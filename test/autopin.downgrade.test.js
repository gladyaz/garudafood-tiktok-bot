"use strict";
// BALAPAN full -> viewport, dan kebijakan kualitas snapshot.
//
// Bentuk kegagalannya, yang sudah direproduksi:
//
//   1. penyegaran viewport ringan diminta
//   2. ia menunggu giliran eksklusif service/browser
//   3. operasi lain menerbitkan snapshot FULL yang baru dan segar
//   4. penyegaran viewport yang mengantre akhirnya jalan
//   5. kode lama MENIMPA full itu dengan viewport
//
// Akibatnya: satu pertanyaan BERNOMOR mematikan jalur NAMA. Hanya terjadi kalau
// waktu tunggunya di bawah 1500 ms - yaitu di dalam jangkauan collect 1080 ms
// yang terukur pada customer.
//
// Yang dijaga di sini BUKAN "full selalu menang". Kesegaran tetap menang: full
// yang sudah BASI memang boleh digantikan viewport yang benar-benar baru, dan
// hasilnya dilaporkan apa adanya.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createService } = require("../autopin/service");
const { createCatalogueStore, COVERAGE, QUOTE_FRESH_MS } = require("../autopin/catalogue");
const { withPriceFields } = require("../autopin/price");

const CONSOLE = "https://shop.tiktok.com/streamer/live/product/dashboard";
const CONFIG = { consoleUrl: CONSOLE, expectedShop: "agen_mulia_abadi", forbiddenShops: ["garudafood"] };

const P = (n, t) => withPriceFields({
  number: n, rowInputs: 1, title: t, price: "Rp1.000", stock: "In stock: 9",
  priceNodes: [{ text: "Rp1.000", primary: true, dim: false }],
  pinButtons: 1, pinVisible: true, pinDisabled: false, pinText: "Pin",
  icons: [], ariaOnRow: [], badges: [], topControls: 1, imageKey: "x",
});
const SEMUA = [P(1, "Garuda Kacang ATOM 16gr"), P(2, "GARUDA TING TING"), P(3, "Gery Saluut Renceng")];

const KELENGKAPAN = (n) => ({
  scope: "clean", declaredTotal: n, declaredTotalStable: true,
  positions: Array.from({ length: n }, (_, i) => i + 1), positionsCoverTotal: true,
  contradictoryPositions: 0, scrollerStable: true,
  exhaustedScrolls: false, bottomReached: false, rowsSane: true,
});
const FULL = (p = SEMUA) => ({
  products: p, livePinButtonsOnPage: p.length, invalidRows: 0, passes: 3,
  stoppedEarly: false, ranOutOfTime: false, numberInputsOnPage: p.length,
  coverage: "full", coverageReasons: [], completeness: KELENGKAPAN(p.length),
});
const VIEWPORT = (p = SEMUA) => ({
  products: p, livePinButtonsOnPage: p.length, invalidRows: 0, passes: 1,
  coverage: "viewport", numberInputsOnPage: p.length,
});

const putar = async (n = 60) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)); };

// Rig dengan collect yang bisa DITAHAN, supaya antrean benar-benar terbentuk.
function rig({ collectMs = 1_080, unknownCoverage = false, closeBrowserDelayMs = 0 } = {}) {
  let t = 1_000_000;
  const jejak = { collect: 0, once: 0 };
  let lepas = null;
  // Penahanan DIAKTIFKAN setelah warmUp: warmUp sendiri menjalankan satu sapuan
  // penuh, jadi menahan collect sejak awal akan menahan warmUp-nya sendiri.
  let tahan = false;
  const page = { url: () => CONSOLE, isClosed: () => false, bringToFront: async () => {} };
  const svc = createService({
    config: CONFIG,
    deps: {
      launchBrowser: async () => ({ id: "f" }),
      getPage: async () => page,
      openConsole: async () => ({ url: CONSOLE, settled: true, readyMs: 1 }),
      // Penutupan yang LAMBAT membuka jendela yang nyata: di dalam stop(),
      // `stopping` sudah true tapi `page` BELUM di-null. Tanpa jendela ini,
      // invarian "jangan membaca sesudah STOP" kebetulan ditegakkan oleh
      // page=null di akhir stop(), dan penjaga `stopping` jadi tak teruji.
      closeBrowser: async () => {
        if (closeBrowserDelayMs > 0) await new Promise((r) => setTimeout(r, closeBrowserDelayMs));
      },
      readIdentity: async () => ["agen_mulia_abadi"],
      readProductsOnce: async () => { jejak.once += 1; return VIEWPORT(); },
      collectProducts: async (p, opts = {}) => {
        jejak.collect += 1;
        if (tahan && !lepas) await new Promise((r) => { lepas = r; });
        t += collectMs;
        // `unknownCoverage` meniru koleksi yang TIDAK bisa membuktikan
        // kelengkapan - mis. jalur pin dengan satu cuplikan. Tanpa ini, setiap
        // skenario selalu punya snapshot full yang lebih baru, dan gerbang
        // STOP tidak pernah benar-benar teruji: penyegaran sudah dilewati
        // lebih dulu oleh gerbang "sudah ada full yang lebih baru".
        if (unknownCoverage) return { ...FULL(), coverage: "unknown", coverageReasons: ["stability-unproven"] };
        return FULL();
      },
      pinProductByTitle: async (_p, k) => ({ ok: true, title: k }),
      readPinState: async () => ({ found: true, text: "Unpin", disabled: false, buttons: 1 }),
      sleep: async () => {},
      now: () => t,
    },
  });
  return {
    svc, jejak,
    maju: (ms) => { t += ms; },
    waktu: () => t,
    mulaiTahan: () => { tahan = true; },
    lepaskan: () => { tahan = false; if (lepas) { lepas(); lepas = null; } },
  };
}

// ===========================================================================
// A. viewport yang mengantre TIDAK menimpa full yang lebih baru
// ===========================================================================

test("A: full baru diterbitkan selagi viewport mengantre -> viewport TIDAK menimpa", async () => {
  const r = rig();
  await r.svc.warmUp();
  r.mulaiTahan();
  r.maju(31_000); // snapshot jadi basi supaya penyegaran ringan memang dipicu

  // Pin mulai mengoleksi dan DITAHAN: penyegaran ringan menumpuk di antrean.
  const pin = r.svc.handlePin({ scene: "PAX-1", productKey: "garuda kacang atom", playId: 1 });
  await putar(30);
  const ringan = r.svc.handleProducts({ refresh: "if-stale" });
  await putar(30);

  r.lepaskan();
  await Promise.all([pin, ringan]);
  await putar(60);

  const akhir = await r.svc.handleProducts({ refresh: "never" });
  assert.equal(akhir.ok, true);
  assert.equal(akhir.coverage, "full", "full yang lebih baru harus bertahan");
  assert.equal(akhir.source, "pin-collect");
});

// ===========================================================================
// B. waktu tunggu DI BAWAH 1500 ms - invarian yang sama
// ===========================================================================

test("B: waktu tunggu di bawah 1500 ms (collect 1080 ms) -> invarian tetap", async () => {
  const r = rig({ collectMs: 1_080 });
  await r.svc.warmUp();
  r.maju(31_000);

  // Keduanya dimulai bersamaan: sapuan penuh lebih dulu masuk antrean.
  const penuh = r.svc.handleProducts({ refresh: "full" });
  const ringan = r.svc.handleProducts({ refresh: "if-stale" });
  await Promise.all([penuh, ringan]);
  await putar(80);

  const akhir = await r.svc.handleProducts({ refresh: "never" });
  assert.equal(akhir.coverage, "full", "collect 1080 ms adalah jangkauan nyata customer");
});

// ===========================================================================
// C. full yang BASI boleh digantikan viewport yang segar
// ===========================================================================

test("C: full yang basi digantikan viewport yang benar-benar baru - dilaporkan apa adanya", () => {
  let t = 1_000_000;
  const s = createCatalogueStore({ now: () => t });
  s.put({ products: SEMUA, coverage: COVERAGE.FULL, source: "pin-collect" });
  t += QUOTE_FRESH_MS + 1;
  const r = s.put({ products: SEMUA, coverage: COVERAGE.VIEWPORT, source: "refresh" });
  assert.equal(r.ok, true, "kesegaran menang: full basi tidak boleh dipertahankan selamanya");
  assert.equal(s.read().coverage, "viewport");
  assert.equal(s.read().source, "refresh");
});

test("C2: full yang basi TIDAK dilaporkan segar hanya karena ia full", () => {
  let t = 1_000_000;
  const s = createCatalogueStore({ now: () => t });
  s.put({ products: SEMUA, coverage: COVERAGE.FULL, source: "pin-collect" });
  t += QUOTE_FRESH_MS + 1;
  const baca = s.read();
  assert.equal(baca.ok, false);
  assert.equal(baca.error, "product-snapshot-stale");
  assert.equal(baca.products, undefined, "snapshot basi tidak pernah membawa produk");
});

// ===========================================================================
// D. sapuan penuh latar dan penyegaran viewport tumpang-tindih
// ===========================================================================

test("D: sapuan penuh latar + penyegaran viewport -> satu-satunya hasil akhir adalah full", async () => {
  const r = rig();
  await r.svc.warmUp();
  r.maju(25_000); // lewati jeda lantai 20 detik
  r.maju(31_000); // dan buat snapshot basi

  const a = r.svc.handleProducts({ refresh: "full" });
  const b = r.svc.handleProducts({ refresh: "if-stale" });
  const c = r.svc.handleProducts({ refresh: "if-stale" });
  await Promise.all([a, b, c]);
  await putar(80);

  const akhir = await r.svc.handleProducts({ refresh: "never" });
  assert.equal(akhir.coverage, "full");
  assert.ok(r.jejak.collect >= 1, "sapuan penuh benar-benar berjalan");
});

// ===========================================================================
// E. collect-before milik PIN menghasilkan full selagi viewport mengantre
// ===========================================================================

test("E: pin collect-before menerbitkan full; viewport yang mengantre tidak menurunkannya", async () => {
  const r = rig();
  await r.svc.warmUp();
  r.mulaiTahan();
  r.maju(31_000);

  const pin = r.svc.handlePin({ scene: "PAX-1", productKey: "garuda kacang atom", playId: 7 });
  await putar(30);
  const ringan = r.svc.handleProducts({ refresh: "if-stale" });
  await putar(30);
  r.lepaskan();
  const [hp] = await Promise.all([pin, ringan]);
  await putar(80);

  assert.equal(hp.ok, true, "pin tetap berhasil: kelengkapan katalog bukan syarat memin");
  const akhir = await r.svc.handleProducts({ refresh: "never" });
  assert.equal(akhir.coverage, "full");
  assert.equal(akhir.source, "pin-collect");
});

// ===========================================================================
// F. STOP selagi penyegaran viewport mengantre
// ===========================================================================

test("F: STOP selagi penyegaran mengantre -> tidak membaca, tidak menerbitkan, tidak menggantung", async () => {
  const r = rig();
  await r.svc.warmUp();
  r.mulaiTahan();
  const onceSebelum = r.jejak.once;
  r.maju(31_000);

  const pin = r.svc.handlePin({ scene: "PAX-1", productKey: "garuda kacang atom", playId: 1 });
  await putar(30);
  const ringan = r.svc.handleProducts({ refresh: "if-stale" });
  await putar(10);

  const stop = r.svc.stop();
  r.lepaskan();
  // Tidak boleh menggantung: ketiganya harus selesai.
  await Promise.all([pin.catch(() => {}), ringan, stop]);
  await putar(80);

  assert.equal(r.jejak.once, onceSebelum, "penyegaran yang mengantre tidak boleh membaca halaman sesudah STOP");
});

test("F1b: STOP selagi mengantre, TANPA full yang lebih baru -> tetap tidak membaca", async () => {
  // Isolasi gerbang STOP. Di sini collect tidak menerbitkan full, jadi gerbang
  // "sudah ada full yang lebih baru" TIDAK menyala - yang menahan pembacaan
  // hanya STOP itu sendiri.
  const r = rig({ unknownCoverage: true });
  await r.svc.warmUp();
  r.mulaiTahan();
  r.maju(31_000);
  const onceSebelum = r.jejak.once;

  const pin = r.svc.handlePin({ scene: "PAX-1", productKey: "garuda kacang atom", playId: 2 });
  await putar(30);
  const ringan = r.svc.handleProducts({ refresh: "if-stale" });
  await putar(10);

  const stop = r.svc.stop();
  r.lepaskan();
  await Promise.all([pin.catch(() => {}), ringan, stop]);
  await putar(80);

  assert.equal(r.jejak.once, onceSebelum, "STOP harus menahan pembacaan walau tidak ada full yang lebih baru");
});

test("F1c: TANPA STOP dan tanpa full baru, penyegaran MEMANG membaca (kontrol positif)", async () => {
  const r = rig({ unknownCoverage: true });
  await r.svc.warmUp();
  r.maju(31_000);
  const onceSebelum = r.jejak.once;
  await r.svc.handleProducts({ refresh: "if-stale" });
  await putar(40);
  assert.ok(r.jejak.once > onceSebelum, "tanpa penghalang, ia harus benar-benar membaca");
});

test("F1d: STOP sedang berjalan, page BELUM ditutup -> penyegaran yang mengantre tetap tidak membaca", async () => {
  // Jendelanya: stopping=true, browser sedang ditutup, page masih ada. Inilah
  // satu-satunya keadaan di mana penjaga `stopping` benar-benar yang menahan.
  const r = rig({ unknownCoverage: true, closeBrowserDelayMs: 60 });
  await r.svc.warmUp();
  r.mulaiTahan();
  r.maju(31_000);
  const onceSebelum = r.jejak.once;

  const pin = r.svc.handlePin({ scene: "PAX-1", productKey: "garuda kacang atom", playId: 3 });
  await putar(30);
  const ringan = r.svc.handleProducts({ refresh: "if-stale" });
  await putar(10);

  const stop = r.svc.stop();      // stopping=true, lalu menunggu closeBrowser 60 ms
  await new Promise((res) => setTimeout(res, 10));
  r.lepaskan();                   // pin selesai -> giliran jatuh ke penyegaran
  await putar(60);
  await Promise.all([pin.catch(() => {}), ringan, stop]);
  await putar(60);

  assert.equal(r.jejak.once, onceSebelum, "penjaga stopping harus menahan pembacaan di jendela ini");
});

test("F2: STOP tidak meninggalkan operasi yatim maupun kesegaran palsu", async () => {
  const r = rig();
  await r.svc.warmUp();
  const sebelum = await r.svc.handleProducts({ refresh: "never" });
  await r.svc.stop();
  const sesudah = await r.svc.handleProducts({ refresh: "never" });
  // capturedAt TIDAK boleh bergerak karena STOP.
  assert.equal(sesudah.capturedAt, sebelum.capturedAt, "STOP tidak memalsukan kesegaran");
});

// ===========================================================================
// KEBIJAKAN KUALITAS, sebagai tabel
// ===========================================================================

test("kebijakan: tabel keputusan penerbitan, eksplisit", () => {
  const kasus = [
    // [tersimpan, umurTersimpan, masuk, harapan, catatan]
    ["full", 0, "viewport", "full", "full segar menang atas viewport"],
    ["full", 5_000, "viewport", "full", "masih di dalam jendela kutip"],
    ["full", QUOTE_FRESH_MS, "viewport", "full", "tepat di ambang: masih bisa dikutip"],
    ["full", QUOTE_FRESH_MS + 1, "viewport", "viewport", "sudah basi: kesegaran menang"],
    ["full", 0, "full", "full", "full boleh menimpa full"],
    ["viewport", 0, "full", "full", "full selalu boleh menimpa viewport"],
    ["viewport", 0, "viewport", "viewport", "viewport boleh menimpa viewport"],
    ["viewport", 60_000, "viewport", "viewport", "viewport basi digantikan viewport baru"],
  ];
  for (const [tersimpan, umur, masuk, harapan, catatan] of kasus) {
    let t = 1_000_000;
    const s = createCatalogueStore({ now: () => t });
    s.put({ products: SEMUA, coverage: tersimpan, source: "awal" });
    t += umur;
    s.put({ products: SEMUA, coverage: masuk, source: "baru" });
    const akhir = s.state();
    assert.equal(akhir.coverage, harapan, catatan + " (tersimpan=" + tersimpan + " umur=" + umur + " masuk=" + masuk + ")");
  }
});

test("kebijakan: tidak ada penggabungan observasi - produk datang dari SATU pembacaan", () => {
  let t = 1_000_000;
  const s = createCatalogueStore({ now: () => t });
  s.put({ products: [P(1, "Satu"), P(2, "Dua"), P(3, "Tiga")], coverage: COVERAGE.FULL, source: "a" });
  t += QUOTE_FRESH_MS + 1;
  s.put({ products: [P(1, "Satu")], coverage: COVERAGE.VIEWPORT, source: "b" });
  const baca = s.read();
  assert.equal(baca.ok, true);
  assert.equal(baca.products.length, 1, "TIDAK digabung dengan observasi sebelumnya");
  assert.equal(baca.coverage, "viewport");
});

test("kebijakan: viewport tidak pernah dinaikkan jadi full", () => {
  let t = 1_000_000;
  const s = createCatalogueStore({ now: () => t });
  s.put({ products: SEMUA, coverage: COVERAGE.VIEWPORT, source: "refresh" });
  assert.equal(s.read().coverage, "viewport");
  t += 1;
  s.put({ products: SEMUA, coverage: COVERAGE.VIEWPORT, source: "refresh" });
  assert.equal(s.read().coverage, "viewport", "mengulang viewport tidak membuatnya lengkap");
});

// ===========================================================================
// PAGAR SUMBER
// ===========================================================================

test("PAGAR: jalur penyegaran ringan MEMBACA ULANG keadaan sesudah dapat giliran", () => {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "autopin", "service.js"), "utf8");
  const i = src.indexOf("const requestedAt = d.now()");
  assert.ok(i > 0, "harus mencatat requestedAt");
  const blok = src.slice(i, i + 2_000);
  assert.ok(/hasFreshFullSince\(requestedAt\)/.test(blok), "harus membaca ulang katalog sesudah antrean");
  // Dan pemeriksaan jam anggarannya SENDIRI tidak boleh jadi satu-satunya syarat.
  const iSisa = blok.indexOf("CATALOGUE_REFRESH_DEADLINE_MS");
  const iFresh = blok.indexOf("hasFreshFullSince");
  assert.ok(iFresh < iSisa, "keadaan katalog diperiksa SEBELUM jam anggaran");
});

test("PAGAR: penerbitan viewport memakai observedAt dan menghormati penolakan", () => {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "autopin", "service.js"), "utf8");
  const i = src.indexOf('source: "refresh"');
  assert.ok(i > 0);
  const blok = src.slice(Math.max(0, i - 600), i + 600);
  assert.ok(/observedAt: readAt/.test(blok), "capturedAt harus waktu pembacaan");
  assert.ok(/if \(!simpan\.ok\)/.test(blok), "penolakan toko harus dihormati, bukan diabaikan");
});
