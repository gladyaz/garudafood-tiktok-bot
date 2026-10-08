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

const CONTROLLER_SCRIPT = path.join("controller", "index.js");

// Membuat pegangan ke satu proses Controller. Bentuknya sengaja cocok dengan apa
// yang dibutuhkan desktop/lifecycle.js, supaya lifecycle bisa diuji dengan
// pegangan palsu tanpa pernah menyalakan proses.
function spawnControllerChild({
  cwd = process.cwd(),
  nodePath = process.execPath,
  port = 4782,
  args = [],
  env = process.env,
  onLine = () => {},
  log = () => {},
} = {}) {
  const file = path.join(cwd, CONTROLLER_SCRIPT);

  const child = spawn(
    nodePath,
    [file, "--port=" + String(port), "--parent-pipe"].concat(args),
    {
      cwd,
      // stdin PIPE: itulah kanal permintaan berhenti. stdout/stderr ikut
      // ditangkap supaya kegagalan start bisa dilaporkan, bukan hilang.
      stdio: ["pipe", "pipe", "pipe"],
      env,
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

module.exports = { spawnControllerChild, createReadinessProbe, CONTROLLER_SCRIPT };
