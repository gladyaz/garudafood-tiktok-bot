
// index.js (patched) - Queue + wait-for-media + 1-minute cooldown behavior
// Extended with aggregation (merge identical etalase requests) and anti-spam (per-user rate/flood) + CMD controls.
// Based on user's prior file and requested features.

require("dotenv").config();
const { WebcastPushConnection, UserOfflineError } = require("tiktok-live-connector");
const OBSWebSocket = require("obs-websocket-js").default;

// ====== CONFIG DASAR ======
const tiktokUsername = process.env.TIKTOK_USERNAME;
const obsHost = process.env.OBS_HOST || "localhost";
const obsPort = Number(process.env.OBS_PORT || 4455);
const obsPassword = process.env.OBS_PASSWORD || "";

// Scene name di OBS (samakan persis dengan OBS-mu)
const SCENES = {
  MAIN: "MAIN",
  AILIVE_SKUPAXSATU: "PAX-1",
  AILIVE_SKUPAXDUA: "PAX-2",
  AILIVE_SKUPAXTIGA: "PAX-3",
  AILIVE_SKUPAXEMPAT: "PAX-4",
  AILIVE_SKUPAXLIMA: "PAX-5",
  AILIVE_SKUPAXENAM: "PAX-6",
  AILIVE_SKUPAXTUJUH: "PAX-7",
  AILIVE_SKUPAXDELAPAN: "PAX-8",
  AILIVE_SKUPAXSEMBILAN: "PAX-9",
  AILIVE_SKUPAXSEPULUH: "PAX-10",
  AILIVE_FAQ_STOKHABIS: "AI LIVE_FAQ_STOKHABIS",
  AILIVE_FAQ_CO: "AI LIVE_FAQ_CO",
  AILIVE_FAQ_ORDER: "AI LIVE_FAQ_ORDER",
  AILIVE_FAQ_ORIGINALEXPIRED: "AI LIVE_FAQ_ORIGINALEXPIRED",
};

// PENTING: mediaInputs berisi NAMA INPUT DI OBS, bukan nama berkas video.
// Event MediaInputPlaybackEnded dari obs-websocket mengirim inputName (mis. "Media 3"),
// bukan nama file (mis. "PAX-2.mp4"). Dulu nilai di sini diisi nama file, sehingga
// tidak pernah cocok dan SETIAP scene berakhir lewat fallback timer.
// Cara memastikan ulang kalau sumber di OBS diganti:
//   GetSceneItemList { sceneName: "PAX-N" } -> sourceName
// Scene PAX-5 dan PAX-10 punya dua sumber media; yang kedua ("Media 7" / "Media 12")
// kosong tanpa berkas dan TIDAK PERNAH mengirim Playback{Started,Ended}, jadi sengaja
// tidak ditunggu - menunggunya akan membuat scene selalu jatuh ke fallback.
const RULES = [
  {
    scene: SCENES.AILIVE_SKUPAXSATU,
    keywords: ["et 1", "etalase 1", "etalase satu", "no 1", "nomor 1", "nomor satu", "paket 1", "paket satu", "produk 1", "produk satu", "spill et 1", "spill etalase 1", "spill etalase satu", "spill no 1", "spill nomor 1", "spill nomor satu", "spill paket 1", "spill paket satu", "spill produk 1", "spill produk satu", "ting ting", "tingting", "garuda ting ting", "garuda tingting", "ting ting pouch", "tingting pouch", "garuda ting ting pouch", "garuda tingting pouch", "peanut candy", "peanut bar candy", "spill ting ting", "spill tingting", "spill garuda ting ting", "spill garuda tingting", "spill ting ting pouch", "spill garuda ting ting pouch"],
    mediaInputs: ["Media"],
    waitForMediaEnd: true,   // FALSE => durasi pakai manual
    duration: 46000,          // FAILSAFE saja - video asli 40.4s + margin 5s; normalnya scene diakhiri MediaInputPlaybackEnded
    
  },
  {
    scene: SCENES.AILIVE_SKUPAXDUA,
    keywords: ["et 2", "etalase 2", "etalase dua", "no 2", "nomor 2", "nomor dua", "paket 2", "paket dua", "produk 2", "produk dua", "spill et 2", "spill etalase 2", "spill etalase dua", "spill no 2", "spill nomor 2", "spill nomor dua", "spill paket 2", "spill paket dua", "spill produk 2", "spill produk dua", "gery potato", "gery potato cracker", "potato cracker", "gery kentang", "biskuit kentang", "gery biskuit kentang", "gery bbq", "bbq", "rasa bbq", "spill gery potato", "spill potato cracker", "spill gery kentang"],
    mediaInputs: ["Media 3"],
    waitForMediaEnd: true,   // FALSE => durasi pakai manual
    duration: 46000,          // FAILSAFE saja - video asli 40.3s + margin 5s; normalnya scene diakhiri MediaInputPlaybackEnded
    
  },
  {
    scene: SCENES.AILIVE_SKUPAXTIGA,
    keywords: ["et 3", "etalase 3", "etalase tiga", "no 3", "nomor 3", "nomor tiga", "paket 3", "paket tiga", "produk 3", "produk tiga", "spill et 3", "spill etalase 3", "spill etalase tiga", "spill no 3", "spill nomor 3", "spill nomor tiga", "spill paket 3", "spill paket tiga", "spill produk 3", "spill produk tiga", "chocolatos pillow", "chocolatos pillow 97", "chocolatos pillow 97gr", "pillow chocolatos", "pillow chocolate", "coklat pillow", "chocolatos", "spill chocolatos pillow", "spill pillow", "spill coklat pillow"],
    mediaInputs: ["Media 4"],
    waitForMediaEnd: true,   // FALSE => durasi pakai manual
    duration: 52000,          // FAILSAFE saja - video asli 46.2s + margin 5s; normalnya scene diakhiri MediaInputPlaybackEnded
    
  },
  {
    scene: SCENES.AILIVE_SKUPAXEMPAT,
    keywords: ["et 4", "etalase 4", "etalase empat", "no 4", "nomor 4", "nomor empat", "paket 4", "paket empat", "produk 4", "produk empat", "spill et 4", "spill etalase 4", "spill etalase empat", "spill no 4", "spill nomor 4", "spill nomor empat", "spill paket 4", "spill paket empat", "spill produk 4", "spill produk empat", "chocolatos rts", "chocolatos rts mt", "chocolatos drink chocolate", "chocolatos drink matcha", "chocolatos chocolate", "chocolatos matcha", "chocolatos rts chocolate", "chocolatos rts matcha", "chocolatos 5 pcs", "chocolatos 5 sachet", "chocolatos isi 5", "spill chocolatos", "spill chocolatos chocolate", "spill chocolatos matcha", "spill minuman chocolatos", "spill minuman coklat", "spill minuman matcha"],
    mediaInputs: ["Media 5"],
    waitForMediaEnd: true,   // FALSE => durasi pakai manual
    duration: 69000,          // FAILSAFE saja - video asli 64.0s + margin 5s; normalnya scene diakhiri MediaInputPlaybackEnded
    
  },
  {
    scene: SCENES.AILIVE_SKUPAXLIMA,
    keywords: ["et 5", "etalase 5", "etalase lima", "no 5", "nomor 5", "nomor lima", "paket 5", "paket lima", "produk 5", "produk lima", "spill et 5", "spill etalase 5", "spill etalase lima", "spill no 5", "spill nomor 5", "spill nomor lima", "spill paket 5", "spill paket lima", "spill produk 5", "spill produk lima", "spill garuda", "spill snack garuda", "garuda", "garuda pilus", "pilus mi goreng", "garuda crunchy corn", "crunchy corn", "corn seasalt", "garuda rosta", "rosta kacang", "rosta kacang panggang", "garuda kacang atom", "kacang atom", "garuda kacang kulit", "kacang kulit", "kacang garuda", "spill pilus", "spill crunchy corn", "spill rosta", "spill kacang atom", "spill kacang kulit"],
    mediaInputs: ["Media 6"],
    waitForMediaEnd: true,   // FALSE => durasi pakai manual
    duration: 58000,          // FAILSAFE saja - video asli 52.9s + margin 5s; normalnya scene diakhiri MediaInputPlaybackEnded
    
  },
  {
    scene: SCENES.AILIVE_SKUPAXENAM,
    keywords: ["et 6", "etalase 6", "etalase enam", "no 6", "nomor 6", "nomor enam", "paket 6", "paket enam", "produk 6", "produk enam", "spill et 6", "spill etalase 6", "spill etalase enam", "spill no 6", "spill nomor 6", "spill nomor enam", "spill paket 6", "spill paket enam", "spill produk 6", "spill produk enam", "spill gery", "spill snack gery", "gery malkist", "gery malkist coklat", "malkist coklat", "gery malkist kelapa", "malkist kelapa", "malkist tabur kelapa", "gery malkist keju", "malkist keju", "gery snack sereal", "snack sereal", "gery sereal coklat", "sereal coklat", "gery snack bantal", "snack bantal", "bantal extrude", "gery bantal", "spill malkist", "spill malkist coklat", "spill malkist kelapa", "spill malkist keju", "spill sereal", "spill sereal coklat", "spill snack bantal"],
    mediaInputs: ["Media 8"],
    waitForMediaEnd: true,   // FALSE => durasi pakai manual
    duration: 48000,          // FAILSAFE saja - video asli 42.9s + margin 5s; normalnya scene diakhiri MediaInputPlaybackEnded
    
  },
  {
    scene: SCENES.AILIVE_SKUPAXTUJUH,
    keywords: ["et 7", "etalase 7", "etalase tujuh", "no 7", "nomor 7", "nomor tujuh", "paket 7", "paket tujuh", "produk 7", "produk tujuh", "spill et 7", "spill etalase 7", "spill etalase tujuh", "spill no 7", "spill nomor 7", "spill nomor tujuh", "spill paket 7", "spill paket tujuh", "spill produk 7", "spill produk tujuh", "spill chocolatos", "spill chocolatos rich", "chocolatos rich", "chocolatos wafer", "chocolatos wafer stick", "wafer stick chocolatos", "chocolatos pistachio", "chocolatos rich pistachio", "pistachio chocolatos", "chocolatos matcha", "chocolatos rich matcha", "matcha chocolatos", "chocolatos drink", "chocolatos drink rts", "drink rts kurma", "chocolatos kurma", "chocolatos drink kurma", "chocolatos pillow", "chocolatos pillow chocolate", "pillow chocolate", "chocolatos chocolate", "spill chocolatos rich wafer", "spill wafer stick", "spill pistachio", "spill matcha", "spill kurma", "spill drink kurma", "spill pillow", "spill pillow chocolate"],
    mediaInputs: ["Media 9"],
    waitForMediaEnd: true,   // FALSE => durasi pakai manual
    duration: 62000,          // FAILSAFE saja - video asli 56.7s + margin 5s; normalnya scene diakhiri MediaInputPlaybackEnded
    
  },
  {
    scene: SCENES.AILIVE_SKUPAXDELAPAN,
    keywords: ["et 8", "etalase 8", "etalase delapan", "no 8", "nomor 8", "nomor delapan", "paket 8", "paket delapan", "produk 8", "produk delapan", "spill et 8", "spill etalase 8", "spill etalase delapan", "spill no 8", "spill nomor 8", "spill nomor delapan", "spill paket 8", "spill paket delapan", "spill produk 8", "spill produk delapan", "spill dilan", "produk dilan", "dilan cookies", "dilan cookies chocolate", "cookies dilan", "dilan sandwich", "dilan sandwich chocolate", "dilan crunchy caramel", "dilan crunchy caramel chocolate", "dilan caramel", "dilan pouch", "dilan chocolate pouch", "dilan matcha", "dilan matcha crunchy caramel", "dilan matcha sandwich", "dilan sandwich matcha", "dilan waffle", "dilan waffle pandan", "waffle pandan dilan", "spill dilan cookies", "spill cookies dilan", "spill dilan sandwich", "spill sandwich dilan", "spill dilan caramel", "spill dilan pouch", "spill dilan matcha", "spill dilan waffle", "spill waffle pandan"],
    mediaInputs: ["Media 10"],
    waitForMediaEnd: true,   // FALSE => durasi pakai manual
    duration: 77000,          // FAILSAFE saja - video asli 71.6s + margin 5s; normalnya scene diakhiri MediaInputPlaybackEnded
    
  },
  {
    scene: SCENES.AILIVE_SKUPAXSEMBILAN,
    keywords: ["et 9", "etalase 9", "etalase sembilan", "no 9", "nomor 9", "nomor sembilan", "paket 9", "paket sembilan", "produk 9", "produk sembilan", "spill et 9", "spill etalase 9", "spill etalase sembilan", "spill no 9", "spill nomor 9", "spill nomor sembilan", "spill paket 9", "spill paket sembilan", "spill produk 9", "spill produk sembilan", "everyday snack mix", "everyday snack", "snack mix", "paket everyday snack mix", "paket snack mix", "spill everyday snack mix", "spill everyday snack", "spill snack mix", "mau everyday snack mix", "ambil everyday snack mix", "yang everyday snack mix", "everyday mix"],
    mediaInputs: ["Media 11"],
    waitForMediaEnd: true,   // FALSE => durasi pakai manual
    duration: 57000,          // FAILSAFE saja - video asli 52.0s + margin 5s; normalnya scene diakhiri MediaInputPlaybackEnded
    
  },
  {
    scene: SCENES.AILIVE_SKUPAXSEPULUH,
    keywords: ["etalase 10", "etalase sepuluh", "et 10", "no 10", "nomor 10", "paket 10", "paket sepuluh", "produk 10", "produk sepuluh", "big sharing pack", "big sharing", "sharing pack", "paket big sharing", "paket sharing", "paket besar", "paket sharing besar", "spill big sharing", "spill big sharing pack", "spill sharing pack", "spill paket sharing", "mau big sharing pack", "ambil big sharing pack", "yang big sharing pack", "big sharing pack yang mana"],
    mediaInputs: ["Media 13"],
    waitForMediaEnd: true,   // contoh: ini mau bener-bener nunggu video selesai
    duration: 71000,          // FAILSAFE saja - video asli 65.9s + margin 5s; normalnya scene diakhiri MediaInputPlaybackEnded
    
  },
  {
    scene: SCENES.AILIVE_FAQ_STOKHABIS,
    enabled: false, // scene FAQ belum ada di OBS -> set true untuk mengaktifkan kembali
    keywords: ["stok", "stok?", "stock", "stoknya", "stoknya?", "ready", "ready?", "redi", "redi?", "rdy", "ada", "ada?", "masih", "masih?", "masih ada", "masih ada?", "masih ready", "masih ready?", "masiada", "masiada?", "stok habis", "stok habis?", "stokhabis", "stokkosong", "kosong", "kosong?", "habis", "habis?", "abis", "abis?", "sold", "sold?", "sold out", "soldout", "sisa", "sisa berapa", "sisa berapa?", "sisaberapa", "restok", "restok?", "restock", "kapan restok", "kapan restok?", "kapan ready", "kapan ready?", "barang ready", "barang ready?", "masih kebagian", "masih kebagian?", "mau beli", "mau order", "mau pesen", "gabisa klik", "gabisa co", "kok habis", "kok habis?", "yah habis", "telat", "cek stok", "cek stok?", "cekharga", "info stok"],
    mediaInputs: ["AI LIVE_FAQ_STOKHABIS.mp4"],
    waitForMediaEnd: true,
    duration: 34000,          // 34 detik
  },
  {
    scene: SCENES.AILIVE_FAQ_CO,
    enabled: false, // scene FAQ belum ada di OBS -> set true untuk mengaktifkan kembali
    keywords: ["sudah co", "sudah co?", "sudahco", "udah co", "udah co?", "udahco", "dah co", "dahco", "co", "checkout", "cekot", "cekot?", "cekaout", "sudah bayar", "sudah bayar?", "sudahbayar", "udah bayar", "udahbayar", "lunas", "lunas?", "payment", "payment done", "sukses", "berhasil", "transaksi berhasil", "pesanan", "pesanan saya", "cek pesanan", "tolong proses", "mohon diproses", "proses ya", "proses ya?", "langsung kirim", "langsung kirim?", "dikirim kapan", "dikirim kapan?", "kapan dikirim", "kapan dikirim?", "kapan kirim", "kapan kirim?", "kirim hari ini", "kirim hari ini?", "kirim skrg", "hari ini kirim?", "lama ga", "lama ga?", "resi", "resi mana", "resi mana?", "ditunggu", "ditunggu ya", "dtunggu", "paket saya", "paket mana", "paket mana?", "uda trf", "sdh trf", "bungkus", "bungkus gan", "bungkus min"],
    mediaInputs: ["AI LIVE_FAQ_CO.mp4"],
    waitForMediaEnd: true,    // contoh: ini mau bener-bener nunggu video selesai
    duration: 24000,          // dipakai sebagai fallback kalau event media nggak muncul
  },
  {
    scene: SCENES.AILIVE_FAQ_ORDER,
    enabled: false, // scene FAQ belum ada di OBS -> set true untuk mengaktifkan kembali
    keywords: ["cod", "cod?", "bisa cod", "bisa cod?", "bisacod", "bayar ditempat", "bayar ditempat?", "bayar di tempat", "bayar di tempat?", "kirim", "kirim?", "pengiriman", "pengiriman?", "ongkir", "ongkir?", "ongkos kirim", "gratis ongkir", "free ongkir", "packing", "packing?", "paking", "peking", "packing aman", "packing aman?", "aman ga", "aman ga?", "aman gak", "aman gak?", "takut pecah", "takut remuk", "takut hancur", "bubble", "bubble wrap", "pake bubble", "pake bubble?", "buble", "tebal", "kardus", "pake dus", "lokasi", "lokasi?", "dari mana", "dari mana?", "pengiriman dari mana", "dikirim dari mana", "jkt", "jakarta", "jawa", "luar jawa", "luar pulau", "kirim ke", "sampai", "nyampe", "nyampe mana", "berapa hari", "berapa hari?", "lama", "lama?", "estimasi", "kurir", "ekspedisi"],
    mediaInputs: ["AI LIVE_FAQ_ORDER"],
    waitForMediaEnd: true,   // FALSE => durasi pakai manual
    duration: 42000,          // 42 detik
    
  },
  {
    scene: SCENES.AILIVE_FAQ_ORIGINALEXPIRED,
    enabled: false, // scene FAQ belum ada di OBS -> set true untuk mengaktifkan kembali
    keywords: ["ori", "ori?", "original", "original?", "asli", "asli?", "garuda asli", "garuda asli?", "official", "resmi", "palsu", "kw", "bukan kw", "jamin ori", "jamin asli", "expired", "expired?", "expire", "exp", "exp?", "xpired", "ed", "ed?", "tgl ed", "kapan expired", "kapan expired?", "expired kapan", "expired kapan?", "kapan exp", "kapan exp?", "expkapan", "kadaluarsa", "kadaluarsa?", "kadeluarsa", "tgl kadaluarsa", "basi", "basi?", "masih lama", "masih lama?", "barang baru", "stok baru", "fresh", "fresh?", "tengik", "alot", "halal", "halal?", "logo halal", "ada halal", "aman dimakan", "aman dikonsumsi", "kualitas", "rasa", "renyah", "enak ga", "enak ga?", "thn brp", "bulan apa", "tahun berapa"],
    mediaInputs: ["AI LIVE_FAQ_ORIGINALEXPIRED"],
    waitForMediaEnd: true,
    duration: 33000,          // 33 detik
  },
  // dst...
];

// Rule dianggap aktif kecuali ditandai enabled:false (scene-nya belum ada di OBS).
// Definisi + keyword tetap tersimpan di RULES; cukup set enabled:true untuk mengaktifkan lagi.
const activeRules = () => RULES.filter((r) => r.enabled !== false);


// durasi maksimal kembali ke MAIN / cooldown (bisa diubah runtime)
let RETURN_DELAY_MS = 60_000;
let COOLDOWN_MS = 60_000;

// ====== KONEK OBS ======
const obs = new OBSWebSocket();
let sceneDurationTimer = null; // timer khusus durasi manual per scene
let lastScene = null;
let timer = null;

// men-track media-inputs yang sedang menunggu selesai
let waitingMediaSet = new Set();
let waitingRule = null; // rule yang sedang aktif menunggu media selesai

// ========== QUEUE SYSTEM (menggunakan aggregates) ==========
let sceneAggregates = []; // stores aggregate objects
let busy = false; // true saat ada scene aktif yang menunggu cooldown

// === GLOBAL DEDUPE: scene yang sudah diputar dalam 1 batch antrean ===
let playedScenes = new Set();

// === PER-SCENE REPLAY COOLDOWN ===
// scene yang sedang diputar + kapan masing-masing scene boleh diputar lagi.
// Map maksimal berisi 1 entry per scene; entry kadaluarsa dihapus saat dicek.
function readNonNegativeIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    console.warn(`⚠ ${name}="${raw}" tidak valid → pakai default ${fallback}`);
    return fallback;
  }
  return n;
}
const SCENE_REPLAY_COOLDOWN_MS = readNonNegativeIntEnv("SCENE_REPLAY_COOLDOWN_MS", 120_000);
let activeScene = null;
const sceneCooldownUntil = new Map(); // sceneName -> timestamp (ms)
let globalPauseTimer = null; // timer jeda global COOLDOWN_MS setelah balik ke MAIN

// ====== AUTOPIN (AUXILIARY — tidak boleh memengaruhi playback) ======
// Bot TIDAK memuat Puppeteer. Browser hidup di proses service terpisah
// (autopin-service.js); di sini hanya ada klien HTTP tipis + dispatcher yang
// menelan semua kegagalannya sendiri. Lihat autopin/scene-pin.js.
const { createScenePin } = require("./autopin/scene-pin");
const { loadSceneProductMap, describeSceneProductMap } = require("./autopin/scene-map");
const { createHttpSender, serviceUrl } = require("./autopin/client");
const { newSessionId } = require("./autopin/session");

// Satu ID untuk seumur proses bot ini. Dikirim pada setiap permintaan ke
// service supaya restart bot TIDAK lagi membuat playId baru dianggap basi -
// bug yang ditemukan 2026-10-05 saat operator me-restart bot saja.
const BOT_SESSION_ID = newSessionId();

const AUTOPIN_ENABLED = String(process.env.AUTOPIN_ENABLED || "false").trim().toLowerCase() === "true";
const AUTOPIN_TIMEOUT_MS = readNonNegativeIntEnv("AUTOPIN_TIMEOUT_MS", 8_000);
const autopinMap = loadSceneProductMap(process.env);

let scenePin = createScenePin({
  enabled: AUTOPIN_ENABLED,
  mapping: autopinMap,
  timeoutMs: AUTOPIN_TIMEOUT_MS,
  send: createHttpSender({ url: serviceUrl(process.env), timeoutMs: AUTOPIN_TIMEOUT_MS, sessionId: BOT_SESSION_ID }),
});

// ====== AUTOCOMMENT (AUXILIARY - saudara AutoPIN, bukan bawahannya) ======
// Bot TIDAK memuat Puppeteer. Browser hidup di proses service terpisah; di sini
// hanya ada klien HTTP tipis. Dipicu oleh scene start yang sama dengan AutoPIN,
// tapi kegagalannya tidak pernah menyentuh playback.
const { createAutoComment, PIN_POLICY } = require("./autocomment/core");
const { loadConfig: loadAutoCommentConfig, TRANSPORTS } = require("./autocomment/config");
const { createCommentSender } = require("./autocomment/client");
const { inspectPinResult } = require("./autopin/pin-result");
const { createChatGate } = require("./tiktok/chat-gate");
const { createInstanceLock } = require("./runtime/single-instance");

// Default-nya (enabled=false, transport dry-run, batas internal konservatif)
// diuji di test/autocomment.config.test.js, jadi tidak bergantung pada .env
// siapa pun. Mengirim chat sungguhan BUTUH DUA LAPIS: transport=browser di sini,
// DAN service yang dijalankan dengan --enable-autocomment-send.
const autocommentConfig = loadAutoCommentConfig(process.env);
const AUTOCOMMENT_ENABLED = autocommentConfig.enabled;
const AUTOCOMMENT_TRANSPORT = autocommentConfig.transport;

let autoComment = createAutoComment({
  enabled: AUTOCOMMENT_ENABLED,
  // Kalimat "sudah aku pin" adalah KLAIM ke penonton. Saat transport browser,
  // klaim itu hanya boleh terucap kalau produknya TERBUKTI ter-pin. Saat
  // dry-run cukup AutoPIN yang ok: tidak ada yang sampai ke penonton, dan
  // gladi bersihnya tetap setia pada urutan sungguhan.
  pinPolicy: AUTOCOMMENT_TRANSPORT === TRANSPORTS.BROWSER ? PIN_POLICY.CONFIRMED : PIN_POLICY.OK,
  inspectPin: inspectPinResult,
  send: createCommentSender({ mode: AUTOCOMMENT_TRANSPORT, timeoutMs: autocommentConfig.timeoutMs, sessionId: BOT_SESSION_ID }),
  maxPerMinute: autocommentConfig.maxPerMinute,
  minIntervalMs: autocommentConfig.minIntervalMs,
  timeoutMs: autocommentConfig.timeoutMs,
});
// Instance asli, disimpan sebelum tes menggantinya lewat setAutoComment: untuk
// membuktikan flag dari env benar-benar sampai ke dispatcher yang dipakai produksi.
const realAutoCommentState = autoComment.__state;

// Jumlah penonton yang meminta scene yang sedang diputar: hanya untuk log.
// Diisi processQueue() tepat sebelum processTrigger(); 0 untuk switch operator.
let currentPlayRequesters = 0;

// AutoPIN dijalankan lebih dulu, lalu HASILNYA menentukan apakah AutoComment
// berhak bicara. Dijalankan sebagai satu tugas latar: jalur playback tidak
// pernah menunggu browser, dan kegagalan di sini tidak punya jalan untuk
// menyentuh busy / activeScene / cooldown / timer / antrean.
async function runAuxiliaries(sceneName, playId, requesters) {
  let pin;
  try {
    pin = await scenePin.requestPin({ scene: sceneName, playId });
  } catch (err) {
    console.warn(`[AUTOPIN_FAILED] scene=${sceneName} playId=${playId} reason=dispatch-threw`);
    pin = { ok: false, reason: "dispatch-threw" };
  }

  try {
    await autoComment.requestComment({ scene: sceneName, playId, requesters, pin });
  } catch (err) {
    console.warn(`[AUTOCOMMENT_FAILED] scene=${sceneName} playId=${playId} reason=dispatch-threw`);
  }
}

// Kedua saudara auxiliary dipanggil dari satu tempat, dengan satu gerbang:
// scene harus MASIH yang aktif saat OBS membalas. Kalau operator sudah force
// (atau scene lain sudah menggantikan) selagi OBS masih memproses, scene ini
// tidak pernah benar-benar "mulai" bagi penonton -> jangan pin, jangan komentar,
// dan jangan habiskan jatah rate limit untuknya.
function dispatchAuxiliaries(sceneName, playId, requesters) {
  if (activeScene !== sceneName) {
    console.log(`[AUX_SKIPPED] scene=${sceneName} playId=${playId} reason=scene-no-longer-active active=${activeScene}`);
    return;
  }
  // fire-and-forget: hasilnya tidak pernah ditunggu oleh playback.
  try {
    const task = runAuxiliaries(sceneName, playId, requesters);
    if (task && typeof task.catch === "function") task.catch(() => {});
  } catch (err) {
    console.warn(`[AUX_FAILED] scene=${sceneName} playId=${playId} reason=dispatch-threw`);
  }
}

// playId naik setiap kali sebuah scene MULAI di-switch (bukan saat di-antre dan
// bukan saat OBS sudah balas). Urutan berdasarkan waktu permintaan inilah yang
// membuat hasil milik scene lama bisa dikenali sebagai basi saat ada force.
let playSeq = 0;
const nextPlayId = () => ++playSeq;

// Generasi playback yang SEDANG berlaku: playId dari switch yang terakhir dimulai
// dan belum selesai / di-force / di-abort. 0 = tidak ada pemutaran yang berlaku
// (playId valid selalu >= 1, jadi 0 tidak pernah cocok dengan permintaan lama).
// Balasan OBS - sukses maupun gagal - yang playId-nya bukan ini adalah sisa dari
// pemutaran lama dan harus menjadi no-op. Nama scene saja tidak cukup: setelah
// force all, scene yang SAMA bisa diminta ulang (ABA) dan namanya cocok lagi.
let activePlayId = 0;

// Dipanggil HANYA setelah SetCurrentProgramScene sukses dan failsafe terpasang.
// Sengaja tidak di-await: jalur playback tidak boleh menunggu browser.
function isValidSceneName(sceneName) {
  return typeof sceneName === "string" && sceneName.trim() !== "";
}

// sisa cooldown (ms) untuk scene; hapus entry yang sudah kadaluarsa
function sceneCooldownRemaining(sceneName) {
  const until = sceneCooldownUntil.get(sceneName);
  if (until === undefined) return 0;
  const remaining = until - Date.now();
  if (remaining <= 0) {
    sceneCooldownUntil.delete(sceneName);
    return 0;
  }
  return remaining;
}

// tutup scene aktif: log selesai + mulai cooldown per-scene
function finishActiveScene(reason) {
  activePlayId = 0; // generasi ini berakhir: balasan OBS yang telat untuknya jadi no-op
  if (!activeScene) return;
  console.log(`[PLAYBACK_END] scene=${activeScene} reason=${reason}`);
  if (SCENE_REPLAY_COOLDOWN_MS > 0) {
    sceneCooldownUntil.set(activeScene, Date.now() + SCENE_REPLAY_COOLDOWN_MS);
    console.log(`[COOLDOWN_START] scene=${activeScene} duration=${SCENE_REPLAY_COOLDOWN_MS}`);
  }
  activeScene = null;
}

// Aggregation + anti-spam config
const DEDUPE_WINDOW_MS = 5000; // waktu window untuk gabung request sama (5s)
const USER_RATE_WINDOW_MS = 10000; // sliding window per user (10s)
const USER_RATE_LIMIT = 6; // >6 pesan per 10s => mute sementara
const FLOOD_WINDOW_MS = 5000; // detect repeated identical msg (5s)
const FLOOD_TRIPLE_LIMIT = 3; // 3 pesan sama dalam window => treat as flood
const AUTO_PROMOTE_THRESHOLD = 3; // kalau aggregate count >= ini, bisa prioritas lebih tinggi

let perUserMap = new Map(); // username -> array[timestamps]
let userLastMessages = new Map(); // username -> { lastMsg, repeatCount, lastAt }
let isMutedUntil = new Map(); // username -> timestamp until muted

// structure of aggregate:
// { scene: 'SCENE_NAME', rule: ruleObj, count: N, requesters: Set(), firstAt: ts, lastAt: ts, priority: 0 }

// helper: find aggregate for scene within dedupe window
function findAggregateForScene(sceneName) {
  const now = Date.now();
  for (const agg of sceneAggregates) {
    if (agg.scene === sceneName && (now - agg.lastAt) <= DEDUPE_WINDOW_MS) return agg;
  }
  return null;
}

// --- FIX: enqueueTrigger sekarang auto-process queue & merge dengan benar ---
function enqueueTrigger(rule, requesterNickname = null) {
  if (!rule) return;

  const scene = rule.scene;
  if (!isValidSceneName(scene)) {
    console.error(`[INVALID_SCENE] scene=${scene} → request diabaikan (cek SCENES/RULES)`);
    return;
  }

  // === ACTIVE: scene sedang diputar → jangan antre lagi ===
  if (scene === activeScene) {
    console.log(`[SKIP_ACTIVE] scene=${scene}`);
    return;
  }

  // === PER-SCENE COOLDOWN setelah selesai diputar ===
  const cooldownLeft = sceneCooldownRemaining(scene);
  if (cooldownLeft > 0) {
    console.log(`[SKIP_COOLDOWN] scene=${scene} remaining=${cooldownLeft}`);
    return;
  }

  // === GLOBAL DEDUPE: kalau scene sudah pernah diputar, skip ===
if (playedScenes.has(scene)) {
  console.log(`[SKIP_PLAYED] scene=${scene} (already played in this batch)`);
  return;
}


  // check mute (kalau sistem mute ada)
  if (requesterNickname && typeof isMutedUntil !== "undefined") {
    const muteUntil = isMutedUntil.get(requesterNickname) || 0;
    if (Date.now() < muteUntil) {
      console.log(`⚠ Ignore: ${requesterNickname} is muted`);
      return;
    }
  }

  // --- Merge aggregate kalau scene sudah ada ---
  // Dalam DEDUPE_WINDOW_MS → [AGGREGATE] (perilaku lama).
  // Di luar window tapi scene masih antre → tetap merge [SKIP_QUEUED]:
  // maksimal 1 entry per scene di antrean.
  const inWindow = findAggregateForScene(scene);
  const existing = inWindow || sceneAggregates.find(a => a.scene === scene);

  if (existing) {
    existing.count = (existing.count || 0) + 1;
    existing.lastAt = Date.now();
    if (requesterNickname) {
      if (!existing.requesters) existing.requesters = new Set();
      existing.requesters.add(requesterNickname);
    }
    const tag = inWindow ? "AGGREGATE" : "SKIP_QUEUED";
    console.log(`[${tag}] scene=${scene} count=${existing.count}`);
  } else {
    const agg = {
      scene,
      rule,
      count: 1,
      requesters: new Set(requesterNickname ? [requesterNickname] : []),
      firstAt: Date.now(),
      lastAt: Date.now(),
      priority: 0,
    };
    sceneAggregates.push(agg);
    console.log(`[QUEUE] scene=${scene} queueLen=${sceneAggregates.length}`);
  }

  // --- AUTO PROCESS QUEUE ---
  // Kalau tidak busy → langsung panggil processQueue() (delay 50ms supaya bisa merge request berdekatan)
  if (!busy) {
    console.log("▶ Idle → will start processing queue in 50ms (allow merge).");
    setTimeout(() => {
      if (!busy) {
        console.log("▶ Starting processQueue() from enqueueTrigger");
        processQueue();
      } else {
        console.log("▶ Became busy before processing queue");
      }
    }, 50);
  } else {
    console.log("▶ Busy → item akan diproses setelah current job selesai");
  }
}

// processQueue updated: pick highest priority aggregate first (but preserve FIFO as tiebreak)
function processQueue() {
  if (busy) return;
  if (sceneAggregates.length === 0) {
    console.log("📭 Aggregate queue kosong.");
    return;
  }

  // pick index of highest priority, otherwise earliest created
  let idx = 0;
  for (let i = 0; i < sceneAggregates.length; i++) {
    if (sceneAggregates[i].priority > sceneAggregates[idx].priority) idx = i;
  }

const next = sceneAggregates.splice(idx, 1)[0];
if (next) {
  // === FAIL-SAFE: entry tidak valid jangan sampai bikin busy macet ===
  if (!isValidSceneName(next.scene) || !next.rule) {
    console.error(`[INVALID_SCENE] scene=${next.scene} → entry dibuang, lanjut antrean`);
    return processQueue();
  }
  // safety net invariant: scene aktif / cooldown tidak boleh diputar ulang
  const cooldownLeft = sceneCooldownRemaining(next.scene);
  if (next.scene === activeScene || cooldownLeft > 0) {
    console.log(`[SKIP_COOLDOWN] scene=${next.scene} remaining=${cooldownLeft} → entry dibuang dari antrean`);
    return processQueue();
  }

  busy = true;
  activeScene = next.scene;

  // === tandai scene ini sudah diputar ===
  playedScenes.add(next.scene);

  console.log(`[PLAY] scene=${next.scene} count=${next.count} requesters=${next.requesters ? next.requesters.size : 0}`);
  currentPlayRequesters = next.requesters ? next.requesters.size : 0;
  processTrigger(next.rule);
}
}

// helper to skip aggregate by scene
function skipAggregate(sceneName) {
  const idx = sceneAggregates.findIndex(a => a.scene === sceneName);
  if (idx >= 0) {
    sceneAggregates.splice(idx, 1);
    console.log(`⛔ Aggregate ${sceneName} di-skip dan dihapus dari queue.`);
  } else {
    console.log(`⚠ Aggregate ${sceneName} tidak ditemukan di queue.`);
  }
}

// helper to promote aggregate to front (set priority)
function promoteAggregate(sceneName) {
  const agg = sceneAggregates.find(a => a.scene === sceneName);
  if (agg) {
    agg.priority = 2; // lebih tinggi
    console.log(`⬆ Aggregate ${sceneName} dipromote (priority=${agg.priority}).`);
  } else {
    console.log(`⚠ Aggregate ${sceneName} tidak ditemukan.`);
  }
}

// user spam tracking: call this for every chat message before matching rules
function recordUserMessage(nickname, message) {
  const now = Date.now();

  // per-user timestamps sliding window
  let arr = perUserMap.get(nickname) || [];
  arr.push(now);
  // remove old
  arr = arr.filter(ts => now - ts <= USER_RATE_WINDOW_MS);
  perUserMap.set(nickname, arr);
  if (arr.length > USER_RATE_LIMIT) {
    // mute for a bit
    const muteFor = USER_RATE_WINDOW_MS * 2;
    isMutedUntil.set(nickname, now + muteFor);
    console.log(`🔇 User ${nickname} muted for ${muteFor/1000}s (too many msgs: ${arr.length})`);
    return { muted: true, reason: "rate" };
  }

  // flood detection for identical repeated messages
  const last = userLastMessages.get(nickname) || { lastMsg: null, repeatCount: 0, lastAt: 0 };
  if (message === last.lastMsg && (now - last.lastAt) <= FLOOD_WINDOW_MS) {
    last.repeatCount += 1;
  } else {
    last.lastMsg = message;
    last.repeatCount = 1;
  }
  last.lastAt = now;
  userLastMessages.set(nickname, last);

  if (last.repeatCount >= FLOOD_TRIPLE_LIMIT) {
    console.log(`🚫 Flood detected from ${nickname} (repeat ${last.repeatCount}) — ignoring message.`);
    return { muted: true, reason: "flood" };
  }

  return { muted: false };
}

// proses trigger: set busy then switchScene
function processTrigger(rule) {
  if (!rule) return;
  busy = true;
  console.log(`▶ Proses trigger: ${rule.scene}`);
  switchScene(rule.scene, rule);
}

function endCurrentScene(reason = "unknown", forceCooldown = false) {
  try {
    console.log(`⏹ endCurrentScene reason=${reason}`);

    // clear semua timer terkait scene
    if (sceneDurationTimer) {
      clearTimeout(sceneDurationTimer);
      sceneDurationTimer = null;
    }
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }

    // sudah tidak menunggu media lagi
    waitingMediaSet.clear();
    waitingRule = null;

    // scene selesai → mulai cooldown per-scene, lepas activeScene
    finishActiveScene(reason);

    // lepas busy untuk lanjut antrean
    busy = false;
    console.log("➡ busy = false. Cek antrean...");

    // kalau masih ada queue, langsung proses next (tanpa balik MAIN)
    if (Array.isArray(sceneAggregates) && sceneAggregates.length > 0) {
      console.log(
        `➡ Queue masih ada (${sceneAggregates.length}) → langsung processQueue()`
      );
      setTimeout(() => {
        if (!busy) processQueue();
      }, 50);
      return;
    }

// === RESET global dedupe kalau antrean kosong ===
if (sceneAggregates.length === 0) {
  console.log("♻ Reset playedScenes (queue empty)");
  playedScenes.clear();
}
    // kalau antrean kosong → kita boleh balik ke MAIN
    if (lastScene !== SCENES.MAIN) {
      console.log("➡ Queue kosong → switch ke MAIN");
      obs
        .call("SetCurrentProgramScene", { sceneName: SCENES.MAIN })
        .then(() => {
          lastScene = SCENES.MAIN;
        })
        .catch((e) => console.warn("Gagal switch MAIN di endCurrentScene:", e));
    }

    // opsional: cooldown setelah balik ke MAIN
    if (forceCooldown && COOLDOWN_MS > 0) {
      busy = true;
      console.log(`⏳ Mulai cooldown ${COOLDOWN_MS} ms`);
      globalPauseTimer = setTimeout(() => {
        globalPauseTimer = null;
        busy = false;
        console.log("✅ Cooldown selesai");

        if (Array.isArray(sceneAggregates) && sceneAggregates.length > 0) {
          processQueue();
        }
      }, COOLDOWN_MS);
    } else {
      console.log("ℹ Tidak pakai cooldown setelah scene ini.");
    }
  } catch (err) {
    console.error("Error di endCurrentScene:", err);
    busy = false;
  }
}


// ====== OBS CONNECT ======
async function connectOBS() {
  try {
    await obs.connect(`ws://${obsHost}:${obsPort}`, obsPassword);
    console.log("✅ Terhubung ke OBS WebSocket");
  } catch (err) {
    console.error("❌ Gagal connect ke OBS:", err);
  }
}

// helper: normalisasi pesan (lowercase, ganti non-alnum ke spasi, collapse spaces)
function normalizeText(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function wordNumberToDigit(s) {
  const map = { satu: "1", dua: "2", tiga: "3", empat: "4", lima: "5", enam: "6", tujuh: "7", delapan: "8", sembilan: "9", nol: "0" };
  let out = s;
  for (const [k, v] of Object.entries(map)) {
    const re = new RegExp(`\\b${k}\\b`, "g");
    out = out.replace(re, v);
  }
  return out;
}

function levenshtein(a, b) {
  if (!a || !b) return (a || b) ? Math.max(a.length, b.length) : 0;
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function fuzzyRatio(a, b) {
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - dist / maxLen;
}

function normalizeForMatching(s) {
  return wordNumberToDigit(normalizeText(s));
}

// Cocokkan frasa pada BATAS KATA, bukan substring mentah.
// normalizeForMatching() sudah memisahkan setiap token dengan satu spasi, jadi cukup
// membungkus kedua sisi dengan spasi. Efeknya: "etalase 10" tidak lagi cocok dengan
// keyword "etalase 1" (dulu cocok karena substring), tapi "spill etalase 10" tetap cocok
// dengan "etalase 10" karena batasnya tetap utuh.
function containsPhrase(haystackNorm, needleNorm) {
  if (!haystackNorm || !needleNorm) return false;
  return ` ${haystackNorm} `.includes(` ${needleNorm} `);
}

// FAIL-SAFE: scene antrean gagal mulai → jangan biarkan busy/activeScene macet
function abortSceneStart(sceneName, reason) {
  const tag = isValidSceneName(sceneName) ? "PLAY_FAILED" : "INVALID_SCENE";
  console.error(`[${tag}] scene=${sceneName} reason=${reason} → lepas busy, lanjut antrean`);
  endCurrentScene("play-failed", false);
}

// utama: switch scene (meng-handle media wait / fallback)
function switchScene(sceneName, rule = null) {
  if (!isValidSceneName(sceneName) || sceneName === lastScene) {
    // dulu: return diam-diam → busy=true selamanya (bot macet)
    if (rule) abortSceneStart(sceneName, !isValidSceneName(sceneName) ? "empty-scene-name" : "already-current-scene");
    return;
  }

  console.log("🔁 Switch Scene →", sceneName);

  // Diambil sebelum request OBS dikirim: kalau force menyalip, scene yang lebih
  // baru punya playId lebih besar walau OBS-nya balas lebih dulu.
  const playId = nextPlayId();
  activePlayId = playId; // generasi ini yang berlaku sampai selesai / di-force / di-abort
  // Ditangkap SEKARANG, bukan saat OBS membalas: slot bersama bisa sudah ditimpa
  // scene lain kalau operator menyalip selagi OBS masih memproses.
  const requesters = currentPlayRequesters;

  obs
    .call("SetCurrentProgramScene", { sceneName })
    .then(() => {
      // Balasan untuk pemutaran yang sudah tidak berlaku -> no-op total.
      if (playId !== activePlayId || (rule && activeScene !== sceneName)) {
        console.log(`[OBS_SWITCH_STALE] scene=${sceneName} playId=${playId} currentPlayId=${activePlayId} active=${activeScene} phase=resolve`);
        return;
      }
      lastScene = sceneName;

      // bersihkan semua state & timer lama
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (sceneDurationTimer) {
        clearTimeout(sceneDurationTimer);
        sceneDurationTimer = null;
      }
      waitingMediaSet.clear();
      waitingRule = null;

      // kalau ke MAIN, cukup set visual saja
      if (sceneName === SCENES.MAIN) {
        console.log("ℹ Scene MAIN aktif.");
        return;
      }

      // --- Kalau rule minta tunggu media selesai ---
      if (rule && rule.waitForMediaEnd && Array.isArray(rule.mediaInputs) && rule.mediaInputs.length) {
        rule.mediaInputs.forEach((i) => waitingMediaSet.add(i));
        waitingRule = rule;
        console.log(
          "⏳ Menunggu media selesai untuk inputs:",
          Array.from(waitingMediaSet)
        );

        // fallback: kalau media tidak pernah kirim event 'end',
        // pakai rule.duration dulu, kalau tidak ada pakai RETURN_DELAY_MS
        const fallbackMs = rule.duration || RETURN_DELAY_MS;

        timer = setTimeout(() => {
          console.log(
            "⏱ Fallback media-end timeout tercapai -> anggap media selesai."
          );
          endCurrentScene("media-fallback", true);
        }, fallbackMs);

        // playback sudah aman (scene aktif + failsafe terpasang) -> baru pin
        dispatchAuxiliaries(sceneName, playId, requesters);
        return;
      }

      // --- MODE: DURASI MANUAL PER SCENE (tidak pakai event media) ---
      const dur = (rule && rule.duration) ? rule.duration : RETURN_DELAY_MS;
      console.log(`⏳ Durasi manual scene ${sceneName} = ${dur} ms`);

      // pastikan busy = true selama scene jalan
      busy = true;

      sceneDurationTimer = setTimeout(() => {
        console.log(`⌛ Durasi selesai untuk scene ${sceneName}`);
        // forceCooldown = true → begitu selesai, kalau queue kosong,
        // dia balik MAIN lalu nunggu COOLDOWN_MS sebelum trigger baru diproses.
        // Kalau mau tanpa cooldown, ubah true → false.
        endCurrentScene("manual-duration", false);
      }, dur);

      // failsafe sudah terpasang -> baru saudara-saudara auxiliary dipanggil
      dispatchAuxiliaries(sceneName, playId, requesters);
    })
    .catch((err) => {
      console.error("❌ Error ganti scene:", err?.message || err);
      if (playId !== activePlayId || (rule && activeScene !== sceneName)) {
        console.log(`[OBS_SWITCH_STALE] scene=${sceneName} playId=${playId} currentPlayId=${activePlayId} active=${activeScene} phase=reject`);
        return;
      }
      if (rule) abortSceneStart(sceneName, "obs-switch-error");
    });
}

// OBS event: media input selesai diputar.
// obs-websocket v5 (obs-websocket-js 5.0.7) HANYA mengirim "MediaInputPlaybackEnded"
// dengan payload { inputName, inputUuid }. Nama event lama (InputPlaybackEnded, MediaEnded, dll)
// tidak pernah ada, sehingga media-end tidak pernah terdeteksi dan selalu jatuh ke fallback.
obs.on("MediaInputPlaybackEnded", (data) => {
  try {
    const inputName = data?.inputName;
    if (!inputName) return;

    // Hanya input yang sedang ditunggu yang boleh mengakhiri scene.
    // Tanpa guard ini, media lain (mis. video idle di MAIN) bisa mengakhiri scene yang sedang jalan.
    if (!waitingMediaSet.has(inputName)) return;

    console.log(`[MEDIA_END] input=${inputName}`);
    waitingMediaSet.delete(inputName);

    if (waitingMediaSet.size !== 0 || !waitingRule) return;

    // endCurrentScene() membersihkan fallback timer + waitingRule, jadi scene selesai
    // tepat sekali dan fallback yang tersisa tidak bisa mengakhiri scene berikutnya.
    // Log [PLAYBACK_END] scene=... reason=media-ended dicetak oleh finishActiveScene().
    endCurrentScene("media-ended", true);
  } catch (e) {
    console.warn("Error menangani event media end", e);
  }
});

function matchAndEnqueue(rule, nickname, via) {
  console.log(`[MATCH] scene=${rule.scene} user=${nickname} via=${via}`);
  enqueueTrigger(rule, nickname);
}

// Chat handler: includes spam check and uses enqueueTrigger(rule, nickname)
function handleChat(data) {
  const nickname = data.nickname || data.user || "anon";
  let msgRaw = (data.comment || "").toLowerCase().trim();
  console.log(`💬 ${nickname}: ${msgRaw}`);

  // spam check
  const check = recordUserMessage(nickname, msgRaw);
  if (check.muted) {
    // ignore message
    return;
  }

  const msgNorm = normalizeForMatching(msgRaw);

  for (const rule of activeRules()) {
    if (rule.pattern) {
      const re = new RegExp(rule.pattern, "i");
      if (re.test(msgRaw)) {
        matchAndEnqueue(rule, nickname, "pattern");
        return;
      }
    }

    if (Array.isArray(rule.keywords)) {
      for (const kw of rule.keywords) {
        const kwNorm = normalizeForMatching(kw);
        if (containsPhrase(msgNorm, kwNorm)) {
          matchAndEnqueue(rule, nickname, "keyword");
          return;
        }
      }
    }
  }

  // fallback fuzzy
  let best = { score: 0, rule: null };
  for (const rule of activeRules()) {
    if (!Array.isArray(rule.keywords)) continue;
    for (const kw of rule.keywords) {
      const kwNorm = normalizeForMatching(kw);
      const score = fuzzyRatio(msgNorm, kwNorm);
      if (score > best.score) best = { score, rule };
    }
  }
  if (best.rule && best.score >= 0.55) {
    matchAndEnqueue(best.rule, nickname, "fuzzy");
    return;
  }
}

// =================== CMD / stdin controls ===================
// clear semua timer scene + jeda global (dipakai force / force all)
function clearAllSceneTimers() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (sceneDurationTimer) {
    clearTimeout(sceneDurationTimer);
    sceneDurationTimer = null;
  }
  if (globalPauseTimer) {
    clearTimeout(globalPauseTimer);
    globalPauseTimer = null;
  }
}

async function switchToMainForOperator(label) {
  try {
    await obs.call("SetCurrentProgramScene", { sceneName: SCENES.MAIN });
    lastScene = SCENES.MAIN;
  } catch (e) {
    console.warn(`Gagal switch MAIN saat ${label}:`, e?.message || e);
  }
}

// FORCE: hentikan scene sekarang (scene aktif tetap masuk cooldown), lalu lanjut antrean
async function forceCurrent() {
  console.log("‼ FORCE: memaksa hentikan kondisi sekarang (mengabaikan media).");
  waitingMediaSet.clear();
  waitingRule = null;
  clearAllSceneTimers();
  finishActiveScene("force");

  await switchToMainForOperator("force");

  busy = false;
  processQueue();
}

// FORCE ALL: hard reset — kosongkan antrean, dedupe, cooldown, state aktif
async function forceAll() {
  console.log("💥 FORCE ALL: hentikan semua + clear seluruh antrean.");
  sceneAggregates.length = 0;
  playedScenes.clear();
  sceneCooldownUntil.clear();
  activeScene = null;
  activePlayId = 0;
  waitingMediaSet.clear();
  waitingRule = null;
  clearAllSceneTimers();
  busy = false;

  await switchToMainForOperator("force all");

  console.log("✅ FORCE ALL selesai. Queue kosong & system idle.");
}

async function handleCommand(chunk) {
  const input = (chunk || "").toString().trim();
  if (!input) return;
  const parts = input.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  switch (cmd) {
    case "help":
      console.log("Perintah yang tersedia:");
      console.log("  next                -> hentikan cooldown sekarang (jika ada) dan jalankan trigger selanjutnya (tidak memaksa stop media).");
      console.log("  force               -> PAKSA hentikan media/cooldown sekarang, switch ke MAIN, lalu proses trigger berikutnya.");
      console.log("  status              -> lihat status sekarang.");
      console.log("  cooldown <ms>       -> ubah durasi cooldown (ms). Contoh: 'cooldown 5000'");
      console.log("  skip <SCENE_NAME>   -> hapus aggregate tertentu dari queue.");
      console.log("  promote <SCENE_NAME>-> promote aggregate (prioritas lebih tinggi).");
      console.log("  help                -> tampilkan ini.");
      console.log("  force all           -> PAKSA hentikan semua & CLEAR seluruh antrean (hard reset).");
      break;

    case "status": {
      console.log("===== STATUS =====");
      console.log("busy:", busy);
      console.log("aggregate queue length:", sceneAggregates.length);
      console.log("waitingMediaSet:", Array.from(waitingMediaSet));
      console.log("waitingRule:", waitingRule ? waitingRule.scene : null);
      console.log("timer active:", !!timer);
      console.log("CURRENT SCENE:", lastScene);
      console.log("COOLDOWN_MS:", COOLDOWN_MS, "ms");
      console.log("ACTIVE SCENE:", activeScene);
      console.log("SCENE_REPLAY_COOLDOWN_MS:", SCENE_REPLAY_COOLDOWN_MS, "ms");
      console.log("Scene cooldowns:");
      for (const scene of Array.from(sceneCooldownUntil.keys())) {
        const left = sceneCooldownRemaining(scene); // sekaligus hapus yang kadaluarsa
        if (left > 0) console.log(` - ${scene} | remaining=${left}ms`);
      }
      console.log("Aggregated Queue:");
      for (const a of sceneAggregates) {
        console.log(` - ${a.scene} | count=${a.count} | priority=${a.priority} | requesters=${Array.from(a.requesters).slice(0,4).join(", ")}`);
      }
      console.log("==================");
      break;
    }

    case "next": {
      // next hanya bisa mempercepat saat sedang cooldown atau idle
      if (!busy) {
        console.log("ℹ Tidak sedang busy — langsung proses queue (jika ada).");
        processQueue();
        break;
      }
      // jika sedang menunggu media playing, tolak dan sarankan 'force'
      if (waitingMediaSet.size > 0) {
        console.log("⚠ Masih ada media yang diputar. Gunakan 'force' jika ingin memaksa skip media.");
        break;
      }
      // sedang busy tapi tidak menunggu media => berarti di cooldown, hentikan cooldown dan lanjutkan
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      // jeda global juga dihentikan, supaya timer-nya tidak melepas busy di tengah scene berikutnya
      if (globalPauseTimer) {
        clearTimeout(globalPauseTimer);
        globalPauseTimer = null;
      }
      busy = false;
      console.log("⏭ Next: menghentikan cooldown sekarang dan melanjutkan queue.");
      processQueue();
      break;
    }

    case "force": {
      // "force" = hentikan scene sekarang; "force all" = hard reset
      if (parts[1]?.toLowerCase() === "all") {
        await forceAll();
      } else {
        await forceCurrent();
      }
      break;
    }

    case "cooldown": {
      if (parts.length < 2) {
        console.log("Gunakan: cooldown <ms>");
        break;
      }
      const ms = parseInt(parts[1], 10);
      if (Number.isNaN(ms) || ms < 0) {
        console.log("Nilai ms tidak valid.");
        break;
      }
      COOLDOWN_MS = ms;
      RETURN_DELAY_MS = Math.max(RETURN_DELAY_MS, ms); // pastikan fallback minimal sama
      console.log(`✅ COOLDOWN_MS di-set ke ${COOLDOWN_MS} ms`);
      break;
    }

    case "skip": {
      const scene = parts[1];
      if (!scene) { console.log("Gunakan: skip <SCENE_NAME>"); break; }
      skipAggregate(scene);
      break;
    }

    case "promote": {
      const scene = parts[1];
      if (!scene) { console.log("Gunakan: promote <SCENE_NAME>"); break; }
      promoteAggregate(scene);
      break;
    }

    default:
      console.log("Perintah tidak dikenal. Ketik 'help' untuk daftar perintah.");
      break;
  }
}

// =================== TIKTOK CONNECTIVITY ===================
// Observability + reconnect. TIDAK mengubah handleChat, matching, queue/cooldown,
// anti-spam, AutoPIN, maupun OBS. Jalur chat tetap: event -> handleChat() yang sudah ada.
//
// Reconnect memakai ULANG instance yang sama: setDisconnected() di konektor mengembalikan
// state ke DISCONNECTED, sehingga connect() bisa dipanggil lagi. Karena instance-nya tidak
// pernah diganti, listener didaftarkan tepat sekali dan tidak mungkin dobel.
const TIKTOK_BACKOFF_MS = [2_000, 5_000, 10_000, 20_000, 30_000];
const TIKTOK_OFFLINE_RETRY_MS = 30_000; // LIVE benar-benar offline -> jangan agresif

let tiktokConn = null;
let tiktokReconnectTimer = null;
let tiktokAttempt = 0;        // 0 = koneksi terakhir sukses
let tiktokConnecting = false; // guard: hanya satu upaya connect aktif
let tiktokStopped = false;    // true setelah stopTikTok() (shutdown)

function tiktokBackoffMs(attempt) {
  const idx = Math.min(Math.max(attempt, 1), TIKTOK_BACKOFF_MS.length) - 1;
  return TIKTOK_BACKOFF_MS[idx];
}

// .name pada UserOfflineError tetap "Error", jadi cek lewat instanceof + nama constructor.
function isUserOfflineError(err) {
  return err instanceof UserOfflineError || err?.constructor?.name === "UserOfflineError";
}

function scheduleTikTokReconnect(reason, offline = false) {
  if (tiktokStopped) return;
  if (tiktokReconnectTimer || tiktokConnecting) return; // cegah upaya ganda
  tiktokAttempt += 1;
  const delayMs = offline ? TIKTOK_OFFLINE_RETRY_MS : tiktokBackoffMs(tiktokAttempt);
  console.log(`[TIKTOK_RECONNECT] attempt=${tiktokAttempt} delayMs=${delayMs} reason=${reason}`);
  tiktokReconnectTimer = setTimeout(() => {
    tiktokReconnectTimer = null;
    connectTikTok();
  }, delayMs);
}

// Gerbang penerimaan chat: menolak pesan sendiri, pesan kembar, dan backlog yang
// diantar ulang konektor saat connect. Lihat tiktok/chat-gate.js untuk bukti
// insiden yang melahirkannya.
let chatGate = createChatGate({ selfIdentities: [tiktokUsername] });

// Didaftarkan SEKALI per instance koneksi.
function attachTikTokListeners(conn) {
  conn.on("chat", (data) => {
    const user = data?.nickname ?? data?.user?.nickname ?? data?.uniqueId ?? "anon";
    console.log(`[TIKTOK_CHAT] user=${user} comment="${data?.comment ?? ""}"`);
    // Gerbang ini FAIL-CLOSED. Kalau ia melempar, pesan DIBUANG dan tidak pernah
    // sampai ke handleChat(). Arah kegagalannya disengaja, dan alasannya langsung
    // dari insiden Phase 21: satu chat yang lolos tanpa tersaring bisa berujung
    // pada klik Pin nyata plus pesan nyata ke penonton, dan keduanya tidak bisa
    // ditarik kembali. Kehilangan satu trigger hanya berarti penonton mengulang
    // komentarnya.
    //
    // Verdict yang bukan { ok: true } persis juga dibuang: gerbang yang
    // mengembalikan bentuk tak terduga diperlakukan sebagai gerbang yang rusak,
    // bukan sebagai izin lewat.
    let verdict;
    try {
      verdict = chatGate.accept(data);
    } catch (err) {
      console.warn(`[TIKTOK_CHAT_GATE_ERROR] msg="${String(err && err.message).slice(0, 80)}" action=drop`);
      return;
    }
    if (!verdict || verdict.ok !== true) return;
    handleChat(data); // jalur produksi yang sudah ada: matching -> queue -> OBS
  });

  // Tanpa listener ini handleError() di konektor no-op, sehingga error hilang tanpa jejak.
  conn.on("error", (e) => {
    const msg = e?.exception?.message ?? e?.message ?? String(e ?? "");
    console.error(`[TIKTOK_ERROR] info="${e?.info ?? ""}" msg="${msg}"`);
  });

  conn.on("disconnected", (d) => {
    console.warn(`[TIKTOK_DISCONNECTED] code=${d?.code ?? "?"} reason="${d?.reason ?? ""}"`);
    chatGate.markDisconnected(); // backlog akan diantar ulang saat reconnect
    scheduleTikTokReconnect("disconnected");
  });
}

async function connectTikTok() {
  if (tiktokStopped || tiktokConnecting) return;
  const reconnecting = tiktokAttempt > 0;
  tiktokConnecting = true;
  console.log(`[TIKTOK_CONNECTING] user=@${tiktokUsername}${reconnecting ? ` attempt=${tiktokAttempt}` : ""}`);
  try {
    const state = await tiktokConn.connect();
    tiktokConnecting = false;
    const roomId = tiktokConn?.roomId || state?.roomId || "(tidak terekspos)";
    // Satu baris per peristiwa: RECONNECTED kalau ini pemulihan, CONNECTED kalau koneksi pertama.
    console.log(`[TIKTOK_${reconnecting ? "RECONNECTED" : "CONNECTED"}] roomId=${roomId}`);
    // Baru DI SINI chat dianggap live. Apa pun yang tiba sebelum titik ini adalah
    // riwayat yang diantar konektor, dan sudah dicatat supaya antaran ulangnya tertolak.
    chatGate.markConnected();
    tiktokAttempt = 0; // reset hitungan setelah sukses
    return state;
  } catch (err) {
    tiktokConnecting = false;
    const offline = isUserOfflineError(err);
    console.error(`[TIKTOK_ERROR] connect gagal: ${offline ? "LIVE sedang offline" : (err?.message ?? err)}`);
    scheduleTikTokReconnect(offline ? "user-offline" : "connect-failed", offline);
  }
}

// createConnection hanya di-inject oleh test; produksi memakai WebcastPushConnection.
function startTikTok({ createConnection } = {}) {
  tiktokStopped = false;
  tiktokAttempt = 0;
  if (!tiktokConn) {
    tiktokConn = (createConnection || (() => new WebcastPushConnection(tiktokUsername)))();
    attachTikTokListeners(tiktokConn);
  }
  return connectTikTok();
}

function stopTikTok() {
  tiktokStopped = true;
  if (tiktokReconnectTimer) {
    clearTimeout(tiktokReconnectTimer);
    tiktokReconnectTimer = null;
  }
}

// Satu-satunya tempat baris [AUTOCOMMENT_CONFIG] dibentuk, supaya nilainya tidak
// bisa lagi menyimpang dari konfigurasi yang benar-benar dipakai.
function autocommentConfigLine(
  cfg = autocommentConfig,
  enabled = AUTOCOMMENT_ENABLED,
  transport = AUTOCOMMENT_TRANSPORT
) {
  return `[AUTOCOMMENT_CONFIG] enabled=${enabled} maxPerMinute=${cfg.maxPerMinute} minIntervalMs=${cfg.minIntervalMs} timeoutMs=${cfg.timeoutMs} transport=${transport}`;
}

// =================== STARTUP (live only) ===================
// Koneksi TikTok/OBS + stdin hanya jalan kalau file ini dieksekusi langsung
// (`node index.js`). Saat di-require oleh test, tidak ada koneksi nyata.
function startLive() {
  // Lebih dulu dari apa pun: kalau ada bot lain yang masih hidup, proses ini
  // tidak boleh ikut menyentuh OBS, TikTok, maupun service AutoPIN. Insiden
  // Phase 21 terjadi justru karena tiga bot berjalan bersamaan.
  const lock = createInstanceLock({ script: "index.js" });
  const locked = lock.acquire();
  if (!locked.ok) {
    console.error("❌ Bot lain masih berjalan. Proses ini berhenti supaya tidak ada aksi ganda ke akun TikTok.");
    process.exit(1);
  }

  console.log(`[BOT_SESSION] id=${BOT_SESSION_ID} note="restart bot aman: service mereset generasi playId untuk sesi baru"`);
  console.log(autocommentConfigLine());
  startTikTok();

  connectOBS();

  console.log("ℹ CMD control aktif. Ketik 'help' untuk perintah: next, force, force all, status, cooldown <ms>, skip <SCENE>, promote <SCENE>, help.");
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", handleCommand);

  // Timer reconnect harus mati bersih saat proses berakhir.
  const shutdown = () => {
    stopTikTok();
    lock.release();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("exit", () => {
    stopTikTok();
    lock.release();
  });
}

if (require.main === module) {
  startLive();
}

// Ekspor minimal untuk test (logika antrean yang sama dengan produksi).
module.exports = {
  SCENES,
  RULES,
  activeRules,
  containsPhrase,
  SCENE_REPLAY_COOLDOWN_MS,
  obs,
  handleChat,
  handleCommand,
  startTikTok,
  stopTikTok,
  enqueueTrigger,
  processQueue,
  endCurrentScene,
  __tiktok: {
    getState: () => ({
      attempt: tiktokAttempt,
      hasReconnectTimer: !!tiktokReconnectTimer,
      connecting: tiktokConnecting,
      stopped: tiktokStopped,
      chatListeners: tiktokConn ? tiktokConn.listenerCount("chat") : 0,
    }),
    backoffMs: tiktokBackoffMs,
    conn: () => tiktokConn,
    reset: () => {
      stopTikTok();
      if (tiktokConn && typeof tiktokConn.removeAllListeners === "function") tiktokConn.removeAllListeners();
      tiktokConn = null;
      tiktokAttempt = 0;
      tiktokConnecting = false;
      tiktokStopped = false;
      chatGate = createChatGate({ selfIdentities: [tiktokUsername] });
    },
  },
  __test: {
    getState: () => ({
      busy,
      activeScene,
      lastScene,
      queue: sceneAggregates.map(a => ({ scene: a.scene, count: a.count })),
      playedScenes: Array.from(playedScenes),
      cooldownScenes: Array.from(sceneCooldownUntil.keys()),
      hasGlobalPauseTimer: !!globalPauseTimer,
      activePlayId,
      waitingMedia: Array.from(waitingMediaSet),
      hasFallbackTimer: !!timer,
      hasDurationTimer: !!sceneDurationTimer,
    }),
    // ganti dispatcher AutoPIN dengan palsu (tes integrasi tanpa browser)
    setScenePin: fake => { scenePin = fake; },
    // ganti dispatcher AutoComment dengan palsu (tes integrasi tanpa transport)
    setAutoComment: fake => { autoComment = fake; },
    autocommentEnabled: () => AUTOCOMMENT_ENABLED,
    autocommentTransport: () => AUTOCOMMENT_TRANSPORT,
    autocommentConfigLine,
    botSessionId: () => BOT_SESSION_ID,
    // ganti gerbang chat dengan palsu, atau baca hitungan penolakannya
    setChatGate: fake => { chatGate = fake; },
    chatGateState: () => chatGate.__state(),
    autocommentRealState: () => realAutoCommentState(),
    autopinMap: () => ({ ...autopinMap }),
    autopinEnabled: () => AUTOPIN_ENABLED,
    // sisipkan entry mentah ke antrean (untuk uji fail-safe entry tidak valid)
    injectAggregate: agg => sceneAggregates.push(agg),
    reset: () => {
      clearAllSceneTimers();
      sceneAggregates.length = 0;
      playedScenes.clear();
      sceneCooldownUntil.clear();
      waitingMediaSet.clear();
      perUserMap.clear();
      userLastMessages.clear();
      isMutedUntil.clear();
      waitingRule = null;
      activeScene = null;
      activePlayId = 0;
      lastScene = null;
      busy = false;
    },
  },
};
