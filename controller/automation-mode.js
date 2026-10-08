"use strict";
// Apakah config MENYATAKAN mode automation yang konsisten.
//
// MURNI. Satu-satunya tempat yang memutuskan ini, dan dipakai dua pihak:
//
//   startAutomation()  menolak start kalau modenya tidak konsisten
//   status()           memberi UI jawaban + kalimatnya, supaya tombol START
//                      bisa mati dengan alasan yang benar
//
// Keduanya memakai fungsi yang SAMA, bukan salinan. Kalau UI memutuskan sendiri,
// suatu saat tombolnya hijau sementara server menolak — atau lebih buruk,
// tombolnya hijau DAN server menerima karena keduanya menyimpang ke arah yang
// sama. Lihat catatan "jangan duplikasi logika lintas lapis".
//
// ---------------------------------------------------------------------------
// KEJADIAN YANG MELAHIRKAN BERKAS INI
//
// Validasi LIVE 2026-10-08 pada aplikasi TERPASANG. OBS tersambung, TikTok
// tersambung, LIVE on air, 10 produk terdeteksi, 5 pemetaan siap, seluruh
// preflight hijau, dan START BOT menyala. Automation berjalan, scene berganti
// dengan benar — dan TIDAK ADA satu pun produk yang di-pin, tidak ada satu pun
// chat admin terkirim.
//
// Runtime snapshot run itu (runId=a583305a15967991):
//
//   autopinEnabled=false  autoCommentEnabled=false  autoCommentTransport=dry-run
//
// Jejak mentahnya tidak memuat SATU PUN [AUTOPIN_REQUEST]. Bot tidak pernah
// meminta pin, karena memang dimatikan. Padahal service sudah hangat dan siap
// (SERVICE_WARMED ok=true, composerReady=true) — ia hanya tidak pernah dipanggil.
//
// Jadi kegagalannya bukan di AutoPIN. Kegagalannya: sistem mengizinkan run
// berjalan dalam mode yang TIDAK BISA melakukan apa yang customer harapkan, dan
// setiap indikator di layar berwarna hijau. Gejalanya terbaca sebagai "AutoPIN
// rusak" — diagnosis yang salah, pada bagian yang paling mahal untuk salah.
//
// Maka aturannya: kalau pemetaan meminta produk di-pin tapi pin dimatikan, run
// itu TIDAK BOLEH dimulai. Lebih baik tombol mati dengan alasan satu kalimat
// daripada run yang terlihat sukses dan tidak melakukan apa pun.

// Kode alasan. Kalimat untuk customer ada di controller/errors.js — di sini
// hanya kodenya, supaya satu-satunya sumber kalimat tetap server.
const BLOCKER = Object.freeze({
  // Pemetaan punya produk, tapi AutoPIN dimatikan.
  PIN_OFF: "autopin-disabled",
  // Balasan admin dinyalakan, tapi jalur kirimnya belum yang sungguhan.
  REPLY_NOT_ENABLED: "admin-reply-not-enabled",
  // Balasan admin dinyalakan tanpa pin. Balasan hanya sah SESUDAH pin
  // terkonfirmasi (itu seluruh dasar AR3), jadi tanpa pin ia menjanjikan
  // sesuatu yang tidak pernah bisa terjadi.
  REPLY_WITHOUT_PIN: "admin-reply-without-pin",
});

// Jalur kirim yang benar-benar mengetik dan mengklik di browser. Nilainya sama
// dengan TRANSPORTS di controller/config-manager.js; disebut di sini karena
// modul ini harus tetap murni dan bisa dimuat tanpa apa pun.
const REAL_TRANSPORT = "browser";

// Apakah ADA pemetaan yang benar-benar meminta sebuah produk di-pin.
//
// `product: null` itu SAH dan sengaja: scene yang punya trigger tapi bukan
// etalase (mis. scene FAQ). Config yang isinya hanya scene seperti itu TIDAK
// membutuhkan AutoPIN, dan memaksanya menyala akan menolak setup yang benar.
function mappingsNeedPin(config) {
  const list = (config && config.mappings) || [];
  if (!Array.isArray(list)) return false;
  return list.some(
    (m) => m && m.product && typeof m.product.title === "string" && m.product.title.trim() !== ""
  );
}

// Mengembalikan:
//   {
//     pin, reply,        apa yang DIMINTA customer
//     needsPin,          apakah pemetaan memang butuh pin
//     ok,                boleh start atau tidak
//     blockers: [kode],  semua alasan, untuk log
//     reason,            alasan PERTAMA, untuk ditampilkan
//   }
//
// Catatan penting soal cakupan: ini HANYA menyatakan fitur yang diinginkan. Ia
// tidak memberi izin apa pun. Izin aksi nyata tetap diberikan per-run oleh
// controller/run-authority.js, hanya sesudah START BOT ditekan dan preflight
// lolos, dan ia lenyap saat Stop maupun restart.
function describeMode(config) {
  const s = (config && config.settings) || {};
  const pin = s.autopinEnabled === true;
  const reply = s.autoCommentEnabled === true;
  const transportReal = s.autoCommentTransport === REAL_TRANSPORT;
  const needsPin = mappingsNeedPin(config);

  const blockers = [];
  if (needsPin && !pin) blockers.push(BLOCKER.PIN_OFF);
  // Diperiksa walau UI sekarang selalu menulis keduanya bersamaan: UI bukan
  // batas keamanan, dan config bisa datang dari berkas yang disunting tangan.
  if (reply && !transportReal) blockers.push(BLOCKER.REPLY_NOT_ENABLED);
  if (reply && !pin) blockers.push(BLOCKER.REPLY_WITHOUT_PIN);

  return {
    pin,
    reply,
    needsPin,
    ok: blockers.length === 0,
    blockers,
    reason: blockers.length > 0 ? blockers[0] : null,
  };
}

module.exports = { describeMode, mappingsNeedPin, BLOCKER, REAL_TRANSPORT };
