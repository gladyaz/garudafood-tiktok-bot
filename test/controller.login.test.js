// Login TikTok dari aplikasi, dan kepemilikan profil Chrome.
//
// SEMUANYA OFFLINE: fungsi browser di-inject, tidak ada Puppeteer yang dimuat,
// tidak ada halaman TikTok yang dibuka, dan tidak ada kredensial yang pernah ada
// di dalam tes ini maupun di dalam kodenya.
//
// Dua hal yang diuji paling keras:
//
//   1. Aplikasi tidak pernah menyentuh password, cookie, atau token. Yang dibaca
//      dari halaman hanya nama akun yang sudah terlihat oleh siapa pun yang
//      menonton LIVE itu.
//   2. Login dan automation SALING EKSKLUSIF. Keduanya memakai satu direktori
//      profil Chrome, dan Chrome mengunci profil ke satu proses — memaksanya bisa
//      merusak sesi yang sedang dipakai mengklik produk sungguhan.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createProfileOwnership, OWNER, REASONS } = require("../controller/profile-owner");
const { createLoginFlow } = require("../controller/login");
const { isExpectedConsole } = require("../autopin/service");
const { checkIdentity } = require("../autopin/core");
const { toAutopinConfig } = require("../controller/config-manager");
const { createHarness, goodConfig } = require("./helpers/controller-harness");
const { STATES } = require("../controller/state-machine");

const DASHBOARD = "https://shop.tiktok.com/streamer/live/product/dashboard";

// --- kepemilikan profil ------------------------------------------------------

test("profil mulai BEBAS", () => {
  const o = createProfileOwnership();
  assert.equal(o.owner(), OWNER.NONE);
  assert.equal(o.isFree(), true);
});

test("login dan automation saling mengunci", () => {
  const a = createProfileOwnership();
  assert.equal(a.acquire(OWNER.LOGIN).ok, true);
  const blocked = a.acquire(OWNER.AUTOMATION);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, REASONS.BUSY_LOGIN);

  const b = createProfileOwnership();
  assert.equal(b.acquire(OWNER.AUTOMATION).ok, true);
  assert.equal(b.acquire(OWNER.LOGIN).reason, REASONS.BUSY_AUTOMATION);
});

test("pemilik yang SAMA juga ditolak mengambil dua kali", () => {
  // Dua jendela login atau dua service adalah tepat kondisi yang modul ini dibuat
  // untuk mencegah. Membiarkannya lewat karena "ya sudah dia juga yang punya"
  // akan menyembunyikan start kedua.
  const o = createProfileOwnership();
  o.acquire(OWNER.LOGIN);
  assert.equal(o.acquire(OWNER.LOGIN).ok, false);
});

test("hanya pemiliknya yang boleh melepas", () => {
  const o = createProfileOwnership();
  o.acquire(OWNER.AUTOMATION);
  const wrong = o.release(OWNER.LOGIN);
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reason, "not-profile-owner");
  assert.equal(o.owner(), OWNER.AUTOMATION, "kepemilikan tidak berubah");

  assert.equal(o.release(OWNER.AUTOMATION).ok, true);
  assert.equal(o.isFree(), true);
});

test("melepas yang sudah bebas aman", () => {
  const o = createProfileOwnership();
  assert.equal(o.release(OWNER.LOGIN).ok, true);
});

test("pemilik yang tidak dikenal ditolak", () => {
  const o = createProfileOwnership();
  assert.equal(o.acquire("sesuatu").reason, "unknown-profile-owner");
  assert.equal(o.isFree(), true);
});

test("forceRelease untuk cleanup", () => {
  const o = createProfileOwnership();
  o.acquire(OWNER.AUTOMATION);
  o.forceRelease("shutdown");
  assert.equal(o.isFree(), true);
});

// --- alur login --------------------------------------------------------------

// Browser palsu yang MENCATAT setiap panggilan, supaya tes bisa membuktikan tidak
// ada fungsi pengetik/pembaca kredensial yang pernah dijalankan.
function fakeBrowser({ pageUrl = DASHBOARD, identity = ["toko uji"], launchError = null, navError = null } = {}) {
  const events = [];
  let currentUrl = pageUrl;
  let open = false;
  const page = {
    url: () => currentUrl,
  };
  const browser = { connected: true };

  const deps = {
    launchBrowser: async () => {
      events.push("launchBrowser");
      if (launchError) {
        const e = new Error("launch failed");
        e.reason = launchError;
        throw e;
      }
      open = true;
      browser.connected = true;
      return browser;
    },
    getPage: async () => {
      events.push("getPage");
      return page;
    },
    openConsole: async () => {
      events.push("openConsole");
      if (navError) throw new Error(navError);
      return { url: currentUrl, title: "x", settled: true, readyMs: 10 };
    },
    closeBrowser: async () => {
      events.push("closeBrowser");
      open = false;
      browser.connected = false;
    },
    readIdentity: async () => {
      events.push("readIdentity");
      // ARRAY, sama seperti produksi.
      return identity;
    },
    // Fungsi PRODUKSI, bukan tiruan: keduanya murni.
    checkIdentity,
    isExpectedConsole,
    toBrowserConfig: toAutopinConfig,
  };

  return {
    deps,
    events,
    isOpen: () => open,
    setUrl: (u) => (currentUrl = u),
    closeWindow: () => {
      browser.connected = false;
    },
  };
}

function loginWith(opts = {}) {
  const f = fakeBrowser(opts);
  const ownership = createProfileOwnership();
  const flow = createLoginFlow(Object.assign({ ownership }, f.deps));
  return { f, ownership, flow };
}

test("start membuka jendela dan kembali SEGERA", async () => {
  // Menunggu customer selesai login bisa belasan menit; menahan permintaan HTTP
  // selama itu akan membuat UI tampak menggantung.
  const { f, flow, ownership } = loginWith({ pageUrl: "https://www.tiktok.com/login" });
  const r = await flow.start(goodConfig());

  assert.equal(r.ok, true);
  assert.equal(r.loginInProgress, true);
  assert.equal(flow.describe().active, true);
  assert.equal(ownership.owner(), OWNER.LOGIN);
  assert.ok(f.events.includes("launchBrowser"));
});

test("start TIDAK PERNAH mengetik, membaca cookie, atau menyentuh password", async () => {
  const { f, flow } = loginWith({ pageUrl: "https://www.tiktok.com/login" });
  await flow.start(goodConfig());

  // Daftar TERTUTUP fungsi yang boleh dipanggil saat membuka login.
  assert.deepEqual(f.events, ["launchBrowser", "getPage", "openConsole"]);
  for (const forbidden of ["type", "cookies", "setCookie", "evaluate", "readIdentity", "keyboard", "fill"]) {
    assert.ok(!f.events.includes(forbidden), forbidden + " tidak boleh pernah dipanggil saat start");
  }
});

test("navigasi yang gagal BUKAN kegagalan login", async () => {
  // Customer yang belum login memang akan dialihkan, dan itu keadaan normal saat
  // tombol LOGIN TIKTOK ditekan.
  const { flow } = loginWith({ navError: "navigation-failed", pageUrl: "https://www.tiktok.com/login" });
  const r = await flow.start(goodConfig());
  assert.equal(r.ok, true);
  assert.equal(flow.describe().active, true);
});

test("login KEDUA ditolak", async () => {
  const { flow } = loginWith({});
  await flow.start(goodConfig());
  const second = await flow.start(goodConfig());
  assert.equal(second.ok, false);
  assert.equal(second.reason, "login-already-in-progress");
});

test("login ditolak saat profil dipegang automation", async () => {
  const { flow, ownership } = loginWith({});
  ownership.acquire(OWNER.AUTOMATION);
  const r = await flow.start(goodConfig());
  assert.equal(r.ok, false);
  assert.equal(r.reason, REASONS.BUSY_AUTOMATION);
});

test("Chrome lain yang memegang profil dilaporkan khusus", async () => {
  const { flow, ownership } = loginWith({ launchError: "profile-in-use" });
  const r = await flow.start(goodConfig());
  assert.equal(r.ok, false);
  assert.equal(r.reason, "profile-busy-external");
  // Profil DILEPAS kembali: kegagalan membuka tidak boleh meninggalkan klaim.
  assert.equal(ownership.isFree(), true);
});

test("check sebelum login selesai: belum selesai, bukan gagal", async () => {
  const { flow } = loginWith({ pageUrl: "https://www.tiktok.com/login" });
  await flow.start(goodConfig());

  const r = await flow.check(goodConfig());
  assert.equal(r.ok, false);
  assert.equal(r.reason, "login-not-finished");
  // Jendela TETAP terbuka: customer bisa menyelesaikan lalu menekan lagi.
  assert.equal(flow.describe().active, true);
});

test("check sesudah login berhasil: identitas dikembalikan, jendela ditutup", async () => {
  const { f, flow, ownership } = loginWith({ pageUrl: "https://www.tiktok.com/login" });
  await flow.start(goodConfig());

  // Customer selesai login; halaman sekarang dashboard.
  f.setUrl(DASHBOARD);
  const r = await flow.check(goodConfig());

  assert.equal(r.ok, true);
  assert.equal(r.loggedIn, true);
  assert.equal(r.identity, "toko uji");
  // Jendela ditutup, profil dilepas — tapi SESINYA tetap di disk untuk AutoPIN.
  assert.equal(f.isOpen(), false);
  assert.equal(ownership.isFree(), true);
  assert.equal(flow.describe().active, false);
});

test("hasil check TIDAK PERNAH memuat cookie, token, atau sesi", async () => {
  const { f, flow } = loginWith({ pageUrl: "https://www.tiktok.com/login" });
  await flow.start(goodConfig());
  f.setUrl(DASHBOARD);
  const r = await flow.check(goodConfig());

  // Bentuk TERTUTUP: hanya ok/loggedIn/identity.
  assert.deepEqual(Object.keys(r).sort(), ["identity", "loggedIn", "ok"]);
  const raw = JSON.stringify(r);
  for (const leak of ["cookie", "token", "session", "password", "autopin-profile", "ws://", "devtools"]) {
    assert.ok(!raw.toLowerCase().includes(leak.toLowerCase()), leak + " tidak boleh keluar");
  }
});

test("AKUN YANG SALAH ditolak, dan tidak diterima diam-diam", async () => {
  // Pin mengklik produk di akun yang sedang login. Akun lain berarti mengubah LIVE
  // milik orang lain.
  const { f, flow, ownership } = loginWith({ identity: ["toko orang lain"] });
  await flow.start(goodConfig());
  f.setUrl(DASHBOARD);

  const r = await flow.check(goodConfig());
  assert.equal(r.ok, false);
  assert.equal(r.reason, "wrong-tiktok-account");
  assert.equal(r.identity, "toko orang lain", "dilaporkan apa adanya");
  // Jendela ditutup supaya customer bisa keluar dan masuk dengan akun yang benar.
  assert.equal(f.isOpen(), false);
  assert.equal(ownership.isFree(), true);
});

test("toko TERLARANG juga ditolak", async () => {
  // Gerbang yang sama dengan jalur pin: nama toko produksi tidak pernah lolos.
  const { f, flow } = loginWith({ identity: ["garudafood official"] });
  await flow.start(goodConfig());
  f.setUrl(DASHBOARD);
  assert.equal((await flow.check(goodConfig())).reason, "wrong-tiktok-account");
});

test("expectedShop belum diisi: ditolak, bukan dilewati", async () => {
  const cfg = goodConfig();
  cfg.settings.expectedShop = "";
  const { f, flow } = loginWith({});
  await flow.start(cfg);
  f.setUrl(DASHBOARD);
  assert.equal((await flow.check(cfg)).reason, "expected-shop-not-configured");
});

test("identitas belum terbaca: belum selesai", async () => {
  const { f, flow } = loginWith({ identity: [] });
  await flow.start(goodConfig());
  f.setUrl(DASHBOARD);
  const r = await flow.check(goodConfig());
  assert.equal(r.reason, "login-not-finished");
  assert.equal(flow.describe().active, true, "jendela tetap terbuka");
});

test("jendela yang ditutup customer dilaporkan, dan profil dilepas", async () => {
  const { f, flow, ownership } = loginWith({});
  await flow.start(goodConfig());
  f.closeWindow();

  const r = await flow.check(goodConfig());
  assert.equal(r.ok, false);
  assert.equal(r.reason, "login-window-closed");
  assert.equal(ownership.isFree(), true);
});

test("check tanpa login yang berjalan ditolak", async () => {
  const { flow } = loginWith({});
  assert.equal((await flow.check(goodConfig())).reason, "login-not-in-progress");
});

test("cancel menutup jendela dan melepas profil", async () => {
  const { f, flow, ownership } = loginWith({});
  await flow.start(goodConfig());

  const r = await flow.cancel();
  assert.equal(r.ok, true);
  assert.equal(r.cancelled, true);
  assert.equal(f.isOpen(), false);
  assert.equal(ownership.isFree(), true);
  assert.equal(flow.describe().active, false);
});

test("cancel saat tidak ada login: idempoten", async () => {
  const { flow } = loginWith({});
  const r = await flow.cancel();
  assert.equal(r.ok, true);
  assert.equal(r.cancelled, false);
});

test("cleanup membereskan jendela yang tertinggal", async () => {
  const { f, flow, ownership } = loginWith({});
  await flow.start(goodConfig());
  await flow.cleanup("shutdown");
  assert.equal(f.isOpen(), false);
  assert.equal(ownership.isFree(), true);
});

test("tanpa dependensi: melaporkan tidak terkonfigurasi, tidak membuka apa pun", async () => {
  const flow = createLoginFlow({ ownership: createProfileOwnership() });
  assert.equal((await flow.start(goodConfig())).reason, "login-not-configured");
});

test("describe() tidak pernah memuat path profil maupun rahasia", async () => {
  const { f, flow } = loginWith({});
  await flow.start(goodConfig());
  const d = flow.describe();
  assert.deepEqual(Object.keys(d).sort(), ["active", "identity", "profileOwner", "startedAt", "state"]);
  assert.ok(!JSON.stringify(d).includes(".autopin-profile"));
});

// --- integrasi dengan Controller --------------------------------------------

function harnessWithLogin(opts = {}) {
  const f = fakeBrowser(opts.browser || {});
  const SCENES = ["MAIN", "PAX-1", "PAX-2", "PAX-3"];
  const CAT = [{ title: "O'CORN Sea Salt 80gr", number: 1, pinAvailable: true }];
  const cfg = opts.config || (() => {
    const c = goodConfig();
    c.mappings = [{ scene: "PAX-1", product: { title: "O'CORN Sea Salt" }, triggers: ["etalase satu"], reply: "ok" }];
    return c;
  })();

  const h = createHarness({
    config: cfg,
    playableScenes: ["PAX-1", "PAX-2", "PAX-3"],
    obsDiscovery: { listScenes: async () => ({ ok: true, connected: true, scenes: SCENES }) },
    tiktokDiscovery: {
      products: async () => ({ ok: true, count: CAT.length, products: CAT, livePinControlsAvailable: true }),
      status: async () => ({ ok: true, identity: "toko uji", identityOk: true, live: true, dashboardReady: true, chatReady: null, productCount: 1 }),
    },
    loginDeps: f.deps,
  });
  return { h, f };
}

test("Controller: login hanya saat automation BERHENTI", async () => {
  const { h } = harnessWithLogin();
  await h.controller.startAutomation();
  assert.equal(h.controller.state(), STATES.RUNNING);

  const r = await h.controller.startTikTokLogin();
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "login-unavailable-while-running");
  assert.equal(r.error.userMessage, "Stop the automation first. You can only sign in while it is stopped.");
});

test("Controller: START ditolak selagi login aktif, dan NOL proses menyala", async () => {
  const { h } = harnessWithLogin({ browser: { pageUrl: "https://www.tiktok.com/login" } });
  const login = await h.controller.startTikTokLogin();
  assert.equal(login.ok, true);

  const started = await h.controller.startAutomation();
  assert.equal(started.ok, false);
  assert.equal(started.error.code, "login-in-progress");
  assert.equal(h.world.spawned.length, 0, "tidak boleh ada yang dinyalakan");
  assert.equal(h.controller.state(), STATES.STOPPED);
});

test("Controller: discovery produk ditolak selagi login aktif", async () => {
  const { h } = harnessWithLogin({ browser: { pageUrl: "https://www.tiktok.com/login" } });
  await h.controller.startTikTokLogin();

  const r = await h.controller.discoverTikTokProducts();
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "discovery-unavailable-during-login");
});

test("Controller: sesudah login dibatalkan, Start boleh lagi", async () => {
  const { h } = harnessWithLogin({ browser: { pageUrl: "https://www.tiktok.com/login" } });
  await h.controller.startTikTokLogin();
  await h.controller.cancelTikTokLogin();

  assert.equal(h.controller.status().profile.owner, "none");
  const started = await h.controller.startAutomation();
  assert.equal(started.ok, true, JSON.stringify(started.error || {}));
});

test("Controller: login berhasil melepas profil dan Start jalan", async () => {
  const { h, f } = harnessWithLogin({ browser: { pageUrl: "https://www.tiktok.com/login" } });
  await h.controller.startTikTokLogin();
  f.setUrl(DASHBOARD);

  const checked = await h.controller.checkTikTokLogin();
  assert.equal(checked.ok, true);
  assert.equal(checked.identity, "toko uji");
  assert.equal(h.controller.status().profile.owner, "none");

  const started = await h.controller.startAutomation();
  assert.equal(started.ok, true);
});

test("Controller: /api/status melaporkan login tanpa rahasah apa pun", async () => {
  const { h } = harnessWithLogin({ browser: { pageUrl: "https://www.tiktok.com/login" } });
  await h.controller.startTikTokLogin();
  const st = h.controller.status();

  assert.equal(st.login.active, true);
  assert.equal(st.profile.owner, "login");
  const raw = JSON.stringify(st);
  for (const leak of ["cookie", "token", "password", "autopin-profile", "rahasia-obs"]) {
    assert.ok(!raw.toLowerCase().includes(leak.toLowerCase()), leak);
  }
});

test("Controller: shutdown membereskan jendela login yang terbuka", async () => {
  const { h, f } = harnessWithLogin({ browser: { pageUrl: "https://www.tiktok.com/login" } });
  await h.controller.startTikTokLogin();
  assert.equal(f.isOpen(), true);

  await h.controller.shutdown();
  // Jendela login juga milik Controller. Membiarkannya berarti meninggalkan Chrome
  // yang memegang profil sesudah Controller mati.
  assert.equal(f.isOpen(), false);
  assert.equal(h.controller.status().profile.owner, "none");
});

test("Controller: automation memegang profil selama RUNNING", async () => {
  const { h } = harnessWithLogin();
  await h.controller.startAutomation();
  assert.equal(h.controller.status().profile.owner, "automation");

  await h.controller.stopAutomation();
  assert.equal(h.controller.status().profile.owner, "none");
});

test("Controller: start yang GAGAL melepas profil kembali", async () => {
  const { h } = harnessWithLogin({});
  // Bot tidak pernah mengucapkan TIKTOK_CONNECTED -> readiness timeout -> rollback.
  const h2 = createHarness({
    config: (() => {
      const c = goodConfig();
      c.mappings = [{ scene: "PAX-1", product: { title: "O'CORN Sea Salt" }, triggers: ["etalase satu"], reply: "ok" }];
      return c;
    })(),
    autoBotConnected: false,
    playableScenes: ["PAX-1", "PAX-2", "PAX-3"],
    obsDiscovery: { listScenes: async () => ({ ok: true, connected: true, scenes: ["MAIN", "PAX-1"] }) },
    tiktokDiscovery: {
      products: async () => ({ ok: true, count: 1, products: [{ title: "O'CORN Sea Salt 80gr", number: 1, pinAvailable: true }], livePinControlsAvailable: true }),
      status: async () => ({ ok: true, identity: "toko uji", identityOk: true, live: true, dashboardReady: true, chatReady: null, productCount: 1 }),
    },
  });

  const r = await h2.controller.startAutomation();
  assert.equal(r.ok, false);
  assert.equal(h2.world.liveCount(), 0);
  // Profil harus bebas lagi: service sudah mati, jadi tidak ada yang memegangnya.
  assert.equal(h2.controller.status().profile.owner, "none");
});
