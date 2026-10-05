// AR2B — jalur kirim sekali pakai, diuji HANYA dengan halaman palsu.
//
// Setiap page palsu mencatat seluruh interaksi (focus / keyboard / type / click)
// supaya tes bisa menegaskan: berapa kali diketik, berapa kali diklik, dan bahwa
// Enter tidak pernah ditekan. Tidak ada TikTok, browser, OBS, maupun jaringan.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createSendOnce, resolvePublishElementInPage, readComposerTextInPage } = require("../autocomment/send-once");
const { CHAT_TEXTAREA, PUBLISH_ICON, COMPOSER_SCOPE_DEPTH } = require("../autocomment/browser-transport");
const { checkIdentity } = require("../autopin/core");
const { createService } = require("../autopin/service");

const TEXT = "Tes admin AI Live ya kak 🙌";
const SHOP = "agen_mulia_abadi";
const CONFIG = { expectedShop: SHOP, forbiddenShops: ["garudafood"] };
const silent = { log: () => {} };

const COMPOSER_EMPTY = {
  foundTextarea: true, foundPublishControl: true,
  textareaVisible: true, textareaDisabled: false,
  publishVisible: true, publishDisabled: true, // kosong -> cursor-not-allowed
  maxLength: 100, placeholder: "Type something...",
};
const COMPOSER_FILLED = { ...COMPOSER_EMPTY, publishDisabled: false };

// Halaman palsu yang mensimulasikan komposer: mencatat semua aksi, dan isi
// textarea-nya benar-benar berubah ketika type() dipanggil.
function fakeChatPage({
  composerEmpty = COMPOSER_EMPTY,
  composerFilled = COMPOSER_FILLED,
  startText = "",
  typeThrows = null,
  clickThrows = null,
  publishElement = { tag: "span" },
  closed = false,
  typeWrites = null, // kalau diisi, nilai inilah yang "masuk" ke textarea
} = {}) {
  const actions = [];
  let value = startText;
  let typed = false;
  const page = {
    actions,
    isClosed: () => closed,
    currentValue: () => value,
    focus: async (sel) => { actions.push(["focus", sel]); },
    type: async (sel, text) => {
      actions.push(["type", sel, text]);
      if (typeThrows) throw new Error(typeThrows);
      value = typeWrites === null ? value + text : typeWrites;
      typed = true;
    },
    keyboard: {
      down: async (k) => { actions.push(["keyboard.down", k]); },
      up: async (k) => { actions.push(["keyboard.up", k]); },
      press: async (k) => {
        actions.push(["keyboard.press", k]);
        if (k === "Backspace") value = "";
      },
    },
    evaluate: async (fn, arg) => {
      actions.push(["evaluate", typeof arg === "object" && arg ? "composer" : String(arg)]);
      if (fn === readComposerTextInPage) return value;
      return typed ? composerFilled : composerEmpty;
    },
    evaluateHandle: async () => {
      actions.push(["evaluateHandle", "publish"]);
      return {
        asElement: () => (publishElement ? { click: async () => { actions.push(["click"]); if (clickThrows) throw new Error(clickThrows); } } : null),
        dispose: async () => { actions.push(["dispose"]); },
      };
    },
  };
  return page;
}

const countOf = (page, name) => page.actions.filter((a) => a[0] === name).length;
const pressed = (page) => page.actions.filter((a) => a[0] === "keyboard.press").map((a) => a[1]);

function makeSendOnce(page, over = {}) {
  return createSendOnce({
    getPage: async () => page,
    allowed: true,
    config: CONFIG,
    readIdentity: async () => [SHOP],
    checkIdentity,
    logger: silent,
    ...over,
  });
}

// ---------- gerbang otorisasi ----------

test("mati secara bawaan: tanpa flag startup, prepare dan publish sama-sama ditolak", async () => {
  const page = fakeChatPage();
  const s = createSendOnce({ getPage: async () => page, config: CONFIG, readIdentity: async () => [SHOP], checkIdentity, logger: silent });
  assert.equal((await s.prepare({ text: TEXT, confirm: true })).reason, "real-comment-send-disabled");
  assert.equal((await s.publish({ confirm: true })).reason, "real-comment-send-disabled");
  assert.deepEqual(page.actions, [], "halaman tidak boleh disentuh sama sekali");
  assert.equal(s.status(), "disabled");
});

test("allowed selain true persis tidak menyalakan apa pun", async () => {
  for (const bad of ["true", 1, {}, "yes"]) {
    const page = fakeChatPage();
    const s = makeSendOnce(page, { allowed: bad });
    assert.equal((await s.prepare({ text: TEXT, confirm: true })).reason, "real-comment-send-disabled", String(bad));
    assert.deepEqual(page.actions, []);
  }
});

test("confirm wajib true: tanpa itu tidak ada yang tersentuh", async () => {
  for (const bad of [undefined, false, "true", 1, null]) {
    const page = fakeChatPage();
    const s = makeSendOnce(page);
    assert.equal((await s.prepare({ text: TEXT, confirm: bad })).reason, "confirmation-required", String(bad));
    assert.equal((await s.publish({ confirm: bad })).reason, "confirmation-required", String(bad));
    assert.deepEqual(page.actions, []);
  }
});

// ---------- gerbang identitas ----------

test("identitas toko salah -> ditolak sebelum mengetik", async () => {
  const page = fakeChatPage();
  const s = makeSendOnce(page, { readIdentity: async () => ["toko_lain"] });
  const r = await s.prepare({ text: TEXT, confirm: true });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^identity-/);
  assert.equal(countOf(page, "type"), 0);
  assert.equal(s.__state().typeAttemptUsed, false, "jatah tidak boleh terpakai oleh penolakan identitas");
});

test("identitas produksi terdeteksi -> ditolak walau identitas tes juga ada", async () => {
  const page = fakeChatPage();
  const s = makeSendOnce(page, { readIdentity: async () => [SHOP, "garudafood_officialstore"] });
  const r = await s.prepare({ text: TEXT, confirm: true });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^identity-/);
  assert.equal(countOf(page, "type"), 0);
});

test("identitas tidak terbaca -> ditolak", async () => {
  const page = fakeChatPage();
  const s = makeSendOnce(page, { readIdentity: async () => [] });
  assert.match((await s.prepare({ text: TEXT, confirm: true })).reason, /^identity-/);
  assert.equal(countOf(page, "type"), 0);
});

// ---------- validasi pesan ----------

test("pesan kosong ditolak tanpa membuka halaman", async () => {
  const page = fakeChatPage();
  const s = makeSendOnce(page);
  for (const bad of ["", "   ", undefined, null, 42]) {
    assert.equal((await s.prepare({ text: bad, confirm: true })).reason, "empty-message", String(bad));
  }
  assert.deepEqual(page.actions, []);
});

test("pesan lebih dari 100 karakter ditolak; tepat 100 diterima", async () => {
  const page = fakeChatPage();
  assert.equal((await makeSendOnce(page).prepare({ text: "x".repeat(101), confirm: true })).reason, "message-too-long");
  assert.equal(countOf(page, "type"), 0);

  const p2 = fakeChatPage({ typeWrites: "x".repeat(100) });
  assert.equal((await makeSendOnce(p2).prepare({ text: "x".repeat(100), confirm: true })).ok, true);
});

test("emoji dihitung DUA unit UTF-16, menyamai penghitung TikTok", async () => {
  const atLimit = "🙌".repeat(50);      // 100 unit UTF-16
  assert.equal(atLimit.length, 100);
  const page = fakeChatPage({ typeWrites: atLimit });
  assert.equal((await makeSendOnce(page).prepare({ text: atLimit, confirm: true })).ok, true);

  const over = "🙌".repeat(51);         // 102 unit -> ditolak
  assert.equal((await makeSendOnce(fakeChatPage()).prepare({ text: over, confirm: true })).reason, "message-too-long");

  // Pesan uji AR2B: 26 code point, 27 unit UTF-16 - persis yang ditulis penghitung TikTok.
  assert.equal([...TEXT].length, 26);
  assert.equal(TEXT.length, 27);
});

// ---------- gerbang komposer ----------

test("textarea hilang / tersembunyi / disabled / publish hilang -> ditolak sebelum mengetik", async () => {
  const cases = [
    [{ ...COMPOSER_EMPTY, foundTextarea: false }, "chat-input-not-found"],
    [{ ...COMPOSER_EMPTY, textareaVisible: false }, "composer-not-ready"],
    [{ ...COMPOSER_EMPTY, textareaDisabled: true }, "chat-input-disabled"],
    [{ ...COMPOSER_EMPTY, foundPublishControl: false }, "publish-control-not-found"],
  ];
  for (const [composer, reason] of cases) {
    const page = fakeChatPage({ composerEmpty: composer });
    const s = makeSendOnce(page);
    assert.equal((await s.prepare({ text: TEXT, confirm: true })).reason, reason);
    assert.equal(countOf(page, "type"), 0, reason);
    assert.equal(s.__state().typeAttemptUsed, false, reason);
  }
});

test("halaman chat tertutup -> ditolak rapi", async () => {
  const page = fakeChatPage({ closed: true });
  assert.equal((await makeSendOnce(page).prepare({ text: TEXT, confirm: true })).reason, "chat-page-unavailable");
});

// ---------- tahap ketik ----------

test("tahap ketik: fokus, bersihkan, ketik SEKALI, verifikasi teks persis, berhenti sebelum klik", async () => {
  const page = fakeChatPage({ typeWrites: TEXT, startText: "sisa lama" });
  const s = makeSendOnce(page);
  const r = await s.prepare({ text: TEXT, confirm: true });

  assert.equal(r.ok, true);
  assert.equal(r.stage, "typed");
  assert.equal(r.typed, TEXT);
  assert.equal(r.publishEnabled, true);
  assert.equal(r.clicked, false, "prepare TIDAK BOLEH mengklik");
  assert.equal(countOf(page, "click"), 0);
  assert.equal(countOf(page, "type"), 1, "tepat satu kali ketik");
  assert.equal(countOf(page, "focus"), 1);
  assert.equal(page.currentValue(), TEXT);
  assert.equal(s.status(), "typed");
});

test("tidak pernah menekan Enter/Return di tahap mana pun", async () => {
  const page = fakeChatPage({ typeWrites: TEXT });
  const s = makeSendOnce(page);
  await s.prepare({ text: TEXT, confirm: true });
  await s.publish({ confirm: true });
  const keys = pressed(page);
  assert.ok(!keys.some((k) => /Enter|Return|NumpadEnter/i.test(k)), "Enter tidak boleh ditekan: " + keys.join(","));
  assert.deepEqual(keys, ["KeyA", "Backspace"], "hanya seleksi + hapus");
});

test("teks yang masuk tidak sama persis -> gagal, dan tidak mengklik", async () => {
  const page = fakeChatPage({ typeWrites: TEXT + " ekstra" });
  const s = makeSendOnce(page);
  const r = await s.prepare({ text: TEXT, confirm: true });
  assert.equal(r.reason, "typed-text-mismatch");
  assert.equal(countOf(page, "click"), 0);
  assert.equal((await s.publish({ confirm: true })).reason, "not-prepared");
});

test("publish tetap disabled setelah mengetik -> menolak melanjutkan ke klik", async () => {
  const page = fakeChatPage({ typeWrites: TEXT, composerFilled: { ...COMPOSER_FILLED, publishDisabled: true } });
  const s = makeSendOnce(page);
  assert.equal((await s.prepare({ text: TEXT, confirm: true })).reason, "publish-still-disabled");
  assert.equal(countOf(page, "click"), 0);
  assert.equal((await s.publish({ confirm: true })).reason, "not-prepared");
});

test("page.type melempar -> gagal rapi, jatah tetap terpakai, tidak ada retry", async () => {
  const page = fakeChatPage({ typeThrows: "detached Frame" });
  const s = makeSendOnce(page);
  const r = await s.prepare({ text: TEXT, confirm: true });
  assert.equal(r.reason, "type-failed");
  assert.equal(s.__state().typeAttemptUsed, true);
  assert.equal((await s.prepare({ text: TEXT, confirm: true })).reason, "real-comment-send-already-used");
  assert.equal(countOf(page, "type"), 1, "tidak boleh mencoba mengetik lagi");
});

// ---------- jatah sekali pakai ----------

test("percobaan kedua selalu ditolak, walau yang pertama sukses", async () => {
  const page = fakeChatPage({ typeWrites: TEXT });
  const s = makeSendOnce(page);
  assert.equal((await s.prepare({ text: TEXT, confirm: true })).ok, true);
  for (let i = 0; i < 3; i++) {
    assert.equal((await s.prepare({ text: TEXT, confirm: true })).reason, "real-comment-send-already-used");
  }
  assert.equal(countOf(page, "type"), 1);
});

test("hasil pertama yang ambigu tetap memakai jatah", async () => {
  const page = fakeChatPage({ typeWrites: "sebagian" });
  const s = makeSendOnce(page);
  assert.equal((await s.prepare({ text: TEXT, confirm: true })).reason, "typed-text-mismatch");
  assert.equal((await s.prepare({ text: TEXT, confirm: true })).reason, "real-comment-send-already-used");
  assert.equal(s.status(), "used");
});

test("klik kedua selalu ditolak, dan klik hanya terjadi sekali", async () => {
  const page = fakeChatPage({ typeWrites: TEXT });
  const s = makeSendOnce(page);
  await s.prepare({ text: TEXT, confirm: true });
  assert.equal((await s.publish({ confirm: true })).ok, true);
  for (let i = 0; i < 3; i++) {
    assert.equal((await s.publish({ confirm: true })).reason, "real-comment-send-already-used");
  }
  assert.equal(countOf(page, "click"), 1, "tepat satu klik untuk seumur hidup proses");
});

test("publish sebelum prepare -> not-prepared, tanpa klik", async () => {
  const page = fakeChatPage();
  const s = makeSendOnce(page);
  assert.equal((await s.publish({ confirm: true })).reason, "not-prepared");
  assert.equal(countOf(page, "click"), 0);
});

test("klik melempar -> gagal rapi, jatah klik tetap terpakai", async () => {
  const page = fakeChatPage({ typeWrites: TEXT, clickThrows: "Node is detached" });
  const s = makeSendOnce(page);
  await s.prepare({ text: TEXT, confirm: true });
  const r = await s.publish({ confirm: true });
  assert.equal(r.reason, "click-failed");
  assert.equal((await s.publish({ confirm: true })).reason, "real-comment-send-already-used");
  assert.equal(s.status(), "used");
});

test("kontrol publish hilang saat hendak diklik -> menolak, tanpa klik", async () => {
  const page = fakeChatPage({ typeWrites: TEXT, publishElement: null });
  const s = makeSendOnce(page);
  await s.prepare({ text: TEXT, confirm: true });
  assert.equal((await s.publish({ confirm: true })).reason, "publish-control-not-found");
  assert.equal(countOf(page, "click"), 0);
});

test("hasil klik TIDAK pernah diklaim terkirim: sent=unknown sampai penonton memastikan", async () => {
  const page = fakeChatPage({ typeWrites: TEXT });
  const s = makeSendOnce(page);
  await s.prepare({ text: TEXT, confirm: true });
  const r = await s.publish({ confirm: true });
  assert.equal(r.stage, "clicked");
  assert.equal(r.clicks, 1);
  assert.equal(r.sent, "unknown");
});

test("observeAfterClick hanya membaca", async () => {
  const page = fakeChatPage({ typeWrites: TEXT });
  const s = makeSendOnce(page);
  await s.prepare({ text: TEXT, confirm: true });
  await s.publish({ confirm: true });
  const before = page.actions.length;
  const obs = await s.observeAfterClick();
  assert.equal(obs.ok, true);
  const added = page.actions.slice(before).map((a) => a[0]);
  assert.ok(added.every((a) => a === "evaluate"), "hanya evaluate: " + added.join(","));
});

// ---------- fungsi in-page ----------

// Dijalankan lewat new Function untuk meniru page.evaluate: tanpa scope modul.
const asPageFn = (fn) => new Function("return (" + fn.toString() + ")")();
const SEL = { textarea: CHAT_TEXTAREA, publishIcon: PUBLISH_ICON, depth: COMPOSER_SCOPE_DEPTH };

function composerForClick({ state = "filled", hasIcon = true, hasTextarea = true, button = null } = {}) {
  const filled = state === "filled";
  const cls = filled ? "text-16 ml-6 text-primary-normal cursor-pointer" : "text-16 ml-6 text-neutral-text3 cursor-not-allowed";
  const ic = filled ? "arco-icon arco-icon-publish_management_fill " : "arco-icon arco-icon-publish";
  const wrapper = { className: cls, hasAttribute: () => false, parentElement: null };
  const icon = hasIcon ? { getAttribute: (n) => (n === "class" ? ic : null), closest: (q) => (button && /button/.test(q) ? button : null), parentElement: wrapper } : null;
  const inner = { querySelector: (s) => (/arco-icon-publish/.test(s) ? icon : null), parentElement: null };
  const ta = hasTextarea ? { parentElement: inner } : null;
  global.document = { querySelector: (s) => (s === CHAT_TEXTAREA ? ta : null) };
  return { ta, icon, wrapper, inner };
}

test("resolver klik: berjangkar textarea dan menemukan kedua varian ikon", () => {
  const run = asPageFn(resolvePublishElementInPage);
  const filled = composerForClick({ state: "filled" });
  assert.equal(run(SEL), filled.wrapper, "keadaan terisi");
  const empty = composerForClick({ state: "empty" });
  assert.equal(run(SEL), empty.wrapper, "keadaan kosong");
});

test("resolver klik: <button> diutamakan kalau halaman menyediakannya", () => {
  const btn = { tag: "button" };
  composerForClick({ button: btn });
  assert.equal(asPageFn(resolvePublishElementInPage)(SEL), btn);
});

test("resolver klik: tanpa textarea atau tanpa ikon -> null, tidak menebak", () => {
  const run = asPageFn(resolvePublishElementInPage);
  composerForClick({ hasTextarea: false });
  assert.equal(run(SEL), null);
  composerForClick({ hasIcon: false });
  assert.equal(run(SEL), null);
});

test("resolver klik: naik maksimal tiga pembungkus mencari penanda state", () => {
  const wrapper = { className: "cursor-pointer", hasAttribute: () => false, parentElement: null };
  const mid = { className: "", hasAttribute: () => false, parentElement: wrapper };
  const icon = { getAttribute: () => "arco-icon arco-icon-publish_management_fill", closest: () => null, parentElement: mid };
  const inner = { querySelector: (s) => (/arco-icon-publish/.test(s) ? icon : null), parentElement: null };
  global.document = { querySelector: (s) => (s === CHAT_TEXTAREA ? { parentElement: inner } : null) };
  assert.equal(asPageFn(resolvePublishElementInPage)(SEL), wrapper);
});

test("resolver klik: halaman kosong -> null", () => {
  global.document = { querySelector: () => null };
  assert.equal(asPageFn(resolvePublishElementInPage)(SEL), null);
});

test("in-page: readComposerText mengembalikan isi apa adanya", () => {
  global.document = { querySelector: (s) => (s === CHAT_TEXTAREA ? { value: "halo" } : null) };
  assert.equal(readComposerTextInPage(CHAT_TEXTAREA), "halo");
  global.document = { querySelector: () => null };
  assert.equal(readComposerTextInPage(CHAT_TEXTAREA), null);
});

// ---------- integrasi service ----------

function serviceWithChat({ allowCommentSendOnce = false, chat = fakeChatPage({ typeWrites: TEXT }) } = {}) {
  const CONSOLE = "https://shop.tiktok.com/streamer/live/product/dashboard";
  return {
    chat,
    svc: createService({
      config: { consoleUrl: CONSOLE, expectedShop: SHOP, forbiddenShops: ["garudafood"] },
      allowCommentSendOnce,
      deps: {
        launchBrowser: async () => ({ id: "fake" }),
        getPage: async () => ({ url: () => CONSOLE, isClosed: () => false, bringToFront: async () => {} }),
        newPage: async () => chat,
        // Penunggu komposer disuntik cepat: tes tidak boleh benar-benar menunggu.
        waitForComposerReady: async () => ({ ready: true, ms: 0, polls: 1 }),
        openConsole: async () => ({ url: CONSOLE, settled: true, readyMs: 1 }),
        closeBrowser: async () => {},
        readIdentity: async () => [SHOP],
        collectProducts: async () => ({ products: [], livePinButtonsOnPage: 0 }),
        pinProductByTitle: async () => ({ ok: false }),
        readPinState: async () => ({ text: "" }),
      },
    }),
  };
}

test("service: tanpa flag startup, send-once mati dan halaman tidak tersentuh", async () => {
  const { svc, chat } = serviceWithChat();
  assert.equal(svc.sendOnceStatus(), "disabled");
  assert.equal((await svc.handleCommentSendOnce({ text: TEXT, confirm: true })).reason, "real-comment-send-disabled");
  assert.equal((await svc.handleCommentPublishOnce({ confirm: true })).reason, "real-comment-send-disabled");
  assert.deepEqual(chat.actions, []);
});

test("service: dengan flag, ketik sekali lalu klik sekali, dan percobaan berikutnya ditolak", async () => {
  const { svc, chat } = serviceWithChat({ allowCommentSendOnce: true });
  assert.equal(svc.sendOnceStatus(), "armed");

  const typed = await svc.handleCommentSendOnce({ text: TEXT, confirm: true });
  assert.equal(typed.ok, true);
  assert.equal(typed.clicked, false);
  assert.equal(countOf(chat, "click"), 0, "mengetik tidak boleh mengklik");
  assert.equal(svc.sendOnceStatus(), "typed");

  const clicked = await svc.handleCommentPublishOnce({ confirm: true });
  assert.equal(clicked.ok, true);
  assert.equal(clicked.clicks, 1);
  assert.equal(clicked.sent, "unknown");
  assert.equal(svc.sendOnceStatus(), "used");

  assert.equal((await svc.handleCommentSendOnce({ text: TEXT, confirm: true })).reason, "real-comment-send-already-used");
  assert.equal((await svc.handleCommentPublishOnce({ confirm: true })).reason, "real-comment-send-already-used");
  assert.equal(countOf(chat, "type"), 1);
  assert.equal(countOf(chat, "click"), 1);
});

test("service: dry-run AR2A tetap bebas mutasi walau send-once bersenjata", async () => {
  const { svc, chat } = serviceWithChat({ allowCommentSendOnce: true });
  const r = await svc.handleCommentDryRun({ text: TEXT, scene: "PAX-1", playId: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  const mutations = chat.actions.filter((a) => ["type", "click", "focus", "keyboard.press", "keyboard.down"].includes(a[0]));
  assert.deepEqual(mutations, [], "dry-run tidak boleh menyentuh UI");
  assert.equal(svc.sendOnceStatus(), "armed", "dry-run tidak memakai jatah");
});

test("service: AutoPIN tetap terisolasi - pin tidak menyentuh halaman chat", async () => {
  const { svc, chat } = serviceWithChat({ allowCommentSendOnce: true });
  await svc.handlePin({ scene: "PAX-1", productKey: "uji satu", playId: 1 });
  assert.deepEqual(chat.actions, [], "pekerjaan pin tidak boleh menyentuh tab chat");
  assert.equal(svc.sendOnceStatus(), "armed");
});
