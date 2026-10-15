// VERIFIKASI TERFOKUS — jalur eksekusi aturan tanpa scene (switchScene=false).
//
// Desain v0.2.0 SENGAJA tidak menaikkan generasi pemutaran (playId) untuk aturan
// tanpa scene, supaya balasan FAQ tidak pernah membuat generasi PAX yang sedang
// tayang menjadi basi. Berkas ini membuktikan bahwa keputusan itu TIDAK merusak
// dedupe maupun send-once di jalur AutoPIN/AutoComment.
//
// Yang dipakai di sini adalah DISPATCHER PRODUKSI YANG SUNGGUHAN:
//
//   autopin/scene-pin.js    createScenePin      (bukan tiruan)
//   autocomment/core.js     createAutoComment   (bukan tiruan)
//   autopin/pin-result.js   inspectPinResult    (gerbang bukti pin sungguhan)
//   runtime/mappings.js     createRuntimeMappings (peta produk & balasan nyata)
//   autopin/service.js      createService       (jalur pin service, browser palsu)
//   autopin/session.js      createPlayGeneration (model generasi sisi service)
//
// Yang dipalsukan HANYA batas luar: transport HTTP, OBS, dan browser. Semua
// keputusan — basi, dedupe, rate limit, bukti pin — dijalankan oleh kode yang
// sama yang dipakai saat LIVE.

const { test, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");

process.env.SCENE_REPLAY_COOLDOWN_MS = "120000";
process.env.DOTENV_CONFIG_QUIET = "true";

const bot = require("../index.js");
const { SCENES } = bot;

const { createScenePin } = require("../autopin/scene-pin");
const { createAutoComment, PIN_POLICY, DEFAULT_MAX_PER_MINUTE, DEFAULT_MIN_INTERVAL_MS } = require("../autocomment/core");
const { inspectPinResult } = require("../autopin/pin-result");
const { createRuntimeMappings } = require("../runtime/mappings");
const { createPlayGeneration } = require("../autopin/session");
const { createService } = require("../autopin/service");

const PAX1 = SCENES.AILIVE_SKUPAXSATU;
const PAX2 = SCENES.AILIVE_SKUPAXDUA;
const QUEUE_KICK_MS = 50;
const COOLDOWN_MS = 120_000;

// Kunci aturan buatan, seperti yang dihasilkan runtime/rule-actions.js untuk
// mapping pada indeks ke-2, ke-3, dan ke-4.
const FAQ_A = "#rule-2";
const FAQ_B = "#rule-3";
const PIN_ONLY = "#rule-4";

const PIN_CONFIRMED = { ok: true, reason: "pinned", clicked: true, state: "Unpin", title: "Produk Uji" };

// Pemetaan customer yang mewakili seluruh matriks aksi sekaligus.
const MAPPINGS = [
  // 0: etalase lengkap — scene + pin + balas (perilaku v0.1.1)
  { scene: PAX1, product: { title: "Produk Uji" }, triggers: ["spill etalase 1"], reply: "Etalase 1 sudah aku pin ya kak" },
  // 1: FAQ balas-saja A
  { triggers: ["berapa harganya"], reply: "Harga terbarunya ada di etalase ya kak", actions: { switchScene: false, autoPin: false, autoReply: true } },
  // 2: FAQ balas-saja B — balasannya BERBEDA
  { triggers: ["bisa cod"], reply: "COD belum tersedia kak, pakai transfer ya", actions: { switchScene: false, autoPin: false, autoReply: true } },
  // 3: pin-saja, tanpa scene dan tanpa balasan
  { product: { title: "Produk Uji Dua" }, triggers: ["pin dong"], actions: { switchScene: false, autoPin: true, autoReply: false } },
  // 4: etalase lengkap kedua, untuk membuktikan PAX sesudah FAQ tetap utuh
  { scene: PAX2, product: { title: "Produk Uji Dua" }, triggers: ["spill etalase 2"], reply: "Etalase 2 sudah aku pin ya kak" },
];

let runtime;
let rules;          // kunci aturan -> objek rule dari snapshot
let logs = [];
let obsSwitches = [];
let pinSends = [];      // payload yang sampai ke transport HTTP AutoPIN
let commentSends = [];  // payload yang sampai ke transport AutoComment
let pinBehaviour;       // (payload) -> Promise hasil pin
let scenePin;
let autoComment;
let commentClock;       // jam monotonik yang disuntikkan ke createAutoComment

const flush = () => new Promise((r) => setImmediate(r));
async function advance(ms) {
  mock.timers.tick(ms);
  // Jam AutoComment adalah jam MONOTONIK terpisah (performance.now di
  // produksi). Ia disuntikkan supaya rate limit sungguhan bisa diuji dengan
  // waktu yang dikendalikan, bukan dilewati.
  commentClock += ms;
  await flush();
  await flush();
  await flush();
}
const state = () => bot.__test.getState();
const logged = (tag) => logs.filter((l) => l.includes("[" + tag + "]"));
const ruleFor = (key) => {
  const r = rules.get(key);
  assert.ok(r, "rule tidak ada di snapshot: " + key);
  return r;
};

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  logs = []; obsSwitches = []; pinSends = []; commentSends = [];
  commentClock = 0;
  pinBehaviour = async () => PIN_CONFIRMED;

  const capture = (...a) => logs.push(a.map(String).join(" "));
  mock.method(console, "log", capture);
  mock.method(console, "warn", capture);
  mock.method(console, "error", capture);

  bot.obs.call = (request, params = {}) => {
    if (request !== "SetCurrentProgramScene") return Promise.resolve();
    obsSwitches.push(params.sceneName);
    return Promise.resolve();
  };

  // Snapshot runtime SUNGGUHAN, dari pemetaan customer di atas. Peta produk dan
  // peta balasan yang dipakai di bawah adalah yang dihasilkan produksi.
  runtime = createRuntimeMappings({ mappings: MAPPINGS, baseRules: bot.RULES, generation: "uji" });
  rules = new Map(runtime.rules.map((r) => [r.key, r]));

  // --- dispatcher AutoPIN produksi ---
  scenePin = createScenePin({
    enabled: true,
    mapping: runtime.productMap,
    timeoutMs: 8_000,
    send: (payload) => {
      pinSends.push(payload);
      return pinBehaviour(payload);
    },
  });

  // --- dispatcher AutoComment produksi ---
  // pinPolicy CONFIRMED = kebijakan saat transport browser, yaitu kondisi
  // paling ketat yang ada di produksi.
  autoComment = createAutoComment({
    enabled: true,
    pinPolicy: PIN_POLICY.CONFIRMED,
    inspectPin: inspectPinResult,
    format: runtime.formatSceneMessage,
    maxPerMinute: DEFAULT_MAX_PER_MINUTE,
    minIntervalMs: DEFAULT_MIN_INTERVAL_MS,
    now: () => commentClock,
    send: async (payload) => {
      commentSends.push(payload);
      return { ok: true };
    },
  });

  bot.__test.setScenePin(scenePin);
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

// --- prasyarat: snapshot-nya memang berbentuk seperti yang diuji -------------

test("prasyarat: snapshot produksi memberi kunci dan peta seperti yang diharapkan", () => {
  assert.deepEqual(runtime.rules.map((r) => r.key), [PAX1, FAQ_A, FAQ_B, PIN_ONLY, PAX2]);
  // Aturan FAQ TIDAK ada di peta produk; aturan pin-saja ada.
  assert.deepEqual(runtime.productMap, { [PAX1]: "Produk Uji", [PIN_ONLY]: "Produk Uji Dua", [PAX2]: "Produk Uji Dua" });
  // Setiap aturan yang membalas punya kalimatnya sendiri.
  assert.equal(runtime.getReplyForScene(FAQ_A), "Harga terbarunya ada di etalase ya kak");
  assert.equal(runtime.getReplyForScene(FAQ_B), "COD belum tersedia kak, pakai transfer ya");
  assert.equal(runtime.getReplyForScene(PIN_ONLY), null, "pin-saja tidak punya balasan");
});

// --- 1. aturan balas-saja: terpicu sekali, satu balasan ---------------------

test("1. BALAS-SAJA: terpicu sekali, mengirim TEPAT satu balasan", async () => {
  bot.enqueueTrigger(ruleFor(FAQ_A), "penonton");
  await advance(QUEUE_KICK_MS);

  assert.equal(commentSends.length, 1, "tepat satu kiriman");
  assert.equal(commentSends[0].text, "Harga terbarunya ada di etalase ya kak");
  assert.equal(commentSends[0].scene, FAQ_A);
  assert.equal(commentSends[0].playId, undefined, "tanpa generasi pemutaran");
  assert.deepEqual(pinSends, [], "nol percobaan pin");
  assert.deepEqual(obsSwitches, [], "nol sentuhan OBS");
});

test("1b. BALAS-SAJA: dua puluh penonton serentak tetap satu balasan", async () => {
  const rule = ruleFor(FAQ_A);
  for (let i = 0; i < 20; i += 1) bot.enqueueTrigger(rule, "penonton" + i);
  await advance(QUEUE_KICK_MS);
  assert.equal(commentSends.length, 1);
});

// --- 2. aturan yang SAMA bisa terpicu lagi sesudah cooldown ----------------

test("2. BALAS-SAJA: aturan yang SAMA mengirim balasan KEDUA sesudah cooldown habis", async () => {
  // Ini pembuktian inti bahwa ketiadaan playId tidak membuat aturan ini
  // ter-dedupe permanen.
  const rule = ruleFor(FAQ_A);

  bot.enqueueTrigger(rule, "penonton-a");
  await advance(QUEUE_KICK_MS);
  assert.equal(commentSends.length, 1);

  // Masih di dalam cooldown: ditolak oleh cooldown, bukan oleh dedupe.
  bot.enqueueTrigger(rule, "penonton-b");
  await advance(1_000);
  assert.equal(commentSends.length, 1, "cooldown masih berjalan");
  assert.ok(logged("SKIP_COOLDOWN").length >= 1);

  // Cooldown habis -> boleh lagi.
  await advance(COOLDOWN_MS);
  bot.enqueueTrigger(rule, "penonton-c");
  await advance(0);

  assert.equal(commentSends.length, 2, "balasan kedua harus terkirim");
  assert.equal(commentSends[1].text, "Harga terbarunya ada di etalase ya kak");
});

test("2b. BALAS-SAJA: dispatcher AutoComment tidak menyimpan satu pun entri dedupe", async () => {
  // Bukti LANGSUNG bahwa tidak ada dedupe permanen: dedupe AutoComment bekerja
  // dengan mengingat playId, dan aturan tanpa scene tidak membawa playId sama
  // sekali — jadi tidak ada yang pernah diingat untuk menolaknya nanti.
  const rule = ruleFor(FAQ_A);
  bot.enqueueTrigger(rule, "a");
  await advance(QUEUE_KICK_MS);
  await advance(COOLDOWN_MS);
  bot.enqueueTrigger(rule, "b");
  await advance(0);

  const s = autoComment.__state();
  assert.equal(commentSends.length, 2);
  assert.equal(s.handled, 0, "nol playId yang diingat");
  assert.equal(s.latestPlayId, 0, "generasi pemutaran tidak pernah dinaikkan");
});

test("2c. BALAS-SAJA: terpicu berkali-kali lintas beberapa cooldown", async () => {
  // Tiga kali berturut-turut, supaya "boleh sekali lagi" tidak lolos sebagai
  // kebetulan.
  const rule = ruleFor(FAQ_A);
  for (let i = 0; i < 3; i += 1) {
    bot.enqueueTrigger(rule, "penonton" + i);
    await advance(QUEUE_KICK_MS);
    await advance(COOLDOWN_MS);
  }
  assert.equal(commentSends.length, 3);
});

// --- 3. dua aturan balas-saja yang BERBEDA ---------------------------------

test("3. DUA ATURAN BALAS-SAJA: masing-masing terpicu dan mengirim balasannya SENDIRI", async () => {
  bot.enqueueTrigger(ruleFor(FAQ_A), "penonton-a");
  await advance(QUEUE_KICK_MS);
  // Jeda minimum AutoComment yang SUNGGUHAN dihormati: dua kalimat dalam lima
  // detik memang dibatasi, dan itu rate limit — bukan dedupe.
  await advance(DEFAULT_MIN_INTERVAL_MS);
  bot.enqueueTrigger(ruleFor(FAQ_B), "penonton-b");
  await advance(QUEUE_KICK_MS);

  assert.equal(commentSends.length, 2);
  assert.deepEqual(
    commentSends.map((c) => c.text),
    ["Harga terbarunya ada di etalase ya kak", "COD belum tersedia kak, pakai transfer ya"]
  );
  assert.deepEqual(commentSends.map((c) => c.scene), [FAQ_A, FAQ_B]);
  assert.deepEqual(pinSends, []);
  assert.deepEqual(obsSwitches, []);
});

test("3b. DUA ATURAN BALAS-SAJA: cooldown satu aturan tidak membungkam aturan lain", async () => {
  // Cooldown dikunci per KUNCI ATURAN. Kalau ia bocor menjadi global, satu
  // pertanyaan harga akan membungkam semua FAQ lain selama dua menit.
  bot.enqueueTrigger(ruleFor(FAQ_A), "a");
  await advance(QUEUE_KICK_MS);
  await advance(DEFAULT_MIN_INTERVAL_MS);
  bot.enqueueTrigger(ruleFor(FAQ_B), "b");
  await advance(0);

  assert.equal(commentSends.length, 2);
  const cooling = state().cooldownScenes;
  assert.ok(cooling.includes(FAQ_A));
  assert.ok(cooling.includes(FAQ_B));
});

test("3c. CATATAN RATE LIMIT: dua FAQ dalam lima detik -> yang kedua dibatasi, bukan di-dedupe", async () => {
  // Perilaku yang memang ada di produksi dan TIDAK diubah v0.2.0: kuota
  // AutoComment bersifat global. Diuji supaya bedanya jelas — alasannya
  // min-interval, bukan stale/duplicate.
  bot.enqueueTrigger(ruleFor(FAQ_A), "a");
  await advance(QUEUE_KICK_MS);
  bot.enqueueTrigger(ruleFor(FAQ_B), "b");
  await advance(0);

  assert.equal(commentSends.length, 1, "yang kedua tertahan kuota");
  const skipped = logged("AUTOCOMMENT_SKIPPED");
  assert.ok(skipped.some((l) => l.includes("reason=min-interval")), skipped.join("\n"));
  assert.ok(!skipped.some((l) => l.includes("reason=stale")), "bukan basi");
  assert.ok(!skipped.some((l) => l.includes("duplicate-playId")), "bukan dedupe");

  // Dan begitu jeda minimum lewat, aturan kedua masih bisa bicara.
  await advance(DEFAULT_MIN_INTERVAL_MS);
  bot.enqueueTrigger(ruleFor(FAQ_B), "c");
  await advance(0);
  assert.equal(commentSends.length, 1, "cooldown aturan B masih berjalan dari percobaan tadi");
});

// --- 4. aturan pin-saja -----------------------------------------------------

test("4. PIN-SAJA: pin dikirim, tidak pernah ditolak basi, dan tanpa generasi pemutaran", async () => {
  bot.enqueueTrigger(ruleFor(PIN_ONLY), "penonton");
  await advance(QUEUE_KICK_MS);

  assert.equal(pinSends.length, 1);
  assert.equal(pinSends[0].productKey, "Produk Uji Dua", "kunci produk dari peta produksi");
  assert.equal(pinSends[0].playId, undefined);
  assert.equal(pinSends[0].scene, PIN_ONLY);
  assert.deepEqual(commentSends, [], "pin-saja tidak membalas");
  assert.deepEqual(obsSwitches, []);
  assert.deepEqual(logged("AUTOPIN_STALE"), [], "tidak ada yang basi");
  assert.ok(logged("AUTOPIN_SUCCESS").length === 1);
});

test("4b. PIN-SAJA: dispatcher AutoPIN tidak menaikkan latestPlayId", async () => {
  // Kalau ia menaikkannya, pin milik scene yang sedang tayang akan dibuang
  // sebagai basi. Lihat juga uji 5.
  bot.enqueueTrigger(ruleFor(PIN_ONLY), "penonton");
  await advance(QUEUE_KICK_MS);
  assert.equal(scenePin.__state().latestPlayId, 0);
});

test("4c. PIN-SAJA: bisa mem-pin lagi sesudah cooldown, tidak ter-dedupe permanen", async () => {
  const rule = ruleFor(PIN_ONLY);
  bot.enqueueTrigger(rule, "a");
  await advance(QUEUE_KICK_MS);
  await advance(COOLDOWN_MS);
  bot.enqueueTrigger(rule, "b");
  await advance(0);
  assert.equal(pinSends.length, 2);
});

test("4d. PIN-SAJA: PIN SERVICE SUNGGUHAN menerima playId yang tidak ada, dan benar-benar mengklik", async () => {
  // Sisi service, lewat createService produksi dengan browser palsu. Inilah
  // yang menjawab "apakah AutoPIN menuntut adanya generasi pemutaran".
  const clicks = [];
  const svc = createService({
    config: { consoleUrl: CONSOLE_URL, expectedShop: "agen_mulia_abadi", forbiddenShops: ["garudafood"] },
    deps: fakeBrowserDeps(clicks),
  });

  // playId memang TIDAK dikirim — persis seperti yang dilakukan
  // createHttpSender untuk aturan tanpa scene (JSON.stringify membuang
  // field undefined).
  const r = await svc.handlePin({ scene: PIN_ONLY, productKey: "Produk Uji Satu", sessionId: "sesi-uji" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.clicked, true);
  assert.deepEqual(clicks, ["Produk Uji Satu"]);
  // Dan generasi service tidak bergerak.
  assert.equal(svc.__state().latestPlayId, 0);
});

test("4e. PIN-SAJA: service mengizinkan pengulangan, lalu TETAP menjaga pin scene dari basi", async () => {
  const clicks = [];
  const svc = createService({
    config: { consoleUrl: CONSOLE_URL, expectedShop: "agen_mulia_abadi", forbiddenShops: ["garudafood"] },
    deps: fakeBrowserDeps(clicks),
  });

  // Dua permintaan pin-saja berturut-turut: KEDUANYA mengklik. Permintaan tanpa
  // generasi pemutaran bukan "pemutaran yang sama diulang", jadi dedupe
  // duplicate-playId tidak berlaku untuknya.
  await svc.handlePin({ scene: PIN_ONLY, productKey: "Produk Uji Satu", sessionId: "s" });
  await svc.handlePin({ scene: PIN_ONLY, productKey: "Produk Uji Satu", sessionId: "s" });
  assert.deepEqual(clicks, ["Produk Uji Satu", "Produk Uji Satu"]);

  // Sekarang sebuah scene sungguhan dengan playId 7.
  const scenePinResult = await svc.handlePin({ scene: PAX1, productKey: "Produk Uji Dua", playId: 7, sessionId: "s" });
  assert.equal(scenePinResult.ok, true);
  assert.equal(svc.__state().latestPlayId, 7);

  // Pin-saja sesudahnya masih boleh mengklik...
  const after = await svc.handlePin({ scene: PIN_ONLY, productKey: "Produk Uji Satu", sessionId: "s" });
  assert.equal(after.ok, true, "tanpa generasi = tidak pernah basi");
  // ...dan TIDAK menurunkan generasi scene, jadi perlindungan basi tetap utuh:
  // permintaan scene yang lebih tua tetap ditolak.
  assert.equal(svc.__state().latestPlayId, 7);
  const older = await svc.handlePin({ scene: PAX2, productKey: "Produk Uji Dua", playId: 6, sessionId: "s" });
  assert.equal(older.ok, false);
  assert.equal(older.reason, "stale");
});

test("4f. model generasi service: playId yang tidak ada tidak basi dan tidak menggeser generasi", () => {
  // Modul generasi yang SAMA yang dipakai service. Pengecualian playId <= 0 ini
  // sudah ada sejak perbaikan 2026-10-05 untuk alat diagnostik; jalur aturan
  // tanpa scene memakainya, bukan melemahkannya.
  const g = createPlayGeneration();
  g.note({ sessionId: "s", playId: 5 });
  assert.equal(g.latest(), 5);

  for (const playId of [undefined, 0]) {
    assert.equal(g.isStale({ sessionId: "s", playId }), false, "playId=" + playId);
    g.note({ sessionId: "s", playId });
    assert.equal(g.latest(), 5, "generasi tidak boleh bergeser oleh playId=" + playId);
  }
  // Perlindungan basi untuk pemutaran sungguhan TIDAK berubah.
  assert.equal(g.isStale({ sessionId: "s", playId: 4 }), true);
  assert.equal(g.isStale({ sessionId: "s", playId: 6 }), false);
});

// --- 5. interleaving: FAQ di tengah generasi PAX yang aktif -----------------

test("5. INTERLEAVING: FAQ di tengah PAX tidak menggeser generasi, dan PAX tetap selesai", async () => {
  // Skenario yang paling berbahaya, dan alasan playId sengaja tidak dinaikkan.
  let releasePin;
  pinBehaviour = () => new Promise((res) => { releasePin = () => res(PIN_CONFIRMED); });

  bot.enqueueTrigger(ruleFor(PAX1), "penonton-pax");
  await advance(QUEUE_KICK_MS);

  const paxPlayId = state().activePlayId;
  assert.ok(paxPlayId > 0, "PAX harus punya generasi pemutaran");
  assert.equal(obsSwitches.length, 1);
  assert.equal(pinSends.length, 1, "pin PAX sedang menggantung");
  assert.equal(pinSends[0].playId, paxPlayId);
  const pinLatestBefore = scenePin.__state().latestPlayId;
  const commentLatestBefore = autoComment.__state().latestPlayId;

  // FAQ menyalip selagi pin PAX masih berjalan.
  bot.enqueueTrigger(ruleFor(FAQ_A), "penonton-faq");
  await advance(0);

  assert.equal(commentSends.length, 1, "FAQ membalas");
  assert.equal(commentSends[0].scene, FAQ_A);

  // Generasi pemutaran TIDAK tergeser, di ketiga tempat yang menyimpannya.
  assert.equal(state().activePlayId, paxPlayId, "generasi aktif bot tidak berubah");
  assert.equal(scenePin.__state().latestPlayId, pinLatestBefore, "AutoPIN tidak tergeser");
  assert.equal(autoComment.__state().latestPlayId, commentLatestBefore, "AutoComment tidak tergeser");
  assert.equal(state().activeScene, PAX1, "PAX masih tayang");

  // Jeda minimum dilewati supaya yang diuji adalah basi/dedupe, bukan kuota.
  await advance(DEFAULT_MIN_INTERVAL_MS);
  releasePin();
  await advance(0);

  // Pin PAX selesai normal, dan balasan PAX terkirim dengan playId-nya sendiri.
  assert.ok(logged("AUTOPIN_SUCCESS").length >= 1);
  assert.deepEqual(logged("AUTOPIN_STALE"), [], "pin PAX tidak boleh jadi basi");
  const paxComment = commentSends.find((c) => c.scene === PAX1);
  assert.ok(paxComment, "balasan PAX harus terkirim: " + JSON.stringify(commentSends));
  assert.equal(paxComment.text, "Etalase 1 sudah aku pin ya kak");
  assert.equal(paxComment.playId, paxPlayId, "korelasi playId PAX utuh");
  assert.deepEqual(logged("AUTOCOMMENT_STALE"), [], "balasan PAX tidak boleh jadi basi");
});

test("5b. INTERLEAVING: bukti pin PAX tetap dituntut, FAQ tidak melemahkannya", async () => {
  // Gerbang CONFIRMED harus tetap membungkam PAX yang pin-nya gagal, walaupun
  // sebuah FAQ baru saja berhasil bicara dengan requirePin=false.
  pinBehaviour = async () => ({ ok: false, reason: "product-not-found" });

  bot.enqueueTrigger(ruleFor(FAQ_A), "penonton-faq");
  await advance(QUEUE_KICK_MS);
  assert.equal(commentSends.length, 1, "FAQ boleh bicara");

  await advance(DEFAULT_MIN_INTERVAL_MS);
  bot.enqueueTrigger(ruleFor(PAX1), "penonton-pax");
  await advance(QUEUE_KICK_MS);

  assert.deepEqual(obsSwitches, [PAX1], "scene PAX tetap berpindah");
  assert.equal(commentSends.length, 1, "PAX yang gagal pin TETAP dibungkam");
  assert.ok(logged("AUTOCOMMENT_SKIPPED").some((l) => l.includes("product-not-found")), logged("AUTOCOMMENT_SKIPPED").join("\n"));
});

// --- 6. PAX sesudah aturan balas-saja --------------------------------------

test("6. SESUDAH BALAS-SAJA: PAX berikutnya tetap scene + pin + balas", async () => {
  bot.enqueueTrigger(ruleFor(FAQ_A), "penonton-faq");
  await advance(QUEUE_KICK_MS);
  assert.equal(commentSends.length, 1);

  await advance(DEFAULT_MIN_INTERVAL_MS);
  bot.enqueueTrigger(ruleFor(PAX1), "penonton-pax");
  await advance(QUEUE_KICK_MS);

  assert.deepEqual(obsSwitches, [PAX1], "scene berpindah");
  const paxPin = pinSends.find((p) => p.scene === PAX1);
  assert.ok(paxPin, "pin PAX dikirim");
  assert.equal(paxPin.productKey, "Produk Uji");
  assert.ok(paxPin.playId > 0, "dengan generasi pemutaran sungguhan");
  const paxComment = commentSends.find((c) => c.scene === PAX1);
  assert.ok(paxComment, "balasan PAX terkirim");
  assert.equal(paxComment.text, "Etalase 1 sudah aku pin ya kak");
  assert.equal(paxComment.playId, paxPin.playId, "keduanya satu generasi");
  assert.equal(state().activeScene, PAX1);
});

test("6b. SESUDAH BALAS-SAJA: nomor generasi PAX tetap BERURUTAN, tidak melompat", async () => {
  // Pembuktian bahwa penghitung playId tidak tercemar oleh aturan tanpa scene.
  //
  // Yang diperiksa adalah SELISIHNYA, bukan nilai mutlaknya: playSeq adalah
  // penghitung tingkat-modul di index.js yang memang tidak direset antar tes
  // (__test.reset() tidak menyentuhnya, dan itu benar — restart bot yang
  // mereset penghitung justru bug 2026-10-05 yang sudah diperbaiki di sisi
  // service). Nilai mutlak di sini hanya akan mengukur urutan tes.
  bot.enqueueTrigger(ruleFor(PAX1), "a");
  await advance(QUEUE_KICK_MS);
  const first = pinSends.find((p) => p.scene === PAX1).playId;

  bot.endCurrentScene("test", false);

  // DUA aturan balas-saja terpicu di antara kedua pemutaran. Kalau salah satu
  // dari keduanya menaikkan penghitung, selisih di bawah tidak akan 1 lagi.
  await advance(DEFAULT_MIN_INTERVAL_MS);
  bot.enqueueTrigger(ruleFor(FAQ_A), "faq-a");
  await advance(0);
  bot.enqueueTrigger(ruleFor(FAQ_B), "faq-b");
  await advance(0);

  await advance(DEFAULT_MIN_INTERVAL_MS);
  bot.enqueueTrigger(ruleFor(PAX2), "b");
  await advance(QUEUE_KICK_MS);
  const second = pinSends.find((p) => p.scene === PAX2).playId;

  assert.equal(second - first, 1, "aturan tanpa scene tidak boleh menghabiskan nomor generasi");
  // Kembali ke MAIN di antaranya adalah perilaku normal akhir pemutaran. Ia
  // memanggil obs.call langsung (index.js), bukan switchScene, jadi ia juga
  // tidak menghabiskan nomor generasi — itulah sebabnya selisih di atas 1.
  assert.deepEqual(obsSwitches, [PAX1, SCENES.MAIN, PAX2]);
  assert.ok(commentSends.find((c) => c.scene === PAX2), "balasan PAX-2 terkirim");
});

// --- 7. prioritas: alur produksi yang dilaporkan -----------------------------

test("7. ALUR PRODUKSI: FAQ lalu PAX dalam <5 detik -> balasan produk TETAP terkirim", async () => {
  // Reproduksi persis kejadian yang dilaporkan, lewat jalur index.js yang
  // sungguhan dan kedua dispatcher produksi:
  //
  //   balasan FAQ (normal)
  //   -> penonton minta produk beberapa saat kemudian
  //   -> scene berganti
  //   -> AutoPIN terkonfirmasi (dengan latensi seperti di LIVE)
  //   -> balasan produk (high) HARUS terkirim, walau belum lima detik
  //
  // Sebelum limiter dua jam, balasan terakhir itu hilang dengan
  // reason=min-interval dan tidak ada apa pun di dashboard yang menjelaskannya.
  bot.enqueueTrigger(ruleFor(FAQ_A), "penonton-faq");
  await advance(QUEUE_KICK_MS);
  assert.equal(commentSends.length, 1, "FAQ terkirim lebih dulu");
  assert.equal(commentSends[0].scene, FAQ_A);

  // Pin dengan latensi sekitar angka yang teramati di LIVE (~1,2 detik).
  let releasePin;
  pinBehaviour = () => new Promise((res) => { releasePin = () => res(PIN_CONFIRMED); });

  bot.enqueueTrigger(ruleFor(PAX1), "penonton-pax");
  await advance(QUEUE_KICK_MS);
  assert.deepEqual(obsSwitches, [PAX1], "scene berganti");

  await advance(1_200);
  releasePin();
  await advance(0);

  // Total yang berlalu sejak balasan FAQ masih jauh di bawah lima detik.
  const paxComment = commentSends.find((c) => c.scene === PAX1);
  assert.ok(paxComment, "balasan produk HARUS terkirim: " + JSON.stringify(commentSends));
  assert.equal(paxComment.text, "Etalase 1 sudah aku pin ya kak");
  assert.ok(
    !logged("AUTOCOMMENT_SKIPPED").some((l) => l.includes("reason=min-interval")),
    logged("AUTOCOMMENT_SKIPPED").join(" | ")
  );
  const s = autoComment.__state();
  assert.equal(s.lastHighSentAt, s.lastAnySentAt, "kiriman high memperbarui kedua jam");
});

test("7b. ALUR PRODUKSI: sesudah balasan produk, FAQ berikutnya TETAP ditahan lima detik", async () => {
  // Sisi lain asimetrinya: prioritas tidak boleh menjadi celah spam.
  bot.enqueueTrigger(ruleFor(PAX1), "penonton-pax");
  await advance(QUEUE_KICK_MS);
  assert.ok(commentSends.find((c) => c.scene === PAX1), "balasan produk terkirim");

  await advance(2_000);
  bot.enqueueTrigger(ruleFor(FAQ_A), "penonton-faq");
  await advance(0);
  assert.equal(commentSends.length, 1, "FAQ ditahan: belum lima detik sejak kiriman terakhir");
  assert.ok(logged("AUTOCOMMENT_SKIPPED").some((l) => l.includes("reason=min-interval")));

  // Dan sesudah lima detik penuh ia boleh bicara. Aturan FAQ_B dipakai karena
  // FAQ_A sudah masuk cooldown per-aturan oleh percobaan di atas.
  await advance(DEFAULT_MIN_INTERVAL_MS);
  bot.enqueueTrigger(ruleFor(FAQ_B), "penonton-lain");
  await advance(0);
  assert.equal(commentSends.length, 2);
});

test("7c. ALUR PRODUKSI: pin GAGAL tetap membungkam balasan produk, prioritas tidak menolong", async () => {
  pinBehaviour = async () => ({ ok: false, reason: "product-not-found" });
  bot.enqueueTrigger(ruleFor(PAX1), "penonton-pax");
  await advance(QUEUE_KICK_MS);

  assert.deepEqual(obsSwitches, [PAX1], "scene tetap berganti");
  assert.deepEqual(commentSends, [], "nol balasan");
  // Dan kuotanya tidak terbakar, jadi FAQ sesudahnya tetap bisa bicara.
  assert.equal(autoComment.__state().sentInWindow, 0);
  await advance(DEFAULT_MIN_INTERVAL_MS);
  bot.enqueueTrigger(ruleFor(FAQ_A), "penonton-faq");
  await advance(0);
  assert.equal(commentSends.length, 1);
});

// --- pembantu: browser palsu untuk service AutoPIN --------------------------

const CONSOLE_URL = "https://shop.tiktok.com/streamer/live/product/dashboard";

const SERVICE_SNAPSHOT = {
  products: [
    { number: 1, title: "Produk Uji Satu", pinButtons: 1, pinVisible: true, pinDisabled: false },
    { number: 2, title: "Produk Uji Dua", pinButtons: 1, pinVisible: true, pinDisabled: false },
  ],
  livePinButtonsOnPage: 2,
};

// Cukup untuk menjalankan SELURUH urutan gerbang service tanpa Chromium.
// Bentuknya disalin dari test/autopin.service.test.js, yang sudah dipakai untuk
// membuktikan perilaku basi in-flight.
function fakeBrowserDeps(clicks) {
  return {
    launchBrowser: async () => ({ id: "fake-browser" }),
    getPage: async () => ({ url: () => CONSOLE_URL, isClosed: () => false }),
    openConsole: async () => ({ url: CONSOLE_URL, settled: true, readyMs: 1 }),
    closeBrowser: async () => {},
    readIdentity: async () => ["agen_mulia_abadi"],
    collectProducts: async () => SERVICE_SNAPSHOT,
    pinProductByTitle: async (_page, key) => { clicks.push(key); return { ok: true, title: key }; },
    readPinState: async () => ({ text: "Unpin", disabled: false, buttons: 1 }),
  };
}
