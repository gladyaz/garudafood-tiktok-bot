"use strict";
// Kontrol browser AutoPIN: profil persisten, navigasi aman, health, screenshot.
// Tidak pernah membaca/mencetak cookie atau storage.

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");
const { log } = require("./core");

const SETTLE_POLL_MS = 500;
const SETTLE_STABLE_MS = 2_500;
const NAVIGATION_ERROR_RE = /Execution context was destroyed|Cannot find context|detached Frame|Target closed/i;

class AutoPinError extends Error {
  constructor(tag, reason, cause) {
    super(`${tag}: ${reason}`);
    this.tag = tag;
    this.reason = reason;
    this.cause = cause;
  }
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

// origin + path saja — query string bisa berisi token
function safeUrl(raw) {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "<invalid-url>";
  }
}

async function launchBrowser(config) {
  ensurePrivateDir(config.profileDir);
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: false,
      userDataDir: config.profileDir,
      executablePath: config.chromePath || undefined,
      defaultViewport: null,
      args: ["--window-size=1440,960"],
    });
  } catch (err) {
    const inUse = /already running|ProcessSingleton|SingletonLock/i.test(err.message);
    throw new AutoPinError("NOT_READY", inUse ? "profile-in-use" : "browser-launch-failed", err);
  }

  browser.on("disconnected", () => {
    log("BROWSER_DISCONNECTED");
    killBrowserProcess(browser);
  });
  return browser;
}

// proses Chrome yang tersisa bisa menahan Node tetap hidup → pastikan mati
function killBrowserProcess(browser) {
  const proc = browser.process();
  if (proc && proc.exitCode === null && !proc.killed) proc.kill("SIGKILL");
}

async function getPage(browser) {
  const pages = await browser.pages();
  const page = pages[0] || (await browser.newPage());
  page.on("close", () => log("PAGE_CLOSED"));
  page.on("error", (err) => log("PAGE_CRASHED", { error: err.message }));
  return page;
}

// Tunggu sampai teks body berhenti berubah — jangan andalkan networkidle
// karena LIVE console punya koneksi panjang.
async function waitForSettled(page, timeoutMs) {
  const start = Date.now();
  let lastLen = -1;
  let stableSince = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (page.isClosed()) throw new AutoPinError("NOT_READY", "page-closed");
    let len;
    try {
      len = await page.evaluate(() => (document.body ? document.body.innerText.length : 0));
    } catch (err) {
      // redirect di tengah polling (mis. ke halaman login / seller center) → anggap masih berubah
      if (!NAVIGATION_ERROR_RE.test(err.message)) throw err;
      len = -1;
    }
    if (len !== lastLen) {
      lastLen = len;
      stableSince = Date.now();
    } else if (len > 0 && Date.now() - stableSince >= SETTLE_STABLE_MS) {
      return { settled: true, ms: Date.now() - start };
    }
    await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
  }
  return { settled: false, ms: Date.now() - start };
}

async function openConsole(page, config) {
  const start = Date.now();
  try {
    await page.goto(config.consoleUrl, { waitUntil: "domcontentloaded", timeout: config.navTimeoutMs });
  } catch (err) {
    throw new AutoPinError("NOT_READY", "navigation-failed", err);
  }
  const settle = await waitForSettled(page, config.readyTimeoutMs);
  return { url: safeUrl(page.url()), title: await page.title(), settled: settle.settled, readyMs: Date.now() - start };
}

async function saveScreenshot(page, config, label) {
  try {
    ensurePrivateDir(config.debugDir);
    const file = path.join(config.debugDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${label}.png`);
    await page.screenshot({ path: file });
    return file;
  } catch (err) {
    log("SCREENSHOT_FAILED", { error: err.message });
    return null;
  }
}

async function closeBrowser(browser) {
  if (!browser) return;
  try {
    if (browser.connected) await browser.close();
  } catch (err) {
    log("BROWSER_CLOSE_FAILED", { error: err.message });
  } finally {
    killBrowserProcess(browser);
  }
}

module.exports = {
  AutoPinError,
  ensurePrivateDir,
  safeUrl,
  launchBrowser,
  getPage,
  waitForSettled,
  openConsole,
  saveScreenshot,
  closeBrowser,
};
