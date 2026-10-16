// Interaksi saat sepi: KEPUTUSANNYA, konfigurasinya, validasinya, dan apa yang
// tampil di layar.
//
// Semuanya murni: tidak ada timer, tidak ada proses, tidak ada TikTok. Daur
// hidup yang sungguhan (timer, antrean, preempsi) diuji di
// test/idle.runtime.test.js lewat index.js yang nyata.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const IDLE = require("../runtime/idle");
const RA = require("../runtime/rule-actions");
const { createRuntimeMappings } = require("../runtime/mappings");
const { buildRuntimeConfig, validateRuntimeConfig } = require("../runtime/runtime-config");
const { validateConfig, defaultConfig } = require("../controller/config-manager");
const { validateMappings } = require("../controller/mapping-validator");
const { createPreflight } = require("../controller/preflight");
const { CATALOG, FIELD_PROBLEMS } = require("../controller/errors");
const I18N = require("../controller/public/i18n.js");
const U = require("../controller/public/ui-logic.js");

const T = (key, vars) => I18N.t("id", key, vars);

const SCENES = ["MAIN", "PAX-1", "ENGAGE-A", "ENGAGE-B"];
const PLAYABLE = ["PAX-1", "ENGAGE-A", "ENGAGE-B"];
const CATALOGUE = [{ title: "Garuda Kacang Atom 80gr", number: 1, pinAvailable: true }];
const BASE = [
  { scene: "PAX-1", keywords: ["etalase 1"], mediaInputs: ["M1"], waitForMediaEnd: true, duration: 46000 },
  { scene: "ENGAGE-A", keywords: [], mediaInputs: ["M8"], waitForMediaEnd: true, duration: 12000 },
  { scene: "ENGAGE-B", keywords: [], mediaInputs: ["M9"], waitForMediaEnd: true, duration: 10000 },
];
const MAPPINGS = [{ scene: "PAX-1", product: { title: "Garuda Kacang Atom" }, triggers: ["etalase 1"], reply: "sudah aku pin" }];

function cfg(idle) {
  const c = defaultConfig();
  c.tiktok.username = "akun";
  c.mappings = MAPPINGS;
  if (idle === undefined) delete c.idle;
  else c.idle = idle;
  return c;
}
const codes = (v) => v.errors.map((e) => e.code);
const paths = (v) => v.errors.map((e) => e.path);
const idleOn = (items, afterSeconds = 30) => ({ enabled: true, afterSeconds, items });

// --- shouldEngage: seluruh matriks gerbang ----------------------------------

const BASE_GATE = {
  enabled: true, armed: true, busy: false, queueLength: 0,
  now: 100_000, lastActivityAt: 0, afterMs: 30_000, ruleCount: 2,
};

test("GERBANG: boleh kalau semuanya terpenuhi", () => {
  assert.deepEqual(IDLE.shouldEngage(BASE_GATE), { ok: true, reason: "idle" });
});

test("GERBANG: fitur mati -> tidak pernah", () => {
  assert.equal(IDLE.shouldEngage({ ...BASE_GATE, enabled: false }).reason, "disabled");
});

test("GERBANG: belum armed -> tidak pernah (pemanasan START terlewati di sini)", () => {
  assert.equal(IDLE.shouldEngage({ ...BASE_GATE, armed: false }).reason, "not-armed");
});

test("GERBANG: nol item -> tidak pernah", () => {
  assert.equal(IDLE.shouldEngage({ ...BASE_GATE, ruleCount: 0 }).reason, "no-items");
});

test("GERBANG: ada scene yang tayang (busy) -> tidak menimpa", () => {
  assert.equal(IDLE.shouldEngage({ ...BASE_GATE, busy: true }).reason, "busy");
});

test("GERBANG: antrean penonton tidak kosong -> penonton dulu", () => {
  assert.equal(IDLE.shouldEngage({ ...BASE_GATE, queueLength: 1 }).reason, "queue-not-empty");
});

test("GERBANG: belum cukup sepi -> too-soon, dengan sisa waktunya", () => {
  const v = IDLE.shouldEngage({ ...BASE_GATE, now: 10_000, lastActivityAt: 0, afterMs: 30_000 });
  assert.equal(v.reason, "too-soon");
  assert.equal(v.remainingMs, 20_000);
});

test("GERBANG: tepat di ambang sudah boleh", () => {
  assert.equal(IDLE.shouldEngage({ ...BASE_GATE, now: 30_000, lastActivityAt: 0, afterMs: 30_000 }).ok, true);
});

// --- rotasi ------------------------------------------------------------------

const RULES3 = [{ scene: "A" }, { scene: "B" }, { scene: "C" }];

test("ROTASI: deterministik dan berurutan, tanpa acak", () => {
  let cursor = 0;
  const seen = [];
  for (let i = 0; i < 7; i += 1) {
    const pick = IDLE.pickIdle({ rules: RULES3, cursor });
    seen.push(pick.rule.scene);
    cursor = pick.nextCursor;
  }
  assert.deepEqual(seen, ["A", "B", "C", "A", "B", "C", "A"]);
});

test("ROTASI: daftar yang sama + kursor yang sama = pilihan yang sama", () => {
  assert.deepEqual(IDLE.pickIdle({ rules: RULES3, cursor: 1 }), IDLE.pickIdle({ rules: RULES3, cursor: 1 }));
});

test("ROTASI: item yang masih cooldown DILEWATI", () => {
  const pick = IDLE.pickIdle({ rules: RULES3, cursor: 0, isCoolingDown: (s) => s === "A" });
  assert.equal(pick.rule.scene, "B");
});

test("ROTASI: semua cooldown -> null, bukan menunggu", () => {
  assert.equal(IDLE.pickIdle({ rules: RULES3, cursor: 0, isCoolingDown: () => true }), null);
});

test("ROTASI: daftar kosong -> null", () => {
  assert.equal(IDLE.pickIdle({ rules: [], cursor: 0 }), null);
});

test("ROTASI: kursor di luar jangkauan tidak meledak", () => {
  assert.equal(IDLE.pickIdle({ rules: RULES3, cursor: 99 }).rule.scene, "A");
});

// --- aksi: autoPin SELALU mati ----------------------------------------------

test("AKSI: item interaksi TIDAK PERNAH mem-pin, apa pun isinya", () => {
  for (const item of [{ scene: "A" }, { scene: "A", reply: "hai" }, { scene: "A", reply: null }, null, undefined]) {
    assert.equal(IDLE.idleActionsFor(item).autoPin, false, JSON.stringify(item));
    assert.equal(RA.idleActionsFor(item).autoPin, false, "versi UMD juga");
  }
});

test("AKSI: balasan menentukan autoReply, scene selalu diganti", () => {
  assert.deepEqual(IDLE.idleActionsFor({ scene: "A", reply: "hai" }), { switchScene: true, autoPin: false, autoReply: true });
  assert.deepEqual(IDLE.idleActionsFor({ scene: "A" }), { switchScene: true, autoPin: false, autoReply: false });
  assert.deepEqual(IDLE.idleActionsFor({ scene: "A", reply: "   " }), { switchScene: true, autoPin: false, autoReply: false });
});

test("AKSI: dua implementasi (node + UMD) tidak boleh menyimpang", () => {
  for (const item of [{ scene: "A", reply: "x" }, { scene: "A" }]) {
    assert.deepEqual(IDLE.idleActionsFor(item), RA.idleActionsFor(item));
  }
});

// --- config: aditif, versi tetap 1 ------------------------------------------

test("CONFIG: config LAMA tanpa blok idle tetap valid", () => {
  const v = validateConfig(cfg(undefined));
  assert.deepEqual(v.errors, []);
});

test("CONFIG: versi TIDAK dinaikkan", () => {
  assert.equal(defaultConfig().version, 1);
});

test("CONFIG: bawaan instalasi baru = MATI", () => {
  const d = defaultConfig();
  assert.deepEqual(d.idle, { enabled: false, afterSeconds: 30, items: [] });
});

test("CONFIG: idle valid diterima", () => {
  assert.deepEqual(validateConfig(cfg(idleOn([{ scene: "ENGAGE-A", reply: "hai kak" }, { scene: "ENGAGE-B" }]))).errors, []);
});

test("CONFIG: menyala tanpa satu pun scene ditolak", () => {
  const v = validateConfig(cfg(idleOn([])));
  assert.ok(codes(v).includes("must-not-be-empty"));
  assert.ok(paths(v).includes("idle.items"));
});

test("CONFIG: mati tanpa scene SAH", () => {
  assert.deepEqual(validateConfig(cfg({ enabled: false, afterSeconds: 30, items: [] })).errors, []);
});

test("CONFIG: afterSeconds di luar batas ditolak", () => {
  for (const n of [1, 4, 3601, 99999]) {
    const v = validateConfig(cfg(idleOn([{ scene: "ENGAGE-A" }], n)));
    assert.ok(codes(v).includes("idle-after-out-of-range"), "n=" + n);
  }
  for (const n of [5, 30, 3600]) {
    assert.deepEqual(validateConfig(cfg(idleOn([{ scene: "ENGAGE-A" }], n))).errors, [], "n=" + n);
  }
});

test("CONFIG: scene idle ganda ditolak", () => {
  const v = validateConfig(cfg(idleOn([{ scene: "ENGAGE-A" }, { scene: "ENGAGE-A" }])));
  assert.ok(codes(v).includes("duplicate-scene"));
});

test("CONFIG: scene idle yang juga milik aturan penonton ditolak", () => {
  const v = validateConfig(cfg(idleOn([{ scene: "PAX-1" }])));
  assert.ok(codes(v).includes("idle-scene-conflicts-with-rule"));
  assert.ok(paths(v).includes("idle.items[0].scene"));
});

test("CONFIG: MAIN tidak boleh jadi scene interaksi", () => {
  assert.ok(codes(validateConfig(cfg(idleOn([{ scene: "MAIN" }])))).includes("scene-never-mappable"));
});

test("CONFIG: balasan memakai aturan balasan yang SUDAH ADA", () => {
  const long = "x".repeat(101);
  assert.ok(codes(validateConfig(cfg(idleOn([{ scene: "ENGAGE-A", reply: long }])))).includes("reply-too-long"));
  assert.ok(codes(validateConfig(cfg(idleOn([{ scene: "ENGAGE-A", reply: "<b>" }])))).includes("html-not-allowed"));
  assert.ok(codes(validateConfig(cfg(idleOn([{ scene: "ENGAGE-A", reply: "" }])))).includes("must-not-be-empty"));
  // null = sengaja tanpa balasan, dan itu sah.
  assert.deepEqual(validateConfig(cfg(idleOn([{ scene: "ENGAGE-A", reply: null }]))).errors, []);
});

// --- artefak runtime ---------------------------------------------------------

test("ARTEFAK: idle ikut, dan ikut mengubah id generasi", () => {
  const off = buildRuntimeConfig({ mappings: MAPPINGS });
  const on = buildRuntimeConfig({ mappings: MAPPINGS, idle: idleOn([{ scene: "ENGAGE-A" }]) });
  assert.deepEqual(off.idle, { enabled: false, afterSeconds: 30, items: [] });
  assert.equal(on.idle.enabled, true);
  assert.notEqual(off.id, on.id, "menyalakan interaksi harus mengubah generasi");
  assert.equal(validateRuntimeConfig(on).ok, true);
});

test("ARTEFAK: bentuk idle yang rusak ditolak", () => {
  const cases = [
    (a) => { delete a.idle; },
    (a) => { a.idle = null; },
    (a) => { a.idle.enabled = "ya"; },
    (a) => { a.idle.afterSeconds = 0; },
    (a) => { a.idle.items = "bukan array"; },
    (a) => { a.idle.items = [{ scene: "" }]; },
    (a) => { a.idle.items = [{ scene: "A", reply: 5 }]; },
  ];
  for (const mutate of cases) {
    const a = buildRuntimeConfig({ mappings: MAPPINGS, idle: idleOn([{ scene: "ENGAGE-A" }]) });
    mutate(a);
    assert.equal(validateRuntimeConfig(a).reason, "idle-invalid");
  }
});

// --- snapshot runtime --------------------------------------------------------

test("SNAPSHOT: scene interaksi memakai detail pemutaran dari RULES, tidak dikarang", () => {
  const rt = createRuntimeMappings({
    mappings: MAPPINGS,
    idle: idleOn([{ scene: "ENGAGE-A", reply: "hai" }]),
    baseRules: BASE,
  });
  const r = rt.idle.rules[0];
  assert.equal(r.scene, "ENGAGE-A");
  assert.deepEqual(r.mediaInputs, ["M8"]);
  assert.equal(r.duration, 12000);
  assert.equal(r.waitForMediaEnd, true);
  assert.deepEqual(r.actions, { switchScene: true, autoPin: false, autoReply: true });
  assert.equal(r.idle, true);
  assert.deepEqual(r.keywords, [], "tidak pernah bisa dipicu penonton");
});

test("SNAPSHOT: scene interaksi TIDAK PERNAH masuk peta produk", () => {
  const rt = createRuntimeMappings({
    mappings: MAPPINGS,
    idle: idleOn([{ scene: "ENGAGE-A", reply: "hai" }]),
    baseRules: BASE,
  });
  assert.deepEqual(rt.productMap, { "PAX-1": "Garuda Kacang Atom" });
  assert.equal(rt.getProductForScene("ENGAGE-A"), null);
});

test("SNAPSHOT: balasan interaksi memakai peta balasan yang SAMA", () => {
  const rt = createRuntimeMappings({
    mappings: MAPPINGS,
    idle: idleOn([{ scene: "ENGAGE-A", reply: "hai kak" }]),
    baseRules: BASE,
  });
  assert.deepEqual(rt.formatSceneMessage("ENGAGE-A"), { ok: true, text: "hai kak" });
});

test("SNAPSHOT: scene interaksi TIDAK masuk indeks matcher", () => {
  const rt = createRuntimeMappings({
    mappings: MAPPINGS,
    idle: idleOn([{ scene: "ENGAGE-A" }]),
    baseRules: BASE,
  });
  assert.deepEqual(rt.rules.map((r) => r.scene), ["PAX-1"]);
  assert.deepEqual(rt.scenes(), ["PAX-1"]);
});

test("SNAPSHOT: scene interaksi yang tidak dikenal mesin pemutaran TIDAK dijalankan", () => {
  // Decision 1: tidak ada durasi cadangan dan tidak ada skema detail kedua.
  const rt = createRuntimeMappings({
    mappings: MAPPINGS,
    idle: idleOn([{ scene: "ENGAGE-TAK-DIKENAL" }]),
    baseRules: BASE,
  });
  assert.deepEqual(rt.idle.rules, []);
  assert.deepEqual(rt.unknownPlayback, ["ENGAGE-TAK-DIKENAL"]);
  assert.equal(rt.idle.enabled, false, "saklar tidak boleh mengaku menyala di atas nol scene");
});

test("SNAPSHOT: mode legacy tidak punya interaksi saat sepi", () => {
  const rt = createRuntimeMappings({ baseRules: BASE });
  assert.equal(rt.idle.enabled, false);
  assert.deepEqual(rt.idle.rules, []);
});

test("SNAPSHOT: afterMs dihitung dari detik", () => {
  const rt = createRuntimeMappings({ mappings: MAPPINGS, idle: idleOn([{ scene: "ENGAGE-A" }], 45), baseRules: BASE });
  assert.equal(rt.idle.afterMs, 45_000);
});

// --- validasi dunia nyata ----------------------------------------------------

function vm(idle, over = {}) {
  return validateMappings({ mappings: MAPPINGS, idle, obsScenes: SCENES, products: CATALOGUE, playableScenes: PLAYABLE, ...over });
}

test("VALIDASI: idle tidak ada / mati -> tidak memengaruhi apa pun", () => {
  assert.equal(vm(null).ok, true);
  assert.equal(vm(undefined).ok, true);
  assert.equal(vm({ enabled: false, afterSeconds: 30, items: [{ scene: "ENGAGE-TIDAK-ADA" }] }).ok, true);
});

test("VALIDASI: idle menyala + scene hilang dari OBS -> START diblokir", () => {
  const v = vm(idleOn([{ scene: "ENGAGE-TIDAK-ADA" }]));
  assert.equal(v.ok, false);
  assert.equal(v.idle[0].reason, "obs-scene-missing");
});

test("VALIDASI: idle menyala + scene ada di OBS tapi tidak bisa diputar -> diblokir", () => {
  // Decision 1, dikatakan dengan JUJUR lewat kode yang sudah ada.
  const v = vm(idleOn([{ scene: "ENGAGE-A" }]), { playableScenes: ["PAX-1"] });
  assert.equal(v.ok, false);
  assert.ok(v.idle[0].reasons.includes("scene-playback-unknown"));
});

test("VALIDASI: scene idle ganda dan tabrakan dengan aturan ditolak", () => {
  assert.equal(vm(idleOn([{ scene: "ENGAGE-A" }, { scene: "ENGAGE-A" }])).idle[1].reason, "duplicate-scene");
  assert.equal(vm(idleOn([{ scene: "PAX-1" }])).idle[0].reason, "idle-scene-conflicts-with-rule");
});

test("VALIDASI: baris idle TERPISAH dari baris pemetaan", () => {
  const v = vm(idleOn([{ scene: "ENGAGE-A" }]));
  assert.equal(v.mappings.length, 1);
  assert.equal(v.idle.length, 1);
});

test("VALIDASI: produk TIDAK PERNAH menjadi prasyarat interaksi", () => {
  // Katalog kosong sama sekali: aturan penonton boleh gagal, interaksi tidak.
  const v = validateMappings({
    mappings: [],
    idle: idleOn([{ scene: "ENGAGE-A" }]),
    obsScenes: SCENES,
    products: [],
    playableScenes: PLAYABLE,
  });
  assert.deepEqual(v.idle, [{ scene: "ENGAGE-A", ok: true, reason: null }]);
});

test("KATALOG: setiap kode baru punya kalimat server", () => {
  for (const c of ["idle-no-items", "idle-scene-conflicts-with-rule", "duplicate-scene"]) {
    assert.equal(typeof CATALOG[c], "string", c);
  }
  for (const c of ["idle-after-out-of-range", "idle-scene-conflicts-with-rule"]) {
    assert.equal(typeof FIELD_PROBLEMS[c], "string", c);
  }
});

// --- preflight ---------------------------------------------------------------

function preflight(idle) {
  const pf = createPreflight({
    portFree: async () => true,
    probeObs: async () => ({ ok: true, scenes: SCENES }),
    checkProfileDir: async () => ({ ok: true }),
    probeTikTok: async () => ({ ok: true, products: CATALOGUE, live: true, productCount: 1 }),
    listOrphans: async () => ({ count: 0 }),
    validateConfig,
    playableScenes: PLAYABLE,
  });
  return pf.run(cfg(idle));
}

test("PREFLIGHT: idle tidak ada -> tidak memengaruhi apa pun", async () => {
  const out = await preflight(undefined);
  assert.equal(out.ok, true, JSON.stringify(out.checks));
});

test("PREFLIGHT: idle MATI dengan scene yang tidak ada -> tetap lolos", async () => {
  const out = await preflight({ enabled: false, afterSeconds: 30, items: [{ scene: "TIDAK-ADA" }] });
  assert.equal(out.ok, true, JSON.stringify(out.checks));
});

test("PREFLIGHT: idle MENYALA dengan scene yang hilang -> START diblokir", async () => {
  const out = await preflight(idleOn([{ scene: "TIDAK-ADA" }]));
  assert.equal(out.ok, false);
  assert.equal(out.checks.scenes.ok, false);
  assert.equal(out.checks.scenes.reason, "obs-scene-missing");
  assert.ok(out.checks.scenes.missing.includes("TIDAK-ADA"));
});

test("PREFLIGHT: idle MENYALA dengan scene yang sah -> lolos", async () => {
  const out = await preflight(idleOn([{ scene: "ENGAGE-A" }, { scene: "ENGAGE-B" }]));
  assert.equal(out.ok, true, JSON.stringify(out.checks));
  assert.equal(out.checks.mappings.idleCount, 2);
});

// --- UI: formulir ------------------------------------------------------------

test("UI: config -> formulir -> config, bolak-balik utuh", () => {
  const original = { enabled: true, afterSeconds: 45, items: [{ scene: "ENGAGE-A", reply: "hai" }, { scene: "ENGAGE-B", reply: null }] };
  assert.deepEqual(U.idleFormToConfig(U.idleToForm(original)), original);
});

test("UI: balasan kosong jadi null, BUKAN string kosong", () => {
  const out = U.idleFormToConfig({ enabled: true, afterSeconds: 30, items: [{ scene: "A", reply: "" }] });
  assert.equal(out.items[0].reply, null);
});

test("UI: baris tanpa scene tidak dikirim, dan tidak menggagalkan penyimpanan", () => {
  const out = U.idleFormToConfig({ enabled: true, afterSeconds: 30, items: [{ scene: "", reply: "x" }, { scene: "A" }] });
  assert.deepEqual(out.items, [{ scene: "A", reply: null }]);
});

test("UI: idle absen dibaca sebagai MATI dengan bawaan 30 detik", () => {
  assert.deepEqual(U.idleToForm(undefined), { enabled: false, afterSeconds: 30, items: [] });
});

test("UI: payload config membawa idle hanya kalau formulirnya dibaca", () => {
  const base = { version: 1, obs: { host: "h", port: 1 }, mappings: [], idle: { enabled: true, afterSeconds: 30, items: [{ scene: "A", reply: null }] } };
  // Tanpa formulir: blok idle yang sudah ada TIDAK ditimpa.
  assert.deepEqual(U.buildConfigPayload(base, []).idle, base.idle);
  // Dengan formulir: formulir yang menang.
  const out = U.buildConfigPayload(base, [], { enabled: false, afterSeconds: 60, items: [] });
  assert.deepEqual(out.idle, { enabled: false, afterSeconds: 60, items: [] });
});

test("UI: field mati kalau fiturnya dimatikan, dan nilainya TIDAK hilang", () => {
  const form = { enabled: false, afterSeconds: 45, items: [{ scene: "ENGAGE-A", reply: "hai" }] };
  const v = U.idleView({ idleForm: form, status: { automation: "STOPPED", config: { present: true }, login: { active: false } } }, "id");
  assert.equal(v.afterDisabled, true);
  assert.equal(v.itemsDisabled, true);
  assert.equal(v.addDisabled, true);
  // Nilainya tetap ada, jadi menyalakannya kembali memulihkan isiannya.
  assert.equal(v.afterSeconds, 45);
  assert.deepEqual(v.items, [{ scene: "ENGAGE-A", reply: "hai" }]);
  assert.equal(v.itemsError, "", "yang mati tidak dikeluhkan");
});

// --- UI: pengaturan DILIPAT saat fiturnya mati -------------------------------
//
// Deretan field mati yang tetap terlihat membuat customer bertanya apakah
// fiturnya masih jalan - pertanyaan yang tidak boleh ada di layar yang dipakai
// saat LIVE. Yang dilipat hanya TAMPILANnya: nilainya tetap di form, jadi
// mati -> nyala memunculkan kembali yang sama persis.

const STATUS_SIAP = { automation: "STOPPED", config: { present: true }, login: { active: false } };
const ISI = { enabled: true, afterSeconds: 45, items: [{ scene: "ENGAGE-A", reply: "hai" }, { scene: "ENGAGE-B", reply: "" }] };

test("UI LIPAT: mati -> seluruh pengaturannya disembunyikan", () => {
  const v = U.idleView({ idleForm: Object.assign({}, ISI, { enabled: false }), status: STATUS_SIAP }, "id");
  assert.equal(v.detailsHidden, true, "detik, kartu scene, balasan, dan tombol Tambah ikut tersembunyi");
  // Mati TETAP juga berarti mati, bukan hanya tersembunyi: yang disembunyikan
  // masih ada di DOM, jadi disabled tidak boleh ikut dilepas.
  assert.equal(v.afterDisabled, true);
  assert.equal(v.itemsDisabled, true);
  assert.equal(v.addDisabled, true);
});

test("UI LIPAT: menyala -> pengaturannya muncul kembali", () => {
  const v = U.idleView({ idleForm: ISI, status: STATUS_SIAP }, "id");
  assert.equal(v.detailsHidden, false);
  assert.equal(v.afterDisabled, false);
  assert.equal(v.itemsDisabled, false);
  assert.equal(v.addDisabled, false);
});

test("UI LIPAT: mati TIDAK menghapus afterSeconds, scene, maupun balasannya", () => {
  const form = Object.assign({}, ISI, { enabled: false });
  const v = U.idleView({ idleForm: form, status: STATUS_SIAP }, "id");
  assert.equal(v.afterSeconds, 45, "detik tidak boleh direset");
  assert.equal(v.count, 2);
  assert.deepEqual(v.items, [{ scene: "ENGAGE-A", reply: "hai" }, { scene: "ENGAGE-B", reply: "" }]);
  // Dan formulirnya sendiri tidak disentuh oleh fungsi tampilan.
  assert.deepEqual(form.items, ISI.items);
  assert.equal(form.afterSeconds, 45);
});

test("UI LIPAT: mati -> nyala memulihkan nilai yang SAMA PERSIS", () => {
  const form = Object.assign({}, ISI, { enabled: false });
  const mati = U.idleView({ idleForm: form, status: STATUS_SIAP }, "id");
  assert.equal(mati.detailsHidden, true);

  form.enabled = true;
  const nyala = U.idleView({ idleForm: form, status: STATUS_SIAP }, "id");
  assert.equal(nyala.detailsHidden, false);
  assert.equal(nyala.afterSeconds, mati.afterSeconds);
  assert.deepEqual(nyala.items, mati.items);
});

test("UI LIPAT: halaman punya pembungkusnya, dan app.js benar-benar memakainya", () => {
  // Tanpa jsdom, kabel DOM diperiksa dari SUMBERNYA - pola yang sama dengan
  // test/ui.realaction.test.js. Keputusan detailsHidden tidak berarti apa pun
  // kalau app.js tidak pernah menuliskannya, atau kalau field-nya ternyata
  // berada di LUAR pembungkus yang disembunyikan.
  const fs = require("node:fs");
  const path = require("node:path");
  const PUBLIC_DIR = path.resolve(__dirname, "..", "controller", "public");
  const html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
  const app = fs.readFileSync(path.join(PUBLIC_DIR, "app.js"), "utf8");

  assert.ok(html.includes('id="idle-details"'), "index.html harus punya pembungkus idle-details");
  assert.ok(app.includes('"idle-details"'), "app.js harus mendaftarkan dan memakai idle-details");
  assert.match(app, /el\["idle-details"\]\.hidden = v\.detailsHidden/, "app.js harus menulis hidden dari keputusan ui-logic");

  // Keempat kendali itu harus berada DI DALAM pembungkusnya.
  const start = html.indexOf('id="idle-details"');
  const end = html.indexOf('id="add-mapping-btn"');
  assert.ok(start > 0 && end > start, "urutan halaman tidak seperti yang diharapkan");
  const inside = html.slice(start, end);
  for (const id of ["idle-after", "idle-items", "idle-empty", "add-idle-btn"]) {
    assert.ok(inside.includes('id="' + id + '"'), id + " harus berada di dalam idle-details");
  }

  // Saklar dan penjelasannya justru TIDAK boleh ikut tersembunyi: itu satu-satunya
  // jalan untuk menyalakannya kembali.
  const before = html.slice(0, start);
  assert.ok(before.includes('id="idle-enabled"'), "saklarnya harus tetap di luar pembungkus");
  assert.ok(before.includes('data-t="ui.idle.help"'), "penjelasan singkatnya harus tetap terlihat");
});

test("UI LIPAT: config -> form -> config saat mati tidak kehilangan apa pun", () => {
  // Pembuktian bahwa melipat benar-benar hanya tampilan: perjalanan bolak-balik
  // lewat jalur simpan yang sesungguhnya harus mengembalikan isi yang sama.
  const config = { enabled: false, afterSeconds: 45, items: [{ scene: "ENGAGE-A", reply: "hai" }] };
  const form = U.idleToForm(config);
  const v = U.idleView({ idleForm: form, status: STATUS_SIAP }, "id");
  assert.equal(v.detailsHidden, true);

  const back = U.idleFormToConfig(form);
  assert.equal(back.enabled, false);
  assert.equal(back.afterSeconds, 45);
  assert.deepEqual(back.items, [{ scene: "ENGAGE-A", reply: "hai" }]);
});

test("UI: menyala tanpa scene dikatakan di layar", () => {
  const v = U.idleView({ idleForm: { enabled: true, afterSeconds: 30, items: [] }, status: { automation: "STOPPED", config: { present: true }, login: { active: false } } }, "id");
  assert.equal(v.itemsError, T("ui.idle.needsScene"));
  assert.equal(v.emptyText, T("ui.idle.empty"));
});

test("UI: afterSeconds di luar batas dikatakan di layar", () => {
  const mk = (n) => U.idleView({ idleForm: { enabled: true, afterSeconds: n, items: [{ scene: "A" }] }, status: { automation: "STOPPED", config: { present: true }, login: { active: false } } }, "id");
  assert.ok(mk(0).afterError.length > 0);
  assert.ok(mk(99999).afterError.length > 0);
  assert.equal(mk(30).afterError, "");
});

test("UI: catatan cooldown SELALU tampil, supaya satu scene tidak terasa rusak", () => {
  const v = U.idleView({ idleForm: U.idleToForm(null) }, "id");
  assert.equal(v.cooldownNote, T("ui.idle.cooldownNote"));
  assert.ok(v.cooldownNote.length > 0);
});

test("UI: masalah per baris interaksi dicocokkan lewat INDEKS", () => {
  const validation = { idle: [{ scene: "A", ok: true }, { scene: "B", ok: false, reason: "obs-scene-missing" }] };
  const issues = U.idleIssues(validation, 2, "id");
  assert.equal(issues[0], null);
  assert.equal(issues[1].message, T("err.obs-scene-missing"));
});

// --- UI: kartu "sedang tayang" ----------------------------------------------

function onair(scene, idleItems, rows) {
  const t = new Date().toISOString();
  return U.onairView(
    {
      status: { automation: "RUNNING" },
      activity: [{ id: 1, type: "PLAY", scene, time: t }],
      rows: rows || [],
      idleItems: idleItems || [],
    },
    "id"
  );
}

test("ON AIR: scene interaksi dengan balasan -> scene diputar + balasan, TANPA pin", () => {
  const v = onair("ENGAGE-A", [{ scene: "ENGAGE-A", reply: "hai" }]);
  assert.equal(v.idle, true);
  assert.equal(v.title, T("ui.onair.idleTitle"));
  assert.deepEqual(v.chain.map((c) => c.label), [T("ui.onair.scenePlaying"), T("ui.onair.replied")]);
  assert.ok(!v.chain.some((c) => c.label === T("ui.onair.pinned")), "tidak boleh ada langkah produk");
});

test("ON AIR: scene interaksi tanpa balasan -> hanya scene diputar", () => {
  const v = onair("ENGAGE-B", [{ scene: "ENGAGE-B", reply: null }]);
  assert.deepEqual(v.chain.map((c) => c.label), [T("ui.onair.scenePlaying")]);
});

test("ON AIR: langkah scene interaksi SUDAH terjadi, bukan menunggu", () => {
  const v = onair("ENGAGE-A", [{ scene: "ENGAGE-A", reply: "hai" }]);
  assert.notEqual(v.chain[0].value, T("ui.onair.waiting"));
  assert.equal(v.chain[0].tone, U.TONE.READY);
});

test("ON AIR: aturan penonton tetap diputuskan dari barisnya, bukan dari idle", () => {
  const v = onair("PAX-1", [{ scene: "ENGAGE-A" }], [{ scene: "PAX-1", actions: { switchScene: true, autoPin: true, autoReply: true } }]);
  assert.equal(v.idle, false);
  assert.deepEqual(v.chain.map((c) => c.label), [T("ui.onair.pinned"), T("ui.onair.replied")]);
});

test("ON AIR: bawaan scene tak dikenal TIDAK BERUBAH", () => {
  // Pagar penting: bawaan lama tetap benar untuk kasusnya sendiri — dashboard
  // yang baru dibuka belum punya daftar aturan maupun daftar interaksi.
  const v = onair("SCENE-ASING", [], []);
  assert.equal(v.idle, false);
  assert.deepEqual(v.chain.map((c) => c.label), [T("ui.onair.pinned"), T("ui.onair.replied")]);
});

// --- tiga bahasa -------------------------------------------------------------

test("TIGA BAHASA: setiap kalimat interaksi ada di id, en, dan zh-CN", () => {
  const keys = [
    "ui.idle.title", "ui.idle.help", "ui.idle.toggle", "ui.idle.after", "ui.idle.afterUnit",
    "ui.idle.afterRange", "ui.idle.scenes", "ui.idle.scene", "ui.idle.replyOptional",
    "ui.idle.add", "ui.idle.empty", "ui.idle.needsScene", "ui.idle.cooldownNote",
    "ui.onair.idleTitle", "ui.onair.scenePlaying",
    "err.idle-no-items", "err.idle-scene-conflicts-with-rule", "err.duplicate-scene",
    "field.idle-after-out-of-range", "field.idle-scene-conflicts-with-rule",
    "path.idle", "path.idle.after", "path.idle.item", "path.idle.items",
    "path.idle.itemScene", "path.idle.itemReply",
  ];
  // "Scene" adalah kata yang SAMA di Indonesia dan Inggris, jadi kesamaannya di
  // dua kamus itu benar — bukan terjemahan yang terlewat. Dikecualikan dengan
  // menyebut kuncinya satu per satu, supaya pengecualian tidak bisa melebar
  // tanpa ada yang menuliskannya di sini.
  const SAME_IN_EN = new Set(["ui.idle.scene", "path.idle.itemScene"]);
  for (const lang of I18N.LANGS) {
    for (const key of keys) {
      const val = I18N.DICT[lang][key];
      assert.equal(typeof val, "string", lang + " " + key);
      assert.ok(val.trim().length > 0, lang + " " + key + " kosong");
      if (lang === "id") continue;
      // Mandarin tidak pernah boleh sama dengan Indonesia: aksaranya berbeda.
      if (lang === "en" && SAME_IN_EN.has(key)) continue;
      assert.notEqual(val, I18N.DICT.id[key], lang + " " + key + " masih bahasa Indonesia");
    }
  }
});

test("TIGA BAHASA: path idle jadi label yang bisa dibaca, bukan path mesin", () => {
  for (const lang of I18N.LANGS) {
    const out = I18N.fieldProblem(lang, "idle.items[0].scene", "idle-scene-conflicts-with-rule", "");
    assert.ok(!/idle\.items/.test(out), lang + ": " + out);
    assert.ok(out.length > 0);
  }
});
