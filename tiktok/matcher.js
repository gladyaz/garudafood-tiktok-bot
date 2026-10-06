"use strict";
// Pencocokan fuzzy yang disaring lebih dulu, bukan dihitung ke semua keyword.
//
// ---------------------------------------------------------------------------
// MASALAH YANG DIPERBAIKI
//
// Diukur pada 2026-10-05: setiap pesan yang TIDAK cocok persis dibandingkan
// Levenshtein ke 616 keyword, dan satu pesan memakan 6,79 ms. Kapasitasnya
// ~147 pesan/detik di satu thread - dan thread itu sama dengan yang menangani
// event OBS serta deteksi media-end. Jadi ledakan 100 komentar serentak
// menyumbat event loop ~679 ms, dan perpindahan scene ikut telat.
//
// Biaya terbesarnya bukan algoritmanya, tapi 616 alokasi matriks DP per pesan.
//
// ---------------------------------------------------------------------------
// KENAPA PENYARINGANNYA AMAN
//
// Kecocokan butuh `1 - dist/maxLen >= ambang`, jadi `dist <= (1-ambang)*maxLen`.
// Edit distance punya dua batas bawah yang murah dihitung:
//
//   dist >= |panjangA - panjangB|
//   dist >= jumlah_selisih_histogram_karakter / 2
//
// Kalau salah satu batas bawah itu sudah melewati jarak yang diizinkan,
// keyword tersebut MUSTAHIL mencapai ambang - jadi melewatinya tidak mungkin
// menghilangkan kecocokan. Ini bukan heuristik yang "biasanya benar": ia
// benar secara aritmetika.
//
// Dan karena jawaban lama adalah "keyword terbaik di antara SEMUA, lalu
// dibandingkan ambang", sedangkan yang terbaik itu - kalau ia memang mencapai
// ambang - pasti lolos penyaring, hasilnya IDENTIK. Urutan iterasi dan
// perbandingan `>` yang ketat juga dipertahankan supaya pemenang saat skor
// seri tetap keyword yang sama seperti sebelumnya.
//
// Levenshtein-nya sendiri ditulis ulang dengan dua baris bergulir (tanpa
// matriks) plus penghentian dini begitu seluruh baris melewati jarak yang
// diizinkan. Hasilnya tetap sama; yang hilang hanya pekerjaan yang tidak
// pernah bisa mengubah keputusan.
//
// Anggaran kerja: ada batas total sel DP per pesan. Normalnya tidak pernah
// tersentuh; ia ada supaya lalu lintas patologis tidak bisa menyumbat event
// loop yang juga memegang OBS dan media-end. Kalau tersentuh, itu DILAPORKAN,
// tidak disembunyikan.

const DEFAULT_THRESHOLD = 0.55;
// Satu pesan 30 karakter melawan 616 keyword ~12 karakter adalah ~220k sel
// kalau tanpa saringan. Anggaran ini jauh di atas kebutuhan normal sesudah
// disaring (terukur: ratusan sel), jadi ia murni jaring pengaman.
const DEFAULT_BUDGET_CELLS = 60_000;

// Levenshtein dengan dua baris bergulir dan ambang batas.
// Mengembalikan jarak sebenarnya, atau angka > maxDist kalau sudah pasti
// melewatinya (nilainya tidak dipakai selain untuk ditolak).
function levenshteinCapped(a, b, maxDist) {
  const m = a.length;
  const n = b.length;
  if (m === 0 || n === 0) return Math.max(m, n);
  if (Math.abs(m - n) > maxDist) return maxDist + 1;

  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;

  for (let i = 1; i <= m; i += 1) {
    cur[0] = i;
    let rowMin = cur[0];
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j += 1) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    // Seluruh baris sudah melewati batas: baris berikutnya tidak bisa turun.
    if (rowMin > maxDist) return maxDist + 1;
    const t = prev;
    prev = cur;
    cur = t;
  }
  return prev[n];
}

// Histogram karakter sebagai Map kode->jumlah. Dihitung sekali per keyword saat
// indeks dibangun, dan sekali per pesan.
function histogram(s) {
  const h = new Map();
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    h.set(c, (h.get(c) || 0) + 1);
  }
  return h;
}

// Batas bawah edit distance dari selisih histogram, dibagi dua karena satu
// substitusi memperbaiki dua selisih sekaligus.
function histLowerBound(ha, hb) {
  let diff = 0;
  for (const [c, n] of ha) {
    const m = hb.get(c) || 0;
    if (n > m) diff += n - m;
  }
  for (const [c, n] of hb) {
    const m = ha.get(c) || 0;
    if (n > m) diff += n - m;
  }
  return Math.ceil(diff / 2);
}

// Indeks dibangun dari rule AKTIF, dalam urutan yang sama dengan pencocokan
// lama: rule demi rule, keyword demi keyword.
function buildMatcherIndex(rules, { normalize } = {}) {
  const norm = typeof normalize === "function" ? normalize : (v) => String(v ?? "");
  const entries = [];
  for (const rule of rules) {
    if (!Array.isArray(rule.keywords)) continue;
    for (const kw of rule.keywords) {
      const n = norm(kw);
      if (!n) continue;
      entries.push({ rule, keyword: kw, norm: n, len: n.length, hist: histogram(n) });
    }
  }
  return { entries, size: entries.length };
}

// Padanan persis dari fallback fuzzy lama, tapi hanya menghitung kandidat yang
// secara aritmetika MASIH MUNGKIN mencapai ambang.
function matchFuzzy(index, msgNorm, { threshold = DEFAULT_THRESHOLD, budgetCells = DEFAULT_BUDGET_CELLS } = {}) {
  const stats = { candidates: 0, calls: 0, cells: 0, skippedLength: 0, skippedHist: 0, budgetExceeded: false };
  if (!index || !msgNorm) return { rule: null, score: 0, keyword: null, stats };

  const la = msgNorm.length;
  const ha = histogram(msgNorm);
  const slack = 1 - threshold;

  let best = { score: 0, rule: null, keyword: null };

  for (const e of index.entries) {
    const maxLen = la > e.len ? la : e.len;
    // Jarak maksimum yang masih bisa mencapai ambang.
    const allowed = Math.floor(slack * maxLen);

    if (Math.abs(la - e.len) > allowed) {
      stats.skippedLength += 1;
      continue;
    }
    if (histLowerBound(ha, e.hist) > allowed) {
      stats.skippedHist += 1;
      continue;
    }

    stats.candidates += 1;
    const cost = la * e.len;
    if (stats.cells + cost > budgetCells) {
      // Anggaran habis. Dilaporkan, bukan didiamkan: pemanggil yang memutuskan
      // apa artinya, dan OBS tidak boleh menunggu kita lebih lama lagi.
      stats.budgetExceeded = true;
      break;
    }
    stats.cells += cost;
    stats.calls += 1;

    const dist = levenshteinCapped(msgNorm, e.norm, allowed);
    if (dist > allowed) continue;

    const score = maxLen === 0 ? 1 : 1 - dist / maxLen;
    // `>` yang ketat, sama seperti sebelumnya: saat seri, keyword yang LEBIH
    // DULU dalam urutan indeks yang menang.
    if (score > best.score) best = { score, rule: e.rule, keyword: e.keyword };
  }

  if (best.rule && best.score >= threshold) return { ...best, stats };
  return { rule: null, score: best.score, keyword: best.keyword, stats };
}

module.exports = {
  buildMatcherIndex,
  matchFuzzy,
  levenshteinCapped,
  histogram,
  histLowerBound,
  DEFAULT_THRESHOLD,
  DEFAULT_BUDGET_CELLS,
};
