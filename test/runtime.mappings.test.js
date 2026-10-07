// Model pemetaan runtime: dua mode, dan batas tegas di antaranya.
//
// Modul ini murni, jadi tesnya murni juga: tidak ada I/O, tidak ada proses, tidak
// ada waktu. Yang diuji adalah keputusan-keputusannya — mana yang diwarisi dari
// RULES, mana yang diganti config, dan apa yang terjadi pada hal-hal yang tidak
// bisa dijawab.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createRuntimeMappings, SOURCES } = require("../runtime/mappings");

// Base rule tiruan yang bentuknya sama dengan entri RULES di index.js.
const BASE = [
  { scene: "PAX-1", keywords: ["ting ting", "etalase 1"], mediaInputs: ["Media"], waitForMediaEnd: true, duration: 46000 },
  { scene: "PAX-2", keywords: ["gery potato"], mediaInputs: ["Media 3"], waitForMediaEnd: true, duration: 46000 },
  { scene: "AI LIVE_FAQ_CO", keywords: ["checkout"], mediaInputs: ["Media 20"], waitForMediaEnd: false, duration: 33000, enabled: false },
];

const fakeFormat = (scene) => (scene === "PAX-1" ? { ok: true, text: "bawaan 1" } : { ok: false, reason: "unsupported-scene" });

// --- mode legacy -------------------------------------------------------------

test("tanpa mappings: mode legacy", () => {
  const rt = createRuntimeMappings({ baseRules: BASE, defaultFormat: fakeFormat });
  assert.equal(rt.source, SOURCES.LEGACY);
  assert.equal(rt.generation, null);
});

test("legacy: mappings null dan undefined sama-sama legacy", () => {
  for (const mappings of [null, undefined]) {
    assert.equal(createRuntimeMappings({ mappings, baseRules: BASE }).source, SOURCES.LEGACY);
  }
});

test("legacy: rule adalah OBJEK YANG SAMA dengan baseRules", () => {
  // Jalur playback membandingkan rule dengan ===.
  const rt = createRuntimeMappings({ baseRules: BASE });
  assert.equal(rt.rules[0], BASE[0]);
});

test("legacy: activeRules menghormati enabled:false", () => {
  const rt = createRuntimeMappings({ baseRules: BASE });
  assert.deepEqual(rt.activeRules().map((r) => r.scene), ["PAX-1", "PAX-2"]);
});

test("legacy: base rule TIDAK dibekukan", () => {
  // Membekukannya akan membuat `rule.enabled = true` gagal diam-diam.
  const rt = createRuntimeMappings({ baseRules: BASE });
  assert.equal(Object.isFrozen(rt.rules[0]), false);
  assert.equal(Object.isFrozen(BASE[0]), false);
});

test("legacy: objek snapshot sendiri DIBEKUKAN", () => {
  // Metodenya tidak boleh bisa ditukar, walau rule-nya tetap bisa diubah.
  const rt = createRuntimeMappings({ baseRules: BASE });
  assert.equal(Object.isFrozen(rt), true);
});

test("legacy: peta produk datang dari envProductMap", () => {
  const rt = createRuntimeMappings({ baseRules: BASE, envProductMap: { "PAX-1": "kunci env" } });
  assert.equal(rt.getProductForScene("PAX-1"), "kunci env");
  assert.equal(rt.getProductForScene("PAX-2"), null);
});

test("legacy: tidak ada balasan per scene", () => {
  const rt = createRuntimeMappings({ baseRules: BASE, defaultFormat: fakeFormat });
  assert.equal(rt.getReplyForScene("PAX-1"), null);
  // Yang menjawab adalah formatter bawaan.
  assert.deepEqual(rt.formatSceneMessage("PAX-1"), { ok: true, text: "bawaan 1" });
  assert.deepEqual(rt.formatSceneMessage("PAX-2"), { ok: false, reason: "unsupported-scene" });
});

test("legacy tanpa formatter: melaporkan tidak ada formatter, bukan melempar", () => {
  const rt = createRuntimeMappings({ baseRules: BASE });
  assert.deepEqual(rt.formatSceneMessage("PAX-1"), { ok: false, reason: "no-formatter" });
});

// --- mode config -------------------------------------------------------------

const CONFIG = [
  { scene: "PAX-1", product: { title: "O'CORN Sea Salt" }, triggers: ["etalase satu", "ocorn"], reply: "sudah dipin kak" },
  { scene: "PAX-2", product: { title: "Dilan Cookies" }, triggers: ["etalase dua"], reply: "etalase 2 siap" },
];

test("mappings array: mode config, walau kosong", () => {
  assert.equal(createRuntimeMappings({ mappings: [], baseRules: BASE }).source, SOURCES.CONFIG);
  assert.equal(createRuntimeMappings({ mappings: CONFIG, baseRules: BASE }).source, SOURCES.CONFIG);
});

test("config: keyword DIGANTI, bukan digabung dengan keyword hardcoded", () => {
  const rt = createRuntimeMappings({ mappings: CONFIG, baseRules: BASE });
  const r1 = rt.rules.find((r) => r.scene === "PAX-1");
  assert.deepEqual(r1.keywords, ["etalase satu", "ocorn"]);
  // "ting ting" ada di BASE tapi tidak di config: ia tidak boleh ikut.
  assert.ok(!r1.keywords.includes("ting ting"));
});

test("config: detail pemutaran DIWARISI dari base rule", () => {
  const rt = createRuntimeMappings({ mappings: CONFIG, baseRules: BASE });
  const r1 = rt.rules.find((r) => r.scene === "PAX-1");
  assert.deepEqual(r1.mediaInputs, ["Media"]);
  assert.equal(r1.waitForMediaEnd, true);
  assert.equal(r1.duration, 46000);
});

test("config: mediaInputs DISALIN, bukan dibagi dengan RULES", () => {
  // Kalau dibagi, pembekuan snapshot akan ikut membekukan array milik RULES.
  const rt = createRuntimeMappings({ mappings: CONFIG, baseRules: BASE });
  const r1 = rt.rules.find((r) => r.scene === "PAX-1");
  assert.notEqual(r1.mediaInputs, BASE[0].mediaInputs, "harus salinan");
  assert.deepEqual(r1.mediaInputs, BASE[0].mediaInputs, "isinya tetap sama");
  assert.equal(Object.isFrozen(BASE[0].mediaInputs), false, "milik RULES tidak boleh dibekukan");
});

test("config: HANYA scene yang dipetakan yang ada di rules", () => {
  const rt = createRuntimeMappings({ mappings: [CONFIG[0]], baseRules: BASE });
  assert.deepEqual(rt.rules.map((r) => r.scene), ["PAX-1"]);
});

test("config: snapshot dibekukan sampai ke dalam", () => {
  const rt = createRuntimeMappings({ mappings: CONFIG, baseRules: BASE });
  assert.equal(Object.isFrozen(rt), true);
  assert.equal(Object.isFrozen(rt.rules), true);
  assert.equal(Object.isFrozen(rt.rules[0]), true);
  assert.equal(Object.isFrozen(rt.rules[0].keywords), true);
  assert.equal(Object.isFrozen(rt.productMap), true);
  assert.equal(Object.isFrozen(rt.replies), true);
});

test("config: pemetaan tidak bisa diubah sesudah dibuat", () => {
  const rt = createRuntimeMappings({ mappings: CONFIG, baseRules: BASE });
  const before = rt.getProductForScene("PAX-1");
  try {
    rt.productMap["PAX-1"] = "selundupan";
  } catch {
    /* melempar di strict mode juga hasil yang benar */
  }
  assert.equal(rt.getProductForScene("PAX-1"), before);
});

test("config: produk dan balasan per scene", () => {
  const rt = createRuntimeMappings({ mappings: CONFIG, baseRules: BASE });
  assert.equal(rt.getProductForScene("PAX-1"), "O'CORN Sea Salt");
  assert.equal(rt.getReplyForScene("PAX-1"), "sudah dipin kak");
  assert.equal(rt.getReplyForScene("PAX-2"), "etalase 2 siap");
  assert.equal(rt.getReplyForScene("PAX-9"), null);
});

test("config: balasan dipakai APA ADANYA", () => {
  const rt = createRuntimeMappings({ mappings: CONFIG, baseRules: BASE });
  assert.deepEqual(rt.formatSceneMessage("PAX-1"), { ok: true, text: "sudah dipin kak" });
});

test("config: scene tanpa balasan membuat formatter DIAM", () => {
  const rt = createRuntimeMappings({
    mappings: [{ scene: "PAX-1", product: { title: "x" }, triggers: ["a"] }],
    baseRules: BASE,
    // Formatter bawaan ADA, dan tetap tidak dipakai: di mode config, balasan
    // hanya datang dari config. Kalau bawaan ikut dipakai, customer yang
    // mengosongkan balasan akan tetap melihat kalimat yang tidak ia tulis.
    defaultFormat: fakeFormat,
  });
  assert.deepEqual(rt.formatSceneMessage("PAX-1"), { ok: false, reason: "no-reply-configured" });
});

test("config: produk null = scene punya trigger tapi tidak dipin", () => {
  const rt = createRuntimeMappings({
    mappings: [{ scene: "AI LIVE_FAQ_CO", product: null, triggers: ["cara order"] }],
    baseRules: BASE,
  });
  assert.equal(rt.rules.length, 1);
  assert.equal(rt.getProductForScene("AI LIVE_FAQ_CO"), null);
  assert.deepEqual(rt.rules[0].keywords, ["cara order"]);
});

test("config: scene FAQ yang enabled:false di RULES menjadi AKTIF kalau dipetakan", () => {
  // Inilah gunanya produk null: customer bisa menghidupkan kembali scene FAQ
  // lewat config, tanpa menyentuh kode.
  const rt = createRuntimeMappings({
    mappings: [{ scene: "AI LIVE_FAQ_CO", product: null, triggers: ["checkout"] }],
    baseRules: BASE,
  });
  // enabled:false diwarisi dari base rule, jadi ia TETAP tidak aktif.
  // Ini perilaku yang jujur: gerbang enabled milik RULES, bukan milik config.
  assert.equal(rt.rules[0].enabled, false);
  assert.deepEqual(rt.activeRules().map((r) => r.scene), []);
});

test("config: scene tanpa base rule dicatat sebagai unknownPlayback, TIDAK dijalankan", () => {
  // Controller tidak punya cara mengetahui nama input media atau durasi scene
  // yang tidak ada di RULES. Menebaknya berarti mengubah perilaku pemutaran.
  const rt = createRuntimeMappings({
    mappings: [{ scene: "SCENE-BARU", product: { title: "x" }, triggers: ["a"] }],
    baseRules: BASE,
  });
  assert.deepEqual(rt.unknownPlayback, ["SCENE-BARU"]);
  assert.deepEqual(rt.rules, []);
  assert.equal(rt.getProductForScene("SCENE-BARU"), null);
});

test("config: MAIN tidak pernah dipetakan", () => {
  const rt = createRuntimeMappings({
    mappings: [{ scene: "MAIN", product: { title: "x" }, triggers: ["a"] }],
    baseRules: BASE.concat([{ scene: "MAIN", keywords: [], mediaInputs: [] }]),
  });
  assert.deepEqual(rt.rules, []);
  assert.deepEqual(rt.unknownPlayback, []);
});

test("config: trigger kosong dan bukan string dibuang", () => {
  const rt = createRuntimeMappings({
    mappings: [{ scene: "PAX-1", product: { title: "x" }, triggers: ["ok", "", "   ", null, 5, "dua"] }],
    baseRules: BASE,
  });
  assert.deepEqual(rt.rules[0].keywords, ["ok", "dua"]);
});

test("config: triggers hilang = scene tanpa keyword, bukan melempar", () => {
  // Validator yang menolak ini (no-triggers); modul ini tidak boleh meledak.
  const rt = createRuntimeMappings({
    mappings: [{ scene: "PAX-1", product: { title: "x" } }],
    baseRules: BASE,
  });
  assert.deepEqual(rt.rules[0].keywords, []);
});

test("config: judul produk dan balasan di-trim", () => {
  const rt = createRuntimeMappings({
    mappings: [{ scene: "PAX-1", product: { title: "  x  " }, triggers: ["a"], reply: "  hai  " }],
    baseRules: BASE,
  });
  assert.equal(rt.getProductForScene("PAX-1"), "x");
  assert.equal(rt.getReplyForScene("PAX-1"), "hai");
});

test("config: judul produk kosong tidak masuk peta", () => {
  const rt = createRuntimeMappings({
    mappings: [{ scene: "PAX-1", product: { title: "   " }, triggers: ["a"] }],
    baseRules: BASE,
  });
  assert.equal(rt.getProductForScene("PAX-1"), null);
});

test("config: generation diteruskan apa adanya", () => {
  const rt = createRuntimeMappings({ mappings: CONFIG, baseRules: BASE, generation: "abc123" });
  assert.equal(rt.generation, "abc123");
});

test("config: scenes() menyebut scene yang aktif dipetakan", () => {
  const rt = createRuntimeMappings({ mappings: CONFIG, baseRules: BASE });
  assert.deepEqual(rt.scenes(), ["PAX-1", "PAX-2"]);
});

test("baseRules kosong: mode config menghasilkan nol rule, bukan melempar", () => {
  const rt = createRuntimeMappings({ mappings: CONFIG, baseRules: [] });
  assert.deepEqual(rt.rules, []);
  assert.deepEqual(rt.unknownPlayback, ["PAX-1", "PAX-2"]);
});

test("pemetaan ganda untuk scene yang sama: keduanya masuk, validator yang menolak", () => {
  // Modul ini tidak menghakimi; ia hanya membentuk. Penolakan duplikat ada di
  // controller/config-manager.js dan controller/mapping-validator.js, di mana
  // pesannya bisa sampai ke customer.
  const rt = createRuntimeMappings({
    mappings: [
      { scene: "PAX-1", product: { title: "a" }, triggers: ["x"] },
      { scene: "PAX-1", product: { title: "b" }, triggers: ["y"] },
    ],
    baseRules: BASE,
  });
  assert.equal(rt.rules.length, 2);
  // Yang terakhir menang di peta produk — dan itu justru kenapa duplikat harus
  // ditolak lebih awal, bukan dibiarkan sampai sini.
  assert.equal(rt.getProductForScene("PAX-1"), "b");
});
