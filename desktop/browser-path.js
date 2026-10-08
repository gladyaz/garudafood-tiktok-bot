"use strict";
// Menemukan browser yang dipakai AutoPIN. Sejajar dengan desktop/node-path.js,
// dan dengan alasan yang sejajar pula.
//
// ---------------------------------------------------------------------------
// KENAPA BROWSER CUSTOMER TIDAK BOLEH DIPAKAI
//
// Seluruh jalur pin diuji terhadap SATU build Chrome. Yang dicari AutoPIN bukan
// API yang stabil, melainkan baris produk di halaman LIVE milik TikTok — ia
// menggulir daftar, mencocokkan judul, lalu mengklik tombol Pin. Perilaku itu
// bergantung pada DOM dan pada rendering.
//
// Jadi membiarkan setiap customer memakai Chrome pribadinya berarti setiap
// customer menjalankan jalur pin di atas browser yang belum pernah kita uji.
// Kegagalannya tidak akan terlihat seperti masalah browser: ia akan terlihat
// seperti "produk tidak ketemu", di tengah LIVE, pada satu customer saja.
//
// Dan ada alasan kedua yang lebih langsung: Chrome pribadi customer sedang
// DIPAKAI. Profil Chrome hanya bisa dipegang satu proses; membukanya dengan
// profil AutoPIN sementara customer memakai Chrome-nya sendiri akan gagal
// dengan ProcessSingleton (lihat autopin/browser.js), atau lebih buruk, ikut
// menutup jendela pribadinya.
//
// Maka aplikasi terpaket membawa browsernya sendiri, dan TIDAK PERNAH membuka
// Chrome sistem.
//
// ---------------------------------------------------------------------------
// MODE DEVELOPMENT TIDAK IKUT BERUBAH
//
// Saat dev, jawabannya null — artinya "jangan sebutkan executablePath, biarkan
// Puppeteer memakai browser dari cache-nya", persis seperti sebelum P5.
// Lihat autopin/browser.js: `executablePath: config.chromePath || undefined`.

const fsDefault = require("node:fs");
const path = require("node:path");

// Berkas tetangga yang tanpa mereka chrome.exe tidak akan menyala.
//
// Diperiksa karena chrome.exe hanya 3 MB: yang membuatnya berjalan adalah
// chrome.dll 266 MB di sebelahnya. Satu aturan allowlist electron-builder yang
// terlalu sempit menghasilkan chrome.exe yang ADA tapi mati saat dijalankan —
// dan kalau yang kita periksa cuma keberadaan chrome.exe, resolver akan
// melaporkan sukses dan kegagalannya pindah ke saat customer menekan
// LOGIN TIKTOK.
const REQUIRED_SIBLINGS = Object.freeze(["chrome.dll"]);

function isFile(file, fsImpl) {
  try {
    return fsImpl.statSync(file).isFile();
  } catch {
    return false;
  }
}

// Mengembalikan:
//   { ok: true, browserPath: "<abs>", from: "bundled" }        aplikasi terpaket
//   { ok: true, browserPath: null,   from: "puppeteer-cache" } development
//   { ok: false, reason }                                       terpaket & rusak
//
//   packaged        true untuk aplikasi yang DIPASANG
//   bundledBrowser  path chrome.exe di dalam resources. Wajib saat packaged.
function resolveBrowserPath({
  packaged = false,
  bundledBrowser = null,
  fs: fsImpl = fsDefault,
} = {}) {
  if (!packaged) {
    // null BUKAN kegagalan: ia berarti "Puppeteer yang memutuskan", yang memang
    // perilaku development hari ini.
    return { ok: true, browserPath: null, from: "puppeteer-cache" };
  }

  if (typeof bundledBrowser !== "string" || bundledBrowser === "") {
    return { ok: false, reason: "bundled-browser-not-configured" };
  }

  if (!isFile(bundledBrowser, fsImpl)) {
    return { ok: false, reason: "bundled-browser-missing" };
  }

  const dir = path.dirname(bundledBrowser);
  const missing = REQUIRED_SIBLINGS.filter((name) => !isFile(path.join(dir, name), fsImpl));
  if (missing.length > 0) {
    // Dibedakan dari "missing" dengan sengaja: yang satu berarti browsernya tidak
    // ikut dipaketkan, yang satu berarti ia ikut tapi SEPARUH. Keduanya butuh
    // perbaikan yang berbeda di konfigurasi build, dan laporan yang menyamakan
    // keduanya akan mengirim orang ke tempat yang salah.
    return { ok: false, reason: "bundled-browser-incomplete", missing };
  }

  return { ok: true, browserPath: bundledBrowser, from: "bundled" };
}

module.exports = { resolveBrowserPath, REQUIRED_SIBLINGS };
