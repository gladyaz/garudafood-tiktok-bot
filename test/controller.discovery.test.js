// Discovery OBS dan TikTok. SEMUANYA OFFLINE.
//
// Klien OBS dan seluruh fungsi browser di-inject. Tidak ada socket yang dibuka,
// tidak ada Puppeteer yang dimuat, tidak ada halaman TikTok yang dibuka, dan
// tidak ada apa pun yang diklik.
//
// Yang paling keras diuji di sini adalah hal-hal yang TIDAK boleh terjadi:
// discovery tidak pernah mengubah scene OBS, tidak pernah mengklik Pin, tidak
// pernah mengetik di chat, dan tidak pernah menyentuh kontrol pengurut daftar
// produk. Satu panggilan yang salah di jalur ini akan terlihat oleh penonton.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createObsDiscovery, classifyObsError } = require("../controller/discovery/obs");
const { createTikTokDiscovery, toPublicProduct } = require("../controller/discovery/tiktok");
const { goodConfig } = require("./helpers/controller-harness");

// --- OBS ---------------------------------------------------------------------

// Klien OBS palsu yang MENCATAT setiap panggilan, supaya tes bisa membuktikan
// tidak ada panggilan yang mengubah apa pun.
function fakeObs({ scenes = ["MAIN", "PAX-1", "PAX-2"], failConnect = null, failCall = null, hang = false } = {}) {
  const calls = [];
  const client = {
    calls,
    connected: false,
    disconnected: false,
    async connect(url, password) {
      calls.push({ m: "connect", url, password });
      if (failConnect) throw new Error(failConnect);
      if (hang) await new Promise(() => {});
      client.connected = true;
    },
    async call(name, params) {
      calls.push({ m: name, params });
      if (failCall) throw new Error(failCall);
      if (hang) await new Promise(() => {});
      if (name === "GetSceneList") return { scenes: scenes.map((s) => ({ sceneName: s })) };
      return {};
    },
    async disconnect() {
      calls.push({ m: "disconnect" });
      client.disconnected = true;
    },
  };
  return client;
}

const obsWith = (opts, extra = {}) => {
  const client = fakeObs(opts);
  const d = createObsDiscovery({ createClient: () => client, timeoutMs: 50, ...extra });
  return { d, client };
};

test("OBS: scene terbaca", async () => {
  const { d } = obsWith({});
  const r = await d.listScenes({ host: "127.0.0.1", port: 4455, password: "x" });
  assert.equal(r.ok, true);
  assert.equal(r.connected, true);
  assert.deepEqual(r.scenes, ["MAIN", "PAX-1", "PAX-2"]);
});

test("OBS: HANYA GetSceneList yang dipanggil — tidak ada yang mengubah apa pun", async () => {
  const { d, client } = obsWith({});
  await d.listScenes({ host: "127.0.0.1", port: 4455 });

  const requests = client.calls.filter((c) => c.m !== "connect" && c.m !== "disconnect").map((c) => c.m);
  assert.deepEqual(requests, ["GetSceneList"]);
  // Secara eksplisit: tidak ada perpindahan scene. Discovery bisa dipanggil dari
  // UI saat LIVE berjalan, dan perpindahan yang tidak diminta akan terlihat
  // penonton sebagai bot yang kacau.
  assert.ok(!requests.includes("SetCurrentProgramScene"));
  assert.ok(!requests.some((m) => /^Set|^Start|^Stop|^Trigger|^Create|^Remove/.test(m)));
});

test("OBS: koneksi SELALU ditutup, termasuk saat sukses", async () => {
  const { d, client } = obsWith({});
  await d.listScenes({ host: "127.0.0.1", port: 4455 });
  assert.equal(client.disconnected, true, "Controller tidak boleh memegang koneksi OBS");
});

test("OBS: koneksi ditutup juga saat gagal", async () => {
  const { d, client } = obsWith({ failCall: "boom" });
  const r = await d.listScenes({ host: "127.0.0.1", port: 4455 });
  assert.equal(r.ok, false);
  assert.equal(client.disconnected, true);
});

test("OBS: URL dibentuk dari config, bukan dari nilai tetap", async () => {
  const { d, client } = obsWith({});
  await d.listScenes({ host: "192.168.1.50", port: 4466, password: "rahasia" });
  const connect = client.calls.find((c) => c.m === "connect");
  assert.equal(connect.url, "ws://192.168.1.50:4466");
  assert.equal(connect.password, "rahasia");
});

test("OBS: password kosong dikirim sebagai undefined, bukan string kosong", async () => {
  const { d, client } = obsWith({});
  await d.listScenes({ host: "127.0.0.1", port: 4455, password: "" });
  assert.equal(client.calls.find((c) => c.m === "connect").password, undefined);
});

test("OBS mati -> obs-unavailable, connected false", async () => {
  const { d } = obsWith({ failConnect: "ECONNREFUSED" });
  const r = await d.listScenes({ host: "127.0.0.1", port: 4455 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "obs-unavailable");
  assert.equal(r.connected, false);
});

test("OBS: password salah -> obs-auth-failed", async () => {
  for (const msg of ["Authentication failed", "error 4009", "wrong password"]) {
    const { d } = obsWith({ failConnect: msg });
    assert.equal((await d.listScenes({ host: "h", port: 1 })).reason, "obs-auth-failed", msg);
  }
});

test("OBS: menggantung -> obs-timeout, bukan menunggu selamanya", async () => {
  // Batas waktu dipasang ke SELURUH urutan baca. OBS yang menerima koneksi lalu
  // tidak pernah menjawab GetSceneList sama buruknya dengan OBS yang mati.
  const { d } = obsWith({ hang: true });
  const r = await d.listScenes({ host: "h", port: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "obs-timeout");
});

test("OBS: menggantung SESUDAH connect juga kena batas waktu", async () => {
  const client = fakeObs({});
  client.call = async () => new Promise(() => {});
  const d = createObsDiscovery({ createClient: () => client, timeoutMs: 50 });
  const r = await d.listScenes({ host: "h", port: 1 });
  assert.equal(r.reason, "obs-timeout");
  assert.equal(r.connected, true, "sempat tersambung, dan itu dilaporkan apa adanya");
});

test("OBS: klien tidak tersedia -> obs-unavailable, bukan melempar", async () => {
  const d = createObsDiscovery({ createClient: () => null });
  const r = await d.listScenes({ host: "h", port: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "obs-unavailable");
});

test("OBS: daftar scene kosong tetap sukses", async () => {
  // OBS tanpa scene adalah keadaan yang sah; yang menolaknya adalah validasi
  // pemetaan, bukan discovery.
  const { d } = obsWith({ scenes: [] });
  const r = await d.listScenes({ host: "h", port: 1 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.scenes, []);
});

test("OBS: nama scene kosong dibuang", async () => {
  const { d } = obsWith({ scenes: ["MAIN", "", "PAX-1"] });
  assert.deepEqual((await d.listScenes({ host: "h", port: 1 })).scenes, ["MAIN", "PAX-1"]);
});

test("OBS: urutan scene TIDAK diubah", async () => {
  // Urutan dari OBS adalah urutan yang dilihat operator di OBS.
  const { d } = obsWith({ scenes: ["PAX-5", "MAIN", "PAX-1"] });
  assert.deepEqual((await d.listScenes({ host: "h", port: 1 })).scenes, ["PAX-5", "MAIN", "PAX-1"]);
});

test("classifyObsError konservatif: yang tidak jelas = obs-unavailable", () => {
  assert.equal(classifyObsError(new Error("timeout")), "obs-timeout");
  assert.equal(classifyObsError(new Error("auth gagal")), "obs-auth-failed");
  assert.equal(classifyObsError(new Error("sesuatu yang aneh")), "obs-unavailable");
  assert.equal(classifyObsError(null), "obs-unavailable");
});

test("OBS: hasil tidak memuat password", async () => {
  const { d } = obsWith({});
  const r = await d.listScenes({ host: "h", port: 1, password: "rahasia-obs" });
  assert.ok(!JSON.stringify(r).includes("rahasia-obs"));
});

// --- TikTok ------------------------------------------------------------------

const RAW_PRODUCTS = [
  { number: 1, title: "O'CORN Sea Salt 80gr", price: "Rp10.000", stock: "Stok 50", pinButtons: 1, pinDisabled: false, pinVisible: true, pinText: "Pin", productId: "", topControls: 1, pinClass: "kelas-internal", icons: ["arco-icon-x"], badges: ["LIVE"] },
  { number: 2, title: "Dilan Cookies Choco Chip", price: "Rp12.000", stock: "Stok 20", pinButtons: 1, pinDisabled: false, pinVisible: true, pinText: "Unpin", productId: "", topControls: 1, pinClass: "kelas-internal", icons: [], badges: [] },
];

// Halaman palsu yang MENCATAT setiap evaluate, supaya tes bisa membuktikan tidak
// ada fungsi pengubah yang pernah dijalankan di dalam halaman.
const DASHBOARD_URL = "https://shop.tiktok.com/streamer/live/product/dashboard";

function fakeTikTok({
  products = RAW_PRODUCTS,
  livePinButtonsOnPage = 2,
  identity = ["toko uji"],
  // URL halaman SESUDAH openConsole. Inilah cara produksi mengetahui sesi login
  // masih berlaku: TikTok mengalihkan ke halaman lain kalau belum login, dan
  // halaman itu tetap memuat dengan sukses.
  pageUrl = DASHBOARD_URL,
  throwOn = null,
  hang = false,
} = {}) {
  const events = [];
  // Halaman palsu punya url(), karena itulah yang dipakai adapter untuk memeriksa
  // "ini memang dashboard produk" — lewat fungsi isExpectedConsole yang sama
  // dengan yang dipakai autopin/service.js.
  const page = { __page: true, url: () => pageUrl };
  let browser = null;

  const deps = {
    launchBrowser: async () => {
      events.push("launchBrowser");
      browser = { __browser: true };
      return browser;
    },
    getPage: async () => {
      events.push("getPage");
      return page;
    },
    // Produksi mengembalikan { url, title, settled, readyMs } dan MELEMPAR saat
    // navigasi gagal — ia tidak pernah mengembalikan { ok: false }.
    openConsole: async () => {
      events.push("openConsole");
      if (throwOn === "openConsole") throw new Error("boom");
      return { url: pageUrl, title: "LIVE products", settled: true, readyMs: 120 };
    },
    closeBrowser: async () => {
      events.push("closeBrowser");
      browser = null;
    },
    collectProducts: async () => {
      events.push("collectProducts");
      if (throwOn === "collectProducts") throw new Error("boom");
      if (hang) await new Promise(() => {});
      return { products, livePinButtonsOnPage, markers: products.length };
    },
    // Mengembalikan ARRAY, sama seperti autopin/products.js readIdentity().
    // Versi pertama fake ini mengembalikan { observed: [...] } — bentuk yang tidak
    // pernah ada di produksi — sehingga adapter-nya membaca `.observed` dan
    // identitas SELALU gagal di produksi tanpa satu pun tes jadi merah.
    readIdentity: async () => {
      events.push("readIdentity");
      if (throwOn === "readIdentity") throw new Error("boom");
      return identity;
    },
    checkIdentity: ({ expected, observed, forbidden }) => {
      events.push("checkIdentity");
      const norm = (v) => String(v ?? "").trim().toLowerCase();
      const want = norm(expected);
      if (!want) return { ok: false, reason: "expected-shop-not-configured" };
      const seen = (observed || []).map(norm).filter(Boolean);
      if (seen.length === 0) return { ok: false, reason: "identity-not-found" };
      const banned = (forbidden || []).map(norm).filter(Boolean);
      if (seen.some((s) => banned.some((b) => s.includes(b)))) return { ok: false, reason: "forbidden-shop" };
      if (!seen.includes(want)) return { ok: false, reason: "mismatch" };
      return { ok: true };
    },
  };

  return { events, deps, isBrowserOpen: () => browser !== null };
}

// isExpectedConsole dan toBrowserConfig memakai implementasi PRODUKSI, bukan
// tiruan: keduanya murni, dan justru di situ bug P2 bersembunyi.
const { isExpectedConsole } = require("../autopin/service");
const { toAutopinConfig } = require("../controller/config-manager");

const tiktokWith = (opts, extra = {}) => {
  const f = fakeTikTok(opts);
  return {
    f,
    d: createTikTokDiscovery({
      ...f.deps,
      isExpectedConsole,
      toBrowserConfig: toAutopinConfig,
      timeoutMs: 50,
      ...extra,
    }),
  };
};

test("TikTok: katalog terbaca dan dibentuk jadi objek terstruktur", async () => {
  const { d } = tiktokWith({});
  const r = await d.products(goodConfig());

  assert.equal(r.ok, true);
  assert.equal(r.count, 2);
  assert.equal(r.products[0].title, "O'CORN Sea Salt 80gr");
  assert.equal(r.products[0].number, 1);
  assert.equal(r.products[0].pinText, "Pin");
  assert.equal(r.products[0].pinAvailable, true);
  assert.equal(r.livePinControlsAvailable, true);
});

test("TikTok: stableId null, dan TIDAK dikarang dari nomor baris", async () => {
  // DOM TikTok tidak mengekspos id produk/SKU (autopin/products.js membacanya
  // sebagai productId: ""). Nomor baris bergeser setiap kali ada aksi pin, jadi
  // nomor sebagai identitas adalah identitas yang berubah sendiri.
  const { d } = tiktokWith({});
  const r = await d.products(goodConfig());
  for (const p of r.products) {
    assert.equal(p.stableId, null);
  }
});

test("TikTok: HANYA fungsi baca yang dijalankan — tidak ada pin, ketik, atau ubah urutan", async () => {
  const { f, d } = tiktokWith({});
  await d.products(goodConfig());

  // Daftar TERTUTUP. Apa pun yang baru harus lewat tes ini dulu.
  assert.deepEqual(f.events, [
    "launchBrowser",
    "getPage",
    "openConsole",
    "readIdentity",
    "checkIdentity",
    "collectProducts",
    "closeBrowser",
  ]);
  // Secara eksplisit: tidak ada yang memin, mengetik, atau mengurut.
  for (const forbidden of ["pinProductByTitle", "pinProductInPage", "typeComment", "sendComment", "resetScrollInPage"]) {
    assert.ok(!f.events.includes(forbidden), forbidden + " tidak boleh pernah dipanggil");
  }
});

test("TikTok: browser SELALU ditutup, termasuk saat gagal", async () => {
  for (const opts of [{}, { throwOn: "collectProducts" }, { throwOn: "readIdentity" }, { pageUrl: "https://www.tiktok.com/login" }]) {
    const { f, d } = tiktokWith(opts);
    await d.products(goodConfig());
    assert.equal(f.isBrowserOpen(), false, "browser tertinggal pada: " + JSON.stringify(opts));
    assert.ok(f.events.includes("closeBrowser"));
  }
});

test("TikTok: identitas diperiksa SEBELUM katalog dikembalikan", async () => {
  // Katalog dari toko yang salah lebih berbahaya daripada tidak ada katalog:
  // ia terlihat benar, dan mapping akan dibuat atas dasar daftar milik orang lain.
  const { f, d } = tiktokWith({ identity: ["toko orang lain"] });
  const r = await d.products(goodConfig());

  assert.equal(r.ok, false);
  assert.equal(r.reason, "wrong-tiktok-account");
  assert.ok(!("products" in r) || !r.products, "katalog tidak boleh dikembalikan");
  assert.ok(f.events.indexOf("checkIdentity") < f.events.indexOf("collectProducts") || !f.events.includes("collectProducts"));
});

test("TikTok: toko terlarang -> wrong-tiktok-account", async () => {
  // Gerbang yang sama dengan jalur pin: nama toko produksi tidak pernah lolos.
  const { d } = tiktokWith({ identity: ["garudafood official"] });
  assert.equal((await d.products(goodConfig())).reason, "wrong-tiktok-account");
});

test("TikTok: identitas tidak terbaca -> tiktok-not-logged-in", async () => {
  const { d } = tiktokWith({ identity: [] });
  assert.equal((await d.products(goodConfig())).reason, "tiktok-not-logged-in");
});

test("TikTok: expectedShop belum diisi -> ditolak, bukan dilewati", async () => {
  const cfg = goodConfig();
  cfg.settings.expectedShop = "";
  const { d } = tiktokWith({});
  assert.equal((await d.products(cfg)).reason, "expected-shop-not-configured");
});

test("TikTok: halaman tak terduga -> tiktok-not-logged-in", async () => {
  // openConsole melaporkan ini saat sesi login kadaluarsa dan TikTok mengalihkan.
  const { d } = tiktokWith({ pageUrl: "https://www.tiktok.com/login" });
  assert.equal((await d.products(goodConfig())).reason, "tiktok-not-logged-in");
});

test("TikTok: dashboard tidak terbuka -> product-dashboard-unavailable", async () => {
  const { d } = tiktokWith({ throwOn: "openConsole" });
  assert.equal((await d.products(goodConfig())).reason, "product-dashboard-unavailable");
});

test("TikTok: katalog kosong -> no-live-products", async () => {
  const { d } = tiktokWith({ products: [], livePinButtonsOnPage: 0 });
  const r = await d.products(goodConfig());
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no-live-products");
  assert.equal(r.count, 0);
});

test("TikTok: menggantung -> product-discovery-timeout", async () => {
  const { d } = tiktokWith({ hang: true });
  assert.equal((await d.products(goodConfig())).reason, "product-discovery-timeout");
});

test("TikTok: tanpa dependensi -> discovery-not-configured, bukan melempar", async () => {
  const d = createTikTokDiscovery({});
  const r = await d.products(goodConfig());
  assert.equal(r.ok, false);
  assert.equal(r.reason, "discovery-not-configured");
});

test("TikTok status: LIVE on air dilihat dari ADA tombol Pin", async () => {
  // Dashboard tetap terbuka saat LIVE mati, jadi URL halaman tidak bisa menjawab
  // "LIVE sedang berjalan". Yang membedakan adalah kontrol pin per produk.
  const on = tiktokWith({ livePinButtonsOnPage: 2 });
  assert.equal((await on.d.status(goodConfig())).live, true);

  const off = tiktokWith({ livePinButtonsOnPage: 0 });
  assert.equal((await off.d.status(goodConfig())).live, false);
});

test("TikTok status: bentuk yang dijanjikan", async () => {
  const { d } = tiktokWith({});
  const r = await d.status(goodConfig());
  assert.equal(r.identity, "toko uji");
  assert.equal(r.identityOk, true);
  assert.equal(r.live, true);
  assert.equal(r.dashboardReady, true);
  assert.equal(r.productCount, 2);
  // chatReady null = BELUM diperiksa, bukan false yang terbaca "chat rusak".
  assert.equal(r.chatReady, null);
});

test("TikTok status: identitas salah dilaporkan, tidak disembunyikan", async () => {
  const { d } = tiktokWith({ identity: ["toko lain"] });
  const r = await d.status(goodConfig());
  assert.equal(r.ok, false);
  assert.equal(r.identityOk, false);
  assert.equal(r.identityReason, "wrong-tiktok-account");
});

test("TikTok: hasil TIDAK memuat diagnostik internal atau rahasia", async () => {
  const { d } = tiktokWith({});
  const r = await d.products(goodConfig());
  const raw = JSON.stringify(r);

  // Diagnostik internal tidak ada gunanya di layar customer, dan pinClass/icons
  // membocorkan struktur DOM internal TikTok.
  for (const leak of ["pinClass", "kelas-internal", "icons", "arco-icon", "ariaOnRow", "topControls", "imageKey", "rowInputs", "badges"]) {
    assert.ok(!raw.includes(leak), leak + " tidak boleh keluar");
  }
  // Dan rahasia dari config tidak boleh ikut.
  assert.ok(!raw.includes("rahasia-obs"));
  assert.ok(!raw.includes(".autopin-profile"));
});

test("toPublicProduct: bentuk field-nya tertutup", () => {
  const p = toPublicProduct(RAW_PRODUCTS[0]);
  assert.deepEqual(Object.keys(p).sort(), [
    "number", "pinAvailable", "pinDisabled", "pinText", "price", "stableId", "stock", "title",
  ]);
});

test("toPublicProduct: produk tanpa kontrol pin ditandai pinAvailable false", () => {
  const p = toPublicProduct({ title: "x", number: 3, pinButtons: 0 });
  assert.equal(p.pinAvailable, false);
  assert.equal(p.number, 3);
});

test("toPublicProduct: nomor yang bukan bilangan bulat jadi null", () => {
  assert.equal(toPublicProduct({ title: "x", number: null }).number, null);
  assert.equal(toPublicProduct({ title: "x", number: "2" }).number, null);
});

// --- KONTRAK BENTUK FUNGSI PRODUKSI -----------------------------------------
//
// Tes-tes di atas memakai fungsi browser palsu. Palsu itu hanya berguna kalau
// bentuknya SAMA dengan yang asli — dan di P2 ia tidak sama, dalam tiga hal
// sekaligus, sehingga discovery TikTok sebenarnya tidak pernah bisa bekerja di
// produksi meskipun seluruh tesnya hijau:
//
//   1. readIdentity() mengembalikan ARRAY, bukan { observed: [...] }
//   2. openConsole() MELEMPAR saat gagal dan mengembalikan { url, title, ... }
//      saat berhasil — ia tidak pernah mengembalikan { ok: false }
//   3. launchBrowser() membaca config.profileDir, sedangkan customer config
//      menyimpannya di config.settings.profileDir
//
// Tes di bawah memeriksa bentuk aslinya langsung dari modul produksi. Kalau
// bentuknya berubah, di sinilah yang merah lebih dulu — bukan saat LIVE.

test("KONTRAK: readIdentity mengembalikan array, bukan objek ber-observed", () => {
  // Diperiksa dari fungsi yang dieksekusi DI DALAM halaman, karena itulah yang
  // menentukan bentuk hasilnya: readIdentity = page.evaluate(readIdentityInPage).
  const fs = require("node:fs");
  const src = fs.readFileSync(require.resolve("../autopin/products.js"), "utf8");
  const body = /function readIdentityInPage\(\)\s*\{([\s\S]*?)\n\}/.exec(src);
  assert.ok(body, "readIdentityInPage harus bisa ditemukan");
  assert.ok(/return \[\.\.\.new Set\(out\)\]/.test(body[1]), "harus mengembalikan array");
  assert.ok(!/return \{/.test(body[1]), "tidak boleh mengembalikan objek");
});

test("KONTRAK: openConsole mengembalikan metadata halaman, tanpa field ok", () => {
  const fs = require("node:fs");
  const src = fs.readFileSync(require.resolve("../autopin/browser.js"), "utf8");
  const body = /async function openConsole\([\s\S]*?\n\}/.exec(src);
  assert.ok(body, "openConsole harus bisa ditemukan");
  assert.ok(/return \{ url:/.test(body[0]), "mengembalikan { url, title, settled, readyMs }");
  assert.ok(!/\bok:\s*(true|false)/.test(body[0]), "tidak pernah mengembalikan field ok");
  assert.ok(/throw new AutoPinError/.test(body[0]), "melempar saat navigasi gagal");
});

test("KONTRAK: launchBrowser memakai config.profileDir (bentuk autopin, bukan customer)", () => {
  const fs = require("node:fs");
  const src = fs.readFileSync(require.resolve("../autopin/browser.js"), "utf8");
  const body = /async function launchBrowser\([\s\S]*?\n\}/.exec(src);
  assert.ok(/config\.profileDir/.test(body[0]), "membaca config.profileDir");
  assert.ok(!/config\.settings/.test(body[0]), "tidak pernah membaca config.settings");

  // Dan toAutopinConfig memang menyediakan bentuk itu.
  const bcfg = toAutopinConfig(goodConfig());
  assert.equal(typeof bcfg.profileDir, "string");
  assert.ok(bcfg.profileDir.length > 0);
  assert.equal(typeof bcfg.consoleUrl, "string");
  assert.equal(typeof bcfg.navTimeoutMs, "number");
  assert.equal("settings" in bcfg, false, "bentuk autopin, bukan customer");
});

test("KONTRAK: adapter MENOLAK jalan tanpa isExpectedConsole / toBrowserConfig", () => {
  // Fail-closed. Keduanya wajib justru karena ketiadaannya-lah yang membuat bug
  // P2 tidak terlihat: adapter tetap "berjalan" dan selalu melaporkan gagal.
  const f = fakeTikTok({});
  const d = createTikTokDiscovery({ ...f.deps, timeoutMs: 50 });
  return d.products(goodConfig()).then((r) => {
    assert.equal(r.ok, false);
    assert.equal(r.reason, "discovery-not-configured");
  });
});
