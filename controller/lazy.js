"use strict";
// Penundaan muatan berat, dipakai bersama supaya tidak ada dua salinan aturannya.
//
// ---------------------------------------------------------------------------
// KENAPA INI ADA
//
// Sebelum Controller mengikat port 4782, ia dulu memuat 504 berkas modul.
// Yang benar-benar dibutuhkan untuk MENYAJIKAN dashboard hanya 152. Sisanya
// Puppeteer (235 modul) dan obs-websocket-js + tiktok-live-connector lewat
// index.js (117 modul) — keduanya baru diperlukan saat discovery, login, atau
// automation benar-benar diminta.
//
// Di mesin yang dingin, tiap modul adalah satu stat + read, dan di Windows tiap
// read itu lewat pemindai antivirus. Itulah yang pada 2026-10-08 membuat launch
// pertama melampaui batas 20 detik sementara launch kedua siap dalam 39ms.
//
// Yang DIPERBAIKI di sini hanya KAPAN modulnya dimuat. Perilakunya tidak
// disentuh: fungsi yang sama, argumen yang sama, hasil yang sama.

// Nilai yang boleh datang sebagai nilai biasa ATAU sebagai fungsi yang baru
// dihitung saat pertama dipakai. Hasilnya diingat, termasuk `undefined`, supaya
// pekerjaan mahalnya tidak pernah dilakukan dua kali.
//
// Dibuat menerima nilai biasa JUGA supaya seluruh pemanggil lama — dan setiap
// tes yang meng-inject array — tidak perlu berubah sedikit pun.
function memoThunk(valueOrFn) {
  if (typeof valueOrFn !== "function") return () => valueOrFn;
  let done = false;
  let cached = null;
  return () => {
    if (!done) {
      cached = valueOrFn();
      done = true;
    }
    return cached;
  };
}

// Façade malas untuk sekumpulan fungsi di dalam beberapa modul.
//
// `specs` dipetakan nama -> [kunci modul, nama fungsi]. Yang dikembalikan adalah
// objek berisi fungsi pembungkus: tiap pembungkus memuat modulnya saat PERTAMA
// DIPANGGIL, lalu meneruskan argumennya apa adanya.
//
// Pembungkusnya tetap bertipe "function", jadi pemeriksaan kesiapan yang sudah
// ada (mis. `configured()` di controller/login.js, yang menuntut setiap dep
// bertipe fungsi) tetap lolos tanpa tahu soal penundaan ini.
function lazyFacade({ load, specs }) {
  let mods = null;
  const get = () => {
    if (!mods) mods = load();
    return mods;
  };
  const out = {};
  for (const name of Object.keys(specs)) {
    const [modKey, fnName] = specs[name];
    out[name] = function (...args) {
      const m = get();
      return m[modKey][fnName](...args);
    };
  }
  return out;
}

module.exports = { memoThunk, lazyFacade };
