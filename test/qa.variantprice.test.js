"use strict";
// KESELAMATAN HARGA VARIAN: angka hanya kalau terbukti bisa dibeli.
//
// ---------------------------------------------------------------------------
// KEJADIAN NYATA 2026-10-21
//
//   produk   : "Dilan - Waffle [PILIH VARIAN] - DLN"
//   dashboard: Rp11.500                       <- dikutip bot ke penonton
//   detail   : VARIAN A  1 PACK ISI 3   Rp11.500   HABIS
//              VARIAN B  1 BOX ISI 12   Rp32.250   TERSEDIA
//
// Jawaban bot COCOK dengan dashboard dan tetap salah secara komersial: harga
// yang benar-benar bisa dibeli hampir tiga kali lebih mahal. Harga tingkat
// produk di LIVE Manager adalah varian termurah yang TERDAFTAR, termasuk yang
// habis, dan `stockText` agregat tidak membuktikan varian termurahnya ada.
//
// Verifikasi per-varian butuh halaman detail produk; satu-satunya halaman
// otomasi sedang dipakai dashboard untuk AutoPIN + sapuan katalog. Jadi
// varian BELUM TERVERIFIKASI, dan yang belum terverifikasi tidak dikutip
// sebagai angka.
const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildPriceReply, looksMultiVariant, FALLBACK_TEXT, QUOTABLE_PRICE_STATES,
} = require("../qa/reply-price");
const { createCatalogueStore, COVERAGE } = require("../autopin/catalogue");

// Produk MENTAH -> snapshot ternormalisasi lewat jalur penyimpanan produksi.
const mentah = (number, title, extra = {}) =>
  Object.assign({ number, title, pinButtons: 1, pinVisible: true, pinDisabled: false }, extra);

function tersimpan(products) {
  let t = 1_000_000;
  const store = createCatalogueStore({ now: () => t });
  assert.equal(store.put({ products, coverage: COVERAGE.FULL, source: "full-test", observedAt: t }).ok, true);
  return store.read({}).products;
}

// Judul NYATA dari LIVE 2026-10-21.
const DILAN = "Dilan - Waffle [PILIH VARIAN] - DLN";
const GERY_RASA = "[COD AFF] Gery - Gery Saluut Malkist Family Pack (100gr) [PILIH VARIAN RASA] - GRY";
const GERY_ALL = "Gery - Gery Saluut Malkist Family Pack 100gr All Variant Sarapan [PILIH VARIAN] - GRY";
const SLASH = "Garuda Kacang / Kacang Telur / Kacang Telur Rasa Original / 100gr";
const SATU = "Garuda - Kacang ATOM 16gr 1 RENCENG ISI 10 PCS oat - GRD";

// ===========================================================================
// A. VARIAN TERMURAH HABIS -> jangan pernah dikutip sebagai bisa dibeli
// ===========================================================================

test("A. kasus Dilan Waffle: Rp11.500 TIDAK pernah dikutip lagi", () => {
  const [p] = tersimpan([mentah(3, DILAN, { currentPriceText: "Rp11.500", priceState: "sale", stockText: "In stock: 857" })]);
  const r = buildPriceReply(p);

  assert.equal(r.ok, true, "tetap membalas, hanya tanpa angka");
  assert.equal(r.numeric, false, "TIDAK boleh numerik");
  assert.ok(!/11\.?500/.test(r.text), "angka varian habis tidak boleh muncul: " + r.text);
  assert.ok(!/32\.?250/.test(r.text), "harga varian lain pun tidak boleh dikarang");
  assert.ok(!/Rp/.test(r.text), "tidak ada rupiah sama sekali: " + r.text);
  assert.equal(r.text, FALLBACK_TEXT);
  assert.equal(r.reason, "variant-unverified");
});

test("G. stok agregat produk > 0 TIDAK membuat harga termurah bisa dipercaya", () => {
  // Inilah jebakan di kasus nyata: "In stock: 857" sementara varian termurah habis.
  const [p] = tersimpan([mentah(3, DILAN, { currentPriceText: "Rp11.500", priceState: "sale", stockText: "In stock: 857" })]);
  assert.match(p.stockText, /857/, "stok agregat memang terbaca");
  assert.equal(buildPriceReply(p).numeric, false, "dan tetap tidak boleh dikutip");
});

// ===========================================================================
// B/E. Varian yang lebih mahal / satu varian terverifikasi
// ===========================================================================

test("B+E. produk tanpa penanda varian: angka tetap boleh dikutip", () => {
  const [p] = tersimpan([mentah(1, SATU, { currentPriceText: "Rp14.299", priceState: "sale" })]);
  const r = buildPriceReply(p);
  assert.equal(r.ok, true);
  assert.equal(r.numeric, true);
  assert.equal(r.price, "Rp14.299");
  assert.match(r.text, /Rp14\.299/);
});

test("B. harga varian yang lebih mahal TIDAK dikarang dari data produk", () => {
  // Kami tidak punya sumber varian, jadi tidak ada jalan untuk menyebut
  // Rp32.250 - dan memang tidak boleh ada.
  const [p] = tersimpan([mentah(3, DILAN, { currentPriceText: "Rp11.500", priceState: "sale" })]);
  const r = buildPriceReply(p);
  assert.ok(!/\d/.test(r.text.replace(/[^0-9]/g, "")) || !/Rp/.test(r.text), r.text);
});

// ===========================================================================
// C/F. Tidak ada data SKU yang andal / bukti basi
// ===========================================================================

test("C. produk multi-varian tanpa data SKU: tidak ada angka", () => {
  for (const title of [DILAN, GERY_RASA, GERY_ALL, SLASH]) {
    const [p] = tersimpan([mentah(9, title, { currentPriceText: "Rp9.490", priceState: "sale" })]);
    const r = buildPriceReply(p);
    assert.equal(r.numeric, false, title);
    assert.ok(!/Rp/.test(r.text), title + " -> " + r.text);
  }
});

test("F. priceState yang tidak dipahami tetap menolak dikutip (bukti basi/aneh)", () => {
  for (const state of ["range", "unknown", "", "sold-out"]) {
    const [p] = tersimpan([mentah(1, SATU, { currentPriceText: "Rp1.000", priceState: state })]);
    const r = buildPriceReply(p);
    assert.equal(r.ok, false, "state=" + state + " tidak boleh dikutip");
    assert.match(String(r.reason), /^price-state-/);
  }
  assert.deepEqual([...QUOTABLE_PRICE_STATES].sort(), ["sale", "single"]);
});

test("D. tanpa harga sama sekali: tidak ada kutipan", () => {
  const [p] = tersimpan([mentah(1, SATU, { currentPriceText: "", priceState: "sale" })]);
  const r = buildPriceReply(p);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "empty-price");
});

// ===========================================================================
// DETEKSI PENANDA
// ===========================================================================

test("penanda varian diambil dari judul yang TERAMATI, arahnya fail-closed", () => {
  // Multi-varian.
  for (const t of [DILAN, GERY_RASA, GERY_ALL, SLASH,
                   "Produk [PILIH VARIAN]", "Produk All Variants", "Keripik varian baru",
                   "Snack Variant Pack", "A / B / C"]) {
    assert.equal(looksMultiVariant(t), true, "harus terdeteksi multi: " + t);
  }
  // Tidak ada penanda - BUKAN berarti "terbukti satu varian", hanya tidak ada
  // bukti sebaliknya.
  for (const t of [SATU, "Chocolatos Wafer Roll 32gr", "Okky Jelly Drink Anggur 150ml", ""]) {
    assert.equal(looksMultiVariant(t), false, "tidak boleh terdeteksi multi: " + t);
  }
  // Satu garis miring saja tidak cukup untuk menuduh daftar pilihan.
  assert.equal(looksMultiVariant("Susu UHT Cokelat 115ml / pack"), false);
});

// ===========================================================================
// H. Jalur Q&A lain tidak terganggu
// ===========================================================================

test("H. kalimat fallback lolos gerbang teks produksi dan tidak memantulkan penonton", () => {
  const [p] = tersimpan([mentah(3, DILAN, { currentPriceText: "Rp11.500", priceState: "sale" })]);
  const r = buildPriceReply(p);
  assert.equal(r.ok, true, "harus lolos validateText");
  assert.ok(r.text.length > 0 && r.text.length <= 150, "panjang wajar: " + r.text.length);
  assert.ok(!/[<>]/.test(r.text), "tanpa HTML");
  // Tidak ada teks penonton yang dipantulkan: kalimatnya tetap, bukan dibentuk
  // dari pertanyaan.
  assert.equal(r.text, FALLBACK_TEXT);
});

test("H. kuota/dedupe tidak disentuh perubahan ini", () => {
  const d = require("../qa/dedupe");
  assert.equal(d.DEFAULT_QUOTA_LIMIT, 2);
  assert.equal(d.DEFAULT_QUOTA_WINDOW_MS, 60_000);
  assert.equal(d.DEFAULT_COOLDOWN_MS, 30_000);
});

test("PENJAGA: tidak ada harga yang DI-HARDCODE ke produksi", () => {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "qa", "reply-price.js"), "utf8");
  const kode = src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  // Angka rupiah yang teramati hari itu tidak boleh ada di KODE.
  for (const n of ["11.500", "32.250", "14.299", "25.500", "9.490", "15.199"]) {
    assert.ok(!kode.includes(n), "harga teramati tidak boleh di-hardcode: " + n);
  }
  // Dan kalimat fallback tidak menyebut angka apa pun.
  assert.ok(!/\d/.test(FALLBACK_TEXT), "fallback tidak boleh memuat angka: " + FALLBACK_TEXT);
});
