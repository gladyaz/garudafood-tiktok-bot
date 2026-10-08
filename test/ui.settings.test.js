// First-Time Settings UI (P4.1).
//
// Customer harus bisa menjalani first-run dari keadaan BLANK tanpa terminal, tanpa
// memanggil API sendiri, dan tanpa menyunting JSON. Yang diuji di sini adalah
// jalur itu, lewat HTTP sungguhan, dengan browser dan child process palsu.
//
// Satu jaminan dijaga paling keras: PASSWORD OBS TIDAK PERNAH KEMBALI KE HALAMAN.
// Server hanya mengirim `passwordSet`. Nilai yang tidak pernah sampai ke halaman
// tidak bisa bocor dari halaman — dan itu juga berarti UI tidak perlu "menjaga"
// password apa pun saat menyimpan hal lain.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { createServer, PUBLIC_DIR } = require("../controller/server");
const { createHarness, goodConfig } = require("./helpers/controller-harness");
const { validateConfig, defaultConfig, redactConfig } = require("../controller/config-manager");
const U = require("../controller/public/ui-logic.js");

const SCENES = ["MAIN", "PAX-1", "PAX-2", "PAX-3"];
const CATALOGUE = [{ title: "O'CORN Sea Salt 80gr", number: 1, price: "Rp10.000", stock: "Stok 50", pinAvailable: true }];

function fakeBrowser({ pageUrl = "https://www.tiktok.com/login", identity = ["toko uji"] } = {}) {
  let url = pageUrl;
  let open = false;
  const browser = { connected: true };
  const page = { url: () => url };
  const { isExpectedConsole } = require("../autopin/service");
  const { checkIdentity } = require("../autopin/core");
  const { toAutopinConfig } = require("../controller/config-manager");
  return {
    isOpen: () => open,
    setUrl: (u) => (url = u),
    deps: {
      launchBrowser: async () => {
        open = true;
        browser.connected = true;
        return browser;
      },
      getPage: async () => page,
      openConsole: async () => ({ url, title: "x", settled: true, readyMs: 5 }),
      closeBrowser: async () => {
        open = false;
        browser.connected = false;
      },
      readIdentity: async () => identity,
      checkIdentity,
      isExpectedConsole,
      toBrowserConfig: toAutopinConfig,
    },
  };
}

// configText: null => BLANK STATE, benar-benar belum ada config.
async function withServer(over, fn) {
  const o = over || {};
  const browser = fakeBrowser(o.browser || {});
  const h = createHarness(
    Object.assign(
      {
        configText: o.configText === undefined ? null : o.configText,
        playableScenes: ["PAX-1", "PAX-2", "PAX-3"],
        obsDiscovery: { listScenes: async () => ({ ok: true, connected: true, scenes: SCENES }) },
        tiktokDiscovery: {
          products: async () => ({ ok: true, count: 1, products: CATALOGUE, livePinControlsAvailable: true }),
          status: async () => ({ ok: true, identity: "toko uji", identityOk: true, live: true, dashboardReady: true, chatReady: null, productCount: 1 }),
        },
        loginDeps: browser.deps,
      },
      o
    )
  );
  const server = createServer({ controller: h.controller });
  const addr = await server.start({ port: 0 });
  const base = "http://127.0.0.1:" + addr.port;
  try {
    await fn({ base, h, browser });
  } finally {
    await h.controller.shutdown().catch(() => {});
    await server.stop();
  }
}

async function get(base, p) {
  const res = await fetch(base + p);
  return { status: res.status, body: await res.json() };
}
async function put(base, p, body) {
  const res = await fetch(base + p, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
async function post(base, p) {
  const res = await fetch(base + p, { method: "POST" });
  return { status: res.status, body: await res.json() };
}

const FILLED = {
  tiktokUsername: "agen_mulia_abadi",
  expectedShop: "toko uji",
  obsHost: "127.0.0.1",
  obsPort: "4455",
  obsPassword: "",
  obsPasswordClear: false,
  obsPasswordSet: false,
};

// --- bentuk formulir ---------------------------------------------------------

test("formulir dibangun dari config, dan TANPA password", () => {
  const form = U.settingsToForm(redactConfig(goodConfig()));
  assert.deepEqual(Object.keys(form).sort(), [
    "expectedShop", "obsHost", "obsPassword", "obsPasswordClear", "obsPasswordSet", "obsPort", "tiktokUsername",
  ]);
  // Hanya penanda, bukan nilainya.
  assert.equal(form.obsPasswordSet, true);
  assert.equal(form.obsPassword, "");
  assert.ok(!JSON.stringify(form).includes("rahasia-obs"));
});

test("formulir dari default: OBS sudah terisi, akun belum", () => {
  const form = U.settingsToForm(redactConfig(defaultConfig()));
  assert.equal(form.obsHost, "127.0.0.1");
  assert.equal(form.obsPort, "4455");
  assert.equal(form.tiktokUsername, "");
  assert.equal(form.expectedShop, "");
  assert.equal(form.obsPasswordSet, false);
});

test("formulir dari config kosong tidak meledak", () => {
  for (const v of [null, undefined, {}]) {
    const f = U.settingsToForm(v);
    assert.equal(typeof f.obsPort, "string");
  }
});

// --- validasi formulir -------------------------------------------------------

test("formulir kosong: username dan nama akun diminta", () => {
  const v = U.validateSettingsForm(U.settingsToForm(redactConfig(defaultConfig())));
  assert.equal(v.ok, false);
  assert.deepEqual(v.fields.sort(), ["expectedShop", "tiktokUsername"]);
});

test("formulir terisi lengkap: lolos", () => {
  assert.equal(U.validateSettingsForm(FILLED).ok, true);
});

test("username TikTok wajib", () => {
  for (const bad of ["", "   ", null, undefined]) {
    const v = U.validateSettingsForm(Object.assign({}, FILLED, { tiktokUsername: bad }));
    assert.equal(v.ok, false, JSON.stringify(bad));
    assert.match(v.errors.tiktokUsername, /TikTok username/);
  }
});

test("nama akun di LIVE console wajib", () => {
  // Tanpa ini gerbang identitas tidak punya pembanding, dan login akan selalu
  // gagal dengan expected-shop-not-configured.
  const v = U.validateSettingsForm(Object.assign({}, FILLED, { expectedShop: "  " }));
  assert.equal(v.ok, false);
  assert.ok(v.errors.expectedShop.length > 0);
});

test("OBS host wajib non-empty", () => {
  const v = U.validateSettingsForm(Object.assign({}, FILLED, { obsHost: "" }));
  assert.equal(v.ok, false);
  assert.match(v.errors.obsHost, /127\.0\.0\.1/);
});

test("OBS port: 1 sampai 65535", () => {
  for (const p of ["1", "4455", "65535"]) {
    assert.equal(U.validateSettingsForm(Object.assign({}, FILLED, { obsPort: p })).ok, true, p);
  }
  for (const p of ["0", "65536", "-1", "", "abc", "44.5", " "]) {
    const v = U.validateSettingsForm(Object.assign({}, FILLED, { obsPort: p }));
    assert.equal(v.ok, false, JSON.stringify(p));
    assert.ok(v.errors.obsPort.length > 0);
  }
});

test("KONTRAK: batas port formulir sama dengan batas validator config", () => {
  // Dua implementasi dari satu aturan tidak pernah tetap sama. Jadi yang diperiksa
  // bukan kodenya, tapi KEPUTUSANNYA pada nilai batas — kalau salah satu berubah,
  // tes ini yang merah, bukan LIVE.
  for (const port of [0, 1, 4455, 65535, 65536]) {
    const cfg = goodConfig();
    cfg.obs.port = port;
    const serverOk = validateConfig(cfg).ok;

    const formOk = U.validateSettingsForm(Object.assign({}, FILLED, { obsPort: String(port) })).ok;
    assert.equal(formOk, serverOk, "port " + port + ": formulir=" + formOk + " server=" + serverOk);
  }
  assert.equal(U.PORT_MIN, 1);
  assert.equal(U.PORT_MAX, 65535);
});

test("password OBS OPSIONAL: kosong tetap lolos", () => {
  // OBS bisa dijalankan tanpa autentikasi; memaksa password akan menolak
  // konfigurasi OBS yang sah.
  assert.equal(U.validateSettingsForm(Object.assign({}, FILLED, { obsPassword: "" })).ok, true);
});

// --- formulir -> config ------------------------------------------------------

test("formulir hanya menyentuh field yang diurusnya", () => {
  const base = redactConfig(goodConfig());
  const out = U.applySettingsToConfig(base, Object.assign({}, FILLED, { tiktokUsername: "akun_baru" }));

  assert.equal(out.tiktok.username, "akun_baru");
  assert.equal(out.settings.expectedShop, "toko uji");
  assert.equal(out.obs.host, "127.0.0.1");
  assert.equal(out.obs.port, 4455);
  // Setelan lain tidak tersentuh.
  assert.equal(out.settings.autopinEnabled, base.settings.autopinEnabled);
  assert.equal(out.settings.autoCommentTransport, base.settings.autoCommentTransport);
  assert.deepEqual(out.mappings, base.mappings);
});

test("port dikirim sebagai ANGKA, bukan string", () => {
  // Validator server menuntut bilangan bulat; string "4455" akan ditolak.
  const out = U.applySettingsToConfig(redactConfig(defaultConfig()), FILLED);
  assert.equal(typeof out.obs.port, "number");

  // Payload-nya SENGAJA tidak memuat obs.password: "tidak dikirim" berarti "jangan
  // diubah". Yang melengkapinya adalah mergeSecrets di server, SEBELUM validasi —
  // jadi kelengkapan payload harus diperiksa lewat jalur itu, bukan langsung.
  const { mergeSecrets } = require("../controller/config-manager");
  const merged = mergeSecrets(Object.assign(out, { mappings: [] }), null);
  const verdict = validateConfig(merged);
  assert.equal(verdict.ok, true, JSON.stringify(verdict.errors));
  assert.equal(merged.obs.password, "", "tanpa config sebelumnya, password jadi kosong");
});

test("payload TANPA password tetap valid sesudah mergeSecrets config lama", () => {
  // Jalur yang paling sering dipakai: customer mengubah host, password tidak
  // disentuh. Password lama harus kembali masuk, dan hasilnya valid.
  const { mergeSecrets } = require("../controller/config-manager");
  const previous = goodConfig();
  const out = U.applySettingsToConfig(redactConfig(previous), Object.assign({}, FILLED, { obsHost: "192.168.1.5" }));
  out.mappings = previous.mappings;

  const merged = mergeSecrets(out, previous);
  assert.equal(merged.obs.password, "rahasia-obs");
  assert.equal(validateConfig(merged).ok, true);
});

test("nilai di-trim sebelum dikirim", () => {
  const out = U.applySettingsToConfig(redactConfig(defaultConfig()), Object.assign({}, FILLED, {
    tiktokUsername: "  akun  ",
    expectedShop: "  toko  ",
    obsHost: "  127.0.0.1  ",
    obsPort: " 4455 ",
  }));
  assert.equal(out.tiktok.username, "akun");
  assert.equal(out.settings.expectedShop, "toko");
  assert.equal(out.obs.host, "127.0.0.1");
  assert.equal(out.obs.port, 4455);
});

test("password TIDAK DIKIRIM kalau tidak diubah", () => {
  // Backend memperlakukan password yang tidak dikirim sebagai "jangan diubah".
  // Itulah yang membuat password tidak perlu pernah kembali ke halaman.
  const out = U.applySettingsToConfig(redactConfig(goodConfig()), FILLED);
  assert.equal("password" in out.obs, false);
  assert.equal("passwordSet" in out.obs, false, "penanda buatan server tidak boleh dikirim balik");
});

test("password baru DIKIRIM kalau diketik", () => {
  const out = U.applySettingsToConfig(redactConfig(goodConfig()), Object.assign({}, FILLED, { obsPassword: "rahasia-baru" }));
  assert.equal(out.obs.password, "rahasia-baru");
});

test("password dikosongkan HANYA kalau sengaja", () => {
  const cleared = U.applySettingsToConfig(redactConfig(goodConfig()), Object.assign({}, FILLED, { obsPasswordClear: true }));
  assert.equal(cleared.obs.password, "");
});

test("applySettingsToConfig tidak mengubah objek aslinya", () => {
  const base = redactConfig(goodConfig());
  U.applySettingsToConfig(base, Object.assign({}, FILLED, { tiktokUsername: "lain" }));
  assert.equal(base.tiktok.username, "agen_mulia_abadi");
});

// --- settingsView -----------------------------------------------------------

test("blank state: firstRun true, Settings bisa disunting", () => {
  const sv = U.settingsView({ status: { automation: "STOPPED", config: { present: false } } });
  assert.equal(sv.firstRun, true);
  assert.equal(sv.configured, false);
  assert.equal(sv.editable, true);
});

test("RUNNING: Settings TIDAK bisa disunting, dan alasannya disebut", () => {
  const sv = U.settingsView({ status: { automation: "RUNNING", config: { present: true } } });
  assert.equal(sv.editable, false);
  assert.equal(sv.hint, "Settings can only be changed while the automation is stopped.");
});

// --- gerbang START dan LOGIN -------------------------------------------------

test("blank state: START BOT dan LOGIN TIKTOK keduanya MATI", () => {
  const status = { automation: "STOPPED", config: { present: false } };
  const c = U.controlsFor({ status });
  assert.equal(c.startEnabled, false);
  assert.equal(c.startReason, "Add your mappings and press Save Changes first.");

  const lv = U.loginView({ status });
  assert.equal(lv.canLogin, false);
  assert.equal(lv.hint, "Save your settings first.");
});

test("sesudah config ada: LOGIN TIKTOK HIDUP", () => {
  const lv = U.loginView({ status: { automation: "STOPPED", config: { present: true } } });
  assert.equal(lv.canLogin, true);
  assert.equal(lv.hint, "");
});

// --- jalur first-run lewat HTTP ---------------------------------------------

test("DoD: first-run dari BLANK sampai LOGIN siap, tanpa terminal", async () => {
  await withServer({}, async ({ base, h }) => {
    // 1. Blank state
    let st = (await get(base, "/api/status")).body;
    assert.equal(st.config.present, false);
    assert.equal(U.settingsView({ status: st }).firstRun, true, "Initial Setup harus tampil");
    assert.equal(U.controlsFor({ status: st }).startEnabled, false, "START mati");
    assert.equal(U.loginView({ status: st }).canLogin, false, "LOGIN mati");

    // GET /api/config memberi default sebagai titik awal, bukan layar kosong.
    const cfgRes = await get(base, "/api/config");
    assert.equal(cfgRes.body.ok, false);
    assert.equal(cfgRes.body.error.code, "config-missing");
    assert.ok(cfgRes.body.defaults);

    // 2. Customer mengisi formulir
    const form = U.settingsToForm(cfgRes.body.defaults);
    assert.deepEqual(U.validateSettingsForm(form).fields.sort(), ["expectedShop", "tiktokUsername"]);

    form.tiktokUsername = "agen_mulia_abadi";
    form.expectedShop = "toko uji";
    assert.equal(U.validateSettingsForm(form).ok, true);

    // 3. Simpan
    const payload = U.applySettingsToConfig(cfgRes.body.defaults, form);
    payload.mappings = [];
    const saved = await put(base, "/api/config", payload);
    assert.equal(saved.status, 200, JSON.stringify(saved.body).slice(0, 300));
    assert.equal(saved.body.ok, true);

    // 4. Kesiapan berubah, LOGIN siap
    st = (await get(base, "/api/status")).body;
    assert.equal(st.config.present, true);
    assert.equal(st.config.tiktokUsername, "agen_mulia_abadi");
    assert.equal(U.loginView({ status: st }).canLogin, true, "LOGIN harus hidup sekarang");
    assert.equal(U.settingsView({ status: st }).firstRun, false);

    // 5. Dan tidak ada proses apa pun yang menyala karena menyimpan settings.
    assert.equal(h.world.spawned.length, 0);
    assert.equal(st.run.armed, false);
    assert.equal(st.profile.owner, "none");
  });
});

test("settings invalid TIDAK menimpa config valid terakhir", async () => {
  await withServer({ configText: JSON.stringify(goodConfig(), null, 2) }, async ({ base, h }) => {
    const before = h.fs.files.get(h.CONFIG_PATH);

    // Port di luar jangkauan.
    const bad = U.applySettingsToConfig(redactConfig(goodConfig()), Object.assign({}, FILLED, { obsPort: "70000" }));
    bad.mappings = goodConfig().mappings;
    const r = await put(base, "/api/config", bad);

    assert.equal(r.status, 400);
    assert.equal(r.body.ok, false);
    assert.ok(r.body.errors.some((e) => e.path === "obs.port"), JSON.stringify(r.body.errors));
    // Berkasnya tidak disentuh SAMA SEKALI.
    assert.equal(h.fs.files.get(h.CONFIG_PATH), before);
  });
});

test("host kosong juga ditolak server, dan config lama utuh", async () => {
  await withServer({ configText: JSON.stringify(goodConfig(), null, 2) }, async ({ base, h }) => {
    const before = h.fs.files.get(h.CONFIG_PATH);
    const bad = U.applySettingsToConfig(redactConfig(goodConfig()), Object.assign({}, FILLED, { obsHost: "" }));
    bad.mappings = goodConfig().mappings;

    const r = await put(base, "/api/config", bad);
    assert.equal(r.status, 400);
    assert.equal(h.fs.files.get(h.CONFIG_PATH), before);
  });
});

test("password OBS TIDAK PERNAH kembali ke halaman, bahkan sesudah disimpan", async () => {
  await withServer({}, async ({ base }) => {
    const defaults = (await get(base, "/api/config")).body.defaults;
    const form = Object.assign(U.settingsToForm(defaults), {
      tiktokUsername: "akun",
      expectedShop: "toko uji",
      obsPassword: "password-super-rahasia",
    });
    const payload = U.applySettingsToConfig(defaults, form);
    payload.mappings = [];

    const saved = await put(base, "/api/config", payload);
    assert.equal(saved.body.ok, true);
    // Balasan PUT pun sudah teredaksi.
    assert.equal("password" in saved.body.config.obs, false);
    assert.equal(saved.body.config.obs.passwordSet, true);
    assert.ok(!JSON.stringify(saved.body).includes("password-super-rahasia"));

    // GET berikutnya juga tidak memuatnya.
    const after = await get(base, "/api/config");
    assert.equal("password" in after.body.config.obs, false);
    assert.equal(after.body.config.obs.passwordSet, true);
    assert.ok(!JSON.stringify(after.body).includes("password-super-rahasia"));

    // Dan /api/status juga tidak.
    const st = await get(base, "/api/status");
    assert.ok(!JSON.stringify(st.body).includes("password-super-rahasia"));
    assert.ok(!/password/i.test(JSON.stringify(st.body)));
  });
});

test("menyimpan settings lain TIDAK menghapus password yang tersimpan", async () => {
  await withServer({ configText: JSON.stringify(goodConfig(), null, 2) }, async ({ base, h }) => {
    // Alur nyata: GET (tanpa password) -> ubah host -> PUT.
    const cfg = (await get(base, "/api/config")).body.config;
    const form = U.settingsToForm(cfg);
    form.obsHost = "192.168.1.50";

    const payload = U.applySettingsToConfig(cfg, form);
    payload.mappings = cfg.mappings;
    const saved = await put(base, "/api/config", payload);

    assert.equal(saved.body.ok, true);
    assert.equal(saved.body.config.obs.host, "192.168.1.50");
    assert.equal(saved.body.config.obs.passwordSet, true, "password harus masih ada");
    // Dibuktikan dari berkas, bukan dari balasan yang sudah teredaksi.
    assert.equal(JSON.parse(h.fs.files.get(h.CONFIG_PATH)).obs.password, "rahasia-obs");
  });
});

test("password bisa DIGANTI lewat UI", async () => {
  await withServer({ configText: JSON.stringify(goodConfig(), null, 2) }, async ({ base, h }) => {
    const cfg = (await get(base, "/api/config")).body.config;
    const form = Object.assign(U.settingsToForm(cfg), { obsPassword: "password-baru" });
    const payload = U.applySettingsToConfig(cfg, form);
    payload.mappings = cfg.mappings;

    await put(base, "/api/config", payload);
    assert.equal(JSON.parse(h.fs.files.get(h.CONFIG_PATH)).obs.password, "password-baru");
  });
});

test("password bisa DIHAPUS dengan sengaja", async () => {
  await withServer({ configText: JSON.stringify(goodConfig(), null, 2) }, async ({ base, h }) => {
    const cfg = (await get(base, "/api/config")).body.config;
    const form = Object.assign(U.settingsToForm(cfg), { obsPasswordClear: true });
    const payload = U.applySettingsToConfig(cfg, form);
    payload.mappings = cfg.mappings;

    const saved = await put(base, "/api/config", payload);
    assert.equal(saved.body.ok, true);
    assert.equal(saved.body.config.obs.passwordSet, false);
    assert.equal(JSON.parse(h.fs.files.get(h.CONFIG_PATH)).obs.password, "");
  });
});

test("menyimpan settings tidak merusak mapping yang sudah ada", async () => {
  await withServer({ configText: JSON.stringify(goodConfig(), null, 2) }, async ({ base }) => {
    const cfg = (await get(base, "/api/config")).body.config;
    const mappingsBefore = JSON.parse(JSON.stringify(cfg.mappings));

    const form = Object.assign(U.settingsToForm(cfg), { obsPort: "4466" });
    const payload = U.applySettingsToConfig(cfg, form);
    payload.mappings = cfg.mappings;

    const saved = await put(base, "/api/config", payload);
    assert.equal(saved.body.ok, true);
    assert.deepEqual(saved.body.config.mappings, mappingsBefore);
  });
});

test("Settings saat RUNNING: tersimpan tapi minta restart, dan tidak hot-apply", async () => {
  const cfg = goodConfig();
  cfg.mappings = [{ scene: "PAX-1", product: { title: "O'CORN Sea Salt" }, triggers: ["etalase satu"], reply: "ok" }];
  await withServer({ configText: JSON.stringify(cfg, null, 2) }, async ({ base, h }) => {
    const started = await post(base, "/api/start");
    assert.equal(started.body.ok, true, JSON.stringify(started.body.error || {}));
    const generationBefore = h.controller.runtimeConfigId();

    const current = (await get(base, "/api/config")).body.config;
    const form = Object.assign(U.settingsToForm(current), { obsHost: "192.168.1.9" });
    const payload = U.applySettingsToConfig(current, form);
    payload.mappings = current.mappings;

    const saved = await put(base, "/api/config", payload);
    assert.equal(saved.body.ok, true);
    assert.equal(saved.body.restartRequired, true);
    // Snapshot yang SEDANG dipakai tidak disentuh.
    assert.equal(h.controller.runtimeConfigId(), generationBefore);

    // Dan UI mematikan penyuntingan selama RUNNING.
    const st = (await get(base, "/api/status")).body;
    assert.equal(U.settingsView({ status: st }).editable, false);
  });
});

// --- halaman ---------------------------------------------------------------

test("halaman punya semua field Settings, dan id-nya nyata", () => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
  const app = fs.readFileSync(path.join(PUBLIC_DIR, "app.js"), "utf8");
  for (const id of [
    "set-tiktok-username", "set-expected-shop", "set-obs-host", "set-obs-port",
    "set-obs-password", "obs-password-change", "obs-password-cancel", "obs-password-label",
    "save-settings-btn", "settings-state", "settings-hint",
    "err-tiktokUsername", "err-expectedShop", "err-obsHost", "err-obsPort",
  ]) {
    assert.ok(html.includes('id="' + id + '"'), "index.html harus punya " + id);
    assert.ok(app.includes('"' + id + '"'), "app.js harus memakai " + id);
  }
});

test("field password OBS bertipe password dan tidak pernah di-autofill", () => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
  const m = /<input id="set-obs-password"[^>]*>/.exec(html);
  assert.ok(m, "input password harus ada");
  assert.match(m[0], /type="password"/);
  // new-password mencegah pengelola password mengisinya dengan kredensial lain.
  assert.match(m[0], /autocomplete="new-password"/);
  // Dan ia tidak pernah punya nilai awal di markup.
  assert.ok(!/value=/.test(m[0]), "tidak boleh ada nilai awal");
});

test("halaman TIDAK memuat path config, path profil, atau .env", () => {
  for (const name of ["index.html", "app.js", "ui-logic.js"]) {
    const src = fs.readFileSync(path.join(PUBLIC_DIR, name), "utf8");
    assert.ok(!/data\/config\.json|config\.json/.test(src), name + " tidak boleh menyebut path config");
    assert.ok(!/\.autopin-profile|profileDir/.test(src), name + " tidak boleh menyebut path profil");
    assert.ok(!/\.env|process\.env/.test(src), name + " tidak boleh menyebut env");
    assert.ok(!/AILIVE_RUNTIME_CONFIG/.test(src), name);
  }
});

test("app.js tidak menyimpan password di state halaman lebih lama dari perlu", () => {
  const app = fs.readFileSync(path.join(PUBLIC_DIR, "app.js"), "utf8");
  // Password hanya dibaca dari input saat sedang diganti, dan state-nya dikosongkan
  // sesudah tersimpan.
  assert.match(app, /state\.changingPassword = false/);
  assert.match(app, /if \(!state\.changingPassword\) pwInput\.value = ""/);
});

test("Settings adalah section TERPISAH dari Mapping", () => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
  assert.ok(html.indexOf('id="settings-title"') < html.indexOf('id="mapping-title"'), "Settings sebelum Mapping");
  // Dan tombol simpannya berbeda.
  assert.ok(html.includes('id="save-settings-btn"'));
  assert.ok(html.includes('id="save-btn"'));
});
