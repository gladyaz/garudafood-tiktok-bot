"use strict";
// Login TikTok dari aplikasi, menggantikan `node autopin-cli.js login`.
//
// ---------------------------------------------------------------------------
// ATURAN YANG TIDAK BISA DITAWAR
//
// AI LIVE HOST TIDAK PERNAH meminta, menerima, menyimpan, mencatat, atau
// mengirimkan password TikTok customer. Login tetap dilakukan MANUAL oleh customer
// di dalam jendela browser yang dibuka aplikasi.
//
// Yang dilakukan modul ini hanya: membuka browser dengan profil yang sama yang
// nanti dipakai AutoPIN, mengarahkannya ke halaman dashboard, lalu MENUNGGU.
// Ia tidak mengetik apa pun, tidak menyentuh field password, tidak membaca cookie,
// dan tidak membaca token. Satu-satunya hal yang dibacanya dari halaman adalah
// nama akun yang terlihat — lewat readIdentity() yang SAMA yang dipakai jalur pin.
//
// ---------------------------------------------------------------------------
// KENAPA HARUS PROFIL YANG SAMA
//
// Sesi login hidup di direktori profil Chrome. Kalau login dilakukan di jendela
// lain (mis. BrowserWindow Electron), sesinya tersimpan di tempat lain dan
// AutoPIN tetap tidak login. Jadi login WAJIB memakai profil automation, dan
// karena Chrome mengunci profil ke satu proses, login dan automation tidak bisa
// berjalan bersamaan. Itu diurus controller/profile-owner.js.
//
// ---------------------------------------------------------------------------
// KENAPA AKUN YANG SALAH DITOLAK
//
// Pin mengklik produk di akun yang sedang login. Kalau yang login ternyata akun
// lain, pin akan mengubah LIVE milik orang lain. Jadi gerbang identitas yang sama
// dengan jalur pin dipakai di sini juga, dan akun yang tidak cocok TIDAK diterima
// diam-diam.

const { OWNER } = require("./profile-owner");

const STATE = Object.freeze({
  IDLE: "idle",
  WAITING: "waiting", // browser terbuka, customer sedang login
});

function createLoginFlow({
  // Semua fungsi browser di-inject. Tanpa injeksi, modul ini tidak memuat
  // Puppeteer dan tidak membuka apa pun.
  launchBrowser = null,
  getPage = null,
  openConsole = null,
  closeBrowser = null,
  readIdentity = null,
  checkIdentity = null,
  isExpectedConsole = null,
  // Customer config -> bentuk config yang dipahami launchBrowser/openConsole.
  toBrowserConfig = null,
  ownership = null,
  log = () => {},
  now = () => Date.now(),
} = {}) {
  let state = STATE.IDLE;
  let browser = null;
  let page = null;
  let startedAt = null;
  let lastIdentity = null;

  function configured() {
    return (
      [launchBrowser, getPage, openConsole, closeBrowser, readIdentity, checkIdentity, isExpectedConsole, toBrowserConfig].every(
        (f) => typeof f === "function"
      ) && !!ownership
    );
  }

  function describe() {
    return {
      // Bentuk tetap, supaya UI tidak perlu menebak.
      active: state === STATE.WAITING,
      state,
      startedAt,
      // Identitas terakhir yang TERBUKTI, bukan dugaan.
      identity: lastIdentity,
      profileOwner: ownership ? ownership.owner() : OWNER.NONE,
    };
  }

  // Membereskan browser dan melepas profil. Dipanggil dari SETIAP jalan keluar:
  // sukses, akun salah, cancel, dan cleanup. Browser yang tertinggal memegang
  // profil, dan Start berikutnya akan gagal dengan sebab yang menyesatkan.
  async function teardown(reason) {
    const b = browser;
    browser = null;
    page = null;
    state = STATE.IDLE;
    startedAt = null;
    if (b) {
      try {
        await closeBrowser(b);
      } catch {
        /* sudah tertutup; tidak mengubah apa pun */
      }
    }
    if (ownership) ownership.release(OWNER.LOGIN);
    log("LOGIN_CLOSED", { reason: reason || "done" });
  }

  // --- start ---------------------------------------------------------------

  async function start(config) {
    if (!configured()) return { ok: false, reason: "login-not-configured" };
    if (state === STATE.WAITING) {
      // Dua jendela login berarti dua proses memegang profil yang sama. Ditolak.
      return { ok: false, reason: "login-already-in-progress" };
    }

    // Profil harus bebas. Kalau service memegangnya, yang benar adalah menyuruh
    // customer menghentikan automation dulu — bukan memaksa membuka profil yang
    // sedang dipakai mengklik produk sungguhan.
    const claim = ownership.acquire(OWNER.LOGIN);
    if (!claim.ok) return { ok: false, reason: claim.reason };

    let bcfg;
    try {
      bcfg = toBrowserConfig(config);
    } catch {
      ownership.release(OWNER.LOGIN);
      return { ok: false, reason: "config-invalid" };
    }

    try {
      browser = await launchBrowser(bcfg);
      page = await getPage(browser);
    } catch (err) {
      // launchBrowser melempar `profile-in-use` kalau Chrome lain masih memegang
      // direktori profil — mis. jendela yang ditinggalkan operator terbuka.
      const reason = err && err.reason === "profile-in-use" ? "profile-busy-external" : "login-browser-failed";
      await teardown(reason);
      return { ok: false, reason };
    }

    // Navigasi ke dashboard. Kegagalan di sini BUKAN kegagalan login: customer
    // yang belum login memang akan dialihkan, dan itu justru keadaan normal saat
    // tombol LOGIN TIKTOK ditekan.
    try {
      await openConsole(page, bcfg);
    } catch (err) {
      log("LOGIN_NAV_INCOMPLETE", { detail: String((err && err.message) || "").slice(0, 120) });
    }

    state = STATE.WAITING;
    startedAt = now();
    log("LOGIN_WAITING", { note: "customer login manual di jendela browser; tidak ada kredensial yang disentuh aplikasi" });
    // Kembali SEGERA. Menunggu customer selesai login bisa belasan menit, dan
    // menahan permintaan HTTP selama itu akan membuat UI tampak menggantung.
    return { ok: true, loginInProgress: true };
  }

  // --- check / finish ------------------------------------------------------

  // Dipanggil saat customer menekan CHECK LOGIN.
  async function check(config) {
    if (!configured()) return { ok: false, reason: "login-not-configured" };
    if (state !== STATE.WAITING) return { ok: false, reason: "login-not-in-progress" };
    if (!page) return { ok: false, reason: "login-browser-failed" };

    let bcfg;
    try {
      bcfg = toBrowserConfig(config);
    } catch {
      return { ok: false, reason: "config-invalid" };
    }

    // Jendela yang sudah ditutup customer tanpa menekan apa pun.
    if (browser && browser.connected === false) {
      await teardown("browser-closed");
      return { ok: false, reason: "login-window-closed" };
    }

    // Masih di halaman login / dialihkan = belum selesai. Bukan kegagalan;
    // customer hanya belum selesai mengisi.
    let url = "";
    try {
      url = page.url();
    } catch {
      await teardown("page-gone");
      return { ok: false, reason: "login-window-closed" };
    }
    if (!isExpectedConsole(url, bcfg.consoleUrl)) {
      return { ok: false, reason: "login-not-finished" };
    }

    // Nama akun yang terlihat. readIdentity() mengembalikan ARRAY string.
    let observed;
    try {
      const seen = await readIdentity(page);
      observed = Array.isArray(seen) ? seen.filter((x) => typeof x === "string" && x.trim() !== "") : [];
    } catch {
      return { ok: false, reason: "login-not-finished" };
    }
    if (observed.length === 0) return { ok: false, reason: "login-not-finished" };

    // Gerbang identitas yang SAMA dengan jalur pin. Tidak dilemahkan di sini.
    const verdict = checkIdentity({
      expected: config.settings.expectedShop,
      observed,
      forbidden: config.settings.forbiddenShops,
    });

    if (!verdict.ok) {
      const reason =
        verdict.reason === "expected-shop-not-configured"
          ? "expected-shop-not-configured"
          : verdict.reason === "identity-not-found"
            ? "login-not-finished"
            : "wrong-tiktok-account";
      // Akun yang salah TIDAK diterima diam-diam. Jendela ditutup supaya customer
      // bisa keluar dan masuk dengan akun yang benar, dan profil dilepas.
      if (reason === "wrong-tiktok-account") {
        log("LOGIN_WRONG_ACCOUNT", { observed: observed[0] || "(unknown)" });
        await teardown("wrong-account");
      }
      return { ok: false, reason, identity: observed[0] || null };
    }

    lastIdentity = observed[0] || null;
    // Sukses: jendela ditutup, PROFIL TETAP tersimpan di disk. Itulah yang dipakai
    // AutoPIN nanti — sesi yang baru dibuat customed tetap ada sesudah jendelanya
    // tertutup.
    await teardown("logged-in");
    log("LOGIN_OK", { identity: lastIdentity });
    return { ok: true, loggedIn: true, identity: lastIdentity };
  }

  // --- cancel --------------------------------------------------------------

  async function cancel() {
    if (state !== STATE.WAITING) {
      // Idempoten: membatalkan yang tidak berjalan bukan kesalahan.
      return { ok: true, cancelled: false };
    }
    await teardown("cancelled");
    return { ok: true, cancelled: true };
  }

  // Dipanggil Controller saat membereskan semuanya.
  async function cleanup(reason) {
    if (state === STATE.WAITING || browser) await teardown(reason || "cleanup");
    return { ok: true };
  }

  return { start, check, cancel, cleanup, describe, state: () => state, STATE };
}

module.exports = { createLoginFlow, STATE };
