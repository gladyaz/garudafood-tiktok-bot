// Aksi per-aturan: modul keputusannya, snapshot runtime yang memakainya, dan
// artefak yang membawanya ke proses anak.
//
// Semuanya murni: tidak ada I/O, tidak ada proses, tidak ada waktu. Yang diuji
// adalah satu pertanyaan yang diulang dari tiga sisi — aksi mana yang berlaku,
// dan apa yang TIDAK terjadi karena sebuah aksi mati.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const RA = require("../runtime/rule-actions");
const { createRuntimeMappings, SOURCES } = require("../runtime/mappings");
const { buildRuntimeConfig, validateRuntimeConfig } = require("../runtime/runtime-config");

const ALL_ON = { switchScene: true, autoPin: true, autoReply: true };

// Base rule tiruan, bentuknya sama dengan entri RULES di index.js.
const BASE = [
  { scene: "PAX-1", keywords: ["etalase 1"], mediaInputs: ["Media"], waitForMediaEnd: true, duration: 46000 },
  { scene: "PAX-2", keywords: ["etalase 2"], mediaInputs: ["Media 3"], waitForMediaEnd: true, duration: 46000 },
  { scene: "FAQ-HARGA", keywords: ["harga"], mediaInputs: ["Media 20"], waitForMediaEnd: false, duration: 12000 },
];

// --- modul keputusan ---------------------------------------------------------

test("LEGACY: aturan tanpa field actions = ketiganya menyala", () => {
  // Inti kompatibilitas v0.2.0. Kalau ini berubah, setiap config customer yang
  // sudah ada berubah artinya sekaligus.
  assert.deepEqual(RA.resolveActions({ scene: "PAX-1" }), ALL_ON);
  assert.deepEqual(RA.resolveActions({}), ALL_ON);
  assert.deepEqual(RA.resolveActions(null), ALL_ON);
  assert.deepEqual(RA.resolveActions(undefined), ALL_ON);
});

test("LEGACY: kunci yang HILANG di dalam actions juga menyala", () => {
  // { autoPin: false } pada aturan FAQ tetap mengganti scene dan tetap
  // membalas. Tidak ada yang perlu mengingat menuliskan dua kunci lainnya.
  assert.deepEqual(RA.resolveActions({ actions: { autoPin: false } }), {
    switchScene: true,
    autoPin: false,
    autoReply: true,
  });
});

test("aksi yang tertulis MENANG, dan hanya boolean yang dibaca", () => {
  assert.deepEqual(RA.resolveActions({ actions: { switchScene: false, autoPin: true, autoReply: false } }), {
    switchScene: false,
    autoPin: true,
    autoReply: false,
  });
  // Nilai yang bukan boolean jatuh ke perilaku lama (menyala), BUKAN ditebak
  // sebagai mati. Yang menolak bentuk rusak adalah validator config.
  for (const bad of ["false", 0, null, [], {}]) {
    assert.deepEqual(RA.resolveActions({ actions: { autoPin: bad } }), ALL_ON, "autoPin=" + JSON.stringify(bad));
  }
});

test("ALL OFF terdeteksi, dan hanya kalau benar-benar ketiganya mati", () => {
  assert.equal(RA.anyEnabled({ switchScene: false, autoPin: false, autoReply: false }), false);
  assert.equal(RA.anyEnabled({ switchScene: false, autoPin: false, autoReply: true }), true);
  assert.equal(RA.anyEnabled({ switchScene: true, autoPin: false, autoReply: false }), true);
  assert.equal(RA.anyEnabled(null), false);
});

test("declaresActions membedakan MEMILIH dari MEWARISI", () => {
  // Bedanya hanya untuk validasi, bukan untuk apa yang dijalankan. Lihat
  // runtime/rule-actions.js: menuntut produk dari setiap aturan lama yang
  // autoPin-nya menyala akan memblokir START untuk setiap scene FAQ yang sudah
  // ada hari ini.
  assert.equal(RA.declaresActions({ scene: "PAX-1" }), false);
  assert.equal(RA.declaresActions({ scene: "PAX-1", actions: {} }), true);
  assert.equal(RA.declaresActions({ scene: "PAX-1", actions: { autoPin: false } }), true);
});

test("bentuk actions yang salah dilaporkan per kunci", () => {
  assert.deepEqual(RA.validateActionsShape(undefined), []);
  assert.deepEqual(RA.validateActionsShape({}), []);
  assert.deepEqual(RA.validateActionsShape("ya"), [{ key: "", code: "must-be-object" }]);
  assert.deepEqual(RA.validateActionsShape({ autoPin: "ya" }), [{ key: "autoPin", code: "must-be-boolean" }]);
});

test("normalizeActions SELALU menulis ketiganya", () => {
  assert.deepEqual(RA.normalizeActions(null), ALL_ON);
  assert.deepEqual(RA.normalizeActions({ autoPin: false }), { switchScene: true, autoPin: false, autoReply: true });
});

// --- kunci aturan ------------------------------------------------------------

test("KUNCI: aturan yang punya scene memakai NAMA SCENE-nya, persis seperti sebelumnya", () => {
  // Ini yang membuat setiap config yang sudah ada menghasilkan peta produk dan
  // peta balasan yang IDENTIK, bukan yang mirip.
  assert.deepEqual(RA.ruleKeys([{ scene: "PAX-1" }, { scene: "FAQ-HARGA" }]), ["PAX-1", "FAQ-HARGA"]);
});

test("KUNCI: aturan tanpa scene mendapat kunci buatan, dan tidak pernah bertabrakan", () => {
  // Tabrakan berarti satu aturan memakai produk atau balasan aturan lain.
  const keys = RA.ruleKeys([{ scene: "PAX-1" }, {}, { scene: "#rule-2" }, {}]);
  assert.equal(new Set(keys).size, keys.length, "kunci harus unik: " + keys.join(","));
  assert.equal(keys[0], "PAX-1");
  assert.equal(keys[2], "#rule-2");
  assert.ok(RA.isSyntheticKey(keys[1]));
  assert.ok(RA.isSyntheticKey(keys[3]));
  assert.ok(!RA.isSyntheticKey("PAX-1"));
});

test("KUNCI: deterministik — daftar yang sama menghasilkan kunci yang sama", () => {
  // Dua proses anak membaca artefak yang sama dan harus sampai pada kunci yang
  // sama; kunci yang bergantung pada urutan pemanggilan akan membuat service
  // dan bot mencari produk di tempat yang berbeda.
  const list = [{ scene: "PAX-1" }, {}, {}];
  assert.deepEqual(RA.ruleKeys(list), RA.ruleKeys(list));
});

// --- snapshot runtime: kompatibilitas ---------------------------------------

test("LEGACY: config tanpa actions menghasilkan peta yang IDENTIK dengan sebelum v0.2.0", () => {
  // Pagar paling penting di berkas ini. Peta produk dan peta balasan adalah
  // yang menentukan apa yang di-pin dan apa yang dikatakan ke penonton.
  const rt = createRuntimeMappings({
    mappings: [
      { scene: "PAX-1", product: { title: "Kacang Atom" }, triggers: ["etalase 1"], reply: "sudah aku pin" },
      { scene: "PAX-2", product: { title: "Gery Potato" }, triggers: ["etalase 2"], reply: "siap kak" },
      // Scene FAQ seperti yang DITULIS customer hari ini: product null, tanpa
      // field actions sama sekali.
      { scene: "FAQ-HARGA", product: null, triggers: ["harga"], reply: "cek etalase ya kak" },
    ],
    baseRules: BASE,
  });
  assert.equal(rt.source, SOURCES.CONFIG);
  assert.deepEqual(rt.productMap, { "PAX-1": "Kacang Atom", "PAX-2": "Gery Potato" });
  assert.deepEqual(rt.replies, {
    "PAX-1": "sudah aku pin",
    "PAX-2": "siap kak",
    "FAQ-HARGA": "cek etalase ya kak",
  });
  assert.deepEqual(rt.scenes(), ["PAX-1", "PAX-2", "FAQ-HARGA"]);
  // Dan ketiga aksinya menyala, jadi jalur runtime berperilaku sama.
  for (const r of rt.rules) assert.deepEqual(r.actions, ALL_ON);
});

test("LEGACY: detail pemutaran tetap diwarisi dari RULES, tidak dikarang", () => {
  const rt = createRuntimeMappings({
    mappings: [{ scene: "PAX-1", product: { title: "x" }, triggers: ["a"] }],
    baseRules: BASE,
  });
  const rule = rt.rules[0];
  assert.deepEqual(rule.mediaInputs, ["Media"]);
  assert.equal(rule.waitForMediaEnd, true);
  assert.equal(rule.duration, 46000);
  assert.equal(rule.key, "PAX-1");
});

// --- snapshot runtime: aksi yang mati ---------------------------------------

test("FAQ: pin mati berarti scene itu TIDAK ADA di peta produk", () => {
  // Lapis kedua. Gerbang utamanya ada di index.js, tapi peta yang tidak memuat
  // judulnya membuat pin lewat jalur ini mustahil, bukan hanya tidak dipanggil.
  const rt = createRuntimeMappings({
    mappings: [
      {
        scene: "FAQ-HARGA",
        product: { title: "Kacang Atom" },
        triggers: ["berapa harganya"],
        reply: "cek etalase ya kak",
        actions: { switchScene: true, autoPin: false, autoReply: true },
      },
    ],
    baseRules: BASE,
  });
  assert.deepEqual(rt.productMap, {}, "judul tersimpan tidak boleh bisa di-pin");
  assert.equal(rt.getProductForScene("FAQ-HARGA"), null);
  assert.deepEqual(rt.replies, { "FAQ-HARGA": "cek etalase ya kak" });
  assert.deepEqual(rt.formatSceneMessage("FAQ-HARGA"), { ok: true, text: "cek etalase ya kak" });
});

test("SCENE ONLY: tidak ada produk dan tidak ada balasan di peta mana pun", () => {
  const rt = createRuntimeMappings({
    mappings: [
      {
        scene: "FAQ-HARGA",
        product: { title: "Kacang Atom" },
        triggers: ["harga"],
        reply: "tidak akan dikirim",
        actions: { switchScene: true, autoPin: false, autoReply: false },
      },
    ],
    baseRules: BASE,
  });
  assert.deepEqual(rt.productMap, {});
  assert.deepEqual(rt.replies, {});
  assert.deepEqual(rt.formatSceneMessage("FAQ-HARGA"), { ok: false, reason: "no-reply-configured" });
  assert.equal(rt.rules.length, 1, "scene-nya tetap bisa diputar");
});

test("REPLY ONLY: aturan tanpa scene tetap masuk indeks matcher, tanpa detail pemutaran", () => {
  const rt = createRuntimeMappings({
    mappings: [
      {
        scene: "",
        product: null,
        triggers: ["ini ai ya"],
        reply: "iya kak, aku asisten LIVE",
        actions: { switchScene: false, autoPin: false, autoReply: true },
      },
    ],
    baseRules: BASE,
  });
  assert.equal(rt.rules.length, 1, "pemicunya harus tetap bisa dicocokkan");
  const rule = rt.rules[0];
  assert.equal(rule.scene, "", "scene KOSONG, bukan undefined yang menyebar jadi \"undefined\"");
  assert.deepEqual(rule.keywords, ["ini ai ya"]);
  assert.equal(rule.mediaInputs, undefined, "tidak ada detail pemutaran yang dikarang");
  assert.ok(RA.isSyntheticKey(rule.key));
  assert.deepEqual(rt.replies, { [rule.key]: "iya kak, aku asisten LIVE" });
  assert.deepEqual(rt.scenes(), [], "tidak ada scene kosong yang bocor ke daftar scene");
});

test("REPLY ONLY: scene tanpa base rule TIDAK dilaporkan sebagai unknownPlayback", () => {
  // unknownPlayback berarti "scene ini ingin diputar tapi kami tidak tahu
  // caranya". Aturan ini tidak ingin diputar, jadi tidak ada yang hilang.
  const rt = createRuntimeMappings({
    mappings: [
      { scene: "", product: null, triggers: ["a"], reply: "b", actions: { switchScene: false, autoPin: false, autoReply: true } },
      { scene: "SCENE-TAK-DIKENAL", product: null, triggers: ["c"], reply: "d" },
    ],
    baseRules: BASE,
  });
  assert.deepEqual(rt.unknownPlayback, ["SCENE-TAK-DIKENAL"]);
});

test("PIN ONLY: produk masuk peta, balasan tidak", () => {
  const rt = createRuntimeMappings({
    mappings: [
      {
        scene: "",
        product: { title: "Kacang Atom" },
        triggers: ["pin dong"],
        reply: "tidak akan dikirim",
        actions: { switchScene: false, autoPin: true, autoReply: false },
      },
    ],
    baseRules: BASE,
  });
  const key = rt.rules[0].key;
  assert.deepEqual(rt.productMap, { [key]: "Kacang Atom" });
  assert.deepEqual(rt.replies, {});
});

test("aturan tanpa scene DAN tanpa pemicu tidak punya alasan untuk ada", () => {
  const rt = createRuntimeMappings({
    mappings: [{ scene: "", product: null, triggers: [], reply: "b", actions: { switchScene: false, autoPin: false, autoReply: true } }],
    baseRules: BASE,
  });
  assert.deepEqual(rt.rules, []);
});

test("snapshot mode config tetap dibekukan sampai ke dalam, termasuk actions", () => {
  const rt = createRuntimeMappings({
    mappings: [{ scene: "PAX-1", product: { title: "x" }, triggers: ["a"], actions: { switchScene: true, autoPin: true, autoReply: false } }],
    baseRules: BASE,
  });
  assert.ok(Object.isFrozen(rt.rules[0].actions));
  assert.throws(() => {
    "use strict";
    rt.rules[0].actions.autoPin = false;
  });
});

// --- artefak config runtime --------------------------------------------------

test("artefak: aksi DISELESAIKAN sebelum ditulis, jadi anak tidak pernah menerka", () => {
  const a = buildRuntimeConfig({
    mappings: [
      { scene: "PAX-1", product: { title: "x" }, triggers: ["a"], reply: "b" },
      { scene: "FAQ", product: null, triggers: ["c"], reply: "d", actions: { autoPin: false } },
    ],
  });
  assert.deepEqual(a.mappings[0].actions, ALL_ON);
  assert.deepEqual(a.mappings[1].actions, { switchScene: true, autoPin: false, autoReply: true });
  assert.equal(validateRuntimeConfig(a).ok, true);
});

test("artefak: aturan tanpa scene sah, dan scene-nya kosong — bukan \"undefined\"", () => {
  const a = buildRuntimeConfig({
    mappings: [{ product: null, triggers: ["a"], reply: "b", actions: { switchScene: false, autoPin: false, autoReply: true } }],
  });
  assert.equal(a.mappings[0].scene, "");
  assert.equal(validateRuntimeConfig(a).ok, true);
});

test("artefak: aturan yang MENGGANTI scene tetap wajib punya scene", () => {
  const a = buildRuntimeConfig({ mappings: [{ product: null, triggers: ["a"], actions: { switchScene: true, autoPin: false, autoReply: false } }] });
  assert.equal(validateRuntimeConfig(a).reason, "scene-missing");
});

test("artefak: aksi yang hilang atau bukan boolean adalah artefak RUSAK", () => {
  // Di artefak, aksi yang hilang BUKAN "aturan lama": buildRuntimeConfig sudah
  // menyelesaikannya. Yang tersisa hanya berkas yang disunting atau rusak.
  const cases = [
    [(a) => { delete a.mappings[0].actions; }, "actions-invalid"],
    [(a) => { a.mappings[0].actions = null; }, "actions-invalid"],
    [(a) => { a.mappings[0].actions = { switchScene: true, autoPin: true }; }, "actions-invalid"],
    [(a) => { a.mappings[0].actions = { switchScene: true, autoPin: "ya", autoReply: true }; }, "actions-invalid"],
  ];
  for (const [mutate, reason] of cases) {
    const a = buildRuntimeConfig({ mappings: [{ scene: "PAX-1", product: { title: "x" }, triggers: ["a"] }] });
    mutate(a);
    assert.equal(validateRuntimeConfig(a).reason, reason);
  }
});

test("artefak: mengubah aksi mengubah id generasi", () => {
  // id generasi adalah satu-satunya bukti bahwa bot dan service membaca
  // pemetaan yang sama. Aksi mengubah apa yang DIKERJAKAN artefak, jadi ia
  // harus ikut dalam hash.
  const base = { scene: "PAX-1", product: { title: "x" }, triggers: ["a"], reply: "b" };
  const withPin = buildRuntimeConfig({ mappings: [base] });
  const noPin = buildRuntimeConfig({ mappings: [Object.assign({}, base, { actions: { autoPin: false } })] });
  assert.notEqual(withPin.id, noPin.id);
});

test("artefak: aturan lama dan aturan yang menyatakan ketiganya menyala adalah SATU generasi", () => {
  // Dua artefak yang mengerjakan hal yang sama bukan dua generasi berbeda.
  const legacy = buildRuntimeConfig({ mappings: [{ scene: "PAX-1", product: { title: "x" }, triggers: ["a"], reply: "b" }] });
  const explicit = buildRuntimeConfig({
    mappings: [{ scene: "PAX-1", product: { title: "x" }, triggers: ["a"], reply: "b", actions: ALL_ON }],
  });
  assert.equal(legacy.id, explicit.id);
});
