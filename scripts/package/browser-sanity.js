#!/usr/bin/env node
"use strict";
// Memeriksa bahwa browser yang DIBUNDEL benar-benar bisa dijalankan.
//
//   node scripts/package/browser-sanity.js <path-ke-chrome.exe>
//   node scripts/package/browser-sanity.js            (pakai yang distaging)
//
// ---------------------------------------------------------------------------
// KENAPA INI TERPISAH DARI "BERKASNYA ADA"
//
// Memeriksa keberadaan chrome.exe tidak membuktikan apa pun. chrome.exe hanya
// 3 MB; yang membuatnya menyala adalah chrome.dll 266 MB, icudtl.dat, berkas
// .pak, dan direktori locales di sebelahnya. Penyalinan yang terpotong, atau
// allowlist electron-builder yang melewatkan satu subdirektori, menghasilkan
// chrome.exe yang ADA tapi mati saat dijalankan — dan itu baru terlihat di mesin
// customer, pada saat ia menekan LOGIN TIKTOK.
//
// Jadi yang diuji di sini adalah menjalankannya sungguhan.
//
// ---------------------------------------------------------------------------
// YANG SENGAJA TIDAK DILAKUKAN
//
// TIDAK membuka TikTok. TIDAK memakai profil AutoPIN. TIDAK menyentuh LIVE.
// Halamannya about:blank dan profilnya direktori sementara yang dibuang lagi
// sesudahnya, jadi verifikasi packaging tidak pernah bisa menyenggol sesi
// TikTok customer maupun akun sungguhan.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..", "..");
const STAGED = path.join(REPO, "build", "vendor", "browser", "chrome.exe");

function say(tag, fields = {}) {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => {
      const s = String(v);
      return k + "=" + (/[\s"]/.test(s) ? JSON.stringify(s) : s);
    });
  console.log(["[BROWSER_SANITY_" + tag + "]"].concat(parts).join(" "));
}

async function main() {
  const exe = process.argv[2] || STAGED;

  if (!fs.existsSync(exe)) {
    say("FAILED", { reason: "executable-missing", exe });
    return 1;
  }

  // Tetangga yang tanpa mereka chrome.exe tidak akan menyala. Diperiksa lebih
  // dulu supaya laporannya menyebut APA yang hilang, bukan sekadar "gagal start".
  const dir = path.dirname(exe);
  const needed = ["chrome.dll", "icudtl.dat", "resources.pak", "locales"];
  const missing = needed.filter((n) => !fs.existsSync(path.join(dir, n)));
  if (missing.length > 0) {
    say("FAILED", { reason: "incomplete-bundle", missing: missing.join(",") });
    return 1;
  }

  const puppeteer = require("puppeteer");

  // Profil sementara: sesi TikTok customer hidup di profil yang LAIN, dan
  // verifikasi packaging tidak boleh pernah menyentuhnya.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ailive-browser-sanity-"));

  let browser = null;
  const t0 = Date.now();
  try {
    browser = await puppeteer.launch({
      executablePath: exe,
      headless: true,
      userDataDir: profile,
      args: ["--no-first-run", "--no-default-browser-check"],
    });

    const version = await browser.version();
    const page = await browser.newPage();
    await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 20000 });
    const title = await page.title();
    await page.close();

    say("OK", { version, url: "about:blank", title: title === "" ? "(blank)" : title, ms: Date.now() - t0 });
    return 0;
  } catch (err) {
    say("FAILED", { reason: "launch-failed", detail: String((err && err.message) || "").slice(0, 200) });
    return 1;
  } finally {
    try {
      if (browser) await browser.close();
    } catch {
      /* dibereskan di bawah */
    }
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      /* profil sementara yang tertinggal bukan alasan menggagalkan pemeriksaan */
    }
  }
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      say("FAILED", { reason: "unexpected", detail: String((err && err.message) || err).slice(0, 200) });
      process.exit(1);
    }
  );
}

module.exports = { main };
