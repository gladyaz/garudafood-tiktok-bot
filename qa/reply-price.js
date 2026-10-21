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

// ---------------------------------------------------------------------------
// HARGA VARIAN: ANGKA HANYA KALAU TERBUKTI BISA DIBELI
//
// Ditemukan pada LIVE nyata 2026-10-21, dan ini kesalahan yang paling mahal
// jenisnya karena JAWABANNYA TERLIHAT BENAR:
//
//   produk  : "Dilan - Waffle [PILIH VARIAN] - DLN"
//   dashboard: Rp11.500        <- currentPriceText, dikutip bot
//   detail   : VARIAN A  1 PACK ISI 3   Rp11.500   HABIS, tidak bisa dibeli
//              VARIAN B  1 BOX ISI 12   Rp32.250   TERSEDIA
//
// Jadi bot menjawab Rp11.500 untuk barang yang tidak bisa dibeli, dan harga
// yang benar-benar bisa dibeli hampir TIGA KALI lebih mahal. Angkanya cocok
// dengan dashboard; yang salah adalah menganggap harga tingkat-PRODUK sebagai
// harga satu SKU.
//
// Harga tingkat produk di LIVE Manager adalah harga varian TERMURAH yang
// terdaftar - termasuk varian yang HABIS. Dan `stockText` ("In stock: 857")
// adalah jumlah agregat produk: ia TIDAK membuktikan varian termurahnya ada.
//
// Verifikasi per-varian menuntut halaman detail produk, dan satu-satunya
// halaman otomasi sedang dipakai dashboard untuk AutoPIN + sapuan katalog.
// Membawanya pergi akan mematikan keduanya. Jadi sampai ada jalur baca-saja
// yang terbukti aman, varian TIDAK TERVERIFIKASI - dan yang tidak terverifikasi
// tidak boleh dikutip sebagai angka.
//
// Penanda di bawah DIAMBIL DARI JUDUL YANG TERAMATI hari itu, bukan dikarang:
//
//   "Dilan - Waffle [PILIH VARIAN] - DLN"
//   "...Family Pack (100gr) [PILIH VARIAN RASA] - GRY"
//   "...Family Pack 100gr All Variant Sarapan [PILIH VARIAN] - GRY"
//   "Garuda Kacang / Kacang Telur / Kacang Telur Rasa Original / 100gr"
//
// Arah dugaannya SELALU ke arah aman: penanda menandakan BAHAYA, bukan
// keamanan. Judul tanpa penanda tidak dianggap "terbukti satu varian" - ia
// hanya tidak punya bukti sebaliknya, dan itu sisa risiko yang dilaporkan
// terbuka, bukan disembunyikan.
const VARIANT_MARKERS = Object.freeze([
  /\bpilih\s+varian\b/i,
  /\ball\s+variants?\b/i,
  /\bvarian\b/i,
  /\bvariants?\b/i,
]);

// Daftar pilihan yang dipisah garis miring: "A / B / C / 100gr".
const SLASH_OPTIONS = 2;

function looksMultiVariant(title) {
  const t = typeof title === "string" ? title : "";
  if (!t) return false;
  if (VARIANT_MARKERS.some((re) => re.test(t))) return true;
  return (t.match(/\//g) || []).length >= SLASH_OPTIONS;
}

// Kalimat aman tanpa angka. Diberikan operator, dan sengaja TIDAK menyebut
// harga apa pun: menyebut angka mana pun di sini akan mengulang bug-nya.
const FALLBACK_TEXT = "Harga tergantung varian ya kak. Cek pilihan varian dan stok terbaru di etalase.";

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

  // Produk yang mungkin punya banyak varian: JANGAN kutip angka. Harga
  // dashboard-nya bisa milik varian yang habis - lihat catatan di atas.
  if (looksMultiVariant(p.title)) {
    const v = validateText(FALLBACK_TEXT);
    if (!v.ok) return v;
    return { ok: true, text: v.text, price: "", numeric: false, reason: "variant-unverified" };
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
  return { ok: true, text: v.text, price, numeric: true };
}

module.exports = { buildPriceReply, QUOTABLE_PRICE_STATES, TEMPLATE, looksMultiVariant, FALLBACK_TEXT, VARIANT_MARKERS };
