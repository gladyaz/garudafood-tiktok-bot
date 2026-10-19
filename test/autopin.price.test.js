// Ekstraksi + klasifikasi harga produk.
//
// Dua lapis diuji, dan sengaja dipisah begitu:
//
//   1. readProductsInPage  — FUNGSI PRODUKSI yang sama, dijalankan di atas DOM
//      tiruan yang kelas dan teksnya DIAMBIL DARI DOM NYATA (LIVE 2026-10-19,
//      docs/dynamic-product-price-audit-v0.2.1.md). Tiruan yang bentuknya
//      dikarang pernah meloloskan tiga bug sekaligus; di sini tidak ada satu
//      pun kelas yang saya karang.
//   2. classifyPrice       — fungsi murni, diuji langsung.
//
// Tidak menyentuh TikTok, browser, OBS, maupun index.js.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { classifyPrice, withPriceFields, countAmounts } = require("../autopin/price");
const products = require("../autopin/products");
const { SELECTORS, PRICE_PRIMARY, PRICE_DIM } = products;

// ---------------------------------------------------------------------------
// DOM tiruan sekecil mungkin, tapi dengan selector yang BENAR-BENAR dipakai
// produksi. Yang didukung hanya bentuk selector yang muncul di
// readProductsInPage: daftar dipisah koma, tiap bagian = tag opsional +
// sejumlah [attr] / [attr="v"] / [class*="v"] + keturunan " span".
// ---------------------------------------------------------------------------

function parseSimple(part) {
  const s = part.trim();
  const m = /^([a-zA-Z*]+)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/.exec(s);
  if (!m) throw new Error("selector tiruan tidak mendukung: " + part);
  const tag = m[1] && m[1] !== "*" ? m[1].toLowerCase() : null;
  const classes = (m[2] || "").split(".").filter(Boolean);
  const conds = [];
  for (const raw of (m[3] || "").match(/\[[^\]]+\]/g) || []) {
    const body = raw.slice(1, -1);
    const eq = /^([a-zA-Z-]+)(\*?)=\s*"([^"]*)"$/.exec(body);
    if (eq) conds.push({ name: eq[1], sub: eq[2] === "*", value: eq[3] });
    else conds.push({ name: body, exists: true });
  }
  return { tag, classes, conds };
}

function matchSimple(node, part) {
  const { tag, classes, conds } = parseSimple(part);
  if (tag && node.tagName.toLowerCase() !== tag) return false;
  if (classes.length) {
    const own = String(node.getAttribute("class") || "").split(/\s+/).filter(Boolean);
    for (const c of classes) if (!own.includes(c)) return false;
  }
  for (const c of conds) {
    const v = node.getAttribute(c.name);
    if (c.exists) {
      if (v === null) return false;
    } else if (c.sub) {
      if (v === null || !String(v).includes(c.value)) return false;
    } else if (v !== c.value) return false;
  }
  return true;
}

// Mendukung "A B" (keturunan) dan "A, B" (daftar).
function matchSelector(node, selector, scope) {
  for (const group of String(selector).split(",")) {
    const parts = group.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;
    const self = parts[parts.length - 1];
    if (!matchSimple(node, self)) continue;
    if (parts.length === 1) return true;
    // satu tingkat leluhur saja: itu yang dipakai produksi
    let a = node.parentElement;
    let ok = false;
    while (a && a !== scope) {
      if (matchSimple(a, parts[0])) { ok = true; break; }
      a = a.parentElement;
    }
    if (ok) return true;
  }
  return false;
}

// spec: { tag, cls, attrs, text, kids }
function el(spec = {}) {
  const node = {
    tagName: String(spec.tag || "div").toUpperCase(),
    _attrs: { ...(spec.cls === undefined ? {} : { class: spec.cls }), ...(spec.attrs || {}) },
    _own: spec.text === undefined ? "" : String(spec.text),
    _kids: [],
    parentElement: null,
    disabled: spec.disabled === true,
  };
  node.getAttribute = (n) => (Object.prototype.hasOwnProperty.call(node._attrs, n) ? String(node._attrs[n]) : null);
  node.getBoundingClientRect = () => (spec.hidden ? { width: 0, height: 0 } : { width: 40, height: 20 });
  Object.defineProperty(node, "childNodes", {
    get() {
      const out = [];
      if (node._own !== "") out.push({ nodeType: 3, textContent: node._own });
      for (const k of node._kids) out.push(k);
      return out;
    },
  });
  Object.defineProperty(node, "textContent", {
    get() {
      let t = node._own;
      for (const k of node._kids) t += ` ${k.textContent}`;
      return t;
    },
  });
  node._descendants = () => {
    const out = [];
    const walk = (n) => {
      for (const k of n._kids) {
        out.push(k);
        walk(k);
      }
    };
    walk(node);
    return out;
  };
  node.querySelectorAll = (sel) => node._descendants().filter((n) => matchSelector(n, sel, node));
  node.querySelector = (sel) => node.querySelectorAll(sel)[0] || null;
  node.matches = (sel) => matchSelector(node, sel, null);
  for (const k of spec.kids || []) {
    k.parentElement = node;
    node._kids.push(k);
  }
  return node;
}

const numberInput = (n) => el({ tag: "input", attrs: { "data-tid": "m4b_input_number", "aria-valuenow": String(n) } });
const marker = () => el({ cls: "stock-and-pin-button-wrapper flex" });
const titleEl = (t) => el({ cls: "overflow-ellipsis", kids: [el({ tag: "span", text: t })] });
// KELAS NYATA dari DOM: harga sekarang 16px/500.
const hargaSekarang = (t) => el({ tag: "span", cls: "text-body-l-medium", text: t });
// KELAS NYATA dari DOM: harga pembanding 12px/400 rgba(0,0,0,.35). TIDAK dicoret.
const hargaPembanding = (t) => el({ tag: "span", cls: "sc-eIcdZJ cSPnAS text-neutral-text4 text-body-s ml-4", text: t });
const stokEl = (t) => el({ cls: "stock-and-ask-to-show", text: t });
const pinEl = (t, extra = {}) => el({ tag: "button", attrs: { "data-pin-performance-source": "product_card" }, text: t, ...extra });

function kartu({ number, title, harga = [], stock, pin = "Pin", extraKids = [] }) {
  const kids = [marker(), numberInput(number), titleEl(title), ...harga];
  if (stock !== undefined) kids.push(stokEl(stock));
  if (pin !== null) kids.push(pinEl(pin));
  return el({ cls: "product-row", kids: [...kids, ...extraKids] });
}

// Satu halaman. Input nomor NON-produk di luar container meniru halaman nyata
// (aria-valuenow=30 yang bukan produk) supaya pencarian baris berhenti di baris,
// bukan memanjat ke seluruh halaman.
function bacaHalaman(rows) {
  const container = el({ cls: "product-list", kids: rows });
  const body = el({ cls: "body", kids: [container, el({ tag: "input", attrs: { "data-tid": "m4b_input_number", "aria-valuenow": "30" } })] });
  const prev = global.document;
  global.document = body;
  try {
    return products.readProductsInPage(SELECTORS);
  } finally {
    if (prev === undefined) delete global.document;
    else global.document = prev;
  }
}

// ---------------------------------------------------------------------------
// KEEMPAT KARTU NYATA
// ---------------------------------------------------------------------------

const KARTU_NYATA = [
  kartu({
    number: 1,
    title: "Garuda - Kacang ATOM 16gr 1 RENCENG ISI 10 PCS oat - GRD",
    harga: [hargaSekarang("Rp14.299"), hargaPembanding("Rp23.000")],
    stock: "In stock: 863",
  }),
  kartu({
    number: 2,
    title: "GARUDA TING TING PEANUT BAR CANDY ISI 12",
    harga: [hargaSekarang("Rp30.000")],
    stock: "Low stock: 10",
  }),
  kartu({
    number: 3,
    title: "[COD AFF] Gery - Gery Saluut [PILIH VARIAN RASA] - GRY",
    harga: [hargaSekarang("Rp25.500"), hargaPembanding("Rp49.999")],
    stock: "In stock: 572",
  }),
  kartu({
    number: 4,
    title: "Gery Saluut Malkist Renceng",
    harga: [hargaSekarang("Rp15.015")],
    stock: "In stock: 35",
  }),
];

test("DOM nyata: keempat baris terbaca, nomor dan judulnya utuh", () => {
  const r = bacaHalaman(KARTU_NYATA);
  assert.equal(r.products.length, 4);
  assert.deepEqual(r.products.map((p) => p.number), [1, 2, 3, 4]);
  assert.match(r.products[0].title, /Kacang ATOM/);
  assert.equal(r.livePinButtonsOnPage, 4);
});

test("DOM nyata: `price` lama TETAP harga sekarang di keempat kartu", () => {
  // Inilah yang sudah tampil di dropdown produk customer hari ini. Nilainya
  // tidak boleh bergeser satu karakter pun.
  const r = bacaHalaman(KARTU_NYATA);
  assert.deepEqual(r.products.map((p) => p.price), ["Rp14.299", "Rp30.000", "Rp25.500", "Rp15.015"]);
  assert.deepEqual(r.products.map((p) => p.stock), [
    "In stock: 863", "Low stock: 10", "In stock: 572", "In stock: 35",
  ]);
});

test("DOM nyata: harga diskon terpisah jadi sekarang + pembanding", () => {
  const r = bacaHalaman(KARTU_NYATA).products.map(withPriceFields);
  assert.deepEqual(
    r.map((p) => [p.priceState, p.currentPriceText, p.originalPriceText]),
    [
      ["sale", "Rp14.299", "Rp23.000"],
      ["single", "Rp30.000", ""],
      ["sale", "Rp25.500", "Rp49.999"],
      ["single", "Rp15.015", ""],
    ]
  );
  // Harga pembanding TIDAK PERNAH menjadi harga yang dikutip.
  for (const p of r) assert.notEqual(p.currentPriceText, p.originalPriceText);
});

test("DOM nyata: produk varian TIDAK menghasilkan rentang harga", () => {
  // Kartu #3 adalah produk [PILIH VARIAN RASA] dan ia menampilkan satu harga
  // sekarang + satu pembanding, sama seperti produk non-varian yang diskon.
  // priceRangeText tetap kosong karena kartu rentang BELUM pernah teramati.
  const p = withPriceFields(bacaHalaman(KARTU_NYATA).products[2]);
  assert.equal(p.priceState, "sale");
  assert.equal(p.priceRangeText, "");
});

test("DOM nyata: kelas DOM internal TIDAK ikut keluar dari halaman", () => {
  // Yang keluar hanya teks + dua boolean. Kalau kelasnya ikut, struktur
  // internal TikTok merembes ke setiap lapisan di atasnya.
  const r = bacaHalaman(KARTU_NYATA);
  const raw = JSON.stringify(r.products.map((p) => p.priceNodes));
  for (const bocor of ["text-body-l-medium", "text-neutral-text4", "sc-eIcdZJ", "class"]) {
    assert.ok(!raw.includes(bocor), bocor + " tidak boleh keluar lewat priceNodes");
  }
  for (const n of r.products[0].priceNodes) {
    assert.deepEqual(Object.keys(n).sort(), ["dim", "primary", "text"]);
  }
});

// ---------------------------------------------------------------------------
// STOK TIDAK BOLEH BISA MENJADI HARGA
// ---------------------------------------------------------------------------

test("stok ber-Rp TIDAK pernah menjadi currentPriceText", () => {
  // Gerbangnya bukan "teksnya mengandung Rp", tapi "simpulnya cocok selector
  // harga". Stok tidak cocok, jadi ia hanya bisa membuat kartunya unknown -
  // tidak pernah bisa menggantikan harganya.
  const r = bacaHalaman([
    kartu({ number: 1, title: "A", harga: [hargaSekarang("Rp10.000")], stock: "In stock: Rp999" }),
    kartu({ number: 2, title: "B", harga: [hargaSekarang("Rp20.000")], stock: "In stock: 5" }),
  ]).products.map(withPriceFields);

  assert.equal(r[0].priceState, "unknown");
  assert.equal(r[0].currentPriceText, "");
  assert.notEqual(r[0].currentPriceText, "In stock: Rp999");
  // dan tetangganya tidak ikut terpengaruh
  assert.equal(r[1].priceState, "single");
  assert.equal(r[1].currentPriceText, "Rp20.000");
});

test("tanpa harga sama sekali, stok ber-Rp tetap bukan harga", () => {
  const r = bacaHalaman([
    kartu({ number: 1, title: "A", harga: [], stock: "Rp999 tersisa" }),
    kartu({ number: 2, title: "B", harga: [hargaSekarang("Rp1.000")], stock: "In stock: 5" }),
  ]).products.map(withPriceFields);
  assert.equal(r[0].priceState, "unknown");
  assert.equal(r[0].currentPriceText, "");
  assert.equal(r[0].price, "");
});

// ---------------------------------------------------------------------------
// KLASIFIKASI — fungsi murni
// ---------------------------------------------------------------------------

const N = (text, primary, dim) => ({ text, primary, dim });

test("classifyPrice: satu harga utama saja -> single", () => {
  const r = classifyPrice([N("Rp30.000", true, false)]);
  assert.equal(r.priceState, "single");
  assert.equal(r.currentPriceText, "Rp30.000");
  assert.equal(r.originalPriceText, "");
});

test("classifyPrice: utama + pembanding redup -> sale", () => {
  const r = classifyPrice([N("Rp14.299", true, false), N("Rp23.000", false, true)]);
  assert.equal(r.priceState, "sale");
  assert.equal(r.currentPriceText, "Rp14.299");
  assert.equal(r.originalPriceText, "Rp23.000");
});

test("classifyPrice: urutan simpul tidak menentukan mana harga sekarang", () => {
  // Kalau suatu saat DOM menukar urutannya, yang menentukan tetap kelas
  // tipografinya - bukan "yang pertama ketemu".
  const r = classifyPrice([N("Rp23.000", false, true), N("Rp14.299", true, false)]);
  assert.equal(r.currentPriceText, "Rp14.299");
  assert.equal(r.originalPriceText, "Rp23.000");
});

test("classifyPrice: nol harga utama -> unknown dan currentPriceText KOSONG", () => {
  for (const nodes of [[], [N("Rp1.000", false, true)], [N("Rp1.000", false, false)]]) {
    const r = classifyPrice(nodes);
    assert.equal(r.priceState, "unknown");
    assert.equal(r.currentPriceText, "");
  }
});

test("classifyPrice: DUA harga utama -> unknown, tidak memilih salah satu", () => {
  const r = classifyPrice([N("Rp10.000", true, false), N("Rp12.000", true, false)]);
  assert.equal(r.priceState, "unknown");
  assert.equal(r.currentPriceText, "");
});

test("classifyPrice: simpul kedua yang BUKAN redup -> unknown", () => {
  // Kartu promo berlabel kemungkinan bentuknya begini. Belum teramati, jadi
  // tidak dikutip.
  const r = classifyPrice([N("Rp10.000", true, false), N("Rp12.000", false, false)]);
  assert.equal(r.priceState, "unknown");
  assert.equal(r.currentPriceText, "");
});

test("classifyPrice: tiga nilai Rp -> unknown", () => {
  const r = classifyPrice([N("Rp10.000", true, false), N("Rp12.000", false, true), N("Rp9.000", false, true)]);
  assert.equal(r.priceState, "unknown");
  assert.equal(r.currentPriceText, "");
});

test("classifyPrice: teks berbentuk rentang -> unknown, dan BUKAN range", () => {
  // Nilai "range" ada di skema tapi sengaja tidak pernah dipancarkan: kartu
  // rentang belum pernah teramati, dan mengisi priceRangeText dari dugaan
  // regex sama dengan mengarang.
  for (const t of ["Rp12.000 - Rp18.000", "Rp12.000-Rp18.000", "Rp12.000 ~ Rp18.000"]) {
    const r = classifyPrice([N(t, true, false)]);
    assert.equal(r.priceState, "unknown", t);
    assert.equal(r.currentPriceText, "", t);
    assert.equal(r.priceRangeText, "", t);
  }
});

test("classifyPrice: unknown SELALU mengosongkan ketiga teks harga", () => {
  // Pagar utama: kartu yang tidak dipahami harus mustahil dikutip oleh kode
  // mana pun yang membaca currentPriceText.
  const r = classifyPrice([N("Rp1", true, false), N("Rp2", true, false)]);
  assert.equal(r.currentPriceText, "");
  assert.equal(r.originalPriceText, "");
  assert.equal(r.priceRangeText, "");
});

test("classifyPrice: masukan rusak tidak melempar", () => {
  for (const bad of [null, undefined, "bukan array", 7, [null], [{}]]) {
    const r = classifyPrice(bad);
    assert.equal(r.priceState, "unknown");
    assert.equal(r.currentPriceText, "");
  }
});

test("countAmounts: menghitung nilai rupiah, bukan kata", () => {
  assert.equal(countAmounts("Rp14.299"), 1);
  assert.equal(countAmounts("Rp 14.299"), 1);
  assert.equal(countAmounts("Rp12.000 - Rp18.000"), 2);
  assert.equal(countAmounts("In stock: 863"), 0);
  assert.equal(countAmounts("Rp"), 0);
  assert.equal(countAmounts(null), 0);
});

// ---------------------------------------------------------------------------
// KOMPATIBILITAS
// ---------------------------------------------------------------------------

test("withPriceFields: price dan stock lama tidak disentuh", () => {
  const p = withPriceFields({
    title: "A", number: 1, price: "Rp9.999", stock: "In stock: 3",
    priceNodes: [N("Rp9.999", true, false)],
  });
  assert.equal(p.price, "Rp9.999");
  assert.equal(p.stock, "In stock: 3");
  assert.equal(p.stockText, "In stock: 3");
  assert.equal(p.currentPriceText, "Rp9.999");
});

test("withPriceFields: kartu unknown TETAP punya price lama untuk ditampilkan", () => {
  // Sengaja: di dropdown harga hanya DIBACA manusia, dan menghapusnya hanya
  // membuang informasi yang benar. Yang berbahaya adalah MENGUTIP harga yang
  // tidak dipahami - dan itu dicegah lewat currentPriceText.
  const p = withPriceFields({
    title: "A", number: 1, price: "Rp9.999", stock: "x",
    priceNodes: [N("Rp9.999", true, false), N("Rp1", false, false)],
  });
  assert.equal(p.priceState, "unknown");
  assert.equal(p.currentPriceText, "");
  assert.equal(p.price, "Rp9.999");
});

test("withPriceFields: produk tanpa priceNodes -> unknown, tidak melempar", () => {
  const p = withPriceFields({ title: "A", number: 1 });
  assert.equal(p.priceState, "unknown");
  assert.equal(p.currentPriceText, "");
  assert.deepEqual(p.priceRawTexts, []);
});

// ---------------------------------------------------------------------------
// PAGAR TINGKAT SUMBER
// ---------------------------------------------------------------------------

test("selector harga: satu sumber, dan PRICE_PRIMARY tidak berubah", () => {
  // Mengubah selector ini mengubah harga yang sudah tampil ke customer.
  assert.equal(PRICE_PRIMARY, '[class*="text-body-l-medium"]');
  assert.equal(SELECTORS.PRICE_PRIMARY, PRICE_PRIMARY);
  assert.equal(SELECTORS.PRICE_DIM, PRICE_DIM);
  const src = products.readProductsInPage.toString();
  assert.ok(src.includes("sel.PRICE_PRIMARY"), "pembacaan harga harus lewat selector bersama");
  assert.ok(!src.includes("text-body-l-medium"), "selector harga tidak boleh ditulis ulang di dalam halaman");
});

test("klasifikasi TIDAK memakai text-decoration / del / s", () => {
  // Harga pembanding TIDAK dicoret CSS (terukur: text-decoration none pada
  // keduanya). Aturan berbasis garis coret akan gagal diam-diam di halaman ini.
  const src = classifyPrice.toString() + products.readProductsInPage.toString();
  for (const salah of ["textDecoration", "text-decoration", "line-through"]) {
    assert.ok(!src.includes(salah), salah + " bukan pembeda di halaman ini");
  }
  assert.ok(!/querySelector(All)?\(\s*["'`]\s*(del|s)\s*["'`]/.test(src), "<del>/<s> bukan pembeda");
});

test("pembacaan harga TIDAK memakai getComputedStyle", () => {
  // getComputedStyle memaksa recalc style dan dipanggil per baris per gelombang
  // gulir - jalur pin punya anggaran keras dan tidak boleh ikut membayarnya.
  // Kalau kelasnya suatu hari berubah, aturannya jatuh ke unknown. Itu arah
  // kegagalan yang benar.
  assert.ok(!products.readProductsInPage.toString().includes("getComputedStyle"));
});
