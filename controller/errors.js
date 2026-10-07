"use strict";
// Penerjemah kode internal -> satu kalimat untuk customer.
//
// Pemisahannya tegas dan itu intinya:
//
//   code        kode mesin yang sudah dipakai core hari ini. TIDAK diubah,
//               TIDAK dihapus, dan tetap yang dicatat di log.
//   userMessage satu kalimat bahasa Inggris biasa untuk ditampilkan.
//   detail      opsional, internal. Tidak pernah berisi stack trace.
//
// Stack trace tidak pernah menjadi pesan customer. Bukan karena jelek dilihat,
// tapi karena ia membocorkan path berkas, versi, dan struktur internal ke layar
// yang bisa sedang di-share saat LIVE.
//
// Kode di bawah diambil dari string `reason` yang SUDAH dikembalikan core
// (autopin/service.js, autopin/scene-pin.js, autocomment/core.js). Tidak ada
// kode baru yang dipaksakan ke core.

const CATALOG = Object.freeze({
  // --- preflight / lingkungan ---
  "obs-unavailable": "OBS is not connected.",
  "obs-auth-failed": "OBS rejected the password.",
  "obs-scene-missing": "A scene from your mapping does not exist in OBS.",
  "port-in-use": "A required port is already being used by another program.",
  "profile-dir-unusable": "The browser profile folder cannot be used.",
  "already-running": "The automation is already running.",
  "orphans-remain": "Older bot processes are still running and could not be stopped.",
  "tiktok-username-missing": "Your TikTok username has not been set yet.",
  "no-mappings": "No scene has a product mapped to it yet.",

  // --- config ---
  "config-missing": "No configuration has been saved yet.",
  "config-invalid": "The configuration has problems that need fixing.",
  "config-invalid-json": "The configuration file is damaged and could not be read.",
  "config-unreadable": "The configuration file could not be opened.",
  "config-write-failed": "The configuration could not be saved.",
  "version-unsupported": "This configuration was made by a different version of the app.",
  "version-missing": "This configuration is missing its version number.",

  // --- lifecycle ---
  "service-already-running": "The pin service is already running.",
  "bot-already-running": "The bot is already running.",
  "spawn-failed": "A required program could not be started.",
  "spawn-no-pid": "A required program failed to start.",
  "service-health-timeout": "The pin service did not become ready in time.",
  "service-exited-early": "The pin service stopped right after starting.",
  "bot-exited-early": "The bot stopped right after starting.",
  "bot-ready-timeout": "The bot did not connect to TikTok LIVE in time.",
  "service-did-not-die": "The pin service could not be stopped.",
  "bot-did-not-die": "The bot could not be stopped.",
  "start-rejected-busy": "The automation is already starting or running.",
  "preflight-failed": "Some checks did not pass, so nothing was started.",

  // --- AutoPIN, dari reason yang sudah ada di service ---
  "no-products-found": "No LIVE products detected.",
  "no-live-products": "No LIVE products detected.",
  "live-pin-control-not-available": "The Pin buttons are not available. Make sure the LIVE is on air.",
  "budget-exhausted-before-click": "TikTok responded too slowly. The product was not changed.",
  "budget-exhausted-in-queue": "TikTok responded too slowly. The product was not changed.",
  "collect-incomplete-budget": "The product list did not finish loading in time.",
  "product-not-found": "The mapped product was not found in the LIVE product list.",
  "ambiguous-product": "More than one LIVE product matches this mapping.",
  "identity-forbidden-shop": "This is a production shop. Pinning was blocked on purpose.",
  "identity-expected-shop-not-configured": "The expected shop name has not been set yet.",
  "identity-identity-not-found": "The shop name could not be read from the page.",
  "identity-mismatch": "The shop on screen is not the shop you configured.",
  "unexpected-page": "The LIVE dashboard did not open as expected. You may need to sign in again.",
  timeout: "TikTok responded too slowly.",
  stale: "The scene changed before this finished, so it was skipped.",
  "duplicate-playId": "This scene was already handled.",
  "dispatch-threw": "Something went wrong while handling this scene.",
  "service-error": "The pin service hit an unexpected problem.",

  // --- AutoComment ---
  "real-comment-send-disabled": "Automatic chat replies are turned off.",
  "pin-state-unreadable": "The pin could not be confirmed, so no reply was sent.",
  "empty-message": "The reply text is empty.",
  "comment-send-error": "The chat reply could not be sent.",
});

const FALLBACK = "Something went wrong. Check the logs for details.";

// Selalu mengembalikan bentuk yang sama, termasuk untuk kode yang belum ada di
// katalog: pemanggil tidak pernah perlu memeriksa apakah terjemahannya ada.
function translate(code, { detail } = {}) {
  const key = typeof code === "string" ? code : "";
  const out = {
    code: key || "unknown",
    userMessage: CATALOG[key] || FALLBACK,
  };
  if (detail !== undefined && detail !== null && String(detail) !== "") {
    // Dipotong, dan hanya satu baris: apa pun yang mirip stack trace kehilangan
    // barisan "at ..."-nya di sini.
    out.detail = String(detail).split("\n")[0].slice(0, 200);
  }
  return out;
}

// Kesalahan validasi config -> daftar kalimat per field. Path-nya ikut supaya UI
// nanti bisa menyorot field yang salah, tanpa perlu menebak dari kalimatnya.
const FIELD_PROBLEMS = Object.freeze({
  "must-be-non-empty-string": "needs to be filled in",
  "must-be-string": "has the wrong kind of value",
  "must-be-boolean": "must be on or off",
  "must-be-object": "has the wrong shape",
  "must-be-array": "must be a list",
  "must-be-string-array": "must be a list of words",
  "must-be-port": "must be a port number between 1 and 65535",
  "must-be-positive-int": "must be a whole number above zero",
  "must-be-non-negative-int": "must be a whole number, zero or more",
  "must-be-known-transport": 'must be either "dry-run" or "browser"',
  "must-not-be-empty": "cannot be empty",
  "duplicate-scene": "is mapped more than once",
  "duplicate-trigger": "is listed twice",
  "scene-never-mappable": "cannot have a product mapped to it",
  "reply-too-long": "is longer than 100 characters",
  "html-not-allowed": "cannot contain < or >",
  "control-chars": "contains characters that are not allowed",
  "not-an-object": "is not a valid configuration",
  "version-missing": "is missing its version number",
  "version-unsupported": "was made by a different version of the app",
  "port-conflicts-with-obs": "cannot be the same as the OBS port",
});

function translateFieldErrors(errors = []) {
  return errors.map((e) => ({
    path: e.path,
    code: e.code,
    userMessage: (e.path ? e.path + " " : "The configuration ") + (FIELD_PROBLEMS[e.code] || "is not valid"),
  }));
}

module.exports = { translate, translateFieldErrors, CATALOG, FALLBACK, FIELD_PROBLEMS };
