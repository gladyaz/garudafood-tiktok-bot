"use strict";
// GERBANG KELAYAKAN PRODUK: aturan yang memin TIDAK memutar scene-nya sampai
// targetnya terbukti bisa ditarget terhadap katalog SAAT INI.
//
// ---------------------------------------------------------------------------
// URUTAN YANG DIPERBAIKI
//
// Sebelum:
//   MATCH -> scene OBS berpindah + video mulai -> dispatchAuxiliaries -> pin
//            -> pin gagal product-not-found
//
// Penonton melihat video produk yang tidak pernah ter-pin. Satu-satunya yang
// benar di situ adalah balasan "sudah aku pin" yang dibungkam gerbang bukti pin.
//
// Sesudah:
//   MATCH -> kelayakan produk -> (layak) scene + pin + balasan
//                             -> (tidak layak) TIDUR: tanpa scene, tanpa pin,
//                                tanpa balasan, tanpa aksi tertunda
//
// ---------------------------------------------------------------------------
// SATU RESOLVER
//
// Keputusannya memakai resolveProductForPin() yang SAMA dengan pin. Resolver
// kedua yang "mirip" akan menyimpang, dan penyimpangannya berarti gerbang
// bilang BOLEH sementara pin bilang tidak ketemu - atau scene sehat tertidur.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { decidePinEligibility, needsProductEligibility, SLEEP_REASONS } = require("../autopin/pin-eligibility");
const { COVERAGE } = require("../autopin/catalogue");

const P = (number, title, extra = {}) =>
  Object.assign({ number, title, pinButtons: 1, pinVisible: true, pinDisabled: false }, extra);

const TARGET = "Garuda - Kacang ATOM 16gr 1 RENCENG ISI 10 PCS oat - GRD";

const bacaFull = (products) => ({ ok: true, coverage: COVERAGE.FULL, products, ageMs: 100 });
const bacaViewport = (products) => ({ ok: true, coverage: COVERAGE.VIEWPORT, products, ageMs: 100 });

// ===========================================================================
// KEPUTUSAN MURNI
// ===========================================================================

test("LAYAK: target unik pada katalog FULL", () => {
  const v = decidePinEligibility({ read: bacaFull([P(1, TARGET), P(2, "Chocolatos 32gr")]), title: TARGET });
  assert.deepEqual(v, { ok: true, reason: null });
});

test("TIDUR: target tidak ada, katalog FULL -> product-not-found", () => {
  const v = decidePinEligibility({ read: bacaFull([P(1, "Chocolatos 32gr")]), title: TARGET });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "product-not-found");
});

test("TIDUR: target AMBIGU -> ambiguous-product, tidak menebak kandidat", () => {
  const v = decidePinEligibility({
    read: bacaFull([P(1, "Gery Saluut Chocolate"), P(2, "Gery Saluut Malkist")]),
    title: "Gery Saluut",
  });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "ambiguous-product");
  assert.equal(v.product, undefined, "tidak boleh membawa kandidat pilihan");
});

test("TIDUR: kontrol pin tidak tersedia / tidak terlihat / mati", () => {
  for (const [extra, reason] of [
    [{ pinButtons: 0 }, "live-pin-control-not-available"],
    [{ pinButtons: 2 }, "ambiguous-control"],
    [{ pinVisible: false }, "control-not-visible"],
    [{ pinDisabled: true }, "control-disabled"],
  ]) {
    const v = decidePinEligibility({ read: bacaFull([P(1, TARGET, extra)]), title: TARGET });
    assert.equal(v.ok, false, reason);
    assert.equal(v.reason, reason, JSON.stringify(extra));
  }
});

test("TIDUR: KETIDAKHADIRAN pada katalog VIEWPORT bukan product-not-found", () => {
  // Produknya mungkin ada di bawah garis lipat. Menyebutnya "tidak ada" akan
  // menidurkan aturan yang sehat dengan alasan yang salah.
  const v = decidePinEligibility({ read: bacaViewport([P(1, "Chocolatos 32gr")]), title: TARGET });
  assert.equal(v.ok, false, "tetap gagal tertutup");
  assert.equal(v.reason, "catalogue-coverage-insufficient", "tapi alasannya jujur");
});

// ===========================================================================
// KONTRA-CONTOH: KEUNIKAN VIEWPORT BUKAN KEUNIKAN KATALOG
// ===========================================================================
//
// Tes ini DULU menyatakan sebaliknya: "ketemu adalah bukti positif, apa pun
// cakupannya". Itu salah, dan salahnya persis membatalkan guna gerbang ini.
//
// Identitas pemetaan adalah JUDUL yang dinormalkan, bukan ID produk TikTok yang
// stabil. Keunikan karena itu adalah pernyataan tentang SELURUH katalog. Satu
// kecocokan di viewport tidak menutup kemungkinan kecocokan kedua di luar
// viewport - dan kalau itu terjadi:
//
//   viewport bilang unik -> scene mulai -> koleksi pin menemukan ambiguitas
//   -> pin gagal SESUDAH video tayang
test("KONTRA-CONTOH: satu kecocokan di VIEWPORT TIDAK layak", () => {
  const v = decidePinEligibility({ read: bacaViewport([P(1, "Garuda Atom")]), title: "Garuda Atom" });
  assert.equal(v.ok, false, "keunikan viewport bukan bukti keunikan katalog");
  assert.equal(v.reason, "catalogue-coverage-insufficient");
});

test("KONTRA-CONTOH: FULL yang sama memperlihatkan kembarannya -> ambiguous-product", () => {
  // Inilah produk yang tidak terlihat di viewport tadi.
  const v = decidePinEligibility({
    read: bacaFull([P(1, "Garuda Atom"), P(5, "Garuda Atom")]),
    title: "Garuda Atom",
  });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "ambiguous-product");
});

test("KONTRA-CONTOH: FULL yang benar-benar unik -> layak", () => {
  const v = decidePinEligibility({ read: bacaFull([P(1, "Garuda Atom")]), title: "Garuda Atom" });
  assert.deepEqual(v, { ok: true, reason: null });
});

test("KELAYAKAN POSITIF menuntut FULL pada SETIAP cakupan lain", () => {
  for (const coverage of ["viewport", "unknown", "", null, undefined, "FULL", "partial"]) {
    const v = decidePinEligibility({ read: { ok: true, coverage, products: [P(1, TARGET)], ageMs: 10 }, title: TARGET });
    assert.equal(v.ok, false, "coverage=" + String(coverage) + " tidak boleh layak");
    assert.equal(v.reason, "catalogue-coverage-insufficient", "coverage=" + String(coverage));
  }
  // Dan hanya nilai FULL yang sesungguhnya yang lolos.
  assert.equal(decidePinEligibility({ read: bacaFull([P(1, TARGET)]), title: TARGET }).ok, true);
});

test("bentuk katalog yang TIDAK UTUH = bukti tidak cukup, bukan katalog kosong", () => {
  for (const products of [undefined, null, "bukan-array", 5, {}]) {
    const v = decidePinEligibility({ read: { ok: true, coverage: COVERAGE.FULL, products, ageMs: 10 }, title: TARGET });
    assert.equal(v.ok, false);
    assert.equal(v.reason, "catalogue-coverage-insufficient",
      "ok:true tanpa daftar produk tidak boleh terbaca product-not-found");
  }
});

test("alasan kesegaran katalog BUKAN alasan degradasi pemetaan di preflight", () => {
  // Bagian 3: kesegaran katalog adalah kondisi RUNTIME. Memasukkannya ke
  // AVAILABILITY_REASONS akan membuat satu service yang belum hangat terbaca
  // sebagai pemetaan customer yang cacat di panel kesiapan.
  const { AVAILABILITY_REASONS } = require("../controller/mapping-validator");
  for (const r of ["catalogue-unavailable", "catalogue-stale", "catalogue-coverage-insufficient"]) {
    assert.equal(AVAILABILITY_REASONS.has(r), false, r + " tidak boleh ada di preflight");
    assert.ok(SLEEP_REASONS.includes(r), r + " harus ada di alasan tidur runtime");
  }
  // Dan ketiga alasan preflight tetap tepat itu saja.
  assert.deepEqual([...AVAILABILITY_REASONS].sort(),
    ["ambiguous-product", "live-pin-control-not-available", "product-not-found"]);
});

test("TIDUR: bukti katalog tidak tersedia / basi, dibedakan", () => {
  assert.equal(decidePinEligibility({ read: null, title: TARGET }).reason, "catalogue-unavailable");
  assert.equal(decidePinEligibility({ read: { ok: false, error: "product-snapshot-unavailable" }, title: TARGET }).reason, "catalogue-unavailable");
  assert.equal(decidePinEligibility({ read: { ok: false, error: "product-snapshot-stale", ageMs: 99_000 }, title: TARGET }).reason, "catalogue-stale");
});

test("TIDUR: judul kosong -> empty-title-key, bukan dianggap layak", () => {
  const v = decidePinEligibility({ read: bacaFull([P(1, TARGET)]), title: "" });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "empty-title-key");
});

test("alasan tidur SELALU anggota daftar tertutup", () => {
  const kasus = [
    { read: null, title: TARGET },
    { read: { ok: false, error: "product-snapshot-stale" }, title: TARGET },
    { read: bacaFull([]), title: TARGET },
    { read: bacaViewport([]), title: TARGET },
    { read: bacaFull([P(1, "A"), P(2, "A besar")]), title: "A" },
    { read: bacaFull([P(1, TARGET, { pinButtons: 0 })]), title: TARGET },
    { read: bacaFull([P(1, TARGET)]), title: "" },
  ];
  for (const k of kasus) {
    const v = decidePinEligibility(k);
    if (v.ok) continue;
    assert.ok(SLEEP_REASONS.includes(v.reason), "alasan di luar daftar: " + v.reason);
    // Dan tidak ada judul produk yang terbawa di alasannya.
    assert.match(v.reason, /^[a-z-]+$/, "alasan harus token teknis: " + v.reason);
  }
});

// ===========================================================================
// HANYA BERLAKU UNTUK ATURAN YANG MEMIN (bagian 7)
// ===========================================================================

test("GERBANG hanya untuk autoPin=true", () => {
  assert.equal(needsProductEligibility({ autoPin: true, switchScene: true, autoReply: true }), true);
  // FAQ / scene-only / reply-only: tidak pernah lewat gerbang.
  assert.equal(needsProductEligibility({ autoPin: false, switchScene: true, autoReply: true }), false);
  assert.equal(needsProductEligibility({ autoPin: false, switchScene: false, autoReply: true }), false);
  assert.equal(needsProductEligibility({ autoPin: false, switchScene: true, autoReply: false }), false);
  // Bentuk yang tidak jelas TIDAK diperlakukan sebagai memin.
  assert.equal(needsProductEligibility(null), false);
  assert.equal(needsProductEligibility({}), false);
  assert.equal(needsProductEligibility({ autoPin: "true" }), false, "hanya boolean true");
});

// ===========================================================================
// SIKLUS HIDUP DINAMIS - TANPA RESTART (bagian 4, 9, 10, 11)
// ===========================================================================

test("SIKLUS: absen -> ditambahkan -> absen lagi, semuanya tanpa restart", () => {
  const lain = [P(1, "Chocolatos 32gr"), P(2, "Okky Jelly 150ml")];

  // 1. absen saat START dan saat trigger pertama
  assert.equal(decidePinEligibility({ read: bacaFull(lain), title: TARGET }).reason, "product-not-found");

  // 2. operator menambahkannya -> trigger berikutnya LAYAK, tanpa restart
  const ditambah = lain.concat([P(3, TARGET)]);
  assert.equal(decidePinEligibility({ read: bacaFull(ditambah), title: TARGET }).ok, true);

  // 3. dihapus lagi -> tidur lagi, aman
  assert.equal(decidePinEligibility({ read: bacaFull(lain), title: TARGET }).reason, "product-not-found");

  // Tidak ada keadaan yang dibawa antar panggilan: keputusannya MURNI fungsi
  // dari katalog saat itu. Itulah yang membuat "tanpa restart" benar.
});

test("SIKLUS: ambigu -> tidak ambigu lagi, pulih tanpa restart", () => {
  const unik = [P(1, "Gery Saluut Chocolate 110gr")];
  const ambigu = unik.concat([P(2, "Gery Saluut Chocolate 110gr isi 2")]);

  assert.equal(decidePinEligibility({ read: bacaFull(unik), title: "Gery Saluut Chocolate 110gr" }).ok, true);
  assert.equal(decidePinEligibility({ read: bacaFull(ambigu), title: "Gery Saluut Chocolate 110gr" }).reason, "ambiguous-product");
  // Pesaingnya dihapus -> pulih.
  assert.equal(decidePinEligibility({ read: bacaFull(unik), title: "Gery Saluut Chocolate 110gr" }).ok, true);
});

test("SIKLUS: diurut ulang -> identitas mengikuti JUDUL, bukan nomor lama", () => {
  // Target awalnya #1.
  assert.equal(decidePinEligibility({ read: bacaFull([P(1, TARGET), P(2, "Chocolatos")]), title: TARGET }).ok, true);

  // Diurut ulang: produk LAIN kini #1, target pindah ke #4.
  const diurut = [
    P(1, "Dilan Waffle 1 BOX"),
    P(2, "Chocolatos 32gr"),
    P(3, "Okky Jelly 150ml"),
    P(4, TARGET),
  ];
  const v = decidePinEligibility({ read: bacaFull(diurut), title: TARGET });
  assert.equal(v.ok, true, "target harus tetap ditemukan di nomor barunya");

  // Dan produk yang MENEMPATI nomor lama tidak pernah menjadi cadangan:
  // kalau targetnya hilang, jawabannya tetap tidak ketemu.
  const tanpaTarget = diurut.filter((p) => p.title !== TARGET);
  assert.equal(decidePinEligibility({ read: bacaFull(tanpaTarget), title: TARGET }).reason, "product-not-found");
});

// ===========================================================================
// BUKAN SNAPSHOT PREFLIGHT (bagian 4)
// ===========================================================================

test("KEPUTUSAN tidak menyimpan apa pun: dua katalog berbeda, dua jawaban berbeda", () => {
  // Kalau keputusannya pernah di-cache, panggilan kedua akan mengulang yang
  // pertama - dan PAX-3 tidak akan pernah pulih tanpa restart.
  const absen = bacaFull([P(1, "Chocolatos")]);
  const ada = bacaFull([P(1, TARGET)]);
  for (let i = 0; i < 5; i += 1) {
    assert.equal(decidePinEligibility({ read: absen, title: TARGET }).ok, false, "putaran " + i);
    assert.equal(decidePinEligibility({ read: ada, title: TARGET }).ok, true, "putaran " + i);
  }
});
