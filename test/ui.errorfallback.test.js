// Kalimat cadangan untuk kode yang BELUM diterjemahkan.
//
// Masalah yang dijaga di sini punya bentuk yang sangat spesifik, dan ia tidak
// akan pernah terlihat di tes lain:
//
//   controller/errors.js translate() SELALU mengisi userMessage. Kode yang ada
//   di katalognya mendapat kalimatnya sendiri; kode yang TIDAK ada mendapat satu
//   kalimat generik berbahasa Inggris. Dari sisi UI, keduanya terlihat persis
//   sama - sebuah string tidak kosong di `userMessage`.
//
//   Jadi UI yang "mengutamakan kalimat server" sebenarnya mengutamakan bahasa
//   Inggris, setiap kali sebuah kode mesin belum sempat masuk katalog. Customer
//   yang memilih Bahasa Indonesia membaca bahasa Inggris, dan tidak ada satu pun
//   yang rusak secara teknis - itulah kenapa ia bisa lolos sampai ke pilot.
//
// Yang diuji: kalimat generik server DIKENALI dan tidak pernah menang atas
// kamus, kode mesin tidak pernah sampai ke layar, dan konten customer tidak
// ikut diterjemahkan.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const I = require("../controller/public/i18n.js");
const U = require("../controller/public/ui-logic.js");
const errors = require("../controller/errors.js");

const LANGS = I.LANGS;

// Huruf Han. Dipakai untuk membuktikan kalimat Mandarin BENAR-BENAR Mandarin,
// bukan bahasa Inggris yang kebetulan lolos lewat cabang kalimat server.
const HAN = /[一-鿿]/;

/* === kontrak dengan server =============================================== */

// Nilai ini DISALIN dari controller/errors.js ke dalam i18n.js, karena i18n.js
// adalah modul browser dan tidak boleh me-require kode server.
//
// Salinan yang tidak dipaku akan menyimpang: FALLBACK diubah satu kata di
// server, UI berhenti mengenalinya, dan lubang P0 ini terbuka kembali tanpa satu
// pun tes merah. Tes inilah yang menggantikan impor itu.
test("SERVER_GENERIC di UI PERSIS sama dengan FALLBACK di server", () => {
  assert.equal(I.SERVER_GENERIC, errors.FALLBACK);
});

test("isServerGeneric mengenali kalimat itu, dan hanya kalimat itu", () => {
  assert.equal(I.isServerGeneric(errors.FALLBACK), true);
  // Spasi di ujung berasal dari perjalanan lewat JSON dan rangkaian string.
  assert.equal(I.isServerGeneric("  " + errors.FALLBACK + "  "), true);

  assert.equal(I.isServerGeneric("OBS is not connected."), false);
  assert.equal(I.isServerGeneric(""), false);
  assert.equal(I.isServerGeneric(null), false);
  assert.equal(I.isServerGeneric(undefined), false);
  assert.equal(I.isServerGeneric(42), false);
  // Kemiripan tidak cukup: hanya kalimat yang SAMA yang ditolak.
  assert.equal(I.isServerGeneric("Something went wrong."), false);
});

// Kode yang DIKENAL katalog server harus dikenal kamus UI juga. Kalau tidak,
// customer membaca kalimat server - yang berbahasa Inggris.
test("setiap kode di katalog server punya terjemahan di KETIGA bahasa", () => {
  const codes = Object.keys(errors.CATALOG);
  assert.ok(codes.length > 50, "katalog terlalu kecil: " + codes.length);

  for (const lang of LANGS) {
    const missing = codes.filter((c) => I.DICT[lang]["err." + c] === undefined);
    assert.deepEqual(missing, [], lang + " belum menerjemahkan kode katalog");
  }
});

/* === kode yang BELUM diterjemahkan ====================================== */

// Bentuk jawaban server yang sebenarnya untuk kode di luar katalog.
const unknownFromServer = (code) => ({ ok: false, ...errors.translate(code) });

test("kode di luar katalog TIDAK PERNAH jatuh ke bahasa Inggris server", () => {
  // Kode nyata yang terukur berada di luar katalog saat audit kesiapan pilot.
  const body = unknownFromServer("runtime-exited-unexpectedly");
  assert.equal(body.userMessage, errors.FALLBACK, "prasyarat: server mengisi kalimat generik");

  const id = U.messageOf("id", body, "err.controller-start-failed");
  const zh = U.messageOf("zh-CN", body, "err.controller-start-failed");

  assert.notEqual(id, errors.FALLBACK);
  assert.notEqual(zh, errors.FALLBACK);
  assert.equal(id, I.DICT.id["err.controller-start-failed"]);
  assert.equal(zh, I.DICT["zh-CN"]["err.controller-start-failed"]);
  assert.match(zh, HAN, "layar Mandarin masih berbahasa Inggris");
});

test("tanpa kalimat cadangan pemanggil pun, err.unknown-nya TERLOKALISASI", () => {
  const body = unknownFromServer("sesuatu-yang-belum-punya-nama");

  const id = U.messageOf("id", body, "err.unknown");
  const en = U.messageOf("en", body, "err.unknown");
  const zh = U.messageOf("zh-CN", body, "err.unknown");

  assert.equal(id, I.DICT.id["err.unknown"]);
  assert.equal(en, I.DICT.en["err.unknown"]);
  assert.equal(zh, I.DICT["zh-CN"]["err.unknown"]);

  // Ketiganya harus BERBEDA. Kalau dua di antaranya sama, satu bahasa sedang
  // menampilkan bahasa lain.
  assert.equal(new Set([id, en, zh]).size, 3);
  assert.match(zh, HAN);
  assert.doesNotMatch(id, HAN);
});

// Kalimat cadangan adalah kalimat yang PALING SERING dibaca saat sesuatu gagal
// dengan cara yang belum punya nama. Ia harus memberi tahu customer apa yang
// bisa ia lakukan, bukan hanya bahwa kami tidak tahu.
test("err.unknown BISA DITINDAKLANJUTI di ketiga bahasa", () => {
  const ACTION = {
    id: [/coba lagi/i, /log dukungan/i],
    en: [/try again/i, /support log/i],
    "zh-CN": [/重试/, /支持日志/],
  };
  for (const lang of LANGS) {
    const s = I.DICT[lang]["err.unknown"];
    for (const re of ACTION[lang]) {
      assert.match(s, re, lang + " err.unknown tidak memberi tahu harus apa");
    }
  }
});

test("mengganti bahasa langsung mengganti kalimat cadangan", () => {
  const body = unknownFromServer("kode-yang-sama");
  const seen = LANGS.map((lang) => U.messageOf(lang, body, "err.unknown"));
  assert.equal(new Set(seen).size, 3, "objek yang sama harus berbunyi beda per bahasa");
});

/* === kode mesin tidak boleh sampai ke layar ============================== */

test("kode mesin TIDAK PERNAH ikut tampil, apa pun bentuknya", () => {
  const CODES = [
    "runtime-exited-unexpectedly",
    "profile-in-use",
    "PLAYBACK_END",
    "obs-unavailable",
    "snake_case_internal_tag",
    "ERR_SOMETHING_INTERNAL",
  ];

  for (const code of CODES) {
    for (const lang of LANGS) {
      for (const body of [
        { ok: false, ...errors.translate(code) },
        { ok: false, reason: code },
        { ok: false, error: { code: code, userMessage: errors.FALLBACK } },
      ]) {
        const out = U.messageOf(lang, body, "err.unknown");
        assert.ok(out && out.length > 0, "kalimat kosong untuk " + code);
        assert.ok(
          out.indexOf(code) === -1,
          lang + " menampilkan kode mesin apa adanya: " + JSON.stringify(out)
        );
        assert.notEqual(out, errors.FALLBACK);
      }
    }
  }
});

test("tanpa badan jawaban sama sekali, kalimat pemanggil yang dipakai", () => {
  for (const lang of LANGS) {
    assert.equal(U.messageOf(lang, null, "err.unknown"), I.DICT[lang]["err.unknown"]);
    assert.equal(U.messageOf(lang, {}, "err.obs-unavailable"), I.DICT[lang]["err.obs-unavailable"]);
  }
});

/* === yang TIDAK boleh berubah ============================================ */

test("kode yang dikenal tetap memakai kalimatnya sendiri, bukan cadangan", () => {
  const body = { ok: false, ...errors.translate("obs-unavailable") };
  assert.notEqual(body.userMessage, errors.FALLBACK, "prasyarat: kode ini ada di katalog");

  for (const lang of LANGS) {
    const out = U.messageOf(lang, body, "err.unknown");
    assert.equal(out, I.DICT[lang]["err.obs-unavailable"]);
    assert.notEqual(out, I.DICT[lang]["err.unknown"], "kalimat spesifik tertelan cadangan");
  }
});

test("kalimat server yang MEMANG untuk customer tetap diteruskan", () => {
  // Kode di luar katalog, tapi kalimatnya jelas ditulis untuk dibaca orang.
  // Ini satu-satunya alasan cabang kalimat server masih ada.
  const specific = "Scene PAX-7 tidak ada di OBS Anda.";
  const body = { ok: false, reason: "scene-missing-in-obs", userMessage: specific };
  for (const lang of LANGS) {
    assert.equal(U.messageOf(lang, body, "err.unknown"), specific);
  }
});

test("fieldProblem juga tidak mempercayai kalimat generik server", () => {
  // Jalur kedua yang meneruskan kalimat server ke layar. Dulu hanya fromServer
  // yang dijaga, dan jalur ini tetap bocor.
  for (const lang of LANGS) {
    const out = I.fieldProblem(lang, "mappings[0].product", "kode-field-asing", errors.FALLBACK);
    assert.notEqual(out, errors.FALLBACK);
    assert.ok(out.indexOf(errors.FALLBACK) === -1, lang + ": kalimat generik bocor ke label field");
    // Labelnya tetap bisa dibaca pemilik toko, bukan path mesin.
    assert.ok(out.indexOf("mappings[0]") === -1, lang + ": path mesin tampil apa adanya");
  }
  // Kalimat field yang khusus tetap diteruskan.
  const specific = "Produk ini sudah dipakai aturan lain.";
  assert.equal(I.fieldProblem("id", "mappings[0].product", "kode-asing", specific), specific);
});

/* === pesan harus benar untuk runtime HEADLESS ============================ */

// profile-busy-external keluar dari SATU tempat: controller/login.js:136, saat
// Chrome menolak membuka direktori profil karena proses lain memegangnya.
// Kepemilikan sudah bebas saat itu (acquire(OWNER.LOGIN) di atasnya berhasil),
// jadi pemegangnya bukan login yang tercatat dan bukan run automation.
//
// Sejak runtime headless, pemegang yang paling mungkin adalah Chrome HEADLESS
// yatim sisa penutupan paksa. Ia tidak punya jendela. Pesan lamanya menyuruh
// customer menutup "jendela Chrome lain" - dan customer akan mencari sesuatu
// yang tidak ada, lalu menutup paksa lagi, yang justru membuat yatim berikutnya.
//
// Jalan keluar yang benar sudah ditelusuri sampai ke kodenya:
//   desktop/main.js window-all-closed / before-quit -> gracefulQuit()
//   -> lifecycle.stop() -> sweep() -> cleanupOrphans()
//   -> cleanupAutomationChrome(), yang mencocokkan Chrome lewat direktori
//      profil (Chrome pribadi operator tidak pernah ikut).
// Login TIDAK menyapu dan tidak ada sapuan saat boot, jadi menutup lalu membuka
// aplikasi memang satu-satunya jalan keluar yang ada di tangan customer.
test("profile-busy-external tidak menyuruh menutup jendela yang mungkin tidak ada", () => {
  const WINDOW_WORDS = [
    [/jendela/i, "menyebut jendela (id)"],
    [/\bwindow\b/i, "menyebut jendela (en)"],
    [/\u7a97\u53e3/, "menyebut jendela (zh)"],
  ];

  for (const lang of LANGS) {
    const text = I.DICT[lang]["err.profile-busy-external"];
    assert.ok(text && text.length > 0, lang + " kehilangan pesannya");
    for (const pair of WINDOW_WORDS) {
      assert.doesNotMatch(text, pair[0], lang + " " + pair[1] + ": " + JSON.stringify(text));
    }
  }

  // Kalimat katalog server dibaca juga di log dukungan, jadi ia ikut dijaga.
  assert.doesNotMatch(errors.CATALOG["profile-busy-external"], /\bwindow\b/i);
});

// Pesan yang hanya menghapus saran lama tanpa memberi gantinya membuat customer
// terjebak: ia tahu ada yang salah dan tidak tahu harus apa.
test("profile-busy-external menyebut jalan keluar yang benar-benar ada", () => {
  const WAY_OUT = {
    id: /tutup .*buka lagi/i,
    en: /close .*open it again/i,
    "zh-CN": /\u5173\u95ed[\s\S]*\u91cd\u65b0\u6253\u5f00/,
  };
  for (const lang of LANGS) {
    const text = I.DICT[lang]["err.profile-busy-external"];
    assert.match(text, WAY_OUT[lang], lang + " tidak memberi jalan keluar: " + JSON.stringify(text));
  }
});

// Dua kode sebelahnya TETAP akurat dan TIDAK ikut diubah: jendela login memang
// ada jendelanya, dan automation yang berjalan memang bisa dihentikan.
test("profile-busy-login dan -automation tetap menyebut pemegangnya", () => {
  for (const lang of LANGS) {
    for (const code of ["profile-busy-login", "profile-busy-automation"]) {
      const text = I.DICT[lang]["err." + code];
      assert.ok(text && text.length > 0, lang + "/" + code);
    }
  }
});

/* === konten customer tidak diterjemahkan ================================= */

test("konten customer TIDAK ikut berganti bahasa", () => {
  // Judul produk, kalimat pemicu penonton, dan nama scene adalah milik
  // customer. Kalau salah satunya pernah masuk kamus, ia akan berganti bahasa
  // di tengah LIVE.
  const OWNED = ["PAX-1", "PAX-3", "et 1", "Paket Hemat Sosis"];
  for (const lang of LANGS) {
    const values = Object.keys(I.DICT[lang]).map((k) => I.DICT[lang][k]);
    for (const text of OWNED) {
      const hit = values.filter((v) => String(v).indexOf(text) !== -1);
      assert.deepEqual(hit, [], lang + " memuat konten customer: " + text);
    }
  }
});
