"use strict";
// Izin melakukan aksi NYATA ke akun TikTok, berlaku PER RUN.
//
// ---------------------------------------------------------------------------
// APA YANG DIPINDAHKAN, DAN APA YANG TIDAK
//
// Sebelum P4, mengirim chat sungguhan butuh operator mengetik sendiri:
//
//     node autopin-service.js --enable-autocomment-send
//
// Gerbang itu TIDAK dihapus. Yang berpindah hanya SIAPA yang memegang otoritasnya:
// dari "pengembang mengetik flag di terminal" menjadi "customer menekan START BOT
// sesudah semua pemeriksaan lolos". Service tetap menolak mengirim apa pun tanpa
// flag itu, dan modul ini satu-satunya yang boleh memberikannya.
//
// ---------------------------------------------------------------------------
// KENAPA PER RUN, DAN KENAPA TIDAK PERNAH DISIMPAN
//
// Izin yang tersimpan di config akan menyala sendiri setiap kali aplikasi dibuka.
// Artinya sebuah klik yang pernah diberikan customer bulan lalu tetap berlaku
// hari ini, pada katalog produk yang berbeda dan LIVE yang berbeda — padahal yang
// ia setujui adalah run saat itu.
//
// Jadi:
//   - tidak ada field config yang menyalakannya
//   - tidak ada variabel environment yang menyalakannya
//   - tidak ada berkas yang menyimpannya
//   - Controller restart  -> UNARMED
//   - Desktop restart     -> UNARMED
//   - Stop                -> otoritas lenyap
//
// Satu-satunya cara ia menyala adalah lewat arm(), dan arm() hanya dipanggil dari
// jalur Start yang preflight-nya sudah hijau.

const crypto = require("node:crypto");

// Flag yang dimengerti autopin-service.js. Namanya ada di satu tempat ini supaya
// tidak ada yang menuliskannya ulang di tempat lain.
const REAL_SEND_FLAG = "--enable-autocomment-send";

function newRunId() {
  return crypto.randomBytes(8).toString("hex");
}

function createRunAuthority({ log = () => {}, now = () => Date.now(), makeId = newRunId } = {}) {
  // Satu-satunya state. Tidak pernah dibaca dari atau ditulis ke disk.
  let run = null; // { id, armedAt, realSend }

  function isArmed() {
    return run !== null;
  }

  // Dipanggil HANYA sesudah preflight hijau.
  //
  // `realSend` memakai prinsip hak paling kecil: flag kirim chat hanya diberikan
  // kalau customer memang menyalakan AutoComment. Kalau ia tidak memintanya,
  // service tidak perlu diberi izin yang tidak akan dipakainya — dan izin yang
  // tidak perlu adalah izin yang akan dipakai suatu hari karena alasan yang salah.
  function arm({ realSend = false } = {}) {
    if (run) {
      // Dua arm tanpa disarm di antaranya berarti ada dua run yang menganggap
      // dirinya berwenang. Ditolak, bukan ditimpa.
      log("RUN_ARM_REFUSED", { reason: "already-armed", runId: run.id });
      return { ok: false, reason: "run-already-armed", runId: run.id };
    }
    run = { id: makeId(), armedAt: now(), realSend: realSend === true };
    log("RUN_ARMED", { runId: run.id, realSend: run.realSend });
    return { ok: true, runId: run.id, realSend: run.realSend };
  }

  // Dipanggil di SETIAP jalan keluar dari sebuah run: Stop, rollback start yang
  // gagal, crash, dan shutdown. Kalau ada satu jalan keluar yang lupa
  // memanggilnya, izin akan hidup lebih lama dari run-nya.
  function disarm(reason) {
    if (!run) return { ok: true, armed: false };
    log("RUN_DISARMED", { runId: run.id, reason: reason || "stopped" });
    run = null;
    return { ok: true, armed: false };
  }

  // Argumen yang diteruskan ke service untuk run ini.
  //
  // Bot TIDAK pernah mendapatkan flag ini: bot tidak mengirim chat, ia hanya
  // meminta service melakukannya. Memberikannya ke bot tidak menambah kemampuan
  // apa pun, hanya memperluas permukaan izin.
  function serviceArgs() {
    if (!run || run.realSend !== true) return [];
    return [REAL_SEND_FLAG];
  }

  // Metadata aman untuk /api/status: id run dan apakah kirim nyata bersenjata.
  // Tidak ada rahasia di sini — id-nya acak dan hanya berarti di dalam proses ini.
  function describe() {
    if (!run) return { armed: false, runId: null, realSend: false };
    return { armed: true, runId: run.id, realSend: run.realSend, armedAt: run.armedAt };
  }

  return { isArmed, arm, disarm, serviceArgs, describe, current: () => (run ? run.id : null) };
}

module.exports = { createRunAuthority, REAL_SEND_FLAG, newRunId };
