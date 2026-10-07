"use strict";
// Otak Controller: menyatukan state machine, process manager, config, preflight,
// dan activity feed menjadi dua operasi yang bisa dipercaya — startAutomation()
// dan stopAutomation().
//
// Keduanya TRANSAKSIONAL. Artinya satu hal yang sangat spesifik: kalau start
// gagal di tahap mana pun, tidak boleh ada proses anak yang tertinggal hidup.
// Inilah kegagalan yang paling mahal di sistem ini, dan sudah terjadi: pada
// 2026-10-05 tiga bot hidup bersamaan tanpa ada yang tahu, dan salah satunya
// membatalkan pin yang baru diumumkan ke penonton lewat chat.
//
// Aturan yang dipegang:
//
//   - Satu start pada satu waktu. Penolakannya SINKRON, sebelum await pertama,
//     supaya dua POST /api/start yang datang bersamaan tidak pernah bisa
//     berselip di antara pemeriksaan dan penyalaan.
//   - Rollback membalik urutan start, dan selalu dijalankan sampai habis.
//   - Kematian dibuktikan, tidak diasumsikan (lihat process-manager.js).
//   - Kalau cleanup TIDAK bisa membuktikan semuanya mati, Controller tetap di
//     ERROR dan mengatakannya. Ia tidak pernah melaporkan bersih saat tidak.

const path = require("node:path");
const fsDefault = require("node:fs");
const { createStateMachine, STATES } = require("./state-machine");
const { createProcessManager } = require("./process-manager");
const { createConfigManager, toEnv, unmappedFields, validateConfig } = require("./config-manager");
const { createPreflight, firstFailure } = require("./preflight");
const { createActivityFeed } = require("./activity");
const { translate } = require("./errors");
const { validateMappings } = require("./mapping-validator");
const {
  buildRuntimeConfig,
  writeRuntimeConfig,
  removeRuntimeConfig,
  RUNTIME_CONFIG_ENV,
} = require("../runtime/runtime-config");

// Batas tunggu per tahap start. Dipisah per tahap, bukan satu batas besar, supaya
// kegagalan bisa menyebut tahap mana yang kehabisan waktu.
const DEFAULT_TIMEOUTS = Object.freeze({
  // Service membuka browser dan memanaskan halaman produk saat start (~8-10 detik
  // menurut komentar di autopin/service.js), jadi batasnya harus di atas itu.
  serviceHealthMs: 45000,
  // Bot menyambung ke TikTok LIVE. Kalau LIVE belum on air, konektor akan
  // mencoba ulang dengan backoff sampai 30 detik, jadi menunggu lebih lama dari
  // ini hanya menunda kabar buruk yang sudah pasti.
  botReadyMs: 60000,
  healthPollMs: 500,
});

// Baris yang menandai bot benar-benar siap: ia sudah tersambung ke room LIVE.
// Diambil dari index.js:1191 yang mencetak `[TIKTOK_CONNECTED] roomId=...`.
// RECONNECTED ikut dihitung karena artinya sama-sama "tersambung sekarang".
const BOT_READY_TYPES = Object.freeze(["TIKTOK_CONNECTED", "TIKTOK_RECONNECTED"]);

function defaultFetchHealth({ port, timeoutMs = 2000 }) {
  const doFetch = globalThis.fetch;
  if (typeof doFetch !== "function") return Promise.resolve({ ok: false, reason: "fetch-unavailable" });
  const controller = new AbortController();
  const abort = setTimeout(() => controller.abort(), timeoutMs);
  return doFetch("http://127.0.0.1:" + port + "/health", { signal: controller.signal })
    .then(async (res) => {
      if (!res.ok) return { ok: false, reason: "http-" + res.status };
      try {
        return { ok: true, body: await res.json() };
      } catch {
        return { ok: true, body: null };
      }
    })
    .catch(() => ({ ok: false, reason: "unreachable" }))
    .finally(() => clearTimeout(abort));
}

function createController({
  cwd = process.cwd(),
  configFile = null,
  fs = undefined,
  spawn = undefined,
  nodePath = undefined,
  pidAlive = undefined,
  // Probe preflight; semuanya di-inject oleh tes supaya tidak ada jaringan,
  // tidak ada OBS, tidak ada browser.
  preflightDeps = {},
  fetchHealth = defaultFetchHealth,
  timeouts = {},
  activityMax = 500,
  killAutomationChrome = null,
  orphanSweeper = null,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  logger = null,
  // Batas tunggu terminasi sopan sebelum dipaksa. Default-nya ditentukan per
  // peran di process-manager.js; di sini hanya untuk tes yang perlu deterministik.
  stopGraceMs = undefined,
  // Argumen tambahan untuk child. Tidak pernah berasal dari config: flag yang
  // mengizinkan aksi nyata ke akun TikTok hanya boleh dari baris perintah
  // operator, persis seperti sebelum Controller ada.
  serviceArgs = [],
  botArgs = [],
  // P2: adapter discovery. Keduanya di-inject; tanpa injeksi Controller tidak
  // membuka socket OBS maupun browser, dan itulah yang membuat tes tetap offline.
  obsDiscovery = null,
  tiktokDiscovery = null,
  // Scene yang punya detail pemutaran di RULES. Disuplai entry point dari
  // index.js supaya Controller tidak perlu meng-require index.js (yang akan
  // menyeret dotenv, OBSWebSocket, dan kedua dispatcher ke proses ini).
  playableScenes = null,
  // Direktori artefak config runtime. Satu berkas per run Controller.
  runtimeDir = null,
} = {}) {
  const budget = Object.assign({}, DEFAULT_TIMEOUTS, timeouts);
  const fsImpl = fs || fsDefault;
  const configPath = configFile || path.join(cwd, "data", "config.json");
  const runtimeRoot = runtimeDir || path.join(cwd, "data", ".runtime");

  const activity = createActivityFeed({ max: activityMax });

  // Log Controller sendiri. Formatnya mengikuti kebiasaan repo:
  // [CONTROLLER_<TAG>] key=value. Child punya log-nya sendiri, tidak diubah.
  function log(tag, fields = {}) {
    const parts = Object.entries(fields)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => {
        const s = String(v);
        return k + "=" + (/[\s"]/.test(s) ? JSON.stringify(s) : s);
      });
    const line = ["[CONTROLLER_" + tag + "]"].concat(parts).join(" ");
    if (logger && typeof logger.log === "function") logger.log(line);
    else console.log(line);
  }

  const sm = createStateMachine({
    now,
    onTransition: ({ from, to }) => {
      log("STATE", { from, to });
      activity.push({ type: "STATE", message: "Status: " + to, from, to });
    },
  });

  const configManager = createConfigManager({ file: configPath, fs });

  // Readiness bot dideteksi dari baris log-nya, bukan dengan bertanya ke TikTok.
  // Satu-satunya pihak yang tahu bot sudah tersambung adalah bot itu sendiri.
  let botReadyResolve = null;
  let botReady = false;

  function noteBotReady() {
    botReady = true;
    if (botReadyResolve) {
      const r = botReadyResolve;
      botReadyResolve = null;
      r(true);
    }
  }

  const pm = createProcessManager({
    cwd,
    spawn,
    nodePath,
    pidAlive,
    now,
    log,
    sleep,
    killAutomationChrome,
    orphanSweeper,
    onLine: ({ line, at }) => {
      const ev = activity.ingest({ line, at: at ? new Date(at).toISOString() : undefined });
      if (ev && BOT_READY_TYPES.includes(ev.type)) noteBotReady();
    },
    onExit: ({ role, code, signal, expected }) => {
      if (expected) return; // kematian yang kita minta; bukan kejadian.
      handleUnexpectedExit({ role, code, signal });
    },
  });

  // Probe preflight yang memakai adapter discovery sungguhan kalau ada. Kalau
  // tidak ada, preflight memakai default-nya sendiri — dan di tes selalu di-inject.
  const discoveryProbes = {};
  if (obsDiscovery) {
    discoveryProbes.probeObs = async ({ host, port, password }) => {
      const r = await obsDiscovery.listScenes({ host, port, password });
      return r.ok ? { ok: true, scenes: r.scenes } : { ok: false, reason: r.reason };
    };
  }
  if (tiktokDiscovery) {
    discoveryProbes.probeTikTok = async ({ config }) => {
      // Discovery TikTok memakai profil Chrome yang SAMA dengan service. Saat
      // automation berjalan, service yang memegang profil itu — lihat catatan di
      // controller/discovery/tiktok.js. Preflight dijalankan sebelum anak
      // dinyalakan, jadi di jalur Start profil memang bebas.
      const r = await tiktokDiscovery.products(config);
      if (!r.ok) return { ok: false, reason: r.reason };
      return {
        ok: true,
        products: r.products,
        productCount: r.count,
        live: r.livePinControlsAvailable === true,
      };
    };
  }

  const preflight = createPreflight(
    Object.assign(
      {
        cwd,
        validateConfig,
        playableScenes,
        listOrphans: orphanSweeper
          ? async () => {
              // Penyapu yang sama dipakai untuk MENGHITUNG saja di preflight.
              const r = await orphanSweeper({ ownPids: new Set(), dryRun: true });
              return { count: r && Number.isInteger(r.count) ? r.count : 0 };
            }
          : null,
      },
      discoveryProbes,
      preflightDeps
    )
  );

  // Hasil preflight terakhir, supaya /api/status bisa menjelaskan kenapa start
  // ditolak tanpa customer harus menjalankan preflight lagi.
  let lastPreflight = null;
  let lastError = null;
  // Artefak config runtime untuk run yang SEDANG berjalan. Satu per run, dibuat
  // saat Start dan dihapus saat Stop.
  let runtimeArtifact = null;
  // Config yang disimpan SESUDAH automation menyala. P2 sengaja tidak menerapkan
  // perubahan panas: ia memberi tahu bahwa restart dibutuhkan, dan snapshot yang
  // sedang dipakai tidak disentuh. Pemutaran yang sedang berjalan tidak boleh
  // berpindah trigger di tengah jalan.
  let configChangedWhileRunning = false;
  // Dinaikkan saat stop dimulai: start yang sedang berjalan memeriksanya di setiap
  // tahap dan membatalkan diri, jadi stop tidak pernah berlomba dengan start.
  let stopRequested = false;
  let inFlightStop = null;

  // --- artefak config runtime ------------------------------------------------

  // Membangun dan menulis artefak. Tulisnya atomik (lihat
  // runtime/runtime-config.js), jadi tidak ada jendela di mana anak bisa membaca
  // berkas yang baru separuh tertulis dan mulai LIVE dengan pemetaan tak lengkap.
  function createRuntimeArtifact(config) {
    const payload = buildRuntimeConfig({
      mappings: config.mappings,
      configVersion: config.version,
    });
    const file = path.join(runtimeRoot, "runtime-" + payload.id + ".json");
    try {
      fsImpl.mkdirSync(runtimeRoot, { recursive: true });
    } catch {
      return { ok: false, code: "runtime-config-write-failed", detail: "mkdir " + runtimeRoot };
    }
    const written = writeRuntimeConfig(file, payload, { fs: fsImpl });
    if (!written.ok) {
      return { ok: false, code: "runtime-config-write-failed", detail: written.reason };
    }
    return { ok: true, file, id: payload.id, configVersion: config.version };
  }

  // Dihapus saat Stop: artefak hanya berlaku untuk satu run. Membiarkannya berarti
  // run berikutnya bisa menemukan berkas lama dan tidak ada yang tahu generasi
  // mana yang sedang dipakai.
  function discardRuntimeArtifact() {
    if (!runtimeArtifact) return;
    removeRuntimeConfig(runtimeArtifact.file, { fs: fsImpl });
    runtimeArtifact = null;
  }

  // --- reaksi terhadap kematian yang tidak diminta ---------------------------

  function handleUnexpectedExit({ role, code, signal }) {
    const state = sm.state();
    log("CHILD_CRASHED", { role, code: code === null ? "null" : code, signal: signal || "", state });
    activity.push({
      type: role === "bot" ? "BOT_CRASHED" : "SERVICE_CRASHED",
      message: (role === "bot" ? "The bot" : "The pin service") + " stopped unexpectedly",
      reason: signal ? "signal-" + signal : "exit-" + code,
    });

    // Selama STARTING, kematian ditangani oleh jalur start itu sendiri (ia yang
    // memegang rollback). Menyentuh state dari sini akan berlomba dengannya.
    if (state === STATES.STARTING || state === STATES.STOPPING) return;

    if (state === STATES.RUNNING || state === STATES.DEGRADED) {
      const ps = pm.getProcessState();
      const anyAlive = ps.service.running || ps.bot.running;
      // DEGRADED = masih jalan tapi tidak utuh. ERROR = tidak ada lagi yang jalan,
      // padahal tidak ada yang meminta berhenti. Perbedaannya penting: DEGRADED
      // masih bisa dihentikan secara normal, ERROR butuh cleanup.
      sm.to(anyAlive ? STATES.DEGRADED : STATES.ERROR, { reason: role + "-crashed" });
      lastError = translate(role === "bot" ? "bot-exited-early" : "service-exited-early");
    }
  }

  // --- menunggu kesiapan ----------------------------------------------------

  // Service dianggap siap hanya kalau /health benar-benar menjawab. Proses yang
  // hidup BUKAN bukti siap: ia bisa hidup sambil gagal mengikat port, dan bot
  // yang start di atas asumsi itu akan menembak port yang tidak mendengarkan.
  async function waitServiceHealthy(port) {
    const deadline = now() + budget.serviceHealthMs;
    while (now() < deadline) {
      if (stopRequested) return { ok: false, code: "stop-requested" };
      // Service yang mati saat ditunggu tidak akan pernah sehat. Jangan habiskan
      // batas waktu untuk sesuatu yang sudah pasti.
      if (!pm.getProcessState().service.running) return { ok: false, code: "service-exited-early" };
      const r = await fetchHealth({ port });
      if (r && r.ok) return { ok: true, health: r.body || null };
      await sleep(budget.healthPollMs);
    }
    return { ok: false, code: "service-health-timeout" };
  }

  async function waitBotReady() {
    if (botReady) return { ok: true };
    const deadline = now() + budget.botReadyMs;
    // Dipantau lewat polling walau sinyalnya datang dari event: dengan begitu
    // kematian bot dan permintaan stop ikut diperiksa di setiap putaran.
    while (now() < deadline) {
      if (botReady) return { ok: true };
      if (stopRequested) return { ok: false, code: "stop-requested" };
      if (!pm.getProcessState().bot.running) return { ok: false, code: "bot-exited-early" };
      await sleep(budget.healthPollMs);
    }
    return botReady ? { ok: true } : { ok: false, code: "bot-ready-timeout" };
  }

  // --- rollback -------------------------------------------------------------

  // Dijalankan untuk SETIAP kegagalan start sesudah ada yang mungkin hidup.
  // Urutannya kebalikan dari start, dan tidak pernah berhenti di tengah: setiap
  // tahap dicoba walau tahap sebelumnya gagal.
  async function rollback(code, detail) {
    sm.to(STATES.ERROR, { reason: code });
    log("START_ROLLBACK", { code });

    const result = await pm.stopAll({ graceMs: stopGraceMs });

    const ps = pm.getProcessState();
    const orphans = [];
    if (ps.service.running) orphans.push({ role: "service", pid: ps.service.pid });
    if (ps.bot.running) orphans.push({ role: "bot", pid: ps.bot.pid });

    if (orphans.length > 0) {
      // Tidak bisa dibuktikan mati. Controller TETAP di ERROR dan mengatakannya;
      // ia tidak pernah melaporkan bersih saat tidak bersih.
      log("START_ROLLBACK_INCOMPLETE", { orphans: orphans.map((o) => o.role + ":" + o.pid).join(",") });
      lastError = Object.assign(translate(code, { detail }), { orphans });
      return { ok: false, state: sm.state(), error: lastError };
    }

    // Artefak config runtime dibuang: run ini tidak pernah jadi, jadi generasinya
    // tidak boleh tertinggal di disk untuk membingungkan run berikutnya.
    discardRuntimeArtifact();
    sm.to(STATES.STOPPED, { reason: "rollback-complete" });
    log("START_ROLLBACK_DONE", { chrome: result.chrome && result.chrome.killed ? result.chrome.killed : 0 });
    lastError = translate(code, { detail });
    return { ok: false, state: sm.state(), error: lastError };
  }

  // --- start ----------------------------------------------------------------

  async function startAutomation() {
    // Penolakan SINKRON. Tidak ada await di atas titik ini, jadi dua permintaan
    // bersamaan tidak mungkin keduanya lolos.
    if (sm.isBusyForStart()) {
      const code = "start-rejected-busy";
      log("START_REFUSED", { state: sm.state(), code });
      return { ok: false, state: sm.state(), error: translate(code, { detail: "state=" + sm.state() }) };
    }
    if (inFlightStop) {
      return { ok: false, state: sm.state(), error: translate("start-rejected-busy", { detail: "stop-in-progress" }) };
    }

    const entered = sm.to(STATES.PREFLIGHT, { reason: "start-requested" });
    if (!entered.ok) {
      return { ok: false, state: sm.state(), error: translate("start-rejected-busy", { detail: entered.reason }) };
    }

    stopRequested = false;
    botReady = false;
    lastError = null;

    // --- config -------------------------------------------------------------
    const loaded = configManager.loadConfig();
    if (!loaded.ok) {
      sm.to(STATES.STOPPED, { reason: loaded.code });
      lastError = Object.assign(translate(loaded.code), { errors: loaded.errors || [] });
      log("START_REFUSED", { code: loaded.code });
      return { ok: false, state: sm.state(), error: lastError };
    }
    const config = loaded.config;

    // --- preflight ----------------------------------------------------------
    lastPreflight = await preflight.run(config);
    if (!lastPreflight.ok) {
      // NOL proses pernah dinyalakan di titik ini, jadi aman langsung ke STOPPED
      // tanpa cleanup. Tidak ada yang perlu dibersihkan karena tidak ada yang mulai.
      const fail = firstFailure(lastPreflight);
      sm.to(STATES.STOPPED, { reason: "preflight-failed" });
      lastError = Object.assign(translate(fail ? fail.reason : "preflight-failed"), {
        check: fail ? fail.check : null,
      });
      log("PREFLIGHT_FAILED", { check: fail && fail.check, reason: fail && fail.reason });
      return { ok: false, state: sm.state(), error: lastError, preflight: lastPreflight };
    }
    log("PREFLIGHT_OK", {});

    const starting = sm.to(STATES.STARTING, { reason: "preflight-ok" });
    if (!starting.ok) {
      sm.to(STATES.STOPPED, { reason: "transition-refused" });
      return { ok: false, state: sm.state(), error: translate("start-rejected-busy", { detail: starting.reason }) };
    }

    // --- cleanup proses yatim ----------------------------------------------
    // Hanya sisa dari sesi SEBELUMNYA. Dilakukan sesudah preflight supaya
    // preflight masih bisa MELAPORKAN keberadaannya, bukan menyembunyikannya
    // dengan membereskannya lebih dulu.
    const swept = await pm.cleanupOrphans();
    if (!swept.ok) {
      return rollback("orphans-remain", "remaining=" + (swept.remaining || "?"));
    }

    // --- snapshot config runtime -------------------------------------------
    // Dibuat SEKALI, lalu dibaca oleh KEDUA anak. Setelah titik ini, menyimpan
    // config baru tidak mengubah apa pun yang sedang berjalan: berkasnya tidak
    // pernah ditulis ulang selama run.
    const artifact = createRuntimeArtifact(config);
    if (!artifact.ok) {
      return rollback(artifact.code, artifact.detail);
    }
    runtimeArtifact = artifact;
    configChangedWhileRunning = false;
    log("RUNTIME_CONFIG", { id: artifact.id, mappings: config.mappings.length });

    const env = toEnv(config, {
      base: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    });
    // SATU variabel environment yang P2 tambahkan: path ke artefak. Isinya JSON,
    // bukan daftar yang disandikan ke dalam string environment.
    env[RUNTIME_CONFIG_ENV] = artifact.file;

    // --- service ------------------------------------------------------------
    const svc = pm.startService({ env, args: serviceArgs });
    if (!svc.ok) {
      return rollback(svc.code, "service spawn");
    }

    const healthy = await waitServiceHealthy(config.settings.autopinPort);
    if (healthy.ok) {
      // Service melaporkan generasi yang IA baca. Kalau berbeda dari yang baru
      // kita tulis, salah satu sisi memakai pemetaan basi — dan itu tidak boleh
      // dibiarkan jalan: ia akan memin produk yang benar untuk scene yang salah,
      // dan tidak ada yang terlihat aneh sampai penonton melihatnya.
      const reported = healthy.health && healthy.health.runtimeConfigId;
      if (reported && reported !== artifact.id) {
        return rollback("runtime-config-generation-mismatch", "service=" + reported + " controller=" + artifact.id);
      }
    }
    if (!healthy.ok) {
      // Service hidup tapi tidak sehat tetap WAJIB dimatikan. Inilah tahap yang
      // kalau dilewati akan meninggalkan service yatim yang memegang port 5055 —
      // dan start berikutnya akan gagal dengan sebab yang menyesatkan.
      return rollback(healthy.code, "service health");
    }
    log("SERVICE_READY", { port: config.settings.autopinPort });

    // --- bot ----------------------------------------------------------------
    const bot = pm.startBot({ env, args: botArgs });
    if (!bot.ok) {
      return rollback(bot.code, "bot spawn");
    }

    const ready = await waitBotReady();
    if (!ready.ok) {
      return rollback(ready.code, "bot readiness");
    }
    log("BOT_READY", {});

    const running = sm.to(STATES.RUNNING, { reason: "all-ready" });
    if (!running.ok) {
      // Satu-satunya cara sampai sini adalah stop yang datang tepat di celah ini.
      return rollback("start-rejected-busy", "transition-refused:" + running.reason);
    }

    const ps = pm.getProcessState();
    log("STARTED", { servicePid: ps.service.pid, botPid: ps.bot.pid });
    return { ok: true, state: sm.state(), service: ps.service, bot: ps.bot };
  }

  // --- stop -----------------------------------------------------------------

  // Aman dipanggil kapan saja: bot sudah mati, service sudah mati, start gagal
  // separuh jalan, atau Controller sedang DEGRADED/ERROR. Dua stop berurutan
  // tidak pernah berbuat dua kali.
  async function stopAutomation() {
    // Stop yang sedang berjalan dipakai ulang, bukan dijalankan dua kali. Dua
    // stopAll() yang berjalan bersamaan akan saling membuktikan kematian proses
    // yang sudah dimatikan pihak lain, dan salah satunya akan salah melapor.
    if (inFlightStop) return inFlightStop;

    stopRequested = true;
    const ps0 = pm.getProcessState();
    const nothingAlive = !ps0.service.running && !ps0.bot.running;

    if (sm.state() === STATES.STOPPED && nothingAlive) {
      // Idempoten, dan sengaja TIDAK melakukan transisi ke dirinya sendiri.
      return { ok: true, state: STATES.STOPPED, code: "already-stopped" };
    }

    inFlightStop = (async () => {
      try {
        const moved = sm.to(STATES.STOPPING, { reason: "stop-requested" });
        if (!moved.ok) {
          // State yang tidak punya jalan ke STOPPING (hanya STOPPED, dan hanya
          // kalau masih ada child yang hidup — sisa yang tidak kita duga).
          // Bersihkan tetap, karena child yang hidup lebih penting daripada
          // kerapian state.
          log("STOP_FROM_UNEXPECTED_STATE", { state: sm.state() });
        }

        const result = await pm.stopAll({ graceMs: stopGraceMs });

        const ps = pm.getProcessState();
        const orphans = [];
        if (ps.service.running) orphans.push({ role: "service", pid: ps.service.pid });
        if (ps.bot.running) orphans.push({ role: "bot", pid: ps.bot.pid });

        if (orphans.length > 0) {
          sm.to(STATES.ERROR, { reason: "stop-incomplete" });
          lastError = Object.assign(
            translate(ps.bot.running ? "bot-did-not-die" : "service-did-not-die"),
            { orphans }
          );
          log("STOP_INCOMPLETE", { orphans: orphans.map((o) => o.role + ":" + o.pid).join(",") });
          return { ok: false, state: sm.state(), error: lastError };
        }

        if (sm.state() !== STATES.STOPPED) sm.to(STATES.STOPPED, { reason: "stop-complete" });
        // Artefak hanya berlaku untuk satu run. Dihapus di sini supaya run
        // berikutnya tidak bisa menemukan berkas lama dan membuat generasi mana
        // yang sedang dipakai jadi pertanyaan.
        discardRuntimeArtifact();
        configChangedWhileRunning = false;
        botReady = false;
        lastError = null;
        log("STOPPED", { chrome: result.chrome && result.chrome.killed ? result.chrome.killed : 0 });
        return { ok: true, state: sm.state(), code: "stopped" };
      } finally {
        inFlightStop = null;
        stopRequested = false;
      }
    })();

    return inFlightStop;
  }

  // --- status ---------------------------------------------------------------

  // Bentuk yang keluar lewat /api/status. TIDAK PERNAH memuat password OBS,
  // cookie, token, data sesi browser, atau environment mentah — satu-satunya
  // nilai dari config yang ikut adalah yang sudah terlihat oleh penonton
  // (username TikTok) atau yang bukan rahasia (jumlah pemetaan).
  function status() {
    const ps = pm.getProcessState();
    const state = sm.state();
    const out = {
      controller: "RUNNING", // proses Controller sendiri; ia yang menjawab ini.
      automation: state,
      service: { running: ps.service.running, pid: ps.service.pid },
      bot: { running: ps.bot.running, pid: ps.bot.pid },
      activity: { count: activity.size(), dropped: activity.dropped(), max: activity.max, lastId: activity.lastId() },
      // P2: metadata generasi config runtime. AMAN untuk ditampilkan — ia hash
      // dari pemetaan, bukan isinya, dan tidak pernah memuat rahasia. Path
      // artefaknya SENGAJA tidak diekspos: ia path di disk milik mesin operator.
      runtimeConfigId: runtimeArtifact ? runtimeArtifact.id : null,
      // Versi skema config customer. Di tingkat atas, bukan hanya di dalam
      // `config`, supaya UI bisa memeriksa kecocokan versi tanpa harus ikut
      // membaca ringkasan config.
      configVersion: runtimeArtifact ? runtimeArtifact.configVersion : null,
      // Config disimpan sesudah automation menyala. Perubahan tidak diterapkan
      // panas; snapshot yang sedang dipakai tetap berlaku sampai restart.
      restartRequired: configChangedWhileRunning,
    };
    if (ps.service.startedAt) out.service.startedAt = ps.service.startedAt;
    if (ps.bot.startedAt) out.bot.startedAt = ps.bot.startedAt;
    if (lastError) out.lastError = lastError;
    if (lastPreflight) out.preflight = { ok: lastPreflight.ok, checks: lastPreflight.checks };

    const loaded = configManager.loadConfig();
    if (loaded.ok) {
      out.config = {
        present: true,
        version: loaded.config.version,
        mappings: loaded.config.mappings.length,
        tiktokUsername: loaded.config.tiktok.username || null,
        autopinEnabled: loaded.config.settings.autopinEnabled,
        autoCommentEnabled: loaded.config.settings.autoCommentEnabled,
        autoCommentTransport: loaded.config.settings.autoCommentTransport,
        // Keterbatasan dibuat terlihat, bukan disembunyikan: field ini tersimpan
        // tapi belum sampai ke core.
        notAppliedToCore: unmappedFields(loaded.config),
      };
    } else {
      out.config = { present: false, problem: loaded.code };
    }

    return out;
  }

  // --- P2: discovery dan validasi pemetaan ----------------------------------

  // Automation yang berjalan berarti service memegang profil Chrome. Discovery
  // TikTok TIDAK boleh memaksa membuka browser kedua dengan profil yang sama:
  // yang terjadi bukan error yang rapi, tapi risiko merusak sesi login yang
  // sedang dipakai service untuk memin produk sungguhan di tengah LIVE.
  function profileBusy() {
    const ps = pm.getProcessState();
    return ps.service.running === true;
  }

  async function discoverObsScenes() {
    if (!obsDiscovery) return { ok: false, connected: false, error: translate("discovery-not-configured") };
    const loaded = configManager.loadConfig();
    if (!loaded.ok) return { ok: false, connected: false, error: translate(loaded.code) };
    const r = await obsDiscovery.listScenes({
      host: loaded.config.obs.host,
      port: loaded.config.obs.port,
      password: loaded.config.obs.password,
    });
    if (!r.ok) return { ok: false, connected: r.connected === true, error: translate(r.reason) };
    return { ok: true, connected: true, scenes: r.scenes };
  }

  async function discoverTikTokStatus() {
    if (!tiktokDiscovery) return { ok: false, error: translate("discovery-not-configured") };
    if (profileBusy()) return { ok: false, error: translate("discovery-unavailable-while-running") };
    const loaded = configManager.loadConfig();
    if (!loaded.ok) return { ok: false, error: translate(loaded.code) };
    const r = await tiktokDiscovery.status(loaded.config);
    if (!r.ok) return { ok: false, error: translate(r.reason || r.identityReason || "tiktok-check-failed") };
    return {
      ok: true,
      identity: r.identity,
      identityOk: r.identityOk,
      live: r.live,
      dashboardReady: r.dashboardReady,
      chatReady: r.chatReady,
      productCount: r.productCount,
    };
  }

  async function discoverTikTokProducts() {
    if (!tiktokDiscovery) return { ok: false, error: translate("discovery-not-configured") };
    if (profileBusy()) return { ok: false, error: translate("discovery-unavailable-while-running") };
    const loaded = configManager.loadConfig();
    if (!loaded.ok) return { ok: false, error: translate(loaded.code) };
    const r = await tiktokDiscovery.products(loaded.config);
    if (!r.ok) return { ok: false, error: translate(r.reason), count: r.count || 0, products: [] };
    return {
      ok: true,
      count: r.count,
      products: r.products,
      livePinControlsAvailable: r.livePinControlsAvailable === true,
    };
  }

  // Validasi pemetaan terhadap dunia nyata. Discovery dijalankan kalau tersedia;
  // bagian yang datanya tidak ada DILEWATI oleh validator, bukan dianggap lolos.
  async function validateMappingsNow() {
    const loaded = configManager.loadConfig();
    if (!loaded.ok) return { ok: false, error: translate(loaded.code), mappings: [] };
    const config = loaded.config;

    let obsScenes = null;
    if (obsDiscovery) {
      const r = await obsDiscovery.listScenes({
        host: config.obs.host,
        port: config.obs.port,
        password: config.obs.password,
      });
      if (r.ok) obsScenes = r.scenes;
    }

    let products = null;
    if (tiktokDiscovery && !profileBusy()) {
      const r = await tiktokDiscovery.products(config);
      if (r.ok) products = r.products;
    }

    const verdict = validateMappings({
      mappings: config.mappings,
      obsScenes,
      products,
      autoCommentEnabled: config.settings.autoCommentEnabled === true,
      playableScenes,
    });

    return {
      ok: verdict.ok,
      // Apa yang BENAR-BENAR diperiksa, supaya "ok" tidak terbaca lebih kuat dari
      // yang sebenarnya. Pemetaan yang lolos tanpa katalog hanya berarti belum
      // ada yang membantahnya.
      checked: { obsScenes: Array.isArray(obsScenes), products: Array.isArray(products) },
      mappings: verdict.mappings,
      ...(verdict.reason ? { error: translate(verdict.reason) } : {}),
    };
  }

  // Dipanggil server sesudah config disimpan. Perubahan TIDAK diterapkan panas:
  // snapshot yang sedang dipakai tetap berlaku sampai restart.
  function noteConfigSaved() {
    if (sm.isBusyForStart()) {
      configChangedWhileRunning = true;
      log("CONFIG_SAVED_WHILE_RUNNING", { state: sm.state() });
      return { restartRequired: true };
    }
    return { restartRequired: false };
  }

  async function runPreflightOnly() {
    const loaded = configManager.loadConfig();
    if (!loaded.ok) {
      const checks = {};
      for (const name of preflight.CHECK_NAMES) {
        checks[name] = name === "config" ? { ok: false, reason: loaded.code } : { ok: false, reason: "skipped-config-invalid", skipped: true };
      }
      lastPreflight = { ok: false, checks };
      return lastPreflight;
    }
    lastPreflight = await preflight.run(loaded.config);
    return lastPreflight;
  }

  // Dipanggil saat proses Controller akan mati. Child TIDAK boleh hidup lebih
  // lama dari Controller: child yatim adalah bentuk persis dari insiden Phase 21.
  async function shutdown() {
    // Tag-nya dibedakan dari [CONTROLLER_SHUTDOWN] milik entry point: dua baris
    // dengan tag yang sama tapi isi berbeda membuat log sulit dibaca, dan log
    // adalah alat utama operator di repo ini.
    log("SHUTDOWN_CLEANUP", { state: sm.state() });
    return stopAutomation();
  }

  return {
    startAutomation,
    stopAutomation,
    shutdown,
    status,
    runPreflight: runPreflightOnly,
    // P2
    discoverObsScenes,
    discoverTikTokStatus,
    discoverTikTokProducts,
    validateMappings: validateMappingsNow,
    noteConfigSaved,
    runtimeConfigId: () => (runtimeArtifact ? runtimeArtifact.id : null),
    runtimeConfigFile: () => (runtimeArtifact ? runtimeArtifact.file : null),
    state: () => sm.state(),
    activity,
    config: configManager,
    processes: pm,
    __sm: sm,
    __lastPreflight: () => lastPreflight,
  };
}

module.exports = { createController, DEFAULT_TIMEOUTS, BOT_READY_TYPES };
