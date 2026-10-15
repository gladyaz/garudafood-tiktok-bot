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

// Aksi per-aturan, DIIMPOR. Keputusan "aksi mana yang berlaku" hidup di satu
// tempat saja; lihat runtime/rule-actions.js.
const { resolveActions, ruleKeys } = require("./rule-actions");
// Interaksi saat sepi: bentuk yang berlaku + aksinya. Lihat runtime/idle.js.
const { resolveIdle, idleActionsFor } = require("./idle");

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

function triggersOf(mapping) {
  return Array.isArray(mapping.triggers) ? mapping.triggers.filter((t) => typeof t === "string" && t.trim() !== "") : [];
}

// Aturan yang TIDAK mengganti scene.
//
// Ia tidak punya nama scene, tidak punya mediaInputs, dan tidak punya durasi —
// karena tidak ada yang akan diputar. Yang dimilikinya hanya pemicu dan aksi,
// dan itu cukup: matcher bekerja atas keywords, dan jalur pemutaran tidak
// pernah menyentuhnya karena index.js memeriksa actions.switchScene SEBELUM
// menyentuh antrean.
//
// `scene` tetap ada sebagai string KOSONG, bukan dihilangkan. Seluruh jalur
// playback membaca rule.scene; field yang hilang akan menjadi undefined yang
// menyebar sebagai "undefined" di log dan di nama scene yang dikirim ke OBS.
function buildSceneLessRule(mapping, key, actions) {
  return {
    scene: "",
    key,
    actions,
    keywords: triggersOf(mapping),
  };
}

// Satu baris rule seperti yang dipahami matcher dan jalur pemutaran. Bentuknya
// sengaja sama dengan entri RULES di index.js, karena konsumennya memang sama.
function buildRuleFromMapping(mapping, baseRule, key, actions) {
  const triggers = triggersOf(mapping);
  return {
    // Semua detail pemutaran diwarisi dari base rule: mediaInputs,
    // waitForMediaEnd, duration, dan pattern kalau ada.
    ...baseRule,
    scene: baseRule.scene,
    // Kunci pencarian produk dan balasan. Untuk aturan yang punya scene ia
    // SELALU sama dengan nama scene-nya, jadi setiap config yang sudah ada
    // menghasilkan peta yang identik — bukan yang mirip.
    key,
    actions,
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
  // Blok `idle` dari config customer. null = mati.
  idle = null,
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
      // Mode legacy tidak punya interaksi saat sepi. `node index.js` tanpa
      // Controller berperilaku persis seperti sebelum fitur ini ada.
      idle: { enabled: false, afterMs: 0, items: [], rules: [] },
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

  // Kunci dihitung untuk SELURUH daftar lebih dulu, bukan per baris: kunci
  // buatan untuk aturan tanpa scene harus menghindari semua nama scene di
  // config yang sama, termasuk yang tertulis sesudahnya.
  const keys = ruleKeys(mappings);

  mappings.forEach((m, index) => {
    const scene = String(m.scene || "").trim();
    const actions = resolveActions(m);
    const key = keys[index];

    // --- aturan yang mengganti scene -----------------------------------------
    if (actions.switchScene) {
      if (!scene || NEVER_MAPPED.includes(scene)) return;

      const baseRule = baseByScene.get(scene);
      if (!baseRule) {
        // Tidak ada detail pemutaran untuk scene ini. Dicatat, TIDAK dijalankan.
        unknownPlayback.push(scene);
        return;
      }
      rules.push(buildRuleFromMapping(m, baseRule, key, actions));
    } else {
      // --- aturan tanpa penggantian scene ------------------------------------
      //
      // TIDAK dicatat sebagai unknownPlayback, dan itu bukan kelalaian:
      // unknownPlayback berarti "scene ini ingin diputar tapi kami tidak tahu
      // caranya". Aturan ini tidak ingin diputar sama sekali, jadi tidak ada
      // detail pemutaran yang hilang dan tidak ada yang perlu dikeluhkan.
      //
      // Tanpa pemicu ia tidak akan pernah bisa diminta penonton, jadi ia tidak
      // punya alasan untuk ada di indeks matcher.
      if (triggersOf(m).length === 0) return;
      rules.push(buildSceneLessRule(m, key, actions));
    }

    // --- produk --------------------------------------------------------------
    // Hanya aturan yang BENAR-BENAR memin yang masuk ke peta produk. Aturan yang
    // mematikan Pin produk tapi masih menyimpan pilihan judulnya tidak boleh
    // bisa memin apa pun lewat peta ini: gerbang aksinya ada di index.js, dan
    // ini lapis keduanya. Dua lapis, pola yang sama dengan AutoComment.
    //
    // product boleh null secara eksplisit: scene yang punya trigger tapi tidak
    // pernah dipin (mis. scene FAQ). Yang ditolak validator adalah judul KOSONG
    // pada aturan yang memin — yaitu field yang lupa diisi.
    const title = m.product && typeof m.product.title === "string" ? m.product.title.trim() : "";
    if (actions.autoPin && title) productMap[key] = title;

    const reply = typeof m.reply === "string" ? m.reply.trim() : "";
    if (actions.autoReply && reply) replies[key] = reply;
  });

  // --- interaksi saat sepi -------------------------------------------------
  //
  // Scene interaksi memakai KONTRAK PEMUTARAN YANG SAMA dengan scene lain: ia
  // harus punya base rule di RULES (mediaInputs + durasi). Tidak ada durasi
  // cadangan, tidak ada skema detail pemutaran kedua, dan tidak ada mesin OBS
  // khusus interaksi. Scene yang tidak dikenal mesin pemutaran dicatat sebagai
  // unknownPlayback dan TIDAK dijalankan — sama seperti scene pemetaan yang
  // tidak dikenal, dan validator Controller sudah menolaknya lebih dulu.
  const idleCfg = resolveIdle(idle);
  const idleRules = [];
  const idleItems = [];
  for (const item of idleCfg.items) {
    const scene = item.scene;
    if (!scene || NEVER_MAPPED.includes(scene)) continue;
    const baseRule = baseByScene.get(scene);
    if (!baseRule) {
      unknownPlayback.push(scene);
      continue;
    }
    const actions = idleActionsFor(item);
    idleRules.push({
      ...baseRule,
      scene,
      key: scene,
      actions,
      // TIDAK punya kata kunci, dan itu bukan kelalaian: scene interaksi tidak
      // diminta penonton, ia dipicu oleh keheningan. Daftar kosong membuatnya
      // mustahil masuk ke indeks matcher kalau suatu saat ada yang
      // memasukkannya ke sana.
      keywords: [],
      mediaInputs: Array.isArray(baseRule.mediaInputs) ? baseRule.mediaInputs.slice() : baseRule.mediaInputs,
      idle: true,
    });
    idleItems.push({ scene, reply: item.reply });
    // Balasannya masuk ke peta balasan yang SAMA, jadi formatSceneMessage()
    // menjawabnya tanpa jalur teks kedua. Produknya TIDAK pernah masuk ke peta
    // produk: idleActionsFor() memaksa autoPin false, dan di sini tidak ada
    // satu pun baris yang menulis productMap.
    if (actions.autoReply && item.reply) replies[scene] = item.reply;
  }

  const snapshot = {
    source: SOURCES.CONFIG,
    generation: generation || null,
    idle: {
      // Menyala HANYA kalau ada yang benar-benar bisa diputar. Saklar yang
      // menyala di atas nol scene yang bisa diputar adalah saklar yang bohong.
      enabled: idleCfg.enabled && idleRules.length > 0,
      afterMs: idleCfg.afterSeconds * 1000,
      items: idleItems,
      rules: idleRules,
    },
    rules,
    productMap,
    replies,
    unknownPlayback,
    activeRules: () => rules.filter((r) => r.enabled !== false),
    // Argumennya adalah KUNCI ATURAN, yang untuk setiap aturan ber-scene sama
    // dengan nama scene-nya (lihat ruleKeys di runtime/rule-actions.js). Nama
    // fungsinya dipertahankan karena itulah arti yang berlaku untuk hampir
    // semua aturan, dan mengubahnya hanya memaksa setiap pemanggil berubah
    // tanpa ada yang menjadi lebih benar.
    getProductForScene: (key) => productMap[key] || null,
    getReplyForScene: (key) => replies[key] || null,
    // Drop-in untuk opsi `format` di createAutoComment. Bentuk hasilnya sama
    // dengan formatSceneMessage: { ok, text } atau { ok:false, reason }.
    //
    // Balasan dipakai APA ADANYA, tanpa placeholder dan tanpa interpolasi.
    // Teks ini dibaca penonton; ia tidak boleh bisa berubah bentuk karena
    // sesuatu di dalam kode.
    formatSceneMessage: (key) => {
      const text = replies[key];
      if (!text) return { ok: false, reason: "no-reply-configured" };
      return { ok: true, text };
    },
    // Hanya scene yang BENAR-BENAR diputar. Aturan tanpa penggantian scene
    // tidak punya nama scene, dan memasukkan string kosong ke daftar ini akan
    // membuat pemanggilnya mengira ada scene bernama "".
    scenes: () => rules.filter((r) => r.scene).map((r) => r.scene),
  };
  return freezeDeep(snapshot);
}

module.exports = { createRuntimeMappings, SOURCES, NEVER_MAPPED };
