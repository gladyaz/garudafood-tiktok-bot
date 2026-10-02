#!/usr/bin/env node
"use strict";
// AP0 — CLI AutoPIN standalone (TIDAK terhubung ke index.js).
//
//   node autopin-cli.js login              buka browser, login manual, lalu TUTUP jendelanya
//   node autopin-cli.js status             cek halaman LIVE console + login
//   node autopin-cli.js inspect            simpan screenshot + outline DOM tersanitasi ke .autopin-debug/
//   node autopin-cli.js products           daftar produk di LIVE (belum aktif sampai selector diverifikasi)
//   node autopin-cli.js pin <N> --dry-run  cari produk N + tombol pin, TANPA klik
//   node autopin-cli.js pin <N> --confirm  klik pin + verifikasi DOM (hanya akun tes yang terverifikasi)

require("dotenv").config({ quiet: true });

const { log, parseArgs } = require("./autopin/core");
const { loadConfig } = require("./autopin/config");
const {
  AutoPinError, launchBrowser, getPage, openConsole, saveScreenshot, closeBrowser,
} = require("./autopin/browser");
const { inspectPage } = require("./autopin/inspect");

const LOGIN_PATH_RE = /login|passport|signin|sign-in|sign_in|account\/register/i;

function usage() {
  console.log(
    "Usage: node autopin-cli.js <login|status|inspect|products|pin <N> --dry-run|pin <N> --confirm>",
  );
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
    case "pin":
      // sengaja belum aktif: selector produk/pin harus diverifikasi dari DOM asli dulu
      log("NOT_READY", { reason: "selectors-not-discovered" });
      return 1;
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
