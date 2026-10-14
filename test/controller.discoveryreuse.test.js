// P0-1: SATU pembacaan dashboard untuk tiga konsumen penasihat.
//
// /api/tiktok/status, /api/tiktok/products, dan /api/mappings/validate dulu
// masing-masing membuka Chrome, membuka dashboard produk yang SAMA dengan profil
// yang SAMA, menjalankan readIdentity dan collectProducts yang SAMA, lalu hanya
// berbeda pada bentuk jawabannya. Dipanggil berurutan di satu klik START,
// halaman yang sama dibaca tiga kali - lalu /api/start membacanya untuk keempat
// kalinya. Terukur 10,34s + 10,10s + 12,16s + 11,84s.
//
// Sekarang tiga yang pertama berbagi satu pembacaan. /api/start TIDAK: ia tetap
// membaca sendiri, segar, tepat sebelum proses dinyalakan, karena kondisi LIVE,
// katalog, dan sesi bisa berubah di antara keduanya. Sasarannya 4 -> 2, bukan
// 4 -> 1, dan berkas ini menjaga angka 2 itu dari kedua arah.
//
// Yang paling mudah rusak di sini BUKAN jumlah peluncuran, tapi semantik
// kegagalan: status() dan products() memang TIDAK identik saat katalog kosong
// atau identitas bermasalah, dan snapshot bersama tidak boleh menyeragamkannya.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { createTikTokDiscovery, statusFromSnapshot, productsFromSnapshot } = require("../controller/discovery/tiktok");
const { PURPOSE } = require("../autopin/browser-mode");

const CONSOLE_URL = "https://shop.tiktok.com/streamer/live/product/dashboard";

const CONFIG = () => ({
  tiktok: { username: "agen_mulia_abadi" },
  obs: { host: "127.0.0.1", port: 4455, password: "" },
  settings: {
    expectedShop: "agen_mulia_abadi",
    forbiddenShops: [],
    consoleUrl: CONSOLE_URL,
    profileDir: ".autopin-profile",
    debugDir: ".autopin-debug",
    chromePath: "",
    autoCommentEnabled: false,
  },
  mappings: [],
});

// Dependensi palsu yang MENCATAT, dengan bentuk yang sama dipakai produksi:
// readIdentity mengembalikan ARRAY, collectProducts mengembalikan
// { products, livePinButtonsOnPage }. Bentuk yang dikarang sudah pernah
// meloloskan bug di repo ini, jadi keduanya disalin dari pemakaian nyata.
function fakeDiscovery({ identity = ["agen_mulia_abadi"], products = [{ id: "p1", title: "Kacang" }], livePins = 3 } = {}) {
  const calls = { launch: 0, purposes: [], collect: 0, identity: 0, closed: 0, openConsole: 0 };
  const deps = {
    launchBrowser: async (_cfg, purpose) => {
      calls.launch += 1;
      calls.purposes.push(purpose);
      return { id: "browser-" + calls.launch };
    },
    getPage: async () => ({ url: () => CONSOLE_URL }),
    openConsole: async () => {
      calls.openConsole += 1;
      return { url: CONSOLE_URL, title: "x", settled: true, readyMs: 1 };
    },
    closeBrowser: async () => {
      calls.closed += 1;
    },
    collectProducts: async () => {
      calls.collect += 1;
      return { products: products, livePinButtonsOnPage: livePins };
    },
    readIdentity: async () => {
      calls.identity += 1;
      return identity;
    },
    checkIdentity: require("../autopin/core").checkIdentity,
    isExpectedConsole: () => true,
    toBrowserConfig: (c) => ({
      consoleUrl: c.settings.consoleUrl,
      profileDir: c.settings.profileDir,
      debugDir: c.settings.debugDir,
      chromePath: c.settings.chromePath,
      expectedShop: c.settings.expectedShop,
      forbiddenShops: c.settings.forbiddenShops,
    }),
  };
  return { calls, discovery: createTikTokDiscovery(deps) };
}

/* === lebih sedikit pekerjaan browser ===================================== */

test("snapshot membaca halaman SEKALI untuk semua konsumen penasihat", async () => {
  const f = fakeDiscovery();
  const snap = await f.discovery.snapshot(CONFIG());

  assert.equal(snap.ok, true);
  assert.equal(f.calls.launch, 1, "lebih dari satu peluncuran browser");
  assert.equal(f.calls.collect, 1, "katalog dibaca " + f.calls.collect + "x");
  assert.equal(f.calls.identity, 1, "identitas dibaca " + f.calls.identity + "x");
  assert.equal(f.calls.closed, 1, "browser tidak ditutup tepat sekali");
});

// Perbandingan dengan jalur LAMA, supaya angka 1 di atas tidak terbaca sebagai
// kebetulan: tiga konsumen yang memanggil sendiri-sendiri = tiga peluncuran.
test("jalur lama memang tiga peluncuran untuk data yang sama", async () => {
  const f = fakeDiscovery();
  await f.discovery.status(CONFIG());
  await f.discovery.products(CONFIG());
  await f.discovery.products(CONFIG()); // yang dipakai validasi pemetaan
  assert.equal(f.calls.launch, 3, "ini bentuk yang DIHINDARI");
  assert.equal(f.calls.collect, 3);
});

test("browser tetap diluncurkan sebagai RUNTIME (headless)", async () => {
  const f = fakeDiscovery();
  await f.discovery.snapshot(CONFIG());
  assert.deepEqual(f.calls.purposes, [PURPOSE.RUNTIME]);
});

/* === proyeksi: snapshot sama, kontrak BERBEDA ============================ */

// Inti risiko perubahan ini. Masing-masing dibandingkan dengan jawaban fungsi
// PRODUKSI yang sebenarnya pada kondisi yang sama - bukan dengan harapan saya.
test("proyeksi status identik dengan status() sungguhan", async () => {
  const f = fakeDiscovery();
  const real = await f.discovery.status(CONFIG());
  const viaSnap = statusFromSnapshot(await f.discovery.snapshot(CONFIG()));
  assert.deepEqual(viaSnap, real);
});

test("proyeksi products identik dengan products() sungguhan", async () => {
  const f = fakeDiscovery();
  const real = await f.discovery.products(CONFIG());
  const viaSnap = productsFromSnapshot(await f.discovery.snapshot(CONFIG()));
  assert.deepEqual(viaSnap, real);
});

// Katalog KOSONG: status tetap melaporkan, products GAGAL. Perbedaan ini
// sengaja, dan menyeragamkannya akan mengubah apa yang dibaca panel kesiapan.
test("katalog kosong: status melaporkan 0, products gagal no-live-products", async () => {
  const f = fakeDiscovery({ products: [], livePins: 0 });
  const realStatus = await f.discovery.status(CONFIG());
  const realProducts = await f.discovery.products(CONFIG());
  const snap = await f.discovery.snapshot(CONFIG());

  assert.deepEqual(statusFromSnapshot(snap), realStatus);
  assert.deepEqual(productsFromSnapshot(snap), realProducts);

  // Dan isinya memang berbeda satu sama lain.
  assert.equal(realStatus.ok, true, "status tidak boleh gagal hanya karena etalase kosong");
  assert.equal(realStatus.productCount, 0);
  assert.equal(realProducts.ok, false);
  assert.equal(realProducts.reason, "no-live-products");
});

// LIVE mati: dashboard tetap terbuka dan katalog tetap terbaca, tapi tidak ada
// tombol Pin. `live` harus false di KEDUA proyeksi.
test("LIVE mati terdeteksi dari nol tombol Pin, katalog tetap terbaca", async () => {
  const f = fakeDiscovery({ livePins: 0, products: [{ id: "p1", title: "Kacang" }] });
  const snap = await f.discovery.snapshot(CONFIG());
  assert.equal(snap.live, false);
  assert.equal(statusFromSnapshot(snap).live, false);
  assert.equal(productsFromSnapshot(snap).livePinControlsAvailable, false);
  assert.equal(productsFromSnapshot(snap).ok, true, "katalog tetap sah saat LIVE belum mulai");
});

// Identitas gagal: products MENAHAN katalog sepenuhnya. Katalog dari toko yang
// salah lebih berbahaya daripada tidak ada katalog - ia terlihat benar.
test("identitas salah: katalog DITAHAN dari products, status tetap jujur", async () => {
  const f = fakeDiscovery({ identity: ["toko_orang_lain"] });
  const realStatus = await f.discovery.status(CONFIG());
  const realProducts = await f.discovery.products(CONFIG());
  const snap = await f.discovery.snapshot(CONFIG());

  assert.deepEqual(statusFromSnapshot(snap), realStatus);
  assert.deepEqual(productsFromSnapshot(snap), realProducts);

  assert.equal(realStatus.ok, false);
  assert.equal(realStatus.identityOk, false);
  assert.equal(realProducts.ok, false);
  assert.equal(realProducts.products, undefined, "katalog bocor padahal identitas salah");
  assert.equal(realProducts.reason, "wrong-tiktok-account");
});

test("identitas tidak terbaca sama sekali: diperlakukan sebagai belum login", async () => {
  const f = fakeDiscovery({ identity: [] });
  const snap = await f.discovery.snapshot(CONFIG());
  assert.equal(snap.identityOk, false);
  assert.equal(snap.identityReason, "tiktok-not-logged-in");
  assert.equal(productsFromSnapshot(snap).ok, false);
  assert.equal(productsFromSnapshot(snap).reason, "tiktok-not-logged-in");
});

test("expectedShop belum diisi tetap memblokir, bukan dilewati", async () => {
  const f = fakeDiscovery();
  const cfg = CONFIG();
  cfg.settings.expectedShop = "";
  const snap = await f.discovery.snapshot(cfg);
  assert.equal(snap.identityOk, false);
  assert.equal(snap.identityReason, "expected-shop-not-configured");
});

test("daftar terlarang tetap berlaku di snapshot", async () => {
  const f = fakeDiscovery({ identity: ["pt resmi official"] });
  const cfg = CONFIG();
  cfg.settings.expectedShop = "pt resmi official";
  cfg.settings.forbiddenShops = ["pt resmi"];
  const snap = await f.discovery.snapshot(cfg);
  assert.equal(snap.identityOk, false);
  assert.equal(snap.identityReason, "wrong-tiktok-account");
});

/* === kegagalan membuka halaman ========================================== */

// Sesi kadaluarsa: TikTok mengalihkan dan halamannya tetap memuat dengan
// sukses, jadi ini hanya terbaca dari URL - bukan dari error navigasi.
test("sesi kadaluarsa gagal lewat jalur yang sama dengan status/products", async () => {
  const f = fakeDiscovery();
  const d = createTikTokDiscovery(
    Object.assign({}, {
      launchBrowser: async () => ({}),
      getPage: async () => ({ url: () => "https://business.tiktokshop.com/us/creator/live" }),
      openConsole: async () => ({}),
      closeBrowser: async () => {},
      collectProducts: async () => ({ products: [], livePinButtonsOnPage: 0 }),
      readIdentity: async () => [],
      checkIdentity: require("../autopin/core").checkIdentity,
      isExpectedConsole: () => false,
      toBrowserConfig: (c) => ({ consoleUrl: c.settings.consoleUrl, profileDir: c.settings.profileDir }),
    })
  );
  const snap = await d.snapshot(CONFIG());
  assert.equal(snap.ok, false);
  assert.equal(snap.reason, "tiktok-not-logged-in");
  // Dan bentuknya sama dengan yang dikembalikan kedua fungsi lama.
  assert.deepEqual(await d.status(CONFIG()), snap);
  assert.deepEqual(await d.products(CONFIG()), snap);
  assert.ok(f.calls.launch === 0);
});

test("dashboard tidak bisa dibuka: ok=false, tidak ada data yang dikarang", async () => {
  const d = createTikTokDiscovery({
    launchBrowser: async () => {
      throw new Error("chrome exploded");
    },
    getPage: async () => ({ url: () => CONSOLE_URL }),
    openConsole: async () => ({}),
    closeBrowser: async () => {},
    collectProducts: async () => ({ products: [], livePinButtonsOnPage: 0 }),
    readIdentity: async () => [],
    checkIdentity: require("../autopin/core").checkIdentity,
    isExpectedConsole: () => true,
    toBrowserConfig: (c) => ({ consoleUrl: c.settings.consoleUrl, profileDir: c.settings.profileDir }),
  });
  const snap = await d.snapshot(CONFIG());
  assert.equal(snap.ok, false);
  assert.equal(snap.reason, "product-dashboard-unavailable");
  assert.equal(snap.products, undefined);
  assert.equal(snap.identity, undefined);
});

/* === tidak ada cache ===================================================== */

// Batasnya STRUKTURAL: snapshot adalah variabel lokal di dalam satu panggilan.
// Panggilan kedua WAJIB membaca halaman lagi.
test("snapshot kedua membaca halaman LAGI - tidak ada yang disimpan", async () => {
  const f = fakeDiscovery();
  await f.discovery.snapshot(CONFIG());
  await f.discovery.snapshot(CONFIG());
  assert.equal(f.calls.launch, 2, "panggilan kedua memakai hasil lama");
  assert.equal(f.calls.collect, 2);
});

const DISCOVERY_SRC = fs.readFileSync(path.join(__dirname, "..", "controller", "discovery", "tiktok.js"), "utf8");
const CONTROLLER_SRC = fs.readFileSync(path.join(__dirname, "..", "controller", "controller.js"), "utf8");

// Penjaga sumber: tidak ada tempat penyimpanan antar-panggilan yang muncul
// diam-diam. Tes perilaku di atas tidak akan menangkap cache ber-TTL yang
// kebetulan kedaluwarsa di antara dua panggilan tes.
// KOMENTAR DIBUANG dulu. Versi pertama tes ini memindai sumber mentah dan
// langsung merah karena komentar saya sendiri berbunyi "tidak ada TTL" -
// penjaga yang membaca prosa, bukan kode, akan menuduh kalimat yang justru
// menjelaskan kenapa cache-nya tidak ada.
function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("tidak ada cache/TTL yang diperkenalkan", () => {
  for (const [name, src] of [["discovery/tiktok.js", DISCOVERY_SRC], ["controller.js", CONTROLLER_SRC]]) {
    const code = codeOnly(src);
    // `\bttl` tanpa batas kata di ujung belakang: `ttlMs`, `TTL_MS`, dan `ttl`
    // sama-sama tertangkap. `\bttl\b` hanya menangkap yang terakhir.
    for (const re of [/\bttl/i, /cacheUntil/i, /lastSnapshot/i, /snapshotCache/i, /cachedProducts/i]) {
      assert.doesNotMatch(code, re, name + " memperkenalkan cache: " + re);
    }
  }

  // Penjaganya sendiri harus bisa gagal: kalau codeOnly() terlalu rakus, tes di
  // atas lulus untuk alasan yang salah.
  assert.match(codeOnly("const ttlMs = 5;\n// tidak ada ttl\n"), /\bttl/i, "ttlMs lolos dari penjaga");
  assert.doesNotMatch(codeOnly("// tidak ada TTL di sini\n"), /\bttl/i, "komentar ikut dituduh");
});

// Snapshot penasihat TIDAK BOLEH sampai ke startAutomation. Kalau ia diteruskan,
// /api/start berhenti menjadi pembacaan segar dan jaminan fail-closed hilang.
test("snapshot penasihat tidak pernah diteruskan ke startAutomation", () => {
  const start = CONTROLLER_SRC.slice(
    CONTROLLER_SRC.indexOf("async function startAutomation"),
    CONTROLLER_SRC.indexOf("async function stopAutomation")
  );
  assert.ok(start.length > 0, "startAutomation tidak ditemukan");
  assert.equal(start.indexOf("discoverTikTokSnapshot"), -1, "start memakai snapshot penasihat");
  assert.equal(start.indexOf("statusFromSnapshot"), -1);
  assert.equal(start.indexOf("productsFromSnapshot"), -1);
  // Dan ia masih menjalankan preflight-nya sendiri.
  assert.ok(start.indexOf("preflight.run(config)") !== -1, "start tidak lagi menjalankan preflight sendiri");
});

/* === probe tidak diparalelkan =========================================== */

// Satu direktori profil hanya boleh dipegang satu proses Chromium. Optimasinya
// adalah pekerjaan browser yang LEBIH SEDIKIT, bukan lebih banyak sekaligus.
test("tidak ada pembacaan TikTok yang dijalankan bersamaan", () => {
  const APP = fs.readFileSync(path.join(__dirname, "..", "controller", "public", "app.js"), "utf8");
  const body = APP.slice(APP.indexOf("function loadDiscovery"), APP.indexOf("function loadValidation"));
  assert.ok(body.length > 0);
  // Hanya SATU panggilan TikTok yang tersisa di jalur ini, jadi tidak ada yang
  // bisa diparalelkan - dan jobs paralel hanya memuat OBS.
  const tiktokCalls = (body.match(/api\("\/api\/(discovery|tiktok\/[a-z]+)"/g) || []);
  assert.deepEqual(tiktokCalls, ['api("/api/discovery"'], "jumlah/bentuk panggilan TikTok berubah");
  assert.ok(body.indexOf('jobs = [guarded(api("/api/obs/scenes"))') !== -1, "jobs paralel harus tetap hanya OBS");
});
