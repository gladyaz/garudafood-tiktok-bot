// Login TikTok lewat HTTP sungguhan, dan bagaimana UI menampilkannya.
//
// Server express-nya nyata di 127.0.0.1; browser dan child process di belakangnya
// palsu. Nol TikTok, nol Chrome, nol kredensial.

const { test } = require("node:test");
const assert = require("node:assert/strict");

// Kalimat customer tidak lagi diassert sebagai prosa: ia dibandingkan dengan
// KAMUS. Mengubah kata-kata tidak memerahkan tes; salah kabel tetap merah.
const I18N = require("../controller/public/i18n.js");
const T = (key, vars) => I18N.t("id", key, vars);
const fs = require("node:fs");
const path = require("node:path");

const { createServer, PUBLIC_DIR } = require("../controller/server");
const { createHarness, goodConfig } = require("./helpers/controller-harness");
const { isExpectedConsole } = require("../autopin/service");
const { checkIdentity } = require("../autopin/core");
const { toAutopinConfig } = require("../controller/config-manager");
const U = require("../controller/public/ui-logic.js");

const DASHBOARD = "https://shop.tiktok.com/streamer/live/product/dashboard";
const LOGIN_PAGE = "https://www.tiktok.com/login";
const SCENES = ["MAIN", "PAX-1", "PAX-2", "PAX-3"];
const CATALOGUE = [{ title: "O'CORN Sea Salt 80gr", number: 1, price: "Rp10.000", stock: "Stok 50", pinAvailable: true }];

function fakeBrowser({ pageUrl = LOGIN_PAGE, identity = ["toko uji"] } = {}) {
  let url = pageUrl;
  let open = false;
  const browser = { connected: true };
  const page = { url: () => url };
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

function configWithMapping() {
  const c = goodConfig();
  c.settings.autoCommentEnabled = true;
  // Dan jalur kirimnya yang sungguhan. Tes ini menguji bahwa service mendapat
  // izin kirim nyata; config yang menyalakan balasan tapi membiarkan jalur
  // kirimnya aman adalah config yang TIDAK PERNAH bisa mengirim, jadi sejak
  // P5.1.1 ia ditolak di jalur start. Lihat controller/automation-mode.js.
  c.settings.autoCommentTransport = "browser";
  c.mappings = [
    { scene: "PAX-1", product: { title: "O'CORN Sea Salt" }, triggers: ["spill etalase 1"], reply: "Etalase 1 sudah aku pin ya kak" },
  ];
  return c;
}

async function withServer(over, fn) {
  const o = over || {};
  const browser = fakeBrowser(o.browser || {});
  const h = createHarness(
    Object.assign(
      {
        config: o.config || configWithMapping(),
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
async function post(base, p) {
  const res = await fetch(base + p, { method: "POST" });
  return { status: res.status, body: await res.json() };
}

// --- endpoint ---------------------------------------------------------------

test("POST /api/tiktok/login/start membuka jendela dan kembali segera", async () => {
  await withServer({}, async ({ base, browser }) => {
    const r = await post(base, "/api/tiktok/login/start");
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.loginInProgress, true);
    assert.equal(r.body.login.active, true);
    assert.equal(browser.isOpen(), true);
  });
});

test("GET /api/tiktok/login/status melaporkan keadaan tanpa rahasia", async () => {
  await withServer({}, async ({ base }) => {
    await post(base, "/api/tiktok/login/start");
    const r = await get(base, "/api/tiktok/login/status");
    assert.equal(r.body.login.active, true);
    assert.deepEqual(Object.keys(r.body.login).sort(), ["active", "identity", "profileOwner", "startedAt", "state"]);
    const raw = JSON.stringify(r.body);
    for (const leak of ["cookie", "token", "password", "autopin-profile", "ws://"]) {
      assert.ok(!raw.toLowerCase().includes(leak.toLowerCase()), leak);
    }
  });
});

test("CHECK sebelum selesai: 200, dan kalimat yang bisa ditindaklanjuti", async () => {
  await withServer({}, async ({ base }) => {
    await post(base, "/api/tiktok/login/start");
    const r = await post(base, "/api/tiktok/login/check");
    assert.equal(r.status, 200, "belum selesai bukan kesalahan server");
    assert.equal(r.body.ok, false);
    assert.equal(r.body.error.code, "login-not-finished");
    assert.equal(
      r.body.error.userMessage,
      "Sign-in is not finished yet. Complete it in the browser window, then check again."
    );
    assert.equal(r.body.login.active, true, "jendela tetap terbuka");
  });
});

test("CHECK sesudah selesai: identitas dikembalikan, jendela tertutup", async () => {
  await withServer({}, async ({ base, browser }) => {
    await post(base, "/api/tiktok/login/start");
    browser.setUrl(DASHBOARD);

    const r = await post(base, "/api/tiktok/login/check");
    assert.equal(r.body.ok, true);
    assert.equal(r.body.loggedIn, true);
    assert.equal(r.body.identity, "toko uji");
    assert.equal(browser.isOpen(), false);
    assert.equal(r.body.login.active, false);
    assert.equal(r.body.login.identity, "toko uji");
  });
});

test("akun SALAH: ditolak, dan tidak diterima diam-diam", async () => {
  await withServer({ browser: { identity: ["toko orang lain"] } }, async ({ base, browser }) => {
    await post(base, "/api/tiktok/login/start");
    browser.setUrl(DASHBOARD);

    const r = await post(base, "/api/tiktok/login/check");
    assert.equal(r.body.ok, false);
    assert.equal(r.body.error.code, "wrong-tiktok-account");
    assert.equal(r.body.error.userMessage, "The TikTok account on screen is not the one you configured.");
    assert.equal(browser.isOpen(), false, "jendela ditutup supaya bisa ganti akun");
  });
});

test("CANCEL menutup jendela dan melepas profil", async () => {
  await withServer({}, async ({ base, browser }) => {
    await post(base, "/api/tiktok/login/start");
    const r = await post(base, "/api/tiktok/login/cancel");
    assert.equal(r.body.ok, true);
    assert.equal(r.body.cancelled, true);
    assert.equal(browser.isOpen(), false);
    assert.equal((await get(base, "/api/status")).body.profile.owner, "none");
  });
});

test("login KEDUA ditolak lewat HTTP", async () => {
  await withServer({}, async ({ base }) => {
    await post(base, "/api/tiktok/login/start");
    const second = await post(base, "/api/tiktok/login/start");
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, "login-already-in-progress");
  });
});

test("START BOT ditolak selagi login aktif, dan nol proses menyala", async () => {
  await withServer({}, async ({ base, h }) => {
    await post(base, "/api/tiktok/login/start");
    const started = await post(base, "/api/start");
    assert.equal(started.status, 409);
    assert.equal(started.body.error.code, "login-in-progress");
    assert.equal(h.world.spawned.length, 0);
  });
});

test("login ditolak selagi automation BERJALAN", async () => {
  await withServer({}, async ({ base }) => {
    const started = await post(base, "/api/start");
    assert.equal(started.body.ok, true, JSON.stringify(started.body.error || {}));

    const login = await post(base, "/api/tiktok/login/start");
    assert.equal(login.status, 409);
    assert.equal(login.body.error.code, "login-unavailable-while-running");
  });
});

test("discovery produk ditolak selagi login aktif, dengan kalimat yang tepat", async () => {
  await withServer({}, async ({ base }) => {
    await post(base, "/api/tiktok/login/start");
    const r = await get(base, "/api/tiktok/products");
    assert.equal(r.body.ok, false);
    assert.equal(r.body.error.code, "discovery-unavailable-during-login");
    assert.equal(r.body.error.userMessage, "Finish or cancel the TikTok sign-in first, then refresh.");
  });
});

test("/api/status melaporkan profil, login, dan run", async () => {
  await withServer({}, async ({ base }) => {
    const before = await get(base, "/api/status");
    assert.equal(before.body.profile.owner, "none");
    assert.equal(before.body.login.active, false);
    assert.equal(before.body.run.armed, false);

    await post(base, "/api/tiktok/login/start");
    const during = await get(base, "/api/status");
    assert.equal(during.body.profile.owner, "login");
  });
});

// --- alur lengkap: login -> start -> stop ------------------------------------

test("DoD: login palsu -> check -> mapping -> START -> RUNNING -> STOP", async () => {
  await withServer({}, async ({ base, h, browser }) => {
    // 1. Belum login
    let st = (await get(base, "/api/status")).body;
    assert.equal(U.loginView({ status: st }).state, "signed-out");

    // 2. Login
    await post(base, "/api/tiktok/login/start");
    st = (await get(base, "/api/status")).body;
    assert.equal(U.loginView({ status: st }).state, "waiting");
    assert.equal(U.controlsFor({ status: st }).startEnabled, false, "Start mati selagi login");

    // 3. Customer selesai login, lalu CHECK
    browser.setUrl(DASHBOARD);
    const checked = await post(base, "/api/tiktok/login/check");
    assert.equal(checked.body.identity, "toko uji");

    st = (await get(base, "/api/status")).body;
    const lv = U.loginView({ status: st });
    assert.equal(lv.state, "connected");
    assert.equal(lv.label, T("ui.login.signedIn", { name: "toko uji" }));

    // 4. START
    const pre = await post(base, "/api/preflight");
    assert.equal(pre.body.ok, true, JSON.stringify(pre.body.checks));
    const started = await post(base, "/api/start");
    assert.equal(started.body.ok, true);
    assert.equal(started.body.state, "RUNNING");

    // Service mendapat izin kirim nyata TEPAT SATU KALI; bot tidak.
    const { REAL_SEND_FLAG } = require("../controller/run-authority");
    const svc = h.world.liveByScript("autopin-service.js")[0];
    const bot = h.world.liveByScript("index.js")[0];
    assert.equal(svc.spawnArgs.filter((a) => a === REAL_SEND_FLAG).length, 1);
    assert.ok(!bot.spawnArgs.includes(REAL_SEND_FLAG));

    // 5. RUNNING: penyuntingan mati, run bersenjata
    st = (await get(base, "/api/status")).body;
    assert.equal(st.run.armed, true);
    assert.equal(st.profile.owner, "automation");
    assert.equal(U.controlsFor({ status: st }).editingEnabled, false);

    // 6. STOP
    const stopped = await post(base, "/api/stop");
    assert.equal(stopped.body.ok, true);
    st = (await get(base, "/api/status")).body;
    assert.equal(st.automation, "STOPPED");
    assert.equal(st.run.armed, false, "otoritas lenyap");
    assert.equal(st.profile.owner, "none");
    assert.equal(h.world.liveCount(), 0, "zero orphan child process");
    assert.equal(U.controlsFor({ status: st }).editingEnabled, true);
  });
});

// --- UI --------------------------------------------------------------------

test("halaman punya tombol login, dan semua id-nya nyata", () => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
  const app = fs.readFileSync(path.join(PUBLIC_DIR, "app.js"), "utf8");
  for (const id of ["login-btn", "login-check-btn", "login-cancel-btn", "login-hint"]) {
    assert.ok(html.includes('id="' + id + '"'), "index.html harus punya " + id);
    assert.ok(app.includes('"' + id + '"'), "app.js harus memakai " + id);
  }
});

test("halaman TIDAK PERNAH meminta kredensial TikTok", () => {
  // Aturan yang tidak bisa ditawar: aplikasi tidak pernah meminta, menerima,
  // menyimpan, mencatat, atau mengirimkan password TikTok. Login TikTok selalu
  // dilakukan customer sendiri di jendela browser.
  //
  // CATATAN PENTING soal cakupan: sejak P4.1 halaman MEMANG punya satu input
  // password — untuk OBS WebSocket di komputer customer sendiri. Itu hal yang
  // berbeda: kredensial layanan lokal yang memang harus diisi customer, bukan
  // kredensial akun TikTok-nya. Jadi yang dilarang di sini adalah input untuk
  // TikTok, bukan input password mana pun.
  const html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
  const markup = html.replace(/<!--[\s\S]*?-->/g, "");

  // SATU-SATUNYA input password yang diizinkan adalah milik OBS.
  const pwInputs = markup.match(/<input[^>]*type\s*=\s*["']password["'][^>]*>/gi) || [];
  assert.equal(pwInputs.length, 1, "hanya boleh ada satu input password: " + pwInputs.join(" | "));
  assert.match(pwInputs[0], /id="set-obs-password"/, "dan itu harus milik OBS");

  // Tidak ada kontrol apa pun yang mengaitkan TikTok dengan kredensial.
  assert.ok(
    !/(?:name|id)\s*=\s*["'][^"']*tiktok[^"']*(?:pass|pwd|secret|token|cookie)[^"']*["']/i.test(markup),
    "tidak boleh ada kontrol kredensial TikTok"
  );
  // Dan tidak ada <form>: halaman ini tidak pernah mengirim kredensial ke mana pun
  // selain lewat PUT /api/config ke 127.0.0.1.
  assert.ok(!/<form\b/i.test(markup), "tidak boleh ada <form>");
});

test("app.js tidak pernah menyentuh kredensial TikTok, dan tidak menyimpan password OBS", () => {
  const app = fs.readFileSync(path.join(PUBLIC_DIR, "app.js"), "utf8");
  const appCode = app
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");

  // Tidak ada jalur kredensial TikTok sama sekali.
  assert.ok(!/tiktokPassword|tiktok_password|loginPassword/i.test(appCode));
  assert.ok(!/cookie|document\.cookie|localStorage|sessionStorage/i.test(appCode), "tidak menyimpan apa pun di browser");

  // Password OBS hanya dibaca saat sedang diganti, dan dikosongkan sesudahnya.
  //
  // Pembacaan DOM-nya sendiri pindah ke ui-logic.js (readSettingsNodes) supaya
  // interaksinya bisa diuji tanpa jsdom, jadi penjaganya diperiksa DI SANA.
  // app.js tetap harus meneruskan keadaan "sedang mengganti" itu.
  // Dibaca MENTAH: frasa yang dicari hanya ada di kode, tidak di komentar,
  // jadi tidak perlu membuang komentar dulu.
  const uiLogic = fs.readFileSync(path.join(PUBLIC_DIR, "ui-logic.js"), "utf8");
  assert.match(uiLogic, /changingPassword && pw/, "password hanya dibaca saat sedang diganti");
  assert.match(uiLogic, /get\("set-obs-password"\)/);
  assert.match(appCode, /state\.changingPassword/, "app.js meneruskan keadaan itu");
  assert.match(appCode, /if \(!state\.changingPassword\) pwInput\.value = ""/);
  // Dan ia tidak pernah dibaca dari balasan server.
  assert.ok(!/body\.config\.obs\.password/.test(appCode), "password tersimpan tidak pernah dibaca dari server");
});

test("loginView: tombol yang benar di tiap keadaan", () => {
  const out = U.loginView({ status: { automation: "STOPPED" } });
  assert.deepEqual([out.canLogin, out.canCheck, out.canCancel], [true, false, false]);

  const waiting = U.loginView({ status: { automation: "STOPPED", login: { active: true } } });
  assert.deepEqual([waiting.canLogin, waiting.canCheck, waiting.canCancel], [false, true, true]);
  assert.equal(waiting.hint, T("ui.login.hintWaiting"));

  const running = U.loginView({ status: { automation: "RUNNING" } });
  assert.equal(running.canLogin, false, "tidak bisa login saat berjalan");
  assert.equal(running.hint, T("ui.login.hintStopFirst"));
});

test("loginView memakai identitas yang TERBUKTI, bukan yang ditulis di config", () => {
  // Nilai di config hanya harapan; yang ditampilkan harus yang benar-benar dibaca
  // dari halaman.
  const fromLogin = U.loginView({ status: { automation: "STOPPED", login: { active: false, identity: "terbukti" } } });
  assert.equal(fromLogin.label, T("ui.login.signedIn", { name: "terbukti" }));

  const fromDiscovery = U.loginView({
    status: { automation: "STOPPED" },
    tiktok: { ok: true, identity: "dari-discovery" },
  });
  assert.equal(fromDiscovery.label, T("ui.login.signedIn", { name: "dari-discovery" }));
});

test("readiness memuat baris TikTok sign-in", () => {
  const rows = U.readinessRows({
    status: { automation: "STOPPED", login: { active: true } },
  });
  const row = rows.find((r) => r.label === T("ui.row.signin"));
  assert.ok(row, "baris TikTok sign-in harus ada");
  assert.equal(row.value, T("ui.login.waiting"));
});

test("activity menerjemahkan kejadian login", () => {
  const items = U.activityItems([
    { id: 1, time: "2026-10-08T10:00:00.000Z", type: "LOGIN_WAITING" },
    { id: 2, time: "2026-10-08T10:01:00.000Z", type: "LOGIN_OK" },
  ]);
  const texts = items.map((i) => i.text);
  assert.ok(texts.includes(T("ui.act.loginWaiting")));
  assert.ok(texts.includes(T("ui.act.loginOk")));
});
