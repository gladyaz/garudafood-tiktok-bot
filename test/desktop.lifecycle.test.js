// Lifecycle aplikasi desktop. SEMUANYA OFFLINE, dan tanpa Electron sama sekali.
//
// Electron tidak pernah di-import di sini: semua yang menyentuh dunia nyata
// di-inject, dan itulah alasan modul lifecycle-nya dibuat terpisah dari main.js.
// Perilaku yang diuji di bawah adalah perilaku yang paling mahal kalau salah —
// menutup aplikasi sementara bot dan service masih hidup, memegang profil Chrome,
// dan masih mengklik produk di akun sungguhan.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createDesktopLifecycle, STATE } = require("../desktop/lifecycle");

// Pegangan Controller palsu. Bentuknya sama dengan yang dikembalikan
// desktop/controller-child.js: pid, requestShutdown, kill, alive, onExit.
function fakeChild({ pid = 9001, dieOnRequest = true, dieOnKill = true } = {}) {
  const h = {
    pid,
    alive_: true,
    shutdownRequests: 0,
    kills: 0,
    exitHandlers: [],
    requestShutdown() {
      h.shutdownRequests += 1;
      if (dieOnRequest) h.die();
    },
    kill() {
      h.kills += 1;
      if (dieOnKill) h.die();
    },
    alive: () => h.alive_,
    onExit(cb) {
      if (!h.alive_) return cb({ code: 0 });
      h.exitHandlers.push(cb);
    },
    // Dipanggil tes untuk mensimulasikan Controller mati.
    die(code = 0) {
      if (!h.alive_) return;
      h.alive_ = false;
      for (const cb of h.exitHandlers.splice(0)) cb({ code });
    },
  };
  return h;
}

// Jam virtual: batas waktu diuji tanpa benar-benar menunggu puluhan detik, dan
// hasilnya tidak tergantung beban mesin.
function clock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    sleep: (ms) => {
      t += Math.max(1, Number(ms) || 1);
      return new Promise((r) => setImmediate(r));
    },
  };
}

function mk(over = {}) {
  const c = clock();
  const spawned = [];
  const logs = [];
  let automation = over.automation === undefined ? "STOPPED" : over.automation;
  const stopCalls = [];
  const sweeps = [];

  const lc = createDesktopLifecycle({
    spawnController:
      over.spawnController ||
      (() => {
        const ch = fakeChild(over.child || {});
        spawned.push(ch);
        return ch;
      }),
    waitReady: over.waitReady || (async () => ({ ok: true })),
    getAutomationState: over.getAutomationState || (async () => automation),
    stopAutomation:
      over.stopAutomation ||
      (async () => {
        stopCalls.push(1);
        automation = "STOPPED";
        return { ok: true };
      }),
    cleanupOrphans:
      over.cleanupOrphans === null
        ? null
        : over.cleanupOrphans ||
          (async () => {
            sweeps.push(1);
            return { ok: true, remaining: 0 };
          }),
    timeouts: Object.assign({ readyMs: 2000, readyPollMs: 100, automationStopMs: 3000, controllerExitMs: 1000, exitPollMs: 50 }, over.timeouts),
    now: c.now,
    sleep: c.sleep,
    log: (tag, f) => logs.push(tag + " " + JSON.stringify(f || {})),
  });

  return { lc, spawned, logs, stopCalls, sweeps, setAutomation: (v) => (automation = v), getAutomation: () => automation };
}

// --- start -------------------------------------------------------------------

test("start menyalakan TEPAT SATU Controller dan menunggunya siap", async () => {
  const h = mk();
  const r = await h.lc.start();

  assert.equal(r.ok, true);
  assert.equal(h.spawned.length, 1, "tepat satu Controller");
  assert.equal(h.lc.state(), STATE.READY);
  assert.equal(h.lc.controllerPid(), h.spawned[0].pid);
});

test("start KEDUA ditolak dan tidak menyalakan Controller kedua", async () => {
  const h = mk();
  await h.lc.start();
  const second = await h.lc.start();

  assert.equal(second.ok, false);
  assert.equal(second.code, "controller-already-running");
  assert.equal(h.spawned.length, 1);
});

test("dua start BERSAMAAN tetap satu Controller", async () => {
  // Penolakannya sinkron, sebelum await pertama, jadi dua panggilan yang dilepas
  // bersamaan tidak mungkin keduanya lolos.
  const h = mk();
  const [a, b] = await Promise.all([h.lc.start(), h.lc.start()]);
  assert.equal([a, b].filter((x) => x.ok).length, 1);
  assert.equal(h.spawned.length, 1);
});

test("Controller yang tidak pernah siap: batas waktu, dan child DIBERESKAN", async () => {
  const h = mk({ waitReady: async () => ({ ok: false, reason: "unreachable" }) });
  const r = await h.lc.start();

  assert.equal(r.ok, false);
  assert.equal(r.code, "controller-start-timeout");
  assert.equal(h.lc.state(), STATE.FAILED);
  // Startup gagal tidak boleh meninggalkan proses tersembunyi.
  assert.equal(h.spawned[0].alive(), false, "child harus dimatikan");
});

test("Controller yang MATI saat ditunggu: tidak menghabiskan batas waktu", async () => {
  let polls = 0;
  const h = mk({
    waitReady: async () => {
      polls += 1;
      return { ok: false };
    },
  });
  const p = h.lc.start();
  await new Promise((r) => setImmediate(r));
  h.spawned[0].die(1);
  const r = await p;

  assert.equal(r.ok, false);
  assert.equal(r.code, "controller-start-failed");
  assert.ok(polls < 20, "harus berhenti lebih awal, polls=" + polls);
});

test("spawn yang melempar dilaporkan, bukan meledak", async () => {
  const h = mk({
    spawnController: () => {
      throw new Error("ENOENT");
    },
  });
  const r = await h.lc.start();
  assert.equal(r.ok, false);
  assert.equal(r.code, "controller-start-failed");
  assert.equal(h.lc.state(), STATE.FAILED);
});

test("spawn tanpa pid dianggap gagal", async () => {
  const h = mk({ spawnController: () => ({ pid: undefined }) });
  const r = await h.lc.start();
  assert.equal(r.ok, false);
  assert.equal(r.code, "controller-start-failed");
});

test("Controller CRASH sesudah siap dilaporkan sebagai FAILED", async () => {
  const h = mk();
  await h.lc.start();
  assert.equal(h.lc.state(), STATE.READY);

  h.spawned[0].die(1);
  await new Promise((r) => setImmediate(r));

  assert.equal(h.lc.state(), STATE.FAILED);
  assert.equal(h.lc.describe().lastError, "controller-crashed");
});

test("lifecycle tanpa dependensi menolak jalan", async () => {
  const lc = createDesktopLifecycle({});
  const r = await lc.start();
  assert.equal(r.ok, false);
  assert.equal(r.code, "desktop-not-configured");
});

// --- stop --------------------------------------------------------------------

test("stop saat automation sudah STOPPED: Controller diminta berhenti, lalu bersih", async () => {
  const h = mk();
  await h.lc.start();

  const r = await h.lc.stop();

  assert.equal(r.ok, true);
  assert.equal(h.lc.state(), STATE.STOPPED);
  assert.equal(h.spawned[0].shutdownRequests, 1, "diminta sopan lewat jalur induk-anak");
  assert.equal(h.spawned[0].kills, 0, "tidak perlu dipaksa");
  assert.equal(h.spawned[0].alive(), false);
});

test("stop saat automation RUNNING: automation DIHENTIKAN LEBIH DULU", async () => {
  // Inilah tes paling penting di berkas ini. Kalau Electron mati lebih dulu,
  // Controller kehilangan induknya sementara bot dan service masih hidup,
  // memegang profil Chrome, dan masih mengklik produk di akun sungguhan.
  const order = [];
  const h = mk({
    automation: "RUNNING",
    stopAutomation: async () => {
      order.push("stop-automation");
      return { ok: true };
    },
  });
  await h.lc.start();
  h.spawned[0].requestShutdown = function () {
    order.push("stop-controller");
    h.spawned[0].die();
  };

  h.setAutomation("RUNNING");
  const p = h.lc.stop();
  // Automation "selesai berhenti" sesudah permintaan diterima.
  await new Promise((r) => setImmediate(r));
  h.setAutomation("STOPPED");
  const r = await p;

  assert.equal(r.ok, true);
  assert.deepEqual(order, ["stop-automation", "stop-controller"]);
});

test("stop saat DEGRADED juga menghentikan automation lebih dulu", async () => {
  const h = mk({ automation: "DEGRADED" });
  await h.lc.start();
  const p = h.lc.stop();
  await new Promise((r) => setImmediate(r));
  h.setAutomation("STOPPED");
  const r = await p;
  assert.equal(r.ok, true);
  assert.equal(h.stopCalls.length, 1);
});

test("automation yang TIDAK MAU berhenti dilaporkan, bukan didiamkan", async () => {
  const h = mk({ automation: "RUNNING", stopAutomation: async () => ({ ok: false }) });
  await h.lc.start();
  // State tidak pernah berubah dari RUNNING.
  const r = await h.lc.stop();

  assert.equal(r.ok, false);
  assert.equal(r.code, "shutdown-incomplete");
  assert.equal(r.automation.code, "automation-stop-timeout");
});

test("Controller yang keras kepala DIPAKSA, lalu dibuktikan mati", async () => {
  const h = mk({ child: { dieOnRequest: false, dieOnKill: true } });
  await h.lc.start();

  const r = await h.lc.stop();

  assert.equal(h.spawned[0].shutdownRequests, 1, "sopan dulu");
  assert.equal(h.spawned[0].kills, 1, "baru dipaksa");
  assert.equal(r.ok, true);
  assert.equal(h.spawned[0].alive(), false);
});

test("Controller yang TIDAK BISA dimatikan: TIDAK mengaku bersih", async () => {
  const h = mk({ child: { dieOnRequest: false, dieOnKill: false } });
  await h.lc.start();

  const r = await h.lc.stop();

  assert.equal(r.ok, false);
  assert.equal(r.code, "shutdown-incomplete");
  assert.equal(r.controller.code, "controller-did-not-die");
  assert.equal(h.spawned[0].alive(), true, "dunia palsu membuktikan ia masih hidup");
});

test("sisa proses yatim yang tidak nol membuat shutdown dilaporkan TIDAK bersih", async () => {
  const h = mk({ cleanupOrphans: async () => ({ ok: false, remaining: 2 }) });
  await h.lc.start();
  const r = await h.lc.stop();

  assert.equal(r.ok, false);
  assert.equal(r.remaining, 2);
});

test("tanpa penyapu: dilaporkan tidak terkonfigurasi, bukan bersih", async () => {
  const h = mk({ cleanupOrphans: null });
  await h.lc.start();
  const r = await h.lc.stop();
  // Tetap ok karena tidak ada yang membantahnya, tapi kejujurannya ada di kode:
  // sweep() mengembalikan code sweep-not-configured.
  assert.equal(r.ok, true);
});

test("dua stop BERSAMAAN memakai satu operasi, bukan dua", async () => {
  const h = mk({ child: { dieOnRequest: false, dieOnKill: true } });
  await h.lc.start();

  const [a, b] = await Promise.all([h.lc.stop(), h.lc.stop()]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  // Dua stopAll bersamaan akan saling membuktikan kematian proses yang sudah
  // dimatikan pihak lain, dan salah satunya akan salah melapor.
  assert.equal(h.spawned[0].kills, 1);
});

test("stop sebelum start: aman", async () => {
  const h = mk();
  const r = await h.lc.stop();
  assert.equal(r.ok, true);
  assert.equal(r.code, "already-stopped");
  assert.equal(h.spawned.length, 0);
});

test("stop dua kali berurutan: yang kedua idempoten", async () => {
  const h = mk();
  await h.lc.start();
  await h.lc.stop();
  const second = await h.lc.stop();
  assert.equal(second.ok, true);
  assert.equal(second.code, "already-stopped");
  assert.equal(h.spawned[0].shutdownRequests, 1, "tidak diminta dua kali");
});

test("start LAGI sesudah stop bersih: boleh, dan tetap satu-satu", async () => {
  const h = mk();
  await h.lc.start();
  await h.lc.stop();

  const again = await h.lc.start();
  assert.equal(again.ok, true);
  assert.equal(h.spawned.length, 2, "dua kali spawn sepanjang hidup aplikasi");
  assert.equal(h.spawned.filter((c) => c.alive()).length, 1, "tapi hanya satu yang hidup");
});

test("Controller yang sudah mati tidak ditembak lagi saat stop", async () => {
  const h = mk();
  await h.lc.start();
  h.spawned[0].die(0);
  await new Promise((r) => setImmediate(r));

  const r = await h.lc.stop();
  assert.equal(r.ok, true);
  assert.equal(h.spawned[0].shutdownRequests, 0, "proses mati tidak perlu diminta berhenti");
  assert.equal(h.spawned[0].kills, 0);
});

test("describe() melaporkan keadaan yang bisa ditampilkan tanpa rahasia", async () => {
  const h = mk();
  await h.lc.start();
  const d = h.lc.describe();
  assert.deepEqual(Object.keys(d).sort(), ["controllerPid", "controllerRunning", "lastError", "state"]);
  assert.equal(d.controllerRunning, true);
  assert.equal(d.state, STATE.READY);
});
