// Regresi cold-start tab chat (AR3.1).
//
// Kegagalan yang dikejar di sini nyata: pada LIVE 2026-10-05, permintaan
// AutoComment PERTAMA ditolak `chat-input-disabled` karena tab chat baru dibuat
// pada saat itu juga dan komposernya belum aktif (ms=4889 vs chat readyMs=4773).
// Semua memakai halaman palsu - tidak ada browser, TikTok, OBS, maupun jaringan.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  waitForComposerReady, inspectComposerInPage,
  CHAT_TEXTAREA, PUBLISH_ICON, UI_MAX_LENGTH, COMPOSER_SCOPE_DEPTH,
  COMPOSER_READY_TIMEOUT_MS, COMPOSER_POLL_MS,
} = require("../autocomment/browser-transport");
const { createService } = require("../autopin/service");

const SHOP = "agen_mulia_abadi";
const CONSOLE = "https://shop.tiktok.com/streamer/live/product/dashboard";

const COMPOSER_DISABLED = {
  foundTextarea: true, textareaVisible: true, textareaDisabled: true,
  foundPublishControl: true, publishVisible: true, publishDisabled: true, maxLength: 100,
};
const COMPOSER_READY = { ...COMPOSER_DISABLED, textareaDisabled: false };

// Jam dan tidur palsu: penungguan diuji tanpa benar-benar menunggu.
function fakeClock() {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: async (ms) => { t += ms; },
    advance: (ms) => { t += ms; },
  };
}

// Halaman palsu yang mencatat SEMUA interaksi, supaya tes bisa membuktikan
// warm-up tidak pernah mengubah apa pun.
function page({ states, throwsFirst = 0 } = {}) {
  const actions = [];
  let i = 0;
  let threw = 0;
  const trap = (name) => (...args) => { actions.push([name, ...args]); };
  return {
    actions,
    evaluate: async (fn, sel) => {
      actions.push(["evaluate", sel && sel.textarea]);
      if (threw < throwsFirst) { threw += 1; throw new Error("Execution context was destroyed"); }
      const s = states[Math.min(i, states.length - 1)];
      i += 1;
      return s;
    },
    isClosed: () => false,
    url: () => CONSOLE,
    bringToFront: trap("bringToFront"),
    focus: trap("focus"),
    type: trap("type"),
    click: trap("click"),
    keyboard: { down: trap("keyboard.down"), up: trap("keyboard.up"), press: trap("keyboard.press") },
    evaluateHandle: trap("evaluateHandle"),
  };
}
const mutations = (p) => p.actions.filter((a) => !["evaluate", "bringToFront"].includes(a[0]));

// ---------- penungguan komposer ----------

test("komposer sudah hangat: siap pada polling pertama, tanpa tidur sama sekali", async () => {
  const clock = fakeClock();
  const p = page({ states: [COMPOSER_READY] });
  const r = await waitForComposerReady(p, { now: clock.now, sleep: clock.sleep });

  assert.equal(r.ready, true);
  assert.equal(r.polls, 1);
  assert.equal(r.ms, 0);
  assert.deepEqual(mutations(p), [], "warm-up tidak boleh mengubah apa pun");
});

test("cold start: textarea disabled di awal lalu aktif -> ditunggu sampai siap", async () => {
  const clock = fakeClock();
  const p = page({ states: [COMPOSER_DISABLED, COMPOSER_DISABLED, COMPOSER_DISABLED, COMPOSER_READY] });
  const r = await waitForComposerReady(p, { now: clock.now, sleep: clock.sleep, pollMs: 500 });

  assert.equal(r.ready, true);
  assert.equal(r.polls, 4);
  assert.equal(r.ms, 1500, "tiga kali tidur 500ms");
  assert.equal(r.composer.textareaDisabled, false);
  assert.deepEqual(mutations(p), []);
});

test("cold start: textarea belum ada lalu muncul -> juga ditunggu", async () => {
  const clock = fakeClock();
  const p = page({ states: [{ foundTextarea: false }, { foundTextarea: false }, COMPOSER_READY] });
  const r = await waitForComposerReady(p, { now: clock.now, sleep: clock.sleep });
  assert.equal(r.ready, true);
  assert.equal(r.polls, 3);
});

test("tidak pernah siap: berhenti pada batas waktu, bukan menunggu selamanya", async () => {
  const clock = fakeClock();
  const p = page({ states: [COMPOSER_DISABLED] });
  const r = await waitForComposerReady(p, { now: clock.now, sleep: clock.sleep, timeoutMs: 3_000, pollMs: 500 });

  assert.equal(r.ready, false);
  assert.equal(r.reason, "composer-not-ready");
  assert.ok(r.ms >= 3_000 && r.ms <= 3_500, "berhenti sekitar batas waktu, ms=" + r.ms);
  assert.ok(r.polls <= 8, "jumlah polling terbatas, polls=" + r.polls);
  assert.deepEqual(mutations(p), []);
});

test("evaluate melempar: tidak bocor ke pemanggil, tetap mencoba lalu menyerah rapi", async () => {
  const clock = fakeClock();
  const p = page({ states: [COMPOSER_DISABLED], throwsFirst: 99 });
  const r = await waitForComposerReady(p, { now: clock.now, sleep: clock.sleep, timeoutMs: 2_000, pollMs: 500 });
  assert.equal(r.ready, false);
  assert.ok(r.composer && r.composer.error, "error terakhir ikut dilaporkan");
});

test("evaluate sempat melempar lalu pulih: tetap bisa siap", async () => {
  const clock = fakeClock();
  const p = page({ states: [COMPOSER_READY], throwsFirst: 2 });
  const r = await waitForComposerReady(p, { now: clock.now, sleep: clock.sleep });
  assert.equal(r.ready, true);
  assert.equal(r.polls, 3);
});

test("batas bawaan konservatif dan terbatas", () => {
  assert.equal(COMPOSER_READY_TIMEOUT_MS, 15_000);
  assert.equal(COMPOSER_POLL_MS, 500);
});

test("penunggu memakai selector dan kedalaman yang sama dengan pemeriksa", async () => {
  let seen = null;
  const p = {
    evaluate: async (fn, sel) => { seen = { fn, sel }; return COMPOSER_READY; },
    isClosed: () => false,
  };
  await waitForComposerReady(p, { now: () => 0, sleep: async () => {} });
  assert.equal(seen.fn, inspectComposerInPage, "memakai pemeriksa yang sama, bukan aturan kedua");
  assert.deepEqual(seen.sel, { textarea: CHAT_TEXTAREA, publishIcon: PUBLISH_ICON, uiMax: UI_MAX_LENGTH, depth: COMPOSER_SCOPE_DEPTH });
});

// ---------- integrasi service ----------

function svcWith({ chat, waiter, productPage } = {}) {
  const prod = productPage || { url: () => CONSOLE, isClosed: () => false, bringToFront: async () => {} };
  return createService({
    config: { consoleUrl: CONSOLE, expectedShop: SHOP, forbiddenShops: ["garudafood"] },
    deps: {
      launchBrowser: async () => ({ id: "fake" }),
      getPage: async () => prod,
      newPage: async () => chat,
      openConsole: async () => ({ url: CONSOLE, settled: true, readyMs: 1 }),
      closeBrowser: async () => {},
      readIdentity: async () => [SHOP],
      collectProducts: async () => ({ products: [{ number: 1, title: "Produk Uji Satu", pinButtons: 1, pinVisible: true, pinDisabled: false }], livePinButtonsOnPage: 1 }),
      pinProductByTitle: async (_p, key) => ({ ok: true, title: key }),
      readPinState: async () => ({ text: "Unpin" }),
      waitForComposerReady: waiter || (async () => ({ ready: true, ms: 0, polls: 1 })),
    },
  });
}

test("service: warmUpChat membuka tab chat, menunggu komposer, dan NOL mutasi", async () => {
  const chat = page({ states: [COMPOSER_READY] });
  let waited = 0;
  const svc = svcWith({ chat, waiter: async () => { waited += 1; return { ready: true, ms: 10, polls: 2 }; } });

  const r = await svc.warmUpChat();
  assert.equal(r.ok, true);
  assert.equal(waited, 1, "komposer ditunggu tepat sekali saat tab dibuat");
  assert.equal(svc.__state().hasChatPage, true);
  assert.deepEqual(mutations(chat), [], "startup tidak boleh mengetik/mengklik apa pun");
});

test("service: halaman produk dikembalikan ke depan sesudah tab chat dibuka", async () => {
  const chat = page({ states: [COMPOSER_READY] });
  const fronts = [];
  const prod = { url: () => CONSOLE, isClosed: () => false, bringToFront: async () => { fronts.push("product"); } };
  const svc = svcWith({ chat, productPage: prod });

  await svc.warmUpChat();
  assert.ok(fronts.includes("product"), "daftar produk hanya ter-render di tab aktif (AP2.3)");
});

test("service: komposer tidak pernah siap -> warm-up TIDAK gagal dan tidak crash", async () => {
  const chat = page({ states: [COMPOSER_DISABLED] });
  const svc = svcWith({ chat, waiter: async () => ({ ready: false, reason: "composer-not-ready", ms: 15_000, polls: 31 }) });

  const r = await svc.warmUpChat();
  assert.equal(r.ok, true, "tidak siap bukan alasan menggagalkan service");
  assert.deepEqual(mutations(chat), []);
});

test("service: tab chat gagal dibuka -> dicatat, service tetap hidup, AutoPIN tetap jalan", async () => {
  const svc = createService({
    config: { consoleUrl: CONSOLE, expectedShop: SHOP, forbiddenShops: ["garudafood"] },
    deps: {
      launchBrowser: async () => ({ id: "fake" }),
      getPage: async () => ({ url: () => CONSOLE, isClosed: () => false, bringToFront: async () => {} }),
      newPage: async () => { throw new Error("tab chat gagal dibuat"); },
      openConsole: async () => ({ url: CONSOLE, settled: true, readyMs: 1 }),
      closeBrowser: async () => {},
      readIdentity: async () => [SHOP],
      collectProducts: async () => ({ products: [{ number: 1, title: "Produk Uji Satu", pinButtons: 1, pinVisible: true, pinDisabled: false }], livePinButtonsOnPage: 1 }),
      pinProductByTitle: async (_p, key) => ({ ok: true, title: key }),
      readPinState: async () => ({ text: "Unpin" }),
      waitForComposerReady: async () => ({ ready: true, ms: 0, polls: 1 }),
    },
  });

  const warm = await svc.warmUpChat();
  assert.equal(warm.ok, false, "kegagalan dilaporkan");

  const pin = await svc.handlePin({ scene: "PAX-1", productKey: "uji satu", playId: 1 });
  assert.equal(pin.ok, true, "AutoPIN sama sekali tidak terganggu");
  assert.equal(pin.reason, "pinned");
});

test("service: tab chat dipakai ulang - komposer tidak ditunggu lagi tiap permintaan", async () => {
  const chat = page({ states: [COMPOSER_READY] });
  let waited = 0;
  const svc = svcWith({ chat, waiter: async () => { waited += 1; return { ready: true, ms: 0, polls: 1 }; } });

  await svc.warmUpChat();
  await svc.ensureChatPage();
  await svc.ensureChatPage();
  assert.equal(waited, 1, "penungguan hanya saat tab pertama kali dibuat");
});
