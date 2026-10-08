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

// --- REGRESI: Controller harus dijalankan sebagai NODE, bukan sebagai Electron --
//
// Ditemukan saat `npm run desktop` dijalankan pertama kali pada 2026-10-08, dan
// TIDAK tertangkap tes mana pun sebelum itu.
//
// Di dalam Electron, process.execPath adalah electron.exe — bukan node. Jadi
// perintah `execPath controller/index.js` diartikan Electron sebagai "buka
// aplikasi di direktori itu", bukan "jalankan skrip Node ini". Controller tidak
// pernah menyala, health check kehabisan waktu, dan customer hanya melihat
// "AI LIVE HOST could not start." tanpa petunjuk apa pun.
//
// Harness lifecycle tidak bisa menangkap ini: ia memakai pegangan child PALSU,
// jadi tidak ada binary yang sungguhan dijalankan. Yang bisa menangkapnya adalah
// memeriksa environment yang BENAR-BENAR dipakai spawn.

test("REGRESI: child Controller mendapat ELECTRON_RUN_AS_NODE", () => {
  const { spawnControllerChild } = require("../desktop/controller-child");

  let captured = null;
  // spawn palsu: tidak ada proses yang benar-benar dijalankan, tapi argumen dan
  // environment-nya diperiksa apa adanya.
  const fakeSpawn = (cmd, argv, opts) => {
    captured = { cmd, argv, opts };
    const { EventEmitter } = require("node:events");
    const ch = new EventEmitter();
    ch.pid = 1234;
    ch.stdout = new EventEmitter();
    ch.stdout.setEncoding = () => {};
    ch.stderr = new EventEmitter();
    ch.stderr.setEncoding = () => {};
    ch.stdin = { writable: true, write: () => {} };
    ch.kill = () => {};
    return ch;
  };

  // Modul memakai spawn dari node:child_process secara langsung, jadi ia di-patch
  // sementara — satu-satunya cara memeriksa pemanggilan sebenarnya tanpa
  // menjalankan proses apa pun.
  const cp = require("node:child_process");
  const original = cp.spawn;
  cp.spawn = fakeSpawn;
  try {
    // Dimuat ulang supaya ia mengambil spawn yang sudah dipatch.
    delete require.cache[require.resolve("../desktop/controller-child")];
    const { spawnControllerChild: fresh } = require("../desktop/controller-child");
    fresh({ cwd: "/fake", nodePath: "/fake/electron.exe", port: 4782 });
  } finally {
    cp.spawn = original;
    delete require.cache[require.resolve("../desktop/controller-child")];
  }

  assert.ok(captured, "spawn harus dipanggil");
  assert.equal(captured.opts.env.ELECTRON_RUN_AS_NODE, "1", "tanpa ini Controller tidak akan pernah menyala di bawah Electron");
  // Dan argumen wajibnya tetap ada.
  assert.ok(captured.argv.some((a) => String(a).includes("controller")), "menjalankan controller/index.js");
  assert.ok(captured.argv.includes("--port=4782"));
  assert.ok(captured.argv.includes("--parent-pipe"), "kanal shutdown induk-anak");
  // stdin harus pipe: itulah kanal permintaan berhenti.
  assert.deepEqual(captured.opts.stdio, ["pipe", "pipe", "pipe"]);
});

test("REGRESI: environment induk diteruskan, tidak ditimpa seluruhnya", () => {
  // PATH dan SystemRoot tetap dibutuhkan untuk menjalankan binary di Windows.
  const src = stripComments(fs.readFileSync(path.join(DESKTOP, "controller-child.js"), "utf8"));
  assert.match(src, /Object\.assign\(\{\}, env, \{ ELECTRON_RUN_AS_NODE: "1" \}\)/);
});

// --- REGRESI: anak Controller WAJIB node.exe, bukan electron.exe --------------
//
// Lapisan kedua dari bug yang sama, dan yang lebih berbahaya.
//
// Kalau Controller sendiri berjalan sebagai electron.exe (karena
// ELECTRON_RUN_AS_NODE), maka process.execPath DI DALAMNYA juga electron.exe — dan
// controller/process-manager.js memakai itu untuk menyalakan bot dan service.
//
// Akibatnya bot menjadi electron.exe, dan SELURUH perlindungan proses yatim
// berhenti menemukannya: scripts/stop-all.ps1 dan penyapu di controller/index.js
// keduanya mencari Name='node.exe'. Itu mengulang insiden LIVE 2026-10-05 dengan
// bentuk yang persis sama — pemeriksaan tetap hijau, dan yang disembunyikannya
// tetap bot yang hidup di akun sungguhan.

test("REGRESI: desktop meneruskan path Node sungguhan untuk anak Controller", () => {
  const src = stripComments(fs.readFileSync(path.join(DESKTOP, "controller-child.js"), "utf8"));
  assert.match(src, /nodePathForChildren/);
  assert.match(src, /--node-path=/);
});

test("REGRESI: Controller menerima --node-path dan memakainya", () => {
  const { parseArgs } = require("../controller/index.js");
  const parsed = parseArgs(["--port=4782", "--parent-pipe", "--node-path=C:/Program Files/nodejs/node.exe"]);
  assert.equal(parsed.nodePath, "C:/Program Files/nodejs/node.exe");

  // Jalur manual tidak menyetelnya, dan di situ process.execPath memang benar.
  assert.equal(parseArgs([]).nodePath, null);

  const idx = stripComments(fs.readFileSync(path.resolve(__dirname, "..", "controller", "index.js"), "utf8"));
  assert.match(idx, /nodePath \? \{ nodePath \} : \{\}/, "diteruskan ke createController");
});

test("REGRESI: pencarian Node mengenali electron dan FAIL-CLOSED", () => {
  const { resolveNodePath, looksLikeElectron } = require("../desktop/node-path");

  assert.equal(looksLikeElectron("C:/x/electron.exe"), true);
  assert.equal(looksLikeElectron("/usr/bin/electron"), true);
  assert.equal(looksLikeElectron("C:/Program Files/nodejs/node.exe"), false);

  // Dijalankan dengan node biasa: execPath sudah benar.
  const underNode = resolveNodePath({ execPath: "C:/Program Files/nodejs/node.exe" });
  assert.equal(underNode.ok, true);
  assert.equal(underNode.from, "execPath");

  // Dijalankan di bawah Electron tanpa Node di PATH: DITOLAK, tidak jatuh kembali
  // ke electron.exe. Controller yang menyala tapi tidak bisa menyalakan bot-nya
  // adalah keadaan yang hanya terlihat saat customer menekan START BOT.
  const noNode = resolveNodePath({ execPath: "C:/x/electron.exe", env: {} });
  assert.equal(noNode.ok, false);
  assert.equal(noNode.reason, "node-not-found");
  assert.equal("nodePath" in noNode, false, "tidak boleh mengembalikan path apa pun");
});

test("REGRESI: aplikasi TIDAK menyala kalau Node tidak ditemukan", () => {
  assert.match(MAIN, /resolveNodePath\(\)/);
  assert.match(MAIN, /if \(!node\.ok\)/);
  assert.match(MAIN, /Node\.js was not found/);
  // Dan pencariannya terjadi SEBELUM lifecycle dibangun.
  //
  // Dibandingkan dengan PEMANGGILANNYA, bukan dengan `buildLifecycle(` begitu saja:
  // yang terakhir juga cocok dengan deklarasi fungsinya di bagian atas berkas, dan
  // perbandingannya akan selalu salah arah.
  assert.ok(
    MAIN.indexOf("resolveNodePath()") < MAIN.indexOf("buildLifecycle(node.nodePath)"),
    "Node harus dicari sebelum Controller dinyalakan"
  );
});

test("REGRESI: perlindungan yatim tetap mencari node.exe (jadi anaknya harus node.exe)", () => {
  // Kontrak yang mengikat kedua sisi. Kalau suatu saat anak-anaknya diizinkan
  // menjadi electron.exe, tes ini mengingatkan bahwa pola pencariannya harus
  // berubah juga — dan itu keputusan besar, bukan perubahan sambil lalu.
  const stopAll = fs.readFileSync(path.resolve(__dirname, "..", "scripts", "stop-all.ps1"), "utf8");
  assert.match(stopAll, /Name='node\.exe'/);
  const idx = stripComments(fs.readFileSync(path.resolve(__dirname, "..", "controller", "index.js"), "utf8"));
  assert.match(idx, /Name='node\.exe'/);
});
