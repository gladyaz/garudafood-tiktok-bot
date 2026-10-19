"use strict";
// Klasifikasi harga produk dari bukti DOM yang sudah dibaca. FUNGSI MURNI.
//
// Kenapa klasifikasinya di sini dan BUKAN di dalam halaman: readProductsInPage
// dieksekusi lewat page.evaluate, jadi ia harus self-contained dan tidak bisa
// mengimpor apa pun. Kalau aturannya ikut tinggal di sana, satu-satunya cara
// mengujinya adalah lewat tiruan DOM — dan tiruan yang bentuknya dikarang sudah
// pernah meloloskan tiga bug sekaligus. Jadi pembagiannya tegas:
//
//   di dalam halaman : melaporkan FAKTA  — teks ber-"Rp" apa adanya, dan apakah
//                      simpulnya cocok selector harga utama / harga pembanding
//   di sini          : memutuskan ARTINYA — single / sale / unknown
//
// --------------------------------------------------------------------------
// BUKTI DOM (LIVE 2026-10-19, 4 kartu, lihat docs/dynamic-product-price-audit-v0.2.1.md)
//
//              harga sekarang              harga pembanding
//   kelas      text-body-l-medium          … text-neutral-text4 text-body-s ml-4
//   ukuran     16px                        12px
//   berat      500                         400
//   warna      rgb(0,0,0)                  rgba(0,0,0,0.35)
//   decoration none                        none   <-- BUKAN dicoret CSS
//
// Harga pembanding TIDAK dicoret: aturan berbasis text-decoration / <del> / <s>
// akan gagal diam-diam di halaman ini. Pembedanya kelas tipografi.
//
// --------------------------------------------------------------------------
// ATURAN KESELAMATAN
//
// Yang tidak bisa dibuktikan menjadi "unknown", dan unknown WAJIB mengosongkan
// currentPriceText. Dengan begitu kartu yang tidak kita pahami tidak bisa
// dikutip oleh kode mana pun yang membaca currentPriceText — fail-closed jadi
// sifat bentuk datanya, bukan kedisiplinan pemanggilnya.

// Satu nilai rupiah: "Rp14.299", "Rp 14.299", "Rp14,299".
const RP_AMOUNT = /rp\s*\d[\d.,]*/gi;

// Berapa nilai rupiah di dalam satu teks. ">1" berarti satu simpul memuat lebih
// dari satu harga — bentuk rentang atau dua harga yang menempel. Keduanya belum
// pernah teramati, jadi keduanya unknown.
function countAmounts(text) {
  const found = String(text == null ? "" : text).match(RP_AMOUNT);
  return found ? found.length : 0;
}

function hasAmount(text) {
  return countAmounts(text) > 0;
}

// nodes: [{ text, primary, dim }] — hasil apa adanya dari dalam halaman.
//
// primary = cocok selector harga PRODUKSI ([class*="text-body-l-medium"]),
//           yaitu simpul yang sudah dibaca sebagai `price` hari ini.
// dim     = cocok selector harga pembanding ([class*="text-neutral-text4"]
//           [class*="text-body-s"]).
function classifyPrice(nodes) {
  const kosong = {
    priceState: "unknown",
    currentPriceText: "",
    originalPriceText: "",
    priceRangeText: "",
  };

  if (!Array.isArray(nodes)) return kosong;

  // Hanya simpul yang benar-benar memuat nilai rupiah. Teks stok ("In stock:
  // 863") tidak punya nilai rupiah dan karena itu tidak pernah masuk ke sini —
  // tapi gerbang sebenarnya ada di `primary`: hanya simpul yang cocok selector
  // harga produksi yang boleh menjadi currentPriceText.
  const rp = nodes.filter((n) => n && hasAmount(n.text));
  const primary = rp.filter((n) => n.primary === true);
  const lain = rp.filter((n) => n.primary !== true);

  // Bukan tepat satu harga utama: 0 berarti kelasnya berubah / kartunya lain
  // bentuk, >1 berarti dua kandidat dan kita tidak boleh memilih salah satu.
  if (primary.length !== 1) return kosong;

  const now = String(primary[0].text).trim();
  // Satu simpul yang memuat dua nilai — kandidat bentuk rentang. BELUM pernah
  // teramati, jadi tidak diterjemahkan jadi priceRangeText: mengisinya dari
  // dugaan regex sama dengan mengarang. Nilai "range" pada priceState memang
  // ada di skema, tapi sengaja TIDAK pernah dipancarkan sampai ada bukti DOM
  // kartu rentang yang sungguhan.
  if (countAmounts(now) !== 1) return kosong;

  // Hanya satu nilai rupiah di seluruh kartu: harga tunggal.
  if (lain.length === 0) {
    return {
      priceState: "single",
      currentPriceText: now,
      originalPriceText: "",
      priceRangeText: "",
    };
  }

  // Tepat satu nilai pendamping, dan ia harus REDUP — kelas pembanding yang
  // memang teramati. Simpul kedua yang bukan redup berarti bentuk kartu yang
  // belum kita kenal (promo berlabel, misalnya), dan itu unknown.
  if (lain.length === 1 && lain[0].dim === true && countAmounts(lain[0].text) === 1) {
    return {
      priceState: "sale",
      currentPriceText: now,
      originalPriceText: String(lain[0].text).trim(),
      priceRangeText: "",
    };
  }

  return kosong;
}

// Produk mentah -> produk mentah + field harga. Tidak membuang apa pun:
// `price` dan `stock` lama TETAP apa adanya supaya pembaca yang sudah ada
// (dropdown produk, kontrak discovery) tidak berubah sama sekali.
//
// Catatan sengaja: `price` TIDAK dijadikan alias dari currentPriceText. Kalau
// dijadikan alias, kartu unknown akan kehilangan harganya di layar customer —
// padahal di sana harga hanya DIBACA manusia, dan menghapusnya hanya membuang
// informasi yang benar. Yang berbahaya adalah MENGUTIP harga yang tidak
// dipahami, dan itu dicegah di jalur kutipan (currentPriceText), bukan di
// jalur tampilan.
function withPriceFields(product) {
  const p = product && typeof product === "object" ? product : {};
  const nodes = Array.isArray(p.priceNodes) ? p.priceNodes : [];
  const harga = classifyPrice(nodes);
  return {
    ...p,
    ...harga,
    // Diagnostik: teks harga apa adanya, tanpa satu pun kelas DOM. Dipakai saat
    // priceState=unknown untuk tahu apa yang sebenarnya tertulis di kartu.
    priceRawTexts: nodes.map((n) => String((n && n.text) || "")).filter(Boolean),
    stockText: typeof p.stock === "string" ? p.stock : "",
  };
}

module.exports = { classifyPrice, withPriceFields, countAmounts, RP_AMOUNT };
