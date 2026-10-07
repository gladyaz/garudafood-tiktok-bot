"use strict";
// SATU-SATUNYA tempat di Controller yang boleh menyalakan atau mematikan proses
// anak. Tidak ada modul lain yang memanggil spawn.
//
// Kenapa dipusatkan: insiden LIVE 2026-10-05 (Phase 21) terjadi karena tidak ada
// satu pihak yang memegang daftar proses yang hidup. Tiga `node index.js` jalan
// bersamaan, dan pemeriksaan yang ada memakai pola yang tidak pernah cocok
// (`-match 'node index\.js'` vs command line sebenarnya
// `"C:\Program Files\nodejs\node.exe" index.js`), jadi laporan "sisa bot: 0"
// terbit tiga kali padahal tiga bot masih hidup.
//
// Dua pelajaran dari insiden itu dipakai di sini:
//
//   1. PID dan handle child dilacak oleh Controller sendiri. Perintah shell
//      (scripts/stop-all.ps1) TIDAK dijadikan satu-satunya sumber kebenaran; ia
//      hanya jaring darurat untuk proses YATIM dari sesi sebelumnya.
//   2. Setelah mematikan, keberadaan proses DIBUKTIKAN lagi lewat pidAlive(),
//      bukan diasumsikan dari "kill tidak melempar".
//
// Catatan Windows yang penting dan sengaja tidak disembunyikan:
// child.kill("SIGTERM") di Windows TIDAK mengantar sinyal — Node memanggil
// TerminateProcess. Jadi handler SIGTERM di autopin-service.js (yang menutup
// browser) TIDAK akan berjalan di mesin ini. Akibatnya Chrome automation bisa
// tertinggal, dan itulah sebabnya cleanupAutomationChrome() ada dan dipanggil
// oleh stopAll().

const { spawn: spawnDefault } = require("node:child_process");
const pathDefault = require("node:path");
// pidAlive dipinjam dari modul runtime yang sudah terbukti (dibuat sesudah
// Phase 21). Hanya dibaca, tidak diubah. process.kill(pid, 0) tidak mengirim
// sinyal apa pun, hanya menanyakan keberadaan proses, dan jalan di Windows.
const { pidAlive: pidAliveDefault } = require("../runtime/single-instance");

const ROLES = Object.freeze({ SERVICE: "service", BOT: "bot" });

// Skrip yang Controller boleh jalankan. Daftar tertutup: Controller tidak pernah
// menjalankan perintah sembarang, termasuk kalau config bilang lain.
const SCRIPTS = Object.freeze({
  [ROLES.SERVICE]: "autopin-service.js",
  [ROLES.BOT]: "index.js",
});

// Batas tunggu terminasi sopan sebelum dipaksa. Dipilih longgar untuk service
// karena ia menutup browser saat shutdown bersih (di platform yang benar-benar
// mengantar SIGTERM), dan pendek untuk bot yang tidak punya pekerjaan tutup apa pun.
const DEFAULT_GRACE_MS = Object.freeze({ [ROLES.SERVICE]: 8000, [ROLES.BOT]: 4000 });

// Baris log child dipotong supaya satu baris raksasa dari child tidak pernah
// bisa menghabiskan memori Controller.
const MAX_LINE_LENGTH = 2000;

function nowDefault() {
  return Date.now();
}

function createProcessManager({
  cwd = process.cwd(),
  spawn = spawnDefault,
  nodePath = process.execPath,
  pidAlive = pidAliveDefault,
  now = nowDefault,
  log = () => {},
  onLine = () => {},
  onExit = () => {},
  // Dilewatkan oleh tes sebagai stub. Di produksi: pembunuh Chrome automation
  // berdasarkan direktori profil, logika yang sama dengan scripts/stop-all.ps1.
  killAutomationChrome = null,
  // Jaring darurat untuk proses yatim dari sesi SEBELUM Controller hidup.
  orphanSweeper = null,
  // Jeda polling saat menunggu proses benar-benar mati.
  pollMs = 50,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  // Satu slot per peran. Lebih dari satu service atau lebih dari satu bot tidak
  // pernah mungkin karena slot-nya memang cuma satu, bukan karena ada yang
  // mengingat untuk memeriksa.
  const slots = {
    [ROLES.SERVICE]: null,
    [ROLES.BOT]: null,
  };

  function describe(role) {
    const slot = slots[role];
    if (!slot) return { running: false, pid: null };
    return {
      running: slot.exited === false,
      pid: slot.pid,
      startedAt: slot.startedAt,
      exitedAt: slot.exitedAt || null,
      exitCode: slot.exitCode === undefined ? null : slot.exitCode,
      signal: slot.signal || null,
      script: slot.script,
    };
  }

  function getProcessState() {
    return {
      service: describe(ROLES.SERVICE),
      bot: describe(ROLES.BOT),
    };
  }

  // Potong stdout/stderr menjadi baris. Sisa tanpa newline ditahan sampai
  // newline berikutnya datang, supaya satu baris log tidak pernah terbelah dua
  // dan gagal dikenali oleh parser activity.
  function attachLineReader(slot, stream, channel) {
    if (!stream || typeof stream.on !== "function") return;
    let buffer = "";
    stream.setEncoding && stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buffer += String(chunk);
      // Buffer yang tidak pernah menemukan newline tidak boleh tumbuh tanpa batas.
      if (buffer.length > MAX_LINE_LENGTH * 4) buffer = buffer.slice(-MAX_LINE_LENGTH * 4);
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        if (line === "") continue;
        try {
          onLine({ role: slot.role, channel, line: line.slice(0, MAX_LINE_LENGTH), at: now() });
        } catch {
          /* pendengar yang melempar tidak boleh menjatuhkan Controller */
        }
      }
    });
    stream.on("error", () => {
      /* pipe yang tertutup saat child mati bukan kejadian yang perlu dilaporkan */
    });
  }

  function start(role, { env = {}, args = [] } = {}) {
    const existing = slots[role];
    if (existing && existing.exited === false) {
      // Ditolak, bukan diantrekan. Mengantrekan start kedua adalah cara paling
      // rapi untuk sampai ke dua bot yang saling menimpa aksi di akun sungguhan.
      return { ok: false, code: role + "-already-running", pid: existing.pid };
    }

    const script = SCRIPTS[role];
    const file = pathDefault.join(cwd, script);

    let child;
    try {
      child = spawn(nodePath, [file].concat(args), {
        cwd,
        // Environment anak dibentuk PENUH oleh pemanggil (adapter config), tidak
        // diwarisi diam-diam dari Controller: nilai sisa di environment Controller
        // tidak boleh bisa mengubah perilaku bot tanpa terlihat di config.
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      log("CHILD_SPAWN_FAILED", { role, script, detail: String(err && err.message).slice(0, 120) });
      return { ok: false, code: "spawn-failed" };
    }

    // Spawn yang gagal secara asinkron (mis. berkas tidak ada) tetap mengembalikan
    // objek child tanpa pid. Itu kegagalan, dan harus terlihat sebagai kegagalan.
    if (!child || typeof child.pid !== "number" || child.pid <= 0) {
      return { ok: false, code: "spawn-no-pid" };
    }

    const slot = {
      role,
      script,
      child,
      pid: child.pid,
      startedAt: now(),
      exited: false,
      exitCode: undefined,
      signal: null,
      exitedAt: null,
      // Diisi stop(): penanda bahwa kematian ini DIMINTA, supaya child yang mati
      // sendiri (crash) bisa dibedakan dari child yang kita matikan.
      stopping: false,
      waiters: [],
    };
    slots[role] = slot;

    attachLineReader(slot, child.stdout, "stdout");
    attachLineReader(slot, child.stderr, "stderr");

    child.on("error", (err) => {
      log("CHILD_ERROR", { role, pid: slot.pid, detail: String(err && err.message).slice(0, 120) });
    });

    child.on("exit", (code, signal) => {
      slot.exited = true;
      slot.exitCode = code;
      slot.signal = signal || null;
      slot.exitedAt = now();
      const waiters = slot.waiters.splice(0);
      for (const w of waiters) w();
      log("CHILD_EXIT", { role, pid: slot.pid, code: code === null ? "null" : code, signal: signal || "" });
      try {
        // expected=true berarti Controller yang memintanya berhenti. expected=false
        // adalah crash, dan itulah yang membuat state pindah ke DEGRADED/ERROR.
        onExit({ role, pid: slot.pid, code, signal: signal || null, expected: slot.stopping === true, at: slot.exitedAt });
      } catch {
        /* diabaikan dengan sengaja */
      }
    });

    log("CHILD_STARTED", { role, pid: slot.pid, script });
    return { ok: true, pid: slot.pid };
  }

  function waitForExit(slot, timeoutMs) {
    if (slot.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      // Timer tidak boleh menahan proses Controller tetap hidup.
      if (timer && typeof timer.unref === "function") timer.unref();
      slot.waiters.push(() => finish(true));
    });
  }

  // Sopan dulu, paksa kemudian, lalu BUKTIKAN. Urutan ini tidak boleh dipotong:
  // "kill tidak melempar" bukan bukti proses sudah mati.
  async function stop(role, { graceMs } = {}) {
    const slot = slots[role];
    if (!slot) return { ok: true, code: "not-started" };
    if (slot.exited) return { ok: true, code: "already-exited", pid: slot.pid };

    const budget = Number.isInteger(graceMs) && graceMs > 0 ? graceMs : DEFAULT_GRACE_MS[role];
    slot.stopping = true;

    // Tahap 1: minta berhenti dengan sopan. Di Linux/macOS handler SIGTERM child
    // berjalan. Di Windows ini sudah setara terminasi paksa — lihat catatan di
    // kepala berkas; itu bukan hal yang bisa diperbaiki dari sisi sini.
    try {
      slot.child.kill("SIGTERM");
    } catch {
      /* proses mungkin sudah mati di antara pemeriksaan dan kill */
    }

    let gone = await waitForExit(slot, budget);

    // Tahap 2: paksa, hanya kalau yang sopan gagal.
    if (!gone) {
      log("CHILD_FORCE_KILL", { role, pid: slot.pid, afterMs: budget });
      try {
        slot.child.kill("SIGKILL");
      } catch {
        /* diabaikan: pembuktian di tahap 3 yang menentukan */
      }
      gone = await waitForExit(slot, budget);
    }

    // Tahap 3: pembuktian. Inilah angka yang boleh dipercaya, bukan asumsi.
    // Event 'exit' bisa saja belum sempat terkirim walau prosesnya sudah hilang,
    // jadi pidAlive() yang jadi hakim terakhir.
    let alive = pidAlive(slot.pid);
    const deadline = now() + budget;
    while (alive && now() < deadline) {
      await sleep(pollMs);
      alive = pidAlive(slot.pid);
    }

    if (alive) {
      log("CHILD_STILL_ALIVE", { role, pid: slot.pid });
      return { ok: false, code: role + "-did-not-die", pid: slot.pid };
    }

    // Kalau pidAlive sudah bilang mati tapi event exit belum datang, catat
    // sendiri: state Controller tidak boleh menggantung menunggu event.
    if (!slot.exited) {
      slot.exited = true;
      slot.exitedAt = now();
      slot.waiters.splice(0).forEach((w) => w());
    }

    return { ok: true, code: "stopped", pid: slot.pid, forced: !gone };
  }

  // Chrome milik automation dikenali dari direktori profilnya, sama seperti
  // scripts/stop-all.ps1, supaya Chrome pribadi operator TIDAK PERNAH ikut
  // tertutup. Tanpa pembunuh yang di-inject, ini no-op yang jujur — bukan
  // kesuksesan yang dipalsukan.
  async function cleanupAutomationChrome() {
    if (typeof killAutomationChrome !== "function") {
      return { ok: true, code: "chrome-cleanup-not-configured", killed: 0 };
    }
    try {
      const r = await killAutomationChrome();
      const killed = r && Number.isInteger(r.killed) ? r.killed : 0;
      if (killed > 0) log("CHROME_CLEANED", { killed });
      return { ok: true, killed };
    } catch (err) {
      log("CHROME_CLEANUP_FAILED", { detail: String(err && err.message).slice(0, 120) });
      return { ok: false, code: "chrome-cleanup-failed", killed: 0 };
    }
  }

  // Hanya untuk proses YATIM: bot/service yang hidup dari sesi SEBELUM Controller
  // ini ada (mis. operator pernah menjalankan `node index.js` dari terminal, atau
  // Controller sebelumnya mati mendadak). Child milik Controller ini diurus oleh
  // slot di atas, bukan oleh penyapu ini.
  async function cleanupOrphans() {
    if (typeof orphanSweeper !== "function") {
      return { ok: true, code: "orphan-sweep-not-configured", killed: 0 };
    }
    const ownPids = new Set(
      Object.values(slots)
        .filter((s) => s && s.exited === false)
        .map((s) => s.pid)
    );
    try {
      const r = await orphanSweeper({ ownPids });
      const killed = r && Number.isInteger(r.killed) ? r.killed : 0;
      const remaining = r && Number.isInteger(r.remaining) ? r.remaining : 0;
      log("ORPHAN_SWEEP", { killed, remaining });
      // remaining > 0 artinya penyapu TIDAK bisa membuktikan sisanya nol. Itu
      // kegagalan, dan preflight harus memperlakukannya sebagai kegagalan.
      return { ok: remaining === 0, code: remaining === 0 ? "swept" : "orphans-remain", killed, remaining };
    } catch (err) {
      log("ORPHAN_SWEEP_FAILED", { detail: String(err && err.message).slice(0, 120) });
      return { ok: false, code: "orphan-sweep-failed", killed: 0 };
    }
  }

  // Urutan sengaja: bot dulu, baru service. Bot adalah yang MEMANGGIL service;
  // mematikan service lebih dulu membuat bot menembak port yang sudah mati dan
  // mencatat kegagalan yang tidak ada artinya.
  async function stopAll({ graceMs } = {}) {
    const bot = await stop(ROLES.BOT, { graceMs });
    const service = await stop(ROLES.SERVICE, { graceMs });
    // Chrome dibersihkan SESUDAH service mati: menutupnya lebih dulu hanya membuat
    // service membuka yang baru.
    const chrome = await cleanupAutomationChrome();
    return { ok: bot.ok && service.ok, bot, service, chrome };
  }

  return {
    startService: (opts) => start(ROLES.SERVICE, opts),
    startBot: (opts) => start(ROLES.BOT, opts),
    stopBot: (opts) => stop(ROLES.BOT, opts),
    stopService: (opts) => stop(ROLES.SERVICE, opts),
    stopAll,
    cleanupOrphans,
    cleanupAutomationChrome,
    getProcessState,
    ROLES,
    __slots: () => slots,
  };
}

module.exports = { createProcessManager, ROLES, SCRIPTS, DEFAULT_GRACE_MS, MAX_LINE_LENGTH };
