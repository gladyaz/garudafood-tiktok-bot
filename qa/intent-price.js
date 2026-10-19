"use strict";
// Intent HARGA untuk Product Q&A. DETERMINISTIK — tanpa LLM, tanpa jaringan,
// tanpa model, tanpa teks bebas.
//
// Bentuknya satu konjungsi, dan tiap suku punya tugas keselamatan berbeda:
//
//   PRICE  =  ada ISYARAT_HARGA
//        AND  tidak ada ISYARAT_BUKAN_HARGA
//        AND  tepat satu produk ter-resolve      <- gerbang sebenarnya, di
//                                                   qa/resolve-product.js
//
// Gerbang ketiga sengaja TIDAK di sini. Detektor ini hanya menjawab "apakah
// ini pertanyaan harga", dan sebagian besar keselamatan justru datang dari
// resolver yang menolak ambiguitas. Lihat docs/dynamic-product-qa-design-v0.3.0.md.
//
// Positif palsu lebih mahal daripada negatif palsu: menyebut harga produk yang
// salah tidak bisa ditarik kembali, sedangkan diam hanya membuat penonton
// bertanya lagi.

// Isyarat harga. Dicocokkan sebagai TOKEN UTUH atas teks yang sudah lewat
// normalizeForMatching — bukan substring, supaya "berapa" di dalam kata lain
// tidak ikut terhitung.
const PRICE_CUES = new Set([
  "harga", "harganya", "hrg", "hrga", "harg",
  "berapa", "brp", "brpa", "brapa", "berapaan", "brapaan", "berp",
  "rp",
]);

// Isyarat intent LAIN. Kalau salah satu ada, PRICE tidak berlaku — walaupun
// isyarat harga juga ada. v0.3.0 hanya mengerjakan harga; sisanya harus DIAM,
// bukan salah dijawab sebagai harga.
const NON_PRICE_CUES = new Set([
  // -> intent STOCK, belum ada
  "stok", "stock", "ready", "restock", "sisa",
  // -> permintaan etalase, milik aturan terkonfigurasi
  "spill", "pin",
  // -> opini, bukan pertanyaan
  "mahal", "murah", "enak", "suka", "bagus", "jelek",
  // -> bukan tentang produk
  "viewer", "viewers", "penonton", "nonton", "like", "follower", "subs",
  // "harga diri"
  "diri",
  // -> intent PROMO/ongkir, belum ada
  "ongkir", "ongkos", "kirim", "voucher", "diskon", "promo",
]);

// Penanda rujukan nomor yang disebut penonton SENDIRI. Tanpa penanda, angka di
// dalam pesan bukan rujukan posisi: "garuda 16gr berapa" tidak boleh memicu
// jalur nomor.
const NUMBER_MARKERS = new Set(["nomor", "no", "nmr", "etalase", "urutan", "produk"]);

// Kata yang tidak membawa identitas produk. Dibuang sebelum resolusi supaya
// tidak ikut menyumbang skor tumpang-tindih judul.
const STOPWORDS = new Set([
  "kak", "kakak", "ka", "bang", "bg", "sis", "gan", "min", "yang", "yg", "itu", "ini",
  "dong", "dok", "ya", "yaa", "nya", "sih", "deh", "kah", "apa", "aku", "saya",
  "mau", "tanya", "nanya", "boleh", "bisa", "ada", "dan", "atau", "untuk", "buat",
  "sekarang", "skrg", "masih", "lagi", "juga", "aja", "saja", "kalo", "kalau",
]);

// Panjang minimum token sebelum sufiks posesif -nya boleh dilepas.
//
// Enam, bukan empat: dengan batas yang lebih rendah, "nya" sendiri dan kata
// pendek lain ikut terpotong menjadi sampah. Angka ini diuji atas 34 kasus
// matriks desain dan mengubah TEPAT SATU baris.
const POSSESSIVE_MIN_LENGTH = 6;

// Normalisasi KHUSUS QUERY. Satu sufiks, satu aturan — BUKAN stemming umum.
//
// Ia ada karena tanpa itu "garuda kacangnya berapa kak" gagal: judul produk
// memuat token "kacang", bukan "kacangnya", sehingga hanya "garuda" yang cocok
// dan hasilnya ambigu antara dua produk Garuda.
//
// PENTING: ini TIDAK PERNAH boleh masuk ke matcher trigger global
// (tiktok/normalize.js, tiktok/matcher.js). Di sana ia akan mengubah arti
// keyword customer yang sudah terbukti, dan itu bukan yang diminta. Pagarnya
// ada sebagai tes tingkat sumber.
function stripPossessive(token) {
  const t = String(token == null ? "" : token);
  return t.length >= POSSESSIVE_MIN_LENGTH && t.endsWith("nya") ? t.slice(0, -3) : t;
}

function tokenize(normText) {
  return String(normText == null ? "" : normText).split(" ").filter(Boolean);
}

// Token yang sudah dinormalkan untuk keperluan query: sufiks posesif dilepas.
function queryTokens(normText) {
  return tokenize(normText).map(stripPossessive);
}

// Rujukan nomor eksplisit: penanda + angka 1-2 digit yang bersebelahan.
// Mengembalikan nomor, atau null kalau penonton tidak menyebut penandanya.
function explicitNumber(normText) {
  const t = queryTokens(normText);
  for (let i = 0; i < t.length - 1; i += 1) {
    if (NUMBER_MARKERS.has(t[i]) && /^\d{1,2}$/.test(t[i + 1])) return Number(t[i + 1]);
  }
  return null;
}

// Kata-kata yang mungkin menunjuk produk: buang stopword, buang isyarat harga,
// buang token terlalu pendek.
function productWords(normText) {
  return queryTokens(normText).filter(
    (x) => !STOPWORDS.has(x) && !PRICE_CUES.has(x) && x.length >= 3
  );
}

// normText WAJIB sudah lewat normalizeForMatching (huruf kecil, non-alnum ->
// spasi, angka kata -> digit). Modul ini tidak menormalkan sendiri: ada satu
// normalizer di repo ini dan ia milik tiktok/normalize.js.
//
// Mengembalikan:
//   { price:true,  reason:"cue:...", cues:[...], number, words }
//   { price:false, reason:"no-price-cue"|"blocked:...", cues:[] }
function detectPriceIntent(normText) {
  const tokens = queryTokens(normText);

  // Pemblokir diperiksa LEBIH DULU. Urutannya penting untuk kejujuran laporan:
  // "garuda stok berapa" harus dilaporkan sebagai diblokir stok, bukan sebagai
  // pertanyaan harga yang kebetulan gagal di tempat lain.
  const blocked = tokens.filter((x) => NON_PRICE_CUES.has(x));
  if (blocked.length) {
    return { price: false, reason: `blocked:${blocked.join(",")}`, cues: [] };
  }

  const cues = tokens.filter((x) => PRICE_CUES.has(x));
  if (!cues.length) return { price: false, reason: "no-price-cue", cues: [] };

  return {
    price: true,
    reason: `cue:${cues.join(",")}`,
    cues,
    number: explicitNumber(normText),
    words: productWords(normText),
  };
}

module.exports = {
  detectPriceIntent,
  stripPossessive,
  queryTokens,
  productWords,
  explicitNumber,
  PRICE_CUES,
  NON_PRICE_CUES,
  NUMBER_MARKERS,
  STOPWORDS,
  POSSESSIVE_MIN_LENGTH,
};
