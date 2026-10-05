// Balasan OBS yang telat untuk pemutaran LAMA harus menjadi no-op.
//
// obs.call di-stub dengan promise yang bisa ditahan lalu di-resolve/reject per
// panggilan, sehingga balapan "force selagi OBS memproses" bisa dimainkan
// deterministik. Tidak ada OBS, TikTok, maupun browser nyata.

const { test, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");

process.env.SCENE_REPLAY_COOLDOWN_MS = "120000";
process.env.DOTENV_CONFIG_QUIET = "true";

const bot = require("../index.js");
const { SCENES, RULES } = bot;

const PAX3 = SCENES.AILIVE_SKUPAXTIGA;
const PAX5 = SCENES.AILIVE_SKUPAXLIMA;
const PAX7 = SCENES.AILIVE_SKUPAXTUJUH;
const MAIN = SCENES.MAIN;
const QUEUE_KICK_MS = 50;
const inputOf = (scene) => RULES.find((r) => r.scene === scene).mediaInputs[0];
const fallbackOf = (scene) => RULES.find((r) => r.scene === scene).duration;

let logs = [];
let obsSwitches = [];
let pending = new Map(); // scene -> [{ resolve, reject }] per panggilan OBS yang ditahan
let pinRequests = [];
let commentRequests = [];

const flush = () => new Promise((r) => setImmediate(r));
async function advance(ms) {
  mock.timers.tick(ms);
  await flush();
}
const chat = (user, comment) => bot.handleChat({ nickname: user, comment });
const state = () => bot.__test.getState();
const has = (re) => logs.some((l) => re.test(l));
const count = (re) => logs.filter((l) => re.test(l)).length;
const mediaEnd = (inputName) => bot.obs.emit("MediaInputPlaybackEnded", { inputName, inputUuid: "u-" + inputName });

// tahan semua panggilan SetCurrentProgramScene untuk scene ini
const hold = (scene) => pending.set(scene, []);
// panggilan ke-i yang ditahan untuk scene ini (0 = yang paling lama)
const held = (scene, i = 0) => pending.get(scene)[i];

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  logs = [];
  obsSwitches = [];
  pending = new Map();
  pinRequests = [];
  commentRequests = [];
  const capture = (...args) => logs.push(args.map(String).join(" "));
  mock.method(console, "log", capture);
  mock.method(console, "warn", capture);
  mock.method(console, "error", capture);

  bot.obs.call = (request, params = {}) => {
    if (request !== "SetCurrentProgramScene") return Promise.resolve();
    const scene = params.sceneName;
    if (pending.has(scene)) {
      return new Promise((resolve, reject) => {
        pending.get(scene).push({
          resolve: () => { obsSwitches.push(scene); resolve(); },
          reject: () => reject(new Error("No source was found")),
        });
      });
    }
    obsSwitches.push(scene);
    return Promise.resolve();
  };

  bot.__test.setScenePin({ requestPin(req) { pinRequests.push(req); return Promise.resolve({ ok: true }); } });
  bot.__test.setAutoComment({ requestComment(req) { commentRequests.push(req); return Promise.resolve({ ok: true, dryRun: true }); } });
  bot.__test.reset();
});

afterEach(() => {
  bot.__test.reset();
  bot.__test.setScenePin({ requestPin: () => Promise.resolve({ ok: false, reason: "test-noop" }) });
  bot.__test.setAutoComment({ requestComment: () => Promise.resolve({ ok: false, reason: "test-noop" }) });
  mock.timers.reset();
  mock.restoreAll();
});

// ---------- A. sukses telat setelah force all ----------

test("A: sukses OBS telat setelah force all -> callback basi tidak menyentuh state apa pun", async () => {
  hold(PAX3);
  chat("a", "etalase 3");
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, PAX3);

  await bot.handleCommand("force all");
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, null);
  assert.equal(state().lastScene, MAIN);
  const before = logs.length;

  held(PAX3).resolve(); // balasan untuk switch yang sudah di-force
  await flush();

  assert.equal(state().lastScene, MAIN, "lastScene tidak boleh ditimpa jadi PAX-3");
  assert.equal(state().activeScene, null);
  assert.equal(state().busy, false);
  assert.ok(!logs.slice(before).some((l) => /Menunggu media selesai/.test(l)), "tidak boleh mengarm penantian media");
  assert.ok(has(/\[OBS_SWITCH_STALE\] scene=PAX-3 .*phase=resolve/), "harus dicatat sebagai balasan basi");
  assert.deepEqual(pinRequests, []);
  assert.deepEqual(commentRequests, []);

  // fallback timer basi (52 s untuk PAX-3) tidak boleh ada: tidak ada PLAYBACK_END sesudahnya
  await advance(fallbackOf(PAX3) + 1);
  assert.ok(!has(/\[PLAYBACK_END\]/), "tidak ada scene yang boleh 'berakhir' setelah force all");
});

// ---------- B. sukses telat setelah force ke scene lain ----------

test("B: sukses OBS telat setelah force -> scene baru (PAX-5) tetap bisa selesai lewat media-end", async () => {
  hold(PAX3);
  chat("a", "etalase 3");
  await advance(QUEUE_KICK_MS);

  await bot.handleCommand("force");
  await advance(QUEUE_KICK_MS);
  chat("b", "etalase 5");
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, PAX5);
  assert.equal(state().lastScene, PAX5);

  held(PAX3).resolve(); // balasan lama tiba selagi PAX-5 tayang
  await flush();

  assert.equal(state().lastScene, PAX5, "balasan lama tidak boleh menimpa lastScene");
  assert.equal(state().activeScene, PAX5);

  mediaEnd(inputOf(PAX5)); // event media PAX-5 harus tetap dikenali
  await advance(QUEUE_KICK_MS);
  assert.ok(has(/\[PLAYBACK_END\] scene=PAX-5 reason=media-ended/), "media-end PAX-5 tidak boleh terhalang penantian media PAX-3 yang basi");
  assert.equal(state().activeScene, null);

  // fallback basi milik PAX-3 juga tidak boleh menyala belakangan
  const ends = count(/\[PLAYBACK_END\]/);
  await advance(fallbackOf(PAX3) + 1);
  assert.equal(count(/\[PLAYBACK_END\]/), ends, "tidak ada PLAYBACK_END tambahan dari timer basi");
  assert.ok(!has(/reason=media-fallback/));
});

// ---------- C. ABA: scene yang SAMA diminta ulang ----------

test("C: ABA - PAX-3 lama tertahan, force all, PAX-3 baru -> balasan lama diabaikan, yang baru jalan normal", async () => {
  hold(PAX3);
  chat("a", "etalase 3");                 // pemutaran lama
  await advance(QUEUE_KICK_MS);
  await bot.handleCommand("force all");   // cooldown dibersihkan, jadi PAX-3 boleh diminta lagi
  await advance(QUEUE_KICK_MS);
  chat("b", "etalase 3");                 // pemutaran baru, scene yang sama
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, PAX3);
  assert.equal(pending.get(PAX3).length, 2, "dua switch PAX-3 sama-sama tertahan");

  held(PAX3, 0).resolve();                // balasan untuk pemutaran LAMA
  await flush();
  assert.deepEqual(pinRequests, [], "nama scene cocok, tapi playId-nya bukan yang berlaku");
  assert.deepEqual(commentRequests, []);
  assert.ok(!has(/Menunggu media selesai/), "state media tidak boleh di-arm oleh balasan lama");
  assert.ok(has(/\[OBS_SWITCH_STALE\] scene=PAX-3 .*phase=resolve/));

  held(PAX3, 1).resolve();                // balasan untuk pemutaran BARU
  await flush();
  assert.equal(pinRequests.length, 1);
  assert.equal(commentRequests.length, 1);
  assert.ok(commentRequests[0].playId > 0);
  assert.ok(has(/Menunggu media selesai/));

  mediaEnd(inputOf(PAX3));
  await advance(QUEUE_KICK_MS);
  assert.ok(has(/\[PLAYBACK_END\] scene=PAX-3 reason=media-ended/));
  assert.equal(count(/\[PLAYBACK_END\]/), 1, "scene berakhir tepat sekali");
});

// ---------- D/E. selesai normal / force -> MAIN, lalu callback basi ----------

test("E: force selagi switch tertahan, MAIN tayang dengan jeda global -> callback basi tidak mengganggu jeda", async () => {
  hold(PAX3);
  chat("a", "etalase 3");
  await advance(QUEUE_KICK_MS);
  await bot.handleCommand("force");
  await advance(QUEUE_KICK_MS);
  assert.equal(state().lastScene, MAIN);
  assert.equal(state().activeScene, null);
  assert.equal(state().busy, false);

  held(PAX3).resolve();
  await flush();

  assert.equal(state().lastScene, MAIN);
  assert.equal(state().activeScene, null);
  assert.equal(state().busy, false, "callback basi tidak boleh membuat bot sibuk lagi");
  assert.deepEqual(pinRequests, []);
  assert.deepEqual(commentRequests, []);
  assert.ok(has(/\[OBS_SWITCH_STALE\] scene=PAX-3 .*phase=resolve/));
});

// ---------- jalur gagal (.catch) ----------

test("F: penolakan OBS untuk pemutaran yang BERLAKU -> perilaku abort lama tidak berubah", async () => {
  hold(PAX3);
  chat("a", "etalase 3");
  await advance(QUEUE_KICK_MS);
  held(PAX3).reject();
  await flush();

  assert.ok(has(/\[PLAY_FAILED\] scene=PAX-3 reason=obs-switch-error/));
  assert.equal(state().activeScene, null);
  assert.equal(state().busy, false);
  assert.deepEqual(state().cooldownScenes, [PAX3]);
});

test("G: penolakan OBS basi setelah force all -> tidak ada abort, tidak ada PLAY_FAILED", async () => {
  hold(PAX3);
  chat("a", "etalase 3");
  await advance(QUEUE_KICK_MS);
  await bot.handleCommand("force all");
  await advance(QUEUE_KICK_MS);
  const ends = count(/\[PLAYBACK_END\]/);

  held(PAX3).reject();
  await flush();

  assert.ok(!has(/\[PLAY_FAILED\]/));
  assert.equal(count(/\[PLAYBACK_END\]/), ends);
  assert.ok(has(/\[OBS_SWITCH_STALE\] scene=PAX-3 .*phase=reject/));
  assert.equal(state().busy, false);
});

test("H: ABA pada jalur gagal - PAX-3 lama ditolak selagi PAX-3 baru berjalan -> pemutaran baru tidak boleh dibunuh", async () => {
  hold(PAX3);
  chat("a", "etalase 3");
  await advance(QUEUE_KICK_MS);
  await bot.handleCommand("force all");
  await advance(QUEUE_KICK_MS);
  chat("b", "etalase 3");
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, PAX3);

  held(PAX3, 0).reject();                 // OBS menolak switch LAMA
  await flush();
  assert.equal(state().activeScene, PAX3, "pemutaran baru masih aktif");
  assert.equal(state().busy, true);
  assert.ok(!has(/\[PLAY_FAILED\]/), "abort milik switch lama tidak boleh menimpa yang baru");
  assert.ok(has(/\[OBS_SWITCH_STALE\] scene=PAX-3 .*phase=reject/));

  held(PAX3, 1).resolve();                // switch BARU sukses
  await flush();
  assert.equal(pinRequests.length, 1);
  assert.equal(commentRequests.length, 1);
  mediaEnd(inputOf(PAX3));
  await advance(QUEUE_KICK_MS);
  assert.ok(has(/\[PLAYBACK_END\] scene=PAX-3 reason=media-ended/));
});

// ---------- jalur yang berlaku tetap normal ----------

test("I: callback yang berlaku masih meng-arm penantian media + fallback dan memanggil kedua saudara tepat sekali", async () => {
  hold(PAX3);
  chat("a", "etalase 3");
  await advance(QUEUE_KICK_MS);
  held(PAX3).resolve();
  await flush();

  assert.ok(has(/Menunggu media selesai/));
  assert.equal(state().lastScene, PAX3);
  assert.equal(pinRequests.length, 1);
  assert.equal(commentRequests.length, 1);
  assert.equal(pinRequests[0].playId, commentRequests[0].playId);

  // fallback hidup: tanpa event media, scene ditutup oleh failsafe
  await advance(fallbackOf(PAX3) + 1);
  assert.ok(has(/\[PLAYBACK_END\] scene=PAX-3 reason=media-fallback/));
});

test("J: scene durasi manual yang berlaku masih meng-arm timer durasinya", async () => {
  bot.__test.injectAggregate({
    scene: PAX7,
    rule: { scene: PAX7, waitForMediaEnd: false, duration: 1_000, mediaInputs: [] },
    count: 1, requesters: new Set(["x"]), priority: 0,
  });
  bot.processQueue();
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, PAX7);
  assert.equal(pinRequests.length, 1);
  assert.equal(commentRequests.length, 1);
  await advance(1_000);
  assert.ok(has(/\[PLAYBACK_END\] scene=PAX-7 reason=manual-duration/));
  assert.equal(state().activeScene, null);
});

test("K: setelah scene selesai normal, generasi lama tidak pernah berlaku lagi untuk scene berikutnya", async () => {
  chat("a", "etalase 3");
  await advance(QUEUE_KICK_MS);
  mediaEnd(inputOf(PAX3));
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, null);
  await advance(60_000 + QUEUE_KICK_MS); // jeda global

  hold(PAX5);
  chat("b", "etalase 5");
  await advance(QUEUE_KICK_MS);
  held(PAX5).resolve();
  await flush();
  assert.equal(state().lastScene, PAX5);
  assert.equal(commentRequests.map((r) => r.scene).join(","), [PAX3, PAX5].join(","));
  assert.ok(commentRequests[1].playId > commentRequests[0].playId, "setiap pemutaran generasi baru");
});
