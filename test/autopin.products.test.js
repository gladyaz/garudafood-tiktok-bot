// Unit test helper murni AutoPIN untuk aksi PIN SEBENARNYA.
// Tidak menyentuh TikTok, browser, OBS, maupun index.js.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { decidePinMode, normalizeTitleKey, resolveProductForPin } = require("../autopin/core");
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
