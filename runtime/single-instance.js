"use strict";
// Kunci satu-instance untuk proses bot.
//
// Dibuat sesudah insiden LIVE 2026-10-05 (Phase 21). Tiga proses `node index.js`
// hidup bersamaan tanpa ada yang tahu: bot Phase 19, Phase 20, dan Phase 21.
// Ketiganya tersambung ke room yang sama, mendengar komentar yang sama, dan
// memukul service AutoPIN yang sama di port 5055. Akibatnya bot Phase 20
// melakukan klik Pin KEDUA pada produk yang baru saja di-pin bot Phase 21 —
// yang artinya mematikan pin itu (svc-p21.log:8 `after=Pin`), padahal chat admin
// sudah mengumumkan produknya ter-pin. Pengumuman benar saat dikirim, lalu
// dibuat salah oleh proses yang seharusnya sudah mati.
//
// Service AutoPIN sendiri sudah terlindungi: ia mengikat port 5055, jadi service
// kedua gagal mengikat. Proses bot tidak punya sumber daya eksklusif seperti itu,
// jadi kuncinya dibuat eksplisit di sini.
//
// Arah kegagalannya disengaja: kalau ragu, TOLAK menyala. Bot yang menolak start
// gampang dilihat dan gampang dibetulkan; dua bot yang saling menimpa aksi nyata
// ke akun TikTok tidak kelihatan sampai kerusakannya sudah terjadi.

const fsDefault = require("fs");
const pathDefault = require("path");

const LOCK_FILENAME = ".bot.lock";

// Variabel environment yang memindahkan LETAK kunci — bukan artinya.
//
// Dibutuhkan sejak P5. Di aplikasi terpaket, cwd bot adalah direktori instalasi
// (resources/app), yang hanya dibaca: menulis kunci ke sana akan gagal, dan
// acquire() memperlakukan kegagalan menulis sebagai mode "unlocked" — artinya
// perlindungan bot kedua DIAM-DIAM mati. Itu persis perlindungan yang dibuat
// sesudah insiden 2026-10-05, jadi ia tidak boleh hilang karena letak berkas.
//
// Dibaca DI SINI, bukan di index.js, dengan sengaja: kalau index.js yang
// membacanya, maka letak kunci diputuskan di dua tempat — di sini untuk default
// dan di sana untuk mode terpaket — dan dua tempat yang memutuskan hal yang sama
// akan menyimpang. Controller mengisinya lewat toEnv(); lihat
// controller/config-manager.js.
//
// Namanya diEKSPOR supaya pengisi dan pembacanya memakai string yang SAMA, pola
// yang sama dengan RUNTIME_CONFIG_ENV di runtime/runtime-config.js.
const LOCK_FILE_ENV = "AILIVE_LOCK_FILE";

// process.kill(pid, 0) tidak mengirim sinyal, hanya menanyakan keberadaan proses.
// Jalan juga di Windows. EPERM = proses ADA tapi milik user lain.
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !!err && err.code === "EPERM";
  }
}

// Membaca berkas kunci. Di tingkat modul karena dipakai DUA pihak: pemegang
// kunci (bot) dan INDUK yang membersihkannya. Dua salinan pembaca berarti suatu
// saat keduanya akan berbeda pendapat soal siapa pemilik kunci.
function readLock(target, fs = fsDefault) {
  try {
    const raw = fs.readFileSync(target, "utf8");
    // BOM dibuang dulu; lihat catatan di read() di bawah.
    const parsed = JSON.parse(raw.replace(/^﻿/, ""));
    const owner = Number(parsed && parsed.pid);
    return Number.isInteger(owner) && owner > 0 ? { ...parsed, pid: owner } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// PEMBERSIHAN OLEH INDUK
//
// Kenapa ini perlu ada, dan kenapa tidak cukup mengandalkan bot sendiri:
//
// index.js melepas kuncinya di handler SIGINT/SIGTERM/exit. Di Windows itu
// tidak cukup. `child.kill("SIGTERM")` memanggil TerminateProcess, jadi tidak
// satu pun handler bot dijalankan — terlihat langsung di log run 2026-10-09:
//
//   [CONTROLLER_CHILD_EXIT] role=bot pid=38576 code=null signal=SIGTERM
//
// dan sesudah stop yang BERSIH, %APPDATA%\AI LIVE HOST\.bot.lock masih ada
// dengan pid 38576 yang sudah mati.
//
// Jadi yang berwenang membersihkan adalah pihak yang MEMBUKTIKAN kematiannya,
// yaitu induk. Dua fungsi di bawah adalah satu-satunya jalan untuk itu, dan
// keduanya menolak bertindak tanpa bukti.

// Membersihkan kunci yang ditinggalkan SATU proses tertentu.
//
// Hanya menghapus kalau kunci itu MEMANG milik pid tersebut DAN pid itu TERBUKTI
// mati. Kunci milik pid lain tidak disentuh sama sekali: induk yang menghapus
// kunci bot orang lain akan membuka jalan bagi dua bot berjalan bersamaan, yaitu
// persis insiden 2026-10-05.
function releaseLockFor({ file, pid, fs = fsDefault, isAlive = pidAlive } = {}) {
  if (!file) return { ok: false, code: "no-file" };
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, code: "no-pid" };

  const existing = readLock(file, fs);
  if (!existing) return { ok: true, code: "no-lock" };

  // Bukan milik kita. JANGAN disentuh.
  if (existing.pid !== pid) return { ok: true, code: "not-ours", pid: existing.pid };

  // Milik kita tapi prosesnya masih hidup: berarti kematiannya belum terbukti,
  // dan menghapus kunci sekarang akan mengizinkan bot kedua menyala di samping
  // yang masih berjalan.
  if (isAlive(pid)) return { ok: false, code: "still-alive", pid };

  try {
    fs.unlinkSync(file);
  } catch {
    return { ok: false, code: "unlink-failed", pid };
  }
  return { ok: true, code: "removed", pid };
}

// Membersihkan kunci saat TERBUKTI tidak ada proses bot hidup sama sekali.
//
// Ini jawaban untuk pid yang dipakai ulang Windows. `process.kill(pid, 0)` hanya
// bisa menjawab "ada proses dengan pid ini", bukan "proses itu bot kita". Jadi
// kunci basi yang pid-nya kebetulan dipakai ulang proses lain akan membuat
// acquire() menolak start — penolakan yang salah.
//
// Yang TIDAK dilakukan di sini: melonggarkan acquire(). Pelonggaran apa pun di
// sana akan mengizinkan bot kedua menyala saat bot pertama masih hidup, dan itu
// adalah insiden 2026-10-05. acquire() tetap fail-closed.
//
// Yang dilakukan: memakai BUKTI DARI LUAR. Penyapu yatim di controller/index.js
// menghitung proses `node.exe` yang command line-nya memuat index.js. Kalau ia
// membuktikan NOL, maka kunci yang tersisa tidak mungkin milik bot yang hidup —
// apa pun pid di dalamnya. `botAlive` harus BERNILAI false secara eksplisit;
// null/undefined berarti belum terbukti, dan tanpa bukti tidak ada yang dihapus.
function clearLockIfNoBot({ file, fs = fsDefault, botAlive = null } = {}) {
  if (!file) return { ok: false, code: "no-file" };
  if (botAlive !== false) return { ok: true, code: "unproven" };

  const existing = readLock(file, fs);
  if (!existing) return { ok: true, code: "no-lock" };

  try {
    fs.unlinkSync(file);
  } catch {
    return { ok: false, code: "unlink-failed", pid: existing.pid };
  }
  return { ok: true, code: "removed", pid: existing.pid };
}

function createInstanceLock({
  file,
  pid = process.pid,
  script = "index.js",
  fs = fsDefault,
  isAlive = pidAlive,
  now = () => Date.now(),
  logger = console,
  env = process.env,
} = {}) {
  // Urutannya: argumen eksplisit, lalu environment, lalu cwd.
  //
  // Argumen tetap menang supaya tes dan pemanggil yang menyebutkan berkasnya
  // tidak pernah bisa diganggu oleh environment. cwd tetap menjadi default
  // terakhir supaya `node index.js` dari terminal repo berperilaku persis
  // seperti sebelum P5.
  const fromEnv = env && typeof env[LOCK_FILE_ENV] === "string" && env[LOCK_FILE_ENV] !== ""
    ? env[LOCK_FILE_ENV]
    : null;
  const target = file || fromEnv || pathDefault.join(process.cwd(), LOCK_FILENAME);
  let held = false;

  const log = (line) => {
    try {
      logger.log(line);
    } catch {
      /* diabaikan */
    }
  };

  // BOM dibuang di readLock(): berkas kunci yang disunting tangan di Windows
  // (Out-File, Notepad) hampir selalu berawalan BOM, dan JSON.parse menolaknya.
  // Kalau itu dibiarkan, kunci dianggap tidak ada dan bot kedua justru ikut
  // menyala - persis kebalikan dari gunanya kunci ini.
  //
  // Berkas yang tidak ada, tidak terbaca, atau JSON-nya rusak semuanya
  // diperlakukan sebagai "tidak ada pemilik sah".
  function read() {
    return readLock(target, fs);
  }

  function write() {
    fs.writeFileSync(target, JSON.stringify({ pid, startedAt: now(), script }, null, 2), "utf8");
  }

  function acquire() {
    const existing = read();

    if (existing && existing.pid !== pid && isAlive(existing.pid)) {
      log(
        `[SINGLE_INSTANCE_REFUSED] pid=${existing.pid} script=${existing.script || "?"} lock=${target}` +
          ` note="bot lain masih hidup. Hentikan dulu (scripts/stop-all.ps1), atau hapus ${LOCK_FILENAME} kalau yakin itu sisa."`
      );
      return { ok: false, reason: "already-running", pid: existing.pid, startedAt: existing.startedAt || null };
    }

    const takenOver = !!existing && existing.pid !== pid;
    try {
      write();
    } catch (err) {
      // Tidak bisa menulis kunci bukan alasan menolak playback: dicatat, lalu jalan.
      log(`[SINGLE_INSTANCE_UNLOCKED] note="gagal menulis ${target}: ${String(err && err.message).slice(0, 80)}"`);
      return { ok: true, mode: "unlocked" };
    }

    held = true;
    if (takenOver) log(`[SINGLE_INSTANCE_STALE_TAKEOVER] previousPid=${existing.pid}`);
    log(`[SINGLE_INSTANCE_HELD] pid=${pid} lock=${target}`);
    return { ok: true, mode: takenOver ? "stale-taken-over" : "fresh" };
  }

  function release() {
    if (!held) return false;
    held = false;
    // Hanya hapus kalau kunci itu memang masih milik kita: proses lain yang sudah
    // mengambil alih tidak boleh kehilangan kuncinya karena kita keluar.
    const existing = read();
    if (existing && existing.pid !== pid) return false;
    try {
      fs.unlinkSync(target);
      return true;
    } catch {
      return false;
    }
  }

  return { acquire, release, __read: read, __state: () => ({ held, target, pid }) };
}

module.exports = {
  createInstanceLock,
  releaseLockFor,
  clearLockIfNoBot,
  readLock,
  pidAlive,
  LOCK_FILENAME,
  LOCK_FILE_ENV,
};
