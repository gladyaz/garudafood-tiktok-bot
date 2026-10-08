#!/usr/bin/env node
"use strict";
// Audit isi aplikasi terpaket, SEBELUM installer dibentuk.
//
//   node scripts/package/verify-package.js [dir]
//
// `dir` default-nya dist/win-unpacked. Dipanggil juga oleh
// scripts/package/after-pack.js, yang dijalankan electron-builder di antara
// "aplikasi sudah dirakit" dan "installer dibentuk" — jadi temuan di sini
// MENGGAGALKAN build, bukan menghasilkan installer yang sudah kotor.
//
// ---------------------------------------------------------------------------
// APA YANG SEBENARNYA DIJAGA
//
// Ada dua kegagalan yang berbeda, dan keduanya tidak akan pernah terlihat dari
// menjalankan aplikasinya:
//
//   1. SESUATU YANG TIDAK BOLEH IKUT, IKUT.
//      .env mesin pengembang memuat password OBS dan username TikTok.
//      data/config.json memuat keduanya lagi. .autopin-profile memuat SESI
//      TIKTOK — cookie yang, kalau ikut terkirim, memberi setiap customer akses
//      ke akun pengembang. Installer yang memuatnya tetap jalan dengan sempurna.
//
//   2. SESUATU YANG HARUS IKUT, TIDAK IKUT.
//      Allowlist `files` electron-builder bekerja dengan menolak secara default.
//      Satu require yang hanya dijalankan saat customer menekan LOGIN TIKTOK
//      (lihat controller/lazy.js) tidak akan pernah ketahuan sampai customer
//      menekannya.
//
// Keduanya diperiksa di sini, dan pemindaian rahasia memakai NILAI SUNGGUHAN
// dari mesin build ini — bukan daftar pola. Pola hanya menemukan rahasia yang
// bentuknya sudah kita duga.

const fs = require("node:fs");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..", "..");
const DEFAULT_DIR = path.join(REPO, "dist", "win-unpacked");

// --- yang TIDAK BOLEH ada di keluaran ----------------------------------------
//
// Dicocokkan ke path relatif bergaya POSIX di dalam direktori keluaran, jadi
// aturannya bisa dibaca sebagai satu daftar dan tidak bergantung pemisah path.
//
// ---------------------------------------------------------------------------
// KENAPA ADA DUA CAKUPAN
//
// Audit ini MENGGAGALKAN build. Jadi aturan yang terlalu lebar bukan sekadar
// berisik — ia menghentikan rilis karena sesuatu yang tidak salah.
//
//   scope: "app"  hanya kode milik repo ini, di LUAR node_modules.
//                 Di sinilah nama seperti "test", "logs", "coverage", ".github"
//                 berarti artefak pengembangan kita.
//
//   scope: "any"  di mana pun, termasuk node_modules. Hanya untuk hal yang tidak
//                 pernah sah di lokasi mana pun.
//
// Tanpa pemisahan ini, aturan `test/` akan cocok dengan direktori `test` milik
// dependensi pihak ketiga — ada puluhan di pohon produksi — dan build akan
// gagal dengan laporan yang menunjuk ke paket orang lain. Hari ini kebetulan
// tidak ada yang cocok, tetapi "kebetulan" bukan dasar untuk gerbang rilis:
// satu `npm update` sudah cukup mengubahnya.
//
// Perhatikan juga `.env`: pola kita mencocokkan `.env.apa pun`, dan banyak paket
// pihak ketiga menyertakan `.env.example` yang tidak berbahaya. Yang berbahaya
// adalah .env MILIK KITA, jadi polanya "app" — dan untuk node_modules disediakan
// aturan sempit tersendiri yang hanya melarang berkas `.env` persis.
const FORBIDDEN = Object.freeze([
  { scope: "app", pattern: /(^|\/)\.env(\.|$)/i, why: "berkas environment pengembang (password OBS, username TikTok)" },
  { scope: "any", pattern: /(^|\/)\.env$/i, why: "berkas environment" },
  { scope: "any", pattern: /(^|\/)\.bot\.lock$/i, why: "kunci runtime; menandakan state ditulis ke dalam direktori instalasi" },
  { scope: "any", pattern: /(^|\/)\.autopin-profile(\/|$)/i, why: "profil browser: memuat SESI TIKTOK pengembang" },
  { scope: "any", pattern: /(^|\/)\.autopin-debug(\/|$)/i, why: "screenshot debug dari akun sungguhan" },
  { scope: "any", pattern: /(^|\/)app\.asar$/i, why: "P5 pilot sengaja asar:false; app.asar berarti konfigurasi tidak berlaku" },
  { scope: "any", pattern: /(^|\/)\.git(\/|$)/i, why: "metadata Git" },
  { scope: "app", pattern: /(^|\/)data\/config\.json(\.tmp)?$/i, why: "config customer dari mesin pengembang" },
  { scope: "app", pattern: /(^|\/)data\/\.runtime(\/|$)/i, why: "artefak config runtime; satu per run, tidak pernah didistribusikan" },
  { scope: "app", pattern: /(^|\/)test(\/|$)/i, why: "direktori tes tidak dibutuhkan saat runtime" },
  { scope: "app", pattern: /(^|\/)\.github(\/|$)/i, why: "konfigurasi CI" },
  { scope: "app", pattern: /(^|\/)coverage(\/|$)/i, why: "laporan coverage" },
  { scope: "app", pattern: /(^|\/)logs(\/|$)/i, why: "log pengembang (memuat nama penonton)" },
  { scope: "app", pattern: /\.log$/i, why: "log pengembang" },
  { scope: "app", pattern: /(^|\/)\.claude(\/|$)/i, why: "konfigurasi alat pengembang" },
  { scope: "app", pattern: /(^|\/)package-lock\.json$/i, why: "artefak build, tidak dibutuhkan saat runtime" },
  { scope: "app", pattern: /(^|\/)\.p5-probe\.js$/i, why: "skrip coba-coba" },
  { scope: "app", pattern: /(^|\/)build\/vendor(\/|$)/i, why: "vendor staging tidak boleh tersalin ke dalam app; ia masuk lewat extraResources" },
  { scope: "app", pattern: /(^|\/)packaging(\/|$)/i, why: "sumber paku runtime; hanya dibutuhkan mesin build" },
  { scope: "app", pattern: /(^|\/)scripts(\/|$)/i, why: "skrip pengembang/build; tidak pernah dijalankan aplikasi" },
]);

// node_modules bukan "milik kita". Aturan scope:"app" tidak berlaku di dalamnya.
const IN_NODE_MODULES = /(^|\/)node_modules\//;

// --- yang WAJIB ada di keluaran ----------------------------------------------
//
// Setiap baris di sini pernah menjadi, atau bisa menjadi, kegagalan yang hanya
// muncul di mesin customer. Yang ditandai lazy= hanya dijalankan jauh sesudah
// aplikasi terlihat sehat.
const REQUIRED = Object.freeze([
  { rel: "resources/app/package.json", why: "metadata app; `main` menentukan entry point Electron" },
  { rel: "resources/app/desktop/main.js", why: "proses utama Electron" },
  { rel: "resources/app/desktop/paths.js", why: "resolver path terpaket" },
  { rel: "resources/app/desktop/lifecycle.js", why: "urutan start/stop" },
  { rel: "resources/app/desktop/controller-child.js", why: "kepemilikan proses Controller" },
  { rel: "resources/app/desktop/node-path.js", why: "resolusi node.exe terbundel" },
  { rel: "resources/app/controller/index.js", why: "entry point Controller; dijalankan sebagai node.exe" },
  { rel: "resources/app/controller/public/index.html", why: "halaman dashboard" },
  { rel: "resources/app/controller/public/app.js", why: "frontend dashboard" },
  { rel: "resources/app/controller/public/ui-logic.js", why: "logika UI" },
  { rel: "resources/app/controller/public/styles.css", why: "gaya dashboard" },
  { rel: "resources/app/index.js", why: "bot; dijalankan sebagai node.exe oleh Controller" },
  { rel: "resources/app/autopin-service.js", why: "service AutoPIN; dijalankan sebagai node.exe" },
  { rel: "resources/app/autopin/browser.js", why: "lazy= dimuat saat LOGIN TIKTOK / discovery" },
  { rel: "resources/app/autopin/products.js", why: "lazy= dimuat saat discovery produk" },
  { rel: "resources/app/autopin/service.js", why: "lazy= dipakai gerbang URL console" },
  { rel: "resources/app/autopin/core.js", why: "lazy= gerbang identitas" },
  { rel: "resources/app/autocomment/click-strategy.js", why: "dibaca service saat start" },
  { rel: "resources/app/tiktok/matcher.js", why: "pencocokan komentar penonton" },
  { rel: "resources/app/runtime/runtime-config.js", why: "artefak config runtime per-run" },
  { rel: "resources/app/runtime/single-instance.js", why: "kunci satu-instance bot" },
  { rel: "resources/app/node_modules/puppeteer/package.json", why: "dependensi produksi" },
  { rel: "resources/app/node_modules/express/package.json", why: "dependensi produksi" },
  { rel: "resources/app/node_modules/dotenv/package.json", why: "dependensi produksi" },
  { rel: "resources/app/node_modules/obs-websocket-js/package.json", why: "dependensi produksi" },
  { rel: "resources/app/node_modules/tiktok-live-connector/package.json", why: "dependensi produksi" },
  { rel: "resources/runtime/node/node.exe", why: "Node terbundel; tanpa ini customer butuh Node terpasang" },
  { rel: "resources/runtime/browser/chrome.exe", why: "browser terbundel" },
  { rel: "resources/runtime/browser/chrome.dll", why: "chrome.exe 3 MB tidak menyala tanpa DLL 266 MB ini" },
  { rel: "resources/runtime/browser/icudtl.dat", why: "data ICU; Chrome menolak start tanpanya" },
  { rel: "resources/runtime/browser/resources.pak", why: "sumber daya Chrome" },
  { rel: "resources/runtime/browser/locales", why: "direktori locale Chrome" },
  { rel: "resources/licenses/node/LICENSE", why: "kewajiban redistribusi runtime Node" },
  { rel: "resources/runtime-manifest.json", why: "manifest dukungan pilot" },
  { rel: "LICENSE.electron.txt", why: "lisensi Electron (diletakkan electron-builder)" },
]);

// --- rahasia dari mesin build ini --------------------------------------------

// Mengumpulkan NILAI rahasia yang sungguhan ada di mesin ini, supaya pemindaian
// mencari yang benar-benar perlu dirahasiakan dan bukan pola yang kita kira.
//
// Nilainya TIDAK PERNAH dicetak — yang dilaporkan hanya namanya. Berkas yang
// menjadi sumbernya sendiri gitignored.
//
// ---------------------------------------------------------------------------
// KENAPA BERDASARKAN NAMA KUNCI, BUKAN "SEMUA ISI .env"
//
// Versi pertama memindai NILAI SETIAP variabel di .env. Hasilnya: build gagal
// dengan 55 temuan, dan 50 di antaranya palsu — karena .env memuat
// `AUTOCOMMENT_TRANSPORT=browser`, dan kata "browser" muncul di hampir setiap
// berkas di repo ini.
//
// Itu bukan ketidaknyamanan kecil. Gerbang yang menerbitkan puluhan temuan palsu
// adalah gerbang yang akan dimatikan orang — dan pada saat itu ia berhenti
// menjaga lima temuan yang sungguhan. Jadi yang dipindai hanya nilai dari kunci
// yang memang rahasia atau mengidentifikasi, dengan ambang panjang per jenisnya.
//
// .env juga memuat host, port, batas waktu, URL, dan mode. Semuanya konfigurasi,
// bukan rahasia, dan tidak ada ruginya kalau ikut ke paket.
const CREDENTIAL_KEY = /password|passwd|secret|token|api[_-]?key/i;
const IDENTITY_KEY = /^(TIKTOK_USERNAME|AUTOPIN_EXPECTED_SHOP)$/;
const BUSINESS_KEY = /^AUTOPIN_PRODUCT_/;

// ---------------------------------------------------------------------------
// TEMUAN YANG SUDAH DIPERIKSA DAN DIIZINKAN
//
// Daftar TERTUTUP, satu baris per berkas, dengan alasannya tertulis. Apa pun di
// luar daftar ini tetap MENGGAGALKAN build.
//
// Gunanya bukan untuk melunakkan gerbang, melainkan untuk membuat satu keputusan
// terlihat. Alternatifnya ada dua dan keduanya lebih buruk: melebarkan aturan
// pemindaian (yang ikut membuka hal-hal lain yang belum pernah diperiksa), atau
// mematikan pemindaian isi sama sekali.
//
// ATURAN KERAS: kredensial TIDAK PERNAH bisa masuk daftar ini. Lihat
// isAcknowledged() — label bertingkat "credential" ditolak di sana, jadi sebuah
// password tidak bisa diizinkan lewat berkas ini sekalipun seseorang
// menambahkannya.
const ACKNOWLEDGED = Object.freeze([
  {
    file: "resources/app/tiktok/chat-gate.js",
    labels: [".env:TIKTOK_USERNAME", ".env:AUTOPIN_EXPECTED_SHOP", "config:tiktok.username", "config:settings.expectedShop"],
    why:
      "Nama akun TES muncul di satu baris KOMENTAR yang menjelaskan normalizeIdentity " +
      "(tiktok/chat-gate.js:47). Bukan kredensial, dan bukan kode. Berkasnya termasuk core " +
      "LIVE yang dibekukan untuk P5 (gerbang chat TikTok), jadi tidak disunting di fase ini. " +
      "Karena pilot memakai asar:false, sumbernya bisa dibaca customer — jadi penghapusan " +
      "komentar itu tercatat sebagai pekerjaan sisa, bukan diabaikan.",
  },
]);

// Kredensial tidak bisa diizinkan, apa pun isi daftar di atas.
function isAcknowledged(file, label) {
  if (CREDENTIAL_KEY.test(label)) return false;
  return ACKNOWLEDGED.some((a) => a.file === file && a.labels.includes(label));
}

function collectSecrets() {
  const secrets = [];

  // Ambang panjang per jenis. Nilai pendek cocok dengan apa saja dan hanya
  // menghasilkan laporan palsu; nilai rahasia dibiarkan berambang rendah karena
  // kalau ia bocor, kerugiannya tidak sebanding dengan satu laporan palsu.
  const add = (label, value, minLength) => {
    const v = String(value == null ? "" : value).trim();
    if (v.length < minLength) return;
    if (/^\d+$/.test(v)) return;
    if (/^https?:\/\//i.test(v)) return;
    if (/^(true|false|dry-run|browser|localhost|127\.0\.0\.1)$/i.test(v)) return;
    secrets.push({ label, value: v });
  };

  const envFile = path.join(REPO, ".env");
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
      if (!m) continue;
      const key = m[1];
      const value = m[2].replace(/^["']|["']$/g, "");

      if (CREDENTIAL_KEY.test(key)) add(".env:" + key, value, 4);
      else if (IDENTITY_KEY.test(key)) add(".env:" + key, value, 6);
      else if (BUSINESS_KEY.test(key)) add(".env:" + key, value, 10);
      // Sisanya konfigurasi, bukan rahasia: diabaikan dengan sengaja.
    }
  }

  const cfgFile = path.join(REPO, "data", "config.json");
  if (fs.existsSync(cfgFile)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8").replace(/^﻿/, ""));
      add("config:obs.password", cfg && cfg.obs && cfg.obs.password, 4);
      add("config:tiktok.username", cfg && cfg.tiktok && cfg.tiktok.username, 6);
      add("config:settings.expectedShop", cfg && cfg.settings && cfg.settings.expectedShop, 6);
      if (Array.isArray(cfg && cfg.mappings)) {
        cfg.mappings.forEach((m, i) => {
          if (m && m.product && m.product.title) {
            add("config:mappings[" + i + "].product.title", m.product.title, 10);
          }
        });
      }
    } catch {
      /* config rusak di mesin build bukan urusan audit ini */
    }
  }

  return secrets;
}

// --- berjalan di atas keluaran ------------------------------------------------

function walk(root) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (e.isDirectory()) {
        out.push({ rel, full, dir: true });
        stack.push(full);
      } else {
        out.push({ rel, full, dir: false });
      }
    }
  }
  return out;
}

// Pemindaian isi dibatasi ke KODE APLIKASI, bukan ke 474 MB runtime yang kita
// staging sendiri dari sumber yang sudah dipaku SHA-256-nya. Memindai ratusan MB
// binary Chrome untuk string akan memakan waktu menit demi keyakinan yang sudah
// kita dapat dari paku itu. "Where practical", dan di sini yang praktis adalah
// bagian yang berasal dari repo ini.
const SCAN_PREFIXES = ["resources/app/"];
const SCAN_SKIP = /(^|\/)node_modules\//;
const TEXTISH = /\.(js|mjs|cjs|json|html|css|md|txt|map|ps1|yml|yaml|xml)$/i;
const MAX_SCAN_BYTES = 4 * 1024 * 1024;

function scanContents(files, secrets) {
  const hits = [];
  if (secrets.length === 0) return hits;

  for (const f of files) {
    if (f.dir) continue;
    if (!SCAN_PREFIXES.some((p) => f.rel.startsWith(p))) continue;
    if (SCAN_SKIP.test(f.rel)) continue;
    if (!TEXTISH.test(f.rel)) continue;

    let text;
    try {
      if (fs.statSync(f.full).size > MAX_SCAN_BYTES) continue;
      text = fs.readFileSync(f.full, "utf8");
    } catch {
      continue;
    }

    for (const s of secrets) {
      if (text.includes(s.value)) hits.push({ file: f.rel, secret: s.label });
    }
  }
  return hits;
}

function verify(dir = DEFAULT_DIR) {
  const problems = [];
  const notes = [];

  if (!fs.existsSync(dir)) {
    return { ok: false, problems: [{ kind: "output-missing", detail: dir }], notes, dir };
  }

  const files = walk(dir);
  notes.push("entri diperiksa: " + files.length);

  // 1. yang tidak boleh ikut
  for (const f of files) {
    const vendored = IN_NODE_MODULES.test(f.rel);
    for (const rule of FORBIDDEN) {
      if (rule.scope === "app" && vendored) continue;
      if (rule.pattern.test(f.rel)) {
        problems.push({ kind: "forbidden", detail: f.rel, why: rule.why });
        break;
      }
    }
  }

  // 2. yang wajib ikut
  const present = new Set(files.map((f) => f.rel));
  for (const req of REQUIRED) {
    if (!present.has(req.rel)) problems.push({ kind: "missing", detail: req.rel, why: req.why });
  }

  // 3. rahasia mesin build
  const secrets = collectSecrets();
  notes.push("nilai rahasia lokal yang dicari: " + secrets.length);
  let acknowledged = 0;
  for (const hit of scanContents(files, secrets)) {
    if (isAcknowledged(hit.file, hit.secret)) {
      acknowledged += 1;
      continue;
    }
    problems.push({ kind: "secret-leak", detail: hit.file, why: "memuat nilai " + hit.secret });
  }
  // Dihitung dan DILAPORKAN, bukan disembunyikan: daftar izin yang tidak pernah
  // disebut dalam keluaran adalah daftar yang akan dilupakan.
  if (acknowledged > 0) notes.push("temuan yang sudah diperiksa & diizinkan: " + acknowledged);

  // 4. `main` aplikasi terpaket HARUS menunjuk shell Electron.
  //
  // package.json repo ini punya "main": "index.js" — itu BOT, bukan shell. Kalau
  // nilai itu lolos ke aplikasi terpaket, Electron akan menjalankan bot sebagai
  // proses utamanya: tanpa jendela, tanpa Controller, dan bot yang menyentuh
  // TikTok dari dalam proses yang dikira cuma shell.
  const pkgPath = path.join(dir, "resources", "app", "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (pkg.main !== "desktop/main.js") {
        problems.push({
          kind: "wrong-main",
          detail: 'main="' + String(pkg.main) + '"',
          why: 'entry point terpaket harus desktop/main.js, bukan bot. Periksa build.extraMetadata.main',
        });
      }
      if (pkg.devDependencies) {
        problems.push({ kind: "dev-deps-shipped", detail: "package.json", why: "devDependencies ikut ke keluaran" });
      }
      notes.push("main terpaket: " + String(pkg.main) + " · versi: " + String(pkg.version));
    } catch (err) {
      problems.push({ kind: "unreadable-package-json", detail: String((err && err.message) || "") });
    }
  }

  // 5. manifest runtime tidak boleh memuat path mesin build
  const manifestPath = path.join(dir, "resources", "runtime-manifest.json");
  if (fs.existsSync(manifestPath)) {
    const raw = fs.readFileSync(manifestPath, "utf8");
    const leak = /[A-Za-z]:\\|\/Users\/|\/home\//.exec(raw);
    if (leak) problems.push({ kind: "manifest-path-leak", detail: leak[0], why: "manifest ikut didistribusikan" });
    try {
      const m = JSON.parse(raw);
      notes.push("manifest: app=" + m.appVersion + " node=" + m.nodeVersion + " browser=" + m.browserVersion);
    } catch {
      problems.push({ kind: "manifest-invalid-json", detail: "resources/runtime-manifest.json" });
    }
  }

  return { ok: problems.length === 0, problems, notes, dir, fileCount: files.length };
}

function report(result) {
  console.log("[VERIFY_PACKAGE] dir=" + result.dir);
  for (const n of result.notes) console.log("[VERIFY_PACKAGE] " + n);

  if (result.ok) {
    console.log("[VERIFY_PACKAGE_OK] note=\"tidak ada rahasia/data pengembang, dan semua berkas runtime ada\"");
    return 0;
  }

  const byKind = new Map();
  for (const p of result.problems) byKind.set(p.kind, (byKind.get(p.kind) || 0) + 1);

  console.error("[VERIFY_PACKAGE_FAILED] problems=" + result.problems.length);
  for (const [kind, n] of byKind) console.error("[VERIFY_PACKAGE_FAILED] " + kind + "=" + n);
  for (const p of result.problems) {
    console.error("  - [" + p.kind + "] " + p.detail + (p.why ? "  — " + p.why : ""));
  }
  return 1;
}

if (require.main === module) {
  const dir = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_DIR;
  process.exit(report(verify(dir)));
}

module.exports = { verify, report, FORBIDDEN, REQUIRED, collectSecrets, isAcknowledged, ACKNOWLEDGED, DEFAULT_DIR };
