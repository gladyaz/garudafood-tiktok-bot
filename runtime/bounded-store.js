"use strict";
// Penyimpanan per-kunci yang BERBATAS: punya umur (TTL) dan punya tutup (maxSize).
//
// ---------------------------------------------------------------------------
// MASALAH YANG DIPERBAIKI
//
// State anti-spam disimpan di tiga Map yang di-kunci nickname penonton:
//
//   perUserMap          nickname -> array timestamp
//   userLastMessages    nickname -> { lastMsg, repeatCount, lastAt }
//   isMutedUntil        nickname -> timestamp
//
// Ketiganya HANYA pernah dibersihkan di dalam `__test.reset()` - sebuah hook
// TES, yang tidak pernah jalan di produksi. Jadi tiap nickname baru menambah
// entri PERMANEN. Terukur pada 2026-10-05: ~1.454 byte per penonton unik,
// 28 MB untuk 20.000 penonton, dan terus naik selama siaran. LIVE panjang
// dengan banyak komentator berbeda akan melambat lalu mati.
//
// ---------------------------------------------------------------------------
// KEBIJAKAN PEMBUANGAN
//
// Dua pagar, keduanya bisa dikonfigurasi:
//
//   TTL      entri yang pemiliknya tidak bicara lagi selama ttlMs dibuang
//   maxSize  kalau tetap kepenuhan, yang PALING LAMA tidak menulis dibuang
//
// Urutan Map JavaScript adalah urutan penyisipan, dan setiap tulisan ulang
// menghapus-lalu-menyisipkan kembali. Jadi isi Map ini SELALU terurut menurut
// waktu tulis terakhir: yang paling lama di depan. Itu membuat dua hal murah:
// pembuangan kedaluwarsa cukup menyapu dari depan dan berhenti pada entri
// pertama yang masih hidup, dan pembuangan karena penuh cukup mengambil entri
// terdepan.
//
// Catatan jujur soal nama: ini pembuangan berdasarkan TULISAN terakhir, bukan
// AKSES terakhir seperti LRU murni. Untuk anti-spam keduanya sama saja - satu
// pesan masuk selalu membaca lalu menulis entri yang sama - dan "penonton yang
// sudah lama tidak bicara" memang tepat sebagai yang pertama dilupakan.
// `get()` sengaja TIDAK mengubah urutan, supaya invarian terurut itu tetap
// utuh dan penyapuan dari depan tetap benar.

const DEFAULT_MAX_SIZE = 5_000;
const DEFAULT_TTL_MS = 10 * 60_000;

function positiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function createBoundedStore({
  maxSize = DEFAULT_MAX_SIZE,
  ttlMs = DEFAULT_TTL_MS,
  now = () => Date.now(),
} = {}) {
  const limit = positiveInt(maxSize, DEFAULT_MAX_SIZE);
  const ttl = positiveInt(ttlMs, DEFAULT_TTL_MS);

  const map = new Map(); // key -> { v, at }
  let evicted = 0;
  let expired = 0;

  const alive = (e, t) => t - e.at <= ttl;

  // Menyapu dari depan. Berhenti pada entri hidup pertama: karena Map terurut
  // menurut waktu tulis, sisanya pasti lebih baru. Biayanya sebanding dengan
  // jumlah yang DIBUANG, bukan dengan jumlah isi.
  function sweep() {
    const t = now();
    let removed = 0;
    for (const [k, e] of map) {
      if (alive(e, t)) break;
      map.delete(k);
      removed += 1;
    }
    expired += removed;
    return removed;
  }

  function get(key) {
    const e = map.get(key);
    if (!e) return undefined;
    if (!alive(e, now())) {
      map.delete(key);
      expired += 1;
      return undefined;
    }
    return e.v;
  }

  function set(key, v) {
    // Hapus dulu supaya penyisipan kembali memindahkannya ke belakang, menjaga
    // urutan "paling lama di depan".
    map.delete(key);
    map.set(key, { v, at: now() });

    // Kedaluwarsa dibuang lebih dulu; baru kalau masih penuh, yang terdepan
    // ikut dibuang walau belum kedaluwarsa.
    if (map.size > limit) sweep();
    while (map.size > limit) {
      const oldest = map.keys().next().value;
      map.delete(oldest);
      evicted += 1;
    }
    return v;
  }

  return {
    get,
    set,
    has: (key) => get(key) !== undefined,
    delete: (key) => map.delete(key),
    clear: () => map.clear(),
    sweep,
    size: () => map.size,
    limits: () => ({ maxSize: limit, ttlMs: ttl }),
    __state: () => ({ size: map.size, maxSize: limit, ttlMs: ttl, evicted, expired }),
  };
}

module.exports = { createBoundedStore, DEFAULT_MAX_SIZE, DEFAULT_TTL_MS };
