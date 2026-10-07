"use strict";
// Model pemetaan runtime: SATU tempat yang menjawab "scene apa untuk komentar
// ini", "produk apa untuk scene ini", dan "balasan apa untuk scene ini".
//
// Modul ini MURNI: tidak ada I/O, tidak ada environment, tidak ada jam, tidak
// ada state global yang bisa diubah. Dipakai bersama oleh proses bot dan oleh
// Controller — Controller memakainya untuk memvalidasi, bot memakainya untuk
// berjalan. Keduanya memakai kode yang sama, jadi "lolos validasi" dan "cocok
// saat LIVE" tidak bisa berbeda arti.
//
// ---------------------------------------------------------------------------
// DUA MODE, DAN YANG LEGACY ADALAH DEFAULT
//
//   legacy  Tidak ada config runtime. Rule, keyword, peta produk, dan teks
//           balasan semuanya persis seperti sebelum P2: array RULES di
//           index.js, AUTOPIN_PRODUCT_* dari environment, dan DEFAULT_TEMPLATE
//           di autocomment/formatter.js. Ini yang dipakai `node index.js`
//           manual dan SELURUH tes yang sudah ada.
//
//   config  Controller menyuplai mappings. Trigger dan balasan datang dari
//           config customer.
//
// Mode config hanya aktif kalau mappings benar-benar disuplai. Tidak ada
// perilaku baru yang menyala karena kelalaian.
//
// ---------------------------------------------------------------------------
// YANG TETAP MILIK RULES, DAN KENAPA
//
// Config customer berisi scene, produk, trigger, dan balasan. Ia TIDAK berisi
// `mediaInputs`, `waitForMediaEnd`, maupun `duration` — dan itu disengaja.
// Ketiganya adalah detail pemutaran di OBS: nama input media (mis. "Media 3",
// BUKAN nama berkas) dan durasi failsafe yang diukur dari video aslinya.
//
// Jadi di mode config, ketiganya tetap diambil dari base rule untuk scene itu.
// Scene yang TIDAK punya base rule tidak bisa diputar: Controller tidak punya
// cara mengetahui nama input media-nya, dan menebak durasi berarti mengubah
// perilaku pemutaran scene itu. Scene seperti itu ditolak oleh validator, dan
// di sini ia dicatat sebagai `unknownPlayback` — tidak pernah dijalankan dengan
// nilai yang dikarang.
//
// ---------------------------------------------------------------------------
// KENAPA SNAPSHOT DIBEKUKAN
//
// Satu kali dibuat, tidak pernah berubah. Config yang disimpan di tengah LIVE
// tidak boleh bisa mengubah scene yang SEDANG diputar: perubahan setengah jadi
// akan membuat satu pemutaran memakai trigger lama dan balasan baru. Controller
// menjawab perubahan di tengah jalan dengan restartRequired, bukan dengan
// menyuntik nilai baru ke snapshot yang sedang dipakai.

// Scene idle. Tidak pernah punya produk dan tidak pernah dikomentari —
// nilainya sejalan dengan autopin/scene-map.js dan autocomment/core.js.
const NEVER_MAPPED = Object.freeze(["MAIN"]);

const SOURCES = Object.freeze({ LEGACY: "legacy", CONFIG: "config" });

function freezeDeep(value) {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) freezeDeep(value[key]);
  return value;
}

// Mode legacy TIDAK boleh membekukan rule-nya, dan itu bukan kelonggaran.
//
// Di mode legacy, `rules` BUKAN milik modul ini: ia adalah array RULES di
// index.js, dan mengubah `rule.enabled` saat berjalan adalah perilaku yang
// didokumentasikan di sana ("cukup set enabled:true untuk mengaktifkan lagi")
// dan diuji di test/queue.test.js. Membekukannya membuat penugasan itu gagal
// DIAM-DIAM — mode non-strict tidak melempar, nilainya hanya tidak berubah —
// sehingga scene FAQ tidak akan pernah bisa dinyalakan lagi dan tidak ada
// pesan apa pun yang menjelaskan kenapa.
//
// Yang dibekukan hanya objek snapshot-nya sendiri, supaya metodenya tidak bisa
// ditukar. Jaminan immutability yang diminta P2 berlaku untuk config runtime,
// dan config runtime hanya ada di mode config — di sana rule-nya objek baru
// milik modul ini, dan di sana ia dibekukan sampai ke dalam.
function freezeSnapshotOnly(snapshot) {
  return Object.freeze(snapshot);
}

// Satu baris rule seperti yang dipahami matcher dan jalur pemutaran. Bentuknya
// sengaja sama dengan entri RULES di index.js, karena konsumennya memang sama.
function buildRuleFromMapping(mapping, baseRule) {
  const triggers = Array.isArray(mapping.triggers) ? mapping.triggers.filter((t) => typeof t === "string" && t.trim() !== "") : [];
  return {
    // Semua detail pemutaran diwarisi dari base rule: mediaInputs,
    // waitForMediaEnd, duration, dan pattern kalau ada.
    ...baseRule,
    scene: baseRule.scene,
    // mediaInputs DISALIN, tidak dibagi. Tanpa salinan ini, pembekuan snapshot
    // mode config akan ikut membekukan array yang masih dimiliki RULES di
    // index.js — modul ini tidak boleh mengubah sifat objek milik orang lain.
    mediaInputs: Array.isArray(baseRule.mediaInputs) ? baseRule.mediaInputs.slice() : baseRule.mediaInputs,
    // Keyword DIGANTI, bukan digabung. Menggabungkan akan membuat bot tetap
    // merespons kata kunci lama yang tidak terlihat di config dan tidak bisa
    // dimatikan customer.
    keywords: triggers,
  };
}

function createRuntimeMappings({
  // Dari config customer. null/undefined = mode legacy.
  mappings = null,
  // Array RULES dari index.js. Sumber tunggal untuk detail pemutaran.
  baseRules = [],
  // Peta scene->kunci judul dari environment (AUTOPIN_PRODUCT_*), hanya dipakai
  // di mode legacy.
  envProductMap = {},
  // Pembentuk pesan bawaan (autocomment/formatter.js formatSceneMessage).
  defaultFormat = null,
  // ID generasi config runtime. Hanya metadata; tidak memengaruhi pencocokan.
  generation = null,
} = {}) {
  const useConfig = Array.isArray(mappings);

  // --- mode legacy ---------------------------------------------------------
  if (!useConfig) {
    const rules = baseRules.slice();
    const productMap = { ...envProductMap };
    const snapshot = {
      source: SOURCES.LEGACY,
      generation: null,
      rules,
      productMap,
      replies: {},
      unknownPlayback: [],
      // Rule dianggap aktif kecuali ditandai enabled:false. Perilaku dan
      // kalimatnya sama dengan activeRules() yang lama.
      activeRules: () => rules.filter((r) => r.enabled !== false),
      getProductForScene: (scene) => productMap[scene] || null,
      // Tidak ada balasan per scene di mode legacy: formatter bawaan yang
      // menjawab, persis seperti sebelum P2.
      getReplyForScene: () => null,
      formatSceneMessage: (scene) =>
        typeof defaultFormat === "function" ? defaultFormat(scene) : { ok: false, reason: "no-formatter" },
      scenes: () => rules.map((r) => r.scene),
    };
    return freezeSnapshotOnly(snapshot);
  }

  // --- mode config ---------------------------------------------------------
  const baseByScene = new Map();
  for (const r of baseRules) baseByScene.set(r.scene, r);

  const rules = [];
  const productMap = {};
  const replies = {};
  const unknownPlayback = [];

  for (const m of mappings) {
    const scene = String(m.scene || "").trim();
    if (!scene || NEVER_MAPPED.includes(scene)) continue;

    const baseRule = baseByScene.get(scene);
    if (!baseRule) {
      // Tidak ada detail pemutaran untuk scene ini. Dicatat, TIDAK dijalankan.
      unknownPlayback.push(scene);
      continue;
    }

    rules.push(buildRuleFromMapping(m, baseRule));

    // product boleh null secara eksplisit: scene yang punya trigger tapi tidak
    // pernah dipin (mis. scene FAQ). Yang ditolak validator adalah judul KOSONG,
    // yaitu field yang lupa diisi — bukan "memang tidak ada produk".
    const title = m.product && typeof m.product.title === "string" ? m.product.title.trim() : "";
    if (title) productMap[scene] = title;

    const reply = typeof m.reply === "string" ? m.reply.trim() : "";
    if (reply) replies[scene] = reply;
  }

  const snapshot = {
    source: SOURCES.CONFIG,
    generation: generation || null,
    rules,
    productMap,
    replies,
    unknownPlayback,
    activeRules: () => rules.filter((r) => r.enabled !== false),
    getProductForScene: (scene) => productMap[scene] || null,
    getReplyForScene: (scene) => replies[scene] || null,
    // Drop-in untuk opsi `format` di createAutoComment. Bentuk hasilnya sama
    // dengan formatSceneMessage: { ok, text } atau { ok:false, reason }.
    //
    // Balasan dipakai APA ADANYA, tanpa placeholder dan tanpa interpolasi.
    // Teks ini dibaca penonton; ia tidak boleh bisa berubah bentuk karena
    // sesuatu di dalam kode.
    formatSceneMessage: (scene) => {
      const text = replies[scene];
      if (!text) return { ok: false, reason: "no-reply-configured" };
      return { ok: true, text };
    },
    scenes: () => rules.map((r) => r.scene),
  };
  return freezeDeep(snapshot);
}

module.exports = { createRuntimeMappings, SOURCES, NEVER_MAPPED };
