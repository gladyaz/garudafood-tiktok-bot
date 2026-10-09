// Dua saklar aksi nyata di Settings, dan gerbang START yang mengikutinya.
//
// ---------------------------------------------------------------------------
// KEJADIAN YANG MELAHIRKAN BERKAS INI
//
// Validasi LIVE 2026-10-08, aplikasi TERPASANG. Semua indikator hijau, scene
// berganti dengan benar, dan NOL produk ter-pin. Sebabnya: ketiga field aksi
// nyata (autopinEnabled, autoCommentEnabled, autoCommentTransport) TIDAK ADA di
// halaman sama sekali. `SETTINGS_FIELDS` hanya memuat empat field teks, dan
// ketiga nama itu muncul NOL kali di index.html.
//
// Jadi customer yang setup sepenuhnya lewat UI tidak punya cara apa pun
// menyalakan AutoPIN — aplikasi terpasang hanya bisa mengganti scene. Dan START
// BOT tetap hijau, karena tidak ada satu pun pemeriksaan yang melihat mode.
//
// Yang diuji di sini: saklarnya ADA, ia menulis ketiga field dengan benar, dan
// START MATI kalau modenya tidak bisa melakukan yang diminta.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const U = require("../controller/public/ui-logic.js");
const { validateConfig, defaultConfig, redactConfig } = require("../controller/config-manager");
const { describeMode } = require("../controller/automation-mode");

const PUBLIC_DIR = path.resolve(__dirname, "..", "controller", "public");

// Formulir yang semua field TEKS-nya sah, supaya yang tersisa hanya saklar.
function filledForm(over) {
  return Object.assign(
    {
      tiktokUsername: "akun_tes",
      expectedShop: "Toko Uji",
      obsHost: "127.0.0.1",
      obsPort: "4455",
      obsPassword: "",
      obsPasswordClear: false,
      autoPinProduct: false,
      sendAdminReply: false,
    },
    over || {}
  );
}

// --- saklar -> config -------------------------------------------------------

test("saklar MATI menulis config yang aman", () => {
  const out = U.applySettingsToConfig(redactConfig(defaultConfig()), filledForm());
  assert.equal(out.settings.autopinEnabled, false);
  assert.equal(out.settings.autoCommentEnabled, false);
  assert.equal(out.settings.autoCommentTransport, "dry-run");
});

test("Auto pin ON menyalakan autopinEnabled, dan TIDAK menyentuh balasan", () => {
  const out = U.applySettingsToConfig(redactConfig(defaultConfig()), filledForm({ autoPinProduct: true }));
  assert.equal(out.settings.autopinEnabled, true);
  assert.equal(out.settings.autoCommentEnabled, false);
  assert.equal(out.settings.autoCommentTransport, "dry-run");
});

test("balasan ON menulis KEDUA field yang dibutuhkan jalur kirim nyata", () => {
  // Inilah inti perbaikannya: customer memilih satu hal ("balas di chat"), dan
  // dua field config diurus di sini. Ia tidak pernah melihat kata "browser".
  const out = U.applySettingsToConfig(
    redactConfig(defaultConfig()),
    filledForm({ autoPinProduct: true, sendAdminReply: true })
  );
  assert.equal(out.settings.autopinEnabled, true);
  assert.equal(out.settings.autoCommentEnabled, true);
  assert.equal(out.settings.autoCommentTransport, "browser");

  // Dan modenya memang sah, jadi START tidak akan tertolak.
  out.mappings = [{ scene: "PAX-1", product: { title: "X" }, triggers: ["spill etalase 1"] }];
  assert.equal(describeMode(out).ok, true);
});

test("mematikan balasan MENGEMBALIKAN jalur kirim ke yang aman", () => {
  // Transport "browser" yang tertinggal dari pengaturan sebelumnya tidak
  // berbahaya hari ini, tapi ia membuat config membaca seolah jalur kirim nyata
  // masih menyala — dan config yang membaca salah akan dipercaya salah.
  const before = redactConfig(defaultConfig());
  before.settings.autoCommentEnabled = true;
  before.settings.autoCommentTransport = "browser";

  const out = U.applySettingsToConfig(before, filledForm({ autoPinProduct: true, sendAdminReply: false }));
  assert.equal(out.settings.autoCommentEnabled, false);
  assert.equal(out.settings.autoCommentTransport, "dry-run");
});

test("config hasil saklar tetap LOLOS validator server", () => {
  for (const over of [{}, { autoPinProduct: true }, { autoPinProduct: true, sendAdminReply: true }]) {
    const out = U.applySettingsToConfig(redactConfig(defaultConfig()), filledForm(over));
    const { mergeSecrets } = require("../controller/config-manager");
    const verdict = validateConfig(mergeSecrets(out, null));
    assert.equal(verdict.ok, true, JSON.stringify(verdict.errors));
  }
});

// --- config -> saklar (perjalanan balik) ------------------------------------

test("saklar dibaca kembali dari config yang tersimpan", () => {
  const cfg = defaultConfig();
  cfg.settings.autopinEnabled = true;
  cfg.settings.autoCommentEnabled = true;
  cfg.settings.autoCommentTransport = "browser";

  const form = U.settingsToForm(redactConfig(cfg));
  assert.equal(form.autoPinProduct, true);
  assert.equal(form.sendAdminReply, true);
});

test("saklar round-trip: config -> formulir -> config tidak berubah", () => {
  const cfg = defaultConfig();
  cfg.settings.autopinEnabled = true;
  cfg.settings.autoCommentEnabled = true;
  cfg.settings.autoCommentTransport = "browser";

  const back = U.applySettingsToConfig(
    redactConfig(cfg),
    Object.assign(filledForm(), U.settingsToForm(redactConfig(cfg)))
  );
  assert.equal(back.settings.autopinEnabled, true);
  assert.equal(back.settings.autoCommentEnabled, true);
  assert.equal(back.settings.autoCommentTransport, "browser");
});

// --- validasi formulir ------------------------------------------------------

test("balasan ON tanpa pin DITOLAK saat menyimpan, dengan kalimat yang bisa ditindaklanjuti", () => {
  // Diberitahukan SAAT MENYIMPAN, bukan nanti saat START BOT mati tanpa customer
  // mengerti kenapa.
  const v = U.validateSettingsForm(filledForm({ autoPinProduct: false, sendAdminReply: true }));
  assert.equal(v.ok, false);
  assert.ok(v.fields.includes("sendAdminReply"), JSON.stringify(v.fields));
  assert.match(v.errors.sendAdminReply, /Auto pin product/);
  // Tanpa istilah teknis.
  assert.ok(!/dry-run|browser|transport/i.test(v.errors.sendAdminReply), v.errors.sendAdminReply);
});

test("kombinasi saklar yang sah TIDAK menghasilkan error formulir", () => {
  for (const over of [{}, { autoPinProduct: true }, { autoPinProduct: true, sendAdminReply: true }]) {
    const v = U.validateSettingsForm(filledForm(over));
    assert.equal(v.ok, true, JSON.stringify(v.errors));
  }
});

// --- gerbang START ----------------------------------------------------------

function viewWithMode(mode) {
  return {
    status: {
      automation: "STOPPED",
      config: { present: true },
      login: { active: false },
      mode: mode,
    },
    obs: { ok: true, connected: true, scenes: ["MAIN", "PAX-1"] },
    tiktok: { ok: true, identity: "Toko Uji", identityOk: true, live: true, productCount: 3 },
    validation: { ok: true, mappings: [{ ok: true }] },
  };
}

test("REGRESI 2026-10-08: semua kesiapan hijau TAPI AutoPIN mati => START MATI", () => {
  // Keadaan PERSIS dari run yang gagal: OBS tersambung, TikTok tersambung, LIVE
  // on air, produk terdeteksi, pemetaan sah — dan AutoPIN mati. Sebelum P5.1.1
  // tombolnya hijau dan run berjalan tanpa memin apa pun.
  const view = viewWithMode({
    ok: false,
    reason: "autopin-disabled",
    userMessage: "Auto pin product is turned off.",
    pin: false,
    reply: false,
    needsPin: true,
  });

  const c = U.controlsFor(view);
  assert.equal(c.startEnabled, false, "START BOT HARUS mati");
  assert.equal(c.startReason, "Auto pin product is turned off.");

  const blocker = U.startBlockers(view).find((b) => b.key === "mode");
  assert.ok(blocker, JSON.stringify(U.startBlockers(view).map((b) => b.key)));
  assert.equal(blocker.message, "Auto pin product is turned off.");
});

test("kalimat penghalang datang dari SERVER, bukan dikarang halaman", () => {
  // Kalau halaman mengarang kalimatnya sendiri, ia akan menyimpang dari alasan
  // server menolak — dan yang menyimpang akan menjadi tombol hijau untuk run
  // yang tidak bisa memin apa pun.
  const view = viewWithMode({ ok: false, reason: "admin-reply-not-enabled", userMessage: "Admin reply is not enabled." });
  const blocker = U.startBlockers(view).find((b) => b.key === "mode");
  assert.equal(blocker.message, "Admin reply is not enabled.");
});

test("mode SAH tidak memblokir apa pun", () => {
  const view = viewWithMode({ ok: true, reason: null, userMessage: null, pin: true, reply: true, needsPin: true });
  assert.equal(U.controlsFor(view).startEnabled, true);
  assert.equal(U.startBlockers(view).length, 0);
});

test("FAIL-CLOSED: mode yang BELUM DIKETAHUI tetap memblokir", () => {
  // Config sudah ada tapi server tidak mengirim verdict mode. Itu keadaan tidak
  // jelas, dan tombol Start yang hidup saat keadaan tidak jelas adalah tombol
  // yang bisa menyalakan sesuatu di akun sungguhan atas dasar tebakan.
  const view = viewWithMode(undefined);
  const c = U.controlsFor(view);
  assert.equal(c.startEnabled, false);
  const blocker = U.startBlockers(view).find((b) => b.key === "mode");
  assert.ok(blocker);
  assert.match(blocker.message, /Checking/);
});

test("tanpa config, penghalang mode TIDAK menambah kebisingan", () => {
  // First-run sudah punya pesannya sendiri ("Save your settings first."); menambah
  // "Checking automation mode…" di situ hanya mengaburkan pekerjaan pertama.
  const view = viewWithMode(undefined);
  view.status.config = { present: false };
  const keys = U.startBlockers(view).map((b) => b.key);
  assert.ok(keys.includes("config"));
  assert.ok(!keys.includes("mode"), JSON.stringify(keys));
});

// --- halaman ----------------------------------------------------------------

test("halaman PUNYA kedua saklar, dan app.js memakainya", () => {
  // Inilah yang hilang sampai 2026-10-08.
  const html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
  const app = fs.readFileSync(path.join(PUBLIC_DIR, "app.js"), "utf8");

  for (const id of ["set-auto-pin", "set-admin-reply", "err-autoPinProduct", "err-sendAdminReply"]) {
    assert.ok(html.includes('id="' + id + '"'), "index.html harus punya " + id);
    assert.ok(app.includes('"' + id + '"'), "app.js harus memakai " + id);
  }
  // Keduanya checkbox: dibaca lewat .checked, bukan .value. Sebuah checkbox
  // punya value "on" walau tidak dicentang, jadi membacanya seperti field teks
  // akan selalu berbunyi menyala.
  assert.match(html, /id="set-auto-pin"[^>]*type="checkbox"/);
  assert.match(html, /id="set-admin-reply"[^>]*type="checkbox"/);
  // Pembacaannya ada di ui-logic.js, bukan app.js: di situlah ia bisa diuji
  // dengan node palsu.
  const ui = fs.readFileSync(path.join(PUBLIC_DIR, "ui-logic.js"), "utf8");
  assert.match(ui, /\.checked === true/, "ui-logic harus membaca .checked");
});

test("halaman TIDAK PERNAH menyebut istilah teknis aksi nyata", () => {
  // Customer memutuskan "pin produknya" dan "balas di chat". Bahwa itu berarti
  // autoCommentTransport=browser adalah urusan ui-logic.js.
  const html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
  const visible = html.replace(/<!--[\s\S]*?-->/g, "");
  for (const term of ["dry-run", "autoCommentTransport", "autopinEnabled", "autoCommentEnabled", "transport"]) {
    assert.ok(!visible.includes(term), "halaman tidak boleh menyebut " + term);
  }
  // Dan yang DILIHAT customer memakai bahasanya sendiri.
  assert.match(visible, /Auto pin product/);
  assert.match(visible, /Send admin reply after pin/);
});

test("saklar dimatikan saat automation berjalan, sama seperti field lain", () => {
  // Mengubah mode di tengah run tidak akan berlaku (snapshot runtime sudah
  // dibuat), jadi membiarkannya bisa diklik hanya menjanjikan sesuatu yang tidak
  // terjadi.
  const app = fs.readFileSync(path.join(PUBLIC_DIR, "app.js"), "utf8");
  const block = app.slice(app.indexOf("SETTINGS_TOGGLES.forEach(function (pair) {\n      var node = el[pair[1]];"));
  assert.match(block.slice(0, 400), /node\.disabled = !sv\.editable/);
});

// ---------------------------------------------------------------------------
// REGRESI: keadaan PERSIS dari layar yang dilaporkan (2026-10-08)
// ---------------------------------------------------------------------------

test("REGRESI screenshot: STOPPED + LIVE aktif + produk + mapping siap, discovery jalan => KEDUA checkbox bisa dicentang", () => {
  // Keadaan yang dilaporkan dari aplikasi TERPASANG: automation STOPPED, LIVE
  // aktif, produk terdeteksi, pemetaan siap — dan seluruh Settings mati,
  // termasuk "Auto pin product" dan "Send admin reply after pin".
  //
  // Dua cacat bertumpuk di situ:
  //
  //   1. `editingEnabled = !busy && (...)` dengan `busy` GLOBAL. Refresh
  //      menjalankan discovery TikTok (membuka Chrome, 6-12 detik), dan selama
  //      itu seluruh Settings terkunci tanpa alasan.
  //
  //   2. Terkuncinya LATCH. renderSettings() menulis disabled=true dari dalam
  //      jendela busy (renderAll dipanggil DI DALAM withBusy), dan polling tidak
  //      pernah memanggil renderSettings lagi — hanya renderControls,
  //      renderReadiness, renderActivity. Jadi checkbox mati PERMANEN.
  //
  // Cacat (2) diperbaiki secara struktural: renderSettingsEnabled() dipanggil
  // dari renderControls(), jadi ia ikut setiap polling. Diuji di bawah.
  const refreshing = {
    busy: true,
    busyOp: "refresh",
    status: {
      automation: "STOPPED",
      config: { present: true },
      login: { active: false, state: "idle" },
      run: { armed: false },
      mode: { ok: false, reason: "autopin-disabled", userMessage: "Auto pin product is turned off.", pin: false, reply: false, needsPin: true },
    },
    obs: { ok: true, connected: true, scenes: ["MAIN", "PAX-1", "PAX-2"] },
    tiktok: { ok: true, identity: "agen_mulia_abadi", identityOk: true, live: true, productCount: 10 },
    validation: { ok: true, mappings: [{ ok: true }] },
  };

  const sv = U.settingsView(refreshing);
  assert.equal(sv.editable, true, "KEDUA checkbox harus bisa dicentang saat discovery berjalan");
  assert.equal(sv.hint, "", "dan tidak ada kalimat yang menyuruh menghentikan automation");

  // Discovery SELESAI: tetap bisa disunting.
  const done = Object.assign({}, refreshing, { busy: false, busyOp: null });
  assert.equal(U.settingsView(done).editable, true);
  assert.equal(U.settingsView(done).hint, "");

  // Dan START tetap mati — tapi karena MODE-nya, bukan karena busy.
  assert.equal(U.controlsFor(done).startEnabled, false);
  assert.equal(U.controlsFor(done).startReason, "Auto pin product is turned off.");
});

test("REGRESI: keadaan terkunci Settings disegarkan setiap polling, jadi tidak bisa LATCH", () => {
  // Inilah cacat (2). Yang MENULIS disabled=true harus juga yang
  // MENULISKANNYA KEMBALI, pada irama yang sama.
  const app = fs.readFileSync(path.join(PUBLIC_DIR, "app.js"), "utf8");

  // renderControls dipanggil setiap polling; ia HARUS menyegarkan Settings.
  const rc = app.slice(app.indexOf("function renderControls()"));
  assert.match(rc.slice(0, 400), /renderSettingsEnabled\(\)/, "renderControls harus memanggil renderSettingsEnabled");

  // Dan polling memang memanggil renderControls.
  const poll = app.slice(app.indexOf("function startPolling()"));
  assert.match(poll.slice(0, 500), /renderControls\(\)/);

  // renderSettingsEnabled TIDAK boleh menulis nilai apa pun: `state.settings`
  // hanya disegarkan dari server, jadi menulis nilai setiap 2 detik akan
  // MENGHAPUS centang customer sebelum ia menekan Save.
  const rse = app.slice(app.indexOf("function renderSettingsEnabled()"));
  const body = rse.slice(0, rse.indexOf("\n  }"));
  assert.ok(!/\.checked =/.test(body), "tidak boleh menulis .checked");
  assert.ok(!/\.value =/.test(body), "tidak boleh menulis .value");
  assert.match(body, /\.disabled = !sv\.editable/);
});

test("setiap withBusy menyebut NAMA operasinya", () => {
  // Kalau satu pemanggil lupa, ia kembali memakai perilaku global dan bug ini
  // bisa kembali lewat jalur itu. Posisinya juga penting: op adalah argumen
  // KEEMPAT, jadi pemanggil tanpa target harus menyebut null secara eksplisit —
  // kalau tidak, nama op mendarat di slot target dan busyOp tetap null.
  const app = fs.readFileSync(path.join(PUBLIC_DIR, "app.js"), "utf8");
  const closings = app.match(/^\s*\}, (?:null|"[a-z-]+"), "[a-zA-Z]+"\);$/gm) || [];
  const callers = (app.match(/withBusy\(/g) || []).length - 1; // minus definisinya
  assert.equal(closings.length, callers, "semua " + callers + " pemanggil harus menyebut op, dapat " + closings.length);

  // Dan nama-namanya yang dipakai ui-logic memang ada.
  for (const op of U.CONFIG_WRITE_OPS) {
    assert.ok(app.includes('"' + op + '"'), "app.js harus memakai op " + op);
  }
});
