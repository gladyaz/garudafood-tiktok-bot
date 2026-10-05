// AR3 — semantik "sudah ter-pin", klien transport, dan pengirim browser.
// Semua memakai halaman/fetch palsu. Tidak ada TikTok, browser, OBS, jaringan.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { isPinConfirmed, inspectPinResult } = require("../autopin/pin-result");
const { createCommentSender, commentUrl, MODES } = require("../autocomment/client");
const { createBrowserSender } = require("../autocomment/browser-sender");
const { createAutoComment, PIN_POLICY } = require("../autocomment/core");
const { loadConfig, TRANSPORTS } = require("../autocomment/config");
const { checkIdentity } = require("../autopin/core");
const { createService } = require("../autopin/service");
const { CHAT_TEXTAREA } = require("../autocomment/browser-transport");

const TEXT = "Etalase 1 sudah aku pin ya kak 🛒";
const SHOP = "agen_mulia_abadi";
const CONFIG = { expectedShop: SHOP, forbiddenShops: ["garudafood"] };
const silent = { log: () => {} };

const PIN_REAL = { ok: true, reason: "pinned", clicked: true, state: "Unpin", title: "Produk Uji" };
const PIN_DRY = { ok: true, reason: "dry-run", clicked: false, dryRun: true, title: "Produk Uji" };

// ================= Phase 2: semantik pin terkonfirmasi =================

test("pin terkonfirmasi: HANYA klik sungguhan yang terbukti berubah jadi Unpin", () => {
  assert.equal(isPinConfirmed(PIN_REAL), true);
  assert.equal(inspectPinResult(PIN_REAL).reason, "pin-confirmed");
  assert.equal(inspectPinResult(PIN_REAL).title, "Produk Uji");
});

test("pin TIDAK terkonfirmasi untuk setiap keadaan selain itu", () => {
  const cases = [
    [PIN_DRY, "pin-dry-run"],
    [{ ok: true, reason: "pinned", clicked: false, state: "Unpin" }, "pin-dry-run"],
    [{ ok: true, reason: "pinned", clicked: true, state: "Pin" }, "pin-state-not-pinned"],
    [{ ok: true, reason: "pinned", clicked: true, state: "" }, "pin-state-unreadable"],
    [{ ok: true, reason: "pinned", clicked: true }, "pin-state-unreadable"],
    [{ ok: true, reason: "no-json-body" }, "pin-unexpected-no-json-body"],
    [{ ok: false, reason: "timeout" }, "timeout"],
    [{ ok: false, reason: "stale" }, "stale"],
    [{ ok: false, reason: "identity-identity-mismatch" }, "identity-identity-mismatch"],
    [{ ok: false, reason: "live-pin-control-not-available" }, "live-pin-control-not-available"],
    [{ ok: false, reason: "send-rejected" }, "send-rejected"],
    [null, "no-result"],
    [undefined, "no-result"],
    ["pinned", "no-result"],
    [{}, "pin-failed"],
  ];
  for (const [result, reason] of cases) {
    assert.equal(isPinConfirmed(result), false, JSON.stringify(result));
    assert.equal(inspectPinResult(result).reason, reason, JSON.stringify(result));
  }
});

test("pin terkonfirmasi: teks tombol toleran spasi, tapi tidak toleran kata lain", () => {
  assert.equal(isPinConfirmed({ ...PIN_REAL, state: "  Unpin  " }), true);
  assert.equal(isPinConfirmed({ ...PIN_REAL, state: "UNPIN" }), true);
  assert.equal(isPinConfirmed({ ...PIN_REAL, state: "Unpin product" }), false);
  assert.equal(isPinConfirmed({ ...PIN_REAL, state: "Pinned" }), false);
});

// ================= Phase 8: konfigurasi transport =================

test("config: transport default dry-run; browser hanya kalau ditulis persis", () => {
  assert.equal(loadConfig({}).transport, TRANSPORTS.DRY_RUN);
  assert.equal(loadConfig({ AUTOCOMMENT_TRANSPORT: "browser" }).transport, TRANSPORTS.BROWSER);
  assert.equal(loadConfig({ AUTOCOMMENT_TRANSPORT: " BROWSER " }).transport, TRANSPORTS.BROWSER);
  assert.equal(loadConfig({ AUTOCOMMENT_TRANSPORT: "dry-run" }).transport, TRANSPORTS.DRY_RUN);
});

test("config: nilai transport tak dikenal jatuh ke dry-run DAN diperingatkan", () => {
  const warned = [];
  for (const bad of ["real", "send", "true", "chrome", "browser!", "1"]) {
    assert.equal(loadConfig({ AUTOCOMMENT_TRANSPORT: bad }, { warn: (m) => warned.push(m) }).transport, TRANSPORTS.DRY_RUN, bad);
  }
  assert.equal(warned.length, 6);
  assert.ok(warned.every((m) => /AUTOCOMMENT_TRANSPORT/.test(m) && /dry-run/.test(m)));
});

// ================= Phase 3: klien HTTP =================

function fakeFetch(record, response = { ok: true, dryRun: true }) {
  return async (url, init) => {
    record.push({ url, body: JSON.parse(init.body) });
    return { ok: true, json: async () => response };
  };
}

test("klien: mode dry-run memanggil /comment/dry-run, mode browser memanggil /comment/send", async () => {
  for (const [mode, path] of [[MODES.DRY_RUN, "/comment/dry-run"], [MODES.BROWSER, "/comment/send"]]) {
    const rec = [];
    const send = createCommentSender({ mode, fetchFn: fakeFetch(rec), env: {} });
    await send({ text: TEXT, scene: "PAX-1", playId: 3, pin: PIN_REAL });
    assert.ok(rec[0].url.endsWith(path), mode + " -> " + rec[0].url);
    assert.equal(rec[0].url.startsWith("http://127.0.0.1:"), true, "loopback saja");
    assert.deepEqual(rec[0].body, { text: TEXT, scene: "PAX-1", playId: 3, pin: PIN_REAL });
  }
});

test("klien: mode tak dikenal menolak tanpa memanggil jaringan sama sekali", async () => {
  for (const bad of ["real", "", "browser ", null, "dry run", "BROWSER!"]) {
    const rec = [];
    const send = createCommentSender({ mode: bad, fetchFn: fakeFetch(rec), env: {} });
    const r = await send({ text: TEXT, scene: "PAX-1", playId: 1 });
    assert.equal(r.ok, false, String(bad));
    assert.match(r.reason, /^unknown-transport-/, String(bad));
    assert.deepEqual(rec, [], String(bad));
  }
  assert.equal(commentUrl("nonsense", {}), null);

  // Mode tidak disebut sama sekali -> jatuh ke default yang AMAN (dry-run),
  // bukan ditolak dan bukan diam-diam jadi browser.
  const rec = [];
  const fallback = createCommentSender({ fetchFn: fakeFetch(rec), env: {} });
  await fallback({ text: TEXT, scene: "PAX-1", playId: 1 });
  assert.ok(rec[0].url.endsWith("/comment/dry-run"), "default harus dry-run");
});

test("klien: HTTP error dan body non-JSON dilaporkan, bukan dianggap sukses", async () => {
  const err = createCommentSender({ mode: MODES.DRY_RUN, env: {}, fetchFn: async () => ({ ok: false, status: 503 }) });
  assert.deepEqual(await err({ text: TEXT, scene: "PAX-1", playId: 1 }), { ok: false, reason: "http-503" });

  const bad = createCommentSender({ mode: MODES.DRY_RUN, env: {}, fetchFn: async () => ({ ok: true, json: async () => { throw new Error("bukan json"); } }) });
  assert.deepEqual(await bad({ text: TEXT, scene: "PAX-1", playId: 1 }), { ok: false, reason: "no-json-body" });
});

test("klien: tanpa retry - satu permintaan, satu panggilan fetch", async () => {
  let calls = 0;
  const send = createCommentSender({ mode: MODES.BROWSER, env: {}, fetchFn: async () => { calls++; return { ok: false, status: 500 }; } });
  await send({ text: TEXT, scene: "PAX-1", playId: 1 });
  assert.equal(calls, 1);
});

// ================= Phase 2 + 11: gerbang bukti pin di dispatcher =================

function commentWith({ pinPolicy, send, logs = [] }) {
  return createAutoComment({
    enabled: true, pinPolicy, inspectPin: inspectPinResult, send,
    minIntervalMs: 0, logger: { log: (l) => logs.push(l) }, now: () => 1_000_000,
  });
}

test("kebijakan confirmed: pin dry-run TIDAK PERNAH membuka komentar sungguhan", async () => {
  const sent = [];
  const logs = [];
  const ac = commentWith({ pinPolicy: PIN_POLICY.CONFIRMED, send: async (r) => { sent.push(r); return { ok: true }; }, logs });
  const r = await ac.requestComment({ scene: "PAX-1", playId: 1, pin: PIN_DRY });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "pin-dry-run");
  assert.deepEqual(sent, [], "tidak boleh ada kiriman");
  assert.ok(logs.some((l) => /AUTOCOMMENT_SKIPPED/.test(l) && /pin-dry-run/.test(l)));
});

test("kebijakan confirmed: hanya pin terbukti yang lolos", async () => {
  const sent = [];
  const ac = commentWith({ pinPolicy: PIN_POLICY.CONFIRMED, send: async (r) => { sent.push(r); return { ok: true }; } });
  assert.equal((await ac.requestComment({ scene: "PAX-1", playId: 1, pin: PIN_REAL })).ok, true);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].pin, PIN_REAL, "bukti pin ikut dikirim ke transport");
});

test("kebijakan confirmed: pin gagal / ambigu / hilang -> tidak ada klaim 'sudah aku pin'", async () => {
  for (const pin of [
    { ok: false, reason: "timeout" },
    { ok: false, reason: "stale" },
    { ok: true, reason: "pinned", clicked: true, state: "Pin" },
    undefined,
    null,
  ]) {
    const sent = [];
    const ac = commentWith({ pinPolicy: PIN_POLICY.CONFIRMED, send: async (r) => { sent.push(r); return { ok: true }; } });
    const r = await ac.requestComment({ scene: "PAX-1", playId: 1, pin });
    assert.equal(r.ok, false, JSON.stringify(pin));
    assert.deepEqual(sent, [], JSON.stringify(pin));
  }
});

test("kebijakan ok (dry-run): pin ok cukup, pin gagal tetap ditolak", async () => {
  const sentDry = [];
  const dry = commentWith({ pinPolicy: PIN_POLICY.OK, send: async (r) => { sentDry.push(r); return { ok: true, dryRun: true }; } });
  assert.equal((await dry.requestComment({ scene: "PAX-1", playId: 1, pin: PIN_DRY })).ok, true, "gladi bersih boleh jalan");
  assert.equal(sentDry.length, 1);

  const sentFail = [];
  const fail = commentWith({ pinPolicy: PIN_POLICY.OK, send: async (r) => { sentFail.push(r); return { ok: true }; } });
  const r = await fail.requestComment({ scene: "PAX-1", playId: 2, pin: { ok: false, reason: "no-products-found" } });
  assert.equal(r.reason, "pin-no-products-found");
  assert.deepEqual(sentFail, []);
});

test("gerbang pin tidak membakar jatah rate limit saat menolak", async () => {
  const sent = [];
  const ac = commentWith({ pinPolicy: PIN_POLICY.CONFIRMED, send: async (r) => { sent.push(r); return { ok: true }; } });
  for (let i = 1; i <= 20; i++) await ac.requestComment({ scene: "PAX-1", playId: i, pin: PIN_DRY });
  assert.equal(ac.__state().sentInWindow, 0, "penolakan pin tidak menghabiskan kuota");
  const ok = await ac.requestComment({ scene: "PAX-1", playId: 99, pin: PIN_REAL });
  assert.equal(ok.ok, true);
  assert.equal(sent.length, 1);
});

// ================= Phase 4: pengirim browser =================

function chatPage({ typeWrites = null, startText = "", closed = false, composerEmpty, composerFilled, clickThrows = null, publishElement = {}, typeThrows = null } = {}) {
  const EMPTY = composerEmpty || {
    foundTextarea: true, foundPublishControl: true, textareaVisible: true, textareaDisabled: false,
    publishVisible: true, publishDisabled: true, maxLength: 100, placeholder: "Type something...",
    publishIconClass: "arco-icon arco-icon-publish", publishState: "disabled",
  };
  const FILLED = composerFilled || { ...EMPTY, publishDisabled: false, publishIconClass: "arco-icon arco-icon-publish_management_fill", publishState: "enabled" };
  const actions = [];
  let value = startText;
  let typed = false;
  return {
    actions,
    currentValue: () => value,
    isClosed: () => closed,
    focus: async (s) => { actions.push(["focus", s]); },
    type: async (s, t) => {
      actions.push(["type", s, t]);
      if (typeThrows) throw new Error(typeThrows);
      value = typeWrites === null ? value + t : typeWrites;
      typed = true;
    },
    keyboard: {
      down: async (k) => { actions.push(["keyboard.down", k]); },
      up: async (k) => { actions.push(["keyboard.up", k]); },
      press: async (k) => { actions.push(["keyboard.press", k]); if (k === "Backspace") value = ""; },
    },
    evaluate: async (fn, arg) => {
      const isText = typeof arg === "string" || (arg && arg.textarea === undefined);
      actions.push(["evaluate", isText ? "text" : "composer"]);
      if (isText) return value;
      return typed ? FILLED : EMPTY;
    },
    evaluateHandle: async () => {
      actions.push(["evaluateHandle"]);
      return {
        asElement: () => (publishElement ? { click: async () => { actions.push(["click"]); if (clickThrows) throw new Error(clickThrows); } } : null),
        dispose: async () => {},
      };
    },
  };
}
const countOf = (p, n) => p.actions.filter((a) => a[0] === n).length;
const pressedKeys = (p) => p.actions.filter((a) => a[0] === "keyboard.press").map((a) => a[1]);

function senderFor(page, over = {}) {
  return createBrowserSender({
    getPage: async () => page, allowed: true, config: CONFIG,
    readIdentity: async () => [SHOP], checkIdentity, isStale: () => false,
    logger: silent, ...over,
  });
}

test("pengirim: mati kecuali diotorisasi flag startup; .env tidak pernah cukup", async () => {
  const page = chatPage({ typeWrites: TEXT });
  for (const bad of [false, undefined, "true", 1, {}]) {
    const s = senderFor(page, { allowed: bad });
    assert.equal((await s.send({ text: TEXT, scene: "PAX-1", playId: 1 })).reason, "real-comment-send-disabled", String(bad));
  }
  assert.deepEqual(page.actions, [], "halaman tidak boleh disentuh");
});

test("pengirim: satu ketik + satu klik, tanpa Enter, tanpa retry", async () => {
  const page = chatPage({ typeWrites: TEXT });
  const r = await senderFor(page).send({ text: TEXT, scene: "PAX-1", playId: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.clicks, 1);
  assert.equal(r.sent, "unknown", "tidak pernah mengklaim sampai ke penonton");
  assert.equal(countOf(page, "type"), 1);
  assert.equal(countOf(page, "click"), 1);
  assert.deepEqual(pressedKeys(page), ["KeyA", "Backspace"], "tidak ada Enter");
});

test("pengirim: playId yang sama tidak pernah mengirim dua kali", async () => {
  const page = chatPage({ typeWrites: TEXT });
  const s = senderFor(page);
  assert.equal((await s.send({ text: TEXT, scene: "PAX-1", playId: 7 })).ok, true);
  for (let i = 0; i < 3; i++) {
    assert.equal((await s.send({ text: TEXT, scene: "PAX-1", playId: 7 })).reason, "duplicate-play-id");
  }
  assert.equal(countOf(page, "click"), 1);
});

test("pengirim: playId berbeda boleh - ini yang membedakannya dari alat AR2B", async () => {
  const page = chatPage({ typeWrites: TEXT });
  const s = senderFor(page);
  assert.equal((await s.send({ text: TEXT, scene: "PAX-1", playId: 1 })).ok, true);
  assert.equal((await s.send({ text: TEXT, scene: "PAX-2", playId: 2 })).ok, true);
  assert.equal(countOf(page, "click"), 2);
  assert.equal(s.__state().attempts, 2);
});

test("pengirim: hasil gagal/ambigu tetap memakai jatah playId-nya", async () => {
  const page = chatPage({ typeWrites: "teks lain" });
  const s = senderFor(page);
  assert.equal((await s.send({ text: TEXT, scene: "PAX-1", playId: 3 })).reason, "typed-text-mismatch");
  assert.equal((await s.send({ text: TEXT, scene: "PAX-1", playId: 3 })).reason, "duplicate-play-id");
  assert.equal(countOf(page, "click"), 0);
});

test("pengirim: basi SEBELUM mengetik -> tidak menyentuh halaman sama sekali", async () => {
  const page = chatPage({ typeWrites: TEXT });
  const s = senderFor(page, { isStale: () => true });
  assert.equal((await s.send({ text: TEXT, scene: "PAX-1", playId: 2 })).reason, "stale");
  assert.deepEqual(page.actions, []);
});

test("pengirim: basi SESUDAH mengetik, SEBELUM klik -> tidak mengklik dan teks sendiri dibersihkan", async () => {
  const page = chatPage({ typeWrites: TEXT });
  let staleNow = false;
  const s = senderFor(page, { isStale: () => staleNow });
  const origType = page.type;
  page.type = async (sel, t) => { const out = await origType(sel, t); staleNow = true; return out; };

  const r = await s.send({ text: TEXT, scene: "PAX-1", playId: 4 });
  assert.equal(r.reason, "stale");
  assert.equal(r.clicked, false);
  assert.equal(r.cleared, true, "teks yang kita tulis dibersihkan");
  assert.equal(countOf(page, "click"), 0, "pesan scene lama tidak boleh muncul");
  assert.equal(page.currentValue(), "");
});

test("pengirim: pembersihan tidak pernah menghapus ketikan orang lain", async () => {
  const page = chatPage({ typeWrites: TEXT });
  let staleNow = false;
  const s = senderFor(page, { isStale: () => staleNow });
  const origType = page.type;
  const origEval = page.evaluate;
  let textReads = 0;
  page.type = async (sel, t) => {
    await origType(sel, t);
    staleNow = true;
    // Verifikasi (bacaan teks pertama) tetap melihat teks kita; saat hendak
    // dibersihkan, isinya sudah berubah jadi ketikan orang lain.
    page.evaluate = async (fn, arg) => {
      const isText = typeof arg === "string" || (arg && arg.textarea === undefined);
      if (!isText) return origEval(fn, arg);
      textReads += 1;
      return textReads === 1 ? TEXT : "operator mengetik ini";
    };
  };
  const r = await s.send({ text: TEXT, scene: "PAX-1", playId: 9 });
  assert.equal(r.reason, "stale");
  assert.equal(r.cleared, false, "isi komposer bukan milik kita -> jangan disentuh");
  assert.equal(countOf(page, "click"), 0);
});

test("pengirim: identitas produksi dan identitas salah selalu ditolak sebelum mengetik", async () => {
  for (const observed of [["garudafood_officialstore"], [SHOP, "garudafood_officialstore"], ["toko_lain"], []]) {
    const page = chatPage({ typeWrites: TEXT });
    const s = senderFor(page, { readIdentity: async () => observed });
    const r = await s.send({ text: TEXT, scene: "PAX-1", playId: 1 });
    assert.match(r.reason, /^identity-/, JSON.stringify(observed));
    assert.equal(countOf(page, "type"), 0, JSON.stringify(observed));
  }
});

test("pengirim: panjang UTF-16 100 diterima, 101 ditolak, emoji dihitung dua", async () => {
  const at = "x".repeat(100);
  assert.equal((await senderFor(chatPage({ typeWrites: at })).send({ text: at, scene: "PAX-1", playId: 1 })).ok, true);
  const over = "x".repeat(101);
  const page = chatPage({ typeWrites: over });
  assert.equal((await senderFor(page).send({ text: over, scene: "PAX-1", playId: 2 })).reason, "message-too-long");
  assert.equal(countOf(page, "type"), 0);
  const emoji = "🛒".repeat(51);
  assert.equal((await senderFor(chatPage()).send({ text: emoji, scene: "PAX-1", playId: 3 })).reason, "message-too-long");
});

test("pengirim: publish disabled / hilang / teks tak cocok -> tidak pernah mengklik", async () => {
  const cases = [
    [{ typeWrites: TEXT, composerFilled: { foundTextarea: true, foundPublishControl: true, textareaVisible: true, textareaDisabled: false, publishVisible: true, publishDisabled: true, maxLength: 100 } }, "publish-still-disabled"],
    [{ typeWrites: TEXT, composerFilled: { foundTextarea: true, foundPublishControl: false, textareaVisible: true, textareaDisabled: false, publishVisible: false, publishDisabled: false, maxLength: 100 } }, "publish-control-not-found"],
    [{ typeWrites: TEXT + "!" }, "typed-text-mismatch"],
  ];
  for (const [opts, reason] of cases) {
    const page = chatPage(opts);
    assert.equal((await senderFor(page).send({ text: TEXT, scene: "PAX-1", playId: 1 })).reason, reason);
    assert.equal(countOf(page, "click"), 0, reason);
  }
});

test("pengirim: halaman tertutup, ketik melempar, klik melempar -> gagal rapi tanpa retry", async () => {
  assert.equal((await senderFor(chatPage({ closed: true })).send({ text: TEXT, scene: "PAX-1", playId: 1 })).reason, "chat-page-unavailable");

  const t = chatPage({ typeThrows: "detached Frame" });
  assert.equal((await senderFor(t).send({ text: TEXT, scene: "PAX-1", playId: 2 })).reason, "type-failed");
  assert.equal(countOf(t, "type"), 1);

  // Klik yang melempar TIDAK lagi langsung disimpulkan gagal: keadaan komposer
  // dibaca dulu secara read-only. Di halaman palsu ini teks kita masih utuh dan
  // Publish masih enabled, jadi kesimpulan yang sah adalah not-sent - dan teks
  // kita sendiri dibersihkan. Rinciannya di test/autocomment.reconcile.test.js.
  const c = chatPage({ typeWrites: TEXT, clickThrows: "Node is detached" });
  const s = senderFor(c);
  const r3 = await s.send({ text: TEXT, scene: "PAX-1", playId: 3 });
  assert.equal(r3.reason, "not-sent");
  assert.equal(r3.reconciled, "not-sent");
  assert.equal(r3.clicked, false);
  assert.equal(countOf(c, "click"), 1, "tidak mencoba klik lagi");
  assert.equal((await s.send({ text: TEXT, scene: "PAX-1", playId: 3 })).reason, "duplicate-play-id");
});

// ================= Phase 5 + 7: otorisasi service dan generasi bersama =================

function serviceAR3({ allowAutoCommentSend = false, chat = chatPage({ typeWrites: TEXT }) } = {}) {
  const CONSOLE = "https://shop.tiktok.com/streamer/live/product/dashboard";
  return {
    chat,
    svc: createService({
      config: { consoleUrl: CONSOLE, expectedShop: SHOP, forbiddenShops: ["garudafood"] },
      allowAutoCommentSend,
      deps: {
        launchBrowser: async () => ({ id: "fake" }),
        getPage: async () => ({ url: () => CONSOLE, isClosed: () => false, bringToFront: async () => {} }),
        newPage: async () => chat,
        // Penunggu komposer disuntik cepat: tes tidak boleh benar-benar menunggu.
        waitForComposerReady: async () => ({ ready: true, ms: 0, polls: 1 }),
        openConsole: async () => ({ url: CONSOLE, settled: true, readyMs: 1 }),
        closeBrowser: async () => {},
        readIdentity: async () => [SHOP],
        collectProducts: async () => ({ products: [{ number: 1, title: "Produk Uji Satu", pinButtons: 1, pinVisible: true, pinDisabled: false }], livePinButtonsOnPage: 1 }),
        pinProductByTitle: async (_p, key) => ({ ok: true, title: key }),
        readPinState: async () => ({ text: "Unpin" }),
      },
    }),
  };
}

test("service: /comment/send mati tanpa --enable-autocomment-send", async () => {
  const { svc, chat } = serviceAR3();
  const r = await svc.handleCommentSend({ text: TEXT, scene: "PAX-1", playId: 1 });
  assert.equal(r.reason, "real-comment-send-disabled");
  assert.deepEqual(chat.actions, []);
});

test("service: dengan flag, /comment/send mengetik dan mengklik sekali", async () => {
  const { svc, chat } = serviceAR3({ allowAutoCommentSend: true });
  const r = await svc.handleCommentSend({ text: TEXT, scene: "PAX-1", playId: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.clicks, 1);
  assert.equal(countOf(chat, "click"), 1);
});

test("service: generasi scene DIPAKAI BERSAMA - pin scene baru membuat komentar scene lama basi", async () => {
  const { svc, chat } = serviceAR3({ allowAutoCommentSend: true });
  // scene baru (playId 11) memulai pekerjaan pin -> generasi naik
  await svc.handlePin({ scene: "PAX-5", productKey: "uji satu", playId: 11 });
  // komentar milik scene lama (playId 10) datang terlambat
  const r = await svc.handleCommentSend({ text: TEXT, scene: "PAX-3", playId: 10 });
  assert.equal(r.reason, "stale");
  assert.equal(countOf(chat, "type"), 0, "tidak boleh mengetik untuk scene yang sudah lewat");
  assert.equal(countOf(chat, "click"), 0);
});

test("service: komentar scene baru membuat pin scene lama basi juga (arah sebaliknya)", async () => {
  const { svc } = serviceAR3({ allowAutoCommentSend: true });
  await svc.handleCommentSend({ text: TEXT, scene: "PAX-5", playId: 20 });
  const pin = await svc.handlePin({ scene: "PAX-3", productKey: "uji satu", playId: 19 });
  assert.equal(pin.reason, "stale");
});

test("service: dry-run tetap bebas mutasi walau pengirim AR3 bersenjata", async () => {
  const { svc, chat } = serviceAR3({ allowAutoCommentSend: true });
  const r = await svc.handleCommentDryRun({ text: TEXT, scene: "PAX-1", playId: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.deepEqual(chat.actions.filter((a) => ["type", "click", "focus", "keyboard.press"].includes(a[0])), []);
});

test("service: alat diagnostik AR2B tetap terpisah dan tetap mati tanpa flag-nya sendiri", async () => {
  const { svc } = serviceAR3({ allowAutoCommentSend: true });
  assert.equal(svc.sendOnceStatus(), "disabled", "--enable-autocomment-send TIDAK menyalakan jalur AR2B");
  assert.equal((await svc.handleCommentSendOnce({ text: TEXT, confirm: true })).reason, "real-comment-send-disabled");
});

test("service: health melaporkan status AR3 tanpa membocorkan apa pun yang sensitif", async () => {
  const { svc } = serviceAR3({ allowAutoCommentSend: true });
  await svc.handleCommentSend({ text: TEXT, scene: "PAX-1", playId: 1 });
  const s = svc.__state();
  assert.equal(typeof s.latestPlayId, "number");
  assert.ok(!JSON.stringify(s).match(/cookie|token|session/i));
});
