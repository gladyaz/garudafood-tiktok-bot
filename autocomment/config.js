"use strict";
// Konfigurasi AutoComment dari environment. Dipisah supaya default-nya bisa
// diuji langsung (loadConfig({}).enabled === false) tanpa bergantung pada .env
// milik siapa pun. Tidak ada nilai rahasia di sini.

// Mode transport yang dikenal. Nilai lain TIDAK PERNAH diartikan sebagai
// "browser"; yang tidak dikenal jatuh ke dry-run (aman) dan diperingatkan.
const TRANSPORTS = Object.freeze({ DRY_RUN: "dry-run", BROWSER: "browser" });

const DEFAULTS = Object.freeze({
  enabled: false,
  transport: TRANSPORTS.DRY_RUN,
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

// Mengirim sungguhan TIDAK PERNAH cukup dengan nilai di .env: service juga
// harus dijalankan dengan --enable-autocomment-send. Dua lapis, sengaja.
function readTransport(raw, warn) {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "") return DEFAULTS.transport;
  if (v === TRANSPORTS.DRY_RUN || v === TRANSPORTS.BROWSER) return v;
  warn("\u26a0 AUTOCOMMENT_TRANSPORT=\"" + String(raw) + "\" tidak dikenal -> pakai " + DEFAULTS.transport);
  return DEFAULTS.transport;
}

function loadConfig(env = process.env, { warn = console.warn } = {}) {
  return {
    enabled: readFlag(env.AUTOCOMMENT_ENABLED),
    transport: readTransport(env.AUTOCOMMENT_TRANSPORT, warn),
    maxPerMinute: readNonNegativeInt("AUTOCOMMENT_MAX_PER_MINUTE", env.AUTOCOMMENT_MAX_PER_MINUTE, DEFAULTS.maxPerMinute, warn),
    minIntervalMs: readNonNegativeInt("AUTOCOMMENT_MIN_INTERVAL_MS", env.AUTOCOMMENT_MIN_INTERVAL_MS, DEFAULTS.minIntervalMs, warn),
    timeoutMs: readNonNegativeInt("AUTOCOMMENT_TIMEOUT_MS", env.AUTOCOMMENT_TIMEOUT_MS, DEFAULTS.timeoutMs, warn),
  };
}

module.exports = { loadConfig, DEFAULTS, TRANSPORTS };
