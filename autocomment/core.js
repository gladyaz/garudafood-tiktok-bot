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

const { formatSceneMessage } = require("./formatter");

const DEFAULT_TIMEOUT_MS = 8_000;
// Batas internal yang konservatif. BUKAN limit resmi TikTok - angka resminya
// tidak diketahui. Keduanya bisa diatur lewat env, lihat .env.example.
const DEFAULT_MAX_PER_MINUTE = 6;
const DEFAULT_MIN_INTERVAL_MS = 5_000;
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

function createAutoComment({
  enabled = false,
  pinPolicy = PIN_POLICY.IGNORE,
  inspectPin = () => ({ confirmed: false, reason: "no-pin-inspector" }),
  send,
  format = formatSceneMessage,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxPerMinute = DEFAULT_MAX_PER_MINUTE,
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
  logger = console,
  now = () => performance.now(), // monotonik: jam dinding yang mundur tidak boleh memblokir kiriman
} = {}) {
  let latestPlayId = 0;
  const handledPlayIds = new Set(); // playId yang sudah diputuskan: dedupe scene-start
  const sentAt = [];                // waktu kirim dalam jendela 60 detik: rate limit
  let lastSentAt = -Infinity;       // kirim terakhir, TERPISAH dari jendela: min-interval
                                    // boleh lebih panjang dari 60 detik tanpa terpotong

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
  function rateLimitReason(t) {
    if (minIntervalMs > 0 && t - lastSentAt < minIntervalMs) return "min-interval";
    while (sentAt.length && t - sentAt[0] >= RATE_WINDOW_MS) sentAt.shift();
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
      if (pinPolicy !== PIN_POLICY.IGNORE) {
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

      // 4. Pesan deterministik; scene tanpa nomor etalase -> diam.
      const formatted = format(scene);
      if (!formatted || !formatted.ok) {
        const reason = (formatted && formatted.reason) || "unsupported-scene";
        log(`[AUTOCOMMENT_SKIPPED] scene=${scene} playId=${playId} reason=${reason}`);
        return Promise.resolve(done(false, reason));
      }
      const text = formatted.text;

      // 5. Rate limit global.
      const t0 = now();
      const limited = rateLimitReason(t0);
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
      sentAt.push(t0);
      lastSentAt = t0;
      log(`[AUTOCOMMENT_REQUEST] scene=${scene} playId=${playId} requesters=${requesters} text="${text}"`);

      let sent;
      try {
        sent = Promise.resolve(send({ text, scene, playId, pin: req.pin }));
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
      lastSentAt,
      maxPerMinute,
      minIntervalMs,
    }),
  };
}

module.exports = {
  createAutoComment,
  PIN_POLICY,
  createDryRunTransport,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_PER_MINUTE,
  DEFAULT_MIN_INTERVAL_MS,
  RATE_WINDOW_MS,
};
