// FAIL-CLOSED: config runtime yang tidak bisa dipakai membuat bot MENOLAK
// menyala — ia tidak pernah jatuh kembali ke kata kunci hardcoded diam-diam.
//
// Kenapa ini penting dan bukan kehati-hatian berlebihan:
//
// Kalau Controller menyuplai AILIVE_RUNTIME_CONFIG, berarti ia sudah memvalidasi
// pemetaan terhadap scene OBS dan katalog LIVE yang sungguhan. Kalau berkas itu
// ternyata tidak terbaca dan bot diam-diam memakai array RULES, yang terjadi
// adalah: bot menyala, terlihat normal, lalu merespons kata kunci yang customer
// tidak pernah lihat dan memin produk dari AUTOPIN_PRODUCT_* milik developer.
// Di akun sungguhan, di depan penonton.
//
// Arah kegagalannya sama dengan runtime/single-instance.js: kalau ragu, TOLAK
// menyala. Bot yang menolak start gampang dilihat dan gampang dibetulkan.
//
// Bot dijalankan sebagai subprocess SUNGGUHAN di sini — tapi ia keluar di tingkat
// modul, sebelum menyentuh TikTok, OBS, atau browser. Nol koneksi.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const { buildRuntimeConfig, writeRuntimeConfig, RUNTIME_CONFIG_ENV } = require("../runtime/runtime-config");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ailive-failclosed-"));

// Memuat index.js di proses TERPISAH, lalu melaporkan kode keluarnya.
//
// Yang dijalankan adalah require(), bukan `node index.js`. Dua alasan, dan
// keduanya penting:
//
//   1. Pemeriksaan config runtime terjadi di TINGKAT MODUL, jadi require() sudah
//      cukup untuk memicunya — termasuk process.exit(1) saat ia menolak.
//   2. `node index.js` menjalankan startLive(), yang memasang pembaca stdin dan
//      mencoba menyambung ke OBS. Prosesnya lalu tidak pernah keluar, dan tesnya
//      hanya lulus lewat timeout 20 detik. Tes yang lulus lewat timeout tidak
//      membuktikan apa pun tentang kode keluar, dan membuat suite lambat tanpa
//      alasan.
// spawnSync, bukan execFileSync: execFileSync hanya mengembalikan stdout saat
// prosesnya SUKSES, dan beberapa baris yang diperiksa di sini dicetak ke stderr
// (console.error). Dengan execFileSync, tes "scene diabaikan" lulus hanya karena
// prosesnya kebetulan kena timeout dan masuk jalur catch yang memang membawa
// stderr — lulus karena alasan yang salah.
function runBot(env, { timeoutMs = 20000 } = {}) {
  const script = "require(" + JSON.stringify(path.join(ROOT, "index.js")) + ")";
  const r = spawnSync(process.execPath, ["-e", script], {
    cwd: ROOT,
    timeout: timeoutMs,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: Object.assign({}, process.env, {
      AUTOPIN_ENABLED: "false",
      AUTOCOMMENT_ENABLED: "false",
      DOTENV_CONFIG_QUIET: "true",
      TIKTOK_USERNAME: "",
    }, env),
  });
  return {
    code: typeof r.status === "number" ? r.status : -1,
    stdout: String(r.stdout || ""),
    stderr: String(r.stderr || ""),
    timedOut: r.signal !== null && r.status === null,
  };
}

const BAD_CASES = [
  [
    "berkas tidak ada",
    () => path.join(TMP, "tidak-ada.json"),
    "runtime-config-missing",
  ],
  [
    "JSON rusak",
    () => {
      const f = path.join(TMP, "rusak.json");
      fs.writeFileSync(f, "{ ini bukan json", "utf8");
      return f;
    },
    "runtime-config-invalid-json",
  ],
  [
    "versi tidak didukung",
    () => {
      const f = path.join(TMP, "versi.json");
      const a = buildRuntimeConfig({ mappings: [{ scene: "PAX-1", product: { title: "x" }, triggers: ["a"] }] });
      a.version = 99;
      fs.writeFileSync(f, JSON.stringify(a), "utf8");
      return f;
    },
    "runtime-config-version-unsupported",
  ],
  [
    "berkas disunting tangan sesudah dibuat",
    () => {
      const f = path.join(TMP, "disunting.json");
      const a = buildRuntimeConfig({ mappings: [{ scene: "PAX-1", product: { title: "x" }, triggers: ["a"] }] });
      writeRuntimeConfig(f, a);
      const edited = JSON.parse(fs.readFileSync(f, "utf8"));
      edited.mappings[0].product.title = "produk yang diselundupkan";
      fs.writeFileSync(f, JSON.stringify(edited), "utf8");
      return f;
    },
    "runtime-config-id-mismatch",
  ],
];

for (const [label, make, expectedReason] of BAD_CASES) {
  test("TOLAK MENYALA: " + label, () => {
    const file = make();
    const r = runBot({ [RUNTIME_CONFIG_ENV]: file });

    assert.notEqual(r.timedOut, true, "bot harus keluar, bukan menggantung");
    assert.equal(r.code, 1, "harus keluar dengan kode 1. stdout=" + r.stdout.slice(0, 300));

    const out = r.stdout + (r.stderr || "");
    assert.ok(out.includes("[RUNTIME_CONFIG_REFUSED]"), "harus mencetak penolakan. out=" + out.slice(0, 400));
    assert.ok(out.includes("reason=" + expectedReason), "alasan harus " + expectedReason + ". out=" + out.slice(0, 400));
    // Dan ia harus mengatakan dengan jelas bahwa ia TIDAK memakai kata kunci bawaan.
    assert.ok(out.includes("TIDAK dijalankan dengan kata kunci bawaan"), "harus menyebutkan tidak ada fallback");
  });
}

test("config runtime yang SAH membuat bot melewati tahap itu tanpa menolak", () => {
  // Kontrol positif. Tanpa ini, tes di atas bisa lulus karena bot selalu keluar 1
  // untuk alasan apa pun.
  const f = path.join(TMP, "sah.json");
  const a = buildRuntimeConfig({ mappings: [{ scene: "PAX-1", product: { title: "x" }, triggers: ["etalase satu"], reply: "ok" }] });
  assert.equal(writeRuntimeConfig(f, a).ok, true);

  const r = runBot({ [RUNTIME_CONFIG_ENV]: f });

  const out = r.stdout + (r.stderr || "");
  assert.equal(r.code, 0, "harus keluar bersih. out=" + out.slice(0, 400));
  assert.ok(!out.includes("[RUNTIME_CONFIG_REFUSED]"), "tidak boleh menolak config yang sah. out=" + out.slice(0, 400));
});

test("TANPA config runtime, bot tidak menolak apa pun (jalur legacy utuh)", () => {
  // Jalur yang dipakai operator hari ini: `node index.js` tanpa Controller.
  const r = runBot({});
  const out = r.stdout + (r.stderr || "");
  assert.equal(r.code, 0, "jalur legacy harus memuat bersih. out=" + out.slice(0, 400));
  assert.ok(!out.includes("[RUNTIME_CONFIG_REFUSED]"));
});

test("scene yang dipetakan tanpa detail pemutaran DILAPORKAN, tidak dikarang", () => {
  // Jaring terakhir yang terlihat. Validator Controller sudah menolaknya lebih
  // dulu; kalau sesuatu lolos sampai sini, operator tetap diberi tahu.
  const f = path.join(TMP, "scene-asing.json");
  const a = buildRuntimeConfig({
    mappings: [{ scene: "SCENE-YANG-TIDAK-ADA-DI-RULES", product: { title: "x" }, triggers: ["a"] }],
  });
  assert.equal(writeRuntimeConfig(f, a).ok, true);

  const r = runBot({ [RUNTIME_CONFIG_ENV]: f });
  const out = r.stdout + (r.stderr || "");
  assert.ok(out.includes("[RUNTIME_CONFIG_SCENE_IGNORED]"), "harus dilaporkan. out=" + out.slice(0, 400));
  assert.ok(out.includes("SCENE-YANG-TIDAK-ADA-DI-RULES"));
});

test("pembaca config runtime SELALU menyebut alasan, tidak mengembalikan null kosong", () => {
  // Diuji di tingkat unit, bukan dengan menjalankan autopin-service.js: service
  // membuka Chrome sesudah tahap ini, dan P2 tidak membuka browser apa pun.
  //
  // Kenapa alasannya harus ada: service memakai pembaca ini hanya untuk mengambil
  // id generasi. Kalau ia gagal tanpa menyebut alasan, service akan melaporkan
  // runtimeConfigId: null, dan pembandingan generasi di Controller akan LOLOS
  // tanpa arti — tepat pada kasus di mana ia paling dibutuhkan.
  const { readRuntimeConfig } = require("../runtime/runtime-config");

  const broken = path.join(TMP, "rusak-svc.json");
  fs.writeFileSync(broken, "{ bukan json", "utf8");
  assert.deepEqual(readRuntimeConfig(broken), { ok: false, reason: "runtime-config-invalid-json" });

  assert.deepEqual(readRuntimeConfig(path.join(TMP, "tidak-pernah-ada.json")), {
    ok: false,
    reason: "runtime-config-missing",
  });
});

test("Controller MENOLAK start kalau generasi service berbeda dari miliknya", async () => {
  // Pasangan dari tes di atas: angka generasi tidak hanya dilaporkan, ia
  // dibandingkan. Service yang masih sisa run sebelumnya akan memakai pemetaan
  // basi, dan itu tidak boleh dibiarkan jalan.
  const { createHarness, goodConfig } = require("./helpers/controller-harness");
  const { STATES } = require("../controller/state-machine");

  const h = createHarness({
    config: goodConfig(),
    // Service melaporkan generasi yang BUKAN milik Controller.
    fetchHealth: async () => ({ ok: true, body: { ok: true, runtimeConfigId: "generasi-basi-1234" } }),
  });

  const r = await h.controller.startAutomation();

  assert.equal(r.ok, false);
  assert.equal(r.error.code, "runtime-config-generation-mismatch");
  assert.equal(r.error.userMessage, "The bot and the pin service are using different settings.");
  // Dan rollback tetap bersih: tidak ada yang tertinggal hidup.
  assert.equal(h.world.liveCount(), 0);
  assert.equal(h.world.countByScript("index.js"), 0, "bot tidak boleh pernah dinyalakan");
  assert.equal(h.controller.state(), STATES.STOPPED);
});

test("generasi service yang COCOK membiarkan start lanjut", async () => {
  // Kontrol positif untuk tes di atas.
  const { createHarness, goodConfig } = require("./helpers/controller-harness");
  const { buildRuntimeConfig: build } = require("../runtime/runtime-config");

  const cfg = goodConfig();
  const expectedId = build({ mappings: cfg.mappings, configVersion: cfg.version }).id;

  const h = createHarness({
    config: cfg,
    fetchHealth: async () => ({ ok: true, body: { ok: true, runtimeConfigId: expectedId } }),
  });

  const r = await h.controller.startAutomation();
  assert.equal(r.ok, true, JSON.stringify(r.error || {}));
  assert.equal(h.controller.runtimeConfigId(), expectedId);
});

test("service yang TIDAK melaporkan generasi tidak memblokir start", async () => {
  // Service lama (atau yang dijalankan tanpa config runtime) melaporkan null.
  // Itu bukan ketidakcocokan; ia hanya tidak tahu. Memblokir start karenanya akan
  // membuat jalur manual mustahil dijalankan lewat Controller.
  const { createHarness, goodConfig } = require("./helpers/controller-harness");
  const h = createHarness({
    config: goodConfig(),
    fetchHealth: async () => ({ ok: true, body: { ok: true, runtimeConfigId: null } }),
  });
  const r = await h.controller.startAutomation();
  assert.equal(r.ok, true, JSON.stringify(r.error || {}));
});
