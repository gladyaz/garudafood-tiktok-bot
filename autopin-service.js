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
const { STRATEGIES } = require("./autocomment/click-strategy");
const { readRuntimeConfig, RUNTIME_CONFIG_ENV } = require("./runtime/runtime-config");

// --click-strategy=<handle|dom|mouse>. Nilai tak dikenal TIDAK diam-diam
// diartikan sebagai salah satu strategi: ia ditolak, dan prosesnya berhenti.
//
// Default DOM, terbukti di LIVE 2026-10-05 (click=95ms, chat terkonfirmasi
// penonton). "handle" dan "mouse" tetap bisa dipilih eksplisit.
function parseClickStrategy(argv) {
  const arg = argv.find((a) => a.startsWith("--click-strategy="));
  if (!arg) return STRATEGIES.DOM;
  const v = arg.slice("--click-strategy=".length).trim().toLowerCase();
  if (!Object.values(STRATEGIES).includes(v)) {
    console.error(
      `--click-strategy="${v}" tidak dikenal. Pilihan: ${Object.values(STRATEGIES).join(", ")}`
    );
    process.exit(1);
  }
  return v;
}

// P2: generasi config runtime yang dipakai Controller untuk run ini.
//
// Service tidak memakai pemetaannya — judul produk datang per-permintaan dari
// bot, dan teks chat juga. Yang dibaca di sini HANYA id generasinya, supaya
// /health bisa melaporkannya dan ketidakcocokan antara bot dan service terlihat
// sebagai dua angka yang berbeda. Tanpa ini, bot yang memakai pemetaan baru
// sementara service masih sisa run sebelumnya akan terlihat normal sepenuhnya.
function readRuntimeConfigId(env) {
  const file = env[RUNTIME_CONFIG_ENV];
  if (!file) return null;
  const loaded = readRuntimeConfig(file);
  if (!loaded.ok) {
    log("SERVICE_RUNTIME_CONFIG_REFUSED", { reason: loaded.reason });
    return null;
  }
  return loaded.config.id;
}

async function main(argv) {
  const dryRun = argv.includes("--dry-run");
  // AR2B: otorisasi satu kali kirim HANYA dari baris perintah, tidak pernah dari
  // environment. Tanpa flag ini, /comment/send-once menolak dengan
  // real-comment-send-disabled.
  const allowCommentSendOnce = argv.includes("--allow-comment-send-once");
// AR3: otorisasi chat otomatis. HANYA dari baris perintah.
// AUTOCOMMENT_ENABLED=true di .env TIDAK cukup, dan memang tidak boleh cukup.
const allowAutoCommentSend = argv.includes("--enable-autocomment-send");
  // Strategi klik HANYA dari baris perintah, sama sekali tidak dari environment:
  // tidak ada berkas .env yang boleh mengubah cara sesuatu diklik di akun
  // sungguhan. Tanpa flag ini, default-nya jalur warisan yang tidak berubah.
  const clickStrategy = parseClickStrategy(argv);
  const runtimeConfigId = readRuntimeConfigId(process.env);
  const svc = await startService({ dryRun, allowCommentSendOnce, allowAutoCommentSend, clickStrategy, runtimeConfigId });
  if (allowAutoCommentSend) {
    log("SERVICE_AUTOCOMMENT_SEND_ARMED", {
      note: "chat otomatis boleh dikirim SESUDAH pin terkonfirmasi: satu ketik + satu klik per playId, tanpa retry",
    });
  }
  log("SERVICE_CLICK_STRATEGY", { strategy: clickStrategy });
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
