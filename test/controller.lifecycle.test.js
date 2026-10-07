// Start dan Stop sebagai TRANSAKSI.
//
// Tes di berkas ini semuanya menjawab satu pertanyaan: apakah mungkin Controller
// bilang gagal sementara ada proses yang masih hidup? Pada 2026-10-05 jawabannya
// ya, dan akibatnya tiga bot jalan bersamaan sampai salah satunya membatalkan pin
// yang baru diumumkan ke penonton lewat chat.
//
// Karena itu hampir setiap tes di bawah tidak memeriksa apa yang DILAPORKAN
// Controller, tapi memeriksa world.liveCount() — jumlah proses yang sungguhan
// masih hidup di dunia palsu. Itu angka yang tidak bisa dibohongi oleh state
// Controller sendiri.
//
// Tidak ada proses nyata, socket, OBS, TikTok, atau browser yang disentuh.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createHarness, goodConfig, sayBotConnected } = require("./helpers/controller-harness");
const { STATES } = require("../controller/state-machine");

// Memberi event loop kesempatan berjalan beberapa tick. Dipakai saat tes perlu
// menyela di tengah start (mis. untuk mematikan child sebelum readiness).
async function tick(n = 1) {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
}

test("STOPPED -> PREFLIGHT -> STARTING -> RUNNING, dan tepat SATU service + SATU bot", async () => {
  const h = createHarness();

  assert.equal(h.controller.state(), STATES.STOPPED);

  const r = await h.controller.startAutomation();

  assert.equal(r.ok, true, "start harus sukses");
  assert.equal(h.controller.state(), STATES.RUNNING);

  // Urutan state yang DILALUI, bukan hanya state akhirnya: start yang melompati
  // preflight akan lulus tes yang hanya memeriksa hasil akhir.
  const path = h.controller.__sm.history().filter((e) => e.ok).map((e) => e.to);
  assert.deepEqual(path, [STATES.PREFLIGHT, STATES.STARTING, STATES.RUNNING]);

  // Satu, bukan "setidaknya satu". Jumlah inilah yang salah pada Phase 21.
  assert.equal(h.world.countByScript("autopin-service.js"), 1, "tepat satu service");
  assert.equal(h.world.countByScript("index.js"), 1, "tepat satu bot");
  assert.equal(h.world.liveCount(), 2);
});

test("service dinyalakan SEBELUM bot, dan bot hanya menyusul sesudah service sehat", async () => {
  const order = [];
  const h = createHarness({
    fetchHealth: async () => {
      order.push("health");
      return { ok: true, body: { ok: true } };
    },
  });
  // Urutan spawn direkam lewat urutan di world.spawned.
  await h.controller.startAutomation();

  const scripts = h.world.spawned.map((c) => (c.script.includes("autopin-service.js") ? "service" : "bot"));
  assert.deepEqual(scripts, ["service", "bot"], "service harus lebih dulu");
  // Health diperiksa sebelum bot ada. Kalau tidak, bot akan menembak port yang
  // belum mendengarkan dan mencatat kegagalan yang tidak ada artinya.
  assert.ok(order.length >= 1, "health harus diperiksa");
});

test("DOUBLE START: permintaan kedua ditolak dan TIDAK menambah satu proses pun", async () => {
  const h = createHarness();
  await h.controller.startAutomation();
  assert.equal(h.world.liveCount(), 2);

  const second = await h.controller.startAutomation();

  assert.equal(second.ok, false);
  assert.equal(second.error.code, "start-rejected-busy");
  assert.equal(h.controller.state(), STATES.RUNNING, "state tidak boleh terganggu");
  assert.equal(h.world.countByScript("autopin-service.js"), 1, "tetap satu service");
  assert.equal(h.world.countByScript("index.js"), 1, "tetap satu bot");
});

test("DOUBLE START BERSAMAAN: dua panggilan tanpa await di antaranya tetap satu service + satu bot", async () => {
  const h = createHarness();

  // Keduanya dilepas sebelum yang pertama selesai. Inilah bentuk nyata dari dua
  // POST /api/start yang datang hampir bersamaan.
  const [a, b] = await Promise.all([h.controller.startAutomation(), h.controller.startAutomation()]);

  const okCount = [a, b].filter((r) => r.ok).length;
  assert.equal(okCount, 1, "tepat satu yang boleh sukses");
  assert.equal(h.world.countByScript("autopin-service.js"), 1);
  assert.equal(h.world.countByScript("index.js"), 1);
});

test("SERVICE HEALTH TIMEOUT: bot TIDAK PERNAH di-spawn, dan service dibersihkan", async () => {
  const h = createHarness({
    // Service hidup tapi /health tidak pernah menjawab ok.
    fetchHealth: async () => ({ ok: false, reason: "unreachable" }),
  });

  const r = await h.controller.startAutomation();

  assert.equal(r.ok, false);
  assert.equal(r.error.code, "service-health-timeout");
  assert.equal(h.world.countByScript("index.js"), 0, "bot tidak boleh pernah dinyalakan");
  // Service yang sempat hidup WAJIB mati. Kalau tidak, ia memegang port 5055 dan
  // start berikutnya gagal dengan sebab yang menyesatkan.
  assert.equal(h.world.liveCount(), 0, "tidak boleh ada sisa proses hidup");
  assert.equal(h.controller.state(), STATES.STOPPED);
});

test("SERVICE MATI SAAT DITUNGGU: tidak menghabiskan batas waktu, dan bot tidak di-spawn", async () => {
  let polls = 0;
  const h = createHarness({
    fetchHealth: async () => {
      polls += 1;
      return { ok: false, reason: "unreachable" };
    },
  });

  const p = h.controller.startAutomation();
  await tick(2);
  // Service crash saat sedang ditunggu sehat.
  const svc = h.world.byScript("autopin-service.js")[0];
  if (svc) svc.exit(1, null);

  const r = await p;

  assert.equal(r.ok, false);
  assert.equal(r.error.code, "service-exited-early");
  assert.equal(h.world.countByScript("index.js"), 0, "bot tidak boleh dinyalakan");
  assert.equal(h.world.liveCount(), 0);
  assert.equal(h.controller.state(), STATES.STOPPED);
  // Buktinya bahwa ia berhenti lebih awal: polling tidak sampai menghabiskan
  // seluruh batas waktu (5000ms / 100ms = 50 kali).
  assert.ok(polls < 50, "harus berhenti sebelum batas waktu habis, polls=" + polls);
});

test("BOT GAGAL SIAP SETELAH SERVICE HIDUP: service IKUT dibersihkan", async () => {
  const h = createHarness({
    // Bot tidak pernah mengucapkan [TIKTOK_CONNECTED].
    autoBotConnected: false,
  });

  const r = await h.controller.startAutomation();

  assert.equal(r.ok, false);
  assert.equal(r.error.code, "bot-ready-timeout");
  // Inilah tes yang paling penting di berkas ini: kegagalan di tahap TERAKHIR
  // tetap harus membersihkan tahap SEBELUMNYA.
  assert.equal(h.world.liveCount(), 0, "service tidak boleh tertinggal hidup");
  assert.equal(h.controller.state(), STATES.STOPPED);
});

test("BOT MATI SAAT DITUNGGU SIAP: service ikut dibersihkan, state STOPPED", async () => {
  const h = createHarness({ autoBotConnected: false });

  const p = h.controller.startAutomation();
  await tick(3);
  const bot = h.world.byScript("index.js")[0];
  assert.ok(bot, "bot harus sudah di-spawn pada titik ini");
  bot.exit(1, null);

  const r = await p;

  assert.equal(r.ok, false);
  assert.equal(r.error.code, "bot-exited-early");
  assert.equal(h.world.liveCount(), 0);
  assert.equal(h.controller.state(), STATES.STOPPED);
});

test("SPAWN TANPA PID: dianggap GAGAL, bukan sukses yang pid-nya kebetulan kosong", async () => {
  // spawn() bisa mengembalikan objek child tanpa pid saat kegagalannya asinkron
  // (mis. berkasnya tidak ada). Itu kegagalan, dan harus terlihat sebagai
  // kegagalan — kalau tidak, Controller akan mengira service hidup dan menunggu
  // /health dari sesuatu yang tidak pernah ada.
  const { createController } = require("../controller/controller");
  const { createClock, createFakeFs, passingPreflightDeps, goodConfig: gc, CONFIG_PATH } = require("./helpers/controller-harness");

  const clock = createClock();
  const controller = createController({
    cwd: "/fake",
    configFile: CONFIG_PATH,
    fs: createFakeFs({ [CONFIG_PATH]: JSON.stringify(gc()) }),
    spawn: () => ({ pid: undefined }),
    nodePath: "/fake/node",
    pidAlive: () => false,
    now: clock.now,
    sleep: clock.sleep,
    logger: { log: () => {} },
    preflightDeps: passingPreflightDeps(),
    fetchHealth: async () => ({ ok: true, body: { ok: true } }),
    timeouts: { serviceHealthMs: 500, botReadyMs: 500, healthPollMs: 100 },
    orphanSweeper: async () => ({ count: 0, killed: 0, remaining: 0 }),
  });

  const r = await controller.startAutomation();

  assert.equal(r.ok, false);
  assert.equal(r.error.code, "spawn-no-pid");
  assert.equal(r.error.userMessage, "A required program failed to start.");
  assert.equal(controller.state(), STATES.STOPPED);
  const ps = controller.processes.getProcessState();
  assert.equal(ps.service.running, false);
  assert.equal(ps.bot.running, false);
});

test("ROLLBACK: urutan mati adalah bot dulu, baru service", async () => {
  const deaths = [];
  const h = createHarness({ autoBotConnected: false });

  const p = h.controller.startAutomation();
  await tick(3);
  for (const c of h.world.spawned) {
    const role = c.script.includes("index.js") ? "bot" : "service";
    c.on("exit", () => deaths.push(role));
  }
  await p;

  // Bot adalah yang MEMANGGIL service. Mematikan service lebih dulu membuat bot
  // menembak port mati dan mencatat kegagalan yang tidak ada artinya.
  assert.deepEqual(deaths, ["bot", "service"]);
});

test("PREFLIGHT MERAH: nol proses dinyalakan, state kembali ke STOPPED", async () => {
  const h = createHarness({
    preflightDeps: { probeObs: async () => ({ ok: false, reason: "obs-unavailable" }) },
  });

  const r = await h.controller.startAutomation();

  assert.equal(r.ok, false);
  assert.equal(r.error.code, "obs-unavailable");
  assert.equal(r.error.userMessage, "OBS is not connected.");
  assert.equal(r.error.check, "obs");
  // Tidak ada yang dinyalakan, jadi tidak ada yang perlu dibersihkan.
  assert.equal(h.world.spawned.length, 0, "tidak boleh ada spawn sama sekali");
  assert.equal(h.controller.state(), STATES.STOPPED);
  const path = h.controller.__sm.history().filter((e) => e.ok).map((e) => e.to);
  assert.deepEqual(path, [STATES.PREFLIGHT, STATES.STOPPED]);
});

test("PREFLIGHT: scene di mapping yang tidak ada di OBS menahan start", async () => {
  const cfg = goodConfig();
  cfg.mappings = [{ scene: "PAX-9", product: { title: "Tidak Ada Di OBS" } }];
  const h = createHarness({
    config: cfg,
    preflightDeps: { probeObs: async () => ({ ok: true, scenes: ["MAIN", "PAX-1"] }) },
  });

  const r = await h.controller.startAutomation();

  assert.equal(r.ok, false);
  assert.equal(r.error.code, "obs-scene-missing");
  assert.equal(h.world.spawned.length, 0);
});

test("PREFLIGHT: port AutoPIN terpakai menahan start", async () => {
  const h = createHarness({ preflightDeps: { portFree: async () => false } });
  const r = await h.controller.startAutomation();
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "port-in-use");
  assert.equal(h.world.spawned.length, 0);
});

test("PREFLIGHT: bot/service yatim yang masih hidup menahan start", async () => {
  // Preflight MELAPORKAN keberadaan proses yatim, bukan membereskannya diam-diam.
  // Operator harus tahu ada bot lain yang hidup sebelum sesuatu dimatikan untuknya.
  const h = createHarness({
    preflightDeps: { listOrphans: async () => ({ count: 3 }) },
  });
  const r = await h.controller.startAutomation();
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "already-running");
  assert.equal(r.error.check, "processes");
  assert.equal(h.world.spawned.length, 0, "jangan tambah proses saat sudah ada yang hidup");
});

test("PENYAPUAN GAGAL: sisa yatim tidak bisa dibuktikan nol -> rollback, nol spawn", async () => {
  // Preflight lolos (hitungannya nol saat itu), lalu penyapuan menemukan sisa yang
  // TIDAK bisa dimatikan. Itu kegagalan, dan start harus berhenti di situ —
  // pelajaran stop-all.ps1: angka yang tidak bisa dipercaya lebih berbahaya
  // daripada tidak ada angka.
  const h = createHarness({
    orphanSweeper: async () => ({ count: 2, killed: 0, remaining: 2 }),
  });
  const r = await h.controller.startAutomation();

  assert.equal(r.ok, false);
  assert.equal(r.error.code, "orphans-remain");
  assert.equal(h.world.spawned.length, 0, "service tidak boleh dinyalakan di atas sisa yang tidak jelas");
  assert.equal(h.world.liveCount(), 0);
  assert.equal(h.controller.state(), STATES.STOPPED);
});

test("STOP: kedua child dibersihkan dan state jadi STOPPED", async () => {
  const h = createHarness();
  await h.controller.startAutomation();
  assert.equal(h.world.liveCount(), 2);

  const r = await h.controller.stopAutomation();

  assert.equal(r.ok, true);
  assert.equal(h.controller.state(), STATES.STOPPED);
  assert.equal(h.world.liveCount(), 0, "zero orphan");
  const ps = h.controller.processes.getProcessState();
  assert.equal(ps.service.running, false);
  assert.equal(ps.bot.running, false);
});

test("STOP: bot dimatikan lebih dulu, baru service", async () => {
  const h = createHarness();
  await h.controller.startAutomation();

  const deaths = [];
  for (const c of h.world.spawned) {
    c.on("exit", () => deaths.push(c.script.includes("index.js") ? "bot" : "service"));
  }
  await h.controller.stopAutomation();

  assert.deepEqual(deaths, ["bot", "service"]);
});

test("DOUBLE STOP: aman, idempoten, dan tidak mengirim sinyal dua kali", async () => {
  const h = createHarness();
  await h.controller.startAutomation();
  const children = h.world.spawned.slice();

  const first = await h.controller.stopAutomation();
  const signalsAfterFirst = children.map((c) => c.signals.length);

  const second = await h.controller.stopAutomation();

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.code, "already-stopped");
  assert.equal(h.controller.state(), STATES.STOPPED);
  // Proses yang sudah mati tidak boleh ditembak lagi: itu cara paling mudah
  // untuk mengirim sinyal ke PID yang sudah dipakai ulang oleh proses lain.
  assert.deepEqual(children.map((c) => c.signals.length), signalsAfterFirst);
});

test("DOUBLE STOP BERSAMAAN: satu operasi stop dipakai bersama, bukan dua", async () => {
  const h = createHarness();
  await h.controller.startAutomation();

  const [a, b] = await Promise.all([h.controller.stopAutomation(), h.controller.stopAutomation()]);

  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(h.world.liveCount(), 0);
  assert.equal(h.controller.state(), STATES.STOPPED);
});

test("STOP saat belum pernah start: aman dan tidak melakukan apa pun", async () => {
  const h = createHarness();
  const r = await h.controller.stopAutomation();
  assert.equal(r.ok, true);
  assert.equal(r.code, "already-stopped");
  assert.equal(h.world.spawned.length, 0);
  assert.equal(h.controller.state(), STATES.STOPPED);
});

test("STOP sesudah start yang gagal separuh jalan: tetap aman", async () => {
  const h = createHarness({ autoBotConnected: false });
  const failed = await h.controller.startAutomation();
  assert.equal(failed.ok, false);

  const r = await h.controller.stopAutomation();

  assert.equal(r.ok, true);
  assert.equal(h.world.liveCount(), 0);
  assert.equal(h.controller.state(), STATES.STOPPED);
});

test("STOP saat DEGRADED: tetap membersihkan sisanya", async () => {
  const h = createHarness();
  await h.controller.startAutomation();

  // Service crash: bot masih hidup, jadi sistemnya jalan tapi tidak utuh.
  h.world.byScript("autopin-service.js")[0].exit(1, null);
  await tick(2);
  assert.equal(h.controller.state(), STATES.DEGRADED);
  assert.equal(h.world.liveCount(), 1);

  const r = await h.controller.stopAutomation();

  assert.equal(r.ok, true);
  assert.equal(h.controller.state(), STATES.STOPPED);
  assert.equal(h.world.liveCount(), 0, "bot yang tersisa harus ikut mati");
});

test("CHILD CRASH saat RUNNING: satu mati -> DEGRADED, dua mati -> ERROR", async () => {
  const h = createHarness();
  await h.controller.startAutomation();
  assert.equal(h.controller.state(), STATES.RUNNING);

  h.world.byScript("autopin-service.js")[0].exit(1, null);
  await tick(2);
  assert.equal(h.controller.state(), STATES.DEGRADED, "masih ada bot yang hidup");

  h.world.byScript("index.js")[0].exit(1, null);
  await tick(2);
  // Tidak ada lagi yang hidup, padahal tidak ada yang meminta berhenti.
  assert.equal(h.controller.state(), STATES.ERROR);
});

test("CHILD CRASH: tercatat di activity feed dengan kalimat untuk manusia", async () => {
  const h = createHarness();
  await h.controller.startAutomation();
  h.world.byScript("index.js")[0].exit(1, null);
  await tick(2);

  const crash = h.controller.activity.list().filter((e) => e.type === "BOT_CRASHED");
  assert.equal(crash.length, 1);
  assert.equal(crash[0].message, "The bot stopped unexpectedly");
  assert.equal(crash[0].reason, "exit-1");
});

test("STOP yang diminta TIDAK dilaporkan sebagai crash", async () => {
  const h = createHarness();
  await h.controller.startAutomation();
  await h.controller.stopAutomation();

  const crashes = h.controller.activity.list().filter((e) => e.type === "BOT_CRASHED" || e.type === "SERVICE_CRASHED");
  assert.equal(crashes.length, 0, "kematian yang kita minta bukan kejadian");
});

test("SHUTDOWN Controller membersihkan kedua child", async () => {
  const h = createHarness();
  await h.controller.startAutomation();
  assert.equal(h.world.liveCount(), 2);

  // Inilah yang dipanggil oleh handler SIGINT/SIGTERM di controller/index.js.
  const r = await h.controller.shutdown();

  assert.equal(r.ok, true);
  assert.equal(h.world.liveCount(), 0, "child tidak boleh hidup lebih lama dari Controller");
  assert.equal(h.controller.state(), STATES.STOPPED);
});

test("CHILD KERAS KEPALA: dipaksa sesudah yang sopan gagal", async () => {
  const h = createHarness({ dieOnSignal: false });

  // Tanpa autoBotConnected, bot tetap akan bicara; yang diuji di sini adalah
  // perilaku stop terhadap child yang tidak mati karena sinyal.
  await h.controller.startAutomation();
  const bot = h.world.byScript("index.js")[0];

  const r = await h.controller.stopAutomation();

  // Sopan dulu, lalu paksa. Keduanya harus benar-benar dicoba.
  assert.deepEqual(bot.signals, ["SIGTERM", "SIGKILL"]);
  // Child tetap tidak mati, jadi Controller WAJIB mengatakannya, bukan melaporkan
  // bersih. Ini satu-satunya hasil yang jujur.
  assert.equal(r.ok, false);
  assert.equal(h.controller.state(), STATES.ERROR);
  assert.ok(Array.isArray(r.error.orphans) && r.error.orphans.length > 0, "sisa proses harus disebutkan");
  assert.equal(r.error.userMessage, "The bot could not be stopped.");
});

test("START ditolak selama stop sedang berjalan", async () => {
  const h = createHarness({ dieOnSignal: false, stopGraceMs: 30 });
  await h.controller.startAutomation();

  const stopping = h.controller.stopAutomation();
  await tick(1);
  const started = await h.controller.startAutomation();

  assert.equal(started.ok, false);
  assert.equal(started.error.code, "start-rejected-busy");
  await stopping;
});

test("ENV anak datang dari config, dan flag izin TIDAK pernah dari config", async () => {
  const h = createHarness({ serviceArgs: ["--enable-autocomment-send"] });
  await h.controller.startAutomation();

  const svc = h.world.byScript("autopin-service.js")[0];
  const bot = h.world.byScript("index.js")[0];

  // Nilai yang diurus customer sampai ke anak lewat nama env yang SUDAH ada.
  assert.equal(bot.spawnEnv.TIKTOK_USERNAME, "agen_mulia_abadi");
  assert.equal(bot.spawnEnv.AUTOPIN_ENABLED, "true");
  assert.equal(bot.spawnEnv.AUTOPIN_PORT, "5055");
  assert.equal(bot.spawnEnv.AUTOPIN_TIMEOUT_MS, "15000");
  assert.equal(bot.spawnEnv.OBS_PORT, "4455");
  assert.equal(bot.spawnEnv.SCENE_REPLAY_COOLDOWN_MS, "120000");
  // Pemetaan TIDAK lewat env sejak P2: ia berjalan lewat artefak config runtime.
  // Lihat test/controller.runtime.test.js untuk pembuktian jalurnya.
  assert.equal(bot.spawnEnv.AUTOPIN_PRODUCT_PAX_1, undefined);

  // Izin mengirim chat sungguhan HANYA lewat argumen baris perintah, dan hanya
  // ke service. Tidak ada nilai di config.json yang bisa menyalakannya.
  assert.deepEqual(svc.spawnArgs.slice(1), ["--enable-autocomment-send"]);
  assert.equal(svc.spawnEnv.AUTOCOMMENT_ENABLED, "false");
});

test("ENV anak tidak mewarisi environment Controller secara diam-diam", async () => {
  const h = createHarness();
  await h.controller.startAutomation();
  const bot = h.world.byScript("index.js")[0];

  // Hanya nilai yang memang dibutuhkan untuk menjalankan node yang diteruskan.
  // Sisa nilai di environment Controller tidak boleh bisa mengubah perilaku bot
  // tanpa terlihat di config.
  //
  // AILIVE_RUNTIME_CONFIG adalah SATU-SATUNYA variabel yang P2 tambahkan, dan ia
  // berisi PATH ke artefak config runtime — bukan pemetaannya. Daftar ini adalah
  // kontraknya: variabel baru harus lewat sini dulu, dengan sadar.
  const keys = Object.keys(bot.spawnEnv).filter((k) => k !== "PATH" && k !== "SystemRoot");
  const unexpected = keys.filter(
    (k) => !/^(TIKTOK_|OBS_|AUTOPIN_|AUTOCOMMENT_|SCENE_REPLAY_)/.test(k) && k !== "AILIVE_RUNTIME_CONFIG"
  );
  assert.deepEqual(unexpected, [], "env anak tidak boleh berisi nilai asing: " + unexpected.join(","));
  assert.equal(typeof bot.spawnEnv.AILIVE_RUNTIME_CONFIG, "string", "path artefak harus diteruskan");
});

test("CHROME automation dibersihkan SESUDAH service mati, bukan sebelum", async () => {
  const events = [];
  const h = createHarness({
    killAutomationChrome: async () => {
      events.push("chrome");
      return { killed: 2 };
    },
  });
  await h.controller.startAutomation();
  for (const c of h.world.spawned) {
    c.on("exit", () => events.push(c.script.includes("index.js") ? "bot" : "service"));
  }

  await h.controller.stopAutomation();

  // Menutup Chrome sebelum service mati hanya membuat service membuka yang baru.
  assert.deepEqual(events, ["bot", "service", "chrome"]);
});

test("CONFIG tidak ada: start ditolak sebelum preflight, nol spawn", async () => {
  const h = createHarness({ configText: null });
  const r = await h.controller.startAutomation();

  assert.equal(r.ok, false);
  assert.equal(r.error.code, "config-missing");
  assert.equal(r.error.userMessage, "No configuration has been saved yet.");
  assert.equal(h.world.spawned.length, 0);
  assert.equal(h.controller.state(), STATES.STOPPED);
});

test("CONFIG rusak: start ditolak, nol spawn, tanpa stack trace", async () => {
  const h = createHarness({ configText: "{ ini bukan json" });
  const r = await h.controller.startAutomation();

  assert.equal(r.ok, false);
  assert.equal(r.error.code, "config-invalid-json");
  assert.equal(h.world.spawned.length, 0);
  assert.ok(!/\bat \w+/.test(JSON.stringify(r.error)), "tidak boleh ada jejak stack");
});

test("START ulang sesudah STOP bersih: boleh, dan tetap satu-satu", async () => {
  const h = createHarness();
  await h.controller.startAutomation();
  await h.controller.stopAutomation();

  const again = await h.controller.startAutomation();

  assert.equal(again.ok, true);
  assert.equal(h.controller.state(), STATES.RUNNING);
  assert.equal(h.world.liveByScript("autopin-service.js").length, 1, "satu service yang hidup");
  assert.equal(h.world.liveByScript("index.js").length, 1, "satu bot yang hidup");
  assert.equal(h.world.liveCount(), 2);
});

test("ACTIVITY: kejadian dari stdout anak sampai ke feed", async () => {
  const h = createHarness();
  await h.controller.startAutomation();
  const bot = h.world.byScript("index.js")[0];

  bot.say("[PLAY] scene=PAX-2 count=3 requesters=2");
  bot.say('[AUTOPIN_SUCCESS] scene=PAX-2 playId=4 key="Gery Potato" ms=1200 dryRun=false clicked=true state="Unpin"');
  bot.say("[PLAYBACK_END] scene=PAX-2 reason=media-ended");
  await tick(1);

  const types = h.controller.activity.list().map((e) => e.type);
  assert.ok(types.includes("PLAY"));
  assert.ok(types.includes("AUTOPIN_SUCCESS"));
  assert.ok(types.includes("PLAYBACK_END"));

  const pin = h.controller.activity.list().find((e) => e.type === "AUTOPIN_SUCCESS");
  assert.equal(pin.scene, "PAX-2");
  assert.equal(pin.playId, 4);
  assert.equal(pin.product, "Gery Potato");
  assert.equal(pin.message, "Product pinned");
});

test("ACTIVITY: baris chat penonton TIDAK PERNAH masuk feed", async () => {
  const h = createHarness();
  await h.controller.startAutomation();
  const bot = h.world.byScript("index.js")[0];

  bot.say('[TIKTOK_CHAT] user=@penonton_asli text="spill etalase 1"');
  await tick(1);

  const serialized = JSON.stringify(h.controller.activity.list());
  // Direktori logs/ di-gitignore justru karena berisi nama penonton. Memindahkan
  // nama itu ke feed yang dibaca UI akan membatalkan alasan itu.
  assert.ok(!serialized.includes("penonton_asli"), "nama penonton tidak boleh masuk feed");
  assert.ok(!serialized.includes("TIKTOK_CHAT"));
});
