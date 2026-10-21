"use strict";
// KONTRAK: SATU sumber judul produk, dipakai preflight, gerbang, dan pin.
//
// ---------------------------------------------------------------------------
// BUG LIVE NYATA 2026-10-21
//
//   [MATCH] scene=PAX-3 via=keyword
//   [SKIP_PRODUCT_UNAVAILABLE] scene=PAX-3 reason=empty-title-key
//
// Aturan itu memang harus tidur, tapi alasannya salah - dan alasan yang salah
// berarti SETIAP aturan autoPin tidur, termasuk PAX-1 yang produknya ada di
// etalase dan bisa dipin.
//
// Sebabnya: gerbang membaca `rule.product.title`. Field itu tidak pernah ada.
// buildRuleFromMapping() di runtime/mappings.js membawa `key`, `actions`,
// `keywords`, dan detail pemutaran - tidak ada objek produk. Judulnya hidup di
// runtime.productMap, di-key oleh kunci aturan, dan objek ITU yang dioper ke
// createScenePin({ mapping: autopinMap }).
//
// Berkas ini mengikat ketiga pembaca pada satu sumber, memakai pembangun
// PRODUKSI dan bentuk aturan bot yang SUNGGUHAN - bukan fixture rule.product
// buatan tangan, karena fixture seperti itulah yang menyembunyikan bug ini.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { buildRuntimeConfig } = require("../runtime/runtime-config");
const { createRuntimeMappings } = require("../runtime/mappings");
const { validateMappings } = require("../controller/mapping-validator");
const { decidePinEligibility } = require("../autopin/pin-eligibility");
const { createCatalogueStore, COVERAGE } = require("../autopin/catalogue");
const { RULES } = require("../index.js");

const ROOT = path.resolve(__dirname, "..");

// Pemetaan berbentuk config customer: judul yang DIPILIH customer, bukan
// judul bawaan environment.
const MAPPINGS = [
  { scene: "PAX-1", product: { title: "Garuda - Kacang ATOM 16gr 1 RENCENG ISI 10 PCS oat - GRD" }, triggers: ["spill etalase 1"], reply: "Etalase 1 sudah aku pin ya kak" },
  { scene: "PAX-2", product: { title: "[COD AFF] Gery - Gery Saluut Malkist Family Pack (100gr)" }, triggers: ["no 2"], reply: "Etalase 2 sudah aku pin ya kak" },
  { scene: "PAX-3", product: { title: "Gery Saluut Malkist Renceng - Netto 10 bks x 18 gr" }, triggers: ["et 3"], reply: "Etalase 3 sudah aku pin ya kak" },
];

// Etalase LIVE: target PAX-1 dan PAX-2 ADA, target PAX-3 TIDAK.
const mentah = (number, title, extra = {}) =>
  Object.assign({ number, title, pinButtons: 1, pinVisible: true, pinDisabled: false, pinText: "Pin", currentPriceText: "Rp1", priceState: "single" }, extra);

const ETALASE = [
  mentah(1, "Garuda - Kacang ATOM 16gr 1 RENCENG ISI 10 PCS oat - GRD"),
  mentah(2, "[COD AFF] Gery - Gery Saluut Malkist Family Pack (100gr) [PILIH VARIAN RASA] - GRY"),
  mentah(3, "Dilan - Waffle [PILIH VARIAN] - DLN"),
];

// Snapshot TERNORMALISASI lewat jalur penyimpanan produksi.
function snapshot(products, coverage = COVERAGE.FULL) {
  let t = 1_000_000;
  const store = createCatalogueStore({ now: () => t });
  assert.equal(store.put({ products, coverage, source: "full-test", observedAt: t }).ok, true);
  return store.read({});
}

// Snapshot runtime lewat pembangun PRODUKSI, dengan RULES bot yang sungguhan.
function runtimeSnapshot(mappings) {
  const rc = buildRuntimeConfig({ mappings, idle: null, configVersion: 1, createdAt: "2026-10-21T00:00:00.000Z" });
  return createRuntimeMappings({
    mappings: rc.mappings,
    idle: rc.idle,
    baseRules: Object.values(RULES),
    envProductMap: {},
    generation: rc.id,
  });
}

// ===========================================================================

test("SUMBER: mode config, dan productMap berisi judul CUSTOMER", () => {
  const snap = runtimeSnapshot(MAPPINGS);
  assert.equal(snap.source, "config", "harus mode config, bukan legacy/env");
  for (const m of MAPPINGS) {
    assert.equal(snap.productMap[m.scene], m.product.title,
      m.scene + " harus memakai judul customer, bukan bawaan environment");
  }
});

test("SUMBER: envProductMap TIDAK boleh menggantikan pemetaan customer", () => {
  // Inilah yang membuat `autopinMap` terlihat berisi produk lama saat modul
  // dimuat tanpa AILIVE_RUNTIME_CONFIG: itu mode LEGACY. Begitu ada pemetaan
  // customer, environment tidak boleh ikut bicara.
  const snap = createRuntimeMappings({
    mappings: buildRuntimeConfig({ mappings: MAPPINGS, idle: null }).mappings,
    idle: null,
    baseRules: Object.values(RULES),
    envProductMap: { "PAX-1": "ocorn sea salt", "PAX-3": "paket ulang tahun" },
    generation: "x",
  });
  assert.equal(snap.source, "config");
  assert.equal(snap.productMap["PAX-1"], MAPPINGS[0].product.title, "judul env tidak boleh menang");
  assert.equal(snap.productMap["PAX-3"], MAPPINGS[2].product.title);
  assert.ok(!Object.values(snap.productMap).some((v) => /ocorn|ulang tahun/i.test(v)), JSON.stringify(snap.productMap));
});

test("BENTUK: aturan runtime TIDAK punya rule.product (sumber bug asli)", () => {
  const snap = runtimeSnapshot(MAPPINGS);
  const r = snap.rules.find((x) => x.scene === "PAX-1");
  assert.ok(r, "PAX-1 harus ada di aturan runtime");
  assert.equal(r.product, undefined, "aturan runtime memang tidak membawa objek produk");
  assert.equal(typeof r.key, "string", "yang dibawa adalah `key`");
  assert.equal(r.key, "PAX-1", "untuk aturan ber-scene, key == nama scene");
  // Jadi judulnya HARUS dicari lewat peta, bukan dari aturan.
  assert.equal(snap.getProductForScene(r.key), MAPPINGS[0].product.title);
});

test("SATU SUMBER: preflight, gerbang, dan pin memakai judul yang SAMA", () => {
  const rt = runtimeSnapshot(MAPPINGS);
  const snap = snapshot(ETALASE);

  // 1. Yang DIVALIDASI preflight (validator Controller atas config customer).
  const verdict = validateMappings({
    mappings: MAPPINGS,
    idle: null,
    obsScenes: ["MAIN", "PAX-1", "PAX-2", "PAX-3"],
    products: snap.products,
    autoCommentEnabled: true,
    playableScenes: ["PAX-1", "PAX-2", "PAX-3"],
  });
  const byScene = new Map(verdict.mappings.map((r) => [r.scene, r]));

  // 2. Yang dipakai RUNTIME (peta yang juga dioper ke scenePin).
  // 3. Keputusan GERBANG atas judul runtime itu.
  for (const m of MAPPINGS) {
    const judulRuntime = rt.getProductForScene(m.scene);
    assert.equal(judulRuntime, m.product.title, m.scene + ": runtime == config customer");

    const v = decidePinEligibility({ read: snap, title: judulRuntime });
    const row = byScene.get(m.scene);

    if (row.ok === true) {
      assert.equal(v.ok, true, m.scene + " siap di preflight, harus layak di gerbang: " + JSON.stringify(v));
    } else {
      assert.equal(v.ok, false, m.scene + " tidak siap di preflight, tidak boleh layak di gerbang");
      // Dan alasannya harus soal PRODUK, bukan soal judul kosong.
      assert.notEqual(v.reason, "empty-title-key", m.scene + ": judul harus TERBACA, bukan kosong");
      assert.equal(v.reason, row.unavailableReason, m.scene + ": alasan kedua lapis harus sama");
    }
  }
});

test("HASIL AKHIR: PAX-1 layak, PAX-3 product-not-found - dari sumber yang SAMA", () => {
  const rt = runtimeSnapshot(MAPPINGS);
  const snap = snapshot(ETALASE);

  const satu = decidePinEligibility({ read: snap, title: rt.getProductForScene("PAX-1") });
  assert.deepEqual(satu, { ok: true, reason: null }, "PAX-1 harus layak: " + JSON.stringify(satu));

  const tiga = decidePinEligibility({ read: snap, title: rt.getProductForScene("PAX-3") });
  assert.equal(tiga.ok, false);
  assert.equal(tiga.reason, "product-not-found",
    "PAX-3 harus product-not-found, BUKAN empty-title-key: " + JSON.stringify(tiga));
});

test("ARBITRER: etalase boleh diurut ulang; identitas tetap judul", () => {
  const rt = runtimeSnapshot(MAPPINGS);
  // Target PAX-1 pindah dari #1 ke #3, produk lain menempati #1.
  const diurut = snapshot([
    mentah(1, "Dilan - Waffle [PILIH VARIAN] - DLN"),
    mentah(2, "[COD AFF] Gery - Gery Saluut Malkist Family Pack (100gr) [PILIH VARIAN RASA] - GRY"),
    mentah(3, "Garuda - Kacang ATOM 16gr 1 RENCENG ISI 10 PCS oat - GRD"),
  ]);
  const v = decidePinEligibility({ read: diurut, title: rt.getProductForScene("PAX-1") });
  assert.equal(v.ok, true, "urutan berubah tidak boleh mengubah kelayakan");
});

test("PENJAGA: gerbang di index.js TIDAK membaca rule.product", () => {
  const src = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
  const mulai = src.indexOf("async function checkProductEligibility");
  assert.ok(mulai > 0, "fungsi gerbang harus ada");
  const potong = src.slice(mulai, mulai + 1800);
  const kode = potong.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

  assert.ok(!/rule\.product/.test(kode), "tidak boleh membaca rule.product: " + kode.slice(0, 300));
  // Dan ia HARUS memakai peta produk runtime lewat kunci aturan.
  assert.match(kode, /getProductForScene/, "harus memakai peta produk runtime");
  assert.match(kode, /ruleKeyOf/, "harus memakai kunci aturan yang sama dengan pin");
});

test("PENJAGA: scenePin menerima peta produk runtime yang SAMA", () => {
  const src = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
  assert.match(src, /const autopinMap = runtime\.productMap;/, "peta pin berasal dari snapshot runtime");
  assert.match(src, /mapping: autopinMap,/, "dan itulah yang dioper ke createScenePin");
});
