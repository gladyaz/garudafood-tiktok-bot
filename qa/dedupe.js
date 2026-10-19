"use strict";
// Jeda per-produk untuk Product Q&A. MELUNCUR, bukan ember per menit kalender.
//
// ---------------------------------------------------------------------------
// KENAPA MELUNCUR, BUKAN EMBER MENIT
//
// Ember menit kalender punya tepi: dua pertanyaan yang hanya berjarak satu
// detik tapi menyeberangi pergantian menit akan dijawab DUA KALI, sementara dua
// pertanyaan berjarak 59 detik di dalam menit yang sama hanya dijawab sekali.
// Jeda yang meluncur memberi jaminan yang sama di mana pun titik waktunya.
//
// ---------------------------------------------------------------------------
// JENDELA DIMULAI SESUDAH KIRIMAN TERBUKTI, BUKAN SAAT DIMINTA
//
// Kalau jendelanya mulai saat permintaan masuk, satu kiriman yang GAGAL akan
// membungkam produk itu selama 30 detik tanpa pernah ada satu pun penonton yang
// mendapat jawaban. Jadi `note()` dipanggil HANYA sesudah AutoComment melapor
// berhasil. Kiriman yang gagal tidak memakan jendela apa pun.
//
// ---------------------------------------------------------------------------
// LINGKUPNYA SEMPIT, DAN ITU DISENGAJA
//
// Peta ini hanya dilihat oleh jalur Q&A. Ia TIDAK bisa membungkam balasan
// aturan terkonfigurasi, TIDAK bisa membungkam balasan HIGH AutoPIN, dan TIDAK
// menyentuh semantik stale/playId AutoComment — jalur-jalur itu tidak pernah
// memanggil modul ini.
//
// Kuncinya identitas produk, BUKAN nomor etalase: nomor bergeser sesudah pin,
// dan kunci yang bergeser berarti produk yang sama bisa dijawab dua kali.

const DEFAULT_COOLDOWN_MS = 30_000;

// Batas ingatan. Satu entri per produk yang pernah dijawab; katalog LIVE
// berukuran puluhan, jadi ini sangat longgar. Ada supaya run yang sangat
// panjang tidak menumbuhkan peta tanpa batas.
const MEMORY_LIMIT = 500;

function createQaDedupe({ cooldownMs = DEFAULT_COOLDOWN_MS, now = () => Date.now() } = {}) {
  // identitas -> stempel waktu kiriman TERBUKTI terakhir
  const lastSentAt = new Map();

  function prune(t) {
    if (lastSentAt.size <= MEMORY_LIMIT) return;
    for (const [k, v] of lastSentAt) {
      if (t - v >= cooldownMs) lastSentAt.delete(k);
      if (lastSentAt.size <= MEMORY_LIMIT) break;
    }
  }

  // Boleh menjawab untuk identitas ini?
  //   { ok:true }
  //   { ok:false, reason:"qa-cooldown", remainingMs, intent, identity }
  function allow(intent, identity) {
    const key = `${intent}|${identity}`;
    if (!identity) return { ok: false, reason: "qa-no-identity" };
    const prev = lastSentAt.get(key);
    if (prev === undefined) return { ok: true };
    const t = now();
    const age = t - prev;
    if (age >= cooldownMs) return { ok: true };
    return { ok: false, reason: "qa-cooldown", remainingMs: cooldownMs - age, intent, identity };
  }

  // Dipanggil HANYA sesudah kiriman TERBUKTI berhasil.
  function note(intent, identity) {
    if (!identity) return;
    const t = now();
    lastSentAt.set(`${intent}|${identity}`, t);
    prune(t);
  }

  return {
    allow,
    note,
    cooldownMs,
    // diagnostik; bukan bagian jalur chat
    __state: () => ({ size: lastSentAt.size, keys: [...lastSentAt.keys()] }),
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
// Jendelanya MELUNCUR, bukan ember menit kalender: ember punya tepi, dan dua
// jawaban berjarak satu detik yang menyeberangi pergantian menit akan lolos
// berdua.
//
// Yang DIHITUNG hanya kiriman Q&A yang TERBUKTI berhasil. Kiriman gagal,
// pertanyaan yang ter-dedupe, yang ambigu, yang snapshot-nya basi, balasan
// aturan terkonfigurasi, dan balasan HIGH AutoPIN tidak pernah memakai slot -
// peta ini tidak pernah dilihat oleh jalur-jalur itu.
const DEFAULT_QUOTA_LIMIT = 2;
const DEFAULT_QUOTA_WINDOW_MS = 60_000;

function createQaQuota({ limit = DEFAULT_QUOTA_LIMIT, windowMs = DEFAULT_QUOTA_WINDOW_MS, now = () => Date.now() } = {}) {
  // stempel waktu kiriman Q&A yang TERBUKTI berhasil, urut naik
  const sentAt = [];

  // Buang yang sudah keluar jendela. Batasnya >= : pada tepat 60 detik, kiriman
  // tertua SUDAH kedaluwarsa.
  function prune(t) {
    while (sentAt.length && t - sentAt[0] >= windowMs) sentAt.shift();
  }

  function allow() {
    const t = now();
    prune(t);
    if (sentAt.length < limit) return { ok: true, used: sentAt.length, limit };
    // TIDAK diantrekan untuk nanti: chat penonton bergerak cepat, dan jawaban
    // harga yang telat lebih buruk daripada diam.
    return {
      ok: false,
      reason: "qa-quota",
      used: sentAt.length,
      limit,
      retryAfterMs: windowMs - (t - sentAt[0]),
    };
  }

  // Dipanggil HANYA sesudah kiriman TERBUKTI berhasil.
  function note() {
    const t = now();
    prune(t);
    sentAt.push(t);
  }

  return {
    allow,
    note,
    limit,
    windowMs,
    __state: () => ({ used: sentAt.length, sentAt: [...sentAt] }),
  };
}

module.exports = {
  createQaDedupe,
  createQaQuota,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_QUOTA_LIMIT,
  DEFAULT_QUOTA_WINDOW_MS,
  MEMORY_LIMIT,
};
