"use strict";
// Kalimat jawaban harga. DETERMINISTIK, dan GAGAL-TERTUTUP.
//
// ---------------------------------------------------------------------------
// KENAPA "yang tampil di etalase saat ini", dan BUKAN "pasti"
//
// "Harganya pasti Rp14.299" adalah klaim yang tidak bisa kami dukung: voucher,
// promo toko, dan flash sale bisa mengubah yang dibayar penonton, dan TTL 30
// detik tidak menjamin promosi TikTok tidak berubah. Kalimat di bawah adalah
// satu-satunya klaim yang didukung bukti — kami benar-benar membaca angka itu
// dari etalase beberapa detik lalu.
//
// ---------------------------------------------------------------------------
// KENAPA HANYA HARGA SEKARANG
//
// originalPriceText tersedia dan benar, tapi TIDAK disebut di v0.3.0:
//   - bukti kami untuk angka itu lebih lemah; kami tahu ia simpul pembanding
//     yang redup, kami TIDAK tahu artinya (harga normal? sebelum diskon? MSRP?)
//   - ia mengundang sengketa "kok beda sama di keranjang"
//   - anggaran 100 karakter sempit, dan balasan kepanjangan DIAM (too-long)
//   - keputusannya bisa dibalik satu arah: menambahkan nanti itu aditif,
//     menarik kembali angka "sebelumnya" yang sudah terucap tidak bisa
//
// ---------------------------------------------------------------------------
// TEKS PENONTON TIDAK PERNAH DIPANTULKAN. Sama seperti aturan yang sudah
// berlaku di autocomment/formatter.js.

const { validateText } = require("../autocomment/formatter");

// priceState yang boleh dikutip. "unknown" dan "range" TIDAK ada di sini, dan
// itu seluruh maksudnya: kartu yang tidak kami pahami tidak bisa dikutip.
const QUOTABLE_PRICE_STATES = new Set(["single", "sale"]);

const TEMPLATE = "Harga yang tampil di etalase saat ini {price} ya kak 😊";

// Mengembalikan { ok:true, text } atau { ok:false, reason }.
//
// Gerbang panjang/HTML/karakter kontrol DIIMPOR dari autocomment/formatter.js,
// bukan ditulis ulang: ada satu gerbang teks di repo ini dan ia dipakai
// bersama oleh jalur scene dan jalur Q&A.
function buildPriceReply(product, { template = TEMPLATE } = {}) {
  const p = product && typeof product === "object" ? product : {};

  const state = typeof p.priceState === "string" ? p.priceState : "";
  if (!QUOTABLE_PRICE_STATES.has(state)) {
    return { ok: false, reason: `price-state-${state || "missing"}` };
  }

  // currentPriceText adalah SATU-SATUNYA sumber angka. Tidak ada cadangan ke
  // `price` legacy (yang sengaja tetap terisi walau priceState unknown) dan
  // tidak ada cadangan ke originalPriceText.
  const price = typeof p.currentPriceText === "string" ? p.currentPriceText.trim() : "";
  if (!price) return { ok: false, reason: "empty-price" };

  if (typeof template !== "string" || !template.includes("{price}")) {
    return { ok: false, reason: "invalid-template" };
  }

  const v = validateText(template.split("{price}").join(price));
  if (!v.ok) return v;
  return { ok: true, text: v.text, price };
}

module.exports = { buildPriceReply, QUOTABLE_PRICE_STATES, TEMPLATE };
