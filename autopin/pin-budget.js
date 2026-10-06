"use strict";
// Anggaran waktu untuk SATU percobaan AutoPIN, diturunkan dari satu angka:
// batas tunggu HTTP milik bot (AUTOPIN_TIMEOUT_MS).
//
// ---------------------------------------------------------------------------
// MASALAH YANG DIPERBAIKI
//
// LIVE 2026-10-06, katalog 20 produk. Bot menyerah pada detik 8:
//
//   [AUTOPIN_FAILED] scene=PAX-1 playId=1 reason=send-rejected
//                    detail=This operation was aborted
//   [AUTOCOMMENT_SKIPPED] scene=PAX-1 playId=1 reason=send-rejected
//
// sementara service MENYELESAIKAN pekerjaannya dengan baik:
//
//   [AUTOPIN_SERVICE_PINNED] scene=PAX-1 after=Unpin via=snapshot-button reads=6
//
// Jadi produknya benar-benar ter-pin dan terkonfirmasi, tapi bot tidak pernah
// tahu, dan chat ikut dilewati. Dua pihak, dua cerita - keadaan "entah" yang
// persis sudah ditutup untuk jalur chat (autocomment/timeouts.js) tapi jalur
// pin belum pernah punya.
//
// Memutus koneksi HTTP TIDAK menghentikan service: ia tetap menggulir, tetap
// mengklik. Jadi tanpa anggaran, bot bisa melaporkan gagal sementara klik
// nyata baru mendarat sesudahnya.
//
// ---------------------------------------------------------------------------
// MODELNYA
//
//   browserDeadlineMs + marginMs  =  httpTimeoutMs
//
// Seluruh pekerjaan sisi service WAJIB selesai di dalam browserDeadlineMs,
// sehingga jawaban selalu sampai sebelum bot berhenti mendengar. Margin adalah
// jatah perjalanan HTTP lokal dan penjadwalan Node.
//
// Di dalam deadline itu ada satu pagar lagi yang lebih penting daripada
// kecepatan - CADANGAN KONFIRMASI:
//
//   sebelum mengklik, sisa waktu harus >= confirmReserveMs
//
// Kalau tidak cukup, pin TIDAK diklik sama sekali. Alasannya: pin yang terjadi
// tapi tidak bisa dikonfirmasi adalah hasil terburuk yang mungkin - produk
// berubah di layar penonton, chat ditahan, dan bot maupun service tidak punya
// cerita yang sama. Tidak mengklik jauh lebih baik: tidak ada yang berubah,
// kedua pihak sepakat, dan penonton bisa meminta ulang.
//
// Cadangan itu dibagi lagi: sebagian untuk sinyal primer (baca tombol), sisanya
// untuk sinyal snapshot. Dengan katalog 20 produk sinyal primer terukur GAGAL
// 100% (primary=found=false di keenam bacaan), jadi menghabiskan seluruh
// cadangan pada bacaan yang hampir pasti buta adalah pemborosan - snapshot yang
// justru butuh waktu itu.

const DEFAULT_HTTP_TIMEOUT_MS = 8_000;

// Margin: tidak pernah di bawah satu detik, walau timeout HTTP-nya kecil.
const MIN_MARGIN_MS = 1_000;
const MARGIN_SHARE = 0.15;

// Cadangan konfirmasi: cukup untuk beberapa bacaan tombol plus satu pencarian
// snapshot yang berhenti dini. Dibatasi atas supaya koleksi awal tetap kebagian
// waktu pada katalog besar.
const MAX_CONFIRM_RESERVE_MS = 3_000;
const CONFIRM_RESERVE_SHARE = 0.35;

// Pembagian di dalam cadangan konfirmasi.
const PRIMARY_SHARE = 0.4;

// Satu bacaan tombol dan jeda antar-bacaan.
const CONFIRM_POLL_MS = 250;
const MAX_CONFIRM_READS = 6;

function intOr(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function planPinTimeouts({ httpTimeoutMs, confirmReserveMs, pollMs } = {}) {
  const http = intOr(httpTimeoutMs, DEFAULT_HTTP_TIMEOUT_MS);
  const margin = Math.max(MIN_MARGIN_MS, Math.round(http * MARGIN_SHARE));
  const browser = Math.max(0, http - margin);

  const wantReserve =
    confirmReserveMs === undefined || confirmReserveMs === null
      ? MAX_CONFIRM_RESERVE_MS
      : Math.max(0, intOr(confirmReserveMs, MAX_CONFIRM_RESERVE_MS));
  const reserve = Math.min(wantReserve, Math.floor(browser * CONFIRM_RESERVE_SHARE));

  const primary = Math.floor(reserve * PRIMARY_SHARE);
  const poll = Math.max(1, intOr(pollMs, CONFIRM_POLL_MS));

  return {
    httpTimeoutMs: http,
    marginMs: margin,
    // Seluruh pekerjaan sisi service harus selesai di dalam ini.
    browserDeadlineMs: browser,
    // Harus masih tersisa SEBELUM klik, kalau tidak: jangan klik.
    confirmReserveMs: reserve,
    // Jatah sinyal primer di dalam cadangan; sisanya milik snapshot.
    primaryWindowMs: primary,
    snapshotWindowMs: reserve - primary,
    confirmPollMs: poll,
    maxConfirmReads: MAX_CONFIRM_READS,
    // Invarian yang menjadi alasan modul ini ada.
    fits: browser > 0 && reserve > 0 && browser + margin <= http,
  };
}

function describePinTimeouts(t) {
  return (
    `http=${t.httpTimeoutMs}ms browser=${t.browserDeadlineMs}ms ` +
    `confirmReserve=${t.confirmReserveMs}ms (primary=${t.primaryWindowMs}ms snapshot=${t.snapshotWindowMs}ms) ` +
    `margin=${t.marginMs}ms fits=${t.fits}`
  );
}

module.exports = {
  planPinTimeouts,
  describePinTimeouts,
  DEFAULT_HTTP_TIMEOUT_MS,
  MIN_MARGIN_MS,
  MARGIN_SHARE,
  MAX_CONFIRM_RESERVE_MS,
  CONFIRM_RESERVE_SHARE,
  PRIMARY_SHARE,
  CONFIRM_POLL_MS,
  MAX_CONFIRM_READS,
};
