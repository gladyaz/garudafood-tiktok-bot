// Validasi aksi per-aturan: bentuk config, pemetaan terhadap dunia nyata, dan
// prasyarat sebelum START.
//
// Satu aturan dipegang di seluruh berkas ini: FAIL-CLOSED untuk setiap aksi yang
// MENYALA, dan NOL TUNTUTAN untuk aksi yang mati. Aturan FAQ yang tidak mem-pin
// apa pun tidak boleh bisa memblokir START karena sebuah produk yang tidak
// pernah ia pakai.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { validateConfig, defaultConfig } = require("../controller/config-manager");
const { validateMappings } = require("../controller/mapping-validator");
const { createPreflight } = require("../controller/preflight");
const { CATALOG } = require("../controller/errors");

const ALL_ON = { switchScene: true, autoPin: true, autoReply: true };

const SCENES = ["MAIN", "PAX-1", "PAX-2", "FAQ-HARGA"];
const PLAYABLE = ["PAX-1", "PAX-2", "FAQ-HARGA"];
const CATALOGUE = [
  { title: "Garuda Kacang Atom 80gr", number: 1, pinAvailable: true },
  { title: "Gery Potato Snack", number: 2, pinAvailable: true },
];

function configWith(mappings) {
  const c = defaultConfig();
  c.tiktok.username = "akun_uji";
  c.mappings = mappings;
  return c;
}

const codesOf = (verdict) => verdict.errors.map((e) => e.code);
const pathsOf = (verdict) => verdict.errors.map((e) => e.path);

function rowFor(mappings, opts = {}) {
  return validateMappings(
    Object.assign({ mappings, obsScenes: SCENES, products: CATALOGUE, playableScenes: PLAYABLE }, opts)
  ).mappings[0];
}

// --- bentuk config: pelonggaran, bukan pengetatan ---------------------------

test("LEGACY: config v0.1.1 tanpa satu pun field actions tetap VALID", () => {
  // Kalau ini merah, setiap customer yang sudah punya config tidak bisa membuka
  // aplikasinya lagi. Tidak ada kompromi di baris ini.
  const v = validateConfig(
    configWith([
      { scene: "PAX-1", product: { title: "Garuda Kacang Atom" }, triggers: ["etalase 1"], reply: "sudah aku pin" },
      // Scene FAQ seperti yang ditulis customer hari ini.
      { scene: "FAQ-HARGA", product: null, triggers: ["harga"], reply: "cek etalase ya kak" },
      // Dan aturan lama yang memin tanpa balasan sama sekali.
      { scene: "PAX-2", product: { title: "Gery Potato" }, triggers: ["etalase 2"] },
    ])
  );
  assert.deepEqual(v.errors, []);
  assert.equal(v.ok, true);
});

test("versi config TIDAK berubah: config lama tidak boleh ditolak sebagai versi asing", () => {
  // Menaikkan CONFIG_VERSION akan membuat setiap config yang sudah ada gagal
  // dengan version-unsupported — kebalikan dari yang diminta kompatibilitas.
  assert.equal(defaultConfig().version, 1);
  const v = validateConfig(configWith([{ scene: "PAX-1", product: null, triggers: ["a"] }]));
  assert.equal(v.ok, true);
});

test("actions yang sah diterima; bentuk yang salah ditolak per kunci", () => {
  assert.equal(validateConfig(configWith([{ scene: "PAX-1", product: { title: "x" }, triggers: ["a"], actions: ALL_ON }])).ok, true);
  assert.equal(validateConfig(configWith([{ scene: "PAX-1", product: { title: "x" }, triggers: ["a"], actions: {} }])).ok, true);

  const bad = validateConfig(configWith([{ scene: "PAX-1", product: { title: "x" }, triggers: ["a"], actions: "ya" }]));
  assert.deepEqual(codesOf(bad), ["must-be-object"]);
  assert.deepEqual(pathsOf(bad), ["mappings[0].actions"]);

  const badKey = validateConfig(configWith([{ scene: "PAX-1", product: { title: "x" }, triggers: ["a"], actions: { autoPin: "ya" } }]));
  assert.deepEqual(codesOf(badKey), ["must-be-boolean"]);
  assert.deepEqual(pathsOf(badKey), ["mappings[0].actions.autoPin"]);
});

test("ALL OFF: ditolak di tingkat bentuk config", () => {
  const v = validateConfig(
    configWith([{ scene: "PAX-1", product: { title: "x" }, triggers: ["a"], actions: { switchScene: false, autoPin: false, autoReply: false } }])
  );
  assert.ok(codesOf(v).includes("no-actions-enabled"));
  assert.ok(pathsOf(v).includes("mappings[0].actions"));
});

test("SCENE: wajib hanya kalau aturan mengganti scene", () => {
  const needs = validateConfig(configWith([{ product: null, triggers: ["a"], actions: { switchScene: true, autoPin: false, autoReply: false } }]));
  assert.ok(codesOf(needs).includes("must-be-non-empty-string"));
  assert.ok(pathsOf(needs).includes("mappings[0].scene"));

  const fine = validateConfig(
    configWith([{ triggers: ["a"], reply: "b", actions: { switchScene: false, autoPin: false, autoReply: true } }])
  );
  assert.deepEqual(fine.errors, [], "aturan balas-saja tidak butuh scene maupun produk");
});

test("PRODUK: field-nya boleh TIDAK ADA kalau aturan tidak mem-pin", () => {
  // Pelonggaran. Sebelumnya product yang hilang selalu product-missing.
  const v = validateConfig(
    configWith([{ scene: "FAQ-HARGA", triggers: ["harga"], reply: "cek etalase ya kak", actions: { switchScene: true, autoPin: false, autoReply: true } }])
  );
  assert.deepEqual(v.errors, []);
});

test("PRODUK: judul kosong pun sah kalau aturan tidak mem-pin, dan judul tersimpan tetap diterima", () => {
  for (const product of [{ title: "" }, null, { title: "Garuda Kacang Atom" }]) {
    const v = validateConfig(
      configWith([{ scene: "FAQ-HARGA", product, triggers: ["harga"], reply: "x", actions: { switchScene: true, autoPin: false, autoReply: true } }])
    );
    assert.deepEqual(v.errors, [], "product=" + JSON.stringify(product));
  }
});

test("PRODUK: aturan lama yang mem-pin tetap wajib menyebut field product", () => {
  // Perilaku v0.1.1 yang TIDAK berubah: field yang lupa diisi tetap ditolak.
  const v = validateConfig(configWith([{ scene: "PAX-1", triggers: ["a"] }]));
  assert.deepEqual(codesOf(v), ["product-missing"]);
});

// --- validasi terhadap OBS dan katalog LIVE ---------------------------------

test("PRODUCT SAFETY: pin menyala + produk tidak ada di etalase => START diblokir", () => {
  const row = rowFor([
    { scene: "PAX-1", product: { title: "Produk Yang Tidak Pernah Ada" }, triggers: ["a"], reply: "b", actions: ALL_ON },
  ]);
  assert.equal(row.ok, false);
  assert.equal(row.reason, "product-not-found");
});

test("PRODUCT SAFETY: pin MATI + produk tidak ada di etalase => TIDAK memblokir START", () => {
  // Pagar inti fitur ini. Judul yang tertinggal pada aturan FAQ tidak boleh ikut
  // dalam fail-closed produk.
  const row = rowFor([
    {
      scene: "FAQ-HARGA",
      product: { title: "Produk Yang Tidak Pernah Ada" },
      triggers: ["harga"],
      reply: "cek etalase ya kak",
      actions: { switchScene: true, autoPin: false, autoReply: true },
    },
  ]);
  assert.equal(row.ok, true, "alasan: " + JSON.stringify(row.reasons || row.reason));
});

test("PRODUCT SAFETY: pin MATI + produk tidak disebut sama sekali => sah", () => {
  const row = rowFor([
    { scene: "FAQ-HARGA", triggers: ["harga"], reply: "cek etalase ya kak", actions: { switchScene: true, autoPin: false, autoReply: true } },
  ]);
  assert.equal(row.ok, true);
});

test("PRODUCT SAFETY: pin menyala secara EKSPLISIT tanpa produk => tidak sah", () => {
  const row = rowFor([{ scene: "PAX-1", triggers: ["a"], reply: "b", actions: ALL_ON }]);
  assert.equal(row.ok, false);
  assert.equal(row.reason, "product-missing");
});

test("PRODUCT SAFETY: pin MATI tidak ikut pemeriksaan ambigu maupun kontrol pin", () => {
  const products = [
    { title: "Kacang Atom Rasa Pedas", number: 1, pinAvailable: true },
    { title: "Kacang Atom Rasa Original", number: 2, pinAvailable: false },
  ];
  const ambiguous = { scene: "FAQ-HARGA", product: { title: "Kacang Atom" }, triggers: ["harga"], reply: "x" };
  // Dengan pin menyala, judul yang cocok ke dua produk ditolak.
  assert.equal(validateMappings({ mappings: [Object.assign({}, ambiguous, { actions: ALL_ON })], products }).mappings[0].reason, "ambiguous-product");
  // Dengan pin mati, tidak ada yang perlu dipilih.
  assert.equal(
    validateMappings({
      mappings: [Object.assign({}, ambiguous, { actions: { switchScene: true, autoPin: false, autoReply: true } })],
      products,
    }).mappings[0].ok,
    true
  );
});

test("SCENE SAFETY: ganti scene menyala + scene hilang dari OBS => tidak sah", () => {
  const row = rowFor([{ scene: "SCENE-SUDAH-DIHAPUS", product: null, triggers: ["a"], reply: "b", actions: { switchScene: true, autoPin: false, autoReply: true } }], {
    playableScenes: null,
  });
  assert.equal(row.ok, false);
  assert.equal(row.reason, "obs-scene-missing");
});

test("SCENE SAFETY: ganti scene MATI + tanpa scene => sah", () => {
  const row = rowFor([{ triggers: ["ini ai ya"], reply: "iya kak", actions: { switchScene: false, autoPin: false, autoReply: true } }]);
  assert.equal(row.ok, true, "alasan: " + JSON.stringify(row.reasons || row.reason));
});

test("SCENE SAFETY: ganti scene MATI + scene tersimpan yang sudah hilang dari OBS => sah", () => {
  // Nilai yang tertinggal tidak boleh memblokir START untuk sesuatu yang tidak
  // akan pernah dikirim ke OBS.
  const row = rowFor([
    { scene: "SCENE-SUDAH-DIHAPUS", triggers: ["a"], reply: "b", actions: { switchScene: false, autoPin: false, autoReply: true } },
  ]);
  assert.equal(row.ok, true, "alasan: " + JSON.stringify(row.reasons || row.reason));
});

test("SCENE SAFETY: ganti scene menyala tanpa scene => scene-required", () => {
  const row = rowFor([{ triggers: ["a"], reply: "b", actions: { switchScene: true, autoPin: false, autoReply: true } }]);
  assert.equal(row.ok, false);
  assert.equal(row.reason, "scene-required");
});

test("SCENE SAFETY: scene ganda hanya dihitung di antara aturan yang MEMAKAI scene", () => {
  const rows = validateMappings({
    mappings: [
      { scene: "PAX-1", product: { title: "Garuda Kacang Atom" }, triggers: ["a"], reply: "r", actions: ALL_ON },
      { triggers: ["b"], reply: "r2", actions: { switchScene: false, autoPin: false, autoReply: true } },
      { triggers: ["c"], reply: "r3", actions: { switchScene: false, autoPin: false, autoReply: true } },
    ],
    obsScenes: SCENES,
    products: CATALOGUE,
    playableScenes: PLAYABLE,
  });
  assert.ok(rows.ok, "dua aturan tanpa scene tidak bentrok: " + JSON.stringify(rows.mappings));
});

test("REPLY SAFETY: balas menyala + balasan kosong => tidak sah, lepas dari saklar global", () => {
  for (const autoCommentEnabled of [true, false]) {
    const row = rowFor([{ scene: "FAQ-HARGA", product: null, triggers: ["harga"], actions: { switchScene: true, autoPin: false, autoReply: true } }], {
      autoCommentEnabled,
    });
    assert.equal(row.ok, false, "autoCommentEnabled=" + autoCommentEnabled);
    assert.equal(row.reason, "reply-required");
  }
});

test("REPLY SAFETY: balas MATI + balasan kosong => sah", () => {
  const row = rowFor([{ scene: "FAQ-HARGA", product: null, triggers: ["harga"], actions: { switchScene: true, autoPin: false, autoReply: false } }], {
    autoCommentEnabled: true,
  });
  assert.equal(row.ok, true, "alasan: " + JSON.stringify(row.reasons || row.reason));
});

test("REPLY SAFETY: penjaga lama tetap berlaku untuk aturan yang mem-pin", () => {
  // Perilaku v0.1.1: AutoComment global menyala + produk akan di-pin + tidak ada
  // kalimat pengumuman = hampir pasti kelalaian. TIDAK dilonggarkan.
  const row = rowFor([{ scene: "PAX-1", product: { title: "Garuda Kacang Atom" }, triggers: ["a"] }], { autoCommentEnabled: true });
  assert.equal(row.ok, false);
  assert.ok((row.reasons || []).includes("reply-required-when-autocomment-enabled"));
});

test("PIN ONLY: produk wajib, scene dan balasan tidak", () => {
  const row = rowFor([
    { product: { title: "Garuda Kacang Atom" }, triggers: ["pin dong"], actions: { switchScene: false, autoPin: true, autoReply: false } },
  ]);
  assert.equal(row.ok, true, "alasan: " + JSON.stringify(row.reasons || row.reason));

  const missing = rowFor([{ triggers: ["pin dong"], actions: { switchScene: false, autoPin: true, autoReply: false } }]);
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "product-missing");
});

test("ALL OFF: ditolak juga oleh validator pemetaan", () => {
  const row = rowFor([
    { scene: "PAX-1", product: { title: "Garuda Kacang Atom" }, triggers: ["a"], reply: "b", actions: { switchScene: false, autoPin: false, autoReply: false } },
  ]);
  assert.equal(row.ok, false);
  assert.equal(row.reason, "no-actions-enabled");
});

test("PEMICU: selalu wajib, aksi apa pun yang menyala", () => {
  for (const actions of [ALL_ON, { switchScene: false, autoPin: false, autoReply: true }, { switchScene: true, autoPin: false, autoReply: false }]) {
    const row = rowFor([{ scene: "PAX-1", product: { title: "Garuda Kacang Atom" }, triggers: [], reply: "b", actions }]);
    assert.ok((row.reasons || []).includes("no-triggers"), JSON.stringify(actions));
  }
});

test("baris hasil validasi membawa aksi yang berlaku, supaya UI tidak menebaknya", () => {
  const row = rowFor([{ scene: "PAX-1", product: { title: "Garuda Kacang Atom" }, triggers: ["a"], reply: "b" }]);
  assert.deepEqual(row.actions, ALL_ON);
});

test("setiap kode alasan baru punya kalimatnya di katalog server", () => {
  // Kode mesin tidak boleh pernah sampai ke layar; tes i18n menjaga sisi kamus,
  // ini menjaga sisi server.
  for (const code of ["no-actions-enabled", "scene-required", "reply-required"]) {
    assert.equal(typeof CATALOG[code], "string", code);
    assert.ok(CATALOG[code].length > 0, code);
  }
});

// --- preflight ---------------------------------------------------------------

function preflightWith(mappings, { obsScenes = SCENES } = {}) {
  const pf = createPreflight({
    portFree: async () => true,
    probeObs: async () => ({ ok: true, scenes: obsScenes }),
    checkProfileDir: async () => ({ ok: true }),
    probeTikTok: async () => ({ ok: true, products: CATALOGUE, live: true, productCount: CATALOGUE.length }),
    listOrphans: async () => ({ count: 0 }),
    validateConfig,
    playableScenes: PLAYABLE,
  });
  return pf.run(configWith(mappings));
}

test("PREFLIGHT: scene dari aturan yang tidak mengganti scene tidak pernah dituntut ada di OBS", async () => {
  const out = await preflightWith([
    { scene: "SCENE-SUDAH-DIHAPUS", triggers: ["a"], reply: "b", actions: { switchScene: false, autoPin: false, autoReply: true } },
  ]);
  assert.equal(out.checks.scenes.ok, true, JSON.stringify(out.checks.scenes));
  assert.equal(out.ok, true, JSON.stringify(out.checks));
});

test("PREFLIGHT: config yang HANYA berisi aturan tanpa scene tetap lolos", () => {
  return preflightWith([
    { triggers: ["ini ai ya"], reply: "iya kak", actions: { switchScene: false, autoPin: false, autoReply: true } },
  ]).then((out) => {
    assert.equal(out.checks.scenes.ok, true, JSON.stringify(out.checks.scenes));
    assert.equal(out.checks.scenes.skipped, true, "check ini tidak mengaku memeriksa sesuatu");
    assert.equal(out.ok, true, JSON.stringify(out.checks));
  });
});

test("PREFLIGHT: scene yang MEMANG akan diganti tetap wajib ada di OBS", () => {
  return preflightWith([
    { scene: "SCENE-SUDAH-DIHAPUS", product: null, triggers: ["a"], reply: "b", actions: { switchScene: true, autoPin: false, autoReply: true } },
  ]).then((out) => {
    assert.equal(out.checks.scenes.ok, false);
    assert.equal(out.checks.scenes.reason, "obs-scene-missing");
    assert.equal(out.ok, false);
  });
});

test("PREFLIGHT: tanpa satu pun pemetaan tetap no-mappings", () => {
  // Pelonggaran di atas tidak boleh menjadi lubang: sistem yang gunanya
  // mengotomasi LIVE tidak siap jalan tanpa satu pun aturan.
  return preflightWith([]).then((out) => {
    assert.equal(out.checks.scenes.ok, false);
    assert.equal(out.checks.scenes.reason, "no-mappings");
    assert.equal(out.ok, false);
  });
});
