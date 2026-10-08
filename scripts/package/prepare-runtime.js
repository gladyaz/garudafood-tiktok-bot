#!/usr/bin/env node
"use strict";
// Menstaging runtime yang dibundel AI LIVE HOST, sebelum electron-builder jalan.
//
//   node scripts/package/prepare-runtime.js
//
// Hasilnya ada di build/vendor/ dan build/generated/ — keduanya gitignored:
//
//   build/vendor/node/node.exe          Node v24.19.0 (92,8 MB)
//   build/vendor/browser/               Chrome for Testing (386 MB, 308 berkas)
//   build/vendor/licenses/node/         LICENSE Node + provenance-nya
//   build/generated/runtime-manifest.json
//
// ---------------------------------------------------------------------------
// KENAPA KEDUANYA DIBUNDEL
//
// Customer tidak boleh perlu memasang apa pun. Tapi ada alasan yang lebih keras
// daripada kenyamanan, dan itu soal keselamatan:
//
//   node.exe   Bot dan service WAJIB berjalan sebagai proses bernama node.exe.
//              Seluruh perlindungan proses yatim mencari Name='node.exe'
//              (scripts/stop-all.ps1 dan penyapu di controller/index.js). Anak
//              yang bernama lain akan tersembunyi dari semuanya — bentuk persis
//              insiden LIVE 2026-10-05. Lihat desktop/node-path.js.
//
//   chrome     Jalur pin diuji terhadap SATU build Chrome. Membiarkan customer
//              memakai Chrome pribadinya berarti setiap customer menjalankan
//              DOM yang berbeda dari yang pernah kita uji, dan kegagalannya
//              muncul sebagai "pin tidak ketemu" di tengah LIVE.
//
// ---------------------------------------------------------------------------
// FAIL-CLOSED, DAN KENAPA SAMPAI KE SHA-256
//
// Yang distaging DIBANDINGKAN dengan packaging/runtime-pins.json, dan
// ketidakcocokan MENGHENTIKAN build. Build yang diam-diam memaketkan Chrome
// versi lain adalah build yang kita kira sudah diuji padahal belum — dan
// itu baru terlihat di mesin customer, saat LIVE sudah jalan.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const REPO = path.resolve(__dirname, "..", "..");
const VENDOR = path.join(REPO, "build", "vendor");
const GENERATED = path.join(REPO, "build", "generated");
const PINS_FILE = path.join(REPO, "packaging", "runtime-pins.json");

const NODE_OUT = path.join(VENDOR, "node");
const BROWSER_OUT = path.join(VENDOR, "browser");
const LICENSE_OUT = path.join(VENDOR, "licenses");
const MANIFEST_OUT = path.join(GENERATED, "runtime-manifest.json");

// --- laporan ------------------------------------------------------------------

function say(tag, fields = {}) {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => {
      const s = String(v);
      return k + "=" + (/[\s"]/.test(s) ? JSON.stringify(s) : s);
    });
  console.log(["[PREPARE_" + tag + "]"].concat(parts).join(" "));
}

// Kegagalan staging TIDAK boleh menghasilkan build setengah jadi: lebih baik
// tidak ada installer daripada installer yang isinya tidak kita kenal.
class PrepareError extends Error {
  constructor(code, detail) {
    super(code + (detail ? ": " + detail : ""));
    this.code = code;
    this.detail = detail || "";
  }
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function countFiles(dir) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) n += 1;
  }
  return n;
}

function dirSizeBytes(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    try {
      total += fs.statSync(path.join(entry.parentPath || entry.path, entry.name)).size;
    } catch {
      /* berkas yang hilang di tengah penghitungan bukan alasan menggagalkan build */
    }
  }
  return total;
}

// Staging ulang selalu dari NOL. Direktori sisa staging sebelumnya bisa memuat
// berkas dari versi Chrome lain yang tidak lagi ditimpa, dan campuran dua versi
// adalah hal yang paling sulit dikenali dari gejalanya.
function resetDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

// --- 1. Node -----------------------------------------------------------------

// node.exe yang distaging adalah node.exe yang MENJALANKAN skrip ini, bukan
// hasil pencarian di PATH. Jadi yang masuk installer persis runtime yang dipakai
// untuk menjalankan 1352 tes repo ini.
function stageNode(pins) {
  const src = process.execPath;
  const base = path.basename(src).toLowerCase();

  if (base !== "node.exe") {
    throw new PrepareError(
      "prepare-must-run-under-node",
      'dijalankan oleh "' + base + '". Jalankan dengan `node scripts/package/prepare-runtime.js`, ' +
        "bukan lewat Electron: yang distaging adalah binary yang menjalankan skrip ini."
    );
  }

  const version = process.version;
  if (version !== pins.node.version) {
    throw new PrepareError(
      "node-version-mismatch",
      "paku=" + pins.node.version + " terstaging=" + version +
        ". Perbarui packaging/runtime-pins.json DAN packaging/licenses/node/ kalau kenaikan versi ini memang disengaja."
    );
  }

  const stat = fs.statSync(src);
  if (stat.size !== pins.node.size) {
    throw new PrepareError("node-size-mismatch", "paku=" + pins.node.size + " terstaging=" + stat.size);
  }

  const digest = sha256(src);
  if (digest !== pins.node.sha256) {
    throw new PrepareError("node-sha256-mismatch", "paku=" + pins.node.sha256 + " terstaging=" + digest);
  }

  resetDir(NODE_OUT);
  const dest = path.join(NODE_OUT, "node.exe");
  fs.copyFileSync(src, dest);

  // Dibuktikan SESUDAH disalin, bukan diasumsikan dari "copyFileSync tidak
  // melempar": salinan yang terpotong adalah kegagalan yang paling mahal untuk
  // ditemukan nanti.
  const copiedDigest = sha256(dest);
  if (copiedDigest !== digest) throw new PrepareError("node-copy-corrupt", "sha256 salinan berbeda dari sumber");

  say("NODE_STAGED", { version, sizeMB: (stat.size / 1048576).toFixed(1), sha256: digest.slice(0, 16) + "…" });
  return { version, size: stat.size, sha256: digest };
}

// --- 2. Lisensi Node ----------------------------------------------------------

// Kewajiban redistribusi TIDAK dikarang di sini. Teksnya datang dari repositori
// resmi nodejs/node pada tag versi yang dibundel, dan sha256-nya ikut dipaku —
// lihat packaging/licenses/node/PROVENANCE.md.
function stageLicenses(pins) {
  const src = path.join(REPO, pins.node.license.path);

  if (!fs.existsSync(src)) {
    throw new PrepareError(
      "node-license-missing",
      src + " tidak ada. Runtime Node TIDAK boleh didistribusikan tanpa lisensinya; " +
        "ambil ulang dari " + pins.node.license.source + " (lihat PROVENANCE.md)."
    );
  }

  const digest = sha256(src);
  if (digest !== pins.node.license.sha256) {
    throw new PrepareError(
      "node-license-sha256-mismatch",
      "paku=" + pins.node.license.sha256 + " terstaging=" + digest +
        ". Teks lisensi tidak boleh disunting; ambil ulang dari sumber resminya."
    );
  }

  resetDir(LICENSE_OUT);
  const nodeLicDir = path.join(LICENSE_OUT, "node");
  fs.mkdirSync(nodeLicDir, { recursive: true });
  fs.copyFileSync(src, path.join(nodeLicDir, "LICENSE"));

  const provenance = path.join(REPO, "packaging", "licenses", "node", "PROVENANCE.md");
  if (fs.existsSync(provenance)) fs.copyFileSync(provenance, path.join(nodeLicDir, "PROVENANCE.md"));

  // Lisensi Electron + Chromium sudah diletakkan electron-builder di dalam
  // aplikasi terpaket; yang kurang hanya Node, karena node.exe kita bundel
  // sendiri di luar Electron.
  say("LICENSE_STAGED", { node: "LICENSE", sha256: digest.slice(0, 16) + "…" });
  return { nodeLicenseSha256: digest };
}

// --- 3. Browser ---------------------------------------------------------------

// Lokasi browser ditanyakan kepada PUPPETEER, lewat resolver resminya, bukan
// ditebak dari pola direktori cache. Kalau suatu saat Puppeteer memindahkan
// cache-nya, yang ikut berubah hanyalah jawaban fungsi ini.
function resolvePuppeteerBrowser() {
  let puppeteer;
  try {
    puppeteer = require("puppeteer");
  } catch (err) {
    throw new PrepareError("puppeteer-unavailable", String((err && err.message) || "").slice(0, 160));
  }

  if (typeof puppeteer.executablePath !== "function") {
    throw new PrepareError("puppeteer-no-resolver", "puppeteer.executablePath() tidak tersedia");
  }

  let exe;
  try {
    exe = puppeteer.executablePath();
  } catch (err) {
    throw new PrepareError("browser-not-installed", String((err && err.message) || "").slice(0, 160));
  }

  if (!exe || !fs.existsSync(exe)) {
    throw new PrepareError(
      "browser-not-installed",
      'Puppeteer menunjuk "' + String(exe) + '" tapi berkasnya tidak ada. Jalankan `npx puppeteer browsers install chrome`.'
    );
  }

  return { exe, dir: path.dirname(exe) };
}

// Versi dibaca dari BINARY-nya, bukan dari nama direktori cache. Nama direktori
// adalah label yang dibuat pengunduh; yang akan dijalankan customer adalah
// berkasnya.
function readBrowserVersion(exe) {
  try {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-Item -LiteralPath " + JSON.stringify(exe) + ").VersionInfo.ProductVersion",
      ],
      { timeout: 20000, windowsHide: true, encoding: "utf8" }
    );
    const v = String(out || "").trim();
    if (/^\d+\.\d+\.\d+\.\d+$/.test(v)) return v;
  } catch {
    /* jatuh ke jalur bawah */
  }
  return null;
}

function stageBrowser(pins) {
  const { exe, dir } = resolvePuppeteerBrowser();

  const digest = sha256(exe);
  if (digest !== pins.browser.sha256) {
    throw new PrepareError(
      "browser-sha256-mismatch",
      "paku=" + pins.browser.sha256 + " terstaging=" + digest +
        ". Jalur pin hanya diuji terhadap build yang dipaku; perbarui packaging/runtime-pins.json " +
        "hanya sesudah menguji ulang jalur pin dengan build baru ini."
    );
  }

  const reported = readBrowserVersion(exe);
  if (reported && reported !== pins.browser.version) {
    throw new PrepareError("browser-version-mismatch", "paku=" + pins.browser.version + " terstaging=" + reported);
  }

  // SELURUH direktori disalin, bukan hanya chrome.exe. chrome.exe sendiri 3 MB;
  // yang membuatnya bisa berjalan adalah chrome.dll 266 MB, icudtl.dat, berkas
  // .pak, dan locales. chrome.exe sendirian tidak akan menyala.
  resetDir(BROWSER_OUT);
  fs.cpSync(dir, BROWSER_OUT, { recursive: true });

  const destExe = path.join(BROWSER_OUT, path.basename(exe));
  if (!fs.existsSync(destExe)) throw new PrepareError("browser-copy-missing-exe", destExe);

  const copiedDigest = sha256(destExe);
  if (copiedDigest !== digest) throw new PrepareError("browser-copy-corrupt", "sha256 salinan berbeda dari sumber");

  const files = countFiles(BROWSER_OUT);
  if (files < pins.browser.minFileCount) {
    throw new PrepareError(
      "browser-copy-incomplete",
      "berkas tersalin=" + files + " minimum=" + pins.browser.minFileCount +
        ". chrome.exe tanpa chrome.dll/locales/*.pak tidak akan menyala."
    );
  }

  const bytes = dirSizeBytes(BROWSER_OUT);
  say("BROWSER_STAGED", {
    version: reported || pins.browser.version,
    files,
    sizeMB: (bytes / 1048576).toFixed(0),
    sha256: digest.slice(0, 16) + "…",
  });

  return {
    version: reported || pins.browser.version,
    executable: path.basename(exe),
    sha256: digest,
    files,
    bytes,
  };
}

// --- 4. Manifest --------------------------------------------------------------

// Manifest dukungan pilot. SENGAJA tanpa path lokal dan tanpa rahasia: ia ikut
// ke dalam aplikasi terpaket dan boleh dibacakan customer saat melaporkan
// masalah. Yang ada di sini hanya versi, hash, dan arsitektur.
function writeManifest({ appVersion, node, browser, licenses }) {
  fs.mkdirSync(GENERATED, { recursive: true });

  const manifest = {
    appVersion,
    nodeVersion: node.version,
    nodeSha256: node.sha256,
    browserVersion: browser.version,
    browserSha256: browser.sha256,
    // Nama berkas di DALAM bundel, bukan path di mesin build. Resolver browser
    // memakainya untuk menemukan executable tanpa menebak namanya.
    browserExecutable: browser.executable,
    nodeLicenseSha256: licenses.nodeLicenseSha256,
    buildArch: "x64",
    buildPlatform: "win32",
    asar: false,
  };

  const text = JSON.stringify(manifest, null, 2) + "\n";

  // Penjaga terakhir: apa pun yang terlihat seperti path Windows atau path home
  // TIDAK boleh lolos ke manifest. Lebih mudah menjaganya di sini sekali
  // daripada mengandalkan setiap penambahan field di masa depan untuk ingat.
  const leak = /[A-Za-z]:\\|\/Users\/|\/home\/|%[A-Z]+%/.exec(text);
  if (leak) throw new PrepareError("manifest-path-leak", 'manifest memuat "' + leak[0] + '"');

  fs.writeFileSync(MANIFEST_OUT, text, "utf8");
  say("MANIFEST_WRITTEN", { appVersion, fields: Object.keys(manifest).length });
  return manifest;
}

// --- main ---------------------------------------------------------------------

function main() {
  if (process.platform !== "win32") {
    throw new PrepareError("wrong-platform", "P5 hanya memaketkan Windows x64; platform=" + process.platform);
  }
  if (process.arch !== "x64") {
    throw new PrepareError("wrong-arch", "P5 hanya memaketkan x64; arch=" + process.arch);
  }

  const pins = JSON.parse(fs.readFileSync(PINS_FILE, "utf8"));
  const appVersion = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version;

  say("START", { appVersion, node: process.version, pins: path.relative(REPO, PINS_FILE) });

  fs.mkdirSync(VENDOR, { recursive: true });

  const node = stageNode(pins);
  const licenses = stageLicenses(pins);
  const browser = stageBrowser(pins);
  const manifest = writeManifest({ appVersion, node, browser, licenses });

  say("DONE", {
    vendorMB: (dirSizeBytes(VENDOR) / 1048576).toFixed(0),
    note: "siap untuk electron-builder",
  });

  return manifest;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    if (err instanceof PrepareError) {
      console.error("[PREPARE_FAILED] code=" + err.code);
      if (err.detail) console.error("[PREPARE_FAILED] detail=" + err.detail);
    } else {
      console.error("[PREPARE_FAILED] code=unexpected detail=" + String((err && err.message) || err));
    }
    process.exit(1);
  }
}

module.exports = { main, PrepareError, VENDOR, GENERATED, MANIFEST_OUT };
