// Setelan keamanan shell Electron, diperiksa dari SUMBERNYA.
//
// Electron tidak dijalankan di sini: menjalankannya butuh jendela, dan tes ini
// harus bisa berjalan di CI tanpa display. Yang diperiksa adalah setelan yang
// kalau salah akan membuka renderer ke seluruh Node — dan itu bisa dibaca dari
// berkasnya tanpa perlu membuka jendela.
//
// Setelan ini bukan formalitas. Renderer memuat halaman dari HTTP; kalau ia punya
// nodeIntegration, satu skrip di halaman itu bisa membaca seluruh disk customer,
// termasuk profil browser yang memuat sesi TikTok-nya.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const DESKTOP = path.resolve(__dirname, "..", "desktop");

// Komentar DIBUANG sebelum diperiksa.
//
// Tanpa ini, tes memeriksa prosa, bukan kode: komentar yang menjelaskan "tidak ada
// preload" sendiri memuat kata "preload:" dan membuat tesnya merah. Lebih buruk
// lagi arah sebaliknya — sebuah setelan berbahaya yang disebut di komentar bisa
// membuat tes LULUS karena kata yang dicari ternyata ada.
// Hanya komentar BARIS PENUH yang dibuang, bukan segala sesuatu sesudah "//".
//
// Versi pertama membuang semua yang mengikuti "//" di setiap baris, dan itu
// MERUSAK string yang memuat URL: `const BASE = "http://127.0.0.1:" + PORT`
// terpotong menjadi `const BASE = "http:`. Tesnya lalu melaporkan bahwa jendela
// tidak memuat Controller lokal — padahal yang rusak adalah pemeriksanya.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

const MAIN_RAW = fs.readFileSync(path.join(DESKTOP, "main.js"), "utf8");
const MAIN = stripComments(MAIN_RAW);

test("semua berkas desktop bisa dikompilasi", () => {
  for (const name of ["main.js", "lifecycle.js", "controller-child.js"]) {
    const src = fs.readFileSync(path.join(DESKTOP, name), "utf8");
    assert.doesNotThrow(() => new vm.Script(src, { filename: name }), name);
  }
});

test("renderer: nodeIntegration MATI", () => {
  assert.match(MAIN, /nodeIntegration:\s*false/);
  assert.ok(!/nodeIntegration:\s*true/.test(MAIN));
});

test("renderer: contextIsolation HIDUP", () => {
  assert.match(MAIN, /contextIsolation:\s*true/);
  assert.ok(!/contextIsolation:\s*false/.test(MAIN));
});

test("renderer: sandbox HIDUP dan webSecurity HIDUP", () => {
  assert.match(MAIN, /sandbox:\s*true/);
  assert.match(MAIN, /webSecurity:\s*true/);
  assert.ok(!/webSecurity:\s*false/.test(MAIN));
});

test("TIDAK ADA preload: permukaan IPC paling aman adalah yang tidak ada", () => {
  // Dashboard sudah bicara ke Controller lewat HTTP; ia tidak butuh satu pun API
  // Electron. Jembatan yang tidak ada tidak bisa disalahgunakan.
  assert.ok(!/preload\s*:/.test(MAIN), "tidak boleh ada preload");
  assert.equal(fs.existsSync(path.join(DESKTOP, "preload.js")), false, "tidak boleh ada berkas preload");
});

test("TIDAK ADA ipcMain: renderer tidak bisa memicu keputusan lifecycle", () => {
  assert.ok(!/ipcMain/.test(MAIN), "tidak boleh ada handler IPC");
  assert.ok(!/remote/.test(MAIN.replace(/openExternal/g, "")), "tidak boleh memakai modul remote");
});

test("jendela HANYA memuat Controller lokal", () => {
  assert.match(MAIN, /const BASE = "http:\/\/127\.0\.0\.1:" \+ PORT/);
  assert.match(MAIN, /win\.loadURL\(BASE \+ "\/"\)/);
  // Tidak ada URL jarak jauh yang dimuat ke jendela.
  const remoteLoads = MAIN.match(/loadURL\(\s*["'`]https?:\/\/(?!127\.0\.0\.1)/g);
  assert.equal(remoteLoads, null, "tidak boleh memuat URL jarak jauh");
});

test("navigasi ke luar origin DITOLAK", () => {
  assert.match(MAIN, /will-navigate/);
  assert.match(MAIN, /event\.preventDefault\(\)/);
  assert.match(MAIN, /ALLOWED_ORIGIN/);
});

test("jendela baru tidak pernah dibuka di dalam aplikasi", () => {
  assert.match(MAIN, /setWindowOpenHandler/);
  assert.match(MAIN, /action:\s*"deny"/);
});

test("permintaan izin perangkat ditolak", () => {
  assert.match(MAIN, /setPermissionRequestHandler/);
  assert.match(MAIN, /callback\(false\)/);
});

test("TikTok TIDAK PERNAH dimuat di BrowserWindow", () => {
  // Login harus di Chrome automation dengan profilnya sendiri. Kalau dilakukan di
  // BrowserWindow, sesinya tersimpan di tempat lain dan AutoPIN tetap tidak login.
  assert.ok(!/tiktok\.com/i.test(MAIN), "main.js tidak boleh memuat tiktok.com di kodenya");
  assert.ok(!/shop\.tiktok/i.test(MAIN));
});

test("kunci satu-instance dipakai, dan instance kedua KELUAR", () => {
  assert.match(MAIN, /requestSingleInstanceLock/);
  assert.match(MAIN, /app\.exit\(0\)/);
  assert.match(MAIN, /second-instance/);
});

test("penutupan DITAHAN sampai pembersihan selesai", () => {
  // Kalau Electron mati lebih dulu, Controller kehilangan induknya sementara bot
  // dan service masih hidup dan masih mengklik produk di akun sungguhan.
  assert.match(MAIN, /before-quit/);
  assert.match(MAIN, /event\.preventDefault\(\)/);
  assert.match(MAIN, /gracefulQuit/);
});

test("shutdown yang TIDAK bersih dilaporkan, bukan disembunyikan", () => {
  assert.match(MAIN, /showErrorBox/);
  assert.match(MAIN, /app\.exit\(result\.ok \? 0 : 1\)/);
});

test("main.js tidak mengandung keputusan lifecycle: semuanya di lifecycle.js", () => {
  // Kontrak arsitektur P4: main.js tipis supaya perilakunya bisa diuji tanpa
  // Electron.
  assert.ok(!/BUSY_AUTOMATION/.test(MAIN), "daftar state harus di lifecycle.js");
  assert.ok(!/automationStopMs/.test(MAIN), "batas waktu harus di lifecycle.js");
  assert.match(MAIN, /createDesktopLifecycle/);
});

test("argumen izin aksi nyata TIDAK diteruskan dari desktop", () => {
  // Otoritasnya per-run dan diberikan Controller sendiri saat START BOT lolos
  // preflight. Desktop tidak boleh punya jalan pintas ke sana.
  assert.ok(!/enable-autocomment-send/.test(MAIN), "desktop tidak boleh menyebut flag kirim nyata");
  assert.ok(!/allow-comment-send-once/.test(MAIN));
  assert.match(MAIN, /args:\s*\[\]/, "service args dari desktop harus kosong");
});

test("tidak ada rahasia maupun path profil di berkas desktop", () => {
  for (const name of ["main.js", "lifecycle.js", "controller-child.js"]) {
    const src = stripComments(fs.readFileSync(path.join(DESKTOP, name), "utf8"));
    assert.ok(!/OBS_PASSWORD|obsPassword/i.test(src), name);
    assert.ok(!/\.autopin-profile/.test(src), name + " tidak boleh menyebut path profil");
  }
});

test("Controller dimatikan lewat induk-anak, BUKAN lewat endpoint HTTP", () => {
  const child = stripComments(fs.readFileSync(path.join(DESKTOP, "controller-child.js"), "utf8"));
  // Permintaan berhenti lewat stdin. Proses yang bisa dimatikan lewat jaringan
  // adalah permukaan yang tidak perlu ada.
  assert.match(child, /stdin\.write\("shutdown/);
  assert.ok(!/api\/shutdown|api\/quit|api\/kill/.test(child), "tidak boleh ada endpoint pembunuh");
  assert.ok(!/api\/shutdown|api\/quit|api\/kill/.test(MAIN));
});

test("Controller TIDAK punya endpoint yang bisa mematikannya lewat HTTP", () => {
  const server = stripComments(fs.readFileSync(path.resolve(__dirname, "..", "controller", "server.js"), "utf8"));
  for (const route of ["/api/shutdown", "/api/quit", "/api/kill", "/api/exit"]) {
    assert.ok(!server.includes(route), "endpoint " + route + " tidak boleh ada");
  }
});

test("kematian Controller DIBUKTIKAN lewat pidAlive, bukan diasumsikan", () => {
  const child = stripComments(fs.readFileSync(path.join(DESKTOP, "controller-child.js"), "utf8"));
  assert.match(child, /pidAlive/);
  assert.match(child, /single-instance/, "memakai pidAlive yang sudah terbukti, bukan salinan baru");
});

test("stdin shutdown DIGERBANG --parent-pipe", () => {
  // Tanpa gerbang itu, `node controller/index.js` dengan stdin tertutup akan
  // mematikan dirinya sendiri sedetik sesudah menyala, dan jalur manual dari
  // terminal rusak karena P4.
  const idx = stripComments(fs.readFileSync(path.resolve(__dirname, "..", "controller", "index.js"), "utf8"));
  assert.match(idx, /parentPipe &&/);
  assert.match(idx, /--parent-pipe/);
});

test("electron hanya devDependency, dan dependencies produksi tidak berubah", () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8"));
  assert.ok(pkg.devDependencies && pkg.devDependencies.electron, "electron harus devDependency");
  assert.equal("electron" in (pkg.dependencies || {}), false, "electron tidak boleh dependency produksi");
  // Dependensi runtime tetap lima: dotenv, express, obs-websocket-js, puppeteer,
  // tiktok-live-connector. P4 tidak menambah satu pun.
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), [
    "dotenv", "express", "obs-websocket-js", "puppeteer", "tiktok-live-connector",
  ]);
});

test("tidak ada React/Vite/auto-updater/installer builder", () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8"));
  const all = Object.keys(Object.assign({}, pkg.dependencies, pkg.devDependencies));
  for (const banned of ["react", "vite", "electron-updater", "electron-builder", "@electron-forge/cli", "nsis"]) {
    assert.ok(!all.includes(banned), banned + " belum boleh ada di P4");
  }
});

test("npm run desktop menjalankan Electron dengan shell-nya", () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8"));
  assert.equal(pkg.scripts.desktop, "electron desktop/main.js");
});
