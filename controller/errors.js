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

  // --- mode automation (P5.1.1) ---
  //
  // Kalimatnya SENGAJA tanpa istilah teknis. Customer tidak pernah melihat kata
  // "dry-run" maupun "browser": yang ia lihat di Settings adalah dua saklar,
  // dan yang ia lihat di sini adalah saklar mana yang masih mati.
  "autopin-disabled": "Auto pin product is turned off.",
  "admin-reply-not-enabled": "Admin reply is not enabled.",
  "admin-reply-without-pin": "Admin reply needs Auto pin product turned on, because the reply is only sent after a product is pinned.",
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

  // --- P2: discovery OBS ---
  "obs-timeout": "OBS did not respond in time.",
  "obs-scene-list-unreadable": "The scene list could not be read from OBS.",

  // --- P2: discovery TikTok ---
  "tiktok-not-logged-in": "You are not signed in to TikTok. Sign in once, then try again.",
  "wrong-tiktok-account": "The TikTok account on screen is not the one you configured.",
  "live-not-active": "Your TikTok LIVE is not on air yet.",
  "product-dashboard-unavailable": "The TikTok product dashboard could not be opened.",
  "product-discovery-timeout": "Reading your LIVE products took too long.",
  "expected-shop-not-configured": "The expected shop name has not been set yet.",
  "discovery-not-configured": "Product discovery is not available in this build.",
  "discovery-unavailable-while-running": "Stop the automation first. Products can only be read while it is stopped.",

  // --- P2: validasi pemetaan ---
  "no-triggers": "This scene has no trigger words yet.",
  "ambiguous-trigger": "Two scenes use the same trigger word.",
  "empty-product-title": "This scene has no product selected.",
  "product-missing": "This scene is missing its product field.",
  "scene-playback-unknown": "This scene has no video settings, so it cannot be played.",
  "reply-required-when-autocomment-enabled": "This scene needs a reply, because automatic replies are turned on.",
  "mapping-validation-failed": "Some of your scene mappings need fixing.",

  // --- P2: config runtime ---
  "runtime-config-missing": "The generated runtime settings file is missing.",
  "runtime-config-unreadable": "The generated runtime settings file could not be read.",
  "runtime-config-invalid-json": "The generated runtime settings file is damaged.",
  "runtime-config-id-mismatch": "The generated runtime settings file was modified after it was created.",
  "runtime-config-write-failed": "The runtime settings could not be prepared.",
  "runtime-config-generation-mismatch": "The bot and the pin service are using different settings.",
  "restart-required": "Your changes are saved. Restart the automation to use them.",

  // --- P4: login TikTok dan kepemilikan profil ---
  "login-not-configured": "TikTok sign-in is not available in this build.",
  "login-already-in-progress": "A TikTok sign-in window is already open.",
  "login-not-in-progress": "No TikTok sign-in is in progress.",
  "login-not-finished": "Sign-in is not finished yet. Complete it in the browser window, then check again.",
  "login-window-closed": "The sign-in window was closed before sign-in finished.",
  "login-browser-failed": "The sign-in window could not be opened.",
  "login-in-progress": "Finish or cancel the TikTok sign-in first.",
  "login-unavailable-while-running": "Stop the automation first. You can only sign in while it is stopped.",
  "profile-busy-login": "A TikTok sign-in window is open. Finish or cancel it first.",
  "profile-busy-automation": "The automation is using the browser. Stop it first.",
  "profile-busy-external": "Another Chrome window is using the browser profile. Close it and try again.",
  "not-profile-owner": "The browser profile is in use by something else.",
  "unknown-profile-owner": "Internal problem while reserving the browser.",
  "discovery-unavailable-during-login": "Finish or cancel the TikTok sign-in first, then refresh.",

  // --- P4: otoritas run ---
  "run-already-armed": "A run is already authorized. Stop the automation first.",

  // --- P4: desktop ---
  "controller-start-failed": "AI LIVE HOST could not start.",
  "controller-not-ready": "AI LIVE HOST is still starting.",
  "shutdown-requires-stopped": "Stop the automation before shutting down.",

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
  "product-missing": "needs a product, or null if this scene pins nothing",
});

function translateFieldErrors(errors = []) {
  return errors.map((e) => ({
    path: e.path,
    code: e.code,
    userMessage: (e.path ? e.path + " " : "The configuration ") + (FIELD_PROBLEMS[e.code] || "is not valid"),
  }));
}

module.exports = { translate, translateFieldErrors, CATALOG, FALLBACK, FIELD_PROBLEMS };
