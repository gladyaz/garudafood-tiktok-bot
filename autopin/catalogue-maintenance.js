"use strict";
// Pemeliharaan kesegaran katalog di latar. FUNGSI MURNI + satu kerangka timer
// yang seluruh ketergantungannya disuntikkan.
//
// ---------------------------------------------------------------------------
// MASALAH YANG DIPERBAIKI
//
// LIVE 10 menit, TANPA pin, satu pertanyaan harga berbasis NAMA produk setiap
// 60 detik: 0 dari 10 terjawab. Terukur, dan mekanismenya tidak misterius:
//
//   1. pertanyaan datang, snapshot full sudah basi -> ditolak (benar)
//   2. penolakan itu memicu sapuan penuh terjaga, selesai ~1,1 detik kemudian
//   3. snapshot full itu segar selama 30 detik
//   4. pertanyaan berikutnya datang 60 detik kemudian - sudah basi lagi
//
// Jadi sapuannya selalu datang untuk pertanyaan yang SUDAH ditolak, dan selalu
// kedaluwarsa sebelum pertanyaan berikutnya. Setiap sapuan membayar penuh dan
// tidak menjawab siapa pun.
//
// ---------------------------------------------------------------------------
// YANG BUKAN
//
// Ini BUKAN setInterval yang menggulir tiap tik tanpa melihat keadaan. Ia
// digerakkan UMUR: pada setiap pemeriksaan ia membaca umur snapshot yang ada
// dan hanya meminta sapuan kalau snapshot full-nya sudah mendekati kedaluwarsa.
// Kalau pin baru saja menyumbang snapshot full, tidak ada yang dikerjakan.
//
// Ia juga BUKAN implementasi sapuan kedua: yang dipanggil adalah
// scheduleFullRefresh yang SAMA - lengkap dengan single-flight, jeda lantai,
// gerbang pinPending, anggaran 6 detik, dan pembatalannya.
//
// ---------------------------------------------------------------------------
// AMBANG 20 DETIK
//
//   30 s  umur kutip (QUOTE_FRESH_MS)
//  - 6 s  anggaran maksimum satu sapuan (FULL_REFRESH_BUDGET_MS)
//  - 4 s  margin keselamatan
//  = 20 s ambang pemeliharaan
//
// Artinya: mulai menyegarkan ketika yang tersimpan masih punya sisa umur yang
// cukup untuk menyelesaikan sapuan terburuk DAN masih menjawab pertanyaan yang
// datang di tengah sapuan itu. Angka ini INTERNAL untuk v0.3.0 - bukan setelan
// customer.

const MAINT_THRESHOLD_MS = 20_000;
// 5s -> 10s -> 20s, lalu tetap 20s. Sapuan full yang BERHASIL meresetnya.
// Kegagalan DOM yang bertahan lama tidak boleh menjadi penggedoran terus-menerus
// ke halaman TikTok.
const MAINT_BACKOFF_MS = Object.freeze([5_000, 10_000, 20_000]);
// Saat ditahan (pin sedang berjalan / sapuan lain in-flight) pemeriksaan
// berikutnya dekat: yang ditunggu bisa selesai kapan saja.
const MAINT_HOLD_CHECK_MS = 1_000;

// Alasan yang berarti "belum sekarang", BUKAN "gagal". Keduanya harus dibedakan:
// kegagalan menaikkan backoff, penundaan tidak. Pin yang mendahului adalah
// penundaan yang SEHAT - memperlakukannya sebagai kegagalan akan membuat
// pemeliharaan menjauh justru saat LIVE sedang paling aktif.
// Daftarnya dicocokkan dengan alasan yang BENAR-BENAR dikembalikan
// scheduleFullRefresh dan task-nya. Entri yang tidak pernah muncul adalah
// konfigurasi mati; entri yang hilang membuat backoff salah arah.
//
// `page-not-open` SENGAJA tidak ada di sini: halaman yang tidak terbuka bukan
// "belum sekarang", dan mencoba ulang setiap detik tidak akan menolong. Ia
// masuk jalur kegagalan supaya backoff membatasinya.
const DEFERRED = Object.freeze([
  "pin-pending",
  "too-soon",
  "stopping",
  "aborted-stopping",
  "aborted-pin-preempted",
  "newer-full-exists",
]);

// Penundaan yang tidak menyebut sisa waktunya diperiksa lagi sesudah jeda ini -
// bukan sesudah satu detik. Permintaan yang ditolak jeda lantai 20 detik, kalau
// diulang tiap detik, menghasilkan 130 permintaan untuk 21 sapuan nyata (terukur
// pada skenario katalog lambat). Browsernya memang tidak bekerja, tapi log
// dukungan ikut terkubur - dan log itu alat utama operator di repo ini.
const MAINT_DEFER_CHECK_MS = 5_000;

// ---------------------------------------------------------------------------
// BENTUK FIELD LOG
//
// Baris pemeliharaan IKUT ke log dukungan customer, dan controller/child-trace.js
// meneruskan baris yang lolos APA ADANYA: ia hanya memutuskan IKUT atau TIDAK,
// dan tidak pernah membuang field.
//
// Di bawahnya MEMANG ada lapis kedua - desktop/support-log.js redactLine - dan
// ia bekerja. Tapi ia berbasis NAMA FIELD: yang disunting adalah nilai dari
// `user=`, `nickname=`, `comment="..."`, `password=`, `cookie=`, `sessionid=`,
// `*token=`. Tidak satu pun field yang dicatat di bawah ada dalam daftar itu.
//
// Itu bukan dugaan. Ketiga baris yang dibocorkan probe taint dijalankan melalui
// redactLine, dan 5 dari 5 kanari LOLOS - satu-satunya yang tertangkap adalah
// `ms=sessionid=abc123`, dan itu pun hanya karena kata "sessionid" kebetulan ada
// di dalam NILAInya. Judul produk di `count=` dan `reason=` lewat utuh.
//
// Jadi untuk field-field DI BAWAH INI, titik pancar adalah satu-satunya tempat
// privasi bisa ditegakkan.
//
// Masalahnya: tiga field yang dicatat BUKAN milik modul ini. `reason`,
// `coverage`, `count`, dan `ms` datang dari hasil scheduleFullRefresh, dan
// `retryAfterMs` ikut menentukan `nextMs`. Hari ini nilai-nilai itu memang
// token tertutup ("empty", "pin-pending", "full", angka) - tapi objek yang
// sama SUDAH membawa free-text hari ini juga:
//
//   autopin/service.js  fullRefresh.catch(err => ({ ok:false, reason:"error",
//                         detail: String(err && err.message).slice(0,120) }))
//
// `detail` itu pesan exception mentah, dan ia selamat hanya karena baris log di
// bawah kebetulan tidak memilihnya. Menambahkan satu field ke satu panggilan
// log sudah cukup untuk menuliskan potongan halaman TikTok ke berkas yang
// dikirim customer saat melaporkan masalah.
//
// Maka nilainya DIBATASI BENTUKNYA, bukan dipercaya: token teknis pendek atau
// angka. Sebuah judul produk, nama penonton, atau cookie tidak berbentuk
// seperti itu, jadi ia tidak bisa lolos walau suatu hari ada yang mengoperkannya.
const TOKEN_LOG_RE = /^[a-z0-9-]{1,40}$/;

// Token teknis, atau penanda bahwa bentuknya ditolak. SENGAJA tidak memotong
// lalu mencatat sisanya: judul produk yang dipotong 40 karakter tetap judul
// produk. Yang dicatat adalah FAKTA bahwa bentuknya salah.
function logToken(value, bawaan) {
  const s = value === undefined || value === null ? "" : String(value);
  if (s === "") return bawaan;
  return TOKEN_LOG_RE.test(s) ? s : "non-token";
}

// Angka, atau null supaya log() membuangnya. String apa pun - termasuk yang
// membawa teks - berhenti di sini.
//
// HANYA number dan string yang dipertimbangkan, dan itu disengaja: Number([])
// bernilai 0, bukan NaN. Jebakan yang sama sudah tertulis di autopin/catalogue.js
// untuk Number(null), dan ia pernah membuat snapshot tanpa umur terlihat baru.
// Array kosong di field `ms` TIDAK berarti nol milidetik - ia berarti pemanggil
// mengoper bentuk yang salah, dan fieldnya harus hilang.
function logNumber(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function backoffFor(streak) {
  if (!Number.isInteger(streak) || streak <= 0) return 0;
  const i = Math.min(streak, MAINT_BACKOFF_MS.length) - 1;
  return MAINT_BACKOFF_MS[i];
}

// KEPUTUSAN PEMELIHARAAN. MURNI: tidak ada jam, tidak ada timer, tidak ada
// browser. Semua yang dibutuhkan dioper, jadi setiap cabang bisa diuji dengan
// jam palsu dan tanpa halaman.
//
// state:
//   now           ms
//   snapshot      hasil catalogue.state(): { has, coverage, ageMs } atau { has:false }
//   pinPending    ada pin yang menunggu/berjalan?
//   stopping      STOP sudah ditandai?
//   inFlight      sapuan penuh sedang berjalan?
//   backoffUntil  ms; 0 kalau tidak ada backoff
function decideMaintenance(state = {}) {
  const { snapshot, pinPending, stopping, inFlight, backoffUntil, now } = state;

  const s = snapshot && typeof snapshot === "object" ? snapshot : { has: false };

  // UMUR SNAPSHOT dihitung SEKALI di sini dan dibawa pada SETIAP keputusan,
  // termasuk yang berhenti lebih awal karena pin atau backoff.
  //
  // Alasannya observabilitas: seluruh keputusan modul ini digerakkan umur, jadi
  // "kenapa pemeliharaan jalan / tidak jalan" hanya bisa dijawab kalau angka
  // yang dilihatnya ikut tercatat. Tanpa itu operator harus menyimpulkannya
  // dari nextMs, dan itu hanya mungkin pada satu cabang.
  //
  // null dan undefined berarti TIDAK TERBACA, bukan nol. Number(null) === 0
  // adalah kecelakaan bahasa, dan kecelakaan itu sudah pernah menggigit repo
  // ini sekali (lihat effectiveMaxAge di autopin/catalogue.js): umur yang
  // dibaca sebagai 0 akan membuat snapshot yang tidak diketahui umurnya
  // terlihat baru saja diambil.
  const umurMentah = s.ageMs === null || s.ageMs === undefined ? NaN : Number(s.ageMs);
  const umurTerbaca = Number.isFinite(umurMentah) && umurMentah >= 0;
  // null = tidak diketahui. core.log membuang field null, jadi barisnya tidak
  // pernah mengarang angka umur.
  const ageMs = umurTerbaca ? umurMentah : null;
  const vonis = (act, reason, nextCheckMs) => ({ act, reason, nextCheckMs, ageMs });

  // STOP menang atas segalanya: tidak ada pemeriksaan berikutnya.
  if (stopping === true) return vonis(false, "stopping", null);

  // AUTOPIN MENANG. Pemeliharaan tidak pernah mendahului pin yang menunggu -
  // bukan hanya "tidak memulai sapuan", tapi juga tidak menjadwalkan ulang
  // dengan cara yang bisa menyelip di depannya.
  if (pinPending === true) return vonis(false, "pin-pending", MAINT_HOLD_CHECK_MS);

  // Sapuan lain sedang jalan: single-flight sudah menanganinya di service.
  if (inFlight === true) return vonis(false, "in-flight", MAINT_HOLD_CHECK_MS);

  const sampai = Number(backoffUntil) || 0;
  const sekarang = Number(now) || 0;
  if (sampai > sekarang) return vonis(false, "backoff", sampai - sekarang);

  if (s.has !== true || s.coverage !== "full") {
    return vonis(true, s.has === true ? "no-full-coverage" : "no-snapshot", MAINT_HOLD_CHECK_MS);
  }
  if (!umurTerbaca) {
    // Umur yang tidak terbaca diperlakukan sebagai alasan menyegarkan, bukan
    // sebagai alasan menganggapnya segar.
    return vonis(true, "age-unreadable", MAINT_HOLD_CHECK_MS);
  }
  if (umurMentah >= MAINT_THRESHOLD_MS) return vonis(true, "stale-full", MAINT_HOLD_CHECK_MS);
  // Masih segar: tidur TEPAT sampai ambangnya, bukan tik buta.
  return vonis(false, "fresh-full", MAINT_THRESHOLD_MS - umurMentah);
}

// Apakah hasil sapuan ini kegagalan yang pantas menaikkan backoff?
function isFailure(result) {
  if (!result || typeof result !== "object") return true;
  if (result.ok === true) return false;
  const reason = typeof result.reason === "string" ? result.reason : "";
  return !DEFERRED.includes(reason);
}

// Kerangka penjadwal. Satu timer, tidak pernah dua.
//
// deps:
//   now()                 jam
//   setTimer(fn, ms)      -> handle   (produksi: setTimeout + unref)
//   clearTimer(handle)
//   readState()           -> catalogue.state()
//   isPinPending()        -> boolean
//   isStopping()          -> boolean
//   isSweepInFlight()     -> boolean
//   requestRefresh()      -> hasil scheduleFullRefresh: { ok, reason, task? }
//   log(tag, fields)
function createCatalogueMaintenance(deps = {}) {
  const {
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (h) => clearTimeout(h),
    readState = () => ({ has: false }),
    isPinPending = () => false,
    isStopping = () => false,
    isSweepInFlight = () => false,
    requestRefresh = async () => ({ ok: false, reason: "not-ready" }),
    log = () => {},
  } = deps;

  let timer = null;
  let berjalan = false;
  let streak = 0;
  // SATU stempel "tidak sebelum", dipakai oleh backoff kegagalan DAN oleh
  // penundaan. Ia diperiksa di decideMaintenance, bukan hanya saat menjadwalkan
  // timer - kalau hanya timer yang menghormatinya, satu tick() yang dipanggil
  // lebih awal (atau penjadwal luar) bisa melewatinya sepenuhnya. Itu persis
  // yang terjadi di simulasi: 130 permintaan untuk 21 sapuan nyata.
  let tidakSebelum = 0;
  let sedangBekerja = false;
  let alasanSkipTerakhir = null;
  const jejak = { requested: 0, skipped: 0, ok: 0, failed: 0, deferred: 0, cancelled: 0 };

  // KEADAAN PEMELIHARAAN, diturunkan dari variabel yang SUDAH ada - tidak ada
  // state baru yang dilacak, dan kosakatanya tertutup pada empat nilai:
  //
  //   stopped   penjadwal tidak berjalan (STOP, atau belum start)
  //   working   satu permintaan penyegaran sedang berjalan
  //   holding   di dalam jendela "tidak sebelum" (backoff atau penundaan)
  //   sleeping  berjalan, dan sedang menunggu ambang umur
  //
  // Ia menjawab pertanyaan yang `reason` TIDAK jawab: reason menjelaskan satu
  // keputusan, keadaan menjelaskan apa yang sedang dilakukan loop-nya. Pada
  // baris FAILED keduanya bersama-sama berarti "gagal, dan sekarang menahan".
  function keadaan() {
    if (!berjalan) return "stopped";
    if (sedangBekerja) return "working";
    return tidakSebelum > now() ? "holding" : "sleeping";
  }

  function batalkanTimer() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  function jadwalkan(ms) {
    batalkanTimer();
    if (!berjalan) return;
    if (ms === null || ms === undefined) return;
    timer = setTimer(tick, Math.max(0, ms));
  }

  async function tick() {
    timer = null;
    if (!berjalan) return;
    // Satu pekerjaan pada satu waktu. Tanpa ini, dua timer yang kebetulan
    // bertumpuk bisa meminta dua sapuan - dan "single-flight" di service akan
    // menyembunyikannya sebagai `joined`, bukan menolaknya.
    if (sedangBekerja) {
      jadwalkan(MAINT_HOLD_CHECK_MS);
      return;
    }

    const keputusan = decideMaintenance({
      now: now(),
      snapshot: readState(),
      pinPending: isPinPending() === true,
      stopping: isStopping() === true,
      inFlight: isSweepInFlight() === true,
      backoffUntil: tidakSebelum,
    });

    if (!keputusan.act) {
      jejak.skipped += 1;
      // Alasan yang SAMA berturut-turut dicatat sekali. Pemeliharaan yang
      // menunggu pin selama 8 detik tidak boleh menulis delapan baris identik:
      // log dukungan harus tetap bisa dibaca manusia.
      // nextCheckMs null = tidak ada pemeriksaan berikutnya, dan itu hanya
      // terjadi pada STOP. Penjadwalnya memang BERHENTI di situ - menyisakan
      // `berjalan` true berarti isRunning() berbohong kepada pemanggil.
      //
      // Dihentikan SEBELUM dicatat, bukan sesudah: kalau urutannya dibalik,
      // baris STOP-nya melaporkan state=sleeping - keadaan yang sudah tidak
      // benar pada saat baris itu ditulis.
      const berhenti = keputusan.nextCheckMs === null;
      if (berhenti) {
        berjalan = false;
        batalkanTimer();
      }
      if (keputusan.reason !== alasanSkipTerakhir) {
        alasanSkipTerakhir = keputusan.reason;
        log("CATALOGUE_MAINT_SKIPPED", {
          reason: logToken(keputusan.reason, "unknown"), state: keadaan(),
          ageMs: logNumber(keputusan.ageMs), nextMs: logNumber(keputusan.nextCheckMs),
        });
      }
      if (berhenti) return;
      jadwalkan(keputusan.nextCheckMs);
      return;
    }

    alasanSkipTerakhir = null;
    sedangBekerja = true;
    jejak.requested += 1;
    log("CATALOGUE_MAINT_REQUESTED", {
      reason: logToken(keputusan.reason, "unknown"), state: keadaan(), ageMs: logNumber(keputusan.ageMs),
    });
    let hasil = null;
    try {
      const diminta = await requestRefresh();
      // `task` TIDAK pernah ditunggu oleh jalur chat; di sini ia ditunggu
      // justru supaya backoff tahu apa yang terjadi.
      hasil = diminta && diminta.task ? await diminta.task : diminta;
    } catch (err) {
      hasil = { ok: false, reason: "threw", detail: String((err && err.message) || "").slice(0, 120) };
    } finally {
      sedangBekerja = false;
    }

    if (hasil && hasil.ok === true) {
      streak = 0;
      tidakSebelum = 0;
      jejak.ok += 1;
      log("CATALOGUE_MAINT_OK", {
        state: keadaan(), count: logNumber(hasil.count) || 0, ms: logNumber(hasil.ms) || 0,
        coverage: logToken(hasil.coverage, "-"),
      });
    } else if (isFailure(hasil)) {
      streak += 1;
      const tunggu = backoffFor(streak);
      tidakSebelum = now() + tunggu;
      jejak.failed += 1;
      // `streak` TIDAK dicatat, dan tidak ada yang hilang karenanya: tangga
      // backoff-nya tetap [5s, 10s, 20s], jadi backoffMs sudah menyebutkan
      // posisi kegagalan ke berapa ini. Sesudah tangga itu mentok, keduanya
      // sama-sama jenuh - dan "sudah gagal berapa kali" tetap terbaca dari
      // jumlah baris FAILED. Satu angka yang bisa diturunkan dari angka lain
      // hanya menambah field yang harus dijaga privasinya.
      log("CATALOGUE_MAINT_FAILED", {
        reason: logToken(hasil && hasil.reason, "unknown"), state: keadaan(), backoffMs: logNumber(tunggu),
      });
    } else {
      // Ditunda, bukan gagal: backoff TIDAK dinaikkan.
      jejak.deferred += 1;
      if ((hasil && hasil.reason) === "aborted-pin-preempted") jejak.cancelled += 1;
      // Sisa waktu yang DISEBUTKAN pemanggil dipakai apa adanya (jeda lantai
      // mengembalikan retryAfterMs); kalau tidak disebut, jeda penundaan.
      const sisa = Number(hasil && hasil.retryAfterMs);
      tidakSebelum = now() + (Number.isFinite(sisa) && sisa > 0 ? sisa : MAINT_DEFER_CHECK_MS);
      log("CATALOGUE_MAINT_CANCELLED", {
        reason: logToken(hasil && hasil.reason, "deferred"), state: keadaan(), nextMs: logNumber(tidakSebelum - now()),
      });
    }

    // STOP bisa datang selagi sapuan berjalan: jangan jadwalkan apa pun lagi.
    if (isStopping() === true) {
      berjalan = false;
      batalkanTimer();
      return;
    }
    const tunda = Math.max(0, tidakSebelum - now());
    jadwalkan(tunda > 0 ? tunda : MAINT_HOLD_CHECK_MS);
  }

  return {
    start() {
      if (berjalan) return;
      berjalan = true;
      jadwalkan(0);
    },
    stop() {
      berjalan = false;
      batalkanTimer();
    },
    // Dipakai tes untuk menjalankan satu pemeriksaan tanpa timer nyata.
    tick,
    stats: () => ({ ...jejak, state: keadaan(), streak, backoffUntil: tidakSebelum }),
    isRunning: () => berjalan,
    hasTimer: () => timer !== null,
  };
}

module.exports = {
  createCatalogueMaintenance,
  decideMaintenance,
  isFailure,
  backoffFor,
  logToken,
  logNumber,
  MAINT_THRESHOLD_MS,
  MAINT_BACKOFF_MS,
  MAINT_HOLD_CHECK_MS,
  MAINT_DEFER_CHECK_MS,
  DEFERRED,
};
