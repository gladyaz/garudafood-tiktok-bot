// Dashboard yang disajikan Controller, dan alur UI lewat HTTP SUNGGUHAN.
//
// Server express-nya nyata dan mendengarkan di 127.0.0.1 pada port sementara;
// semua yang di belakangnya palsu (child process palsu, fs palsu, discovery
// di-inject). Nol TikTok, nol OBS, nol browser, nol proses nyata.
//
// Berkas ini menguji dua hal yang tidak bisa dijangkau tes logika murni:
//
//   1. Berkas statis benar-benar tersaji, dan halamannya menunjuk ke berkas yang
//      memang ada. Satu salah ketik di <script src> membuat dashboard kosong
//      tanpa satu pun tes logika jadi merah.
//   2. Urutan panggilan API untuk Start dan Stop, dijalankan persis seperti yang
//      dilakukan app.js — termasuk jaminan bahwa /api/start TIDAK dipanggil saat
//      preflight merah.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const I18N = require("../controller/public/i18n.js");
const T = (key, vars) => I18N.t("id", key, vars);
const fs = require("node:fs");
const path = require("node:path");

const { createServer, PUBLIC_DIR } = require("../controller/server");
const { createHarness, goodConfig } = require("./helpers/controller-harness");

const SCENES = ["MAIN", "PAX-1", "PAX-2", "PAX-3"];
const CATALOGUE = [
  { title: "O'CORN Sea Salt 80gr", number: 1, price: "Rp10.000", stock: "Stok 50", pinText: "Pin", pinAvailable: true, pinDisabled: false, stableId: null },
  { title: "Dilan Cookies Choco Chip", number: 10, price: "Rp12.000", stock: "Stok 20", pinText: "Unpin", pinAvailable: true, pinDisabled: false, stableId: null },
];

function configForCatalogue() {
  const c = goodConfig();
  c.mappings = [
    { scene: "PAX-1", product: { title: "O'CORN Sea Salt" }, triggers: ["spill etalase 1", "etalase satu"], reply: "Etalase 1 sudah aku pin ya kak" },
  ];
  return c;
}

function fakeDiscovery({ scenes = SCENES, products = CATALOGUE, obsFail = null, tiktokFail = null } = {}) {
  return {
    obsDiscovery: {
      listScenes: async () => (obsFail ? { ok: false, connected: false, reason: obsFail } : { ok: true, connected: true, scenes }),
    },
    tiktokDiscovery: {
      products: async () =>
        tiktokFail ? { ok: false, reason: tiktokFail } : { ok: true, count: products.length, products, livePinControlsAvailable: true },
      status: async () =>
        tiktokFail
          ? { ok: false, reason: tiktokFail }
          : { ok: true, identity: "toko uji", identityOk: true, live: true, dashboardReady: true, chatReady: null, productCount: products.length },
    },
  };
}

async function withServer(overrides, fn) {
  const o = overrides || {};
  const h = createHarness(
    Object.assign(
      { config: o.config || configForCatalogue(), playableScenes: ["PAX-1", "PAX-2", "PAX-3"] },
      fakeDiscovery(o.discovery || {}),
      o
    )
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
  return { status: res.status, type: res.headers.get("content-type") || "", headers: res.headers, body: await res.text() };
}
async function getJson(base, p) {
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

// --- penyajian berkas statis ------------------------------------------------

test("GET / menyajikan dashboard", async () => {
  await withServer({}, async ({ base }) => {
    const r = await get(base, "/");
    assert.equal(r.status, 200);
    assert.ok(r.type.includes("text/html"), "type=" + r.type);
    assert.ok(r.body.includes("AI LIVE HOST"));
  });
});

test("berkas statis tersaji dengan tipe yang benar", async () => {
  await withServer({}, async ({ base }) => {
    const css = await get(base, "/styles.css");
    assert.equal(css.status, 200);
    assert.ok(css.type.includes("text/css"), "type=" + css.type);

    for (const js of ["/app.js", "/ui-logic.js"]) {
      const r = await get(base, js);
      assert.equal(r.status, 200, js);
      assert.ok(/javascript/.test(r.type), js + " type=" + r.type);
    }
  });
});

test("halaman menunjuk ke berkas yang MEMANG ADA", async () => {
  // Satu salah ketik di <script src> membuat dashboard kosong tanpa satu pun tes
  // logika jadi merah.
  const html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
  const refs = [];
  html.replace(/(?:src|href)="([^"]+)"/g, (_m, p1) => {
    refs.push(p1);
    return _m;
  });
  assert.ok(refs.length >= 3, "harus ada rujukan css/js: " + refs.join(","));
  for (const ref of refs) {
    assert.ok(!/^https?:/i.test(ref), "tidak boleh ada CDN eksternal: " + ref);
    assert.equal(fs.existsSync(path.join(PUBLIC_DIR, ref)), true, "berkas tidak ada: " + ref);
  }
});

test("berkas statis TIDAK menaungi endpoint /api", async () => {
  await withServer({}, async ({ base }) => {
    const r = await getJson(base, "/api/status");
    assert.equal(r.status, 200);
    assert.equal(typeof r.body.automation, "string");
  });
});

test("path yang tidak dikenal tetap dibalas JSON 404", async () => {
  await withServer({}, async ({ base }) => {
    const r = await get(base, "/tidak-ada-berkas-ini.js");
    assert.equal(r.status, 404);
    assert.ok(r.type.includes("application/json"), "type=" + r.type);
  });
});

test("halaman mengirim Content-Security-Policy yang menolak sumber luar", async () => {
  await withServer({}, async ({ base }) => {
    const r = await get(base, "/");
    const csp = r.headers.get("content-security-policy") || "";
    assert.ok(csp.includes("default-src 'self'"), "csp=" + csp);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  });
});

test("kedua skrip halaman bisa dikompilasi", () => {
  // Tanpa jsdom, ini jaring pertama terhadap salah ketik sintaks: berkas yang
  // tidak bisa dikompilasi membuat dashboard kosong tanpa satu pun tes logika
  // jadi merah.
  const vm = require("node:vm");
  for (const name of ["app.js", "ui-logic.js"]) {
    const src = fs.readFileSync(path.join(PUBLIC_DIR, name), "utf8");
    assert.doesNotThrow(() => new vm.Script(src, { filename: name }), name + " tidak bisa dikompilasi");
  }
});

test("setiap id yang dipakai app.js BENAR-BENAR ada di index.html", () => {
  // Jaring kedua, dan yang paling berguna: satu salah ketik id membuat satu
  // bagian halaman mati tanpa error apa pun di console. Browser akan
  // menemukannya; tanpa browser, tes ini yang menemukannya.
  const app = fs.readFileSync(path.join(PUBLIC_DIR, "app.js"), "utf8");
  const html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");

  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const block = /function cacheEls\(\) \{([\s\S]*?)\]\.forEach/.exec(app);
  assert.ok(block, "daftar cacheEls harus bisa ditemukan");
  const cached = [...block[1].matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);

  assert.ok(cached.length >= 15, "jumlah id terlalu sedikit: " + cached.length);
  const missing = cached.filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, [], "id tidak ada di index.html: " + missing.join(", "));
});

test("setiap elemen yang dirujuk app.js memang di-cache lebih dulu", () => {
  // Arah sebaliknya: el["sesuatu"] yang tidak pernah di-cache selalu undefined,
  // dan baris yang memakainya gagal diam-diam.
  const app = fs.readFileSync(path.join(PUBLIC_DIR, "app.js"), "utf8");
  const cached = [...(/function cacheEls\(\) \{([\s\S]*?)\]\.forEach/.exec(app)[1]).matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);

  const bracket = [...app.matchAll(/\bel\["([a-z0-9-]+)"\]/g)].map((m) => m[1]);
  // Batas kiri perlu: tanpanya, `sceneSel.appendChild` ikut cocok sebagai
  // `el.appendChild` dan tesnya melaporkan kesalahan yang tidak ada.
  const dot = [...app.matchAll(/(?<![A-Za-z0-9_$])el\.([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1]);

  const used = [...new Set(bracket.concat(dot))];
  const notCached = used.filter((k) => !cached.includes(k));
  assert.deepEqual(notCached, [], "dirujuk tapi tidak di-cache: " + notCached.join(", "));
});

test("app.js tidak mengambil keputusan: semuanya lewat AiLiveUI", () => {
  // Kontrak arsitektur P3. Kalau logika mulai pindah ke app.js, ia keluar dari
  // jangkauan tes — dan repo ini tidak punya jsdom untuk menangkapnya.
  const app = fs.readFileSync(path.join(PUBLIC_DIR, "app.js"), "utf8");

  // Keputusan tombol dan batas activity tidak boleh DIDEFINISIKAN di sini.
  // Memakai nilainya dari modul logika (U.MAX_ACTIVITY_ITEMS) justru yang benar:
  // itu satu sumber yang sama dengan yang dipakai saat memotong daftar.
  assert.ok(!/startEnabled\s*=/.test(app), "aturan tombol harus di ui-logic.js");
  assert.ok(!/(?<!U\.)MAX_ACTIVITY_ITEMS\s*=/.test(app), "batas activity harus didefinisikan di ui-logic.js");
  // Memotong DAFTAR tetap dilarang di sini. Dua huruf pertama nama akun untuk
  // inisial chip bukan pemotongan daftar, jadi yang diperiksa adalah APA yang
  // dipotong — bukan polanya saja, yang akan merah karena hal yang sah lalu
  // dilemahkan orang berikutnya.
  const sliced = [...app.matchAll(/(\w+)\.slice\(0,\s*\d+\)/g)].map((m) => m[1]);
  assert.deepEqual(sliced.filter((v) => v !== "name"), [], "pemotongan daftar harus di ui-logic.js");
  // Dan app.js memang memakai modul logika itu.
  assert.ok(/U\.controlsFor\(/.test(app));
  assert.ok(/U\.activityItems\(/.test(app));
  assert.ok(/U\.applySuggestion\(/.test(app));
});

test("tidak ada rahasia di berkas statis mana pun", async () => {
  // Berkas-berkas ini dikirim apa adanya ke browser.
  //
  // Yang dilarang adalah NAMA VARIABEL ENVIRONMENT internal dan PATH di disk —
  // bukan kata "password" di mana pun. Sejak P4.1 formulir Settings memang punya
  // field bernama `obsPassword`, dan itu nama field formulir, bukan rahasia:
  // nilainya tidak pernah dikirim server ke halaman (hanya `passwordSet`).
  //
  // Membedakan keduanya penting. Tes yang melarang kata "password" akan merah
  // karena nama field yang sah, lalu orang akan melemahkannya — dan yang hilang
  // adalah penjagaan terhadap kebocoran yang sesungguhnya.
  for (const name of ["index.html", "app.js", "ui-logic.js", "styles.css"]) {
    const src = fs.readFileSync(path.join(PUBLIC_DIR, name), "utf8");
    assert.ok(!/OBS_PASSWORD/.test(src), name + " tidak boleh menyebut nama env OBS_PASSWORD");
    assert.ok(!/\.autopin-profile/.test(src), name + " tidak boleh menyebut path profil");
    assert.ok(!/AUTOPIN_PRODUCT_|AILIVE_RUNTIME_CONFIG/.test(src), name + " tidak boleh menyebut env internal");
    assert.ok(!/data\/config\.json/.test(src), name + " tidak boleh menyebut path config");
  }
});

test("berkas statis tidak memuat satu pun NILAI rahasia", async () => {
  // Arah sebaliknya, dan yang sesungguhnya penting: tidak ada nilai yang terlihat
  // seperti kredensial yang di-hardcode ke halaman.
  for (const name of ["index.html", "app.js", "ui-logic.js"]) {
    const src = fs.readFileSync(path.join(PUBLIC_DIR, name), "utf8");
    // Tidak ada penugasan literal ke field password.
    assert.ok(!/password\s*[:=]\s*["'][^"']+["']/i.test(src), name + " tidak boleh menetapkan nilai password");
    // Dan tidak ada token/cookie/sesi yang disimpan di browser. localStorage
    // hanya boleh muncul di app.js, tepat sekali, sebagai suntikan ke prefs.js
    // untuk bahasa dan tema; ui-logic.js dan halaman tidak menyentuhnya sama
    // sekali.
    assert.ok(!/sessionStorage|document\.cookie/.test(src), name);
    // Dihitung dari KODE saja: berkas-berkas ini menjelaskan di komentarnya
    // mengapa penyimpanan itu hanya dipakai untuk bahasa dan tema, dan
    // penjelasan bukan pemakaian.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split(/\r?\n/)
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join("\n");
    const stores = (code.match(/localStorage/g) || []).length;
    assert.equal(stores, name === "app.js" ? 1 : 0, name + ": localStorage");
  }
});

test("frontend tidak pernah meminta password OBS, dan server tidak mengirimnya", async () => {
  await withServer({}, async ({ base }) => {
    const r = await getJson(base, "/api/config");
    assert.equal(r.body.ok, true);
    assert.equal("password" in r.body.config.obs, false);
    assert.equal(r.body.config.obs.passwordSet, true);
    assert.ok(!JSON.stringify(r.body).includes("rahasia-obs"));
  });
});

// --- kalimat untuk customer datang dari server ------------------------------

test("/api/mappings/validate mengirim userMessage per baris", async () => {
  const cfg = configForCatalogue();
  cfg.mappings[0].product.title = "Produk Hantu";
  await withServer({ config: cfg }, async ({ base }) => {
    const r = await send(base, "/api/mappings/validate", "POST");
    assert.equal(r.body.ok, false);
    assert.equal(r.body.mappings[0].reason, "product-not-found");
    // Inilah yang ditampilkan UI; ia tidak membentuk kalimat sendiri.
    assert.equal(r.body.mappings[0].userMessage, "The mapped product was not found in the LIVE product list.");
  });
});

test("/api/preflight mengirim userMessage untuk tiap check yang merah", async () => {
  await withServer({ discovery: { obsFail: "obs-unavailable" } }, async ({ base }) => {
    const r = await send(base, "/api/preflight", "POST");
    assert.equal(r.body.ok, false);
    assert.equal(r.body.checks.obs.userMessage, "OBS is not connected.");
    // Check yang hijau tidak perlu kalimat.
    assert.equal("userMessage" in r.body.checks.config, false);
  });
});

test("/api/activity mengirim userMessage untuk kejadian yang punya reason", async () => {
  await withServer({}, async ({ base, h }) => {
    h.controller.activity.push({ type: "AUTOPIN_FAILED", scene: "PAX-1", reason: "budget-exhausted-before-click" });
    const r = await getJson(base, "/api/activity");
    const ev = r.body.events.find((e) => e.type === "AUTOPIN_FAILED");
    assert.equal(ev.userMessage, "TikTok responded too slowly. The product was not changed.");
    // Kode mesinnya TETAP ada untuk ditelusuri.
    assert.equal(ev.reason, "budget-exhausted-before-click");
  });
});

// --- alur UI: muat, dropdown, simpan ----------------------------------------

test("UI bisa memuat config, scene, dan produk dari API", async () => {
  await withServer({}, async ({ base }) => {
    const cfg = await getJson(base, "/api/config");
    const scenes = await getJson(base, "/api/obs/scenes");
    const products = await getJson(base, "/api/tiktok/products");

    assert.equal(cfg.body.config.mappings.length, 1);
    assert.deepEqual(scenes.body.scenes, SCENES);
    assert.equal(products.body.count, 2);
    assert.equal(products.body.products[0].title, "O'CORN Sea Salt 80gr");
  });
});

test("dropdown scene dan produk terisi dari API, lewat logika yang sama dengan halaman", async () => {
  const U = require("../controller/public/ui-logic.js");
  await withServer({}, async ({ base }) => {
    const scenes = (await getJson(base, "/api/obs/scenes")).body.scenes;
    const products = (await getJson(base, "/api/tiktok/products")).body.products;

    assert.deepEqual(U.sceneOptions(scenes).map((o) => o.value), SCENES);
    const opts = U.productOptions(products);
    assert.deepEqual(opts.map((o) => o.label), ["#1 — O'CORN Sea Salt 80gr", "#10 — Dilan Cookies Choco Chip"]);
    assert.equal(opts[0].sub, "Rp10.000 · Stok 50");
  });
});

test("UI bisa MENYIMPAN pemetaan baru lewat API", async () => {
  const U = require("../controller/public/ui-logic.js");
  await withServer({}, async ({ base, h }) => {
    const current = (await getJson(base, "/api/config")).body.config;
    const rows = current.mappings.map(U.mappingToRow);

    // Baris baru, diisi seperti operator mengisinya di formulir.
    rows.push({ scene: "PAX-2", productTitle: "Dilan Cookies Choco Chip", triggersText: "", reply: "" });
    const suggested = U.applySuggestion({ trigger: "", reply: "" }, "PAX-2");
    rows[1].triggersText = suggested.trigger;
    rows[1].reply = suggested.reply;

    const payload = U.buildConfigPayload(current, rows);
    const put = await send(base, "/api/config", "PUT", payload);

    assert.equal(put.status, 200);
    assert.equal(put.body.ok, true);
    assert.equal(put.body.config.mappings.length, 2);
    assert.equal(put.body.config.mappings[1].scene, "PAX-2");
    assert.deepEqual(put.body.config.mappings[1].triggers, ["spill etalase 2"]);
    assert.equal(put.body.config.mappings[1].reply, "Etalase 2 sudah aku pin ya kak");
    // Password OBS tetap utuh di berkas walau tidak pernah dikirim bolak-balik.
    assert.equal(JSON.parse(h.fs.files.get(h.CONFIG_PATH)).obs.password, "rahasia-obs");
  });
});

test("pemetaan pertama bisa dibuat walau config belum ada", async () => {
  const U = require("../controller/public/ui-logic.js");
  await withServer({ configText: null }, async ({ base }) => {
    const r = await getJson(base, "/api/config");
    assert.equal(r.body.ok, false);
    assert.equal(r.body.error.code, "config-missing");
    assert.ok(r.body.defaults, "default harus dikirim sebagai titik awal");

    // UI memakai default itu, mengisi yang perlu, lalu menyimpan — tanpa seorang
    // pun menyunting JSON.
    const base0 = r.body.defaults;
    base0.tiktok.username = "akun_baru";
    base0.settings.expectedShop = "toko uji";
    const payload = U.buildConfigPayload(base0, [
      { scene: "PAX-1", productTitle: "O'CORN Sea Salt 80gr", triggersText: "spill etalase 1", reply: "Etalase 1 sudah aku pin ya kak" },
    ]);
    const put = await send(base, "/api/config", "PUT", payload);
    assert.equal(put.status, 200, JSON.stringify(put.body).slice(0, 300));
    assert.equal(put.body.ok, true);
  });
});

test("config belum ada: /api/status mengatakannya, jadi UI bisa menampilkan panduan", async () => {
  await withServer({ configText: null }, async ({ base }) => {
    const r = await getJson(base, "/api/status");
    assert.equal(r.status, 200);
    assert.equal(r.body.config.present, false);
  });
});

// --- Definition of Done: Start -> RUNNING -> Stop ---------------------------

// Urutan yang DILAKUKAN app.js saat START BOT ditekan. Ditulis di sini sebagai
// fungsi supaya yang diuji adalah urutannya, bukan sekadar hasil akhirnya.
async function uiStartSequence(base, { dirtyPayload } = {}) {
  const calls = [];
  const record = (p, r) => {
    calls.push(p);
    return r;
  };

  if (dirtyPayload) record("PUT /api/config", await send(base, "/api/config", "PUT", dirtyPayload));
  record("GET /api/obs/scenes", await getJson(base, "/api/obs/scenes"));
  record("GET /api/tiktok/products", await getJson(base, "/api/tiktok/products"));
  record("POST /api/mappings/validate", await send(base, "/api/mappings/validate", "POST"));

  const pre = await send(base, "/api/preflight", "POST");
  calls.push("POST /api/preflight");

  if (pre.body.ok !== true) return { calls, preflight: pre.body, started: null };

  const started = await send(base, "/api/start", "POST");
  calls.push("POST /api/start");
  return { calls, preflight: pre.body, started: started.body };
}

test("DoD: Start -> RUNNING -> Stop -> STOPPED tanpa proses yatim", async () => {
  await withServer({}, async ({ base, h }) => {
    // 1. Muat
    assert.equal((await getJson(base, "/api/status")).body.automation, "STOPPED");

    // 2. Start, dengan urutan yang dipakai UI
    const seq = await uiStartSequence(base);
    assert.equal(seq.preflight.ok, true, JSON.stringify(seq.preflight.checks));
    assert.equal(seq.started.ok, true);
    assert.equal(seq.started.state, "RUNNING");
    assert.ok(seq.calls.indexOf("POST /api/preflight") < seq.calls.indexOf("POST /api/start"), "preflight harus lebih dulu");

    // 3. RUNNING
    const running = await getJson(base, "/api/status");
    assert.equal(running.body.automation, "RUNNING");
    assert.equal(h.world.countByScript("autopin-service.js"), 1);
    assert.equal(h.world.countByScript("index.js"), 1);

    // 4. Activity muncul
    h.world.liveByScript("index.js")[0].say("[PLAY] scene=PAX-1 count=1 requesters=1");
    await new Promise((r) => setImmediate(r));
    const feed = await getJson(base, "/api/activity");
    assert.ok(feed.body.events.some((e) => e.type === "PLAY" && e.scene === "PAX-1"));

    // 5. Stop
    const stopped = await send(base, "/api/stop", "POST");
    assert.equal(stopped.body.ok, true);
    assert.equal((await getJson(base, "/api/status")).body.automation, "STOPPED");
    assert.equal(h.world.liveCount(), 0, "zero orphan child process");
  });
});

test("Start TIDAK dipanggil saat preflight merah", async () => {
  // Jaminan paling penting di alur Start: /api/start tidak pernah dipanggil di
  // atas keadaan yang belum diperiksa.
  await withServer({ discovery: { tiktokFail: "no-live-products" } }, async ({ base, h }) => {
    const seq = await uiStartSequence(base);

    assert.equal(seq.preflight.ok, false);
    assert.equal(seq.started, null, "start tidak boleh dipanggil");
    assert.equal(seq.calls.includes("POST /api/start"), false);
    assert.equal(h.world.spawned.length, 0, "nol proses dinyalakan");
    assert.equal((await getJson(base, "/api/status")).body.automation, "STOPPED");
  });
});

test("preflight merah menyebut baris mana yang belum siap, dengan kalimatnya", async () => {
  const U = require("../controller/public/ui-logic.js");
  await withServer({ discovery: { obsFail: "obs-unavailable" } }, async ({ base }) => {
    const seq = await uiStartSequence(base);
    const failed = U.failedPreflight(seq.preflight);
    assert.ok(failed.length > 0);
    const obs = failed.find((f) => f.label === "OBS");
    // failedPreflight adalah lapisan UI: kalimatnya ikut bahasa customer, dan
    // yang menghubungkannya ke server adalah KODE-nya, bukan kata-katanya.
    assert.equal(obs.value, T("err.obs-unavailable"));
  });
});

test("Start dua kali berturut-turut tidak menyalakan proses kedua", async () => {
  await withServer({}, async ({ base, h }) => {
    await uiStartSequence(base);
    const second = await send(base, "/api/start", "POST");
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, "start-rejected-busy");
    assert.equal(h.world.countByScript("index.js"), 1);
  });
});

test("Stop memanggil /api/stop dan membereskan semuanya", async () => {
  await withServer({}, async ({ base, h }) => {
    await uiStartSequence(base);
    assert.equal(h.world.liveCount(), 2);

    const r = await send(base, "/api/stop", "POST");
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(h.world.liveCount(), 0);
  });
});

// --- RUNNING mematikan penyuntingan ----------------------------------------

test("RUNNING mematikan penyuntingan; STOPPED menyalakannya lagi", async () => {
  const U = require("../controller/public/ui-logic.js");
  await withServer({}, async ({ base }) => {
    let status = (await getJson(base, "/api/status")).body;
    assert.equal(U.controlsFor({ status }).editingEnabled, true);
    // Kesiapan lengkap disuplai terpisah: sejak P4.1.1 Start menuntut semuanya.
    const ready = {
      obs: { ok: true, scenes: SCENES },
      tiktok: { ok: true, identityOk: true, live: true, productCount: 1 },
      validation: { ok: true, mappings: [{ ok: true }] },
    };
    assert.equal(U.controlsFor(Object.assign({ status }, ready)).startEnabled, true);

    await uiStartSequence(base);
    status = (await getJson(base, "/api/status")).body;
    const running = U.controlsFor({ status });
    assert.equal(running.editingEnabled, false);
    assert.equal(running.startEnabled, false);
    assert.equal(running.stopEnabled, true);
    // Dan discovery produk tidak boleh diminta lagi saat berjalan.
    assert.equal(running.discoveryAllowed, false);

    await send(base, "/api/stop", "POST");
    status = (await getJson(base, "/api/status")).body;
    const stopped = U.controlsFor(Object.assign({ status }, ready));
    assert.equal(stopped.editingEnabled, true);
    assert.equal(stopped.startEnabled, true);
  });
});

test("discovery produk ditolak server saat berjalan, dan UI memang tidak memintanya", async () => {
  const U = require("../controller/public/ui-logic.js");
  await withServer({}, async ({ base }) => {
    await uiStartSequence(base);
    const status = (await getJson(base, "/api/status")).body;
    assert.equal(U.controlsFor({ status }).discoveryAllowed, false);

    // Kalau toh diminta, server menolaknya — dua lapis.
    const r = await getJson(base, "/api/tiktok/products");
    assert.equal(r.body.ok, false);
    assert.equal(r.body.error.code, "discovery-unavailable-while-running");
  });
});

// --- restartRequired -------------------------------------------------------

test("menyimpan config saat RUNNING: restartRequired dan kalimatnya", async () => {
  await withServer({}, async ({ base }) => {
    await uiStartSequence(base);

    const current = (await getJson(base, "/api/config")).body.config;
    delete current.obs.passwordSet;
    current.mappings[0].reply = "kalimat baru";
    const put = await send(base, "/api/config", "PUT", current);

    assert.equal(put.body.ok, true);
    assert.equal(put.body.restartRequired, true);
    assert.equal(put.body.notice.userMessage, "Your changes are saved. Press STOP BOT, then START BOT to use them.");
    assert.equal((await getJson(base, "/api/status")).body.restartRequired, true);
  });
});

// --- backend tidak terjangkau ----------------------------------------------

test("backend mati: UI punya keadaan aman, dan Start TIDAK pernah hidup", async () => {
  const U = require("../controller/public/ui-logic.js");
  const h = createHarness({ config: configForCatalogue() });
  const server = createServer({ controller: h.controller });
  const addr = await server.start({ port: 0 });
  const base = "http://127.0.0.1:" + addr.port;

  // Masih hidup: status terbaca.
  assert.equal((await getJson(base, "/api/status")).status, 200);
  await server.stop();

  // Sesudah mati: permintaan gagal, dan UI memperlakukannya sebagai "tidak
  // terjangkau" — bukan sebagai pengecualian yang menghentikan halaman.
  let unreachable = false;
  try {
    await fetch(base + "/api/status", { signal: AbortSignal.timeout(1500) });
  } catch {
    unreachable = true;
  }
  assert.equal(unreachable, true);

  const c = U.controlsFor({ backendUnreachable: true, status: null });
  assert.equal(c.startEnabled, false);
  assert.equal(c.stopEnabled, false);
  assert.equal(c.editingEnabled, false);
  // controlsFor adalah lapisan UI, jadi kalimatnya ikut bahasa - bukan
  // kalimat server. Yang diassert kuncinya.
  assert.equal(c.startReason, I18N.t("id", "ui.banner.offline"));
});

// --- activity dibatasi -----------------------------------------------------

test("activity dibatasi di permintaan DAN di tampilan", async () => {
  const U = require("../controller/public/ui-logic.js");
  await withServer({}, async ({ base, h }) => {
    for (let i = 0; i < 200; i += 1) {
      h.controller.activity.push({ type: "PLAY", scene: "PAX-1", message: "Scene started" });
    }
    const r = await getJson(base, "/api/activity?limit=" + U.MAX_ACTIVITY_ITEMS);
    assert.equal(r.body.events.length, U.MAX_ACTIVITY_ITEMS);
    assert.equal(U.activityItems(r.body.events).length, U.MAX_ACTIVITY_ITEMS);
  });
});

test("activity tidak pernah memuat nama penonton", async () => {
  await withServer({}, async ({ base, h }) => {
    await uiStartSequence(base);
    h.world.liveByScript("index.js")[0].say('[TIKTOK_CHAT] user=@penonton_asli text="spill etalase 1"');
    await new Promise((r) => setImmediate(r));
    const r = await getJson(base, "/api/activity");
    assert.ok(!JSON.stringify(r.body).includes("penonton_asli"));
  });
});
