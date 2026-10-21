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

// Penolakan yang TERBUKTI terjadi SEBELUM transport dipanggil.
//
// Daftar ini sengaja berupa ALLOWLIST, dan bawaannya adalah MENAHAN slot.
// Alasannya: hanya untuk reason-reason di bawah posisinya bisa dibuktikan dari
// sumber. Semuanya dihasilkan autocomment/core.js di atas baris
// `sent = Promise.resolve(send({...}))` (core.js:331), jadi pada jalur-jalur itu
// NOL byte pernah menuju TikTok dan slotnya aman dikembalikan.
//
// Yang TIDAK ada di sini, dan karena itu MENAHAN slot:
//
//   timeout        anggaran habis selagi browser mengetik/mengklik
//   send-rejected  promise transport ditolak SESUDAH dispatch
//   send-threw     send() dipanggil lalu melempar - ia sudah dipanggil
//   dispatch-threw catch terluar; posisinya terhadap dispatch tidak terbukti
//   refused + reason apa pun DARI TRANSPORT - kami tidak bisa membuktikan
//                  dari string-nya apakah ada yang sudah terkirim
//
//   stale          SENGAJA tidak masuk: core.js memakai string yang SAMA pada
//                  fase dispatch (sebelum send) DAN fase hasil (sesudah send).
//                  Karena tidak bisa dibedakan, ia diperlakukan post-dispatch.
//
// Menahan paling buruk membuat kami diam 30 detik untuk produk itu. Melepas
// bisa menghasilkan balasan GANDA ke penonton, dan itu tidak bisa ditarik.
const PRE_DISPATCH_REFUSALS = new Set([
  // gerbang 1-3 core.js
  "disabled",
  "empty-scene",
  "scene-never-commented",
  "duplicate-playId",
  // gerbang 3.5: bukti pin (tidak terjangkau Q&A - requirePin selalu false)
  "pin-not-confirmed",
  "pin-not-ok",
  // gerbang 4: pembentukan teks
  "unsupported-scene",
  "empty-text",
  "html-not-allowed",
  "control-chars",
  "too-long",
  "invalid-template",
  // gerbang 5: rate limit global
  "min-interval",
  "min-interval-high",
  "rate-limit",
  // transport belum ada sama sekali
  "no-transport",
]);

// `pin-*` lainnya datang dari inspectPin dan juga pre-dispatch. Diperiksa lewat
// prefix supaya alasan pin baru tidak diam-diam berubah menjadi "menahan".
function isPreDispatch(reason) {
  const r = String(reason == null ? "" : reason);
  if (PRE_DISPATCH_REFUSALS.has(r)) return true;
  return r.startsWith("pin-");
}

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
  // Nomor pengiriman Q&A, naik satu per JAWABAN yang benar-benar dikirim.
  // Bukan playId: tidak ada pemutaran di jalur ini.
  let pengirimanKe = 0;
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
    // Di luar try supaya catch TERLUAR juga bisa melepasnya: setiap lemparan
    // dan penolakan harus melepas reservasi dengan aman.
    const pesanan = [];
    const lepasSemua = () => { while (pesanan.length) pesanan.pop().release(); };
    const kunciSemua = () => { while (pesanan.length) pesanan.pop().commit(); };
    // true begitu transport DIPANGGIL. Sesudah titik itu kami tidak bisa lagi
    // membuktikan bahwa nol byte menuju TikTok, jadi catch terluar pun harus
    // MENAHAN slotnya, bukan melepas.
    let dispatched = false;
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

      // Permintaan sapuan penuh di LATAR. TIDAK PERNAH ditunggu: sapuan penuh
      // berbiaya detik, pembaca ini beranggaran 1500 ms, dan jawaban harga yang
      // telat lebih buruk daripada diam. Service sendiri yang menjaga
      // single-flight, jeda lantai, dan prioritas pin.
      const mintaSapuanPenuh = () => {
        try {
          const bg = readProducts({ maxAgeMs, refresh: "full" });
          if (bg && typeof bg.catch === "function") bg.catch(() => {});
        } catch {
          /* permintaan latar tidak boleh bisa menjatuhkan jalur chat */
        }
      };

      // --- 2. katalog, dari snapshot milik service ------------------------
      if (typeof readProducts !== "function") return declined("no-catalogue-reader");

      // MODE BACA dipilih menurut cara pertanyaannya akan di-resolve, dan itu
      // bukan detail kecil.
      //
      // Penyegaran ringan menghasilkan coverage="viewport". Untuk pertanyaan
      // NAMA itu bukan cuma tidak membantu - ia MERUSAK: snapshot "full" yang
      // baru saja dihasilkan sapuan latar akan diturunkan menjadi "viewport",
      // dan resolusi judul lalu selalu gagal. Terukur: 0% pertanyaan nama
      // terjawab pada LIVE 10 menit sebelum pemisahan ini.
      //
      // Jadi pertanyaan NAMA membaca dengan refresh="never" - ia bersandar pada
      // sapuan penuh - sementara pertanyaan NOMOR tetap memakai penyegaran
      // ringan, karena bagi nomor viewport memang cukup.
      const modeBaca = hasNumber ? "if-stale" : "never";
      const snap = await readProducts({ maxAgeMs, refresh: modeBaca });
      if (!snap || snap.ok !== true) {
        // Snapshot basi/tidak ada. Untuk pertanyaan NAMA, satu sapuan penuh
        // diminta di latar supaya pertanyaan berikutnya punya daftar lengkap
        // yang segar.
        if (!hasNumber) mintaSapuanPenuh();
        return declined((snap && snap.error) || "product-snapshot-unavailable");
      }

      // --- 3. resolusi, gagal-tertutup ------------------------------------
      const r = resolveProductForQuestion(snap, { words: intent.words, number: intent.number });
      if (!r.ok) {
        // Cakupan tidak cukup berarti snapshot-nya SEGAR tapi hanya viewport,
        // dan resolusi lewat judul menuntut daftar LENGKAP. Satu sapuan penuh
        // diminta di LATAR; pertanyaan INI tetap tidak terjawab, pertanyaan
        // berikutnya bisa.
        //
        // TIDAK ditunggu. Sapuan penuh berbiaya detik, pembaca ini beranggaran
        // 1500 ms, dan jawaban harga yang telat lebih buruk daripada diam.
        // Service sendiri yang menjaga single-flight, jeda lantai, dan
        // prioritas pin - di sini cukup satu permintaan tanpa syarat.
        if (r.reason === "coverage-insufficient") mintaSapuanPenuh();
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
      // Keduanya DIPESAN secara sinkron, sebelum satu pun await: inilah yang
      // menutup celah balapan. Bentuk lama (allow lalu note sesudah await)
      // membiarkan pertanyaan kedua melihat pencatat yang masih kosong, dan itu
      // TERUKUR menghasilkan tiga balasan per 60 detik serta dua balasan untuk
      // produk yang sama berjarak 6 detik.
      //
      // Urutannya jeda-dulu-lalu-kuota: pertanyaan yang sudah ter-dedupe tidak
      // boleh ikut memakai slot kuota.
      if (dedupe) {
        const gate = dedupe.reserve(INTENT_PRICE, identity);
        if (!gate.ok) {
          say(`[QA_PRICE_COOLDOWN] product=${r.product.number} remainingMs=${gate.remainingMs || 0}`);
          return { handled: false, reason: gate.reason };
        }
        pesanan.push(gate);
      }

      // --- 6b. plafon admisi GLOBAL Q&A ----------------------------------
      // SEBELUM requestComment: penolakan di sini berarti nol pekerjaan
      // transport dan nol jatah limiter global terpakai.
      //
      // Tidak diantrekan untuk nanti. Chat penonton bergerak cepat, dan jawaban
      // harga yang telat lebih buruk daripada diam.
      if (quota) {
        const slot = quota.reserve();
        if (!slot.ok) {
          // Reservasi sebagian WAJIB dilepas: kalau tidak, produk ini terkunci
          // 30 detik tanpa pernah ada satu pun penonton yang dijawab.
          lepasSemua();
          say(`[QA_PRICE_QUOTA] product=${r.product.number} used=${slot.used}/${slot.limit} retryAfterMs=${slot.retryAfterMs || 0}`);
          return { handled: false, reason: slot.reason };
        }
        pesanan.push(slot);
      }

      // --- 6. kirim lewat AutoComment yang SUDAH ADA ----------------------
      // requirePin:false  -> tidak ada pin yang dijanjikan kalimat ini, jadi
      //                      bukti pin tidak dituntut.
      // priority dibiarkan NORMAL (bawaan). Jawaban harga TIDAK PERNAH boleh
      // mendahului balasan pin produk yang berprioritas tinggi; autocomment/
      // core.js juga akan menurunkan high tanpa requirePin, jadi ada dua lapis.
      // playId TIDAK dioper: Q&A tidak memutar apa pun, dan sebuah playId
      // palsu akan meracuni semantik stale balasan scene.
      if (typeof requestComment !== "function") {
        lepasSemua();
        return declined("no-sender");
      }

      let res;
      try {
        // Ditandai SEBELUM pemanggilan: sesudah titik ini kami tidak bisa lagi
        // membuktikan bahwa nol byte menuju TikTok.
        dispatched = true;
        // IDENTITAS PENGIRIMAN, bukan playId palsu.
        //
        // Q&A tidak memutar apa pun, jadi ia tidak boleh mengarang playId
        // scene - itu akan meracuni semantik basi balasan scene. Yang dipakai
        // adalah identitas sendiri yang naik satu per JAWABAN, jadi dua jawaban
        // yang berbeda tidak pernah berebut jatah kirim-sekali yang sama,
        // sementara percobaan ulang jawaban yang SAMA tetap memakai identitas
        // yang sama dan tetap ditolak.
        pengirimanKe += 1;
        res = await requestComment({
          scene: QA_SCENE,
          text: reply.text,
          requirePin: false,
          requesters: 1,
          deliveryId: "qa:" + pengirimanKe,
        });
      } catch (err) {
        // autocomment/core.js TIDAK PERNAH menolak - setiap jalurnya pulang
        // sebagai { ok:false, reason }. Jadi cabang ini hanya terjangkau lewat
        // pengirim yang disuntikkan, dan untuk pengirim seperti itu kami tidak
        // bisa memposisikan lemparannya terhadap dispatch.
        //
        // Reservasi DITAHAN, bukan dilepas. Melepasnya bisa menghasilkan
        // balasan ganda kalau yang pertama ternyata sampai.
        kunciSemua();
        say(`[QA_PRICE_DECLINED] reason=send-threw note=ambiguous-delivery-slot-held product=${r.product.number}`);
        return { handled: false, reason: "send-threw", ambiguous: true };
      }

      // --- 7. keputusan reservasi ----------------------------------------
      if (res && res.ok === true) {
        kunciSemua();
        // `numeric=false` berarti yang terkirim adalah kalimat aman tanpa
        // angka (produk banyak varian yang tidak terverifikasi). Dicatat apa
        // adanya supaya log dukungan tidak terbaca seolah harga dikutip.
        say(`[QA_PRICE_REPLY] product=${r.product.number} via=${r.via} numeric=${reply.numeric === true} price="${reply.price || ""}" reason=${res.reason}`);
        return { handled: true, reason: res.reason, product: r.product.number, text: reply.text };
      }

      const alasan = (res && res.reason) || "failed";

      // Gagal yang TERBUKTI pre-dispatch: nol byte menuju TikTok, jadi slotnya
      // kembali utuh dan pertanyaan berikutnya boleh mencoba seketika.
      if (isPreDispatch(alasan)) {
        lepasSemua();
        return declined(`send-${alasan}`);
      }

      // Semua sisanya POST-DISPATCH atau tidak bisa dibuktikan posisinya.
      // Reservasi DITAHAN. Ini satu-satunya titik di fitur ini yang tidak bisa
      // menjanjikan tepat-satu-kali, dan itu dilaporkan apa adanya.
      kunciSemua();
      say(`[QA_PRICE_DECLINED] reason=send-${alasan} note=ambiguous-delivery-slot-held product=${r.product.number}`);
      return { handled: false, reason: `send-${alasan}`, ambiguous: true };
    } catch (err) {
      // Jaring terakhir. Dipanggil dari handleChat, dan apa pun yang terjadi di
      // sini tidak boleh keluar sebagai exception.
      //
      // Reservasi yang masih tergantung diselesaikan menurut apakah transport
      // SUDAH dipanggil. Sebelum dispatch tidak ada bukti apa pun yang sampai
      // ke penonton, jadi slotnya dikembalikan; sesudah dispatch ia ditahan.
      // Kedua jalur menyelesaikan reservasinya - tidak ada yang bocor.
      if (dispatched) kunciSemua();
      else lepasSemua();
      return declined("qa-threw", `detail=${String(err && err.message).slice(0, 80)} dispatched=${dispatched}`);
    }
  }

  return { handle, precheck, QA_SCENE, maxAgeMs };
}

module.exports = { createPriceQa, QA_SCENE, INTENT_PRICE, DEFAULT_MAX_AGE_MS };
