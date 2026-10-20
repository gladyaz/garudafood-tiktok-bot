"use strict";
// Service AutoPIN: SATU browser + SATU halaman LIVE console yang hidup lama,
// dijalankan sebagai proses TERPISAH dari bot.
//
// Kenapa terpisah:
//   - Chromium tidak ikut dimuat ke proses bot yang sudah terbukti stabil
//   - browser yang crash tidak menjatuhkan playback
//   - halaman tidak perlu dibuka ulang per scene (startup ~8-10 detik; video
//     PAX hanya ~40-46 detik, jadi membuka browser per pin akan telat)
//
// Semua aksi UI diserialkan: satu halaman tidak boleh mengklik dua pin bersamaan.

const express = require("express");
const { log, checkIdentity, createSerialRunner, normalizeTitleKey, resolveProductForPin } = require("./core");
const { loadConfig } = require("./config");
const browserMod = require("./browser");
const { PURPOSE } = require("./browser-mode");
const productsMod = require("./products");
const { createBrowserTransport, waitForComposerReady } = require("../autocomment/browser-transport");
const { createSendOnce } = require("../autocomment/send-once");
const { createBrowserSender } = require("../autocomment/browser-sender");
const { planTimeouts, describeTimeouts } = require("../autocomment/timeouts");
const { createPinConfirmer } = require("./pin-confirm");
const { createPlayGeneration } = require("./session");
const { planPinTimeouts, describePinTimeouts } = require("./pin-budget");
const { loadConfig: loadAutoCommentConfig } = require("../autocomment/config");
const { createCatalogueStore, COVERAGE } = require("./catalogue");
const { createCatalogueMaintenance } = require("./catalogue-maintenance");

const DEFAULT_PORT = 5055;
const LOOPBACK = "127.0.0.1";

// Pembacaan state pin sesudah klik: SEKALI BACA TIDAK CUKUP.
//
// Pada LIVE 2026-10-05, tiga dari empat pin terakhir mengembalikan state kosong
// walau kliknya berhasil:
//
//   [AUTOPIN_SERVICE_PINNED] scene=PAX-1 title="Dilan Bon Bon ..."   <- tanpa after=
//   [AUTOPIN_SUCCESS] ... clicked=true state=""
//   [AUTOCOMMENT_SKIPPED] reason=pin-state-unreadable
//
// Sebabnya: kartu produk ter-render ulang begitu ia menjadi featured. Barisnya
// masih ketemu lewat judul, tapi tombol Pin/Unpin di dalamnya sesaat TIDAK ADA,
// sehingga teksnya pulang kosong. Gerbang semantik lalu menahan chat - benar,
// karena ia tidak boleh mengklaim pin yang tak terbukti - tapi akibatnya kaki
// AutoComment ikut mati padahal pin-nya sukses.
//
// PENTING: mengulang PEMBACAAN bukan "retry" yang dilarang. Aturan nol-retry
// melindungi dari pin ganda dan pesan ganda; membaca ulang tidak mengklik dan
// tidak mengirim apa pun. Jendelanya pun berbatas, dan scene masih tayang
// puluhan detik sesudahnya.
const PIN_STATE_READS = 6;
const PIN_STATE_POLL_MS = 250;
// Bantalan kecil di atas perkiraan biaya konfirmasi: perkiraan tidak boleh
// dipakai mentah, karena salah sedikit saja berarti mengklik tanpa bisa
// membuktikan.
const CONFIRM_SLACK_MS = 300;
// Sinyal kedua dipakai HANYA saat sinyal pertama buta. Lihat autopin/pin-confirm.js.

// Berapa (sesi, playId) terakhir yang diingat sudah pernah DIKLIK. Mencegah
// pin kedua untuk pemutaran yang sama: permintaan ulang, pengiriman ganda,
// atau proses bot kembar. Batasnya sama dengan dedupe AutoComment
// (autocomment/core.js DEDUPE_MEMORY) supaya keduanya setara.
const PIN_DEDUPE_MEMORY = 1_000;

// Anggaran penyegaran katalog baca-saja. SENGAJA jauh di bawah anggaran pin
// (8 detik): pembacaan katalog nanti berada di jalur menjawab chat, dan tidak
// boleh menahan apa pun. Kalau menunggu giliran di antrean sudah memakan
// anggaran ini, penyegarannya TIDAK dimulai - bukan dimulai lalu ditinggalkan.
// Operasi yang ditinggalkan tetap berjalan di latar dan bisa tumpang tindih
// dengan pin berikutnya; itu alasan yang sama kenapa guardedPin memeriksa sisa
// waktu sebelum setiap tahap, bukan memakai withDeadline.
const CATALOGUE_REFRESH_DEADLINE_MS = 1_500;

// --- SAPUAN KATALOG PENUH untuk Product Q&A ---------------------------------
//
// Resolusi lewat JUDUL menuntut coverage="full", dan satu-satunya yang
// menghasilkannya adalah koleksi bergulir. Tanpa sapuan terjadwal, pertanyaan
// berbasis nama produk hanya bisa dijawab 30 detik sesudah tiap pin - terukur
// 4 dari 61 titik waktu pada LIVE 10 menit dengan satu pin.
//
// Sapuan ini BUKAN periodik. Ia diminta ON-DEMAND oleh jalur Q&A saat sebuah
// pertanyaan nama ditolak karena cakupan, dan dijaga tiga lapis:
//
//   1. SINGLE-FLIGHT   paling banyak satu sapuan berjalan; pertanyaan lain
//                      menempel pada yang sedang berjalan, tidak memulai yang baru
//   2. JEDA LANTAI     minimal 20 detik antar sapuan, jadi banjir komentar
//                      penonton tidak bisa menjadi badai gulir
//   3. ANGGARAN        sapuan memotong dirinya sendiri; daftar terpotong TIDAK
//                      PERNAH disimpan sebagai "full"
//
// Dan yang terpenting: AUTOPIN MENANG. Lihat pinPending di bawah.
const FULL_REFRESH_BUDGET_MS = 6_000;
const FULL_REFRESH_MIN_INTERVAL_MS = 20_000;

function isExpectedConsole(actualUrl, consoleUrl) {
  try {
    const a = new URL(actualUrl);
    const b = new URL(consoleUrl);
    return a.origin === b.origin && a.pathname === b.pathname;
  } catch {
    return false;
  }
}

// deps bisa diganti pada tes supaya jalur penolakan dan urutan aksi dapat
// diperiksa tanpa membuka browser sungguhan.
function createService({ config = loadConfig(), dryRun = false, allowCommentSendOnce = false, allowAutoCommentSend = false, timeouts, pinTimeouts, clickStrategy, runtimeConfigId = null, deps = {} } = {}) {
  // Anggaran waktu diturunkan dari timeout HTTP yang SAMA yang dipakai bot
  // (AUTOCOMMENT_TIMEOUT_MS), supaya service selalu menjawab sebelum bot
  // menyerah. Phase 21 gagal justru karena kedua sisi tidak pernah dihubungkan.
  const budget = timeouts || planTimeouts({ httpTimeoutMs: loadAutoCommentConfig(process.env, { warn: () => {} }).timeoutMs });
  // Anggaran jalur PIN, diturunkan dari batas tunggu yang SAMA yang dipakai bot
  // (AUTOPIN_TIMEOUT_MS). Tanpa ini, bot bisa menyerah sementara service masih
  // menggulir dan mengklik - keadaan "entah" yang terjadi pada LIVE 2026-10-06
  // dengan katalog 20 produk. Lihat autopin/pin-budget.js.
  const pinBudget = pinTimeouts || planPinTimeouts({ httpTimeoutMs: Number(process.env.AUTOPIN_TIMEOUT_MS) || undefined });

  // Pemutaran yang pin-nya SUDAH benar-benar diklik. Aturan basi saja tidak
  // cukup: ia menolak playId yang lebih KECIL dari yang terbaru, jadi playId
  // yang SAMA diulang lolos begitu saja dan mengklik dua kali. Untuk pin itu
  // berarti produknya ter-toggle kembali OFF - kebalikan dari yang diminta.
  const sudahDiklik = new Set();
  const kunciPlay = (sessionId, playId) => `${String(sessionId || "")}#${playId}`;
  // playId <= 0 dipakai alat diagnostik dan memang boleh diulang, sama seperti
  // pengecualiannya di aturan basi.
  const bisaDedupe = (playId) => Number.isFinite(playId) && playId > 0;
  const pernahDiklik = (sessionId, playId) =>
    bisaDedupe(playId) && sudahDiklik.has(kunciPlay(sessionId, playId));
  const catatDiklik = (sessionId, playId) => {
    if (!bisaDedupe(playId)) return;
    sudahDiklik.add(kunciPlay(sessionId, playId));
    if (sudahDiklik.size > PIN_DEDUPE_MEMORY) {
      sudahDiklik.delete(sudahDiklik.values().next().value);
    }
  };
  const d = {
    launchBrowser: browserMod.launchBrowser,
    getPage: browserMod.getPage,
    openConsole: browserMod.openConsole,
    closeBrowser: browserMod.closeBrowser,
    // Tab kedua khusus chat. Dipisah dari halaman produk supaya scraping
    // AutoPIN dan pemeriksaan komposer AutoComment tidak pernah berbagi DOM.
    newPage: (b) => b.newPage(),
    // Disuntikkan supaya penungguan komposer bisa diuji tanpa browser.
    waitForComposerReady,
    collectProducts: productsMod.collectProducts,
    // Pembacaan SATU LINTASAN tanpa menggulir. Dipakai HANYA oleh penyegaran
    // katalog baca-saja, tidak pernah oleh jalur pin.
    readProductsOnce: productsMod.readProductsOnce,
    readIdentity: productsMod.readIdentity,
    pinProductByTitle: productsMod.pinProductByTitle,
    readPinState: productsMod.readPinState,
    // Disuntikkan supaya penungguan state pin bisa diuji tanpa menunggu nyata.
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    // Jam disuntikkan supaya anggaran waktu bisa diuji tanpa waktu nyata.
    now: () => Date.now(),
    ...deps,
  };

  const runExclusive = createSerialRunner();
  // Snapshot katalog produk. Diisi dari pembacaan yang service MEMANG sudah
  // lakukan; lihat autopin/catalogue.js untuk kebijakan kesegarannya.
  const catalogue = createCatalogueStore({ now: () => d.now() });

  // --- PRIORITAS: pekerjaan pin SUNGGUHAN mengalahkan sapuan Q&A -----------
  //
  // Dinaikkan di PINTU MASUK handlePin, yaitu SEBELUM pin memasuki runExclusive.
  // Letaknya itu yang membuat ini pembatalan sungguhan, bukan sekadar "nanti
  // kebagian giliran": sapuan yang sedang berjalan membaca penanda ini dari
  // dalam fungsi `remaining`-nya, memotong dirinya sendiri di gelombang gulir
  // berikutnya (~350-400 ms), lalu melepas giliran browser.
  //
  // runExclusive TIDAK punya preemption. Kalau penanda ini hanya dibaca dari
  // dalam task yang mengantre, pin akan tetap menunggu sapuan selesai penuh.
  let pinPending = 0;

  // Sapuan penuh yang sedang berjalan (single-flight) + jam jeda lantai.
  let fullRefresh = null;
  let lastFullAttemptAt = -Infinity;
  // Dinyalakan stop(): sapuan harus berhenti dan tidak boleh dimulai lagi.
  let stopping = false;

  let browser = null;
  let page = null;
    let chatPage = null;
  // Generasi pemutaran, SADAR SESI. Dipakai bersama oleh pin dan komentar:
  // begitu scene baru mulai, pekerjaan chat scene lama ikut basi, bukan cuma
  // pin-nya. Lihat autopin/session.js - basi hanya berarti sesuatu di dalam
  // SATU sesi bot, supaya restart bot tidak lagi memblokir playId yang sah.
  const generation = createPlayGeneration({ logger: (event, data) => log(event, data) });
  const isStale = (sessionId, id) => generation.isStale({ sessionId, playId: id });
  const noteScenePlayId = (sessionId, id) => generation.note({ sessionId, playId: id });

  async function ensurePage() {
    if (browser && page && !page.isClosed()) return page;
    if (browser) {
      try {
        await d.closeBrowser(browser);
      } catch {
        /* abaikan: kita memang sedang membangun ulang */
      }
    }
    // Runtime: headless secara bawaan. Pin, konfirmasi pin, dan tab chat
    // AutoComment semuanya berjalan di browser ini.
    browser = await d.launchBrowser(config, PURPOSE.RUNTIME);
    page = await d.getPage(browser);

    // Profil persisten bisa memulihkan beberapa tab. Tab latar di-throttle Chrome:
    // daftar produk yang ter-virtualisasi tidak pernah ter-render, sehingga
    // halaman terlihat "tidak punya produk" padahal header akunnya terbaca.
    // Halaman harus benar-benar di depan sebelum discraping.
    if (typeof page.bringToFront === "function") {
      try {
        await page.bringToFront();
      } catch {
        /* bukan alasan untuk membatalkan: scraping tetap dicoba */
      }
    }

    const info = await d.openConsole(page, config);
    log("SERVICE_PAGE_READY", { url: info.url, settled: info.settled, readyMs: info.readyMs });
    return page;
  }

    // Halaman chat: tab TERPISAH di browser yang SAMA. Profil Chrome hanya bisa
    // dipegang satu proses, jadi proses/profil kedua bukan pilihan; tab kedua
    // memberi isolasi DOM tanpa login kedua.
  async function ensureChatPage() {
    if (chatPage && !chatPage.isClosed()) return chatPage;
    await ensurePage(); // pastikan browser hidup dan sudah login
    chatPage = await d.newPage(browser);
    const info = await d.openConsole(chatPage, config);

    // Komposer butuh beberapa detik sesudah halaman dimuat sebelum bisa dipakai.
    // Menunggunya di sini membuat permintaan PERTAMA tidak lagi jatuh ke
    // chat-input-disabled (terlihat di LIVE 2026-10-05). Murni membaca, dan
    // tidak siap pun bukan alasan gagal: tiap permintaan punya gerbangnya sendiri.
    const composer = await d.waitForComposerReady(chatPage, {});
    log("SERVICE_CHAT_PAGE_READY", {
      url: info.url, settled: info.settled, readyMs: info.readyMs,
      composerReady: composer.ready, composerMs: composer.ms, polls: composer.polls,
    });
    return chatPage;
  }

  // AR2A: satu-satunya mode. Transport ini tidak punya jalur mengetik/mengklik.
  const commentTransport = createBrowserTransport({ getPage: ensureChatPage, dryRun: true });

  // AR3: pengirim chat yang bisa dipakai BERULANG, tapi satu kali ketik + satu
  // klik PER playId. MATI kecuali service dijalankan dengan
  // --enable-autocomment-send. Tidak ada nilai .env yang bisa menyalakannya.
  const browserSender = createBrowserSender({
    getPage: ensureChatPage,
    allowed: allowAutoCommentSend === true,
    config,
    readIdentity: (p) => d.readIdentity(p),
    checkIdentity,
    isStale,
    timeouts: budget,
    clickStrategy,
  });

  async function handleCommentSend({ text, scene, playId, sessionId }) {
    if (allowAutoCommentSend !== true) return { ok: false, reason: "real-comment-send-disabled" };
    const id = Number.isFinite(playId) ? playId : 0;
    if (isStale(sessionId, id)) return { ok: false, reason: "stale" };
    noteScenePlayId(sessionId, id);
    return runExclusive(async () => {
      // Diperiksa lagi di dalam antrean: scene bisa berganti selagi menunggu giliran.
      if (isStale(sessionId, id)) {
        log("SERVICE_COMMENT_STALE", { scene, playId: id, latest: generation.latest(), phase: "queued" });
        return { ok: false, reason: "stale" };
      }
      try {
        return await browserSender.send({ text, scene, playId: id });
      } catch (err) {
        log("SERVICE_COMMENT_ERROR", { scene, detail: String(err && err.message).slice(0, 120) });
        return { ok: false, reason: "comment-send-error" };
      }
    });
  }

  // AR2B: jalur kirim sungguhan sekali pakai. MATI kecuali service dijalankan
      // dengan --allow-comment-send-once. Tidak ada variabel environment yang bisa
      // menyalakannya, supaya tidak pernah tertinggal aktif di .env siapa pun.
      const sendOnce = createSendOnce({
        getPage: ensureChatPage,
        allowed: allowCommentSendOnce === true,
        config,
        readIdentity: (p) => d.readIdentity(p),
        checkIdentity,
      });

    // Diserialkan lewat runner yang SAMA dengan pin: walau halamannya beda, dua
    // pekerjaan UI Puppeteer tidak boleh berjalan bersamaan di AR2A.
    async function handleCommentDryRun({ text, scene, playId, sessionId }) {
      if (typeof text !== "string" || text.trim() === "") return { ok: false, reason: "empty-message" };
      noteScenePlayId(sessionId, Number.isFinite(playId) ? playId : 0);
      return runExclusive(async () => {
        try {
          return await commentTransport.send({ text, scene, playId });
        } catch (err) {
          log("SERVICE_COMMENT_ERROR", { scene, detail: String(err && err.message).slice(0, 120) });
          return { ok: false, reason: "comment-dry-run-error" };
        }
      });
    }

  // Konfirmasi pin dari dua sinyal independen, murni membaca dan berbatas
  // waktu. Tidak pernah melempar. Lihat autopin/pin-confirm.js untuk aturannya
  // - terutama bahwa bacaan negatif yang JELAS tidak boleh ditimpa sinyal lain.
  const pinConfirmer = createPinConfirmer({
    readPinState: (p, key) => d.readPinState(p, key),
    // Opsi diteruskan: konfirmasi memakai penghentian dini supaya tidak
    // menggulir seluruh katalog untuk kedua kalinya.
    collectProducts: (p, opts) => d.collectProducts(p, opts),
    sleep: (ms) => d.sleep(ms),
    reads: pinBudget.maxConfirmReads,
    pollMs: pinBudget.confirmPollMs,
    now: () => d.now(),
  });

  // Gerbang yang sama persis dengan CLI yang sudah terverifikasi.
  async function guardedPin({ scene, productKey, playId, sessionId, acceptedAt }) {
    // --- anggaran waktu + instrumentasi per-tahap ---
    // Satu deadline untuk SELURUH pekerjaan sisi service. Tiap tahap yang bisa
    // lambat dijalankan di bawah sisa waktu, jadi service tidak pernah masih
    // bekerja ketika bot sudah menyerah.
    //
    // Deadline dihitung dari saat permintaan DITERIMA, bukan saat kerjanya
    // mulai. Bedanya penting: hanya satu mutasi UI boleh jalan pada satu waktu,
    // jadi permintaan untuk playId yang berbeda bisa menunggu lama di antrean.
    // Kalau jamnya baru mulai sesudah gilirannya tiba, waktu tunggu itu tidak
    // terhitung - dan bot bisa menyerah ketika service justru baru mulai.
    const t0 = d.now();
    const mulaiDari = Number.isFinite(acceptedAt) ? acceptedAt : t0;
    const deadlineAt = mulaiDari + pinBudget.browserDeadlineMs;
    const left = () => deadlineAt - d.now();
    const marks = [];
    if (t0 > mulaiDari) marks.push(["queue-wait", t0 - mulaiDari]);
    const timingLine = () =>
      marks.map(([k, v]) => `${k}=${v}`).join(" ") + ` total=${d.now() - t0} remaining=${left()}`;

    // Tahap async berbatas sisa waktu. Kalau waktunya habis, tahapnya TIDAK
    // dimulai - bukan dimulai lalu ditinggalkan.
    // Hanya MEMERIKSA sisa waktu sebelum memulai. Sengaja TIDAK memakai
    // withDeadline: operasi yang ditinggalkan di tengah tetap berjalan di latar
    // dan bisa tumpang tindih dengan pekerjaan berikutnya. Tahap yang panjang
    // (koleksi produk) memotong dirinya sendiri lewat opsi `remaining`.
    const stage = async (name, fn) => {
      if (pinBudget.browserDeadlineMs > 0 && left() <= 0) {
        marks.push([name, "skip"]);
        const err = new Error("pin-budget-exhausted:" + name);
        err.budget = true;
        err.stage = name;
        throw err;
      }
      const a = d.now();
      try {
        return await fn();
      } finally {
        marks.push([name, d.now() - a]);
      }
    };
    const timeSync = (name, fn) => {
      const a = d.now();
      try {
        return fn();
      } finally {
        marks.push([name, d.now() - a]);
      }
    };

    const p = await ensurePage();

    if (!isExpectedConsole(p.url(), config.consoleUrl)) {
      return { ok: false, reason: "unexpected-page" };
    }

    const observed = await stage("identity", () => d.readIdentity(p));
    const verdict = checkIdentity({
      expected: config.expectedShop,
      observed,
      forbidden: config.forbiddenShops,
    });
    if (!verdict.ok) return { ok: false, reason: `identity-${verdict.reason}` };

    // Koleksi SEBELUM klik harus LENGKAP: resolusi menolak kalau kuncinya cocok
    // ke lebih dari satu produk, dan penghentian dini di sini bisa menyembunyikan
    // produk kedua yang cocok - itu akan mengubah "ambigu, jangan klik" menjadi
    // "klik produk pertama yang kebetulan ketemu". Jadi yang dipotong hanya
    // koleksi untuk KONFIRMASI, bukan yang ini.
    const sebelumCollect = d.now();
    const snapshot = await stage("collect-before", () => d.collectProducts(p, { remaining: left }));
    // Saat pembacaan SELESAI. Inilah yang jadi capturedAt snapshot, bukan saat
    // ia diterbitkan: collect 6 detik yang distempel pada saat put() akan
    // melebih-lebihkan kesegarannya sebesar seluruh durasi pembacaan.
    const collectedAt = d.now();
    const collectMs = collectedAt - sebelumCollect;
    // Daftar yang dipotong anggaran TIDAK boleh dipakai untuk resolusi: produk
    // kedua yang cocok bisa belum terlihat, dan itu mengubah penolakan "ambigu"
    // menjadi klik ke produk yang kebetulan ketemu lebih dulu.
    if (snapshot.ranOutOfTime === true) {
      log("SERVICE_PIN_BUDGET_EXHAUSTED", {
        scene, playId, phase: "collect-before", passes: snapshot.passes,
        note: "daftar produk tidak lengkap karena anggaran: tidak diklik",
      });
      return { ok: false, reason: "collect-incomplete-budget", clicked: false };
    }
    // Katalog LENGKAP yang baru saja dibaca disimpan. Ini satu-satunya tempat
    // snapshot "full" lahir, dan ia GRATIS: pembacaannya sudah terjadi di baris
    // atas untuk keperluan pin.
    //
    // Hanya daftar yang UTUH yang boleh disimpan. Daftar yang dipotong - oleh
    // anggaran (ranOutOfTime) atau oleh penghentian dini (stoppedEarly) - tidak
    // boleh pernah ditandai "full": ketidakhadiran produk di dalamnya bukan
    // bukti produk itu tidak ada. Kolektor konfirmasi pasca-klik memang dipotong
    // begitu, dan karena itu TIDAK disimpan di sini.
    //
    // Dibungkus try/catch: menyimpan snapshot tidak boleh pernah bisa
    // menggagalkan pin.
    // coverage DATANG DARI KOLEKTOR, tidak disimpulkan di sini.
    //
    // Dulu baris ini menyimpulkan "full" dari dua flag negatif
    // (ranOutOfTime/stoppedEarly). Kesimpulan itu terbukti salah pada tiga
    // jalan keluar: kuota gelombang habis, container gulir keliru, dan daftar
    // yang tersaring kotak pencarian/filter. Sekarang collectProducts yang
    // menyaksikan dan memutuskan; di sini tinggal menyimpan apa yang disaksikan.
    //
    // coverage="unknown" ditolak oleh catalogue.put() dengan sengaja - barisnya
    // tidak boleh dipercaya, jadi ia tidak boleh masuk penyimpanan sama sekali.
    // Gerbang "jangan simpan yang dipotong" DIPERTAHANKAN apa adanya: daftar
    // yang dipotong anggaran atau dihentikan dini tidak masuk penyimpanan sama
    // sekali, sama seperti sebelum v0.3.0. Yang berubah hanya LABELNYA - dulu
    // disimpulkan di sini, sekarang disaksikan oleh kolektor.
    if (snapshot.ranOutOfTime !== true && snapshot.stoppedEarly !== true) {
      try {
        const simpan = catalogue.put({
          products: snapshot.products,
          coverage: snapshot.coverage,
          source: "pin-collect",
          observedAt: collectedAt,
        });
        if (!simpan.ok) {
          log("SERVICE_CATALOGUE_NOT_STORED", {
            source: "pin-collect", reason: simpan.reason, coverage: snapshot.coverage,
            why: (snapshot.coverageReasons || []).join(",").slice(0, 80),
          });
        }
      } catch (e) {
        log("SERVICE_CATALOGUE_STORE_FAILED", { detail: String(e && e.message).slice(0, 120) });
      }
    }

    if (snapshot.products.length === 0) return { ok: false, reason: "no-products-found" };
    if (!snapshot.livePinButtonsOnPage) return { ok: false, reason: "live-pin-control-not-available" };

    const resolved = timeSync("resolve-product", () => resolveProductForPin(snapshot.products, productKey));
    if (!resolved.ok) return { ok: false, reason: resolved.reason };

    // === GERBANG TERAKHIR SEBELUM MENYENTUH UI ===
    // Semua langkah di atas memakan waktu (halaman siap, identitas, scraping
    // produk). Selama itu scene bisa sudah berganti. Memeriksa playId setelah
    // klik tidak ada gunanya: produk yang salah sudah tampil ke penonton.
    if (timeSync("stale", () => isStale(sessionId, playId))) {
      log("SERVICE_STALE", { scene, playId, latest: generation.latest(), phase: "before-click" });
      return { ok: false, reason: "stale-before-click", clicked: false };
    }

    // === GERBANG ANGGARAN: jangan mengklik kalau konfirmasi tidak akan kebagian waktu ===
    // Pin yang terjadi tapi tidak bisa dikonfirmasi adalah hasil TERBURUK: produk
    // berubah di layar penonton, chat ditahan, dan bot maupun service tidak punya
    // cerita yang sama. Tidak mengklik jauh lebih baik - tidak ada yang berubah,
    // keduanya sepakat, dan penonton bisa meminta ulang.
    // Cadangan tetap TIDAK cukup, dan itu terukur: biaya snapshot tergantung
    // seberapa jauh produknya dari atas daftar. Dengan cadangan patokan, target
    // di tengah katalog 20 produk sempat DIKLIK lalu gagal dikonfirmasi - hasil
    // yang justru paling ingin dihindari.
    //
    // Perkiraannya diambil dari data yang sudah ada di tangan: koleksi pra-klik
    // tadi memakan collectMs untuk seluruh daftar, dan konfirmasi hanya perlu
    // menggulir sampai posisi produk target. Jadi biayanya sekitar sebanding
    // dengan posisi relatifnya.
    const totalProduk = snapshot.products.length;
    const posisi = (resolved.product && resolved.product.number) || totalProduk;
    const perkiraanSnapshot =
      totalProduk > 0 ? Math.ceil(collectMs * Math.min(1, posisi / totalProduk)) : collectMs;
    const butuh = Math.max(
      pinBudget.confirmReserveMs,
      pinBudget.primaryWindowMs + perkiraanSnapshot + CONFIRM_SLACK_MS
    );

    if (!dryRun && left() < butuh) {
      log("SERVICE_PIN_BUDGET_EXHAUSTED", {
        scene, playId, phase: "before-click", remaining: left(),
        need: butuh, estSnapshot: perkiraanSnapshot, position: posisi + "/" + totalProduk,
        timing: timingLine(),
        note: "tidak diklik: konfirmasi tidak akan kebagian waktu",
      });
      return { ok: false, reason: "budget-exhausted-before-click", clicked: false };
    }

    if (dryRun) {
      const probe = await stage("click", () => d.pinProductByTitle(p, productKey, { dryRun: true }));
      return probe.ok
        ? { ok: true, reason: "dry-run", title: probe.title, clicked: false }
        : { ok: false, reason: probe.reason };
    }

    // SATU klik. Tidak pernah ada klik kedua, dan tidak ada retry.
    const act = await stage("click", () => d.pinProductByTitle(p, productKey, { dryRun: false, remaining: left }));
    if (!act.ok) return { ok: false, reason: act.reason };
    // Dicatat SEBELUM konfirmasi, bukan sesudah: yang harus dicegah adalah klik
    // kedua, dan kliknya sudah terjadi di baris atas. Konfirmasi yang gagal
    // tidak boleh memberi izin mengklik lagi.
    catatDiklik(sessionId, playId);

    // Konfirmasi di bawah cadangan yang sudah dipastikan tersisa sebelum klik.
    // Kalau cadangan itu ternyata habis juga, confirm() melapor jujur
    // "pin-confirm-out-of-budget" - ia TIDAK memulai snapshot yang tidak akan
    // selesai pada waktunya.
    const v = await pinConfirmer.confirm(p, productKey, {
      primaryWindowMs: pinBudget.primaryWindowMs,
      remaining: left,
    });
    marks.push(["primary-confirm", v.primaryMs === undefined ? "?" : v.primaryMs]);
    marks.push(["snapshot-confirm", v.snapshotMs === undefined ? "-" : v.snapshotMs]);

    // Seluruh bukti dicatat: hasil bacaan tombol APA ADANYA (found/buttons/text)
    // dan hasil sinyal kedua kalau sampai dipakai. Inilah yang dulu hilang.
    log("SERVICE_PINNED", {
      scene, title: act.title, after: v.state, via: v.via || "-",
      reads: v.reads, primary: v.primary, snapshot: v.snapshot || "-",
      snapshotPasses: v.snapshotPasses === undefined ? "-" : v.snapshotPasses,
      snapshotEarly: v.snapshotEarly === undefined ? "-" : v.snapshotEarly,
      timing: timingLine(),
    });
    return {
      ok: true, reason: "pinned", title: act.title, state: v.state, clicked: true,
      // Dibawa ke sisi bot murni untuk observability. Gerbang di sana TETAP
      // memutuskan dari state, bukan dari field ini.
      confirmedVia: v.via, confirmReason: v.reason,
      timing: timingLine(),
    };
  }

  async function handlePin({ scene, productKey, playId, sessionId }) {
    if (typeof productKey !== "string" || !normalizeTitleKey(productKey)) {
      return { ok: false, reason: "empty-product-key" };
    }
    // Jam anggaran mulai DI SINI, sebelum antre. Lihat guardedPin.
    const acceptedAt = d.now();

    // PRIORITAS: ditandai SEKARANG, sebelum gerbang apa pun dan sebelum
    // runExclusive. Sapuan katalog Q&A yang sedang berjalan membaca penanda ini
    // dari dalam fungsi `remaining`-nya dan memotong dirinya sendiri di
    // gelombang gulir berikutnya, jadi giliran browser lepas untuk pin ini
    // dalam ~350-400 ms - bukan sesudah sapuan selesai penuh.
    //
    // Dinaikkan di luar try supaya SETIAP jalur keluar di bawah ini melewati
    // finally dan menurunkannya kembali.
    pinPending += 1;
    try {
      return await handlePinInner({ scene, productKey, playId, sessionId, acceptedAt });
    } finally {
      pinPending -= 1;
    }
  }

  async function handlePinInner({ scene, productKey, playId, sessionId, acceptedAt }) {
    const id = Number.isFinite(playId) ? playId : 0;
    if (isStale(sessionId, id)) return { ok: false, reason: "stale" };
    // Satu pemutaran = satu pin. Permintaan kedua untuk playId yang sama bukan
    // pemutaran baru, jadi ia TIDAK boleh mengklik apa pun.
    if (pernahDiklik(sessionId, id)) {
      log("SERVICE_PIN_DUPLICATE", { scene, playId: id, phase: "entry" });
      return { ok: false, reason: "duplicate-playId", clicked: false };
    }
    noteScenePlayId(sessionId, id);

    return runExclusive(async () => {
      // Dicek lagi DI DALAM antrean: permintaan yang lebih baru bisa datang
      // selama kita menunggu giliran. Yang menang adalah yang terbaru.
      if (isStale(sessionId, id)) {
        log("SERVICE_STALE", { scene, playId: id, latest: generation.latest(), phase: "queued" });
        return { ok: false, reason: "stale" };
      }
      // Dan dicek lagi juga: kembarannya bisa sudah selesai mengklik selagi
      // permintaan ini menunggu giliran di antrean.
      if (pernahDiklik(sessionId, id)) {
        log("SERVICE_PIN_DUPLICATE", { scene, playId: id, phase: "queued" });
        return { ok: false, reason: "duplicate-playId", clicked: false };
      }
      // Anggarannya sudah habis dimakan antrean? Jangan mulai sama sekali.
      // Menolak di sini berarti NOL mutasi: tidak menggulir, tidak mengklik.
      const sisaSesudahAntre = acceptedAt + pinBudget.browserDeadlineMs - d.now();
      if (sisaSesudahAntre <= pinBudget.confirmReserveMs) {
        log("SERVICE_PIN_BUDGET_EXHAUSTED", {
          scene, playId: id, phase: "queue-wait",
          waited: d.now() - acceptedAt, remaining: sisaSesudahAntre,
          need: pinBudget.confirmReserveMs,
          note: "menunggu giliran terlalu lama: tidak diklik",
        });
        return { ok: false, reason: "budget-exhausted-in-queue", clicked: false };
      }
      try {
        return await guardedPin({ scene, productKey, playId: id, sessionId, acceptedAt });
      } catch (err) {
        // Anggaran habis di tengah tahap: dijawab apa adanya, bukan dilempar.
        // Yang penting di sini adalah service MENJAWAB - bot tidak boleh
        // menyerah sambil service diam-diam masih bekerja.
        if (err && (err.budget === true || err.deadline === true)) {
          const after = /click|primary-confirm|snapshot/.test(String(err.label || err.stage || ""));
          const reason = after ? "budget-exhausted-after-click" : "budget-exhausted-before-click";
          log("SERVICE_PIN_BUDGET_EXHAUSTED", {
            scene, playId: id, stage: err.label || err.stage || "?", reason,
          });
          return { ok: false, reason, clicked: after ? "unknown" : false };
        }
        const reason = err && err.reason ? err.reason : "pin-error";
        log("SERVICE_ERROR", { scene, reason, detail: String(err && err.message).slice(0, 120) });
        return { ok: false, reason };
      }
    });
  }

    // Dua langkah TERPISAH, dua persetujuan terpisah: mengetik berhenti sebelum
    // klik, dan klik butuh permintaan tersendiri. Keduanya lewat runner serial
    // yang sama dengan pin, jadi tidak ada dua pekerjaan UI berbarengan.
    async function handleCommentSendOnce(body = {}) {
      return runExclusive(async () => {
        try {
          return await sendOnce.prepare({ text: body.text, confirm: body.confirm });
        } catch (err) {
          log("SERVICE_SEND_ONCE_ERROR", { stage: "prepare", detail: String(err && err.message).slice(0, 120) });
          return { ok: false, reason: "send-once-error" };
        }
      });
    }

    async function handleCommentPublishOnce(body = {}) {
      return runExclusive(async () => {
        try {
          const r = await sendOnce.publish({ confirm: body.confirm });
          if (!r.ok) return r;
          const after = await sendOnce.observeAfterClick();
          return { ...r, after };
        } catch (err) {
          log("SERVICE_SEND_ONCE_ERROR", { stage: "publish", detail: String(err && err.message).slice(0, 120) });
          return { ok: false, reason: "send-once-error" };
        }
      });
    }

  // Halaman yang SUDAH dimiliki service, atau null. SENGAJA bukan ensurePage:
  // jalur baca-saja tidak boleh pernah membuka browser. Profil Chrome terkunci
  // satu proses, jadi "membuka kalau belum ada" di sini bisa berarti merebut
  // profil dari pemiliknya di tengah LIVE.
  function pageIfOpen() {
    return page && !page.isClosed() ? page : null;
  }

  // Sapuan katalog PENUH, bergulir, dengan tiga penjaga dan satu pembatalan.
  //
  // Mengembalikan segera: { ok:false, reason } kalau ditolak, atau
  // { ok:true, reason:"scheduled"|"joined", task } kalau berjalan. Pemanggil
  // di jalur chat TIDAK PERNAH menunggu `task` - tidak ada balasan tertunda.
  function scheduleFullRefresh(trigger = "qa") {
    if (stopping) return { ok: false, reason: "stopping" };
    // SINGLE-FLIGHT: banyak pertanyaan penonton menempel pada sapuan yang
    // sedang berjalan, tidak memulai sapuan kedua.
    if (fullRefresh) return { ok: true, reason: "joined", task: fullRefresh };
    // AUTOPIN MENANG: jangan mulai apa pun kalau pin sedang menunggu/berjalan.
    if (pinPending > 0) return { ok: false, reason: "pin-pending" };

    const t = d.now();
    const sejak = t - lastFullAttemptAt;
    if (sejak < FULL_REFRESH_MIN_INTERVAL_MS) {
      return { ok: false, reason: "too-soon", retryAfterMs: FULL_REFRESH_MIN_INTERVAL_MS - sejak };
    }
    const p = pageIfOpen();
    if (!p) return { ok: false, reason: "page-not-open" };
    if (!isExpectedConsole(p.url(), config.consoleUrl)) return { ok: false, reason: "unexpected-page" };

    // Jam jeda lantai dimulai di SINI, saat dijadwalkan - bukan saat selesai.
    // Dengan begitu sapuan yang gagal atau dibatalkan pun tidak bisa memicu
    // percobaan ulang beruntun.
    lastFullAttemptAt = t;

    const task = runExclusive(async () => {
      // Diperiksa LAGI di dalam antrean: keadaan bisa berubah selama menunggu.
      if (stopping) return { ok: false, reason: "stopping" };
      if (pinPending > 0) return { ok: false, reason: "pin-pending" };
      const hidup = pageIfOpen();
      if (!hidup) return { ok: false, reason: "page-not-open" };
      if (!isExpectedConsole(hidup.url(), config.consoleUrl)) return { ok: false, reason: "unexpected-page" };

      const mulai = d.now();
      const deadline = mulai + FULL_REFRESH_BUDGET_MS;
      // SATU fungsi, DUA tugas: anggaran waktu dan pembatalan.
      //
      // collectProducts memeriksanya di puncak setiap gelombang gulir dan
      // berhenti SENDIRI dengan ranOutOfTime=true - bukan ditinggalkan di
      // tengah jalan. Operasi yang ditinggalkan tetap berjalan di latar dan
      // bisa tumpang tindih dengan pin berikutnya; yang berhenti sendiri
      // selesai rapi dan melaporkan bahwa daftarnya tidak lengkap.
      const remaining = () => {
        if (stopping || pinPending > 0) return 0;
        return deadline - d.now();
      };

      try {
        const snap = await d.collectProducts(hidup, { remaining });
        const sweptAt = d.now();
        const ms = sweptAt - mulai;
        // Daftar yang DIPOTONG tidak boleh pernah ditandai "full": ketidakhadiran
        // produk di dalamnya bukan bukti produk itu tidak ada, dan resolusi
        // judul bersandar pada keunikan di dalam daftar LENGKAP.
        if (snap.ranOutOfTime === true || snap.stoppedEarly === true) {
          const sebab = stopping ? "stopping" : (pinPending > 0 ? "pin-preempted" : "budget");
          log("SERVICE_CATALOGUE_FULL_ABORTED", {
            trigger, cause: sebab, ms, passes: snap.passes, products: snap.products.length,
            note: "daftar tidak lengkap: TIDAK disimpan sebagai full",
          });
          return { ok: false, reason: `aborted-${sebab}`, ms, passes: snap.passes };
        }
        if (snap.products.length === 0) {
          log("SERVICE_CATALOGUE_FULL_EMPTY", { trigger, ms, passes: snap.passes });
          return { ok: false, reason: "empty", ms };
        }
        // Lagi: coverage dari KOLEKTOR. Sapuan yang selesai tanpa terpotong pun
        // belum tentu lengkap - daftar yang tersaring filter juga "selesai".
        const simpan = catalogue.put({
          products: snap.products,
          coverage: snap.coverage,
          source: `full-${trigger}`,
          observedAt: sweptAt,
        });
        if (!simpan.ok) {
          log("SERVICE_CATALOGUE_NOT_STORED", {
            source: `full-${trigger}`, reason: simpan.reason, coverage: snap.coverage,
            why: (snap.coverageReasons || []).join(",").slice(0, 80),
          });
          return { ok: false, reason: simpan.reason, coverage: snap.coverage, ms, passes: snap.passes };
        }
        log("SERVICE_CATALOGUE_FULL_REFRESHED", {
          trigger, count: snap.products.length, ms, passes: snap.passes, coverage: snap.coverage,
          declaredTotal: snap.completeness ? snap.completeness.declaredTotal : null,
        });
        return { ok: true, count: snap.products.length, ms, passes: snap.passes, coverage: snap.coverage };
      } catch (err) {
        // Halaman bisa tertutup di tengah sapuan (STOP). Kegagalan di sini
        // TIDAK memperbarui capturedAt apa pun - snapshot lama tetap apa adanya,
        // termasuk umurnya.
        log("SERVICE_CATALOGUE_FULL_FAILED", { trigger, detail: String(err && err.message).slice(0, 120) });
        return { ok: false, reason: "error" };
      }
    });

    // Pembersih single-flight. `.catch` sebelum `.then` supaya penolakan dari
    // runExclusive pun tetap membersihkan penanda - kalau tidak, satu kegagalan
    // akan memblokir setiap sapuan berikutnya selamanya.
    fullRefresh = task
      .catch((err) => ({ ok: false, reason: "error", detail: String(err && err.message).slice(0, 120) }))
      .then((hasil) => {
        fullRefresh = null;
        return hasil;
      });

    return { ok: true, reason: "scheduled", task: fullRefresh };
  }

  // Katalog produk BACA-SAJA. Tidak mengklik, tidak menavigasi, tidak menyentuh
  // .pc_top_product, tidak pin/unpin, tidak menggulir, dan tidak pernah membuka
  // browser kedua.
  async function handleProducts({ maxAgeMs, refresh } = {}) {
    // refresh="full": jadwalkan sapuan penuh di LATAR, lalu jawab dengan vonis
    // yang ada SEKARANG. Rute ini tidak pernah menunggu sapuan - sapuan penuh
    // berbiaya detik, sementara pembaca sisi bot beranggaran 1500 ms, dan
    // jawaban harga yang telat lebih buruk daripada diam.
    //
    // Dipakai jalur Q&A saat sebuah pertanyaan nama ditolak coverage-insufficient:
    // pertanyaan ITU tetap tidak terjawab, pertanyaan berikutnya bisa.
    if (refresh === "full") {
      const jadwal = scheduleFullRefresh("qa");
      if (!jadwal.ok) {
        log("SERVICE_CATALOGUE_FULL_REFUSED", { reason: jadwal.reason, retryAfterMs: jadwal.retryAfterMs || 0 });
      }
      const sekarang = catalogue.read({ maxAgeMs });
      return Object.assign(sekarang, { fullRefresh: jadwal.reason || "scheduled" });
    }

    const cached = catalogue.read({ maxAgeMs });
    if (cached.ok) return cached;

    // refresh="never": jawab apa adanya. Yang basi tetap basi.
    if (refresh === "never") return cached;

    const p = pageIfOpen();
    if (!p) {
      log("SERVICE_PRODUCTS_UNAVAILABLE", { reason: "page-not-open" });
      return cached;
    }

    // requestedAt: kapan penyegaran ini DIMINTA, bukan kapan ia dapat giliran.
    // Dipakai untuk menjawab satu pertanyaan sesudah antrean: apakah ada yang
    // menerbitkan snapshot yang LEBIH BARU dari permintaan ini selagi ia
    // menunggu?
    const requestedAt = d.now();
    const acceptedAt = requestedAt;
    await runExclusive(async () => {
      // --- BALAPAN YANG DITUTUP DI SINI ---
      //
      // Terbukti bisa terjadi: penyegaran ringan mengantre, sapuan penuh (atau
      // collect-before milik pin) menerbitkan snapshot FULL yang segar selagi ia
      // menunggu, lalu penyegaran ringan akhirnya jalan dan menimpanya dengan
      // pembacaan VIEWPORT. Satu pertanyaan BERNOMOR dengan begitu mematikan
      // jalur NAMA, dan hanya terjadi kalau waktu tunggunya di bawah 1500 ms -
      // yaitu di dalam jangkauan collect 1080 ms milik customer.
      //
      // Dulu baris di bawah HANYA memeriksa jam anggarannya sendiri dan tidak
      // pernah membaca ulang keadaan katalog.
      if (catalogue.hasFreshFullSince(requestedAt)) {
        log("SERVICE_PRODUCTS_REFRESH_SKIPPED", {
          waited: d.now() - requestedAt,
          reason: "newer-full-exists",
          note: "snapshot full yang lebih baru sudah ada: pembacaan ringan mubazir",
        });
        return;
      }
      // Anggarannya sudah habis dimakan antrean? Jangan mulai sama sekali.
      const sisa = acceptedAt + CATALOGUE_REFRESH_DEADLINE_MS - d.now();
      if (sisa <= 0) {
        log("SERVICE_PRODUCTS_REFRESH_SKIPPED", { waited: d.now() - acceptedAt, reason: "queue-wait" });
        return;
      }
      // STOP yang tiba selagi task ini mengantre: jangan membaca, jangan
      // menerbitkan.
      if (stopping) {
        log("SERVICE_PRODUCTS_REFRESH_SKIPPED", { waited: d.now() - requestedAt, reason: "stopping" });
        return;
      }
      const alive = pageIfOpen();
      if (!alive) {
        log("SERVICE_PRODUCTS_REFRESH_SKIPPED", { reason: "page-closed" });
        return;
      }
      if (!isExpectedConsole(alive.url(), config.consoleUrl)) {
        log("SERVICE_PRODUCTS_REFRESH_SKIPPED", { reason: "unexpected-page" });
        return;
      }
      const t0 = d.now();
      try {
        const batch = await d.readProductsOnce(alive);
        const readAt = d.now();
        // Pembacaan viewport yang KOSONG tidak disimpan. Nol baris tidak bisa
        // dibedakan dari "daftar belum ter-render", dan menyimpannya berarti
        // melayani ok:true dengan nol produk - tepat bentuk jawaban yang
        // membuat "tidak terlihat" terbaca sebagai "tidak ada".
        if (batch.products.length === 0) {
          log("SERVICE_PRODUCTS_REFRESH_EMPTY", { ms: readAt - t0 });
          return;
        }
        // Penjaga kedua, SESUDAH pembacaan: penerbitan sendiri bisa kalah cepat.
        // catalogue.put() juga menolaknya (would-downgrade), jadi ini dua lapis
        // untuk satu invarian - yang di sini menghemat penulisan, yang di sana
        // yang menjamin.
        const simpan = catalogue.put({
          products: batch.products,
          coverage: COVERAGE.VIEWPORT,
          source: "refresh",
          observedAt: readAt,
        });
        if (!simpan.ok) {
          log("SERVICE_PRODUCTS_REFRESH_SKIPPED", { reason: simpan.reason, waited: readAt - requestedAt });
          return;
        }
        log("SERVICE_PRODUCTS_REFRESHED", { count: batch.products.length, ms: readAt - t0, coverage: COVERAGE.VIEWPORT });
      } catch (err) {
        log("SERVICE_PRODUCTS_REFRESH_FAILED", { detail: String(err && err.message).slice(0, 120) });
      }
    });

    // Dibaca ulang lewat kebijakan yang SAMA. Kalau penyegarannya tidak terjadi
    // atau gagal, yang keluar tetap vonis basi/tidak-tersedia yang jujur -
    // bukan data lama berlabel segar.
    return catalogue.read({ maxAgeMs });
  }

  // --- PEMELIHARAAN KESEGARAN KATALOG DI LATAR ---------------------------
  //
  // Memakai scheduleFullRefresh YANG SAMA: tidak ada implementasi sapuan
  // kedua, tidak ada browser kedua, tidak ada discovery Controller. Yang
  // ditambahkan modul ini hanya KEPUTUSAN KAPAN - digerakkan umur snapshot,
  // bukan tik buta.
  //
  // Timer-nya di-unref: ia tidak boleh menjadi alasan proses service tetap
  // hidup sesudah STOP. Itu pelajaran yang sama dengan .bot.lock yang
  // tertinggal pada 2026-10-09 - yang menahan proses harus selalu pekerjaan
  // nyata, bukan penjadwal.
  const maintenance = createCatalogueMaintenance({
    now: () => d.now(),
    setTimer: (fn, ms) => {
      const t = setTimeout(fn, ms);
      if (t && typeof t.unref === "function") t.unref();
      return t;
    },
    clearTimer: (t) => clearTimeout(t),
    readState: () => catalogue.state(),
    isPinPending: () => pinPending > 0,
    isStopping: () => stopping === true,
    isSweepInFlight: () => !!fullRefresh,
    requestRefresh: () => scheduleFullRefresh("maintenance"),
    log,
  });

  const app = express();
  app.use(express.json({ limit: "16kb" }));

  // Dipisah dari rute supaya BISA DITES tanpa menyalakan server. Sebelum
  // Phase 21, commentTransport di sini di-hardcode "dry-run" walau service
  // dijalankan dengan --enable-autocomment-send - jenis laporan menyesatkan
  // yang sama dengan [AUTOCOMMENT_CONFIG] di bot, dan tidak ada tes yang bisa
  // menangkapnya selama kalimatnya terkubur di dalam handler rute.
  function healthPayload() {
    return {
      ok: true,
      dryRun,
      pageOpen: !!(page && !page.isClosed()),
      chatPageOpen: !!(chatPage && !chatPage.isClosed()),
      // Yang dilaporkan adalah apa yang service ini SANGGUP lakukan: transport
      // dimiliki bot, tapi tanpa --enable-autocomment-send tidak ada jalur
      // browser sama sekali di sisi service.
      commentTransport: allowAutoCommentSend === true ? "browser" : "dry-run",
      timeouts: budget,
      pinTimeouts: pinBudget,
      commentSendOnce: sendOnce.status(),
      autoCommentSend: allowAutoCommentSend === true ? "enabled" : "disabled",
      autoCommentAttempts: browserSender.__state().attempts,
      clickStrategy: browserSender.__state().clickStrategy,
      latestPlayId: generation.latest(),
      botId: generation.session() || "(none)",
      expectedShop: config.expectedShop || null,
      // P2: generasi config runtime yang dipakai run ini. Service tidak memakai
      // pemetaannya sama sekali - judul produk datang per-permintaan dari bot,
      // begitu juga teks chat. Angka ini ada supaya Controller bisa MEMBUKTIKAN
      // bot dan service membaca generasi yang SAMA. Tanpa itu, bot yang memakai
      // pemetaan baru sementara service masih sisa run sebelumnya akan terlihat
      // normal sepenuhnya.
      runtimeConfigId: runtimeConfigId || null,
      // Diagnostik snapshot katalog. TIDAK pernah membawa produknya.
      productSnapshot: catalogue.state(),
      fullRefresh: { inFlight: !!fullRefresh, pinPending, stopping },
      maintenance: maintenance.stats(),
    };
  }

  app.get("/health", (_req, res) => {
    res.json(healthPayload());
  });

  app.post("/pin", async (req, res) => {
    const { scene, productKey, playId, sessionId } = req.body || {};
    try {
      const result = await handlePin({ scene, productKey, playId, sessionId });
      res.json(result);
    } catch (err) {
      // handlePin sudah menangkap semuanya; ini jaring terakhir agar service
      // tidak pernah membalas dengan koneksi terputus.
      res.json({ ok: false, reason: "service-error" });
    }
  });

  // BACA-SAJA, dan GET dengan sengaja: satu-satunya GET lain di service ini
  // (/health) juga baca-saja, sementara semua rute yang MENGUBAH sesuatu
  // adalah POST. Mengikuti konvensi itu membuat sifat rute terbaca dari
  // metodenya.
  //
  // Tidak butuh flag otoritas baru: flag yang ada (--enable-autocomment-send,
  // --allow-comment-send-once) menggerbang AKSI NYATA ke akun customer, dan
  // rute ini tidak beraksi. Menambah flag untuk pembacaan hanya akan
  // mengaburkan arti flag yang maknanya sekarang tajam.
  app.get("/products", async (req, res) => {
    const q = req.query || {};
    try {
      res.json(await handleProducts({
        // Nilai yang tidak bisa dibaca sebagai angka dianggap tidak diisi,
        // bukan nol: Number("") === 0 akan menolak semua snapshot.
        maxAgeMs: Number.isFinite(Number(q.maxAgeMs)) && String(q.maxAgeMs).trim() !== "" ? Number(q.maxAgeMs) : undefined,
        refresh: typeof q.refresh === "string" ? q.refresh : undefined,
      }));
    } catch (err) {
      log("SERVICE_PRODUCTS_ERROR", { detail: String(err && err.message).slice(0, 120) });
      res.json({ ok: false, error: "product-snapshot-unavailable" });
    }
  });

  // Dipanggil sekali saat service start: membuka browser lebih awal supaya
  // permintaan pin PERTAMA tidak menanggung ~20 detik startup, yang pasti
  // melewati batas waktu dispatcher di sisi bot.
  async function warmUp() {
    try {
      await ensurePage();
      // Snapshot awal: SATU lintasan, tanpa menggulir. Sengaja bukan koleksi
      // penuh - koleksi penuh memakan ~4 detik gulir di saat start dan snapshot
      // "full" toh datang gratis pada pin pertama. Yang dibeli di sini hanya
      // supaya pembaca pertama tidak menemukan katalog kosong.
      // Gagal di sini tidak menggagalkan apa pun.
      try {
        const batch = await d.readProductsOnce(page);
        if (batch.products.length > 0) {
          catalogue.put({ products: batch.products, coverage: COVERAGE.VIEWPORT, source: "warmup", observedAt: d.now() });
          log("SERVICE_CATALOGUE_WARMED", { count: batch.products.length, coverage: COVERAGE.VIEWPORT });
        }
      } catch (e) {
        log("SERVICE_CATALOGUE_WARMUP_FAILED", { detail: String(e && e.message).slice(0, 120) });
      }

      // Satu sapuan PENUH di awal, supaya pertanyaan berbasis nama produk bisa
      // dijawab sejak detik-detik pertama run - bukan hanya sesudah pin pertama.
      //
      // Tidak menunda kesiapan START: warmUp() sendiri dipanggil SESUDAH
      // server listen() dan tidak ditunggu oleh siapa pun. Ia memakai anggaran
      // dan pembatalan yang sama dengan sapuan on-demand, jadi kalau pin
      // pertama tiba selagi sapuan ini berjalan, pin yang menang.
      //
      // Jam jeda lantai sengaja TIDAK dipakai di sini: ini sapuan pertama run.
      lastFullAttemptAt = -Infinity;
      const awal = scheduleFullRefresh("warmup");
      if (awal.ok && awal.task) {
        const hasil = await awal.task;
        log("SERVICE_CATALOGUE_FULL_WARMED", { ok: hasil.ok, reason: hasil.reason || "-", count: hasil.count || 0, ms: hasil.ms || 0 });
      } else {
        log("SERVICE_CATALOGUE_FULL_WARMUP_SKIPPED", { reason: awal.reason });
      }

      // Pemeliharaan dinyalakan SESUDAH sapuan awal, dan tidak menunda apa pun:
      // warmUp sendiri tidak ditunggu siapa pun, dan pemeriksaan pertamanya
      // hanya membaca umur snapshot di memori.
      if (!stopping) maintenance.start();
      return { ok: true };
    } catch (err) {
      log("SERVICE_WARMUP_FAILED", { detail: String(err && err.message).slice(0, 120) });
      return { ok: false };
    }
  }

    app.post("/comment/dry-run", async (req, res) => {
      const { text, scene, playId, sessionId } = req.body || {};
      try {
        res.json(await handleCommentDryRun({ text, scene, playId, sessionId }));
      } catch {
        res.json({ ok: false, reason: "service-error" });
      }
    });

    app.post("/comment/send", async (req, res) => {
    const { text, scene, playId, sessionId } = req.body || {};
    try {
      res.json(await handleCommentSend({ text, scene, playId, sessionId }));
    } catch {
      res.json({ ok: false, reason: "service-error" });
    }
  });

  app.post("/comment/send-once", async (req, res) => {
      try {
        res.json(await handleCommentSendOnce(req.body || {}));
      } catch {
        res.json({ ok: false, reason: "service-error" });
      }
    });

    app.post("/comment/send-once/publish", async (req, res) => {
      try {
        res.json(await handleCommentPublishOnce(req.body || {}));
      } catch {
        res.json({ ok: false, reason: "service-error" });
      }
    });

  // Dipanggil sekali saat service start, SESUDAH halaman produk hangat. Tab chat
  // dibuka dan ditunggu sampai komposernya siap diperiksa, supaya scene pertama
  // tidak menanggung cold start. Kegagalan di sini hanya dicatat: service tetap
  // hidup dan AutoPIN tidak terganggu sama sekali.
  async function warmUpChat() {
    try {
      await ensureChatPage();
      // Halaman produk dikembalikan ke depan: daftar produk yang ter-virtualisasi
      // hanya ter-render di tab yang aktif (lihat AP2.3).
      if (page && typeof page.bringToFront === "function") {
        try {
          await page.bringToFront();
        } catch {
          /* bukan alasan untuk menggagalkan apa pun */
        }
      }
      return { ok: true };
    } catch (err) {
      log("SERVICE_CHAT_WARMUP_FAILED", { detail: String(err && err.message).slice(0, 120) });
      return { ok: false };
    }
  }

  async function stop() {
    // Penjadwal dimatikan LEBIH DULU: tidak boleh ada pemeriksaan baru yang
    // menyelip sesudah ini, dan tidak boleh ada timer yang tertinggal.
    maintenance.stop();
    // Ditandai LEBIH DULU: sapuan yang sedang berjalan membacanya lewat
    // `remaining`, memotong dirinya sendiri di gelombang gulir berikutnya, dan
    // melepas giliran browser.
    stopping = true;

    // Lalu DITUNGGU sebentar. Menutup browser di bawah page.evaluate yang masih
    // berjalan menghasilkan penolakan yang tidak perlu dan meninggalkan sapuan
    // yang masih menggulir halaman yang sudah mati. Batas atasnya ada supaya
    // STOP tidak pernah menggantung: kalau sapuan tidak berhenti tepat waktu,
    // kami tetap menutup - dan sapuan itu akan gagal rapi di catch-nya.
    if (fullRefresh) {
      const batas = new Promise((r) => setTimeout(r, 1_500));
      await Promise.race([fullRefresh.catch(() => {}), batas]);
    }

    if (browser) await d.closeBrowser(browser).catch(() => {});
    browser = null;
    chatPage = null;
    page = null;
  }

  return {
    app,
    handlePin,
    handleProducts,
    scheduleFullRefresh,
    catalogue,
    handleCommentDryRun,
    handleCommentSend,
    noteScenePlayId,
    generation,
        handleCommentSendOnce,
        handleCommentPublishOnce,
        sendOnceStatus: () => sendOnce.status(),
    ensureChatPage,
    warmUpChat,
    stop,
    warmUp,
    healthPayload,
    maintenance,
    pinConfirmer,
    timeouts: budget,
    pinTimeouts: pinBudget,
    __state: () => ({
      latestPlayId: generation.latest(), botId: generation.session(),
      hasPage: !!page, hasChatPage: !!chatPage, timeouts: budget,
      pinPending, fullRefreshInFlight: !!fullRefresh, stopping,
    }),
  };
}

// Selalu loopback: /pin tidak boleh bisa dipanggil dari perangkat lain di LAN.
// Host sengaja TIDAK dibuat bisa dikonfigurasi lewat environment.
function startService({ port = Number(process.env.AUTOPIN_PORT) || DEFAULT_PORT, ...rest } = {}) {
  const svc = createService(rest);
  return new Promise((resolve) => {
    const server = svc.app.listen(port, LOOPBACK, () => {
      const addr = server.address();
      log("SERVICE_LISTENING", { host: addr.address, port: addr.port, dryRun: !!rest.dryRun });
      // Anggaran waktu dicetak supaya bisa dibaca, bukan ditebak dari kode.
      log("SERVICE_TIMEOUTS", { budget: describeTimeouts(svc.timeouts) });
      log("SERVICE_PIN_TIMEOUTS", { budget: describePinTimeouts(svc.pinTimeouts) });
      if (!svc.pinTimeouts.fits) {
        log("SERVICE_PIN_BUDGET_TOO_TIGHT", {
          note: "AUTOPIN_TIMEOUT_MS terlalu kecil: pin bisa ditolak sebelum diklik",
        });
      }
      if (!svc.timeouts.fits) {
        log("SERVICE_TIMEOUT_BUDGET_TOO_TIGHT", {
          note: "AUTOCOMMENT_TIMEOUT_MS terlalu kecil: service bisa menjawab SETELAH bot menyerah",
        });
      }
      svc.warmUp()
        .then((w) => {
          log("SERVICE_WARMED", { ok: w.ok });
          // Tab chat dihangatkan SESUDAH halaman produk dan berurutan, supaya
          // tidak ada dua pekerjaan browser berbarengan saat start.
          return svc.warmUpChat();
        })
        .then((c) => log("SERVICE_CHAT_WARMED", { ok: c.ok }))
        .catch(() => {});
      resolve({ ...svc, server });
    });
  });
}

module.exports = { createService, startService, isExpectedConsole, DEFAULT_PORT, LOOPBACK };
