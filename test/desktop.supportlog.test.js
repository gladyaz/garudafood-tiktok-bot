// Membuka log dukungan dari dashboard.
//
// Kalimat cadangan untuk kegagalan yang belum punya nama menyuruh customer
// "buka Log Dukungan". Sebelum ini tidak ada tombolnya, jadi kalimat itu adalah
// instruksi yang tidak bisa diikuti - dan satu-satunya jalan diagnosis pilot
// bergantung pada customer yang menemukan %APPDATA% sendiri.
//
// Bentuk solusinya DIPAKSA oleh arsitektur yang sudah ada, dan itu bagus:
//
//   desktop/main.js  : TIDAK ADA preload dan TIDAK ADA IPC, disengaja -
//                      "Permukaan IPC yang paling aman adalah yang tidak ada"
//   controller-child : `logsDir` TIDAK ada di daftar tertutup path yang
//                      diterima Controller; pemiliknya desktop/paths.js
//
// Jadi renderer hanya bisa menyatakan NIAT lewat satu URL sentinel tetap, dan
// proses utama yang meresolusi letaknya sendiri. Tidak ada path yang pernah
// menyeberang, jadi "buka log dukungan" tidak bisa berubah menjadi "buka apa
// saja di disk ini".

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const I = require("../controller/public/i18n.js");
const { BASENAME } = require("../desktop/support-log.js");

const MAIN = fs.readFileSync(path.join(__dirname, "..", "desktop", "main.js"), "utf8");
const APP = fs.readFileSync(path.join(__dirname, "..", "controller", "public", "app.js"), "utf8");
const HTML = fs.readFileSync(path.join(__dirname, "..", "controller", "public", "index.html"), "utf8");

// Komentar dibuang sebelum memindai kode: komentar di sini MENJELASKAN kenapa
// tidak ada preload, jadi penjaga yang membaca prosa akan menuduh kalimat yang
// justru membuktikan kebalikannya.
function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const SENTINEL = "ailivehost://support-log";

/* === aksinya ADA dan bisa ditemukan customer ============================= */

test("dashboard punya tombol Buka Log Dukungan", () => {
  assert.ok(HTML.indexOf('id="open-log-btn"') !== -1, "tombolnya tidak ada di halaman");
  assert.ok(HTML.indexOf('data-t="ui.btn.openLog"') !== -1, "labelnya tidak lewat kamus");
  assert.ok(APP.indexOf('el["open-log-btn"]') !== -1, "tombolnya tidak dirangkai di app.js");
  assert.ok(APP.indexOf("function onOpenLog") !== -1);
});

// Di Pengaturan, bukan di dekat MULAI/HENTIKAN BOT: ini aksi yang dicari saat
// ada masalah, bukan yang dipakai saat sedang tayang.
test("tombolnya di panel Pengaturan, bukan di kendali LIVE", () => {
  const settings = HTML.slice(
    HTML.indexOf('data-panel="settings"'),
    HTML.indexOf("</main>")
  );
  assert.ok(settings.indexOf('id="open-log-btn"') !== -1, "tombolnya di luar panel Pengaturan");

  const hero = HTML.slice(HTML.indexOf('class="hero'), HTML.indexOf('data-panel="rules"'));
  assert.equal(hero.indexOf("open-log-btn"), -1, "tombolnya mengotori kendali LIVE");
});

test("kalimatnya lengkap di KETIGA bahasa", () => {
  const KEYS = [
    "ui.support.title",
    "ui.support.help",
    "ui.support.hint",
    "ui.btn.openLog",
    "ui.support.opening",
    "ui.support.unavailable",
  ];
  for (const lang of I.LANGS) {
    for (const k of KEYS) {
      const v = I.DICT[lang][k];
      assert.ok(typeof v === "string" && v.trim() !== "", lang + " kehilangan " + k);
    }
  }
  // Label tombolnya persis yang disetujui.
  assert.equal(I.DICT.id["ui.btn.openLog"], "Buka Log Dukungan");
  assert.equal(I.DICT.en["ui.btn.openLog"], "Open Support Log");
  assert.equal(I.DICT["zh-CN"]["ui.btn.openLog"], "\u6253\u5f00\u652f\u6301\u65e5\u5fd7");
});

// Kalimat cadangan tidak boleh lagi menyuruh customer mencari berkas sendiri.
test("kalimat cadangan menunjuk tombolnya, bukan sebuah berkas", () => {
  const POINTS_AT_UI = {
    id: /Pengaturan/,
    en: /Settings/,
    "zh-CN": /\u8bbe\u7f6e/,
  };
  for (const lang of I.LANGS) {
    const s = I.DICT[lang]["err.unknown"];
    assert.match(s, POINTS_AT_UI[lang], lang + " tidak menunjuk ke Pengaturan: " + s);
    // Tidak ada jalur, ekstensi berkas, atau nama folder di kalimat customer.
    assert.doesNotMatch(s, /%APPDATA%|\\\\|\.log\b|C:/i, lang + " membocorkan jalur berkas");
  }
});

/* === renderer TIDAK BISA menyebut path ================================== */

test("renderer hanya mengirim NIAT, bukan path", () => {
  const code = codeOnly(APP);
  assert.ok(code.indexOf('"' + SENTINEL + '"') !== -1, "sentinel tidak ada di app.js");

  // Satu-satunya argumen window.open di jalur ini adalah konstanta sentinel.
  assert.ok(
    /window\.open\(SUPPORT_LOG_URL\)/.test(code),
    "window.open dipanggil dengan sesuatu selain konstanta sentinel"
  );

  // Tidak ada jalur, nama folder, atau API berkas apa pun di halaman.
  for (const re of [/logsDir/, /%APPDATA%/i, /require\(/, /node:fs/, /openPath/, /shell\./]) {
    assert.doesNotMatch(code, re, "renderer menyentuh sesuatu yang bukan miliknya: " + re);
  }
});

// Nilai sentinel disalin di dua berkas yang tidak bisa saling impor (satu modul
// browser, satu proses utama Electron). Salinan yang tidak dipaku akan
// menyimpang, dan tombolnya akan diam tanpa satu pun tes merah.
test("KONTRAK: sentinel di renderer dan di main PERSIS sama", () => {
  const fromApp = /var SUPPORT_LOG_URL = "([^"]+)"/.exec(APP);
  const fromMain = /const SUPPORT_LOG_URL = "([^"]+)"/.exec(MAIN);
  assert.ok(fromApp, "sentinel tidak ditemukan di app.js");
  assert.ok(fromMain, "sentinel tidak ditemukan di main.js");
  assert.equal(fromApp[1], fromMain[1]);
  assert.equal(fromApp[1], SENTINEL);
});

// Skema kustom, BUKAN http: kalau sentinel-nya http, cabang openExternal yang
// sudah ada akan membuka browser customer ke URL palsu.
test("sentinel memakai skema kustom, bukan http", () => {
  assert.doesNotMatch(SENTINEL, /^https?:/i);
  const handler = MAIN.slice(MAIN.indexOf("setWindowOpenHandler"), MAIN.indexOf("setPermissionRequestHandler"));
  const iSentinel = handler.indexOf("SUPPORT_LOG_URL");
  const iExternal = handler.indexOf("openExternal");
  assert.ok(iSentinel > -1 && iExternal > -1);
  assert.ok(iSentinel < iExternal, "sentinel harus diperiksa SEBELUM cabang openExternal");
});

/* === main process yang memutuskan letaknya ============================== */

test("letak log diresolusi di main dari PATHS.logsDir", () => {
  const fn = MAIN.slice(MAIN.indexOf("async function openSupportLog"), MAIN.indexOf("function createWindow"));
  assert.ok(fn.length > 0, "openSupportLog tidak ditemukan");
  assert.ok(fn.indexOf("PATHS.logsDir") !== -1, "letaknya tidak datang dari PATHS");
  assert.ok(fn.indexOf("SUPPORT_LOG_BASENAME") !== -1, "nama berkasnya tidak dari support-log.js");
  assert.ok(fn.indexOf("shell.openPath") !== -1);

  // Fungsi ini TIDAK menerima argumen - tidak ada celah untuk path dari luar.
  assert.match(MAIN, /async function openSupportLog\(\)/, "openSupportLog menerima argumen");
});

// Nama berkasnya diimpor, bukan ditulis ulang: rotasi sudah punya satu pemilik.
test("nama berkas log diimpor dari support-log.js", () => {
  assert.match(MAIN, /BASENAME: SUPPORT_LOG_BASENAME/);
  assert.equal(typeof BASENAME, "string");
  assert.ok(BASENAME.endsWith(".log"));
  // Dan TIDAK ada salinan literalnya di main.js.
  assert.equal(codeOnly(MAIN).indexOf('"' + BASENAME + '"'), -1, "nama berkas disalin literal");
});

test("berkas hilang ditangani, tidak meledak", () => {
  const fn = MAIN.slice(MAIN.indexOf("async function openSupportLog"), MAIN.indexOf("function createWindow"));
  assert.ok(fn.indexOf("existsSync") !== -1, "keberadaan berkas tidak diperiksa");
  assert.ok(fn.indexOf("SUPPORT_LOG_UNAVAILABLE") !== -1, "tidak ada jalur untuk 'tidak ada log'");
  assert.ok(/catch/.test(fn), "tidak ada penangkap kesalahan");
  // openPath mengembalikan STRING kesalahan, bukan melempar - hasilnya harus dibaca.
  assert.ok(fn.indexOf("SUPPORT_LOG_OPEN_FAILED") !== -1, "kegagalan openPath tidak dilaporkan");
});

/* === keamanan Electron TIDAK berubah ==================================== */

test("REGRESI: pengaturan keamanan BrowserWindow tetap", () => {
  const wp = MAIN.slice(MAIN.indexOf("webPreferences: {"), MAIN.indexOf("});", MAIN.indexOf("webPreferences: {")));
  assert.match(wp, /nodeIntegration:\s*false/);
  assert.match(wp, /contextIsolation:\s*true/);
  assert.match(wp, /sandbox:\s*true/);
  assert.match(wp, /webSecurity:\s*true/);
});

test("REGRESI: tetap TIDAK ada preload dan TIDAK ada IPC", () => {
  const code = codeOnly(MAIN);
  assert.equal(code.indexOf("preload"), -1, "preload muncul di main.js");
  assert.equal(code.indexOf("ipcMain"), -1, "ipcMain muncul di main.js");
  assert.equal(code.indexOf("ipcRenderer"), -1);
  assert.equal(code.indexOf("contextBridge"), -1);
  assert.equal(codeOnly(APP).indexOf("ipcRenderer"), -1, "renderer memakai IPC");
  assert.equal(codeOnly(APP).indexOf("contextBridge"), -1);
});

test("REGRESI: navigasi keluar origin tetap ditolak", () => {
  assert.ok(MAIN.indexOf("NAVIGATION_BLOCKED") !== -1);
  assert.match(MAIN, /will-navigate/);
});

/* === tidak ada data sensitif yang ikut ================================== */

test("aksinya tidak menyentuh profil TikTok maupun data sesi", () => {
  const fn = MAIN.slice(MAIN.indexOf("async function openSupportLog"), MAIN.indexOf("function createWindow"));
  for (const re of [/profileDir/, /browser-profile/, /Cookies/i, /debugDir/, /configFile/]) {
    assert.doesNotMatch(fn, re, "openSupportLog menyentuh " + re);
  }
  // Dan kalimat customer tidak menyebut profil, cookie, atau sesi.
  for (const lang of I.LANGS) {
    for (const k of ["ui.support.title", "ui.support.help", "ui.support.hint", "ui.support.opening", "ui.support.unavailable"]) {
      assert.doesNotMatch(I.DICT[lang][k], /cookie|profil browser|browser profile|session id/i, lang + "/" + k);
    }
  }
});

// Log dukungan sudah punya penyuntingan sendiri; aksi ini tidak boleh
// melewatinya dengan membuka sumber mentah yang lain.
test("yang dibuka adalah log dukungan yang SUDAH tersunting", () => {
  const redactions = require("../desktop/support-log.js").REDACTIONS;
  assert.ok(Array.isArray(redactions) && redactions.length > 0, "log dukungan tidak punya penyuntingan");
  const fn = MAIN.slice(MAIN.indexOf("async function openSupportLog"), MAIN.indexOf("function createWindow"));
  // Hanya logsDir yang disentuh - bukan stdout mentah atau berkas lain.
  assert.equal(fn.indexOf("runtimeDir"), -1);
  assert.equal(fn.indexOf("resourcesRoot"), -1);
});
