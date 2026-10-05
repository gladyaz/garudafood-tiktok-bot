// AR3 — orkestrasi scene: AutoPIN dulu, hasilnya menentukan AutoComment.
// obs.call di-stub; kedua dispatcher diganti palsu. Tidak ada TikTok, browser,
// OBS, maupun jaringan.

const { test, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");

process.env.SCENE_REPLAY_COOLDOWN_MS = "120000";
process.env.DOTENV_CONFIG_QUIET = "true";

const bot = require("../index.js");
const { SCENES, RULES } = bot;

const PAX1 = SCENES.AILIVE_SKUPAXSATU;
const PAX2 = SCENES.AILIVE_SKUPAXDUA;
const PAX3 = SCENES.AILIVE_SKUPAXTIGA;
const PAX5 = SCENES.AILIVE_SKUPAXLIMA;
const MAIN = SCENES.MAIN;
const QUEUE_KICK_MS = 50;
const GLOBAL_PAUSE_MS = 60_000;
const inputOf = (scene) => RULES.find((r) => r.scene === scene).mediaInputs[0];

const PIN_REAL = { ok: true, reason: "pinned", clicked: true, state: "Unpin", title: "Produk Uji" };

let logs = [];
let obsSwitches = [];
let failingScenes = new Set();
let deferred = new Map();
let order = [];      // urutan pemanggilan: pin:<scene> / comment:<scene>
let pinCalls = [];
let commentCalls = [];

const flush = () => new Promise((r) => setImmediate(r));
async function advance(ms) {
  mock.timers.tick(ms);
  await flush();
  await flush(); // rantai pin -> comment butuh satu giliran microtask ekstra
}
const chat = (user, comment) => bot.handleChat({ nickname: user, comment });
const flood = (p, n, c) => { for (let i = 0; i < n; i++) chat(`${p}${i}`, c); };
const state = () => bot.__test.getState();
const mediaEnd = (inputName) => bot.obs.emit("MediaInputPlaybackEnded", { inputName, inputUuid: "u" });

function fakePin(behaviour = async () => PIN_REAL) {
  return { requestPin(req) { order.push(`pin:${req.scene}`); pinCalls.push(req); return behaviour(req); } };
}
function fakeComment(behaviour = async () => ({ ok: true })) {
  return { requestComment(req) { order.push(`comment:${req.scene}`); commentCalls.push(req); return behaviour(req); } };
}

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  logs = []; obsSwitches = []; failingScenes = new Set(); deferred = new Map();
  order = []; pinCalls = []; commentCalls = [];
  const capture = (...a) => logs.push(a.map(String).join(" "));
  mock.method(console, "log", capture);
  mock.method(console, "warn", capture);
  mock.method(console, "error", capture);

  bot.obs.call = (request, params = {}) => {
    if (request !== "SetCurrentProgramScene") return Promise.resolve();
    const scene = params.sceneName;
    if (failingScenes.has(scene)) return Promise.reject(new Error("No source was found"));
    if (deferred.has(scene)) {
      return new Promise((resolve) => {
        const slot = deferred.get(scene);
        slot.releases = slot.releases || [];
        slot.releases.push(() => { obsSwitches.push(scene); resolve(); });
        slot.release = () => slot.releases.shift()();
      });
    }
    obsSwitches.push(scene);
    return Promise.resolve();
  };

  bot.__test.setScenePin(fakePin());
  bot.__test.setAutoComment(fakeComment());
  bot.__test.reset();
});

afterEach(() => {
  bot.__test.reset();
  bot.__test.setScenePin({ requestPin: () => Promise.resolve({ ok: false, reason: "test-noop" }) });
  bot.__test.setAutoComment({ requestComment: () => Promise.resolve({ ok: false, reason: "test-noop" }) });
  mock.timers.reset();
  mock.restoreAll();
});

// ---------- urutan ----------

test("scene mulai: AutoPIN dipanggil DULU, AutoComment menyusul membawa hasil pin", async () => {
  chat("a", "etalase 1");
  await advance(QUEUE_KICK_MS);

  assert.deepEqual(order, [`pin:${PAX1}`, `comment:${PAX1}`], "pin harus mendahului comment");
  assert.equal(commentCalls.length, 1);
  assert.deepEqual(commentCalls[0].pin, PIN_REAL, "bukti pin diteruskan ke AutoComment");
  assert.equal(commentCalls[0].playId, pinCalls[0].playId, "playId yang sama untuk keduanya");
  assert.equal(commentCalls[0].requesters, 1);
});

test("AutoComment tidak dipanggil sebelum AutoPIN selesai", async () => {
  let release;
  bot.__test.setScenePin(fakePin(() => new Promise((res) => { release = () => res(PIN_REAL); })));
  chat("a", "etalase 1");
  await advance(QUEUE_KICK_MS);

  assert.deepEqual(order, [`pin:${PAX1}`], "comment belum boleh jalan");
  assert.equal(state().activeScene, PAX1, "playback tidak menunggu pin");
  assert.equal(state().busy, true);

  release();
  await flush(); await flush();
  assert.deepEqual(order, [`pin:${PAX1}`, `comment:${PAX1}`]);
});

test("AutoPIN yang menggantung tidak menahan playback maupun antrean", async () => {
  bot.__test.setScenePin(fakePin(() => new Promise(() => {})));
  chat("a", "etalase 1");
  await advance(QUEUE_KICK_MS);
  chat("b", "etalase 2");
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, PAX1);

  mediaEnd(inputOf(PAX1));
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, PAX2, "scene berikutnya tetap jalan");
  assert.deepEqual(commentCalls, [], "comment tidak pernah dipanggil untuk pin yang menggantung");
});

// ---------- scene yang tidak berhak ----------

test("MAIN: tidak ada pin maupun comment", async () => {
  chat("a", "etalase 1");
  await advance(QUEUE_KICK_MS);
  mediaEnd(inputOf(PAX1));
  await advance(QUEUE_KICK_MS);
  assert.ok(obsSwitches.includes(MAIN));
  assert.deepEqual(order, [`pin:${PAX1}`, `comment:${PAX1}`], "MAIN tidak menambah apa pun");
});

test("OBS gagal switch: tidak ada pin, tidak ada comment", async () => {
  failingScenes.add(PAX1);
  chat("a", "etalase 1");
  await advance(QUEUE_KICK_MS);
  assert.deepEqual(order, []);
  assert.equal(state().busy, false);
});

test("scene ditolak cooldown: tidak ada pin, tidak ada comment", async () => {
  chat("a", "etalase 1");
  await advance(QUEUE_KICK_MS);
  mediaEnd(inputOf(PAX1));
  await advance(GLOBAL_PAUSE_MS + QUEUE_KICK_MS);
  order = [];

  chat("b", "etalase 1");
  await advance(QUEUE_KICK_MS);
  assert.ok(logs.some((l) => l.startsWith(`[SKIP_COOLDOWN] scene=${PAX1}`)));
  assert.deepEqual(order, []);
});

test("entry antrean tidak valid: tidak ada pin, tidak ada comment", async () => {
  bot.__test.injectAggregate({ scene: "", rule: null, count: 1, requesters: new Set(), priority: 0 });
  bot.processQueue();
  await advance(QUEUE_KICK_MS);
  assert.deepEqual(order, []);
  assert.equal(state().busy, false);
});

test("scene yang sudah di-force sebelum OBS membalas: tidak ada pin, tidak ada comment", async () => {
  deferred.set(PAX3, {});
  chat("a", "etalase 3");
  await advance(QUEUE_KICK_MS);
  await bot.handleCommand("force");
  await advance(QUEUE_KICK_MS);

  deferred.get(PAX3).release();
  await flush(); await flush();
  assert.deepEqual(order, [], "scene yang tidak pernah benar-benar mulai tidak boleh memicu apa pun");
  assert.ok(logs.some((l) => l.startsWith("[OBS_SWITCH_STALE]")));
});

// ---------- antrean & agregasi ----------

test("PAX-2 antre selagi PAX-1 tayang: tidak ada pin/comment B sampai PAX-2 benar-benar mulai", async () => {
  chat("a", "etalase 1");
  await advance(QUEUE_KICK_MS);
  chat("b", "etalase 2");
  await advance(QUEUE_KICK_MS);
  assert.deepEqual(order, [`pin:${PAX1}`, `comment:${PAX1}`], "B belum boleh disentuh");

  mediaEnd(inputOf(PAX1));
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, PAX2);
  assert.deepEqual(order, [`pin:${PAX1}`, `comment:${PAX1}`, `pin:${PAX2}`, `comment:${PAX2}`]);
  assert.ok(commentCalls[1].playId > commentCalls[0].playId);
});

test("20 penonton minta etalase sama: satu pin, satu comment, requesters hanya telemetri", async () => {
  flood("u", 20, "etalase 3");
  await advance(QUEUE_KICK_MS);
  assert.deepEqual(order, [`pin:${PAX3}`, `comment:${PAX3}`]);
  assert.equal(commentCalls[0].requesters, 20);
});

test("komentar berulang untuk scene yang sedang aktif: tidak ada pin/comment kedua", async () => {
  chat("a", "etalase 3");
  await advance(QUEUE_KICK_MS);
  flood("v", 30, "etalase 3");
  await advance(QUEUE_KICK_MS);
  assert.deepEqual(order, [`pin:${PAX3}`, `comment:${PAX3}`]);
});

// ---------- isolasi kegagalan ----------

test("AutoPIN gagal: playback utuh, AutoComment tetap dipanggil tapi membawa pin gagal", async () => {
  const failed = { ok: false, reason: "live-pin-control-not-available" };
  bot.__test.setScenePin(fakePin(async () => failed));
  chat("a", "etalase 1");
  await advance(QUEUE_KICK_MS);

  assert.equal(state().activeScene, PAX1);
  assert.equal(state().busy, true);
  assert.deepEqual(commentCalls[0].pin, failed, "gerbang 'sudah aku pin' ada di dispatcher, bukan di sini");

  mediaEnd(inputOf(PAX1));
  await advance(QUEUE_KICK_MS);
  // media-ended memicu jeda global, jadi busy memang masih true di sini.
  assert.equal(state().activeScene, null);
  assert.equal(state().hasGlobalPauseTimer, true);
  await advance(GLOBAL_PAUSE_MS);
  assert.equal(state().busy, false, "setelah jeda global, bot bebas lagi");
});

test("AutoPIN melempar sinkron: ditangkap, AutoComment tetap dapat hasil gagal", async () => {
  bot.__test.setScenePin({ requestPin(req) { order.push(`pin:${req.scene}`); throw new Error("meledak"); } });
  chat("a", "etalase 1");
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, PAX1);
  assert.equal(commentCalls[0].pin.reason, "dispatch-threw");
});

test("AutoPIN menolak (rejected): playback utuh", async () => {
  bot.__test.setScenePin(fakePin(() => Promise.reject(new Error("service mati"))));
  chat("a", "etalase 1");
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, PAX1);
  assert.equal(commentCalls[0].pin.reason, "dispatch-threw");
  mediaEnd(inputOf(PAX1));
  await advance(GLOBAL_PAUSE_MS + QUEUE_KICK_MS);
  assert.equal(state().busy, false);
});

test("AutoComment melempar / menolak / menggantung: playback dan antrean tidak terpengaruh", async () => {
  bot.__test.setAutoComment({ requestComment(req) { order.push(`comment:${req.scene}`); throw new Error("meledak"); } });
  chat("a", "etalase 1");
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, PAX1);
  mediaEnd(inputOf(PAX1));
  await advance(GLOBAL_PAUSE_MS + QUEUE_KICK_MS);
  assert.equal(state().busy, false);

  bot.__test.reset();
  order = [];
  bot.__test.setAutoComment(fakeComment(() => Promise.reject(new Error("transport mati"))));
  chat("b", "etalase 2");
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, PAX2);

  bot.__test.reset();
  order = [];
  bot.__test.setAutoComment(fakeComment(() => new Promise(() => {})));
  chat("c", "etalase 3");
  await advance(QUEUE_KICK_MS);
  chat("d", "etalase 5");
  await advance(QUEUE_KICK_MS);
  mediaEnd(inputOf(PAX3));
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, PAX5, "comment yang menggantung tidak menahan antrean");
});

// ---------- perilaku lama tetap utuh ----------

test("media-end, cooldown, dan MAIN tetap sama dengan sebelum AR3", async () => {
  chat("a", "etalase 1");
  await advance(QUEUE_KICK_MS);
  mediaEnd(inputOf(PAX1));
  await advance(QUEUE_KICK_MS);

  assert.ok(logs.some((l) => l === `[PLAYBACK_END] scene=${PAX1} reason=media-ended`));
  assert.deepEqual(state().cooldownScenes, [PAX1]);
  assert.ok(obsSwitches.includes(MAIN));
  assert.equal(state().hasGlobalPauseTimer, true);
});

test("hook audit: flag dan transport terbaca", () => {
  assert.equal(typeof bot.__test.autocommentEnabled(), "boolean");
  assert.ok(["dry-run", "browser"].includes(bot.__test.autocommentTransport()));
});
