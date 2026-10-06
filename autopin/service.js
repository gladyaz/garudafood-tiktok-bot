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
const productsMod = require("./products");
const { createBrowserTransport, waitForComposerReady } = require("../autocomment/browser-transport");
const { createSendOnce } = require("../autocomment/send-once");
const { createBrowserSender } = require("../autocomment/browser-sender");
const { planTimeouts, describeTimeouts } = require("../autocomment/timeouts");
const { createPinConfirmer } = require("./pin-confirm");
const { createPlayGeneration } = require("./session");
const { planPinTimeouts, describePinTimeouts } = require("./pin-budget");
const { loadConfig: loadAutoCommentConfig } = require("../autocomment/config");

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
function createService({ config = loadConfig(), dryRun = false, allowCommentSendOnce = false, allowAutoCommentSend = false, timeouts, pinTimeouts, clickStrategy, deps = {} } = {}) {
  // Anggaran waktu diturunkan dari timeout HTTP yang SAMA yang dipakai bot
  // (AUTOCOMMENT_TIMEOUT_MS), supaya service selalu menjawab sebelum bot
  // menyerah. Phase 21 gagal justru karena kedua sisi tidak pernah dihubungkan.
  const budget = timeouts || planTimeouts({ httpTimeoutMs: loadAutoCommentConfig(process.env, { warn: () => {} }).timeoutMs });
  // Anggaran jalur PIN, diturunkan dari batas tunggu yang SAMA yang dipakai bot
  // (AUTOPIN_TIMEOUT_MS). Tanpa ini, bot bisa menyerah sementara service masih
  // menggulir dan mengklik - keadaan "entah" yang terjadi pada LIVE 2026-10-06
  // dengan katalog 20 produk. Lihat autopin/pin-budget.js.
  const pinBudget = pinTimeouts || planPinTimeouts({ httpTimeoutMs: Number(process.env.AUTOPIN_TIMEOUT_MS) || undefined });
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
    browser = await d.launchBrowser(config);
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
  async function guardedPin({ scene, productKey, playId, sessionId }) {
    // --- anggaran waktu + instrumentasi per-tahap ---
    // Satu deadline untuk SELURUH pekerjaan sisi service. Tiap tahap yang bisa
    // lambat dijalankan di bawah sisa waktu, jadi service tidak pernah masih
    // bekerja ketika bot sudah menyerah.
    const t0 = d.now();
    const deadlineAt = t0 + pinBudget.browserDeadlineMs;
    const left = () => deadlineAt - d.now();
    const marks = [];
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
    const collectMs = d.now() - sebelumCollect;
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
    const id = Number.isFinite(playId) ? playId : 0;
    if (isStale(sessionId, id)) return { ok: false, reason: "stale" };
    noteScenePlayId(sessionId, id);

    return runExclusive(async () => {
      // Dicek lagi DI DALAM antrean: permintaan yang lebih baru bisa datang
      // selama kita menunggu giliran. Yang menang adalah yang terbaru.
      if (isStale(sessionId, id)) {
        log("SERVICE_STALE", { scene, playId: id, latest: generation.latest(), phase: "queued" });
        return { ok: false, reason: "stale" };
      }
      try {
        return await guardedPin({ scene, productKey, playId: id, sessionId });
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

  // Dipanggil sekali saat service start: membuka browser lebih awal supaya
  // permintaan pin PERTAMA tidak menanggung ~20 detik startup, yang pasti
  // melewati batas waktu dispatcher di sisi bot.
  async function warmUp() {
    try {
      await ensurePage();
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
    if (browser) await d.closeBrowser(browser).catch(() => {});
    browser = null;
    chatPage = null;
    page = null;
  }

  return {
    app,
    handlePin,
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
    pinConfirmer,
    timeouts: budget,
    pinTimeouts: pinBudget,
    __state: () => ({
      latestPlayId: generation.latest(), botId: generation.session(),
      hasPage: !!page, hasChatPage: !!chatPage, timeouts: budget,
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
