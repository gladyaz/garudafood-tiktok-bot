"use strict";
// Service AutoPIN: SATU browser + SATU halaman LIVE console yang hidup lama,
// dijalankan sebagai proses TERPISAH dari bot.
//
// Kenapa terpisah:
//   - Chromium tidak ikut dimuat ke proses bot yang sudah terbukti stabil
//   - browser yang crash tidak menjatuhkan playback
//   - halaman tidak perlu dibuka ulang per scene (startup ~8-10 detik; video
//     PAX hanya ~40-46 detik, jadi membuka browser per pin akan telat)
//
// Semua aksi UI diserialkan: satu halaman tidak boleh mengklik dua pin bersamaan.

const express = require("express");
const { log, checkIdentity, createSerialRunner, normalizeTitleKey, resolveProductForPin } = require("./core");
const { loadConfig } = require("./config");
const browserMod = require("./browser");
const productsMod = require("./products");
const { createBrowserTransport } = require("../autocomment/browser-transport");

const DEFAULT_PORT = 5055;
const LOOPBACK = "127.0.0.1";

function isExpectedConsole(actualUrl, consoleUrl) {
  try {
    const a = new URL(actualUrl);
    const b = new URL(consoleUrl);
    return a.origin === b.origin && a.pathname === b.pathname;
  } catch {
    return false;
  }
}

// deps bisa diganti pada tes supaya jalur penolakan dan urutan aksi dapat
// diperiksa tanpa membuka browser sungguhan.
function createService({ config = loadConfig(), dryRun = false, deps = {} } = {}) {
  const d = {
    launchBrowser: browserMod.launchBrowser,
    getPage: browserMod.getPage,
    openConsole: browserMod.openConsole,
    closeBrowser: browserMod.closeBrowser,
        // Tab kedua khusus chat. Dipisah dari halaman produk supaya scraping
        // AutoPIN dan pemeriksaan komposer AutoComment tidak pernah berbagi DOM.
        newPage: (b) => b.newPage(),
    collectProducts: productsMod.collectProducts,
    readIdentity: productsMod.readIdentity,
    pinProductByTitle: productsMod.pinProductByTitle,
    readPinState: productsMod.readPinState,
    ...deps,
  };

  const runExclusive = createSerialRunner();
  let browser = null;
  let page = null;
    let chatPage = null;
  // playId terbesar yang pernah DITERIMA (bukan yang sedang dikerjakan).
  // Dicatat di pintu masuk, sebelum antrean, supaya pekerjaan yang sedang
  // berjalan bisa tahu dirinya sudah tidak relevan.
  let latestPlayId = 0;

  const isStale = (id) => id > 0 && id < latestPlayId;

  async function ensurePage() {
    if (browser && page && !page.isClosed()) return page;
    if (browser) {
      try {
        await d.closeBrowser(browser);
      } catch {
        /* abaikan: kita memang sedang membangun ulang */
      }
    }
    browser = await d.launchBrowser(config);
    page = await d.getPage(browser);

    // Profil persisten bisa memulihkan beberapa tab. Tab latar di-throttle Chrome:
    // daftar produk yang ter-virtualisasi tidak pernah ter-render, sehingga
    // halaman terlihat "tidak punya produk" padahal header akunnya terbaca.
    // Halaman harus benar-benar di depan sebelum discraping.
    if (typeof page.bringToFront === "function") {
      try {
        await page.bringToFront();
      } catch {
        /* bukan alasan untuk membatalkan: scraping tetap dicoba */
      }
    }

    const info = await d.openConsole(page, config);
    log("SERVICE_PAGE_READY", { url: info.url, settled: info.settled, readyMs: info.readyMs });
    return page;
  }

    // Halaman chat: tab TERPISAH di browser yang SAMA. Profil Chrome hanya bisa
    // dipegang satu proses, jadi proses/profil kedua bukan pilihan; tab kedua
    // memberi isolasi DOM tanpa login kedua.
    async function ensureChatPage() {
      if (chatPage && !chatPage.isClosed()) return chatPage;
      await ensurePage(); // pastikan browser hidup dan sudah login
      chatPage = await d.newPage(browser);
      const info = await d.openConsole(chatPage, config);
      log("SERVICE_CHAT_PAGE_READY", { url: info.url, settled: info.settled, readyMs: info.readyMs });
      return chatPage;
    }

    // AR2A: satu-satunya mode. Transport ini tidak punya jalur mengetik/mengklik.
    const commentTransport = createBrowserTransport({ getPage: ensureChatPage, dryRun: true });

    // Diserialkan lewat runner yang SAMA dengan pin: walau halamannya beda, dua
    // pekerjaan UI Puppeteer tidak boleh berjalan bersamaan di AR2A.
    async function handleCommentDryRun({ text, scene, playId }) {
      if (typeof text !== "string" || text.trim() === "") return { ok: false, reason: "empty-message" };
      return runExclusive(async () => {
        try {
          return await commentTransport.send({ text, scene, playId });
        } catch (err) {
          log("SERVICE_COMMENT_ERROR", { scene, detail: String(err && err.message).slice(0, 120) });
          return { ok: false, reason: "comment-dry-run-error" };
        }
      });
    }

  // Gerbang yang sama persis dengan CLI yang sudah terverifikasi.
  async function guardedPin({ scene, productKey, playId }) {
    const p = await ensurePage();

    if (!isExpectedConsole(p.url(), config.consoleUrl)) {
      return { ok: false, reason: "unexpected-page" };
    }

    const observed = await d.readIdentity(p);
    const verdict = checkIdentity({
      expected: config.expectedShop,
      observed,
      forbidden: config.forbiddenShops,
    });
    if (!verdict.ok) return { ok: false, reason: `identity-${verdict.reason}` };

    const snapshot = await d.collectProducts(p);
    if (snapshot.products.length === 0) return { ok: false, reason: "no-products-found" };
    if (!snapshot.livePinButtonsOnPage) return { ok: false, reason: "live-pin-control-not-available" };

    const resolved = resolveProductForPin(snapshot.products, productKey);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };

    // === GERBANG TERAKHIR SEBELUM MENYENTUH UI ===
    // Semua langkah di atas memakan waktu (halaman siap, identitas, scraping
    // produk). Selama itu scene bisa sudah berganti. Memeriksa playId setelah
    // klik tidak ada gunanya: produk yang salah sudah tampil ke penonton.
    if (isStale(playId)) {
      log("SERVICE_STALE", { scene, playId, latest: latestPlayId, phase: "before-click" });
      return { ok: false, reason: "stale-before-click", clicked: false };
    }

    if (dryRun) {
      const probe = await d.pinProductByTitle(p, productKey, { dryRun: true });
      return probe.ok
        ? { ok: true, reason: "dry-run", title: probe.title, clicked: false }
        : { ok: false, reason: probe.reason };
    }

    const act = await d.pinProductByTitle(p, productKey, { dryRun: false });
    if (!act.ok) return { ok: false, reason: act.reason };

    const after = await d.readPinState(p, productKey);
    log("SERVICE_PINNED", { scene, title: act.title, after: after.text });
    return { ok: true, reason: "pinned", title: act.title, state: after.text, clicked: true };
  }

  async function handlePin({ scene, productKey, playId }) {
    if (typeof productKey !== "string" || !normalizeTitleKey(productKey)) {
      return { ok: false, reason: "empty-product-key" };
    }
    const id = Number.isFinite(playId) ? playId : 0;
    if (isStale(id)) return { ok: false, reason: "stale" };
    if (id > latestPlayId) latestPlayId = id;

    return runExclusive(async () => {
      // Dicek lagi DI DALAM antrean: permintaan yang lebih baru bisa datang
      // selama kita menunggu giliran. Yang menang adalah yang terbaru.
      if (isStale(id)) {
        log("SERVICE_STALE", { scene, playId: id, latest: latestPlayId, phase: "queued" });
        return { ok: false, reason: "stale" };
      }
      try {
        return await guardedPin({ scene, productKey, playId: id });
      } catch (err) {
        const reason = err && err.reason ? err.reason : "pin-error";
        log("SERVICE_ERROR", { scene, reason, detail: String(err && err.message).slice(0, 120) });
        return { ok: false, reason };
      }
    });
  }

  const app = express();
  app.use(express.json({ limit: "16kb" }));

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      dryRun,
      pageOpen: !!(page && !page.isClosed()),
            chatPageOpen: !!(chatPage && !chatPage.isClosed()),
            commentTransport: "dry-run",
      latestPlayId,
      expectedShop: config.expectedShop || null,
    });
  });

  app.post("/pin", async (req, res) => {
    const { scene, productKey, playId } = req.body || {};
    try {
      const result = await handlePin({ scene, productKey, playId });
      res.json(result);
    } catch (err) {
      // handlePin sudah menangkap semuanya; ini jaring terakhir agar service
      // tidak pernah membalas dengan koneksi terputus.
      res.json({ ok: false, reason: "service-error" });
    }
  });

  // Dipanggil sekali saat service start: membuka browser lebih awal supaya
  // permintaan pin PERTAMA tidak menanggung ~20 detik startup, yang pasti
  // melewati batas waktu dispatcher di sisi bot.
  async function warmUp() {
    try {
      await ensurePage();
      return { ok: true };
    } catch (err) {
      log("SERVICE_WARMUP_FAILED", { detail: String(err && err.message).slice(0, 120) });
      return { ok: false };
    }
  }

    app.post("/comment/dry-run", async (req, res) => {
      const { text, scene, playId } = req.body || {};
      try {
        res.json(await handleCommentDryRun({ text, scene, playId }));
      } catch {
        res.json({ ok: false, reason: "service-error" });
      }
    });

  async function stop() {
    if (browser) await d.closeBrowser(browser).catch(() => {});
    browser = null;
    chatPage = null;
    page = null;
  }

  return {
    app,
    handlePin,
    handleCommentDryRun,
    ensureChatPage,
    stop,
    warmUp,
    __state: () => ({ latestPlayId, hasPage: !!page, hasChatPage: !!chatPage }),
  };
}

// Selalu loopback: /pin tidak boleh bisa dipanggil dari perangkat lain di LAN.
// Host sengaja TIDAK dibuat bisa dikonfigurasi lewat environment.
function startService({ port = Number(process.env.AUTOPIN_PORT) || DEFAULT_PORT, ...rest } = {}) {
  const svc = createService(rest);
  return new Promise((resolve) => {
    const server = svc.app.listen(port, LOOPBACK, () => {
      const addr = server.address();
      log("SERVICE_LISTENING", { host: addr.address, port: addr.port, dryRun: !!rest.dryRun });
      svc.warmUp().then((w) => log("SERVICE_WARMED", { ok: w.ok }));
      resolve({ ...svc, server });
    });
  });
}

module.exports = { createService, startService, isExpectedConsole, DEFAULT_PORT, LOOPBACK };
