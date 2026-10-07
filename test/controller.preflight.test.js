// Preflight: semua yang harus benar SEBELUM satu proses pun dinyalakan.
//
// Dua sifat yang diuji keras di sini:
//
//   1. FAIL-CLOSED. Probe yang melempar adalah check yang GAGAL, bukan check yang
//      dilewati. Validasi platform yang lambat pada 2026-10-07 (collect 6613ms,
//      focus 5306ms) sudah membuktikan arah kegagalan ini benar.
//   2. Hasilnya selalu berbentuk sama, dengan SEMUA nama check hadir. Check yang
//      hilang dari hasil adalah check yang tidak akan pernah diperhatikan.
//
// Semua probe di-inject. Tidak ada socket, OBS, TikTok, atau browser.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createPreflight, firstFailure, CHECK_NAMES } = require("../controller/preflight");
const { validateConfig } = require("../controller/config-manager");
const { goodConfig, passingPreflightDeps } = require("./helpers/controller-harness");

function mk(overrides = {}) {
  return createPreflight(Object.assign({ validateConfig, cwd: "/fake" }, passingPreflightDeps(overrides)));
}

test("semua hijau -> ok", async () => {
  const r = await mk().run(goodConfig());
  assert.equal(r.ok, true);
  for (const name of CHECK_NAMES) assert.equal(r.checks[name].ok, true, name);
});

test("hasil selalu memuat SEMUA nama check", async () => {
  const r = await mk({ probeObs: async () => ({ ok: false, reason: "obs-unavailable" }) }).run(goodConfig());
  assert.deepEqual(Object.keys(r.checks).sort(), CHECK_NAMES.slice().sort());
});

test("config tidak valid: sisa check ditandai DILEWATI, bukan dihapus", async () => {
  const bad = goodConfig();
  bad.mappings = [{ scene: "PAX-1", product: { title: "" } }];

  const r = await mk().run(bad);

  assert.equal(r.ok, false);
  assert.equal(r.checks.config.ok, false);
  assert.ok(r.checks.config.errors.length > 0, "daftar error ikut, supaya bisa ditampilkan");
  // Port mana yang diperiksa dan scene mana yang dicari semuanya datang dari
  // config: tanpa config yang valid, sisanya tidak punya arti.
  for (const name of CHECK_NAMES) {
    if (name === "config") continue;
    assert.equal(r.checks[name].skipped, true, name + " harus ditandai dilewati");
  }
});

test("username TikTok belum diisi: ditahan walau skemanya sah", async () => {
  // Kosong itu sah sebagai bentuk (string), tapi belum siap dipakai. Pemeriksaan
  // kesiapan tempatnya di preflight, bukan di validator skema.
  const c = goodConfig();
  c.tiktok.username = "   ";
  const r = await mk().run(c);
  assert.equal(r.ok, false);
  assert.equal(r.checks.config.reason, "tiktok-username-missing");
});

test("port terpakai -> port-in-use, dengan nomor portnya", async () => {
  const r = await mk({ portFree: async () => false }).run(goodConfig());
  assert.equal(r.checks.ports.ok, false);
  assert.equal(r.checks.ports.reason, "port-in-use");
  assert.equal(r.checks.ports.port, 5055);
});

test("probe port yang MELEMPAR dianggap gagal, bukan lolos", async () => {
  const r = await mk({
    portFree: async () => {
      throw new Error("boom");
    },
  }).run(goodConfig());
  assert.equal(r.checks.ports.ok, false);
  assert.equal(r.checks.ports.reason, "port-check-failed");
  assert.equal(r.ok, false);
});

test("OBS mati -> obs-unavailable, dan scenes tidak bisa diperiksa", async () => {
  const r = await mk({ probeObs: async () => ({ ok: false, reason: "obs-unavailable" }) }).run(goodConfig());
  assert.equal(r.checks.obs.reason, "obs-unavailable");
  assert.equal(r.checks.scenes.ok, false);
  assert.equal(r.checks.scenes.skipped, true);
  assert.equal(r.checks.scenes.reason, "skipped-obs-unavailable");
});

test("password OBS salah dibedakan dari OBS mati", async () => {
  // Tindakan customer-nya berbeda: satu memperbaiki password, satu menyalakan OBS.
  const r = await mk({ probeObs: async () => ({ ok: false, reason: "obs-auth-failed" }) }).run(goodConfig());
  assert.equal(r.checks.obs.reason, "obs-auth-failed");
});

test("probe OBS yang MELEMPAR dianggap OBS tidak tersedia", async () => {
  const r = await mk({
    probeObs: async () => {
      throw new Error("ECONNREFUSED");
    },
  }).run(goodConfig());
  assert.equal(r.checks.obs.ok, false);
  assert.equal(r.checks.obs.reason, "obs-unavailable");
});

test("scene di mapping yang tidak ada di OBS disebutkan satu per satu", async () => {
  const c = goodConfig();
  c.mappings = [
    { scene: "PAX-1", product: { title: "A" } },
    { scene: "PAX-7", product: { title: "B" } },
    { scene: "PAX-8", product: { title: "C" } },
  ];
  const r = await mk({ probeObs: async () => ({ ok: true, scenes: ["MAIN", "PAX-1"] }) }).run(c);

  assert.equal(r.checks.scenes.ok, false);
  assert.equal(r.checks.scenes.reason, "obs-scene-missing");
  // Disebutkan yang mana, supaya customer tidak harus mencocokkan sendiri.
  assert.deepEqual(r.checks.scenes.missing, ["PAX-7", "PAX-8"]);
});

test("mapping kosong ditahan: AutoPIN tidak akan pernah melakukan apa pun", async () => {
  const c = goodConfig();
  c.mappings = [];
  const r = await mk().run(c);
  assert.equal(r.checks.scenes.ok, false);
  assert.equal(r.checks.scenes.reason, "no-mappings");
});

test("daftar scene OBS yang tidak terbaca dianggap gagal", async () => {
  const r = await mk({ probeObs: async () => ({ ok: true }) }).run(goodConfig());
  assert.equal(r.checks.scenes.ok, false);
  assert.equal(r.checks.scenes.reason, "obs-scene-list-unreadable");
});

test("direktori profil tidak bisa dipakai -> profile-dir-unusable", async () => {
  const r = await mk({ checkProfileDir: async () => ({ ok: false, reason: "profile-dir-unusable" }) }).run(goodConfig());
  assert.equal(r.checks.profile.ok, false);
  assert.equal(r.checks.profile.reason, "profile-dir-unusable");
});

test("probe profil yang MELEMPAR dianggap gagal", async () => {
  const r = await mk({
    checkProfileDir: async () => {
      throw new Error("EACCES");
    },
  }).run(goodConfig());
  assert.equal(r.checks.profile.ok, false);
});

test("proses yatim yang masih hidup -> already-running dengan jumlahnya", async () => {
  const r = await mk({ listOrphans: async () => ({ count: 3 }) }).run(goodConfig());
  assert.equal(r.checks.processes.ok, false);
  assert.equal(r.checks.processes.reason, "already-running");
  assert.equal(r.checks.processes.count, 3);
});

test("pemeriksaan proses yang MELEMPAR dianggap gagal", async () => {
  // Inilah pelajaran stop-all.ps1: laporan yang tidak bisa dipercaya lebih
  // berbahaya daripada tidak ada laporan.
  const r = await mk({
    listOrphans: async () => {
      throw new Error("powershell hilang");
    },
  }).run(goodConfig());
  assert.equal(r.checks.processes.ok, false);
  assert.equal(r.checks.processes.reason, "process-check-failed");
});

test("tanpa penyapu yatim: ditandai dilewati, dan jujur soal itu", async () => {
  const p = createPreflight({ validateConfig, cwd: "/fake", ...passingPreflightDeps({ listOrphans: null }) });
  const r = await p.run(goodConfig());
  assert.equal(r.checks.processes.skipped, true);
  assert.equal(r.checks.processes.reason, "orphan-check-not-configured");
});

test("adapter TikTok di P1 adalah stub yang JUJUR, bukan yang mengaku ok", async () => {
  // Memeriksa LIVE on air / daftar produk / komposer chat butuh browser sungguhan
  // di akun sungguhan. Itu pekerjaan P2.
  const r = await mk().run(goodConfig());
  assert.equal(r.checks.tiktok.ok, true);
  assert.equal(r.checks.tiktok.skipped, true);
  assert.equal(r.checks.tiktok.reason, "not-implemented-p1");
});

test("adapter TikTok yang gagal tetap menahan start", async () => {
  // Bentuknya sudah siap untuk P2: begitu adapter sungguhan dipasang, kegagalannya
  // langsung berlaku tanpa mengubah apa pun di sini.
  const r = await mk({ probeTikTok: async () => ({ ok: false, reason: "no-live-products" }) }).run(goodConfig());
  assert.equal(r.ok, false);
  assert.equal(r.checks.tiktok.reason, "no-live-products");
});

test("satu check merah membuat keseluruhannya merah", async () => {
  for (const dep of [
    { portFree: async () => false },
    { probeObs: async () => ({ ok: false, reason: "obs-unavailable" }) },
    { checkProfileDir: async () => ({ ok: false }) },
    { listOrphans: async () => ({ count: 1 }) },
    { probeTikTok: async () => ({ ok: false, reason: "x" }) },
  ]) {
    const r = await mk(dep).run(goodConfig());
    assert.equal(r.ok, false, JSON.stringify(Object.keys(dep)));
  }
});

test("firstFailure menyebut SEBAB paling awal, bukan gejala sesudahnya", async () => {
  // OBS mati membuat check scenes juga merah. Yang dilaporkan harus OBS, karena
  // itulah yang perlu diperbaiki customer.
  const r = await mk({ probeObs: async () => ({ ok: false, reason: "obs-unavailable" }) }).run(goodConfig());
  const f = firstFailure(r);
  assert.equal(f.check, "obs");
  assert.equal(f.reason, "obs-unavailable");
});

test("firstFailure null kalau semuanya hijau", async () => {
  assert.equal(firstFailure(await mk().run(goodConfig())), null);
});

test("preflight tidak pernah membocorkan stack trace", async () => {
  const r = await mk({
    probeObs: async () => {
      throw new Error("C:\\Users\\rahasia\\node_modules\\obs.js:42 meledak");
    },
  }).run(goodConfig());
  const serialized = JSON.stringify(r);
  assert.ok(!serialized.includes("node_modules"), "path internal tidak boleh keluar");
  assert.ok(!serialized.includes("rahasia"));
});

test("preflight tidak pernah membocorkan password OBS", async () => {
  const r = await mk().run(goodConfig());
  assert.ok(!JSON.stringify(r).includes("rahasia-obs"));
});

test("urutan CHECK_NAMES: config lebih dulu, lalu processes, lalu ports", async () => {
  // Urutan ini yang dipakai firstFailure untuk memilih sebab paling awal.
  assert.equal(CHECK_NAMES[0], "config");
  assert.equal(CHECK_NAMES[1], "processes");
  assert.equal(CHECK_NAMES[2], "ports");
});
