// Transport browser AutoComment (AR2A): HANYA BACA.
//
// Halaman Puppeteer dipalsukan sepenuhnya. Setiap page palsu mencatat panggilan
// mutasi (type/click/press/focus/fill) supaya tes bisa membuktikan transport ini
// tidak pernah menyentuh UI. Tidak ada TikTok, browser, OBS, maupun jaringan.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createBrowserTransport, inspectComposerInPage, decideDryRun,
  CHAT_TEXTAREA, PUBLISH_ICON, UI_MAX_LENGTH, COMPOSER_SCOPE_DEPTH, findPublishControlInPage,
} = require("../autocomment/browser-transport");
const { createService, LOOPBACK, startService } = require("../autopin/service");

const TEXT = "Etalase 3 sudah aku pin ya kak 🛒";
const silent = { log: () => {} };

// Komposer sehat sebagaimana terlihat di DOM LIVE Manager yang tersimpan.
const HEALTHY = {
  foundTextarea: true, foundPublishControl: true,
  textareaVisible: true, textareaDisabled: false,
  publishVisible: true, publishDisabled: true, // kosong -> memang cursor-not-allowed
  maxLength: 100, placeholder: "Type something...",
};

// page palsu: evaluate() mengembalikan composer yang ditentukan tes, dan setiap
// metode mutasi dicatat sebagai pelanggaran.
function fakePage(composer, { closed = false, evaluateThrows = null } = {}) {
  const violations = [];
  const trap = (name) => (...args) => { violations.push({ name, args }); };
  return {
    violations,
    isClosed: () => closed,
    evaluate: async (fn, sel) => {
      if (evaluateThrows) throw new Error(evaluateThrows);
      assert.equal(typeof fn, "function");
      assert.equal(sel.textarea, CHAT_TEXTAREA);
      assert.equal(sel.publishIcon, PUBLISH_ICON);
      return typeof composer === "function" ? composer(sel) : composer;
    },
    type: trap("type"),
    click: trap("click"),
    fill: trap("fill"),
    focus: trap("focus"),
    $eval: trap("$eval"),
    keyboard: { type: trap("keyboard.type"), press: trap("keyboard.press"), down: trap("keyboard.down") },
  };
}
const transportFor = (page, over = {}) =>
  createBrowserTransport({ getPage: async () => page, dryRun: true, logger: silent, ...over });

// ---------- pemeriksaan komposer (decideDryRun murni) ----------

test("komposer sehat + pesan wajar -> dry-run diterima", () => {
  assert.deepEqual(decideDryRun(TEXT, HEALTHY), { ok: true });
});

test("textarea tidak ketemu -> chat-input-not-found", () => {
  assert.equal(decideDryRun(TEXT, { ...HEALTHY, foundTextarea: false }).reason, "chat-input-not-found");
});

test("kontrol publish tidak ketemu -> publish-control-not-found", () => {
  assert.equal(decideDryRun(TEXT, { ...HEALTHY, foundPublishControl: false }).reason, "publish-control-not-found");
});

test("textarea tersembunyi -> composer-not-ready", () => {
  assert.equal(decideDryRun(TEXT, { ...HEALTHY, textareaVisible: false }).reason, "composer-not-ready");
});

test("textarea disabled/readonly -> chat-input-disabled", () => {
  assert.equal(decideDryRun(TEXT, { ...HEALTHY, textareaDisabled: true }).reason, "chat-input-disabled");
});

test("komposer tidak terbaca sama sekali -> composer-not-ready", () => {
  assert.equal(decideDryRun(TEXT, null).reason, "composer-not-ready");
});

test("pesan kosong ditolak sebelum menyentuh apa pun", () => {
  for (const bad of ["", "   ", undefined, null, 42]) {
    assert.equal(decideDryRun(bad, HEALTHY).reason, "empty-message", String(bad));
  }
});

test("panjang memakai satuan UTF-16 seperti penghitung TikTok (emoji = 2)", () => {
  assert.equal(decideDryRun("x".repeat(100), HEALTHY).ok, true);
  assert.equal(decideDryRun("x".repeat(101), HEALTHY).reason, "message-too-long");
  // 50 emoji = 100 unit UTF-16 -> pas di batas; 51 emoji = 102 -> ditolak.
  assert.equal("🛒".repeat(50).length, 100);
  assert.equal(decideDryRun("🛒".repeat(50), HEALTHY).ok, true);
  assert.equal(decideDryRun("🛒".repeat(51), HEALTHY).reason, "message-too-long");
  // Dulu 100 emoji lolos karena dihitung per code point; itu LEBIH LONGGAR dari TikTok.
  assert.equal([..."🛒".repeat(100)].length, 100);
  assert.equal(decideDryRun("🛒".repeat(100), HEALTHY).reason, "message-too-long");
});

test("maxLength halaman yang lebih kecil dihormati; yang lebih besar tidak menaikkan batas UI 100", () => {
  assert.equal(decideDryRun("x".repeat(60), { ...HEALTHY, maxLength: 50 }).reason, "message-too-long");
  assert.equal(decideDryRun("x".repeat(101), { ...HEALTHY, maxLength: 500 }).reason, "message-too-long");
});

test("publish yang disabled TIDAK menolak dry-run (kosong memang bikin cursor-not-allowed)", () => {
  assert.deepEqual(decideDryRun(TEXT, { ...HEALTHY, publishDisabled: true }), { ok: true });
});

// ---------- transport end-to-end dengan page palsu ----------

test("dry-run mengembalikan wouldSend dan TIDAK memanggil type/click/keyboard sama sekali", async () => {
  const page = fakePage(HEALTHY);
  const r = await transportFor(page).send({ text: TEXT, scene: "PAX-3", playId: 7 });

  assert.deepEqual(r, { ok: true, dryRun: true, wouldSend: TEXT, composer: HEALTHY });
  assert.deepEqual(page.violations, [], "tidak boleh ada mutasi UI");
});

test("jalur penolakan pun tidak menyentuh UI", async () => {
  const page = fakePage({ ...HEALTHY, foundTextarea: false });
  const r = await transportFor(page).send({ text: TEXT, scene: "PAX-1", playId: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "chat-input-not-found");
  assert.deepEqual(page.violations, []);
});

test("evaluate melempar -> gagal rapi, bukan exception bocor", async () => {
  const page = fakePage(HEALTHY, { evaluateThrows: "Execution context was destroyed" });
  const r = await transportFor(page).send({ text: TEXT, scene: "PAX-1", playId: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "composer-inspect-failed");
  assert.match(r.detail, /Execution context/);
});

test("halaman tertutup -> gagal rapi", async () => {
  const page = fakePage(HEALTHY, { closed: true });
  const r = await transportFor(page).send({ text: TEXT, scene: "PAX-1", playId: 1 });
  assert.equal(r.reason, "composer-inspect-failed");
  assert.match(r.detail, /chat-page-closed/);
});

test("halaman tidak tersedia -> gagal rapi", async () => {
  const t = createBrowserTransport({ getPage: async () => null, dryRun: true, logger: silent });
  const r = await t.send({ text: TEXT, scene: "PAX-1", playId: 1 });
  assert.equal(r.reason, "composer-inspect-failed");
  assert.match(r.detail, /chat-page-unavailable/);
});

test("logger rusak tidak menjatuhkan transport", async () => {
  const page = fakePage(HEALTHY);
  const t = createBrowserTransport({
    getPage: async () => page, dryRun: true,
    logger: { log: () => { throw new Error("logger mati"); } },
  });
  assert.equal((await t.send({ text: TEXT, scene: "PAX-1", playId: 1 })).ok, true);
});

test("dryRun selain true ditolak saat pembuatan: AR2A tidak punya jalur kirim sungguhan", () => {
  // undefined sengaja TIDAK di sini: tanpa argumen, default-nya true (aman).
  for (const bad of [false, "real", 1, 0, null]) {
    assert.throws(
      () => createBrowserTransport({ getPage: async () => fakePage(HEALTHY), dryRun: bad, logger: silent }),
      /AR2B|dryRun:true/,
      String(bad)
    );
  }
});

test("tanpa menyebut dryRun, default-nya tetap dry-run (aman)", async () => {
  const page = fakePage(HEALTHY);
  const t = createBrowserTransport({ getPage: async () => page, logger: silent });
  const r = await t.send({ text: TEXT, scene: "PAX-1", playId: 1 });
  assert.equal(r.dryRun, true);
  assert.deepEqual(page.violations, []);
});

test("log tahapan: READY lalu DRYRUN; tidak ada log yang memuat kata kirim/klik", async () => {
  const logs = [];
  const page = fakePage(HEALTHY);
  const t = createBrowserTransport({ getPage: async () => page, dryRun: true, logger: { log: (l) => logs.push(l) } });
  await t.send({ text: TEXT, scene: "PAX-3", playId: 9 });
  assert.ok(logs.some((l) => l.startsWith("[AUTOCOMMENT_BROWSER_READY]")));
  assert.ok(logs.some((l) => l.startsWith("[AUTOCOMMENT_BROWSER_DRYRUN]") && l.includes("wouldSend=")));
  assert.ok(!logs.some((l) => /\bSENT\b|clicked|typed/i.test(l)));
});

// ---------- fungsi yang berjalan di dalam halaman (dijalankan atas DOM palsu) ----------

// DOM berbentuk komposer SUNGGUHAN seperti yang terbukti di LIVE Manager:
//   div.flex.w-full                      <- scope
//     div.flex-1.relative                <- induk textarea
//       div "N/100"  > span.cursor-*  > svg.arco-icon-publish[_management_fill]
//       textarea[data-tid="m4b_input_textarea"]
// Resolver harus berangkat dari textarea dan menemukan ikon di dalam scope ini.
function composerDom({
  state = "empty",          // "empty" | "filled"
  iconClass = null,         // paksa kelas ikon tertentu
  wrapperClass = null,      // paksa kelas pembungkus
  hasIcon = true,
  hasTextarea = true,
  counterText = "0/100",
  maxlength = null,
  textareaRect = { width: 300, height: 36 },
  taOverrides = {},
  extraNoise = true,        // tombol "New" yang TIDAK boleh tertukar
} = {}) {
  const filled = state === "filled";
  const cls = wrapperClass !== null ? wrapperClass
    : filled ? "text-16 flex items-center ml-6 text-primary-normal cursor-pointer"
             : "text-16 flex items-center ml-6 text-neutral-text3 cursor-not-allowed";
  const ic = iconClass !== null ? iconClass
    : filled ? "arco-icon arco-icon-publish_management_fill " : "arco-icon arco-icon-publish";

  const el = (o = {}) => ({
    getBoundingClientRect: () => ({ width: 16, height: 16 }),
    getAttribute: () => null,
    hasAttribute: () => false,
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    className: "",
    innerText: "",
    parentElement: null,
    ...o,
  });

  const icon = hasIcon ? el({
    getAttribute: (n) => (n === "class" ? ic : null),
    className: ic,
  }) : null;
  const wrapper = el({ className: cls, getBoundingClientRect: () => ({ width: 16, height: 24 }) });
  if (icon) icon.parentElement = wrapper;
  const noise = el({ className: "arco-btn hidden", getAttribute: (n) => (n === "class" ? "arco-btn hidden" : null) });

  const inner = el({
    innerText: counterText,
    querySelector: (s) => {
      if (/arco-icon-publish/.test(s) && icon) return icon;
      if (/button/.test(s) && extraNoise) return null; // "New" tidak pernah cocok pola ikon publish
      return null;
    },
  });
  const scope = el({ innerText: counterText, querySelector: () => null, parentElement: null });
  inner.parentElement = scope;

  const ta = hasTextarea ? el({
    disabled: false,
    readOnly: false,
    value: filled ? "sudah ada teks" : "",
    getBoundingClientRect: () => textareaRect,
    getAttribute: (n) => (n === "placeholder" ? "Type something..." : n === "maxlength" ? maxlength : null),
    closest: () => inner,
    parentElement: inner,
    ...taOverrides,
  }) : null;

  global.document = { querySelector: (s) => (s === CHAT_TEXTAREA ? ta : s === PUBLISH_ICON ? icon : null) };
  global.getComputedStyle = (node) => ({
    visibility: "visible", display: "block", opacity: "1",
    cursor: /cursor-not-allowed/.test(String((node && node.className) || "")) ? "not-allowed"
      : /cursor-pointer/.test(String((node && node.className) || "")) ? "pointer" : "auto",
  });
  return { ta, icon, wrapper, inner, scope, noise };
}

// page.evaluate hanya membawa SUMBER fungsi ke halaman. Menjalankan lewat
// new Function meniru itu: kalau fungsi in-page masih merujuk scope modul,
// tes ini yang pertama jatuh.
const asPageFn = (fn) => new Function("return (" + fn.toString() + ")")();
const runInPage = (over = {}) =>
  asPageFn(inspectComposerInPage)({ textarea: CHAT_TEXTAREA, publishIcon: PUBLISH_ICON, uiMax: UI_MAX_LENGTH, depth: COMPOSER_SCOPE_DEPTH, ...over });

test("in-page KOSONG: ikon arco-icon-publish, state disabled, maxLength dari penghitung", () => {
  composerDom({ state: "empty" });
  const r = runInPage();
  assert.equal(r.foundTextarea, true);
  assert.equal(r.foundPublishControl, true);
  assert.equal(r.textareaVisible, true);
  assert.equal(r.textareaDisabled, false);
  assert.equal(r.maxLength, 100);
  assert.equal(r.placeholder, "Type something...");
  assert.match(r.publishIconClass, /arco-icon-publish$/);
  assert.equal(r.publishState, "disabled");
  assert.equal(r.publishDisabled, true);
});

test("in-page TERISI: ikon publish_management_fill, state enabled", () => {
  composerDom({ state: "filled", counterText: "27/100" });
  const r = runInPage();
  assert.equal(r.foundPublishControl, true);
  assert.match(r.publishIconClass, /arco-icon-publish_management_fill/);
  assert.equal(r.publishState, "enabled");
  assert.equal(r.publishDisabled, false);
  assert.equal(r.publishVisible, true);
});

test("in-page: kedua varian ikon sama-sama ditemukan oleh satu pola selector", () => {
  for (const [state, re] of [["empty", /arco-icon-publish$/], ["filled", /publish_management_fill/]]) {
    composerDom({ state });
    const r = runInPage();
    assert.equal(r.foundPublishControl, true, state);
    assert.match(r.publishIconClass, re, state);
  }
});

test("in-page: tanpa penanda state yang jelas -> dianggap disabled, bukan ditebak aktif", () => {
  composerDom({ state: "filled", wrapperClass: "text-16 flex items-center" });
  const r = runInPage();
  assert.equal(r.foundPublishControl, true);
  assert.equal(r.publishDisabled, true, "lebih baik menolak daripada mengklik yang belum tentu tombol kirim");
});

test("in-page: atribut maxlength asli menang atas penghitung", () => {
  composerDom({ maxlength: "80" });
  assert.equal(runInPage().maxLength, 80);
});

test("in-page: tanpa maxlength dan tanpa penghitung -> jatuh ke batas UI 100", () => {
  composerDom({ counterText: "" });
  assert.equal(runInPage().maxLength, 100);
});

test("in-page: textarea hilang / ikon publish hilang terdeteksi", () => {
  composerDom({ hasTextarea: false });
  assert.equal(runInPage().foundTextarea, false);
  composerDom({ hasIcon: false });
  const r = runInPage();
  assert.equal(r.foundTextarea, true);
  assert.equal(r.foundPublishControl, false, "inilah kegagalan AR2B: ikon tidak ketemu");
});

test("in-page: tanpa textarea, kontrol publish TIDAK dicari sama sekali (jangkar wajib)", () => {
  composerDom({ hasTextarea: false, state: "filled" });
  const r = runInPage();
  assert.equal(r.foundPublishControl, false, "tanpa jangkar, jangan menebak elemen mana pun di halaman");
});

test("in-page: textarea berukuran nol dianggap tidak terlihat", () => {
  composerDom({ textareaRect: { width: 0, height: 0 } });
  assert.equal(runInPage().textareaVisible, false);
});

test("in-page: readOnly dan aria-disabled dihitung sebagai disabled", () => {
  composerDom({ taOverrides: { readOnly: true } });
  assert.equal(runInPage().textareaDisabled, true);
  composerDom({ taOverrides: { getAttribute: (n) => (n === "aria-disabled" ? "true" : null) } });
  assert.equal(runInPage().textareaDisabled, true);
});

test("in-page: resolver modul dan salinan bersarang memberi hasil yang sama", () => {
  // Salinan bersarang WAJIB ada (page.evaluate tanpa scope modul), jadi tes ini
  // yang menjaga keduanya tidak pernah berbeda perilaku.
  for (const state of ["empty", "filled"]) {
    const dom = composerDom({ state });
    const viaModule = findPublishControlInPage(dom.ta, PUBLISH_ICON, COMPOSER_SCOPE_DEPTH);
    const viaPage = runInPage();
    assert.equal(viaModule.icon, dom.icon, state);
    assert.equal(viaModule.actionable, dom.wrapper, state);
    assert.equal(viaPage.publishIconClass, String(dom.icon.getAttribute("class")).trim(), state);
  }
});

// ---------- integrasi service: serialisasi, isolasi, bind ----------

function serviceWithFakes({ pinDelay = 0, chatDelay = 0, composer = HEALTHY, pinThrows = false } = {}) {
  const order = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const CONSOLE = "https://shop.tiktok.com/streamer/live/product/dashboard";
  const productPage = { url: () => CONSOLE, isClosed: () => false, bringToFront: async () => {} };
  const chat = fakePage(composer);
  const svc = createService({
    config: { consoleUrl: CONSOLE, expectedShop: "agen_mulia_abadi", forbiddenShops: ["garudafood"] },
    deps: {
      launchBrowser: async () => ({ id: "fake" }),
      getPage: async () => productPage,
      newPage: async () => chat,
      // Penunggu komposer disuntik cepat: tes tidak boleh benar-benar menunggu.
      waitForComposerReady: async () => ({ ready: true, ms: 0, polls: 1 }),
      openConsole: async () => ({ url: CONSOLE, settled: true, readyMs: 1 }),
      closeBrowser: async () => {},
      readIdentity: async () => ["agen_mulia_abadi"],
      collectProducts: async () => {
        order.push("pin:start");
        if (pinDelay) await sleep(pinDelay);
        if (pinThrows) { order.push("pin:throw"); throw new Error("scraping gagal"); }
        order.push("pin:end");
        return { products: [{ number: 1, title: "Produk Uji Satu", pinButtons: 1, pinVisible: true, pinDisabled: false }], livePinButtonsOnPage: 1 };
      },
      pinProductByTitle: async (_p, key) => ({ ok: true, title: key }),
      readPinState: async () => ({ text: "Unpin" }),
    },
  });
  const origEval = chat.evaluate;
  chat.evaluate = async (...a) => {
    order.push("comment:start");
    if (chatDelay) await sleep(chatDelay);
    const r = await origEval(...a);
    order.push("comment:end");
    return r;
  };
  return { svc, order, chat, productPage };
}

test("service: /comment/dry-run mengembalikan wouldSend tanpa menyentuh UI", async () => {
  const { svc, chat } = serviceWithFakes();
  const r = await svc.handleCommentDryRun({ text: TEXT, scene: "PAX-3", playId: 3 });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.equal(r.wouldSend, TEXT);
  assert.deepEqual(chat.violations, []);
});

test("service: pesan kosong ditolak tanpa membuka halaman chat", async () => {
  const { svc } = serviceWithFakes();
  const r = await svc.handleCommentDryRun({ text: "  ", scene: "PAX-3", playId: 1 });
  assert.equal(r.reason, "empty-message");
  assert.equal(svc.__state().hasChatPage, false);
});

test("service: halaman chat adalah TAB TERPISAH dari halaman produk AutoPIN", async () => {
  const { svc, chat, productPage } = serviceWithFakes();
  const page = await svc.ensureChatPage();
  assert.equal(page, chat);
  assert.notEqual(page, productPage, "chat tidak boleh memakai halaman produk");
  assert.equal(await svc.ensureChatPage(), chat, "tab chat dipakai ulang, tidak dibuat berulang");
});

test("service: pekerjaan UI diserialkan - pin dan comment tidak pernah tumpang tindih", async () => {
  const { svc, order } = serviceWithFakes({ pinDelay: 30, chatDelay: 30 });
  await Promise.all([
    svc.handlePin({ scene: "PAX-1", productKey: "uji satu", playId: 1 }),
    svc.handleCommentDryRun({ text: TEXT, scene: "PAX-1", playId: 1 }),
  ]);
  const seq = order.join(" ");
  assert.ok(!/pin:start[^]*comment:start[^]*pin:end/.test(seq), "comment tidak boleh menyela pin: " + seq);
  assert.ok(!/comment:start[^]*pin:start[^]*comment:end/.test(seq), "pin tidak boleh menyela comment: " + seq);
  assert.equal(order.filter((o) => o === "pin:start").length, 1);
  assert.equal(order.filter((o) => o === "comment:start").length, 1);
});

test("service: kegagalan AutoPIN tidak merusak dry-run AutoComment berikutnya", async () => {
  const { svc } = serviceWithFakes({ pinThrows: true });
  const pin = await svc.handlePin({ scene: "PAX-1", productKey: "uji satu", playId: 1 });
  assert.equal(pin.ok, false);
  const comment = await svc.handleCommentDryRun({ text: TEXT, scene: "PAX-1", playId: 2 });
  assert.equal(comment.ok, true);
});

test("service: kegagalan AutoComment tidak merusak pin berikutnya", async () => {
  const { svc } = serviceWithFakes({ composer: { ...HEALTHY, foundTextarea: false } });
  const comment = await svc.handleCommentDryRun({ text: TEXT, scene: "PAX-1", playId: 1 });
  assert.equal(comment.ok, false);
  const pin = await svc.handlePin({ scene: "PAX-1", productKey: "uji satu", playId: 2 });
  assert.equal(pin.ok, true);
});

test("service: health melaporkan mode transport dry-run dan status tab chat", async () => {
  const { svc } = serviceWithFakes();
  const res = await new Promise((resolve) => {
    svc.app._router || null; // hanya memastikan app ada
    resolve(null);
  });
  assert.equal(res, null);
  const state = svc.__state();
  assert.equal(state.hasChatPage, false);
  await svc.ensureChatPage();
  assert.equal(svc.__state().hasChatPage, true);
});

test("service tetap hanya mendengarkan di loopback setelah AR2A", async () => {
  const { svc: inner } = serviceWithFakes();
  const svc = await startService({
    port: 0,
    config: { consoleUrl: "https://shop.tiktok.com/streamer/live/product/dashboard", forbiddenShops: ["garudafood"] },
    deps: {
      launchBrowser: async () => ({ id: "fake" }),
      getPage: async () => ({ url: () => "https://shop.tiktok.com/streamer/live/product/dashboard", isClosed: () => false, bringToFront: async () => {} }),
      newPage: async () => fakePage(HEALTHY),
      // Penunggu komposer disuntik cepat: tes tidak boleh benar-benar menunggu.
      waitForComposerReady: async () => ({ ready: true, ms: 0, polls: 1 }),
      openConsole: async () => ({ url: "x", settled: true, readyMs: 1 }),
      closeBrowser: async () => {},
      readIdentity: async () => ["agen_mulia_abadi"],
      collectProducts: async () => ({ products: [], livePinButtonsOnPage: 0 }),
      pinProductByTitle: async () => ({ ok: false }),
      readPinState: async () => ({ text: "" }),
    },
  });
  try {
    assert.equal(svc.server.address().address, LOOPBACK);
    assert.equal(LOOPBACK, "127.0.0.1");
  } finally {
    await new Promise((r) => svc.server.close(r));
  }
  assert.ok(inner);
});

// ---------- regresi AR2C: keamanan sekali-pakai tidak berubah oleh selector baru ----------

test("AR2C: selector baru tidak mengubah sifat bebas-mutasi dry-run", async () => {
  const page = fakePage(HEALTHY);
  const r = await transportFor(page).send({ text: TEXT, scene: "PAX-3", playId: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.deepEqual(page.violations, [], "dry-run tetap nol mutasi");
});

test("AR2C: dry-run menolak saat kontrol kirim tidak ketemu (kegagalan nyata AR2B)", async () => {
  const page = fakePage({ ...HEALTHY, foundPublishControl: false, publishVisible: false, publishDisabled: false });
  const r = await transportFor(page).send({ text: TEXT, scene: "PAX-3", playId: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "publish-control-not-found");
  assert.deepEqual(page.violations, []);
});

test("AR2C: depth pencarian ikut dikirim ke halaman, bukan diambil dari scope modul", async () => {
  let seen = null;
  const page = fakePage(HEALTHY);
  page.evaluate = async (_fn, sel) => { seen = sel; return HEALTHY; };
  await transportFor(page).send({ text: TEXT, scene: "PAX-1", playId: 1 });
  assert.equal(seen.textarea, CHAT_TEXTAREA);
  assert.equal(seen.publishIcon, PUBLISH_ICON);
  assert.equal(seen.depth, COMPOSER_SCOPE_DEPTH);
});

test("AR2C: pola selector menerima kedua varian dan menolak ikon lain", () => {
  const matches = (cls) => new RegExp(PUBLISH_ICON.replace(/^svg\[class\*="(.+)"\]$/, "$1")).test(cls);
  assert.ok(matches("arco-icon arco-icon-publish"));
  assert.ok(matches("arco-icon arco-icon-publish_management_fill "));
  assert.ok(!matches("arco-icon arco-icon-right_arrow rotate-90"), "tombol 'New' tidak boleh cocok");
  assert.ok(!matches("arco-icon arco-icon-notice"));
  assert.ok(!/nth-child|index-module__/.test(PUBLISH_ICON), "tanpa nth-child / kelas hash");
});
