"use strict";
// Satu tempat yang memutuskan DI MANA segala sesuatu berada. MURNI — tidak
// pernah meng-import Electron, jadi seluruh keputusannya bisa diuji offline.
//
// ---------------------------------------------------------------------------
// TIGA AKAR YANG SELAMA INI DIKIRA SATU
//
// Sampai P4, repo ini punya satu gagasan tentang "akar": `path.resolve(__dirname,
// "..")`. Itu benar selama kode dan data memang tinggal bersama — yaitu selama
// aplikasinya cuma dijalankan dari checkout pengembang.
//
// Aplikasi yang DIPASANG memecah anggapan itu menjadi tiga hal yang berbeda:
//
//   codeRoot       kode aplikasi. Terpaket: resources/app di dalam direktori
//                  instalasi. Hanya dibaca.
//   resourcesRoot  runtime yang dibundel (node.exe, Chrome) dan lisensi.
//                  Hanya dibaca.
//   userDataRoot   SEGALA SESUATU YANG DITULIS. Config customer, profil browser
//                  yang memuat sesi TikTok-nya, artefak runtime, log.
//
// Membiarkan ketiganya tetap satu adalah cara paling langsung untuk menulis data
// customer ke dalam direktori instalasi. Dan itu bukan sekadar tidak rapi:
// uninstall akan MENGHAPUS sesi TikTok customer bersama binary-nya, dan setiap
// reinstall akan memaksanya login lagi. Lebih buruk, di instalasi per-machine
// direktori itu tidak bisa ditulis sama sekali, jadi gejalanya menjadi "Simpan
// tidak berfungsi" tanpa sebab yang terlihat.
//
// ---------------------------------------------------------------------------
// DEVELOPMENT SENGAJA TIDAK IKUT BERUBAH
//
// Saat tidak terpaket, ketiga akar itu kembali menjadi akar repo — jadi
// data/config.json, .autopin-profile, dan .bot.lock tetap di tempat yang persis
// sama seperti sebelum P5. `npm run desktop` dan `node controller/index.js`
// tidak merasakan apa pun.
//
// Itu disengaja. Packaging yang memaksa development memakai %APPDATA% akan
// membuat dua jalur yang berbeda, dan yang jarang dijalankan — jalur terpaket —
// adalah yang akan menyimpang tanpa ada yang tahu. Yang berbeda hanya JAWABAN
// modul ini; mekanismenya satu.

const path = require("node:path");

// Nama produk. SATU sumber.
//
// Dipakai dua pihak yang tidak bisa saling membaca: Electron memanggil
// app.setName() dengan nilai ini untuk menentukan %APPDATA%\<nama>, dan
// electron-builder memakai "productName" di package.json untuk nama installer,
// direktori instalasi, dan shortcut. Keduanya HARUS sama — kalau tidak,
// aplikasi akan menulis ke folder yang bukan folder tempat ia dipasang.
//
// package.json tidak bisa meng-require berkas ini, jadi kesamaannya tidak bisa
// dijamin oleh struktur. Yang menjamin adalah tes: lihat
// test/packaging.paths.test.js.
const PRODUCT_NAME = "AI LIVE HOST";

// Letak runtime yang dibundel, relatif terhadap resourcesRoot. Dicocokkan dengan
// pemetaan extraResources di package.json, dan dipaku oleh tes.
const BUNDLED = Object.freeze({
  NODE: path.join("runtime", "node", "node.exe"),
  BROWSER: path.join("runtime", "browser", "chrome.exe"),
  LICENSES: "licenses",
  MANIFEST: "runtime-manifest.json",
});

const MODE = Object.freeze({ DEVELOPMENT: "development", PACKAGED: "packaged" });

// Nama berkas/direktori di bawah userDataRoot saat terpaket.
//
// Sengaja TIDAK memakai nama bertitik seperti ".autopin-profile": nama bertitik
// itu masuk akal di checkout pengembang, di mana gunanya menyembunyikan diri
// dari `ls`. Di %APPDATA% milik customer, yang dibutuhkan justru sebaliknya —
// kalau ia harus mengirimkan log atau menghapus profilnya, ia harus bisa
// MELIHAT foldernya.
const PACKAGED_LAYOUT = Object.freeze({
  CONFIG: "config.json",
  RUNTIME: "runtime",
  PROFILE: "browser-profile",
  DEBUG: "browser-debug",
  LOGS: "logs",
  LOCK: ".bot.lock",
});

// Letak data di checkout pengembang. Nilai-nilai ini BUKAN pilihan baru: mereka
// adalah tempat yang sudah dipakai hari ini, dan ditulis di sini supaya jalur
// development melewati mekanisme yang sama, bukan melewati cabang lain.
const DEV_LAYOUT = Object.freeze({
  CONFIG: path.join("data", "config.json"),
  RUNTIME: path.join("data", ".runtime"),
  PROFILE: ".autopin-profile",
  DEBUG: ".autopin-debug",
  LOGS: "logs",
  LOCK: ".bot.lock",
});

// Mengembalikan seluruh peta path untuk satu mode.
//
//   isPackaged     app.isPackaged
//   resourcesPath  process.resourcesPath   (hanya berarti saat terpaket)
//   userData       app.getPath("userData") (hanya berarti saat terpaket)
//   moduleDir      direktori berkas ini; dari sini akar repo dihitung saat dev
//
// Semuanya di-inject, tidak satu pun dibaca dari Electron di sini. Itulah yang
// membuat kedua mode bisa diuji di proses yang sama.
function resolveAppPaths({
  isPackaged = false,
  resourcesPath = null,
  userData = null,
  moduleDir = __dirname,
} = {}) {
  const repoRoot = path.resolve(moduleDir, "..");

  if (!isPackaged) {
    // Ketiga akar menjadi satu, dan itu BENAR di sini: di checkout pengembang,
    // kode dan data memang satu pohon, dan seluruh data yang ditulis sudah
    // gitignored.
    return freeze({
      mode: MODE.DEVELOPMENT,
      productName: PRODUCT_NAME,
      codeRoot: repoRoot,
      resourcesRoot: repoRoot,
      userDataRoot: repoRoot,
      configFile: path.join(repoRoot, DEV_LAYOUT.CONFIG),
      runtimeDir: path.join(repoRoot, DEV_LAYOUT.RUNTIME),
      profileDir: path.join(repoRoot, DEV_LAYOUT.PROFILE),
      debugDir: path.join(repoRoot, DEV_LAYOUT.DEBUG),
      logsDir: path.join(repoRoot, DEV_LAYOUT.LOGS),
      lockFile: path.join(repoRoot, DEV_LAYOUT.LOCK),
      // Tidak ada yang dibundel saat dev: Node datang dari PATH dan browser dari
      // cache Puppeteer, persis seperti sebelum P5.
      bundledNode: null,
      bundledBrowser: null,
      licensesDir: null,
      manifestFile: null,
    });
  }

  // Terpaket. Keduanya WAJIB diberikan: menebaknya dari __dirname akan
  // menghasilkan path di dalam direktori instalasi, yang justru hal yang modul
  // ini ada untuk mencegah.
  if (typeof resourcesPath !== "string" || resourcesPath === "") {
    throw new Error("resolveAppPaths: `resourcesPath` wajib saat terpaket");
  }
  if (typeof userData !== "string" || userData === "") {
    throw new Error("resolveAppPaths: `userData` wajib saat terpaket");
  }

  const resourcesRoot = path.resolve(resourcesPath);
  const codeRoot = path.join(resourcesRoot, "app");
  const userDataRoot = path.resolve(userData);

  return freeze({
    mode: MODE.PACKAGED,
    productName: PRODUCT_NAME,
    codeRoot,
    resourcesRoot,
    userDataRoot,
    configFile: path.join(userDataRoot, PACKAGED_LAYOUT.CONFIG),
    runtimeDir: path.join(userDataRoot, PACKAGED_LAYOUT.RUNTIME),
    profileDir: path.join(userDataRoot, PACKAGED_LAYOUT.PROFILE),
    debugDir: path.join(userDataRoot, PACKAGED_LAYOUT.DEBUG),
    logsDir: path.join(userDataRoot, PACKAGED_LAYOUT.LOGS),
    lockFile: path.join(userDataRoot, PACKAGED_LAYOUT.LOCK),
    bundledNode: path.join(resourcesRoot, BUNDLED.NODE),
    bundledBrowser: path.join(resourcesRoot, BUNDLED.BROWSER),
    licensesDir: path.join(resourcesRoot, BUNDLED.LICENSES),
    manifestFile: path.join(resourcesRoot, BUNDLED.MANIFEST),
  });
}

function freeze(obj) {
  return Object.freeze(obj);
}

// Apakah `child` berada di dalam `parent`. Dipakai pemeriksaan di bawah.
//
// Perbandingan dilakukan atas path yang sudah diresolusi DAN diakhiri pemisah,
// supaya "…\AI LIVE HOST" tidak pernah terbaca sebagai berada di dalam
// "…\AI LIVE HOSTING". Di Windows huruf besar/kecil tidak membedakan, jadi
// perbandingannya ikut tidak membedakan.
function isInside(child, parent) {
  const norm = (p) => {
    let v = path.resolve(String(p));
    if (process.platform === "win32") v = v.toLowerCase();
    return v.endsWith(path.sep) ? v : v + path.sep;
  };
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p);
}

// PEMERIKSAAN YANG PALING PENTING DI BERKAS INI.
//
// Saat terpaket, tidak satu pun path yang ditulis boleh berada di dalam kode
// atau resources. Kalau pernah terjadi, akibatnya bukan error yang terlihat
// melainkan tiga hal yang semuanya diam:
//
//   - uninstall menghapus sesi TikTok customer bersama binary-nya
//   - reinstall memaksa login ulang, dan terlihat seperti "aplikasinya lupa"
//   - di lokasi yang tidak bisa ditulis, Simpan gagal tanpa sebab yang terlihat
//
// Jadi ini dibuat sebagai pemeriksaan, bukan sebagai catatan di komentar. Mode
// development SENGAJA dikecualikan: di sana ketiga akar memang satu pohon, dan
// itu keputusan yang dinyatakan di atas — bukan kecelakaan.
function assertWritableOutsideCode(paths) {
  if (!paths || paths.mode !== MODE.PACKAGED) return { ok: true, mode: paths && paths.mode };

  const writable = [
    ["userDataRoot", paths.userDataRoot],
    ["configFile", paths.configFile],
    ["runtimeDir", paths.runtimeDir],
    ["profileDir", paths.profileDir],
    ["debugDir", paths.debugDir],
    ["logsDir", paths.logsDir],
    ["lockFile", paths.lockFile],
  ];

  const violations = [];
  for (const [name, value] of writable) {
    if (isInside(value, paths.codeRoot)) violations.push({ name, inside: "codeRoot" });
    else if (isInside(value, paths.resourcesRoot)) violations.push({ name, inside: "resourcesRoot" });
  }

  return violations.length === 0 ? { ok: true, mode: paths.mode } : { ok: false, violations };
}

// Bentuk ringkas untuk log. Path TIDAK ikut: yang berguna bagi dukungan adalah
// MODE-nya dan apakah runtime terbundel ditemukan, bukan susunan direktori mesin
// customer.
function describePaths(paths) {
  return {
    mode: paths.mode,
    bundledNode: paths.bundledNode ? "bundled" : "system",
    bundledBrowser: paths.bundledBrowser ? "bundled" : "puppeteer-cache",
  };
}

module.exports = {
  resolveAppPaths,
  assertWritableOutsideCode,
  describePaths,
  isInside,
  PRODUCT_NAME,
  BUNDLED,
  MODE,
  PACKAGED_LAYOUT,
  DEV_LAYOUT,
};
