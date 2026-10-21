"use strict";
// RUTE HTTP PRODUKSI: POST /comment/send
//
// ---------------------------------------------------------------------------
// BUG LIVE NYATA 2026-10-21 (gagal rilis)
//
//   [AUTOCOMMENT_REQUEST] scene=PAX-1 playId=1 priority=high
//   [AUTOCOMMENT_FAILED]  scene=PAX-1 playId=1 reason=service-error ms=7
//
// Tanpa SATU pun baris log di sisi service. Sebabnya ada di rute Express-nya,
// bukan di handler: rutenya membaca `body.deliveryId` padahal di lingkup itu
// tidak ada binding bernama `body` - hanya `req.body`. Setiap kiriman melempar
// ReferenceError, ditelan `catch` rutenya, dan pulang sebagai `service-error`.
// Balasan HIGH scene DAN Product Q&A sama-sama mati.
//
// Kenapa seluruh suite lolos: tes yang ada memanggil `svc.handleCommentSend()`
// LANGSUNG (lihat autocomment.ar3.test.js). Handler-nya memang benar. Yang
// tidak pernah dijalankan satu tes pun adalah LAPISAN RUTE-nya: registrasi
// route produksi + penguraian JSON body. Berkas ini menutup celah itu dengan
// mengetuk port HTTP sungguhan.
//
// Tidak ada rute tiruan di sini: `svc.app` adalah aplikasi Express produksi.
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createService } = require("../autopin/service");
// Kontrak halaman diambil dari PRODUKSI, bukan dikarang. Tiga bug P2 pernah
// lolos karena fake mengarang bentuk, jadi penanda dan fungsi klik yang
// dibandingkan di bawah adalah objek yang sama yang dipakai produksi.
const {
  CHAT_TEXTAREA, PUBLISH_ICON, UI_MAX_LENGTH, COMPOSER_SCOPE_DEPTH,
} = require("../autocomment/browser-transport");
const { domClickInPage } = require("../autocomment/click-strategy");

const SHOP = "agen_mulia_abadi";
const CONSOLE = "https://shop.tiktok.com/streamer/live/product/dashboard";
const TEXT_SCENE = "Etalase 1 sudah aku pin ya kak";
const TEXT_QA_1 = "Harga tergantung varian ya kak. Cek pilihan varian di etalase.";
const TEXT_QA_2 = "Harga yang tampil di etalase saat ini Rp14.299 ya kak";

// ---------------------------------------------------------------------------
// Halaman chat tiruan. Hanya menjawab apa yang benar-benar dipanggil produksi:
// focus / type / keyboard / evaluate(inspect) / evaluate(bacaTeks) /
// evaluate(domClickInPage) / isClosed.
function chatPage() {
  const EMPTY = {
    foundTextarea: true, foundPublishControl: true, textareaVisible: true, textareaDisabled: false,
    publishVisible: true, publishDisabled: true, maxLength: UI_MAX_LENGTH, placeholder: "Type something...",
    publishIconClass: "arco-icon arco-icon-publish", publishState: "disabled",
  };
  const FILLED = { ...EMPTY, publishDisabled: false, publishIconClass: "arco-icon arco-icon-publish_management_fill", publishState: "enabled" };
  const actions = [];
  let value = "";
  let typed = false;
  return {
    actions,
    isClosed: () => false,
    focus: async (s) => {
      assert.equal(s, CHAT_TEXTAREA, "produksi harus fokus ke textarea chat yang asli");
      actions.push(["focus"]);
    },
    type: async (s, t) => {
      assert.equal(s, CHAT_TEXTAREA);
      actions.push(["type", t]);
      value = t;            // echo apa adanya: verifikasi produksi harus cocok
      typed = true;
    },
    keyboard: {
      down: async () => { actions.push(["keyboard.down"]); },
      up: async () => { actions.push(["keyboard.up"]); },
      press: async (k) => { actions.push(["keyboard.press", k]); if (k === "Backspace") { value = ""; typed = false; } },
    },
    evaluate: async (fn, arg) => {
      if (fn === domClickInPage) {
        actions.push(["click", value]);
        return { ok: true, clicked: true, tag: "SPAN", cls: "cursor-pointer" };
      }
      if (typeof arg === "string") { actions.push(["readText"]); return value; }
      // Inspeksi komposer: penanda yang diminta harus yang asli.
      assert.equal(arg.textarea, CHAT_TEXTAREA);
      assert.equal(arg.publishIcon, PUBLISH_ICON);
      assert.equal(arg.depth, COMPOSER_SCOPE_DEPTH);
      actions.push(["inspect"]);
      return typed ? FILLED : EMPTY;
    },
    evaluateHandle: async () => { actions.push(["evaluateHandle"]); return { dispose: async () => {} }; },
  };
}

const clicksOf = (chat) => chat.actions.filter((a) => a[0] === "click");
const clickedTexts = (chat) => clicksOf(chat).map((a) => a[1]);

// Menyalakan aplikasi Express PRODUKSI pada port ephemeral loopback.
async function harness({ allowAutoCommentSend = true } = {}) {
  const chat = chatPage();
  const svc = createService({
    config: { consoleUrl: CONSOLE, expectedShop: SHOP, forbiddenShops: ["garudafood"] },
    allowAutoCommentSend,
    deps: {
      launchBrowser: async () => ({ id: "fake" }),
      getPage: async () => ({ url: () => CONSOLE, isClosed: () => false, bringToFront: async () => {} }),
      newPage: async () => chat,
      waitForComposerReady: async () => ({ ready: true, ms: 0, polls: 1 }),
      openConsole: async () => ({ url: CONSOLE, settled: true, readyMs: 1 }),
      closeBrowser: async () => {},
      readIdentity: async () => [SHOP],
      collectProducts: async () => ({
        products: [{ number: 1, title: "Produk Uji Satu", pinButtons: 1, pinVisible: true, pinDisabled: false }],
        livePinButtonsOnPage: 1,
      }),
      pinProductByTitle: async (_p, key) => ({ ok: true, title: key }),
      readPinState: async () => ({ text: "Unpin" }),
    },
  });

  const server = await new Promise((resolve, reject) => {
    const s = svc.app.listen(0, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
  const port = server.address().port;

  // Klien HTTP sungguhan: inilah yang memaksa express.json() ikut diuji.
  async function post(path, body) {
    const res = await fetch("http://127.0.0.1:" + port + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { json = { __noJson: true }; }
    return { status: res.status, json };
  }

  return { svc, chat, post, close: () => new Promise((r) => server.close(r)) };
}

// Penjaga umum: alasan ini HANYA muncul kalau rutenya melempar. Dipakai di
// setiap pernyataan di bawah supaya bug yang sama tidak bisa kembali diam-diam.
function bukanServiceError(r, label) {
  assert.notEqual(r.json.reason, "service-error",
    label + ": rute melempar sebelum handler jalan -> " + JSON.stringify(r.json));
}

// ===========================================================================
// A. Balasan scene dengan playId sungguhan
// ===========================================================================

test("A. rute menerima balasan scene dan benar-benar mencapai handler kirim", async () => {
  const h = await harness();
  try {
    const r = await h.post("/comment/send", { text: TEXT_SCENE, scene: "PAX-1", playId: 1 });
    bukanServiceError(r, "A");
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true, JSON.stringify(r.json));
    assert.equal(r.json.clicks, 1);
    // Bukti ia MENCAPAI pengirim, bukan hanya membalas 200: teksnya diketik
    // dan diklik di halaman. Ini juga membuktikan express.json() mengurai body.
    assert.deepEqual(clickedTexts(h.chat), [TEXT_SCENE]);
  } finally { await h.close(); }
});

// ===========================================================================
// B+C. Q&A dengan deliveryId - dua jawaban berbeda, dua-duanya terkirim
// ===========================================================================

test("B+C. qa:1 lalu qa:2 adalah dua pengiriman yang MERDEKA", async () => {
  const h = await harness();
  try {
    const b = await h.post("/comment/send", { text: TEXT_QA_1, scene: "QA-PRICE", deliveryId: "qa:1" });
    bukanServiceError(b, "B");
    assert.equal(b.json.ok, true, "jawaban Q&A pertama: " + JSON.stringify(b.json));

    const c = await h.post("/comment/send", { text: TEXT_QA_2, scene: "QA-PRICE", deliveryId: "qa:2" });
    bukanServiceError(c, "C");
    assert.equal(c.json.ok, true, "jawaban Q&A kedua harus tetap bisa: " + JSON.stringify(c.json));

    // Inilah regresi LIVE yang sebenarnya: dulu hanya SATU yang lolos.
    assert.deepEqual(clickedTexts(h.chat), [TEXT_QA_1, TEXT_QA_2]);
  } finally { await h.close(); }
});

// ===========================================================================
// D. Identitas pengiriman yang DIULANG tetap dijaga kirim-sekali
// ===========================================================================

test("D. deliveryId yang sama dua kali: pengiriman kedua DICEGAH", async () => {
  const h = await harness();
  try {
    const satu = await h.post("/comment/send", { text: TEXT_QA_1, scene: "QA-PRICE", deliveryId: "qa:1" });
    assert.equal(satu.json.ok, true);

    const ulang = await h.post("/comment/send", { text: TEXT_QA_1, scene: "QA-PRICE", deliveryId: "qa:1" });
    bukanServiceError(ulang, "D");
    assert.equal(ulang.json.ok, false, "identitas yang sama tidak boleh mengirim dua kali");
    assert.equal(ulang.json.reason, "duplicate-play-id");

    // Dan yang penting: TIDAK ada klik kedua di halaman.
    assert.equal(clicksOf(h.chat).length, 1, "hanya satu klik untuk satu identitas");
  } finally { await h.close(); }
});

// ===========================================================================
// E. Proteksi basi jalur scene TIDAK dilonggarkan
// ===========================================================================

test("E. playId scene yang sudah lewat tetap ditolak BASI lewat rute", async () => {
  const h = await harness();
  try {
    // Scene baru (playId 11) memulai pin -> generasi pemutaran naik.
    await h.svc.handlePin({ scene: "PAX-5", productKey: "uji satu", playId: 11 });

    const basi = await h.post("/comment/send", { text: TEXT_SCENE, scene: "PAX-3", playId: 10 });
    bukanServiceError(basi, "E");
    assert.equal(basi.json.ok, false);
    assert.equal(basi.json.reason, "stale");
    assert.equal(clicksOf(h.chat).length, 0, "tidak boleh mengetik/mengklik untuk scene yang sudah lewat");

    // Q&A TIDAK boleh ikut dinilai basi: ia tidak memutar apa pun.
    const qa = await h.post("/comment/send", { text: TEXT_QA_1, scene: "QA-PRICE", deliveryId: "qa:7" });
    bukanServiceError(qa, "E-qa");
    assert.equal(qa.json.ok, true, "Q&A tidak punya generasi pemutaran: " + JSON.stringify(qa.json));
    assert.deepEqual(clickedTexts(h.chat), [TEXT_QA_1]);
  } finally { await h.close(); }
});

test("E. gerbang --enable-autocomment-send tetap MATI secara bawaan, lewat rute", async () => {
  const h = await harness({ allowAutoCommentSend: false });
  try {
    const r = await h.post("/comment/send", { text: TEXT_SCENE, scene: "PAX-1", playId: 1 });
    bukanServiceError(r, "E-gate");
    assert.equal(r.json.ok, false);
    assert.equal(r.json.reason, "real-comment-send-disabled");
    assert.equal(clicksOf(h.chat).length, 0);
  } finally { await h.close(); }
});

// ===========================================================================
// F. Rute tidak boleh pulang `service-error` dari variabel yang tak terdefinisi
// ===========================================================================

test("F. body tanpa deliveryId pun TIDAK melempar (bentuk payload lama)", async () => {
  // Klien versi lama tidak mengirim deliveryId sama sekali. Rute harus tetap
  // menguraikannya sebagai undefined, bukan melempar.
  const h = await harness();
  try {
    const r = await h.post("/comment/send", { text: TEXT_SCENE, scene: "PAX-1", playId: 4 });
    bukanServiceError(r, "F-lama");
    assert.equal(r.json.ok, true);
  } finally { await h.close(); }
});

test("F. body KOSONG tetap dijawab rapi, bukan service-error", async () => {
  const h = await harness();
  try {
    const r = await h.post("/comment/send", {});
    bukanServiceError(r, "F-kosong");
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, false, "tanpa teks/playId harus ditolak dengan alasan jelas");
    assert.equal(clicksOf(h.chat).length, 0);
  } finally { await h.close(); }
});

test("F. PENJAGA SUMBER: rute mengurai deliveryId dari req.body, tanpa `body` bebas", () => {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "autopin", "service.js"), "utf8");

  const i = src.indexOf('app.post("/comment/send"');
  assert.ok(i > 0, "rute produksi harus ada");
  const potong = src.slice(i, src.indexOf('app.post("/comment/send-once"'));
  const kode = potong.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

  assert.match(kode, /const \{[^}]*\bdeliveryId\b[^}]*\} = req\.body \|\| \{\}/,
    "deliveryId harus ikut diurai dari req.body");
  assert.match(kode, /handleCommentSend\(\{[^}]*\bdeliveryId\b/,
    "deliveryId harus diteruskan ke handler");
  // Yang mematikan rilis: referensi ke `body` yang bukan `req.body`.
  const bebas = kode.replace(/req\.body/g, "REQBODY").match(/(^|[^.\w])body\b/g);
  assert.equal(bebas, null, "tidak boleh ada referensi `body` bebas di rute ini: " + JSON.stringify(bebas));
});
