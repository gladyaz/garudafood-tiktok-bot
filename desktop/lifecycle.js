"use strict";
// Lifecycle aplikasi desktop. MURNI — tidak pernah meng-import Electron.
//
// Semua yang menyentuh dunia nyata di-inject: menyalakan Controller, menunggunya
// siap, meminta automation berhenti, meminta Controller berhenti, dan menyapu
// sisa. Itulah yang membuat seluruh perilaku di bawah bisa diuji tanpa pernah
// membuka jendela Electron.
//
// ---------------------------------------------------------------------------
// EMPAT TINGKAT YANG MASING-MASING MAKSIMUM SATU
//
//   aplikasi desktop  dijaga Electron single-instance lock (desktop/main.js)
//   Controller        dijaga modul ini: satu child, satu slot
//   bot               dijaga controller/process-manager.js
//   service AutoPIN   dijaga port 5055 + process-manager
//
// Tingkat-tingkat itu tidak saling menggantikan. Kunci .bot.lock tidak tahu
// apa-apa soal jendela Electron kedua, dan Electron tidak tahu apa-apa soal bot
// yatim dari sesi sebelumnya.
//
// ---------------------------------------------------------------------------
// URUTAN MATI, DAN KENAPA TIDAK BOLEH DIPOTONG
//
// Menutup jendela saat automation sedang RUNNING tidak boleh langsung mematikan
// Electron. Kalau Electron mati lebih dulu, Controller kehilangan induknya
// sementara bot dan service masih hidup, memegang profil Chrome, dan masih
// mengklik produk di akun sungguhan. Tidak ada lagi yang akan membereskannya.
//
// Jadi: automation berhenti dulu, lalu Controller, lalu Electron. Masing-masing
// dengan batas waktu, dan sisanya DIBUKTIKAN — bukan diasumsikan.

const STATE = Object.freeze({
  IDLE: "idle",
  STARTING: "starting",
  READY: "ready",
  STOPPING: "stopping",
  STOPPED: "stopped",
  FAILED: "failed",
});

const DEFAULT_TIMEOUTS = Object.freeze({
  // Controller memuat express + modul Controller; ia tidak membuka browser,
  // jadi ini cukup longgar tanpa perlu puluhan detik.
  readyMs: 20000,
  readyPollMs: 250,
  // Menghentikan automation berarti mematikan bot, service, dan Chrome
  // automation, lalu membuktikan ketiganya mati. Itu pekerjaan paling lama di
  // jalur shutdown.
  automationStopMs: 30000,
  // Controller sendiri keluar cepat begitu diminta.
  controllerExitMs: 8000,
  exitPollMs: 100,
});

// State automation yang berarti "masih ada yang hidup / sedang bergerak".
const BUSY_AUTOMATION = Object.freeze(["STARTING", "RUNNING", "DEGRADED", "STOPPING", "PREFLIGHT", "ERROR"]);

function createDesktopLifecycle({
  // () -> { pid, requestShutdown(), kill(), alive(), onExit(cb) }
  spawnController = null,
  // () -> Promise<{ ok, reason? }>  — health check Controller
  waitReady = null,
  // () -> Promise<string|null>  — state automation dari /api/status
  getAutomationState = null,
  // () -> Promise<{ ok }>  — POST /api/stop
  stopAutomation = null,
  // () -> Promise<{ ok, remaining }>  — penyapu bot/service/Chrome yatim
  cleanupOrphans = null,
  timeouts = {},
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  // Tag log di sini TIDAK memuat awalan "DESKTOP_": pemanggilnya yang
  // menambahkannya. Sebelum ini keduanya menambahkan, dan keluarannya menjadi
  // [DESKTOP_DESKTOP_STOPPING] — log adalah alat utama operator di repo ini,
  // jadi ia tidak boleh terbaca seperti kesalahan ketik.
  log = () => {},
} = {}) {
  const budget = Object.assign({}, DEFAULT_TIMEOUTS, timeouts);

  let state = STATE.IDLE;
  let child = null;
  let childExited = false;
  let lastError = null;
  let inFlightStop = null;

  function describe() {
    return {
      state,
      controllerPid: child ? child.pid : null,
      controllerRunning: !!child && !childExited,
      lastError,
    };
  }

  function configured() {
    return [spawnController, waitReady, getAutomationState, stopAutomation].every((f) => typeof f === "function");
  }

  // --- start ---------------------------------------------------------------

  async function start() {
    if (!configured()) return { ok: false, code: "desktop-not-configured" };

    // Penolakan SINKRON, sebelum await apa pun: dua start yang datang bersamaan
    // tidak boleh keduanya lolos dan menyalakan dua Controller.
    if (state === STATE.STARTING || state === STATE.READY) {
      return { ok: false, code: "controller-already-running", pid: child ? child.pid : null };
    }
    if (state === STATE.STOPPING) return { ok: false, code: "controller-stopping" };

    state = STATE.STARTING;
    lastError = null;
    childExited = false;

    try {
      child = spawnController();
    } catch (err) {
      child = null;
      state = STATE.FAILED;
      lastError = "controller-start-failed";
      log("CONTROLLER_SPAWN_FAILED", { detail: String((err && err.message) || "").slice(0, 120) });
      return { ok: false, code: "controller-start-failed" };
    }

    if (!child || typeof child.pid !== "number" || child.pid <= 0) {
      child = null;
      state = STATE.FAILED;
      lastError = "controller-start-failed";
      return { ok: false, code: "controller-start-failed" };
    }

    // Controller yang mati di tengah startup tidak boleh ditunggu sampai batas
    // waktu habis: itu menunda kabar buruk yang sudah pasti.
    if (typeof child.onExit === "function") {
      child.onExit(() => {
        childExited = true;
        log("CONTROLLER_EXITED", { pid: child ? child.pid : null, state });
        // Kematian saat READY berarti Controller crash. Dilaporkan, bukan
        // disembunyikan; jendela tidak lagi punya backend.
        if (state === STATE.READY) {
          state = STATE.FAILED;
          lastError = "controller-crashed";
        }
      });
    }

    const startedAt = now();
    const ready = await waitForReady();
    if (!ready.ok) {
      // Startup gagal WAJIB tidak meninggalkan proses tersembunyi.
      await killController("start-failed");
      state = STATE.FAILED;
      lastError = ready.code;
      // Tahap boot terakhir ikut dilaporkan: "timeout" saja tidak memberi tahu
      // apa pun, sementara "timeout di tahap listen-begin" langsung menunjuk
      // tempatnya. Lihat controller/index.js -> bootStage().
      log("CONTROLLER_NOT_READY", {
        code: ready.code,
        ms: now() - startedAt,
        stage: ready.stage || "",
      });
      return { ok: false, code: ready.code, stage: ready.stage || null };
    }

    state = STATE.READY;
    log("CONTROLLER_READY", { pid: child.pid, ms: now() - startedAt });
    return { ok: true, pid: child.pid };
  }

  // Membedakan LAMBAT dari MENGGANTUNG.
  //
  // Child yang masih hidup dan masih melaporkan tahap boot ditunggu sampai batas
  // waktunya — mesin yang dingin memang berhak lambat. Tapi child yang sudah mati
  // atau sudah mengabarkan kegagalan fatal TIDAK ditunggu: itu hanya menunda kabar
  // buruk yang sudah pasti, dan di layar customer penundaannya terasa seperti
  // aplikasi yang membeku.
  //
  // PID yang masih ada TIDAK pernah dianggap sebagai tanda sehat. Satu-satunya
  // bukti kesiapan adalah server HTTP-nya menjawab.
  const stageOf = () => (child && typeof child.bootStage === "function" ? child.bootStage() : null);

  async function waitForReady() {
    const deadline = now() + budget.readyMs;
    while (now() < deadline) {
      if (childExited) return { ok: false, code: "controller-start-failed", stage: stageOf() };
      if (child && typeof child.fatal === "function" && child.fatal()) {
        return { ok: false, code: "controller-boot-failed", stage: stageOf() };
      }
      const r = await waitReady();
      if (r && r.ok) return { ok: true };
      await sleep(budget.readyPollMs);
    }
    return { ok: false, code: "controller-start-timeout", stage: stageOf() };
  }

  // --- stop ----------------------------------------------------------------

  // Dipakai ulang kalau sudah berjalan: dua shutdown bersamaan akan saling
  // membuktikan kematian proses yang sudah dimatikan pihak lain, dan salah satunya
  // akan salah melapor.
  function stop() {
    if (inFlightStop) return inFlightStop;
    if (state === STATE.STOPPED || state === STATE.IDLE) {
      return Promise.resolve({ ok: true, code: "already-stopped" });
    }

    inFlightStop = (async () => {
      try {
        state = STATE.STOPPING;
        log("STOPPING", {});

        // 1. Automation dulu. Inilah tahap yang kalau dilewati akan meninggalkan
        //    bot dan service hidup tanpa induk, masih memegang profil Chrome,
        //    masih mengklik produk di akun sungguhan.
        const stopped = await stopAutomationFirst();

        // 2. Controller. Diminta berhenti baik-baik lewat jalur induk-anak, bukan
        //    lewat endpoint HTTP: proses yang bisa dimatikan lewat jaringan adalah
        //    permukaan yang tidak perlu ada.
        const gone = await stopControllerChild();

        // 3. Sisa dibuktikan, bukan diasumsikan.
        const swept = await sweep();

        const clean = stopped.ok && gone.ok && swept.ok;
        state = STATE.STOPPED;
        if (!clean) {
          lastError = "shutdown-incomplete";
          log("SHUTDOWN_INCOMPLETE", {
            automation: stopped.ok ? "ok" : stopped.code,
            controller: gone.ok ? "ok" : gone.code,
            remaining: swept.remaining || 0,
          });
          return {
            ok: false,
            code: "shutdown-incomplete",
            automation: stopped,
            controller: gone,
            remaining: swept.remaining || 0,
          };
        }
        log("STOPPED", {});
        return { ok: true };
      } finally {
        inFlightStop = null;
      }
    })();

    return inFlightStop;
  }

  async function stopAutomationFirst() {
    let current = null;
    try {
      current = await getAutomationState();
    } catch {
      current = null;
    }

    // Controller yang sudah mati tidak bisa ditanya; penyapu di tahap 3 yang
    // menanggungnya.
    if (current === null) return { ok: true, code: "automation-unknown" };
    if (!BUSY_AUTOMATION.includes(current)) return { ok: true, code: "already-stopped" };

    log("DESKTOP_STOPPING_AUTOMATION", { from: current });
    try {
      await stopAutomation();
    } catch {
      /* hasilnya diperiksa dari state di bawah, bukan dari lemparan ini */
    }

    const deadline = now() + budget.automationStopMs;
    while (now() < deadline) {
      let s = null;
      try {
        s = await getAutomationState();
      } catch {
        s = null;
      }
      if (s === null) return { ok: true, code: "automation-unknown" };
      if (!BUSY_AUTOMATION.includes(s)) return { ok: true };
      await sleep(budget.exitPollMs);
    }
    return { ok: false, code: "automation-stop-timeout" };
  }

  async function stopControllerChild() {
    if (!child || childExited) return { ok: true, code: "already-exited" };

    // Sopan dulu: minta Controller membereskan dirinya sendiri.
    try {
      if (typeof child.requestShutdown === "function") child.requestShutdown();
    } catch {
      /* jalur paksa di bawah yang menanggungnya */
    }

    const deadline = now() + budget.controllerExitMs;
    while (now() < deadline) {
      if (childExited || (typeof child.alive === "function" && !child.alive())) return { ok: true };
      await sleep(budget.exitPollMs);
    }

    // Baru dipaksa.
    log("CONTROLLER_FORCE_KILL", { pid: child.pid });
    const killed = await killController("exit-timeout");
    return killed.ok ? { ok: true, forced: true } : { ok: false, code: "controller-did-not-die" };
  }

  async function killController(reason) {
    if (!child) return { ok: true };
    try {
      if (typeof child.kill === "function") await child.kill();
    } catch {
      /* pembuktian di bawah yang menentukan */
    }
    const deadline = now() + budget.controllerExitMs;
    while (now() < deadline) {
      if (childExited || (typeof child.alive === "function" && !child.alive())) {
        childExited = true;
        log("CONTROLLER_KILLED", { reason: reason || "kill" });
        return { ok: true };
      }
      await sleep(budget.exitPollMs);
    }
    return { ok: false, code: "controller-did-not-die" };
  }

  async function sweep() {
    if (typeof cleanupOrphans !== "function") {
      // Jujur: tanpa penyapu, "nol sisa" tidak bisa dibuktikan. Dilaporkan
      // sebagai tidak terkonfigurasi, bukan sebagai bersih.
      return { ok: true, remaining: 0, code: "sweep-not-configured" };
    }
    try {
      const r = await cleanupOrphans();
      const remaining = r && Number.isInteger(r.remaining) ? r.remaining : 0;
      return { ok: remaining === 0, remaining };
    } catch {
      return { ok: false, remaining: -1, code: "sweep-failed" };
    }
  }

  return {
    start,
    stop,
    describe,
    state: () => state,
    controllerPid: () => (child ? child.pid : null),
    // Dipakai tes untuk mensimulasikan crash Controller.
    __noteExit: () => {
      childExited = true;
      if (state === STATE.READY) {
        state = STATE.FAILED;
        lastError = "controller-crashed";
      }
    },
  };
}

module.exports = { createDesktopLifecycle, STATE, DEFAULT_TIMEOUTS, BUSY_AUTOMATION };
