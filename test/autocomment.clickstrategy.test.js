// Strategi klik tombol Publish.
//
// Dua run diagnostik LIVE 2026-10-05 membuktikan ElementHandle.click() milik
// Puppeteer tidak pernah selesai di dashboard LIVE:
//
//   anggaran browser 5300ms  -> jatah klik 3750ms  -> click=3758!   timeout
//   anggaran browser 15500ms -> jatah klik 14022ms -> click=14038!  timeout
//
// Kliknya menyerap berapa pun yang diberikan sementara `resolve-publish` hanya
// 1 ms, jadi elemennya ketemu instan dan yang menggantung murni aksi kliknya.
// Dua strategi di sini melewati jalur itu. Keduanya WAJIB terbukti: tepat satu
// klik, tanpa fallback otomatis, dan menolak elemen yang salah.
//
// DOM palsu di bawah dijalankan lewat `new Function` dari sumber fungsinya -
// itu sekaligus membuktikan fungsi in-page BENAR-BENAR self-contained, karena
// page.evaluate() hanya membawa sumbernya ke halaman tanpa scope modul.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createClickStrategy, domClickInPage, publishBoxInPage, defaultSelectors, STRATEGIES,
} = require("../autocomment/click-strategy");
const {
  inspectComposerInPage, findPublishControlInPage,
  CHAT_TEXTAREA, PUBLISH_ICON, COMPOSER_SCOPE_DEPTH,
} = require("../autocomment/browser-transport");
const { readComposerTextInPage } = require("../autocomment/send-once");
const { createBrowserSender } = require("../autocomment/browser-sender");
const { planTimeouts } = require("../autocomment/timeouts");
const { checkIdentity } = require("../autopin/core");

const SHOP = "agen_mulia_abadi";
const CONFIG = { expectedShop: SHOP, forbiddenShops: ["garudafood"] };
const TEXT = "Etalase 1 sudah aku pin ya kak \u{1F6D2}";
const SEL = defaultSelectors();
const silent = { log() {} };

// ===================== DOM palsu =====================

function matches(n, sel) {
  return sel
    .split(",")
    .map((s) => s.trim())
    .some((one) => {
      const m = /^([a-zA-Z]*)(?:\[([a-zA-Z-]+)([*]?)="?([^"\]]*)"?\])?$/.exec(one);
      if (!m) return false;
      const [, tag, attr, op, val] = m;
      if (tag && String(n.tagName).toLowerCase() !== tag.toLowerCase()) return false;
      if (!attr) return true;
      const actual = attr === "class" ? String(n.className || "") : n.getAttribute(attr);
      if (actual === null || actual === undefined) return false;
      return op === "*" ? String(actual).includes(val) : String(actual) === val;
    });
}

function node({ tag = "DIV", cls = "", attrs = {}, rect, style = {}, children = [], clickThrows = null } = {}) {
  const n = {
    tagName: tag.toUpperCase(),
    className: cls,
    clicks: 0,
    parentElement: null,
    _attrs: { ...attrs },
    _rect: rect === undefined ? { left: 100, top: 200, width: 40, height: 40 } : rect,
    _style: { visibility: "visible", display: "block", opacity: "1", cursor: "auto", ...style },
    _kids: [],
    getBoundingClientRect() {
      const r = this._rect || { left: 0, top: 0, width: 0, height: 0 };
      return { ...r, right: r.left + r.width, bottom: r.top + r.height };
    },
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null;
    },
    hasAttribute(k) {
      return Object.prototype.hasOwnProperty.call(this._attrs, k);
    },
    click() {
      this.clicks += 1;
      if (clickThrows) throw new Error(clickThrows);
    },
    closest(sel) {
      let cur = this;
      while (cur) {
        if (matches(cur, sel)) return cur;
        cur = cur.parentElement;
      }
      return null;
    },
    querySelector(sel) {
      const stack = [...this._kids];
      while (stack.length) {
        const cur = stack.shift();
        if (matches(cur, sel)) return cur;
        stack.unshift(...cur._kids);
      }
      return null;
    },
  };
  for (const c of children) {
    c.parentElement = n;
    n._kids.push(c);
  }
  return n;
}

// Bentuk komposer yang meniru dashboard: textarea dan ikon publish berada di
// blok yang sama, dengan pembungkus yang membawa penanda cursor-*.
function composerDom({
  withTextarea = true,
  withIcon = true,
  wrapperCls = "flex cursor-pointer",
  iconRect,
  wrapperRect,
  wrapperStyle = {},
  wrapperAttrs = {},
  wrapperTag = "DIV",
  clickThrows = null,
} = {}) {
  const icon = node({ tag: "svg", cls: "arco-icon arco-icon-publish_management_fill", rect: iconRect });
  const wrapper = node({
    tag: wrapperTag,
    cls: wrapperCls,
    attrs: wrapperAttrs,
    rect: wrapperRect,
    style: wrapperStyle,
    children: withIcon ? [icon] : [],
    clickThrows,
  });
  const ta = node({ tag: "textarea", attrs: { "data-tid": "m4b_input_textarea" } });
  const block = node({ children: withTextarea ? [ta, wrapper] : [wrapper] });
  const root = node({ children: [block] });
  const doc = {
    querySelector(sel) {
      return root.querySelector(sel);
    },
  };
  return { doc, root, block, ta, wrapper, icon };
}

// Dijalankan dari SUMBER fungsinya, tanpa scope modul: kalau fungsi in-page
// diam-diam mengandalkan sesuatu dari modul, di sini ia akan melempar
// ReferenceError - persis seperti di dalam halaman sungguhan.
function runInPage(fn, dom, sel = SEL) {
  const factory = new Function(
    "document",
    "getComputedStyle",
    "sel",
    "return (" + fn.toString() + ")(sel);"
  );
  return factory(dom.doc, (el) => el._style, sel);
}

// ===================== fungsi in-page: DOM_CLICK =====================

test("DOM_CLICK: mengklik TEPAT SATU KALI, di dalam halaman", () => {
  const dom = composerDom();
  const r = runInPage(domClickInPage, dom);

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.clicked, true);
  assert.equal(dom.wrapper.clicks, 1, "tepat satu klik");
  assert.equal(dom.icon.clicks, 0, "ikon SVG-nya sendiri tidak diklik");
});

test("DOM_CLICK: fungsi in-page self-contained (tidak butuh scope modul)", () => {
  // runInPage memakai new Function, jadi tes ini lewat hanya kalau benar-benar
  // tidak ada rujukan ke scope modul.
  assert.doesNotThrow(() => runInPage(domClickInPage, composerDom()));
  assert.doesNotThrow(() => runInPage(publishBoxInPage, composerDom()));
});

test("DOM_CLICK: menolak elemen yang salah/tersembunyi/disabled, dan NOL klik", () => {
  const cases = [
    ["textarea tidak ada", { withTextarea: false }, "chat-input-not-found"],
    ["ikon publish tidak ada", { withIcon: false }, "publish-control-not-found"],
    ["ukuran nol (mis. tombol 'New')", { wrapperRect: { left: 0, top: 0, width: 0, height: 0 } }, "publish-control-not-visible"],
    ["display none", { wrapperStyle: { display: "none" } }, "publish-control-not-visible"],
    ["visibility hidden", { wrapperStyle: { visibility: "hidden" } }, "publish-control-not-visible"],
    ["opacity 0", { wrapperStyle: { opacity: "0" } }, "publish-control-not-visible"],
    ["cursor-not-allowed", { wrapperCls: "flex cursor-not-allowed" }, "publish-control-disabled"],
    ["aria-disabled", { wrapperAttrs: { "aria-disabled": "true" } }, "publish-control-disabled"],
    ["tanpa penanda aktif", { wrapperCls: "flex" }, "publish-control-disabled"],
  ];

  for (const [label, opts, reason] of cases) {
    const dom = composerDom(opts);
    const r = runInPage(domClickInPage, dom);
    assert.equal(r.ok, false, label);
    assert.equal(r.reason, reason, label);
    assert.equal(dom.wrapper.clicks, 0, label + ": tidak boleh ada klik");
  }
});

test("DOM_CLICK: <button> dipakai kalau halaman menyediakannya", () => {
  const dom = composerDom({ wrapperTag: "button", wrapperCls: "cursor-pointer" });
  const r = runInPage(domClickInPage, dom);
  assert.equal(r.ok, true);
  assert.equal(r.tag, "BUTTON");
  assert.equal(dom.wrapper.clicks, 1);
});

test("DOM_CLICK: button yang disabled ditolak walau bertanda cursor-pointer", () => {
  const dom = composerDom({ wrapperTag: "button", wrapperCls: "cursor-pointer" });
  dom.wrapper.disabled = true;
  const r = runInPage(domClickInPage, dom);
  assert.equal(r.reason, "publish-control-disabled");
  assert.equal(dom.wrapper.clicks, 0);
});

// ===================== fungsi in-page: MOUSE_CLICK =====================

test("MOUSE_CLICK: mengembalikan titik TENGAH pembungkus, dan TIDAK mengklik", () => {
  const dom = composerDom({ wrapperRect: { left: 100, top: 200, width: 40, height: 20 } });
  const r = runInPage(publishBoxInPage, dom);

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.x, 120, "100 + 40/2");
  assert.equal(r.y, 210, "200 + 20/2");
  assert.equal(dom.wrapper.clicks, 0, "tahap ini murni membaca");
});

test("MOUSE_CLICK: menolak keadaan yang sama dengan DOM_CLICK", () => {
  for (const [label, opts, reason] of [
    ["textarea tidak ada", { withTextarea: false }, "chat-input-not-found"],
    ["ikon tidak ada", { withIcon: false }, "publish-control-not-found"],
    ["ukuran nol", { wrapperRect: { left: 0, top: 0, width: 0, height: 0 } }, "publish-control-not-visible"],
    ["display none", { wrapperStyle: { display: "none" } }, "publish-control-not-visible"],
    ["disabled", { wrapperCls: "flex cursor-not-allowed" }, "publish-control-disabled"],
  ]) {
    const dom = composerDom(opts);
    const r = runInPage(publishBoxInPage, dom);
    assert.equal(r.ok, false, label);
    assert.equal(r.reason, reason, label);
    assert.equal(dom.wrapper.clicks, 0, label);
  }
});

test("MOUSE_CLICK: titik di luar viewport dilaporkan, bukan diklik membabi buta", () => {
  const dom = composerDom({ wrapperRect: { left: -200, top: -200, width: 40, height: 40 } });
  const r = runInPage(publishBoxInPage, dom);
  assert.equal(r.reason, "publish-control-offscreen");
});

// ===================== kesetaraan dengan resolver acuan =====================

test("kedua fungsi in-page memakai aturan resolusi yang SAMA dengan acuan modul", () => {
  // findPublishControlInPage() adalah implementasi acuan. Kalau salah satu
  // fungsi in-page menyimpang, kita bisa memeriksa satu hal tapi mengklik yang
  // lain - cacat yang persis pernah terjadi di AR2B.
  for (const opts of [
    {},
    { wrapperTag: "button", wrapperCls: "cursor-pointer" },
    { wrapperCls: "flex cursor-not-allowed" },
    { wrapperAttrs: { "aria-disabled": "true" } },
  ]) {
    const dom = composerDom(opts);
    const acuan = findPublishControlInPage(dom.ta, PUBLISH_ICON, COMPOSER_SCOPE_DEPTH);
    const target = acuan.actionable || acuan.icon;

    const box = runInPage(publishBoxInPage, dom);
    const klik = runInPage(domClickInPage, dom);

    if (box.ok) {
      const r = target.getBoundingClientRect();
      assert.equal(box.x, r.left + r.width / 2, JSON.stringify(opts));
      assert.equal(box.y, r.top + r.height / 2, JSON.stringify(opts));
    }
    // Kalau boleh diklik, yang terklik HARUS elemen acuan yang sama.
    if (klik.ok) assert.equal(target.clicks, 1, JSON.stringify(opts));
    // Dan kedua fungsi harus SELALU sepakat soal boleh/tidak.
    assert.equal(box.ok, klik.ok, "kedua strategi tidak boleh berbeda pendapat: " + JSON.stringify(opts));
    if (!box.ok) assert.equal(box.reason, klik.reason, JSON.stringify(opts));
  }
});

// ===================== strategi sebagai unit =====================

function strategyPage({ domResult, boxResult, evaluateThrows = null, mouseThrows = null } = {}) {
  const calls = [];
  return {
    calls,
    evaluate: async (fn, arg) => {
      if (fn === domClickInPage) {
        calls.push(["evaluate:dom-click", arg]);
        if (evaluateThrows) throw new Error(evaluateThrows);
        return domResult === undefined ? { ok: true, clicked: true, tag: "DIV", cls: "cursor-pointer" } : domResult;
      }
      if (fn === publishBoxInPage) {
        calls.push(["evaluate:publish-box", arg]);
        if (evaluateThrows) throw new Error(evaluateThrows);
        return boxResult === undefined ? { ok: true, x: 120, y: 210, width: 40, height: 20 } : boxResult;
      }
      calls.push(["evaluate:lain"]);
      return null;
    },
    evaluateHandle: async () => {
      calls.push(["evaluateHandle"]);
      return { asElement: () => ({ click: async () => calls.push(["handle-click"]) }), dispose: async () => {} };
    },
    mouse: {
      click: async (x, y) => {
        calls.push(["mouse.click", x, y]);
        if (mouseThrows) throw new Error(mouseThrows);
      },
    },
  };
}

const countCalls = (p, name) => p.calls.filter((c) => c[0] === name).length;

test("strategi DOM: satu evaluate, NOL evaluateHandle, NOL mouse", async () => {
  const p = strategyPage();
  const s = createClickStrategy({ strategy: STRATEGIES.DOM });
  const r = await s.click({ page: p });

  assert.equal(r.ok, true);
  assert.equal(r.clicks, 1);
  assert.equal(r.strategy, "dom");
  assert.equal(countCalls(p, "evaluate:dom-click"), 1, "tepat satu round-trip");
  assert.equal(countCalls(p, "evaluateHandle"), 0, "ElementHandle.click() tidak boleh dipakai");
  assert.equal(countCalls(p, "handle-click"), 0);
  assert.equal(countCalls(p, "mouse.click"), 0);
});

test("strategi MOUSE: baca kotak lalu satu mouse.click, NOL evaluateHandle", async () => {
  const p = strategyPage();
  const s = createClickStrategy({ strategy: STRATEGIES.MOUSE });
  const r = await s.click({ page: p });

  assert.equal(r.ok, true);
  assert.equal(r.clicks, 1);
  assert.equal(r.strategy, "mouse");
  assert.deepEqual(r.point, { x: 120, y: 210 });
  assert.equal(countCalls(p, "evaluate:publish-box"), 1);
  assert.equal(countCalls(p, "mouse.click"), 1, "tepat satu klik");
  assert.deepEqual(p.calls.find((c) => c[0] === "mouse.click"), ["mouse.click", 120, 210]);
  assert.equal(countCalls(p, "evaluateHandle"), 0, "ElementHandle.click() tidak boleh dipakai");
});

test("strategi baru TIDAK PERNAH memakai ElementHandle.click() - juga di sumbernya", () => {
  const src = require("node:fs").readFileSync(require.resolve("../autocomment/click-strategy.js"), "utf8");
  const baru = src.slice(src.indexOf("if (name === STRATEGIES.DOM)"), src.indexOf("// STRATEGIES.HANDLE"));
  assert.ok(!/evaluateHandle/.test(baru), "jalur DOM/MOUSE tidak boleh menyentuh evaluateHandle");
  assert.ok(!/asElement/.test(baru), "jalur DOM/MOUSE tidak boleh menyentuh asElement");
});

test("strategi: penolakan dari halaman diteruskan apa adanya, tanpa klik", async () => {
  for (const reason of ["publish-control-not-found", "publish-control-disabled", "publish-control-not-visible"]) {
    const dom = strategyPage({ domResult: { ok: false, reason } });
    const rd = await createClickStrategy({ strategy: STRATEGIES.DOM }).click({ page: dom });
    assert.equal(rd.ok, false);
    assert.equal(rd.reason, reason);

    const mouse = strategyPage({ boxResult: { ok: false, reason } });
    const rm = await createClickStrategy({ strategy: STRATEGIES.MOUSE }).click({ page: mouse });
    assert.equal(rm.ok, false);
    assert.equal(rm.reason, reason);
    assert.equal(countCalls(mouse, "mouse.click"), 0, "kotak ditolak -> tidak boleh ada klik");
  }
});

test("strategi: satu instance = PALING BANYAK satu percobaan klik", async () => {
  for (const name of [STRATEGIES.DOM, STRATEGIES.MOUSE, STRATEGIES.HANDLE]) {
    const p = strategyPage();
    const s = createClickStrategy({ strategy: name });
    assert.equal((await s.click({ page: p })).ok, true, name);
    const again = await s.click({ page: p });
    assert.equal(again.reason, "click-already-attempted", name);
  }
});

test("strategi: nilai tak dikenal ditolak, halaman tidak disentuh", async () => {
  for (const bad of ["ngawur", "", null, "DOM_CLICK"]) {
    const p = strategyPage();
    const r = await createClickStrategy({ strategy: bad }).click({ page: p });
    assert.equal(r.ok, false, String(bad));
    assert.ok(r.reason.startsWith("unknown-click-strategy-"), r.reason);
    assert.deepEqual(p.calls, [], "tidak boleh ada interaksi halaman: " + String(bad));
  }
});

test("strategi: error dari halaman DILEMPAR, bukan ditelan", async () => {
  const dom = strategyPage({ evaluateThrows: "deadline-exceeded:click" });
  await assert.rejects(createClickStrategy({ strategy: STRATEGIES.DOM }).click({ page: dom }), /deadline-exceeded/);

  const mouse = strategyPage({ mouseThrows: "deadline-exceeded:click" });
  await assert.rejects(createClickStrategy({ strategy: STRATEGIES.MOUSE }).click({ page: mouse }), /deadline-exceeded/);
});

test("strategi: TIDAK ADA fallback otomatis antar strategi", async () => {
  // DOM gagal -> tidak boleh diam-diam mencoba mouse, dan sebaliknya.
  const dom = strategyPage({ evaluateThrows: "boom" });
  await createClickStrategy({ strategy: STRATEGIES.DOM }).click({ page: dom }).catch(() => {});
  assert.equal(countCalls(dom, "mouse.click"), 0, "DOM gagal tidak boleh jatuh ke mouse");
  assert.equal(countCalls(dom, "evaluate:publish-box"), 0);

  const mouse = strategyPage({ mouseThrows: "boom" });
  await createClickStrategy({ strategy: STRATEGIES.MOUSE }).click({ page: mouse }).catch(() => {});
  assert.equal(countCalls(mouse, "evaluate:dom-click"), 0, "mouse gagal tidak boleh jatuh ke DOM");
});

// ===================== integrasi dengan pengirim =====================

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

// Halaman lengkap: membedakan panggilan evaluate berdasarkan IDENTITAS fungsi,
// jadi tidak ada tebak-tebakan soal argumen.
function senderPage({
  clickClears = true,
  clickThrows = null,
  publishStuck = null,
  hijackOnClick = null,
  boxResult,
} = {}) {
  const calls = [];
  let text = "";
  const doClick = () => {
    calls.push(["click"]);
    if (clickClears) text = "";
    if (hijackOnClick !== null) text = hijackOnClick;
    if (clickThrows) throw new Error(clickThrows);
  };
  return {
    calls,
    text: () => text,
    isClosed: () => false,
    focus: async () => calls.push(["focus"]),
    type: async (_s, t) => {
      calls.push(["type"]);
      text = t;
    },
    keyboard: {
      down: async () => {},
      up: async () => {},
      press: async (k) => {
        calls.push(["press", k]);
        if (k === "Backspace") text = "";
      },
    },
    evaluate: async (fn, arg) => {
      if (fn === readComposerTextInPage) {
        calls.push(["read-text"]);
        return text;
      }
      if (fn === inspectComposerInPage) {
        calls.push(["inspect"]);
        return {
          foundTextarea: true,
          textareaVisible: true,
          textareaDisabled: false,
          foundPublishControl: true,
          publishVisible: true,
          publishDisabled: publishStuck === null ? text === "" : publishStuck,
          maxLength: 100,
        };
      }
      if (fn === domClickInPage) {
        calls.push(["evaluate:dom-click"]);
        doClick();
        return { ok: true, clicked: true, tag: "DIV", cls: "cursor-pointer" };
      }
      if (fn === publishBoxInPage) {
        calls.push(["evaluate:publish-box"]);
        return boxResult === undefined ? { ok: true, x: 120, y: 210, width: 40, height: 20 } : boxResult;
      }
      calls.push(["evaluate:lain"]);
      return null;
    },
    evaluateHandle: async () => {
      calls.push(["evaluateHandle"]);
      return { asElement: () => ({ click: async () => doClick() }), dispose: async () => {} };
    },
    mouse: {
      click: async (x, y) => {
        calls.push(["mouse.click", x, y]);
        doClick();
      },
    },
  };
}

function senderFor(page, strategy, over = {}) {
  const c = over.clock || clock();
  return createBrowserSender({
    getPage: async () => page,
    allowed: true,
    config: CONFIG,
    readIdentity: async () => [SHOP],
    checkIdentity,
    isStale: () => false,
    clickStrategy: strategy,
    timeouts: planTimeouts({ httpTimeoutMs: 8_000 }),
    now: c.now,
    sleep: c.sleep,
    logger: silent,
    ...over,
  });
}

const NEW = [STRATEGIES.DOM, STRATEGIES.MOUSE];

test("pengirim: default produksi adalah DOM", () => {
  // Diubah sesudah run LIVE 2026-10-05 membuktikannya: click=95ms, total
  // 1674ms, chat terkirim dan terkonfirmasi penonton - sementara jalur warisan
  // tidak pernah selesai di halaman yang sama (3758ms lalu 14038ms, keduanya
  // timeout).
  const s = createBrowserSender({ allowed: true });
  assert.equal(s.__state().clickStrategy, STRATEGIES.DOM);
});

test("pengirim: TANPA memilih apa pun, kirim benar-benar lewat DOM dan NOL evaluateHandle", async () => {
  // Bukan hanya nama default-nya yang benar: jalur yang BENAR-BENAR dipakai
  // harus DOM, dan jalur yang terbukti menggantung tidak boleh tersentuh.
  const p = senderPage({});
  const r = await senderFor(p, undefined).send({ text: TEXT, scene: "PAX-1", playId: 1 });

  assert.equal(r.ok, true);
  assert.equal(r.strategy, STRATEGIES.DOM);
  assert.equal(p.calls.filter((c) => c[0] === "evaluate:dom-click").length, 1);
  assert.equal(p.calls.filter((c) => c[0] === "evaluateHandle").length, 0, "jalur warisan tidak boleh tersentuh");
  assert.equal(p.calls.filter((c) => c[0] === "click").length, 1, "tetap tepat satu klik");
});

test("pengirim: klik sukses lewat strategi baru -> perilaku after-click tetap sama", async () => {
  for (const strategy of NEW) {
    const p = senderPage({ strategy });
    const r = await senderFor(p, strategy).send({ text: TEXT, scene: "PAX-1", playId: 1 });

    assert.equal(r.ok, true, strategy);
    assert.equal(r.reason, "clicked", strategy);
    assert.equal(r.clicks, 1, strategy);
    assert.equal(r.strategy, strategy, strategy);
    assert.equal(r.composerCleared, true, strategy + ": pembacaan after-click tetap jalan");
    assert.equal(r.sent, "unknown", strategy + ": sukses UI bukan bukti sampai ke penonton");
    assert.equal(p.calls.filter((c) => c[0] === "click").length, 1, strategy + ": tepat satu klik");
    assert.equal(p.calls.filter((c) => c[0] === "evaluateHandle").length, 0, strategy);
  }
});

test("pengirim: klik melempar -> REKONSILIASI, dan NOL fallback ke strategi lain", async () => {
  for (const strategy of NEW) {
    const p = senderPage({ strategy, clickClears: false, clickThrows: "deadline-exceeded:click" });
    const r = await senderFor(p, strategy).send({ text: TEXT, scene: "PAX-1", playId: 1 });

    assert.equal(r.reason, "not-sent", strategy);
    assert.equal(r.reconciled, "not-sent", strategy);
    assert.equal(r.cleared, true, strategy);
    assert.equal(p.calls.filter((c) => c[0] === "click").length, 1, strategy + ": satu percobaan saja");
    assert.equal(p.calls.filter((c) => c[0] === "evaluateHandle").length, 0, strategy);
    // Tidak boleh menyentuh jalur strategi yang lain.
    const lain = strategy === STRATEGIES.DOM ? "evaluate:publish-box" : "evaluate:dom-click";
    assert.equal(p.calls.filter((c) => c[0] === lain).length, 0, strategy + ": tanpa fallback");
  }
});

test("pengirim: klik melempar tapi komposer bersih -> sent-reconciled, tetap tanpa fallback", async () => {
  for (const strategy of NEW) {
    const p = senderPage({ strategy, clickClears: true, clickThrows: "deadline-exceeded:click" });
    const r = await senderFor(p, strategy).send({ text: TEXT, scene: "PAX-1", playId: 1 });

    assert.equal(r.ok, true, strategy);
    assert.equal(r.reason, "sent-reconciled", strategy);
    assert.equal(r.sent, "likely", strategy);
    assert.equal(p.calls.filter((c) => c[0] === "click").length, 1, strategy);
  }
});

test("pengirim: elemen disabled/tidak ada -> menolak, NOL klik, teks sendiri dibersihkan", async () => {
  // DOM: penolakan datang dari dalam halaman.
  const dom = senderPage({ strategy: STRATEGIES.DOM });
  dom.evaluate = (function (orig) {
    return async (fn, arg) => {
      if (fn === domClickInPage) {
        dom.calls.push(["evaluate:dom-click"]);
        return { ok: false, reason: "publish-control-disabled" };
      }
      return orig(fn, arg);
    };
  })(dom.evaluate);
  const rd = await senderFor(dom, STRATEGIES.DOM).send({ text: TEXT, scene: "PAX-1", playId: 1 });
  assert.equal(rd.reason, "publish-control-disabled");
  assert.equal(rd.clicked, false);
  assert.equal(rd.cleared, true, "teks kita tidak boleh ditinggal di komposer LIVE");
  assert.equal(dom.calls.filter((c) => c[0] === "click").length, 0);

  // MOUSE: penolakan datang dari pembacaan kotak.
  const mouse = senderPage({ strategy: STRATEGIES.MOUSE, boxResult: { ok: false, reason: "publish-control-not-found" } });
  const rm = await senderFor(mouse, STRATEGIES.MOUSE).send({ text: TEXT, scene: "PAX-1", playId: 1 });
  assert.equal(rm.reason, "publish-control-not-found");
  assert.equal(rm.cleared, true);
  assert.equal(mouse.calls.filter((c) => c[0] === "mouse.click").length, 0);
});

test("pengirim: basi sebelum klik -> NOL klik di kedua strategi", async () => {
  for (const strategy of NEW) {
    let n = 0;
    const p = senderPage({ strategy });
    const r = await senderFor(p, strategy, { isStale: () => ++n > 1 }).send({ text: TEXT, scene: "PAX-1", playId: 1 });

    assert.equal(r.reason, "stale", strategy);
    assert.equal(r.clicked, false, strategy);
    assert.equal(p.calls.filter((c) => c[0] === "click").length, 0, strategy);
    assert.equal(p.calls.filter((c) => c[0] === "evaluate:dom-click").length, 0, strategy);
    assert.equal(p.calls.filter((c) => c[0] === "mouse.click").length, 0, strategy);
  }
});

test("pengirim: playId kembar -> NOL klik kedua di kedua strategi", async () => {
  for (const strategy of NEW) {
    const p = senderPage({ strategy });
    const s = senderFor(p, strategy);
    await s.send({ text: TEXT, scene: "PAX-1", playId: 4 });
    const again = await s.send({ text: TEXT, scene: "PAX-1", playId: 4 });

    assert.equal(again.reason, "duplicate-play-id", strategy);
    assert.equal(p.calls.filter((c) => c[0] === "click").length, 1, strategy + ": tetap satu klik total");
    assert.equal(p.calls.filter((c) => c[0] === "type").length, 1, strategy + ": tetap satu ketik total");
  }
});

test("pengirim: teks ORANG LAIN tetap utuh di kedua strategi", async () => {
  const FOREIGN = "halo kak mau tanya ongkir";
  for (const strategy of NEW) {
    const p = senderPage({ strategy, clickClears: false, clickThrows: "deadline-exceeded:click", hijackOnClick: FOREIGN });
    const r = await senderFor(p, strategy).send({ text: TEXT, scene: "PAX-1", playId: 1 });

    assert.equal(r.reason, "ambiguous", strategy);
    assert.equal(r.cleared, false, strategy + ": pembersihan harus menolak");
    assert.equal(p.text(), FOREIGN, strategy + ": ketikan orang lain wajib utuh");
  }
});

test("pengirim: NOL retry di seluruh kombinasi strategi x hasil", async () => {
  const outcomes = [
    ["sukses", {}],
    ["not-sent", { clickClears: false, clickThrows: "deadline-exceeded:click" }],
    ["sent-reconciled", { clickClears: true, clickThrows: "deadline-exceeded:click" }],
    ["ambigu", { clickClears: true, clickThrows: "deadline-exceeded:click", publishStuck: false }],
  ];
  for (const strategy of NEW) {
    for (const [label, opts] of outcomes) {
      const p = senderPage({ strategy, ...opts });
      await senderFor(p, strategy).send({ text: TEXT, scene: "PAX-1", playId: 1 });
      const tag = strategy + "/" + label;
      assert.ok(p.calls.filter((c) => c[0] === "click").length <= 1, tag + ": klik <= 1");
      assert.ok(p.calls.filter((c) => c[0] === "type").length <= 1, tag + ": ketik <= 1");
      assert.equal(p.calls.filter((c) => c[0] === "evaluateHandle").length, 0, tag);
    }
  }
});

test("pengirim: strategi ikut tercetak di baris timing", async () => {
  for (const strategy of NEW) {
    const lines = [];
    const p = senderPage({ strategy });
    await senderFor(p, strategy, { logger: { log: (l) => lines.push(l) } }).send({
      text: TEXT, scene: "PAX-1", playId: 1,
    });
    const timing = lines.find((l) => l.includes("[AUTOCOMMENT_SEND_TIMING]"));
    assert.ok(timing, strategy);
    assert.ok(timing.includes("strategy=" + strategy), timing);
    assert.ok(timing.includes("click="), timing);
  }
});

test("pengirim: strategi DOM tidak punya tahap resolve-publish terpisah; MOUSE punya", async () => {
  const lines = { dom: [], mouse: [] };
  for (const strategy of NEW) {
    const p = senderPage({ strategy });
    await senderFor(p, strategy, { logger: { log: (l) => lines[strategy].push(l) } }).send({
      text: TEXT, scene: "PAX-1", playId: 1,
    });
  }
  const dom = lines.dom.find((l) => l.includes("TIMING"));
  const mouse = lines.mouse.find((l) => l.includes("TIMING"));
  assert.ok(!dom.includes("resolve-publish="), "DOM: resolusi ikut terhitung di dalam click: " + dom);
  assert.ok(mouse.includes("resolve-publish="), "MOUSE: pembacaan kotak terukur sendiri: " + mouse);
});
