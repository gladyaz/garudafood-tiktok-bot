"use strict";
// Konfigurasi AutoComment dari environment. Dipisah supaya default-nya bisa
// diuji langsung (loadConfig({}).enabled === false) tanpa bergantung pada .env
// milik siapa pun. Tidak ada nilai rahasia di sini.

const DEFAULTS = Object.freeze({
  enabled: false,
  // Batas internal konservatif, BUKAN limit resmi TikTok (angka resminya tidak diketahui).
  maxPerMinute: 6,
  minIntervalMs: 5_000,
  timeoutMs: 8_000,
});

function readFlag(raw) {
  return String(raw ?? "").trim().toLowerCase() === "true";
}

// Nilai kosong = tidak diisi (diam). Nilai terisi tapi rusak = jatuh ke default
// DAN diperingatkan, supaya operator tidak mengira batas yang ia tulis berlaku.
function readNonNegativeInt(name, raw, fallback, warn) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 0) return n;
  warn("⚠ " + name + "=\"" + String(raw) + "\" tidak valid -> pakai default " + fallback);
  return fallback;
}

function loadConfig(env = process.env, { warn = console.warn } = {}) {
  return {
    enabled: readFlag(env.AUTOCOMMENT_ENABLED),
    maxPerMinute: readNonNegativeInt("AUTOCOMMENT_MAX_PER_MINUTE", env.AUTOCOMMENT_MAX_PER_MINUTE, DEFAULTS.maxPerMinute, warn),
    minIntervalMs: readNonNegativeInt("AUTOCOMMENT_MIN_INTERVAL_MS", env.AUTOCOMMENT_MIN_INTERVAL_MS, DEFAULTS.minIntervalMs, warn),
    timeoutMs: readNonNegativeInt("AUTOCOMMENT_TIMEOUT_MS", env.AUTOCOMMENT_TIMEOUT_MS, DEFAULTS.timeoutMs, warn),
  };
}

module.exports = { loadConfig, DEFAULTS };
