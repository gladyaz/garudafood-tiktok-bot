"use strict";
// Penemuan status LIVE dan katalog produk TikTok. HANYA MEMBACA.
//
// ---------------------------------------------------------------------------
// APA YANG MODUL INI TIDAK PERNAH LAKUKAN
//
// Tidak pernah mengklik Pin. Tidak pernah mengetik di chat. Tidak pernah
// mengirim apa pun. Tidak pernah mengubah urutan produk. Tidak pernah menyentuh
// `.pc_top_product` sebagai pengganti Pin — kontrol itu memang ada di DOM dan
// memang terlihat seperti tombol pin, tapi ia MENGUBAH urutan daftar, dan
// autopin/products.js sudah menandainya sebagai diagnostik saja.
//
// Yang dipakai hanya: buka halaman dashboard, baca identitas, gulir daftar
// produk, baca barisnya. Fungsi yang dipanggil adalah collectProducts() dan
// readIdentity() yang SAMA dengan yang dipakai jalur pin — bukan tiruan — supaya
// "produk yang terlihat di UI" dan "produk yang nanti dicari saat pin" tidak
// pernah bisa jadi dua daftar berbeda.
//
// ---------------------------------------------------------------------------
// KENAPA DISCOVERY TIDAK BISA JALAN SAAT AUTOMATION BERJALAN
//
// Profil Chrome terkunci SATU proses. Saat automation berjalan, service AutoPIN
// yang memegang profil itu (lihat catatan di autopin-service.js: service dan CLI
// tidak boleh jalan bersamaan). Kalau Controller memaksa membuka browser kedua
// dengan profil yang sama, yang terjadi bukan error yang rapi — ia bisa merusak
// sesi login yang dipakai service untuk memin produk sungguhan di tengah LIVE.
//
// Jadi discovery menolak dengan `discovery-unavailable-while-running`. Alur yang
// dimaksudkan memang: discover dulu, atur mapping, baru Start.
//
// ---------------------------------------------------------------------------
// IDENTITAS PRODUK
//
// DOM TikTok tidak mengekspos id produk/SKU — autopin/products.js membacanya
// sebagai `productId: ""` karena memang tidak ada di sana. Jadi `stableId`
// dilaporkan null, dan TIDAK dikarang dari nomor baris: nomor bergeser setiap
// kali ada aksi pin (lihat autopin/VERIFICATION.md), jadi nomor sebagai
// identitas adalah identitas yang berubah sendiri.

const DEFAULT_TIMEOUT_MS = 45000;

// Bentuk produk yang keluar ke Controller/UI. Sempit dengan sengaja: yang lain
// (pinClass, icons, ariaOnRow, badges, imageKey) adalah diagnostik internal dan
// tidak ada gunanya di layar customer.
function toPublicProduct(p) {
  return {
    title: p.title || "",
    number: Number.isInteger(p.number) ? p.number : null,
    price: p.price || "",
    stock: p.stock || "",
    pinText: p.pinText || "",
    // Kontrol pin ADA untuk produk ini atau tidak. Inilah yang membedakan
    // "LIVE sedang jalan" dari "halaman terbuka tapi bukan sesi LIVE".
    pinAvailable: Number(p.pinButtons) > 0,
    pinDisabled: p.pinDisabled === true,
    // null, dan tidak pernah dikarang. Lihat catatan di kepala berkas.
    stableId: null,
  };
}

function createTikTokDiscovery({
  // Semua di-inject. Tanpa injeksi modul ini tidak memuat Puppeteer dan tidak
  // membuka apa pun — itulah yang membuat seluruh tes P2 bisa offline.
  launchBrowser = null,
  getPage = null,
  openConsole = null,
  closeBrowser = null,
  collectProducts = null,
  readIdentity = null,
  checkIdentity = null,
  // Pemeriksa "halaman yang terbuka memang dashboard produk". Fungsi yang SAMA
  // yang dipakai autopin/service.js sebelum mengklik apa pun.
  isExpectedConsole = null,
  // Customer config -> bentuk config yang dipahami launchBrowser/openConsole.
  // Wajib: meneruskan customer config apa adanya membuat profileDir undefined.
  toBrowserConfig = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  log = () => {},
} = {}) {
  function missingDeps() {
    return [
      launchBrowser, getPage, openConsole, closeBrowser,
      collectProducts, readIdentity, checkIdentity, isExpectedConsole, toBrowserConfig,
    ].some((d) => typeof d !== "function");
  }

  // Satu sesi browser read-only: buka, kerjakan satu fungsi, tutup. Browser
  // SELALU ditutup, termasuk saat gagal — browser yang tertinggal memegang
  // profil, dan Start berikutnya akan gagal dengan sebab yang menyesatkan.
  async function withPage(config, fn) {
    if (missingDeps()) return { ok: false, reason: "discovery-not-configured" };

    let browser = null;
    let timer = null;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      if (timer && typeof timer.unref === "function") timer.unref();
    });

    try {
      const work = (async () => {
        // Config DITERJEMAHKAN lebih dulu. launchBrowser membaca
        // config.profileDir, sementara customer config menyimpannya di
        // config.settings.profileDir — meneruskannya apa adanya membuat
        // profileDir undefined dan ensurePrivateDir() langsung melempar.
        const bcfg = toBrowserConfig(config);
        browser = await launchBrowser(bcfg);
        const page = await getPage(browser);
        await openConsole(page, bcfg);

        // openConsole TIDAK mengembalikan { ok }: ia melempar saat navigasi gagal,
        // dan kalau berhasil ia mengembalikan { url, title, settled, readyMs }.
        // Jadi "benarkah ini dashboard produk" harus diperiksa dari URL halaman,
        // dengan fungsi yang SAMA yang dipakai service sebelum mengklik.
        //
        // Inilah pembeda "sesi login kadaluarsa" dari "dashboard tidak terbuka":
        // TikTok mengalihkan ke halaman lain saat belum login, dan halamannya
        // tetap memuat dengan sukses.
        if (!isExpectedConsole(page.url(), bcfg.consoleUrl)) {
          return { ok: false, reason: "tiktok-not-logged-in" };
        }
        return fn(page);
      })();

      return await Promise.race([work, deadline]);
    } catch (err) {
      const msg = String((err && err.message) || "").toLowerCase();
      if (msg.includes("timeout")) return { ok: false, reason: "product-discovery-timeout" };
      log("DISCOVERY_FAILED", { detail: String((err && err.message) || "").slice(0, 120) });
      return { ok: false, reason: "product-dashboard-unavailable" };
    } finally {
      if (timer) clearTimeout(timer);
      if (browser) {
        try {
          await closeBrowser(browser);
        } catch {
          /* sudah tertutup, atau tidak bisa ditutup: tidak mengubah hasil baca */
        }
      }
    }
  }

  // Bentuk hasil readIdentity() dinormalkan di SATU tempat: ia mengembalikan
  // array string. Toleran terhadap null supaya halaman tanpa avatar tidak
  // melempar, tapi TIDAK menebak bentuk lain — bentuk yang salah berarti
  // identitas tidak terbaca, dan itu harus gagal, bukan dikarang.
  async function readObserved(page) {
    const seen = await readIdentity(page);
    return Array.isArray(seen) ? seen.filter((x) => typeof x === "string" && x.trim() !== "") : [];
  }

  // Identitas yang terlihat di halaman harus LOLOS gerbang yang sama dengan
  // jalur pin: persis sama dengan expectedShop, dan tidak mengandung nama toko
  // produksi yang dilarang. Gerbang itu tidak dilemahkan untuk discovery hanya
  // karena discovery tidak mengklik apa pun — identitas yang salah berarti kita
  // sedang melihat katalog toko yang salah, dan mapping akan dibuat atas dasar
  // daftar produk milik orang lain.
  function verifyIdentity(config, observed) {
    const verdict = checkIdentity({
      expected: config.settings.expectedShop,
      observed: Array.isArray(observed) ? observed : [observed].filter(Boolean),
      forbidden: config.settings.forbiddenShops,
    });
    if (verdict.ok) return { ok: true };
    if (verdict.reason === "identity-not-found") return { ok: false, reason: "tiktok-not-logged-in" };
    if (verdict.reason === "forbidden-shop") return { ok: false, reason: "wrong-tiktok-account" };
    if (verdict.reason === "expected-shop-not-configured") return { ok: false, reason: "expected-shop-not-configured" };
    return { ok: false, reason: "wrong-tiktok-account" };
  }

  async function status(config) {
    return withPage(config, async (page) => {
      // readIdentity() mengembalikan ARRAY nama yang terbaca di halaman — bentuk
      // yang sama yang diteruskan autopin/service.js ke checkIdentity(). Membaca
      // `.observed` darinya selalu undefined, dan identitas akan SELALU gagal.
      const observed = await readObserved(page);
      const idv = verifyIdentity(config, observed);

      // Katalog dibaca juga di /status, karena "LIVE sedang berjalan" tidak bisa
      // dijawab dari URL halaman: dashboard tetap terbuka saat LIVE mati. Yang
      // membedakan adalah ADA tombol Pin per produk atau tidak.
      const snap = await collectProducts(page, {});
      const livePins = Number(snap && snap.livePinButtonsOnPage) || 0;
      const count = snap && Array.isArray(snap.products) ? snap.products.length : 0;

      return {
        ok: idv.ok,
        identity: observed[0] || null,
        identityOk: idv.ok,
        identityReason: idv.ok ? null : idv.reason,
        live: livePins > 0,
        dashboardReady: true,
        // Kesiapan komposer chat butuh membuka tab chat, dan itu di luar yang
        // dibutuhkan untuk menyusun mapping. Dilaporkan null = belum diperiksa,
        // bukan false yang akan terbaca sebagai "chat rusak".
        chatReady: null,
        productCount: count,
      };
    });
  }

  async function products(config) {
    return withPage(config, async (page) => {
      const observed = await readObserved(page);
      const idv = verifyIdentity(config, observed);
      // Identitas diperiksa SEBELUM katalog dikembalikan. Katalog dari toko yang
      // salah lebih berbahaya daripada tidak ada katalog: ia terlihat benar.
      if (!idv.ok) return { ok: false, reason: idv.reason };

      const snap = await collectProducts(page, {});
      const raw = snap && Array.isArray(snap.products) ? snap.products : [];
      if (raw.length === 0) return { ok: false, reason: "no-live-products", count: 0, products: [] };

      const livePins = Number(snap && snap.livePinButtonsOnPage) || 0;
      const list = raw.map(toPublicProduct);

      return {
        ok: true,
        count: list.length,
        products: list,
        // Dilaporkan, tidak ditebak: daftar produk bisa terbaca lengkap padahal
        // LIVE belum on air, dan mapping yang dibuat dari daftar itu tetap sah.
        livePinControlsAvailable: livePins > 0,
        identity: observed[0] || null,
      };
    });
  }

  return { status, products, toPublicProduct };
}

module.exports = { createTikTokDiscovery, toPublicProduct, DEFAULT_TIMEOUT_MS };
