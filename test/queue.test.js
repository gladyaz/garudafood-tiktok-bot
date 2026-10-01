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
  // Pakai PAX8: failsafe-nya (77s) lebih panjang dari global pause 60s, sehingga scene masih
  // berjalan saat timer pause lama seharusnya menyala. Jangan pakai scene yang failsafe-nya
  // lebih pendek dari GLOBAL_PAUSE_MS - scene akan berakhir wajar dan test jadi tidak bermakna.
  assert.ok(
    ruleFor(PAX8).duration > GLOBAL_PAUSE_MS,
    "test ini butuh scene dengan failsafe > GLOBAL_PAUSE_MS"
  );

  await playNow("a0", "etalase 1", PAX1);
  await advance(ruleFor(PAX1).duration); // global 60s pause starts
  chat("p8", "etalase 8");
  await advance(10_000);

  await bot.handleCommand("force");
  assert.equal(state().activeScene, PAX8);
  assert.equal(state().hasGlobalPauseTimer, false);

  // the old pause timer would have fired here and released busy mid-PAX8
  await advance(GLOBAL_PAUSE_MS - 10_000);
  assert.equal(state().busy, true);
  assert.equal(state().activeScene, PAX8);
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

// --- FAQ routing sementara dimatikan (scene-nya belum ada di OBS) ---

const FAQ_SCENES = [
  SCENES.AILIVE_FAQ_STOKHABIS,
  SCENES.AILIVE_FAQ_CO,
  SCENES.AILIVE_FAQ_ORDER,
  SCENES.AILIVE_FAQ_ORIGINALEXPIRED,
];

// Komentar yang sebelumnya cocok ke salah satu rule FAQ (keyword persis).
const FAQ_COMMENTS = [
  "stok",
  "ada",
  "ready",
  "habis",
  "kosong",
  "co",
  "checkout",
  "sudah co",
  "resi",
  "cod",
  "ongkir",
  "kirim",
  "packing",
  "lokasi",
  "ori",
  "original",
  "expired",
  "halal",
  "rasa",
];

test("FAQ: keempat rule FAQ ditandai disabled tapi definisi + keyword tetap ada", () => {
  for (const scene of FAQ_SCENES) {
    const rule = ruleFor(scene);
    assert.ok(rule, `rule untuk ${scene} harus tetap ada di RULES`);
    assert.equal(rule.enabled, false);
    assert.ok(Array.isArray(rule.keywords) && rule.keywords.length > 0);
  }

  const activeScenes = bot.activeRules().map(r => r.scene);
  for (const scene of FAQ_SCENES) {
    assert.ok(!activeScenes.includes(scene), `${scene} tidak boleh ikut routing`);
  }
});

test("FAQ: komentar FAQ tidak lagi match, tidak antre, dan tidak switch scene di OBS", async () => {
  for (const comment of FAQ_COMMENTS) {
    bot.__test.reset();
    logs = [];
    obsSwitches = [];

    chat("u", comment);
    await advance(QUEUE_KICK_MS);

    assert.equal(countLogs("MATCH"), 0, `"${comment}" seharusnya tidak match rule apa pun`);
    assert.deepEqual(state().queue, [], `"${comment}" seharusnya tidak masuk antrean`);
    assert.equal(state().activeScene, null, `"${comment}" seharusnya tidak mengaktifkan scene`);
    assert.deepEqual(obsSwitches, [], `"${comment}" seharusnya tidak memicu switch OBS`);
  }
});

test("FAQ: tidak ada komentar FAQ yang nyasar ke scene PAX lewat fuzzy", async () => {
  for (const comment of FAQ_COMMENTS) {
    bot.__test.reset();
    obsSwitches = [];

    chat("u", comment);
    await advance(QUEUE_KICK_MS);

    assert.deepEqual(obsSwitches, [], `"${comment}" tidak boleh memicu scene PAX`);
  }
});

test("FAQ: routing produk PAX1-PAX10 tetap jalan walau FAQ dimatikan", async () => {
  const activeScenes = bot.activeRules().map(r => r.scene);
  const paxScenes = [
    SCENES.AILIVE_SKUPAXSATU, SCENES.AILIVE_SKUPAXDUA, SCENES.AILIVE_SKUPAXTIGA,
    SCENES.AILIVE_SKUPAXEMPAT, SCENES.AILIVE_SKUPAXLIMA, SCENES.AILIVE_SKUPAXENAM,
    SCENES.AILIVE_SKUPAXTUJUH, SCENES.AILIVE_SKUPAXDELAPAN, SCENES.AILIVE_SKUPAXSEMBILAN,
    SCENES.AILIVE_SKUPAXSEPULUH,
  ];
  for (const scene of paxScenes) {
    assert.ok(activeScenes.includes(scene), `${scene} harus tetap aktif`);
  }

  await playNow("u", "etalase 1", PAX1);
  assert.deepEqual(obsSwitches, [PAX1]);
});

test("FAQ: cukup set enabled:true untuk mengaktifkan routing FAQ kembali", async () => {
  const rule = ruleFor(SCENES.AILIVE_FAQ_CO);
  rule.enabled = true;
  try {
    chat("u", "checkout");
    await advance(QUEUE_KICK_MS);

    assert.equal(countLogs("MATCH"), 1);
    assert.equal(state().activeScene, SCENES.AILIVE_FAQ_CO);
  } finally {
    rule.enabled = false;
  }
});

// --- Deteksi media-end nyata (MediaInputPlaybackEnded) ---
// obs-websocket-js 5.0.7 hanya mengirim event ini; nama event lama tidak pernah ada,
// sehingga sebelum perbaikan setiap scene selalu diakhiri fallback timer.

const mediaEnd = inputName => bot.obs.emit("MediaInputPlaybackEnded", { inputName, inputUuid: "uuid-" + inputName });
const inputOf = scene => ruleFor(scene).mediaInputs[0];

test("MEDIA: nama input di rule sama dengan nama input di OBS (PAX-N.mp4)", () => {
  for (let n = 1; n <= 10; n++) {
    const scene = SCENES[`AILIVE_SKUPAX${["SATU","DUA","TIGA","EMPAT","LIMA","ENAM","TUJUH","DELAPAN","SEMBILAN","SEPULUH"][n - 1]}`];
    assert.deepEqual(ruleFor(scene).mediaInputs, [`PAX-${n}.mp4`]);
  }
});

test("MEDIA: media-end mengakhiri scene dengan reason=media-ended, bukan fallback", async () => {
  await playNow("u", "etalase 1", PAX1);
  assert.equal(inputOf(PAX1), "PAX-1.mp4");

  mediaEnd("PAX-1.mp4");
  await flush();

  assert.ok(logs.some(l => l === "[MEDIA_END] input=PAX-1.mp4"), "harus ada log [MEDIA_END]");
  assert.ok(logs.some(l => l === `[PLAYBACK_END] scene=${PAX1} reason=media-ended`), "harus berakhir karena media-ended");
  assert.ok(!logs.some(l => l.includes("media-fallback")), "fallback tidak boleh ikut menyala");
  assert.equal(state().activeScene, null);
  assert.deepEqual(state().cooldownScenes, [PAX1]);
});

test("MEDIA: setelah media-end, fallback lama tidak mengakhiri scene berikutnya", async () => {
  await playNow("u", "etalase 1", PAX1);
  chat("v", "etalase 8");
  assert.deepEqual(state().queue, [{ scene: PAX8, count: 1 }]);

  mediaEnd("PAX-1.mp4");
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, PAX8);

  // lewati titik waktu di mana fallback PAX1 dulu akan menyala
  await advance(ruleFor(PAX1).duration);
  assert.equal(state().activeScene, PAX8, "PAX8 tidak boleh diakhiri oleh fallback milik PAX1");
  assert.equal(countLogs("PLAYBACK_END"), 1);
});

test("MEDIA: event dari input lain tidak mengakhiri scene yang sedang jalan", async () => {
  await playNow("u", "etalase 1", PAX1);

  mediaEnd("MAIN.mp4");      // video idle di scene MAIN
  mediaEnd("PAX-7.mp4");     // scene lain yang tidak sedang diputar
  await flush();

  assert.equal(state().activeScene, PAX1);
  assert.equal(countLogs("PLAYBACK_END"), 0);
  assert.ok(!logs.some(l => l.startsWith("[MEDIA_END]")), "input yang tidak ditunggu tidak boleh dicatat");
});

test("MEDIA: event ganda untuk input yang sama hanya menyelesaikan scene sekali", async () => {
  await playNow("u", "etalase 1", PAX1);

  mediaEnd("PAX-1.mp4");
  mediaEnd("PAX-1.mp4");
  mediaEnd("PAX-1.mp4");
  await flush();

  assert.equal(countLogs("PLAYBACK_END"), 1);
  assert.equal(countLogs("COOLDOWN_START"), 1);
  assert.equal(logs.filter(l => l === "[MEDIA_END] input=PAX-1.mp4").length, 1);
});

test("MEDIA: fallback tetap jadi jaring aman kalau event media tidak pernah datang", async () => {
  await playNow("u", "etalase 1", PAX1);

  await advance(ruleFor(PAX1).duration);

  assert.ok(logs.some(l => l.includes("media-fallback")), "fallback harus menyala kalau tidak ada event");
  assert.equal(state().activeScene, null);
  assert.deepEqual(state().cooldownScenes, [PAX1]);
});

test("MEDIA: setiap failsafe lebih panjang dari durasi video aslinya", () => {
  // durasi video nyata (ffprobe) -> failsafe harus di atas ini, bukan memotong video
  const REAL_MS = { 1: 40438, 2: 40250, 3: 46231, 4: 63960, 5: 52887, 6: 42903, 7: 56684, 8: 71640, 9: 52000, 10: 65880 };
  const KEYS = ["SATU","DUA","TIGA","EMPAT","LIMA","ENAM","TUJUH","DELAPAN","SEMBILAN","SEPULUH"];
  for (let n = 1; n <= 10; n++) {
    const rule = ruleFor(SCENES[`AILIVE_SKUPAX${KEYS[n - 1]}`]);
    assert.ok(
      rule.duration > REAL_MS[n],
      `PAX-${n}: failsafe ${rule.duration}ms harus > durasi video ${REAL_MS[n]}ms`
    );
  }
});

// --- Alias numerik: "etalase 10" tidak boleh lagi match PAX-1 (substring) ---

const PAX4 = SCENES.AILIVE_SKUPAXEMPAT;
const PAX10 = SCENES.AILIVE_SKUPAXSEPULUH;
let matchSeq = 0;

// Scene yang dipilih tahap matching untuk sebuah komentar (null kalau tidak match).
const matchedScene = comment => {
  bot.__test.reset();
  logs = [];
  chat("mu" + ++matchSeq, comment); // nickname unik supaya anti-spam tidak ikut campur
  const line = logs.find(l => l.startsWith("[MATCH] scene="));
  return line ? line.split("scene=")[1].split(" ")[0] : null;
};

test("NUMERIK: containsPhrase mencocokkan pada batas kata, bukan substring", () => {
  assert.equal(bot.containsPhrase("etalase 10", "etalase 1"), false);
  assert.equal(bot.containsPhrase("etalase 10", "etalase 10"), true);
  assert.equal(bot.containsPhrase("spill etalase 10 dong", "etalase 10"), true);
  assert.equal(bot.containsPhrase("spill etalase 1 dong", "etalase 1"), true);
  assert.equal(bot.containsPhrase("etalase 1", "etalase 10"), false);
  assert.equal(bot.containsPhrase("etalase 1", ""), false);
});

test("NUMERIK: semua pasangan 1 vs 10 diarahkan ke scene yang benar", () => {
  const pairs = [
    ["etalase 1", PAX1], ["etalase 10", PAX10],
    ["et 1", PAX1], ["et 10", PAX10],
    ["no 1", PAX1], ["no 10", PAX10],
    ["nomor 1", PAX1], ["nomor 10", PAX10],
    ["paket 1", PAX1], ["paket 10", PAX10],
    ["produk 1", PAX1], ["produk 10", PAX10],
  ];
  for (const [comment, expected] of pairs) {
    assert.equal(matchedScene(comment), expected, `"${comment}" harus -> ${expected}`);
  }
});

test("NUMERIK: varian spill dan angka-kata juga benar", () => {
  const cases = [
    ["spill etalase 1", PAX1],
    ["spill etalase 10", PAX10],
    ["etalase satu", PAX1],
    ["etalase sepuluh", PAX10],
    ["paket sepuluh", PAX10],
    ["produk sepuluh", PAX10],
  ];
  for (const [comment, expected] of cases) {
    assert.equal(matchedScene(comment), expected, `"${comment}" harus -> ${expected}`);
  }
});

test("NUMERIK: angka 2-9 tidak terpengaruh perubahan ini", () => {
  const expect = {
    2: SCENES.AILIVE_SKUPAXDUA, 3: SCENES.AILIVE_SKUPAXTIGA, 4: PAX4,
    5: SCENES.AILIVE_SKUPAXLIMA, 6: SCENES.AILIVE_SKUPAXENAM, 7: SCENES.AILIVE_SKUPAXTUJUH,
    8: PAX8, 9: SCENES.AILIVE_SKUPAXSEMBILAN,
  };
  for (const prefix of ["etalase", "et", "no", "nomor", "paket", "produk"]) {
    for (const n of [2, 3, 4, 5, 6, 7, 8, 9]) {
      assert.equal(matchedScene(`${prefix} ${n}`), expect[n], `"${prefix} ${n}"`);
    }
  }
});

test("NUMERIK: setiap rule PAX punya keenam alias numerik (cegah celah seperti 'produk 10')", () => {
  const KEYS = ["SATU","DUA","TIGA","EMPAT","LIMA","ENAM","TUJUH","DELAPAN","SEMBILAN","SEPULUH"];
  for (let n = 1; n <= 10; n++) {
    const rule = ruleFor(SCENES[`AILIVE_SKUPAX${KEYS[n - 1]}`]);
    for (const prefix of ["etalase", "et", "no", "nomor", "paket", "produk"]) {
      assert.ok(
        rule.keywords.includes(`${prefix} ${n}`),
        `PAX-${n} kehilangan alias "${prefix} ${n}" - tanpa ini fuzzy bisa salah arah`
      );
    }
  }
});

test("NUMERIK: keyword nama produk tetap jalan (tidak jadi korban batas kata)", () => {
  assert.equal(matchedScene("ting ting"), PAX1);
  assert.equal(matchedScene("garuda ting ting pouch"), PAX1);
  assert.equal(matchedScene("gery potato cracker"), SCENES.AILIVE_SKUPAXDUA);
  assert.equal(matchedScene("big sharing pack"), PAX10);
  assert.equal(matchedScene("everyday snack mix"), SCENES.AILIVE_SKUPAXSEMBILAN);
});
