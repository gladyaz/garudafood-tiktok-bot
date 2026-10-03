#!/usr/bin/env node
"use strict";
// AP0 — CLI AutoPIN standalone (TIDAK terhubung ke index.js).
//
//   node autopin-cli.js login                            buka browser, login manual, lalu TUTUP jendelanya
//   node autopin-cli.js status                           cek halaman LIVE console + login
//   node autopin-cli.js inspect                          simpan screenshot + outline DOM tersanitasi ke .autopin-debug/
//   node autopin-cli.js products                         daftar produk di LIVE + identitas toko
//   node autopin-cli.js pin-title "<judul>" --dry-run    cari produk + tombol pin LIVE, TANPA klik
//   node autopin-cli.js pin-title "<judul>" --confirm    klik pin + verifikasi DOM (hanya akun tes yang terverifikasi)
//
// `pin <N>` sengaja dimatikan: satu aksi menggeser nomor posisi banyak produk,
// jadi target pin HARUS lewat judul.

require("dotenv").config({ quiet: true });

const { log, parseArgs, checkIdentity, decidePinMode, normalizeTitleKey, resolveProductForPin } = require("./autopin/core");
const { loadConfig } = require("./autopin/config");
const {
  AutoPinError, launchBrowser, getPage, openConsole, saveScreenshot, closeBrowser,
} = require("./autopin/browser");
const { inspectPage } = require("./autopin/inspect");
const { collectProducts, readIdentity, pinProductByTitle, readPinState, diffSnapshots } = require("./autopin/products");

const LOGIN_PATH_RE = /login|passport|signin|sign-in|sign_in|account\/register/i;

function usage() {
  console.log("Usage: node autopin-cli.js <command> [--dry-run|--confirm]");
  console.log("");
  console.log("  login                             buka browser, login manual, lalu TUTUP jendelanya");
  console.log("  status                            cek halaman LIVE console + login");
  console.log("  inspect                           simpan screenshot + outline DOM ke .autopin-debug/");
  console.log("  products                          daftar produk di LIVE + identitas toko");
  console.log('  pin-title "<judul>" --dry-run     cari produk + tombol pin LIVE, TANPA klik');
  console.log('  pin-title "<judul>" --confirm     klik pin (hanya akun tes yang terverifikasi)');
  console.log("  pin <N>                           DIMATIKAN - nomor posisi tidak stabil, pakai pin-title");
}

function looksLikeLoginPage(url) {
  return LOGIN_PATH_RE.test(url);
}

// bukti positif "belum login": ada tombol/link Log in / Masuk / Sign in yang terlihat
async function hasVisibleLoginControl(page) {
  return page.evaluate(() => {
    const LOGIN_TEXT = /^(log ?in|sign ?in|masuk)$/i;
    return [...document.querySelectorAll("a, button, [role=button]")].some((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && LOGIN_TEXT.test((el.innerText || "").trim());
    });
  });
}

// buka browser + LIVE console, jalankan fn(page, info), selalu tutup browser
async function withConsole(config, fn) {
  const browser = await launchBrowser(config);
  try {
    const page = await getPage(browser);
    const info = await openConsole(page, config);
    log("PAGE", { url: info.url, title: info.title, settled: info.settled, readyMs: info.readyMs });
    return await fn(page, info);
  } finally {
    await closeBrowser(browser);
  }
}

async function cmdLogin(config) {
  const browser = await launchBrowser(config);
  const page = await getPage(browser);
  try {
    await openConsole(page, config);
  } catch (err) {
    log("NOT_READY", { reason: err.reason || "navigation-failed" });
  }
  log("LOGIN_WAITING", {
    note: "Login manual di jendela Chromium, buka LIVE console, lalu TUTUP jendela untuk menyimpan sesi",
    timeoutMin: Math.round(config.loginTimeoutMs / 60_000),
  });
  const closed = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), config.loginTimeoutMs);
    browser.once("disconnected", () => {
      clearTimeout(t);
      resolve(true);
    });
  });
  if (!closed) {
    log("LOGIN_TIMEOUT");
    await closeBrowser(browser);
    return 1;
  }
  log("LOGIN_WINDOW_CLOSED", { note: "profil tersimpan; jalankan `status` untuk cek" });
  return 0;
}

async function cmdStatus(config) {
  return withConsole(config, async (page, info) => {
    if (looksLikeLoginPage(info.url) || (await hasVisibleLoginControl(page))) {
      const shot = await saveScreenshot(page, config, "status-login-required");
      log("LOGIN_REQUIRED", { url: info.url, screenshot: shot });
      return 1;
    }
    const shot = await saveScreenshot(page, config, "status");
    // identitas toko belum bisa dibaca sampai selector-nya ditemukan dari DOM asli
    log("STATUS", { url: info.url, loginControlVisible: false, identity: "unverified", screenshot: shot });
    return 0;
  });
}

async function cmdInspect(config) {
  return withConsole(config, async (page) => {
    const shot = await saveScreenshot(page, config, "inspect");
    const result = await inspectPage(page, config);
    log("INSPECT_DONE", { screenshot: shot, outline: result.outFile, candidates: result.candFile, frames: result.frames, pinCandidates: result.pinCandidates });
    return 0;
  });
}

// Identitas yang terlihat di header. Hanya ini yang boleh dipakai guard identitas —
// JANGAN memakai teks produk: judul produk di akun tes pun bisa memuat kata "garudafood".
async function reportIdentity(page, config) {
  const observed = await readIdentity(page);
  const verdict = checkIdentity({
    expected: config.expectedShop,
    observed,
    forbidden: config.forbiddenShops,
  });
  log("IDENTITY", {
    observed: observed.join(" | ") || "(tidak terbaca)",
    expected: config.expectedShop || "(belum dikonfigurasi)",
    guard: verdict.ok ? "ok" : verdict.reason,
  });
  return { observed, verdict };
}

function logProduct(p) {
  log("PRODUCT", {
    number: p.number,
    title: p.title,
    price: p.price,
    topControls: p.pinControls,
    atTop: p.number === 1 ? "yes" : "no",
  });
}

async function cmdProducts(config) {
  return withConsole(config, async (page, info) => {
    if (looksLikeLoginPage(info.url) || (await hasVisibleLoginControl(page))) {
      log("LOGIN_REQUIRED", { url: info.url });
      return 1;
    }
    await reportIdentity(page, config);
    const r = await collectProducts(page);
    if (r.products.length === 0) {
      log("NOT_READY", { reason: "no-products-found", numberInputsOnPage: r.numberInputsOnPage });
      return 1;
    }
    r.products.forEach(logProduct);
    log("PRODUCTS_DONE", { count: r.products.length, scrollPasses: r.passes, invalidRows: r.invalidRows });
    return 0;
  });
}

// Gerbang 4: halaman aktif harus benar-benar konsol yang dikonfigurasi (origin + path).
function isExpectedConsole(actualUrl, consoleUrl) {
  try {
    const a = new URL(actualUrl);
    const b = new URL(consoleUrl);
    return a.origin === b.origin && a.pathname === b.pathname;
  } catch {
    return false;
  }
}

const POST_CLICK_SETTLE_MS = 2_500;

// Posisi daftar TERBUKTI tidak stabil: satu aksi menggeser nomor banyak produk.
// Karena itu pin berbasis nomor dinonaktifkan; target harus lewat judul.
async function cmdPinByNumber() {
  log("NOT_READY", {
    reason: "position-based-pinning-disabled",
    hint: "pakai: pin-title \"<judul>\" --dry-run | --confirm",
  });
  return 1;
}

async function cmdPinTitle(config, args) {
  const titleKey = args.positional.join(" ").trim();
  if (!normalizeTitleKey(titleKey)) {
    log("USAGE_ERROR", { reason: "empty-title-key", hint: "pin-title \"junny low ph face wash\" --dry-run" });
    return 2;
  }
  const decided = decidePinMode(args);
  if (!decided.ok) {
    log(decided.reason === "both-modes-given" ? "USAGE_ERROR" : "NOT_READY", {
      reason: decided.reason, hint: "--dry-run atau --confirm",
    });
    return decided.reason === "both-modes-given" ? 2 : 1;
  }
  const { mode } = decided;

  return withConsole(config, async (page, info) => {
    if (looksLikeLoginPage(info.url) || (await hasVisibleLoginControl(page))) {
      log("LOGIN_REQUIRED", { url: info.url });
      return 1;
    }
    if (!isExpectedConsole(info.url, config.consoleUrl)) {
      log("REFUSED", { mode, reason: "unexpected-page", url: info.url });
      return 1;
    }

    const { observed, verdict } = await reportIdentity(page, config);
    if (mode === "confirm" && !verdict.ok) {
      log("CONFIRM_REFUSED", { reason: verdict.reason, observed: observed.join(" | ") || "(tidak terbaca)" });
      return 1;
    }

    const before = await collectProducts(page);
    log("PRODUCTS_SEEN", {
      count: before.products.length,
      invalidRows: before.invalidRows,
      livePinButtons: before.livePinButtonsOnPage,
    });

    // Kontrol pin LIVE hanya ada selama siaran berjalan.
    if (!before.livePinButtonsOnPage) {
      log("LIVE_PIN_CONTROL_NOT_AVAILABLE", {
        reason: "no-product_card-button-on-page",
        note: "tombol Pin per produk hanya muncul saat LIVE aktif; .pc_top_product TIDAK dipakai sebagai pengganti",
      });
      return 1;
    }

    const resolved = resolveProductForPin(before.products, titleKey);
    if (!resolved.ok) {
      const p = resolved.product;
      log(mode === "confirm" ? "CONFIRM_REFUSED" : "DRYRUN_REFUSED", {
        key: normalizeTitleKey(titleKey),
        reason: resolved.reason,
        count: resolved.count,
        title: p ? p.title : undefined,
        stock: p ? p.stock : undefined,
      });
      return 1;
    }
    const p = resolved.product;

    log("TARGET", {
      key: normalizeTitleKey(titleKey),
      title: p.title,
      position: p.number,
      price: p.price,
      stock: p.stock || "(tidak terbaca)",
      pinButtons: p.pinButtons,
      pinText: p.pinText,
      pinVisible: String(p.pinVisible),
      pinDisabled: String(p.pinDisabled),
      topControlsDiagnostic: p.topControls,
    });

    if (mode === "dry-run") {
      const probe = await pinProductByTitle(page, titleKey, { dryRun: true });
      if (!probe.ok) {
        log("DRYRUN_REFUSED", { reason: probe.reason, count: probe.count, title: probe.title });
        return 1;
      }
      log("DRYRUN_OK", {
        title: probe.title,
        buttonText: probe.before.text,
        buttonDisabled: String(probe.before.disabled),
        clicked: "no",
      });
      return 0;
    }

    // ---- confirm ----
    const shotBefore = await saveScreenshot(page, config, "pin-before");
    const stateBefore = await readPinState(page, titleKey);
    log("PIN_STATE_BEFORE", { text: stateBefore.text, disabled: String(stateBefore.disabled), buttons: stateBefore.buttons });

    const act = await pinProductByTitle(page, titleKey, { dryRun: false });
    if (!act.ok) {
      log("CONFIRM_REFUSED", { reason: act.reason, count: act.count, title: act.title });
      return 1;
    }
    log("CLICKED", { title: act.title, control: "button[data-pin-performance-source=product_card]", scrollSteps: act.scrollSteps, screenshotBefore: shotBefore });

    await new Promise((r) => setTimeout(r, POST_CLICK_SETTLE_MS));
    const stateAfter = await readPinState(page, titleKey);
    const after = await collectProducts(page);
    const shotAfter = await saveScreenshot(page, config, "pin-after");

    log("PIN_STATE_AFTER", { text: stateAfter.text, disabled: String(stateAfter.disabled), buttons: stateAfter.buttons });
    log("ORDER_BEFORE", { order: before.products.map((x) => x.number).join(",") });
    log("ORDER_AFTER", { order: after.products.map((x) => x.number).join(",") });

    const d = diffSnapshots(before.products, after.products);
    for (const m of d.moved) log("DOM_CHANGE", { kind: "moved", title: m.title, from: m.from, to: m.to });
    for (const c of d.changed) log("DOM_CHANGE", { kind: "fields", title: c.title, delta: c.fields });
    if (!d.moved.length && !d.changed.length) log("DOM_CHANGE", { kind: "none" });

    log("POST_CLICK_STATE", { screenshotAfter: shotAfter });
    log("VERIFY_PENDING_VIEWER", {
      note: "klik terkirim ke tombol Pin LIVE; efek ke penonton BELUM terbukti - perlu konfirmasi dari perangkat penonton",
    });
    return 0;
  });
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.unknownFlags.length) {
    log("USAGE_ERROR", { unknownFlags: args.unknownFlags.join(",") });
    return 2;
  }
  const config = loadConfig();

  switch (args.command) {
    case "login":
      return cmdLogin(config);
    case "status":
      return cmdStatus(config);
    case "inspect":
      return cmdInspect(config);
    case "products":
      return cmdProducts(config);
    case "pin":
      return cmdPinByNumber();
    case "pin-title":
      return cmdPinTitle(config, args);
    default:
      usage();
      return args.command === "help" ? 0 : 2;
  }
}

process.on("unhandledRejection", (err) => {
  log("UNHANDLED", { error: err && err.message ? err.message : String(err) });
  process.exitCode = 1;
});

const EXIT_GRACE_MS = 2_000;

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    if (err instanceof AutoPinError) log(err.tag, { reason: err.reason, error: err.cause ? err.cause.message : undefined });
    else log("ERROR", { error: err.message });
    process.exitCode = 1;
  })
  .finally(() => {
    // jaring pengaman: kalau ada handle tersisa (mis. proses Chrome), jangan menggantung selamanya
    setTimeout(() => process.exit(process.exitCode ?? 0), EXIT_GRACE_MS).unref();
  });
