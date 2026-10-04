// Integrasi AutoComment <-> playback scene, TANPA browser, TikTok, maupun OBS nyata:
// obs.call di-stub, AutoPIN dan AutoComment diganti palsu lewat hook __test.
//
// Yang diuji di sini bukan logika pesannya (itu di autocomment.core.test.js),
// melainkan KAPAN bot memanggilnya, bahwa ia saudara AutoPIN (bukan bawahannya),
// dan bahwa kegagalannya tidak bisa merusak playback.

const { test, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");

process.env.SCENE_REPLAY_COOLDOWN_MS = "120000";
process.env.DOTENV_CONFIG_QUIET = "true";

const bot = require("../index.js");
const { loadConfig: loadAutoCommentConfig } = require("../autocomment/config");
const { SCENES } = bot;

const PAX1 = SCENES.AILIVE_SKUPAXSATU;
const PAX2 = SCENES.AILIVE_SKUPAXDUA;
const PAX3 = SCENES.AILIVE_SKUPAXTIGA;
const PAX5 = SCENES.AILIVE_SKUPAXLIMA;
const MAIN = SCENES.MAIN;
const QUEUE_KICK_MS = 50;
const GLOBAL_PAUSE_MS = 60_000;

let logs = [];
let obsSwitches = [];
let failingScenes = new Set();
let deferred = new Map();
let commentRequests = [];
let pinRequests = [];

const flush = () => new Promise((r) => setImmediate(r));
async function advance(ms) {
  mock.timers.tick(ms);
  await flush();
}
const chat = (user, comment) => bot.handleChat({ nickname: user, comment });
const flood = (prefix, count, comment) => { for (let i = 0; i < count; i++) chat(`${prefix}${i}`, comment); };
const state = () => bot.__test.getState();
const commentedScenes = () => commentRequests.map((r) => r.scene);

function fakeComment(behaviour = () => Promise.resolve({ ok: true, reason: "dry-run", dryRun: true })) {
  return { requestComment(req) { commentRequests.push(req); return behaviour(req); } };
}
function fakePin(behaviour = () => Promise.resolve({ ok: true })) {
  return { requestPin(req) { pinRequests.push(req); return behaviour(req); } };
}

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  logs = [];
  obsSwitches = [];
  failingScenes = new Set();
  deferred = new Map();
  commentRequests = [];
  pinRequests = [];
  const capture = (...args) => logs.push(args.map(String).join(" "));
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
        slot.release = () => slot.releases.shift()(); // melepas balasan yang paling lama tertahan
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
  bot.__test.setScenePin(fakePin());
  bot.__test.setAutoComment(fakeComment());
  mock.timers.reset();
  mock.restoreAll();
});

test("hook AutoComment terpasang dan flag-nya bisa dibaca", () => {
  assert.equal(typeof bot.__test.setAutoComment, "function");
  assert.equal(typeof bot.__test.autocommentEnabled(), "boolean");
});

test("PAX-1 mulai sukses -> tepat satu permintaan AutoComment dengan playId dan requesters", async () => {
  chat("a", "etalase 1");
  await advance(QUEUE_KICK_MS);

  assert.equal(state().activeScene, PAX1);
  assert.deepEqual(commentedScenes(), [PAX1]);
  assert.equal(typeof commentRequests[0].playId, "number");
  assert.equal(commentRequests[0].requesters, 1);
});

test("permintaan baru dikirim SETELAH OBS membalas sukses, setelah AutoPIN", async () => {
  deferred.set(PAX3, {});
  chat("a", "etalase 3");
  await advance(QUEUE_KICK_MS);
  assert.deepEqual(commentRequests, [], "belum boleh selagi OBS memproses");

  deferred.get(PAX3).release();
  await flush();
  assert.deepEqual(commentedScenes(), [PAX3]);
  assert.deepEqual(pinRequests.map((r) => r.scene), [PAX3]);
  assert.equal(commentRequests[0].playId, pinRequests[0].playId, "playId yang sama dipakai kedua saudara");
});

test("OBS gagal switch -> tidak ada AutoComment", async () => {
  failingScenes.add(PAX3);
  chat("a", "etalase 3");
  await advance(QUEUE_KICK_MS);
  assert.deepEqual(commentRequests, []);
  assert.equal(state().busy, false);
});

test("kembali ke MAIN setelah antrean habis -> tidak ada AutoComment untuk MAIN", async () => {
  chat("a", "etalase 3");
  await advance(QUEUE_KICK_MS);
  bot.endCurrentScene("media-ended", false);
  await advance(QUEUE_KICK_MS);
  assert.ok(obsSwitches.includes(MAIN));
  assert.deepEqual(commentedScenes(), [PAX3]);
});

test("20 penonton minta etalase yang sama -> satu scene start -> satu AutoComment dengan requesters=20", async () => {
  flood("u", 20, "etalase 3");
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, PAX3);
  assert.equal(commentRequests.length, 1);
  assert.equal(commentRequests[0].requesters, 20);
});

test("komentar berulang untuk scene yang sedang aktif -> tidak ada AutoComment kedua", async () => {
  chat("a", "etalase 3");
  await advance(QUEUE_KICK_MS);
  flood("v", 30, "etalase 3");
  await advance(QUEUE_KICK_MS);
  assert.deepEqual(commentedScenes(), [PAX3]);
});

test("PAX-2 antre selagi PAX-1 tayang -> belum ada AutoComment; baru saat PAX-2 benar-benar mulai", async () => {
  chat("a", "etalase 1");
  await advance(QUEUE_KICK_MS);
  chat("b", "etalase 2");
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, PAX1);
  assert.deepEqual(commentedScenes(), [PAX1], "scene yang masih antre tidak boleh dikomentari");

  bot.endCurrentScene("media-ended", false);
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, PAX2);
  assert.deepEqual(commentedScenes(), [PAX1, PAX2]);
  assert.ok(commentRequests[1].playId > commentRequests[0].playId);
});

test("scene ditolak karena replay cooldown -> tidak ada AutoComment", async () => {
  chat("a", "etalase 1");
  await advance(QUEUE_KICK_MS);
  bot.endCurrentScene("media-ended", false);
  await advance(GLOBAL_PAUSE_MS + QUEUE_KICK_MS); // lewati jeda global, PAX-1 masih cooldown 120s

  chat("b", "etalase 1");
  await advance(QUEUE_KICK_MS);
  assert.ok(logs.some((l) => l.startsWith(`[SKIP_COOLDOWN] scene=${PAX1}`)));
  assert.deepEqual(commentedScenes(), [PAX1], "hanya pemutaran pertama yang dikomentari");
});

test("entry antrean tidak valid -> tidak ada AutoComment, antrean tetap lanjut", async () => {
  bot.__test.injectAggregate({ scene: "", rule: null, count: 1, requesters: new Set(), priority: 0 });
  bot.processQueue();
  await advance(QUEUE_KICK_MS);
  assert.deepEqual(commentRequests, []);
  assert.equal(state().busy, false);
});

test("AutoComment melempar sinkron -> playback tetap jalan, AutoPIN tetap dipanggil", async () => {
  bot.__test.setAutoComment({ requestComment(req) { commentRequests.push(req); throw new Error("meledak"); } });
  chat("a", "etalase 3");
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, PAX3);
  assert.equal(state().busy, true);
  assert.deepEqual(pinRequests.map((r) => r.scene), [PAX3]);

  bot.endCurrentScene("media-ended", false);
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, null);
  assert.equal(state().busy, false);
});

test("AutoComment menolak (rejected promise) -> playback tidak terpengaruh", async () => {
  bot.__test.setAutoComment(fakeComment(() => Promise.reject(new Error("transport mati"))));
  chat("a", "etalase 3");
  await advance(QUEUE_KICK_MS);
  await flush();
  assert.equal(state().activeScene, PAX3);
  bot.endCurrentScene("media-ended", false);
  await advance(QUEUE_KICK_MS);
  assert.equal(state().busy, false);
});

test("AutoComment menggantung -> scene berikutnya tetap jalan", async () => {
  bot.__test.setAutoComment(fakeComment(() => new Promise(() => {})));
  chat("a", "etalase 3");
  await advance(QUEUE_KICK_MS);
  chat("b", "etalase 5");
  await advance(QUEUE_KICK_MS);
  bot.endCurrentScene("media-ended", false);
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, PAX5, "komentar yang menggantung tidak boleh menahan antrean");
  assert.deepEqual(commentedScenes(), [PAX3, PAX5]);
});

test("AutoPIN melempar -> AutoComment tetap dipanggil (saudara, bukan bawahan)", async () => {
  bot.__test.setScenePin({ requestPin(req) { pinRequests.push(req); throw new Error("pin meledak"); } });
  chat("a", "etalase 3");
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, PAX3);
  assert.deepEqual(pinRequests.map((r) => r.scene), [PAX3]);
  assert.deepEqual(commentedScenes(), [PAX3]);
});

test("AutoPIN menolak (rejected) -> AutoComment tetap dry-run sukses", async () => {
  bot.__test.setScenePin(fakePin(() => Promise.reject(new Error("service pin mati"))));
  const results = [];
  bot.__test.setAutoComment(fakeComment(async (req) => { const r = { ok: true, dryRun: true }; results.push(r); return r; }));
  chat("a", "etalase 3");
  await advance(QUEUE_KICK_MS);
  await flush();
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
  assert.equal(state().activeScene, PAX3);
});

test("force saat OBS masih memproses -> scene lama tidak pernah dikomentari", async () => {
  deferred.set(PAX3, {});
  chat("a", "etalase 3");
  await advance(QUEUE_KICK_MS);
  assert.deepEqual(commentRequests, []);

  await bot.handleCommand("force");
  await advance(QUEUE_KICK_MS);
  chat("b", "etalase 5");
  await advance(QUEUE_KICK_MS);
  assert.deepEqual(commentedScenes(), [PAX5]);

  deferred.get(PAX3).release();
  await flush();
  // Scene yang sudah di-force tidak pernah benar-benar "mulai" -> tidak dikomentari,
  // dan tidak menghabiskan jatah rate limit.
  assert.deepEqual(commentedScenes(), [PAX5]);
  assert.ok(logs.some((l) => l.startsWith(`[OBS_SWITCH_STALE] scene=${PAX3}`) && l.includes("phase=resolve")));
});

test("media-end, cooldown, dan jalur MAIN tidak berubah dengan hook AutoComment terpasang", async () => {
  chat("a", "etalase 1");
  await advance(QUEUE_KICK_MS);
  bot.obs.emit("MediaInputPlaybackEnded", { inputName: "Media", inputUuid: "u" });
  await advance(QUEUE_KICK_MS);

  assert.ok(logs.some((l) => l === `[PLAYBACK_END] scene=${PAX1} reason=media-ended`));
  assert.deepEqual(state().cooldownScenes, [PAX1]);
  assert.ok(obsSwitches.includes(MAIN));
  assert.equal(state().hasGlobalPauseTimer, true);
  assert.deepEqual(commentedScenes(), [PAX1]);
});


test("force saat OBS memproses, balasan OBS tiba berurutan (PAX-3 sebelum MAIN) -> di-skip dengan active=null", async () => {
  deferred.set(PAX3, {});
  deferred.set(MAIN, {});
  chat("a", "etalase 3");
  await advance(QUEUE_KICK_MS);
  const forcing = bot.handleCommand("force");
  await flush();
  deferred.get(PAX3).release();
  await flush();
  assert.deepEqual(commentedScenes(), []);
  assert.ok(logs.some((l) => l.startsWith(`[OBS_SWITCH_STALE] scene=${PAX3}`) && l.includes("active=null")));
  deferred.get(MAIN).release();
  await forcing;
  await advance(QUEUE_KICK_MS);
  chat("b", "etalase 5");
  await advance(QUEUE_KICK_MS);
  assert.deepEqual(commentedScenes(), [PAX5]);
});

test("balasan OBS lama untuk scene yang sama tidak dikomentari; yang baru membawa hitungan peminta yang benar", async () => {
  deferred.set(PAX3, {});
  chat("a", "etalase 3");                 // pemutaran lama, 1 peminta, balasan tertahan
  await advance(QUEUE_KICK_MS);
  await bot.handleCommand("force all");   // reset; balasan lama MASIH tertahan
  await advance(QUEUE_KICK_MS);
  flood("z", 2, "etalase 3");             // pemutaran baru untuk scene yang sama, 2 peminta
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, PAX3);

  deferred.get(PAX3).release();           // balasan untuk pemutaran LAMA -> basi, bukan generasi yang berlaku
  await flush();
  assert.deepEqual(commentRequests, []);
  assert.ok(logs.some((l) => l.startsWith(`[OBS_SWITCH_STALE] scene=${PAX3}`) && l.includes("phase=resolve")));

  deferred.get(PAX3).release();           // balasan untuk pemutaran BARU
  await flush();
  assert.equal(commentRequests.length, 1);
  assert.equal(commentRequests[0].requesters, 2, "hitungan milik pemutaran yang berlaku");
});

test("cabang durasi manual (waitForMediaEnd=false) juga memanggil kedua saudara", async () => {
  const PAX7 = SCENES.AILIVE_SKUPAXTUJUH;
  bot.__test.injectAggregate({
    scene: PAX7,
    rule: { scene: PAX7, waitForMediaEnd: false, duration: 1_000, mediaInputs: [] },
    count: 1, requesters: new Set(["x"]), priority: 0,
  });
  bot.processQueue();
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, PAX7);
  assert.deepEqual(pinRequests.map((r) => r.scene), [PAX7]);
  assert.deepEqual(commentedScenes(), [PAX7]);
  assert.equal(commentRequests[0].requesters, 1);
  await advance(1_000);
  assert.equal(state().activeScene, null, "durasi manual mengakhiri scene");
});

test("instance AutoComment asli di index.js memakai flag dan batas dari env, bukan nilai tetap", () => {
  const real = bot.__test.autocommentRealState();
  const expected = loadAutoCommentConfig(process.env, { warn: () => {} });
  assert.equal(real.enabled, expected.enabled);
  assert.equal(real.enabled, bot.__test.autocommentEnabled());
  assert.equal(real.maxPerMinute, expected.maxPerMinute);
  assert.equal(real.minIntervalMs, expected.minIntervalMs);
});
