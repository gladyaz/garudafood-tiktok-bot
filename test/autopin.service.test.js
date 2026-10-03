// Tes service AutoPIN yang TIDAK membuka browser.
// Hanya jalur yang menolak lebih dulu (sebelum halaman dibutuhkan) yang diuji
// di sini; klik sungguhan diverifikasi manual di LIVE, lihat autopin/VERIFICATION.md.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createService, isExpectedConsole } = require("../autopin/service");

const CONSOLE = "https://shop.tiktok.com/streamer/live/product/dashboard";

test("service: halaman dianggap benar hanya kalau origin DAN path sama", () => {
  assert.equal(isExpectedConsole(CONSOLE, CONSOLE), true);
  assert.equal(isExpectedConsole(`${CONSOLE}?tab=1`, CONSOLE), true, "query string tidak menentukan");
  assert.equal(isExpectedConsole("https://shop.tiktok.com/streamer/live-console", CONSOLE), false);
  assert.equal(isExpectedConsole("https://evil.example.com/streamer/live/product/dashboard", CONSOLE), false);
  assert.equal(isExpectedConsole("bukan-url", CONSOLE), false);
});

test("service: kunci produk kosong ditolak tanpa menyentuh browser", async () => {
  const svc = createService({ config: { consoleUrl: CONSOLE, forbiddenShops: ["garudafood"] } });
  for (const bad of [undefined, "", "   ", "!!!", 42]) {
    const r = await svc.handlePin({ scene: "PAX-1", productKey: bad, playId: 1 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "empty-product-key");
  }
  assert.equal(svc.__state().hasPage, false);
});

test("service: permintaan dengan playId lebih lama dibuang (latest-wins)", async () => {
  const svc = createService({ config: { consoleUrl: CONSOLE, forbiddenShops: ["garudafood"] } });
  await svc.handlePin({ scene: "PAX-5", productKey: "bon bon", playId: 9 }).catch(() => {});
  const r = await svc.handlePin({ scene: "PAX-3", productKey: "kue coklat", playId: 4 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "stale");
  assert.equal(svc.__state().latestPlayId, 9);
});

// ---- AP2.1: klik tidak boleh terjadi kalau scene sudah berganti ----

const { startService } = require("../autopin/service");

const CONFIG = { consoleUrl: CONSOLE, expectedShop: "agen_mulia_abadi", forbiddenShops: ["garudafood"] };

const SNAPSHOT = {
  products: [
    { number: 1, title: "Produk Uji Satu", pinButtons: 1, pinVisible: true, pinDisabled: false },
    { number: 2, title: "Produk Uji Dua", pinButtons: 1, pinVisible: true, pinDisabled: false },
  ],
  livePinButtonsOnPage: 2,
};

// Browser palsu: cukup untuk menjalankan seluruh urutan gerbang tanpa Chromium.
function fakeDeps({ clicks, collect }) {
  return {
    launchBrowser: async () => ({ id: "fake-browser" }),
    getPage: async () => ({ url: () => CONSOLE, isClosed: () => false }),
    openConsole: async () => ({ url: CONSOLE, settled: true, readyMs: 1 }),
    closeBrowser: async () => {},
    readIdentity: async () => ["agen_mulia_abadi"],
    collectProducts: collect,
    pinProductByTitle: async (_page, key) => { clicks.push(key); return { ok: true, title: key }; },
    readPinState: async () => ({ text: "Unpin", disabled: false, buttons: 1 }),
  };
}

const settle = async (turns = 20) => {
  for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r));
};

test("in-flight: permintaan lama yang SUDAH bekerja tidak pernah mengklik setelah scene baru masuk", async () => {
  const clicks = [];
  let releaseA = null;
  let calls = 0;
  const collect = async () => {
    calls += 1;
    if (calls === 1) await new Promise((r) => { releaseA = r; }); // A tertahan di scraping produk
    return SNAPSHOT;
  };

  const svc = createService({ config: CONFIG, deps: fakeDeps({ clicks, collect }) });

  const a = svc.handlePin({ scene: "PAX-3", productKey: "uji satu", playId: 10 });
  await settle();
  assert.equal(typeof releaseA, "function", "A harus sudah melewati gerbang dan sedang mengambil produk");
  assert.deepEqual(clicks, [], "belum ada klik sebelum scene berganti");

  // scene berikutnya mulai selagi A masih di tengah jalan
  const b = svc.handlePin({ scene: "PAX-5", productKey: "uji dua", playId: 11 });
  releaseA();

  const [ra, rb] = await Promise.all([a, b]);

  assert.equal(ra.ok, false);
  assert.equal(ra.reason, "stale-before-click");
  assert.equal(ra.clicked, false);
  assert.equal(rb.ok, true);
  assert.equal(rb.clicked, true);
  assert.deepEqual(clicks, ["uji dua"], "hanya scene terbaru yang boleh menyentuh UI");
});

test("in-flight: tanpa scene baru, permintaan yang tertahan tetap boleh mengklik", async () => {
  const clicks = [];
  let release = null;
  const collect = async () => {
    if (!release) await new Promise((r) => { release = r; return r; });
    return SNAPSHOT;
  };
  const svc = createService({ config: CONFIG, deps: fakeDeps({ clicks, collect }) });

  const a = svc.handlePin({ scene: "PAX-3", productKey: "uji satu", playId: 10 });
  await settle();
  if (release) release();
  const ra = await a;

  assert.equal(ra.ok, true, "penundaan saja tidak boleh membatalkan pin");
  assert.deepEqual(clicks, ["uji satu"]);
});

test("in-flight: identitas toko diperiksa sebelum klik, produksi tidak pernah diklik", async () => {
  const clicks = [];
  const svc = createService({
    config: CONFIG,
    deps: {
      ...fakeDeps({ clicks, collect: async () => SNAPSHOT }),
      readIdentity: async () => ["garudafood_officialstore"],
    },
  });
  const r = await svc.handlePin({ scene: "PAX-3", productKey: "uji satu", playId: 1 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^identity-/);
  assert.deepEqual(clicks, []);
});


// ---- AP2.3: halaman harus di depan sebelum discraping ----

test("service: halaman dibawa ke depan sebelum konsol dibuka (tab latar tidak me-render daftar produk)", async () => {
  const order = [];
  const page = {
    url: () => CONSOLE,
    isClosed: () => false,
    bringToFront: async () => { order.push("bringToFront"); },
  };
  const svc = createService({
    config: CONFIG,
    deps: {
      ...fakeDeps({ clicks: [], collect: async () => SNAPSHOT }),
      getPage: async () => page,
      openConsole: async () => { order.push("openConsole"); return { url: CONSOLE, settled: true, readyMs: 1 }; },
    },
  });

  await svc.warmUp();
  assert.deepEqual(order, ["bringToFront", "openConsole"]);
});

test("service: halaman tanpa bringToFront tetap jalan (tidak crash)", async () => {
  const svc = createService({
    config: CONFIG,
    deps: { ...fakeDeps({ clicks: [], collect: async () => SNAPSHOT }), getPage: async () => ({ url: () => CONSOLE, isClosed: () => false }) },
  });
  const w = await svc.warmUp();
  assert.equal(w.ok, true);
});

test("service: warmUp yang gagal tidak melempar, service tetap bisa dipakai", async () => {
  const svc = createService({
    config: CONFIG,
    deps: { ...fakeDeps({ clicks: [], collect: async () => SNAPSHOT }), launchBrowser: async () => { throw new Error("chrome tidak ada"); } },
  });
  const w = await svc.warmUp();
  assert.equal(w.ok, false);
});

test("service mendengarkan hanya di loopback, tidak terekspos ke LAN", async () => {
  // deps palsu WAJIB: startService memanggil warmUp(), dan tanpa ini tes akan
  // benar-benar membuka Chrome.
  const svc = await startService({
    port: 0,
    config: CONFIG,
    deps: fakeDeps({ clicks: [], collect: async () => SNAPSHOT }),
  });
  try {
    const addr = svc.server.address();
    assert.equal(addr.address, "127.0.0.1");
    assert.ok(addr.port > 0);
  } finally {
    await new Promise((r) => svc.server.close(r));
  }
});
