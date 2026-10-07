"use strict";
// Normalisasi teks untuk pencocokan komentar. EKSTRAKSI MURNI dari index.js —
// isinya dipindahkan apa adanya, tanpa satu pun perubahan perilaku.
//
// Kenapa dipindahkan: sejak P2, trigger datang dari config customer, dan
// Controller harus bisa memvalidasi trigger itu memakai normalisasi yang SAMA
// dengan yang dipakai produksi. Satu-satunya cara Controller memakai fungsi di
// index.js adalah dengan meng-require index.js — dan itu menyeret dotenv,
// OBSWebSocket, dispatcher AutoPIN, serta dispatcher AutoComment ke dalam proses
// Controller. Jadi fungsinya yang pindah, bukan pemanggilnya yang memaksa.
//
// Kalau normalisasi di sini berbeda walau sedikit dari yang dipakai matcher,
// akibatnya adalah trigger yang lolos validasi tapi tidak pernah cocok saat
// LIVE — kegagalan yang tidak terlihat sampai penonton mengetik dan tidak
// terjadi apa-apa. Karena itu ada tes yang membandingkan fungsi di sini dengan
// perilaku lama baris per baris.

// Huruf kecil, semua yang bukan huruf/angka jadi spasi, spasi dirapatkan.
function normalizeText(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// Angka yang ditulis sebagai kata jadi digit, supaya "etalase satu" dan
// "etalase 1" bertemu di bentuk yang sama.
//
// Catatan yang disengaja: "sepuluh" TIDAK ada di peta ini, sama seperti
// sebelumnya. Menambahkannya akan mengubah pencocokan produksi, dan itu di luar
// cakupan P2.
function wordNumberToDigit(s) {
  const map = { satu: "1", dua: "2", tiga: "3", empat: "4", lima: "5", enam: "6", tujuh: "7", delapan: "8", sembilan: "9", nol: "0" };
  let out = s;
  for (const [k, v] of Object.entries(map)) {
    const re = new RegExp(`\\b${k}\\b`, "g");
    out = out.replace(re, v);
  }
  return out;
}

function normalizeForMatching(s) {
  return wordNumberToDigit(normalizeText(s));
}

// Cocokkan frasa pada BATAS KATA, bukan substring mentah.
// normalizeForMatching() sudah memisahkan setiap token dengan satu spasi, jadi cukup
// membungkus kedua sisi dengan spasi. Efeknya: "etalase 10" tidak lagi cocok dengan
// keyword "etalase 1" (dulu cocok karena substring), tapi "spill etalase 10" tetap cocok
// dengan "etalase 10" karena batasnya tetap utuh.
function containsPhrase(haystackNorm, needleNorm) {
  if (!haystackNorm || !needleNorm) return false;
  return ` ${haystackNorm} `.includes(` ${needleNorm} `);
}

module.exports = { normalizeText, wordNumberToDigit, normalizeForMatching, containsPhrase };
