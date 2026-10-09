// Interaksi SUNGGUHAN pada dua saklar aksi nyata: klik -> state -> render.
//
// ---------------------------------------------------------------------------
// KEJADIAN YANG MELAHIRKAN BERKAS INI
//
// Aplikasi TERPASANG, 2026-10-08. Checkbox sudah tidak disabled, tapi centangnya
// TIDAK BERTAHAN. Lalu saat "Send admin reply after pin" diklik, muncul:
//
//     Turn on Auto pin product first. The reply is only sent after a product
//     is pinned.
//
// padahal "Auto pin product" baru saja diklik. Itu bukti kuatnya: dari sudut
// pandang state aplikasi, autoPinProduct memang masih false.
//
// Urutan yang salah, di app.js:
//
//   1. customer klik       -> node.checked = true          (DOM benar)
//   2. markSettingsDirty() -> HANYA menandai dirty         (state TIDAK disalin)
//   3. validateSettingsForm(readSettingsForm())            (form DIBUANG)
//   4. renderSettings()    -> node.checked = state.settings.autoPinProduct
//                          -> false. Centang hilang seketika.
//
// Dan pada klik KEDUA, langkah 3 membaca DOM yang sudah dikembalikan ke false,
// jadi ia melaporkan ketergantungan yang tidak terpenuhi.
//
// ---------------------------------------------------------------------------
// KENAPA TES INI ADA, PADAHAL SUDAH ADA TES SAKLAR
//
// Tes sebelumnya membuktikan checkbox BISA DIEDIT (editable=true) dan bahwa
// pemetaan formulir->config benar. Tidak satu pun mensimulasikan customer
// MENGKLIK lalu memeriksa apakah pilihannya BERTAHAN. Bug urutan hanya terlihat
// dari urutan.
//
// Repo ini tidak punya jsdom, jadi pembacaan dan penulisan DOM hidup di
// controller/public/ui-logic.js (readSettingsNodes / writeSettingsNodes), dan
// harness di bawah menjalankan FUNGSI PRODUKSI yang sama atas node palsu.
// Urutan app.js sendiri dipaku oleh tes teks sumber di bagian akhir berkas ini.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const U = require("../controller/public/ui-logic.js");
const { defaultConfig, redactConfig, validateConfig, mergeSecrets } = require("../controller/config-manager");

const PUBLIC_DIR = path.resolve(__dirname, "..", "controller", "public");

// Config tersimpan yang realistis: sudah terisi, tapi kedua saklar MATI —
// persis keadaan aplikasi terpasang sebelum customer menyentuhnya.
function savedConfig(over) {
  const c = defaultConfig();
  c.tiktok.username = "akun_tes";
  c.settings.expectedShop = "Toko Uji";
  c.settings.autopinEnabled = false;
  c.settings.autoCommentEnabled = false;
  c.settings.autoCommentTransport = "dry-run";
  c.mappings = [
    {
      scene: "PAX-1",
      product: { title: "Kacang telur garuda / 220g" },
      triggers: ["spill etalase 1"],
      reply: "Etalase 1 sudah aku pin ya kak",
    },
  ];
  Object.assign(c.settings, (over && over.settings) || {});
  return c;
}

// Harness yang menjalankan urutan app.js memakai fungsi produksi.
function makeUi(config) {
  const nodes = {
    "set-tiktok-username": { value: "" },
    "set-expected-shop": { value: "" },
    "set-obs-host": { value: "" },
    "set-obs-port": { value: "" },
    "set-auto-pin": { checked: false },
    "set-admin-reply": { checked: false },
    "set-obs-password": { value: "" },
  };
  const get = (id) => nodes[id] || null;

  const state = {
    config: redactConfig(config),
    settings: U.settingsToForm(redactConfig(config)),
    settingsErrors: {},
    settingsDirty: false,
    changingPassword: false,
    busy: false,
    busyOp: null,
    status: {
      automation: "STOPPED",
      config: { present: true },
      login: { active: false },
      mode: { ok: true, reason: null, userMessage: null },
    },
  };

  // renderSettings(): NILAI dari state -> DOM.
  function renderSettings() {
    U.writeSettingsNodes(get, state.settings, () => false);
  }

  // markSettingsDirty(): DOM -> state, SEBELUM apa pun merender.
  function markSettingsDirty() {
    state.settings = U.readSettingsNodes(get, state.settings, state.changingPassword);
    state.settingsDirty = true;
  }

  // Handler "change" pada checkbox, urutan sama dengan app.js.
  function clickToggle(id) {
    nodes[id].checked = !nodes[id].checked; // browser mengubah DOM lebih dulu
    markSettingsDirty();
    state.settingsErrors = U.validateSettingsForm(state.settings).errors;
    renderSettings();
  }

  // Polling 2 detik: renderControls -> renderSettingsEnabled. TIDAK menulis nilai.
  function poll() {
    U.controlsFor(state);
    U.settingsView(state);
  }

  // Refresh/discovery latar: diakhiri renderAll(), yang MEMANGGIL renderSettings.
  function backgroundRefresh() {
    state.busy = true;
    state.busyOp = "refresh";
    renderSettings(); // renderAll di dalam jendela busy
    state.busy = false;
    state.busyOp = null;
  }

  // Save: payload dari nilai yang TERLIHAT, lalu state dibangun ulang dari
  // balasan server.
  function save() {
    const form = U.readSettingsNodes(get, state.settings, state.changingPassword);
    state.settings = form;
    const verdict = U.validateSettingsForm(form);
    if (!verdict.ok) return { ok: false, errors: verdict.errors };

    const payload = U.applySettingsToConfig(state.config, form);
    payload.mappings = config.mappings;
    const merged = mergeSecrets(payload, config);

    const server = validateConfig(merged);
    if (!server.ok) return { ok: false, serverErrors: server.errors };

    // Server menyimpan, lalu mengirim config terbaru kembali.
    state.config = redactConfig(merged);
    state.settings = U.settingsToForm(state.config);
    state.settingsErrors = {};
    state.settingsDirty = false;
    renderSettings();
    return { ok: true, saved: merged };
  }

  return { nodes, state, get, clickToggle, renderSettings, poll, backgroundRefresh, save };
}

// --- 1. klik Auto pin: centang BERTAHAN -------------------------------------

test("REGRESI: autoPin false -> customer klik -> checked TRUE dan TETAP true", () => {
  const ui = makeUi(savedConfig());
  ui.renderSettings();
  assert.equal(ui.nodes["set-auto-pin"].checked, false, "titik awal: mati");
  assert.equal(ui.state.settings.autoPinProduct, false);

  ui.clickToggle("set-auto-pin");

  // Inilah yang gagal sebelum perbaikan: centangnya hilang seketika.
  assert.equal(ui.nodes["set-auto-pin"].checked, true, "centang harus BERTAHAN sesudah render");
  assert.equal(ui.state.settings.autoPinProduct, true, "dan state harus ikut");
  assert.equal(ui.state.settingsDirty, true);

  // Dan tetap bertahan melewati polling.
  ui.poll();
  ui.poll();
  assert.equal(ui.nodes["set-auto-pin"].checked, true, "polling tidak boleh menghapusnya");
});

test("REGRESI: tidak ada error dependency saat HANYA Auto pin dinyalakan", () => {
  const ui = makeUi(savedConfig());
  ui.renderSettings();
  ui.clickToggle("set-auto-pin");
  assert.deepEqual(ui.state.settingsErrors, {}, JSON.stringify(ui.state.settingsErrors));
});

// --- 2. lalu klik Send admin reply ------------------------------------------

test("REGRESI: autoPin true -> klik adminReply -> KEDUANYA true, tanpa error dependency", () => {
  // Inilah gejala yang dilaporkan: "Turn on Auto pin product first" padahal
  // Auto pin baru saja diklik.
  const ui = makeUi(savedConfig());
  ui.renderSettings();

  ui.clickToggle("set-auto-pin");
  ui.clickToggle("set-admin-reply");

  assert.equal(ui.nodes["set-auto-pin"].checked, true, "Auto pin harus masih tercentang");
  assert.equal(ui.nodes["set-admin-reply"].checked, true, "dan admin reply juga");
  assert.equal(ui.state.settings.autoPinProduct, true);
  assert.equal(ui.state.settings.sendAdminReply, true);
  assert.deepEqual(
    ui.state.settingsErrors,
    {},
    "TIDAK boleh ada 'Turn on Auto pin product first': " + JSON.stringify(ui.state.settingsErrors)
  );
});

test("urutan terbalik tetap dijaga: adminReply dulu MEMANG error, lalu hilang", () => {
  const ui = makeUi(savedConfig());
  ui.renderSettings();

  ui.clickToggle("set-admin-reply");
  assert.equal(ui.nodes["set-admin-reply"].checked, true, "centangnya tetap bertahan walau error");
  assert.ok(ui.state.settingsErrors.sendAdminReply, "dependensi memang belum terpenuhi");

  ui.clickToggle("set-auto-pin");
  assert.deepEqual(ui.state.settingsErrors, {}, "error hilang begitu dependensinya terpenuhi");
  assert.equal(ui.nodes["set-auto-pin"].checked, true);
  assert.equal(ui.nodes["set-admin-reply"].checked, true);
});

// --- 3. Save -----------------------------------------------------------------

test("Save menyimpan autopinEnabled=true, autoCommentEnabled=true, transport=browser", () => {
  const ui = makeUi(savedConfig());
  ui.renderSettings();
  ui.clickToggle("set-auto-pin");
  ui.clickToggle("set-admin-reply");

  const r = ui.save();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.saved.settings.autopinEnabled, true);
  assert.equal(r.saved.settings.autoCommentEnabled, true);
  assert.equal(r.saved.settings.autoCommentTransport, "browser");

  // Sesudah save, keduanya masih tercentang dan tidak lagi dirty.
  assert.equal(ui.nodes["set-auto-pin"].checked, true);
  assert.equal(ui.nodes["set-admin-reply"].checked, true);
  assert.equal(ui.state.settingsDirty, false);
});

test("Save membaca nilai yang TERLIHAT, bukan config lama", () => {
  // Kalau Save membaca state lama, ia akan menyimpan false/false/dry-run —
  // yaitu run 2026-10-08 yang scene-nya jalan tapi nol pin.
  const ui = makeUi(savedConfig());
  ui.renderSettings();
  ui.clickToggle("set-auto-pin");

  const r = ui.save();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.saved.settings.autopinEnabled, true);
  assert.equal(r.saved.settings.autoCommentEnabled, false, "balasan tidak diklik, jadi tetap mati");
  assert.equal(r.saved.settings.autoCommentTransport, "dry-run");
});

// --- 4. reload ---------------------------------------------------------------

test("reload UI: kedua checkbox tetap tercentang dari config TERSIMPAN", () => {
  const ui = makeUi(savedConfig());
  ui.renderSettings();
  ui.clickToggle("set-auto-pin");
  ui.clickToggle("set-admin-reply");
  const r = ui.save();
  assert.equal(r.ok, true);

  // Halaman dibuka lagi dari nol, dari config yang tersimpan.
  const fresh = makeUi(r.saved);
  fresh.renderSettings();
  assert.equal(fresh.nodes["set-auto-pin"].checked, true, "harus tercentang sesudah reload");
  assert.equal(fresh.nodes["set-admin-reply"].checked, true);
  assert.equal(fresh.state.settingsDirty, false);
  assert.deepEqual(fresh.state.settingsErrors, {});
});

// --- 5. pekerjaan latar tidak menghapus suntingan yang belum disimpan -------

test("REGRESI: refresh/discovery latar TIDAK menghapus centang yang belum disimpan", () => {
  // renderAll() dipanggil DI DALAM jendela busy onRefresh, dan ia memanggil
  // renderSettings(). Kalau state.settings belum disinkronkan dari DOM, render
  // itu akan menuliskan kembali nilai server yang lama.
  const ui = makeUi(savedConfig());
  ui.renderSettings();
  ui.clickToggle("set-auto-pin");
  ui.clickToggle("set-admin-reply");

  ui.backgroundRefresh();

  assert.equal(ui.nodes["set-auto-pin"].checked, true, "refresh latar tidak boleh menghapus centang");
  assert.equal(ui.nodes["set-admin-reply"].checked, true);
  assert.equal(ui.state.settingsDirty, true, "dan masih ditandai belum disimpan");
});

test("REGRESI: polling berulang tidak menghapus centang yang belum disimpan", () => {
  const ui = makeUi(savedConfig());
  ui.renderSettings();
  ui.clickToggle("set-auto-pin");
  for (let i = 0; i < 10; i += 1) ui.poll();
  assert.equal(ui.nodes["set-auto-pin"].checked, true);
  assert.equal(ui.state.settings.autoPinProduct, true);
});

// --- 6. urutan di app.js DIPAKU --------------------------------------------

test("app.js: state disinkronkan dari DOM SEBELUM render apa pun", () => {
  // Harness di atas meniru urutan app.js. Tes ini yang memaku urutan itu di
  // produksi — tanpa ini, harness bisa tetap hijau sementara app.js berubah.
  const app = fs.readFileSync(path.join(PUBLIC_DIR, "app.js"), "utf8");

  // markSettingsDirty MENYALIN DOM -> state.
  const dirty = app.slice(app.indexOf("function markSettingsDirty()"));
  const dirtyBody = dirty.slice(0, dirty.indexOf("\n  }"));
  assert.match(dirtyBody, /state\.settings = readSettingsForm\(\)/, "harus menyalin DOM ke state");

  // Handler saklar: markSettingsDirty dulu, baru validasi, baru render.
  //
  // Anchor-nya harus UNIK. Dua pola yang kelihatannya jelas ternyata bukan:
  //
  //   SETTINGS_TOGGLES.forEach  muncul juga di renderSettingsEnabled(), yang
  //                             didefinisikan LEBIH AWAL
  //   addEventListener("change" muncul lebih dulu di handler select scene
  //                             pada Mapping
  //
  // Jadi yang dicari adalah blok SETTINGS_TOGGLES.forEach yang BENAR-BENAR
  // memasang listener. Tes yang memotong blok salah akan hijau karena alasan
  // yang salah, dan itu lebih buruk daripada tes yang merah.
  const needle = "SETTINGS_TOGGLES.forEach(function (pair) {";
  let hBody = null;
  for (let at = app.indexOf(needle); at !== -1; at = app.indexOf(needle, at + 1)) {
    const window = app.slice(at, at + 900);
    if (window.includes("addEventListener")) {
      hBody = window;
      break;
    }
  }
  assert.ok(hBody, "blok handler saklar harus ditemukan");
  const iDirty = hBody.indexOf("markSettingsDirty()");
  const iValidate = hBody.indexOf("validateSettingsForm");
  const iRender = hBody.indexOf("renderSettings()");
  assert.ok(iDirty !== -1 && iValidate !== -1 && iRender !== -1, hBody);
  assert.ok(iDirty < iValidate, "sinkron sebelum validasi");
  assert.ok(iValidate < iRender, "validasi sebelum render");

  // Dan validasinya dari STATE, bukan dari DOM lagi.
  assert.match(hBody, /validateSettingsForm\(state\.settings\)/, "satu sumber: state");
});

test("app.js memakai fungsi baca/tulis DOM dari ui-logic, bukan salinannya", () => {
  // Kalau app.js menyimpan salinannya sendiri, harness di atas menguji fungsi
  // yang BUKAN yang dijalankan customer.
  const app = fs.readFileSync(path.join(PUBLIC_DIR, "app.js"), "utf8");
  assert.match(app, /U\.readSettingsNodes\(/);
  assert.match(app, /U\.writeSettingsNodes\(/);
  assert.match(app, /var SETTINGS_FIELDS = U\.SETTINGS_FIELD_IDS;/);
  assert.match(app, /var SETTINGS_TOGGLES = U\.SETTINGS_TOGGLE_IDS;/);

  // Dan tidak ada lagi pembacaan .checked langsung di app.js.
  const code = app
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
  assert.ok(!/\.checked\s*===/.test(code), "pembacaan .checked harus lewat ui-logic");
});
