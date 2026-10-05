// Rekonsiliasi hasil klik Publish + anggaran waktu.
//
// Regresi LIVE 2026-10-05 (Phase 21), kaki AutoComment. Yang terjadi:
//
//   bot, detik 8:   [AUTOCOMMENT_FAILED] reason=send-rejected
//                                        detail=This operation was aborted
//   service, nanti: [AUTOCOMMENT_SEND_FAILED] stage=click
//                                        detail=Runtime.callFunctionOn timed out
//
// Dua cacat sekaligus. Pertama, bot menyerah jauh sebelum service selesai, jadi
// jawabannya tidak pernah sampai. Kedua, klik yang timeout langsung disimpulkan
// "gagal" - padahal kliknya BISA sudah mendarat dan pesannya sudah sampai ke
// penonton. Selama berpuluh menit tidak ada satu pun pihak yang tahu.
//
// Semua memakai halaman palsu: tidak ada browser, Puppeteer, TikTok, OBS, HTTP,
// maupun jaringan. Tidak ada satu pun tes di sini yang menunggu waktu nyata.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createBrowserSender, reconcileClickOutcome, withDeadline, OUTCOME,
} = require("../autocomment/browser-sender");
const {
  planTimeouts, describeTimeouts, PROTOCOL_TIMEOUT_MS, MIN_MARGIN_MS,
} = require("../autocomment/timeouts");
const { checkIdentity } = require("../autopin/core");
const { createService } = require("../autopin/service");

const SHOP = "agen_mulia_abadi";
const CONFIG = { expectedShop: SHOP, forbiddenShops: ["garudafood"] };
const TEXT = "Etalase 1 sudah aku pin ya kak \u{1F6D2}";
const TIMEOUT_ERR = "Runtime.callFunctionOn timed out. Increase the 'protocolTimeout' setting";
const silent = { log() {} };

// Jam palsu: jendela rekonsiliasi diuji tanpa benar-benar menunggu.
function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
}

// Halaman chat palsu yang MEMODELKAN keadaan, bukan sekadar mengembalikan
// jawaban terskrip: teks benar-benar berubah saat diketik, dihapus, dan diklik.
// Tombol Publish mati saat komposer kosong, persis seperti TikTok.
function fakePage({
  resolveThrows = null,   // timeout SEBELUM klik (saat mencari tombol)
  clickThrows = null,     // timeout SAAT klik
  clickClears = true,     // true = klik benar-benar mengirim (komposer bersih)
  publishStuck = null,    // paksa publishDisabled, lepas dari isi komposer
  hijackOnClick = null,   // komposer diisi teks ORANG LAIN sesudah klik
  readThrowsAfterClick = null, // halaman rusak SESUDAH klik: bacaan ikut gagal
} = {}) {
  const actions = [];
  let text = "";
  let clicked = false;
  return {
    actions,
    text: () => text,
    isClosed: () => false,
    focus: async () => {
      actions.push(["focus"]);
    },
    type: async (_sel, t) => {
      actions.push(["type", t]);
      text = t;
    },
    keyboard: {
      down: async () => {},
      up: async () => {},
      press: async (k) => {
        actions.push(["press", k]);
        if (k === "Backspace") text = "";
      },
    },
    evaluate: async (_fn, arg) => {
      const wantsText = typeof arg === "string";
      actions.push(["read", wantsText ? "text" : "composer"]);
      if (clicked && readThrowsAfterClick) throw new Error(readThrowsAfterClick);
      if (wantsText) return text;
      return {
        foundTextarea: true,
        textareaVisible: true,
        textareaDisabled: false,
        foundPublishControl: true,
        publishVisible: true,
        publishDisabled: publishStuck === null ? text === "" : publishStuck,
        maxLength: 100,
        placeholder: "Type something...",
      };
    },
    evaluateHandle: async () => {
      actions.push(["resolve-publish"]);
      if (resolveThrows) throw new Error(resolveThrows);
      return {
        asElement: () => ({
          click: async () => {
            actions.push(["click"]);
            clicked = true;
            if (clickClears) text = "";
            if (hijackOnClick !== null) text = hijackOnClick;
            if (clickThrows) throw new Error(clickThrows);
          },
        }),
        dispose: async () => {},
      };
    },
  };
}

const countOf = (p, name) => p.actions.filter((a) => a[0] === name).length;
const pressed = (p) => p.actions.filter((a) => a[0] === "press").map((a) => a[1]);

function senderFor(page, over = {}) {
  const c = over.clock || clock();
  return createBrowserSender({
    getPage: async () => page,
    allowed: true,
    config: CONFIG,
    readIdentity: async () => [SHOP],
    checkIdentity,
    isStale: () => false,
    // Lihat catatan di test/autocomment.ar3.test.js: suite ini menguji
    // rekonsiliasi lewat halaman palsu yang mengklik dengan evaluateHandle.
    clickStrategy: "handle",
    logger: silent,
    now: c.now,
    sleep: c.sleep,
    ...over,
  });
}

const send = (p, over) => senderFor(p, over).send({ text: TEXT, scene: "PAX-1", playId: 1 });

// ===================== 1. jalur sukses =====================

test("SUKSES: klik mulus -> clicked, satu klik, komposer bersih, TANPA rekonsiliasi", async () => {
  const p = fakePage();
  const r = await send(p);

  assert.equal(r.ok, true);
  assert.equal(r.reason, "clicked");
  assert.equal(r.clicks, 1);
  assert.equal(r.composerCleared, true);
  assert.equal(r.sent, "unknown", "sukses UI bukan bukti sampai ke penonton");
  assert.equal(r.reconciled, undefined, "jalur mulus tidak perlu rekonsiliasi");

  assert.equal(countOf(p, "type"), 1);
  assert.equal(countOf(p, "click"), 1);
  assert.equal(p.text(), "");
});

// ===================== 2. timeout SEBELUM klik =====================

test("TIMEOUT SEBELUM KLIK: nol klik, disimpulkan not-sent, teks sendiri dibersihkan", async () => {
  // evaluateHandle gagal = tombolnya belum pernah ditemukan, jadi klik tidak
  // mungkin terjadi. Tapi kesimpulannya TETAP harus datang dari membaca
  // komposer, bukan dari asumsi.
  const p = fakePage({ resolveThrows: TIMEOUT_ERR });
  const r = await send(p);

  assert.equal(countOf(p, "click"), 0, "klik tidak pernah terjadi");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "not-sent");
  assert.equal(r.reconciled, OUTCOME.NOT_SENT);
  assert.equal(r.clicked, false);
  assert.equal(r.cleared, true);
  assert.ok(r.detail.includes("Runtime.callFunctionOn"), "penyebab aslinya tetap dilaporkan");
  assert.equal(p.text(), "", "tidak ada teks menggantung di komposer LIVE");
});

// ===================== 3. timeout SESUDAH klik, komposer bersih =====================

test("TIMEOUT SESUDAH KLIK tapi komposer BERSIH: dilaporkan terkirim, bukan gagal", async () => {
  // Inilah kasus yang dulu dilaporkan salah. Klik mendarat, komposer bersih,
  // tombol kirim kembali mati - lalu panggilan protokolnya baru kehabisan waktu.
  const p = fakePage({ clickClears: true, clickThrows: TIMEOUT_ERR });
  const r = await send(p);

  assert.equal(r.ok, true, "menyimpulkan gagal di sini berarti menyangkal pesan yang sudah terkirim");
  assert.equal(r.reason, "sent-reconciled");
  assert.equal(r.reconciled, OUTCOME.SENT);
  assert.equal(r.clicks, 1);
  assert.equal(r.sent, "likely", "jejak UI, bukan konfirmasi penonton");
  assert.equal(r.composerCleared, true);
  assert.ok(r.clickError.includes("timed out"));
});

test("TIMEOUT SESUDAH KLIK: rekonsiliasi MURNI MEMBACA - nol ketik, nol klik tambahan", async () => {
  const p = fakePage({ clickClears: true, clickThrows: TIMEOUT_ERR });
  await send(p);

  assert.equal(countOf(p, "click"), 1, "tidak pernah mengklik dua kali");
  assert.equal(countOf(p, "type"), 1, "tidak pernah mengetik ulang");
  const afterClick = p.actions.slice(p.actions.findIndex((a) => a[0] === "click") + 1);
  assert.deepEqual(
    afterClick.filter((a) => a[0] !== "read"),
    [],
    "sesudah klik hanya ada pembacaan: " + JSON.stringify(afterClick)
  );
});

// ===================== 4. pembersihan teks PERSIS milik bot =====================

test("CLEANUP TEKS PERSIS: hanya teks yang kita tulis yang dihapus, lewat seleksi+hapus", async () => {
  const p = fakePage({ clickClears: false, clickThrows: TIMEOUT_ERR });
  const r = await send(p);

  assert.equal(r.reason, "not-sent");
  assert.equal(r.cleared, true);
  assert.equal(p.text(), "");
  // Ctrl+A lalu Backspace: mengisi el.value langsung tidak dilihat React.
  const keys = pressed(p);
  assert.ok(keys.includes("KeyA") && keys.includes("Backspace"), "memakai seleksi+hapus: " + keys.join(","));
});

test("CLEANUP juga berjalan pada kegagalan SESUDAH mengetik selain klik", async () => {
  // Sebelum perbaikan ini, hanya jalur basi yang membersihkan - itu sebabnya
  // Phase 21 meninggalkan 33 karakter menggantung di kotak chat LIVE.
  const p = fakePage({ publishStuck: true }); // tombol kirim tetap mati walau ada teks
  const r = await send(p);

  assert.equal(r.reason, "publish-still-disabled");
  assert.equal(r.cleared, true, "teks kita tidak boleh ditinggal di komposer");
  assert.equal(p.text(), "");
  assert.equal(countOf(p, "click"), 0);
});

// ===================== 5. teks ORANG LAIN tidak pernah disentuh =====================

test("TEKS ORANG LAIN DIPERTAHANKAN: ambigu, dan komposer sama sekali tidak diubah", async () => {
  const FOREIGN = "halo kak mau tanya ongkir";
  const p = fakePage({ clickClears: false, clickThrows: TIMEOUT_ERR, hijackOnClick: FOREIGN });
  const r = await send(p);

  assert.equal(r.reason, "ambiguous");
  assert.equal(r.reconciled, OUTCOME.AMBIGUOUS);
  assert.equal(r.cleared, false, "pembersihan harus menolak: isinya bukan milik kita");
  assert.equal(p.text(), FOREIGN, "ketikan orang lain wajib utuh");

  const afterClick = p.actions.slice(p.actions.findIndex((a) => a[0] === "click") + 1);
  assert.deepEqual(
    afterClick.filter((a) => a[0] === "press" && a[1] === "Backspace"),
    [],
    "tidak ada penghapusan sesudah klik"
  );
});

test("TEKS ORANG LAIN: teks mirip-tapi-tidak-persis juga tidak dihapus", async () => {
  const NEARLY = TEXT + " ";
  const p = fakePage({ clickClears: false, clickThrows: TIMEOUT_ERR, hijackOnClick: NEARLY });
  const r = await send(p);

  assert.equal(r.reason, "ambiguous");
  assert.equal(r.cleared, false);
  assert.equal(p.text(), NEARLY, "pencocokannya persis, bukan kira-kira");
});

// ===================== 6. keadaan ambigu =====================

test("AMBIGU: komposer kosong tapi Publish masih enabled -> tidak menyimpulkan apa pun", async () => {
  const c = clock();
  const p = fakePage({ clickClears: true, clickThrows: TIMEOUT_ERR, publishStuck: false });
  const r = await send(p, { clock: c });

  assert.equal(r.ok, false);
  assert.equal(r.reason, "ambiguous");
  assert.equal(r.clicked, "unknown", "jujur: kita tidak tahu");
  assert.equal(r.reconciled, OUTCOME.AMBIGUOUS);
  assert.equal(r.cleared, false, "komposer kosong: tidak ada yang boleh/perlu disentuh");
});

test("AMBIGU: pembacaan yang melempar tidak menjadi kesimpulan", async () => {
  // Halaman rusak SESUDAH klik: rekonsiliasi tidak bisa membaca apa pun. Itu
  // bukan alasan menyimpulkan terkirim MAUPUN gagal.
  const c = clock();
  const p = fakePage({ clickThrows: TIMEOUT_ERR, readThrowsAfterClick: "Execution context was destroyed" });
  const r = await send(p, { clock: c });

  assert.equal(r.ok, false);
  assert.equal(r.reason, "ambiguous");
  assert.equal(r.clicked, "unknown");
  assert.ok(r.observed && r.observed.error, "error terakhir ikut dilaporkan");
  assert.equal(r.cleared, false, "tidak ada mutasi saat keadaannya tidak terbaca");
});

test("AMBIGU: jendela rekonsiliasi BERBATAS, tidak menunggu selamanya", async () => {
  const c = clock();
  const t = planTimeouts({ httpTimeoutMs: 8_000 });
  const p = fakePage({ clickClears: true, clickThrows: TIMEOUT_ERR, publishStuck: false });
  await send(p, { clock: c, timeouts: t });

  // Jam palsu hanya maju lewat sleep, jadi ini mengukur jendela yang sebenarnya.
  const elapsed = c.now() - 1_000_000;
  assert.ok(elapsed >= t.reconcileWindowMs, "jendelanya dipakai, elapsed=" + elapsed);
  assert.ok(elapsed <= t.reconcileWindowMs + t.reconcilePollMs, "dan tidak melewatinya, elapsed=" + elapsed);
});

// ===================== nol kirim ulang, apa pun hasilnya =====================

test("NOL KIRIM ULANG: ketiga hasil sama-sama menghabiskan jatah playId", async () => {
  const cases = [
    ["sukses", fakePage()],
    ["sent-reconciled", fakePage({ clickClears: true, clickThrows: TIMEOUT_ERR })],
    ["not-sent", fakePage({ clickClears: false, clickThrows: TIMEOUT_ERR })],
    ["ambiguous", fakePage({ clickClears: true, clickThrows: TIMEOUT_ERR, publishStuck: false })],
  ];
  for (const [label, p] of cases) {
    const s = senderFor(p);
    await s.send({ text: TEXT, scene: "PAX-1", playId: 7 });
    const again = await s.send({ text: TEXT, scene: "PAX-1", playId: 7 });
    assert.equal(again.reason, "duplicate-play-id", label);
    assert.ok(countOf(p, "click") <= 1, label + ": klik paling banyak sekali");
    assert.ok(countOf(p, "type") <= 1, label + ": ketik paling banyak sekali");
  }
});

// ===================== rekonsiliasi sebagai fungsi murni =====================

const composerAt = (text, { publishDisabled, foundPublishControl = true } = {}) => ({
  foundTextarea: true,
  textareaVisible: true,
  textareaDisabled: false,
  foundPublishControl,
  publishVisible: true,
  publishDisabled: publishDisabled === undefined ? text === "" : publishDisabled,
  maxLength: 100,
});

function reconcileWith(text, opts = {}) {
  const c = clock();
  return reconcileClickOutcome({}, TEXT, {
    readText: async () => text,
    inspect: async () => composerAt(text, opts),
    windowMs: 500,
    pollMs: 100,
    now: c.now,
    sleep: c.sleep,
  });
}

test("rekonsiliasi: tabel keputusan lengkap", async () => {
  // kosong + disabled -> terkirim
  assert.equal((await reconcileWith("")).outcome, OUTCOME.SENT);
  // teks kita + enabled -> belum terkirim
  assert.equal((await reconcileWith(TEXT)).outcome, OUTCOME.NOT_SENT);
  // kosong tapi masih enabled -> ambigu
  assert.equal((await reconcileWith("", { publishDisabled: false })).outcome, OUTCOME.AMBIGUOUS);
  // teks kita tapi tombol mati -> ambigu
  assert.equal((await reconcileWith(TEXT, { publishDisabled: true })).outcome, OUTCOME.AMBIGUOUS);
  // teks orang lain -> ambigu
  assert.equal((await reconcileWith("punya orang")).outcome, OUTCOME.AMBIGUOUS);
  // tombol hilang sama sekali -> ambigu
  assert.equal((await reconcileWith("", { foundPublishControl: false })).outcome, OUTCOME.AMBIGUOUS);
  // komposer hilang (null) -> ambigu
  assert.equal((await reconcileWith(null, { publishDisabled: false })).outcome, OUTCOME.AMBIGUOUS);
});

test("rekonsiliasi: keadaan yang berubah di tengah jendela tetap tertangkap", async () => {
  const c = clock();
  const states = [TEXT, TEXT, ""]; // komposer baru bersih pada bacaan ketiga
  let i = 0;
  const r = await reconcileClickOutcome({}, TEXT, {
    readText: async () => states[Math.min(i, states.length - 1)],
    inspect: async () => composerAt(states[Math.min(i++, states.length - 1)]),
    windowMs: 1_000,
    pollMs: 100,
    now: c.now,
    sleep: c.sleep,
  });
  // Bacaan pertama sudah cocok not-sent (teks kita + enabled), jadi berhenti di situ.
  assert.equal(r.outcome, OUTCOME.NOT_SENT);
  assert.equal(r.polls, 1, "berhenti pada kesimpulan pertama yang jelas");
});

test("rekonsiliasi: windowMs 0 tetap membaca sekali", async () => {
  const c = clock();
  const r = await reconcileClickOutcome({}, TEXT, {
    readText: async () => "punya orang",
    inspect: async () => composerAt("punya orang"),
    windowMs: 0,
    pollMs: 100,
    now: c.now,
    sleep: c.sleep,
  });
  assert.equal(r.outcome, OUTCOME.AMBIGUOUS);
  assert.equal(r.polls, 1);
});

// ===================== deadline operasi browser =====================

test("withDeadline: selesai sebelum batas -> nilainya lewat, timer dibersihkan", async () => {
  const cleared = [];
  const v = await withDeadline(Promise.resolve("ok"), 1_000, "x", {
    setTimeoutFn: () => 42,
    clearTimeoutFn: (t) => cleared.push(t),
  });
  assert.equal(v, "ok");
  assert.deepEqual(cleared, [42], "timer tidak boleh ditinggal hidup");
});

test("withDeadline: tidak pernah selesai -> ditolak dengan label yang jelas", async () => {
  await assert.rejects(
    withDeadline(new Promise(() => {}), 1_000, "click", {
      setTimeoutFn: (fn) => {
        fn();
        return 1;
      },
      clearTimeoutFn: () => {},
    }),
    (err) => {
      assert.equal(err.deadline, true);
      assert.equal(err.label, "click");
      assert.ok(err.message.includes("deadline-exceeded:click"));
      return true;
    }
  );
});

test("withDeadline: batas <= 0 berarti tanpa batas, bukan gagal seketika", async () => {
  assert.equal(await withDeadline(Promise.resolve("lewat"), 0, "x"), "lewat");
  assert.equal(await withDeadline(Promise.resolve("lewat"), -5, "x"), "lewat");
});

test("deadline operasi dipakai pengirim: operasi yang menggantung tidak dibiarkan", async () => {
  const p = fakePage();
  p.type = () => new Promise(() => {}); // menggantung selamanya
  const r = await senderFor(p, {
    timeouts: planTimeouts({ httpTimeoutMs: 8_000 }),
    setTimeoutFn: (fn) => {
      fn();
      return 1;
    },
    clearTimeoutFn: () => {},
  }).send({ text: TEXT, scene: "PAX-1", playId: 1 });

  assert.equal(r.reason, "type-failed");
  assert.ok(r.detail.includes("deadline-exceeded"), r.detail);
  assert.equal(countOf(p, "click"), 0);
});

// ===================== anggaran waktu =====================

test("anggaran: deadline browser SELALU lebih pendek dari timeout HTTP, dengan margin jelas", () => {
  for (const http of [3_000, 5_000, 8_000, 12_000, 20_000, 60_000]) {
    const t = planTimeouts({ httpTimeoutMs: http });
    assert.equal(t.fits, true, "http=" + http);
    assert.ok(t.browserDeadlineMs > 0, "http=" + http);
    // Invarian yang menjadi alasan modul timeouts.js ada.
    assert.ok(
      t.browserDeadlineMs + t.reconcileWindowMs + t.marginMs <= t.httpTimeoutMs,
      "http=" + http + " -> " + describeTimeouts(t)
    );
    // Margin benar-benar ada, bukan nol.
    assert.ok(t.httpTimeoutMs - t.browserDeadlineMs >= t.marginMs, "http=" + http);
    assert.ok(t.marginMs >= MIN_MARGIN_MS, "http=" + http);
    // Rekonsiliasi kebagian waktu SEBELUM bot menyerah - kalau tidak,
    // hasil bacaannya tidak pernah terkirim.
    assert.ok(t.reconcileWindowMs > 0, "http=" + http);
    assert.ok(t.reconcilePollMs > 0 && t.reconcilePollMs <= t.reconcileWindowMs, "http=" + http);
  }
});

test("anggaran: timeout HTTP yang terlalu kecil dilaporkan fits=false, tidak dibiarkan diam", () => {
  const t = planTimeouts({ httpTimeoutMs: 1_000 });
  assert.equal(t.fits, false, "operator harus diperingatkan, bukan dibiarkan menebak");
});

test("anggaran: nilai rusak jatuh ke default yang masuk akal", () => {
  for (const bad of [undefined, null, 0, -1, "abc", NaN]) {
    const t = planTimeouts({ httpTimeoutMs: bad });
    assert.equal(t.httpTimeoutMs, 8_000, "http=" + String(bad));
    assert.equal(t.fits, true);
  }
});

test("anggaran: protocolTimeout jauh di bawah bawaan Puppeteer 180s", () => {
  // Bawaan 180 detik itulah yang membuat satu panggilan CDP menggantung
  // berpuluh kali lebih lama dari timeout bot pada Phase 21.
  assert.ok(PROTOCOL_TIMEOUT_MS < 180_000);
  assert.equal(PROTOCOL_TIMEOUT_MS, 30_000);
  // Tetap longgar: pemuatan halaman konsol sendiri pernah butuh 12 detik.
  assert.ok(PROTOCOL_TIMEOUT_MS > 15_000);
});

test("anggaran: dipakai Chrome sungguhan lewat opsi launch", () => {
  const src = require("node:fs").readFileSync(require.resolve("../autopin/browser.js"), "utf8");
  assert.ok(src.includes("protocolTimeout: PROTOCOL_TIMEOUT_MS"), "launch harus menyetelnya eksplisit");
});

// ===================== laporan transport di /health =====================

const svcFor = (allowAutoCommentSend) =>
  createService({
    config: { consoleUrl: "https://shop.tiktok.com/streamer/live/product/dashboard", expectedShop: SHOP, forbiddenShops: ["garudafood"] },
    allowAutoCommentSend,
    deps: {},
  });

test("health: transport DITURUNKAN dari otorisasi, tidak lagi hardcoded 'dry-run'", () => {
  // Sebelum ini field-nya selalu berbunyi "dry-run" walau service dijalankan
  // dengan --enable-autocomment-send - jenis laporan menyesatkan yang sama
  // dengan [AUTOCOMMENT_CONFIG] di bot pada bot-p21.log:2.
  assert.equal(svcFor(true).healthPayload().commentTransport, "browser");
  assert.equal(svcFor(false).healthPayload().commentTransport, "dry-run");
});

test("health: transport dan otorisasi tidak pernah saling bertentangan", () => {
  for (const armed of [true, false]) {
    const h = svcFor(armed).healthPayload();
    const armedByTransport = h.commentTransport === "browser";
    const armedByFlag = h.autoCommentSend === "enabled";
    assert.equal(armedByTransport, armedByFlag, "armed=" + armed + " -> " + JSON.stringify(h));
  }
});

test("health: hanya boolean true persis yang dilaporkan sebagai browser", () => {
  for (const bad of ["true", 1, {}, [], "browser"]) {
    const h = createService({
      config: { consoleUrl: "https://x/y", expectedShop: SHOP, forbiddenShops: ["garudafood"] },
      allowAutoCommentSend: bad,
      deps: {},
    }).healthPayload();
    assert.equal(h.commentTransport, "dry-run", "allowAutoCommentSend=" + JSON.stringify(bad));
    assert.equal(h.autoCommentSend, "disabled");
  }
});

test("health: anggaran waktu ikut dilaporkan supaya bisa dibaca, bukan ditebak", () => {
  const h = svcFor(true).healthPayload();
  assert.ok(h.timeouts, "anggaran harus terlihat di /health");
  assert.equal(h.timeouts.fits, true);
  assert.ok(h.timeouts.browserDeadlineMs < h.timeouts.httpTimeoutMs);
});
