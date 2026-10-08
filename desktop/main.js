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

const path = require("node:path");
const { app, BrowserWindow, dialog, shell } = require("electron");

const { createDesktopLifecycle } = require("./lifecycle");
const { spawnControllerChild, createReadinessProbe } = require("./controller-child");

const ROOT = path.resolve(__dirname, "..");
const PORT = 4782;
const BASE = "http://127.0.0.1:" + PORT;
const ALLOWED_ORIGIN = BASE;

let win = null;
let lifecycle = null;
let quitting = false;

function log(tag, fields = {}) {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => k + "=" + String(v));
  console.log(["[DESKTOP_" + tag + "]"].concat(parts).join(" "));
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

function buildLifecycle() {
  const probe = createReadinessProbe({ port: PORT });
  return createDesktopLifecycle({
    spawnController: () =>
      spawnControllerChild({
        cwd: ROOT,
        port: PORT,
        // Argumen yang mengizinkan aksi nyata TIDAK diteruskan dari sini.
        // Otoritasnya per-run dan diberikan Controller sendiri saat START BOT
        // lolos preflight (controller/run-authority.js).
        args: [],
        onLine: ({ channel, line }) => {
          if (channel === "stderr") console.error(line);
          else console.log(line);
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
    try {
      dialog.showErrorBox(
        "AI LIVE HOST did not shut down cleanly",
        "Some background processes may still be running. Open Task Manager and close any remaining " +
          "node.exe or Chrome windows that belong to AI LIVE HOST."
      );
    } catch {
      /* dialog gagal bukan alasan menahan keluar */
    }
  }

  app.exit(result.ok ? 0 : 1);
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
    lifecycle = buildLifecycle();
    const started = await lifecycle.start();

    if (!started.ok) {
      log("CONTROLLER_START_FAILED", { code: started.code });
      dialog.showErrorBox(
        "AI LIVE HOST could not start.",
        "The local controller did not start. Close any other copy of AI LIVE HOST and try again."
      );
      // Tidak meninggalkan proses tersembunyi: lifecycle.start() sudah
      // membereskan child-nya sendiri saat gagal.
      app.exit(1);
      return;
    }

    createWindow();
  });
}

module.exports = { gracefulQuit, buildLifecycle };
