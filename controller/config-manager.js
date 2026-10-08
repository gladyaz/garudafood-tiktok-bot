"use strict";
// Konfigurasi customer dalam SATU berkas JSON yang berversi.
//
// Kenapa pindah dari .env: .env adalah berkas untuk pengembang. Ia tidak punya
// versi, tidak bisa divalidasi sebelum dipakai, dan kesalahan ketik di dalamnya
// baru terasa saat LIVE sudah jalan — mis. AUTOPIN_PRODUCT_PAX_3 yang salah
// ketik tidak error, ia hanya membuat scene itu tidak pernah dipin, diam-diam.
// Customer tidak boleh pernah membuka .env.
//
// .env TETAP ada dan TETAP dibaca oleh core: ia sekarang hanya untuk default
// internal, rahasia pengembang, dan kompatibilitas development. Config JSON
// inilah yang menang untuk nilai yang diurus customer.
//
// Catatan penting soal cakupan (lihat juga toEnv di bawah): field `triggers` dan
// `reply` DISIMPAN dan DIVALIDASI di sini, tetapi belum diterapkan ke core.
// Kata kunci trigger masih hidup di array RULES di index.js, dan teks balasan
// masih satu template tetap di autocomment/formatter.js yang tidak pernah
// dioper dari index.js. Menerapkannya = mengubah core, dan core sedang frozen.

const fsDefault = require("node:fs");
// autopin/config.js MURNI (satu-satunya require di dalamnya adalah node:path),
// jadi memuatnya di proses Controller tidak menyeret Puppeteer ke mana pun.
const { loadConfig: autopinConfig } = require("../autopin/config");
// Hanya untuk nama variabelnya; modulnya ringan (fs + path). Namanya diIMPOR,
// bukan ditulis ulang, supaya pengisi dan pembacanya tidak bisa menyimpang —
// pola yang sama dengan RUNTIME_CONFIG_ENV di controller/index.js.
const { LOCK_FILE_ENV } = require("../runtime/single-instance");

const CONFIG_VERSION = 1;

// Scene idle, bukan etalase: tidak pernah boleh punya produk. Nilainya sengaja
// dicocokkan dengan autopin/scene-map.js NEVER_MAPPED, tanpa meng-import-nya,
// supaya config bisa divalidasi tanpa menyentuh modul core sama sekali.
const NEVER_MAPPED_SCENES = Object.freeze(["MAIN"]);

// Batas panjang balasan mengikuti indikator "0/100" di UI LIVE Manager, dihitung
// dalam satuan UTF-16 seperti penghitung TikTok (lihat autocomment/formatter.js).
const MAX_REPLY_LENGTH = 100;

const TRANSPORTS = Object.freeze(["dry-run", "browser"]);

function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    tiktok: { username: "" },
    obs: { host: "127.0.0.1", port: 4455, password: "" },
    settings: {
      autopinEnabled: false,
      autopinPort: 5055,
      autopinTimeoutMs: 15000,
      autoCommentEnabled: false,
      // Default aman. Nilai di berkas ini SAJA tidak pernah cukup untuk mengirim
      // chat sungguhan: service juga harus dijalankan dengan
      // --enable-autocomment-send. Dua lapis, sama seperti sebelumnya.
      autoCommentTransport: "dry-run",
      autoCommentMaxPerMinute: 6,
      autoCommentMinIntervalMs: 5000,
      autoCommentTimeoutMs: 8000,
      sceneReplayCooldownMs: 120000,
      expectedShop: "",
      forbiddenShops: ["garudafood"],
      consoleUrl: "https://shop.tiktok.com/streamer/live/product/dashboard",
      profileDir: ".autopin-profile",
      debugDir: ".autopin-debug",
      chromePath: "",
    },
    mappings: [],
  };
}

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim() !== "";
}

function isPort(v) {
  return Number.isInteger(v) && v >= 1 && v <= 65535;
}

function isNonNegativeInt(v) {
  return Number.isInteger(v) && v >= 0;
}

function isPositiveInt(v) {
  return Number.isInteger(v) && v > 0;
}

// ---------------------------------------------------------------------------
// Validasi
// ---------------------------------------------------------------------------

// Mengembalikan { ok, errors: [{ path, code }] }. Kode-nya mesin-ramah; kalimat
// untuk customer dibentuk di controller/errors.js, bukan di sini.
function validateConfig(raw) {
  const errors = [];
  const add = (where, code) => errors.push({ path: where, code });

  if (!isPlainObject(raw)) {
    return { ok: false, errors: [{ path: "", code: "not-an-object" }] };
  }

  // Versi diperiksa PALING DULU: config dari versi yang tidak dikenal tidak boleh
  // divalidasi dengan aturan versi ini, karena artinya bisa berbeda.
  if (raw.version !== CONFIG_VERSION) {
    const code = raw.version === undefined ? "version-missing" : "version-unsupported";
    return { ok: false, errors: [{ path: "version", code }] };
  }

  // --- tiktok ---
  if (!isPlainObject(raw.tiktok)) {
    add("tiktok", "must-be-object");
  } else if (typeof raw.tiktok.username !== "string") {
    add("tiktok.username", "must-be-string");
  }

  // --- obs ---
  if (!isPlainObject(raw.obs)) {
    add("obs", "must-be-object");
  } else {
    if (!isNonEmptyString(raw.obs.host)) add("obs.host", "must-be-non-empty-string");
    if (!isPort(raw.obs.port)) add("obs.port", "must-be-port");
    if (typeof raw.obs.password !== "string") add("obs.password", "must-be-string");
  }

  // --- settings ---
  const s = raw.settings;
  if (!isPlainObject(s)) {
    add("settings", "must-be-object");
  } else {
    if (typeof s.autopinEnabled !== "boolean") add("settings.autopinEnabled", "must-be-boolean");
    if (!isPort(s.autopinPort)) add("settings.autopinPort", "must-be-port");
    if (!isPositiveInt(s.autopinTimeoutMs)) add("settings.autopinTimeoutMs", "must-be-positive-int");
    if (typeof s.autoCommentEnabled !== "boolean") add("settings.autoCommentEnabled", "must-be-boolean");
    if (!TRANSPORTS.includes(s.autoCommentTransport)) {
      add("settings.autoCommentTransport", "must-be-known-transport");
    }
    if (!isNonNegativeInt(s.autoCommentMaxPerMinute)) {
      add("settings.autoCommentMaxPerMinute", "must-be-non-negative-int");
    }
    if (!isNonNegativeInt(s.autoCommentMinIntervalMs)) {
      add("settings.autoCommentMinIntervalMs", "must-be-non-negative-int");
    }
    if (!isPositiveInt(s.autoCommentTimeoutMs)) add("settings.autoCommentTimeoutMs", "must-be-positive-int");
    if (!isNonNegativeInt(s.sceneReplayCooldownMs)) add("settings.sceneReplayCooldownMs", "must-be-non-negative-int");
    if (typeof s.expectedShop !== "string") add("settings.expectedShop", "must-be-string");
    if (!Array.isArray(s.forbiddenShops) || s.forbiddenShops.some((x) => !isNonEmptyString(x))) {
      add("settings.forbiddenShops", "must-be-string-array");
    }
    if (!isNonEmptyString(s.consoleUrl)) add("settings.consoleUrl", "must-be-non-empty-string");
    if (!isNonEmptyString(s.profileDir)) add("settings.profileDir", "must-be-non-empty-string");
    if (!isNonEmptyString(s.debugDir)) add("settings.debugDir", "must-be-non-empty-string");
    if (typeof s.chromePath !== "string") add("settings.chromePath", "must-be-string");

    // Port bentrok ditolak di sini, bukan dibiarkan muncul sebagai EADDRINUSE saat
    // start. AutoPIN service mengikat port-nya; kalau nilainya sama dengan OBS,
    // salah satunya pasti gagal dan sebabnya tidak akan jelas bagi customer.
    if (isPort(s.autopinPort) && isPlainObject(raw.obs) && isPort(raw.obs.port) && s.autopinPort === raw.obs.port) {
      add("settings.autopinPort", "port-conflicts-with-obs");
    }
  }

  // --- mappings ---
  if (!Array.isArray(raw.mappings)) {
    add("mappings", "must-be-array");
  } else {
    const seen = new Set();
    raw.mappings.forEach((m, i) => {
      const at = "mappings[" + i + "]";
      if (!isPlainObject(m)) {
        add(at, "must-be-object");
        return;
      }

      if (!isNonEmptyString(m.scene)) {
        add(at + ".scene", "must-be-non-empty-string");
      } else {
        const scene = m.scene.trim();
        if (NEVER_MAPPED_SCENES.includes(scene)) add(at + ".scene", "scene-never-mappable");
        // Satu scene = satu produk. Dua baris untuk scene yang sama berarti satu
        // di antaranya pasti diabaikan tanpa jejak, dan customer tidak akan tahu
        // yang mana. Ditolak, bukan dipilih diam-diam.
        if (seen.has(scene)) add(at + ".scene", "duplicate-scene");
        else seen.add(scene);
      }

      // Produk: ada tiga keadaan, dan dua di antaranya sah.
      //
      //   { title: "..." }  scene ini memin produk itu
      //   null              scene ini SENGAJA tidak memin apa pun — scene yang
      //                     punya trigger tapi bukan etalase, mis. scene FAQ.
      //                     Ini yang membuat config bisa menyatakan semua yang
      //                     dulu dinyatakan array RULES; tanpa ini, menyalakan
      //                     mode config akan mematikan scene FAQ tanpa ada cara
      //                     untuk menghidupkannya kembali.
      //   { title: "" }     DITOLAK. Ini field yang lupa diisi, bukan keputusan.
      //
      // Bedanya null dan judul kosong disengaja: yang satu pernyataan, yang satu
      // kelalaian, dan keduanya tidak boleh diperlakukan sama.
      if (m.product === null) {
        /* sengaja tanpa produk: sah */
      } else if (m.product === undefined) {
        add(at + ".product", "product-missing");
      } else if (!isPlainObject(m.product)) {
        add(at + ".product", "must-be-object");
      } else if (!isNonEmptyString(m.product.title)) {
        add(at + ".product.title", "must-be-non-empty-string");
      }

      // triggers boleh kosong (belum terhubung ke core), tapi kalau ada isinya
      // setiap entri harus benar-benar sebuah kata kunci.
      if (m.triggers !== undefined) {
        if (!Array.isArray(m.triggers)) {
          add(at + ".triggers", "must-be-array");
        } else {
          const t = new Set();
          m.triggers.forEach((trig, j) => {
            const where = at + ".triggers[" + j + "]";
            if (!isNonEmptyString(trig)) {
              add(where, "must-be-non-empty-string");
              return;
            }
            const key = trig.trim().toLowerCase();
            if (t.has(key)) add(where, "duplicate-trigger");
            else t.add(key);
          });
        }
      }

      if (m.reply !== undefined) {
        const where = at + ".reply";
        if (typeof m.reply !== "string") add(where, "must-be-string");
        else if (m.reply.trim() === "") add(where, "must-not-be-empty");
        else if (m.reply.length > MAX_REPLY_LENGTH) add(where, "reply-too-long");
        else if (/[<>]/.test(m.reply)) add(where, "html-not-allowed");
        else if (/[\x00-\x1f\x7f]/.test(m.reply)) add(where, "control-chars");
      }
    });
  }

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Baca / tulis
// ---------------------------------------------------------------------------

function createConfigManager({ file, fs = fsDefault } = {}) {
  if (!file) throw new Error("config-manager: `file` wajib diisi");
  const target = file;
  // Berkas sementara untuk tulis atomik. Diletakkan di direktori yang SAMA:
  // rename hanya atomik di dalam satu volume.
  const tmp = target + ".tmp";

  function loadConfig() {
    let raw;
    try {
      raw = fs.readFileSync(target, "utf8");
    } catch (err) {
      const code = err && err.code === "ENOENT" ? "config-missing" : "config-unreadable";
      return { ok: false, code, errors: [{ path: "", code }] };
    }

    let parsed;
    try {
      // BOM dibuang lebih dulu: berkas yang pernah disunting tangan di Windows
      // (Notepad, Out-File) hampir selalu berawalan BOM dan JSON.parse menolaknya.
      // Pelajaran yang sama dengan runtime/single-instance.js.
      parsed = JSON.parse(raw.replace(/^﻿/, ""));
    } catch {
      return { ok: false, code: "config-invalid-json", errors: [{ path: "", code: "config-invalid-json" }] };
    }

    const verdict = validateConfig(parsed);
    if (!verdict.ok) return { ok: false, code: "config-invalid", errors: verdict.errors };

    return { ok: true, config: parsed };
  }

  // Validasi dulu, tulis kemudian. Config valid yang terakhir TIDAK PERNAH
  // tergantikan oleh yang tidak valid: kalau validasi gagal, berkasnya tidak
  // pernah disentuh sama sekali.
  function saveConfig(next) {
    const verdict = validateConfig(next);
    if (!verdict.ok) return { ok: false, code: "config-invalid", errors: verdict.errors };

    const text = JSON.stringify(next, null, 2) + "\n";
    try {
      // Tulis ke berkas sementara, lalu rename. Rename adalah satu operasi: tidak
      // ada jendela di mana config.json ada tapi separuh tertulis — yang akan
      // terjadi kalau Controller mati di tengah penulisan langsung.
      fs.writeFileSync(tmp, text, "utf8");
      fs.renameSync(tmp, target);
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* sisa berkas sementara bukan alasan menutupi error aslinya */
      }
      return { ok: false, code: "config-write-failed", errors: [{ path: "", code: "config-write-failed" }] };
    }
    return { ok: true, config: next };
  }

  return { loadConfig, saveConfig, validateConfig, file: target, __tmp: tmp };
}

// ---------------------------------------------------------------------------
// Adapter ke environment yang dipahami core
// ---------------------------------------------------------------------------

// Menerjemahkan config JSON ke environment yang core SUDAH mengerti hari ini.
// Tidak ada satu pun nama variabel baru di sini: semuanya sudah dibaca oleh
// index.js / autopin/*.js / autocomment/*.js sebelum Controller ada.
//
// Yang SENGAJA tidak diterjemahkan, karena core belum punya tempat untuknya:
//   - mappings[].triggers -> kata kunci masih di array RULES di index.js
//   - mappings[].reply    -> teks masih DEFAULT_TEMPLATE di autocomment/formatter.js
// Keduanya butuh perubahan core, dan core sedang frozen. Dilaporkan lewat
// unmappedFields() supaya tidak ada yang mengira keduanya sudah berlaku.
// Path yang DIBERITAHUKAN aplikasi desktop menang atas nilai di config.
//
// ---------------------------------------------------------------------------
// KENAPA MENANG, DAN BUKAN SEKADAR MENJADI DEFAULT
//
// Tiga nilai di config adalah path relatif: profileDir, debugDir, dan (lewat
// ketiadaannya) chromePath. Nilai relatif diresolusi autopin/config.js terhadap
// AKAR MODUL ITU SENDIRI — yang di aplikasi terpaket adalah resources/app, yaitu
// direktori instalasi.
//
// Jadi kalau config yang menang:
//   - profil browser (dengan SESI TIKTOK customer) ditulis ke direktori
//     instalasi, lalu terhapus saat uninstall
//   - chromePath kosong berarti Puppeteer mencari browser di cache yang tidak
//     ada di mesin customer
//
// Keduanya tidak muncul sebagai error. Yang pertama muncul sebagai "aplikasinya
// lupa login saya setiap update", yang kedua sebagai LOGIN TIKTOK yang tidak
// melakukan apa pun.
//
// Di jalur manual (`node controller/index.js`) tidak ada yang memberitahukan
// apa pun, `paths` kosong, dan config tetap menang — perilaku sebelum P5.
function pick(fromPaths, fromConfig) {
  return typeof fromPaths === "string" && fromPaths !== "" ? fromPaths : fromConfig;
}

function toEnv(config, { base = {}, paths = null } = {}) {
  const s = config.settings;
  const p = paths || {};
  const env = Object.assign({}, base, {
    TIKTOK_USERNAME: String(config.tiktok.username || ""),
    OBS_HOST: String(config.obs.host),
    OBS_PORT: String(config.obs.port),
    OBS_PASSWORD: String(config.obs.password || ""),
    SCENE_REPLAY_COOLDOWN_MS: String(s.sceneReplayCooldownMs),

    AUTOPIN_ENABLED: s.autopinEnabled ? "true" : "false",
    AUTOPIN_PORT: String(s.autopinPort),
    AUTOPIN_TIMEOUT_MS: String(s.autopinTimeoutMs),
    AUTOPIN_CONSOLE_URL: String(s.consoleUrl),
    AUTOPIN_PROFILE_DIR: String(pick(p.profileDir, s.profileDir)),
    AUTOPIN_DEBUG_DIR: String(pick(p.debugDir, s.debugDir)),
    AUTOPIN_EXPECTED_SHOP: String(s.expectedShop || ""),
    AUTOPIN_FORBIDDEN_SHOPS: s.forbiddenShops.join(","),
    AUTOPIN_CHROME_PATH: String(pick(p.browserPath, s.chromePath || "")),

    AUTOCOMMENT_ENABLED: s.autoCommentEnabled ? "true" : "false",
    AUTOCOMMENT_TRANSPORT: String(s.autoCommentTransport),
    AUTOCOMMENT_MAX_PER_MINUTE: String(s.autoCommentMaxPerMinute),
    AUTOCOMMENT_MIN_INTERVAL_MS: String(s.autoCommentMinIntervalMs),
    AUTOCOMMENT_TIMEOUT_MS: String(s.autoCommentTimeoutMs),
  });

  // Pemetaan scene/produk/trigger/balasan TIDAK ikut lewat environment sejak P2.
  //
  // Di P1 ia dikirim sebagai AUTOPIN_PRODUCT_PAX_1..10, satu variabel per scene.
  // Sekarang keempatnya berjalan lewat artefak config runtime
  // (runtime/runtime-config.js), dan AUTOPIN_PRODUCT_* sengaja TIDAK dibentuk di
  // sini lagi: dua sumber untuk hal yang sama berarti suatu saat keduanya akan
  // berbeda, dan yang menang akan ditentukan oleh urutan pembacaan — bukan oleh
  // keputusan siapa pun.
  //
  // Jalur legacy tidak terpengaruh: `node index.js` tanpa Controller tetap
  // membaca AUTOPIN_PRODUCT_* dari .env lewat autopin/scene-map.js, persis
  // seperti sebelumnya.

  // Letak kunci satu-instance bot, HANYA kalau desktop memberitahukannya.
  //
  // Tanpa ini, bot terpaket akan menulis .bot.lock ke cwd-nya — direktori
  // instalasi — dan kegagalan menulis di sana diperlakukan createInstanceLock
  // sebagai mode "unlocked": perlindungan bot kedua mati DIAM-DIAM. Itu persis
  // perlindungan yang dibuat sesudah insiden LIVE 2026-10-05, dan ia tidak boleh
  // hilang karena sebuah direktori yang tidak bisa ditulis.
  //
  // Variabelnya TIDAK pernah disetel di jalur manual, jadi `node index.js` tetap
  // memakai .bot.lock di cwd seperti sebelumnya.
  if (typeof p.lockFile === "string" && p.lockFile !== "") env[LOCK_FILE_ENV] = p.lockFile;

  return env;
}

// Config customer -> bentuk config yang dipahami autopin/browser.js dan
// autopin/products.js (profileDir yang sudah diresolusi, consoleUrl, chromePath,
// batas waktu navigasi, dan seterusnya).
//
// DIKOMPOSISIKAN dari dua pemeta yang sudah ada, bukan ditulis ulang:
//
//   toEnv(config)            customer config -> environment
//   autopinConfig(env)       environment     -> config autopin
//
// Kenapa penting: percobaan pertama di P2 meneruskan config CUSTOMER langsung ke
// launchBrowser(). Bentuknya berbeda — launchBrowser membaca config.profileDir
// sementara customer config menyimpannya di config.settings.profileDir — jadi
// profileDir-nya undefined dan ensurePrivateDir() langsung melempar. Tesnya tidak
// menangkap itu karena fake-nya mengabaikan argumennya.
//
// Dengan dikomposisikan, satu-satunya sumber bentuk tetap autopin/config.js. Kalau
// ia menambah field, jalur ini ikut mendapatkannya tanpa ada yang perlu ingat.
function toAutopinConfig(config, { base = {}, paths = null } = {}) {
  return autopinConfig(toEnv(config, { base, paths }));
}

// Field yang tersimpan di config tapi belum sampai ke core.
//
// Di P1 daftar ini berisi mappings[].triggers dan mappings[].reply. Sejak P2
// keduanya BENAR-BENAR berlaku: trigger menjadi keyword rule lewat
// runtime/mappings.js, dan reply menjadi pembentuk teks AutoComment lewat opsi
// `format` di createAutoComment. Jadi daftarnya sekarang kosong.
//
// Fungsinya dipertahankan, bukan dihapus: bentuk /api/status tidak berubah untuk
// pembacanya, dan kalau suatu saat ada field baru yang tersimpan tapi belum
// terhubung, di sinilah tempatnya dilaporkan — bukan di komentar yang tidak
// pernah dibaca siapa pun.
function unmappedFields() {
  return [];
}

// Bentuk config yang boleh keluar lewat HTTP. Password OBS TIDAK PERNAH ikut:
// ia rahasia, dan /api/config dibaca oleh UI yang nanti bisa tampil di layar
// yang sedang di-share saat LIVE. Yang dikirim hanya "sudah diisi atau belum".
function redactConfig(config) {
  const copy = JSON.parse(JSON.stringify(config));
  const had = typeof config.obs.password === "string" && config.obs.password !== "";
  delete copy.obs.password;
  copy.obs.passwordSet = had;
  return copy;
}

// Password yang tidak dikirim oleh klien berarti "jangan diubah", bukan
// "kosongkan". Tanpa ini, setiap penyimpanan dari UI yang memakai hasil
// redactConfig() akan menghapus password OBS tanpa ada yang meminta.
function mergeSecrets(incoming, previous) {
  const next = JSON.parse(JSON.stringify(incoming));
  if (isPlainObject(next.obs)) {
    delete next.obs.passwordSet;
    if (typeof next.obs.password !== "string") {
      const prevOk = isPlainObject(previous) && isPlainObject(previous.obs) && typeof previous.obs.password === "string";
      next.obs.password = prevOk ? previous.obs.password : "";
    }
  }
  return next;
}

module.exports = {
  createConfigManager,
  validateConfig,
  defaultConfig,
  toEnv,
  toAutopinConfig,
  unmappedFields,
  redactConfig,
  mergeSecrets,
  CONFIG_VERSION,
  MAX_REPLY_LENGTH,
  NEVER_MAPPED_SCENES,
  TRANSPORTS,
};
