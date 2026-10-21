"use strict";
// KELAYAKAN PRODUK SEBELUM SCENE DIPUTAR. Fungsi MURNI.
//
// ---------------------------------------------------------------------------
// MASALAH YANG DIPERBAIKI
//
// Urutan produksi sebelum ini:
//
//   MATCH -> scene OBS berpindah + video mulai -> dispatchAuxiliaries -> pin
//
// Artinya aturan PAX yang produknya TIDAK ADA di etalase tetap memutar video
// produknya. Penonton melihat iklan produk yang tidak pernah ter-pin, dan
// satu-satunya yang benar di situ adalah balasan "sudah aku pin" yang memang
// dibungkam gerbang bukti pin. Yang dijanjikan "aturan itu tidur" tidak terjadi.
//
// Modul ini menjawab satu pertanyaan, SEBELUM scene mulai: apakah produk yang
// dipetakan bisa ditarget dengan AMAN terhadap katalog SAAT INI?
//
// ---------------------------------------------------------------------------
// SATU PRIMITIF IDENTITAS, DUA BENTUK PRODUK
//
// Identitasnya memakai resolveProductIdentity() yang SAMA dengan jalur pin,
// jadi semantik judul tidak bisa menyimpang: normalisasi yang sama, penolakan
// ambigu yang sama, tanpa cadangan ke posisi/nomor etalase.
//
// Yang TIDAK boleh dibagi adalah pemeriksaan KONTROL PIN, karena bentuk
// produknya berbeda:
//
//   mentah (jalur pin)        pinButtons, pinVisible, pinDisabled
//   ternormalisasi (katalog)  pinAvailable, pinDisabled   <- yang dibaca DI SINI
//
// toSnapshotProduct() di autopin/catalogue.js menyuling pinButtons menjadi
// pinAvailable dan TIDAK menyimpan pinButtons (maupun pinVisible). Versi
// pertama modul ini memanggil resolveProductForPin() atas snapshot katalog,
// jadi `product.pinButtons` selalu undefined dan SETIAP produk sehat ditolak
// live-pin-control-not-available. Pada LIVE nyata 2026-10-21 itu berarti PAX-1
// dan PAX-2 - keduanya ada dan bisa dipin - ikut tertidur.
//
// Perbaikannya bukan mengarang pinButtons di snapshot, melainkan membaca
// kontrak yang memang dimiliki snapshot.
//
// ---------------------------------------------------------------------------
// KELAYAKAN POSITIF MENUNTUT CAKUPAN PENUH YANG DISAKSIKAN
//
// Versi pertama modul ini memperlakukan "ketemu dan unik" sebagai cukup, pada
// cakupan APA PUN, dan hanya menuntut FULL untuk menyatakan "tidak ketemu".
// Itu separuh yang benar, dan separuh yang salah justru yang berbahaya.
//
// Identitas pemetaan di sini adalah JUDUL yang dinormalkan - bukan ID produk
// TikTok yang stabil. Maka keunikan adalah pernyataan tentang SELURUH katalog,
// bukan tentang baris yang kebetulan ter-render. Snapshot VIEWPORT bisa memuat
// satu kecocokan sementara kecocokan KEDUA dengan judul yang sama persis ada di
// luar viewport, dan urutannya menjadi:
//
//   viewport bilang unik -> scene mulai -> koleksi pin yang sungguhan
//   menemukan ambiguitas -> pin gagal SESUDAH video sudah tayang
//
// Yaitu persis kegagalan yang gerbang pra-scene ini dibuat untuk mencegah.
//
// Jadi: kelayakan POSITIF hanya boleh datang dari snapshot yang SEGAR dan
// coverage="full". Semua cakupan lain - viewport, unknown, hilang, basi,
// bentuk yang tidak utuh - gagal tertutup untuk aturan ITU saja, dengan alasan
// yang jujur, dan TIDAK pernah menjadi peringatan pemetaan di preflight:
// kesegaran katalog adalah kondisi runtime, bukan cacat konfigurasi.
const { resolveProductIdentity } = require("./core");
const { COVERAGE } = require("./catalogue");

// Alasan tidur yang TERTUTUP. Token teknis, tanpa judul produk, tanpa harga,
// tanpa identitas penonton - baris ini ikut ke log dukungan customer.
const SLEEP_REASONS = Object.freeze([
  // identitas, dari resolveProductIdentity
  "product-not-found",
  "ambiguous-product",
  "empty-title-key",
  // kesehatan kontrol pin, dari field KATALOG (pinAvailable / pinDisabled)
  "live-pin-control-not-available",
  "control-disabled",
  // bukti katalognya sendiri
  "catalogue-unavailable",
  "catalogue-stale",
  "catalogue-coverage-insufficient",
]);
// `ambiguous-control` dan `control-not-visible` SENGAJA tidak ada di sini:
// keduanya diturunkan dari pinButtons/pinVisible, yang tidak disimpan snapshot.
// Keduanya tetap hidup di jalur pin, yang memeriksa DOM saat itu sebelum klik.

// KEPUTUSAN MURNI. `read` adalah jawaban apa adanya dari pembaca katalog
// (autopin/client.js createCatalogueReader), yaitu bentuk catalogue.read().
//
// Mengembalikan { ok, reason }. ok:true berarti scene boleh mulai.
function decidePinEligibility({ read, title } = {}) {
  // Bukti tidak ada sama sekali, atau basi. Dibedakan karena keduanya menuntut
  // tindakan operator yang berbeda: yang satu service/halaman, yang satu waktu.
  if (!read || read.ok !== true) {
    const err = read && typeof read.error === "string" ? read.error : "";
    return { ok: false, reason: err === "product-snapshot-stale" ? "catalogue-stale" : "catalogue-unavailable" };
  }

  // CAKUPAN DULU, sebelum resolusi apa pun. Tanpa daftar yang lengkap, tidak
  // ada satu pun kesimpulan tentang keunikan yang bisa ditarik - termasuk
  // "ketemu satu".
  if (read.coverage !== COVERAGE.FULL) {
    return { ok: false, reason: "catalogue-coverage-insufficient" };
  }
  // Bentuk yang tidak utuh diperlakukan sebagai bukti yang tidak cukup, BUKAN
  // sebagai katalog kosong: ok:true tanpa daftar produk tidak boleh terbaca
  // sebagai "produknya memang tidak ada".
  if (!Array.isArray(read.products)) {
    return { ok: false, reason: "catalogue-coverage-insufficient" };
  }

  // --- 1. IDENTITAS (primitif bersama) ---
  const id = resolveProductIdentity(read.products, title);
  if (id.ok !== true) return { ok: false, reason: id.reason };

  // --- 2. KESEHATAN KONTROL PIN, dari field katalog yang SUNGGUHAN ---
  //
  // pinAvailable sudah merupakan hasil `Number(pinButtons) > 0` saat snapshot
  // disimpan, jadi membacanya di sini adalah membaca pertanyaan yang sama
  // lewat kontrak yang memang ada - bukan menebaknya dari pinText.
  const p = id.product;
  if (p.pinAvailable !== true) return { ok: false, reason: "live-pin-control-not-available" };
  if (p.pinDisabled === true) return { ok: false, reason: "control-disabled" };
  return { ok: true, reason: null };
}

// Apakah aturan ini BERGANTUNG pada produk? Hanya aksi pin yang bergantung.
//
// Sumber kebenarannya adalah aksi yang sudah diselesaikan - bukan ada/tidaknya
// field product. Aturan FAQ menyimpan judul historis tanpa pernah memin, dan
// menidurkannya karena judul itu sudah hilang dari etalase akan mematikan
// balasan FAQ setiap customer.
function needsProductEligibility(actions) {
  return !!(actions && actions.autoPin === true);
}

module.exports = { decidePinEligibility, needsProductEligibility, SLEEP_REASONS };
