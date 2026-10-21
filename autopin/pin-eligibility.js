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
// TIDAK ADA RESOLVER KEDUA
//
// Keputusannya memakai resolveProductForPin() yang SAMA dengan yang dipakai pin
// itu sendiri. Itu disengaja: resolver kedua yang "mirip" akan menyimpang, dan
// penyimpangan di sini berarti gerbang mengatakan BOLEH sementara pin kemudian
// mengatakan tidak ketemu - atau sebaliknya, scene yang sehat ikut tertidur.
// Satu implementasi, satu semantik: identitas judul yang dinormalkan, penolakan
// saat ambigu, tanpa cadangan ke posisi/nomor etalase.
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
const { resolveProductForPin } = require("./core");
const { COVERAGE } = require("./catalogue");

// Alasan tidur yang TERTUTUP. Token teknis, tanpa judul produk, tanpa harga,
// tanpa identitas penonton - baris ini ikut ke log dukungan customer.
const SLEEP_REASONS = Object.freeze([
  // dari resolveProductForPin
  "product-not-found",
  "ambiguous-product",
  "live-pin-control-not-available",
  "ambiguous-control",
  "control-not-visible",
  "control-disabled",
  "empty-title-key",
  // dari bukti katalognya sendiri
  "catalogue-unavailable",
  "catalogue-stale",
  "catalogue-coverage-insufficient",
]);

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

  const r = resolveProductForPin(read.products, title);
  if (r.ok === true) return { ok: true, reason: null };
  return { ok: false, reason: r.reason };
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
