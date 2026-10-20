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

// Kosakata cakupan, didefinisikan SATU KALI di sini dan diimpor oleh
// autopin/products.js. Dua definisi untuk hal yang sama adalah cara paling
// mudah membuat lapisan pembaca dan lapisan penyimpan menyimpang.
//
// UNKNOWN sengaja TIDAK BISA disimpan: lihat put(). Ia berarti "barisnya
// sendiri tidak boleh dipercaya", dan invarian penyimpanan ini adalah apa pun
// yang ada di dalamnya boleh dikutip kalau masih segar.
const COVERAGE = { FULL: "full", VIEWPORT: "viewport", UNKNOWN: "unknown" };

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
  const refusals = [];

  // `at` DIOPER, tidak dibaca ulang dari jam. Setiap pembacaan jam tambahan
  // adalah efek samping yang terlihat oleh pemanggil - tes memakai jam
  // pencacah (now: () => t += 1), dan put() yang membaca jam beberapa kali
  // menggeser umur yang diukur pemanggil berikutnya.
  function tolak(reason, at, extra) {
    refusals.push({ reason, at });
    if (refusals.length > 20) refusals.shift();
    return Object.assign({ ok: false, reason }, extra || {});
  }

  // Dipanggil dari tempat service MEMANG sudah membaca katalog. Tidak boleh
  // pernah melempar: menyimpan snapshot tidak boleh bisa menggagalkan pin.
  //
  // --------------------------------------------------------------------------
  // observedAt: KAPAN HALAMANNYA DIBACA, bukan kapan hasilnya diterbitkan
  //
  // Dulu capturedAt = now() pada saat put(). Untuk sapuan penuh yang memakan 6
  // detik, itu MELEBIH-LEBIHKAN kesegaran sebesar seluruh durasi pembacaan, dan
  // untuk task yang mengantre, sebesar seluruh waktu tunggunya. Kesegaran
  // sekarang selalu diukur dari pengamatan.
  //
  // --------------------------------------------------------------------------
  // KEBIJAKAN PENERBITAN
  //
  // Dua penolakan, dan keduanya menjawab satu balapan yang sudah terbukti bisa
  // terjadi: penyegaran ringan yang mengantre di belakang sapuan penuh, lalu
  // menimpa hasil sapuan itu dengan pembacaan viewport yang lebih tua nilainya.
  //
  //   out-of-order            pengamatan yang LEBIH TUA dari yang tersimpan
  //                           tidak boleh menang hanya karena datang terakhir.
  //   would-downgrade         viewport tidak boleh menggantikan full yang MASIH
  //                           BISA DIKUTIP. Di dalam jendela kutip keduanya sah
  //                           menurut kebijakan, jadi yang dipilih adalah yang
  //                           bisa menjawab lebih banyak - membuang cakupan
  //                           mematikan jalur nama sepenuhnya, sementara
  //                           membuang <=30 detik umur harga tidak mematikan
  //                           apa pun yang pernah dijanjikan.
  //
  // KESEGARAN TETAP MENANG. Penjaga downgrade hanya menyala selagi full yang
  // tersimpan masih di dalam QUOTE_FRESH_MS. Begitu ia basi, pengamatan
  // viewport yang benar-benar baru menggantikannya dan hasilnya dilaporkan
  // apa adanya sebagai coverage="viewport".
  function put({ products, coverage, source, observedAt } = {}) {
    // SATU pembacaan jam untuk seluruh pemanggilan. Lihat catatan di tolak().
    const sekarang = now();
    if (!Array.isArray(products)) return tolak("products-not-array", sekarang);
    if (coverage !== COVERAGE.FULL && coverage !== COVERAGE.VIEWPORT) {
      // Cakupan yang tidak jelas ditolak, bukan ditebak: "full" yang salah
      // membuat ketidakhadiran produk terlihat seperti bukti produk tidak ada.
      // COVERAGE.UNKNOWN ikut tertolak di sini, dan itu disengaja.
      return tolak("unknown-coverage", sekarang);
    }
    const n = Number(observedAt);
    const at = Number.isFinite(n) && n > 0 ? n : sekarang;

    if (last) {
      if (at < last.capturedAt) {
        return tolak("out-of-order", sekarang, { storedAt: last.capturedAt, observedAt: at });
      }
      const umurTersimpan = Math.max(0, sekarang - last.capturedAt);
      if (last.coverage === COVERAGE.FULL && coverage === COVERAGE.VIEWPORT && umurTersimpan <= QUOTE_FRESH_MS) {
        return tolak("would-downgrade", sekarang, { storedCoverage: last.coverage, storedAgeMs: umurTersimpan });
      }
    }

    last = {
      capturedAt: at,
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

  // Apakah ada snapshot FULL yang masih bisa dikutip dan TIDAK lebih tua dari
  // `since`? Dipakai jalur penyegaran ringan sesudah ia dapat giliran: kalau
  // sudah ada yang lebih baru dan lebih lengkap, pembacaannya memang mubazir.
  function hasFreshFullSince(since) {
    if (!last || last.coverage !== COVERAGE.FULL) return false;
    const n = Number(since);
    if (Number.isFinite(n) && last.capturedAt < n) return false;
    return ageOf(last) <= QUOTE_FRESH_MS;
  }

  // Diagnostik untuk /health. Tidak pernah membawa produk.
  function state() {
    if (!last) return { has: false, refusals: refusals.slice(-5) };
    return {
      has: true,
      refusals: refusals.slice(-5),
      capturedAt: last.capturedAt,
      ageMs: ageOf(last),
      coverage: last.coverage,
      source: last.source,
      count: last.products.length,
      unknownPrice: last.products.filter((p) => p.priceState === "unknown").length,
    };
  }

  return { put, read, state, needsRefresh, hasFreshFullSince };
}

module.exports = {
  createCatalogueStore,
  toSnapshotProduct,
  QUOTE_FRESH_MS,
  HARD_STALE_MS,
  COVERAGE,
};
