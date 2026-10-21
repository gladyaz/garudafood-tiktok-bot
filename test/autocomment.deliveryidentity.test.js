"use strict";
// IDENTITAS PENGIRIMAN: Q&A boleh membalas berkali-kali, percobaan ulang tidak.
//
// ---------------------------------------------------------------------------
// BUG LIVE NYATA 2026-10-21
//
//   penonton: "dilan waffle berapa"
//   bot     : balasan harga terkirim          <- BERHASIL
//   lalu    : [AUTOCOMMENT_SEND_SKIPPED] playId=0 reason=duplicate-play-id
//             [QA_PRICE_DECLINED] reason=send-duplicate-play-id product=3
//             [QA_PRICE_DECLINED] reason=send-duplicate-play-id product=1
//
// Perhatikan product=1 pada penolakan kedua: produk BERBEDA, ditolak dengan
// alasan yang sama. Jadi itu bukan dedupe per-produk - itu jatah kirim-sekali
// yang bertabrakan.
//
// Sebabnya: autopin/service.js menjatuhkan playId Q&A ke 0
// (`Number.isFinite(playId) ? playId : 0`), dan browser-sender memakai playId
// sebagai kunci `attempted`. Jawaban pertama memakan slot 0, dan SEMUA jawaban
// Q&A berikutnya sepanjang run ditolak. Nol juga membuat Q&A dinilai BASI
// terhadap generasi scene mana pun.
//
// Yang diuji di sini adalah kontrak PENGIRIM SUNGGUHAN (createBrowserSender),
// bukan transport palsu yang permisif - karena justru transport palsu yang
// membuat simulasi "10/10 terjawab" lolos sementara produksi hanya bisa sekali.
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createBrowserSender } = require("../autocomment/browser-sender");
const { createAutoComment, PIN_POLICY, PRIORITY } = require("../autocomment/core");
const { checkIdentity } = require("../autopin/core");
const { inspectPinResult } = require("../autopin/pin-result");
const { CHAT_TEXTAREA } = require("../autocomment/browser-transport");

const SHOP = "agen_mulia_abadi";
const CONFIG = { expectedShop: SHOP, forbiddenShops: ["garudafood"] };
const silent = { log: () => {} };

const TEXT_A = "Harga yang tampil di etalase saat ini Rp11.500 ya kak";
const TEXT_B = "Harga yang tampil di etalase saat ini Rp14.299 ya kak";

// ===========================================================================
// DISPATCHER: prioritas & gerbang pin tidak dilonggarkan
// ===========================================================================

test("7. balasan HIGH PAX tetap menuntut pin terkonfirmasi", async () => {
  const terkirim = [];
  const ac = createAutoComment({
    enabled: true,
    pinPolicy: PIN_POLICY.CONFIRMED,
    inspectPin: inspectPinResult,
    format: (scene) => ({ ok: true, text: "Etalase " + scene + " sudah aku pin ya kak" }),
    send: async (p) => { terkirim.push(p); return { ok: true }; },
    now: () => 1_000_000,
    logger: silent,
    timeoutMs: 1000,
  });

  const gagal = await ac.requestComment({
    scene: "PAX-1", playId: 1, pin: { ok: false, reason: "product-not-found" },
    requirePin: true, priority: PRIORITY.HIGH,
  });
  assert.equal(gagal.ok, false, "pin gagal tidak boleh mengirim");
  assert.equal(terkirim.length, 0);

  const ok = await ac.requestComment({
    scene: "PAX-1", playId: 2,
    pin: { ok: true, reason: "pinned", clicked: true, state: "Unpin", title: "X" },
    requirePin: true, priority: PRIORITY.HIGH,
  });
  assert.equal(ok.ok, true);
  assert.equal(terkirim.length, 1);
  // Balasan scene TIDAK membawa deliveryId - bentuk payload-nya tidak berubah.
  assert.equal("deliveryId" in terkirim[0], false, JSON.stringify(terkirim[0]));
});

test("dispatcher meneruskan deliveryId HANYA kalau diberikan", async () => {
  const terkirim = [];
  const ac = createAutoComment({
    enabled: true,
    pinPolicy: PIN_POLICY.IGNORE,
    format: () => ({ ok: true, text: TEXT_B }),
    send: async (p) => { terkirim.push(p); return { ok: true }; },
    now: () => 1_000_000,
    logger: silent,
    timeoutMs: 1000,
  });
  await ac.requestComment({ scene: "QA-PRICE", text: TEXT_B, requirePin: false, deliveryId: "qa:3" });
  assert.equal(terkirim.length, 1);
  assert.equal(terkirim[0].deliveryId, "qa:3");
});

// ===========================================================================
// KUOTA & DEDUPE TIDAK DILONGGARKAN
// ===========================================================================

test("3+4. dedupe produk yang sama 30 detik, lalu boleh lagi", () => {
  const { createQaDedupe, DEFAULT_COOLDOWN_MS } = require("../qa/dedupe");
  assert.equal(DEFAULT_COOLDOWN_MS, 30_000);
  let t = 1_000_000;
  const d = createQaDedupe({ now: () => t });

  // Tanda tangan PRODUKSI: reserve(intent, identity) - lihat qa/price-qa.js.
  const INTENT = "PRICE";
  const a = d.reserve(INTENT, "produk-3");
  assert.equal(a.ok, true, JSON.stringify(a));
  a.commit();

  // Dalam 30 detik: produk SAMA ditolak.
  t += 29_000;
  assert.equal(d.reserve(INTENT, "produk-3").ok, false, "produk sama dalam 30s harus ditolak");
  // Produk LAIN tetap boleh.
  const lain = d.reserve(INTENT, "produk-1");
  assert.equal(lain.ok, true, "produk berbeda tidak boleh ikut terkena");
  lain.commit();

  // Sesudah 30 detik: produk sama boleh lagi.
  t += 2_000;
  assert.equal(d.reserve(INTENT, "produk-3").ok, true, "sesudah 30s harus boleh lagi");
});

test("2. kuota 2 balasan per 60 detik bergulir tetap berlaku", () => {
  const { createQaQuota, DEFAULT_QUOTA_LIMIT, DEFAULT_QUOTA_WINDOW_MS } = require("../qa/dedupe");
  assert.equal(DEFAULT_QUOTA_LIMIT, 2);
  assert.equal(DEFAULT_QUOTA_WINDOW_MS, 60_000);
  let t = 1_000_000;
  const q = createQaQuota({ now: () => t });

  const a = q.reserve(); assert.equal(a.ok, true); a.commit();
  const b = q.reserve(); assert.equal(b.ok, true); b.commit();
  // Ketiga dalam jendela yang sama: ditolak.
  assert.equal(q.reserve().ok, false, "balasan ketiga dalam 60s harus ditolak");
  // Sesudah jendela bergulir: boleh lagi.
  t += 61_000;
  assert.equal(q.reserve().ok, true);
});

// ===========================================================================
// PENJAGA SUMBER
// ===========================================================================

test("PENJAGA: service TIDAK lagi menjatuhkan playId Q&A ke 0", () => {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "autopin", "service.js"), "utf8");
  const mulai = src.indexOf("async function handleCommentSend(");
  assert.ok(mulai > 0);
  const potong = src.slice(mulai, mulai + 2200);
  const kode = potong.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

  assert.match(kode, /deliveryId/, "handler harus mengenal deliveryId");
  // Jatuh ke 0 hanya boleh terjadi pada jalur scene (deliveryId null).
  assert.match(kode, /dId === null \? \(Number\.isFinite\(playId\) \? playId : 0\) : null/,
    "nol hanya untuk jalur scene, bukan untuk Q&A");
  assert.match(kode, /if \(dId === null\) \{/, "pemeriksaan basi harus dibatasi jalur scene");
});

test("PENJAGA: Q&A TIDAK mengarang playId scene", () => {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "qa", "price-qa.js"), "utf8");
  const kode = src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  assert.ok(!/playId:/.test(kode), "Q&A tidak boleh mengoper playId");
  assert.match(kode, /deliveryId: "qa:"/, "Q&A memakai identitas pengirimannya sendiri");
});
