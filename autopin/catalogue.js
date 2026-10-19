"use strict";
// Snapshot katalog produk milik service AutoPIN: penyimpanan + kebijakan
// kesegaran. FUNGSI MURNI — tidak menyentuh browser, tidak menyentuh HTTP.
//
// --------------------------------------------------------------------------
// KENAPA SERVICE YANG MEMILIKINYA
//
// Profil Chrome terkunci SATU proses. Saat automation berjalan, service inilah
// yang memegangnya — Controller tidak bisa membaca etalase (terbukti LIVE
// 2026-10-19: panggilan produk balik kosong selagi profileOwner=automation),
// dan bot sengaja tidak pernah memuat Puppeteer. Jadi satu-satunya komponen
// yang BISA membaca katalog saat run adalah service.
//
// Dan sebagian besar pekerjaannya sudah dilakukan: setiap /pin membaca katalog
// LENGKAP sebelum mengklik (tahap collect-before, sengaja tidak dipotong
// anggaran supaya "ambigu" tidak berubah jadi "klik yang pertama ketemu").
// Modul ini hanya MENYIMPAN apa yang sudah dibaca.
//
// --------------------------------------------------------------------------
// KEBIJAKAN KESEGARAN
//
// Terukur (docs/dynamic-product-price-audit-v0.2.1.md):
//   waitForSettled halaman dingin   10.330 ms
//   harga tersedia sesudah settle        2 ms
//   baca ulang +8 detik             identik, 0 dari 4 baris berubah
//
// QUOTE_FRESH_MS = 30 detik: cukup pendek sehingga harga yang dikutip masih
// yang dilihat penonton di layar yang sama, dan pada LIVE aktif hampir selalu
// terpenuhi gratis karena setiap pemutaran scene produk menghasilkan snapshot
// penuh.
//
// HARD_STALE_MS = 120 detik: di atas ini datanya dianggap TIDAK ADA, bukan
// "tua". Bedanya penting — ok:false memaksa penolakan, sedangkan ageMs besar
// mengundang pemanggil berikutnya untuk "ya sudahlah, pakai saja".
//
// YANG TIDAK DIJANJIKAN: kesegaran promosi TikTok. Flash sale bisa berubah satu
// detik sesudah capturedAt dan tidak ada TTL yang bisa menangkap itu. TTL hanya
// membatasi seberapa tua data yang kita izinkan diri sendiri pakai.
const QUOTE_FRESH_MS = 30_000;
const HARD_STALE_MS = 120_000;

const COVERAGE = { FULL: "full", VIEWPORT: "viewport" };

// Bentuk produk yang keluar dari snapshot. Sempit dengan sengaja, dengan alasan
// yang sama seperti toPublicProduct di Controller: priceNodes, pinClass, icons,
// ariaOnRow, imageKey adalah struktur DOM internal TikTok dan tidak ada
// gunanya di luar modul pembaca.
function toSnapshotProduct(p) {
  const o = p && typeof p === "object" ? p : {};
  const str = (v) => (typeof v === "string" ? v : "");
  return {
    title: str(o.title),
    number: Number.isInteger(o.number) ? o.number : null,
    // null, dan TIDAK PERNAH dikarang dari nomor baris: nomor dibaca dari
    // aria-valuenow, yaitu posisi TERLIHAT, dan posisi bergeser setiap kali
    // daftar diurutkan ulang. Nomor sebagai identitas adalah identitas yang
    // berubah sendiri.
    stableId: o.stableId == null ? null : String(o.stableId),
    currentPriceText: str(o.currentPriceText),
    originalPriceText: str(o.originalPriceText),
    priceRangeText: str(o.priceRangeText),
    priceState: str(o.priceState) || "unknown",
    stockText: str(o.stockText) || str(o.stock),
    pinText: str(o.pinText),
    pinAvailable: Number(o.pinButtons) > 0,
    pinDisabled: o.pinDisabled === true,
    // --- alias kompatibilitas ---
    // Pembaca yang sudah ada memakai nama ini. Tidak dihapus, tidak diganti
    // nama. `price` sengaja BUKAN alias dari currentPriceText: lihat alasannya
    // di autopin/price.js — kartu yang tidak dipahami tetap boleh TAMPIL, yang
    // dilarang adalah DIKUTIP.
    price: str(o.price),
    stock: str(o.stock),
  };
}

// nowFn disuntikkan supaya kebijakan kesegaran bisa diuji tanpa menunggu nyata.
function createCatalogueStore({ now = () => Date.now() } = {}) {
  let last = null;

  // Dipanggil dari tempat service MEMANG sudah membaca katalog. Tidak boleh
  // pernah melempar: menyimpan snapshot tidak boleh bisa menggagalkan pin.
  function put({ products, coverage, source } = {}) {
    if (!Array.isArray(products)) return { ok: false, reason: "products-not-array" };
    if (coverage !== COVERAGE.FULL && coverage !== COVERAGE.VIEWPORT) {
      // Cakupan yang tidak jelas ditolak, bukan ditebak: "full" yang salah
      // membuat ketidakhadiran produk terlihat seperti bukti produk tidak ada.
      return { ok: false, reason: "unknown-coverage" };
    }
    last = {
      capturedAt: now(),
      coverage,
      source: typeof source === "string" && source ? source : "unknown",
      products: products.map(toSnapshotProduct),
    };
    return { ok: true, capturedAt: last.capturedAt, count: last.products.length };
  }

  function ageOf(snap) {
    return Math.max(0, now() - snap.capturedAt);
  }

  // Ambang efektif: pemanggil boleh lebih KETAT, tidak boleh lebih longgar.
  //
  // maxAgeMs = 0 TIDAK BISA DIPENUHI, dan itu disengaja. Pembacaan halaman
  // selalu memakan waktu, jadi sesudah penyegaran pun umurnya sudah beberapa
  // milidetik; permintaan "hanya data yang dibaca pada detik ini juga" memang
  // mustahil. Yang dipilih di sini adalah MENOLAK, bukan melonggarkan diam-diam
  // ke kebijakan bawaan: melonggarkan berarti pemanggil yang meminta ketat
  // justru dilayani data yang lebih tua dari yang ia minta. Jalur normal
  // memang tidak memakai 0 - ia mengosongkan maxAgeMs (kebijakan 30 detik)
  // atau menyebut angka yang masuk akal, dan ageMs selalu dilaporkan supaya
  // pemanggil bisa menolak sendiri.
  function effectiveMaxAge(maxAgeMs) {
    // null dan undefined berarti TIDAK DIISI, bukan nol. Number(null) === 0
    // adalah kecelakaan bahasa, bukan maksud pemanggil.
    if (maxAgeMs === null || maxAgeMs === undefined) return QUOTE_FRESH_MS;
    const n = Number(maxAgeMs);
    if (!Number.isFinite(n) || n < 0) return QUOTE_FRESH_MS;
    return Math.min(n, QUOTE_FRESH_MS);
  }

  // true berarti snapshot yang ada tidak memenuhi syarat dan penyegaran ringan
  // layak dicoba. Snapshot yang sudah melewati batas keras juga perlu disegarkan.
  function needsRefresh({ maxAgeMs } = {}) {
    if (!last) return true;
    return ageOf(last) > effectiveMaxAge(maxAgeMs);
  }

  function read({ maxAgeMs } = {}) {
    if (!last) return { ok: false, error: "product-snapshot-unavailable" };
    const ageMs = ageOf(last);
    // Di atas batas keras: dianggap tidak ada.
    if (ageMs > HARD_STALE_MS) {
      return { ok: false, error: "product-snapshot-unavailable", ageMs };
    }
    // Di antara ambang kutip dan batas keras: ADA, tapi tidak boleh dipakai.
    // Produknya TIDAK disertakan — satu-satunya cara memastikan data basi
    // tidak pernah ikut jalan bersama ok:true.
    if (ageMs > effectiveMaxAge(maxAgeMs)) {
      return {
        ok: false,
        error: "product-snapshot-stale",
        ageMs,
        capturedAt: last.capturedAt,
        coverage: last.coverage,
      };
    }
    return {
      ok: true,
      capturedAt: last.capturedAt,
      ageMs,
      coverage: last.coverage,
      source: last.source,
      products: last.products,
    };
  }

  // Diagnostik untuk /health. Tidak pernah membawa produk.
  function state() {
    if (!last) return { has: false };
    return {
      has: true,
      capturedAt: last.capturedAt,
      ageMs: ageOf(last),
      coverage: last.coverage,
      source: last.source,
      count: last.products.length,
      unknownPrice: last.products.filter((p) => p.priceState === "unknown").length,
    };
  }

  return { put, read, state, needsRefresh };
}

module.exports = {
  createCatalogueStore,
  toSnapshotProduct,
  QUOTE_FRESH_MS,
  HARD_STALE_MS,
  COVERAGE,
};
