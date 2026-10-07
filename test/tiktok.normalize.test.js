// Normalisasi dipindahkan dari index.js ke tiktok/normalize.js pada P2.
//
// Berkas ini membuktikan pemindahannya MURNI. Bukan dengan membandingkan kode,
// tapi dengan menjalankan ulang definisi LAMA — ditulis ulang di bawah apa
// adanya dari index.js sebelum P2 — dan menuntut hasilnya identik pada korpus
// yang mencakup kasus-kasus yang benar-benar penting di sistem ini.
//
// Kenapa seketat ini: sejak P2, trigger datang dari config customer dan
// Controller memvalidasinya memakai fungsi di modul baru. Kalau normalisasi di
// modul baru berbeda walau sedikit dari yang dipakai matcher produksi,
// akibatnya adalah trigger yang LOLOS validasi tapi TIDAK PERNAH cocok saat
// LIVE — kegagalan yang tidak terlihat sampai penonton mengetik dan tidak
// terjadi apa-apa.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { normalizeText, wordNumberToDigit, normalizeForMatching, containsPhrase } = require("../tiktok/normalize");

// --- definisi LAMA, disalin apa adanya dari index.js sebelum P2 --------------

function oldNormalizeText(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function oldWordNumberToDigit(s) {
  const map = { satu: "1", dua: "2", tiga: "3", empat: "4", lima: "5", enam: "6", tujuh: "7", delapan: "8", sembilan: "9", nol: "0" };
  let out = s;
  for (const [k, v] of Object.entries(map)) {
    const re = new RegExp(`\\b${k}\\b`, "g");
    out = out.replace(re, v);
  }
  return out;
}

function oldNormalizeForMatching(s) {
  return oldWordNumberToDigit(oldNormalizeText(s));
}

function oldContainsPhrase(haystackNorm, needleNorm) {
  if (!haystackNorm || !needleNorm) return false;
  return ` ${haystackNorm} `.includes(` ${needleNorm} `);
}

// Korpus: komentar penonton yang realistis, kata kunci dari RULES, dan kasus
// tepi yang pernah jadi bug.
const CORPUS = [
  "",
  "   ",
  "spill etalase 1",
  "SPILL ETALASE SATU",
  "Spill Etalase Satu!!!",
  "etalase 1",
  "etalase satu",
  "etalase 10",
  "etalase sepuluh",
  "spill etalase 10",
  "et 1",
  "no 1",
  "nomor satu",
  "paket dua",
  "produk tiga",
  "ting ting",
  "tingting",
  "garuda ting ting pouch",
  "gery potato cracker",
  "chocolatos pillow 97gr",
  "O'CORN Sea Salt 80gr",
  "Dilan Cookies Choco Chip",
  "kak spill dong etalase    3   ya",
  "mau yg nomor empat dong",
  "satusatu",
  "satu satu",
  "nol",
  "sembilan",
  "delapan belas",
  "checkout",
  "cara order",
  "stok habis?",
  "halo!!! @admin ??? #spill",
  "emoji 🛒 etalase 2 🛒",
  "  banyak   spasi   di   mana   mana  ",
  "Tab\tdan\nbaris baru",
  "123",
  "etalase1",
  "ETALASE-1",
  "etalase_1",
  "étalase satu",
  "ＥＴＡＬＡＳＥ　１",
  "null",
  "undefined",
];

test("normalizeText identik dengan definisi lama pada seluruh korpus", () => {
  for (const s of CORPUS) {
    assert.equal(normalizeText(s), oldNormalizeText(s), "beda pada: " + JSON.stringify(s));
  }
});

test("wordNumberToDigit identik dengan definisi lama pada seluruh korpus", () => {
  for (const s of CORPUS) {
    const pre = oldNormalizeText(s);
    assert.equal(wordNumberToDigit(pre), oldWordNumberToDigit(pre), "beda pada: " + JSON.stringify(s));
  }
});

test("normalizeForMatching identik dengan definisi lama pada seluruh korpus", () => {
  for (const s of CORPUS) {
    assert.equal(normalizeForMatching(s), oldNormalizeForMatching(s), "beda pada: " + JSON.stringify(s));
  }
});

test("containsPhrase identik dengan definisi lama pada seluruh pasangan korpus", () => {
  // Seluruh pasangan, bukan contoh pilihan: 44x44 pasangan masih murah, dan
  // kecocokan frasa adalah hal yang paling sering dipakai di jalur produksi.
  for (const a of CORPUS) {
    for (const b of CORPUS) {
      const na = normalizeForMatching(a);
      const nb = normalizeForMatching(b);
      assert.equal(
        containsPhrase(na, nb),
        oldContainsPhrase(na, nb),
        "beda pada: " + JSON.stringify(a) + " vs " + JSON.stringify(b)
      );
    }
  }
});

test("nilai yang bukan string ditangani sama seperti dulu", () => {
  for (const v of [null, undefined, 0, false, NaN]) {
    assert.equal(normalizeText(v), oldNormalizeText(v), "beda pada: " + String(v));
    assert.equal(normalizeForMatching(v), oldNormalizeForMatching(v), "beda pada: " + String(v));
  }
});

// --- sifat yang diandalkan jalur produksi ------------------------------------

test("index.js mengekspor fungsi yang SAMA dengan modul baru", () => {
  // Kalau suatu saat index.js kembali punya salinannya sendiri, tes ini merah.
  const bot = require("../index");
  assert.equal(bot.normalizeForMatching, normalizeForMatching, "harus fungsi yang sama, bukan salinan");
  assert.equal(bot.containsPhrase, containsPhrase, "harus fungsi yang sama, bukan salinan");
});

test("angka kata dan digit bertemu di bentuk yang sama", () => {
  // Inilah yang membuat trigger "etalase satu" di config bisa cocok dengan
  // komentar "etalase 1" yang diketik penonton.
  assert.equal(normalizeForMatching("etalase satu"), "etalase 1");
  assert.equal(normalizeForMatching("ETALASE SATU"), "etalase 1");
  assert.equal(normalizeForMatching("Etalase 1"), "etalase 1");
});

test('"sepuluh" SENGAJA tidak dipetakan ke 10', () => {
  // Sama seperti sebelum P2. Menambahkannya akan mengubah pencocokan produksi,
  // dan itu di luar cakupan P2 — dicatat sebagai perilaku yang diketahui, bukan
  // sebagai sesuatu yang diperbaiki sambil lalu.
  assert.equal(normalizeForMatching("etalase sepuluh"), "etalase sepuluh");
  assert.notEqual(normalizeForMatching("etalase sepuluh"), "etalase 10");
});

test("batas kata dijaga: etalase 1 tidak cocok dengan etalase 10", () => {
  // Regresi yang pernah nyata saat pencocokan masih substring mentah.
  const haystack = normalizeForMatching("spill etalase 10");
  assert.equal(containsPhrase(haystack, normalizeForMatching("etalase 1")), false);
  assert.equal(containsPhrase(haystack, normalizeForMatching("etalase 10")), true);
});
