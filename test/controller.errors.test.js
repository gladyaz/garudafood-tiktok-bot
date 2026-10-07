// Penerjemah kode internal -> kalimat untuk customer, dan parsing argumen entry
// point Controller.
//
// Pemisahan yang diuji di sini: `code` tetap kode mesin yang sudah dipakai core,
// `userMessage` kalimat biasa, dan stack trace TIDAK PERNAH menjadi pesan
// customer — bukan karena jelek dilihat, tapi karena ia membocorkan path berkas
// dan struktur internal ke layar yang bisa sedang di-share saat LIVE.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { translate, translateFieldErrors, CATALOG, FALLBACK } = require("../controller/errors");
const { parseArgs, SERVICE_PASSTHROUGH } = require("../controller/index");
const { DEFAULT_PORT } = require("../controller/server");

// --- translate ---------------------------------------------------------------

test("kode yang ada di katalog diterjemahkan", () => {
  assert.equal(translate("obs-unavailable").userMessage, "OBS is not connected.");
  assert.equal(translate("no-live-products").userMessage, "No LIVE products detected.");
  assert.equal(
    translate("budget-exhausted-before-click").userMessage,
    "TikTok responded too slowly. The product was not changed."
  );
});

test("kode internal TETAP ada di hasil, tidak dibuang", () => {
  // Detail teknis tidak dihapus; ia hanya dipisahkan dari kalimat customer.
  const r = translate("budget-exhausted-before-click");
  assert.equal(r.code, "budget-exhausted-before-click");
});

test("kode yang belum dikenal tetap mengembalikan bentuk yang sama", () => {
  // Pemanggil tidak pernah perlu memeriksa apakah terjemahannya ada.
  const r = translate("sesuatu-yang-baru");
  assert.equal(r.code, "sesuatu-yang-baru");
  assert.equal(r.userMessage, FALLBACK);
});

test("kode yang bukan string tidak meledak", () => {
  for (const v of [null, undefined, 42, {}, []]) {
    const r = translate(v);
    assert.equal(r.code, "unknown");
    assert.equal(r.userMessage, FALLBACK);
  }
});

test("detail opsional: hanya satu baris, dipotong, tanpa jejak stack", () => {
  const stack = "Error: boom\n    at foo (C:\\Users\\rahasia\\app.js:1:1)\n    at bar (...)";
  const r = translate("service-error", { detail: stack });
  assert.equal(r.detail, "Error: boom");
  assert.ok(!r.detail.includes("at foo"), "barisan stack harus hilang");
  assert.ok(!r.detail.includes("rahasia"));
});

test("detail yang sangat panjang dipotong", () => {
  const r = translate("service-error", { detail: "x".repeat(500) });
  assert.ok(r.detail.length <= 200);
});

test("detail kosong tidak ikut di hasil", () => {
  for (const d of ["", null, undefined]) {
    assert.equal("detail" in translate("obs-unavailable", { detail: d }), false);
  }
});

test("semua kalimat customer berakhir dengan tanda baca dan tanpa jargon kode", () => {
  for (const [code, msg] of Object.entries(CATALOG)) {
    assert.ok(/[.!]$/.test(msg), code + ' -> "' + msg + '" harus diakhiri tanda baca');
    // Kalimat untuk customer tidak boleh berisi kode mesin bergaya kebab-case.
    assert.ok(!/\b[a-z]+-[a-z]+-[a-z]+\b/.test(msg), code + " -> masih ada kode mesin di kalimatnya");
  }
});

test("kode yang dikembalikan core punya terjemahan", () => {
  // Daftar ini diambil dari string `reason` yang sungguhan ada di
  // autopin/service.js, autopin/scene-pin.js, dan autocomment/core.js.
  const fromCore = [
    "no-products-found",
    "live-pin-control-not-available",
    "budget-exhausted-before-click",
    "budget-exhausted-in-queue",
    "collect-incomplete-budget",
    "unexpected-page",
    "stale",
    "duplicate-playId",
    "dispatch-threw",
    "service-error",
    "real-comment-send-disabled",
    "empty-message",
    "timeout",
  ];
  for (const code of fromCore) {
    assert.ok(CATALOG[code], code + " belum punya terjemahan");
  }
});

// --- translateFieldErrors ----------------------------------------------------

test("kesalahan field jadi kalimat dengan path-nya", () => {
  const out = translateFieldErrors([{ path: "mappings[0].product.title", code: "must-be-non-empty-string" }]);
  assert.equal(out[0].path, "mappings[0].product.title");
  assert.equal(out[0].code, "must-be-non-empty-string");
  assert.equal(out[0].userMessage, "mappings[0].product.title needs to be filled in");
});

test("kesalahan tanpa path memakai kalimat umum", () => {
  const out = translateFieldErrors([{ path: "", code: "not-an-object" }]);
  assert.equal(out[0].userMessage, "The configuration is not a valid configuration");
});

test("kode field yang belum dikenal tetap menghasilkan kalimat", () => {
  const out = translateFieldErrors([{ path: "obs.port", code: "entah-apa" }]);
  assert.equal(out[0].userMessage, "obs.port is not valid");
});

test("daftar kosong jadi daftar kosong", () => {
  assert.deepEqual(translateFieldErrors([]), []);
  assert.deepEqual(translateFieldErrors(), []);
});

// --- entry point -------------------------------------------------------------

test("tanpa argumen: port default", () => {
  assert.equal(parseArgs([]).port, DEFAULT_PORT);
  assert.deepEqual(parseArgs([]).serviceArgs, []);
});

test("--port= dihormati", () => {
  assert.equal(parseArgs(["--port=4900"]).port, 4900);
});

test("--port yang tidak masuk akal jatuh ke default, bukan meledak", () => {
  for (const v of ["0", "-1", "65536", "abc", ""]) {
    assert.equal(parseArgs(["--port=" + v]).port, DEFAULT_PORT, "port=" + v);
  }
});

test("flag izin diteruskan ke service, dan HANYA dari baris perintah", () => {
  // Tidak ada nilai di data/config.json yang bisa menyalakan ini. Dua lapis,
  // persis seperti sebelum Controller ada.
  const r = parseArgs(["--enable-autocomment-send", "--click-strategy=dom"]);
  assert.deepEqual(r.serviceArgs, ["--enable-autocomment-send", "--click-strategy=dom"]);
});

test("argumen sembarang TIDAK diteruskan ke proses yang mengklik akun sungguhan", () => {
  const r = parseArgs(["--rm-rf", "--ngawur", "--enable-autocomment-send", "halo"]);
  assert.deepEqual(r.serviceArgs, ["--enable-autocomment-send"]);
});

test("daftar passthrough memang tertutup dan isinya yang diharapkan", () => {
  assert.deepEqual(SERVICE_PASSTHROUGH.slice().sort(), [
    "--allow-comment-send-once",
    "--dry-run",
    "--enable-autocomment-send",
  ]);
});

test("--click-strategy diteruskan apa adanya, divalidasi oleh service", () => {
  // Nilai tak dikenal ditolak oleh autopin-service.js sendiri (parseClickStrategy),
  // dan prosesnya berhenti. Controller tidak menduplikasi validasi itu.
  assert.deepEqual(parseArgs(["--click-strategy=mouse"]).serviceArgs, ["--click-strategy=mouse"]);
});

test("mengimpor entry point tidak menyalakan apa pun", () => {
  // require() di atas sudah terjadi. Kalau impor itu punya efek samping, tes ini
  // tidak akan pernah sampai ke sini dengan bersih.
  assert.equal(typeof parseArgs, "function");
});
