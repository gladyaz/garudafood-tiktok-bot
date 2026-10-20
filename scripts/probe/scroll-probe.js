"use strict";
// Validasi gulir terkendali: apakah container yang DIPILIH PRODUKSI benar-benar
// menggerakkan virtualizer TikTok dan memunculkan baris yang belum ter-render?
//
// ---------------------------------------------------------------------------
// APA YANG BERBEDA DARI PROBE SEBELUMNYA
//
// Probe pertama (dom-probe-page.js) TIDAK PERNAH menulis scrollTop. Yang ini
// BOLEH - dan hanya itu yang berubah. Klik, ketik, filter, pin, penyusunan
// ulang DOM tetap tidak ada di sini sama sekali.
//
// ---------------------------------------------------------------------------
// TIDAK ADA LOGIKA GULIR BARU DI REPO INI
//
// Dua-duanya fungsi PRODUKSI, dipakai apa adanya lewat page.evaluate:
//
//   scrollProductListInPage(SELECTORS, step)   menggulir satu gelombang
//   resetScrollInPage(SELECTORS)               mengembalikan scrollTop ke 0
//
// Tidak ada simulasi roda mouse. Tidak ada window.scrollTo. Tidak ada
// penulisan scrollTop yang ditulis sendiri oleh alat ini. Kalau validasi ini
// lulus, yang terbukti adalah perilaku PRODUKSI, bukan perilaku sesuatu yang
// mirip produksi.
//
// ---------------------------------------------------------------------------
// CONTAINER YANG DIGULIR DIVERIFIKASI LEBIH DULU
//
// Identitas container TIDAK diselesaikan ulang di sini - itu akan jadi salinan
// ketiga dari jalan-naik yang sama. Ia dibaca dari readScrollAncestorsInPage
// yang SUDAH memakai kondisi produksi (`scrollHeight > clientHeight + 10`),
// lalu DITUNTUT memenuhi tiga hal sebelum satu pun gulir terjadi:
//
//   1. ia elemen yang AKAN dipilih produksi (wouldPickDepth)
//   2. ia container virtualisasi itu sendiri
//   3. overflow-y-nya auto atau scroll
//
// Kalau salah satu tidak terpenuhi, alat ini BERHENTI tanpa menggulir apa pun.

const EPS_BOTTOM = 2;
const DEFAULT_STEP = 400; // default collectProducts di autopin/products.js
const DEFAULT_MAX_WAVES = 3;

// Sidik jari container: cukup untuk mendeteksi "yang digulir berpindah elemen"
// tanpa menyimpan referensi DOM apa pun.
function fingerprintOf(a) {
  if (!a) return "";
  return a.depth + "|" + a.tag + "|" + String(a.className || "").slice(0, 60);
}

function bottomReached(a) {
  if (!a) return false;
  return Number(a.scrollTop) + Number(a.clientHeight) >= Number(a.scrollHeight) - EPS_BOTTOM;
}

// Apakah container yang akan digulir memang container daftar produk?
function verifyScroller(geometry) {
  if (!geometry || geometry.rowFound !== true) return { ok: false, reason: "no-rows" };
  const d = geometry.wouldPickDepth;
  if (d === null || d === undefined) return { ok: false, reason: "no-scroll-container" };
  const a = geometry.ancestors[d];
  if (!a) return { ok: false, reason: "ancestor-missing" };
  if (a.isVirtualizedContainer !== true) return { ok: false, reason: "picked-not-virtualized", fingerprint: fingerprintOf(a) };
  if (a.scrollable !== true) return { ok: false, reason: "picked-not-scrollable", fingerprint: fingerprintOf(a) };
  return { ok: true, depth: d, fingerprint: fingerprintOf(a), geom: a };
}

const geomOf = (a) => ({ scrollTop: a.scrollTop, scrollHeight: a.scrollHeight, clientHeight: a.clientHeight, atBottom: bottomReached(a) });

// Orkestrasi MURNI: setiap pembacaan dan setiap gulir disuntikkan, jadi seluruh
// jalur berhenti-dini dan jalur berhenti-karena-tidak-konsisten bisa diuji
// tanpa browser.
//
// deps:
//   readAncestors()  -> hasil readScrollAncestorsInPage
//   readRows()       -> hasil readRowsInPage
//   readStrip()      -> hasil readStripInPage
//   readScope()      -> "clean" | "dirty" | "unknown"
//   scrollWave()     -> hasil scrollProductListInPage PRODUKSI
//   resetScroll()    -> hasil resetScrollInPage PRODUKSI
//   settle()         -> menunggu baris virtual selesai dirender
async function scrollValidation({
  readAncestors, readRows, readStrip, readScope,
  scrollWave, resetScroll, settle,
  maxWaves = DEFAULT_MAX_WAVES,
} = {}) {
  const hasil = {
    ok: false,
    stopReason: "",
    baseline: null,
    waves: [],
    uniquePositions: [],
    candidateTotalStable: null,
    scrollerStable: null,
    scopeStable: null,
    restored: null,
    bottomReached: false,
    totalSatisfied: false,
  };

  // --- BASELINE, sebelum apa pun digulir ---
  const geom0 = await readAncestors();
  const v0 = verifyScroller(geom0);
  if (!v0.ok) {
    hasil.stopReason = "scroller-unverified:" + v0.reason;
    return hasil;
  }
  const rows0 = await readRows();
  const strip0 = await readStrip();
  const scope0 = await readScope();

  const total = strip0 && strip0.state === "ok" ? strip0.candidateTotal : null;
  hasil.baseline = {
    scope: scope0,
    candidateTotal: total,
    stripState: strip0 ? strip0.state : "?",
    rowMarkers: rows0.rowMarkers,
    numbers: rows0.numbers.slice(),
    initialized: rows0.initialized,
    scroller: { depth: v0.depth, fingerprint: v0.fingerprint, ...geomOf(v0.geom) },
  };

  // Gerbang baseline. Semuanya FAIL-CLOSED: ragu berarti tidak menggulir.
  if (scope0 !== "clean") { hasil.stopReason = "scope-not-clean:" + scope0; return hasil; }
  if (!Number.isInteger(total) || total <= 0) { hasil.stopReason = "candidate-total-unusable"; return hasil; }
  if (rows0.initialized !== true) { hasil.stopReason = "rows-not-initialized"; return hasil; }
  // scrollTop awal HARUS 0. Pemulihannya memakai resetScrollInPage PRODUKSI,
  // yang mengembalikan ke 0 - jadi kalau titik awalnya bukan 0, alat ini tidak
  // punya cara mengembalikan keadaan tanpa menulis logika gulir sendiri.
  if (Number(v0.geom.scrollTop) !== 0) { hasil.stopReason = "baseline-scrolltop-not-zero"; return hasil; }

  const terlihat = new Set(rows0.numbers);
  const semuaTerlihat = () => {
    for (let i = 1; i <= total; i += 1) if (!terlihat.has(i)) return false;
    return true;
  };

  hasil.candidateTotalStable = true;
  hasil.scrollerStable = true;
  hasil.scopeStable = true;

  if (semuaTerlihat()) {
    hasil.totalSatisfied = true;
    hasil.ok = true;
    hasil.stopReason = "total-satisfied-at-baseline";
    hasil.uniquePositions = [...terlihat].sort((a, b) => a - b);
    return hasil;
  }
  if (bottomReached(v0.geom)) {
    hasil.bottomReached = true;
    hasil.stopReason = "bottom-at-baseline-but-total-unsatisfied";
    hasil.uniquePositions = [...terlihat].sort((a, b) => a - b);
    return hasil;
  }

  // --- GELOMBANG GULIR ---
  let selesai = "";
  for (let w = 1; w <= maxWaves; w += 1) {
    const sebelum = hasil.waves.length ? hasil.waves[hasil.waves.length - 1].after : geomOf(v0.geom);

    const s = await scrollWave();
    await settle();

    const geom = await readAncestors();
    const v = verifyScroller(geom);
    const rows = await readRows();
    const strip = await readStrip();
    const scope = await readScope();

    const wave = {
      wave: w,
      beforeScrollTop: sebelum.scrollTop,
      scrolled: s && s.scrolled === true,
      scrollReason: s && s.reason ? s.reason : "",
      after: v.ok ? geomOf(v.geom) : null,
      visible: rows.numbers.slice(),
      rowMarkers: rows.rowMarkers,
      initialized: rows.initialized,
      scope,
      candidateTotal: strip && strip.state === "ok" ? strip.candidateTotal : null,
      fingerprint: v.ok ? v.fingerprint : "",
      bottom: v.ok ? bottomReached(v.geom) : null,
    };
    for (const n of rows.numbers) terlihat.add(n);
    wave.uniqueAfter = [...terlihat].sort((a, b) => a - b);
    hasil.waves.push(wave);

    // --- konsistensi (kondisi C) ---
    if (!v.ok) { hasil.scrollerStable = false; selesai = "scroller-lost:" + v.reason; break; }
    if (v.fingerprint !== v0.fingerprint) { hasil.scrollerStable = false; selesai = "scroller-changed"; break; }
    if (scope !== "clean") { hasil.scopeStable = false; selesai = "scope-changed:" + scope; break; }
    if (wave.candidateTotal !== total) { hasil.candidateTotalStable = false; selesai = "candidate-total-changed"; break; }
    if (rows.initialized !== true) { selesai = "rows-not-initialized"; break; }

    // --- berhenti dini (kondisi A dan B) ---
    if (semuaTerlihat()) { hasil.totalSatisfied = true; selesai = "total-satisfied"; break; }
    if (wave.bottom === true) { hasil.bottomReached = true; selesai = "bottom-reached"; break; }
    if (!wave.scrolled) { selesai = "scroll-ineffective"; break; }
    // Tidak ada `if (w === maxWaves) break` di sini: batas gelombangnya ADALAH
    // kondisi `for` di atas, dan `selesai || "max-waves"` di bawah yang memberi
    // namanya. Menuliskannya dua kali membuat salah satunya kode mati - dan
    // kode mati di pembatas keselamatan adalah pembatas yang tidak bisa
    // dibuktikan bekerja.
  }

  hasil.uniquePositions = [...terlihat].sort((a, b) => a - b);
  hasil.stopReason = selesai || "max-waves";

  // --- PEMULIHAN: selalu dicoba, apa pun yang terjadi di atas ---
  try {
    const r = await resetScroll();
    await settle();
    const geomAkhir = await readAncestors();
    const vAkhir = verifyScroller(geomAkhir);
    hasil.restored = {
      requested: 0,
      ok: vAkhir.ok ? Number(vAkhir.geom.scrollTop) === 0 : false,
      scrollTop: vAkhir.ok ? Number(vAkhir.geom.scrollTop) : null,
      resetReported: r && r.ok === true,
      scopeAfter: await readScope(),
      fingerprintAfter: vAkhir.ok ? vAkhir.fingerprint : "",
    };
  } catch (err) {
    hasil.restored = { requested: 0, ok: false, scrollTop: null, error: String((err && err.message) || "").slice(0, 120) };
  }

  hasil.ok = hasil.totalSatisfied === true || hasil.bottomReached === true;
  return hasil;
}

module.exports = { scrollValidation, verifyScroller, fingerprintOf, bottomReached, EPS_BOTTOM, DEFAULT_STEP, DEFAULT_MAX_WAVES };
