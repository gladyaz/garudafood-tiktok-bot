"use strict";
// KONTRAK KELENGKAPAN KATALOG: kapan coverage="full" boleh diklaim.
//
// Yang dijalankan di sini adalah collectProducts PRODUKSI di atas DOM tiruan,
// dengan SEMUA fungsi in-page produksi: readProductsInPage,
// readCatalogueStateInPage, scrollProductListInPage, resetScrollInPage. Tidak
// ada satu pun yang ditiru. Virtualizer-nya dimodelkan dari pengukuran LIVE
// 2026-10-20 (akun agen_mulia_abadi, katalog 5 produk):
//
//   clientHeight 604, baris ~151 px, 4 baris ter-render pada scrollTop 0
//   scrollHeight 1209 -> 1275 saat baris ke-5 dipasang
//   satu gelombang 400 px memunculkan produk #5
//
// Fakta terakhir itulah alasan berkas ini ada: DASAR BUKAN BUKTI. scrollHeight
// bergerak selagi baris dipasang, jadi "scrollTop + clientHeight >=
// scrollHeight" diukur terhadap angka yang masih berubah.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { el, withDocument } = require("./fake-dom");
const products = require("../autopin/products");
const {
  SELECTORS, COVERAGE, collectProducts, readProductsInPage,
  scrollProductListInPage, resetScrollInPage, decideCoverage, positionsCover, scopeVerdict,
} = products;

const ROOT = path.resolve(__dirname, "..");
const ROW_H = 151;
const CLIENT_H = 604;
const WINDOW = 4;          // baris ter-render sekaligus, dari pengukuran
const SH_BASE = 1209;      // scrollHeight dengan 4 baris terpasang
const SH_PER_ROW = 66;     // pertumbuhan terukur saat baris ke-5 dipasang
const VIRT_CLASS = "index-module__virtualized-container--nn7XK";

// --- bagian halaman, ditranskrip dari DOM nyata ---

const thumb = () => el({ tag: "span", attrs: { class: "sc-eldPxv w-39 h-39" }, kids: [el({ tag: "img", attrs: { class: "rounded-8" } })] });
const badgeSlot = (text) => el({ attrs: { class: "flex items-center justify-center w-39 h-39" }, kids: [el({ tag: "span", text })] });

function strip({ total, badge = true, header = true, malformedBadge = null }) {
  const thumbs = Math.min(4, total);
  const kids = [];
  for (let i = 0; i < thumbs; i += 1) kids.push(thumb());
  const sisa = total - thumbs;
  if (malformedBadge !== null) kids.push(badgeSlot(malformedBadge));
  else if (badge && sisa > 0) kids.push(badgeSlot("+" + sisa));
  const inner = [];
  if (header) inner.push(el({ attrs: { class: "text-neutral-text1 mb-8" }, text: "Product list in this LIVE" }));
  inner.push(el({ attrs: { class: "flex justify-between items-center" }, kids: [el({ attrs: { class: "flex items-center" }, kids })] }));
  return el({ attrs: { class: "mb-8 rounded-8 py-12 pl-12 pr-10" }, kids: inner });
}

// value === null berarti properti `value` TIDAK ADA sama sekali - meniru input
// yang nilainya tidak bisa dibaca. Sentinel-nya null, bukan undefined, karena
// undefined akan jatuh ke nilai bawaan destrukturisasi.
function searchBox(value) {
  return el({
    tag: "input",
    attrs: { "data-tid": "m4b_input_search", placeholder: "Search product ID or product name", class: "arco-input" },
    ...(value === null ? {} : { value }),
  });
}

function filterRow({ category = "All categories", stock = "All stock", activities = "", activitiesPlaceholder = true } = {}) {
  const kategori = el({
    tag: "button",
    attrs: { "data-tid": "m4b_button", class: "arco-btn" },
    kids: category === null ? [] : [el({ attrs: { class: "arco-typography" }, text: category })],
  });
  const stok = el({
    attrs: { role: "combobox", class: "arco-select" },
    kids: [el({ attrs: stock === null ? { class: "arco-select-view" } : { title: stock, class: "arco-select-view" } })],
  });
  const aktivitas = el({
    attrs: { role: "combobox", class: "arco-select arco-select-multiple" },
    kids: [el({
      attrs: { title: activities, class: "arco-select-view" },
      kids: [el({ attrs: { class: "arco-input-tag" + (activitiesPlaceholder ? " arco-input-tag-has-placeholder" : "") } })],
    })],
  });
  const centang = el({
    tag: "label",
    attrs: { "data-tid": "m4b_checkbox", class: "arco-checkbox" },
    kids: [el({ tag: "input", attrs: { type: "checkbox" }, checked: false })],
  });
  return el({ attrs: { class: "w-full flex items-center index-module__productFilter--Mq+Zx" }, kids: [centang, kategori, stok, aktivitas] });
}

// Satu baris produk. Geometrinya scrollHeight === clientHeight supaya jalan-naik
// produksi MELEWATINYA dan berhenti di container virtualisasi - persis seperti
// kedalaman 0..9 pada pengukuran LIVE.
function row(n, title) {
  return el({
    attrs: { class: "rounded-4 mb-8" },
    scrollHeight: 40, clientHeight: 40,
    kids: [el({
      attrs: { class: "flex flex-col flex-1 overflow-hidden" },
      overflowY: "hidden", scrollHeight: 40, clientHeight: 40,
      kids: [
        el({ tag: "input", attrs: { "data-tid": "m4b_input_number", "aria-valuenow": String(n) } }),
        el({ attrs: { class: "stock-and-pin-button-wrapper flex" } }),
        el({ attrs: { class: "overflow-ellipsis" }, kids: [el({ tag: "span", text: title })] }),
        el({ tag: "span", attrs: { class: "text-body-l-medium" }, text: "Rp10.000" }),
        el({ attrs: { class: "stock-and-ask-to-show" }, text: "In stock: 9" }),
        el({ tag: "button", attrs: { "data-pin-performance-source": "product_card" }, text: "Pin" }),
      ],
    })],
  });
}

// Halaman palsu yang menjalankan FUNGSI IN-PAGE PRODUKSI. Virtualizer-nya
// dimodelkan: jendela baris diturunkan dari scrollTop container, dan scrollTop
// hanya berubah lewat scrollProductListInPage produksi.
function page({
  total = 5,
  titles = null,
  search = "",
  filters = {},
  stripOpts = {},
  // "normal" | "frozen" (virtualizer tidak bereaksi) | "duplicate" | "zero-position"
  mode = "normal",
  scopeAfterFirstWave = null,
  scopeRevertsAfterWave = null,
  totalAfterFirstWave = null,
  scrollerChangesAfterFirstWave = false,
  evaluates = { n: 0 },
} = {}) {
  const judul = titles || Array.from({ length: total }, (_, i) => "Produk " + (i + 1));
  const list = el({ attrs: { class: "list-area" }, scrollHeight: 10, clientHeight: 10 });
  const kepala = el({ kids: [] });
  const virt = el({
    attrs: { class: VIRT_CLASS },
    overflowY: "auto",
    scrollTop: 0,
    clientHeight: CLIENT_H,
    scrollHeight: SH_BASE,
    kids: [kepala, list],
  });
  const root = el({ attrs: { class: "body-root" }, kids: [virt] });

  let gelombang = 0;
  let scopeNow = { search, filters: { ...filters } };
  let totalNow = total;

  const pasangKepala = () => {
    kepala._kids.length = 0;
    for (const k of [
      el({ attrs: { class: "w-full" }, kids: [searchBox(scopeNow.search)] }),
      filterRow(scopeNow.filters),
      strip({ total: totalNow, ...stripOpts }),
    ]) { k.parentElement = kepala; kepala._kids.push(k); }
  };

  // Virtualizer TikTok yang terukur TIDAK menggeser jendela: pada LIVE
  // 2026-10-20 baris 1..4 tetap terpasang dan baris 5 DITAMBAHKAN
  // (rowMarkers 4 -> 5, scrollHeight 1209 -> 1275). Jadi yang bertambah adalah
  // batas bawahnya, bukan posisi jendelanya.
  const pasangBaris = () => {
    const efektif = mode === "frozen" ? 0 : virt.scrollTop;
    const akhir = Math.min(total, WINDOW + Math.floor(efektif / ROW_H));
    list._kids.length = 0;
    for (let i = 0; i < akhir; i += 1) {
      let n = i + 1;
      let t = judul[i];
      if (mode === "zero-position" && n === 2) n = 0;
      const r = row(n, t);
      r.parentElement = list;
      list._kids.push(r);
      // Posisi yang BERTENTANGAN: nomor sama, judul berbeda.
      if (mode === "duplicate" && n === 1) {
        const bentrok = row(1, "Judul Lain Sama Sekali");
        bentrok.parentElement = list;
        list._kids.push(bentrok);
      }
    }
    virt.scrollHeight = SH_BASE + Math.max(0, list._kids.length - WINDOW) * SH_PER_ROW;
  };

  pasangKepala();
  pasangBaris();

  const maxScroll = () => Math.max(0, virt.scrollHeight - CLIENT_H);

  return {
    url: () => "https://shop.tiktok.com/streamer/live/product/dashboard",
    isClosed: () => false,
    bringToFront: async () => {},
    evaluate: async (fn, sel, step) => {
      evaluates.n += 1;
      if (fn === readProductsInPage) evaluates.rows = (evaluates.rows || 0) + 1;
      return withDocument(root, () => {
        if (fn === resetScrollInPage) {
          const r = fn(sel);
          pasangBaris();
          return r;
        }
        if (fn === scrollProductListInPage) {
          const r = fn(sel, step);
          // DOM nyata membatasi scrollTop; node tiruan tidak, jadi dibatasi di sini.
          if (virt.scrollTop > maxScroll()) virt.scrollTop = maxScroll();
          gelombang += 1;
          if (gelombang === 1 && scopeAfterFirstWave) { scopeNow = scopeAfterFirstWave; pasangKepala(); }
          // KOTOR sebentar, lalu BERSIH lagi. Cuplikan awal+akhir tidak akan
          // pernah melihat ini; cuplikan per gelombang melihatnya.
          if (scopeRevertsAfterWave) {
            if (gelombang === 1) { scopeNow = scopeRevertsAfterWave; pasangKepala(); }
            else if (gelombang === 2) { scopeNow = { search: "", filters: {} }; pasangKepala(); }
          }
          if (gelombang === 1 && totalAfterFirstWave !== null) { totalNow = totalAfterFirstWave; pasangKepala(); }
          // Container yang EFEKTIF berpindah: penanda virtualisasinya hilang,
          // jadi elemen yang digulir bukan lagi container daftar yang sama.
          // Meniru re-render TikTok yang membangun ulang pembungkusnya.
          if (gelombang === 1 && scrollerChangesAfterFirstWave) {
            virt._attrs.class = "pembungkus-lain tanpa-penanda";
          }
          pasangBaris();
          // Dikembalikan APA ADANYA dari fungsi produksi. Menimpanya dengan
          // geometri pasca-pemasangan justru akan MENYEMBUNYIKAN fakta yang
          // sedang diuji: angka yang dibaca penggulir sudah basi begitu baris
          // baru terpasang.
          return r;
        }
        return fn(sel);
      });
    },
    __virt: virt,
  };
}

const kumpulkan = (p, opts = {}) => collectProducts(p, { sleep: async () => {}, witness: "both", ...opts });

// ===========================================================================
// HARUS FULL
// ===========================================================================

test("FULL: 5 produk, [1,2,3,4] lalu satu gelombang -> [1,2,3,4,5]", async () => {
  const ev = { n: 0 };
  const p = page({ total: 5, evaluates: ev });
  const r = await kumpulkan(p);
  assert.equal(r.coverage, COVERAGE.FULL);
  assert.deepEqual(r.coverageReasons, []);
  const c = r.completeness;
  assert.equal(c.scope, "clean");
  assert.equal(c.declaredTotal, 5);
  assert.equal(c.declaredTotalStable, true);
  assert.deepEqual(c.positions, [1, 2, 3, 4, 5]);
  assert.equal(c.positionsCoverTotal, true);
  assert.equal(c.contradictoryPositions, 0);
  assert.equal(c.scrollerStable, true);
  assert.equal(c.exhaustedScrolls, false);
  assert.equal(c.rowsSane, true);
  assert.equal(r.products.length, 5);
});

// REGRESI GEOMETRI NYATA. Inilah fixture yang diminta: scrollHeight BERGERAK
// selagi baris ke-5 dipasang, dan kelengkapan tetap terbukti - lewat total,
// bukan lewat dasar.
test("REGRESI LIVE 2026-10-20: scrollHeight 1209 -> 1275, total tetap yang membuktikan", async () => {
  const p = page({ total: 5 });
  assert.equal(p.__virt.scrollTop, 0, "awal: scrollTop 0");
  assert.equal(p.__virt.scrollHeight, 1209, "awal: scrollHeight 1209");
  assert.equal(p.__virt.clientHeight, 604, "awal: clientHeight 604");

  const r = await kumpulkan(p);

  assert.equal(p.__virt.scrollHeight, 1275, "sesudah gelombang: scrollHeight 1275");
  assert.ok(p.__virt.scrollTop >= 400, "sesudah gelombang: scrollTop >= 400, dapat " + p.__virt.scrollTop);
  assert.equal(r.coverage, COVERAGE.FULL);
  assert.deepEqual(r.completeness.positions, [1, 2, 3, 4, 5]);
  assert.equal(r.completeness.scrollStopReason, "positions-complete");
  // DAN kelengkapannya TIDAK datang dari dasar: dasar bahkan belum tercapai.
  assert.equal(r.completeness.bottomReached, false, "dasar tidak boleh jadi sumber klaim lengkap");
});

test("FULL: katalog yang sudah lengkap di awal tidak digulir sama sekali", async () => {
  const p = page({ total: 3 });
  const r = await kumpulkan(p);
  assert.equal(r.coverage, COVERAGE.FULL);
  assert.deepEqual(r.completeness.positions, [1, 2, 3]);
  assert.equal(r.completeness.scrollStopReason, "positions-complete-at-start");
  assert.equal(r.passes, 1, "satu lintasan saja");
});

// ===========================================================================
// HARUS BUKAN FULL
// ===========================================================================

test("BUKAN FULL: hanya [1,2,3,4] dari declaredTotal=5 (virtualizer tidak bereaksi)", async () => {
  const p = page({ total: 5, mode: "frozen" });
  const r = await kumpulkan(p);
  assert.notEqual(r.coverage, COVERAGE.FULL);
  assert.equal(r.coverage, COVERAGE.VIEWPORT);
  assert.deepEqual(r.completeness.positions, [1, 2, 3, 4]);
  assert.equal(r.completeness.positionsCoverTotal, false);
  assert.ok(r.coverageReasons.length > 0);
});

test("BUKAN FULL: kuota gelombang habis", async () => {
  const p = page({ total: 60 });
  const r = await kumpulkan(p, { maxScrolls: 2 });
  assert.equal(r.coverage, COVERAGE.VIEWPORT);
  assert.equal(r.completeness.exhaustedScrolls, true);
  assert.equal(r.completeness.scrollStopReason, "max-scrolls");
  assert.ok(r.coverageReasons.includes("positions-incomplete") || r.coverageReasons.includes("max-scrolls-exhausted"));
});

test("BUKAN FULL: dasar tercapai tapi posisi belum lengkap", async () => {
  // Virtualizer beku + daftar pendek: gulir mencapai dasar tanpa pernah
  // memunculkan produk terakhir.
  const p = page({ total: 5, mode: "frozen" });
  const r = await kumpulkan(p, { maxScrolls: 14 });
  assert.equal(r.coverage, COVERAGE.VIEWPORT);
  assert.equal(r.completeness.positionsCoverTotal, false);
  if (r.completeness.bottomReached) {
    assert.ok(r.coverageReasons.includes("bottom-reached-but-incomplete"));
  }
});

for (const [nama, opts] of [
  ["pencarian aktif", { search: "atom" }],
  ["pencarian tidak terbaca", { search: null }],
  ["kategori bukan default", { filters: { category: "Snack Premium" } }],
  ["kategori tidak dikenali", { filters: { category: "Semua kategori" } }],
  ["kategori hilang", { filters: { category: null } }],
  ["stock bukan default", { filters: { stock: "Out of stock" } }],
  ["stock hilang", { filters: { stock: null } }],
  ["activities punya pilihan", { filters: { activities: "Promo", activitiesPlaceholder: false } }],
]) {
  test("BUKAN FULL: " + nama + " -> coverage unknown", async () => {
    const p = page({ total: 5, ...opts });
    const r = await kumpulkan(p);
    assert.equal(r.coverage, COVERAGE.UNKNOWN, "reasons=" + r.coverageReasons.join(","));
    assert.ok(r.coverageReasons.some((x) => x.startsWith("scope-")), "harus menyebut scope: " + r.coverageReasons.join(","));
  });
}

test("BUKAN FULL: strip hilang -> total tidak tersedia", async () => {
  const p = page({ total: 5, stripOpts: { header: false, badge: false } });
  const r = await kumpulkan(p);
  assert.notEqual(r.coverage, COVERAGE.FULL);
  assert.equal(r.completeness.declaredTotal, null);
});

// Beberapa bentuk rusak, dan "+" yang berdiri sendiri adalah yang paling
// berbahaya: tanpa pemeriksaan pola, "+".slice(1) jadi "" dan Number("") jadi 0,
// sehingga totalnya diam-diam menjadi SAMA DENGAN jumlah thumbnail - angka yang
// terlihat masuk akal dan salah.
for (const rusak of ["+1 lagi", "+", "16", "+1 6", "~16", "+16a", " "]) {
  test("BUKAN FULL: badge rusak " + JSON.stringify(rusak) + " -> total tidak tersedia", async () => {
    const p = page({ total: 5, stripOpts: { malformedBadge: rusak } });
    const r = await kumpulkan(p);
    assert.notEqual(r.coverage, COVERAGE.FULL);
    assert.equal(r.completeness.declaredTotal, null, "badge rusak TIDAK boleh jadi total = jumlah thumbnail");
  });
}

test("BUKAN FULL: declaredTotal berubah di tengah sapuan", async () => {
  const p = page({ total: 5, totalAfterFirstWave: 9 });
  const r = await kumpulkan(p);
  assert.equal(r.coverage, COVERAGE.UNKNOWN);
  assert.equal(r.completeness.declaredTotalStable, false);
  assert.ok(r.coverageReasons.includes("declared-total-unstable"));
});

test("BUKAN FULL: cakupan berubah KOTOR di tengah sapuan", async () => {
  const p = page({ total: 5, scopeAfterFirstWave: { search: "atom", filters: {} } });
  const r = await kumpulkan(p);
  assert.equal(r.coverage, COVERAGE.UNKNOWN);
  assert.equal(r.completeness.scope, "dirty");
});

// INILAH yang tidak bisa dilakukan cuplikan awal+akhir. Cakupan kotor hanya
// pada gelombang pertama, lalu bersih lagi sebelum sapuan selesai: kedua ujung
// bersih, tengahnya tidak.
test("PER-GELOMBANG: cakupan kotor SEMENTARA di tengah sapuan tetap tertangkap", async () => {
  const p = page({ total: 60, scopeRevertsAfterWave: { search: "atom", filters: {} } });
  const r = await kumpulkan(p, { maxScrolls: 6 });
  assert.equal(r.coverage, COVERAGE.UNKNOWN);
  assert.equal(r.completeness.scope, "dirty");
  const c = r.completeness.scopeSamples;
  assert.equal(c[0], "clean", "ujung awal bersih");
  assert.equal(c[c.length - 1], "clean", "ujung akhir bersih juga");
  assert.ok(c.includes("dirty"), "tapi ada gelombang yang kotor: " + c.join(","));
});

test("PER-GELOMBANG: satu cuplikan per gelombang, jumlahnya = jumlah pembacaan", async () => {
  const p = page({ total: 60 });
  const r = await kumpulkan(p, { maxScrolls: 4 });
  assert.equal(r.completeness.evidenceSamples, r.passes);
  assert.equal(r.completeness.scopeSamples.length, r.passes);
});

test("BUKAN FULL: container gulir berpindah di tengah sapuan", async () => {
  const p = page({ total: 20, scrollerChangesAfterFirstWave: true });
  const r = await kumpulkan(p);
  assert.equal(r.coverage, COVERAGE.UNKNOWN);
  assert.equal(r.completeness.scrollerStable, false);
  assert.ok(r.coverageReasons.includes("scroller-unstable"), r.coverageReasons.join(","));
});

test("sidik jari scroller: berbeda saat semantiknya berbeda, sama saat sama", () => {
  const { scrollerFingerprint } = require("../autopin/products");
  const dasar = { found: true, depth: 10, tag: "div", virtualized: true };
  const f = scrollerFingerprint(dasar);
  assert.equal(scrollerFingerprint({ ...dasar }), f, "struktur sama -> sidik jari sama");
  // scrollTop/scrollHeight MEMANG berubah saat menggulir: keduanya tidak boleh ikut.
  assert.equal(scrollerFingerprint({ ...dasar, scrollTop: 400, scrollHeight: 1275 }), f);
  // Gaya terhitung tidak dipakai sama sekali, jadi overflow-y tidak boleh ikut.
  assert.equal(scrollerFingerprint({ ...dasar, overflowY: "scroll" }), f, "overflow-y tidak ikut");
  for (const [k, v] of [["depth", 11], ["tag", "section"], ["virtualized", false]]) {
    assert.notEqual(scrollerFingerprint({ ...dasar, [k]: v }), f, k + " harus mengubah sidik jari");
  }
  assert.equal(scrollerFingerprint({ found: false }), "");
  assert.equal(scrollerFingerprint(null), "");
});

test("BUKAN FULL: posisi bertentangan (nomor sama, judul beda)", async () => {
  const p = page({ total: 5, mode: "duplicate" });
  const r = await kumpulkan(p);
  assert.equal(r.coverage, COVERAGE.UNKNOWN);
  assert.ok(r.completeness.contradictoryPositions > 0);
  assert.ok(r.coverageReasons.includes("rows-malformed") || r.coverageReasons.includes("positions-invalid"));
});

test("BUKAN FULL: nomor posisi nol/negatif ditolak sebagai baris rusak", async () => {
  const p = page({ total: 5, mode: "zero-position" });
  const r = await kumpulkan(p);
  assert.notEqual(r.coverage, COVERAGE.FULL);
  assert.ok(r.invalidRows > 0, "baris bernomor 0 harus terhitung rusak");
});

test("BUKAN FULL: anggaran waktu habis (aborted)", async () => {
  const p = page({ total: 60 });
  let sisa = 500;
  const r = await kumpulkan(p, { remaining: () => (sisa -= 100) });
  assert.equal(r.coverage, COVERAGE.UNKNOWN);
  assert.equal(r.ranOutOfTime, true);
  assert.ok(r.coverageReasons.some((x) => x.startsWith("aborted-")));
});

test("BUKAN FULL: satu gelombang mengembalikan baris TANPA catalogueEvidence", async () => {
  // Bukti yang hilang bukan bukti yang lolos. Gelombang tanpa bukti dicatat
  // sebagai cuplikan "unknown", dan satu cuplikan unknown sudah cukup.
  const p = page({ total: 20 });
  const asli = p.evaluate;
  let n = 0;
  p.evaluate = async (fn, sel, step) => {
    const hasil = await asli(fn, sel, step);
    if (fn === readProductsInPage) {
      n += 1;
      if (n === 2) {
        const tanpa = Object.assign({}, hasil);
        delete tanpa.catalogueEvidence;
        return tanpa;
      }
    }
    return hasil;
  };
  const r = await kumpulkan(p);
  assert.equal(r.coverage, COVERAGE.UNKNOWN);
  assert.equal(r.completeness.scope, "unknown");
  assert.ok(r.coverageReasons.some((x) => x.startsWith("scope-")), r.coverageReasons.join(","));
});

test("BUKAN FULL: SEMUA gelombang tanpa bukti -> unknown, bukan diam-diam lolos", async () => {
  const p = page({ total: 5 });
  const asli = p.evaluate;
  p.evaluate = async (fn, sel, step) => {
    const hasil = await asli(fn, sel, step);
    if (fn === readProductsInPage) {
      const tanpa = Object.assign({}, hasil);
      delete tanpa.catalogueEvidence;
      return tanpa;
    }
    return hasil;
  };
  const r = await kumpulkan(p);
  assert.equal(r.coverage, COVERAGE.UNKNOWN);
  assert.equal(r.completeness.declaredTotal, null);
  assert.equal(r.completeness.scrollerStable, false);
});

test("BUKAN FULL: halaman tanpa baris produk", async () => {
  const p = page({ total: 0 });
  const r = await kumpulkan(p);
  assert.notEqual(r.coverage, COVERAGE.FULL);
  assert.equal(r.completeness.rowsSane, false);
});

test("BUKAN FULL: halaman tertutup di tengah -> melempar, tidak mengaku lengkap", async () => {
  const p = page({ total: 60 });
  const asli = p.evaluate;
  let n = 0;
  p.evaluate = async (fn, sel, step) => {
    n += 1;
    if (n > 4) throw new Error("page closed");
    return asli(fn, sel, step);
  };
  await assert.rejects(() => kumpulkan(p), /page closed/);
});

// ===========================================================================
// BIAYA, dan kontrak antar fungsi in-page
// ===========================================================================

// BIAYA BUKTI = NOL perjalanan bolak-balik. Jumlah evaluate per koleksi harus
// TEPAT: 1 reset + 1 pembacaan awal + 2 per gelombang (gulir + baca). Tidak ada
// satu pun panggilan tambahan untuk bukti.
test("biaya: bukti menumpang pada pembacaan baris - NOL evaluate tambahan", async () => {
  const ukur = async (total, opts = {}) => {
    const ev = { n: 0, rows: 0 };
    const r = await kumpulkan(page({ total, evaluates: ev }), opts);
    return { total: ev.n, rows: ev.rows, passes: r.passes, cuplikan: r.completeness.evidenceSamples };
  };

  const kecil = await ukur(5);
  assert.equal(kecil.passes, 2, "5 produk: baca awal + satu gelombang");
  assert.equal(kecil.total, 2 + 2 * 1, "1 reset + 1 baca awal + (gulir+baca) x1");

  const besar = await ukur(60, { maxScrolls: 3 });
  assert.equal(besar.passes, 4, "baca awal + tiga gelombang");
  assert.equal(besar.total, 2 + 2 * 3, "tetap 2 evaluate per gelombang, bukan 3");

  // Dan tiap pembacaan baris menghasilkan TEPAT satu cuplikan bukti.
  for (const u of [kecil, besar]) {
    assert.equal(u.rows, u.passes, "satu pembacaan baris per pass");
    assert.equal(u.cuplikan, u.passes, "satu cuplikan bukti per pembacaan baris");
  }
});

test("biaya: jumlah evaluate TIDAK naik dibanding model tanpa bukti", async () => {
  // Model acuan: apa yang collectProducts lakukan kalau buktinya tidak ada sama
  // sekali - reset, baca, lalu gulir+baca per gelombang. Angkanya harus sama.
  const ev = { n: 0 };
  const r = await kumpulkan(page({ total: 60, evaluates: ev }), { maxScrolls: 5 });
  const acuan = 1 + 1 + 2 * (r.passes - 1);
  assert.equal(ev.n, acuan, "bukti tidak boleh menambah satu pun evaluate");
});

// Jalan-naik container ada di DUA fungsi in-page produksi. Kalau keduanya
// menyimpang, sidik jari yang dibandingkan bukan sidik jari elemen yang
// benar-benar digulir - dan seluruh saksi "scroller stabil" jadi mengukur
// benda yang salah.
test("kontrak: pembaca scroller memilih elemen yang SAMA dengan penggulir", () => {
  const p = page({ total: 20 });
  const root = withDocument;
  const sebelum = p.__virt.scrollTop;
  // Pembaca melaporkan kedalaman + geometri container.
  let dibaca = null;
  let digulir = null;
  // Keduanya dijalankan pada DOM yang sama, lewat page.evaluate yang sama.
  return (async () => {
    dibaca = (await p.evaluate(readProductsInPage, SELECTORS)).catalogueEvidence;
    // Geometri DICATAT pada saat pembacaan: sesudah digulir ia sudah berubah,
    // dan membandingkannya dengan keadaan akhir justru akan mengukur hal lain.
    const shSaatBaca = p.__virt.scrollHeight;
    const chSaatBaca = p.__virt.clientHeight;
    assert.equal(dibaca.scroller.found, true);
    assert.equal(dibaca.scroller.virtualized, true, "harus container virtualisasi");
    assert.equal(dibaca.scroller.scrollHeight, shSaatBaca);
    assert.equal(dibaca.scroller.clientHeight, chSaatBaca);
    assert.equal(dibaca.scroller.scrollTop, sebelum);

    digulir = await p.evaluate(scrollProductListInPage, SELECTORS, 400);
    // Elemen yang digulir adalah elemen yang dibaca: scrollTop-nya yang berubah.
    assert.equal(digulir.scrolled, true);
    assert.ok(p.__virt.scrollTop > sebelum, "yang bergerak adalah container yang dilaporkan");
    // Dan inilah buktinya langsung: scrollHeight yang DIKEMBALIKAN penggulir
    // sudah BASI begitu baris baru terpasang. Angka yang sama yang dulu dipakai
    // untuk menyimpulkan "sudah di dasar".
    assert.ok(
      digulir.scrollHeight < p.__virt.scrollHeight,
      "scrollHeight dari penggulir harus lebih kecil dari yang terbaru: " +
        digulir.scrollHeight + " vs " + p.__virt.scrollHeight
    );
    assert.ok(root);
  })();
});

// ===========================================================================
// FUNGSI MURNI
// ===========================================================================

test("positionsCover: membuktikan [1..total] TEPAT, bukan sekadar panjang", () => {
  assert.equal(positionsCover([1, 2, 3], 3), true);
  assert.equal(positionsCover([3, 1, 2], 3), true);
  assert.equal(positionsCover([1, 2, 4], 3), false, "panjang 3 tapi bukan 1..3");
  assert.equal(positionsCover([1, 2], 3), false);
  assert.equal(positionsCover([1, 2, 3, 4], 3), false);
  assert.equal(positionsCover([0, 1, 2], 3), false, "nol bukan posisi sah");
  assert.equal(positionsCover([1, 2, 2.5], 3), false);
  assert.equal(positionsCover([1, -1, 2], 3), false);
  // Duplikat TIDAK membatalkan cakupan: himpunannya tetap tepat [1..3].
  // "nomor sama dengan judul berbeda" adalah saksi TERPISAH
  // (contradictoryPositions), bukan tugas fungsi ini.
  assert.equal(positionsCover([1, 1, 2, 3], 3), true, "himpunan tetap menutup 1..3");
  assert.equal(positionsCover([], 0), false);
  assert.equal(positionsCover(null, 3), false);
  assert.equal(positionsCover([1], null), false);
});

test("scopeVerdict: fail-closed di tiga arah", () => {
  const bersih = {
    search: { state: "empty" },
    filters: { category: { state: "default" }, stock: { state: "default" }, activities: { state: "default" } },
  };
  assert.equal(scopeVerdict(bersih), "clean");
  const ubah = (k, v) => {
    const c = JSON.parse(JSON.stringify(bersih));
    if (k === "search") c.search.state = v; else c.filters[k].state = v;
    return c;
  };
  assert.equal(scopeVerdict(ubah("search", "non-empty")), "dirty");
  assert.equal(scopeVerdict(ubah("search", "unknown")), "unknown");
  assert.equal(scopeVerdict(ubah("category", "non-default")), "dirty");
  assert.equal(scopeVerdict(ubah("category", "unknown")), "unknown");
  assert.equal(scopeVerdict(ubah("stock", "unknown")), "unknown");
  assert.equal(scopeVerdict(ubah("activities", "non-default")), "dirty");
  assert.equal(scopeVerdict({}), "unknown");
  assert.equal(scopeVerdict(null), "unknown");
});

test("decideCoverage: dasar SENDIRI tidak pernah cukup untuk full", () => {
  const dasar = {
    scopeClean: true, scopeState: "clean", declaredTotal: 5, declaredTotalStable: true,
    positionsValid: true, positionsCoverTotal: false, scrollerStable: true, rowsSane: true,
    exhaustedScrolls: false, bottomReached: true, aborted: false,
  };
  const v = decideCoverage(dasar);
  assert.equal(v.coverage, COVERAGE.VIEWPORT);
  assert.ok(v.reasons.includes("bottom-reached-but-incomplete"));
  // dan dengan posisi lengkap, dasar tidak relevan lagi
  assert.equal(decideCoverage({ ...dasar, positionsCoverTotal: true }).coverage, COVERAGE.FULL);
});

test("decideCoverage: kuota gelombang habis tidak pernah berarti full", () => {
  const ev = {
    scopeClean: true, scopeState: "clean", declaredTotal: 5, declaredTotalStable: true,
    positionsValid: true, positionsCoverTotal: true, scrollerStable: true, rowsSane: true,
    exhaustedScrolls: true, bottomReached: false, aborted: false,
  };
  assert.equal(decideCoverage(ev).coverage, COVERAGE.VIEWPORT);
  assert.ok(decideCoverage(ev).reasons.includes("max-scrolls-exhausted"));
});

test("decideCoverage: bukti yang HILANG jadi unknown, bukan lolos", () => {
  assert.equal(decideCoverage({}).coverage, COVERAGE.UNKNOWN);
  assert.equal(decideCoverage().coverage, COVERAGE.UNKNOWN);
  const lengkap = {
    scopeClean: true, scopeState: "clean", declaredTotal: 5, declaredTotalStable: true,
    positionsValid: true, positionsCoverTotal: true, scrollerStable: true, rowsSane: true,
    exhaustedScrolls: false, bottomReached: false, aborted: false,
  };
  for (const k of ["scopeClean", "declaredTotalStable", "positionsValid", "scrollerStable", "rowsSane"]) {
    const rusak = { ...lengkap, [k]: false };
    assert.equal(decideCoverage(rusak).coverage, COVERAGE.UNKNOWN, k + " harus memaksa unknown");
  }
  assert.equal(decideCoverage({ ...lengkap, aborted: true }).coverage, COVERAGE.UNKNOWN);
  assert.equal(decideCoverage({ ...lengkap, declaredTotal: null }).coverage, COVERAGE.VIEWPORT);
  assert.equal(decideCoverage({ ...lengkap, declaredTotal: 0 }).coverage, COVERAGE.VIEWPORT);
});

// ===========================================================================
// PAGAR SUMBER
// ===========================================================================

test("PAGAR: bukti kelengkapan tidak membaca gaya terhitung", () => {
  // Aturan yang sama dengan pembacaan harga (test/autopin.price.test.js):
  // fungsi ini jalan setiap gelombang, dan recalc style bukan biaya yang boleh
  // ditanggung jalur pin.
  const src = products.readProductsInPage.toString();
  assert.ok(!src.includes("getComputed" + "Style"), "readProductsInPage tidak boleh membacanya");
});

test("PAGAR: coverage diputuskan di SATU tempat, dan service tidak menyimpulkannya", () => {
  const svc = fs.readFileSync(path.join(ROOT, "autopin", "service.js"), "utf8");
  const kode = svc.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  // Tidak boleh ada lagi kesimpulan "kalau tidak dipotong maka full".
  assert.ok(
    !/ranOutOfTime !== true && snapshot\.stoppedEarly !== true\)\s*\{\s*\n?\s*catalogue\.put\([^)]*COVERAGE\.FULL/.test(kode),
    "service tidak boleh menyimpulkan full dari flag negatif"
  );
  assert.ok(/coverage: snapshot\.coverage/.test(kode), "label pin-collect harus dari kolektor");
  assert.ok(/coverage: snap\.coverage/.test(kode), "label sapuan harus dari kolektor");
  // COVERAGE.FULL tidak boleh lagi dipakukan di tempat penyimpanan.
  assert.ok(!/coverage: COVERAGE\.FULL/.test(kode), "tidak boleh memakukan label full");
});

test("PAGAR: decideCoverage adalah satu-satunya penentu coverage di products.js", () => {
  const src = fs.readFileSync(path.join(ROOT, "autopin", "products.js"), "utf8");
  const kode = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  // COVERAGE.FULL boleh muncul TEPAT SEKALI, dan hanya di dalam decideCoverage.
  const semua = (kode.match(/coverage: COVERAGE\.FULL/g) || []).length;
  assert.equal(semua, 1, "label full hanya boleh lahir di satu tempat");
  const mulai = kode.indexOf("function decideCoverage");
  const akhir = kode.indexOf("function positionsCover");
  const blok = kode.slice(mulai, akhir);
  assert.ok(mulai > 0 && akhir > mulai, "kedua fungsi harus ada");
  assert.equal((blok.match(/coverage: COVERAGE\.FULL/g) || []).length, 1, "dan tempat itu adalah decideCoverage");
  assert.equal((blok.match(/COVERAGE\.(FULL|VIEWPORT|UNKNOWN)/g) || []).length, 5, "tiga keadaan diputuskan di sini");
  assert.ok(/coverage: verdict\.coverage/.test(kode), "collectProducts memakai verdict");
});
