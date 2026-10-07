"use strict";
// Alat bantu tes Controller. SEMUANYA palsu dan di dalam proses ini:
//
//   - tidak ada proses yang benar-benar dinyalakan atau dimatikan
//   - tidak ada socket, tidak ada OBS, tidak ada TikTok, tidak ada browser
//   - tidak ada berkas yang ditulis ke disk (fs palsu berbasis Map)
//   - waktu adalah jam virtual, jadi batas waktu deterministik dan tes tidak
//     pernah benar-benar menunggu puluhan detik
//
// Jam virtual penting bukan hanya untuk kecepatan: dengan Date.now() yang
// sungguhan, tes batas waktu lulus atau gagal tergantung beban mesin. Itu jenis
// tes yang nanti akan dimatikan orang karena "kadang merah", dan justru tes batas
// waktu yang paling tidak boleh hilang.

const { EventEmitter } = require("node:events");

// --- jam virtual -------------------------------------------------------------

function createClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    // sleep MEMAJUKAN waktu, bukan menunggu. Setiap loop polling di Controller
    // memakai sleep yang di-inject ini, jadi batas waktu 45 detik terlewati dalam
    // beberapa milidetik nyata tanpa mengubah logikanya.
    //
    // setImmediate, bukan Promise.resolve(): microtask tidak pernah memberi
    // kesempatan pada event loop, jadi loop polling akan menghabiskan seluruh
    // batas waktunya sebelum tes sempat menyuntikkan apa pun. Dengan setImmediate,
    // urutannya tetap deterministik TAPI tes masih bisa menyela.
    sleep: (ms) => {
      t += Math.max(1, Number(ms) || 1);
      return new Promise((r) => setImmediate(r));
    },
    advance: (ms) => {
      t += Number(ms) || 0;
    },
  };
}

// --- child process palsu -----------------------------------------------------

function createFakeStream() {
  const s = new EventEmitter();
  s.setEncoding = () => {};
  return s;
}

// Dunia proses palsu: mencatat siapa yang di-spawn, siapa yang hidup, dan sinyal
// apa yang diterima. pidAlive() dijawab dari himpunan `alive` di sini, jadi
// pembuktian kematian di process-manager benar-benar diuji dan bukan dilewati.
function createFakeWorld({ dieOnSignal = true, onSpawn = null } = {}) {
  const alive = new Set();
  const spawned = [];
  let nextPid = 4000;

  function spawn(cmd, args, opts) {
    const pid = (nextPid += 7);
    const child = new EventEmitter();
    child.pid = pid;
    child.stdout = createFakeStream();
    child.stderr = createFakeStream();
    child.signals = [];
    child.spawnArgs = args;
    child.spawnEnv = opts && opts.env ? opts.env : {};
    child.spawnCwd = opts && opts.cwd;
    child.script = String((args && args[0]) || "");
    // Child yang keras kepala: dipakai untuk menguji jalur force-kill dan jalur
    // "tidak bisa dibuktikan mati".
    child.ignoreSignals = dieOnSignal === false;

    child.kill = (signal) => {
      child.signals.push(signal);
      if (!child.ignoreSignals) child.exit(0, signal);
      return true;
    };

    // Dipanggil tes untuk mensimulasikan kematian: baik yang diminta maupun crash.
    child.exit = (code = 0, signal = null) => {
      if (!alive.has(pid)) return false;
      alive.delete(pid);
      child.emit("exit", code, signal);
      return true;
    };

    // Dipanggil tes untuk mensimulasikan satu baris stdout dari child.
    child.say = (line) => {
      child.stdout.emit("data", line + "\n");
    };
    child.sayErr = (line) => {
      child.stderr.emit("data", line + "\n");
    };

    alive.add(pid);
    spawned.push(child);
    if (typeof onSpawn === "function") onSpawn(child);
    return child;
  }

  return {
    spawn,
    spawned,
    alive,
    pidAlive: (pid) => alive.has(pid),
    // Jumlah proses yang masih hidup. Inilah angka yang dipakai tes untuk
    // membuktikan "zero orphan", bukan state yang dilaporkan Controller sendiri.
    liveCount: () => alive.size,
    byScript: (needle) => spawned.filter((c) => c.script.includes(needle)),
    countByScript: (needle) => spawned.filter((c) => c.script.includes(needle)).length,
    liveByScript: (needle) => spawned.filter((c) => c.script.includes(needle) && alive.has(c.pid)),
  };
}

// --- fs palsu ----------------------------------------------------------------

// Cukup untuk config-manager: readFileSync, writeFileSync, renameSync, unlinkSync.
// Penulisan dan rename dicatat supaya tes bisa membuktikan tulis atomik benar-benar
// lewat berkas sementara, bukan langsung ke sasaran.
function createFakeFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const writes = [];
  const renames = [];
  return {
    files,
    writes,
    renames,
    readFileSync(p) {
      if (!files.has(p)) {
        const err = new Error("ENOENT: " + p);
        err.code = "ENOENT";
        throw err;
      }
      return files.get(p);
    },
    writeFileSync(p, data) {
      if (this.failWrites) {
        const err = new Error("EACCES");
        err.code = "EACCES";
        throw err;
      }
      files.set(p, String(data));
      writes.push(p);
    },
    renameSync(from, to) {
      if (this.failRenames) {
        const err = new Error("EPERM");
        err.code = "EPERM";
        throw err;
      }
      if (!files.has(from)) {
        const err = new Error("ENOENT: " + from);
        err.code = "ENOENT";
        throw err;
      }
      files.set(to, files.get(from));
      files.delete(from);
      renames.push([from, to]);
    },
    unlinkSync(p) {
      files.delete(p);
    },
    mkdirSync() {},
    failWrites: false,
    failRenames: false,
  };
}

// --- config contoh yang valid ------------------------------------------------

// Config minimum yang LULUS validasi dan lulus preflight. Dipakai sebagai titik
// awal; tes yang ingin menguji kegagalan merusaknya satu field saja, supaya yang
// diuji benar-benar field itu.
function goodConfig(overrides = {}) {
  const base = {
    version: 1,
    tiktok: { username: "agen_mulia_abadi" },
    obs: { host: "127.0.0.1", port: 4455, password: "rahasia-obs" },
    settings: {
      autopinEnabled: true,
      autopinPort: 5055,
      autopinTimeoutMs: 15000,
      autoCommentEnabled: false,
      autoCommentTransport: "dry-run",
      autoCommentMaxPerMinute: 6,
      autoCommentMinIntervalMs: 5000,
      autoCommentTimeoutMs: 8000,
      sceneReplayCooldownMs: 120000,
      expectedShop: "toko uji",
      forbiddenShops: ["garudafood"],
      consoleUrl: "https://shop.tiktok.com/streamer/live/product/dashboard",
      profileDir: ".autopin-profile",
      debugDir: ".autopin-debug",
      chromePath: "",
    },
    mappings: [
      { scene: "PAX-1", product: { title: "Garuda Ting Ting" }, triggers: ["spill etalase 1"], reply: "Etalase 1 sudah aku pin ya kak" },
      { scene: "PAX-2", product: { title: "Gery Potato" } },
    ],
  };
  return Object.assign({}, base, overrides);
}

// Semua probe preflight yang HIJAU, tanpa menyentuh apa pun yang nyata.
// Scene OBS dibuat cocok dengan mapping di goodConfig().
function passingPreflightDeps(overrides = {}) {
  return Object.assign(
    {
      portFree: async () => true,
      probeObs: async () => ({ ok: true, scenes: ["MAIN", "PAX-1", "PAX-2", "PAX-3"] }),
      checkProfileDir: async () => ({ ok: true }),
      probeTikTok: async () => ({ ok: true, skipped: true, reason: "not-implemented-p1" }),
      listOrphans: async () => ({ count: 0 }),
    },
    overrides
  );
}

const CONFIG_PATH = "/fake/data/config.json";

// Rakitan standar: Controller lengkap dengan dunia palsu, jam virtual, fs palsu,
// dan preflight hijau. Tes mengubah apa yang perlu diubah lewat `overrides`.
function createHarness(overrides = {}) {
  const clock = createClock();
  // Bot sungguhan mencetak [TIKTOK_CONNECTED] sendiri begitu tersambung. Di sini
  // itu ditirukan satu tick sesudah spawn, supaya jalur bahagia tidak perlu
  // mengatur waktu secara manual. Tes yang menguji kegagalan readiness mematikan
  // ini dengan autoBotConnected: false.
  const world = createFakeWorld({
    dieOnSignal: overrides.dieOnSignal !== false,
    onSpawn:
      overrides.autoBotConnected === false
        ? null
        : (child) => {
            if (!child.script.includes("index.js")) return;
            setImmediate(() => {
              if (world.alive.has(child.pid)) sayBotConnected(child);
            });
          },
  });
  const fs = createFakeFs(
    overrides.configText === null
      ? {}
      : { [CONFIG_PATH]: overrides.configText || JSON.stringify(overrides.config || goodConfig(), null, 2) }
  );

  const chromeKills = [];
  const sweeps = [];
  const logs = [];

  const { createController } = require("../../controller/controller");

  const controller = createController({
    cwd: "/fake",
    configFile: CONFIG_PATH,
    fs,
    spawn: world.spawn,
    nodePath: "/fake/node",
    pidAlive: world.pidAlive,
    now: clock.now,
    sleep: clock.sleep,
    logger: { log: (line) => logs.push(line) },
    // Grace pendek: tes force-kill tidak perlu menunggu 8 detik nyata.
    stopGraceMs: overrides.stopGraceMs === undefined ? 20 : overrides.stopGraceMs,
    preflightDeps: passingPreflightDeps(overrides.preflightDeps || {}),
    fetchHealth: overrides.fetchHealth || (async () => ({ ok: true, body: { ok: true } })),
    timeouts: Object.assign({ serviceHealthMs: 5000, botReadyMs: 5000, healthPollMs: 100 }, overrides.timeouts),
    killAutomationChrome:
      overrides.killAutomationChrome === null
        ? null
        : overrides.killAutomationChrome ||
          (async () => {
            chromeKills.push(1);
            return { killed: 0 };
          }),
    orphanSweeper:
      overrides.orphanSweeper === null
        ? null
        : overrides.orphanSweeper ||
          (async (arg) => {
            sweeps.push(arg);
            return { count: 0, killed: 0, remaining: 0 };
          }),
    activityMax: overrides.activityMax,
    serviceArgs: overrides.serviceArgs,
    botArgs: overrides.botArgs,
  });

  return { controller, world, clock, fs, logs, chromeKills, sweeps, CONFIG_PATH, goodConfig };
}

// Setelah bot di-spawn, bot sungguhan mencetak baris ini saat tersambung ke room
// LIVE (index.js:1191). Controller menunggu baris itu sebagai tanda siap, jadi tes
// harus mengucapkannya — bukan Controller yang menebak.
function sayBotConnected(child, roomId = "7300000000000000000") {
  child.say("[TIKTOK_CONNECTED] roomId=" + roomId);
}

module.exports = {
  createClock,
  createFakeWorld,
  createFakeFs,
  createHarness,
  goodConfig,
  passingPreflightDeps,
  sayBotConnected,
  CONFIG_PATH,
};
