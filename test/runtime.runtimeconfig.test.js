// Artefak config runtime: bentuk, hash generasi, tulis atomik, dan baca
// fail-closed.
//
// Dua jaminan yang paling penting di berkas ini:
//
//   1. Hash generasi berubah kalau DAN HANYA KALAU isi yang berpengaruh berubah.
//      Kalau ia berubah karena hal yang tidak relevan (mis. waktu pembuatan),
//      pemeriksaan "bot dan service memakai generasi yang sama" akan selalu
//      gagal. Kalau ia TIDAK berubah padahal pemetaan berubah, pemeriksaan itu
//      akan selalu lolos — dan tidak ada gunanya sama sekali.
//
//   2. Berkas yang disunting tangan sesudah dibuat DITOLAK. Artefak adalah apa
//      yang sudah divalidasi Controller; berkas yang berubah sesudah itu bukan
//      lagi hal yang sama.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildRuntimeConfig,
  validateRuntimeConfig,
  computeRuntimeConfigId,
  writeRuntimeConfig,
  readRuntimeConfig,
  removeRuntimeConfig,
  RUNTIME_CONFIG_ENV,
  RUNTIME_CONFIG_VERSION,
} = require("../runtime/runtime-config");
const { createFakeFs } = require("./helpers/controller-harness");

const FILE = "/fake/data/.runtime/runtime-x.json";

const M = [
  { scene: "PAX-1", product: { title: "O'CORN Sea Salt" }, triggers: ["etalase satu"], reply: "sudah dipin" },
  { scene: "PAX-2", product: { title: "Dilan Cookies" }, triggers: ["etalase dua"], reply: "siap" },
];

// --- bentuk ------------------------------------------------------------------

test("build menghasilkan bentuk yang sempit dan tetap", () => {
  const a = buildRuntimeConfig({ mappings: M, configVersion: 1 });
  assert.deepEqual(Object.keys(a).sort(), ["configVersion", "createdAt", "id", "mappings", "version"]);
  assert.equal(a.version, RUNTIME_CONFIG_VERSION);
  assert.equal(a.configVersion, 1);
  assert.equal(typeof a.id, "string");
  assert.equal(a.id.length, 16);
});

test("setiap mapping punya tepat empat field", () => {
  const a = buildRuntimeConfig({ mappings: M });
  for (const m of a.mappings) {
    assert.deepEqual(Object.keys(m).sort(), ["product", "reply", "scene", "triggers"]);
  }
});

test("field asing di mapping dibuang, tidak diteruskan", () => {
  // Artefak dibaca dua proses; ia tidak boleh jadi tempat menumpuk apa pun.
  const a = buildRuntimeConfig({
    mappings: [{ scene: "PAX-1", product: { title: "x" }, triggers: ["a"], reply: "b", rahasia: "jangan ikut", obsPassword: "bocor" }],
  });
  assert.deepEqual(Object.keys(a.mappings[0]).sort(), ["product", "reply", "scene", "triggers"]);
  assert.ok(!JSON.stringify(a).includes("bocor"));
});

test("produk: judul kosong jadi null, bukan objek dengan judul kosong", () => {
  for (const product of [{ title: "" }, { title: "   " }, null, undefined]) {
    const a = buildRuntimeConfig({ mappings: [{ scene: "PAX-1", product, triggers: ["a"] }] });
    assert.equal(a.mappings[0].product, null, "product=" + JSON.stringify(product));
  }
});

test("balasan kosong jadi null", () => {
  for (const reply of ["", "   ", null, undefined]) {
    const a = buildRuntimeConfig({ mappings: [{ scene: "PAX-1", product: null, triggers: ["a"], reply }] });
    assert.equal(a.mappings[0].reply, null);
  }
});

test("judul, balasan, dan scene di-trim", () => {
  const a = buildRuntimeConfig({
    mappings: [{ scene: "  PAX-1  ", product: { title: "  x  " }, triggers: ["a"], reply: "  hai  " }],
  });
  assert.equal(a.mappings[0].scene, "PAX-1");
  assert.equal(a.mappings[0].product.title, "x");
  assert.equal(a.mappings[0].reply, "hai");
});

test("trigger kosong dan bukan string dibuang", () => {
  const a = buildRuntimeConfig({ mappings: [{ scene: "PAX-1", product: null, triggers: ["ok", "", null, 7, "  "] }] });
  assert.deepEqual(a.mappings[0].triggers, ["ok"]);
});

// --- hash generasi -----------------------------------------------------------

test("id SAMA untuk pemetaan yang sama", () => {
  const a = buildRuntimeConfig({ mappings: M, configVersion: 1 });
  const b = buildRuntimeConfig({ mappings: M, configVersion: 1 });
  assert.equal(a.id, b.id);
});

test("id TIDAK berubah karena waktu pembuatan", () => {
  // Kalau ia berubah karena waktu, pemeriksaan generasi antara bot dan service
  // akan selalu gagal walau keduanya memakai pemetaan yang identik.
  const a = buildRuntimeConfig({ mappings: M, createdAt: "2026-01-01T00:00:00.000Z" });
  const b = buildRuntimeConfig({ mappings: M, createdAt: "2026-12-31T23:59:59.000Z" });
  assert.equal(a.id, b.id);
  assert.notEqual(a.createdAt, b.createdAt);
});

test("id BERUBAH kalau trigger berubah", () => {
  const a = buildRuntimeConfig({ mappings: M });
  const changed = JSON.parse(JSON.stringify(M));
  changed[0].triggers.push("trigger baru");
  assert.notEqual(buildRuntimeConfig({ mappings: changed }).id, a.id);
});

test("id BERUBAH kalau balasan berubah", () => {
  const a = buildRuntimeConfig({ mappings: M });
  const changed = JSON.parse(JSON.stringify(M));
  changed[0].reply = "kalimat lain";
  assert.notEqual(buildRuntimeConfig({ mappings: changed }).id, a.id);
});

test("id BERUBAH kalau produk berubah", () => {
  const a = buildRuntimeConfig({ mappings: M });
  const changed = JSON.parse(JSON.stringify(M));
  changed[0].product.title = "produk lain";
  assert.notEqual(buildRuntimeConfig({ mappings: changed }).id, a.id);
});

test("id BERUBAH kalau scene berubah", () => {
  const a = buildRuntimeConfig({ mappings: M });
  const changed = JSON.parse(JSON.stringify(M));
  changed[0].scene = "PAX-9";
  assert.notEqual(buildRuntimeConfig({ mappings: changed }).id, a.id);
});

test("id BERUBAH kalau urutan pemetaan berubah", () => {
  // Urutan berpengaruh: ia menentukan rule mana yang cocok lebih dulu.
  const a = buildRuntimeConfig({ mappings: M });
  const b = buildRuntimeConfig({ mappings: M.slice().reverse() });
  assert.notEqual(a.id, b.id);
});

test("id BERUBAH kalau satu pemetaan dihapus", () => {
  const a = buildRuntimeConfig({ mappings: M });
  const b = buildRuntimeConfig({ mappings: [M[0]] });
  assert.notEqual(a.id, b.id);
});

// --- validasi ----------------------------------------------------------------

test("artefak hasil build selalu valid", () => {
  assert.equal(validateRuntimeConfig(buildRuntimeConfig({ mappings: M })).ok, true);
  assert.equal(validateRuntimeConfig(buildRuntimeConfig({ mappings: [] })).ok, true);
});

test("bukan objek ditolak", () => {
  for (const v of [null, undefined, 42, "x", []]) {
    assert.equal(validateRuntimeConfig(v).ok, false);
  }
});

test("versi yang tidak didukung ditolak", () => {
  const a = buildRuntimeConfig({ mappings: M });
  a.version = 2;
  assert.equal(validateRuntimeConfig(a).reason, "version-unsupported");
});

test("id yang hilang ditolak", () => {
  const a = buildRuntimeConfig({ mappings: M });
  delete a.id;
  assert.equal(validateRuntimeConfig(a).reason, "id-missing");
});

test("BERKAS YANG DISUNTING TANGAN ditolak lewat id-mismatch", () => {
  // Inilah jaminan paling penting di modul ini: artefak adalah apa yang sudah
  // divalidasi Controller. Berkas yang berubah sesudah itu bukan lagi hal yang
  // sama, dan memakainya berarti memin produk yang tidak pernah diperiksa.
  const a = buildRuntimeConfig({ mappings: M });
  a.mappings[0].product.title = "produk yang diselundupkan";
  assert.equal(validateRuntimeConfig(a).reason, "id-mismatch");
});

test("menambah pemetaan tanpa memperbarui id juga tertolak", () => {
  const a = buildRuntimeConfig({ mappings: M });
  a.mappings.push({ scene: "PAX-9", product: { title: "x" }, triggers: ["a"], reply: null });
  assert.equal(validateRuntimeConfig(a).reason, "id-mismatch");
});

test("mapping yang bentuknya salah ditolak", () => {
  const base = () => buildRuntimeConfig({ mappings: M });
  const cases = [
    [(a) => { a.mappings = "bukan array"; }, "mappings-not-an-array"],
    [(a) => { a.mappings[0] = null; }, "mapping-not-an-object"],
    [(a) => { a.mappings[0].scene = ""; }, "scene-missing"],
    [(a) => { a.mappings[0].triggers = "bukan array"; }, "triggers-not-an-array"],
    [(a) => { a.mappings[0].product = { title: "" }; }, "product-invalid"],
    [(a) => { a.mappings[0].reply = 42; }, "reply-invalid"],
  ];
  for (const [mutate, reason] of cases) {
    const a = base();
    mutate(a);
    assert.equal(validateRuntimeConfig(a).reason, reason);
  }
});

test("produk null tetap sah", () => {
  const a = buildRuntimeConfig({ mappings: [{ scene: "PAX-1", product: null, triggers: ["a"] }] });
  assert.equal(validateRuntimeConfig(a).ok, true);
});

// --- tulis / baca ------------------------------------------------------------

test("tulis ATOMIK: lewat berkas sementara, lalu rename", () => {
  const fs = createFakeFs();
  const a = buildRuntimeConfig({ mappings: M });
  const r = writeRuntimeConfig(FILE, a, { fs });

  assert.equal(r.ok, true);
  assert.equal(r.id, a.id);
  // Tanpa rename, ada jendela di mana anak bisa membaca berkas separuh tertulis
  // dan mulai LIVE dengan pemetaan tak lengkap.
  assert.deepEqual(fs.writes, [FILE + ".tmp"]);
  assert.deepEqual(fs.renames, [[FILE + ".tmp", FILE]]);
  assert.equal(fs.files.has(FILE + ".tmp"), false);
});

test("tulis menolak payload yang tidak valid, dan tidak menyentuh berkas", () => {
  const fs = createFakeFs();
  const a = buildRuntimeConfig({ mappings: M });
  a.version = 99;
  const r = writeRuntimeConfig(FILE, a, { fs });
  assert.equal(r.ok, false);
  assert.deepEqual(fs.writes, []);
  assert.equal(fs.files.has(FILE), false);
});

test("rename gagal: berkas sementara dibersihkan", () => {
  const fs = createFakeFs();
  fs.failRenames = true;
  const r = writeRuntimeConfig(FILE, buildRuntimeConfig({ mappings: M }), { fs });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "write-failed");
  assert.equal(fs.files.has(FILE + ".tmp"), false, "sisa berkas sementara harus dibersihkan");
});

test("tulis lalu baca: isinya kembali utuh", () => {
  const fs = createFakeFs();
  const a = buildRuntimeConfig({ mappings: M, configVersion: 1 });
  writeRuntimeConfig(FILE, a, { fs });
  const back = readRuntimeConfig(FILE, { fs });
  assert.equal(back.ok, true);
  assert.deepEqual(back.config, a);
});

test("baca: berkas tidak ada -> runtime-config-missing", () => {
  const fs = createFakeFs();
  assert.equal(readRuntimeConfig(FILE, { fs }).reason, "runtime-config-missing");
});

test("baca: JSON rusak -> runtime-config-invalid-json", () => {
  const fs = createFakeFs({ [FILE]: "{ bukan json" });
  assert.equal(readRuntimeConfig(FILE, { fs }).reason, "runtime-config-invalid-json");
});

test("baca: BOM di awal tetap terbaca", () => {
  // Pelajaran yang sama dengan .bot.lock dan config customer.
  const fs = createFakeFs();
  const a = buildRuntimeConfig({ mappings: M });
  fs.files.set(FILE, "﻿" + JSON.stringify(a));
  const back = readRuntimeConfig(FILE, { fs });
  assert.equal(back.ok, true);
  assert.equal(back.config.id, a.id);
});

test("baca: berkas yang disunting tangan ditolak dengan alasan yang jelas", () => {
  const fs = createFakeFs();
  const a = buildRuntimeConfig({ mappings: M });
  writeRuntimeConfig(FILE, a, { fs });
  // Operator (atau sesuatu) menyunting berkasnya langsung.
  const edited = JSON.parse(fs.files.get(FILE));
  edited.mappings[0].product.title = "produk lain";
  fs.files.set(FILE, JSON.stringify(edited));

  const back = readRuntimeConfig(FILE, { fs });
  assert.equal(back.ok, false);
  assert.equal(back.reason, "runtime-config-id-mismatch");
});

test("hapus membuang berkas DAN sisa berkas sementara", () => {
  const fs = createFakeFs();
  const a = buildRuntimeConfig({ mappings: M });
  writeRuntimeConfig(FILE, a, { fs });
  fs.files.set(FILE + ".tmp", "sisa");

  removeRuntimeConfig(FILE, { fs });
  assert.equal(fs.files.has(FILE), false);
  assert.equal(fs.files.has(FILE + ".tmp"), false);
});

test("hapus berkas yang tidak ada: aman", () => {
  const fs = createFakeFs();
  assert.equal(removeRuntimeConfig(FILE, { fs }).ok, true);
});

test("nama variabel environment-nya tepat satu, dan itu sebuah path", () => {
  // Kontrak transport P2: SATU variabel, isinya path. Bukan puluhan variabel,
  // dan bukan daftar yang disandikan ke dalam string.
  assert.equal(RUNTIME_CONFIG_ENV, "AILIVE_RUNTIME_CONFIG");
});

test("computeRuntimeConfigId stabil untuk payload yang sama", () => {
  const a = buildRuntimeConfig({ mappings: M });
  assert.equal(computeRuntimeConfigId(a), computeRuntimeConfigId(a));
  assert.equal(computeRuntimeConfigId(a), a.id);
});
