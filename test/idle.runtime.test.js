// Daur hidup interaksi saat sepi, di jalur yang SUNGGUHAN.
//
// index.js yang nyata dijalankan dengan AILIVE_RUNTIME_CONFIG menunjuk ke
// artefak yang memuat blok idle, jadi yang diuji adalah antrean, busy,
// activeScene, cooldown, playId, dan preempsi milik produksi — bukan tiruannya.
//
// Dispatcher AutoPIN dan AutoComment juga yang asli (autopin/scene-pin.js,
// autocomment/core.js), supaya "interaksi tidak pernah mem-pin" dan "balasannya
// NORMAL" dibuktikan oleh kode yang memutuskan saat LIVE. Yang dipalsukan hanya
// batas luar: transport HTTP, transport chat, dan OBS.

const { test, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const { buildRuntimeConfig, writeRuntimeConfig, RUNTIME_CONFIG_ENV } = require("../runtime/runtime-config");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ailive-idle-"));

// PAX-9 dan PAX-10 dipakai sebagai scene interaksi: keduanya ADA di katalog
// pemutaran (RULES) dan bukan scene pemetaan di tes ini, jadi ia memenuhi
// Decision 1 tanpa menambah satu pun detail pemutaran baru.
const IDLE_A = "PAX-9";
const IDLE_B = "PAX-10";
const IDLE_REPLY_A = "Yang baru join welcome ya kak";

const MAPPINGS = [
  { scene: "PAX-1", product: { title: "Produk Uji" }, triggers: ["spill etalase 1"], reply: "Etalase 1 sudah aku pin ya kak" },
  { scene: "PAX-2", product: { title: "Produk Uji Dua" }, triggers: ["spill etalase 2"], reply: "Etalase 2 sudah aku pin ya kak" },
];
const IDLE_CFG = {
  enabled: true,
  afterSeconds: 30,
  items: [{ scene: IDLE_A, reply: IDLE_REPLY_A }, { scene: IDLE_B, reply: null }],
};

const artifact = buildRuntimeConfig({ mappings: MAPPINGS, idle: IDLE_CFG, configVersion: 1 });
const ARTIFACT_FILE = path.join(TMP, "runtime-" + artifact.id + ".json");
assert.equal(writeRuntimeConfig(ARTIFACT_FILE, artifact).ok, true);

process.env[RUNTIME_CONFIG_ENV] = ARTIFACT_FILE;
process.env.SCENE_REPLAY_COOLDOWN_MS = "120000";
process.env.DOTENV_CONFIG_QUIET = "true";

const bot = require("../index.js");
const { SCENES } = bot;
const { createScenePin } = require("../autopin/scene-pin");
const { createAutoComment, PIN_POLICY, DEFAULT_MIN_INTERVAL_MS, DEFAULT_MAX_PER_MINUTE } = require("../autocomment/core");
const { inspectPinResult } = require("../autopin/pin-result");

const PAX1 = SCENES.AILIVE_SKUPAXSATU;
const MAIN = SCENES.MAIN;
const QUEUE_KICK_MS = 50;
const IDLE_AFTER_MS = 30_000;
const COOLDOWN_MS = 120_000;

const PIN_CONFIRMED = { ok: true, reason: "pinned", clicked: true, state: "Unpin", title: "Produk Uji" };

let logs = [];
let obsSwitches = [];
let pinSends = [];
let commentSends = [];
let commentClock = 0;
let autoComment;

const flush = () => new Promise((r) => setImmediate(r));
async function advance(ms) {
  mock.timers.tick(ms);
  commentClock += ms;
  await flush();
  await flush();
  await flush();
}
// Satu periode sepi PLUS kick antrean 50ms yang SUDAH ADA di enqueueTrigger:
// entri interaksi masuk antrean dulu, lalu processQueue() berjalan di tick
// berikutnya. Itu perilaku antrean produksi dan bukan sesuatu yang khusus
// interaksi — jalur penonton pun melewati kick yang sama.
async function engage(ms = IDLE_AFTER_MS) {
  await advance(ms);
  await advance(QUEUE_KICK_MS);
}

const state = () => bot.__test.getState();
const idle = () => bot.__test.idle;
const logged = (tag) => logs.filter((l) => l.includes("[" + tag + "]"));
const chat = (user, comment) => bot.handleChat({ nickname: user, comment });

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  logs = []; obsSwitches = []; pinSends = []; commentSends = [];
  commentClock = 0;
  const capture = (...a) => logs.push(a.map(String).join(" "));
  mock.method(console, "log", capture);
  mock.method(console, "warn", capture);
  mock.method(console, "error", capture);

  bot.obs.call = (request, params = {}) => {
    if (request !== "SetCurrentProgramScene") return Promise.resolve();
    obsSwitches.push(params.sceneName);
    return Promise.resolve();
  };

  bot.__test.setScenePin(
    createScenePin({
      enabled: true,
      mapping: bot.__test.autopinMap(),
      timeoutMs: 8_000,
      send: (p) => {
        pinSends.push(p);
        return Promise.resolve(PIN_CONFIRMED);
      },
    })
  );
  autoComment = createAutoComment({
    enabled: true,
    pinPolicy: PIN_POLICY.CONFIRMED,
    inspectPin: inspectPinResult,
    format: (scene) => bot.__test.runtimeFormat(scene),
    maxPerMinute: DEFAULT_MAX_PER_MINUTE,
    minIntervalMs: DEFAULT_MIN_INTERVAL_MS,
    now: () => commentClock,
    send: async (p) => {
      commentSends.push(p);
      return { ok: true };
    },
  });
  bot.__test.setAutoComment(autoComment);
  bot.__test.reset();
});

afterEach(() => {
  bot.__test.reset();
  bot.__test.setScenePin({ requestPin: () => Promise.resolve({ ok: false, reason: "test-noop" }) });
  bot.__test.setAutoComment({ requestComment: () => Promise.resolve({ ok: false, reason: "test-noop" }) });
  mock.timers.reset();
  mock.restoreAll();
});

// --- prasyarat ---------------------------------------------------------------

test("prasyarat: bot membaca blok idle dari artefak", () => {
  const c = idle().config();
  assert.equal(c.enabled, true);
  assert.equal(c.afterMs, IDLE_AFTER_MS);
  assert.deepEqual(c.scenes, [IDLE_A, IDLE_B]);
  assert.equal(idle().isIdleScene(IDLE_A), true);
  assert.equal(idle().isIdleScene(PAX1), false);
});

test("prasyarat: scene interaksi TIDAK ada di peta produk", () => {
  const map = bot.__test.autopinMap();
  assert.equal(map[IDLE_A], undefined);
  assert.equal(map[IDLE_B], undefined);
  assert.equal(map[PAX1], "Produk Uji");
});

test("prasyarat: scene interaksi TIDAK bisa dipicu penonton", () => {
  assert.deepEqual(bot.activeRules().map((r) => r.scene).sort(), ["PAX-1", "PAX-2"]);
});

// --- arming ------------------------------------------------------------------

test("ARM: belum armed sebelum TIKTOK_CONNECTED, dan timernya belum ada", () => {
  assert.equal(idle().state().armed, false);
  assert.equal(idle().state().hasTimer, false);
  // Jatuh tempo yang dipaksakan pun tidak melakukan apa pun.
  idle().due();
  assert.deepEqual(obsSwitches, []);
});

test("ARM: armed memasang timer", () => {
  idle().arm("connected");
  const s = idle().state();
  assert.equal(s.armed, true);
  assert.equal(s.hasTimer, true);
  assert.ok(logged("IDLE_ARMED").length === 1);
});

test("DISARM: disarm mematikan armed DAN timernya", () => {
  idle().arm("connected");
  idle().disarm("disconnected");
  const s = idle().state();
  assert.equal(s.armed, false);
  assert.equal(s.hasTimer, false);
  assert.ok(logged("IDLE_DISARMED").length === 1);
});

test("DISARM: sesudah disarm, periode sepi terlewat pun tidak memutar apa pun", async () => {
  idle().arm("connected");
  idle().disarm("disconnected");
  await engage(IDLE_AFTER_MS * 2);
  assert.deepEqual(obsSwitches, []);
});

// --- aktivitas ---------------------------------------------------------------

test("AKTIVITAS: komentar yang lolos gerbang mereset hitungan sepi", async () => {
  idle().arm("connected");
  await engage(IDLE_AFTER_MS - 1_000);
  chat("penonton", "halo kak");
  await engage(2_000);
  assert.deepEqual(obsSwitches, [], "hitungan harus mulai dari nol lagi");
  await engage();
  assert.deepEqual(obsSwitches, [IDLE_A], "dan sesudah periode penuh, baru bicara");
});

test("AKTIVITAS: pesan BOT SENDIRI tidak pernah sampai ke handleChat, jadi tidak mereset", () => {
  // Gerbang chat (tiktok/chat-gate.js) menolak self-message SEBELUM handleChat.
  // Ini pagar terpenting fitur ini: tanpa itu, balasan interaksi yang baru
  // dikirim bot akan kembali sebagai "aktivitas" dan bot menyimpulkan ruangan
  // ramai karena mendengar dirinya sendiri.
  const gate = bot.__test.chatGateState;
  assert.equal(typeof gate, "function", "gerbang chat harus ada di jalur produksi");
  // Dibuktikan secara struktural: aktivitas dicatat DI DALAM handleChat.
  const src = fs.readFileSync(require.resolve("../index.js"), "utf8");
  const handler = src.slice(src.indexOf("function handleChat("), src.indexOf("function handleChat(") + 1200);
  assert.ok(handler.includes("noteViewerActivity()"), "aktivitas dicatat di dalam handleChat");
  const listener = src.slice(src.indexOf("verdict = chatGate.accept(data)"));
  assert.ok(listener.indexOf("handleChat(data)") > 0, "handleChat hanya dipanggil sesudah gerbang");
  assert.ok(!listener.slice(0, listener.indexOf("handleChat(data)")).includes("noteViewerActivity"),
    "aktivitas TIDAK boleh dicatat sebelum gerbang");
});

// --- gerbang: busy / antrean -------------------------------------------------

test("GERBANG: tidak pernah memutar interaksi selagi ada scene yang tayang", async () => {
  idle().arm("connected");
  chat("penonton", "spill etalase 1");
  await advance(QUEUE_KICK_MS);
  assert.equal(state().busy, true);
  assert.deepEqual(obsSwitches, [PAX1]);

  // Tetap DI BAWAH durasi failsafe PAX-1 (46 detik), supaya yang diuji adalah
  // gerbang busy — bukan scene yang kebetulan sudah selesai sendiri dan kembali
  // ke MAIN, yang memang perilaku normal akhir pemutaran.
  await engage(IDLE_AFTER_MS);
  assert.equal(state().busy, true, "scene penonton masih tayang");
  assert.equal(state().activeScene, PAX1);
  assert.ok(!obsSwitches.includes(IDLE_A), "interaksi tidak boleh menimpa: " + obsSwitches.join(","));
  assert.ok(!obsSwitches.includes(IDLE_B));
});

// --- JEDA PASCA-SCENE: hanya penonton yang boleh membatalkannya -------------
//
// Kebijakan 2026-10-17: permintaan penonton membatalkan jeda global pasca-scene
// supaya bot terasa responsif. Interaksi saat sepi TIDAK boleh ikut, karena LIVE
// yang sepi justru harus tetap tenang — dan karena interaksi yang membatalkan
// jeda akan bisa mulai tepat saat sebuah scene selesai, kebalikan dari gunanya.

test("GERBANG JEDA: interaksi TETAP tertahan selama jeda pasca-scene", async () => {
  idle().arm("connected");
  chat("penonton", "spill etalase 1");
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, PAX1);

  // Scene penonton selesai -> jeda global mulai.
  await advance(bot.RULES.find((r) => r.scene === PAX1).duration);
  assert.equal(state().activeScene, null);
  assert.equal(state().hasGlobalPauseTimer, true, "premis: jeda hidup");
  assert.equal(state().busy, true);

  // Periode sepi terlewat PENUH selagi jeda masih menahan.
  await engage(IDLE_AFTER_MS);
  assert.ok(!obsSwitches.includes(IDLE_A), "interaksi tidak boleh menembus jeda: " + obsSwitches.join(","));
  assert.ok(!obsSwitches.includes(IDLE_B));
  assert.equal(state().hasGlobalPauseTimer, true, "interaksi TIDAK membatalkan timer jeda");
  assert.equal(logged("PAUSE_CANCELLED").length, 0, "hanya penonton yang boleh membatalkan");
  assert.equal(state().busy, true, "jeda masih menahan busy");
  // Ditahan, bukan menyerah: onIdleDue() menjadwalkan ulang saat verdict-nya
  // "busy", jadi timernya harus tetap ada.
  assert.equal(idle().state().hasTimer, true, "interaksi dijadwalkan ulang, bukan berhenti");
});

test("GERBANG JEDA: sesudah jeda habis sendiri, interaksi baru boleh jalan", async () => {
  // Kebalikannya: interaksi tidak dilarang selamanya - ia hanya menunggu.
  idle().arm("connected");
  chat("penonton", "spill etalase 1");
  await advance(QUEUE_KICK_MS);
  await advance(bot.RULES.find((r) => r.scene === PAX1).duration);
  assert.equal(state().hasGlobalPauseTimer, true);

  await advance(60_000); // jeda global habis sendiri
  assert.equal(state().hasGlobalPauseTimer, false);
  assert.equal(state().busy, false);

  await engage(IDLE_AFTER_MS);
  assert.ok(obsSwitches.includes(IDLE_A), "sesudah jeda, interaksi jalan seperti biasa: " + obsSwitches.join(","));
});

test("GERBANG JEDA: permintaan PENONTON di jeda yang sama memang membatalkannya", async () => {
  // Sisi lain dari kebijakan yang sama, diuji di harness ini juga supaya kedua
  // perilaku itu tidak bisa menyimpang satu sama lain.
  idle().arm("connected");
  chat("a", "spill etalase 1");
  await advance(QUEUE_KICK_MS);
  await advance(bot.RULES.find((r) => r.scene === PAX1).duration);
  assert.equal(state().hasGlobalPauseTimer, true);

  chat("b", "spill etalase 2");
  assert.equal(state().hasGlobalPauseTimer, false, "penonton membatalkan");
  assert.equal(logged("PAUSE_CANCELLED").length, 1);

  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, SCENES.AILIVE_SKUPAXDUA);
});

test("GERBANG: tidak memutar interaksi selagi antrean penonton belum kosong", async () => {
  idle().arm("connected");
  // Satu entri menunggu di antrean, tapi playback ditahan busy.
  chat("a", "spill etalase 1");
  await advance(QUEUE_KICK_MS);
  chat("b", "spill etalase 2");
  await advance(0);
  assert.ok(state().queue.length > 0, "entri kedua harus menunggu");

  await engage();
  assert.ok(!obsSwitches.includes(IDLE_A), "interaksi tidak boleh menyalip antrean penonton");
});

// --- eksekusi ----------------------------------------------------------------

test("EKSEKUSI: sesudah periode sepi, scene interaksi pertama diputar", async () => {
  idle().arm("connected");
  await engage();
  assert.deepEqual(obsSwitches, [IDLE_A]);
  assert.equal(state().activeScene, IDLE_A);
  assert.equal(logged("IDLE_ENGAGE").length, 1);
});

test("EKSEKUSI: interaksi TIDAK PERNAH mem-pin", async () => {
  idle().arm("connected");
  await engage();
  assert.deepEqual(pinSends, [], "nol permintaan pin");
  assert.deepEqual(logged("AUTOPIN_REQUEST"), []);
  assert.deepEqual(logged("AUTOPIN_SUCCESS"), []);
  assert.deepEqual(logged("AUTOPIN_FAILED"), []);
});

test("EKSEKUSI: balasan interaksi terkirim dengan prioritas NORMAL", async () => {
  idle().arm("connected");
  await engage();
  assert.equal(commentSends.length, 1);
  assert.equal(commentSends[0].scene, IDLE_A);
  assert.equal(commentSends[0].text, IDLE_REPLY_A);
  // NORMAL, dibuktikan dari jamnya: kiriman high memperbarui lastHighSentAt.
  const s = autoComment.__state();
  assert.equal(s.lastHighSentAt, -Infinity, "balasan interaksi tidak boleh berprioritas tinggi");
  assert.notEqual(s.lastAnySentAt, -Infinity);
});

test("EKSEKUSI: interaksi mendapat playId pemutaran normal", async () => {
  idle().arm("connected");
  await engage();
  assert.ok(state().activePlayId > 0, "scene yang sungguh diputar harus punya generasi");
  assert.equal(commentSends[0].playId, state().activePlayId);
});

test("EKSEKUSI: item tanpa balasan hanya memutar scene", async () => {
  idle().arm("connected");
  await engage();            // IDLE_A (punya balasan)
  bot.endCurrentScene("test", false);
  await engage(COOLDOWN_MS + IDLE_AFTER_MS); // IDLE_B (tanpa balasan)
  assert.deepEqual(obsSwitches.filter((s) => s !== MAIN), [IDLE_A, IDLE_B]);
  assert.equal(commentSends.length, 1, "hanya item pertama yang membalas");
});

// --- rotasi + cooldown -------------------------------------------------------

test("ROTASI: item berganti setiap kali, tidak mengulang yang sama", async () => {
  idle().arm("connected");
  await engage();
  assert.equal(state().activeScene, IDLE_A);
  bot.endCurrentScene("test", false);
  await engage();
  assert.equal(state().activeScene, IDLE_B, "kursor harus maju");
});

test("COOLDOWN: item yang masih cooldown dilewati", async () => {
  idle().arm("connected");
  await engage();
  bot.endCurrentScene("test", false);     // IDLE_A masuk cooldown 120s
  assert.ok(state().cooldownScenes.includes(IDLE_A));
  await engage();
  assert.equal(state().activeScene, IDLE_B);
});

test("COOLDOWN: semua item cooldown -> DIAM, bukan memutar apa pun", async () => {
  idle().arm("connected");
  await engage();
  bot.endCurrentScene("test", false);
  await engage();
  bot.endCurrentScene("test", false);
  const before = obsSwitches.filter((s) => s !== MAIN).length;
  assert.equal(before, 2, "keduanya sudah diputar dan kini cooldown");

  await engage();
  assert.equal(obsSwitches.filter((s) => s !== MAIN).length, 2, "harus diam");
  assert.ok(logged("IDLE_SKIPPED").some((l) => l.includes("all-items-cooling")));

  // Dan sesudah cooldown habis, ia boleh bicara lagi.
  await engage(COOLDOWN_MS);
  assert.ok(obsSwitches.filter((s) => s !== MAIN).length > 2);
});

test("MAIN: sesudah interaksi selesai, periode sepi harus PENUH lagi", async () => {
  idle().arm("connected");
  await engage();
  const after = obsSwitches.length;
  bot.endCurrentScene("test", false);
  assert.ok(obsSwitches.includes(MAIN), "kembali ke MAIN seperti biasa");

  await engage(IDLE_AFTER_MS - 1_000);
  assert.equal(obsSwitches.length, after + 1, "belum boleh ada interaksi baru");
  await engage(2_000);
  assert.ok(obsSwitches.length > after + 1, "sesudah periode penuh, boleh lagi");
});

// --- prioritas & preempsi ----------------------------------------------------

test("PRIORITAS: entri interaksi masuk antrean dengan prioritas -1", async () => {
  // Prioritas -1 adalah LAPIS KEDUA, dan sejak entri interaksi yang menunggu
  // dibuang oleh aktivitas penonton, ia tidak lagi bisa diamati lewat jalur
  // publik: kedua jenis entri tidak pernah lagi berada di antrean bersamaan.
  //
  // Ia tetap dipertahankan dan tetap diuji di sini. processQueue() memilih
  // prioritas tertinggi lebih dulu, jadi kalau suatu hari ada jalur baru yang
  // memasukkan keduanya, penonton tetap menang tanpa ada yang perlu mengingat
  // untuk menuliskannya lagi.
  idle().arm("connected");
  await advance(IDLE_AFTER_MS);

  const q = idle().queued();
  assert.deepEqual(q.map((e) => e.scene), [IDLE_A], "entri interaksi menunggu, kick belum jalan");
  assert.equal(q[0].priority, -1, "entri interaksi harus berprioritas -1");
  assert.equal(state().busy, false);

  // Dan entri penonton memakai prioritas normal, jadi ia selalu lebih tinggi.
  bot.__test.reset();
  chat("penonton", "spill etalase 1");
  assert.equal(idle().queued()[0].priority, 0, "entri penonton berprioritas 0");
});

test("PREEMPSI: permintaan penonton MENGHENTIKAN scene interaksi yang sedang tayang", async () => {
  idle().arm("connected");
  await engage();
  assert.equal(state().activeScene, IDLE_A);

  chat("penonton", "spill etalase 1");
  await advance(QUEUE_KICK_MS);

  assert.ok(logged("IDLE_PREEMPTED").length === 1, logs.filter((l) => l.includes("IDLE")).join(" | "));
  assert.equal(state().activeScene, PAX1, "scene penonton harus langsung jalan");
  assert.ok(obsSwitches.includes(PAX1));
});

test("PREEMPSI: scene PENONTON tidak pernah diinterupsi", async () => {
  idle().arm("connected");
  chat("a", "spill etalase 1");
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, PAX1);

  chat("b", "spill etalase 2");
  await advance(QUEUE_KICK_MS);

  assert.deepEqual(logged("IDLE_PREEMPTED"), [], "tidak ada preempsi untuk scene penonton");
  assert.equal(state().activeScene, PAX1, "PAX-1 harus tetap tayang sampai selesai");
});

test("PREEMPSI: balasan scene interaksi yang di-preempt tidak pernah terkirim belakangan", async () => {
  // finishActiveScene() menyetel activePlayId = 0, jadi auxiliary yang masih di
  // udara menjadi basi. Dibuktikan dengan menahan balasan interaksi.
  let releaseComment;
  bot.__test.setAutoComment({
    requestComment(req) {
      commentSends.push(req);
      return new Promise((res) => { releaseComment = () => res({ ok: true }); });
    },
  });
  idle().arm("connected");
  await engage();
  assert.equal(commentSends.length, 1);
  assert.equal(commentSends[0].scene, IDLE_A);

  chat("penonton", "spill etalase 1");
  await advance(QUEUE_KICK_MS);
  if (releaseComment) releaseComment();
  await advance(0);

  assert.equal(state().activeScene, PAX1);
  assert.ok(logged("IDLE_PREEMPTED").length === 1);
});

// --- entri interaksi BASI di antrean ----------------------------------------
//
// Celah yang membuat bug ini ada: gerbang interaksi menuntut antrean kosong,
// jadi entri interaksi masuk saat sepi — lalu kick 50ms milik antrean memberi
// penonton satu celah untuk menyalip. Prioritas -1 membuat penonton MENANG di
// celah itu, tapi sebelum perbaikan ini entri interaksi yang kalah TETAP
// tertinggal di antrean, dan endCurrentScene memutarnya begitu scene penonton
// selesai: tanpa kembali ke MAIN, dan tanpa menunggu satu periode sepi pun.
//
// Terbukti sebelum perbaikan: PAX-1 selesai -> PAX-9 langsung tayang.

// Menyiapkan keadaan "entri interaksi sudah di antrean, kick belum jalan".
async function queueIdleWithoutPlaying() {
  idle().arm("connected");
  await advance(IDLE_AFTER_MS);
  assert.deepEqual(state().queue.map((e) => e.scene), [IDLE_A], "entri interaksi harus menunggu di antrean");
  assert.equal(state().activeScene, null, "dan belum ada yang tayang");
}

test("BASI: permintaan PAX membuang entri interaksi yang menunggu", async () => {
  await queueIdleWithoutPlaying();

  chat("penonton", "spill etalase 1");
  // Keduanya sempat ada bersamaan — itulah arsitektur antreannya — tapi yang
  // interaksi langsung dibuang oleh aktivitas penonton.
  assert.deepEqual(state().queue.map((e) => e.scene), [PAX1], "entri interaksi harus hilang");
  assert.ok(logged("IDLE_QUEUE_DROPPED").length === 1, logs.filter((l) => l.includes("IDLE")).join(" | "));

  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, PAX1, "penonton yang jalan");

  // PAX selesai: kembali ke MAIN, dan TIDAK ada interaksi basi yang menyusul.
  bot.endCurrentScene("test", false);
  await advance(QUEUE_KICK_MS);
  assert.deepEqual(state().queue, [], "antrean harus bersih");
  assert.equal(state().activeScene, null, "MAIN yang aktif, bukan scene interaksi");
  assert.ok(obsSwitches.includes(MAIN));
  assert.ok(!obsSwitches.includes(IDLE_A), "scene interaksi tidak boleh ikut tayang: " + obsSwitches.join(","));

  // Kurang dari satu periode: masih diam.
  await advance(IDLE_AFTER_MS - 1_000);
  assert.ok(!obsSwitches.includes(IDLE_A), "belum boleh, periode sepi belum penuh");

  // Periode PENUH sejak scene penonton berakhir: baru boleh.
  //
  // Item MANA yang tampil tidak dipaku di sini. Kursor rotasi sudah maju saat
  // entri yang dibatalkan itu dibuat, jadi putaran berikutnya adalah item
  // berikutnya — deterministik, dan tidak merugikan: yang penting adalah
  // interaksi baru hanya boleh jalan sesudah periode sepi penuh.
  await advance(1_000);
  await advance(QUEUE_KICK_MS);
  const played = obsSwitches.filter((sc) => idle().isIdleScene(sc));
  assert.equal(played.length, 1, "tepat satu scene interaksi, sesudah periode penuh: " + obsSwitches.join(","));
});

test("BASI: aturan FAQ yang cocok juga membuang entri interaksi yang menunggu", async () => {
  // Aturan penonton kedua (PAX-2) berdiri sebagai "aturan yang cocok tapi bukan
  // PAX-1": yang diuji adalah bahwa SETIAP aturan penonton yang cocok
  // membatalkan interaksi, bukan hanya satu scene tertentu.
  await queueIdleWithoutPlaying();

  chat("penonton", "spill etalase 2");
  assert.deepEqual(state().queue.map((e) => e.scene), ["PAX-2"]);
  assert.ok(logged("IDLE_QUEUE_DROPPED").length === 1);

  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, "PAX-2");
  bot.endCurrentScene("test", false);
  await advance(QUEUE_KICK_MS);
  assert.ok(!obsSwitches.includes(IDLE_A), "tidak ada interaksi basi: " + obsSwitches.join(","));
});

test("BASI: komentar yang TIDAK cocok aturan apa pun juga membuangnya", async () => {
  // Pembeda yang penting. Komentar ini tidak punya scene untuk diantrekan, jadi
  // antrean menjadi KOSONG — tapi ia tetap aktivitas penonton yang lolos
  // gerbang, dan ruangan itu tidak sepi. Interaksi yang menunggu harus batal.
  await queueIdleWithoutPlaying();

  chat("penonton", "halo kak apa kabar");
  assert.deepEqual(state().queue, [], "tidak ada scene penonton, dan interaksi dibuang");
  assert.ok(logged("IDLE_QUEUE_DROPPED").length === 1);

  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, null, "tidak ada apa pun yang tayang");
  assert.deepEqual(obsSwitches, [], "nol sentuhan OBS");

  await advance(IDLE_AFTER_MS - 1_000);
  assert.deepEqual(obsSwitches, [], "periode sepi harus mulai dari nol lagi");
  await advance(1_000);
  await advance(QUEUE_KICK_MS);
  // Satu scene interaksi, dan item mana tidak dipaku: lihat catatan kursor di
  // tes "BASI: permintaan PAX ...".
  assert.equal(obsSwitches.length, 1, "tepat satu, baru sesudah periode penuh: " + obsSwitches.join(","));
  assert.ok(idle().isIdleScene(obsSwitches[0]), "dan ia scene interaksi: " + obsSwitches[0]);
});

test("BASI: pembuangan HANYA menyentuh entri interaksi, bukan entri penonton", async () => {
  // Pagar terhadap generalisasi berlebihan: dua entri penonton yang menunggu
  // tidak boleh ikut terbuang oleh komentar penonton berikutnya.
  idle().arm("connected");
  chat("a", "spill etalase 1");
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, PAX1, "PAX-1 tayang");

  chat("b", "spill etalase 2");
  assert.deepEqual(state().queue.map((e) => e.scene), ["PAX-2"], "entri penonton menunggu");

  chat("c", "halo kak");
  assert.deepEqual(state().queue.map((e) => e.scene), ["PAX-2"], "entri penonton TIDAK boleh terbuang");
  assert.deepEqual(logged("IDLE_QUEUE_DROPPED"), [], "tidak ada yang perlu dibuang");
});

test("BASI: komentar penonton TIDAK menginterupsi scene penonton yang sedang tayang", async () => {
  // Perilaku preempsi tidak berubah: hanya scene INTERAKSI yang boleh
  // dihentikan, dan hanya oleh permintaan penonton.
  idle().arm("connected");
  chat("a", "spill etalase 1");
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, PAX1);

  chat("b", "halo kak");
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, PAX1, "PAX-1 harus tetap tayang");
  assert.deepEqual(logged("IDLE_PREEMPTED"), []);
});

test("BASI: scene interaksi yang SUDAH tayang tidak dibuang oleh filter antrean", async () => {
  // processQueue() mengeluarkan entri dari antrean sebelum memutarnya, jadi
  // scene yang sedang tayang tidak pernah ada di antrean. Yang menanganinya
  // tetap jalur preempsi (forceCurrent), dan itu tidak berubah.
  await queueIdleWithoutPlaying();
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, IDLE_A, "scene interaksi sudah tayang");
  assert.deepEqual(state().queue, [], "dan tidak ada lagi di antrean");

  chat("penonton", "spill etalase 1");
  await advance(QUEUE_KICK_MS);
  assert.ok(logged("IDLE_PREEMPTED").length === 1, "yang bekerja adalah preempsi, bukan filter antrean");
  assert.equal(state().activeScene, PAX1);
});

// --- kuota AutoComment -------------------------------------------------------

test("KUOTA: balasan interaksi TIDAK membungkam balasan PAX yang pin-nya terkonfirmasi", async () => {
  // Inilah gunanya limiter dua jam yang baru: balasan interaksi memakai jam
  // normal, balasan produk memakai jamnya sendiri.
  idle().arm("connected");
  await engage();
  assert.equal(commentSends.length, 1, "balasan interaksi terkirim");
  assert.equal(commentSends[0].scene, IDLE_A);

  // Penonton menyalip hanya 1,2 detik kemudian — jauh di bawah jeda normal 5s.
  chat("penonton", "spill etalase 1");
  await engage(1_200);

  const paxComment = commentSends.find((c) => c.scene === PAX1);
  assert.ok(paxComment, "balasan produk HARUS terkirim: " + JSON.stringify(commentSends.map((c) => c.scene)));
  assert.equal(paxComment.text, "Etalase 1 sudah aku pin ya kak");
});

// --- shutdown ----------------------------------------------------------------

test("SHUTDOWN: reset membersihkan timer interaksi", () => {
  idle().arm("connected");
  assert.equal(idle().state().hasTimer, true);
  bot.__test.reset();
  const s = idle().state();
  assert.equal(s.hasTimer, false);
  assert.equal(s.armed, false);
  assert.equal(s.cursor, 0);
});

test("SHUTDOWN: jalur keluar memanggil disarmIdle", () => {
  // Di Windows anak dimatikan dengan TerminateProcess, jadi timer mati bersama
  // prosesnya. Di jalur manual/POSIX handler-lah yang membersihkannya, dan
  // ketiadaannya akan membuat proses menggantung pada timer yang belum selesai.
  const src = fs.readFileSync(require.resolve("../index.js"), "utf8");
  const shutdown = src.slice(src.indexOf("const shutdown = () =>"), src.indexOf("process.on(\"SIGINT\""));
  assert.ok(shutdown.includes("disarmIdle"), "shutdown harus mematikan interaksi");
  const onExit = src.slice(src.indexOf("process.on(\"exit\""));
  assert.ok(onExit.slice(0, 200).includes("disarmIdle"), "exit juga");
});
