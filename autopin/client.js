"use strict";
// Transport tipis dari bot ke service AutoPIN di localhost.
//
// Sengaja TIDAK meng-import Puppeteer: proses bot yang stabil tidak boleh ikut
// memuat Chromium. Browser hidup di proses service terpisah, jadi browser yang
// crash tidak menjatuhkan bot.

const DEFAULT_PORT = 5055;
const DEFAULT_TIMEOUT_MS = 8_000;
// Batas tunggu pembacaan katalog. SENGAJA jauh di bawah 8 detik milik pin:
// pembacaan katalog nanti berada di jalur menjawab chat, dan tidak boleh
// menahan apa pun. Habis waktu berarti "tidak tersedia", bukan menunggu.
const CATALOGUE_TIMEOUT_MS = 1_500;

function serviceBaseUrl(env = process.env) {
  const base = env.AUTOPIN_SERVICE_URL || `http://127.0.0.1:${Number(env.AUTOPIN_PORT) || DEFAULT_PORT}`;
  return base.replace(/\/+$/, "");
}

function serviceUrl(env = process.env) {
  return `${serviceBaseUrl(env)}/pin`;
}

// Rute katalog BACA-SAJA. Port dan host yang SAMA dengan /pin: loopback,
// tanpa otoritas baru - rute yang dibacanya memang tidak beraksi.
function catalogueUrl(env = process.env) {
  return `${serviceBaseUrl(env)}/products`;
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

// Pembaca katalog produk BACA-SAJA dari service.
//
// Alamat dan otoritasnya SAMA dengan jalur pin: loopback, port service yang
// sama, tanpa flag baru - rute yang dibacanya memang tidak beraksi.
//
// Yang modul ini tidak pernah lakukan, dan itu disengaja:
//   - tidak memuat Puppeteer, tidak pernah membuka Chrome. Browser hidup di
//     proses service; bot tidak boleh ikut memegang profil.
//   - tidak pernah jatuh ke discovery Controller sebagai cadangan. Saat
//     automation berjalan, Controller justru TIDAK BISA membaca etalase -
//     profil Chrome terkunci satu proses. Cadangan seperti itu bukan cuma
//     gagal, ia bisa merebut profil di tengah LIVE.
//
// Habis waktu / service mati / jawaban bukan JSON semuanya menjadi
// { ok:false, error } yang terstruktur. TIDAK PERNAH melempar ke pemanggil:
// jalur chat tidak boleh bisa dijatuhkan oleh pembacaan katalog.
function createCatalogueReader({ url, timeoutMs = CATALOGUE_TIMEOUT_MS, fetchFn, env = process.env } = {}) {
  const target = url || catalogueUrl(env);

  return async function readProducts({ maxAgeMs, refresh } = {}) {
    const doFetch = fetchFn || globalThis.fetch;
    if (typeof doFetch !== "function") return { ok: false, error: "fetch-unavailable" };

    const qs = [];
    if (Number.isFinite(Number(maxAgeMs))) qs.push(`maxAgeMs=${Number(maxAgeMs)}`);
    if (refresh === "never" || refresh === "if-stale" || refresh === "full") qs.push(`refresh=${refresh}`);
    const full = qs.length ? `${target}?${qs.join("&")}` : target;

    const controller = new AbortController();
    const abort = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(full, { method: "GET", signal: controller.signal });
      if (!res.ok) return { ok: false, error: "product-snapshot-unavailable", http: res.status };
      let body;
      try {
        body = await res.json();
      } catch {
        return { ok: false, error: "product-snapshot-unavailable", detail: "no-json-body" };
      }
      if (!body || body.ok !== true) {
        return {
          ok: false,
          error: (body && body.error) || "product-snapshot-unavailable",
          ageMs: body && body.ageMs,
        };
      }
      // Bentuknya DIPERIKSA, bukan dipercaya: jawaban ok:true tanpa daftar
      // produk tidak boleh lolos sebagai katalog kosong yang sah.
      if (!Array.isArray(body.products)) {
        return { ok: false, error: "product-snapshot-unavailable", detail: "no-products" };
      }
      return body;
    } catch (err) {
      // Abort karena habis waktu masuk ke sini juga - dan jawabannya sama:
      // tidak tersedia.
      return { ok: false, error: "product-snapshot-unavailable", detail: String(err && err.name) };
    } finally {
      clearTimeout(abort);
    }
  };
}

module.exports = {
  createHttpSender,
  createCatalogueReader,
  serviceUrl,
  serviceBaseUrl,
  catalogueUrl,
  DEFAULT_PORT,
  DEFAULT_TIMEOUT_MS,
  CATALOGUE_TIMEOUT_MS,
};
