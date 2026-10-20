"use strict";
// Admisi Product Q&A: jeda per-produk + plafon global. RESERVASI, bukan
// periksa-lalu-bertindak.
//
// ---------------------------------------------------------------------------
// KENAPA RESERVASI, DAN BUKAN allow() LALU note()
//
// Bentuk yang lama punya celah balapan yang TERUKUR:
//
//   allow()                 <- periksa
//   await requestComment()  <- SELURUH kiriman browser terjadi di sini
//   note()                  <- catat
//
// Pertanyaan penonton kedua yang tiba di dalam jeda itu melihat pencatat yang
// MASIH KOSONG. Pada config customer apa adanya (minIntervalMs 5000,
// maxPerMinute 6, kuota 2/60s) dengan kiriman 7 detik dan pertanyaan tiap 6
// detik, hasilnya: TIGA balasan Q&A dalam satu jendela 60 detik, dan DUA
// balasan untuk produk yang SAMA berjarak 6 detik. 7 detik bukan angka
// karangan - autoCommentTimeoutMs memang 8000, jadi kiriman selambat itu masih
// di dalam toleransi yang sistem ini nyatakan sendiri.
//
// Jadi slotnya DIPESAN secara sinkron sebelum await, lalu:
//   commit()  kiriman TERBUKTI berhasil (atau hasilnya ambigu)  -> slot terpakai
//   release() kiriman TERBUKTI gagal sebelum menyentuh TikTok   -> slot kembali
//
// Keduanya idempoten: commit/release kedua kali tidak melakukan apa pun.
//
// ---------------------------------------------------------------------------
// KEBIJAKAN YANG DIJAGA (tidak berubah)
//
//   jeda per-produk : 30 detik SESUDAH kiriman berhasil
//   plafon global   : 2 kiriman berhasil per 60 detik MELUNCUR
//
// Jendelanya meluncur, bukan ember menit kalender: ember punya tepi, dan dua
// jawaban berjarak satu detik yang menyeberangi pergantian menit akan lolos
// berdua.
//
// ---------------------------------------------------------------------------
// LINGKUPNYA SEMPIT, DAN ITU DISENGAJA
//
// Peta-peta di sini hanya dilihat jalur Q&A. Ia TIDAK bisa membungkam balasan
// aturan terkonfigurasi, TIDAK bisa membungkam balasan HIGH AutoPIN, dan TIDAK
// menyentuh semantik stale/playId AutoComment - jalur-jalur itu tidak pernah
// memanggil modul ini.

const DEFAULT_COOLDOWN_MS = 30_000;
const DEFAULT_QUOTA_LIMIT = 2;
const DEFAULT_QUOTA_WINDOW_MS = 60_000;

// Umur maksimum sebuah reservasi yang tidak pernah di-commit maupun di-release.
//
// Secara normal mustahil: requestComment SELALU selesai karena ia berlomba
// dengan timeout-nya sendiri, dan setiap jalur keluar di qa/price-qa.js
// memanggil commit atau release. TTL ini jaring terakhir untuk jalur
// patologis - tanpa itu, satu reservasi yang menggantung akan memakan slot
// SELAMANYA dan fitur ini membungkam dirinya sendiri sampai bot di-restart.
//
// Arahnya konservatif: selama TTL, slotnya DIANGGAP TERPAKAI.
const DEFAULT_RESERVATION_TTL_MS = 30_000;

// Batas ingatan jeda per-produk. Satu entri per produk yang pernah dijawab;
// katalog LIVE berukuran puluhan, jadi ini sangat longgar.
const MEMORY_LIMIT = 500;

// Pegangan reservasi. commit/release idempoten, dan keduanya tidak pernah
// melempar - dipanggil dari jalur keluar yang tidak boleh gagal.
function createHandle({ onCommit, onRelease }) {
  let settled = false;
  return {
    ok: true,
    commit() {
      if (settled) return false;
      settled = true;
      try {
        onCommit();
      } catch {
        /* pencatat rusak tidak boleh menjatuhkan jalur chat */
      }
      return true;
    },
    release() {
      if (settled) return false;
      settled = true;
      try {
        onRelease();
      } catch {
        /* idem */
      }
      return true;
    },
    settled: () => settled,
  };
}

// ---------------------------------------------------------------------------
// JEDA PER-PRODUK
//
// Kuncinya identitas produk, BUKAN nomor etalase: nomor bergeser sesudah pin,
// dan kunci yang bergeser berarti produk yang sama bisa dijawab dua kali.
function createQaDedupe({
  cooldownMs = DEFAULT_COOLDOWN_MS,
  now = () => Date.now(),
  reservationTtlMs = DEFAULT_RESERVATION_TTL_MS,
} = {}) {
  // identitas -> stempel waktu kiriman TERBUKTI terakhir
  const lastSentAt = new Map();
  // identitas -> { at, token } untuk kiriman yang SEDANG berjalan
  //
  // Token-nya BUKAN hiasan. Tanpa itu ada jalur yang merusak: reservasi R1
  // untuk produk X menggantung, TTL membuangnya, R2 untuk X yang sah dibuat,
  // lalu R1 akhirnya selesai dan commit/release-nya menghapus entri inFlight
  // milik R2 - sehingga pertanyaan ketiga diizinkan selagi R2 masih mengirim,
  // dan penonton bisa melihat balasan ganda. Dengan token, pegangan yang
  // kedaluwarsa hanya bisa menyentuh reservasinya SENDIRI.
  const inFlight = new Map();
  let seq = 0;

  function pruneReservations(t) {
    for (const [k, v] of inFlight) {
      if (t - v.at >= reservationTtlMs) inFlight.delete(k);
    }
  }

  // Hapus HANYA kalau entri yang ada memang milik token ini.
  function dropIfOwn(key, token) {
    const cur = inFlight.get(key);
    if (cur && cur.token === token) inFlight.delete(key);
  }

  function pruneCommitted(t) {
    if (lastSentAt.size <= MEMORY_LIMIT) return;
    for (const [k, v] of lastSentAt) {
      if (t - v >= cooldownMs) lastSentAt.delete(k);
      if (lastSentAt.size <= MEMORY_LIMIT) break;
    }
  }

  function keyOf(intent, identity) {
    return `${intent}|${identity}`;
  }

  // Keputusan murni-baca. Dipakai diagnostik dan tes; jalur produksi memakai
  // reserve(), karena hanya reserve() yang menutup celah balapan.
  function allow(intent, identity) {
    if (!identity) return { ok: false, reason: "qa-no-identity" };
    const t = now();
    pruneReservations(t);
    const key = keyOf(intent, identity);
    // Kiriman yang SEDANG berjalan untuk produk ini sudah memegang jedanya.
    if (inFlight.has(key)) {
      return { ok: false, reason: "qa-cooldown", inFlight: true, remainingMs: cooldownMs };
    }
    const prev = lastSentAt.get(key);
    if (prev === undefined) return { ok: true };
    const age = t - prev;
    if (age >= cooldownMs) return { ok: true };
    return { ok: false, reason: "qa-cooldown", remainingMs: cooldownMs - age, intent, identity };
  }

  // Memesan jeda produk ini SEBELUM kiriman dimulai.
  function reserve(intent, identity) {
    const gate = allow(intent, identity);
    if (!gate.ok) return gate;
    const key = keyOf(intent, identity);
    const t = now();
    const token = (seq += 1);
    inFlight.set(key, { at: t, token });
    return createHandle({
      onCommit: () => {
        dropIfOwn(key, token);
        // Stempelnya waktu KIRIMAN BERHASIL, bukan waktu reservasi: kebijakan
        // menyebut "30 detik sesudah kiriman berhasil".
        //
        // Dicatat walau reservasinya sudah kedaluwarsa: sebuah kiriman memang
        // berhasil, dan jedanya harus berlaku. Yang dijaga token hanyalah agar
        // entri inFlight milik reservasi LAIN tidak ikut terhapus.
        const t2 = now();
        lastSentAt.set(key, t2);
        pruneCommitted(t2);
      },
      onRelease: () => {
        dropIfOwn(key, token);
      },
    });
  }

  // Jalur commit tanpa reservasi. Dipertahankan untuk diagnostik dan tes;
  // produksi tidak memakainya.
  function note(intent, identity) {
    if (!identity) return;
    const t = now();
    inFlight.delete(keyOf(intent, identity));
    lastSentAt.set(keyOf(intent, identity), t);
    pruneCommitted(t);
  }

  return {
    allow,
    reserve,
    note,
    cooldownMs,
    reservationTtlMs,
    __state: () => ({
      size: lastSentAt.size,
      keys: [...lastSentAt.keys()],
      inFlight: [...inFlight.keys()],
    }),
  };
}

// ---------------------------------------------------------------------------
// PLAFON ADMISI GLOBAL PRODUCT Q&A
//
// Jeda per-produk SENDIRI tidak cukup, dan itu TERUKUR: dengan 5 produk di
// etalase, jeda 30 detik membuat tiap produk bisa dijawab dua kali per menit =
// 10 balasan diinginkan per menit, sementara plafon bersama AutoComment hanya
// 6. Hasilnya Q&A memenuhi SELURUH anggaran, dan karena maxPerMinute berlaku
// untuk prioritas tinggi juga (autocomment/core.js rateLimitReason: prioritas
// tinggi tidak punya jalan apa pun untuk melewatinya), balasan pin produk
// IKUT HILANG - terukur 2 dari 2, lalu 3 dari 5.
//
// Plafon ini BUKAN pengganti limiter global, dan bukan kelas prioritas ketiga.
// Ia hanya mencegah fitur BARU memakan habis anggaran balasan yang sudah ada.
//
// Yang MEMAKAI slot: kiriman yang terbukti berhasil, DAN kiriman yang hasilnya
// ambigu (lihat qa/price-qa.js). Kiriman yang terbukti gagal sebelum menyentuh
// TikTok, pertanyaan yang ter-dedupe, yang ambigu produknya, yang snapshot-nya
// basi, balasan aturan terkonfigurasi, dan balasan HIGH AutoPIN tidak pernah
// memakai slot - jalur-jalur itu tidak pernah melihat peta ini.
function createQaQuota({
  limit = DEFAULT_QUOTA_LIMIT,
  windowMs = DEFAULT_QUOTA_WINDOW_MS,
  now = () => Date.now(),
  reservationTtlMs = DEFAULT_RESERVATION_TTL_MS,
} = {}) {
  // stempel waktu kiriman Q&A yang TERBUKTI berhasil, urut naik
  const sentAt = [];
  // token -> saat reservasi dibuat
  const inFlight = new Map();
  let seq = 0;

  // Buang yang sudah keluar jendela. Batasnya >= : pada tepat 60 detik,
  // kiriman tertua SUDAH kedaluwarsa.
  function pruneSent(t) {
    while (sentAt.length && t - sentAt[0] >= windowMs) sentAt.shift();
  }

  function pruneReservations(t) {
    for (const [k, v] of inFlight) {
      if (t - v >= reservationTtlMs) inFlight.delete(k);
    }
  }

  // Slot terpakai = yang sudah terkirim di dalam jendela + yang sedang berjalan.
  // Menghitung reservasi di sinilah yang menutup celah balapan.
  function usedAt(t) {
    pruneSent(t);
    pruneReservations(t);
    return sentAt.length + inFlight.size;
  }

  function retryAfter(t) {
    const tertua = Math.min(
      sentAt.length ? sentAt[0] : Infinity,
      inFlight.size ? Math.min(...inFlight.values()) : Infinity
    );
    if (!Number.isFinite(tertua)) return 0;
    return Math.max(0, windowMs - (t - tertua));
  }

  function allow() {
    const t = now();
    const used = usedAt(t);
    if (used < limit) return { ok: true, used, limit };
    // TIDAK diantrekan untuk nanti: chat penonton bergerak cepat, dan jawaban
    // harga yang telat lebih buruk daripada diam.
    return { ok: false, reason: "qa-quota", used, limit, retryAfterMs: retryAfter(t) };
  }

  function reserve() {
    const gate = allow();
    if (!gate.ok) return gate;
    const token = (seq += 1);
    inFlight.set(token, now());
    return createHandle({
      onCommit: () => {
        inFlight.delete(token);
        const t = now();
        pruneSent(t);
        sentAt.push(t);
      },
      onRelease: () => {
        inFlight.delete(token);
      },
    });
  }

  // Jalur commit tanpa reservasi. Diagnostik dan tes saja.
  function note() {
    const t = now();
    pruneSent(t);
    sentAt.push(t);
  }

  return {
    allow,
    reserve,
    note,
    limit,
    windowMs,
    reservationTtlMs,
    __state: () => ({ used: sentAt.length + inFlight.size, sentAt: [...sentAt], inFlight: inFlight.size }),
  };
}

module.exports = {
  createQaDedupe,
  createQaQuota,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_QUOTA_LIMIT,
  DEFAULT_QUOTA_WINDOW_MS,
  DEFAULT_RESERVATION_TTL_MS,
  MEMORY_LIMIT,
};
