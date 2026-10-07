// Process manager: satu-satunya tempat yang boleh spawn, dan satu-satunya tempat
// yang boleh membunuh.
//
// Tes paling penting di berkas ini adalah yang membuktikan KEMATIAN, bukan yang
// membuktikan kill terpanggil. Pada 2026-10-05 laporan "sisa bot: 0" terbit tiga
// kali padahal tiga bot masih hidup — karena yang diperiksa adalah pola yang
// tidak pernah cocok, bukan keberadaan prosesnya. Di sini pidAlive() dari dunia
// palsu yang jadi hakim, bukan apa yang dilaporkan process manager.
//
// Tidak ada proses nyata yang dinyalakan atau dimatikan.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createProcessManager, SCRIPTS, ROLES } = require("../controller/process-manager");
const { createFakeWorld, createClock } = require("./helpers/controller-harness");

function mk(overrides = {}) {
  const world = createFakeWorld({ dieOnSignal: overrides.dieOnSignal !== false });
  const clock = createClock();
  const lines = [];
  const exits = [];
  const pm = createProcessManager(
    Object.assign(
      {
        cwd: "/fake",
        spawn: world.spawn,
        nodePath: "/fake/node",
        pidAlive: world.pidAlive,
        now: clock.now,
        sleep: clock.sleep,
        onLine: (l) => lines.push(l),
        onExit: (e) => exits.push(e),
      },
      overrides.pm || {}
    )
  );
  return { pm, world, clock, lines, exits };
}

test("startService dan startBot menjalankan skrip yang benar", () => {
  const path = require("node:path");
  const { pm, world } = mk();
  pm.startService({ env: {} });
  pm.startBot({ env: {} });

  // path.join memakai pemisah milik platform (backslash di Windows), jadi
  // perbandingannya dibentuk dengan path.join juga, bukan dengan string yang
  // mengasumsikan garis miring.
  assert.equal(world.spawned[0].script, path.join("/fake", SCRIPTS[ROLES.SERVICE]));
  assert.equal(world.spawned[1].script, path.join("/fake", SCRIPTS[ROLES.BOT]));
  assert.ok(world.spawned[0].script.includes("autopin-service.js"));
  assert.ok(world.spawned[1].script.includes("index.js"));
});

test("hanya skrip dari daftar tertutup yang bisa dijalankan", () => {
  // Controller tidak pernah menjalankan perintah sembarang, termasuk kalau config
  // bilang lain.
  assert.deepEqual(Object.values(SCRIPTS).sort(), ["autopin-service.js", "index.js"]);
});

test("MAKSIMUM SATU service", () => {
  const { pm, world } = mk();
  assert.equal(pm.startService({ env: {} }).ok, true);
  const second = pm.startService({ env: {} });

  assert.equal(second.ok, false);
  assert.equal(second.code, "service-already-running");
  assert.equal(world.countByScript("autopin-service.js"), 1);
});

test("MAKSIMUM SATU bot", () => {
  const { pm, world } = mk();
  assert.equal(pm.startBot({ env: {} }).ok, true);
  const second = pm.startBot({ env: {} });

  assert.equal(second.ok, false);
  assert.equal(second.code, "bot-already-running");
  assert.equal(world.countByScript("index.js"), 1);
});

test("slot bisa dipakai ulang sesudah child-nya mati", () => {
  const { pm, world } = mk();
  pm.startBot({ env: {} });
  world.spawned[0].exit(0, null);

  assert.equal(pm.startBot({ env: {} }).ok, true, "boleh start lagi sesudah yang lama mati");
  assert.equal(world.countByScript("index.js"), 2);
  assert.equal(world.liveByScript("index.js").length, 1, "tapi hanya satu yang hidup");
});

test("PID dilacak oleh Controller sendiri, bukan ditanyakan ke shell", () => {
  const { pm, world } = mk();
  const r = pm.startService({ env: {} });
  const state = pm.getProcessState();

  assert.equal(state.service.pid, r.pid);
  assert.equal(state.service.pid, world.spawned[0].pid);
  assert.equal(state.service.running, true);
  assert.equal(state.service.script, "autopin-service.js");
});

test("getProcessState melaporkan bot dan service yang belum pernah start", () => {
  const { pm } = mk();
  const s = pm.getProcessState();
  assert.deepEqual(s.service, { running: false, pid: null });
  assert.deepEqual(s.bot, { running: false, pid: null });
});

test("exitCode dan signal dicatat", () => {
  const { pm, world } = mk();
  pm.startBot({ env: {} });
  world.spawned[0].exit(3, null);

  const s = pm.getProcessState();
  assert.equal(s.bot.running, false);
  assert.equal(s.bot.exitCode, 3);
});

test("env diteruskan apa adanya ke child", () => {
  const { pm, world } = mk();
  pm.startBot({ env: { TIKTOK_USERNAME: "akun", AUTOPIN_ENABLED: "true" } });
  assert.deepEqual(world.spawned[0].spawnEnv, { TIKTOK_USERNAME: "akun", AUTOPIN_ENABLED: "true" });
});

test("env anak TIDAK mewarisi process.env secara diam-diam", () => {
  // Nilai sisa di environment Controller tidak boleh bisa mengubah perilaku bot
  // tanpa terlihat di config.
  const { pm, world } = mk();
  pm.startBot({ env: { ONLY: "this" } });
  assert.deepEqual(Object.keys(world.spawned[0].spawnEnv), ["ONLY"]);
});

test("args diteruskan sesudah nama skrip", () => {
  const { pm, world } = mk();
  pm.startService({ env: {}, args: ["--dry-run", "--click-strategy=dom"] });
  assert.deepEqual(world.spawned[0].spawnArgs.slice(1), ["--dry-run", "--click-strategy=dom"]);
});

test("spawn yang melempar dilaporkan gagal, bukan dibiarkan meledak", () => {
  const { pm } = mk({
    pm: {
      spawn: () => {
        throw new Error("ENOENT");
      },
    },
  });
  const r = pm.startService({ env: {} });
  assert.equal(r.ok, false);
  assert.equal(r.code, "spawn-failed");
  assert.equal(pm.getProcessState().service.running, false);
});

test("spawn tanpa pid dianggap gagal", () => {
  const { pm } = mk({ pm: { spawn: () => ({ pid: undefined }) } });
  const r = pm.startBot({ env: {} });
  assert.equal(r.ok, false);
  assert.equal(r.code, "spawn-no-pid");
});

test("stdout dipotong per baris, dan baris terbelah disatukan kembali", async () => {
  const { pm, world, lines } = mk();
  pm.startBot({ env: {} });
  const bot = world.spawned[0];

  // Satu baris log yang datang dalam dua potongan. Kalau ini tidak disatukan,
  // parser activity tidak akan pernah mengenali barisnya.
  bot.stdout.emit("data", "[PLAY] scene=");
  bot.stdout.emit("data", "PAX-2 count=1\n[PLAYBACK_END] scene=PAX-2 reason=media-ended\n");

  const got = lines.map((l) => l.line);
  assert.deepEqual(got, ["[PLAY] scene=PAX-2 count=1", "[PLAYBACK_END] scene=PAX-2 reason=media-ended"]);
});

test("stderr ikut ditangkap dan ditandai channel-nya", () => {
  const { pm, world, lines } = mk();
  pm.startBot({ env: {} });
  world.spawned[0].sayErr("[AUTOPIN_FAILED] scene=PAX-1 reason=timeout");

  assert.equal(lines.length, 1);
  assert.equal(lines[0].channel, "stderr");
  assert.equal(lines[0].role, "bot");
});

test("CRLF dari Windows dibuang", () => {
  const { pm, world, lines } = mk();
  pm.startBot({ env: {} });
  world.spawned[0].stdout.emit("data", "[PLAY] scene=PAX-1\r\n");
  assert.equal(lines[0].line, "[PLAY] scene=PAX-1");
});

test("baris kosong tidak diteruskan", () => {
  const { pm, world, lines } = mk();
  pm.startBot({ env: {} });
  world.spawned[0].stdout.emit("data", "\n\n\n");
  assert.equal(lines.length, 0);
});

test("baris raksasa dipotong, tidak dibiarkan menghabiskan memori", () => {
  const { pm, world, lines } = mk();
  pm.startBot({ env: {} });
  world.spawned[0].say("x".repeat(100000));
  assert.ok(lines[0].line.length <= 2000, "panjang=" + lines[0].line.length);
});

test("pendengar baris yang melempar tidak menjatuhkan Controller", () => {
  const { pm, world } = mk({
    pm: {
      onLine: () => {
        throw new Error("pendengar rusak");
      },
    },
  });
  pm.startBot({ env: {} });
  assert.doesNotThrow(() => world.spawned[0].say("[PLAY] scene=PAX-1"));
});

test("stop: SOPAN DULU", async () => {
  const { pm, world } = mk();
  pm.startBot({ env: {} });
  const bot = world.spawned[0];

  const r = await pm.stopBot({ graceMs: 20 });

  assert.equal(r.ok, true);
  // Yang sopan saja sudah cukup: tidak perlu naik ke SIGKILL.
  assert.deepEqual(bot.signals, ["SIGTERM"]);
  assert.equal(r.forced, false);
  assert.equal(world.pidAlive(bot.pid), false, "harus benar-benar mati");
});

test("stop: DIPAKSA hanya kalau yang sopan gagal, lalu dibuktikan", async () => {
  const { pm, world } = mk({ dieOnSignal: false });
  pm.startBot({ env: {} });
  const bot = world.spawned[0];

  const r = await pm.stopBot({ graceMs: 20 });

  assert.deepEqual(bot.signals, ["SIGTERM", "SIGKILL"]);
  // Child tetap hidup di dunia palsu, jadi process manager WAJIB bilang gagal.
  // Inilah yang membedakannya dari "kill tidak melempar, berarti sudah mati".
  assert.equal(r.ok, false);
  assert.equal(r.code, "bot-did-not-die");
  assert.equal(r.pid, bot.pid);
});

test("stop: child yang sudah mati tidak ditembak lagi", async () => {
  const { pm, world } = mk();
  pm.startBot({ env: {} });
  const bot = world.spawned[0];
  bot.exit(0, null);

  const r = await pm.stopBot({ graceMs: 20 });

  assert.equal(r.ok, true);
  assert.equal(r.code, "already-exited");
  // Menembak PID yang sudah mati adalah cara paling mudah mengirim sinyal ke
  // proses lain yang kebetulan mewarisi PID itu.
  assert.deepEqual(bot.signals, []);
});

test("stop: yang belum pernah start aman", async () => {
  const { pm } = mk();
  const r = await pm.stopBot();
  assert.equal(r.ok, true);
  assert.equal(r.code, "not-started");
});

test("stop dua kali: yang kedua tidak mengirim sinyal lagi", async () => {
  const { pm, world } = mk();
  pm.startBot({ env: {} });
  const bot = world.spawned[0];

  await pm.stopBot({ graceMs: 20 });
  const count = bot.signals.length;
  const second = await pm.stopBot({ graceMs: 20 });

  assert.equal(second.ok, true);
  assert.equal(bot.signals.length, count);
});

test("stopAll: bot DULU, baru service", async () => {
  const { pm, world } = mk();
  pm.startService({ env: {} });
  pm.startBot({ env: {} });

  const deaths = [];
  world.spawned[0].on("exit", () => deaths.push("service"));
  world.spawned[1].on("exit", () => deaths.push("bot"));

  const r = await pm.stopAll({ graceMs: 20 });

  // Bot adalah yang MEMANGGIL service. Mematikan service lebih dulu membuat bot
  // menembak port mati dan mencatat kegagalan yang tidak ada artinya.
  assert.deepEqual(deaths, ["bot", "service"]);
  assert.equal(r.ok, true);
  assert.equal(world.liveCount(), 0);
});

test("stopAll melaporkan gagal kalau salah satu tidak bisa dibuktikan mati", async () => {
  const { pm, world } = mk({ dieOnSignal: false });
  pm.startService({ env: {} });
  pm.startBot({ env: {} });

  const r = await pm.stopAll({ graceMs: 20 });

  assert.equal(r.ok, false);
  assert.equal(world.liveCount(), 2, "dunia palsu membuktikan keduanya masih hidup");
});

test("onExit: kematian yang DIMINTA ditandai expected", async () => {
  const { pm, world, exits } = mk();
  pm.startBot({ env: {} });
  await pm.stopBot({ graceMs: 20 });

  assert.equal(exits.length, 1);
  assert.equal(exits[0].expected, true);
  assert.equal(exits[0].role, "bot");
});

test("onExit: CRASH ditandai TIDAK expected", () => {
  const { pm, world, exits } = mk();
  pm.startBot({ env: {} });
  world.spawned[0].exit(1, null);

  assert.equal(exits[0].expected, false);
  assert.equal(exits[0].code, 1);
});

test("pendengar onExit yang melempar tidak menjatuhkan Controller", () => {
  const { pm, world } = mk({
    pm: {
      onExit: () => {
        throw new Error("rusak");
      },
    },
  });
  pm.startBot({ env: {} });
  assert.doesNotThrow(() => world.spawned[0].exit(1, null));
});

test("cleanupAutomationChrome tanpa pembunuh: no-op yang JUJUR", async () => {
  const { pm } = mk();
  const r = await pm.cleanupAutomationChrome();
  // Bukan kesuksesan yang dipalsukan: ia mengatakan dirinya tidak terkonfigurasi.
  assert.equal(r.code, "chrome-cleanup-not-configured");
  assert.equal(r.killed, 0);
});

test("cleanupAutomationChrome memakai pembunuh yang di-inject", async () => {
  const { pm } = mk({ pm: { killAutomationChrome: async () => ({ killed: 2 }) } });
  const r = await pm.cleanupAutomationChrome();
  assert.equal(r.ok, true);
  assert.equal(r.killed, 2);
});

test("pembunuh Chrome yang melempar dilaporkan gagal", async () => {
  const { pm } = mk({
    pm: {
      killAutomationChrome: async () => {
        throw new Error("powershell hilang");
      },
    },
  });
  const r = await pm.cleanupAutomationChrome();
  assert.equal(r.ok, false);
  assert.equal(r.code, "chrome-cleanup-failed");
});

test("cleanupOrphans MENGECUALIKAN child milik Controller ini", async () => {
  // Child kita diurus oleh slot, bukan oleh penyapu. Menyapu mereka dari sini
  // akan berlomba dengan process manager sendiri.
  let seen = null;
  const { pm, world } = mk({
    pm: {
      orphanSweeper: async (arg) => {
        seen = arg;
        return { count: 0, killed: 0, remaining: 0 };
      },
    },
  });
  const svc = pm.startService({ env: {} });
  const bot = pm.startBot({ env: {} });

  await pm.cleanupOrphans();

  assert.ok(seen.ownPids.has(svc.pid), "pid service harus dikecualikan");
  assert.ok(seen.ownPids.has(bot.pid), "pid bot harus dikecualikan");
});

test("cleanupOrphans: sisa > 0 adalah KEGAGALAN", async () => {
  const { pm } = mk({ pm: { orphanSweeper: async () => ({ count: 3, killed: 1, remaining: 2 }) } });
  const r = await pm.cleanupOrphans();
  assert.equal(r.ok, false);
  assert.equal(r.code, "orphans-remain");
  assert.equal(r.remaining, 2);
});

test("cleanupOrphans: sisa nol adalah sukses", async () => {
  const { pm } = mk({ pm: { orphanSweeper: async () => ({ count: 2, killed: 2, remaining: 0 }) } });
  const r = await pm.cleanupOrphans();
  assert.equal(r.ok, true);
  assert.equal(r.killed, 2);
});

test("cleanupOrphans tanpa penyapu: no-op yang jujur", async () => {
  const { pm } = mk();
  const r = await pm.cleanupOrphans();
  assert.equal(r.code, "orphan-sweep-not-configured");
});

test("penyapu yang melempar dilaporkan gagal", async () => {
  const { pm } = mk({
    pm: {
      orphanSweeper: async () => {
        throw new Error("boom");
      },
    },
  });
  const r = await pm.cleanupOrphans();
  assert.equal(r.ok, false);
  assert.equal(r.code, "orphan-sweep-failed");
});
