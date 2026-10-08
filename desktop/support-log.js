"use strict";
// Log dukungan lokal untuk aplikasi terpaket. Berotasi, berbatas, dan disunting.
//
// ---------------------------------------------------------------------------
// KENAPA INI PERLU ADA SAMA SEKALI
//
// Seluruh alat diagnosis repo ini adalah log. Setiap keputusan sulit di sini
// — kenapa start ditolak, tahap boot mana yang lambat, apakah shutdown benar
// bersih — dijawab dengan membaca baris [CONTROLLER_*] dan [DESKTOP_*].
//
// Customer tidak punya terminal. Ia menjalankan aplikasi dari shortcut, dan
// stdout-nya tidak pergi ke mana pun. Jadi tanpa berkas ini, satu-satunya
// laporan masalah yang bisa ia berikan adalah "tidak bisa dibuka" — dan itu
// kalimat yang sama untuk node.exe yang hilang, port yang sudah terpakai, dan
// Controller yang crash saat boot.
//
// ---------------------------------------------------------------------------
// TIGA BATAS, DAN SEMUANYA DISENGAJA
//
//   BERBATAS    Log yang tumbuh tanpa batas pada akhirnya adalah bug: LIVE
//               berjam-jam, setiap hari, di mesin customer. Maksimum 5 MB per
//               berkas dan 3 berkas disimpan.
//
//   DISUNTING   Yang lewat sini adalah log Controller. Ia tidak mencetak
//               password hari ini, tapi berkas ini akan hidup lebih lama
//               daripada ingatan siapa pun soal itu, dan customer akan
//               MENGIRIMKAN isinya saat melaporkan masalah. Jadi penyuntingannya
//               dilakukan di sini, di satu tempat, bukan diandalkan pada setiap
//               baris log di masa depan untuk berhati-hati.
//
//   LOKAL       Tidak ada telemetri, tidak ada jaringan. Berkasnya tinggal di
//               %APPDATA%\AI LIVE HOST\logs dan tidak pergi ke mana-mana kecuali
//               customer sendiri yang mengirimkannya.

const fsDefault = require("node:fs");
const path = require("node:path");

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 3;
const BASENAME = "ai-live-host.log";

// Satu baris tidak boleh tak terbatas panjangnya: baris raksasa dari child bisa
// menghabiskan kuota rotasi sendirian dan membuang riwayat yang berguna.
const MAX_LINE = 4000;

// --- penyuntingan -------------------------------------------------------------

// Pola yang isinya TIDAK BOLEH pernah tertulis ke disk.
//
// Masing-masing menyisakan nama field-nya dan membuang nilainya, supaya baris
// log tetap bisa dibaca sebagai peristiwa ("ada password yang disebut di sini")
// tanpa memuat rahasianya.
// Catatan soal `"?` sesudah nama field: ia ada untuk bentuk JSON.
//
// Versi pertama memakai /\b(password)(\s*[:=]\s*)…/ dan itu MELEWATKAN
// `{"password": "hunter2"}` — karena sesudah kata `password` yang datang adalah
// tanda kutip PENUTUP nama field, bukan titik dua. Jadi bentuk key=value
// tersunting sementara bentuk JSON lolos utuh ke disk.
//
// Itu ditemukan oleh tes, bukan oleh pembacaan ulang. Penyuntingan rahasia
// adalah jenis kode yang kalau salah tetap terlihat benar: keluarannya tetap
// berisi kata "password", dan yang berubah hanya ada atau tidaknya nilainya.
const REDACTIONS = Object.freeze([
  // password=…   OBS_PASSWORD=…   "password": "…"
  { re: /\b(password|passwd|obs_password|obspassword)("?\s*[:=]\s*)("?)[^\s",}]+\3/gi, to: '$1$2"<redacted>"' },
  // Cookie dan token sesi TikTok. Kalau salah satu ini pernah sampai ke log,
  // mengirimkan log sama dengan mengirimkan akses ke akunnya.
  //
  // Skema otorisasi ikut dilewati sebelum nilainya.
  //
  // Tanpa `(?:bearer|basic|token)\s+`, baris `authorization: Bearer eyJhbGciOi`
  // tersunting menjadi `authorization: <redacted> eyJhbGciOi` — kata "Bearer"
  // yang dibuang, dan TOKEN-nya yang tertulis ke disk. Hasilnya terlihat seperti
  // penyuntingan yang berhasil, dan itulah yang membuatnya berbahaya.
  {
    re: /\b(cookie|set-cookie|sessionid|sessionid_ss|sid_tt|sid_guard|msToken|ttwid|authorization|bearer)("?\s*[:=]\s*)(?:(?:bearer|basic|token)\s+)?\S+/gi,
    to: "$1$2<redacted>",
  },
  // token=…   access_token=…   apiKey=…   secret=…
  { re: /\b([a-z_]*token|api[_-]?key|secret)("?\s*[:=]\s*)("?)[^\s",}]+\3/gi, to: '$1$2"<redacted>"' },

  // ---------------------------------------------------------------------------
  // IDENTITAS PENONTON
  //
  // Dibutuhkan sejak jejak baris anak ada (controller/child-trace.js). Baris
  // `[MATCH] scene=PAX-1 user=<nama> via=<trigger>` memuat nama penonton, dan
  // log ini DIKIRIMKAN customer saat melaporkan masalah. Nama orang lain tidak
  // boleh ikut terkirim; yang dibutuhkan audit adalah `via=` (trigger mana yang
  // cocok), bukan siapa yang mengetiknya.
  //
  // Nilainya dimakan sampai `key=` BERIKUTNYA atau akhir baris, bukan sampai
  // spasi pertama. Itu disengaja: nama penonton hampir selalu MEMUAT SPASI, dan
  // pola `user=(\S+)` hanya akan menyunting kata pertama lalu membiarkan sisanya
  // tertulis — penyuntingan yang terlihat berhasil padahal bocor.
  {
    re: /\b(user|nickname|uniqueId|displayName|requesterNickname)=.*?(?=\s+[a-zA-Z][a-zA-Z0-9_]*=|$)/g,
    to: "$1=<redacted>",
  },

  // Isi komentar penonton. `[TIKTOK_CHAT]` sudah DITOLAK oleh allowlist jejak,
  // jadi ini lapis kedua — untuk kalau suatu saat ada baris lain yang membawa
  // `comment="..."` dan lolos ke sini.
  { re: /\bcomment="(?:[^"\\]|\\.)*"/g, to: 'comment="<redacted>"' },
]);

function redactLine(line) {
  let out = String(line == null ? "" : line);
  for (const r of REDACTIONS) out = out.replace(r.re, r.to);
  return out;
}

// --- rotasi -------------------------------------------------------------------

function createSupportLog({
  dir,
  fs = fsDefault,
  maxBytes = MAX_BYTES,
  keep = KEEP,
  basename = BASENAME,
  now = () => new Date(),
  // Dipanggil kalau menulis log gagal. Default-nya sengaja diam: log yang tidak
  // bisa ditulis TIDAK boleh menjatuhkan aplikasi. Aplikasi yang menolak menyala
  // karena direktori log-nya tidak bisa dibuat adalah aplikasi yang rusak demi
  // kemampuannya menjelaskan kerusakan.
  onError = () => {},
} = {}) {
  if (!dir) throw new Error("support-log: `dir` wajib diisi");

  const target = path.join(dir, basename);
  let bytes = 0;
  let ready = false;
  let broken = false;

  function ensure() {
    if (ready || broken) return ready;
    try {
      fs.mkdirSync(dir, { recursive: true });
      try {
        bytes = fs.statSync(target).size;
      } catch {
        bytes = 0;
      }
      ready = true;
    } catch (err) {
      // SEKALI saja. Direktori yang tidak bisa dibuat tidak akan tiba-tiba bisa,
      // dan mencobanya setiap baris akan mengubah kegagalan log menjadi beban.
      broken = true;
      try {
        onError(err);
      } catch {
        /* diabaikan */
      }
    }
    return ready;
  }

  // ai-live-host.log -> .1 -> .2 -> dibuang
  function rotate() {
    try {
      const oldest = target + "." + keep;
      try {
        fs.rmSync(oldest, { force: true });
      } catch {
        /* tidak ada: normal */
      }
      for (let i = keep - 1; i >= 1; i -= 1) {
        const from = target + "." + i;
        const to = target + "." + (i + 1);
        try {
          if (fs.existsSync(from)) fs.renameSync(from, to);
        } catch {
          /* rotasi yang gagal bukan alasan berhenti mencatat */
        }
      }
      try {
        if (fs.existsSync(target)) fs.renameSync(target, target + ".1");
      } catch {
        /* sama */
      }
      bytes = 0;
    } catch (err) {
      try {
        onError(err);
      } catch {
        /* diabaikan */
      }
    }
  }

  function stamp() {
    try {
      return now().toISOString();
    } catch {
      return "";
    }
  }

  function write(line) {
    if (!ensure()) return false;

    let text = redactLine(line);
    if (text.length > MAX_LINE) text = text.slice(0, MAX_LINE) + "…";
    const record = stamp() + " " + text + "\n";

    // Rotasi diputuskan SEBELUM menulis, jadi berkasnya tidak pernah melewati
    // batas — bukan "melewati lalu dirotasi".
    if (bytes + Buffer.byteLength(record, "utf8") > maxBytes) rotate();

    try {
      fs.appendFileSync(target, record, "utf8");
      bytes += Buffer.byteLength(record, "utf8");
      return true;
    } catch (err) {
      try {
        onError(err);
      } catch {
        /* diabaikan */
      }
      return false;
    }
  }

  return {
    write,
    file: target,
    // Dipakai tes dan laporan dukungan.
    __state: () => ({ bytes, ready, broken, target }),
  };
}

module.exports = { createSupportLog, redactLine, MAX_BYTES, KEEP, BASENAME, REDACTIONS };
