"use strict";
// Menemukan binary Node SUNGGUHAN untuk menjalankan Controller dan anak-anaknya.
//
// ---------------------------------------------------------------------------
// KENAPA INI PERLU ADA
//
// Di dalam Electron, process.execPath adalah electron.exe — bukan node. Itu
// menimbulkan DUA masalah berlapis, dan keduanya terjadi sungguhan pada
// 2026-10-08 saat `npm run desktop` dijalankan pertama kali:
//
//   1. `electron.exe controller/index.js` diartikan Electron sebagai "buka
//      aplikasi di direktori itu", bukan "jalankan skrip Node ini". Controller
//      tidak pernah menyala. Ini bisa diatasi dengan ELECTRON_RUN_AS_NODE=1.
//
//   2. Tapi kalau Controller sendiri berjalan sebagai electron.exe, maka
//      process.execPath DI DALAMNYA juga electron.exe — dan ia memakai itu untuk
//      menyalakan bot dan service. Jadi bot dan service akan menjadi electron.exe
//      juga.
//
// Dan masalah kedua itu JAUH lebih berbahaya daripada kelihatannya.
//
// ---------------------------------------------------------------------------
// KENAPA ANAK-ANAKNYA WAJIB node.exe
//
// Seluruh perlindungan yang dibuat sesudah insiden LIVE 2026-10-05 mencari proses
// dengan nama node.exe:
//
//   scripts/stop-all.ps1          Get-CimInstance ... -Filter "Name='node.exe'"
//   penyapu yatim di controller/  pola yang sama
//
// Insiden itu sendiri terjadi karena pencarian proses yang TIDAK cocok dengan
// kenyataan: pola lama `-match 'node index\.js'` tidak pernah cocok, sehingga
// laporan "sisa bot: 0" terbit tiga kali padahal tiga bot masih hidup, dan salah
// satunya membatalkan pin yang sudah diumumkan ke penonton.
//
// Membiarkan bot berjalan sebagai electron.exe akan mengulang kegagalan itu
// dengan bentuk yang persis sama: pemeriksaannya tetap hijau, dan yang
// disembunyikannya tetap bot yang hidup. Jadi anak-anaknya harus node.exe, dan
// untuk itu dibutuhkan path Node yang sungguhan.

const fs = require("node:fs");
const path = require("node:path");

// Nama binary Electron, untuk mengenali kapan execPath BUKAN Node.
function looksLikeElectron(execPath) {
  const base = path.basename(String(execPath || "")).toLowerCase();
  return base === "electron.exe" || base === "electron";
}

function candidateNames() {
  return process.platform === "win32" ? ["node.exe"] : ["node"];
}

// Mencari node di PATH. Sengaja TIDAK memakai `which`/`where`: menjalankan proses
// shell untuk mencari sebuah berkas menambah satu titik gagal tanpa alasan, dan di
// Windows `where` bisa mengembalikan beberapa baris yang harus diurai lagi.
function searchPath(env) {
  const raw = (env && (env.PATH || env.Path)) || "";
  const dirs = String(raw).split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of candidateNames()) {
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {
        /* entri PATH yang tidak ada: normal */
      }
    }
  }
  return null;
}

// Mengembalikan { ok, nodePath } atau { ok:false, reason }.
//
// FAIL-CLOSED: kalau Node sungguhan tidak ditemukan, ini TIDAK jatuh kembali ke
// electron.exe. Jatuh kembali akan menghasilkan sistem yang menyala tapi tidak
// bisa menghentikan bot-nya sendiri — keadaan yang lebih buruk daripada tidak
// menyala, karena ia hanya terlihat saat sudah ada yang berjalan di akun sungguhan.
function resolveNodePath({ execPath = process.execPath, env = process.env } = {}) {
  // Dijalankan dengan node biasa (mis. tes, atau `node controller/index.js`):
  // execPath sudah benar.
  if (!looksLikeElectron(execPath)) return { ok: true, nodePath: execPath, from: "execPath" };

  // Jalan keluar eksplisit untuk lingkungan yang menaruh Node di tempat tak biasa,
  // dan nanti untuk aplikasi terpaket yang membundel Node-nya sendiri.
  const override = env && env.AILIVE_NODE_PATH;
  if (override) {
    try {
      if (fs.statSync(override).isFile()) return { ok: true, nodePath: override, from: "AILIVE_NODE_PATH" };
    } catch {
      return { ok: false, reason: "node-path-invalid" };
    }
  }

  const found = searchPath(env);
  if (found) return { ok: true, nodePath: found, from: "PATH" };

  return { ok: false, reason: "node-not-found" };
}

module.exports = { resolveNodePath, looksLikeElectron, searchPath };
