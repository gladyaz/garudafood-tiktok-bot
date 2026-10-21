"use strict";
// Dispatcher AutoComment: "scene X baru saja benar-benar mulai" -> paling banyak
// SATU pesan admin terencana untuk scene itu.
//
// AUXILIARY, dengan jaminan yang sama seperti AutoPIN (autopin/scene-pin.js):
//   - tidak pernah melempar ke pemanggil, sinkron maupun asinkron
//   - tidak menyentuh busy / activeScene / cooldown / timer / antrean
//   - batas waktu sendiri; transport yang menggantung tidak menahan playback
//   - hasil yang datang setelah scene berganti dibuang (stale), bukan dipakai
//
// AR1: transport-nya HANYA dry-run. Modul ini tidak tahu browser, HTTP, maupun
// TikTok, dan tidak boleh diberi transport sungguhan sebelum AR2 dibuktikan.

const { formatSceneMessage, validateText } = require("./formatter");

const DEFAULT_TIMEOUT_MS = 8_000;
// Batas internal yang konservatif. BUKAN limit resmi TikTok - angka resminya
// tidak diketahui. Keduanya bisa diatur lewat env, lihat .env.example.
const DEFAULT_MAX_PER_MINUTE = 6;
const DEFAULT_MIN_INTERVAL_MS = 5_000;
// Jeda minimum untuk balasan PRIORITAS TINGGI, yaitu balasan yang mengumumkan
// produk yang TERBUKTI ter-pin. Lebih pendek daripada jeda normal, dan diukur
// terhadap jamnya SENDIRI - lihat dua jam di bawah.
//
// ---------------------------------------------------------------------------
// KENAPA ANGKA INI TIDAK PUNYA KNOB ENVIRONMENT
//
// Berbeda dari AUTOCOMMENT_MAX_PER_MINUTE dan AUTOCOMMENT_MIN_INTERVAL_MS,
// nilai ini SENGAJA tidak bisa diatur lewat environment maupun config customer.
// Bukan karena kurang penting, tapi karena knob seperti itu TIDAK AKAN BEKERJA
// di aplikasi terpaket, dan knob yang tidak bekerja lebih buruk daripada tidak
// ada knob: operator mengubahnya, tidak ada yang berubah, dan tidak ada pesan
// apa pun yang menjelaskan kenapa.
//
// Sudah diperiksa, bukan diduga:
//   1. controller/process-manager.js membentuk environment anak PENUH dan tidak
//      mewarisi environment Controller. Daftar base-nya di controller.js hanya
//      PATH, SystemRoot, dan (kalau diset) AILIVE_BROWSER_HEADLESS.
//   2. Hanya lima variabel AUTOCOMMENT_* yang benar-benar diteruskan toEnv():
//      ENABLED, TRANSPORT, MAX_PER_MINUTE, MIN_INTERVAL_MS, TIMEOUT_MS.
//      Daftarnya dipaku di test/controller.config.test.js.
//   3. .env tidak ikut dipaket (package.json build.files: "!**/.env*"), jadi
//      dotenv di bot terpaket tidak menemukan apa pun.
//
// Jadi: satu bawaan deterministik di sini. Parameternya tetap bisa disuntikkan
// ke createAutoComment() untuk tes dan pemanggil internal. Kalau nanti ada
// bukti dari LIVE bahwa 1,5 detik perlu digeser, yang benar adalah menambahkan
// jalur propagasi yang SUNGGUHAN (toEnv + config) bersamaan - bukan knob yang
// menggantung.
const DEFAULT_HIGH_MIN_INTERVAL_MS = 1_500;
const RATE_WINDOW_MS = 60_000;
// Berapa playId terakhir yang diingat untuk dedupe. Cukup kecil untuk memori,
// cukup besar untuk satu sesi LIVE (ratusan scene).
const DEDUPE_MEMORY = 1_000;

const NEVER_COMMENTED = new Set(["MAIN"]);
const TIMED_OUT = Symbol("autocomment-timeout");

// Transport dry-run: satu-satunya transport yang ada di AR1. Tidak mengirim ke
// mana pun; cuma membalas "ok, dry-run".
function createDryRunTransport() {
  return async function send({ text, scene, playId }) {
    return { ok: true, dryRun: true, text, scene, playId };
  };
}

// Pesan error saja, tidak pernah objek mentah.
function brief(err) {
  const msg = err && err.message ? String(err.message) : String(err);
  return msg.slice(0, 120).replace(/\s+/g, " ");
}

// Seberapa keras bukti pin dituntut sebelum sebuah komentar boleh dikirim:
//   "ignore"    - tidak diperiksa (dipakai unit test logika lain)
//   "ok"        - AutoPIN harus ok (dipakai saat transport dry-run)
//   "confirmed" - produk harus TERBUKTI ter-pin (wajib saat transport browser)
// Kalimat "sudah aku pin" adalah klaim ke penonton; "confirmed" yang menjaganya
// tidak pernah terucap tanpa bukti.
const PIN_POLICY = Object.freeze({ IGNORE: "ignore", OK: "ok", CONFIRMED: "confirmed" });

// Prioritas penjadwalan satu permintaan. HANYA metadata runtime: ia tidak ada di
// config customer, tidak ada di skema aksi aturan, dan tidak pernah tersimpan.
//
//   high    balasan yang mengumumkan produk yang sudah TERBUKTI ter-pin
//   normal  balasan FAQ/umum yang tidak menjanjikan pin apa pun
//
// Dua tingkat, dan tidak akan ditambah. Tingkat ketiga berarti kebijakan yang
// harus diputuskan di tempat lain, dan tempat itu belum ada.
const PRIORITY = Object.freeze({ HIGH: "high", NORMAL: "normal" });

function createAutoComment({
  enabled = false,
  pinPolicy = PIN_POLICY.IGNORE,
  inspectPin = () => ({ confirmed: false, reason: "no-pin-inspector" }),
  send,
  format = formatSceneMessage,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxPerMinute = DEFAULT_MAX_PER_MINUTE,
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
  highMinIntervalMs = DEFAULT_HIGH_MIN_INTERVAL_MS,
  logger = console,
  now = () => performance.now(), // monotonik: jam dinding yang mundur tidak boleh memblokir kiriman
} = {}) {
  let latestPlayId = 0;
  const handledPlayIds = new Set(); // playId yang sudah diputuskan: dedupe scene-start
  const sentAt = [];                // waktu kirim dalam jendela 60 detik: rate limit
                                    // SATU jendela untuk kedua prioritas: plafon
                                    // per menit tidak boleh bisa dilampaui oleh
                                    // prioritas apa pun.

  // ---------------------------------------------------------------------------
  // DUA JAM, DAN ASIMETRINYA DISENGAJA
  //
  // lastAnySentAt   diperbarui oleh SETIAP kiriman. Jam ini yang dipakai
  //                 balasan normal, dengan minIntervalMs (5 detik).
  // lastHighSentAt  diperbarui HANYA oleh kiriman prioritas tinggi. Jam ini
  //                 yang dipakai balasan prioritas tinggi, dengan
  //                 highMinIntervalMs (1,5 detik).
  //
  // Akibat asimetrinya, dan inilah yang diminta:
  //
  //   normal t=0, high t=0.5   -> high BOLEH kirim. Balasan FAQ tidak boleh
  //                               membungkam pengumuman produk yang sudah
  //                               terbukti ter-pin hanya karena ia lebih dulu
  //                               memakai slot lima detik.
  //   high t=0.5, high t=1.0   -> yang kedua DITOLAK: jamnya sendiri baru
  //                               berjalan 0,5 detik.
  //   high t=0.5, normal t=1.0 -> normal DITOLAK: lastAnySentAt sudah
  //                               diperbarui oleh kiriman high itu.
  //
  // Satu jam bersama dengan dua ambang TIDAK cukup: dengan jam bersama, sebuah
  // balasan FAQ pada t=0 masih membungkam balasan produk pada t=1.2 - dan
  // latensi AutoPIN yang teramati memang berada di sekitar angka itu, jadi
  // kasus itu bukan teoretis.
  //
  // Tidak ada antrean dan tidak ada penjadwal: kebijakan saat limit tercapai
  // tetap DROP, sama seperti sebelumnya.
  let lastAnySentAt = -Infinity;    // kirim terakhir apa pun prioritasnya
  let lastHighSentAt = -Infinity;   // kirim terakhir yang berprioritas tinggi
                                    // keduanya TERPISAH dari jendela 60 detik,
                                    // jadi jeda boleh lebih panjang dari itu
                                    // tanpa terpotong

  const log = (line) => {
    try {
      logger.log(line);
    } catch {
      /* logger rusak tidak boleh menjatuhkan playback */
    }
  };
  const done = (ok, reason, extra) => ({ ok, reason, ...extra });

  function rememberPlayId(id) {
    handledPlayIds.add(id);
    if (handledPlayIds.size > DEDUPE_MEMORY) {
      // buang yang paling lama; Set menjaga urutan sisipan
      const oldest = handledPlayIds.values().next().value;
      handledPlayIds.delete(oldest);
    }
  }

  // Kebijakan saat limit tercapai: DROP, bukan antre. Pesan admin yang telat
  // beberapa menit tidak ada gunanya dan hanya menumpuk spam.
  //
  // Jeda dihitung terhadap jam MILIK PRIORITAS ITU; plafon per menit dihitung
  // terhadap jendela BERSAMA. Jadi prioritas memengaruhi kerapatan, tidak
  // pernah plafonnya.
  function rateLimitReason(t, high) {
    if (high) {
      if (highMinIntervalMs > 0 && t - lastHighSentAt < highMinIntervalMs) return "min-interval-high";
    } else if (minIntervalMs > 0 && t - lastAnySentAt < minIntervalMs) {
      return "min-interval";
    }
    while (sentAt.length && t - sentAt[0] >= RATE_WINDOW_MS) sentAt.shift();
    // Plafon per menit BERSAMA, dan diperiksa untuk kedua prioritas. Prioritas
    // tinggi tidak punya jalan apa pun untuk melewatinya.
    if (sentAt.length >= maxPerMinute) return "rate-limit";
    return null;
  }

  function requestComment(req = {}) {
    try {
      const { scene, playId } = req;
      const requesters = Number.isFinite(req.requesters) ? req.requesters : 0;

      // 1. Flag mati -> nol aksi, nol log.
      if (!enabled) return Promise.resolve(done(false, "disabled"));

      // 2. Scene yang memang tidak pernah dikomentari.
      if (typeof scene !== "string" || scene.trim() === "") {
        log(`[AUTOCOMMENT_SKIPPED] scene=${scene} reason=empty-scene`);
        return Promise.resolve(done(false, "empty-scene"));
      }
      if (NEVER_COMMENTED.has(scene)) {
        log(`[AUTOCOMMENT_SKIPPED] scene=${scene} reason=scene-never-commented`);
        return Promise.resolve(done(false, "scene-never-commented"));
      }

      // 3. Proteksi stale + dedupe per scene start, keduanya lewat playId.
      // NaN/Infinity tidak boleh meracuni latestPlayId dan mematikan proteksi stale.
      const hasPlayId = Number.isFinite(playId);
      if (hasPlayId) {
        if (playId < latestPlayId) {
          log(`[AUTOCOMMENT_STALE] scene=${scene} playId=${playId} latest=${latestPlayId} phase=dispatch`);
          return Promise.resolve(done(false, "stale"));
        }
        if (handledPlayIds.has(playId)) {
          log(`[AUTOCOMMENT_SKIPPED] scene=${scene} playId=${playId} reason=duplicate-playId`);
          return Promise.resolve(done(false, "duplicate-playId"));
        }
        latestPlayId = playId;
        rememberPlayId(playId);
      }

      // 3.5 Bukti pin. Dicek SEBELUM pesan dibentuk dan sebelum jatah rate
      // limit terpakai, supaya penolakan di sini tidak membakar kuota.
      //
      // `requirePin:false` mematikan gerbang ini UNTUK SATU PERMINTAAN, dan
      // hanya itu — kebijakan instance tidak berubah untuk permintaan lain.
      //
      // Kenapa itu benar dan bukan pelemahan: gerbang ini ada untuk menjaga
      // satu kalimat tertentu, "sudah aku pin", agar tidak pernah terucap tanpa
      // bukti. Kalimat itu hanya ada pada aturan yang MEMIN. Aturan FAQ tidak
      // menjanjikan pin apa pun — balasannya milik customer dan tidak menyebut
      // pin — jadi menuntut bukti pin darinya bukan kehati-hatian, melainkan
      // cara membuat setiap balasan FAQ hilang tanpa jejak yang bisa dilihat
      // customer. Dengan transport browser, pinPolicy=CONFIRMED akan menolak
      // SETIAP balasan FAQ sebagai pin-not-confirmed.
      //
      // Yang memutuskan nilai ini adalah aksi aturan (actions.autoPin) di
      // index.js, bukan hasil pin: aturan yang memin dan gagal memin TETAP
      // dibungkam, persis seperti sebelumnya.
      const requirePin = req.requirePin !== false;
      if (!requirePin && pinPolicy !== PIN_POLICY.IGNORE) {
        log(`[AUTOCOMMENT_NO_PIN_CLAIM] scene=${scene} playId=${playId} note="aturan ini tidak memin; bukti pin tidak dituntut"`);
      }
      if (requirePin && pinPolicy !== PIN_POLICY.IGNORE) {
        const pin = req.pin;
        let gate;
        if (pinPolicy === PIN_POLICY.CONFIRMED) {
          const v = inspectPin(pin);
          gate = v.confirmed ? null : v.reason || "pin-not-confirmed";
        } else {
          gate = pin && pin.ok === true ? null : (pin && pin.reason ? "pin-" + pin.reason : "pin-not-ok");
        }
        if (gate) {
          log(`[AUTOCOMMENT_SKIPPED] scene=${scene} playId=${playId} reason=${gate}`);
          return Promise.resolve(done(false, gate));
        }
      }

      // 3.6 Prioritas penjadwalan. DITENTUKAN DI SINI, sesudah gerbang pin.
      //
      // Letaknya bukan kebetulan: prioritas tidak boleh pernah menjadi jalan
      // memutari bukti pin. Karena baris ini hanya terjangkau setelah gerbang
      // di atas lolos, sebuah permintaan prioritas tinggi SELALU sudah
      // membuktikan pin-nya sebelum ia mendapat keringanan jeda apa pun.
      //
      // Dan prioritas tinggi hanya diberikan kepada permintaan yang MENYERAHKAN
      // DIRI pada gerbang itu: `priority:"high"` dengan `requirePin:false`
      // diturunkan menjadi normal, bukan dihormati. Tanpa aturan ini, pemanggil
      // bisa meminta keringanan jeda sekaligus meminta gerbang pin dilewati —
      // persis bentuk pembobolan yang tidak boleh ada jalannya.
      const wantsHigh = req.priority === PRIORITY.HIGH;
      const high = wantsHigh && requirePin;
      if (wantsHigh && !requirePin) {
        log(`[AUTOCOMMENT_PRIORITY_DOWNGRADED] scene=${scene} playId=${playId} note="high tanpa requirePin: diperlakukan normal"`);
      }

      // 4. Pesan deterministik.
      //
      // DUA sumber teks, dan hanya dua:
      //
      //   a. berbasis SCENE  -> format(scene). Satu-satunya jalur sampai v0.2.2.
      //   b. TEKS EKSPLISIT  -> req.text. Dipakai Product Q&A, yang tidak
      //      memutar scene apa pun dan karena itu tidak punya balasan
      //      berbasis scene untuk diambil (format() berkunci scene; lihat
      //      runtime/mappings.js formatSceneMessage).
      //
      // Yang dilewati jalur (b) HANYA PEMILIHAN TEKS. Gerbang teksnya tetap
      // sama dan DIIMPOR dari formatter yang sama — panjang, HTML, karakter
      // kontrol, kosong — dan setiap gerbang keselamatan lain di fungsi ini
      // (dedupe playId, bukti pin, prioritas, rate limit, transport, timeout)
      // berlaku penuh tanpa pengecualian.
      const explicit = typeof req.text === "string" ? req.text : null;
      let text;
      if (explicit !== null) {
        const v = validateText(explicit);
        if (!v.ok) {
          log(`[AUTOCOMMENT_SKIPPED] scene=${scene} playId=${playId} reason=${v.reason} source=explicit-text`);
          return Promise.resolve(done(false, v.reason));
        }
        text = v.text;
      } else {
        const formatted = format(scene);
        if (!formatted || !formatted.ok) {
          const reason = (formatted && formatted.reason) || "unsupported-scene";
          log(`[AUTOCOMMENT_SKIPPED] scene=${scene} playId=${playId} reason=${reason}`);
          return Promise.resolve(done(false, reason));
        }
        text = formatted.text;
      }

      // 5. Rate limit global.
      const t0 = now();
      const limited = rateLimitReason(t0, high);
      if (limited) {
        log(`[AUTOCOMMENT_SKIPPED] scene=${scene} playId=${playId} reason=${limited}`);
        return Promise.resolve(done(false, limited));
      }

      if (typeof send !== "function") {
        log(`[AUTOCOMMENT_FAILED] scene=${scene} playId=${playId} reason=no-transport`);
        return Promise.resolve(done(false, "no-transport"));
      }

      // Dihitung saat DIKIRIM, bukan saat sukses: lebih konservatif, dan
      // kegagalan transport tidak boleh membuka celah spam lewat retry.
      //
      // Titik ini TIDAK berubah oleh prioritas. Yang berubah hanya jam mana
      // yang ikut diperbarui: kiriman prioritas tinggi memperbarui KEDUANYA,
      // sehingga ia menahan balasan normal berikutnya selama lima detik penuh —
      // itulah yang mencegah prioritas berubah menjadi celah spam.
      sentAt.push(t0);
      lastAnySentAt = t0;
      if (high) lastHighSentAt = t0;
      log(`[AUTOCOMMENT_REQUEST] scene=${scene} playId=${playId} requesters=${requesters} priority=${high ? PRIORITY.HIGH : PRIORITY.NORMAL} text="${text}"`);

      let sent;
      try {
        // `deliveryId` hanya disertakan kalau pemanggil memang memberinya.
        // Balasan scene TIDAK boleh berubah bentuk payload-nya - termasuk
        // tidak membawa kunci undefined yang akan ikut ke JSON.
        const kiriman = { text, scene, playId, pin: req.pin };
        if (req.deliveryId !== undefined) kiriman.deliveryId = req.deliveryId;
        sent = Promise.resolve(send(kiriman));
      } catch (err) {
        log(`[AUTOCOMMENT_FAILED] scene=${scene} playId=${playId} reason=send-threw detail=${brief(err)}`);
        return Promise.resolve(done(false, "send-threw"));
      }
      sent.catch(() => {}); // kalau kalah balapan dengan timeout, tetap ada yang menangani

      let timer = null;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      });
      const settle = () => {
        if (timer) clearTimeout(timer);
      };

      return Promise.race([sent, timeout])
        .then((result) => {
          settle();
          const ms = Math.round(now() - t0);
          if (result === TIMED_OUT) {
            log(`[AUTOCOMMENT_FAILED] scene=${scene} playId=${playId} reason=timeout ms=${timeoutMs}`);
            return done(false, "timeout");
          }
          if (hasPlayId && playId < latestPlayId) {
            log(`[AUTOCOMMENT_STALE] scene=${scene} playId=${playId} latest=${latestPlayId} phase=result`);
            return done(false, "stale");
          }
          if (!result || result.ok === false) {
            const reason = (result && result.reason) || "refused";
            log(`[AUTOCOMMENT_FAILED] scene=${scene} playId=${playId} reason=${reason} ms=${ms}`);
            return done(false, reason);
          }
          if (result.dryRun) {
            log(`[AUTOCOMMENT_DRYRUN] scene=${scene} playId=${playId} text="${text}" ms=${ms}`);
            return done(true, "dry-run", { dryRun: true, text });
          }
          log(`[AUTOCOMMENT_SUCCESS] scene=${scene} playId=${playId} ms=${ms}`);
          return done(true, "sent", { text });
        })
        .catch((err) => {
          settle();
          log(`[AUTOCOMMENT_FAILED] scene=${scene} playId=${playId} reason=send-rejected detail=${brief(err)}`);
          return done(false, "send-rejected");
        });
    } catch (err) {
      // Jaring terakhir: dipanggil dari jalur playback, apa pun yang terjadi di
      // sini tidak boleh keluar sebagai exception.
      log(`[AUTOCOMMENT_FAILED] reason=dispatch-threw detail=${brief(err)}`);
      return Promise.resolve(done(false, "dispatch-threw"));
    }
  }

  return {
    requestComment,
    // untuk tes/diagnostik; bukan bagian dari jalur playback
    __state: () => ({
      enabled,
      pinPolicy,
      latestPlayId,
      handled: handledPlayIds.size,
      sentInWindow: sentAt.length,
      lastAnySentAt,
      lastHighSentAt,
      maxPerMinute,
      minIntervalMs,
      highMinIntervalMs,
    }),
  };
}

module.exports = {
  createAutoComment,
  PIN_POLICY,
  PRIORITY,
  createDryRunTransport,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_PER_MINUTE,
  DEFAULT_MIN_INTERVAL_MS,
  DEFAULT_HIGH_MIN_INTERVAL_MS,
  RATE_WINDOW_MS,
};
