#!/usr/bin/env node
"use strict";
// Entry point Controller.
//
//   node controller/index.js                jalankan Controller di 127.0.0.1:4782
//   node controller/index.js --port=4900    port lain
//
// Controller TIDAK menyalakan apa pun sampai POST /api/start. Menjalankan berkas
// ini sendiri tidak menyentuh TikTok, OBS, maupun browser.
//
// Flag yang mengizinkan aksi nyata ke akun TikTok tetap HANYA dari baris perintah
// operator, dan diteruskan apa adanya ke service — persis seperti sebelum
// Controller ada. Tidak ada nilai di data/config.json yang bisa menyalakannya:
//
//   --enable-autocomment-send     AR3: chat otomatis sesudah pin terkonfirmasi
//   --allow-comment-send-once     AR2B: tepat satu percobaan kirim
//   --click-strategy=<...>        strategi klik
//   --dry-run                     service tidak mengklik
//
// Contoh: node controller/index.js -- --enable-autocomment-send

// .env tetap dibaca: ia sekarang hanya untuk default internal dan kompatibilitas
// development. Nilai yang diurus customer datang dari data/config.json.
require("dotenv").config({ quiet: true });

const path = require("node:path");
const { execFile } = require("node:child_process");
const { createController } = require("./controller");
const { createServer, DEFAULT_PORT } = require("./server");
const { createObsDiscovery } = require("./discovery/obs");
const { createTikTokDiscovery } = require("./discovery/tiktok");
const { toAutopinConfig } = require("./config-manager");

const ROOT = path.resolve(__dirname, "..");

// Flag yang diteruskan ke service AutoPIN. Daftar TERTUTUP: Controller tidak
// pernah meneruskan argumen sembarang ke proses yang mengklik akun sungguhan.
const SERVICE_PASSTHROUGH = Object.freeze([
  "--dry-run",
  "--enable-autocomment-send",
  "--allow-comment-send-once",
]);

function parseArgs(argv) {
  const portArg = argv.find((a) => a.startsWith("--port="));
  const port = portArg ? Number.parseInt(portArg.slice("--port=".length), 10) : DEFAULT_PORT;

  const serviceArgs = argv.filter(
    (a) => SERVICE_PASSTHROUGH.includes(a) || a.startsWith("--click-strategy=")
  );

  return {
    port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_PORT,
    serviceArgs,
    // Induk (aplikasi desktop) memakai stdin untuk meminta berhenti. Jalur manual
    // dari terminal TIDAK menyetel ini, jadi perilakunya tidak berubah.
    parentPipe: argv.includes("--parent-pipe"),
    // Path Node untuk menyalakan bot dan service.
    //
    // Diisi aplikasi desktop, karena di dalam Electron process.execPath adalah
    // electron.exe. Bot dan service WAJIB node.exe: seluruh perlindungan proses
    // yatim (scripts/stop-all.ps1 dan penyapu di sini) mencari Name='node.exe',
    // dan anak yang bernama lain akan tersembunyi dari semuanya.
    //
    // Kosong = pakai process.execPath, yang benar untuk jalur manual `node
    // controller/index.js`.
    nodePath: (function () {
      const a = argv.find((x) => x.startsWith("--node-path="));
      return a ? a.slice("--node-path=".length) : null;
    })(),
  };
}

// --- penyapu proses yatim (produksi, Windows) --------------------------------
//
// Pencocokannya SENGAJA sama dengan scripts/stop-all.ps1: -like pada substring
// nama skrip, BUKAN pola yang mengasumsikan bagaimana node dipanggil. Pola lama
// `-match 'node index\.js'` tidak pernah cocok dengan command line sebenarnya di
// mesin ini (`"C:\Program Files\nodejs\node.exe" index.js`), dan itulah sebabnya
// laporan "sisa bot: 0" terbit tiga kali pada 2026-10-05 padahal tiga bot hidup.
//
// Proses anak milik Controller ini dikecualikan lewat ownPids: mereka diurus oleh
// process-manager, dan menyapu mereka dari sini akan berlomba dengannya.
function runPowerShell(script, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        resolve(String(stdout || "").trim());
      }
    );
  });
}

function createWindowsOrphanSweeper() {
  return async function sweep({ ownPids = new Set(), dryRun = false } = {}) {
    const exclude = Array.from(ownPids).filter((p) => Number.isInteger(p));
    const excludeList = exclude.length > 0 ? exclude.join(",") : "-1";
    // Satu skrip, satu angka keluar: jumlah yang cocok (dryRun) atau jumlah yang
    // dibunuh plus sisa yang terbukti. Pembuktian ulang ada di dalam skrip,
    // bukan disimpulkan dari "tidak ada error".
    const script = [
      "$ErrorActionPreference='Stop'",
      "$own=@(" + excludeList + ")",
      "$pats=@('*index.js*','*autopin-service.js*')",
      "function Hits { $r=@(); foreach($p in (Get-CimInstance Win32_Process -Filter \"Name='node.exe'\")){ if($own -contains $p.ProcessId){continue}; foreach($pat in $pats){ if($p.CommandLine -like $pat){ $r+=$p; break } } }; return $r }",
      "$found=@(Hits)",
      dryRun
        ? "Write-Output ('count=' + $found.Count + ' killed=0 remaining=' + $found.Count)"
        : [
            "$killed=0",
            "foreach($p in $found){ try{ Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; $killed++ }catch{} }",
            "Start-Sleep -Milliseconds 300",
            "$left=@(Hits).Count",
            "Write-Output ('count=' + $found.Count + ' killed=' + $killed + ' remaining=' + $left)",
          ].join("; "),
    ].join("; ");

    const out = await runPowerShell(script);
    const num = (key) => {
      const m = new RegExp(key + "=(\\d+)").exec(out);
      return m ? Number(m[1]) : 0;
    };
    return { count: num("count"), killed: num("killed"), remaining: num("remaining") };
  };
}

// Chrome milik automation dikenali dari direktori profilnya, sama seperti
// scripts/stop-all.ps1, supaya Chrome PRIBADI operator tidak pernah ikut
// tertutup. Ini bukan kehati-hatian berlebihan: profilnya memang satu-satunya
// pembeda, dan menutup Chrome pribadi operator saat LIVE jalan akan terlihat
// seperti sistem yang merusak mesinnya sendiri.
function createWindowsChromeKiller({ profileDirName = "autopin-profile" } = {}) {
  return async function kill() {
    const script = [
      "$ErrorActionPreference='Stop'",
      "$pat='*" + profileDirName + "*'",
      "$c=@(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -like $pat })",
      "$k=0; foreach($p in $c){ try{ Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; $k++ }catch{} }",
      "Write-Output ('killed=' + $k)",
    ].join("; ");
    const out = await runPowerShell(script);
    const m = /killed=(\d+)/.exec(out);
    return { killed: m ? Number(m[1]) : 0 };
  };
}

// Adapter discovery TikTok sungguhan. Dibangun dengan fungsi yang SAMA yang
// dipakai jalur pin — launchBrowser/getPage/openConsole dari autopin/browser.js,
// collectProducts/readIdentity dari autopin/products.js, checkIdentity dari
// autopin/core.js. Bukan tiruan: kalau daftar produk yang dilihat UI berbeda dari
// yang dicari saat pin, mapping akan dibuat atas dasar daftar yang salah.
//
// Dimuat MALAS (require di dalam fungsi) supaya Puppeteer tidak ikut dimuat ke
// proses Controller sampai discovery benar-benar diminta.
function buildBrowserDeps() {
  let browserMod;
  let productsMod;
  let coreMod;
  let serviceMod;
  try {
    browserMod = require("../autopin/browser");
    productsMod = require("../autopin/products");
    coreMod = require("../autopin/core");
    // isExpectedConsole dipinjam dari service: fungsi URL murni yang SAMA yang
    // dipakai sebelum mengklik apa pun. Menyalinnya ke sini akan menyimpang,
    // persis seperti salinan normalizeTitleKey di P2.
    serviceMod = require("../autopin/service");
  } catch {
    return null;
  }
  return {
    launchBrowser: browserMod.launchBrowser,
    getPage: browserMod.getPage,
    openConsole: browserMod.openConsole,
    closeBrowser: browserMod.closeBrowser,
    collectProducts: productsMod.collectProducts,
    readIdentity: productsMod.readIdentity,
    checkIdentity: coreMod.checkIdentity,
    isExpectedConsole: serviceMod.isExpectedConsole,
    // Customer config -> bentuk config yang dipahami launchBrowser/openConsole.
    // Tanpa ini, profileDir undefined dan browser gagal dibuka.
    toBrowserConfig: toAutopinConfig,
  };
}

function buildTikTokDiscovery(deps) {
  if (!deps) return null;
  return createTikTokDiscovery(
    Object.assign({}, deps, {
      log: (tag, fields) => console.log("[CONTROLLER_TIKTOK_" + tag + "]", JSON.stringify(fields || {})),
    })
  );
}

// Scene yang punya detail pemutaran (mediaInputs/waitForMediaEnd/duration) di
// array RULES. Pemetaan ke scene di luar daftar ini ditolak preflight, karena
// Controller tidak punya cara mengetahui nama input media-nya — dan menebak
// durasi berarti mengubah perilaku pemutaran scene itu.
//
// Dibaca lewat require("../index") yang SENGAJA hanya mengambil RULES. Itu aman:
// index.js hanya menjalankan startLive() kalau ia modul utama, dan di sini ia
// bukan. Yang ikut termuat adalah dotenv dan objek OBSWebSocket yang belum
// tersambung ke mana pun — tidak ada koneksi, tidak ada browser, tidak ada bot.
function readPlayableScenes() {
  try {
    const bot = require("../index");
    return Array.isArray(bot.RULES) ? bot.RULES.map((r) => r.scene) : null;
  } catch {
    return null;
  }
}

async function main(argv) {
  const { port, serviceArgs, parentPipe, nodePath } = parseArgs(argv);
  const onWindows = process.platform === "win32";
  const browserDeps = buildBrowserDeps();

  const controller = createController({
    cwd: ROOT,
    serviceArgs,
    // null = process.execPath (jalur manual). Diisi hanya oleh aplikasi desktop.
    ...(nodePath ? { nodePath } : {}),
    // Penyapu hanya dipasang di Windows: di platform lain ia tidak ada, dan
    // process-manager akan melaporkan dirinya tidak terkonfigurasi daripada
    // berpura-pura menyapu.
    orphanSweeper: onWindows ? createWindowsOrphanSweeper() : null,
    killAutomationChrome: onWindows ? createWindowsChromeKiller() : null,
    // P2
    obsDiscovery: createObsDiscovery(),
    tiktokDiscovery: buildTikTokDiscovery(browserDeps),
    playableScenes: readPlayableScenes(),
    // Alur login memakai fungsi browser yang SAMA dengan discovery dan dengan
    // jalur pin. Satu sesi, satu profil, satu gerbang identitas.
    loginDeps: browserDeps,
  });

  const server = createServer({ controller, port });
  const addr = await server.start();

  console.log(
    "[CONTROLLER_LISTENING] host=" + addr.host + " port=" + addr.port +
      (serviceArgs.length > 0 ? ' serviceArgs="' + serviceArgs.join(" ") + '"' : "")
  );
  console.log("[CONTROLLER_READY] note=\"nothing is running yet; POST /api/start to begin\"");

  // Child TIDAK boleh hidup lebih lama dari Controller. Child yatim adalah bentuk
  // persis dari insiden 2026-10-05, dan di situ sebabnya adalah proses yang
  // ditinggalkan tanpa ada yang merasa memilikinya.
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("[CONTROLLER_SHUTDOWN] signal=" + signal);
    try {
      const r = await controller.shutdown();
      if (!r.ok) {
        console.error("[CONTROLLER_SHUTDOWN_INCOMPLETE] note=\"child processes may still be running\"");
      }
    } catch (err) {
      console.error("[CONTROLLER_SHUTDOWN_FAILED] detail=" + String(err && err.message).slice(0, 160));
    } finally {
      await server.stop();
      process.exit(0);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Jalur berhenti dari INDUK (aplikasi desktop), lewat stdin.
  //
  // Kenapa stdin dan bukan sinyal: di Windows, child.kill("SIGTERM") memanggil
  // TerminateProcess — handler di atas tidak pernah berjalan, dan Controller mati
  // tanpa membereskan bot, service, maupun Chrome automation. Itu persis bentuk
  // proses yatim yang P1 dibuat untuk mencegah.
  //
  // Kenapa bukan endpoint HTTP: sebuah proses yang bisa dimatikan lewat jaringan
  // adalah permukaan serang yang tidak perlu ada, sekecil apa pun. Kepemilikan
  // induk-anak sudah cukup, dan hanya induknya yang punya stdin ini.
  // HANYA kalau induknya memang memintanya lewat --parent-pipe.
  //
  // Tanpa gerbang ini, `node controller/index.js` yang dijalankan dengan stdin
  // tertutup (mis. stdio "ignore", atau `< /dev/null`) akan langsung melihat
  // peristiwa "end" dan mematikan dirinya sendiri sedetik sesudah menyala. Jalur
  // manual dari terminal tidak boleh berubah sedikit pun karena P4.
  if (parentPipe && process.stdin && typeof process.stdin.on === "function") {
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buffer += String(chunk);
      // Satu perintah per baris. Hanya satu yang dikenal; sisanya diabaikan, bukan
      // ditebak artinya.
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line === "shutdown") shutdown("parent-request");
      }
    });
    // stdin yang tertutup berarti induknya hilang. Controller tidak boleh hidup
    // lebih lama dari aplikasi yang memilikinya.
    process.stdin.on("end", () => shutdown("parent-gone"));
    process.stdin.on("error", () => {
      /* tidak ada stdin (dijalankan manual dari terminal): bukan masalah */
    });
    try {
      process.stdin.resume();
    } catch {
      /* diabaikan */
    }
  }

  return { controller, server };
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error("[CONTROLLER_FATAL] detail=" + String(err && err.message).slice(0, 200));
    process.exit(1);
  });
}

module.exports = { main, parseArgs, createWindowsOrphanSweeper, createWindowsChromeKiller, SERVICE_PASSTHROUGH, ROOT };
