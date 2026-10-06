"use strict";
// Transport tipis dari bot ke service AutoComment di localhost, sejajar dengan
// autopin/client.js.
//
// Sengaja TIDAK meng-import Puppeteer, konektor TikTok, maupun Euler Stream:
// proses bot yang stabil tidak boleh memuat Chromium, dan tidak ada jalur kirim
// berbayar/pihak ketiga di sini. Browser hidup di proses service terpisah.
//
// Dua mode, dan default-nya yang paling tidak berbahaya:
//   "dry-run" -> POST /comment/dry-run   (service hanya MEMBACA komposer)
//   "browser" -> POST /comment/send      (service boleh mengetik + satu klik,
//                                         itu pun kalau service dijalankan
//                                         dengan --enable-autocomment-send)
// Nilai mode lain ditolak di sini, tidak diam-diam diartikan sebagai "browser".

const DEFAULT_PORT = 5055;
const DEFAULT_TIMEOUT_MS = 8_000;

const MODES = Object.freeze({
  DRY_RUN: "dry-run",
  BROWSER: "browser",
});
const PATHS = Object.freeze({
  [MODES.DRY_RUN]: "/comment/dry-run",
  [MODES.BROWSER]: "/comment/send",
});

function serviceBase(env = process.env) {
  const base = env.AUTOPIN_SERVICE_URL || `http://127.0.0.1:${Number(env.AUTOPIN_PORT) || DEFAULT_PORT}`;
  return base.replace(/\/+$/, "");
}

function commentUrl(mode, env = process.env) {
  const path = PATHS[mode];
  if (!path) return null;
  return `${serviceBase(env)}${path}`;
}

// Tidak ada retry di sini maupun di mana pun: satu permintaan, satu jawaban.
function createCommentSender({
  mode = MODES.DRY_RUN,
  url,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchFn,
  // Menandai proses bot ini, sama seperti pada autopin/client.js: generasi
  // pemutaran dipakai BERSAMA oleh pin dan komentar.
  sessionId,
  env = process.env,
} = {}) {
  const target = url || commentUrl(mode, env);

  return async function send({ text, scene, playId, pin }) {
    if (!target) return { ok: false, reason: `unknown-transport-${String(mode)}` };

    const doFetch = fetchFn || globalThis.fetch;
    if (typeof doFetch !== "function") throw new Error("fetch-unavailable");

    const controller = new AbortController();
    const abort = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(target, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // `pin` hanya dibawa sebagai bukti/telemetri; service tetap memeriksa
        // gerbangnya sendiri dan tidak mempercayai klaim dari sisi pemanggil.
        body: JSON.stringify({ text, scene, playId, pin, sessionId }),
        signal: controller.signal,
      });
      if (!res.ok) return { ok: false, reason: `http-${res.status}` };
      try {
        return await res.json();
      } catch {
        return { ok: false, reason: "no-json-body" };
      }
    } finally {
      clearTimeout(abort);
    }
  };
}

module.exports = { createCommentSender, commentUrl, serviceBase, MODES, PATHS, DEFAULT_PORT, DEFAULT_TIMEOUT_MS };
