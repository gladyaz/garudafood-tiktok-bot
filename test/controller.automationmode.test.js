// Mode aksi nyata: apakah config MENYATAKAN run yang bisa melakukan apa yang
// customer harapkan. OFFLINE sepenuhnya.
//
// ---------------------------------------------------------------------------
// KEJADIAN YANG MELAHIRKAN BERKAS INI
//
// Validasi LIVE 2026-10-08, aplikasi TERPASANG. OBS tersambung, TikTok
// tersambung, LIVE on air, 10 produk terdeteksi, 5 pemetaan siap, SELURUH
// preflight hijau, START BOT menyala, automation RUNNING, scene berganti dengan
// benar — dan NOL produk ter-pin, NOL chat admin terkirim.
//
// Runtime snapshot run itu (runId=a583305a15967991):
//   autopinEnabled=false  autoCommentEnabled=false  autoCommentTransport=dry-run
//
// Jejak mentahnya tidak memuat SATU PUN [AUTOPIN_REQUEST].
//
// Jadi yang diuji di sini bukan AutoPIN. Yang diuji: sistem TIDAK BOLEH lagi
// mengizinkan run yang tidak bisa melakukan apa pun, sementara semua indikator
// di layar hijau.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { describeMode, mappingsNeedPin, BLOCKER } = require("../controller/automation-mode");
const { CATALOG } = require("../controller/errors");

// Config seperti yang BENAR-BENAR dipakai run 2026-10-08: pemetaan punya
// produk, tapi ketiga flag aksi nyata mati.
function configFromFailedRun(over) {
  return Object.assign(
    {
      version: 1,
      tiktok: { username: "agen_tes" },
      obs: { host: "127.0.0.1", port: 4455, password: "" },
      settings: Object.assign(
        {
          autopinEnabled: false,
          autoCommentEnabled: false,
          autoCommentTransport: "dry-run",
        },
        (over && over.settings) || {}
      ),
      mappings: (over && over.mappings) || [
        { scene: "PAX-1", product: { title: "Kacang telur garuda / 220g" }, triggers: ["spill etalase 1"] },
      ],
    },
    {}
  );
}

// --- REGRESI dari run yang sungguhan ----------------------------------------

test("REGRESI 2026-10-08: pemetaan butuh pin tapi AutoPIN mati -> START DITOLAK", () => {
  const m = describeMode(configFromFailedRun());
  assert.equal(m.ok, false, "run ini tidak boleh pernah bisa dimulai lagi");
  assert.equal(m.reason, BLOCKER.PIN_OFF);
  assert.equal(m.needsPin, true);
  assert.equal(m.pin, false);
  assert.equal(m.reply, false);
});

test("kalimatnya SEDERHANA dan tanpa istilah teknis", () => {
  // Customer tidak pernah boleh melihat "dry-run" atau "browser".
  for (const code of Object.values(BLOCKER)) {
    const sentence = CATALOG[code];
    assert.ok(sentence, "kode " + code + " harus punya kalimat");
    assert.ok(!/dry-run|browser|transport|autoComment|autopinEnabled/i.test(sentence), code + ": " + sentence);
    assert.match(sentence, /^[A-Z]/, "kalimat untuk customer: " + sentence);
  }
  assert.equal(CATALOG[BLOCKER.PIN_OFF], "Auto pin product is turned off.");
  assert.equal(CATALOG[BLOCKER.REPLY_NOT_ENABLED], "Admin reply is not enabled.");
});

// --- mode yang SAH ----------------------------------------------------------

test("pin ON + balasan OFF = mode pin-only, SAH", () => {
  const m = describeMode(configFromFailedRun({ settings: { autopinEnabled: true } }));
  assert.equal(m.ok, true, JSON.stringify(m.blockers));
  assert.equal(m.pin, true);
  assert.equal(m.reply, false);
});

test("pin ON + balasan ON + jalur kirim nyata = mode penuh, SAH", () => {
  const m = describeMode(
    configFromFailedRun({
      settings: { autopinEnabled: true, autoCommentEnabled: true, autoCommentTransport: "browser" },
    })
  );
  assert.equal(m.ok, true, JSON.stringify(m.blockers));
  assert.equal(m.pin, true);
  assert.equal(m.reply, true);
});

// --- mode yang TIDAK SAH ----------------------------------------------------

test("balasan ON tapi pin OFF = TIDAK SAH, karena balasan hanya sesudah pin", () => {
  // Ini bukan kerapian: seluruh dasar AR3 adalah bahwa chat dikirim HANYA
  // sesudah pin terkonfirmasi. Balasan tanpa pin menjanjikan sesuatu yang tidak
  // pernah bisa terjadi.
  const m = describeMode(
    configFromFailedRun({
      settings: { autopinEnabled: false, autoCommentEnabled: true, autoCommentTransport: "browser" },
    })
  );
  assert.equal(m.ok, false);
  assert.ok(m.blockers.includes(BLOCKER.REPLY_WITHOUT_PIN), JSON.stringify(m.blockers));
});

test("balasan ON tapi jalur kirim masih aman = TIDAK SAH", () => {
  // UI sekarang selalu menulis keduanya bersamaan, tapi UI bukan batas keamanan:
  // config bisa datang dari berkas yang disunting tangan.
  const m = describeMode(
    configFromFailedRun({
      settings: { autopinEnabled: true, autoCommentEnabled: true, autoCommentTransport: "dry-run" },
    })
  );
  assert.equal(m.ok, false);
  assert.equal(m.reason, BLOCKER.REPLY_NOT_ENABLED);
});

// --- pemetaan yang TIDAK butuh pin ------------------------------------------

test("pemetaan tanpa produk TIDAK memaksa AutoPIN menyala", () => {
  // `product: null` itu SAH dan sengaja: scene yang punya trigger tapi bukan
  // etalase (mis. scene FAQ). Memaksa pin menyala akan menolak setup yang benar.
  const m = describeMode(
    configFromFailedRun({
      mappings: [{ scene: "AI LIVE_FAQ_CO", product: null, triggers: ["cara checkout"] }],
    })
  );
  assert.equal(m.needsPin, false);
  assert.equal(m.ok, true, JSON.stringify(m.blockers));
});

test("judul produk kosong/spasi tidak dihitung sebagai butuh pin", () => {
  assert.equal(mappingsNeedPin({ mappings: [{ scene: "PAX-1", product: { title: "   " } }] }), false);
  assert.equal(mappingsNeedPin({ mappings: [{ scene: "PAX-1", product: {} }] }), false);
  assert.equal(mappingsNeedPin({ mappings: [] }), false);
  assert.equal(mappingsNeedPin({}), false);
  assert.equal(mappingsNeedPin({ mappings: [{ scene: "PAX-1", product: { title: "X" } }] }), true);
});

test("satu pemetaan berproduk di antara banyak yang tidak sudah cukup", () => {
  const m = describeMode(
    configFromFailedRun({
      mappings: [
        { scene: "AI LIVE_FAQ_CO", product: null, triggers: ["a"] },
        { scene: "PAX-3", product: { title: "Kacang ATOM" }, triggers: ["b"] },
      ],
    })
  );
  assert.equal(m.needsPin, true);
  assert.equal(m.ok, false);
  assert.equal(m.reason, BLOCKER.PIN_OFF);
});

// --- fail-closed terhadap bentuk yang rusak ---------------------------------

test("config kosong/rusak tidak pernah dilaporkan sebagai mode menyala", () => {
  for (const bad of [null, undefined, {}, { settings: null }, { settings: {} }]) {
    const m = describeMode(bad);
    assert.equal(m.pin, false, JSON.stringify(bad));
    assert.equal(m.reply, false, JSON.stringify(bad));
  }
});

test("nilai yang bukan boolean TIDAK dianggap menyala", () => {
  // "true", 1, dan "on" semuanya truthy di JavaScript. Kalau salah satu lolos,
  // sebuah config yang disunting tangan bisa menyalakan aksi nyata tanpa pernah
  // melewati validator.
  for (const v of ["true", 1, "on", {}, []]) {
    const m = describeMode({ settings: { autopinEnabled: v, autoCommentEnabled: v }, mappings: [] });
    assert.equal(m.pin, false, "autopinEnabled=" + JSON.stringify(v));
    assert.equal(m.reply, false, "autoCommentEnabled=" + JSON.stringify(v));
  }
});

// ---------------------------------------------------------------------------
// GERBANG SERVER: tombol UI bukan batas keamanan
// ---------------------------------------------------------------------------

const { createHarness, goodConfig } = require("./helpers/controller-harness");

// goodConfig() sudah mode pin-only (autopinEnabled=true, balasan mati), jadi
// helper ini hanya mengubah bagian yang diuji.
function withSettings(over) {
  const c = goodConfig();
  c.settings = Object.assign({}, c.settings, over);
  return c;
}

test("START DITOLAK server-side saat AutoPIN mati, dan NOL proses dinyalakan", async () => {
  // Inilah run 2026-10-08, dijalankan ulang offline. Semua yang lain hijau:
  // preflight lolos, OBS ada, TikTok ada, pemetaan sah.
  const h = createHarness({ config: withSettings({ autopinEnabled: false }) });

  const r = await h.controller.startAutomation();

  assert.equal(r.ok, false);
  assert.equal(r.error.code, "autopin-disabled");
  assert.equal(r.state, "STOPPED", "kembali ke STOPPED, bukan menggantung di PREFLIGHT");

  // Yang paling penting: tidak ada yang pernah menyala.
  assert.equal(h.world.alive.size, 0, "nol proses anak");
  const st = h.controller.status();
  assert.equal(st.bot.running, false);
  assert.equal(st.service.running, false);
  assert.equal(st.run.armed, false, "tidak pernah bersenjata");
  assert.equal(st.profile.owner, "none", "profil Chrome tidak pernah diambil");
});

test("penolakan terjadi SEBELUM preflight, jadi tidak ada yang perlu dibereskan", async () => {
  const h = createHarness({ config: withSettings({ autopinEnabled: false }) });
  await h.controller.startAutomation();
  // Penyapu yatim dijalankan SESUDAH preflight di jalur normal. Kalau ia
  // terpanggil, berarti gerbang mode diletakkan terlalu jauh ke bawah.
  assert.deepEqual(h.sweeps, [], "cleanup tidak dijalankan karena belum ada apa pun");
  assert.deepEqual(h.chromeKills, []);
});

test("alasannya dicatat dengan saklar yang terbaca, bukan hanya kode", async () => {
  const h = createHarness({ config: withSettings({ autopinEnabled: false }) });
  await h.controller.startAutomation();
  const refused = h.logs.find((l) => l.includes("START_REFUSED") && l.includes("autopin-disabled"));
  assert.ok(refused, h.logs.join("\n"));
  assert.match(refused, /pin=false/);
});

test("balasan ON tanpa pin: DITOLAK server-side", async () => {
  const h = createHarness({
    config: withSettings({ autopinEnabled: false, autoCommentEnabled: true, autoCommentTransport: "browser" }),
  });
  const r = await h.controller.startAutomation();
  assert.equal(r.ok, false);
  assert.ok(["autopin-disabled", "admin-reply-without-pin"].includes(r.error.code), r.error.code);
  assert.equal(h.world.alive.size, 0);
});

test("balasan ON dengan jalur kirim aman: DITOLAK server-side", async () => {
  const h = createHarness({
    config: withSettings({ autopinEnabled: true, autoCommentEnabled: true, autoCommentTransport: "dry-run" }),
  });
  const r = await h.controller.startAutomation();
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "admin-reply-not-enabled");
  assert.equal(h.world.alive.size, 0);
});

test("mode pin-only BOLEH start, dan bot+service menyala", async () => {
  const h = createHarness({ config: withSettings({ autopinEnabled: true, autoCommentEnabled: false }) });
  const r = await h.controller.startAutomation();
  assert.equal(r.ok, true, JSON.stringify(r.error || {}));
  const st = h.controller.status();
  assert.equal(st.automation, "RUNNING");
  assert.equal(st.bot.running, true);
  assert.equal(st.service.running, true);
  // Hak paling kecil: balasan mati, jadi izin kirim nyata TIDAK diberikan.
  assert.equal(st.run.armed, true);
  assert.equal(st.run.realSend, false, "tanpa balasan, flag kirim nyata tidak boleh ada");
  await h.controller.stopAutomation();
});

test("mode penuh BOLEH start, dan izin kirim nyata DIBERIKAN untuk run itu", async () => {
  const h = createHarness({
    config: withSettings({ autopinEnabled: true, autoCommentEnabled: true, autoCommentTransport: "browser" }),
  });
  const r = await h.controller.startAutomation();
  assert.equal(r.ok, true, JSON.stringify(r.error || {}));
  const st = h.controller.status();
  assert.equal(st.run.armed, true);
  assert.equal(st.run.realSend, true, "mode penuh: service mendapat flag kirim nyata");
  await h.controller.stopAutomation();
});

// ---------------------------------------------------------------------------
// KEAMANAN PER-RUN tetap seperti P4
// ---------------------------------------------------------------------------

test("saklar Settings TIDAK memberi izin apa pun sebelum START", () => {
  // Mode penuh tersimpan di config, tapi aplikasi yang baru dibuka tetap
  // UNARMED. Saklar hanya MENYATAKAN fitur; izin datang dari START + preflight.
  const h = createHarness({
    config: withSettings({ autopinEnabled: true, autoCommentEnabled: true, autoCommentTransport: "browser" }),
  });
  const st = h.controller.status();
  assert.equal(st.run.armed, false, "startup selalu UNARMED");
  assert.equal(st.run.realSend, false);
  assert.equal(st.automation, "STOPPED");
  assert.equal(st.mode.ok, true, "mode-nya sah, tapi itu bukan izin");
  assert.equal(st.mode.reply, true, "config MENYATAKAN balasan diinginkan");
});

test("STOP menghapus izin, dan restart tetap UNARMED", async () => {
  const cfg = withSettings({ autopinEnabled: true, autoCommentEnabled: true, autoCommentTransport: "browser" });
  const h = createHarness({ config: cfg });

  await h.controller.startAutomation();
  assert.equal(h.controller.status().run.realSend, true);

  await h.controller.stopAutomation();
  const afterStop = h.controller.status();
  assert.equal(afterStop.run.armed, false, "STOP menghapus otoritas");
  assert.equal(afterStop.run.realSend, false);
  assert.equal(afterStop.run.runId, null);

  // "Restart" = Controller baru dari config yang SAMA.
  const fresh = createHarness({ config: cfg });
  const st = fresh.controller.status();
  assert.equal(st.run.armed, false, "restart tetap UNARMED walau config mode penuh");
  assert.equal(st.run.realSend, false);
});

// ---------------------------------------------------------------------------
// status.mode: satu-satunya sumber jawaban untuk UI
// ---------------------------------------------------------------------------

test("status.mode membawa verdict DAN kalimatnya", () => {
  const h = createHarness({ config: withSettings({ autopinEnabled: false }) });
  const st = h.controller.status();
  assert.equal(st.mode.ok, false);
  assert.equal(st.mode.reason, "autopin-disabled");
  assert.equal(st.mode.userMessage, "Auto pin product is turned off.");
  assert.equal(st.mode.pin, false);
  assert.equal(st.mode.needsPin, true);
});

test("status.mode yang SAH tidak membawa kalimat", () => {
  const h = createHarness({ config: withSettings({ autopinEnabled: true }) });
  const st = h.controller.status();
  assert.equal(st.mode.ok, true);
  assert.equal(st.mode.reason, null);
  assert.equal(st.mode.userMessage, null);
});

test("tanpa config, tidak ada mode yang diklaim", () => {
  const h = createHarness({ configText: null });
  const st = h.controller.status();
  assert.equal(st.config.present, false);
  assert.equal(st.mode, undefined, "mode tidak dikarang saat config belum ada");
});
