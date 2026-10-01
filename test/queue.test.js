// Deterministic tests for the scene queue / replay-cooldown logic in index.js.
// No TikTok or OBS connection: index.js only connects when run directly,
// and obs.call is stubbed below. Timers + Date are faked via node:test.

const { test, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");

process.env.SCENE_REPLAY_COOLDOWN_MS = "120000";
process.env.DOTENV_CONFIG_QUIET = "true";

const bot = require("../index.js");

const { SCENES, RULES, SCENE_REPLAY_COOLDOWN_MS } = bot;
const PAX1 = SCENES.AILIVE_SKUPAXSATU;
const PAX2 = SCENES.AILIVE_SKUPAXDUA;
const PAX3 = SCENES.AILIVE_SKUPAXTIGA;
const PAX8 = SCENES.AILIVE_SKUPAXDELAPAN;
const GLOBAL_PAUSE_MS = 60_000; // COOLDOWN_MS default in index.js
const QUEUE_KICK_MS = 50; // enqueueTrigger / endCurrentScene processing delay

const ruleFor = scene => RULES.find(r => r.scene === scene);

let logs = [];
let obsSwitches = [];
let failingScenes = new Set();

const flush = () => new Promise(resolve => setImmediate(resolve));

async function advance(ms) {
  mock.timers.tick(ms);
  await flush();
}

function chat(user, comment) {
  bot.handleChat({ nickname: user, comment });
}

function flood(prefix, count, comment) {
  for (let i = 0; i < count; i++) chat(`${prefix}${i}`, comment);
}

const state = () => bot.__test.getState();
const countLogs = tag => logs.filter(l => l.startsWith(`[${tag}]`)).length;
const switchesTo = scene => obsSwitches.filter(s => s === scene).length;

// request a scene once and let it start playing
async function playNow(user, comment, expectedScene) {
  chat(user, comment);
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, expectedScene);
}

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  logs = [];
  obsSwitches = [];
  failingScenes = new Set();
  const capture = (...args) => logs.push(args.map(String).join(" "));
  mock.method(console, "log", capture);
  mock.method(console, "warn", capture);
  mock.method(console, "error", capture);
  bot.obs.call = async (request, params = {}) => {
    if (request !== "SetCurrentProgramScene") return;
    if (failingScenes.has(params.sceneName)) throw new Error("No source was found");
    obsSwitches.push(params.sceneName);
  };
  bot.__test.reset();
});

afterEach(() => {
  bot.__test.reset();
  mock.timers.reset();
  mock.restoreAll();
});

test("config: replay cooldown read from SCENE_REPLAY_COOLDOWN_MS", () => {
  assert.equal(SCENE_REPLAY_COOLDOWN_MS, 120_000);
});

test("A: 50 rapid PAX1 requests aggregate into exactly one queue entry", () => {
  flood("a", 50, "etalase 1");

  assert.deepEqual(state().queue, [{ scene: PAX1, count: 50 }]);
  assert.equal(countLogs("MATCH"), 50);
  assert.equal(countLogs("QUEUE"), 1);
  assert.equal(countLogs("AGGREGATE"), 49);
});

test("B: while PAX1 is active, 50 more requests never queue a second PAX1", async () => {
  flood("a", 50, "etalase 1");
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, PAX1);
  assert.equal(countLogs("PLAY"), 1);

  flood("b", 50, "etalase 1");

  assert.deepEqual(state().queue, []);
  assert.equal(countLogs("SKIP_ACTIVE"), 50);
  assert.equal(state().activeScene, PAX1);
  assert.equal(switchesTo(PAX1), 1);
});

test("C: after PAX1 completes, requests during its cooldown are skipped (even after the 60s global pause)", async () => {
  await playNow("a0", "etalase 1", PAX1);

  await advance(ruleFor(PAX1).duration); // fallback timer = playback end
  assert.equal(state().activeScene, null);
  assert.equal(countLogs("PLAYBACK_END"), 1);
  assert.ok(logs.includes(`[COOLDOWN_START] scene=${PAX1} duration=120000`));
  assert.deepEqual(state().cooldownScenes, [PAX1]);

  flood("c", 50, "etalase 1");
  assert.deepEqual(state().queue, []);
  assert.equal(countLogs("SKIP_COOLDOWN"), 50);
  assert.ok(logs.includes(`[SKIP_COOLDOWN] scene=${PAX1} remaining=120000`));

  // the original bug: global pause ends, flood is still running → PAX1 replayed
  await advance(GLOBAL_PAUSE_MS);
  flood("d", 50, "etalase 1");
  await advance(QUEUE_KICK_MS);

  assert.deepEqual(state().queue, []);
  assert.equal(state().activeScene, null);
  assert.ok(logs.some(l => l.startsWith(`[SKIP_COOLDOWN] scene=${PAX1} remaining=60000`)));
  assert.equal(switchesTo(PAX1), 1);
});

test("D: PAX1 cooldown does not block PAX2", async () => {
  await playNow("a0", "etalase 1", PAX1);
  await advance(ruleFor(PAX1).duration);

  chat("p2", "etalase 2");
  assert.deepEqual(state().queue, [{ scene: PAX2, count: 1 }]);

  await advance(GLOBAL_PAUSE_MS); // existing global pause still applies
  assert.equal(state().activeScene, PAX2);
  assert.equal(switchesTo(PAX2), 1);
  assert.deepEqual(state().cooldownScenes, [PAX1]);
});

test("E: once the cooldown expires, PAX1 can be queued and played again", async () => {
  await playNow("a0", "etalase 1", PAX1);
  await advance(ruleFor(PAX1).duration);
  await advance(SCENE_REPLAY_COOLDOWN_MS);

  chat("e0", "etalase 1");

  assert.deepEqual(state().queue, [{ scene: PAX1, count: 1 }]);
  assert.deepEqual(state().cooldownScenes, [], "expired cooldown entry is removed when checked");
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, PAX1);
  assert.equal(switchesTo(PAX1), 2);
});

test("F: PAX1 waiting > 5s in the queue still gets no second entry", async () => {
  await playNow("p2", "etalase 2", PAX2);

  chat("f0", "etalase 1");
  await advance(6_000); // outside the 5s aggregation window
  flood("g", 10, "etalase 1");

  assert.deepEqual(state().queue, [{ scene: PAX1, count: 11 }]);
  assert.equal(countLogs("SKIP_QUEUED"), 1);
  assert.equal(countLogs("AGGREGATE"), 9);

  // PAX2 ends → PAX1 plays exactly once, then the queue drains
  await advance(ruleFor(PAX2).duration);
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, PAX1);
  await advance(ruleFor(PAX1).duration);
  await advance(GLOBAL_PAUSE_MS + QUEUE_KICK_MS);

  assert.equal(switchesTo(PAX1), 1);
  assert.equal(state().busy, false);
  assert.equal(countLogs("PLAY_FAILED"), 0);
});

test("G1: a rule with an undefined scene is rejected and never makes the bot busy", async () => {
  bot.enqueueTrigger({ scene: undefined, keywords: [], mediaInputs: [] }, "x");
  await advance(QUEUE_KICK_MS);

  assert.deepEqual(state().queue, []);
  assert.equal(state().busy, false);
  assert.equal(countLogs("INVALID_SCENE"), 1);
});

test("G2: an invalid entry already in the queue is dropped and the next entry plays", async () => {
  bot.__test.injectAggregate({ scene: undefined, rule: { scene: undefined }, count: 1, requesters: new Set(), priority: 0 });
  chat("p2", "etalase 2");
  await advance(QUEUE_KICK_MS);

  assert.equal(countLogs("INVALID_SCENE"), 1);
  assert.equal(state().activeScene, PAX2);
  assert.deepEqual(state().queue, []);
});

test("G3: an OBS switch failure releases busy/activeScene and the bot keeps working", async () => {
  failingScenes.add(PAX3);
  chat("p3", "etalase 3");
  await advance(QUEUE_KICK_MS);

  assert.equal(countLogs("PLAY_FAILED"), 1);
  assert.equal(state().busy, false);
  assert.equal(state().activeScene, null);

  await playNow("p2", "etalase 2", PAX2);
});

test("H: Etalase 8 resolves to a valid PAX8 scene and plays", async () => {
  assert.equal(typeof PAX8, "string");
  const sceneNames = new Set(Object.values(SCENES));
  for (const rule of RULES) {
    assert.ok(sceneNames.has(rule.scene), `rule scene not defined in SCENES: ${rule.scene}`);
  }

  await playNow("p8", "etalase 8", PAX8);
  assert.ok(logs.includes(`[MATCH] scene=${PAX8} user=p8 via=keyword`));
});

test("I: force releases the active scene, starts its cooldown and keeps the bot usable", async () => {
  await playNow("a0", "etalase 1", PAX1);

  await bot.handleCommand("force");

  assert.equal(state().activeScene, null);
  assert.equal(state().busy, false);
  assert.equal(state().lastScene, SCENES.MAIN);
  assert.deepEqual(state().cooldownScenes, [PAX1]);
  assert.ok(logs.includes(`[PLAYBACK_END] scene=${PAX1} reason=force`));

  chat("i0", "etalase 1");
  assert.equal(countLogs("SKIP_COOLDOWN"), 1);
  await playNow("p2", "etalase 2", PAX2);
});

test("I2: force during the global pause cancels it (no overlap with the next scene)", async () => {
  await playNow("a0", "etalase 1", PAX1);
  await advance(ruleFor(PAX1).duration); // global 60s pause starts
  chat("p2", "etalase 2");
  await advance(10_000);

  await bot.handleCommand("force");
  assert.equal(state().activeScene, PAX2);
  assert.equal(state().hasGlobalPauseTimer, false);

  // the old pause timer would have fired here and released busy mid-PAX2
  await advance(GLOBAL_PAUSE_MS - 10_000);
  assert.equal(state().busy, true);
  assert.equal(state().activeScene, PAX2);
});

test("J: force all resets queue, active scene, playedScenes and cooldowns", async () => {
  await playNow("a0", "etalase 1", PAX1);
  await advance(ruleFor(PAX1).duration);
  await advance(GLOBAL_PAUSE_MS);
  await playNow("p2", "etalase 2", PAX2);
  chat("p3", "etalase 3");

  assert.equal(state().activeScene, PAX2);
  assert.deepEqual(state().queue, [{ scene: PAX3, count: 1 }]);
  assert.deepEqual(state().cooldownScenes, [PAX1]);
  assert.deepEqual(state().playedScenes, [PAX2]);

  await bot.handleCommand("force all");

  assert.deepEqual(state(), {
    busy: false,
    activeScene: null,
    lastScene: SCENES.MAIN,
    queue: [],
    playedScenes: [],
    cooldownScenes: [],
    hasGlobalPauseTimer: false,
  });

  chat("j0", "etalase 1");
  assert.deepEqual(state().queue, [{ scene: PAX1, count: 1 }]);
});

test("existing per-user anti-spam still drops a user's repeated identical message", () => {
  chat("spammer", "etalase 1");
  chat("spammer", "etalase 1");
  chat("spammer", "etalase 1");

  assert.equal(countLogs("MATCH"), 2);
  assert.ok(logs.some(l => l.includes("Flood detected from spammer")));
});
