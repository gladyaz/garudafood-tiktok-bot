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
//
// ---------------------------------------------------------------------------
// P5: DUA MODE, DAN YANG TERPAKET TIDAK PUNYA JALAN KELUAR
//
// Customer tidak memasang Node. Jadi aplikasi terpaket membawa node.exe-nya
// sendiri di resources/runtime/node/node.exe, dan di mode itu pencarian PATH
// TIDAK dilakukan sama sekali.
//
// Itu bukan penyederhanaan, itu keputusan. Kalau mode terpaket diizinkan jatuh
// kembali ke Node sistem, maka aplikasi yang paketnya rusak akan tetap menyala
// di mesin yang kebetulan punya Node — yaitu di mesin PENGEMBANG, dan hanya di
// situ. Kerusakannya lalu baru muncul di mesin customer pertama yang tidak punya
// Node, sesudah installer-nya dikirim. Lebih buruk lagi, versi Node sistem itu
// bisa berbeda dari yang pernah diuji, dan bot yang berjalan di atas runtime
// yang belum pernah diuji adalah hal yang paling tidak ingin kita temukan saat
// LIVE sudah jalan.
//
// Jadi: terpaket = terbundel atau TIDAK MENYALA.

const fs = require("node:fs");
const path = require("node:path");

// Apakah execPath benar-benar binary Node.
//
// ---------------------------------------------------------------------------
// KENAPA PERTANYAANNYA DIBALIK
//
// Versi pertama bertanya "apakah ini electron?", dengan membandingkan nama
// berkas terhadap "electron.exe". Itu benar saat dijalankan dari checkout
// pengembang, di mana binary Electron memang bernama electron.exe.
//
// Aplikasi yang DIPASANG tidak. electron-builder mengganti nama binary-nya
// menjadi nama produk — di sini "AI LIVE HOST.exe". Jadi pertanyaan lama
// menjawab "bukan electron" untuk sebuah proses yang justru Electron, dan
// jawabannya adalah "pakai execPath apa adanya sebagai Node".
//
// Akibatnya bot dan service akan dinyalakan sebagai "AI LIVE HOST.exe", dan
// SELURUH perlindungan proses yatim mencari Name='node.exe'. Itu mengulang
// insiden 2026-10-05 dengan bentuk yang persis sama: pemeriksaannya tetap
// hijau, dan yang disembunyikannya tetap bot yang hidup di akun sungguhan.
//
// Jadi sekarang yang ditanyakan adalah "apakah ini Node?", dan apa pun yang
// bukan diperlakukan sebagai bukan. Daftar nama yang DIKENALI selalu lebih aman
// daripada daftar nama yang DICURIGAI: nama baru yang tak terduga jatuh ke sisi
// hati-hati, bukan ke sisi yang menyalakan bot tak terlihat.
function looksLikeNode(execPath) {
  const base = path.basename(String(execPath || "")).toLowerCase();
  return base === "node.exe" || base === "node";
}

// Dipertahankan: "bukan Node" adalah pertanyaan yang dipakai jalur di bawah, dan
// nama ini sudah dipakai tes yang mengikat kontraknya. Artinya kini lebih luas
// daripada namanya — ia benar untuk electron.exe DAN untuk Electron yang sudah
// diganti nama menjadi nama produk.
function looksLikeElectron(execPath) {
  return !looksLikeNode(execPath);
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

function isFile(file, fsImpl) {
  try {
    return fsImpl.statSync(file).isFile();
  } catch {
    return false;
  }
}

// Mengembalikan { ok, nodePath } atau { ok:false, reason }.
//
// FAIL-CLOSED: kalau Node sungguhan tidak ditemukan, ini TIDAK jatuh kembali ke
// electron.exe. Jatuh kembali akan menghasilkan sistem yang menyala tapi tidak
// bisa menghentikan bot-nya sendiri — keadaan yang lebih buruk daripada tidak
// menyala, karena ia hanya terlihat saat sudah ada yang berjalan di akun sungguhan.
//
//   packaged     true untuk aplikasi yang DIPASANG. Di mode ini HANYA bundledNode
//                yang dipakai; PATH dan AILIVE_NODE_PATH tidak dilihat.
//   bundledNode  path node.exe di dalam resources. Wajib saat packaged.
function resolveNodePath({
  execPath = process.execPath,
  env = process.env,
  packaged = false,
  bundledNode = null,
  fs: fsImpl = fs,
} = {}) {
  // --- aplikasi terpaket ----------------------------------------------------
  //
  // Diperiksa PALING DULU, dan tidak pernah jatuh ke cabang mana pun di bawahnya.
  // Urutan ini yang menjadikan "tidak ada jalan keluar" sebagai sifat struktur,
  // bukan sesuatu yang bergantung pada tidak adanya bug di bawah.
  if (packaged) {
    if (typeof bundledNode !== "string" || bundledNode === "") {
      // Terpaket tapi pemanggilnya tidak menyebutkan Node terbundel. Itu cacat
      // pemrograman, bukan keadaan mesin customer — dan ia TIDAK boleh berakhir
      // sebagai pencarian PATH yang diam-diam berhasil di mesin pengembang.
      return { ok: false, reason: "bundled-node-not-configured" };
    }
    if (isFile(bundledNode, fsImpl)) return { ok: true, nodePath: bundledNode, from: "bundled" };
    return { ok: false, reason: "bundled-node-missing" };
  }

  // --- development ----------------------------------------------------------
  // Perilakunya TIDAK berubah sedikit pun dari P4.

  // Dijalankan dengan node biasa (mis. tes, atau `node controller/index.js`):
  // execPath sudah benar.
  if (!looksLikeElectron(execPath)) return { ok: true, nodePath: execPath, from: "execPath" };

  // Jalan keluar eksplisit untuk lingkungan yang menaruh Node di tempat tak biasa.
  //
  // Ketiga cabangnya dipertahankan PERSIS seperti P4, termasuk yang jatuh ke
  // pencarian PATH saat override menunjuk sesuatu yang ada tapi bukan berkas.
  // Fase packaging tidak boleh ikut mengubah arti jalur development: perubahan
  // yang tidak diminta dan tidak tertutup tes adalah cara paling halus untuk
  // merusak sesuatu yang tidak sedang dikerjakan.
  const override = env && env.AILIVE_NODE_PATH;
  if (override) {
    try {
      if (fsImpl.statSync(override).isFile()) {
        return { ok: true, nodePath: override, from: "AILIVE_NODE_PATH" };
      }
    } catch {
      return { ok: false, reason: "node-path-invalid" };
    }
  }

  const found = searchPath(env);
  if (found) return { ok: true, nodePath: found, from: "PATH" };

  return { ok: false, reason: "node-not-found" };
}

module.exports = { resolveNodePath, looksLikeNode, looksLikeElectron, searchPath };
