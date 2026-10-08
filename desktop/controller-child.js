"use strict";
// Kepemilikan proses Controller oleh aplikasi desktop.
//
// Satu-satunya tempat di sisi desktop yang menyalakan atau mematikan Controller,
// dengan pola yang sama seperti controller/process-manager.js memegang bot dan
// service: PID dilacak sendiri, berhenti diminta baik-baik dulu, dan kematiannya
// DIBUKTIKAN — bukan disimpulkan dari "kill tidak melempar".
//
// Permintaan berhenti dikirim lewat stdin, bukan lewat sinyal maupun HTTP:
//
//   sinyal  di Windows, child.kill("SIGTERM") memanggil TerminateProcess, jadi
//           handler shutdown Controller tidak pernah berjalan dan bot/service/
//           Chrome automation tertinggal hidup.
//   HTTP    proses yang bisa dimatikan lewat jaringan adalah permukaan yang
//           tidak perlu ada. Hanya induknya yang punya stdin ini.

const { spawn } = require("node:child_process");
const path = require("node:path");
const { pidAlive } = require("../runtime/single-instance");
const { resolveNodePath } = require("./node-path");

const CONTROLLER_SCRIPT = path.join("controller", "index.js");

// Membuat pegangan ke satu proses Controller. Bentuknya sengaja cocok dengan apa
// yang dibutuhkan desktop/lifecycle.js, supaya lifecycle bisa diuji dengan
// pegangan palsu tanpa pernah menyalakan proses.
// Path yang diteruskan ke Controller sebagai argumen, dan nama flag-nya.
//
// Daftar TERTUTUP dan satu arah: desktop memberi tahu, Controller menerima.
// Tidak ada satu pun dari ini yang dihitung ulang di sisi Controller — kalau
// dihitung ulang, letak data customer akan ditentukan di dua tempat, dan dua
// tempat yang menghitung hal yang sama akan menyimpang. Satu-satunya pemilik
// keputusannya adalah desktop/paths.js.
const PATH_FLAGS = Object.freeze([
  ["configFile", "--config-file="],
  ["runtimeDir", "--runtime-dir="],
  ["profileDir", "--profile-dir="],
  ["debugDir", "--debug-dir="],
  ["lockFile", "--lock-file="],
  ["browserPath", "--browser-path="],
]);

function spawnControllerChild({
  cwd = process.cwd(),
  nodePath = process.execPath,
  port = 4782,
  args = [],
  env = process.env,
  // Path Node untuk anak-anak Controller (bot dan service AutoPIN).
  nodePathForChildren = null,
  // Peta path dari desktop/paths.js. Kosong = Controller memakai default-nya
  // sendiri, yang merupakan perilaku jalur manual `node controller/index.js`
  // dan TIDAK berubah karena P5.
  paths = null,
  onLine = () => {},
  log = () => {},
} = {}) {
  const file = path.join(cwd, CONTROLLER_SCRIPT);

  // Path Node SUNGGUHAN diteruskan ke Controller, dan Controller memakainya untuk
  // menyalakan bot dan service. Tanpa itu, anak-anaknya menjadi electron.exe dan
  // scripts/stop-all.ps1 berhenti menemukannya — mengulang insiden 2026-10-05
  // dengan bentuk yang persis sama. Lihat desktop/node-path.js.
  const childArgs = [file, "--port=" + String(port), "--parent-pipe"];
  if (nodePathForChildren) childArgs.push("--node-path=" + nodePathForChildren);

  // Flag path diteruskan HANYA kalau ada isinya. Nilai kosong tidak pernah
  // menjadi flag kosong: `--config-file=` tanpa nilai akan diartikan Controller
  // sebagai path kosong, dan itu lebih buruk daripada tidak menyebutkannya.
  if (paths) {
    for (const [key, flag] of PATH_FLAGS) {
      const value = paths[key];
      if (typeof value === "string" && value !== "") childArgs.push(flag + value);
    }
  }

  const child = spawn(
    nodePath,
    childArgs.concat(args),
    {
      cwd,
      // stdin PIPE: itulah kanal permintaan berhenti. stdout/stderr ikut
      // ditangkap supaya kegagalan start bisa dilaporkan, bukan hilang.
      stdio: ["pipe", "pipe", "pipe"],
      // ELECTRON_RUN_AS_NODE membuat binary Electron berperilaku sebagai Node biasa.
      //
      // WAJIB, dan ini bukan kehati-hatian teoretis. Di dalam Electron,
      // process.execPath adalah electron.exe — BUKAN node. Tanpa variabel ini,
      // perintahnya menjadi `electron.exe controller/index.js`, yang diartikan
      // Electron sebagai "buka aplikasi di direktori itu", bukan "jalankan skrip
      // Node ini". Controller tidak pernah menyala, health check kehabisan waktu,
      // dan aplikasi hanya menampilkan "could not start" tanpa petunjuk apa pun.
      //
      // Terjadi sungguhan pada 2026-10-08: tes lolos karena harness-nya dijalankan
      // dengan `node` (di situ execPath memang node), lalu `npm run desktop`
      // gagal di percobaan pertama.
      //
      // Aman di kedua arah: Node biasa mengabaikan variabel yang tidak dikenalnya.
      env: Object.assign({}, env, { ELECTRON_RUN_AS_NODE: "1" }),
      windowsHide: true,
    }
  );

  let exited = false;
  let exitInfo = null;
  const exitHandlers = [];

  child.on("exit", (code, signal) => {
    exited = true;
    exitInfo = { code, signal: signal || null };
    log("CONTROLLER_CHILD_EXIT", { code: code === null ? "null" : code, signal: signal || "" });
    for (const h of exitHandlers.splice(0)) {
      try {
        h(exitInfo);
      } catch {
        /* pendengar yang melempar tidak boleh menjatuhkan desktop */
      }
    }
  });

  child.on("error", (err) => {
    log("CONTROLLER_CHILD_ERROR", { detail: String((err && err.message) || "").slice(0, 120) });
  });

  // --- tonggak boot & kabar fatal (P4.2) ------------------------------------
  //
  // Dua hal dibaca dari aliran log Controller, dan keduanya untuk SATU tujuan:
  // membedakan "lambat" dari "menggantung".
  //
  //   bootStage   tahap terakhir yang dilaporkan Controller. Kalau kesiapan
  //               habis waktunya, laporannya bisa menyebut tahap mana yang
  //               tertinggal — bukan sekadar "timeout".
  //   fatal       Controller mengabarkan kegagalan startup. Menunggu sampai batas
  //               waktu sesudah itu hanya menunda kabar buruk yang sudah pasti.
  let bootStage = null;
  let fatal = null;

  const BOOT_RE = /^\[CONTROLLER_BOOT\]\s+stage=([a-z-]+)/;
  const FATAL_RE = /^\[CONTROLLER_(FATAL|BOOT_FAILED)\]/;

  function noteLine(line) {
    const b = BOOT_RE.exec(line);
    if (b) {
      bootStage = b[1];
      return;
    }
    if (fatal === null && FATAL_RE.test(line)) fatal = line.slice(0, 200);
  }

  // Baris demi baris, supaya log Controller tetap terbaca utuh.
  function attach(stream, channel) {
    if (!stream) return;
    let buffer = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buffer += String(chunk);
      if (buffer.length > 64 * 1024) buffer = buffer.slice(-64 * 1024);
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        if (line !== "") {
          noteLine(line);
          try {
            onLine({ channel, line });
          } catch {
            /* diabaikan */
          }
        }
      }
    });
    stream.on("error", () => {
      /* pipe tertutup saat child mati: bukan kejadian */
    });
  }
  attach(child.stdout, "stdout");
  attach(child.stderr, "stderr");

  return {
    pid: child.pid,

    // Tahap boot terakhir yang dikabarkan Controller, atau null kalau belum ada
    // satu pun. Dipakai laporan timeout supaya ia menyebut DI MANA ia tertinggal.
    bootStage: () => bootStage,

    // Baris kegagalan startup dari Controller, atau null. Kehadirannya berarti
    // Controller sudah menyerah; menunggunya siap tidak ada gunanya lagi.
    fatal: () => fatal,

    // Minta Controller membereskan dirinya: ia akan menghentikan bot, service,
    // Chrome automation, dan jendela login sebelum keluar.
    requestShutdown() {
      try {
        if (child.stdin && child.stdin.writable) child.stdin.write("shutdown\n");
      } catch {
        /* jalur paksa yang menanggungnya */
      }
    },

    // Paksa. Dipakai hanya kalau permintaan sopan di atas tidak membuahkan hasil
    // dalam batas waktu.
    kill() {
      try {
        child.kill("SIGKILL");
      } catch {
        /* pembuktian lewat alive() yang menentukan */
      }
    },

    // Kematian DIBUKTIKAN lewat keberadaan PID, bukan lewat event saja: event
    // "exit" bisa belum sempat terkirim walau prosesnya sudah hilang.
    alive() {
      if (exited) return false;
      return pidAlive(child.pid);
    },

    onExit(cb) {
      if (exited) {
        try {
          cb(exitInfo);
        } catch {
          /* diabaikan */
        }
        return;
      }
      exitHandlers.push(cb);
    },

    __child: child,
  };
}

// Health check Controller. Dipakai lifecycle untuk menunggu kesiapan.
function createReadinessProbe({ port = 4782, timeoutMs = 1500 } = {}) {
  return async function waitReady() {
    const doFetch = globalThis.fetch;
    if (typeof doFetch !== "function") return { ok: false, reason: "fetch-unavailable" };
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await doFetch("http://127.0.0.1:" + port + "/api/status", { signal: ac.signal });
      if (!res.ok) return { ok: false, reason: "http-" + res.status };
      const body = await res.json();
      // Siap berarti Controller menjawab DAN melaporkan bentuk yang kita pahami.
      return typeof body.automation === "string" ? { ok: true, status: body } : { ok: false, reason: "unexpected-body" };
    } catch {
      return { ok: false, reason: "unreachable" };
    } finally {
      clearTimeout(t);
    }
  };
}

module.exports = { spawnControllerChild, createReadinessProbe, CONTROLLER_SCRIPT, PATH_FLAGS };
