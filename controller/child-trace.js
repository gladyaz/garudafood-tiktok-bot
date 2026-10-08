"use strict";
// Jejak baris MENTAH dari bot dan service, untuk audit sesudah satu run.
//
// MURNI dan OPSIONAL. Tidak ada satu pun keputusan di sini: tidak menyentuh
// antrean, matcher, AutoPIN, AutoComment, batas waktu, retry, perilaku scene,
// maupun otoritas run. Ia hanya memutuskan baris mana yang boleh IKUT DICATAT.
//
// ---------------------------------------------------------------------------
// MASALAH YANG DIPECAHKAN
//
// stdout bot dan service dibaca controller/process-manager.js, dioper ke
// activity feed, dan apa pun yang TIDAK dikenali feed itu DIBUANG. Feed hanya
// mengenali sembilan tag (controller/activity.js TAG_TYPES), dan dari masing-
// masing baris hanya menyimpan scene/reason/playId/ms/key.
//
// Jadi sesudah sebuah run LIVE, rantai yang paling perlu diaudit tidak ada di
// mana pun:
//
//   [MATCH]                        trigger mana yang cocok
//   [QUEUE]                        apakah ia diantrekan
//   [AUTOPIN_REQUEST]              permintaan pin
//   [AUTOPIN_SERVICE_PINNED]       after=... via=...  <- SUMBER & STATE konfirmasi
//   [AUTOCOMMENT_SEND_RECONCILED]  hasil rekonsiliasi kirim
//
// `state=` dan `via=` bahkan dibuang oleh parser feed, jadi "pin terkonfirmasi
// lewat apa" tidak bisa dijawab sesudahnya.
//
// ---------------------------------------------------------------------------
// KENAPA ALLOWLIST, DAN BUKAN "CATAT SEMUANYA"
//
// Karena "semuanya" memuat SELURUH ISI CHAT PENONTON:
//
//   index.js:1207  [TIKTOK_CHAT] user=<nama> comment="<isi komentar>"
//   index.js:949   💬 <nama>: <isi komentar>
//
// Mencatat semuanya berarti setiap komentar setiap penonton tertulis ke berkas
// di disk customer — berkas yang justru DIKIRIMKAN customer saat melaporkan
// masalah. Itu bukan kebocoran rahasia teknis, itu lebih buruk: data orang lain
// yang tidak pernah setuju.
//
// Maka yang dipakai adalah daftar TERTUTUP, dan arah kegagalannya disengaja:
//
//   - baris tanpa tag `[NAMA]`  -> TIDAK PERNAH dicatat (itu menutup baris 💬)
//   - tag di luar daftar        -> TIDAK dicatat
//   - tag di daftar TOLAK       -> TIDAK dicatat, apa pun isi daftar izin
//
// Tag baru di masa depan karena itu TIDAK ikut tercatat sampai seseorang
// menambahkannya dengan sengaja. Itulah gunanya.

// Variabel environment yang menyalakannya. Default MATI.
//
// Dimatikan secara default bukan karena ragu, tapi karena dua biaya nyata:
// volume dan privasi. runtime/op-log.js ada justru karena 20.000 komentar
// pernah menghasilkan 20.000 baris dan menulis stdout itu SINKRON — ia
// memblokir event loop yang sama dengan penanganan OBS. Jejak ini menambah satu
// hop lagi di atas itu. Untuk satu run validasi terkendali itu murah; sebagai
// perilaku bawaan di LIVE berjam-jam ia adalah regresi.
const TRACE_ENV = "AILIVE_TRACE_CHILD";

// Keluarga tag otomasi. Semua baris AutoPIN/AutoComment memakai awalan ini
// (autopin/core.js log() mencetak `[AUTOPIN_<TAG>]`), dan tidak satu pun dari
// mereka memuat identitas penonton — isinya scene, playId, judul produk (yang
// sudah terlihat penonton di daftar LIVE), ms, state, dan reason.
const TRACE_FAMILIES = Object.freeze(["AUTOPIN_", "AUTOCOMMENT_"]);

// Tag bot yang membentuk rantai audit, satu per satu.
const TRACE_TAGS = Object.freeze([
  // rantai utama
  "MATCH",
  "QUEUE",
  "PLAY",
  "PLAYBACK_END",
  "AGGREGATE",
  "MEDIA_END",
  // kenapa sesuatu TIDAK terjadi — sama pentingnya saat mengaudit
  "COOLDOWN_START",
  "SKIP_ACTIVE",
  "SKIP_COOLDOWN",
  "SKIP_PLAYED",
  "SKIP_QUEUED",
  "INVALID_SCENE",
  "OBS_SWITCH_STALE",
  "AUX_FAILED",
  "AUX_SKIPPED",
  // generasi config runtime: membuktikan bot dan service memakai pemetaan sama
  "BOT_SESSION",
  "RUNTIME_CONFIG_ENV",
  "RUNTIME_CONFIG_REFUSED",
  "RUNTIME_CONFIG_SCENE_IGNORED",
  // sambungan TikTok
  "TIKTOK_CONNECTING",
  "TIKTOK_CONNECTED",
  "TIKTOK_RECONNECTED",
  "TIKTOK_RECONNECT",
  "TIKTOK_DISCONNECTED",
  "TIKTOK_ERROR",
  "TIKTOK_CHAT_GATE_ERROR",
  // kunci satu-instance
  "SINGLE_INSTANCE_HELD",
  "SINGLE_INSTANCE_REFUSED",
  "SINGLE_INSTANCE_STALE_TAKEOVER",
]);

// Tag yang TIDAK BOLEH dicatat, dan penolakan ini MENANG atas daftar izin.
//
// Secara teknis sudah cukup kalau TIKTOK_CHAT tidak ada di TRACE_TAGS. Daftar
// ini ada supaya penolakannya menjadi pernyataan, bukan kelalaian: tanpa itu,
// seseorang bisa menambahkan TIKTOK_CHAT ke daftar izin sambil lalu dan mulai
// menulis isi chat penonton ke disk tanpa ada yang merah. Tesnya mengikat ini.
const TRACE_DENY = Object.freeze(["TIKTOK_CHAT"]);

const TAG_RE = /^\s*\[([A-Z][A-Z0-9_]*)\]/;

const ALLOW_SET = new Set(TRACE_TAGS);
const DENY_SET = new Set(TRACE_DENY);

// Tag sebuah baris, atau null kalau baris itu tidak bertag.
function traceTagOf(line) {
  if (typeof line !== "string") return null;
  const m = TAG_RE.exec(line);
  return m ? m[1] : null;
}

// Apakah baris ini boleh ikut dicatat.
function shouldTrace(line) {
  const tag = traceTagOf(line);
  // Baris tanpa tag tidak pernah dicatat. Inilah yang menutup `💬 <nama>: <isi>`
  // di index.js:949 tanpa perlu mengenalinya secara khusus.
  if (tag === null) return false;
  // Penolakan menang lebih dulu.
  if (DENY_SET.has(tag)) return false;
  if (ALLOW_SET.has(tag)) return true;
  return TRACE_FAMILIES.some((p) => tag.startsWith(p));
}

// Apakah jejak diminta. Hanya nilai yang eksplisit "1"/"true" yang menyalakan;
// variabel yang ada tapi kosong TIDAK menyalakan.
function traceEnabled(env = process.env) {
  const v = env && env[TRACE_ENV];
  return v === "1" || String(v).toLowerCase() === "true";
}

// Membuat penulis jejak. Mengembalikan fungsi (role, line) -> boolean, di mana
// nilai kembaliannya berarti "baris ini dicatat".
//
//   enabled  biasanya traceEnabled(env)
//   write    (text) -> void. Di produksi console.log; di tes sebuah array.
function createChildTracer({ enabled = false, write = null } = {}) {
  if (!enabled || typeof write !== "function") return () => false;

  return function trace(role, line) {
    if (!shouldTrace(line)) return false;
    // Awalan menyebut ASALNYA, dan sengaja TIDAK dimulai dengan "[CONTROLLER_":
    // desktop/controller-child.js mencocokkan `^\[CONTROLLER_BOOT\]` dan
    // `^\[CONTROLLER_(FATAL|BOOT_FAILED)\]` pada stdout Controller, dan baris
    // anak tidak boleh pernah bisa terbaca sebagai kabar fatal Controller.
    //
    // Peran ikut dicatat karena rantainya melintasi dua proses: permintaan pin
    // datang dari bot, hasil dan konfirmasinya dari service.
    try {
      write("[CHILD:" + String(role || "?") + "] " + line);
    } catch {
      /* jejak yang gagal ditulis tidak boleh menjatuhkan Controller */
    }
    return true;
  };
}

module.exports = {
  createChildTracer,
  shouldTrace,
  traceTagOf,
  traceEnabled,
  TRACE_ENV,
  TRACE_TAGS,
  TRACE_DENY,
  TRACE_FAMILIES,
};
