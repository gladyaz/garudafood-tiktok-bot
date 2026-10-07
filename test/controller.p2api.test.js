// Endpoint P2 lewat HTTP sungguhan: discovery, validasi pemetaan, dan
// restartRequired.
//
// Server express-nya nyata dan mendengarkan di 127.0.0.1 pada port sementara;
// semua yang di belakangnya palsu. Nol TikTok, nol OBS, nol browser, nol proses.
//
// Yang paling keras diuji: tidak ada rahasia yang keluar lewat endpoint baru.
// /api/tiktok/products memuat katalog produk, dan /api/obs/scenes memuat daftar
// scene — keduanya akan tampil di UI yang bisa ada di layar yang sedang di-share
// saat LIVE. Password OBS, cookie, token, path profil browser, dan struktur DOM
// internal TikTok tidak boleh ikut.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createServer } = require("../controller/server");
const { createHarness, goodConfig } = require("./helpers/controller-harness");

const SCENES = ["MAIN", "PAX-1", "PAX-2", "PAX-3"];
const CATALOGUE = [
  { title: "O'CORN Sea Salt 80gr", number: 1, price: "Rp10.000", stock: "Stok 50", pinText: "Pin", pinAvailable: true, pinDisabled: false, stableId: null },
  { title: "Dilan Cookies Choco Chip", number: 2, price: "Rp12.000", stock: "Stok 20", pinText: "Unpin", pinAvailable: true, pinDisabled: false, stableId: null },
];

function configForCatalogue() {
  const c = goodConfig();
  c.mappings = [
    { scene: "PAX-1", product: { title: "O'CORN Sea Salt" }, triggers: ["etalase satu"], reply: "Etalase 1 sudah aku pin ya kak" },
    { scene: "PAX-2", product: { title: "Dilan Cookies" }, triggers: ["etalase dua"], reply: "Etalase 2 sudah aku pin ya kak" },
  ];
  return c;
}

function fakeDiscovery({ scenes = SCENES, products = CATALOGUE, obsFail = null, tiktokFail = null } = {}) {
  return {
    obsDiscovery: {
      listScenes: async () =>
        obsFail ? { ok: false, connected: false, reason: obsFail } : { ok: true, connected: true, scenes },
    },
    tiktokDiscovery: {
      products: async () =>
        tiktokFail
          ? { ok: false, reason: tiktokFail }
          : { ok: true, count: products.length, products, livePinControlsAvailable: true },
      status: async () =>
        tiktokFail
          ? { ok: false, reason: tiktokFail }
          : { ok: true, identity: "toko uji", identityOk: true, live: true, dashboardReady: true, chatReady: null, productCount: products.length },
    },
  };
}

async function withServer(overrides, fn) {
  const h = createHarness(
    Object.assign({ config: configForCatalogue(), playableScenes: ["PAX-1", "PAX-2", "PAX-3"] }, fakeDiscovery(overrides.discovery || {}), overrides)
  );
  const server = createServer({ controller: h.controller });
  const addr = await server.start({ port: 0 });
  const base = "http://127.0.0.1:" + addr.port;
  try {
    await fn({ base, h, addr });
  } finally {
    await h.controller.stopAutomation().catch(() => {});
    await server.stop();
  }
}

async function get(base, p) {
  const res = await fetch(base + p);
  return { status: res.status, body: await res.json() };
}
async function send(base, p, method, body) {
  const res = await fetch(base + p, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// --- /api/obs/scenes ---------------------------------------------------------

test("GET /api/obs/scenes mengembalikan daftar scene", async () => {
  await withServer({}, async ({ base }) => {
    const { status, body } = await get(base, "/api/obs/scenes");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.connected, true);
    assert.deepEqual(body.scenes, SCENES);
  });
});

test("GET /api/obs/scenes saat OBS mati: 200 dengan kalimat untuk manusia", async () => {
  // "OBS tidak nyala" adalah jawaban yang sah untuk pertanyaan "scene apa saja
  // yang ada", bukan kesalahan server.
  await withServer({ discovery: { obsFail: "obs-unavailable" } }, async ({ base }) => {
    const { status, body } = await get(base, "/api/obs/scenes");
    assert.equal(status, 200);
    assert.equal(body.ok, false);
    assert.equal(body.connected, false);
    assert.equal(body.error.code, "obs-unavailable");
    assert.equal(body.error.userMessage, "OBS is not connected.");
  });
});

test("GET /api/obs/scenes membedakan password salah dari OBS mati", async () => {
  await withServer({ discovery: { obsFail: "obs-auth-failed" } }, async ({ base }) => {
    const { body } = await get(base, "/api/obs/scenes");
    assert.equal(body.error.code, "obs-auth-failed");
    assert.equal(body.error.userMessage, "OBS rejected the password.");
  });
});

test("GET /api/obs/scenes tidak membocorkan password OBS", async () => {
  await withServer({}, async ({ base }) => {
    const { body } = await get(base, "/api/obs/scenes");
    const raw = JSON.stringify(body);
    assert.ok(!raw.includes("rahasia-obs"));
    assert.ok(!/password/i.test(raw));
  });
});

// --- /api/tiktok/status ------------------------------------------------------

test("GET /api/tiktok/status melaporkan identitas, LIVE, dan kesiapan", async () => {
  await withServer({}, async ({ base }) => {
    const { status, body } = await get(base, "/api/tiktok/status");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.identity, "toko uji");
    assert.equal(body.identityOk, true);
    assert.equal(body.live, true);
    assert.equal(body.dashboardReady, true);
    assert.equal(body.chatReady, null);
    assert.equal(body.productCount, 2);
  });
});

test("GET /api/tiktok/status: belum login dilaporkan dengan kalimat yang bisa ditindaklanjuti", async () => {
  await withServer({ discovery: { tiktokFail: "tiktok-not-logged-in" } }, async ({ base }) => {
    const { body } = await get(base, "/api/tiktok/status");
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "tiktok-not-logged-in");
    assert.equal(body.error.userMessage, "You are not signed in to TikTok. Sign in once, then try again.");
  });
});

test("GET /api/tiktok/status: akun salah dilaporkan", async () => {
  await withServer({ discovery: { tiktokFail: "wrong-tiktok-account" } }, async ({ base }) => {
    const { body } = await get(base, "/api/tiktok/status");
    assert.equal(body.error.code, "wrong-tiktok-account");
  });
});

// --- /api/tiktok/products ----------------------------------------------------

test("GET /api/tiktok/products mengembalikan katalog terstruktur", async () => {
  await withServer({}, async ({ base }) => {
    const { status, body } = await get(base, "/api/tiktok/products");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.count, 2);
    assert.equal(body.products[0].title, "O'CORN Sea Salt 80gr");
    assert.equal(body.products[0].number, 1);
    assert.equal(body.products[0].stableId, null);
    assert.equal(body.livePinControlsAvailable, true);
  });
});

test("GET /api/tiktok/products: tanpa produk LIVE -> kalimat yang jelas", async () => {
  await withServer({ discovery: { tiktokFail: "no-live-products" } }, async ({ base }) => {
    const { body } = await get(base, "/api/tiktok/products");
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "no-live-products");
    assert.equal(body.error.userMessage, "No LIVE products detected.");
    assert.deepEqual(body.products, []);
  });
});

test("GET /api/tiktok/products TIDAK membocorkan rahasia maupun DOM internal", async () => {
  await withServer({}, async ({ base }) => {
    const { body } = await get(base, "/api/tiktok/products");

    // Diperiksa STRUKTURAL, bukan dengan mencari kata terlarang di teks.
    // Pencarian kata gagal ke dua arah: ia melewatkan rahasia yang namanya tidak
    // ada di daftar, dan ia salah menuduh isi yang sah — judul produk "Dilan
    // Cookies Choco Chip" mengandung "cookie" tanpa ada cookie di dalamnya.
    assert.deepEqual(Object.keys(body).sort(), ["count", "livePinControlsAvailable", "ok", "products"]);
    for (const p of body.products) {
      assert.deepEqual(Object.keys(p).sort(), [
        "number", "pinAvailable", "pinDisabled", "pinText", "price", "stableId", "stock", "title",
      ]);
    }

    // Dan nilai rahasia yang memang ada di config tidak boleh ikut.
    const raw = JSON.stringify(body);
    assert.ok(!raw.includes("rahasia-obs"), "password OBS tidak boleh keluar");
    assert.ok(!raw.includes(".autopin-profile"), "path profil browser tidak boleh keluar");
  });
});

test("discovery TIDAK TERSEDIA saat automation berjalan", async () => {
  // Profil Chrome terkunci satu proses, dan saat automation berjalan service yang
  // memegangnya. Memaksa membuka browser kedua dengan profil yang sama berisiko
  // merusak sesi login yang sedang dipakai memin produk sungguhan di tengah LIVE.
  await withServer({}, async ({ base, h }) => {
    const started = await send(base, "/api/start", "POST");
    assert.equal(started.body.ok, true);

    for (const p of ["/api/tiktok/status", "/api/tiktok/products"]) {
      const { body } = await get(base, p);
      assert.equal(body.ok, false, p);
      assert.equal(body.error.code, "discovery-unavailable-while-running", p);
      assert.equal(body.error.userMessage, "Stop the automation first. Products can only be read while it is stopped.");
    }

    // OBS tetap boleh dibaca: ia tidak memakai profil browser.
    const obs = await get(base, "/api/obs/scenes");
    assert.equal(obs.body.ok, true, "discovery OBS tidak terhalang profil");
  });
});

test("tanpa adapter discovery: dilaporkan tidak tersedia, bukan melempar", async () => {
  const h = createHarness({ config: configForCatalogue() });
  const server = createServer({ controller: h.controller });
  const addr = await server.start({ port: 0 });
  try {
    for (const p of ["/api/obs/scenes", "/api/tiktok/status", "/api/tiktok/products"]) {
      const { status, body } = await get("http://127.0.0.1:" + addr.port, p);
      assert.equal(status, 200, p);
      assert.equal(body.ok, false, p);
      assert.equal(body.error.code, "discovery-not-configured", p);
    }
  } finally {
    await server.stop();
  }
});

// --- /api/mappings/validate --------------------------------------------------

test("POST /api/mappings/validate: pemetaan benar -> ok, dan menyebut apa yang diperiksa", async () => {
  await withServer({}, async ({ base }) => {
    const { status, body } = await send(base, "/api/mappings/validate", "POST");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    // "ok" tidak boleh terbaca lebih kuat dari yang sebenarnya.
    assert.deepEqual(body.checked, { obsScenes: true, products: true });
    assert.equal(body.mappings.length, 2);
  });
});

test("POST /api/mappings/validate: produk tidak ada -> baris yang salah disebutkan", async () => {
  const cfg = configForCatalogue();
  cfg.mappings[0].product.title = "Produk Hantu";
  await withServer({ config: cfg }, async ({ base }) => {
    const { body } = await send(base, "/api/mappings/validate", "POST");
    assert.equal(body.ok, false);
    assert.equal(body.mappings[0].ok, false);
    assert.equal(body.mappings[0].reason, "product-not-found");
    assert.equal(body.mappings[0].scene, "PAX-1");
    // Baris yang benar tetap dilaporkan benar.
    assert.equal(body.mappings[1].ok, true);
  });
});

test("POST /api/mappings/validate: judul yang BENAR-BENAR terlihat di LIVE ikut", async () => {
  await withServer({}, async ({ base }) => {
    const { body } = await send(base, "/api/mappings/validate", "POST");
    assert.equal(body.mappings[0].resolvedTitle, "O'CORN Sea Salt 80gr");
    assert.equal(body.mappings[0].resolvedNumber, 1);
  });
});

test("POST /api/mappings/validate hanya loopback", async () => {
  await withServer({}, async ({ base }) => {
    // Jalur loopback bekerja; penolakan non-loopback diuji di
    // test/controller.api.test.js lewat pengikatan socket.
    const { status } = await send(base, "/api/mappings/validate", "POST");
    assert.equal(status, 200);
  });
});

// --- generasi config runtime -------------------------------------------------

test("KEDUA anak menerima generasi config runtime YANG SAMA", async () => {
  await withServer({}, async ({ base, h }) => {
    await send(base, "/api/start", "POST");

    const svc = h.world.liveByScript("autopin-service.js")[0];
    const bot = h.world.liveByScript("index.js")[0];
    const { RUNTIME_CONFIG_ENV } = require("../runtime/runtime-config");

    const svcPath = svc.spawnEnv[RUNTIME_CONFIG_ENV];
    const botPath = bot.spawnEnv[RUNTIME_CONFIG_ENV];
    assert.equal(typeof svcPath, "string");
    // Satu berkas, satu generasi. Dua path berbeda adalah cara paling rapi untuk
    // sampai ke bot dan service yang memetakan produk berbeda untuk scene sama.
    assert.equal(svcPath, botPath);

    const artifact = JSON.parse(h.fs.files.get(svcPath));
    assert.equal(artifact.id, h.controller.runtimeConfigId());
    assert.equal(svcPath.includes(artifact.id), true, "nama berkas memuat generasinya");
  });
});

test("/api/status mengekspos runtimeConfigId, tanpa path dan tanpa isi", async () => {
  await withServer({}, async ({ base, h }) => {
    await send(base, "/api/start", "POST");
    const { body } = await get(base, "/api/status");

    assert.equal(body.runtimeConfigId, h.controller.runtimeConfigId());
    assert.equal(typeof body.runtimeConfigId, "string");
    // Versi skema config customer, di tingkat atas dan di ringkasan config.
    assert.equal(body.configVersion, 1);
    assert.equal(body.config.version, 1);

    const raw = JSON.stringify(body);
    // Path artefak adalah path di disk milik mesin operator.
    assert.ok(!raw.includes(".runtime"), "path artefak tidak boleh diekspos");
    // Dan isi pemetaannya juga bukan urusan /api/status.
    assert.ok(!raw.includes("O'CORN"), "judul produk tidak perlu ada di status");
    assert.ok(!raw.includes("etalase satu"), "trigger tidak perlu ada di status");
  });
});

test("runtimeConfigId null sebelum start, dan null lagi sesudah stop", async () => {
  await withServer({}, async ({ base, h }) => {
    assert.equal((await get(base, "/api/status")).body.runtimeConfigId, null);

    await send(base, "/api/start", "POST");
    assert.equal(typeof (await get(base, "/api/status")).body.runtimeConfigId, "string");

    await send(base, "/api/stop", "POST");
    assert.equal((await get(base, "/api/status")).body.runtimeConfigId, null);
  });
});

test("artefak config runtime DIHAPUS saat Stop", async () => {
  await withServer({}, async ({ base, h }) => {
    await send(base, "/api/start", "POST");
    const file = h.controller.runtimeConfigFile();
    assert.equal(h.fs.files.has(file), true);

    await send(base, "/api/stop", "POST");
    // Artefak hanya berlaku untuk satu run. Membiarkannya berarti run berikutnya
    // bisa menemukan berkas lama dan generasi mana yang dipakai jadi pertanyaan.
    assert.equal(h.fs.files.has(file), false);
  });
});

test("artefak DIHAPUS juga saat start gagal di tengah jalan", async () => {
  await withServer({ autoBotConnected: false }, async ({ base, h }) => {
    const r = await send(base, "/api/start", "POST");
    assert.equal(r.body.ok, false);
    // Tidak ada berkas artefak yang tertinggal.
    const leftover = [...h.fs.files.keys()].filter((k) => k.includes(".runtime"));
    assert.deepEqual(leftover, []);
    assert.equal(h.world.liveCount(), 0);
  });
});

test("start ulang menghasilkan artefak baru untuk pemetaan yang berubah", async () => {
  await withServer({}, async ({ base, h }) => {
    await send(base, "/api/start", "POST");
    const first = h.controller.runtimeConfigId();
    await send(base, "/api/stop", "POST");

    const cfg = configForCatalogue();
    cfg.mappings[0].triggers = ["etalase satu", "trigger baru"];
    await send(base, "/api/config", "PUT", cfg);
    await send(base, "/api/start", "POST");

    assert.notEqual(h.controller.runtimeConfigId(), first, "pemetaan berubah -> generasi berubah");
  });
});

// --- restartRequired ---------------------------------------------------------

test("PUT /api/config saat RUNNING -> restartRequired, dan snapshot TIDAK berubah", async () => {
  await withServer({}, async ({ base, h }) => {
    await send(base, "/api/start", "POST");
    const generationBefore = h.controller.runtimeConfigId();
    const fileBefore = h.controller.runtimeConfigFile();
    const contentBefore = h.fs.files.get(fileBefore);

    const cfg = configForCatalogue();
    cfg.mappings[0].reply = "kalimat yang benar-benar baru";
    const put = await send(base, "/api/config", "PUT", cfg);

    assert.equal(put.status, 200);
    assert.equal(put.body.ok, true, "config tetap tersimpan");
    assert.equal(put.body.restartRequired, true);
    assert.equal(put.body.notice.userMessage, "Your changes are saved. Restart the automation to use them.");

    // Snapshot yang SEDANG dipakai tidak disentuh. Satu pemutaran tidak boleh
    // berpindah trigger atau balasan di tengah jalan.
    assert.equal(h.controller.runtimeConfigId(), generationBefore);
    assert.equal(h.controller.runtimeConfigFile(), fileBefore);
    assert.equal(h.fs.files.get(fileBefore), contentBefore, "artefak tidak boleh ditulis ulang");
  });
});

test("/api/status melaporkan restartRequired sesudah config disimpan saat RUNNING", async () => {
  await withServer({}, async ({ base }) => {
    await send(base, "/api/start", "POST");
    assert.equal((await get(base, "/api/status")).body.restartRequired, false);

    await send(base, "/api/config", "PUT", configForCatalogue());
    assert.equal((await get(base, "/api/status")).body.restartRequired, true);
  });
});

test("PUT /api/config saat STOPPED tidak meminta restart", async () => {
  await withServer({}, async ({ base }) => {
    const put = await send(base, "/api/config", "PUT", configForCatalogue());
    assert.equal(put.body.restartRequired, false);
    assert.equal("notice" in put.body, false);
  });
});

test("restartRequired direset sesudah Stop", async () => {
  await withServer({}, async ({ base }) => {
    await send(base, "/api/start", "POST");
    await send(base, "/api/config", "PUT", configForCatalogue());
    assert.equal((await get(base, "/api/status")).body.restartRequired, true);

    await send(base, "/api/stop", "POST");
    // Sudah berhenti: tidak ada lagi yang perlu di-restart.
    assert.equal((await get(base, "/api/status")).body.restartRequired, false);
  });
});

test("config TIDAK VALID saat RUNNING tetap ditolak dan tidak meminta restart", async () => {
  await withServer({}, async ({ base, h }) => {
    await send(base, "/api/start", "POST");
    const bad = configForCatalogue();
    bad.mappings[0].product = { title: "" };

    const put = await send(base, "/api/config", "PUT", bad);
    assert.equal(put.status, 400);
    assert.equal(put.body.ok, false);
    assert.equal("restartRequired" in put.body, false);
    // Dan status tidak berubah jadi "perlu restart" karena tidak ada yang berubah.
    assert.equal((await get(base, "/api/status")).body.restartRequired, false);
  });
});

// --- preflight dengan discovery ---------------------------------------------

test("POST /api/preflight menyertakan check mappings", async () => {
  await withServer({}, async ({ base }) => {
    const { body } = await send(base, "/api/preflight", "POST");
    assert.equal(body.ok, true);
    assert.equal(body.checks.mappings.ok, true);
    assert.equal(body.checks.mappings.count, 2);
  });
});

test("POST /api/preflight: pemetaan salah membuat preflight merah dan menyebut barisnya", async () => {
  const cfg = configForCatalogue();
  cfg.mappings[1].product.title = "Produk Hantu";
  await withServer({ config: cfg }, async ({ base }) => {
    const { body } = await send(base, "/api/preflight", "POST");
    assert.equal(body.ok, false);
    assert.equal(body.checks.mappings.ok, false);
    assert.equal(body.checks.mappings.mappings[0].scene, "PAX-2");
    assert.equal(body.checks.mappings.mappings[0].reason, "product-not-found");
  });
});

test("POST /api/preflight TIDAK menyalakan apa pun", async () => {
  await withServer({}, async ({ base, h }) => {
    await send(base, "/api/preflight", "POST");
    assert.equal(h.world.spawned.length, 0);
    // Dan tidak menulis artefak config runtime.
    assert.deepEqual([...h.fs.files.keys()].filter((k) => k.includes(".runtime")), []);
  });
});
