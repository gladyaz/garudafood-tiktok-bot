"use strict";
// KETERSEDIAAN PRODUK: peringatan, bukan pemblokir global.
//
// ---------------------------------------------------------------------------
// KEJADIAN YANG MELAHIRKAN BERKAS INI
//
// Preflight LIVE NYATA, 2026-10-21, akun pilot, etalase berisi 5 produk:
//
//   PAX-1  target ADA
//   PAX-2  target ADA
//   PAX-3  target TIDAK ADA
//   PAX-4  target TIDAK ADA
//   PAX-5  target TIDAK ADA
//
//   -> preflight mapping-validation-failed
//   -> SELURUH runtime menolak menyala
//
// Yang mati bersamanya bukan hanya tiga aturan itu: dua pemetaan yang SEHAT,
// Product PRICE Q&A (yang tidak butuh pemetaan sama sekali), balasan FAQ, dan
// interaksi saat sepi. Etalase LIVE memang boleh berisi produk apa saja dalam
// urutan apa saja, jadi produk yang absen adalah keadaan DUNIA - bukan config
// yang rusak.
//
// ---------------------------------------------------------------------------
// YANG TIDAK DILONGGARKAN
//
// Keselamatannya tidak pindah ke preflight; ia memang sudah ada di tempat lain,
// dan berkas ini MEMBUKTIKANNYA alih-alih menulis ulang jalurnya:
//
//   resolveProductForPin  0 cocok -> product-not-found, tidak memin apa pun
//                         >1 cocok -> ambiguous-product, tidak menebak
//   gerbang bukti pin     pin gagal -> balasan "sudah aku pin" DIBUNGKAM
//   runtime config        memuat SEMUA pemetaan; ketersediaan TIDAK dibekukan
//   PRICE Q&A             bekerja atas katalog, tidak menuntut pemetaan

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { validateMappings, AVAILABILITY_REASONS } = require("../controller/mapping-validator");
const { resolveProductForPin } = require("../autopin/core");
const { buildRuntimeConfig } = require("../runtime/runtime-config");
const { resolveActions } = require("../runtime/rule-actions");
const { resolveProductForQuestion } = require("../qa/resolve-product");
const { detectPriceIntent } = require("../qa/intent-price");
const { buildPriceReply } = require("../qa/reply-price");
const { normalizeForMatching } = require("../tiktok/normalize");
const {
  createAutoComment, createDryRunTransport, PIN_POLICY, PRIORITY,
} = require("../autocomment/core");
const { inspectPinResult } = require("../autopin/pin-result");

// --- dunia tiruan yang bentuknya seperti LIVE nyata --------------------------

const OBS_SCENES = ["MAIN", "PAX-1", "PAX-2", "PAX-3", "PAX-4", "PAX-5"];
const PLAYABLE = OBS_SCENES;

// Produk etalase. Berkas ini menguji DUA lapis sekaligus, jadi fixture-nya
// membawa kedua bentuk dengan sengaja:
//
//   pinButtons/pinVisible  dibaca resolveProductForPin (jalur pin, MENTAH)
//   pinAvailable           dibaca validator pemetaan Controller (preflight)
//
// Gerbang kelayakan TIDAK diuji dari sini - bentuk ternormalisasinya diikat di
// test/autopin.eligibilityshape.test.js lewat jalur penyimpanan produksi.
const P = (number, title, extra = {}) =>
  Object.assign(
    { number, title, pinButtons: 1, pinVisible: true, pinDisabled: false, pinAvailable: true },
    extra
  );

// Etalase LIVE 2026-10-21: lima produk, dan HANYA target PAX-1 / PAX-2 ada.
const ETALASE_HARI_ITU = [
  P(1, "Garuda - Kacang ATOM 16gr 1 RENCENG ISI 10 PCS oat - GRD"),
  P(2, "[COD AFF] Gery - Gery Saluut Malkist Family Pack (100gr) [PILIH VARIAN RASA] - GRY"),
  P(3, "Chocolatos Wafer Roll Chocolate 32gr"),
  P(4, "Okky Jelly Drink Anggur 150ml"),
  P(5, "Clevo Susu UHT Cokelat 115ml"),
];

// Lima pemetaan customer APA ADANYA.
const PEMETAAN = [
  { scene: "PAX-1", product: { title: "Garuda - Kacang ATOM 16gr 1 RENCENG ISI 10 PCS oat - GRD" }, triggers: ["spill etalase 1"], reply: "Etalase 1 sudah aku pin ya kak" },
  { scene: "PAX-2", product: { title: "[COD AFF] Gery - Gery Saluut Malkist Family Pack (100gr) [PILIH VARIAN RASA] - GRY" }, triggers: ["no 2"], reply: "Etalase 2 sudah aku pin ya kak" },
  { scene: "PAX-3", product: { title: "Gery Saluut Malkist Renceng - Netto 10 bks x 18 gr" }, triggers: ["et 3"], reply: "Etalase 3 sudah aku pin ya kak" },
  { scene: "PAX-4", product: { title: "DILAN COOKIES CHOCO CHIP Murah 12 gram PACK ISI 23 PCS Biskuit Cemilan" }, triggers: ["et 4"], reply: "Etalase 4 sudah aku pin ya kak" },
  { scene: "PAX-5", product: { title: "Dilan Waffle 1 BOX Kue Coklat 16gr Garudafood Cemilan Cokelat" }, triggers: ["spill etalase 5"], reply: "Etalase 5 sudah aku pin ya kak" },
];

const periksa = (mappings, products) =>
  validateMappings({
    mappings,
    idle: null,
    obsScenes: OBS_SCENES,
    products,
    autoCommentEnabled: true,
    playableScenes: PLAYABLE,
  });

// ===========================================================================
// KASUS LIVE NYATA (bagian 10)
// ===========================================================================

test("KASUS NYATA: 5 produk, PAX-1/2 ada, PAX-3/4/5 absen -> verdict OK", () => {
  const v = periksa(PEMETAAN, ETALASE_HARI_ITU);

  assert.equal(v.ok, true, "produk absen TIDAK boleh menjatuhkan verdict global");
  assert.equal(v.blocking.length, 0, "tidak ada yang menghalangi: " + JSON.stringify(v.blocking));
  assert.equal(v.degraded.length, 3, "tiga baris harus ditandai tidak tersedia");
  assert.deepEqual(v.degraded.map((r) => r.scene), ["PAX-3", "PAX-4", "PAX-5"]);
  for (const r of v.degraded) {
    assert.equal(r.unavailableReason, "product-not-found", r.scene);
    assert.equal(r.blocking, false, r.scene + " tidak boleh menghalangi");
  }
});

test("KASUS NYATA: PAX-3/4/5 TIDAK diam-diam dianggap siap", () => {
  const v = periksa(PEMETAAN, ETALASE_HARI_ITU);
  const byScene = new Map(v.mappings.map((r) => [r.scene, r]));

  // Yang sehat: siap.
  for (const s of ["PAX-1", "PAX-2"]) {
    assert.equal(byScene.get(s).ok, true, s + " harus siap");
    assert.ok(byScene.get(s).resolvedTitle, s + " harus menyebut produk yang terpilih");
    assert.equal(byScene.get(s).unavailable, undefined, s + " bukan degraded");
  }
  // Yang absen: TIDAK siap, dan alasannya terbaca.
  for (const s of ["PAX-3", "PAX-4", "PAX-5"]) {
    const r = byScene.get(s);
    assert.equal(r.ok, false, s + " TIDAK boleh terbaca siap");
    assert.equal(r.reason, "product-not-found", s);
    assert.equal(r.unavailable, true, s);
  }
});

// ===========================================================================
// ETALASE DINAMIS - TANPA RESTART (bagian 11)
// ===========================================================================
//
// Inti bagian 11: ketersediaan TIDAK dibekukan saat START. Artefak runtime
// memuat SEMUA pemetaan, dan resolusi terjadi terhadap katalog SAAT ITU.

test("DINAMIS: artefak runtime memuat SEMUA pemetaan, termasuk yang produknya absen", () => {
  // Kalau yang tidak tersedia disaring di sini, PAX-3 tidak akan pernah bisa
  // bekerja lagi tanpa restart - persis yang dilarang bagian 3.
  const rc = buildRuntimeConfig({ mappings: PEMETAAN, idle: null, configVersion: 1, createdAt: "2026-10-21T00:00:00.000Z" });

  assert.equal(rc.mappings.length, 5, "kelima pemetaan harus ikut");
  assert.deepEqual(rc.mappings.map((m) => m.scene), ["PAX-1", "PAX-2", "PAX-3", "PAX-4", "PAX-5"]);
  for (const m of rc.mappings) {
    assert.ok(m.product && typeof m.product.title === "string" && m.product.title !== "",
      m.scene + " harus tetap membawa judul produknya");
    // Dan TIDAK ada nomor etalase yang dibekukan ke dalam artefak.
    assert.equal(m.product.number, undefined, m.scene + " tidak boleh membekukan nomor");
    assert.equal(Object.keys(m.product).join(","), "title", m.scene + " hanya judul");
  }
});

test("DINAMIS A: produk absen saat trigger -> TIDAK memin apa pun", () => {
  const r = resolveProductForPin(ETALASE_HARI_ITU, PEMETAAN[2].product.title); // PAX-3
  assert.equal(r.ok, false);
  assert.equal(r.reason, "product-not-found");
  assert.equal(r.product, undefined, "tidak boleh membawa produk pengganti");
});

test("DINAMIS B: produk DITAMBAHKAN kemudian -> pemetaan yang sama resolve, tanpa restart", () => {
  const judul = PEMETAAN[2].product.title;
  const sesudah = ETALASE_HARI_ITU.concat([P(6, judul)]);

  const r = resolveProductForPin(sesudah, judul);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.product.number, 6);
  assert.equal(r.product.title, judul);
});

test("DINAMIS C: produk DIHAPUS lagi -> gagal aman, tanpa memengaruhi yang lain", () => {
  const judul = PEMETAAN[2].product.title;
  const lagi = resolveProductForPin(ETALASE_HARI_ITU, judul);
  assert.equal(lagi.ok, false);
  assert.equal(lagi.reason, "product-not-found");

  // Dan PAX-1 TETAP bekerja pada katalog yang sama.
  const satu = resolveProductForPin(ETALASE_HARI_ITU, PEMETAAN[0].product.title);
  assert.equal(satu.ok, true, "aturan sehat tidak boleh ikut terdampak");
  assert.equal(satu.product.number, 1);
});

test("DINAMIS D: etalase DIURUT ULANG -> pemetaan tetap resolve produk yang dimaksud", () => {
  // Hari ini #1 Garuda, #2 Gery. Besok Dilan masuk di depan.
  const diurutUlang = [
    P(1, "Dilan Waffle 1 BOX Kue Coklat 16gr Garudafood Cemilan Cokelat"),
    P(2, "Garuda - Kacang ATOM 16gr 1 RENCENG ISI 10 PCS oat - GRD"),
    P(3, "[COD AFF] Gery - Gery Saluut Malkist Family Pack (100gr) [PILIH VARIAN RASA] - GRY"),
  ];

  const pax1 = resolveProductForPin(diurutUlang, PEMETAAN[0].product.title);
  assert.equal(pax1.ok, true);
  assert.equal(pax1.product.number, 2, "PAX-1 harus mengikuti JUDUL, bukan nomor lama");
  assert.match(pax1.product.title, /Kacang ATOM/);

  const pax2 = resolveProductForPin(diurutUlang, PEMETAAN[1].product.title);
  assert.equal(pax2.ok, true);
  assert.equal(pax2.product.number, 3);
  assert.match(pax2.product.title, /Gery Saluut Malkist Family/);
});

test("DINAMIS E: produk LAIN menempati nomor lama -> TIDAK ikut ter-pin", () => {
  // Nomor 1 sekarang milik produk yang sama sekali berbeda.
  const diurutUlang = [
    P(1, "Dilan Waffle 1 BOX Kue Coklat 16gr Garudafood Cemilan Cokelat"),
    P(2, "Garuda - Kacang ATOM 16gr 1 RENCENG ISI 10 PCS oat - GRD"),
  ];
  const r = resolveProductForPin(diurutUlang, PEMETAAN[0].product.title);
  assert.equal(r.ok, true);
  assert.notEqual(r.product.number, 1, "nomor lama TIDAK boleh menentukan");
  assert.ok(!/Dilan/i.test(r.product.title), "produk lain tidak boleh terpilih: " + r.product.title);

  // Dan kalau target aslinya HILANG sementara nomornya ditempati produk lain,
  // jawabannya tetap "tidak ketemu" - bukan produk di nomor itu.
  const tanpaTarget = [P(1, "Dilan Waffle 1 BOX Kue Coklat 16gr Garudafood Cemilan Cokelat")];
  const kosong = resolveProductForPin(tanpaTarget, PEMETAAN[0].product.title);
  assert.equal(kosong.ok, false);
  assert.equal(kosong.reason, "product-not-found");
});

test("DINAMIS F: produk BARU yang tidak pernah dipetakan tetap bisa dijawab PRICE Q&A", () => {
  // Bagian 7: Q&A bekerja atas katalog, bukan atas pemetaan.
  const baru = P(6, "Leo Keripik Singkong Balado 68gr", {
    priceState: "single", currentPriceText: "Rp7.900",
  });
  const snap = { coverage: "full", products: ETALASE_HARI_ITU.concat([baru]) };

  // Tidak ada satu pun pemetaan yang menyebut produk ini.
  for (const m of PEMETAAN) {
    assert.ok(!/leo|singkong|balado/i.test(m.product.title), "fixture harus benar-benar tak terpetakan");
  }

  const norm = normalizeForMatching("harga leo singkong berapa");
  const intent = detectPriceIntent(norm);
  assert.equal(intent.price, true, JSON.stringify(intent));

  const r = resolveProductForQuestion(snap, { words: intent.words, number: intent.number });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.product.number, 6);

  const rep = buildPriceReply(r.product);
  assert.equal(rep.ok, true, JSON.stringify(rep));
  assert.equal(rep.price, "Rp7.900");
});

test("KETERSEDIAAN: produk ADA tapi tombol pin-nya tidak -> peringatan, bukan pemblokir", () => {
  // Kondisi kedua dalam AVAILABILITY_REASONS, dan ia terpisah dari
  // product-not-found: produknya terlihat di etalase, tapi kontrol pin-nya tidak
  // tersedia (mis. habis stok). Itu juga keadaan DUNIA, bukan config rusak.
  const etalase = [
    P(1, "Garuda - Kacang ATOM 16gr 1 RENCENG ISI 10 PCS oat - GRD", { pinAvailable: false }),
  ];
  const v = periksa([
    { scene: "PAX-1", product: { title: "Garuda - Kacang ATOM 16gr 1 RENCENG ISI 10 PCS oat - GRD" },
      triggers: ["spill etalase 1"], reply: "Etalase 1 sudah aku pin ya kak" },
  ], etalase);

  assert.equal(v.ok, true, "kontrol pin yang absen TIDAK boleh memblokir START: " + JSON.stringify(v.mappings));
  assert.equal(v.blocking.length, 0);
  assert.equal(v.degraded.length, 1);
  assert.equal(v.degraded[0].scene, "PAX-1");
  assert.equal(v.degraded[0].unavailableReason, "live-pin-control-not-available");
  assert.equal(v.degraded[0].ok, false, "barisnya tetap TIDAK siap");
  // Produknya memang DIKENALI - jadi ini benar-benar beda dari product-not-found.
  assert.ok(v.degraded[0].resolvedTitle, "produk harus tetap teridentifikasi");
});

// ===========================================================================
// ATURAN YANG TIDAK MEMIN (bagian 6)
// ===========================================================================

test("FAQ: aturan autoPin=false TIDAK menjadi tidak tersedia walau produknya absen", () => {
  const faq = [
    { scene: "", product: null, triggers: ["jam berapa buka"], reply: "Buka tiap hari kak",
      actions: { switchScene: false, autoPin: false, autoReply: true } },
    // Judul historis yang sudah tidak ada di etalase, tapi aturannya tidak memin.
    { scene: "", product: { title: "Produk Yang Sudah Lama Hilang" }, triggers: ["ongkir"], reply: "Ongkir dari Jakarta",
      actions: { switchScene: false, autoPin: false, autoReply: true } },
  ];
  const v = periksa(faq, ETALASE_HARI_ITU);

  assert.equal(v.ok, true, JSON.stringify(v.mappings));
  assert.equal(v.degraded.length, 0, "FAQ tidak boleh muncul sebagai degraded");
  for (const r of v.mappings) {
    assert.equal(r.ok, true, r.scene + " " + JSON.stringify(r.reasons || null));
    assert.equal(resolveActions(r.actions ? r : {}).autoPin, false);
  }
});

test("FAQ: sumber kebenaran adalah resolveActions, bukan ada/tidaknya field product", () => {
  const m = { scene: "", product: null, triggers: ["x"], reply: "y",
    actions: { switchScene: false, autoPin: false, autoReply: true } };
  assert.equal(resolveActions(m).autoPin, false);
  const v = periksa([m], ETALASE_HARI_ITU);
  assert.equal(v.ok, true);
});

// ===========================================================================
// KONTROL NEGATIF - YANG MASIH HARUS MEMBLOKIR (bagian 9)
// ===========================================================================

test("TETAP FATAL: scene OBS tidak ada", () => {
  const v = periksa([{ scene: "PAX-99", product: { title: ETALASE_HARI_ITU[0].title }, triggers: ["x"], reply: "y" }], ETALASE_HARI_ITU);
  assert.equal(v.ok, false);
  assert.equal(v.blocking.length, 1);
  assert.equal(v.blocking[0].blockingReason, "obs-scene-missing");
});

test("KETERSEDIAAN: produk AMBIGU -> peringatan, bukan pemblokir", () => {
  // Kondisi ketiga: produknya ada, bahkan dua, jadi kunci judulnya berhenti
  // unik. Itu tetap keadaan ETALASE - operator menambahkan produk bernama mirip
  // - dan membiarkannya fatal berarti satu produk baru bisa mematikan seluruh
  // otomasi. Keselamatannya ada di gerbang kelayakan dan di resolver pin, yang
  // keduanya menolak menebak kandidat.
  const dua = [P(1, "Gery Saluut Chocolate 110gr"), P(2, "Gery Saluut Malkist 105gr")];
  const v = periksa([{ scene: "PAX-1", product: { title: "Gery Saluut" }, triggers: ["x"], reply: "y" }], dua);

  assert.equal(v.ok, true, "ambiguitas TIDAK boleh memblokir START");
  assert.equal(v.blocking.length, 0);
  assert.equal(v.degraded.length, 1);
  assert.equal(v.degraded[0].unavailableReason, "ambiguous-product");
  assert.equal(v.degraded[0].ok, false, "barisnya tetap TIDAK siap");
  assert.equal(v.degraded[0].matches, 2, "jumlah kandidat tetap dilaporkan");
  assert.equal(AVAILABILITY_REASONS.has("ambiguous-product"), true);
});

test("TETAP FATAL: pin menyala tanpa produk dipilih", () => {
  const v = periksa([{ scene: "PAX-1", product: null, triggers: ["x"], reply: "y",
    actions: { switchScene: true, autoPin: true, autoReply: true } }], ETALASE_HARI_ITU);
  assert.equal(v.ok, false);
  assert.equal(v.blocking[0].blockingReason, "product-missing");
});

test("TETAP FATAL: trigger yang sama diklaim dua aturan", () => {
  const v = periksa([
    { scene: "PAX-1", product: { title: ETALASE_HARI_ITU[0].title }, triggers: ["etalase satu"], reply: "a" },
    { scene: "PAX-2", product: { title: ETALASE_HARI_ITU[1].title }, triggers: ["etalase satu"], reply: "b" },
  ], ETALASE_HARI_ITU);
  assert.equal(v.ok, false);
  assert.ok(v.blocking.some((r) => r.reasons.includes("ambiguous-trigger")), JSON.stringify(v.blocking));
});

test("TETAP FATAL: tanpa satu pun pemetaan", () => {
  const v = periksa([], ETALASE_HARI_ITU);
  assert.equal(v.ok, false);
  assert.equal(v.reason, "no-mappings");
});

test("TETAP FATAL: aturan tanpa trigger", () => {
  const v = periksa([{ scene: "PAX-1", product: { title: ETALASE_HARI_ITU[0].title }, triggers: [], reply: "y" }], ETALASE_HARI_ITU);
  assert.equal(v.ok, false);
  assert.ok(v.blocking[0].reasons.includes("no-triggers"));
});

test("CAMPURAN: satu baris fatal + satu baris hanya tidak tersedia -> tetap FATAL", () => {
  const v = periksa([
    { scene: "PAX-3", product: { title: "Produk Hantu" }, triggers: ["et 3"], reply: "a" },
    { scene: "PAX-99", product: { title: ETALASE_HARI_ITU[0].title }, triggers: ["x"], reply: "b" },
  ], ETALASE_HARI_ITU);
  assert.equal(v.ok, false, "satu kerusakan struktural cukup untuk memblokir");
  assert.equal(v.blocking.length, 1);
  assert.equal(v.blocking[0].scene, "PAX-99");
  assert.equal(v.degraded.length, 1, "yang tidak tersedia tetap dilaporkan");
  assert.equal(v.degraded[0].scene, "PAX-3");
});

// ===========================================================================
// BARIS KESIAPAN UI (bagian 14)
// ===========================================================================

test("UI: baris pemetaan TIDAK mengaku 'semua siap' saat ada yang tidak tersedia", () => {
  // Permukaan yang SUDAH ADA (readinessRows), bukan UI baru. Verdict hijau,
  // tapi barisnya harus menyebut berapa yang tidak tersedia - kalau tidak,
  // satu-satunya tempat operator melihatnya hilang justru ketika kita berhenti
  // memblokir START.
  const { readinessRows, TONE } = require("../controller/public/ui-logic");
  const v = periksa(PEMETAAN, ETALASE_HARI_ITU);

  const rows = readinessRows({ validation: { ok: v.ok, mappings: v.mappings } }, "id");
  const row = rows.find((r) => /aturan|rule|规则/.test(String(r.value)));
  assert.ok(row, "baris pemetaan harus ada: " + JSON.stringify(rows.map((r) => r.value)));
  assert.equal(row.tone, TONE.ATTENTION, "harus minta perhatian, bukan hijau polos");
  assert.match(String(row.value), /2/, "dua yang siap harus disebut: " + row.value);
  assert.match(String(row.value), /3/, "tiga yang tidak tersedia harus disebut: " + row.value);
});

test("UI: tanpa baris degraded, baris pemetaan tetap hijau seperti sebelumnya", () => {
  const { readinessRows, TONE } = require("../controller/public/ui-logic");
  const sehat = PEMETAAN.slice(0, 2);
  const v = periksa(sehat, ETALASE_HARI_ITU);
  assert.equal(v.degraded.length, 0);

  const rows = readinessRows({ validation: { ok: v.ok, mappings: v.mappings } }, "id");
  const row = rows.find((r) => /aturan siap/.test(String(r.value)));
  assert.ok(row, JSON.stringify(rows.map((r) => r.value)));
  assert.equal(row.tone, TONE.READY);
});

// ===========================================================================
// KESELAMATAN BALASAN SAAT PIN GAGAL (bagian 12)
// ===========================================================================

test("PIN GAGAL: balasan 'sudah aku pin' DIBUNGKAM, bukan dikirim", async () => {
  const terkirim = [];
  const logs = [];
  const ac = createAutoComment({
    enabled: true,
    pinPolicy: PIN_POLICY.CONFIRMED,
    inspectPin: inspectPinResult,
    format: (scene) => ({ ok: true, text: "Etalase " + scene + " sudah aku pin ya kak" }),
    send: async ({ text }) => { terkirim.push(text); return { ok: true }; },
    now: () => 1_000_000,
    logger: { log: (l) => logs.push(String(l)) },
    timeoutMs: 1000,
  });

  const r = await ac.requestComment({
    scene: "PAX-3", playId: 1,
    pin: { ok: false, reason: "product-not-found" },
    requirePin: true, priority: PRIORITY.HIGH,
  });

  assert.equal(r.ok, false, "tidak boleh ada balasan");
  assert.equal(r.reason, "product-not-found");
  assert.equal(terkirim.length, 0, "TIDAK ada teks yang terkirim: " + JSON.stringify(terkirim));
  assert.ok(logs.some((l) => /AUTOCOMMENT_SKIPPED/.test(l)), JSON.stringify(logs));
});

test("PIN BERHASIL: balasan HIGH tetap terkirim seperti sebelumnya", async () => {
  const terkirim = [];
  const ac = createAutoComment({
    enabled: true,
    pinPolicy: PIN_POLICY.CONFIRMED,
    inspectPin: inspectPinResult,
    format: (scene) => ({ ok: true, text: "Etalase " + scene + " sudah aku pin ya kak" }),
    send: async ({ text }) => { terkirim.push(text); return { ok: true }; },
    now: () => 1_000_000,
    logger: { log: () => {} },
    timeoutMs: 1000,
  });

  const r = await ac.requestComment({
    scene: "PAX-1", playId: 1,
    pin: { ok: true, reason: "pinned", clicked: true, state: "Unpin", title: "Garuda" },
    requirePin: true, priority: PRIORITY.HIGH,
  });

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(terkirim.length, 1);
  assert.match(terkirim[0], /sudah aku pin/);
});

test("PIN GAGAL: tidak ada antrean tertunda yang mengirim balasan basi kemudian", async () => {
  const terkirim = [];
  let t = 1_000_000;
  const ac = createAutoComment({
    enabled: true,
    pinPolicy: PIN_POLICY.CONFIRMED,
    inspectPin: inspectPinResult,
    format: (scene) => ({ ok: true, text: "Etalase " + scene + " sudah aku pin ya kak" }),
    send: async ({ text }) => { terkirim.push(text); return { ok: true }; },
    now: () => t,
    logger: { log: () => {} },
    timeoutMs: 1000,
  });

  await ac.requestComment({
    scene: "PAX-3", playId: 1,
    pin: { ok: false, reason: "product-not-found" },
    requirePin: true, priority: PRIORITY.HIGH,
  });
  // Waktu maju jauh melewati setiap jeda yang mungkin.
  t += 10 * 60 * 1000;
  await new Promise((r) => setImmediate(r));
  assert.equal(terkirim.length, 0, "penolakan harus FINAL: " + JSON.stringify(terkirim));
});
