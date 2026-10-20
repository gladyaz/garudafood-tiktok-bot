// Fondasi snapshot produk di sisi service + pembaca di sisi bot.
//
// Tidak membuka browser, tidak menyentuh TikTok. Browser dan jamnya disuntikkan,
// jadi kepemilikan halaman dan kebijakan kesegaran bisa dibuktikan tanpa Chrome
// dan tanpa menunggu waktu nyata.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { createService } = require("../autopin/service");
const { createCatalogueReader, catalogueUrl, serviceUrl, CATALOGUE_TIMEOUT_MS } = require("../autopin/client");
const { toPublicProduct } = require("../controller/discovery/tiktok");
const { withPriceFields } = require("../autopin/price");

const CONSOLE = "https://shop.tiktok.com/streamer/live/product/dashboard";
const CONFIG = { consoleUrl: CONSOLE, expectedShop: "agen_mulia_abadi", forbiddenShops: ["garudafood"] };

// Produk mentah seperti yang keluar dari readProductsInPage.
const MENTAH = (n, title, extra = {}) => ({
  number: n,
  rowInputs: 1,
  title,
  price: "Rp14.299",
  stock: "In stock: 863",
  priceNodes: [
    { text: "Rp14.299", primary: true, dim: false },
    { text: "Rp23.000", primary: false, dim: true },
  ],
  pinButtons: 1,
  pinVisible: true,
  pinDisabled: false,
  pinText: "Pin",
  pinClass: "sc-rahasia internal",
  imageKey: "x.jpg",
  icons: [],
  ariaOnRow: [],
  badges: [],
  topControls: 1,
  ...extra,
});

// Bentuknya mengikuti collectProducts PRODUKSI, termasuk `coverage` dan
// `completeness`. Fake yang tidak membawa coverage akan ditolak toko katalog
// sebagai unknown-coverage - dan itu memang yang seharusnya terjadi: kalau
// fake di sini mengarang bentuk, yang diuji bukan jalur yang dipakai produksi.
const FULL = (titles, extra = {}) => ({
  products: titles.map((t, i) => withPriceFields(MENTAH(i + 1, t))),
  livePinButtonsOnPage: titles.length,
  invalidRows: 0,
  passes: 3,
  stoppedEarly: false,
  ranOutOfTime: false,
  numberInputsOnPage: titles.length,
  coverage: "full",
  completeness: {
    scope: "clean",
    declaredTotal: titles.length,
    declaredTotalStable: true,
    positions: titles.map((_, i) => i + 1),
    positionsCoverTotal: true,
    contradictoryPositions: 0,
    scrollerStable: true,
    exhaustedScrolls: false,
    bottomReached: false,
    rowsSane: true,
  },
  ...extra,
});

const VIEWPORT = (titles) => ({
  products: titles.map((t, i) => withPriceFields(MENTAH(i + 1, t))),
  livePinButtonsOnPage: titles.length,
  invalidRows: 0,
  passes: 1,
  coverage: "viewport",
  numberInputsOnPage: titles.length,
});

// Rig: satu halaman palsu, satu jam palsu, semua panggilan browser dicatat.
function rig({ full = FULL(["Produk Satu", "Produk Dua"]), viewport = VIEWPORT(["Produk Satu"]), pageUrl = CONSOLE } = {}) {
  const jejak = { launch: 0, getPage: 0, openConsole: 0, collect: 0, once: 0, click: [] };
  let t = 1_000_000;
  let pageClosed = false;
  const page = { url: () => pageUrl, isClosed: () => pageClosed, bringToFront: async () => {} };

  const deps = {
    launchBrowser: async () => { jejak.launch += 1; return { id: "fake" }; },
    getPage: async () => { jejak.getPage += 1; return page; },
    openConsole: async () => { jejak.openConsole += 1; return { url: pageUrl, settled: true, readyMs: 1 }; },
    closeBrowser: async () => {},
    readIdentity: async () => ["agen_mulia_abadi"],
    collectProducts: async () => { jejak.collect += 1; return full; },
    readProductsOnce: async () => { jejak.once += 1; return viewport; },
    pinProductByTitle: async (_p, key) => { jejak.click.push(key); return { ok: true, title: key }; },
    readPinState: async () => ({ found: true, text: "Unpin", disabled: false, buttons: 1 }),
    sleep: async () => {},
    now: () => t,
  };

  const svc = createService({ config: CONFIG, deps });
  return {
    svc, jejak, page,
    maju: (ms) => { t += ms; },
    tutupHalaman: () => { pageClosed = true; },
  };
}

// ---------------------------------------------------------------------------
// SNAPSHOT: diisi dari pembacaan yang service MEMANG sudah lakukan
// ---------------------------------------------------------------------------

test("snapshot: koleksi penuh dari /pin mengisi katalog, ditandai full", async () => {
  const { svc, jejak } = rig();
  assert.equal(svc.catalogue.state().has, false, "belum ada apa-apa sebelum pin");

  const r = await svc.handlePin({ scene: "PAX-1", productKey: "produk satu", playId: 1 });
  assert.equal(r.ok, true);

  const got = await svc.handleProducts();
  assert.equal(got.ok, true);
  assert.equal(got.coverage, "full");
  assert.equal(got.source, "pin-collect");
  assert.equal(got.products.length, 2);
  // Dan pembacaan katalog TIDAK memicu pembacaan halaman tambahan: snapshotnya
  // gratis, diambil dari koleksi yang sudah terjadi untuk keperluan pin.
  assert.equal(jejak.once, 0, "tidak boleh ada pembacaan halaman untuk melayani snapshot segar");
});

test("snapshot: capturedAt dan ageMs ikut jam, diperbarui tiap pin", async () => {
  const { svc, maju } = rig();
  await svc.handlePin({ scene: "PAX-1", productKey: "produk satu", playId: 1 });
  const pertama = (await svc.handleProducts()).capturedAt;

  maju(5_000);
  assert.equal((await svc.handleProducts()).ageMs, 5_000);

  await svc.handlePin({ scene: "PAX-1", productKey: "produk dua", playId: 2 });
  const kedua = await svc.handleProducts();
  assert.equal(kedua.ageMs, 0);
  assert.equal(kedua.capturedAt - pertama, 5_000);
});

test("snapshot: bentuk produk lengkap, dan DOM internal tidak ikut", async () => {
  const { svc } = rig();
  await svc.handlePin({ scene: "PAX-1", productKey: "produk satu", playId: 1 });
  const got = await svc.handleProducts();

  assert.deepEqual(Object.keys(got.products[0]).sort(), [
    "currentPriceText", "number", "originalPriceText", "pinAvailable", "pinDisabled",
    "pinText", "price", "priceRangeText", "priceState", "stableId", "stock", "stockText", "title",
  ]);
  const raw = JSON.stringify(got);
  for (const bocor of ["pinClass", "sc-rahasia", "imageKey", "x.jpg", "priceNodes", "priceRawTexts", "topControls"]) {
    assert.ok(!raw.includes(bocor), bocor + " tidak boleh keluar dari /products");
  }
});

test("snapshot: alias price/stock lama tetap terbawa", async () => {
  const { svc } = rig();
  await svc.handlePin({ scene: "PAX-1", productKey: "produk satu", playId: 1 });
  const p = (await svc.handleProducts()).products[0];
  assert.equal(p.price, "Rp14.299");
  assert.equal(p.stock, "In stock: 863");
  assert.equal(p.stockText, "In stock: 863");
  assert.equal(p.currentPriceText, "Rp14.299");
  assert.equal(p.originalPriceText, "Rp23.000");
  assert.equal(p.priceState, "sale");
});

test("snapshot: daftar yang DIPOTONG anggaran tidak pernah disimpan", async () => {
  // Daftar yang dipotong tidak boleh pernah ditandai "full": ketidakhadiran
  // produk di dalamnya bukan bukti produk itu tidak ada.
  const { svc } = rig({ full: FULL(["Produk Satu"], { ranOutOfTime: true, coverage: "viewport" }) });
  const r = await svc.handlePin({ scene: "PAX-1", productKey: "produk satu", playId: 1 });
  assert.equal(r.reason, "collect-incomplete-budget");
  assert.equal(svc.catalogue.state().has, false, "daftar tidak lengkap tidak boleh tersimpan");
});

test("snapshot: daftar yang berhenti dini tidak pernah disimpan", async () => {
  const { svc } = rig({ full: FULL(["Produk Satu"], { stoppedEarly: true, coverage: "viewport" }) });
  await svc.handlePin({ scene: "PAX-1", productKey: "produk satu", playId: 1 });
  assert.equal(svc.catalogue.state().has, false);
});

test("snapshot: penyimpanan yang gagal TIDAK menggagalkan pin", async () => {
  const { svc, jejak } = rig();
  // Katalog dirusak dengan sengaja: pin tetap harus berhasil mengklik.
  svc.catalogue.put = () => { throw new Error("penyimpanan meledak"); };
  const r = await svc.handlePin({ scene: "PAX-1", productKey: "produk satu", playId: 1 });
  assert.equal(r.ok, true);
  assert.deepEqual(jejak.click, ["produk satu"]);
});

test("snapshot: keberadaan katalog TIDAK mengubah jalannya pin", async () => {
  // Pin kedua tetap melakukan koleksi penuhnya sendiri. Snapshot cache tidak
  // boleh pernah menggantikan collect-before: resolusi pin harus memakai daftar
  // yang baru dibaca, bukan yang tersimpan.
  const { svc, jejak } = rig();
  await svc.handlePin({ scene: "PAX-1", productKey: "produk satu", playId: 1 });
  assert.equal(jejak.collect, 1, "pin pertama tetap melakukan collect-before sendiri");
  await svc.handlePin({ scene: "PAX-2", productKey: "produk dua", playId: 2 });
  assert.equal(jejak.collect, 2, "pin kedua harus mengoleksi ulang, bukan memakai cache");
  assert.deepEqual(jejak.click, ["produk satu", "produk dua"]);
});

// ---------------------------------------------------------------------------
// KESEGARAN lewat rute
// ---------------------------------------------------------------------------

test("kesegaran: basi -> stale tanpa produk; sangat basi -> unavailable", async () => {
  const { svc, maju } = rig();
  await svc.handlePin({ scene: "PAX-1", productKey: "produk satu", playId: 1 });

  maju(45_000);
  const basi = await svc.handleProducts({ refresh: "never" });
  assert.equal(basi.ok, false);
  assert.equal(basi.error, "product-snapshot-stale");
  assert.equal(basi.products, undefined);
  assert.equal(basi.ageMs, 45_000);

  maju(100_000);
  const hilang = await svc.handleProducts({ refresh: "never" });
  assert.equal(hilang.error, "product-snapshot-unavailable");
  assert.equal(hilang.products, undefined);
});

test("kesegaran: tidak pernah ada ok:true yang membawa data basi", async () => {
  const { svc, maju } = rig();
  await svc.handlePin({ scene: "PAX-1", productKey: "produk satu", playId: 1 });
  for (const ms of [0, 10_000, 30_000, 30_001, 60_000, 121_000]) {
    const { svc: s2, maju: m2 } = rig();
    await s2.handlePin({ scene: "PAX-1", productKey: "produk satu", playId: 1 });
    m2(ms);
    const r = await s2.handleProducts({ refresh: "never" });
    if (r.ok) assert.ok(r.ageMs <= 30_000, `ok:true pada umur ${ms} ms`);
    else assert.equal(r.products, undefined, `produk ikut terbawa pada umur ${ms} ms`);
  }
  maju(0);
});

test("kesegaran: pemanggil boleh minta lebih ketat", async () => {
  const { svc, maju } = rig();
  await svc.handlePin({ scene: "PAX-1", productKey: "produk satu", playId: 1 });
  maju(8_000);
  assert.equal((await svc.handleProducts({ maxAgeMs: 10_000, refresh: "never" })).ok, true);
  assert.equal((await svc.handleProducts({ maxAgeMs: 5_000, refresh: "never" })).ok, false);
});

// ---------------------------------------------------------------------------
// KEPEMILIKAN: tidak pernah membuka browser kedua
// ---------------------------------------------------------------------------

test("kepemilikan: tanpa halaman terbuka, /products TIDAK membuka apa pun", async () => {
  const { svc, jejak } = rig();
  const r = await svc.handleProducts();
  assert.equal(r.ok, false);
  assert.equal(r.error, "product-snapshot-unavailable");
  assert.equal(jejak.launch, 0, "launchBrowser tidak boleh pernah dipanggil dari jalur baca-saja");
  assert.equal(jejak.getPage, 0);
  assert.equal(jejak.openConsole, 0);
  assert.equal(jejak.once, 0);
});

test("kepemilikan: halaman yang DITUTUP tidak dibangun ulang", async () => {
  const { svc, jejak, maju, tutupHalaman } = rig();
  await svc.warmUp();
  const sesudahWarm = jejak.launch;
  tutupHalaman();
  maju(45_000);
  const r = await svc.handleProducts();
  assert.equal(r.ok, false);
  assert.equal(jejak.launch, sesudahWarm, "tidak boleh ada peluncuran browser kedua");
});

test("kepemilikan: halaman yang BUKAN dashboard tidak dibaca", async () => {
  const { svc, jejak, maju } = rig({ pageUrl: "https://shop.tiktok.com/streamer/live-console" });
  await svc.warmUp();
  const sebelum = jejak.once;
  maju(45_000);
  const r = await svc.handleProducts();
  assert.equal(r.ok, false);
  assert.equal(jejak.once, sebelum, "halaman tak dikenal tidak boleh discraping");
});

test("kepemilikan: jalur /products tidak memakai ensurePage di sumbernya", () => {
  // Pagar tingkat sumber. Profil Chrome terkunci satu proses: "buka kalau
  // belum ada" di jalur baca-saja bisa berarti merebut profil dari pemiliknya
  // di tengah LIVE.
  const src = fs.readFileSync(path.join(__dirname, "..", "autopin", "service.js"), "utf8");
  const mulai = src.indexOf("async function handleProducts");
  const akhir = src.indexOf("const app = express()", mulai);
  assert.ok(mulai > 0 && akhir > mulai, "handleProducts harus bisa ditemukan di sumber");
  const blok = src.slice(mulai, akhir);
  assert.ok(!blok.includes("ensurePage"), "handleProducts tidak boleh memanggil ensurePage");
  assert.ok(!blok.includes("launchBrowser"), "handleProducts tidak boleh meluncurkan browser");
  assert.ok(blok.includes("pageIfOpen"), "harus memakai halaman yang sudah dimiliki");
});

test("kepemilikan: jalur baca-saja tidak mengklik dan tidak menggulir", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "autopin", "service.js"), "utf8");
  const mulai = src.indexOf("async function handleProducts");
  const blok = src.slice(mulai, src.indexOf("const app = express()", mulai));
  for (const terlarang of ["pinProductByTitle", "PIN_BUTTON", "pc_top_product", "collectProducts", "scrollProductList", "resetScroll", "goto("]) {
    assert.ok(!blok.includes(terlarang), terlarang + " tidak boleh ada di jalur baca-saja");
  }
});

test("kepemilikan: pembacaan satu lintasan tidak menggulir sama sekali", () => {
  const products = require("../autopin/products");
  const src = products.readProductsOnce.toString();
  assert.ok(!src.includes("resetScrollInPage"), "tidak boleh mereset posisi gulir");
  assert.ok(!src.includes("scrollProductListInPage"), "tidak boleh menggulir");
  assert.ok(src.includes("viewport"), "harus menandai dirinya viewport");
});

test("kepemilikan: bot tidak pernah memuat Puppeteer maupun discovery Controller", () => {
  // Diperiksa pada DEPENDENSINYA, bukan dengan mencari kata di teks: kepala
  // berkasnya memang menyebut Puppeteer justru untuk mengatakan ia tidak
  // dipakai, dan pencarian kata akan salah menuduh komentar itu.
  const src = fs.readFileSync(path.join(__dirname, "..", "autopin", "client.js"), "utf8");
  const deps = [...src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(deps, [], "sisi bot tidak boleh punya dependensi modul sama sekali");

  // Dan jalur pembacaan tidak punya cadangan ke discovery Controller: saat
  // automation berjalan, Controller justru TIDAK BISA membaca etalase.
  const { createCatalogueReader } = require("../autopin/client");
  const body = createCatalogueReader.toString();
  for (const terlarang of ["discovery", "launchBrowser", "createTikTokDiscovery", "api/tiktok"]) {
    assert.ok(!body.includes(terlarang), terlarang + " tidak boleh jadi cadangan");
  }
});

// ---------------------------------------------------------------------------
// CAKUPAN: penyegaran ringan menandai dirinya viewport
// ---------------------------------------------------------------------------

test("cakupan: warmUp membaca viewport LALU satu sapuan penuh", async () => {
  // Sejak v0.3.0 warmUp melakukan keduanya: satu lintasan viewport supaya
  // pembaca pertama tidak menemukan katalog kosong, LALU satu sapuan penuh
  // supaya pertanyaan berbasis nama produk bisa dijawab sejak awal run - bukan
  // hanya 30 detik sesudah pin pertama.
  const { svc, jejak } = rig();
  await svc.warmUp();
  assert.equal(jejak.once, 1, "satu lintasan viewport");
  assert.equal(jejak.collect, 1, "satu sapuan penuh");
  const r = await svc.handleProducts();
  assert.equal(r.ok, true);
  assert.equal(r.coverage, "full", "sapuan penuh menang atas viewport");
  assert.equal(r.source, "full-warmup");
});

test("cakupan: sapuan warmUp yang DIPOTONG meninggalkan viewport, bukan full", async () => {
  // Hari yang buruk: sapuan tidak selesai. Daftar terpotong TIDAK boleh
  // ditandai full, dan snapshot viewport dari lintasan pertama tetap berlaku.
  const { svc } = rig({ full: FULL(["Produk Satu"], { ranOutOfTime: true, coverage: "viewport" }) });
  await svc.warmUp();
  const r = await svc.handleProducts();
  assert.equal(r.ok, true);
  assert.equal(r.coverage, "viewport");
  assert.equal(r.source, "warmup");
});

test("cakupan: penyegaran saat basi memakai satu lintasan dan ditandai viewport", async () => {
  const { svc, jejak, maju } = rig();
  await svc.handlePin({ scene: "PAX-1", productKey: "produk satu", playId: 1 });
  assert.equal((await svc.handleProducts()).coverage, "full");

  maju(45_000);
  const r = await svc.handleProducts();
  assert.equal(r.ok, true);
  assert.equal(r.coverage, "viewport", "penyegaran ringan hanya melihat viewport");
  assert.equal(r.source, "refresh");
  assert.equal(r.ageMs, 0);
  assert.equal(jejak.once, 1);
  assert.equal(jejak.collect, 1, "penyegaran TIDAK memakai koleksi bergulir");
});

test("cakupan: ketidakhadiran produk di viewport BUKAN product-not-found", async () => {
  // Pin melihat dua produk; viewport hanya melihat satu. Yang kedua TIDAK
  // boleh terbaca sebagai bukti bahwa produknya tidak ada.
  const { svc, maju } = rig({
    full: FULL(["Produk Satu", "Produk Dua"]),
    viewport: VIEWPORT(["Produk Satu"]),
  });
  await svc.handlePin({ scene: "PAX-1", productKey: "produk satu", playId: 1 });
  maju(45_000);
  const r = await svc.handleProducts();
  assert.equal(r.products.length, 1);
  assert.equal(r.coverage, "viewport");
  // Satu-satunya cara pemanggil boleh menyimpulkan "tidak ada" adalah dari
  // snapshot full. Field inilah yang memungkinkannya; tanpa itu, dua keadaan
  // yang berbeda jadi tidak bisa dibedakan.
  assert.notEqual(r.coverage, "full");
  assert.ok(!r.products.some((p) => /Dua/.test(p.title)));
});

test("cakupan: penyegaran yang KOSONG tidak disimpan dan tidak dilayani", async () => {
  // Nol baris tidak bisa dibedakan dari "daftar belum ter-render". Menyimpannya
  // berarti melayani ok:true dengan nol produk - tepat bentuk jawaban yang
  // membuat "tidak terlihat" terbaca sebagai "tidak ada".
  const { svc, maju } = rig({ viewport: VIEWPORT([]) });
  await svc.handlePin({ scene: "PAX-1", productKey: "produk satu", playId: 1 });
  maju(45_000);
  const r = await svc.handleProducts();
  assert.equal(r.ok, false);
  assert.equal(r.error, "product-snapshot-stale");
});

test("cakupan: penyegaran yang GAGAL tidak melempar dan tidak memalsukan segar", async () => {
  // readProductsOnce meledak: jawabannya tetap vonis basi yang jujur, bukan
  // data lama berlabel segar, dan pemanggil tidak pernah melihat pengecualian.
  const { svc, maju } = rig({ viewport: null }); // null -> batch.products melempar
  await svc.handlePin({ scene: "PAX-1", productKey: "produk satu", playId: 1 });
  maju(45_000);
  const r = await svc.handleProducts();
  assert.equal(r.ok, false);
  assert.equal(r.error, "product-snapshot-stale");
  assert.equal(r.products, undefined);
});

test("refresh=never: tidak pernah menyentuh halaman", async () => {
  const { svc, jejak, maju } = rig();
  await svc.handlePin({ scene: "PAX-1", productKey: "produk satu", playId: 1 });
  maju(45_000);
  const sebelum = jejak.once;
  const r = await svc.handleProducts({ refresh: "never" });
  assert.equal(r.error, "product-snapshot-stale");
  assert.equal(jejak.once, sebelum, "refresh=never tidak boleh membaca halaman");
});

// ---------------------------------------------------------------------------
// SERIALISASI: pembacaan tidak boleh menyelip ke tengah pin
// ---------------------------------------------------------------------------

test("serialisasi: penyegaran katalog tidak tumpang-tindih dengan pin", async () => {
  const urutan = [];
  let lepas = null;
  let t = 1_000_000;
  const page = { url: () => CONSOLE, isClosed: () => false, bringToFront: async () => {} };
  const svc = createService({
    config: CONFIG,
    deps: {
      launchBrowser: async () => ({ id: "fake" }),
      getPage: async () => page,
      openConsole: async () => ({ url: CONSOLE, settled: true, readyMs: 1 }),
      closeBrowser: async () => {},
      readIdentity: async () => ["agen_mulia_abadi"],
      collectProducts: async () => {
        urutan.push("pin:collect-mulai");
        if (!lepas) await new Promise((r) => { lepas = r; });
        urutan.push("pin:collect-selesai");
        return FULL(["Produk Satu"]);
      },
      readProductsOnce: async () => {
        urutan.push("refresh:baca");
        return VIEWPORT(["Produk Satu"]);
      },
      pinProductByTitle: async (_p, key) => { urutan.push("pin:klik"); return { ok: true, title: key }; },
      readPinState: async () => ({ found: true, text: "Unpin", disabled: false, buttons: 1 }),
      sleep: async () => {},
      now: () => t,
    },
  });

  const pin = svc.handlePin({ scene: "PAX-1", productKey: "produk satu", playId: 1 });
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.equal(typeof lepas, "function", "pin harus sedang mengoleksi produk");

  const baca = svc.handleProducts({ maxAgeMs: 0 });
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.ok(!urutan.includes("refresh:baca"), "pembacaan TIDAK boleh menyelip saat pin bekerja");

  lepas();
  await pin;
  await baca;

  // Sesudah pin selesai, ia sudah menerbitkan snapshot FULL yang lebih baru
  // daripada permintaan penyegaran ini - jadi pembacaan ringannya memang
  // MUBAZIR dan dilewati. Yang dibuktikan tes ini tetap sama: ia tidak pernah
  // menyelip di tengah pin. Bahwa ia juga tidak jalan SESUDAHNYA adalah
  // perbaikan, bukan kemunduran.
  assert.ok(!urutan.includes("refresh:baca"), "penyegaran mubazir tidak perlu membaca halaman: " + urutan.join(" > "));
  assert.ok(urutan.indexOf("pin:klik") >= 0, "pin tetap mengklik: " + urutan.join(" > "));
});

test("serialisasi: TANPA full yang lebih baru, penyegaran tetap menunggu pin lalu jalan", async () => {
  // Pasangan tes di atas: di sini pin TIDAK menerbitkan full (coverage viewport,
  // mis. daftar yang tersaring), jadi penyegaran ringan tidak mubazir. Yang
  // diuji adalah URUTANNYA - ia harus jalan SESUDAH klik pin, tidak menyelip.
  const urutan = [];
  let lepas = null;
  let t = 1_000_000;
  const page = { url: () => CONSOLE, isClosed: () => false, bringToFront: async () => {} };
  const svc = createService({
    config: CONFIG,
    deps: {
      launchBrowser: async () => ({ id: "fake" }),
      getPage: async () => page,
      openConsole: async () => ({ url: CONSOLE, settled: true, readyMs: 1 }),
      closeBrowser: async () => {},
      readIdentity: async () => ["agen_mulia_abadi"],
      collectProducts: async () => {
        urutan.push("pin:collect-mulai");
        if (!lepas) await new Promise((r) => { lepas = r; });
        urutan.push("pin:collect-selesai");
        return FULL(["Produk Satu"], { coverage: "viewport" });
      },
      readProductsOnce: async () => {
        urutan.push("refresh:baca");
        return VIEWPORT(["Produk Satu"]);
      },
      pinProductByTitle: async (_p, key) => { urutan.push("pin:klik"); return { ok: true, title: key }; },
      readPinState: async () => ({ found: true, text: "Unpin", disabled: false, buttons: 1 }),
      sleep: async () => {},
      now: () => t,
    },
  });

  const pin = svc.handlePin({ scene: "PAX-1", productKey: "produk satu", playId: 1 });
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.equal(typeof lepas, "function", "pin harus sedang mengoleksi produk");

  const baca = svc.handleProducts({ maxAgeMs: 0 });
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.ok(!urutan.includes("refresh:baca"), "pembacaan TIDAK boleh menyelip saat pin bekerja");

  lepas();
  await pin;
  await baca;

  const iKlik = urutan.indexOf("pin:klik");
  const iBaca = urutan.indexOf("refresh:baca");
  assert.ok(iKlik >= 0 && iBaca > iKlik, "penyegaran harus menunggu pin selesai: " + urutan.join(" > "));
});

test("serialisasi: anggaran penyegaran jauh di bawah anggaran pin", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "autopin", "service.js"), "utf8");
  const m = /CATALOGUE_REFRESH_DEADLINE_MS = ([\d_]+)/.exec(src);
  assert.ok(m, "anggaran penyegaran harus berupa konstanta yang bisa dibaca");
  const ms = Number(m[1].replace(/_/g, ""));
  assert.equal(ms, 1_500);
  assert.ok(ms < 8_000, "tidak boleh memakai anggaran jalur pin");
});

// ---------------------------------------------------------------------------
// HEALTH
// ---------------------------------------------------------------------------

test("health: melaporkan snapshot tanpa membawa produknya", async () => {
  const { svc, maju } = rig();
  assert.deepEqual(svc.healthPayload().productSnapshot, { has: false, refusals: [] });
  await svc.handlePin({ scene: "PAX-1", productKey: "produk satu", playId: 1 });
  maju(3_000);
  const h = svc.healthPayload();
  assert.equal(h.productSnapshot.has, true);
  assert.equal(h.productSnapshot.count, 2);
  assert.equal(h.productSnapshot.coverage, "full");
  assert.equal(h.productSnapshot.ageMs, 3_000);
  assert.ok(!JSON.stringify(h).includes("Produk Satu"), "health tidak boleh membawa judul produk");
});

// ---------------------------------------------------------------------------
// RUTE HTTP
// ---------------------------------------------------------------------------

function dengarkan(svc) {
  return new Promise((resolve) => {
    const server = svc.app.listen(0, "127.0.0.1", () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

test("rute: GET /products melayani bentuk yang tertutup", async () => {
  const { svc } = rig();
  await svc.handlePin({ scene: "PAX-1", productKey: "produk satu", playId: 1 });
  const { server, base } = await dengarkan(svc);
  try {
    const res = await fetch(`${base}/products`);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ["ageMs", "capturedAt", "coverage", "ok", "products", "source"]);
    assert.equal(body.ok, true);
    assert.equal(body.coverage, "full");

    // POST tidak dilayani: rute ini baca-saja, dan metodenya yang mengatakannya.
    const post = await fetch(`${base}/products`, { method: "POST" });
    assert.equal(post.status, 404);
  } finally {
    server.close();
  }
});

test("rute: maxAgeMs kosong/rusak dianggap tidak diisi, bukan nol", async () => {
  const { svc } = rig();
  await svc.handlePin({ scene: "PAX-1", productKey: "produk satu", playId: 1 });
  const { server, base } = await dengarkan(svc);
  try {
    for (const q of ["", "?maxAgeMs=", "?maxAgeMs=abc"]) {
      const body = await (await fetch(`${base}/products${q}`)).json();
      assert.equal(body.ok, true, q);
    }
    const ketat = await (await fetch(`${base}/products?maxAgeMs=10000&refresh=never`)).json();
    assert.equal(ketat.ok, true, "permintaan ketat yang masuk akal tetap dilayani");
  } finally {
    server.close();
  }
});

test("maxAgeMs=0 TIDAK BISA dipenuhi, dan itu keputusan - bukan kecelakaan", async () => {
  // Pembacaan halaman selalu memakan waktu, jadi sesudah penyegaran pun umurnya
  // sudah beberapa milidetik. Yang dipilih adalah MENOLAK, bukan melonggarkan
  // diam-diam ke kebijakan bawaan: melonggarkan berarti pemanggil yang meminta
  // ketat justru dilayani data yang lebih tua dari yang ia minta.
  //
  // Dibuktikan dengan jam yang BERJALAN, bukan jam beku - persis keadaan yang
  // membuat perilaku ini pertama kali terlihat.
  // Jam yang BERJALAN: setiap pembacaan jam maju 1 ms, seperti waktu
  // sungguhan. Dengan jam beku bug ini tidak akan pernah terlihat.
  let t = 1_000_000;
  const page = { url: () => CONSOLE, isClosed: () => false, bringToFront: async () => {} };
  const svc = createService({
    config: CONFIG,
    deps: {
      launchBrowser: async () => ({ id: "f" }),
      getPage: async () => page,
      openConsole: async () => ({ url: CONSOLE, settled: true, readyMs: 1 }),
      closeBrowser: async () => {},
      readIdentity: async () => ["agen_mulia_abadi"],
      collectProducts: async () => FULL(["Produk Satu"]),
      readProductsOnce: async () => VIEWPORT(["Produk Satu"]),
      pinProductByTitle: async (_p, key) => ({ ok: true, title: key }),
      readPinState: async () => ({ found: true, text: "Unpin", disabled: false, buttons: 1 }),
      sleep: async () => {},
      now: () => (t += 1),
    },
  });
  await svc.warmUp();
  const r = await svc.handleProducts({ maxAgeMs: 0 });
  assert.equal(r.ok, false, "umur 0 ms tidak pernah bisa dicapai");
  assert.equal(r.error, "product-snapshot-stale");
  assert.ok(r.ageMs > 0, "umurnya selalu di atas nol, sekecil apa pun");

  // dan permintaan yang masuk akal pada snapshot yang sama BERHASIL
  const wajar = await svc.handleProducts({ maxAgeMs: 1_000 });
  assert.equal(wajar.ok, true);
  // DULU "viewport": penyegaran ringan yang dipicu maxAgeMs=0 menimpa snapshot
  // full milik warmUp. Itu BALAPANNYA, bukan perilaku yang diinginkan - satu
  // pertanyaan bernomor mematikan jalur nama. Penjaga would-downgrade sekarang
  // menahannya selama full-nya masih bisa dikutip.
  assert.equal(wajar.coverage, "full", "viewport tidak boleh menurunkan full yang masih segar");
});

test("rute: tanpa snapshot -> ok:false tanpa produk", async () => {
  const { svc } = rig();
  const { server, base } = await dengarkan(svc);
  try {
    const body = await (await fetch(`${base}/products`)).json();
    assert.equal(body.ok, false);
    assert.equal(body.error, "product-snapshot-unavailable");
    assert.equal(body.products, undefined);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// PEMBACA SISI BOT
// ---------------------------------------------------------------------------

test("pembaca: alamatnya sama dengan jalur pin, hanya rutenya beda", () => {
  assert.equal(serviceUrl({}), "http://127.0.0.1:5055/pin");
  assert.equal(catalogueUrl({}), "http://127.0.0.1:5055/products");
  assert.equal(catalogueUrl({ AUTOPIN_PORT: "6000" }), "http://127.0.0.1:6000/products");
  assert.equal(catalogueUrl({ AUTOPIN_SERVICE_URL: "http://127.0.0.1:7000/" }), "http://127.0.0.1:7000/products");
});

test("pembaca: batas tunggunya pendek, bukan 8 detik milik pin", () => {
  assert.equal(CATALOGUE_TIMEOUT_MS, 1_500);
  assert.ok(CATALOGUE_TIMEOUT_MS < 8_000);
});

test("pembaca: memakai GET dan meneruskan parameter", async () => {
  const dilihat = [];
  const baca = createCatalogueReader({
    url: "http://127.0.0.1:1/products",
    fetchFn: async (url, opts) => {
      dilihat.push({ url, method: opts.method });
      return { ok: true, json: async () => ({ ok: true, products: [], coverage: "full", ageMs: 1 }) };
    },
  });
  await baca();
  await baca({ maxAgeMs: 5000, refresh: "never" });
  assert.equal(dilihat[0].method, "GET");
  assert.equal(dilihat[0].url, "http://127.0.0.1:1/products");
  assert.match(dilihat[1].url, /maxAgeMs=5000/);
  assert.match(dilihat[1].url, /refresh=never/);
});

test("pembaca: service mati -> error terstruktur, tidak melempar", async () => {
  const baca = createCatalogueReader({
    url: "http://127.0.0.1:1/products",
    fetchFn: async () => { throw Object.assign(new Error("gagal konek"), { name: "TypeError" }); },
  });
  const r = await baca();
  assert.equal(r.ok, false);
  assert.equal(r.error, "product-snapshot-unavailable");
});

test("pembaca: habis waktu -> tidak tersedia, bukan menunggu", async () => {
  const baca = createCatalogueReader({
    url: "http://127.0.0.1:1/products",
    timeoutMs: 20,
    fetchFn: (url, opts) => new Promise((_res, rej) => {
      opts.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }),
  });
  const t0 = Date.now();
  const r = await baca();
  assert.equal(r.ok, false);
  assert.equal(r.error, "product-snapshot-unavailable");
  assert.equal(r.detail, "AbortError");
  assert.ok(Date.now() - t0 < 1_000, "tidak boleh menunggu lama");
});

test("pembaca: stale dari service diteruskan apa adanya", async () => {
  const baca = createCatalogueReader({
    url: "http://127.0.0.1:1/products",
    fetchFn: async () => ({ ok: true, json: async () => ({ ok: false, error: "product-snapshot-stale", ageMs: 45_000 }) }),
  });
  const r = await baca();
  assert.equal(r.error, "product-snapshot-stale");
  assert.equal(r.ageMs, 45_000);
  assert.equal(r.products, undefined);
});

test("pembaca: ok:true tanpa daftar produk DITOLAK", async () => {
  // Bentuknya diperiksa, bukan dipercaya: jawaban aneh tidak boleh lolos
  // sebagai katalog kosong yang sah.
  for (const body of [{ ok: true }, { ok: true, products: null }, { ok: true, products: "x" }]) {
    const baca = createCatalogueReader({
      url: "http://127.0.0.1:1/products",
      fetchFn: async () => ({ ok: true, json: async () => body }),
    });
    const r = await baca();
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.equal(r.error, "product-snapshot-unavailable");
  }
});

test("pembaca: HTTP non-2xx dan body bukan JSON -> tidak tersedia", async () => {
  const a = createCatalogueReader({ url: "u", fetchFn: async () => ({ ok: false, status: 500 }) });
  assert.equal((await a()).error, "product-snapshot-unavailable");
  const b = createCatalogueReader({ url: "u", fetchFn: async () => ({ ok: true, json: async () => { throw new Error("bukan json"); } }) });
  assert.equal((await b()).error, "product-snapshot-unavailable");
});

test("pembaca: tanpa fetch sama sekali -> tidak melempar", async () => {
  const baca = createCatalogueReader({ url: "u", fetchFn: null, env: {} });
  const prev = globalThis.fetch;
  globalThis.fetch = undefined;
  try {
    assert.equal((await baca()).error, "fetch-unavailable");
  } finally {
    globalThis.fetch = prev;
  }
});

// ---------------------------------------------------------------------------
// KOMPATIBILITAS LINTAS LAPIS
// ---------------------------------------------------------------------------

test("kompatibilitas: toPublicProduct Controller tetap menerima price/stock", () => {
  // Dropdown produk customer menampilkan "harga - stok" dari dua field ini.
  // Field harga yang baru ditambahkan di bawahnya tidak boleh menggesernya.
  const p = toPublicProduct(withPriceFields(MENTAH(1, "Garuda Kacang ATOM")));
  assert.equal(p.price, "Rp14.299");
  assert.equal(p.stock, "In stock: 863");
  assert.deepEqual(Object.keys(p).sort(), [
    "number", "pinAvailable", "pinDisabled", "pinText", "price", "stableId", "stock", "title",
  ]);
});

test("kompatibilitas: field harga baru TIDAK merembes ke kontrak Controller", () => {
  const raw = JSON.stringify(toPublicProduct(withPriceFields(MENTAH(1, "A"))));
  for (const baru of ["currentPriceText", "priceState", "priceNodes", "priceRawTexts", "stockText"]) {
    assert.ok(!raw.includes(baru), baru + " bukan bagian kontrak Controller");
  }
});
