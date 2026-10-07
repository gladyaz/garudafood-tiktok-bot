// DEFINITION OF DONE P2, dijalankan ujung ke ujung.
//
// Yang dibuktikan di sini bukan bahwa modul-modul baru bekerja sendiri-sendiri —
// itu ada di berkas tes masing-masing. Yang dibuktikan di sini adalah bahwa
// config customer BENAR-BENAR mengendalikan produksi:
//
//   trigger di config  -> matcher PRODUKSI merutekan ke scene itu
//   produk di config   -> permintaan AutoPIN PRODUKSI membawa judul itu
//   reply di config    -> permintaan AutoComment PRODUKSI membawa teks itu
//
// Caranya: index.js SUNGGUHAN dijalankan dengan AILIVE_RUNTIME_CONFIG menunjuk ke
// artefak config runtime yang dibuat di direktori sementara. Tidak ada matcher
// tiruan, tidak ada jalur pencocokan paralel. Kalau tes ini hijau, jalurnya nyata.
//
// Tetap 100% offline: obs.call di-stub, AutoPIN dan AutoComment diganti palsu
// lewat hook __test yang sudah ada. Nol TikTok, nol OBS, nol browser, nol proses.

const { test, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const { buildRuntimeConfig, writeRuntimeConfig, RUNTIME_CONFIG_ENV } = require("../runtime/runtime-config");

// Artefak ditulis ke direktori sementara nyata, bukan fs palsu: index.js membaca
// berkasnya sendiri lewat fs, dan jalur pembacaan itu bagian dari yang diuji.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ailive-p2-"));

// Produk dan teks yang dipilih sengaja TIDAK ada di keyword maupun template
// bawaan, supaya tidak mungkin lolos karena kebetulan cocok dengan yang lama.
const PRODUCT_A = "O'CORN Sea Salt 80gr";
const REPLY_A = "Etalase 1 sudah aku pin ya kak";
const TRIGGERS_A = ["spill etalase 1", "etalase satu"];

const MAPPINGS = [
  { scene: "PAX-1", product: { title: PRODUCT_A }, triggers: TRIGGERS_A, reply: REPLY_A },
  { scene: "PAX-2", product: { title: "Dilan Cookies Choco Chip" }, triggers: ["kode dua"], reply: "Etalase 2 siap kak" },
];

const artifact = buildRuntimeConfig({ mappings: MAPPINGS, configVersion: 1 });
const ARTIFACT_FILE = path.join(TMP, "runtime-" + artifact.id + ".json");
const written = writeRuntimeConfig(ARTIFACT_FILE, artifact);
assert.equal(written.ok, true, "artefak harus bisa ditulis");

// Environment disiapkan SEBELUM index.js di-require: ia membaca config runtime di
// tingkat modul, sama seperti ia membaca .env.
process.env[RUNTIME_CONFIG_ENV] = ARTIFACT_FILE;
process.env.SCENE_REPLAY_COOLDOWN_MS = "120000";
process.env.DOTENV_CONFIG_QUIET = "true";

const bot = require("../index.js");
const { SCENES } = bot;

const PAX1 = SCENES.AILIVE_SKUPAXSATU;
const PAX2 = SCENES.AILIVE_SKUPAXDUA;
const QUEUE_KICK_MS = 50;

let obsSwitches = [];
let commentRequests = [];
let pinRequests = [];
let logs = [];

const flush = () => new Promise((r) => setImmediate(r));
async function advance(ms) {
  mock.timers.tick(ms);
  await flush();
}
const chat = (user, comment) => bot.handleChat({ nickname: user, comment });
const state = () => bot.__test.getState();

function fakeComment() {
  return {
    requestComment(req) {
      commentRequests.push(req);
      return Promise.resolve({ ok: true, reason: "dry-run", dryRun: true });
    },
  };
}
function fakePin() {
  return {
    requestPin(req) {
      pinRequests.push(req);
      return Promise.resolve({ ok: true });
    },
  };
}

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  obsSwitches = [];
  commentRequests = [];
  pinRequests = [];
  logs = [];
  const capture = (...args) => logs.push(args.map(String).join(" "));
  mock.method(console, "log", capture);
  mock.method(console, "warn", capture);
  mock.method(console, "error", capture);

  bot.obs.call = (request, params = {}) => {
    if (request !== "SetCurrentProgramScene") return Promise.resolve();
    obsSwitches.push(params.sceneName);
    return Promise.resolve();
  };
  bot.__test.setScenePin(fakePin());
  bot.__test.setAutoComment(fakeComment());
  bot.__test.reset();
});

afterEach(() => {
  bot.__test.reset();
  mock.timers.reset();
  mock.restoreAll();
});

// --- snapshot runtime --------------------------------------------------------

test("bot berjalan dalam MODE CONFIG, bukan legacy", () => {
  assert.equal(bot.__test.runtimeSource(), "config");
  assert.equal(bot.__test.runtimeGeneration(), artifact.id);
});

test("hanya scene yang DIPETAKAN customer yang aktif", () => {
  // Inilah yang membuat config jadi otoritatif. Kalau rule hardcoded ikut aktif,
  // bot akan merespons kata kunci yang customer tidak pernah lihat dan tidak
  // bisa matikan.
  const scenes = bot.activeRules().map((r) => r.scene);
  assert.deepEqual(scenes.sort(), ["PAX-1", "PAX-2"]);
  assert.equal(bot.RULES.length, 14, "RULES hardcoded tetap utuh sebagai sumber detail pemutaran");
});

test("detail pemutaran tetap diwarisi dari RULES, bukan dikarang", () => {
  // Config customer tidak punya mediaInputs/duration, dan tidak boleh punya:
  // keduanya detail OBS (nama input seperti "Media 3", bukan nama berkas) dan
  // durasi failsafe yang diukur dari video aslinya.
  const base = bot.RULES.find((r) => r.scene === PAX1);
  const live = bot.activeRules().find((r) => r.scene === PAX1);
  assert.deepEqual(live.mediaInputs, base.mediaInputs);
  assert.equal(live.waitForMediaEnd, base.waitForMediaEnd);
  assert.equal(live.duration, base.duration);
  // Tapi keyword-nya DIGANTI, bukan digabung.
  assert.deepEqual(live.keywords, TRIGGERS_A);
});

// --- DoD: trigger mengendalikan pencocokan -----------------------------------

test("DoD: trigger dari config merutekan komentar penonton ke scene yang benar", async () => {
  // "etalase satu" hanya ada di config. Matcher PRODUKSI yang memutuskan.
  chat("penonton", "etalase satu");
  await advance(QUEUE_KICK_MS);

  assert.equal(state().activeScene, PAX1);
  assert.deepEqual(obsSwitches, [PAX1]);
});

test("DoD: trigger kedua untuk scene yang sama juga bekerja", async () => {
  chat("penonton", "spill etalase 1");
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, PAX1);
});

test("trigger dinormalkan dengan normalisasi PRODUKSI", async () => {
  // Config menulis "etalase satu"; penonton mengetik "ETALASE 1!!!". Keduanya
  // bertemu hanya kalau normalisasi yang sama dipakai di kedua sisi.
  chat("penonton", "ETALASE 1!!!");
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, PAX1);
});

test("kata kunci HARDCODED yang tidak ada di config TIDAK LAGI memicu scene", async () => {
  // "ting ting" adalah keyword PAX-1 di array RULES, dan sengaja TIDAK
  // dimasukkan ke config. Kalau ini masih memicu, berarti rule hardcoded bocor
  // ke mode config dan customer tidak punya kendali penuh.
  chat("penonton", "ting ting");
  await advance(QUEUE_KICK_MS);

  assert.equal(state().activeScene, null);
  assert.deepEqual(obsSwitches, []);
});

test("scene yang tidak dipetakan tidak bisa dipicu sama sekali", async () => {
  // "chocolatos pillow" adalah keyword PAX-3 di RULES. PAX-3 tidak ada di config.
  chat("penonton", "chocolatos pillow");
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, null);
});

// --- DoD: produk dan balasan sampai ke jalur auxiliary -----------------------

test("DoD: permintaan AutoPIN membawa produk dari config", async () => {
  chat("penonton", "etalase satu");
  await advance(QUEUE_KICK_MS);
  await flush();

  assert.equal(pinRequests.length, 1);
  assert.equal(pinRequests[0].scene, PAX1);
  // Peta scene->produk yang dipakai dispatcher produksi.
  assert.equal(bot.__test.autopinMap()[PAX1], PRODUCT_A);
});

test("DoD: permintaan AutoComment membawa PERSIS balasan dari config", async () => {
  chat("penonton", "etalase satu");
  await advance(QUEUE_KICK_MS);
  await flush();

  assert.equal(commentRequests.length, 1);
  assert.equal(commentRequests[0].scene, PAX1);
  // Inilah pembuktian yang paling penting di berkas ini: teks yang akan dibaca
  // penonton adalah teks yang ditulis customer, bukan DEFAULT_TEMPLATE.
  const formatted = bot.__test.runtimeFormat(PAX1);
  assert.equal(formatted.ok, true);
  assert.equal(formatted.text, REPLY_A);
});

test("balasan dipakai APA ADANYA: tanpa placeholder, tanpa emoji tambahan", () => {
  const formatted = bot.__test.runtimeFormat(PAX1);
  assert.equal(formatted.text, REPLY_A);
  // Template bawaan berakhir dengan emoji keranjang. Kalau itu muncul di sini,
  // berarti formatter bawaan yang menjawab, bukan config.
  assert.ok(!formatted.text.includes("🛒"), "tidak boleh memakai template bawaan");
  assert.ok(!formatted.text.includes("{n}"), "tidak ada placeholder yang tertinggal");
});

test("balasan berbeda per scene", () => {
  assert.equal(bot.__test.runtimeReplyFor(PAX1), REPLY_A);
  assert.equal(bot.__test.runtimeReplyFor(PAX2), "Etalase 2 siap kak");
});

test("scene tanpa balasan membuat AutoComment DIAM, bukan mengarang", () => {
  // PAX-3 tidak dipetakan sama sekali.
  const formatted = bot.__test.runtimeFormat("PAX-3");
  assert.equal(formatted.ok, false);
  assert.equal(formatted.reason, "no-reply-configured");
});

// --- jaminan P1 tetap berlaku ------------------------------------------------

test("urutan auxiliary tidak berubah: AutoPIN dulu, hasilnya menentukan AutoComment", async () => {
  chat("penonton", "etalase satu");
  await advance(QUEUE_KICK_MS);
  await flush();

  assert.equal(pinRequests.length, 1);
  assert.equal(commentRequests.length, 1);
  // AutoComment menerima hasil pin, sama seperti sebelum P2.
  assert.deepEqual(commentRequests[0].pin, { ok: true });
});

test("dedupe dan cooldown per scene tidak berubah", async () => {
  chat("a", "etalase satu");
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, PAX1);

  // Permintaan kedua untuk scene yang sedang aktif tidak memutar ulang.
  chat("b", "etalase satu");
  await advance(QUEUE_KICK_MS);
  assert.deepEqual(obsSwitches, [PAX1]);
});

test("agregasi tetap bekerja: dua penonton meminta scene yang sama = satu pemutaran", async () => {
  chat("a", "etalase satu");
  chat("b", "spill etalase 1");
  await advance(QUEUE_KICK_MS);

  assert.deepEqual(obsSwitches, [PAX1]);
  assert.equal(pinRequests.length, 1);
});

test("snapshot runtime TIDAK BISA diubah saat berjalan", () => {
  // Config yang disimpan di tengah LIVE tidak boleh mengubah pemutaran yang
  // sedang berlangsung. Jaminannya bukan kesepakatan, tapi objek yang dibekukan.
  const rulesBefore = bot.activeRules().map((r) => r.scene).sort();

  // Semua upaya di bawah harus gagal atau tidak berpengaruh. Mode non-strict
  // tidak melempar, jadi yang diperiksa adalah nilainya tidak berubah.
  const live = bot.activeRules().find((r) => r.scene === PAX1);
  try {
    live.keywords.push("trigger selundupan");
  } catch {
    /* frozen: melempar di strict mode, itu juga hasil yang benar */
  }
  try {
    live.scene = "PAX-9";
  } catch {
    /* sama */
  }

  assert.deepEqual(bot.activeRules().map((r) => r.scene).sort(), rulesBefore);
  assert.deepEqual(bot.activeRules().find((r) => r.scene === PAX1).keywords, TRIGGERS_A);
});

test("trigger selundupan tidak bisa menambah scene baru ke snapshot", async () => {
  // Bahkan kalau sesuatu berhasil mengubah array rule, scene yang tidak ada di
  // config tidak boleh bisa dipicu.
  chat("penonton", "trigger selundupan");
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, null);
});

test("peta produk tidak bisa diubah saat berjalan", () => {
  const before = bot.__test.autopinMap()[PAX1];
  // autopinMap() mengembalikan salinan, jadi mengubahnya tidak berpengaruh.
  const copy = bot.__test.autopinMap();
  copy[PAX1] = "Produk Selundupan";
  assert.equal(bot.__test.autopinMap()[PAX1], before);
});

test("tidak ada rahasia di artefak config runtime", () => {
  const parsed = JSON.parse(fs.readFileSync(ARTIFACT_FILE, "utf8"));

  // Diperiksa secara STRUKTURAL, bukan dengan mencari kata terlarang di teks.
  // Pencarian kata gagal ke dua arah: ia melewatkan rahasia yang namanya tidak
  // ada di daftar, dan ia salah menuduh isi yang sah — judul produk "Dilan
  // Cookies Choco Chip" mengandung "cookie" tanpa ada cookie di dalamnya.
  //
  // Daftar kunci yang TERTUTUP inilah jaminannya: apa pun yang baru harus lewat
  // sini dulu, dengan sadar.
  assert.deepEqual(Object.keys(parsed).sort(), ["configVersion", "createdAt", "id", "mappings", "version"]);
  for (const m of parsed.mappings) {
    assert.deepEqual(Object.keys(m).sort(), ["product", "reply", "scene", "triggers"]);
    if (m.product !== null) assert.deepEqual(Object.keys(m.product), ["title"]);
  }

  // Dan nilai rahasia yang sungguhan ada di config customer tidak boleh ikut.
  const raw = JSON.stringify(parsed);
  // Nama field rahasia maupun nilainya tidak pernah ada di artefak. Diperiksa
  // dengan nama field, bukan dengan nilai sentinel: artefak ini dibuat dari
  // MAPPINGS yang memang tidak memuat blok obs sama sekali.
  assert.ok(!("obs" in parsed), "blok obs tidak boleh ikut");
  assert.ok(!("settings" in parsed), "settings tidak boleh ikut");
  assert.ok(!raw.includes("AUTOPIN_PROFILE_DIR"), "path profil browser tidak boleh ikut");
  assert.ok(!/\.autopin-profile/.test(raw), "direktori profil tidak boleh ikut");
});
