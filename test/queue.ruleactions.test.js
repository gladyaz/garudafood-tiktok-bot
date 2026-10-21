// Eksekusi aksi per-aturan di jalur yang SUNGGUHAN: enqueueTrigger -> antrean ->
// switch scene -> auxiliary, lewat index.js yang sama dengan produksi.
//
// obs.call di-stub; kedua dispatcher diganti palsu. Nol TikTok, nol OBS, nol
// browser, nol jaringan. Yang diuji bukan "apakah fungsinya dipanggil", tapi
// apa yang TIDAK terjadi karena sebuah aksi mati — dan apakah jalur playback
// tetap utuh di sekitarnya.

const { test, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");

process.env.SCENE_REPLAY_COOLDOWN_MS = "120000";
process.env.DOTENV_CONFIG_QUIET = "true";

const bot = require("../index.js");
const { SCENES, RULES } = bot;

const PAX1 = SCENES.AILIVE_SKUPAXSATU;
const QUEUE_KICK_MS = 50;
const COOLDOWN_MS = 120_000;
const base = (scene) => RULES.find((r) => r.scene === scene);

const PIN_REAL = { ok: true, reason: "pinned", clicked: true, state: "Unpin", title: "Produk Uji" };

let logs = [];
let obsSwitches = [];
let order = [];
let pinCalls = [];
let commentCalls = [];

const flush = () => new Promise((r) => setImmediate(r));
async function advance(ms) {
  mock.timers.tick(ms);
  await flush();
  await flush(); // rantai pin -> comment butuh satu giliran microtask ekstra
}
const state = () => bot.__test.getState();
const logged = (tag) => logs.filter((l) => l.includes("[" + tag + "]"));

// Aturan dengan aksi yang dinyatakan. Detail pemutarannya diambil dari RULES
// yang sungguhan, supaya jalur playback-nya sama persis dengan produksi.
function sceneRule(actions, extra = {}) {
  const b = base(PAX1);
  return Object.assign({}, b, { key: PAX1, actions }, extra);
}

// Aturan tanpa scene: bentuk yang dihasilkan runtime/mappings.js untuk aturan
// yang mematikan "Ganti scene".
function keyRule(actions, key = "#rule-7") {
  return { scene: "", key, actions, keywords: ["tanya harga"] };
}

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  logs = []; obsSwitches = []; order = []; pinCalls = []; commentCalls = [];
  const capture = (...a) => logs.push(a.map(String).join(" "));
  mock.method(console, "log", capture);
  mock.method(console, "warn", capture);
  mock.method(console, "error", capture);

  bot.obs.call = (request, params = {}) => {
    if (request !== "SetCurrentProgramScene") return Promise.resolve();
    obsSwitches.push(params.sceneName);
    return Promise.resolve();
  };

  // Gerbang kelayakan produk DIMATIKAN untuk berkas ini: yang diuji di sini
  // adalah antrean/pemutaran, bukan ketersediaan produk di etalase LIVE.
  // Ketersediaan punya berkasnya sendiri (controller.productavailability).
  bot.__test.setProductEligibility(() => Promise.resolve({ ok: true, reason: null }));
  bot.__test.setScenePin({
    requestPin(req) {
      order.push("pin:" + req.scene);
      pinCalls.push(req);
      return Promise.resolve(PIN_REAL);
    },
  });
  bot.__test.setAutoComment({
    requestComment(req) {
      order.push("comment:" + req.scene);
      commentCalls.push(req);
      return Promise.resolve({ ok: true });
    },
  });
  bot.__test.reset();
});

afterEach(() => {
  bot.__test.reset();
  bot.__test.setScenePin({ requestPin: () => Promise.resolve({ ok: false, reason: "test-noop" }) });
  bot.__test.setAutoComment({ requestComment: () => Promise.resolve({ ok: false, reason: "test-noop" }) });
  mock.timers.reset();
  mock.restoreAll();
});

// --- aturan lengkap: HARUS identik dengan v0.1.1 ----------------------------

test("LEGACY: rule tanpa field actions berperilaku scene + pin + reply", () => {
  // Jalur yang dipakai `node index.js` dan seluruh tes yang sudah ada. Rule dari
  // RULES tidak punya actions sama sekali.
  bot.enqueueTrigger(base(PAX1), "penonton");
  return advance(QUEUE_KICK_MS).then(() => {
    assert.deepEqual(obsSwitches, [PAX1]);
    assert.deepEqual(order, ["pin:" + PAX1, "comment:" + PAX1]);
    assert.equal(pinCalls[0].scene, PAX1);
    assert.equal(commentCalls[0].scene, PAX1);
    assert.deepEqual(commentCalls[0].pin, PIN_REAL);
    assert.equal(commentCalls[0].playId, pinCalls[0].playId, "korelasi playId tidak berubah");
  });
});

test("FULL ACTION: ketiganya menyala identik dengan rantai PAX yang sudah ada", async () => {
  bot.enqueueTrigger(sceneRule({ switchScene: true, autoPin: true, autoReply: true }), "penonton");
  await advance(QUEUE_KICK_MS);
  assert.deepEqual(obsSwitches, [PAX1]);
  assert.deepEqual(order, ["pin:" + PAX1, "comment:" + PAX1]);
  // requirePin TIDAK dimatikan untuk aturan yang mem-pin: bukti pin tetap
  // dituntut persis seperti sebelumnya.
  assert.equal(commentCalls[0].requirePin, true);
  assert.equal(state().activeScene, PAX1);
  assert.equal(state().busy, true);
});

// --- FAQ: scene + reply, tanpa pin ------------------------------------------

test("FAQ: scene berganti dan balasan terkirim, TANPA satu pun percobaan pin", async () => {
  bot.enqueueTrigger(sceneRule({ switchScene: true, autoPin: false, autoReply: true }), "penonton");
  await advance(QUEUE_KICK_MS);

  assert.deepEqual(obsSwitches, [PAX1], "scene tetap berganti");
  assert.deepEqual(order, ["comment:" + PAX1], "pin tidak pernah dipanggil");
  assert.equal(pinCalls.length, 0);
  assert.equal(commentCalls.length, 1);
});

test("FAQ: tidak ada kebisingan pin di log — tidak ada gagal, tidak ada product-not-found", async () => {
  // Inti §10. Aksi yang mati tidak boleh terlihat sebagai kegagalan di Activity,
  // dan satu-satunya sumber Activity adalah baris log ini.
  bot.enqueueTrigger(sceneRule({ switchScene: true, autoPin: false, autoReply: true }), "penonton");
  await advance(QUEUE_KICK_MS);

  assert.deepEqual(logged("AUTOPIN_FAILED"), []);
  assert.deepEqual(logged("AUTOPIN_SUCCESS"), []);
  assert.deepEqual(logged("AUTOPIN_REQUEST"), []);
  const raw = logs.join("\n");
  assert.ok(!raw.includes("product-not-found"), raw);
});

test("FAQ: Activity feed hanya memuat langkah yang SUNGGUH terjadi", async () => {
  // Diperiksa lewat parser Activity yang sungguhan, bukan dengan menebak dari
  // baris log. Feed inilah yang dibaca operator saat LIVE; satu langkah pin
  // palsu di sana adalah pernyataan yang salah tentang apa yang dilakukan bot.
  const { parseLine } = require("../controller/activity");

  bot.enqueueTrigger(sceneRule({ switchScene: true, autoPin: false, autoReply: true }), "penonton");
  await advance(QUEUE_KICK_MS);
  // Scene-nya diselesaikan supaya PLAYBACK_END ikut terbentuk.
  bot.endCurrentScene("test", false);

  const feed = logs.map((l) => parseLine(l)).filter(Boolean);
  const types = feed.map((e) => e.type);
  assert.ok(types.includes("PLAY"), types.join(","));
  assert.ok(types.includes("PLAYBACK_END"), types.join(","));
  assert.ok(!types.some((t) => t.indexOf("AUTOPIN") === 0), "tidak boleh ada langkah pin: " + types.join(","));
  // Dan baris baru yang diperkenalkan v0.2.0 bukan kejadian: ia penjelasan di
  // log mentah, bukan sesuatu yang perlu dibaca customer.
  for (const tag of ["RULE_ONLY", "AUTOCOMMENT_NO_PIN_CLAIM"]) {
    assert.equal(parseLine("[" + tag + "] scene=X playId=1"), null, tag);
  }
});

test("FAQ: balasan TIDAK dituntut bukti pin, karena ia tidak menjanjikan pin", async () => {
  // Tanpa ini, transport browser (pinPolicy=CONFIRMED) akan menolak SETIAP
  // balasan FAQ sebagai pin-not-confirmed, dan tidak ada apa pun di dashboard
  // yang menjelaskan kenapa balasannya hilang.
  bot.enqueueTrigger(sceneRule({ switchScene: true, autoPin: false, autoReply: true }), "penonton");
  await advance(QUEUE_KICK_MS);

  assert.equal(commentCalls[0].requirePin, false);
  assert.equal(commentCalls[0].pin.ok, false);
  assert.equal(commentCalls[0].pin.reason, "action-disabled");
  assert.equal(commentCalls[0].pin.skipped, true, "dibedakan dari pin yang GAGAL");
});

// --- scene saja --------------------------------------------------------------

test("SCENE ONLY: scene berganti, nol pin, nol balasan", async () => {
  bot.enqueueTrigger(sceneRule({ switchScene: true, autoPin: false, autoReply: false }), "penonton");
  await advance(QUEUE_KICK_MS);

  assert.deepEqual(obsSwitches, [PAX1]);
  assert.deepEqual(order, []);
  assert.equal(state().activeScene, PAX1, "playback-nya tetap berjalan normal");
});

// --- balas saja, tanpa scene -------------------------------------------------

test("REPLY ONLY: balasan terkirim tanpa menyentuh OBS", async () => {
  bot.enqueueTrigger(keyRule({ switchScene: false, autoPin: false, autoReply: true }), "penonton");
  await advance(QUEUE_KICK_MS);

  assert.deepEqual(obsSwitches, [], "tidak ada scene yang diganti");
  assert.deepEqual(order, ["comment:#rule-7"]);
  assert.equal(pinCalls.length, 0);
  assert.equal(commentCalls[0].requirePin, false);
});

test("REPLY ONLY: jalur playback TIDAK tersentuh sama sekali", async () => {
  // Aturan balas-saja tidak boleh bisa menahan, mendahului, atau memacetkan satu
  // pun pemutaran scene.
  bot.enqueueTrigger(keyRule({ switchScene: false, autoPin: false, autoReply: true }), "penonton");
  await advance(QUEUE_KICK_MS);

  const s = state();
  assert.equal(s.busy, false);
  assert.equal(s.activeScene, null);
  assert.deepEqual(s.queue, []);
  assert.deepEqual(s.playedScenes, []);
  assert.equal(s.activePlayId, 0);
  assert.equal(s.hasFallbackTimer, false);
  assert.equal(s.hasDurationTimer, false);
  assert.deepEqual(logged("INVALID_SCENE"), [], "bukan kesalahan konfigurasi");
});

test("REPLY ONLY: scene yang sedang tayang TIDAK kehilangan balasannya", async () => {
  // Regresi yang paling mudah dibuat: kalau aturan tanpa scene ikut menaikkan
  // playId, scene yang sedang menunggu hasil pin-nya akan melihat nomornya
  // tersalip dan balasannya sendiri dibuang sebagai stale. Penonton kehilangan
  // kalimat "sudah aku pin" karena ada orang lain yang bertanya soal harga.
  let releasePin;
  bot.__test.setScenePin({
    requestPin(req) {
      order.push("pin:" + req.scene);
      pinCalls.push(req);
      return new Promise((res) => { releasePin = () => res(PIN_REAL); });
    },
  });

  bot.enqueueTrigger(sceneRule({ switchScene: true, autoPin: true, autoReply: true }), "a");
  await advance(QUEUE_KICK_MS);
  assert.deepEqual(order, ["pin:" + PAX1], "pin masih menggantung");
  const scenePlayId = pinCalls[0].playId;

  // Aturan FAQ menyalip selagi pin scene masih berjalan.
  bot.enqueueTrigger(keyRule({ switchScene: false, autoPin: false, autoReply: true }), "b");
  await advance(0);
  assert.deepEqual(order, ["pin:" + PAX1, "comment:#rule-7"]);

  releasePin();
  await advance(0);

  const sceneComment = commentCalls.find((c) => c.scene === PAX1);
  assert.ok(sceneComment, "balasan scene harus tetap terkirim: " + JSON.stringify(order));
  assert.equal(sceneComment.playId, scenePlayId, "dan dengan playId scene-nya sendiri");
  assert.equal(commentCalls.find((c) => c.scene === "#rule-7").playId, undefined,
    "aturan tanpa scene tidak membawa nomor generasi pemutaran");
});

test("REPLY ONLY: cooldown per-aturan menahan banjir penonton", async () => {
  // Dua puluh penonton yang bertanya soal harga tidak boleh menjadi dua puluh
  // permintaan balasan.
  const rule = keyRule({ switchScene: false, autoPin: false, autoReply: true });
  for (let i = 0; i < 20; i += 1) bot.enqueueTrigger(rule, "penonton" + i);
  await advance(QUEUE_KICK_MS);

  assert.equal(commentCalls.length, 1, "hanya satu yang lolos");
  assert.ok(state().cooldownScenes.includes("#rule-7"));
  assert.ok(logged("SKIP_COOLDOWN").length >= 19);

  // Dan setelah cooldown habis, ia boleh terpicu lagi.
  await advance(COOLDOWN_MS);
  bot.enqueueTrigger(rule, "penonton-baru");
  await advance(0);
  assert.equal(commentCalls.length, 2);
});

// --- pin saja, tanpa scene ---------------------------------------------------

test("PIN ONLY: pin dijalankan, tanpa scene dan tanpa balasan", async () => {
  bot.enqueueTrigger(keyRule({ switchScene: false, autoPin: true, autoReply: false }), "penonton");
  await advance(QUEUE_KICK_MS);

  assert.deepEqual(obsSwitches, []);
  assert.deepEqual(order, ["pin:#rule-7"]);
  assert.equal(commentCalls.length, 0);
});

// --- semua aksi mati ---------------------------------------------------------

test("ALL OFF: nol aksi dan jalur playback tetap bersih", async () => {
  // Validator sudah menolak aturan seperti ini jauh sebelum LIVE; ini jaring
  // terakhirnya, dan ia harus diam — bukan meledak.
  bot.enqueueTrigger(keyRule({ switchScene: false, autoPin: false, autoReply: false }), "penonton");
  await advance(QUEUE_KICK_MS);

  assert.deepEqual(obsSwitches, []);
  assert.deepEqual(order, []);
  assert.equal(state().busy, false);
});

// --- saklar global tetap tombol darurat --------------------------------------

test("MASTER SWITCH: aturan pin menyala + AutoPIN global mati => tidak ada pin", async () => {
  // Saklar global tertanam di instance scenePin (enabled:false = nol aksi, nol
  // log). Yang dibuktikan di sini: aksi aturan TIDAK melewatinya.
  const { createScenePin } = require("../autopin/scene-pin");
  bot.__test.setScenePin(
    createScenePin({
      enabled: false,
      mapping: { [PAX1]: "Produk Uji" },
      send: () => {
        throw new Error("transport tidak boleh pernah disentuh saat AutoPIN global mati");
      },
    })
  );

  bot.enqueueTrigger(sceneRule({ switchScene: true, autoPin: true, autoReply: true }), "penonton");
  await advance(QUEUE_KICK_MS);

  assert.deepEqual(obsSwitches, [PAX1], "scene tetap berganti: itu aksinya sendiri");
  assert.deepEqual(logged("AUTOPIN_REQUEST"), []);
  assert.equal(commentCalls[0].pin.ok, false);
  assert.equal(commentCalls[0].pin.reason, "disabled");
});

test("MASTER SWITCH: aturan balas menyala + AutoComment global mati => tidak ada balasan", async () => {
  const { createAutoComment } = require("../autocomment/core");
  bot.__test.setAutoComment(
    createAutoComment({
      enabled: false,
      send: () => {
        throw new Error("transport tidak boleh pernah disentuh saat AutoComment global mati");
      },
    })
  );

  bot.enqueueTrigger(sceneRule({ switchScene: true, autoPin: true, autoReply: true }), "penonton");
  await advance(QUEUE_KICK_MS);

  assert.deepEqual(obsSwitches, [PAX1]);
  assert.deepEqual(order, ["pin:" + PAX1]);
  assert.deepEqual(logged("AUTOCOMMENT_REQUEST"), []);
});

test("MASTER SWITCH: requirePin dari aturan TIDAK melemahkan bukti pin saat transport browser", async () => {
  // Gerbang yang menjaga kalimat "sudah aku pin" tetap utuh untuk aturan yang
  // mem-pin: pin yang gagal tetap membungkam balasannya.
  const { createAutoComment, PIN_POLICY } = require("../autocomment/core");
  const { inspectPinResult } = require("../autopin/pin-result");
  let sent = 0;
  bot.__test.setAutoComment(
    createAutoComment({
      enabled: true,
      pinPolicy: PIN_POLICY.CONFIRMED,
      inspectPin: inspectPinResult,
      format: () => ({ ok: true, text: "sudah aku pin ya kak" }),
      send: async () => { sent += 1; return { ok: true }; },
    })
  );
  bot.__test.setScenePin({ requestPin: () => Promise.resolve({ ok: false, reason: "product-not-found" }) });

  bot.enqueueTrigger(sceneRule({ switchScene: true, autoPin: true, autoReply: true }), "penonton");
  await advance(QUEUE_KICK_MS);
  assert.equal(sent, 0, "pin gagal harus tetap membungkam klaim pin");

  // Sementara aturan yang TIDAK mem-pin tetap boleh bicara dengan kebijakan yang
  // sama, karena balasannya tidak menjanjikan pin apa pun.
  bot.enqueueTrigger(keyRule({ switchScene: false, autoPin: false, autoReply: true }), "penonton");
  await advance(0);
  assert.equal(sent, 1);
});
