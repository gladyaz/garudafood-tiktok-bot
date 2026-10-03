#!/usr/bin/env node
"use strict";
// Proses service AutoPIN — dijalankan TERPISAH dari bot.
//
//   node autopin-service.js                 jalankan service (akan mengklik)
//   node autopin-service.js --dry-run       resolusi target saja, TIDAK mengklik
//
// Login manual dilakukan sekali lewat: node autopin-cli.js login
// Profil browser dipakai bersama, jadi service dan CLI TIDAK boleh jalan
// bersamaan (profil Chrome terkunci satu proses).

require("dotenv").config({ quiet: true });

const { log } = require("./autopin/core");
const { startService } = require("./autopin/service");

async function main(argv) {
  const dryRun = argv.includes("--dry-run");
  const svc = await startService({ dryRun });

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
