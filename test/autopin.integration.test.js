// Integrasi AutoPIN <-> playback scene, TANPA browser dan TANPA TikTok:
// obs.call di-stub, dispatcher AutoPIN diganti palsu lewat bot.__test.setScenePin.
//
// Yang diuji di sini bukan logika pin-nya (itu di autopin.scenepin.test.js),
// melainkan KAPAN bot memanggilnya dan apakah kegagalannya bisa merusak playback.

const { test, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");

process.env.SCENE_REPLAY_COOLDOWN_MS = "120000";
process.env.DOTENV_CONFIG_QUIET = "true";

const bot = require("../index.js");
const { SCENES } = bot;

const PAX3 = SCENES.AILIVE_SKUPAXTIGA;
const PAX5 = SCENES.AILIVE_SKUPAXLIMA;
const MAIN = SCENES.MAIN;
const QUEUE_KICK_MS = 50;

let logs = [];
let obsSwitches = [];
let failingScenes = new Set();
let deferred = new Map(); // scene -> { resolve }
let pinRequests = [];

const flush = () => new Promise((r) => setImmediate(r));
async function advance(ms) {
  mock.timers.tick(ms);
  await flush();
}
const chat = (user, comment) => bot.handleChat({ nickname: user, comment });
const state = () => bot.__test.getState();
const requestedScenes = () => pinRequests.map((r) => r.scene);

// dispatcher palsu: mencatat panggilan, perilakunya bisa diatur per tes
function fakePin(behaviour = () => ({ ok: true })) {
  return {
    requestPin(req) {
      pinRequests.push(req);
      return behaviour(req);
    },
  };
}

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  logs = [];
  obsSwitches = [];
  failingScenes = new Set();
  deferred = new Map();
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
        deferred.get(scene).release = () => {
          obsSwitches.push(scene);
          resolve();
        };
      });
    }
    obsSwitches.push(scene);
    return Promise.resolve();
  };

  bot.__test.setScenePin(fakePin());
  bot.__test.reset();
});

afterEach(() => {
  bot.__test.reset();
  bot.__test.setScenePin(fakePin());
  mock.timers.reset();
  mock.restoreAll();
});

test("hook AutoPIN terpasang dan bisa dibaca untuk audit", () => {
  assert.equal(typeof bot.__test.autopinEnabled(), "boolean");
  assert.equal(typeof bot.__test.autopinMap(), "object");
});

test("scene PAX mulai sukses -> tepat satu permintaan pin untuk scene itu", async () => {
  chat("a", "etalase 3");
  await advance(QUEUE_KICK_MS);

  assert.equal(state().activeScene, PAX3);
  assert.deepEqual(requestedScenes(), [PAX3]);
  assert.equal(typeof pinRequests[0].playId, "number");
});

test("OBS gagal switch -> tidak ada permintaan pin sama sekali", async () => {
  failingScenes.add(PAX3);
  chat("a", "etalase 3");
  await advance(QUEUE_KICK_MS);

  assert.deepEqual(pinRequests, []);
  assert.equal(state().activeScene, null); // playback dilepas seperti biasa
  assert.equal(state().busy, false);
});

test("permintaan pin baru dikirim SETELAH OBS membalas sukses", async () => {
  deferred.set(PAX3, {});
  chat("a", "etalase 3");
  await advance(QUEUE_KICK_MS);

  assert.deepEqual(pinRequests, [], "belum boleh pin selagi OBS masih memproses");

  deferred.get(PAX3).release();
  await flush();
  assert.deepEqual(requestedScenes(), [PAX3]);
});

test("kembali ke MAIN setelah antrean habis -> tidak ada pin", async () => {
  chat("a", "etalase 3");
  await advance(QUEUE_KICK_MS);
  bot.endCurrentScene("media-ended", false);
  await advance(QUEUE_KICK_MS);

  assert.ok(obsSwitches.includes(MAIN));
  assert.deepEqual(requestedScenes(), [PAX3]); // MAIN tidak menambah permintaan
});

test("komentar berulang untuk scene yang sedang aktif -> tidak ada pin kedua", async () => {
  chat("a", "etalase 3");
  await advance(QUEUE_KICK_MS);
  for (let i = 0; i < 30; i++) chat(`u${i}`, "etalase 3");
  await advance(QUEUE_KICK_MS);

  assert.deepEqual(requestedScenes(), [PAX3]);
});

test("PAX-5 antre selagi PAX-3 tayang -> belum dipin; dipin saat gilirannya mulai", async () => {
  chat("a", "etalase 3");
  await advance(QUEUE_KICK_MS);
  chat("b", "etalase 5");
  await advance(QUEUE_KICK_MS);

  assert.equal(state().activeScene, PAX3);
  assert.deepEqual(requestedScenes(), [PAX3], "scene yang masih antre tidak boleh dipin");

  bot.endCurrentScene("media-ended", false);
  await advance(QUEUE_KICK_MS);

  assert.equal(state().activeScene, PAX5);
  assert.deepEqual(requestedScenes(), [PAX3, PAX5]);
});

test("AutoPIN melempar sinkron -> playback tetap jalan dan tetap bisa diselesaikan", async () => {
  bot.__test.setScenePin({
    requestPin(req) {
      pinRequests.push(req);
      throw new Error("dispatcher meledak");
    },
  });

  chat("a", "etalase 3");
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, PAX3);
  assert.equal(state().busy, true);

  bot.endCurrentScene("media-ended", false);
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, null);
  assert.equal(state().busy, false);
});

test("AutoPIN mengembalikan promise reject -> playback tidak terpengaruh", async () => {
  bot.__test.setScenePin(fakePin(() => Promise.reject(new Error("service mati"))));

  chat("a", "etalase 3");
  await advance(QUEUE_KICK_MS);
  await flush();

  assert.equal(state().activeScene, PAX3);
  bot.endCurrentScene("media-ended", false);
  await advance(QUEUE_KICK_MS);
  assert.equal(state().busy, false);
});

test("AutoPIN menggantung -> scene berikutnya tetap jalan", async () => {
  bot.__test.setScenePin(fakePin(() => new Promise(() => {})));

  chat("a", "etalase 3");
  await advance(QUEUE_KICK_MS);
  chat("b", "etalase 5");
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, PAX3);

  bot.endCurrentScene("media-ended", false);
  await advance(QUEUE_KICK_MS);

  assert.equal(state().activeScene, PAX5, "pin yang menggantung tidak boleh menahan antrean");
  assert.deepEqual(requestedScenes(), [PAX3, PAX5]);
});

test("force saat OBS masih memproses -> scene lama membawa playId lebih kecil dari scene baru", async () => {
  deferred.set(PAX3, {});
  chat("a", "etalase 3");
  await advance(QUEUE_KICK_MS);
  assert.deepEqual(pinRequests, []);

  await bot.handleCommand("force"); // operator menyalip sebelum OBS balas
  await advance(QUEUE_KICK_MS);

  chat("b", "etalase 5");
  await advance(QUEUE_KICK_MS);
  assert.deepEqual(requestedScenes(), [PAX5]);

  deferred.get(PAX3).release(); // balasan OBS lama baru datang sekarang
  await flush();

  assert.deepEqual(requestedScenes(), [PAX5, PAX3]);
  const p5 = pinRequests.find((r) => r.scene === PAX5).playId;
  const p3 = pinRequests.find((r) => r.scene === PAX3).playId;
  assert.ok(p3 < p5, `playId scene lama (${p3}) harus lebih kecil dari scene baru (${p5})`);
});

test("entry antrean tidak valid -> tidak ada pin, antrean tetap lanjut", async () => {
  bot.__test.injectAggregate({ scene: "", rule: null, count: 1, requesters: new Set(), priority: 0 });
  bot.processQueue();
  await advance(QUEUE_KICK_MS);

  assert.deepEqual(pinRequests, []);
  assert.equal(state().busy, false);
});
