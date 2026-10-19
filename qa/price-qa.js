"use strict";
// Product Q&A — jalur HARGA. CADANGAN, dipanggil hanya sesudah kedua lapis
// aturan terkonfigurasi gagal.
//
// ---------------------------------------------------------------------------
// URUTAN YANG DIJAMIN OLEH LETAK PEMANGGILAN, BUKAN OLEH DISIPLIN
//
//   1. matchPhrase  -> return      (aturan terkonfigurasi, frasa)
//   2. matchFuzzy   -> return      (aturan terkonfigurasi, fuzzy)
//   3. modul ini                   <- hanya terjangkau kalau keduanya gagal
//   4. tidak ada aksi
//
// Modul ini TIDAK PERNAH melihat komentar yang sudah diklaim sebuah aturan,
// karena handleChat sudah `return` sebelum baris pemanggilnya tereksekusi.
//
// ---------------------------------------------------------------------------
// SEMUA DEPENDENSI DISUNTIKKAN
//
// Tidak memuat Puppeteer, tidak membuka browser, tidak pernah jatuh ke
// discovery Controller. Katalog HANYA datang dari pembaca snapshot service
// (fondasi v0.2.2). Saat automation berjalan, Controller justru TIDAK BISA
// membaca etalase — cadangan ke sana bukan cuma gagal, ia bisa merebut profil
// Chrome di tengah LIVE.

const { detectPriceIntent } = require("./intent-price");
const { resolveProductForQuestion, productIdentity } = require("./resolve-product");
const { buildPriceReply } = require("./reply-price");

// Label untuk log dan transport. BUKAN scene OBS: tidak ada scene yang diputar.
// Dipilih supaya tidak pernah bisa cocok dengan PAX-N di formatter maupun
// dengan NEVER_COMMENTED di autocomment/core.js.
const QA_SCENE = "QA-PRICE";
const INTENT_PRICE = "PRICE";

// Umur maksimum snapshot yang boleh dikutip. Lebih KETAT tidak dilarang;
// lebih longgar ditolak kebijakan fondasi (QUOTE_FRESH_MS 30 detik).
const DEFAULT_MAX_AGE_MS = 30_000;

function createPriceQa({
  // async ({ maxAgeMs, refresh }) -> jawaban GET /products
  readProducts,
  // autoComment.requestComment
  requestComment,
  // qa/dedupe.js createQaDedupe() - jeda 30 detik PER PRODUK
  dedupe,
  // qa/dedupe.js createQaQuota() - plafon admisi GLOBAL Q&A, 2 per 60 detik
  // meluncur. Ada karena jeda per-produk saja TERUKUR tidak cukup: 5 produk x
  // 2 per menit = 10 balasan diinginkan terhadap plafon bersama 6, sehingga
  // Q&A memenuhi seluruh anggaran dan balasan pin HIGH ikut hilang.
  quota,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  enabled = true,
  log = () => {},
} = {}) {
  const say = (line) => {
    try {
      log(line);
    } catch {
      /* logger rusak tidak boleh menjatuhkan jalur chat */
    }
  };

  const declined = (reason, extra = "") => {
    say(`[QA_PRICE_DECLINED] reason=${reason}${extra ? " " + extra : ""}`);
    return { handled: false, reason };
  };

  // Gerbang MURAH dan SINKRON. Dipanggil dari handleChat untuk setiap komentar
  // yang tidak cocok aturan, dan mayoritas besar lalu lintas LIVE berhenti di
  // sini.
  //
  // Sinkron dengan sengaja: kalau penolakan ini terjadi di dalam fungsi async,
  // setiap komentar mengalokasikan rantai promise hanya untuk dibuang. Itu
  // bukan kebocoran - promise-nya selesai begitu event loop berputar - tapi ia
  // biaya per-komentar yang nyata, dan ia terlihat sebagai pertumbuhan heap
  // pada beban yang tidak pernah menyerahkan kendali (test/load.soak.test.js
  // mengukur 50.000 komentar lalu langsung memaksa GC).
  //
  // Hasilnya dioper ke handle() supaya intent tidak dihitung dua kali.
  function precheck(msgNorm) {
    if (enabled !== true) return { price: false, reason: "disabled" };
    if (typeof msgNorm !== "string" || msgNorm.trim() === "") {
      return { price: false, reason: "empty-message" };
    }
    return detectPriceIntent(msgNorm);
  }

  // Mengembalikan { handled, reason }. TIDAK PERNAH melempar: jalur chat tidak
  // boleh bisa dijatuhkan oleh pertanyaan penonton.
  async function handle({ msgNorm, nickname, intent: precomputed } = {}) {
    try {
      // --- 1. intent ------------------------------------------------------
      // Dipakai ulang kalau handleChat sudah menghitungnya lewat precheck().
      const intent = precomputed || precheck(msgNorm);
      if (!intent.price) {
        // Bukan pertanyaan harga: NOL log dan nol aksi. Mayoritas komentar
        // LIVE lewat sini, dan mencatat semuanya akan mengubur log dukungan.
        return { handled: false, reason: intent.reason };
      }

      const hasNumber = Number.isInteger(intent.number);
      if (!hasNumber && (!intent.words || intent.words.length === 0)) {
        return declined("no-product-reference");
      }

      // --- 2. katalog, dari snapshot milik service ------------------------
      if (typeof readProducts !== "function") return declined("no-catalogue-reader");
      const snap = await readProducts({ maxAgeMs, refresh: "if-stale" });
      if (!snap || snap.ok !== true) {
        return declined((snap && snap.error) || "product-snapshot-unavailable");
      }

      // --- 3. resolusi, gagal-tertutup ------------------------------------
      const r = resolveProductForQuestion(snap, { words: intent.words, number: intent.number });
      if (!r.ok) {
        return declined(r.reason, r.count ? `count=${r.count}` : (r.coverage ? `coverage=${r.coverage}` : ""));
      }

      // --- 4. kalimat -----------------------------------------------------
      const reply = buildPriceReply(r.product);
      if (!reply.ok) return declined(reply.reason);

      // --- 5. jeda per-produk --------------------------------------------
      // Diperiksa SESUDAH resolusi karena kuncinya adalah identitas produk,
      // dan identitas itu baru diketahui di sini.
      const identity = productIdentity(r.product);
      if (!identity) return declined("qa-no-identity");
      if (dedupe) {
        const gate = dedupe.allow(INTENT_PRICE, identity);
        if (!gate.ok) {
          say(`[QA_PRICE_COOLDOWN] product=${r.product.number} remainingMs=${gate.remainingMs || 0}`);
          return { handled: false, reason: gate.reason };
        }
      }

      // --- 6b. plafon admisi GLOBAL Q&A ----------------------------------
      // SESUDAH jeda per-produk: pertanyaan yang sudah ter-dedupe tidak boleh
      // ikut memakai slot kuota. Dan SEBELUM requestComment: penolakan di sini
      // berarti nol pekerjaan transport dan nol jatah limiter global terpakai.
      //
      // Tidak diantrekan untuk nanti. Chat penonton bergerak cepat, dan jawaban
      // harga yang telat lebih buruk daripada diam.
      if (quota) {
        const slot = quota.allow();
        if (!slot.ok) {
          say(`[QA_PRICE_QUOTA] product=${r.product.number} used=${slot.used}/${slot.limit} retryAfterMs=${slot.retryAfterMs || 0}`);
          return { handled: false, reason: slot.reason };
        }
      }

      // --- 6. kirim lewat AutoComment yang SUDAH ADA ----------------------
      // requirePin:false  -> tidak ada pin yang dijanjikan kalimat ini, jadi
      //                      bukti pin tidak dituntut.
      // priority dibiarkan NORMAL (bawaan). Jawaban harga TIDAK PERNAH boleh
      // mendahului balasan pin produk yang berprioritas tinggi; autocomment/
      // core.js juga akan menurunkan high tanpa requirePin, jadi ada dua lapis.
      // playId TIDAK dioper: Q&A tidak memutar apa pun, dan sebuah playId
      // palsu akan meracuni semantik stale balasan scene.
      if (typeof requestComment !== "function") return declined("no-sender");
      const res = await requestComment({
        scene: QA_SCENE,
        text: reply.text,
        requirePin: false,
        requesters: 1,
      });

      // --- 7. KEDUA pencatat dimulai HANYA kalau terbukti terkirim --------
      // Kiriman yang gagal tidak boleh memakan jendela apa pun: kalau jeda
      // per-produk termakan, produk itu bungkam setengah menit tanpa pernah ada
      // penonton yang mendapat jawaban; kalau slot kuota termakan, fitur ini
      // membungkam dirinya sendiri tanpa pernah menjawab siapa pun.
      if (res && res.ok === true) {
        if (dedupe) dedupe.note(INTENT_PRICE, identity);
        if (quota) quota.note();
        say(`[QA_PRICE_REPLY] product=${r.product.number} via=${r.via} price="${reply.price}" reason=${res.reason}`);
        return { handled: true, reason: res.reason, product: r.product.number, text: reply.text };
      }
      return declined(`send-${(res && res.reason) || "failed"}`);
    } catch (err) {
      // Jaring terakhir. Dipanggil dari handleChat, dan apa pun yang terjadi di
      // sini tidak boleh keluar sebagai exception.
      return declined("qa-threw", `detail=${String(err && err.message).slice(0, 80)}`);
    }
  }

  return { handle, precheck, QA_SCENE, maxAgeMs };
}

module.exports = { createPriceQa, QA_SCENE, INTENT_PRICE, DEFAULT_MAX_AGE_MS };
