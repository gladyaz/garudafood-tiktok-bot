"use strict";
// Gerbang keselamatan untuk probe DOM. FUNGSI MURNI - tidak membaca disk,
// tidak menjalankan PowerShell, tidak menyentuh HTTP. Semua fakta DISUNTIKKAN.
//
// Alasannya bukan kerapian: gerbang yang mengumpulkan faktanya sendiri hanya
// bisa diuji dengan benar-benar menjalankan Controller dan Chrome, yaitu
// tepat keadaan yang gerbang ini ada untuk mencegah.
//
// ---------------------------------------------------------------------------
// KENAPA GERBANGNYA SEBANYAK INI
//
// Profil Chrome terkunci SATU proses. Kepemilikannya disimpan sebagai variabel
// DI DALAM MEMORI proses Controller (controller/profile-owner.js: `let owner =
// OWNER.NONE`), jadi tidak ada cara bagi alat di luar proses itu untuk
// mendaftarkan klaim. Artinya probe ini TIDAK BISA ikut protokol kepemilikan -
// ia hanya bisa membuktikan bahwa tidak ada orang lain yang memegang profil,
// lalu bergerak cepat.
//
// Dan taruhannya bukan error yang rapi. controller/discovery/tiktok.js:20-28
// menulisnya sendiri: Chrome kedua dengan profil yang sama "bisa merusak sesi
// login yang dipakai service untuk memin produk sungguhan di tengah LIVE".
//
// ---------------------------------------------------------------------------
// YANG SENGAJA TIDAK ADA DI MODUL INI
//
// Tidak ada kill. Tidak ada penghapusan lock. Tidak ada pembuatan ulang profil.
// Satu-satunya keluarannya adalah vonis: lanjut, atau berhenti dengan alasan.

// Kode penolakan -> kalimat untuk operator. Kode mesinnya tetap yang dicatat.
const REFUSAL_TEXT = Object.freeze({
  "automation-running": "Automation sedang berjalan (.bot.lock ada). Hentikan dulu dari dashboard.",
  "service-running": "Controller melaporkan service AutoPIN masih hidup.",
  "bot-running": "Controller melaporkan proses bot masih hidup.",
  "login-active": "Jendela login TikTok sedang terbuka dan memegang profil.",
  "profile-owned": "Controller melaporkan profil Chrome sedang dipegang.",
  "controller-state-unreadable": "Status Controller terbaca tapi bentuknya tidak dikenali - kepemilikan profil tidak bisa dibuktikan.",
  "chrome-version-mismatch": "Versi Chrome yang akan dipakai berbeda dari versi yang terakhir memakai profil ini.",
  "chrome-path-missing": "Berkas Chrome yang ditunjuk --chrome-path tidak ada.",
  "chrome-using-profile": "Masih ada proses Chrome yang memakai profil automation.",
  "profile-missing": "Direktori profil tidak ditemukan - tidak ada sesi login untuk dibaca.",
  "controller-state-unknown": "Controller tidak bisa dihubungi, jadi kepemilikan profil tidak bisa dibuktikan.",
  "operator-confirmation-missing": "Butuh konfirmasi operator eksplisit (--operator-confirmed).",
  "live-not-confirmed": "Butuh konfirmasi bahwa LIVE sedang on air (--live-on-air).",
});

// facts:
//   botLockExists        boolean   - .bot.lock ada?
//   profileDirExists     boolean
//   controller           { reachable, profileOwner, serviceRunning }
//   chromePidsOnProfile  array     - PID chrome.exe yang command line-nya menyebut profil
//   chromeScanOk         boolean   - pemindaian proses benar-benar berjalan?
//   devToolsPortExists   boolean   - sisa DevToolsActivePort (diagnostik saja)
//   operatorConfirmed    boolean   - operator menyatakan Controller berhenti & aman
//   liveOnAir            boolean   - operator menyatakan LIVE on air
function evaluateSafety(facts = {}) {
  const f = facts || {};
  const refusals = [];
  const warnings = [];
  const add = (code, detail) => refusals.push({ code, detail: detail || "", userMessage: REFUSAL_TEXT[code] || code });

  // 1. automation berjalan -> service memegang profil
  if (f.botLockExists === true) add("automation-running");

  // 2. Controller: dua sinyal terpisah, keduanya perlu
  const c = f.controller && typeof f.controller === "object" ? f.controller : { reachable: false };
  if (c.reachable === true) {
    // Bentuk /api/status yang SUNGGUHAN (diverifikasi 2026-10-20 terhadap
    // Controller yang berjalan): service.running, bot.running, automation,
    // login.active, profile.owner - semuanya di tingkat ATAS.
    //
    // Field yang TIDAK terbaca diperlakukan sebagai tidak aman, bukan sebagai
    // "tidak ada masalah". Field yang salah alamat mengembalikan undefined, dan
    // `undefined === true` selalu false - jadi gerbang yang menebak alamatnya
    // akan selalu lolos dengan tenang. Itu bentuk insiden 2026-10-05, dan versi
    // pertama gerbang ini memang jatuh ke lubang itu (membaca process.service).
    const bool = (v) => (v === true || v === false ? v : null);
    const serviceRunning = bool(c.serviceRunning);
    const botRunning = bool(c.botRunning);
    const loginActive = bool(c.loginActive);
    const owner = typeof c.profileOwner === "string" ? c.profileOwner : null;
    const state = typeof c.automationState === "string" ? c.automationState : null;

    if (serviceRunning === null || botRunning === null || loginActive === null || owner === null || state === null) {
      add("controller-state-unreadable");
    } else {
      if (state !== "STOPPED") add("automation-running", "automation=" + state);
      if (serviceRunning === true) add("service-running");
      if (botRunning === true) add("bot-running");
      if (loginActive === true) add("login-active");
      if (owner !== "none") add("profile-owned", "owner=" + owner);
    }
  } else {
    // Controller mati TIDAK otomatis aman: kita tidak bisa membuktikannya, dan
    // ia bisa dinyalakan kapan saja oleh operator. Hanya konfirmasi eksplisit
    // yang menutup celah ini.
    if (f.operatorConfirmed === true) warnings.push({ code: "controller-unreachable-acknowledged" });
    else add("controller-state-unknown");
  }

  // 3. proses Chrome yang memakai profil. Pemindaian yang GAGAL diperlakukan
  //    sebagai tidak aman - bukan sebagai nol. Itu bentuk insiden 2026-10-05:
  //    pola yang tidak cocok menerbitkan angka nol yang menenangkan.
  if (f.chromeScanOk !== true) add("chrome-using-profile", "pemindaian proses tidak berhasil");
  else if (Array.isArray(f.chromePidsOnProfile) && f.chromePidsOnProfile.length > 0) {
    add("chrome-using-profile", "pid=" + f.chromePidsOnProfile.join(","));
  }

  // 4. profil harus ADA. Chrome akan membuatnya kalau tidak ada, dan profil
  //    kosong berarti halaman login - bukan dashboard yang bisa diaudit.
  if (f.profileDirExists !== true) add("profile-missing");

  // 5. konfirmasi operator. Tanpa ini, "konteks inspeksi yang aman" tidak
  //    pernah bisa dibuktikan: tidak ada tes mesin yang bisa tahu apakah ada
  //    manusia yang sedang menyiarkan.
  if (f.operatorConfirmed !== true) add("operator-confirmation-missing");
  if (f.liveOnAir !== true) add("live-not-confirmed");

  // 6. Versi Chrome. Membuka profil login dengan build Chrome yang BERBEDA bisa
  //    meng-upgrade skema data profil, dan upgrade itu TIDAK bisa dibatalkan -
  //    artinya satu probe diagnostik bisa merusak sesi login customer secara
  //    permanen. Profil menyimpan versi pemakai terakhirnya di berkas
  //    "Last Version"; kalau keduanya diketahui dan BERBEDA, berhenti.
  //
  //    Kalau salah satunya tidak diketahui, ini jadi CATATAN, bukan penolakan:
  //    jalur pengembang memang tidak menyebut chromePath dan memakai Chrome
  //    bawaan Puppeteer, dan memaksa penolakan di sana akan mematikan alatnya
  //    untuk kasus yang justru paling aman.
  const vProfil = typeof f.profileLastVersion === "string" && f.profileLastVersion ? f.profileLastVersion : null;
  const vChrome = typeof f.chromeVersion === "string" && f.chromeVersion ? f.chromeVersion : null;
  if (f.chromePathGiven === true && f.chromePathExists !== true) add("chrome-path-missing");
  if (vProfil && vChrome && vProfil !== vChrome) {
    add("chrome-version-mismatch", "profil=" + vProfil + " chrome=" + vChrome);
  } else if (!vProfil || !vChrome) {
    warnings.push({ code: "chrome-version-unverified", detail: "profil=" + (vProfil || "?") + " chrome=" + (vChrome || "?") });
  }

  // DevToolsActivePort yatim: Chrome bersih menghapusnya saat keluar, jadi
  // sisanya menandakan sesi yang crash. BUKAN penolakan - membersihkannya
  // dilarang, dan berkas yatim sendiri tidak berbahaya.
  if (f.devToolsPortExists === true && (!Array.isArray(f.chromePidsOnProfile) || f.chromePidsOnProfile.length === 0)) {
    warnings.push({ code: "stale-devtools-port", detail: "sisa sesi Chrome sebelumnya; TIDAK dibersihkan oleh alat ini" });
  }

  return { safe: refusals.length === 0, refusals, warnings };
}

// Memilih PID Chrome yang memakai direktori profil tertentu. MURNI: menerima
// daftar proses yang sudah dibaca, memfilter di JS.
//
// Difilter di JS, bukan di PowerShell, karena quoting pola -like adalah tempat
// bug yang sudah pernah terjadi di repo ini, dan karena fungsi murni bisa diuji
// dengan daftar proses sintetis.
//
// Command line TIDAK PERNAH dikembalikan - hanya PID. Command line memuat jalur
// filesystem dan flag yang tidak dibutuhkan audit ini.
function chromePidsUsingProfile(processes, profileDirName) {
  const needle = String(profileDirName || "").toLowerCase();
  if (!needle) return [];
  const out = [];
  for (const p of Array.isArray(processes) ? processes : []) {
    const cmd = String((p && (p.CommandLine || p.commandLine)) || "").toLowerCase();
    const pid = Number((p && (p.ProcessId || p.pid)) || 0);
    if (!cmd || !Number.isInteger(pid) || pid <= 0) continue;
    if (cmd.indexOf(needle) !== -1) out.push(pid);
  }
  return out;
}

module.exports = { evaluateSafety, chromePidsUsingProfile, REFUSAL_TEXT };
