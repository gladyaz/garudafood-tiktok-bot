"use strict";
// Transport tipis dari bot ke service AutoPIN di localhost.
//
// Sengaja TIDAK meng-import Puppeteer: proses bot yang stabil tidak boleh ikut
// memuat Chromium. Browser hidup di proses service terpisah, jadi browser yang
// crash tidak menjatuhkan bot.

const DEFAULT_PORT = 5055;
const DEFAULT_TIMEOUT_MS = 8_000;

function serviceUrl(env = process.env) {
  const base = env.AUTOPIN_SERVICE_URL || `http://127.0.0.1:${Number(env.AUTOPIN_PORT) || DEFAULT_PORT}`;
  return `${base.replace(/\/+$/, "")}/pin`;
}

// sessionId menandai proses bot ini. Service memakainya untuk membedakan
// "pemutaran lama" dari "bot yang baru di-restart" - tanpa itu, restart bot
// membuat playId yang sah ditolak basi. Lihat autopin/session.js.
function createHttpSender({ url, timeoutMs = DEFAULT_TIMEOUT_MS, fetchFn, sessionId } = {}) {
  const target = url || serviceUrl();

  return async function send({ scene, productKey, playId }) {
    const doFetch = fetchFn || globalThis.fetch;
    if (typeof doFetch !== "function") throw new Error("fetch-unavailable");

    const controller = new AbortController();
    const abort = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(target, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scene, productKey, playId, sessionId }),
        signal: controller.signal,
      });
      if (!res.ok) return { ok: false, reason: `http-${res.status}` };
      try {
        return await res.json();
      } catch {
        return { ok: true, reason: "no-json-body" };
      }
    } finally {
      clearTimeout(abort);
    }
  };
}

module.exports = { createHttpSender, serviceUrl, DEFAULT_PORT, DEFAULT_TIMEOUT_MS };
