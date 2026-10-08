"use strict";
// Electron main — SHELL SAJA.
//
// Berkas ini sengaja tipis. Ia tidak tahu apa pun soal mapping, preflight,
// arming, atau login; semuanya tetap milik Controller, dan dashboard-nya tetap
// halaman P3 yang disajikan Controller lewat HTTP. Tidak ada frontend kedua.
//
// Keputusan lifecycle ada di desktop/lifecycle.js, yang murni dan bisa diuji
// tanpa pernah menyalakan Electron. Yang tertinggal di sini hanya hal-hal yang
// memang hanya bisa dilakukan Electron: kunci satu-instance, membuat jendela,
// dan menahan penutupan sampai pembersihan selesai.
//
// ---------------------------------------------------------------------------
// KEAMANAN RENDERER
//
// nodeIntegration=false, contextIsolation=true, dan TIDAK ADA preload.
//
// Dashboard tidak butuh satu pun API Electron: ia sudah bicara ke Controller
// lewat HTTP di 127.0.0.1. Jadi permukaan IPC yang paling aman adalah yang tidak
// ada sama sekali — tidak ada jembatan untuk disalahgunakan, dan tidak ada
// keputusan lifecycle yang bisa dipicu dari halaman.
//
// Navigasi ke luar juga ditolak. Jendela ini hanya boleh memuat Controller lokal;
// halaman TikTok dibuka di Chrome automation dengan profilnya sendiri, bukan di
// sini — kalau login dilakukan di BrowserWindow, sesinya tersimpan di tempat yang
// salah dan AutoPIN tetap tidak login.

const { app, BrowserWindow, dialog, shell } = require("electron");

const { createDesktopLifecycle } = require("./lifecycle");
const { createStartupFlow, createExitAnnouncer } = require("./startup");
const { spawnControllerChild, createReadinessProbe } = require("./controller-child");
const { resolveNodePath } = require("./node-path");
const { resolveBrowserPath } = require("./browser-path");
const { resolveAppPaths, assertWritableOutsideCode, describePaths, PRODUCT_NAME } = require("./paths");
const { createSupportLog } = require("./support-log");

// Nama aplikasi disetel SEBELUM apa pun membaca userData.
//
// Ini bukan kosmetik. app.getPath("userData") dibentuk dari nama aplikasi, jadi
// nama inilah yang menentukan apakah data customer tinggal di
// %APPDATA%\AI LIVE HOST atau di tempat lain. Dan nilainya TIDAK bisa diandalkan
// datang dari package.json: saat dijalankan sebagai `electron desktop/main.js`,
// Electron melaporkan namanya sendiri ("Electron") dan mengabaikan productName —
// diperiksa langsung di mesin ini pada 2026-10-08. Jadi disebutkan eksplisit,
// dari satu sumber bersama desktop/paths.js.
app.setName(PRODUCT_NAME);

// Peta path untuk mode yang sedang berjalan. Satu kali, di satu tempat.
const PATHS = resolveAppPaths({
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  userData: app.getPath("userData"),
});
const PACKAGED = PATHS.mode === "packaged";

const PORT = 4782;
const BASE = "http://127.0.0.1:" + PORT;
const ALLOWED_ORIGIN = BASE;

let win = null;
let lifecycle = null;
let quitting = false;

// Log dukungan HANYA untuk aplikasi terpaket.
//
// Customer tidak punya terminal: stdout aplikasi yang dibuka dari shortcut tidak
// pergi ke mana pun, jadi tanpa berkas ini satu-satunya laporan yang bisa ia
// berikan adalah "tidak bisa dibuka". Saat dev, terminalnya ADA dan menulis
// berkas kedua hanya akan membuat dua sumber kebenaran.
const supportLog = PACKAGED ? createSupportLog({ dir: PATHS.logsDir }) : null;

function log(tag, fields = {}) {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => k + "=" + String(v));
  const line = ["[DESKTOP_" + tag + "]"].concat(parts).join(" ");
  console.log(line);
  // Penyuntingan rahasia dan rotasi diurus support-log.js.
  if (supportLog) supportLog.write(line);
}

// --- jembatan HTTP tipis ke Controller ---------------------------------------
// Dipakai lifecycle untuk membaca state automation dan memintanya berhenti.

async function api(pathname, method = "GET") {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 5000);
  try {
    const res = await fetch(BASE + pathname, { method, signal: ac.signal });
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function buildLifecycle(nodeForChildren, browserForChildren) {
  const probe = createReadinessProbe({ port: PORT });
  return createDesktopLifecycle({
    spawnController: () =>
      spawnControllerChild({
        // cwd anak DISEBUTKAN, bukan diwarisi.
        //
        // Aplikasi yang dibuka dari shortcut Desktop mewarisi cwd dari Explorer,
        // yang bisa berupa Desktop, Start Menu, atau apa pun. Controller memakai
        // cwd untuk menemukan skrip anaknya, jadi cwd yang diwarisi berarti
        // "index.js tidak ditemukan" di mesin yang shortcut-nya dibuat di tempat
        // berbeda — kegagalan yang tidak akan pernah muncul saat dijalankan dari
        // terminal repo.
        cwd: PATHS.codeRoot,
        port: PORT,
        // Bot dan service WAJIB node.exe, bukan electron.exe: seluruh
        // perlindungan proses yatim mencari Name='node.exe'. Lihat node-path.js.
        nodePathForChildren: nodeForChildren,
        // Satu-satunya pemilik keputusan path adalah desktop/paths.js. Controller
        // tidak menghitung ulang apa pun dari cwd-nya: ia diberi tahu.
        //
        // Kalau Controller ikut menghitung, maka letak data customer ditentukan
        // di dua tempat — dan dua tempat yang menghitung hal yang sama akan
        // menyimpang. Pelajaran yang sama dengan salinan normalizeTitleKey di P2.
        paths: {
          configFile: PATHS.configFile,
          runtimeDir: PATHS.runtimeDir,
          profileDir: PATHS.profileDir,
          debugDir: PATHS.debugDir,
          lockFile: PATHS.lockFile,
          browserPath: browserForChildren,
        },
        // Argumen yang mengizinkan aksi nyata TIDAK diteruskan dari sini.
        // Otoritasnya per-run dan diberikan Controller sendiri saat START BOT
        // lolos preflight (controller/run-authority.js).
        args: [],
        onLine: ({ channel, line }) => {
          if (channel === "stderr") console.error(line);
          else console.log(line);
          // Baris Controller ikut ke log dukungan: justru baris inilah yang
          // menjawab "kenapa tidak mau start" saat tidak ada terminal.
          if (supportLog) supportLog.write(line);
        },
        log,
      }),
    waitReady: probe,
    getAutomationState: async () => {
      const body = await api("/api/status");
      return body && typeof body.automation === "string" ? body.automation : null;
    },
    stopAutomation: () => api("/api/stop", "POST"),
    log,
  });
}

// --- jendela ------------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    title: "AI LIVE HOST",
    backgroundColor: "#f4f5f7",
    // Jendela baru ditampilkan hanya sesudah halaman siap, supaya customer tidak
    // melihat kotak putih kosong lebih dulu.
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      // Tidak ada preload: dashboard tidak butuh satu pun API Electron.
      // Permukaan IPC yang paling aman adalah yang tidak ada.
      spellcheck: false,
    },
  });

  win.once("ready-to-show", () => win.show());
  win.loadURL(BASE + "/");

  // Navigasi ke luar origin Controller DITOLAK. Satu halaman, satu asal.
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(ALLOWED_ORIGIN)) {
      event.preventDefault();
      log("NAVIGATION_BLOCKED", { url: url.slice(0, 120) });
    }
  });

  // Jendela baru tidak pernah dibuka di dalam aplikasi. Tautan luar (kalau suatu
  // saat ada) diserahkan ke browser customer, bukan dimuat di sini.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && !url.startsWith(ALLOWED_ORIGIN)) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: "deny" };
  });

  // Izin perangkat (kamera, mikrofon, notifikasi) tidak dibutuhkan dashboard.
  win.webContents.session.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));

  win.on("closed", () => {
    win = null;
  });
}

// --- penutupan ----------------------------------------------------------------

// Menutup jendela saat automation RUNNING tidak boleh langsung mematikan Electron.
// Kalau Electron mati lebih dulu, Controller kehilangan induknya sementara bot dan
// service masih hidup, masih memegang profil Chrome, dan masih mengklik produk di
// akun sungguhan — tanpa ada lagi yang akan membereskannya.
async function gracefulQuit() {
  if (quitting) return;
  quitting = true;
  log("QUIT_REQUESTED", {});

  if (win && !win.isDestroyed()) {
    // Memberi tahu customer bahwa penutupan sedang berjalan, lewat judul jendela
    // supaya tidak perlu IPC apa pun ke halaman.
    try {
      win.setTitle("AI LIVE HOST — stopping safely…");
    } catch {
      /* diabaikan */
    }
  }

  let result = { ok: true };
  try {
    if (lifecycle) result = await lifecycle.stop();
  } catch (err) {
    result = { ok: false, code: "shutdown-failed", detail: String((err && err.message) || "") };
  }

  if (!result.ok) {
    // TIDAK mengaku bersih saat tidak bersih.
    log("SHUTDOWN_INCOMPLETE", { code: result.code, remaining: result.remaining });
    // Cacat yang sama dengan jalur startup: showErrorBox memblokir sampai diklik,
    // jadi app.exit() di bawahnya tidak pernah dijalankan dan Electron tetap hidup
    // memegang kunci satu-instance. Mekanismenya dipakai bersama, bukan disalin.
    createExitAnnouncer({ showFailure, exit: (code) => app.exit(code), log }).announceThenExit(1, {
      title: "AI LIVE HOST did not shut down cleanly",
      message:
        "Some background processes may still be running. Open Task Manager and close any remaining " +
        "node.exe or Chrome windows that belong to AI LIVE HOST.",
    });
    return;
  }

  app.exit(0);
}

// --- kabar kegagalan ----------------------------------------------------------

// showErrorBox MEMBLOKIR sampai ada yang menekan OK, dan saat startup gagal belum
// ada jendela sama sekali — jadi kotaknya tidak terlihat dan baris sesudahnya
// tidak pernah dijalankan. Itu sebab persis dari "aplikasi gagal tapi tetap hidup
// memegang kunci satu-instance" pada 2026-10-08.
//
// Versi asinkronnya mengembalikan Promise, jadi desktop/startup.js bisa keluar
// saat diklik ATAU saat batas waktunya habis — mana yang lebih dulu.
function showFailure({ title, message }) {
  return dialog
    .showMessageBox({
      type: "error",
      title: "AI LIVE HOST",
      message: title,
      detail: message,
      buttons: ["OK"],
      defaultId: 0,
      noLink: true,
    })
    .then(() => undefined);
}

// --- startup ------------------------------------------------------------------

// Kunci satu-instance: double-click kedua TIDAK boleh menyalakan Controller kedua.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  log("SECOND_INSTANCE_REFUSED", {});
  app.exit(0);
} else {
  app.on("second-instance", () => {
    // Instance kedua keluar sendiri; yang pertama memfokuskan jendelanya.
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.on("window-all-closed", () => {
    // Tidak langsung keluar: gracefulQuit yang memutuskan kapan boleh keluar.
    gracefulQuit();
  });

  app.on("before-quit", (event) => {
    if (!quitting) {
      event.preventDefault();
      gracefulQuit();
    }
  });

  app.whenReady().then(async () => {
    log("MODE", describePaths(PATHS));

    // Browser diresolusi SEKALI, dan jawabannya dipakai dua kali: sebagai
    // gerbang startup (ada atau aplikasi tidak menyala) dan sebagai nilai yang
    // diteruskan ke Controller. Meresolusinya dua kali membuka kemungkinan
    // gerbangnya memeriksa satu hal dan yang dipakai hal lain.
    const browser = resolveBrowserPath({ packaged: PACKAGED, bundledBrowser: PATHS.bundledBrowser });

    // Seluruh keputusan startup ada di desktop/startup.js, yang murni dan diuji
    // offline. Yang tertinggal di sini hanya sambungan ke Electron.
    const startup = createStartupFlow({
      checkPaths: () => assertWritableOutsideCode(PATHS),
      resolveNode: () => resolveNodePath({ packaged: PACKAGED, bundledNode: PATHS.bundledNode }),
      resolveBrowser: () => browser,
      buildLifecycle: (nodePath) => {
        lifecycle = buildLifecycle(nodePath, browser.browserPath);
        return lifecycle;
      },
      createWindow,
      showFailure,
      // Keluar membebaskan kunci satu-instance. Tanpa ini, double-click
      // berikutnya ditolak oleh instance yang sudah tidak berguna.
      exit: (code) => app.exit(code),
      log,
    });
    await startup.run();
  });
}

module.exports = { gracefulQuit, buildLifecycle };
