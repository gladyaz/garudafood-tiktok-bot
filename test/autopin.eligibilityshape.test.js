"use strict";
// KONTRAK BENTUK: gerbang kelayakan membaca snapshot katalog TERNORMALISASI.
//
// ---------------------------------------------------------------------------
// KENAPA BERKAS INI ADA
//
// Pada LIVE NYATA 2026-10-21 gerbang kelayakan pra-scene menolak SETIAP produk
// yang sehat sebagai live-pin-control-not-available, jadi PAX-1 dan PAX-2 -
// keduanya ada di etalase dan bisa dipin - ikut tertidur.
//
// Sebabnya bukan logika, melainkan BENTUK. Ada dua bentuk produk, keduanya sah:
//
//   mentah (kolektor/jalur pin)  pinButtons, pinVisible, pinDisabled
//   ternormalisasi (katalog)     pinAvailable, pinDisabled, pinText
//
// toSnapshotProduct() menyuling pinButtons menjadi pinAvailable dan TIDAK
// menyimpan pinButtons. Gerbangnya memanggil resolveProductForPin() atas
// snapshot ternormalisasi, jadi `product.pinButtons` selalu undefined.
//
// Tes deterministik yang sudah ada TIDAK menangkapnya karena fixture-nya
// MENGARANG `pinButtons: 1` - fake yang tidak cocok dengan bentuk produksi.
// Itu pelajaran yang sudah tercatat di repo ini, dan tetap terulang.
//
// Maka ATURAN berkas ini: fixture-nya WAJIB lewat jalur penyimpanan produksi
// (createCatalogueStore().put()), dan apa yang dioper ke gerbang adalah hasil
// store.read() - bukan objek yang disusun tangan.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { createCatalogueStore, COVERAGE } = require("../autopin/catalogue");
const { decidePinEligibility, SLEEP_REASONS } = require("../autopin/pin-eligibility");
const { resolveProductForPin, resolveProductIdentity } = require("../autopin/core");

const ROOT = path.resolve(__dirname, "..");

// Produk MENTAH, bentuk yang BENAR-BENAR dihasilkan kolektor. Hanya ini yang
// boleh menyebut pinButtons/pinVisible - dan ia tidak pernah dioper ke gerbang.
const mentah = (number, title, extra = {}) =>
  Object.assign(
    {
      number,
      title,
      pinButtons: 1,
      pinVisible: true,
      pinDisabled: false,
      pinText: "Pin",
      currentPriceText: "Rp14.299",
      priceState: "sale",
      stockText: "In stock: 857",
    },
    extra
  );

// Membuat snapshot TERNORMALISASI lewat jalur produksi.
function snapshot(products, coverage = COVERAGE.FULL) {
  let t = 1_000_000;
  const store = createCatalogueStore({ now: () => t });
  const put = store.put({ products, coverage, source: "full-test", observedAt: t });
  assert.equal(put.ok, true, "put harus berhasil: " + JSON.stringify(put));
  const read = store.read({});
  assert.equal(read.ok, true, "read harus berhasil: " + JSON.stringify(read));
  return read;
}

// ===========================================================================
// KONTRAK BENTUK ITU SENDIRI (bagian 4)
// ===========================================================================

test("KONTRAK: snapshot tersimpan punya pinAvailable/pinDisabled dan TIDAK punya pinButtons", () => {
  const snap = snapshot([mentah(1, "Garuda Atom")]);
  const p = snap.products[0];

  assert.equal("pinAvailable" in p, true, "pinAvailable harus ada");
  assert.equal("pinDisabled" in p, true, "pinDisabled harus ada");
  assert.equal(p.pinAvailable, true);
  assert.equal(p.pinDisabled, false);

  // Inilah inti bug-nya: field yang gerbang DULU bergantung padanya tidak ada.
  assert.equal("pinButtons" in p, false, "snapshot TIDAK menyimpan pinButtons");
  assert.equal("pinVisible" in p, false, "snapshot TIDAK menyimpan pinVisible");
});

test("KONTRAK: pinAvailable memang turunan pinButtons, dihitung saat disimpan", () => {
  assert.equal(snapshot([mentah(1, "A", { pinButtons: 1 })]).products[0].pinAvailable, true);
  assert.equal(snapshot([mentah(1, "A", { pinButtons: 3 })]).products[0].pinAvailable, true);
  assert.equal(snapshot([mentah(1, "A", { pinButtons: 0 })]).products[0].pinAvailable, false);
  // Dan ketiadaan field mentah pun jatuh ke false, bukan ke undefined.
  const tanpa = mentah(1, "A");
  delete tanpa.pinButtons;
  assert.equal(snapshot([tanpa]).products[0].pinAvailable, false);
});

test("KELAYAKAN LULUS pada snapshot ternormalisasi yang sehat (tes yang DULU merah)", () => {
  // Fresh FULL, satu target unik, pinAvailable=true, pinDisabled=false.
  const snap = snapshot([mentah(1, "Garuda Atom"), mentah(2, "Chocolatos Wafer 32gr")]);
  const v = decidePinEligibility({ read: snap, title: "Garuda Atom" });
  assert.deepEqual(v, { ok: true, reason: null },
    "produk sehat pada bentuk PRODUKSI harus layak: " + JSON.stringify(v));
});

// ===========================================================================
// NEGATIF, SEMUANYA PADA BENTUK TERNORMALISASI (bagian 5)
// ===========================================================================

test("A. pinAvailable=false -> live-pin-control-not-available", () => {
  const snap = snapshot([mentah(1, "Garuda Atom", { pinButtons: 0 })]);
  assert.equal(snap.products[0].pinAvailable, false);
  const v = decidePinEligibility({ read: snap, title: "Garuda Atom" });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "live-pin-control-not-available");
});

test("B. pinDisabled=true -> control-disabled", () => {
  const snap = snapshot([mentah(1, "Garuda Atom", { pinDisabled: true })]);
  assert.equal(snap.products[0].pinAvailable, true, "tombolnya ADA...");
  assert.equal(snap.products[0].pinDisabled, true, "...tapi mati");
  const v = decidePinEligibility({ read: snap, title: "Garuda Atom" });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "control-disabled");
});

test("C. dua judul ternormalkan sama -> ambiguous-product", () => {
  const snap = snapshot([mentah(1, "Garuda Atom"), mentah(5, "Garuda Atom")]);
  const v = decidePinEligibility({ read: snap, title: "Garuda Atom" });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "ambiguous-product");
});

test("D. nol kecocokan pada FULL -> product-not-found", () => {
  const snap = snapshot([mentah(1, "Chocolatos Wafer 32gr")]);
  const v = decidePinEligibility({ read: snap, title: "Garuda Atom" });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "product-not-found");
});

test("E. satu kecocokan pada VIEWPORT -> catalogue-coverage-insufficient", () => {
  // Syarat FULL-saja TETAP: keunikan adalah pernyataan tentang seluruh katalog.
  const snap = snapshot([mentah(1, "Garuda Atom")], COVERAGE.VIEWPORT);
  const v = decidePinEligibility({ read: snap, title: "Garuda Atom" });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "catalogue-coverage-insufficient");
});

test("alasan gerbang SELALU anggota daftar tertutup", () => {
  const kasus = [
    [[mentah(1, "Chocolatos")], COVERAGE.FULL],
    [[mentah(1, "Garuda Atom", { pinButtons: 0 })], COVERAGE.FULL],
    [[mentah(1, "Garuda Atom", { pinDisabled: true })], COVERAGE.FULL],
    [[mentah(1, "Garuda Atom"), mentah(2, "Garuda Atom")], COVERAGE.FULL],
    [[mentah(1, "Garuda Atom")], COVERAGE.VIEWPORT],
  ];
  for (const [products, coverage] of kasus) {
    const v = decidePinEligibility({ read: snapshot(products, coverage), title: "Garuda Atom" });
    if (v.ok) continue;
    assert.ok(SLEEP_REASONS.includes(v.reason), "alasan di luar daftar: " + v.reason);
  }
  // Dua alasan yang TIDAK bisa lagi datang dari gerbang - keduanya diturunkan
  // dari pinButtons/pinVisible, yang tidak disimpan snapshot.
  assert.equal(SLEEP_REASONS.includes("ambiguous-control"), false);
  assert.equal(SLEEP_REASONS.includes("control-not-visible"), false);
});

// ===========================================================================
// JALUR PIN MENTAH TIDAK IKUT BERUBAH (bagian 6)
// ===========================================================================

test("JALUR PIN: tetap memvalidasi kontrol MENTAH-nya sendiri", () => {
  // Sehat.
  assert.equal(resolveProductForPin([mentah(1, "Garuda Atom")], "Garuda Atom").ok, true);
  // Tidak ada tombol pin sama sekali.
  assert.equal(resolveProductForPin([mentah(1, "Garuda Atom", { pinButtons: 0 })], "Garuda Atom").reason,
    "live-pin-control-not-available");
  // Tombol ganda - hanya bisa dilihat dari bentuk MENTAH.
  assert.equal(resolveProductForPin([mentah(1, "Garuda Atom", { pinButtons: 2 })], "Garuda Atom").reason,
    "ambiguous-control");
  // Tersembunyi - juga hanya dari bentuk MENTAH.
  assert.equal(resolveProductForPin([mentah(1, "Garuda Atom", { pinVisible: false })], "Garuda Atom").reason,
    "control-not-visible");
  // Mati.
  assert.equal(resolveProductForPin([mentah(1, "Garuda Atom", { pinDisabled: true })], "Garuda Atom").reason,
    "control-disabled");
  // Identitas ambigu.
  assert.equal(resolveProductForPin([mentah(1, "Garuda Atom"), mentah(2, "Garuda Atom")], "Garuda Atom").reason,
    "ambiguous-product");
  // Tidak ketemu.
  assert.equal(resolveProductForPin([mentah(1, "Chocolatos")], "Garuda Atom").reason, "product-not-found");
});

test("JALUR PIN: TIDAK boleh mempercayai pinAvailable turunan katalog", () => {
  // Kalau jalur pin mulai menerima bentuk ternormalisasi, ia akan mengklik
  // berdasarkan bukti yang berumur detik, bukan DOM saat itu. Snapshot
  // ternormalisasi TIDAK punya pinButtons, jadi ia harus DITOLAK di sini.
  const snap = snapshot([mentah(1, "Garuda Atom")]);
  const r = resolveProductForPin(snap.products, "Garuda Atom");
  assert.equal(r.ok, false, "jalur pin tidak boleh meloloskan bentuk katalog");
  assert.equal(r.reason, "live-pin-control-not-available");
});

test("IDENTITAS: primitif yang SAMA dipakai kedua jalur, dan hanya soal judul", () => {
  // Bentuk ternormalisasi maupun mentah: identitasnya sama, karena `title` ada
  // di keduanya dan tidak ada field kontrol yang dibaca.
  const snap = snapshot([mentah(1, "Garuda Atom")]);
  assert.equal(resolveProductIdentity(snap.products, "Garuda Atom").ok, true);
  assert.equal(resolveProductIdentity([mentah(1, "Garuda Atom")], "Garuda Atom").ok, true);
  // Nol / banyak / judul kosong.
  assert.equal(resolveProductIdentity(snap.products, "Tidak Ada").reason, "product-not-found");
  assert.equal(resolveProductIdentity(snapshot([mentah(1, "A B"), mentah(2, "A B")]).products, "A B").reason, "ambiguous-product");
  assert.equal(resolveProductIdentity(snap.products, "").reason, "empty-title-key");
  // Dan TIDAK ada cadangan ke nomor etalase.
  assert.equal(resolveProductIdentity(snap.products, "1").reason, "product-not-found");
});

// ===========================================================================
// PENJAGA SUMBER: fixture gerbang tidak boleh mengarang pinButtons lagi
// ===========================================================================

test("PENJAGA: gerbang TIDAK menyebut pinButtons/pinVisible sama sekali", () => {
  const src = fs.readFileSync(path.join(ROOT, "autopin", "pin-eligibility.js"), "utf8");
  const kode = src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  assert.ok(!/\bpinButtons\b/.test(kode), "gerbang tidak boleh bergantung pada pinButtons");
  assert.ok(!/\bpinVisible\b/.test(kode), "gerbang tidak boleh bergantung pada pinVisible");
  // Dan ia MEMANG membaca kontrak katalog.
  assert.match(kode, /\bpinAvailable\b/);
  assert.match(kode, /\bpinDisabled\b/);
  // Identitasnya dari primitif bersama, bukan resolver pin.
  assert.match(kode, /resolveProductIdentity/);
  assert.ok(!/resolveProductForPin/.test(kode), "gerbang tidak memakai resolver jalur pin");
});

test("PENJAGA: berkas kontrak ini memakai jalur penyimpanan PRODUKSI", () => {
  // Fixture yang disusun tangan adalah yang menyembunyikan bug-nya. Penjaga ini
  // mengikat caranya: pinButtons hanya boleh muncul pada masukan MENTAH, dan
  // apa yang dioper ke gerbang harus hasil store.read().
  const src = fs.readFileSync(path.join(ROOT, "test", "autopin.eligibilityshape.test.js"), "utf8");
  assert.match(src, /createCatalogueStore/, "harus memakai store produksi");
  assert.match(src, /store\.read\(\{\}\)/, "yang dioper ke gerbang harus hasil read()");
  // decidePinEligibility SELALU menerima `read:` hasil snapshot(), tidak pernah
  // objek literal.
  const panggilan = src.match(/decidePinEligibility\(\{[^}]*\}/g) || [];
  assert.ok(panggilan.length >= 6, "harus ada beberapa pemanggilan: " + panggilan.length);
  for (const p of panggilan) {
    assert.match(p, /read:\s*(snap|snapshot\()/, "gerbang hanya boleh diberi snapshot ternormalisasi: " + p);
    assert.ok(!/pinButtons/.test(p), "pemanggilan gerbang tidak boleh menyebut pinButtons: " + p);
  }
});
