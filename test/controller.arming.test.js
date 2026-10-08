// Izin melakukan aksi NYATA ke akun TikTok, berlaku per run.
//
// Yang diuji di sini adalah pemindahan otoritas, BUKAN pelemahannya:
//
//   sebelum P4  pengembang mengetik  --enable-autocomment-send  di terminal
//   sejak P4    customer menekan START BOT, dan HANYA kalau preflight hijau
//
// Service tetap menolak mengirim apa pun tanpa flag itu. Yang berubah hanya siapa
// yang memberikannya, dan berapa lama ia berlaku.
//
// Kenapa per run, dan bukan setelan: izin yang tersimpan akan menyala sendiri
// setiap kali aplikasi dibuka. Artinya satu klik yang pernah diberikan customer
// bulan lalu tetap berlaku hari ini, pada katalog produk dan LIVE yang berbeda —
// padahal yang ia setujui adalah run saat itu.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { createRunAuthority, REAL_SEND_FLAG } = require("../controller/run-authority");
const { createHarness, goodConfig } = require("./helpers/controller-harness");
const { STATES } = require("../controller/state-machine");

const SCENES = ["MAIN", "PAX-1", "PAX-2", "PAX-3"];
const CATALOGUE = [{ title: "O'CORN Sea Salt 80gr", number: 1, pinAvailable: true }];

// --- modul otoritas ----------------------------------------------------------

test("mulai UNARMED", () => {
  const a = createRunAuthority();
  assert.equal(a.isArmed(), false);
  assert.deepEqual(a.serviceArgs(), []);
  assert.deepEqual(a.describe(), { armed: false, runId: null, realSend: false });
});

test("arm memberi run id dan menyalakan flag kirim nyata", () => {
  const a = createRunAuthority();
  const r = a.arm({ realSend: true });
  assert.equal(r.ok, true);
  assert.equal(typeof r.runId, "string");
  assert.deepEqual(a.serviceArgs(), [REAL_SEND_FLAG]);
});

test("HAK PALING KECIL: tanpa AutoComment, flag kirim TIDAK diberikan", () => {
  // Izin yang tidak dibutuhkan adalah izin yang suatu hari akan terpakai karena
  // alasan yang salah.
  const a = createRunAuthority();
  a.arm({ realSend: false });
  assert.equal(a.isArmed(), true, "run tetap berwenang");
  assert.deepEqual(a.serviceArgs(), [], "tapi tanpa flag kirim chat");
});

test("arm kedua tanpa disarm DITOLAK", () => {
  // Dua arm berarti dua run yang menganggap dirinya berwenang.
  const a = createRunAuthority();
  a.arm({ realSend: true });
  const second = a.arm({ realSend: true });
  assert.equal(second.ok, false);
  assert.equal(second.reason, "run-already-armed");
});

test("disarm mencabut otoritas sepenuhnya", () => {
  const a = createRunAuthority();
  a.arm({ realSend: true });
  a.disarm("stopped");
  assert.equal(a.isArmed(), false);
  assert.deepEqual(a.serviceArgs(), []);
  assert.equal(a.current(), null);
});

test("disarm berulang aman", () => {
  const a = createRunAuthority();
  assert.equal(a.disarm().ok, true);
  assert.equal(a.disarm().ok, true);
});

test("run id BARU setiap arm", () => {
  const a = createRunAuthority();
  a.arm({ realSend: true });
  const first = a.current();
  a.disarm();
  a.arm({ realSend: true });
  assert.notEqual(a.current(), first);
});

test("describe() aman ditampilkan: tidak ada rahasia", () => {
  const a = createRunAuthority();
  a.arm({ realSend: true });
  const d = a.describe();
  assert.deepEqual(Object.keys(d).sort(), ["armed", "armedAt", "realSend", "runId"]);
});

test("nama flag hanya ada di SATU tempat", () => {
  assert.equal(REAL_SEND_FLAG, "--enable-autocomment-send");
});

// --- tidak pernah disimpan ---------------------------------------------------

test("config customer TIDAK punya field yang menyalakan kirim nyata", () => {
  // Kalau suatu saat ada yang menambahkannya, tes ini merah.
  const src = fs.readFileSync(require.resolve("../controller/config-manager.js"), "utf8");
  for (const forbidden of ["enableRealSend", "realSend", "armRealSend", "allowRealSend"]) {
    assert.ok(!src.includes(forbidden), "config-manager tidak boleh mengenal " + forbidden);
  }
  const cfg = goodConfig();
  assert.equal("realSend" in cfg.settings, false);
  assert.equal("enableRealSend" in cfg.settings, false);
});

test("TIDAK ADA variabel environment yang menyalakan kirim nyata", () => {
  // toEnv() adalah satu-satunya pembentuk environment anak.
  const { toEnv } = require("../controller/config-manager");
  const cfg = goodConfig();
  cfg.settings.autoCommentEnabled = true;
  cfg.settings.autoCommentTransport = "browser";
  const env = toEnv(cfg);

  const raw = JSON.stringify(env);
  assert.ok(!raw.includes("enable-autocomment-send"), "flag tidak boleh lewat environment");
  for (const k of Object.keys(env)) {
    assert.ok(!/REAL_SEND|ENABLE_SEND|ARM/.test(k), "variabel mencurigakan: " + k);
  }
});

test("otoritas tidak pernah ditulis ke disk", () => {
  const src = fs.readFileSync(require.resolve("../controller/run-authority.js"), "utf8");
  // Tidak ada I/O sama sekali di modul ini.
  assert.ok(!/require\(["']node:fs["']\)|writeFileSync|readFileSync/.test(src), "run-authority tidak boleh menyentuh disk");
});

// --- integrasi dengan Start/Stop --------------------------------------------

function harness(over = {}) {
  const cfg = over.config || (() => {
    const c = goodConfig();
    // AutoComment MENYALA: inilah kasus customer yang memang ingin balasan
    // terkirim, dan kasus yang DoD P4 mensyaratkan.
    //
    // Jalur kirimnya ikut disetel ke yang sungguhan. Sejak P5.1.1, config yang
    // menyalakan balasan tapi membiarkan jalur kirimnya aman adalah config yang
    // TIDAK PERNAH bisa mengirim, dan jalur start menolaknya — lihat
    // controller/automation-mode.js.
    c.settings.autoCommentEnabled = true;
    c.settings.autoCommentTransport = "browser";
    c.mappings = [
      { scene: "PAX-1", product: { title: "O'CORN Sea Salt" }, triggers: ["etalase satu"], reply: "Etalase 1 sudah aku pin ya kak" },
    ];
    return c;
  })();

  return createHarness(
    Object.assign(
      {
        config: cfg,
        playableScenes: ["PAX-1", "PAX-2", "PAX-3"],
        obsDiscovery: { listScenes: async () => ({ ok: true, connected: true, scenes: SCENES }) },
        tiktokDiscovery: {
          products: async () => ({ ok: true, count: 1, products: CATALOGUE, livePinControlsAvailable: true }),
          status: async () => ({ ok: true, identity: "toko uji", identityOk: true, live: true, dashboardReady: true, chatReady: null, productCount: 1 }),
        },
      },
      over
    )
  );
}

test("Controller baru: UNARMED", () => {
  const h = harness();
  assert.equal(h.controller.runAuthority.isArmed(), false);
  assert.equal(h.controller.status().run.armed, false);
});

test("Start yang LOLOS preflight memberi service flag kirim nyata TEPAT SATU KALI", async () => {
  const h = harness();
  const r = await h.controller.startAutomation();
  assert.equal(r.ok, true, JSON.stringify(r.error || {}));

  const svc = h.world.liveByScript("autopin-service.js")[0];
  const args = svc.spawnArgs.slice(1); // argv[0] = path skrip
  const count = args.filter((a) => a === REAL_SEND_FLAG).length;
  assert.equal(count, 1, "tepat satu, bukan nol dan bukan dua: " + JSON.stringify(args));
});

test("BOT tidak pernah menerima flag kirim", async () => {
  // Bot tidak mengirim chat; ia memintanya ke service. Memberinya flag itu tidak
  // menambah kemampuan apa pun, hanya memperluas permukaan izin.
  const h = harness();
  await h.controller.startAutomation();
  const bot = h.world.liveByScript("index.js")[0];
  assert.ok(!bot.spawnArgs.includes(REAL_SEND_FLAG));
  assert.deepEqual(bot.spawnArgs.slice(1), []);
});

test("AutoComment MATI: service tidak diberi flag, tapi run tetap berwenang", async () => {
  const cfg = goodConfig();
  cfg.settings.autoCommentEnabled = false;
  cfg.mappings = [{ scene: "PAX-1", product: { title: "O'CORN Sea Salt" }, triggers: ["etalase satu"] }];
  const h = harness({ config: cfg });

  const r = await h.controller.startAutomation();
  assert.equal(r.ok, true, JSON.stringify(r.error || {}));

  const svc = h.world.liveByScript("autopin-service.js")[0];
  assert.ok(!svc.spawnArgs.includes(REAL_SEND_FLAG), "tanpa AutoComment, tanpa izin kirim");
  assert.equal(h.controller.status().run.armed, true);
  assert.equal(h.controller.status().run.realSend, false);
});

test("preflight GAGAL: TIDAK ada arming, dan nol proses", async () => {
  const h = harness({
    obsDiscovery: { listScenes: async () => ({ ok: false, connected: false, reason: "obs-unavailable" }) },
  });

  const r = await h.controller.startAutomation();
  assert.equal(r.ok, false);
  assert.equal(h.controller.runAuthority.isArmed(), false, "preflight merah tidak boleh memberi izin");
  assert.equal(h.world.spawned.length, 0);
  assert.equal(h.controller.status().run.armed, false);
});

test("pemetaan tidak valid: tidak ada arming", async () => {
  const cfg = goodConfig();
  cfg.settings.autoCommentEnabled = true;
  cfg.settings.autoCommentTransport = "browser";
  cfg.mappings = [{ scene: "PAX-1", product: { title: "Produk Hantu" }, triggers: ["etalase satu"], reply: "x" }];
  const h = harness({ config: cfg });

  const r = await h.controller.startAutomation();
  assert.equal(r.ok, false);
  assert.equal(h.controller.runAuthority.isArmed(), false);
  assert.equal(h.world.spawned.length, 0);
});

test("STOP mencabut otoritas", async () => {
  const h = harness();
  await h.controller.startAutomation();
  assert.equal(h.controller.runAuthority.isArmed(), true);

  await h.controller.stopAutomation();
  assert.equal(h.controller.runAuthority.isArmed(), false);
  assert.equal(h.controller.status().run.armed, false);
  assert.equal(h.controller.status().run.runId, null);
});

test("Start KEDUA sesudah Stop membuat otoritas BARU, bukan memakai yang lama", async () => {
  const h = harness();
  await h.controller.startAutomation();
  const first = h.controller.status().run.runId;
  await h.controller.stopAutomation();
  await h.controller.startAutomation();
  const second = h.controller.status().run.runId;

  assert.ok(first && second);
  assert.notEqual(second, first);
});

test("start yang GAGAL separuh jalan mencabut otoritas", async () => {
  // Bot tidak pernah siap -> rollback. Izin tidak boleh hidup lebih lama dari
  // percobaan run yang gagal.
  const h = harness({ autoBotConnected: false });
  const r = await h.controller.startAutomation();

  assert.equal(r.ok, false);
  assert.equal(h.controller.runAuthority.isArmed(), false);
  assert.equal(h.world.liveCount(), 0);
});

test("crash kedua anak tidak meninggalkan otoritas saat di-stop", async () => {
  const h = harness();
  await h.controller.startAutomation();
  h.world.byScript("autopin-service.js")[0].exit(1, null);
  h.world.byScript("index.js")[0].exit(1, null);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.controller.state(), STATES.ERROR);

  await h.controller.stopAutomation();
  assert.equal(h.controller.runAuthority.isArmed(), false);
});

test("shutdown Controller mencabut otoritas", async () => {
  const h = harness();
  await h.controller.startAutomation();
  await h.controller.shutdown();
  assert.equal(h.controller.runAuthority.isArmed(), false);
});

test("Controller BARU (restart) mulai UNARMED walau run sebelumnya bersenjata", async () => {
  const h1 = harness();
  await h1.controller.startAutomation();
  assert.equal(h1.controller.runAuthority.isArmed(), true);

  // Controller baru di atas config yang SAMA, termasuk berkas config yang sama.
  const h2 = harness();
  assert.equal(h2.controller.runAuthority.isArmed(), false, "izin tidak boleh bertahan lewat restart");
  assert.deepEqual(h2.controller.runAuthority.serviceArgs(), []);
});

test("argumen operator dari baris perintah tetap diteruskan, dan tidak ganda", async () => {
  // Operator yang menjalankan Controller dengan flag secara manual tetap bisa;
  // yang penting flag-nya tidak muncul dua kali.
  const h = harness({ serviceArgs: ["--click-strategy=dom"] });
  await h.controller.startAutomation();
  const args = h.world.liveByScript("autopin-service.js")[0].spawnArgs.slice(1);
  assert.deepEqual(args, ["--click-strategy=dom", REAL_SEND_FLAG]);
  assert.equal(args.filter((a) => a === REAL_SEND_FLAG).length, 1);
});

test("/api/status mengekspos metadata run tanpa rahasia", async () => {
  const h = harness();
  await h.controller.startAutomation();
  const st = h.controller.status();

  assert.equal(st.run.armed, true);
  assert.equal(st.run.realSend, true);
  assert.equal(typeof st.run.runId, "string");
  const raw = JSON.stringify(st);
  assert.ok(!raw.includes("enable-autocomment-send"), "nama flag internal tidak perlu tampil di status");
  assert.ok(!raw.includes("rahasia-obs"));
});

test("artefak config runtime tidak memuat izin apa pun", () => {
  const { buildRuntimeConfig } = require("../runtime/runtime-config");
  const a = buildRuntimeConfig({ mappings: goodConfig().mappings, configVersion: 1 });
  const raw = JSON.stringify(a);
  assert.ok(!raw.includes("enable-autocomment-send"));
  assert.ok(!/realSend|armed|runId/.test(raw));
});
