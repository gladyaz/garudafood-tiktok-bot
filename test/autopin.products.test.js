// Unit test helper murni AutoPIN untuk aksi PIN SEBENARNYA.
// Tidak menyentuh TikTok, browser, OBS, maupun index.js.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { decidePinMode, normalizeTitleKey, resolveProductForPin, resolveProductForQuery } = require("../autopin/core");
const products = require("../autopin/products");
const { summarize, diffSnapshots, PIN_BUTTON, TOP_CONTROL, SELECTORS } = products;

// produk default: punya tombol pin LIVE yang terlihat & aktif
const P = (title, extra = {}) => ({
  number: 1,
  title,
  price: "IDR 1.000",
  stock: "In stock: 10",
  pinButtons: 1,
  pinVisible: true,
  pinDisabled: false,
  pinText: "Pin",
  topControls: 1,
  icons: [],
  ariaOnRow: [],
  badges: [],
  ...extra,
});

// --- selector yang benar ---

test("selector: pin per produk adalah product_card, bukan shopping_list", () => {
  assert.equal(PIN_BUTTON, 'button[data-pin-performance-source="product_card"]');
  assert.ok(!PIN_BUTTON.includes("shopping_list"), "shopping_list tidak boleh jadi selector pin");
  assert.equal(SELECTORS.PIN_BUTTON, PIN_BUTTON);
});

test("selector: .pc_top_product TIDAK PERNAH dipakai sebagai aksi pin", () => {
  assert.equal(TOP_CONTROL, ".pc_top_product");
  // aksi klik hanya boleh menyentuh PIN_BUTTON
  const src = products.pinProductInPage.toString();
  assert.ok(src.includes("sel.PIN_BUTTON"), "aksi pin harus memakai PIN_BUTTON");
  assert.ok(!src.includes("sel.TOP_CONTROL"), ".pc_top_product tidak boleh muncul di jalur klik");
  // dan tidak ada fallback ke teks "Pin" generik
  assert.ok(!/querySelectorAll\(\s*["'`]button["'`]\s*\)/.test(src), "tidak boleh menyapu semua <button>");
});

test("selector: pembacaan baris tetap mencatat .pc_top_product sebagai diagnostik saja", () => {
  const src = products.readProductsInPage.toString();
  assert.ok(src.includes("topControls"), "urutan daftar tetap dibaca untuk diagnostik");
  assert.ok(src.includes("sel.PIN_BUTTON"), "pin LIVE juga dibaca per baris");
});

// --- resolusi berbasis judul ---

test("normalizeTitleKey: membuang tanda potong dan menyeragamkan", () => {
  assert.equal(normalizeTitleKey("JUNNY - Low PH Face Wash…"), "junny low ph face wash");
  assert.equal(normalizeTitleKey("  Dilan   PANDAN  Waffle "), "dilan pandan waffle");
  assert.equal(normalizeTitleKey(""), "");
});

test("resolveProductForPin: tepat satu produk cocok lewat judul", () => {
  const list = [P("JUNNY - Low PH Face Wash Berry Bright 100 ml"), P("Chocolatos Drink Matcha")];
  const r = resolveProductForPin(list, "junny low ph face wash");
  assert.equal(r.ok, true);
  assert.match(r.product.title, /JUNNY/);
});

test("resolveProductForPin: judul kosong ditolak", () => {
  assert.equal(resolveProductForPin([P("A")], "   ").reason, "empty-title-key");
});

test("resolveProductForPin: tidak ketemu ditolak", () => {
  assert.equal(resolveProductForPin([P("A")], "produk lain").reason, "product-not-found");
});

test("resolveProductForPin: judul ambigu ditolak, tidak memilih salah satu", () => {
  const list = [P("Dilan Waffle 1 BOX"), P("Dilan Waffle 1 BOX Isi 12")];
  const r = resolveProductForPin(list, "dilan waffle");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "ambiguous-product");
  assert.equal(r.count, 2);
});

// --- gerbang kondisi tombol ---

test("resolveProductForPin: tanpa tombol pin LIVE -> live-pin-control-not-available", () => {
  const r = resolveProductForPin([P("A", { pinButtons: 0 })], "a");
  assert.equal(r.reason, "live-pin-control-not-available");
});

test("resolveProductForPin: tombol pin ganda ditolak", () => {
  assert.equal(resolveProductForPin([P("A", { pinButtons: 2 })], "a").reason, "ambiguous-control");
});

test("resolveProductForPin: tombol disabled ditolak (produk habis stok)", () => {
  const r = resolveProductForPin([P("SKIN AND US Serum", { pinDisabled: true, stock: "Out of stock" })], "skin and us");
  assert.equal(r.reason, "control-disabled");
  assert.equal(r.product.stock, "Out of stock");
});

test("resolveProductForPin: tombol tersembunyi ditolak", () => {
  assert.equal(resolveProductForPin([P("A", { pinVisible: false })], "a").reason, "control-not-visible");
});

// --- gating mode ---

test("decidePinMode: tanpa flag, mengklik mustahil", () => {
  assert.deepEqual(decidePinMode({}), { ok: false, reason: "mode-flag-required" });
});

test("decidePinMode: dua flag sekaligus ditolak", () => {
  assert.deepEqual(decidePinMode({ confirm: true, dryRun: true }), { ok: false, reason: "both-modes-given" });
});

test("decidePinMode: masing-masing flag memilih satu mode", () => {
  assert.deepEqual(decidePinMode({ dryRun: true }), { ok: true, mode: "dry-run" });
  assert.deepEqual(decidePinMode({ confirm: true }), { ok: true, mode: "confirm" });
});

// --- pembandingan snapshot ---

test("diffSnapshots: perpindahan dilacak lewat judul, bukan nomor", () => {
  const before = [P("A", { number: 1 }), P("B", { number: 2 }), P("C", { number: 3 })];
  const after = [P("C", { number: 1 }), P("A", { number: 2 }), P("B", { number: 3 })];
  const moved = Object.fromEntries(diffSnapshots(before, after).moved.map((m) => [m.title, `${m.from}->${m.to}`]));
  assert.deepEqual(moved, { A: "1->2", B: "2->3", C: "3->1" });
});

test("diffSnapshots: perubahan teks/disabled tombol pin ikut terlaporkan", () => {
  const before = [P("A", { pinText: "Pin", pinDisabled: false })];
  const after = [P("A", { pinText: "Unpin", pinDisabled: true })];
  const [c] = diffSnapshots(before, after).changed;
  assert.match(c.fields, /pinText:Pin->Unpin/);
  assert.match(c.fields, /pinDisabled:false->true/);
});

test("summarize: menyertakan state tombol pin untuk pembandingan", () => {
  const [s] = summarize([P("A", { pinText: "Pin", pinButtons: 1, topControls: 0 })]);
  assert.equal(s.pinText, "Pin");
  assert.equal(s.pinButtons, 1);
  assert.equal(s.controls, 0);
});

// --- resolusi untuk PERTANYAAN (baca-saja), bukan untuk pin ---------------
//
// Pemisahannya disengaja: logika 0/1/banyak dipakai ulang, tapi empat
// pemeriksaan kontrol pin TIDAK. Produk habis stok bisa tidak punya tombol
// pin sementara harganya tetap terpampang.

test("resolveProductForQuery: judul ternormalkan yang PERSIS menang", () => {
  const list = [P("Garuda - Kacang ATOM 16gr"), P("Gery Saluut Malkist", { number: 2 })];
  const r = resolveProductForQuery(list, "garuda kacang atom 16gr");
  assert.equal(r.ok, true);
  assert.equal(r.via, "title-exact");
  assert.match(r.product.title, /Kacang ATOM/);
});

test("resolveProductForQuery: yang persis dipilih walau ada yang memuatnya", () => {
  // Tanpa prioritas ini, kunci pendek bisa cocok ke dua produk sekaligus dan
  // seluruh pertanyaan jadi ambigu padahal ada satu yang jelas persis.
  const list = [P("Kacang Atom"), P("Kacang Atom Pedas", { number: 2 })];
  const r = resolveProductForQuery(list, "kacang atom");
  assert.equal(r.ok, true);
  assert.equal(r.via, "title-exact");
  assert.equal(r.product.title, "Kacang Atom");
});

test("resolveProductForQuery: tanpa yang persis, containment dipakai tapi tetap 0/1/banyak", () => {
  const list = [P("Garuda - Kacang ATOM 16gr"), P("Gery Saluut Malkist", { number: 2 })];
  const r = resolveProductForQuery(list, "kacang atom");
  assert.equal(r.ok, true);
  assert.equal(r.via, "title-contains");

  const dua = resolveProductForQuery([P("Kacang Atom A"), P("Kacang Atom B", { number: 2 })], "kacang atom");
  assert.equal(dua.ok, false);
  assert.equal(dua.reason, "ambiguous-product");
  assert.equal(dua.count, 2);
  assert.equal(dua.product, undefined);
});

test("resolveProductForQuery: tidak ketemu -> product-not-found, tidak memilih apa pun", () => {
  const r = resolveProductForQuery([P("A"), P("B", { number: 2 })], "chocolatos");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "product-not-found");
  assert.equal(r.product, undefined);
});

test("resolveProductForQuery: kunci kosong -> empty-query", () => {
  for (const bad of ["", "   ", "!!!", null, undefined, 42]) {
    assert.equal(resolveProductForQuery([P("A")], bad).reason, "empty-query", String(bad));
  }
});

test("resolveProductForQuery: stableId diutamakan di atas judul", () => {
  // Hari ini stableId selalu null, jadi jalur ini belum pernah aktif di
  // produksi. Ia tetap diuji supaya saat DOM mengeksposnya, urutan
  // identitasnya sudah terbukti - bukan baru dipikirkan saat itu.
  const list = [
    P("Judul Yang Sama", { stableId: "sku-1" }),
    P("Judul Yang Sama", { number: 2, stableId: "sku-2" }),
  ];
  const r = resolveProductForQuery(list, { stableId: "sku-2" });
  assert.equal(r.ok, true);
  assert.equal(r.via, "stableId");
  assert.equal(r.product.number, 2);

  // Judul yang sama DUA KALI memang ambigu kalau hanya judul yang dipakai.
  assert.equal(resolveProductForQuery(list, "judul yang sama").reason, "ambiguous-product");
});

test("resolveProductForQuery: stableId yang tidak ada TIDAK jatuh ke judul", () => {
  // Kalau pemanggil menyebut identitas kuat, identitas lemah tidak boleh
  // dipakai sebagai gantinya.
  const list = [P("Kacang Atom", { stableId: "sku-1" })];
  const r = resolveProductForQuery(list, { stableId: "sku-9", titleKey: "kacang atom" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "product-not-found");
});

test("resolveProductForQuery: nomor terlihat BUKAN identitas", () => {
  // Nomor dibaca dari aria-valuenow, yaitu posisi, dan posisi bergeser kalau
  // daftar diurutkan ulang.
  const list = [P("Judul Sama", { number: 1 }), P("Judul Sama", { number: 2 })];
  assert.equal(resolveProductForQuery(list, "judul sama").reason, "ambiguous-product");
  assert.equal(resolveProductForQuery(list, "2").reason, "product-not-found");
  assert.equal(resolveProductForQuery(list, { number: 2 }).reason, "empty-query");
});

test("resolveProductForQuery: produk yang TIDAK BISA di-pin tetap bisa ditanyakan", () => {
  // Inilah alasan resolver ini ada. Produk habis stok mungkin tidak punya
  // tombol pin sementara harganya tetap terpampang; menolak menyebut harganya
  // karena ia tidak bisa di-pin adalah penolakan yang salah sebabnya.
  const kasus = [
    { pinButtons: 0 },
    { pinButtons: 2 },
    { pinVisible: false },
    { pinDisabled: true },
  ];
  for (const k of kasus) {
    const list = [P("Kacang Atom", k)];
    const pin = resolveProductForPin(list, "kacang atom");
    const tanya = resolveProductForQuery(list, "kacang atom");
    assert.equal(pin.ok, false, JSON.stringify(k) + " harus ditolak untuk PIN");
    assert.equal(tanya.ok, true, JSON.stringify(k) + " harus tetap boleh DITANYAKAN");
  }
});

test("resolveProductForQuery: memakai normalizeTitleKey yang SAMA, bukan salinan", () => {
  // Salinan normalisasi selalu menyimpang. Pagarnya di tingkat sumber:
  // resolver ini tidak boleh punya normalisasi judulnya sendiri.
  const src = resolveProductForQuery.toString();
  assert.ok(src.includes("normalizeTitleKey"), "harus memakai normalizeTitleKey");
  assert.ok(!src.includes("normalize(\"NFKC\")"), "tidak boleh menormalkan sendiri");
  assert.ok(!src.includes("toLowerCase"), "tidak boleh menormalkan sendiri");
  // dan judul dengan tanda potong tetap cocok lewat normalisasi bersama
  const r = resolveProductForQuery([P("JUNNY - Low PH Face Wash\u2026")], "junny low ph face wash");
  assert.equal(r.ok, true);
});

test("resolveProductForQuery: TIDAK memeriksa kontrol pin di sumbernya", () => {
  const src = resolveProductForQuery.toString();
  for (const terlarang of ["pinButtons", "pinVisible", "pinDisabled", "live-pin-control", "control-disabled"]) {
    assert.ok(!src.includes(terlarang), terlarang + " bukan syarat untuk pertanyaan");
  }
});

test("resolveProductForQuery: daftar rusak tidak melempar", () => {
  for (const bad of [null, undefined, "bukan array", [null], [{}]]) {
    const r = resolveProductForQuery(bad, "apa saja");
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
});
