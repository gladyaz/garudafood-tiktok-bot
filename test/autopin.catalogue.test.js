// Snapshot katalog produk: penyimpanan, bentuk, cakupan, dan kebijakan
// kesegaran. Jam disuntikkan, jadi tidak ada satu pun tes di sini yang menunggu
// waktu nyata.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createCatalogueStore, toSnapshotProduct, QUOTE_FRESH_MS, HARD_STALE_MS, COVERAGE,
} = require("../autopin/catalogue");

// Produk MENTAH seperti yang keluar dari readProductsInPage + withPriceFields.
const RAW = (extra = {}) => ({
  number: 1,
  rowInputs: 1,
  title: "Garuda - Kacang ATOM 16gr 1 RENCENG ISI 10 PCS oat - GRD",
  price: "Rp14.299",
  stock: "In stock: 863",
  stockText: "In stock: 863",
  currentPriceText: "Rp14.299",
  originalPriceText: "Rp23.000",
  priceRangeText: "",
  priceState: "sale",
  priceNodes: [{ text: "Rp14.299", primary: true, dim: false }],
  priceRawTexts: ["Rp14.299", "Rp23.000"],
  imageKey: "abc.jpg",
  productId: "",
  pinButtons: 1,
  pinDisabled: false,
  pinVisible: true,
  pinText: "Pin",
  pinClass: "sc-xyz tombol-internal",
  topControls: 1,
  icons: ["arco-icon-pin"],
  ariaOnRow: [],
  badges: [],
  ...extra,
});

function toko(t0 = 1_000_000) {
  let t = t0;
  const s = createCatalogueStore({ now: () => t });
  return { s, maju: (ms) => { t += ms; }, waktu: () => t };
}

// ---------------------------------------------------------------------------
// BENTUK
// ---------------------------------------------------------------------------

test("toSnapshotProduct: bentuk field-nya tertutup", () => {
  assert.deepEqual(Object.keys(toSnapshotProduct(RAW())).sort(), [
    "currentPriceText", "number", "originalPriceText", "pinAvailable", "pinDisabled",
    "pinText", "price", "priceRangeText", "priceState", "stableId", "stock", "stockText", "title",
  ]);
});

test("toSnapshotProduct: struktur DOM internal TIDAK ikut", () => {
  const raw = JSON.stringify(toSnapshotProduct(RAW()));
  for (const bocor of ["pinClass", "tombol-internal", "icons", "arco-icon", "imageKey", "abc.jpg", "priceNodes", "topControls", "rowInputs"]) {
    assert.ok(!raw.includes(bocor), bocor + " tidak boleh keluar dari snapshot");
  }
});

test("toSnapshotProduct: alias kompatibilitas price/stock tetap ada", () => {
  const p = toSnapshotProduct(RAW());
  assert.equal(p.price, "Rp14.299");
  assert.equal(p.stock, "In stock: 863");
  assert.equal(p.stockText, "In stock: 863");
});

test("toSnapshotProduct: stockText jatuh ke stock kalau belum diisi", () => {
  const p = toSnapshotProduct(RAW({ stockText: undefined }));
  assert.equal(p.stockText, "In stock: 863");
});

test("toSnapshotProduct: stableId null dan TIDAK dikarang dari nomor", () => {
  const p = toSnapshotProduct(RAW({ number: 7 }));
  assert.equal(p.stableId, null);
  assert.equal(p.number, 7);
  assert.notEqual(String(p.stableId), "7");
});

test("toSnapshotProduct: nomor bukan bilangan bulat jadi null", () => {
  assert.equal(toSnapshotProduct(RAW({ number: "2" })).number, null);
  assert.equal(toSnapshotProduct(RAW({ number: null })).number, null);
});

test("toSnapshotProduct: pinAvailable dari ada-tidaknya kontrol pin", () => {
  assert.equal(toSnapshotProduct(RAW({ pinButtons: 0 })).pinAvailable, false);
  assert.equal(toSnapshotProduct(RAW({ pinButtons: 1 })).pinAvailable, true);
  assert.equal(toSnapshotProduct(RAW({ pinDisabled: true })).pinDisabled, true);
});

test("toSnapshotProduct: priceState default unknown, bukan kosong", () => {
  const p = toSnapshotProduct({ title: "x", number: 1 });
  assert.equal(p.priceState, "unknown");
  assert.equal(p.currentPriceText, "");
});

// ---------------------------------------------------------------------------
// PENYIMPANAN
// ---------------------------------------------------------------------------

test("put: snapshot penuh tersimpan, capturedAt dari jam", () => {
  const { s, waktu } = toko();
  const r = s.put({ products: [RAW()], coverage: COVERAGE.FULL, source: "pin-collect" });
  assert.equal(r.ok, true);
  assert.equal(r.capturedAt, waktu());
  const got = s.read();
  assert.equal(got.ok, true);
  assert.equal(got.coverage, "full");
  assert.equal(got.source, "pin-collect");
  assert.equal(got.products.length, 1);
});

test("put: capturedAt DIPERBARUI setiap penyimpanan", () => {
  const { s, maju, waktu } = toko();
  s.put({ products: [RAW()], coverage: COVERAGE.FULL, source: "pin-collect" });
  const pertama = s.read().capturedAt;
  maju(5_000);
  s.put({ products: [RAW()], coverage: COVERAGE.FULL, source: "pin-collect" });
  assert.equal(s.read().capturedAt, waktu());
  assert.equal(s.read().capturedAt - pertama, 5_000);
  assert.equal(s.read().ageMs, 0);
});

test("put: cakupan yang tidak dikenal DITOLAK, bukan ditebak", () => {
  // "full" yang salah membuat ketidakhadiran produk terlihat seperti bukti
  // produk itu tidak ada.
  const { s } = toko();
  for (const bad of [undefined, "", "penuh", "partial", "FULL", null]) {
    assert.equal(s.put({ products: [RAW()], coverage: bad, source: "x" }).reason, "unknown-coverage");
  }
  assert.equal(s.read().ok, false);
});

test("put: produk yang bukan array ditolak", () => {
  const { s } = toko();
  assert.equal(s.put({ products: null, coverage: COVERAGE.FULL }).reason, "products-not-array");
  assert.equal(s.put({ coverage: COVERAGE.FULL }).reason, "products-not-array");
});

// KEBIJAKAN PENERBITAN. Dulu tes ini menuntut viewport SELALU menimpa full,
// dengan alasan "kejujuran di atas optimisme". Itu benar soal pelaporan tapi
// salah soal penerbitan: ia adalah balapan yang terbukti mematikan jalur nama -
// satu pertanyaan bernomor yang mengantre di belakang sapuan penuh menimpa
// hasil sapuan itu. Yang dijaga sekarang: kesegaran tetap menang, tapi di DALAM
// jendela kutip yang menang adalah yang bisa menjawab lebih banyak.
test("put: viewport TIDAK menimpa full yang masih segar", () => {
  const { s, maju } = toko();
  s.put({ products: [RAW()], coverage: COVERAGE.FULL, source: "pin-collect" });
  maju(5_000);
  const r = s.put({ products: [RAW()], coverage: COVERAGE.VIEWPORT, source: "refresh" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "would-downgrade");
  assert.equal(s.read().coverage, "full");
  assert.equal(s.read().source, "pin-collect");
});

test("put: viewport yang benar-benar baru MENGGANTIKAN full yang sudah basi", () => {
  const { s, maju } = toko();
  s.put({ products: [RAW()], coverage: COVERAGE.FULL, source: "pin-collect" });
  // Lewat ambang kutip: full-nya tidak bisa dipakai lagi, jadi ia tidak boleh
  // menghalangi pengamatan yang masih berguna.
  maju(31_000);
  const r = s.put({ products: [RAW()], coverage: COVERAGE.VIEWPORT, source: "refresh" });
  assert.equal(r.ok, true);
  assert.equal(s.read().coverage, "viewport");
  assert.equal(s.read().source, "refresh");
});

test("put: full BOLEH menimpa full, dan viewport boleh menimpa viewport", () => {
  const { s, maju } = toko();
  s.put({ products: [RAW()], coverage: COVERAGE.VIEWPORT, source: "warmup" });
  maju(1_000);
  assert.equal(s.put({ products: [RAW()], coverage: COVERAGE.VIEWPORT, source: "refresh" }).ok, true);
  maju(1_000);
  assert.equal(s.put({ products: [RAW()], coverage: COVERAGE.FULL, source: "full-qa" }).ok, true);
  maju(1_000);
  assert.equal(s.put({ products: [RAW()], coverage: COVERAGE.FULL, source: "pin-collect" }).ok, true);
  assert.equal(s.read().coverage, "full");
});

test("put: pengamatan yang LEBIH TUA dari yang tersimpan ditolak (out-of-order)", () => {
  const { s, maju, waktu } = toko();
  const t0 = waktu();
  maju(10_000);
  s.put({ products: [RAW()], coverage: COVERAGE.FULL, source: "full-qa", observedAt: waktu() });
  // Pengamatan yang SELESAI lebih dulu tapi diterbitkan terakhir.
  const r = s.put({ products: [RAW()], coverage: COVERAGE.FULL, source: "pin-collect", observedAt: t0 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "out-of-order");
  assert.equal(s.read().source, "full-qa");
});

test("put: capturedAt memakai observedAt, bukan saat penerbitan", () => {
  const { s, maju, waktu } = toko();
  const dibaca = waktu();
  // Sapuan 6 detik: hasilnya diterbitkan jauh sesudah halamannya dibaca.
  maju(6_000);
  s.put({ products: [RAW()], coverage: COVERAGE.FULL, source: "full-qa", observedAt: dibaca });
  assert.equal(s.read().capturedAt, dibaca);
  assert.equal(s.read().ageMs, 6_000, "umurnya dihitung dari pembacaan, bukan penerbitan");
});

test("put: observedAt yang tidak masuk akal jatuh ke jam sekarang", () => {
  const { s, waktu } = toko();
  for (const buruk of [undefined, null, 0, -5, "kemarin", NaN]) {
    const { s: bersih, waktu: w } = toko();
    bersih.put({ products: [RAW()], coverage: COVERAGE.FULL, source: "x", observedAt: buruk });
    assert.equal(bersih.read().capturedAt, w(), "observedAt=" + String(buruk));
  }
  assert.ok(waktu() > 0);
});

test("put: snapshot adalah salinan — mengubah produk mentah tidak mengubahnya", () => {
  const { s } = toko();
  const mentah = RAW();
  s.put({ products: [mentah], coverage: COVERAGE.FULL, source: "pin-collect" });
  mentah.currentPriceText = "Rp1";
  mentah.title = "DIGANTI";
  const p = s.read().products[0];
  assert.equal(p.currentPriceText, "Rp14.299");
  assert.match(p.title, /Kacang ATOM/);
});

// ---------------------------------------------------------------------------
// KESEGARAN
// ---------------------------------------------------------------------------

test("kebijakan: 30 detik untuk mengutip, 120 detik batas keras", () => {
  assert.equal(QUOTE_FRESH_MS, 30_000);
  assert.equal(HARD_STALE_MS, 120_000);
  assert.ok(QUOTE_FRESH_MS < HARD_STALE_MS);
});

test("read: tanpa snapshot -> unavailable, tanpa produk", () => {
  const r = toko().s.read();
  assert.equal(r.ok, false);
  assert.equal(r.error, "product-snapshot-unavailable");
  assert.equal(r.products, undefined);
});

test("read: di bawah 30 detik -> terpakai", () => {
  const { s, maju } = toko();
  s.put({ products: [RAW()], coverage: COVERAGE.FULL, source: "pin-collect" });
  for (const ms of [0, 1, 1_000, 29_999, 30_000]) {
    const { s: s2, maju: m2 } = toko();
    s2.put({ products: [RAW()], coverage: COVERAGE.FULL, source: "pin-collect" });
    m2(ms);
    const r = s2.read();
    assert.equal(r.ok, true, ms + " ms harus masih terpakai");
    assert.equal(r.ageMs, ms);
  }
  maju(30_000);
  assert.equal(s.read().ok, true);
});

test("read: 30-120 detik -> stale, dan TANPA produk", () => {
  // Pagar utama: tidak ada satu pun jalan yang mengembalikan data basi
  // bersama ok:true.
  for (const ms of [30_001, 60_000, 119_999, 120_000]) {
    const { s, maju } = toko();
    s.put({ products: [RAW()], coverage: COVERAGE.FULL, source: "pin-collect" });
    maju(ms);
    const r = s.read();
    assert.equal(r.ok, false, ms + " ms harus basi");
    assert.equal(r.error, "product-snapshot-stale");
    assert.equal(r.products, undefined, "produk basi tidak boleh ikut");
    assert.equal(r.ageMs, ms);
    // umurnya tetap dilaporkan supaya pemanggil tahu ini basi, bukan hilang
    assert.equal(r.coverage, "full");
  }
});

test("read: di atas 120 detik -> unavailable, bukan sekadar stale", () => {
  // Bedanya penting: ok:false "tidak tersedia" memaksa penolakan, sedangkan
  // umur besar mengundang pemanggil berikutnya untuk memakainya saja.
  for (const ms of [120_001, 600_000]) {
    const { s, maju } = toko();
    s.put({ products: [RAW()], coverage: COVERAGE.FULL, source: "pin-collect" });
    maju(ms);
    const r = s.read();
    assert.equal(r.error, "product-snapshot-unavailable", ms + " ms");
    assert.equal(r.products, undefined);
  }
});

test("read: pemanggil boleh lebih KETAT", () => {
  const { s, maju } = toko();
  s.put({ products: [RAW()], coverage: COVERAGE.FULL, source: "pin-collect" });
  maju(6_000);
  assert.equal(s.read({ maxAgeMs: 10_000 }).ok, true);
  assert.equal(s.read({ maxAgeMs: 5_000 }).ok, false);
  assert.equal(s.read({ maxAgeMs: 5_000 }).error, "product-snapshot-stale");
  assert.equal(s.read({ maxAgeMs: 0 }).ok, false);
});

test("read: pemanggil TIDAK boleh lebih longgar dari kebijakan", () => {
  const { s, maju } = toko();
  s.put({ products: [RAW()], coverage: COVERAGE.FULL, source: "pin-collect" });
  maju(45_000);
  for (const longgar of [60_000, 119_000, Number.MAX_SAFE_INTEGER, Infinity]) {
    const r = s.read({ maxAgeMs: longgar });
    assert.equal(r.ok, false, longgar + " tidak boleh melonggarkan kebijakan");
    assert.equal(r.error, "product-snapshot-stale");
  }
});

test("read: maxAgeMs rusak jatuh ke kebijakan bawaan", () => {
  const { s, maju } = toko();
  s.put({ products: [RAW()], coverage: COVERAGE.FULL, source: "pin-collect" });
  maju(10_000);
  for (const bad of [undefined, null, NaN, "abc", -5]) {
    assert.equal(s.read({ maxAgeMs: bad }).ok, true, String(bad));
  }
});

test("read: jam yang mundur tidak menghasilkan umur negatif", () => {
  let t = 1_000_000;
  const s = createCatalogueStore({ now: () => t });
  s.put({ products: [RAW()], coverage: COVERAGE.FULL, source: "pin-collect" });
  t -= 5_000;
  const r = s.read();
  assert.equal(r.ok, true);
  assert.equal(r.ageMs, 0);
});

test("needsRefresh: hanya saat melewati ambang", () => {
  const { s, maju } = toko();
  assert.equal(s.needsRefresh(), true, "tanpa snapshot selalu perlu");
  s.put({ products: [RAW()], coverage: COVERAGE.FULL, source: "pin-collect" });
  assert.equal(s.needsRefresh(), false);
  maju(30_001);
  assert.equal(s.needsRefresh(), true);
  assert.equal(s.needsRefresh({ maxAgeMs: 10_000 }), true);
});

test("state: diagnostik tanpa produk, dan menghitung harga unknown", () => {
  const { s, maju } = toko();
  assert.deepEqual(s.state(), { has: false, refusals: [] });
  s.put({
    products: [RAW(), RAW({ number: 2, priceState: "unknown", currentPriceText: "" })],
    coverage: COVERAGE.FULL,
    source: "pin-collect",
  });
  maju(2_000);
  const st = s.state();
  assert.equal(st.has, true);
  assert.equal(st.count, 2);
  assert.equal(st.unknownPrice, 1);
  assert.equal(st.ageMs, 2_000);
  assert.equal(st.coverage, "full");
  assert.equal(JSON.stringify(st).includes("Kacang ATOM"), false, "state tidak boleh membawa produk");
});

// ---------------------------------------------------------------------------
// CAKUPAN: ketidakhadiran di viewport BUKAN bukti
// ---------------------------------------------------------------------------

test("cakupan: snapshot viewport tetap menyebut dirinya viewport saat dibaca", () => {
  const { s } = toko();
  s.put({ products: [RAW()], coverage: COVERAGE.VIEWPORT, source: "warmup" });
  const r = s.read();
  assert.equal(r.ok, true);
  assert.equal(r.coverage, "viewport");
  // Pemanggil WAJIB bisa membedakannya: tanpa field ini, "tidak ada di daftar"
  // tidak bisa dipisahkan dari "tidak ada di etalase".
  assert.notEqual(r.coverage, "full");
});

test("cakupan: tiga nilai ada, tapi hanya DUA yang bisa disimpan", () => {
  assert.deepEqual(Object.values(COVERAGE).sort(), ["full", "unknown", "viewport"]);
  // "unknown" berarti barisnya sendiri tidak boleh dipercaya. Ia sengaja tidak
  // bisa masuk penyimpanan: invariannya adalah apa pun yang ada di dalam toko
  // boleh dikutip kalau masih segar.
  const { s } = toko();
  const r = s.put({ products: [RAW()], coverage: COVERAGE.UNKNOWN, source: "x" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unknown-coverage");
  assert.equal(s.read().ok, false, "toko tetap kosong");
});

test("state: penolakan terakhir ikut dilaporkan untuk penelusuran", () => {
  const { s, maju } = toko();
  s.put({ products: [RAW()], coverage: COVERAGE.FULL, source: "pin-collect" });
  maju(1_000);
  s.put({ products: [RAW()], coverage: COVERAGE.VIEWPORT, source: "refresh" });
  const st = s.state();
  assert.ok(Array.isArray(st.refusals));
  assert.equal(st.refusals[st.refusals.length - 1].reason, "would-downgrade");
});

test("hasFreshFullSince: hanya full yang segar DAN tidak lebih tua dari batas", () => {
  const { s, maju, waktu } = toko();
  assert.equal(s.hasFreshFullSince(waktu()), false, "toko kosong");
  s.put({ products: [RAW()], coverage: COVERAGE.VIEWPORT, source: "warmup" });
  assert.equal(s.hasFreshFullSince(0), false, "viewport bukan full");
  maju(1_000);
  const saatPenuh = waktu();
  s.put({ products: [RAW()], coverage: COVERAGE.FULL, source: "full-qa" });
  assert.equal(s.hasFreshFullSince(saatPenuh - 1), true);
  assert.equal(s.hasFreshFullSince(saatPenuh + 1), false, "lebih tua dari yang diminta");
  maju(31_000);
  assert.equal(s.hasFreshFullSince(0), false, "sudah basi");
});
