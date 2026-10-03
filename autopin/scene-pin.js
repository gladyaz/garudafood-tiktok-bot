"use strict";
// Dispatcher AutoPIN untuk playback scene.
//
// Modul ini TIDAK mengenal Puppeteer dan tidak pernah dipakai untuk memegang
// browser. Tugasnya cuma satu: menerjemahkan "scene X baru saja benar-benar
// mulai diputar" menjadi satu permintaan pin, dengan jaminan:
//
//   - tidak pernah melempar ke pemanggil (sinkron maupun asinkron)
//   - tidak pernah menyentuh busy / activeScene / cooldown / timer / antrean
//   - selalu punya batas waktu sendiri, jadi transport yang menggantung tidak
//     pernah menahan jalur playback
//   - hasil yang datang terlambat (scene sudah berganti) dibuang, bukan dipakai
//
// AutoPIN bersifat AUXILIARY: kegagalannya tidak boleh terlihat oleh penonton
// sebagai video yang macet.

const { NEVER_MAPPED } = require("./scene-map");

const DEFAULT_TIMEOUT_MS = 8_000;

function createScenePin({
  enabled = false,
  mapping = {},
  send,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  logger = console,
  now = () => Date.now(),
} = {}) {
  // playId tertinggi yang pernah dilihat. Dipakai untuk membuang permintaan dan
  // hasil milik scene yang sudah tidak tayang lagi.
  let latestPlayId = 0;

  const log = (line) => {
    try {
      logger.log(line);
    } catch {
      /* logger rusak tidak boleh menjatuhkan playback */
    }
  };

  function done(ok, reason, extra) {
    return { ok, reason, ...extra };
  }

  function requestPin(req = {}) {
    try {
      const { scene, playId } = req;

      // 1. Flag mati -> benar-benar nol aksi dan nol log.
      if (!enabled) return Promise.resolve(done(false, "disabled"));

      // 2. Scene yang memang tidak pernah punya produk.
      if (typeof scene !== "string" || scene.trim() === "") {
        log(`[AUTOPIN_SKIPPED] scene=${scene} reason=empty-scene`);
        return Promise.resolve(done(false, "empty-scene"));
      }
      if (NEVER_MAPPED.has(scene)) {
        log(`[AUTOPIN_SKIPPED] scene=${scene} reason=scene-never-mapped`);
        return Promise.resolve(done(false, "scene-never-mapped"));
      }

      // 3. Permintaan yang sudah basi sebelum sempat dikirim.
      //    Terjadi saat force/ganti scene mendahului resolve-nya OBS switch lama.
      if (typeof playId === "number") {
        if (playId < latestPlayId) {
          log(`[AUTOPIN_STALE] scene=${scene} playId=${playId} latest=${latestPlayId} phase=dispatch`);
          return Promise.resolve(done(false, "stale"));
        }
        latestPlayId = playId;
      }

      // 4. Scene tanpa pemetaan produk -> diam, bukan menebak.
      const productKey = mapping[scene];
      if (!productKey) {
        log(`[AUTOPIN_SKIPPED] scene=${scene} reason=no-mapping`);
        return Promise.resolve(done(false, "no-mapping"));
      }

      if (typeof send !== "function") {
        log(`[AUTOPIN_FAILED] scene=${scene} playId=${playId} reason=no-transport`);
        return Promise.resolve(done(false, "no-transport"));
      }

      log(`[AUTOPIN_REQUEST] scene=${scene} playId=${playId} key="${productKey}"`);
      const startedAt = now();

      let sent;
      try {
        sent = Promise.resolve(send({ scene, productKey, playId }));
      } catch (err) {
        // transport melempar seketika
        log(`[AUTOPIN_FAILED] scene=${scene} playId=${playId} reason=send-threw detail=${brief(err)}`);
        return Promise.resolve(done(false, "send-threw"));
      }
      // Kalau nanti kalah balapan dengan timeout, penolakannya tetap harus ada
      // yang menangani supaya tidak jadi unhandled rejection.
      sent.catch(() => {});

      let timer = null;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      });

      const settle = (result) => {
        if (timer) clearTimeout(timer);
        return result;
      };

      return Promise.race([sent, timeout])
        .then((result) => {
          settle();
          const ms = now() - startedAt;

          if (result === TIMED_OUT) {
            log(`[AUTOPIN_FAILED] scene=${scene} playId=${playId} reason=timeout ms=${timeoutMs}`);
            return done(false, "timeout");
          }

          // Hasil datang setelah scene lain mulai -> jangan dianggap sukses saat ini.
          if (typeof playId === "number" && playId < latestPlayId) {
            log(`[AUTOPIN_STALE] scene=${scene} playId=${playId} latest=${latestPlayId} phase=result`);
            return done(false, "stale");
          }

          if (result && result.ok === false) {
            log(`[AUTOPIN_FAILED] scene=${scene} playId=${playId} reason=${result.reason || "refused"} ms=${ms}`);
            return done(false, result.reason || "refused");
          }

          log(`[AUTOPIN_SUCCESS] scene=${scene} playId=${playId} key="${productKey}" ms=${ms}`);
          return done(true, "pinned");
        })
        .catch((err) => {
          settle();
          log(`[AUTOPIN_FAILED] scene=${scene} playId=${playId} reason=send-rejected detail=${brief(err)}`);
          return done(false, "send-rejected");
        });
    } catch (err) {
      // Jaring terakhir: requestPin dipanggil dari jalur playback, jadi apa pun
      // yang terjadi di sini tidak boleh keluar sebagai exception.
      log(`[AUTOPIN_FAILED] reason=dispatch-threw detail=${brief(err)}`);
      return Promise.resolve(done(false, "dispatch-threw"));
    }
  }

  return {
    requestPin,
    // untuk tes/diagnostik; bukan bagian dari jalur playback
    __state: () => ({ enabled, latestPlayId, mappedScenes: Object.keys(mapping) }),
  };
}

const TIMED_OUT = Symbol("autopin-timeout");

// Pesan error saja, tidak pernah objek mentah: menghindari cookie/token ikut ter-log.
function brief(err) {
  const msg = err && err.message ? String(err.message) : String(err);
  return msg.slice(0, 120).replace(/\s+/g, " ");
}

module.exports = { createScenePin, DEFAULT_TIMEOUT_MS };
