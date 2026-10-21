"use strict";
// AutoPIN pure helpers (no browser). Unit-tested in test/autopin.core.test.js.

const KNOWN_FLAGS = new Set(["--confirm", "--dry-run"]);
const MAX_PRODUCT_NUMBER = 999;

function formatValue(value) {
  const s = String(value);
  return /[\s"]/.test(s) ? JSON.stringify(s) : s;
}

// [AUTOPIN_<TAG>] key=value ... — values with spaces are JSON-quoted
function log(tag, fields = {}) {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${formatValue(v)}`);
  console.log([`[AUTOPIN_${tag}]`, ...parts].join(" "));
}

function parseArgs(argv) {
  const [command = "help", ...rest] = argv;
  const flags = rest.filter((a) => a.startsWith("--"));
  return {
    command,
    positional: rest.filter((a) => !a.startsWith("--")),
    confirm: flags.includes("--confirm"),
    dryRun: flags.includes("--dry-run"),
    unknownFlags: flags.filter((f) => !KNOWN_FLAGS.has(f)),
  };
}

function parseProductNumber(raw) {
  const s = String(raw ?? "");
  if (!/^\d{1,3}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= MAX_PRODUCT_NUMBER ? n : null;
}

function normalizeIdentity(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/^@/, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

// Guard sebelum klik nyata: identitas toko yang terlihat harus PERSIS sama dengan
// AUTOPIN_EXPECTED_SHOP, dan tidak boleh mengandung nama toko produksi yang dilarang.
function checkIdentity({ expected, observed = [], forbidden = [] }) {
  const want = normalizeIdentity(expected);
  if (!want) return { ok: false, reason: "expected-shop-not-configured" };

  const seen = observed.map(normalizeIdentity).filter(Boolean);
  if (seen.length === 0) return { ok: false, reason: "identity-not-found" };

  const banned = forbidden.map(normalizeIdentity).filter(Boolean);
  const hit = seen.find((s) => banned.some((b) => s.includes(b)));
  if (hit) return { ok: false, reason: "forbidden-shop", observed: hit };

  if (banned.some((b) => want.includes(b))) return { ok: false, reason: "expected-shop-is-forbidden" };

  return seen.includes(want)
    ? { ok: true, observed: want }
    : { ok: false, reason: "identity-mismatch", observed: seen.join(" | ") };
}

// Mode klik harus EKSPLISIT. Tanpa flag, mengklik mustahil.
function decidePinMode({ confirm = false, dryRun = false } = {}) {
  if (confirm && dryRun) return { ok: false, reason: "both-modes-given" };
  if (confirm) return { ok: true, mode: "confirm" };
  if (dryRun) return { ok: true, mode: "dry-run" };
  return { ok: false, reason: "mode-flag-required" };
}

// products: [{ number, title, productId, pinControls, pinned }] dari DOM.
// `number` adalah nomor yang TERLIHAT di UI (bukan posisi DOM).
function resolveProduct(products, requested) {
  const matches = products.filter((p) => p.number === requested);
  if (matches.length === 0) return { ok: false, reason: "product-not-found" };
  if (matches.length > 1) return { ok: false, reason: "ambiguous-product", count: matches.length };

  const product = matches[0];
  if (product.pinControls === 0) return { ok: false, reason: "control-not-found", product };
  if (product.pinControls > 1) return { ok: false, reason: "ambiguous-control", product };
  return { ok: true, product };
}

// Kunci judul ternormalisasi: identitas produk yang stabil.
// Nomor posisi TIDAK dipakai — mengurutkan daftar menggeser nomor semua produk.
function normalizeTitleKey(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/…+$/, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

// IDENTITAS produk, dan HANYA identitas: 0 / 1 / banyak terhadap judul yang
// dinormalkan. Tidak satu pun field kontrol pin dibaca di sini.
//
// KENAPA DIPISAH
//
// Ada DUA bentuk produk di sistem ini, dan keduanya sah:
//
//   mentah (jalur pin)        pinButtons, pinVisible, pinDisabled
//   ternormalisasi (katalog)  pinAvailable, pinDisabled, pinText
//                             - lihat toSnapshotProduct di autopin/catalogue.js
//
// Snapshot katalog MENYULING pinButtons menjadi pinAvailable dan tidak
// menyimpan pinButtons. Jadi fungsi yang memeriksa product.pinButtons hanya
// benar untuk bentuk MENTAH, dan pada LIVE nyata 2026-10-21 gerbang kelayakan
// pra-scene memakainya atas bentuk TERNORMALISASI: setiap produk yang sehat
// ditolak sebagai live-pin-control-not-available, dan setiap aturan PAX yang
// valid tertidur.
//
// Identitas tidak punya masalah itu - `title` ada di kedua bentuk. Jadi ia
// menjadi primitif BERSAMA, dipakai gerbang dan jalur pin, supaya semantik
// judul (normalisasi yang sama, penolakan ambigu yang sama, tanpa cadangan ke
// nomor etalase) tidak bisa menyimpang di antara keduanya.
function resolveProductIdentity(products, titleKey) {
  const want = normalizeTitleKey(titleKey);
  if (!want) return { ok: false, reason: "empty-title-key" };

  const list = Array.isArray(products) ? products : [];
  const matches = list.filter((p) => normalizeTitleKey(p.title).includes(want));
  if (matches.length === 0) return { ok: false, reason: "product-not-found" };
  // Dua produk yang cocok berarti kunci judulnya tidak cukup unik. Memilih
  // salah satu berarti memin yang salah separuh waktu.
  if (matches.length > 1) return { ok: false, reason: "ambiguous-product", count: matches.length };
  return { ok: true, product: matches[0] };
}

// Resolusi target untuk aksi PIN SEBENARNYA (button[data-pin-performance-source="product_card"]).
// Menolak: tidak ketemu, ambigu, kontrol pin LIVE tidak ada, kontrol ganda, tersembunyi, disabled.
// Tidak pernah jatuh ke shopping_list, teks "Pin" generik, atau .pc_top_product.
//
// Pemeriksaan kontrolnya TETAP atas bentuk MENTAH, dan itu disengaja: ini
// dijalankan tepat sebelum klik, terhadap DOM saat itu. Gerbang pra-scene
// adalah keputusan keselamatan AWAL, bukan penggantinya.
function resolveProductForPin(products, titleKey) {
  const id = resolveProductIdentity(products, titleKey);
  if (!id.ok) return id;

  const product = id.product;
  if (!product.pinButtons) return { ok: false, reason: "live-pin-control-not-available", product };
  if (product.pinButtons > 1) return { ok: false, reason: "ambiguous-control", product };
  if (product.pinVisible === false) return { ok: false, reason: "control-not-visible", product };
  if (product.pinDisabled === true) return { ok: false, reason: "control-disabled", product };
  return { ok: true, product };
}

// Resolusi target untuk PERTANYAAN tentang produk (baca-saja). Bukan untuk pin.
//
// KENAPA TIDAK MEMAKAI resolveProductForPin
//
// Logika 0/1/banyak di sana memang persis yang dibutuhkan, dan dipakai ulang di
// sini lewat normalizeTitleKey yang SAMA. Tapi empat pemeriksaan terakhirnya
// menuntut kontrol pin yang sehat (live-pin-control-not-available,
// ambiguous-control, control-not-visible, control-disabled) — dan produk HABIS
// STOK mungkin tidak punya tombol pin sementara harganya tetap terpampang.
// Menolak menyebut harganya karena ia tidak bisa di-pin adalah penolakan yang
// salah sebabnya. Jadi di sini TIDAK ADA satu pun pemeriksaan kontrol pin.
//
// URUTAN IDENTITAS
//   1. stableId — begitu DOM mengeksposnya. Hari ini selalu null, dan tidak
//      pernah dikarang.
//   2. judul ternormalkan, PERSIS dulu; kalau tidak ada yang persis, baru
//      containment — dengan aturan 0/1/banyak yang sama.
//   3. nomor terlihat TIDAK PERNAH dipakai mencocokkan. Ia dibaca dari
//      aria-valuenow, yaitu posisi, dan posisi bergeser kalau daftar
//      diurutkan ulang.
//
// Ambiguitas SELALU ditolak. Menyebut harga produk yang salah lebih merusak
// daripada diam — persis seperti mem-pin etalase 1 saat penonton meminta
// etalase 2 (lihat hotfix v0.2.1).
function resolveProductForQuery(products, query) {
  const list = Array.isArray(products) ? products : [];
  const q = typeof query === "string" ? { titleKey: query } : (query || {});

  const stableId = q.stableId == null ? "" : String(q.stableId).trim();
  if (stableId) {
    const byId = list.filter((p) => p && p.stableId != null && String(p.stableId) === stableId);
    if (byId.length === 1) return { ok: true, product: byId[0], via: "stableId" };
    if (byId.length > 1) return { ok: false, reason: "ambiguous-product", count: byId.length };
    return { ok: false, reason: "product-not-found" };
  }

  const want = normalizeTitleKey(q.titleKey);
  if (!want) return { ok: false, reason: "empty-query" };

  const persis = list.filter((p) => normalizeTitleKey(p && p.title) === want);
  if (persis.length === 1) return { ok: true, product: persis[0], via: "title-exact" };
  if (persis.length > 1) return { ok: false, reason: "ambiguous-product", count: persis.length };

  const sebagian = list.filter((p) => normalizeTitleKey(p && p.title).includes(want));
  if (sebagian.length === 0) return { ok: false, reason: "product-not-found" };
  if (sebagian.length > 1) return { ok: false, reason: "ambiguous-product", count: sebagian.length };
  return { ok: true, product: sebagian[0], via: "title-contains" };
}

// Produk dianggap "sama" lewat productId kalau ada; kalau tidak, nomor + judul.
function sameProduct(a, b) {
  if (a.productId && b.productId) return a.productId === b.productId;
  return a.number === b.number && a.title === b.title;
}

// Verifikasi pasca-klik dari DOM yang dibaca ulang: target harus tepat satu dan pinned.
function verifyPinned(productsAfter, target) {
  const matches = productsAfter.filter((p) => sameProduct(p, target));
  if (matches.length !== 1) return { ok: false, reason: "target-not-unique-after-click", count: matches.length };
  const pinnedOthers = productsAfter.filter((p) => p.pinned && !sameProduct(p, target)).map((p) => p.number);
  if (!matches[0].pinned) return { ok: false, reason: "target-not-pinned", pinnedOthers };
  return { ok: true, pinnedOthers };
}

// Satu interaksi halaman pada satu waktu: setiap tugas menunggu tugas sebelumnya selesai.
function createSerialRunner() {
  let tail = Promise.resolve();
  return function runExclusive(task) {
    const run = tail.then(() => task());
    tail = run.catch(() => {});
    return run;
  };
}

module.exports = {
  log,
  parseArgs,
  parseProductNumber,
  normalizeIdentity,
  checkIdentity,
  decidePinMode,
  normalizeTitleKey,
  resolveProductIdentity,
  resolveProductForPin,
  resolveProductForQuery,
  resolveProduct,
  verifyPinned,
  createSerialRunner,
};
