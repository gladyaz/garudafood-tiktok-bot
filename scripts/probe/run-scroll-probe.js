#!/usr/bin/env node
"use strict";
// Pelaksana VALIDASI GULIR TERKENDALI. Alat diagnosa, bukan modul produksi.
//
//   node scripts/probe/run-scroll-probe.js                       <- HANYA cek gerbang
//   node scripts/probe/run-scroll-probe.js --execute --operator-confirmed --live-on-air ...
//
// Bedanya dengan run-dom-probe.js: yang ini DIIZINKAN menulis scrollTop, dan
// hanya itu. Gerbang keselamatannya persis yang sama (probe-guards.js), pembaca
// bukti DOM-nya persis yang sama (dom-probe-page.js), dan penggulirnya adalah
// fungsi PRODUKSI (scrollProductListInPage / resetScrollInPage).
//
// Yang tetap tidak pernah dilakukan: klik, pin/unpin, ketik, ubah pencarian,
// ubah filter, susun ulang DOM, ubah config customer, kirim chat, nyalakan
// automation, simulasi roda mouse, gulir body/halaman, atau gulir container
// lain selain scroller daftar produk yang sudah diverifikasi.

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const probe = require("./dom-probe-page");
const scroll = require("./scroll-probe");
const { evaluateSafety } = require("./probe-guards");
const { PURPOSE } = require("../../autopin/browser-mode");
// Argumen, fakta, dan pencetak vonis DIPAKAI ULANG dari probe read-only supaya
// kedua alat tidak bisa menyimpang soal profil, lock, versi Chrome, atau
// kepemilikan.
const base = require("./run-dom-probe");

const SETTLE_WAVE_MS = 700; // > settleMs produksi (350 ms), untuk baris virtual

function loadRealDeps() {
  const { launchBrowser, getPage, openConsole, closeBrowser } = require("../../autopin/browser");
  const { isExpectedConsole } = require("../../autopin/service");
  const { readIdentity, SELECTORS, scrollProductListInPage, resetScrollInPage } = require("../../autopin/products");
  const { checkIdentity } = require("../../autopin/core");
  return {
    launchBrowser, getPage, openConsole, closeBrowser, purpose: PURPOSE.RUNTIME,
    isExpectedConsole, readIdentity, checkIdentity,
    SELECTORS, scrollProductListInPage, resetScrollInPage,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function execute(opts, deps = null) {
  const d = deps || loadRealDeps();
  const bcfg = {
    profileDir: opts.profileDir,
    debugDir: opts.debugDir,
    consoleUrl: opts.consoleUrl,
    navTimeoutMs: opts.navTimeoutMs,
    readyTimeoutMs: opts.readyTimeoutMs,
    ...(opts.chromePath ? { chromePath: opts.chromePath } : {}),
  };
  let browser = null;
  try {
    browser = await d.launchBrowser(bcfg, d.purpose || PURPOSE.RUNTIME);
    const page = await d.getPage(browser);
    const opened = await d.openConsole(page, bcfg);
    if (!d.isExpectedConsole(page.url(), opts.consoleUrl)) return { ok: false, reason: "unexpected-page" };
    if (opened && opened.settled !== true) {
      return { ok: false, reason: "page-not-settled", detail: "readyMs=" + (opened.readyMs === undefined ? "?" : opened.readyMs) };
    }

    // Identitas SEBELUM apa pun dibaca atau digulir.
    const terlihat = await d.readIdentity(page);
    const observed = Array.isArray(terlihat) ? terlihat.filter((x) => typeof x === "string" && x.trim() !== "") : [];
    const idv = d.checkIdentity({ expected: opts.expectedShop, observed, forbidden: opts.forbiddenShops });
    if (!idv.ok) {
      return { ok: false, reason: "identity-" + idv.reason, identity: { ok: false, expected: opts.expectedShop, observed: idv.observed || observed.join(" | ") || "(tidak terbaca)" } };
    }

    const hasil = await scroll.scrollValidation({
      readAncestors: () => page.evaluate(probe.readScrollAncestorsInPage, probe.SEL),
      readRows: () => page.evaluate(probe.readRowsInPage, probe.SEL),
      readStrip: () => page.evaluate(probe.readStripInPage, probe.SEL),
      readScope: async () => {
        const search = await page.evaluate(probe.readSearchInPage, probe.SEL);
        const filters = await page.evaluate(probe.readFiltersInPage, probe.SEL);
        return probe.scopeVerdict({ search, filters });
      },
      // PRODUKSI, apa adanya. Step 400 = default collectProducts.
      scrollWave: () => page.evaluate(d.scrollProductListInPage, d.SELECTORS, scroll.DEFAULT_STEP),
      resetScroll: () => page.evaluate(d.resetScrollInPage, d.SELECTORS),
      settle: () => sleep(opts.waveSettleMs),
      maxWaves: opts.maxWaves,
    });

    return {
      ok: true,
      readyMs: opened && typeof opened.readyMs === "number" ? opened.readyMs : null,
      identity: { ok: true, expected: opts.expectedShop, observed: idv.observed },
      validation: hasil,
    };
  } catch (err) {
    return { ok: false, reason: "probe-failed", detail: String((err && err.message) || "").slice(0, 160) };
  } finally {
    if (browser) {
      try {
        await d.closeBrowser(browser);
      } catch (e) {
        /* sudah tertutup */
      }
    }
  }
}

function parseArgs(argv) {
  const o = base.parseArgs(argv);
  o.maxWaves = scroll.DEFAULT_MAX_WAVES;
  o.waveSettleMs = SETTLE_WAVE_MS;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--max-waves") { o.maxWaves = Math.max(1, Math.min(3, Number(argv[i + 1]) || 1)); i += 1; }
    else if (argv[i] === "--wave-settle-ms") { o.waveSettleMs = Math.max(0, Number(argv[i + 1]) || 0); i += 1; }
  }
  return o;
}

async function main(argv) {
  const opts = parseArgs(argv);
  const facts = await base.gatherFacts(opts);
  const verdict = evaluateSafety(facts);

  console.log("=== GERBANG KESELAMATAN (sama dengan probe read-only) ===");
  console.log("  profil                   : " + facts.__profileDir);
  console.log("  lock diperiksa           : " + facts.__lockFile + "  ada=" + facts.botLockExists);
  console.log("  Controller terhubung     : " + facts.controller.reachable);
  console.log("  versi Chrome / profil    : " + (facts.chromeVersion || "?") + " / " + (facts.profileLastVersion || "?"));
  console.log("  Chrome memakai profil    : " + (facts.chromePidsOnProfile.length ? facts.chromePidsOnProfile.join(",") : "tidak ada"));
  console.log("  operator / LIVE          : " + facts.operatorConfirmed + " / " + facts.liveOnAir);
  for (const w of verdict.warnings) console.log("  CATATAN  " + w.code);
  console.log("  VONIS: " + (verdict.safe ? "AMAN" : "DITOLAK"));
  if (!verdict.safe) for (const r of verdict.refusals) console.log("    - " + r.code + ": " + r.userMessage);

  if (!opts.execute) {
    console.log("");
    console.log("Mode cek-gerbang saja: TIDAK ada browser yang dibuka, TIDAK ada gulir.");
    return 0;
  }
  if (!verdict.safe) {
    console.log("");
    console.log("BERHENTI: gerbang tidak hijau. Halaman tidak dibuka, tidak ada gulir.");
    return 1;
  }

  console.log("");
  console.log("Membuka dashboard dan memvalidasi gulir (maks " + opts.maxWaves + " gelombang)...");
  const r = await execute(opts);
  if (!r.ok) {
    console.log("GAGAL: " + r.reason + (r.detail ? " - " + r.detail : ""));
    if (r.identity) console.log("  identitas terbaca: " + r.identity.observed);
    return 1;
  }

  const v = r.validation;
  console.log("  akun terverifikasi    : " + r.identity.observed);
  console.log("  readyMs               : " + r.readyMs);
  console.log("");
  console.log("  BASELINE: scope=" + v.baseline.scope + " candidateTotal=" + v.baseline.candidateTotal +
    " rows=" + v.baseline.rowMarkers + " numbers=[" + v.baseline.numbers.join(",") + "]");
  console.log("            scroller depth=" + v.baseline.scroller.depth +
    " scrollTop=" + v.baseline.scroller.scrollTop + " scrollH=" + v.baseline.scroller.scrollHeight +
    " clientH=" + v.baseline.scroller.clientHeight);
  for (const w of v.waves) {
    console.log("  WAVE " + w.wave + ": " + w.beforeScrollTop + " -> " +
      (w.after ? w.after.scrollTop : "?") + "  scrolled=" + w.scrolled +
      "  visible=[" + w.visible.join(",") + "]  unique=[" + w.uniqueAfter.join(",") + "]" +
      "  bottom=" + w.bottom + "  total=" + w.candidateTotal + "  scope=" + w.scope);
  }
  console.log("");
  console.log("  uniquePositions       : [" + v.uniquePositions.join(",") + "]");
  console.log("  totalSatisfied        : " + v.totalSatisfied);
  console.log("  bottomReached         : " + v.bottomReached);
  console.log("  stopReason            : " + v.stopReason);
  console.log("  scroller stabil       : " + v.scrollerStable);
  console.log("  candidateTotal stabil : " + v.candidateTotalStable);
  console.log("  scope stabil          : " + v.scopeStable);
  console.log("  dipulihkan            : " + JSON.stringify(v.restored));

  fs.mkdirSync(opts.debugDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = path.join(opts.debugDir, stamp + "_scroll-probe.json");
  fs.writeFileSync(outFile, JSON.stringify(r, null, 2), { mode: 0o600 });
  console.log("");
  console.log("Laporan: " + outFile);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((c) => process.exit(c))
    .catch((e) => {
      console.error("GAGAL: " + String((e && e.stack) || e));
      process.exit(1);
    });
}

module.exports = { parseArgs, execute, main, SETTLE_WAVE_MS };
