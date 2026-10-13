"use strict";
// Konfigurasi AutoPIN dari environment. Tidak ada nilai rahasia di sini.

const path = require("path");

const ROOT = path.resolve(__dirname, "..");

function readPositiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// Hanya dipakai kalau AUTOPIN_FORBIDDEN_SHOPS memang TIDAK ADA di env.
// Controller selalu mengirimkannya (config-manager.js toEnv), jadi di produksi
// nilai ini tidak pernah terpakai; ia menjaga jalur legacy CLI tetap sama.
const LEGACY_FORBIDDEN_SHOPS = "garudafood";

function splitShops(value) {
  return String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function loadConfig(env = process.env) {
  return {
    // Halaman product dashboard adalah satu-satunya yang TERVERIFIKASI punya
    // tombol Pin per produk saat LIVE berjalan. /streamer/live-console lama
    // redirect ke halaman marketing US dan tidak pernah memuat daftar produk.
    consoleUrl: env.AUTOPIN_CONSOLE_URL || "https://shop.tiktok.com/streamer/live/product/dashboard",
    profileDir: path.resolve(ROOT, env.AUTOPIN_PROFILE_DIR || ".autopin-profile"),
    debugDir: path.resolve(ROOT, env.AUTOPIN_DEBUG_DIR || ".autopin-debug"),
    expectedShop: env.AUTOPIN_EXPECTED_SHOP || "",
    // identitas yang mengandung salah satu kata ini = produksi → tidak boleh diklik
    //
    // "TIDAK DISETEL" dan "SENGAJA DIKOSONGKAN" adalah dua hal berbeda, dan
    // dulu keduanya sama saja di sini.
    //
    // controller/config-manager.js:366 menulis daftar ini dengan .join(","),
    // jadi daftar kosong menjadi "". Dengan `|| LEGACY_FORBIDDEN_SHOPS`, string
    // kosong itu jatuh ke fallback - sehingga Controller yakin daftarnya kosong
    // sementara anak runtime diam-diam memakai nama klien lama. Dua lapis yang
    // menyimpang, dan yang menyimpang tidak pernah yang kelihatan.
    //
    // Sekarang: env yang ADA dihormati apa adanya, termasuk saat ia kosong.
    // Fallback hanya berlaku kalau env memang TIDAK ADA sama sekali - yaitu
    // jalur legacy `node autopin-cli.js` tanpa Controller, yang perilakunya
    // sengaja tidak diubah.
    //
    // Ini TIDAK melemahkan apa pun: penjaga utama di checkIdentity() adalah
    // kecocokan PERSIS dengan expectedShop, dan daftar ini hanya lapis kedua
    // yang menangkap salah konfigurasi.
    forbiddenShops: splitShops(
      typeof env.AUTOPIN_FORBIDDEN_SHOPS === "string"
        ? env.AUTOPIN_FORBIDDEN_SHOPS
        : LEGACY_FORBIDDEN_SHOPS
    ),
    chromePath: env.AUTOPIN_CHROME_PATH || "",
    navTimeoutMs: readPositiveInt(env.AUTOPIN_NAV_TIMEOUT_MS, 45_000),
    readyTimeoutMs: readPositiveInt(env.AUTOPIN_READY_TIMEOUT_MS, 30_000),
    loginTimeoutMs: readPositiveInt(env.AUTOPIN_LOGIN_TIMEOUT_MS, 15 * 60_000),
  };
}

module.exports = { loadConfig, ROOT };
