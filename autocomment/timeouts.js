"use strict";
// Anggaran waktu untuk SATU permintaan AutoComment, dihitung dari satu angka:
// timeout HTTP milik bot.
//
// Phase 21 gagal justru karena anggaran ini tidak pernah dihitung. Bot menyerah
// pada detik 8 (AbortController di autocomment/client.js):
//
//   [AUTOCOMMENT_FAILED] scene=PAX-1 playId=1 reason=send-rejected
//                        detail=This operation was aborted
//
// sementara service masih mengerjakan browser, dan satu panggilan CDP
// menggantung sampai jauh melewati itu:
//
//   [AUTOCOMMENT_SEND_FAILED] scene=PAX-1 playId=1 stage=click
//                             detail=Runtime.callFunctionOn timed out
//
// Hasilnya jendela "entah" yang panjang: bot sudah menyatakan gagal, service
// masih mungkin mengklik, dan tidak ada satu pun pihak yang tahu apakah pesan
// benar-benar terkirim. Itu keadaan terburuk untuk sistem yang bisa memposting
// ke penonton - lebih buruk daripada gagal terang-terangan.
//
// Aturannya sekarang satu arah dan selalu diperiksa:
//
//     browserDeadlineMs + reconcileWindowMs + marginMs  <=  httpTimeoutMs
//
// Artinya service WAJIB selesai dan menjawab sebelum bot menyerah. Jawaban yang
// sampai lebih berharga daripada percobaan yang lebih lama.

const DEFAULT_HTTP_TIMEOUT_MS = 8_000;

// Margin: jatah untuk perjalanan HTTP lokal, penjadwalan Node, dan pembulatan.
// Tidak pernah di bawah satu detik walau timeout HTTP-nya kecil.
const MIN_MARGIN_MS = 1_000;
const MARGIN_SHARE = 0.15;

// Rekonsiliasi hanya membaca; ia tidak perlu lama, tapi harus kebagian waktu
// SEBELUM bot menyerah - kalau tidak, hasil bacaannya tidak pernah terkirim.
const DEFAULT_RECONCILE_WINDOW_MS = 1_500;
const MAX_RECONCILE_SHARE = 0.3;
const DEFAULT_RECONCILE_POLL_MS = 250;

// Backstop Puppeteer. Bawaannya 180 detik, dan itulah yang membuat satu
// panggilan protokol menggantung berjam-jam-rasanya di Phase 21. Angka ini bukan
// deadline operasi kita (itu browserDeadlineMs); ini hanya jaring supaya
// panggilan yang benar-benar mati tidak menggantung tanpa batas. Sengaja masih
// longgar karena pemuatan halaman konsol sendiri pernah butuh 12 detik.
const PROTOCOL_TIMEOUT_MS = 30_000;

function intOr(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// Membagi satu timeout HTTP menjadi anggaran yang konsisten. `fits` false berarti
// timeout HTTP-nya terlalu kecil untuk memuat semuanya; pemanggil harus
// MEMPERINGATKAN, bukan diam, karena pada keadaan itu jaminan di atas tidak
// berlaku lagi.
function planTimeouts({ httpTimeoutMs, reconcileWindowMs, reconcilePollMs } = {}) {
  const http = intOr(httpTimeoutMs, DEFAULT_HTTP_TIMEOUT_MS);
  const margin = Math.max(MIN_MARGIN_MS, Math.round(http * MARGIN_SHARE));
  const roomAfterMargin = Math.max(0, http - margin);

  const wantReconcile =
    reconcileWindowMs === undefined || reconcileWindowMs === null
      ? DEFAULT_RECONCILE_WINDOW_MS
      : Math.max(0, intOr(reconcileWindowMs, DEFAULT_RECONCILE_WINDOW_MS));

  // Rekonsiliasi mengalah lebih dulu: lebih baik jendelanya sempit daripada
  // browser tidak punya waktu bekerja sama sekali.
  const reconcile = Math.min(wantReconcile, Math.floor(roomAfterMargin * MAX_RECONCILE_SHARE));
  const browser = roomAfterMargin - reconcile;

  const poll = Math.max(
    1,
    Math.min(intOr(reconcilePollMs, DEFAULT_RECONCILE_POLL_MS), Math.max(1, reconcile || DEFAULT_RECONCILE_POLL_MS))
  );

  return {
    httpTimeoutMs: http,
    marginMs: margin,
    browserDeadlineMs: browser,
    reconcileWindowMs: reconcile,
    reconcilePollMs: poll,
    protocolTimeoutMs: PROTOCOL_TIMEOUT_MS,
    // Invarian yang menjadi alasan modul ini ada.
    fits: browser > 0 && browser + reconcile + margin <= http,
  };
}

// Satu baris ringkas untuk log startup, supaya anggaran yang BENAR-BENAR dipakai
// bisa dibaca operator - bukan ditebak dari kode.
function describeTimeouts(t) {
  return (
    `http=${t.httpTimeoutMs}ms browser=${t.browserDeadlineMs}ms ` +
    `reconcile=${t.reconcileWindowMs}ms margin=${t.marginMs}ms ` +
    `protocol=${t.protocolTimeoutMs}ms fits=${t.fits}`
  );
}

module.exports = {
  planTimeouts,
  describeTimeouts,
  DEFAULT_HTTP_TIMEOUT_MS,
  MIN_MARGIN_MS,
  MARGIN_SHARE,
  DEFAULT_RECONCILE_WINDOW_MS,
  MAX_RECONCILE_SHARE,
  DEFAULT_RECONCILE_POLL_MS,
  PROTOCOL_TIMEOUT_MS,
};
