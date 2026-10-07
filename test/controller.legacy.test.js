// KOMPATIBILITAS MUNDUR: tanpa config runtime, bot harus berperilaku PERSIS
// seperti sebelum P2.
//
// Ini pasangan dari test/controller.runtime.test.js. Yang di sana membuktikan
// config mengendalikan produksi; yang di sini membuktikan bahwa tidak adanya
// config tidak mengubah apa pun.
//
// Kenapa berkas tersendiri: index.js membaca config runtime di tingkat modul,
// jadi "dengan config" dan "tanpa config" tidak bisa hidup di satu proses tes.
// Berkas ini SENGAJA tidak menyetel AILIVE_RUNTIME_CONFIG.
//
// Jalur yang dilindungi di sini adalah jalur yang dipakai operator hari ini:
// `node index.js` dari terminal, dengan .env dan array RULES. Kalau P2 merusaknya,
// yang rusak bukan fitur baru — yang rusak adalah cara sistem ini dijalankan
// selama ini.

const { test, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");

const { RUNTIME_CONFIG_ENV } = require("../runtime/runtime-config");

// Dipastikan BERSIH sebelum index.js dimuat: kalau variabel ini bocor dari
// lingkungan luar, tes ini akan menguji hal yang salah tanpa memberi tahu.
delete process.env[RUNTIME_CONFIG_ENV];

// Peta produk legacy dari environment, bentuk yang sama dengan .env.
process.env.AUTOPIN_PRODUCT_PAX_1 = "kunci legacy satu";
process.env.AUTOPIN_PRODUCT_PAX_4 = "kunci legacy empat";
process.env.SCENE_REPLAY_COOLDOWN_MS = "120000";
process.env.DOTENV_CONFIG_QUIET = "true";

const bot = require("../index.js");
const { formatSceneMessage, DEFAULT_TEMPLATE } = require("../autocomment/formatter");
const { SCENES } = bot;

const PAX1 = SCENES.AILIVE_SKUPAXSATU;
const PAX3 = SCENES.AILIVE_SKUPAXTIGA;
const QUEUE_KICK_MS = 50;

let obsSwitches = [];
let pinRequests = [];
let commentRequests = [];

const flush = () => new Promise((r) => setImmediate(r));
async function advance(ms) {
  mock.timers.tick(ms);
  await flush();
}
const chat = (user, comment) => bot.handleChat({ nickname: user, comment });
const state = () => bot.__test.getState();

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  obsSwitches = [];
  pinRequests = [];
  commentRequests = [];
  const capture = () => {};
  mock.method(console, "log", capture);
  mock.method(console, "warn", capture);
  mock.method(console, "error", capture);

  bot.obs.call = (request, params = {}) => {
    if (request !== "SetCurrentProgramScene") return Promise.resolve();
    obsSwitches.push(params.sceneName);
    return Promise.resolve();
  };
  bot.__test.setScenePin({
    requestPin(req) {
      pinRequests.push(req);
      return Promise.resolve({ ok: true });
    },
  });
  bot.__test.setAutoComment({
    requestComment(req) {
      commentRequests.push(req);
      return Promise.resolve({ ok: true, dryRun: true });
    },
  });
  bot.__test.reset();
});

afterEach(() => {
  bot.__test.reset();
  mock.timers.reset();
  mock.restoreAll();
});

test("tanpa config runtime, mode-nya LEGACY", () => {
  assert.equal(bot.__test.runtimeSource(), "legacy");
  assert.equal(bot.__test.runtimeGeneration(), null);
});

test("rule aktif tetap datang dari array RULES", () => {
  // Jumlah dan isinya sama seperti sebelum P2: semua rule yang tidak ditandai
  // enabled:false.
  const expected = bot.RULES.filter((r) => r.enabled !== false).map((r) => r.scene);
  assert.deepEqual(bot.activeRules().map((r) => r.scene), expected);
  assert.ok(expected.length > 0);
});

test("activeRules mengembalikan OBJEK RULE YANG SAMA, bukan salinan", () => {
  // Penting karena jalur playback membandingkan rule dengan ===, dan karena
  // mengubah rule.enabled saat berjalan adalah perilaku yang didokumentasikan.
  const live = bot.activeRules().find((r) => r.scene === PAX1);
  const base = bot.RULES.find((r) => r.scene === PAX1);
  assert.equal(live, base, "harus objek yang sama");
});

test("rule TIDAK dibekukan: enabled masih bisa diubah saat berjalan", () => {
  // Regresi yang nyaris terjadi saat P2 dibuat: membekukan snapshot ikut
  // membekukan array RULES, sehingga `rule.enabled = true` gagal DIAM-DIAM
  // (mode non-strict tidak melempar) dan scene FAQ tidak akan pernah bisa
  // dinyalakan lagi tanpa ada pesan apa pun yang menjelaskan kenapa.
  const faq = bot.RULES.find((r) => r.scene === SCENES.AILIVE_FAQ_CO);
  const before = faq.enabled;
  try {
    faq.enabled = true;
    assert.equal(faq.enabled, true, "penugasan harus berlaku");
    assert.ok(bot.activeRules().some((r) => r.scene === SCENES.AILIVE_FAQ_CO));
  } finally {
    faq.enabled = before;
  }
});

test("kata kunci HARDCODED tetap memicu scene", async () => {
  // "ting ting" ada di keyword PAX-1 di RULES, dan tidak ada config apa pun.
  chat("penonton", "ting ting");
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, PAX1);
  assert.deepEqual(obsSwitches, [PAX1]);
});

test("kata kunci hardcoded untuk scene lain juga tetap bekerja", async () => {
  chat("penonton", "chocolatos pillow");
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, PAX3);
});

test("peta produk tetap datang dari AUTOPIN_PRODUCT_* di environment", () => {
  const map = bot.__test.autopinMap();
  assert.equal(map[PAX1], "kunci legacy satu");
  assert.equal(map["PAX-4"], "kunci legacy empat");
  // Scene yang tidak diisi di environment tidak punya entri, sama seperti dulu.
  assert.equal(map["PAX-7"], undefined);
});

test("teks AutoComment tetap DEFAULT_TEMPLATE, bukan balasan dari config", () => {
  const formatted = bot.__test.runtimeFormat(PAX1);
  assert.equal(formatted.ok, true);
  // Identik dengan formatter bawaan yang dipanggil langsung.
  assert.deepEqual(formatted, formatSceneMessage(PAX1));
  assert.ok(DEFAULT_TEMPLATE.includes("{n}"));
  assert.equal(formatted.text, "Etalase 1 sudah aku pin ya kak 🛒");
});

test("getReplyForScene selalu null di mode legacy", () => {
  // Tidak ada balasan per scene sebelum P2, dan tidak boleh tiba-tiba ada.
  for (const scene of [PAX1, PAX3, "PAX-7", "MAIN"]) {
    assert.equal(bot.__test.runtimeReplyFor(scene), null, scene);
  }
});

test("scene tanpa nomor etalase tetap tidak dikomentari", () => {
  // Perilaku formatter bawaan: hanya PAX-1..PAX-10 yang punya pesan.
  const formatted = bot.__test.runtimeFormat(SCENES.AILIVE_FAQ_CO);
  assert.equal(formatted.ok, false);
  assert.equal(formatted.reason, "unsupported-scene");
});

test("jalur auxiliary tetap: AutoPIN lalu AutoComment", async () => {
  chat("penonton", "ting ting");
  await advance(QUEUE_KICK_MS);
  await flush();
  assert.equal(pinRequests.length, 1);
  assert.equal(commentRequests.length, 1);
  assert.equal(pinRequests[0].scene, PAX1);
});

test("normalisasi dan pencocokan frasa tetap diekspor dan bekerja", () => {
  assert.equal(bot.normalizeForMatching("Spill Etalase Satu!!"), "spill etalase 1");
  assert.equal(bot.containsPhrase("spill etalase 1", "etalase 1"), true);
  assert.equal(bot.containsPhrase("spill etalase 10", "etalase 1"), false);
});

test("indeks matcher terbangun dari rule legacy", () => {
  // Ukurannya > 0 membuktikan keyword hardcoded benar-benar masuk indeks fuzzy.
  assert.ok(bot.__test.fuzzyIndexSize() > 100, "size=" + bot.__test.fuzzyIndexSize());
});
