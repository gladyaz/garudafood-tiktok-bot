"use strict";
// Headed atau headless: SATU tempat yang memutuskannya.
//
// Dua pihak memakai browser automation, dan keduanya ingin hal yang berlawanan:
//
//   LOGIN    customer harus MELIHAT dan mengetik di halaman TikTok.
//            Jendelanya wajib ada. Tidak ada keadaan di mana login yang
//            tak terlihat berguna — ia hanya menggantung selamanya menunggu
//            orang yang tidak pernah diberi tahu harus berbuat apa.
//
//   RUNTIME  discovery, service AutoPIN, konfirmasi pin, AutoComment.
//            Tidak satu pun butuh mata manusia, dan sampai v0.1.0 semuanya
//            membuka jendela Chrome yang muncul-hilang di depan customer
//            setiap kali Periksa ulang, preflight, START, dan STOP berjalan.
//
// Modul ini MURNI: tidak membuka browser, tidak menyentuh disk, tidak membaca
// process.env sendiri. Ia menerima environment sebagai argumen supaya tes bisa
// menjalankan setiap cabang tanpa mengotori environment proses tes.
//
// Bentuknya meniru controller/child-trace.js dengan sengaja: saklar diagnostik
// di repo ini sudah punya pola, dan pola kedua untuk hal yang sama hanya
// menambah tempat untuk lupa.

// Nama variabel environment. Lihat PURPOSE.RUNTIME di bawah untuk semantiknya.
const HEADLESS_ENV = "AILIVE_BROWSER_HEADLESS";

const PURPOSE = Object.freeze({
  LOGIN: "login",
  RUNTIME: "runtime",
});

const PURPOSES = Object.freeze([PURPOSE.LOGIN, PURPOSE.RUNTIME]);

class BrowserPurposeError extends Error {
  constructor(received) {
    super(
      "launchBrowser: purpose wajib dan harus salah satu dari " +
        PURPOSES.join(" | ") +
        ' — diterima: ' +
        JSON.stringify(received)
    );
    this.tag = "NOT_READY";
    this.reason = "browser-purpose-invalid";
    this.received = received;
  }
}

function isPurpose(value) {
  return value === PURPOSE.LOGIN || value === PURPOSE.RUNTIME;
}

// Hanya "false" (tanpa peduli huruf besar-kecil, spasi dipangkas) yang membuat
// runtime terlihat. Apa pun yang lain — unset, kosong, "0", "no", salah ketik —
// jatuh ke headless.
//
// Arah gagalnya dipilih, bukan kebetulan. Nilai yang salah ketik seharusnya
// memberi customer perilaku PRODUKSI yang benar, bukan jendela Chrome yang
// muncul-hilang di tengah LIVE karena ada yang menulis "AILIVE_BROWSER_HEADLES"
// dengan satu S.
function headlessFromEnv(env) {
  const raw = env && typeof env[HEADLESS_ENV] === "string" ? env[HEADLESS_ENV].trim().toLowerCase() : "";
  return raw !== "false";
}

// Satu-satunya fungsi yang menjawab "jendelanya terlihat atau tidak".
//
// `purpose` WAJIB. Tidak ada default, dan itu disengaja: default diam-diam
// adalah persis cara jalur login baru suatu hari menjadi headless tanpa ada
// yang menyadarinya, lalu customer menatap aplikasi yang menunggu login yang
// tidak pernah bisa ia lakukan.
function resolveHeadless(purpose, env) {
  if (!isPurpose(purpose)) throw new BrowserPurposeError(purpose);

  // Login MENANG atas environment. Override itu alat diagnosa untuk runtime;
  // ia tidak pernah boleh mengambil jendela yang dibutuhkan manusia.
  if (purpose === PURPOSE.LOGIN) return false;

  return headlessFromEnv(env);
}

module.exports = {
  HEADLESS_ENV,
  PURPOSE,
  PURPOSES,
  BrowserPurposeError,
  isPurpose,
  resolveHeadless,
};
