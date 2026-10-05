#!/usr/bin/env node
"use strict";
// Proses service AutoPIN — dijalankan TERPISAH dari bot.
//
//   node autopin-service.js                 jalankan service (akan mengklik)
//   node autopin-service.js --dry-run       resolusi target saja, TIDAK mengklik
//
//   node autopin-service.js --enable-autocomment-send
//       AR3: mengizinkan AutoComment mengirim chat otomatis, dan HANYA setelah
//       pin terkonfirmasi. Satu ketik + satu klik per playId, tanpa retry.
//       Tanpa flag ini /comment/send menolak: real-comment-send-disabled.
//
//   node autopin-service.js --allow-comment-send-once
//       AR2B: mengizinkan TEPAT SATU percobaan kirim chat sungguhan (satu kali
//       ketik + satu kali klik) selama umur proses ini. Tanpa flag ini jalur
//       kirim mati total. Tidak ada variabel environment yang menyalakannya.
//
// Login manual dilakukan sekali lewat: node autopin-cli.js login
// Profil browser dipakai bersama, jadi service dan CLI TIDAK boleh jalan
// bersamaan (profil Chrome terkunci satu proses).

require("dotenv").config({ quiet: true });

const { log } = require("./autopin/core");
const { startService } = require("./autopin/service");

async function main(argv) {
  const dryRun = argv.includes("--dry-run");
  // AR2B: otorisasi satu kali kirim HANYA dari baris perintah, tidak pernah dari
  // environment. Tanpa flag ini, /comment/send-once menolak dengan
  // real-comment-send-disabled.
  const allowCommentSendOnce = argv.includes("--allow-comment-send-once");
// AR3: otorisasi chat otomatis. HANYA dari baris perintah.
// AUTOCOMMENT_ENABLED=true di .env TIDAK cukup, dan memang tidak boleh cukup.
const allowAutoCommentSend = argv.includes("--enable-autocomment-send");
  const svc = await startService({ dryRun, allowCommentSendOnce, allowAutoCommentSend });
  if (allowAutoCommentSend) {
    log("SERVICE_AUTOCOMMENT_SEND_ARMED", {
      note: "chat otomatis boleh dikirim SESUDAH pin terkonfirmasi: satu ketik + satu klik per playId, tanpa retry",
    });
  }
  if (allowCommentSendOnce) {
    log("SERVICE_SEND_ONCE_ARMED", {
      note: "satu percobaan ketik + satu klik untuk SELURUH umur proses ini; tidak ada retry",
    });
  }

  const shutdown = async (sig) => {
    log("SERVICE_SHUTDOWN", { signal: sig });
    try {
      svc.server.close();
      await svc.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    log("SERVICE_FATAL", { reason: String(err && err.message).slice(0, 160) });
    process.exit(1);
  });
}
