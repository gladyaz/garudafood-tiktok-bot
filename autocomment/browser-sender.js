"use strict";
// AR3 — pengirim chat yang BISA DIPAKAI BERULANG, tapi berpagar per playId.
//
// Bedanya dengan autocomment/send-once.js (alat diagnostik AR2B yang sengaja
// dibatasi satu kali SEUMUR PROSES): modul ini boleh melayani banyak scene,
// namun tetap memberi jaminan yang sama per pemutaran:
//
//   * satu playId = PALING BANYAK satu kali ketik dan satu kali klik
//   * playId yang sama diminta lagi -> ditolak, tidak pernah mengirim dua kali
//   * playId yang sudah ketinggalan (scene lain sudah mulai) -> ditolak,
//     DIPERIKSA DUA KALI: sebelum mengetik DAN tepat sebelum mengklik
//   * nol retry, nol loop, Enter tidak pernah ditekan
//   * identitas toko harus akun tes; identitas produksi selalu menolak
//   * teks di komposer harus COCOK PERSIS sebelum klik
//   * kontrol kirim harus terbukti enabled sebelum klik
//   * hasil ambigu dilaporkan apa adanya, tidak pernah dicoba ulang
//
// ---------------------------------------------------------------------------
// REKONSILIASI HASIL KLIK (ditambahkan sesudah Phase 21)
//
// Pada LIVE 2026-10-05 klik Publish gagal dengan timeout protokol:
//
//   [AUTOCOMMENT_SEND_FAILED] scene=PAX-1 playId=1 stage=click
//                             detail=Runtime.callFunctionOn timed out
//
// Dulu itu langsung disimpulkan "gagal". Itu kesimpulan yang tidak sah: klik
// BISA sudah mendarat sebelum panggilan protokolnya kehabisan waktu, dan pesan
// bisa sudah sampai ke penonton. Satu-satunya cara jujur adalah MEMBACA keadaan
// komposer sesudahnya, dalam jendela berbatas, lalu melaporkan apa yang terbaca:
//
//   komposer KOSONG  + Publish kembali DISABLED  -> terkirim (sent)
//   teks KITA UTUH   + Publish masih ENABLED     -> belum terkirim (not-sent)
//   apa pun selain itu                           -> ambigu, dilaporkan apa adanya
//
// Tidak ada cabang yang mengirim ulang. Pembersihan hanya menyentuh teks yang
// PERSIS sama dengan yang kita tulis, jadi ketikan orang lain tidak pernah
// ikut terhapus.
// ---------------------------------------------------------------------------
//
// Kalau sebuah permintaan menjadi basi SESUDAH mengetik tapi SEBELUM mengklik,
// teks yang KITA tulis dibersihkan - dan hanya kalau isinya memang persis teks
// itu, supaya ketikan manusia tidak pernah ikut terhapus.

const {
  inspectComposerInPage, decideDryRun,
  CHAT_TEXTAREA, PUBLISH_ICON, UI_MAX_LENGTH, COMPOSER_SCOPE_DEPTH,
} = require("./browser-transport");
const { readComposerTextInPage } = require("./send-once");
const { planTimeouts } = require("./timeouts");
const { createStepTimer } = require("./step-timer");
const { createClickStrategy, STRATEGIES } = require("./click-strategy");

// Berapa playId terakhir yang diingat. Cukup untuk satu sesi LIVE (ratusan
// scene) dan tetap terbatas supaya memori tidak tumbuh tanpa batas.
const ATTEMPT_MEMORY = 500;

// Hasil rekonsiliasi. Bukan sekadar boolean: "tidak tahu" adalah jawaban yang
// sah dan harus bisa dilaporkan apa adanya.
const OUTCOME = Object.freeze({
  SENT: "sent",
  NOT_SENT: "not-sent",
  AMBIGUOUS: "ambiguous",
});

const REFUSE = (reason, extra) => ({ ok: false, reason, ...extra });

const isEmptyText = (t) => t === "" || t === null || t === undefined;

// Membatasi SATU operasi browser. Bukan pengganti protocolTimeout Puppeteer,
// melainkan deadline yang KITA kendalikan, supaya service selalu menjawab
// sebelum timeout HTTP milik bot - lihat autocomment/timeouts.js.
//
// ms <= 0 berarti tanpa deadline: anggaran yang tidak masuk akal lebih baik
// dijalankan tanpa batas daripada menggagalkan setiap operasi seketika.
function withDeadline(promise, ms, label, { setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const timer = setTimeoutFn(() => {
      const err = new Error(`deadline-exceeded:${label}`);
      err.deadline = true;
      err.label = label;
      reject(err);
    }, ms);
    Promise.resolve(promise).then(
      (v) => {
        clearTimeoutFn(timer);
        resolve(v);
      },
      (e) => {
        clearTimeoutFn(timer);
        reject(e);
      }
    );
  });
}

// MURNI MEMBACA. Dipanggil hanya sesudah klik gagal/timeout, dan tidak pernah
// mengetik, mengklik, maupun menekan Enter. Berhenti pada kesimpulan pertama
// yang jelas, atau pada batas jendela dengan jawaban "ambigu".
async function reconcileClickOutcome(page, expectedText, {
  inspect,
  readText,
  windowMs = 0,
  pollMs = 250,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const started = now();
  let observed = null;
  let polls = 0;

  for (;;) {
    polls += 1;
    try {
      const text = await readText(page);
      const composer = await inspect(page);
      observed = { text, composer };

      const found = !!composer && composer.foundPublishControl === true;
      const disabled = !!composer && composer.publishDisabled === true;

      // Terkirim: komposer bersih DAN tombol kirim kembali mati. Itu persis
      // jejak pengiriman yang berhasil (composerCleared=true pada AR2B).
      if (isEmptyText(text) && found && disabled) {
        return { outcome: OUTCOME.SENT, polls, ms: now() - started, observed };
      }

      // Belum terkirim: teks KITA masih utuh DAN tombol kirim masih hidup.
      // Keduanya harus benar; satu saja tidak cukup untuk menyimpulkan.
      if (text === expectedText && found && disabled === false) {
        return { outcome: OUTCOME.NOT_SENT, polls, ms: now() - started, observed };
      }
    } catch (err) {
      // Bacaan yang gagal bukan kesimpulan. Dicatat, lalu dicoba baca lagi
      // selama jendelanya belum habis.
      observed = { error: String(err && err.message).slice(0, 80) };
    }

    if (now() - started >= windowMs) {
      return { outcome: OUTCOME.AMBIGUOUS, polls, ms: now() - started, observed };
    }
    await sleep(pollMs);
  }
}

function createBrowserSender({
  getPage,
  allowed = false,              // HANYA dari flag baris perintah service
  config = {},
  readIdentity,
  checkIdentity,
  isStale,                      // (playId) => boolean, generasi scene milik service
  maxLength = UI_MAX_LENGTH,
  timeouts = planTimeouts({}),
  // Pilihan strategi klik. SENGAJA tidak dibaca dari environment: tidak ada
  // berkas .env yang boleh mengubah cara sesuatu diklik di akun sungguhan.
  //
  // Default DOM sejak run LIVE 2026-10-05 yang membuktikannya: click=95ms,
  // total 1674ms, chat terkirim dan terkonfirmasi penonton. Jalur warisan
  // (handle) tidak pernah selesai di halaman yang sama - 3758ms lalu 14038ms,
  // keduanya timeout - jadi ia tidak boleh lagi menjadi jalur default. Masih
  // tersedia lewat --click-strategy=handle untuk perbandingan.
  clickStrategy = STRATEGIES.DOM,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  logger = console,
} = {}) {
  // Hanya boolean true persis. Nilai truthy lain tidak cukup: otorisasi harus
  // disengaja, bukan kebetulan.
  const armed = allowed === true;
  const attempted = new Set();  // playId yang sudah pernah dicoba

  const log = (line) => {
    try {
      logger.log(line);
    } catch {
      /* logger rusak tidak boleh menjatuhkan apa pun */
    }
  };

  const stale = (playId) => (typeof isStale === "function" ? isStale(playId) === true : false);

  function remember(playId) {
    attempted.add(playId);
    if (attempted.size > ATTEMPT_MEMORY) {
      attempted.delete(attempted.values().next().value);
    }
  }

  const SEL = {
    textarea: CHAT_TEXTAREA,
    publishIcon: PUBLISH_ICON,
    uiMax: maxLength,
    depth: COMPOSER_SCOPE_DEPTH,
  };

  const inspect = (p) => p.evaluate(inspectComposerInPage, SEL);
  const readText = (p) => p.evaluate(readComposerTextInPage, CHAT_TEXTAREA);

  // Membersihkan HANYA teks yang kita tulis sendiri. Kalau isi komposer sudah
  // berbeda (operator mengetik sesuatu), biarkan apa adanya.
  async function clearOwnText(p, expected) {
    try {
      const current = await readText(p);
      if (current !== expected) return { cleared: false, reason: "not-ours" };
      await p.focus(CHAT_TEXTAREA);
      await p.keyboard.down("Control");
      await p.keyboard.press("KeyA");
      await p.keyboard.up("Control");
      await p.keyboard.press("Backspace");
      const after = await readText(p);
      return { cleared: isEmptyText(after) };
    } catch (err) {
      return { cleared: false, reason: String(err && err.message).slice(0, 60) };
    }
  }

  // Satu-satunya titik yang mencetak timing, dan ia di finally: hasil sukses,
  // penolakan, maupun error sama-sama terukur. finally tanpa return/throw tidak
  // mengubah apa pun yang dikembalikan attempt().
  async function send(req) {
    const timer = createStepTimer({ now });
    try {
      return await attempt(req, timer);
    } finally {
      // Permintaan yang ditolak sebelum menyentuh halaman tidak menghasilkan
      // tahap apa pun; tidak perlu baris kosong yang bikin log berisik.
      if (timer.any()) {
        const id = Number.isFinite(req && req.playId) ? req.playId : "-";
        log(
          "[AUTOCOMMENT_SEND_TIMING] scene=" + (req && req.scene) +
          " playId=" + id + " strategy=" + clickStrategy + " " + timer.describe()
        );
      }
    }
  }

  async function attempt({ text, scene, playId }, timer) {
    if (!armed) return REFUSE("real-comment-send-disabled");

    const id = Number.isFinite(playId) ? playId : null;
    if (id === null) return REFUSE("play-id-required");
    if (attempted.has(id)) {
      log(`[AUTOCOMMENT_SEND_SKIPPED] scene=${scene} playId=${id} reason=duplicate-play-id`);
      return REFUSE("duplicate-play-id");
    }
    if (typeof text !== "string" || text.trim() === "") return REFUSE("empty-message");
    // Satuan UTF-16, menyamai penghitung TikTok.
    if (text.length > maxLength) return REFUSE("message-too-long");

    // Gerbang basi #1: sebelum menyentuh apa pun.
    if (stale(id)) {
      log(`[AUTOCOMMENT_SEND_STALE] scene=${scene} playId=${id} phase=before-type`);
      return REFUSE("stale");
    }

    let p;
    try {
      p = await timer.step("getPage", () => getPage());
      if (!p) throw new Error("chat-page-unavailable");
      if (typeof p.isClosed === "function" && p.isClosed()) throw new Error("chat-page-closed");
    } catch (err) {
      return REFUSE("chat-page-unavailable", { detail: String(err && err.message).slice(0, 80) });
    }

    // Identitas: header akun saja, tidak pernah teks produk.
    const observed = await timer.step("identity", () => readIdentity(p));
    const verdict = checkIdentity({
      expected: config.expectedShop,
      observed,
      forbidden: config.forbiddenShops,
    });
    if (!verdict.ok) {
      log(`[AUTOCOMMENT_SEND_REFUSED] scene=${scene} playId=${id} reason=identity-${verdict.reason}`);
      return REFUSE(`identity-${verdict.reason}`);
    }

    const before = await timer.step("inspect-before", () => inspect(p));
    const ready = decideDryRun(text, before, { uiMax: maxLength });
    if (!ready.ok) {
      log(`[AUTOCOMMENT_SEND_REFUSED] scene=${scene} playId=${id} reason=${ready.reason}`);
      return REFUSE(ready.reason, { composer: before });
    }

    // ---- mulai dari sini halaman benar-benar disentuh ----
    // Jatah playId dipakai SEKARANG: hasil setengah jadi atau ambigu pun tidak
    // boleh membuka percobaan kedua.
    remember(id);
    log(`[AUTOCOMMENT_SEND_TYPING] scene=${scene} playId=${id} shop="${(observed || []).join(" | ")}" chars=${text.length}`);

    // Deadline milik kita sendiri, dihitung mundur dari sini. Service harus
    // menjawab sebelum bot menyerah; lihat autocomment/timeouts.js.
    const budget = timeouts.browserDeadlineMs > 0 ? timeouts.browserDeadlineMs : 0;
    const deadlineAt = now() + budget;
    const bounded = (promise, label) => {
      if (budget <= 0) return Promise.resolve(promise);
      const remaining = deadlineAt - now();
      if (remaining <= 0) {
        // Anggaran habis: jangan menunggu lagi. Operasi yang sudah berjalan
        // dibiarkan selesai sendiri, hasilnya dibuang - tapi tanpa membiarkan
        // penolakannya menjadi unhandled rejection.
        Promise.resolve(promise).catch(() => {});
        const err = new Error(`deadline-exceeded:${label}`);
        err.deadline = true;
        err.label = label;
        return Promise.reject(err);
      }
      return withDeadline(promise, remaining, label, { setTimeoutFn, clearTimeoutFn });
    };

    // Setiap kegagalan SESUDAH mengetik membersihkan teks kita sendiri. Sebelum
    // ini hanya jalur basi yang membersihkan, sehingga Phase 21 meninggalkan 33
    // karakter menggantung di kotak chat LIVE.
    const bail = async (reason, extra) => {
      const cleanup = await timer.step("cleanup", () => clearOwnText(p, text));
      return REFUSE(reason, { clicked: false, cleared: cleanup.cleared, ...extra });
    };

    try {
      await timer.step("focus", () => bounded(p.focus(CHAT_TEXTAREA), "focus"));
      // Bersihkan isi lama lewat seleksi + hapus. Mengisi el.value langsung
      // tidak dilihat React, sehingga tombol kirim tidak akan pernah aktif.
      await timer.step("clear", async () => {
        await bounded(p.keyboard.down("Control"), "selectall");
        await bounded(p.keyboard.press("KeyA"), "selectall");
        await bounded(p.keyboard.up("Control"), "selectall");
        await bounded(p.keyboard.press("Backspace"), "clear");
      });
      // Satu kali ketik. TIDAK ADA Enter: pengiriman hanya lewat klik.
      await timer.step("type", () => bounded(p.type(CHAT_TEXTAREA, text, { delay: 25 }), "type"));
    } catch (err) {
      const detail = String(err && err.message).slice(0, 80);
      log(`[AUTOCOMMENT_SEND_FAILED] scene=${scene} playId=${id} stage=type detail=${detail}`);
      return bail("type-failed", { detail });
    }

    const typed = await timer.step("verify", () => bounded(readText(p), "verify")).catch(() => undefined);
    if (typed !== text) {
      log(`[AUTOCOMMENT_SEND_FAILED] scene=${scene} playId=${id} stage=verify reason=typed-text-mismatch`);
      return bail("typed-text-mismatch", { typed });
    }

    const after = await timer.step("inspect-after", () => bounded(inspect(p), "inspect")).catch(() => null);
    if (!after || !after.foundPublishControl) {
      log(`[AUTOCOMMENT_SEND_FAILED] scene=${scene} playId=${id} stage=verify reason=publish-control-not-found`);
      return bail("publish-control-not-found", { composer: after });
    }
    if (after.publishDisabled) {
      log(`[AUTOCOMMENT_SEND_FAILED] scene=${scene} playId=${id} stage=verify reason=publish-still-disabled`);
      return bail("publish-still-disabled", { composer: after });
    }

    // Gerbang basi #2: tepat sebelum klik. Scene bisa berganti selama mengetik,
    // dan pesan scene lama TIDAK BOLEH muncul setelah scene baru mengambil alih.
    if (timer.sync("stale", () => stale(id))) {
      const cleanup = await timer.step("cleanup", () => clearOwnText(p, text));
      log(`[AUTOCOMMENT_SEND_STALE] scene=${scene} playId=${id} phase=before-click cleared=${cleanup.cleared}`);
      return REFUSE("stale", { clicked: false, cleared: cleanup.cleared });
    }

    // Satu instance per permintaan: lapis kedua di atas jatah per-playId, yang
    // menjamin satu playId tidak pernah menghasilkan dua percobaan klik.
    const clicker = createClickStrategy({ strategy: clickStrategy, depth: COMPOSER_SCOPE_DEPTH, logger: log });
    let clicked;
    try {
      // SATU percobaan klik. Tanpa retry, tanpa Enter, dan TANPA mencoba
      // strategi lain kalau yang ini gagal.
      clicked = await clicker.click({ page: p, bounded, timer });
    } catch (err) {
      const detail = String(err && err.message).slice(0, 80);
      log(`[AUTOCOMMENT_SEND_FAILED] scene=${scene} playId=${id} stage=click strategy=${clicker.name} detail=${detail}`);
      // Hasilnya TIDAK DIKETAHUI: jangan simpulkan gagal, jangan kirim ulang,
      // jangan ganti strategi. Baca keadaan komposernya.
      return await reconcile({ p, text, scene, id, detail, timer });
    }
    if (!clicked || clicked.ok !== true) {
      const reason = (clicked && clicked.reason) || "publish-control-not-found";
      log(`[AUTOCOMMENT_SEND_FAILED] scene=${scene} playId=${id} stage=click strategy=${clicker.name} reason=${reason}`);
      // Keadaan elemen yang menolak berarti kita TAHU tidak ada klik yang
      // terjadi - maka teks kita sendiri aman dibersihkan.
      return await bail(reason);
    }

    // Bacaan sesudah klik: komposer yang kembali kosong adalah sinyal kuat, tapi
    // bukan bukti sampai ke penonton. Karena itu sent tetap "unknown".
    let composerCleared = null;
    try {
      const leftover = await timer.step("after-click", () => bounded(readText(p), "after-click"));
      composerCleared = isEmptyText(leftover);
    } catch {
      composerCleared = null;
    }

    log(`[AUTOCOMMENT_SEND_CLICKED] scene=${scene} playId=${id} strategy=${clicker.name} clicks=1 composerCleared=${composerCleared}`);
    return { ok: true, reason: "clicked", clicks: 1, sent: "unknown", text, composerCleared, strategy: clicker.name };
  }

  // Jendela rekonsiliasi: read-only, berbatas waktu, nol retry.
  async function reconcile({ p, text, scene, id, detail, timer }) {
    const t = timer || createStepTimer({ now });
    const r = await t.step("reconcile", () =>
      reconcileClickOutcome(p, text, {
        inspect,
        readText,
        windowMs: timeouts.reconcileWindowMs,
        pollMs: timeouts.reconcilePollMs,
        now,
        sleep,
      })
    );

    const head = `[AUTOCOMMENT_SEND_RECONCILED] scene=${scene} playId=${id} outcome=${r.outcome} polls=${r.polls} ms=${r.ms}`;

    if (r.outcome === OUTCOME.SENT) {
      // Komposer bersih dan tombol kirim mati: jejak pengiriman yang berhasil.
      // Dilaporkan sukses TANPA percobaan kedua. `sent` tetap "likely", bukan
      // "yes": yang kita punya jejak UI, bukan konfirmasi dari penonton.
      log(`${head} note="komposer kosong + publish disabled, tidak ada kirim ulang"`);
      return {
        ok: true,
        reason: "sent-reconciled",
        clicks: 1,
        sent: "likely",
        text,
        composerCleared: true,
        reconciled: OUTCOME.SENT,
        clickError: detail,
      };
    }

    if (r.outcome === OUTCOME.NOT_SENT) {
      // Teks kita masih utuh dan tombol masih hidup: kliknya tidak mendarat.
      // Hanya di sini pembersihan jelas benar.
      const cleanup = await t.step("cleanup", () => clearOwnText(p, text));
      log(`${head} cleared=${cleanup.cleared}`);
      return REFUSE("not-sent", {
        clicked: false,
        cleared: cleanup.cleared,
        reconciled: OUTCOME.NOT_SENT,
        detail,
      });
    }

    // Ambigu. Satu-satunya mutasi yang boleh dilakukan adalah pembersihan yang
    // SUDAH terbukti aman: clearOwnText membaca ulang dan hanya menghapus kalau
    // isinya persis teks kita. Teks orang lain, teks separuh, maupun komposer
    // kosong tidak tersentuh.
    const cleanup = await t.step("cleanup", () => clearOwnText(p, text));
    log(`${head} cleared=${cleanup.cleared} note="hasil tidak dapat disimpulkan, tidak ada kirim ulang"`);
    return REFUSE("ambiguous", {
      clicked: "unknown",
      cleared: cleanup.cleared,
      reconciled: OUTCOME.AMBIGUOUS,
      detail,
      observed: r.observed,
    });
  }

  return {
    send,
    __state: () => ({ allowed: armed, attempts: attempted.size, timeouts, clickStrategy }),
  };
}

module.exports = {
  createBrowserSender,
  reconcileClickOutcome,
  withDeadline,
  ATTEMPT_MEMORY,
  OUTCOME,
};
