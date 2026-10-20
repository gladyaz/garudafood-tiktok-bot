#!/usr/bin/env node
"use strict";
// Pelaksana probe DOM read-only. ALAT DIAGNOSA - bukan modul produksi, tidak
// di-require oleh entry point mana pun, dan `scripts/` tidak ada di build.files.
//
//   node scripts/probe/run-dom-probe.js                      <- HANYA cek gerbang, TIDAK membuka browser
//   node scripts/probe/run-dom-probe.js --profile-dir "<dir>"
//   node scripts/probe/run-dom-probe.js --execute --operator-confirmed --live-on-air --profile-dir "<dir>"
//
// ---------------------------------------------------------------------------
// BAWAANNYA TIDAK MELAKUKAN APA-APA
//
// Tanpa --execute, alat ini mengumpulkan fakta kepemilikan, mencetak vonis, dan
// keluar. Ia tidak memuat Puppeteer, tidak membuka Chrome, tidak menyentuh
// TikTok. Itu disengaja: "jalankan dulu, lihat apa yang terjadi" bukan cara
// yang pantas untuk alat yang menyentuh profil login di tengah LIVE.
//
// --execute pun MENOLAK jalan kecuali setiap gerbang di probe-guards.js hijau,
// termasuk dua pernyataan operator yang tidak bisa disimpulkan mesin:
// --operator-confirmed dan --live-on-air.
//
// ---------------------------------------------------------------------------
// YANG TIDAK PERNAH DILAKUKAN
//
// Tidak mengklik. Tidak menggulir (tidak ada satu pun penulisan scrollTop).
// Tidak mengetik. Tidak mengubah filter. Tidak mem-pin. Tidak mematikan proses.
// Tidak menghapus lock. Tidak membuat ulang profil. Tidak membaca cookie atau
// localStorage. Tidak menulis apa pun ke dalam direktori profil.
//
// Satu-satunya tulisan ke disk adalah satu berkas JSON tersanitasi di direktori
// debug yang sudah di-gitignore, dengan mode 0600.

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const probe = require("./dom-probe-page");
const { evaluateSafety, chromePidsUsingProfile } = require("./probe-guards");
// Aman di puncak berkas: autopin/browser-mode.js MURNI - tidak me-require apa
// pun, tidak membuka browser, tidak menyentuh disk. Jadi ia tidak menarik
// Puppeteer, dan jalur cek-gerbang tetap gratis.
const { PURPOSE } = require("../../autopin/browser-mode");

const DEFAULT_CONSOLE_URL = "https://shop.tiktok.com/streamer/live/product/dashboard";
const CONTROLLER_STATUS_URL = "http://127.0.0.1:4782/api/status";

function parseArgs(argv) {
  const out = {
    execute: false,
    operatorConfirmed: false,
    liveOnAir: false,
    profileDir: path.join(ROOT, ".autopin-profile"),
    debugDir: path.join(ROOT, ".autopin-debug"),
    consoleUrl: DEFAULT_CONSOLE_URL,
    lockFile: null,
    chromePath: "",
    expectedShop: "",
    forbiddenShops: [],
    // Sama dengan default produksi di autopin/config.js:59-60. Lihat bcfg di
    // execute() untuk kenapa membiarkannya undefined adalah bug, bukan pilihan.
    navTimeoutMs: 45_000,
    readyTimeoutMs: 30_000,
    settleMs: 1500,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const val = () => argv[i + 1];
    if (a === "--execute") out.execute = true;
    else if (a === "--operator-confirmed") out.operatorConfirmed = true;
    else if (a === "--live-on-air") out.liveOnAir = true;
    else if (a === "--profile-dir") { out.profileDir = path.resolve(String(val() || "")); i += 1; }
    else if (a === "--debug-dir") { out.debugDir = path.resolve(String(val() || "")); i += 1; }
    else if (a === "--console-url") { out.consoleUrl = String(val() || ""); i += 1; }
    else if (a === "--lock-file") { out.lockFile = path.resolve(String(val() || "")); i += 1; }
    else if (a === "--chrome-path") { out.chromePath = path.resolve(String(val() || "")); i += 1; }
    else if (a === "--expected-shop") { out.expectedShop = String(val() || "").trim(); i += 1; }
    else if (a === "--forbidden-shops") {
      out.forbiddenShops = String(val() || "").split(",").map((x) => x.trim()).filter(Boolean);
      i += 1;
    }
    else if (a === "--settle-ms") { out.settleMs = Math.max(0, Number(val()) || 0); i += 1; }
  }
  // Lock DITURUNKAN dari profil, dan diturunkan SESUDAH semua argumen dibaca.
  //
  // Memakukannya ke akar repo adalah bug: itu letak layout PENGEMBANG. Aplikasi
  // terpaket menaruh keduanya di %APPDATA%\AI LIVE HOST — profil di
  // `browser-profile`, lock di `.bot.lock` — jadi memeriksa lock di repo saat
  // memprobe profil terinstal berarti selalu melihat "tidak ada lock", apa pun
  // yang sebenarnya berjalan. Di KEDUA layout lock-nya bersebelahan dengan
  // direktori profil (desktop/paths.js: DEV_LAYOUT dan PACKAGED_LAYOUT), jadi
  // induk profil adalah turunan yang benar untuk dua-duanya.
  if (out.lockFile === null) out.lockFile = path.join(path.dirname(out.profileDir), ".bot.lock");
  return out;
}

function runPowerShell(script) {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: 20000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve({ ok: !err, stdout: String(stdout || "") })
    );
  });
}

// Daftar proses chrome.exe + command line-nya. Pemfilterannya dilakukan di JS
// (chromePidsUsingProfile), bukan di PowerShell.
async function readChromeProcesses() {
  if (process.platform !== "win32") return { ok: false, processes: [] };
  const r = await runPowerShell(
    "$ErrorActionPreference='Stop'; " +
      "@(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | " +
      "Select-Object ProcessId, CommandLine) | ConvertTo-Json -Compress -Depth 3"
  );
  if (!r.ok) return { ok: false, processes: [] };
  const text = r.stdout.trim();
  if (text === "") return { ok: true, processes: [] };
  try {
    const parsed = JSON.parse(text);
    return { ok: true, processes: Array.isArray(parsed) ? parsed : [parsed] };
  } catch (e) {
    return { ok: false, processes: [] };
  }
}

// Bentuk /api/status dibaca APA ADANYA, tanpa menebak: field yang tidak ada
// dibiarkan null supaya evaluateSafety MENOLAK, bukan diam-diam lolos.
const KOSONG = { reachable: false, profileOwner: null, serviceRunning: null, botRunning: null, automationState: null, loginActive: null };

async function readControllerStatus() {
  try {
    const res = await fetch(CONTROLLER_STATUS_URL, { method: "GET" });
    if (!res.ok) return { ...KOSONG, reachable: true };
    const j = await res.json();
    const bool = (o, k) => (o && typeof o === "object" && typeof o[k] === "boolean" ? o[k] : null);
    return {
      reachable: true,
      profileOwner: j && j.profile && typeof j.profile.owner === "string" ? j.profile.owner : null,
      serviceRunning: bool(j && j.service, "running"),
      botRunning: bool(j && j.bot, "running"),
      loginActive: bool(j && j.login, "active"),
      automationState: j && typeof j.automation === "string" ? j.automation : null,
    };
  } catch (e) {
    return { ...KOSONG };
  }
}

// Versi build Chrome yang AKAN dipakai, dan versi yang TERAKHIR memakai profil.
// Keduanya dibaca, tidak ditebak; yang tidak terbaca dilaporkan null.
function readProfileLastVersion(profileDir) {
  try {
    const t = fs.readFileSync(path.join(profileDir, "Last Version"), "utf8").trim();
    return t === "" ? null : t;
  } catch (e) {
    return null;
  }
}

async function readChromeVersion(chromePath) {
  if (!chromePath) return null;
  if (!fs.existsSync(chromePath)) return null;
  if (process.platform !== "win32") return null;
  const r = await runPowerShell(
    "$ErrorActionPreference='Stop'; (Get-Item -LiteralPath " +
      JSON.stringify(chromePath) +
      ").VersionInfo.ProductVersion"
  );
  if (!r.ok) return null;
  const v = r.stdout.trim();
  return v === "" ? null : v;
}

async function gatherFacts(opts) {
  const chrome = await readChromeProcesses();
  const controller = await readControllerStatus();
  const profileDirName = path.basename(opts.profileDir);
  const chromePathExists = opts.chromePath ? fs.existsSync(opts.chromePath) : false;
  return {
    profileLastVersion: readProfileLastVersion(opts.profileDir),
    chromeVersion: await readChromeVersion(opts.chromePath),
    chromePathGiven: opts.chromePath !== "",
    chromePathExists,
    botLockExists: fs.existsSync(opts.lockFile),
    profileDirExists: fs.existsSync(opts.profileDir),
    devToolsPortExists: fs.existsSync(path.join(opts.profileDir, "DevToolsActivePort")),
    controller,
    chromeScanOk: chrome.ok,
    chromePidsOnProfile: chromePidsUsingProfile(chrome.processes, profileDirName),
    operatorConfirmed: opts.operatorConfirmed === true,
    liveOnAir: opts.liveOnAir === true,
    __profileDirName: profileDirName,
    __profileDir: opts.profileDir,
    __lockFile: opts.lockFile,
    __chromePath: opts.chromePath,
  };
}

// Satu lintasan pembacaan. TIDAK menggulir.
async function onePass(page) {
  const strip = await page.evaluate(probe.readStripInPage, probe.SEL);
  const rows = await page.evaluate(probe.readRowsInPage, probe.SEL);
  const search = await page.evaluate(probe.readSearchInPage, probe.SEL);
  const filters = await page.evaluate(probe.readFiltersInPage, probe.SEL);
  const geometry = await page.evaluate(probe.readScrollAncestorsInPage, probe.SEL);
  const pass = { strip, rows, search, filters, geometry };
  pass.scope = probe.scopeVerdict({ search, filters });
  return pass;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Dependensi NYATA, dimuat hanya saat benar-benar dipakai.
//
// Lazy, dan SEMUANYA lazy: autopin/service.js me-require ./browser di baris 16,
// jadi mengimpor isExpectedConsole di puncak berkas ini pun sudah cukup untuk
// menarik Puppeteer. Jalur cek-gerbang tidak boleh membayarnya, dan tes tidak
// boleh menyentuhnya sama sekali.
//
// isExpectedConsole DIPINJAM dari service, readIdentity/checkIdentity dari
// products/core — bukan ditulis ulang. Keputusan identitas yang disalin berarti
// probe bisa menyetujui akun yang akan ditolak produksi, atau sebaliknya.
function loadRealDeps() {
  const { launchBrowser, getPage, openConsole, closeBrowser } = require("../../autopin/browser");
  const { isExpectedConsole } = require("../../autopin/service");
  const { readIdentity } = require("../../autopin/products");
  const { checkIdentity } = require("../../autopin/core");
  return { launchBrowser, getPage, openConsole, closeBrowser, purpose: PURPOSE.RUNTIME, isExpectedConsole, readIdentity, checkIdentity };
}

// `deps` disuntikkan supaya URUTAN GERBANG bisa diuji tanpa browser. Urutannya
// adalah properti keselamatannya — halaman yang belum tenang dan akun yang
// salah harus menghentikan probe SEBELUM satu pun bukti DOM dibaca — dan
// memeriksa urutan itu dengan grep atas kode sumber bukan bukti: `if (false)`
// tetap menyisakan string yang digrep.
async function execute(opts, deps = null) {
  const { launchBrowser, getPage, openConsole, closeBrowser, purpose, isExpectedConsole, readIdentity, checkIdentity } =
    deps || loadRealDeps();

  // chromePath diteruskan supaya build yang membuka profil customer SAMA dengan
  // yang dipakai produksi. Tanpa ini launchBrowser memakai Chrome bawaan
  // Puppeteer (executablePath: config.chromePath || undefined).
  // navTimeoutMs dan readyTimeoutMs WAJIB diisi, dengan nilai yang sama dengan
  // default produksi (autopin/config.js:59-60).
  //
  // Tanpa keduanya, openConsole memanggil waitForSettled(page, undefined), dan
  // perulangannya adalah `while (Date.now() - start < timeoutMs)` — dengan
  // undefined perbandingannya NaN, jadi FALSE pada pemeriksaan pertama dan
  // badan loop TIDAK PERNAH berjalan. Ia balik dengan settled:false dalam ~0 ms,
  // dan halaman React yang belum merender ikut terbaca sebagai halaman kosong.
  // Itulah yang membuat probe pertama melaporkan identity-not-found.
  const bcfg = {
    profileDir: opts.profileDir,
    debugDir: opts.debugDir,
    consoleUrl: opts.consoleUrl,
    navTimeoutMs: opts.navTimeoutMs,
    readyTimeoutMs: opts.readyTimeoutMs,
    ...(opts.chromePath ? { chromePath: opts.chromePath } : {}),
  };
  let browser = null;
  try {
    // PURPOSE.RUNTIME tertulis di tempat pemanggilan, bukan hanya diinjeksikan:
    // pagar di test/browser.mode.test.js memindai SETIAP pemanggil launchBrowser
    // dan menuntut purpose terbaca di argumennya. Pagar itu benar - purpose yang
    // hilang baru melempar saat dijalankan, yaitu di tengah LIVE customer.
    browser = await launchBrowser(bcfg, purpose || PURPOSE.RUNTIME);
    const page = await getPage(browser);
    const opened = await openConsole(page, bcfg);
    // isExpectedConsole hanya membandingkan origin + pathname (service.js:95),
    // jadi ia TIDAK membuktikan sesi masih hidup — halaman yang belum login pun
    // bisa tetap berada di URL yang sama. Ia hanya membuktikan kita tidak
    // dialihkan ke tempat lain.
    if (!isExpectedConsole(page.url(), opts.consoleUrl)) {
      return { ok: false, reason: "unexpected-page" };
    }

    // Halaman yang BELUM TENANG tidak boleh dibaca sama sekali. Membacanya
    // menghasilkan nol baris, nol identitas, dan strip yang "absent" — semuanya
    // terlihat seperti temuan, padahal hanya berarti React belum selesai.
    if (opened && opened.settled !== true) {
      return { ok: false, reason: "page-not-settled", detail: "readyMs=" + (opened.readyMs === undefined ? "?" : opened.readyMs) };
    }

    // IDENTITAS DULU, SEBELUM satu pun bukti DOM dibaca. Katalog dari akun yang
    // salah lebih berbahaya daripada tidak ada katalog - ia terlihat benar, dan
    // seluruh audit kelengkapan akan dibangun di atas etalase milik orang lain.
    const terlihat = await readIdentity(page);
    const observed = Array.isArray(terlihat) ? terlihat.filter((x) => typeof x === "string" && x.trim() !== "") : [];
    const idv = checkIdentity({ expected: opts.expectedShop, observed, forbidden: opts.forbiddenShops });
    if (!idv.ok) {
      return { ok: false, reason: "identity-" + idv.reason, identity: { ok: false, expected: opts.expectedShop, observed: idv.observed || observed.join(" | ") || "(tidak terbaca)" } };
    }

    const first = await onePass(page);
    await sleep(opts.settleMs);
    const second = await onePass(page);
    return {
      ok: true,
      readyMs: opened && typeof opened.readyMs === "number" ? opened.readyMs : null,
      // Nama toko adalah identitas PUBLIK yang terlihat siapa pun yang menonton
      // LIVE itu, dan ia diminta eksplisit sebagai jejak audit. Bukan kredensial.
      identity: { ok: true, expected: opts.expectedShop, observed: idv.observed },
      passes: [probe.sanitizePass(first), probe.sanitizePass(second)],
      stability: probe.stability(first, second),
    };
  } catch (err) {
    return { ok: false, reason: "probe-failed", detail: String((err && err.message) || "").slice(0, 160) };
  } finally {
    if (browser) {
      try {
        await closeBrowser(browser);
      } catch (e) {
        /* sudah tertutup: tidak mengubah hasil baca */
      }
    }
  }
}

function printVerdict(facts, verdict) {
  console.log("=== GERBANG KESELAMATAN ===");
  console.log("  profil diperiksa         : " + facts.__profileDir);
  console.log("  profil ada               : " + facts.profileDirExists + "  (" + facts.__profileDirName + ")");
  console.log("  lock diperiksa           : " + facts.__lockFile);
  console.log("  .bot.lock ada            : " + facts.botLockExists);
  const c = facts.controller;
  const tampil = (v) => (v === null ? "TIDAK TERBACA" : String(v));
  console.log("  Controller terhubung     : " + c.reachable);
  console.log("  Controller automation    : " + tampil(c.automationState));
  console.log("  Controller profileOwner  : " + tampil(c.profileOwner));
  console.log("  Controller serviceRunning: " + tampil(c.serviceRunning));
  console.log("  Controller botRunning    : " + tampil(c.botRunning));
  console.log("  Controller loginActive   : " + tampil(c.loginActive));
  console.log("  Chrome yang dipakai      : " + (facts.chromePathGiven ? facts.__chromePath + "  ada=" + facts.chromePathExists : "(bawaan Puppeteer)"));
  console.log("  versi Chrome / profil    : " + (facts.chromeVersion || "?") + " / " + (facts.profileLastVersion || "?"));
  console.log("  pemindaian Chrome ok     : " + facts.chromeScanOk);
  console.log("  Chrome memakai profil    : " + (facts.chromePidsOnProfile.length ? facts.chromePidsOnProfile.join(",") : "tidak ada"));
  console.log("  DevToolsActivePort sisa  : " + facts.devToolsPortExists);
  console.log("  operator konfirmasi      : " + facts.operatorConfirmed);
  console.log("  LIVE on air (operator)   : " + facts.liveOnAir);
  console.log("");
  for (const w of verdict.warnings) console.log("  CATATAN  " + w.code + (w.detail ? " - " + w.detail : ""));
  if (verdict.safe) {
    console.log("  VONIS: AMAN");
  } else {
    console.log("  VONIS: DITOLAK");
    for (const r of verdict.refusals) {
      console.log("    - " + r.code + (r.detail ? " (" + r.detail + ")" : "") + ": " + r.userMessage);
    }
  }
}

async function main(argv) {
  const opts = parseArgs(argv);
  const facts = await gatherFacts(opts);
  const verdict = evaluateSafety(facts);
  printVerdict(facts, verdict);

  if (!opts.execute) {
    console.log("");
    console.log("Mode cek-gerbang saja: TIDAK ada browser yang dibuka.");
    console.log("Tambahkan --execute --operator-confirmed --live-on-air untuk benar-benar membaca halaman.");
    return 0;
  }
  if (!verdict.safe) {
    console.log("");
    console.log("BERHENTI: gerbang tidak hijau, halaman TIDAK dibaca.");
    return 1;
  }

  console.log("");
  console.log("Membuka dashboard (headless, read-only, tanpa gulir)...");
  const result = await execute(opts);
  if (!result.ok) {
    console.log("GAGAL: " + result.reason + (result.detail ? " - " + result.detail : ""));
    if (result.identity) {
      console.log("  identitas diharapkan : " + (result.identity.expected || "(tidak diisi)"));
      console.log("  identitas terbaca    : " + result.identity.observed);
      console.log("  TIDAK ada bukti DOM yang dikumpulkan.");
    }
    return 1;
  }
  console.log("  akun terverifikasi    : " + result.identity.observed);

  fs.mkdirSync(opts.debugDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = path.join(opts.debugDir, stamp + "_dom-probe.json");
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2), { mode: 0o600 });

  const p0 = result.passes[0];
  console.log("  scope                 : " + p0.scope);
  console.log("  strip                 : " + p0.strip.state + "  kandidatTotal=" + (p0.strip.candidateTotal === undefined ? "-" : p0.strip.candidateTotal));
  console.log("  baris ter-render      : " + p0.rows.rowMarkers + "  initialized=" + p0.rows.initialized);
  console.log("  pencarian             : " + p0.search.state);
  console.log("  container dipilih     : depth " + p0.geometry.wouldPickDepth + "  scrollerNyata=[" + p0.geometry.realScrollerDepths.join(",") + "]");
  console.log("  heuristik tepat?      : " + p0.geometry.heuristicPicksRealScroller);
  console.log("  stabil antar lintasan : " + JSON.stringify(result.stability));
  console.log("");
  console.log("Laporan tersanitasi: " + outFile);
  console.log("CATATAN: candidateTotal adalah KANDIDAT, belum otoritatif. Jangan dipakai mengubah coverage.");
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("GAGAL: " + String((err && err.stack) || err));
      process.exit(1);
    });
}

module.exports = { parseArgs, gatherFacts, onePass, execute, main, DEFAULT_CONSOLE_URL };
