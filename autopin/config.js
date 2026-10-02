"use strict";
// Konfigurasi AutoPIN dari environment. Tidak ada nilai rahasia di sini.

const path = require("path");

const ROOT = path.resolve(__dirname, "..");

function readPositiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function loadConfig(env = process.env) {
  return {
    consoleUrl: env.AUTOPIN_CONSOLE_URL || "https://shop.tiktok.com/streamer/live-console",
    profileDir: path.resolve(ROOT, env.AUTOPIN_PROFILE_DIR || ".autopin-profile"),
    debugDir: path.resolve(ROOT, env.AUTOPIN_DEBUG_DIR || ".autopin-debug"),
    expectedShop: env.AUTOPIN_EXPECTED_SHOP || "",
    // identitas yang mengandung salah satu kata ini = produksi → tidak boleh diklik
    forbiddenShops: (env.AUTOPIN_FORBIDDEN_SHOPS || "garudafood")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    chromePath: env.AUTOPIN_CHROME_PATH || "",
    navTimeoutMs: readPositiveInt(env.AUTOPIN_NAV_TIMEOUT_MS, 45_000),
    readyTimeoutMs: readPositiveInt(env.AUTOPIN_READY_TIMEOUT_MS, 30_000),
    loginTimeoutMs: readPositiveInt(env.AUTOPIN_LOGIN_TIMEOUT_MS, 15 * 60_000),
  };
}

module.exports = { loadConfig, ROOT };
