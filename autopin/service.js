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
const { launchBrowser, getPage, openConsole, closeBrowser } = require("./browser");
const { collectProducts, readIdentity, pinProductByTitle, readPinState } = require("./products");

const DEFAULT_PORT = 5055;

function isExpectedConsole(actualUrl, consoleUrl) {
  try {
    const a = new URL(actualUrl);
    const b = new URL(consoleUrl);
    return a.origin === b.origin && a.pathname === b.pathname;
  } catch {
    return false;
  }
}

function createService({ config = loadConfig(), dryRun = false } = {}) {
  const runExclusive = createSerialRunner();
  let browser = null;
  let page = null;
  // playId terbesar yang pernah diterima. Permintaan lama yang baru sempat
  // dijalankan setelah scene berganti dibuang, bukan diklik terlambat.
  let latestPlayId = 0;

  async function ensurePage() {
    if (browser && page && !page.isClosed()) return page;
    if (browser) {
      try {
        await closeBrowser(browser);
      } catch {
        /* abaikan: kita memang sedang membangun ulang */
      }
    }
    browser = await launchBrowser(config);
    page = await getPage(browser);
    const info = await openConsole(page, config);
    log("SERVICE_PAGE_READY", { url: info.url, settled: info.settled, readyMs: info.readyMs });
    return page;
  }

  // Gerbang yang sama persis dengan CLI yang sudah terverifikasi.
  async function guardedPin({ scene, productKey, playId }) {
    const p = await ensurePage();

    if (!isExpectedConsole(p.url(), config.consoleUrl)) {
      return { ok: false, reason: "unexpected-page" };
    }

    const observed = await readIdentity(p);
    const verdict = checkIdentity({
      expected: config.expectedShop,
      observed,
      forbidden: config.forbiddenShops,
    });
    if (!verdict.ok) return { ok: false, reason: `identity-${verdict.reason}` };

    const snapshot = await collectProducts(p);
    if (snapshot.products.length === 0) return { ok: false, reason: "no-products-found" };
    if (!snapshot.livePinButtonsOnPage) return { ok: false, reason: "live-pin-control-not-available" };

    const resolved = resolveProductForPin(snapshot.products, productKey);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };

    if (dryRun) {
      const probe = await pinProductByTitle(p, productKey, { dryRun: true });
      return probe.ok
        ? { ok: true, reason: "dry-run", title: probe.title, clicked: false }
        : { ok: false, reason: probe.reason };
    }

    const act = await pinProductByTitle(p, productKey, { dryRun: false });
    if (!act.ok) return { ok: false, reason: act.reason };

    const after = await readPinState(p, productKey);
    log("SERVICE_PINNED", { scene, title: act.title, after: after.text });
    return { ok: true, reason: "pinned", title: act.title, state: after.text, clicked: true };
  }

  async function handlePin({ scene, productKey, playId }) {
    if (typeof productKey !== "string" || !normalizeTitleKey(productKey)) {
      return { ok: false, reason: "empty-product-key" };
    }
    const id = Number.isFinite(playId) ? playId : 0;
    if (id && id < latestPlayId) return { ok: false, reason: "stale" };
    if (id > latestPlayId) latestPlayId = id;

    return runExclusive(async () => {
      // Dicek lagi DI DALAM antrean: permintaan yang lebih baru bisa datang
      // selama kita menunggu giliran. Yang menang adalah yang terbaru.
      if (id && id < latestPlayId) {
        log("SERVICE_STALE", { scene, playId: id, latest: latestPlayId });
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

  async function stop() {
    if (browser) await closeBrowser(browser).catch(() => {});
    browser = null;
    page = null;
  }

  return { app, handlePin, stop, __state: () => ({ latestPlayId, hasPage: !!page }) };
}

function startService({ port = Number(process.env.AUTOPIN_PORT) || DEFAULT_PORT, host = "127.0.0.1", ...rest } = {}) {
  const svc = createService(rest);
  return new Promise((resolve) => {
    const server = svc.app.listen(port, host, () => {
      log("SERVICE_LISTENING", { host, port, dryRun: !!rest.dryRun });
      resolve({ ...svc, server });
    });
  });
}

module.exports = { createService, startService, isExpectedConsole, DEFAULT_PORT };
