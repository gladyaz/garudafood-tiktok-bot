"use strict";
// Artefak config runtime: satu berkas yang dibuat Controller saat Start, dan
// dibaca oleh KEDUA proses anak.
//
// ---------------------------------------------------------------------------
// KENAPA BERKAS, BUKAN PULUHAN VARIABEL ENVIRONMENT
//
// Pemetaan scene->produk dulu berjalan sebagai AUTOPIN_PRODUCT_PAX_1..10, satu
// variabel per scene. Trigger dan balasan tidak mungkin ikut cara itu: satu
// scene bisa punya dua puluh trigger, dan balasan bisa memuat spasi, emoji,
// serta tanda baca. Melewatkannya lewat environment berarti menyandikan daftar
// di dalam string, dan setiap penyandian seperti itu akhirnya punya kasus tepi
// yang tidak pernah diuji.
//
// Jadi: SATU variabel environment yang berisi PATH, dan isinya JSON.
//
//   AILIVE_RUNTIME_CONFIG=C:\...\data\.runtime\runtime-<id>.json
//
// Yang MASIH lewat environment, dan alasannya — ini kompatibilitas, bukan
// kelalaian:
//
//   TIKTOK_USERNAME, OBS_*            dibaca di tingkat modul index.js sebelum
//                                     apa pun bisa disuntikkan
//   AUTOPIN_ENABLED, AUTOPIN_PORT,    gerbang dan anggaran waktu; dibaca juga
//   AUTOPIN_TIMEOUT_MS                oleh autopin/client.js dan service
//   AUTOCOMMENT_*                     dibaca autocomment/config.js, yang punya
//                                     tes default sendiri
//   AUTOPIN_PROFILE_DIR, _DEBUG_DIR,  dibaca autopin/config.js di proses service
//   _CONSOLE_URL, _EXPECTED_SHOP,
//   _FORBIDDEN_SHOPS, _CHROME_PATH
//   SCENE_REPLAY_COOLDOWN_MS          perilaku cooldown; tidak disentuh P2
//
// Memindahkan semuanya ke berkas berarti mengubah cara core membaca
// konfigurasinya — refactor yang jauh lebih besar daripada yang dibolehkan P2.
// Yang pindah hanya hal yang memang BARU: pemetaan scene/produk/trigger/balasan.
//
// ---------------------------------------------------------------------------
// APA YANG TIDAK PERNAH ADA DI BERKAS INI
//
// Tidak ada cookie, token, data sesi browser, maupun password OBS. Berkas ini
// hanya memuat apa yang sudah terlihat oleh penonton: nama scene, judul produk
// di daftar LIVE, kata kunci yang diketik penonton, dan kalimat yang akan
// dikirim ke chat. Kalau suatu saat ada yang ingin menambahkan rahasia ke sini,
// jawabannya tidak — berkas ini dibaca oleh dua proses dan hidup di disk.

const fsDefault = require("node:fs");
const crypto = require("node:crypto");

const RUNTIME_CONFIG_VERSION = 1;

// SATU-SATUNYA variabel environment yang P2 tambahkan.
const RUNTIME_CONFIG_ENV = "AILIVE_RUNTIME_CONFIG";

// ID generasi: hash dari isi yang berpengaruh. Dipakai untuk membuktikan bot dan
// service membaca generasi yang SAMA. Kalau suatu saat keduanya berbeda, itu
// berarti satu di antaranya memakai pemetaan basi — dan lebih baik terlihat
// sebagai angka yang tidak cocok daripada sebagai pin ke produk yang salah.
function computeRuntimeConfigId(payload) {
  const canonical = JSON.stringify({
    version: payload.version,
    mappings: (payload.mappings || []).map((m) => ({
      scene: m.scene,
      product: m.product && m.product.title ? { title: m.product.title } : null,
      triggers: Array.isArray(m.triggers) ? m.triggers.slice() : [],
      reply: typeof m.reply === "string" ? m.reply : null,
    })),
  });
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

// Bentuk artefak. Sengaja sempit: ia bukan tempat menumpuk pengaturan.
function buildRuntimeConfig({ mappings = [], configVersion = null, createdAt = null } = {}) {
  const payload = {
    version: RUNTIME_CONFIG_VERSION,
    // Versi config CUSTOMER yang menghasilkan artefak ini, untuk jejak audit.
    configVersion,
    createdAt: createdAt || new Date().toISOString(),
    mappings: mappings.map((m) => ({
      scene: String(m.scene).trim(),
      product: m.product && typeof m.product.title === "string" && m.product.title.trim() !== ""
        ? { title: m.product.title.trim() }
        : null,
      triggers: Array.isArray(m.triggers) ? m.triggers.filter((t) => typeof t === "string" && t.trim() !== "") : [],
      reply: typeof m.reply === "string" && m.reply.trim() !== "" ? m.reply.trim() : null,
    })),
  };
  payload.id = computeRuntimeConfigId(payload);
  return payload;
}

function validateRuntimeConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "not-an-object" };
  if (raw.version !== RUNTIME_CONFIG_VERSION) return { ok: false, reason: "version-unsupported" };
  if (!Array.isArray(raw.mappings)) return { ok: false, reason: "mappings-not-an-array" };
  if (typeof raw.id !== "string" || raw.id === "") return { ok: false, reason: "id-missing" };

  for (const m of raw.mappings) {
    if (!m || typeof m !== "object") return { ok: false, reason: "mapping-not-an-object" };
    if (typeof m.scene !== "string" || m.scene.trim() === "") return { ok: false, reason: "scene-missing" };
    if (!Array.isArray(m.triggers)) return { ok: false, reason: "triggers-not-an-array" };
    if (m.product !== null && (typeof m.product !== "object" || typeof m.product.title !== "string" || m.product.title.trim() === "")) {
      return { ok: false, reason: "product-invalid" };
    }
    if (m.reply !== null && typeof m.reply !== "string") return { ok: false, reason: "reply-invalid" };
  }

  // Hash harus cocok dengan isinya. Berkas yang disunting tangan sesudah dibuat
  // adalah berkas yang tidak lagi mewakili apa yang divalidasi Controller, dan
  // ia ditolak — bukan dipakai dengan harapan isinya masih benar.
  if (computeRuntimeConfigId(raw) !== raw.id) return { ok: false, reason: "id-mismatch" };

  return { ok: true };
}

// Tulis atomik: ke berkas sementara, lalu rename. Sama seperti config customer
// (controller/config-manager.js). Tanpa ini ada jendela di mana anak bisa
// membaca berkas yang baru separuh tertulis — dan anak itu akan mulai LIVE
// dengan pemetaan yang tidak lengkap.
function writeRuntimeConfig(file, payload, { fs = fsDefault } = {}) {
  const verdict = validateRuntimeConfig(payload);
  if (!verdict.ok) return { ok: false, reason: verdict.reason };
  const tmp = file + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* sisa berkas sementara bukan alasan menutupi error aslinya */
    }
    return { ok: false, reason: "write-failed" };
  }
  return { ok: true, file, id: payload.id };
}

// Dibaca anak satu kali saat boot. FAIL-CLOSED: artefak yang tidak bisa dibaca
// atau tidak valid TIDAK jatuh kembali ke perilaku legacy diam-diam. Controller
// yang menyuplai path berarti Controller sudah memvalidasi pemetaannya; kalau
// path itu ternyata tidak terbaca, yang benar adalah berhenti — bukan menyala
// dengan kata kunci hardcoded yang customer tidak pernah lihat dan tidak pilih.
function readRuntimeConfig(file, { fs = fsDefault } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    return { ok: false, reason: err && err.code === "ENOENT" ? "runtime-config-missing" : "runtime-config-unreadable" };
  }
  let parsed;
  try {
    // BOM dibuang lebih dulu, pelajaran yang sama dengan .bot.lock dan config
    // customer: berkas yang pernah tersentuh editor Windows hampir selalu
    // berawalan BOM, dan JSON.parse menolaknya.
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    return { ok: false, reason: "runtime-config-invalid-json" };
  }
  const verdict = validateRuntimeConfig(parsed);
  if (!verdict.ok) return { ok: false, reason: "runtime-config-" + verdict.reason };
  return { ok: true, config: parsed };
}

function removeRuntimeConfig(file, { fs = fsDefault } = {}) {
  let removed = false;
  for (const target of [file, file + ".tmp"]) {
    try {
      fs.unlinkSync(target);
      removed = true;
    } catch {
      /* tidak ada = tidak perlu dihapus */
    }
  }
  return { ok: true, removed };
}

module.exports = {
  buildRuntimeConfig,
  validateRuntimeConfig,
  computeRuntimeConfigId,
  writeRuntimeConfig,
  readRuntimeConfig,
  removeRuntimeConfig,
  RUNTIME_CONFIG_ENV,
  RUNTIME_CONFIG_VERSION,
};
