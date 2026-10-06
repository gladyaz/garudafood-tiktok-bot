"use strict";
// Generasi pemutaran (playId) yang sadar SESI.
//
// ---------------------------------------------------------------------------
// MASALAH YANG DIPERBAIKI
//
// Pada 2026-10-05, me-restart BOT saja membuat seluruh trigger ditolak:
//
//   [AUTOPIN_FAILED] scene=PAX-1 playId=1 reason=stale
//   [AUTOCOMMENT_SKIPPED] scene=PAX-1 playId=1 reason=stale
//
// Penyebabnya: penghitung playId bot mulai lagi dari 1 saat restart, tapi
// service masih menyimpan `latestPlayId=2` dari sesi bot SEBELUMNYA. Aturan
// basi `playId < latestPlayId` lalu membaca 1 < 2 dan menolak pemutaran yang
// sebenarnya BARU.
//
// Ini tidak pernah muncul dalam pengujian karena saya selalu me-restart service
// dan bot bersamaan - jadi kedua penghitung selalu mulai dari nol. Operator
// yang me-restart satu proses saja langsung menabraknya, dan pesannya
// ("stale") justru menyesatkan.
//
// ---------------------------------------------------------------------------
// YANG TETAP HARUS DIJAGA
//
// Pemeriksaan basi itu ADA untuk alasan nyata: saat scene baru mulai, pekerjaan
// pin dan chat milik scene lama harus mati, supaya pesan "Etalase 1 sudah
// di-pin" tidak muncul ketika Etalase 2 sudah tayang. Jadi perbaikannya bukan
// melemahkan aturan itu, melainkan memberinya BATAS yang benar: basi hanya
// berarti sesuatu DI DALAM satu sesi bot yang sama.
//
// Sesi baru = penghitung baru. Sesi yang sama = aturan basi berlaku penuh.

// Permintaan tanpa sessionId (mis. curl diagnostik) tidak boleh mengubah sesi
// yang sedang berjalan, dan diperlakukan dengan aturan lama.
const LEGACY = null;

function clean(v) {
  const s = String(v ?? "").trim();
  return s === "" ? null : s.slice(0, 64);
}

function createPlayGeneration({ logger = null } = {}) {
  let session = LEGACY;
  let latest = 0;
  let adoptions = 0;

  const log = (event, data) => {
    if (!logger) return;
    try {
      logger(event, data);
    } catch (e) {
      /* logger rusak tidak boleh menjatuhkan jalur pin */
    }
  };

  // Dipanggil saat sebuah pemutaran MULAI dikerjakan. Mengadopsi sesi baru
  // (dan mereset penghitung) lalu menaikkan generasi.
  function note({ sessionId, playId } = {}) {
    const sid = clean(sessionId);

    if (sid !== null && sid !== session) {
      // Sesi berganti: bot baru, atau bot yang di-restart. Penghitungnya mulai
      // dari nol lagi, jadi angka lama TIDAK boleh dipakai sebagai pembanding.
      adoptions += 1;
      log("SERVICE_SESSION_ADOPTED", {
        session: sid,
        previous: session || "(none)",
        resetFrom: latest,
        note: "penghitung playId direset: sesi bot baru",
      });
      session = sid;
      latest = 0;
    }

    if (Number.isFinite(playId) && playId > latest) latest = playId;
  }

  // true berarti pemutaran ini sudah ketinggalan OLEH PEMUTARAN LAIN DI SESI
  // YANG SAMA.
  function isStale({ sessionId, playId } = {}) {
    if (!Number.isFinite(playId) || playId <= 0) return false;

    const sid = clean(sessionId);
    // Sesi yang berbeda belum pernah dibandingkan dengan apa pun di sini.
    // Menyebutnya basi adalah kekeliruan yang persis menjadi bug 2026-10-05.
    if (sid !== null && sid !== session) return false;

    return playId < latest;
  }

  return {
    note,
    isStale,
    session: () => session,
    latest: () => latest,
    __state: () => ({ session, latest, adoptions }),
  };
}

// ID sesi untuk proses bot. Cukup unik untuk membedakan dua proses pada mesin
// yang sama; ini bukan nilai rahasia dan tidak pernah dikirim ke luar loopback.
function newSessionId({ pid = process.pid, now = () => Date.now(), rand = Math.random } = {}) {
  const r = Math.floor(rand() * 0xfffff).toString(36);
  return `b${pid}-${now().toString(36)}-${r}`;
}

module.exports = { createPlayGeneration, newSessionId, LEGACY };
