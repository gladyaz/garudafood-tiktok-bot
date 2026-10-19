"use strict";
// Resolusi produk untuk PERTANYAAN penonton. BACA-SAJA, GAGAL-TERTUTUP.
//
// Sumbernya HANYA snapshot milik service AutoPIN (GET /products, fondasi
// v0.2.2). Tidak ada Chrome kedua, tidak ada discovery Controller, tidak ada
// data katalog yang ditebak.
//
// ---------------------------------------------------------------------------
// URUTAN IDENTITAS
//
//   1. stableId         — didahulukan di kode, DORMAN hari ini: DOM TikTok
//                         tidak mengeksposnya dan toSnapshotProduct
//                         melaporkannya null tanpa pernah mengarang. Tidak ada
//                         cara penonton menyebutnya, jadi jalur ini hanya
//                         terpakai lewat pemanggil internal.
//   2. judul ternormalkan — PERSIS dulu, lalu tumpang-tindih token.
//   3. nomor TERLIHAT   — hanya kalau penonton menyebut penandanya sendiri.
//
// Nomor TIDAK PERNAH menjadi identitas tersimpan: ia dibaca dari aria-valuenow,
// yaitu POSISI, dan posisi bergeser setiap kali daftar diurutkan ulang.
//
// ---------------------------------------------------------------------------
// KECUKUPAN COVERAGE — asimetri yang WAJIB ada
//
//   resolusi lewat JUDUL  butuh coverage="full".
//     Pada "viewport", produk kedua yang cocok bisa berada DI BAWAH LIPATAN.
//     "Ambigu" lalu berubah diam-diam menjadi "unik", dan kita mengutip produk
//     yang SALAH. Ini kelas kegagalan yang sama dengan collect-incomplete-budget
//     di jalur pin.
//
//   resolusi lewat NOMOR  boleh "viewport".
//     Nomor dibaca dari baris itu sendiri, jadi baris yang ADA di snapshot pasti
//     baris yang benar. Yang mengancam di sini bukan cakupan melainkan
//     kesegaran, dan itu dijaga TTL 30 detik di fondasi.
//
// Ketidakhadiran produk dari snapshot "viewport" BUKAN bukti produk itu tidak
// ada — karena itu alasannya "coverage-insufficient", bukan "product-not-found".

const { normalizeTitleKey } = require("../autopin/core");

const COVERAGE_FULL = "full";

// Token judul produk. normalizeTitleKey PRODUKSI yang dipakai — DIIMPOR, bukan
// disalin: salinan normalisasi judul selalu menyimpang.
function titleTokens(product) {
  const key = normalizeTitleKey(product && product.title);
  return new Set(key.split(" ").filter((t) => t.length >= 3));
}

// query:
//   { stableId }                      -> jalur identitas kuat
//   { titleKey }                      -> judul persis / containment
//   { words: [...], number: n|null }  -> dari detectPriceIntent
function resolveProductForQuestion(snapshot, query = {}) {
  const coverage = snapshot && typeof snapshot.coverage === "string" ? snapshot.coverage : "";
  const list = snapshot && Array.isArray(snapshot.products) ? snapshot.products : [];
  if (!list.length) return { ok: false, reason: "catalogue-empty" };

  // --- 1. stableId -------------------------------------------------------
  const stableId = query.stableId == null ? "" : String(query.stableId).trim();
  if (stableId) {
    const hit = list.filter((p) => p && p.stableId != null && String(p.stableId) === stableId);
    if (hit.length === 1) return { ok: true, product: hit[0], via: "stableId" };
    if (hit.length > 1) return { ok: false, reason: "ambiguous-product", count: hit.length };
    // Identitas kuat yang tidak ketemu TIDAK jatuh ke identitas lemah.
    return { ok: false, reason: "product-not-found" };
  }

  // --- 3. nomor terlihat, hanya kalau penonton menyebutnya ----------------
  // Diperiksa sebelum judul: kalau penonton menyebut nomor secara eksplisit,
  // itulah yang ia maksud, dan jalur ini juga sah pada coverage "viewport".
  if (Number.isInteger(query.number)) {
    const hit = list.filter((p) => p && p.number === query.number);
    if (hit.length === 1) return { ok: true, product: hit[0], via: "visible-number" };
    if (hit.length > 1) return { ok: false, reason: "ambiguous-number", count: hit.length };
    // Nomor tidak ada di snapshot. Pada snapshot sebagian itu bukan bukti.
    return {
      ok: false,
      reason: coverage === COVERAGE_FULL ? "number-not-in-catalogue" : "coverage-insufficient",
      coverage,
    };
  }

  // --- 2. judul ----------------------------------------------------------
  // Mulai dari sini resolusi bersandar pada KEUNIKAN di dalam daftar, jadi
  // daftarnya harus LENGKAP.
  if (coverage !== COVERAGE_FULL) {
    return { ok: false, reason: "coverage-insufficient", coverage };
  }

  // 2a. judul PERSIS
  const want = normalizeTitleKey(query.titleKey);
  if (want) {
    const exact = list.filter((p) => normalizeTitleKey(p && p.title) === want);
    if (exact.length === 1) return { ok: true, product: exact[0], via: "title-exact" };
    if (exact.length > 1) return { ok: false, reason: "ambiguous-product", count: exact.length };
    const part = list.filter((p) => normalizeTitleKey(p && p.title).includes(want));
    if (part.length === 1) return { ok: true, product: part[0], via: "title-contains" };
    if (part.length > 1) return { ok: false, reason: "ambiguous-product", count: part.length };
    return { ok: false, reason: "product-not-found" };
  }

  // 2b. tumpang-tindih token
  const words = Array.isArray(query.words) ? query.words.filter((w) => typeof w === "string" && w.length >= 3) : [];
  if (!words.length) return { ok: false, reason: "no-product-reference" };

  const scored = list.map((p) => {
    const tokens = titleTokens(p);
    const hits = words.filter((w) => tokens.has(w));
    return { product: p, hits, score: hits.length };
  });
  const best = Math.max(...scored.map((s) => s.score));
  if (best === 0) return { ok: false, reason: "product-not-found", score: 0 };

  const top = scored.filter((s) => s.score === best);
  if (top.length > 1) {
    // SELALU ditolak. Tidak ada "ambil yang pertama", tidak ada "ambil yang
    // skornya paling tinggi tipis". Menyebut harga produk yang salah lebih
    // merusak daripada diam — pelajaran hotfix v0.2.1.
    return {
      ok: false,
      reason: "ambiguous-product",
      count: top.length,
      candidates: top.map((s) => s.product.number),
      score: best,
    };
  }
  return { ok: true, product: top[0].product, via: "title-tokens", score: best, hits: top[0].hits };
}

// Identitas untuk DEDUPE. stableId kalau ada, kalau tidak judul ternormalkan.
// Nomor TIDAK PERNAH dipakai: ia bergeser, dan kunci dedupe yang bergeser
// berarti produk yang sama bisa dijawab dua kali.
function productIdentity(product) {
  const p = product && typeof product === "object" ? product : {};
  if (p.stableId != null && String(p.stableId).trim() !== "") return `id:${String(p.stableId).trim()}`;
  const key = normalizeTitleKey(p.title);
  return key ? `title:${key}` : "";
}

module.exports = { resolveProductForQuestion, productIdentity, titleTokens, COVERAGE_FULL };
