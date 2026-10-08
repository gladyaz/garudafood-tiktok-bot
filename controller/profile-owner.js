"use strict";
// Siapa yang memegang profil Chrome automation.
//
// Profil itu satu direktori di disk, dan Chrome mengunci satu direktori profil ke
// SATU proses (launchBrowser melempar `profile-in-use` kalau dipaksa). Ada dua
// pihak yang ingin memakainya:
//
//   LOGIN       jendela browser untuk customer login manual ke TikTok
//   AUTOMATION  service AutoPIN, yang memegangnya selama LIVE berjalan
//
// Keduanya SALING EKSKLUSIF, dan itu bukan sekadar soal kerapian: kalau login
// dipaksa membuka profil yang sedang dipakai service, yang rusak bisa jadi sesi
// login yang sedang dipakai memin produk sungguhan di tengah LIVE. Kegagalannya
// tidak terlihat sampai pin berikutnya gagal di depan penonton.
//
// Jadi ada satu pemilik, tercatat eksplisit, dan perpindahannya hanya lewat
// acquire/release. Tidak ada "kira-kira bebas".
//
// Modul ini MURNI: tidak membuka browser, tidak menyentuh disk. Ia hanya menjawab
// siapa pemiliknya dan menolak permintaan yang bertabrakan.

const OWNER = Object.freeze({
  NONE: "none",
  LOGIN: "login",
  AUTOMATION: "automation",
});

// Alasan penolakan dipilih supaya pesannya bisa menyebut SIAPA yang memegang,
// bukan hanya "sibuk". Customer yang diberi tahu "hentikan automation dulu" bisa
// bertindak; yang diberi tahu "profil sibuk" tidak.
const REASONS = Object.freeze({
  BUSY_LOGIN: "profile-busy-login",
  BUSY_AUTOMATION: "profile-busy-automation",
});

function createProfileOwnership({ log = () => {}, now = () => Date.now() } = {}) {
  let owner = OWNER.NONE;
  let since = null;

  function state() {
    return { owner, since };
  }

  function busyReason() {
    if (owner === OWNER.LOGIN) return REASONS.BUSY_LOGIN;
    if (owner === OWNER.AUTOMATION) return REASONS.BUSY_AUTOMATION;
    return null;
  }

  // Mengambil kepemilikan. Permintaan dari pemilik yang SAMA ditolak juga, bukan
  // diteruskan: dua jendela login atau dua service adalah tepat kondisi yang
  // modul ini dibuat untuk mencegah, dan membiarkannya lewat karena "ya sudah
  // dia juga yang punya" akan menyembunyikan start kedua.
  function acquire(who) {
    if (who !== OWNER.LOGIN && who !== OWNER.AUTOMATION) {
      return { ok: false, reason: "unknown-profile-owner" };
    }
    if (owner !== OWNER.NONE) {
      log("PROFILE_BUSY", { wanted: who, owner });
      return { ok: false, reason: busyReason(), owner };
    }
    owner = who;
    since = now();
    log("PROFILE_ACQUIRED", { owner });
    return { ok: true, owner };
  }

  // Melepas kepemilikan. Hanya pemiliknya yang boleh melepas: pihak lain yang
  // melepaskan profil milik orang lain akan membuat dua pihak sama-sama merasa
  // berhak membukanya.
  function release(who) {
    if (owner === OWNER.NONE) return { ok: true, owner };
    if (who !== owner) {
      log("PROFILE_RELEASE_REFUSED", { by: who, owner });
      return { ok: false, reason: "not-profile-owner", owner };
    }
    owner = OWNER.NONE;
    since = null;
    log("PROFILE_RELEASED", { by: who });
    return { ok: true, owner };
  }

  // Jaring terakhir untuk cleanup: dipakai saat Controller membereskan semuanya
  // (shutdown, rollback) dan tidak ada lagi yang berhak memegang apa pun.
  function forceRelease(reason) {
    if (owner === OWNER.NONE) return { ok: true, owner };
    log("PROFILE_FORCE_RELEASED", { from: owner, reason: reason || "cleanup" });
    owner = OWNER.NONE;
    since = null;
    return { ok: true, owner };
  }

  return {
    state,
    owner: () => owner,
    isFree: () => owner === OWNER.NONE,
    heldBy: (who) => owner === who,
    acquire,
    release,
    forceRelease,
  };
}

module.exports = { createProfileOwnership, OWNER, REASONS };
