// Generasi pemutaran yang sadar sesi.
//
// Regresi 2026-10-05: me-restart BOT saja memblokir semua trigger.
//
//   [AUTOPIN_FAILED] scene=PAX-1 playId=1 reason=stale
//   [AUTOCOMMENT_SKIPPED] scene=PAX-1 playId=1 reason=stale
//
// Penghitung playId bot mulai lagi dari 1, tapi service masih menyimpan
// latestPlayId=2 dari sesi bot sebelumnya, jadi 1 < 2 dibaca "basi" untuk
// pemutaran yang sebenarnya BARU. Operator bisa menabraknya tanpa melakukan
// apa pun yang salah, dan pesannya justru menyesatkan.
//
// Yang TIDAK boleh ikut hilang: pemeriksaan basi di DALAM satu sesi. Itu yang
// mencegah chat "Etalase 1 sudah di-pin" muncul ketika Etalase 2 sudah tayang.
//
// Semua offline: tidak ada browser, TikTok, OBS, maupun HTTP.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createPlayGeneration, newSessionId } = require("../autopin/session");
const { createService } = require("../autopin/service");

const A = "botA-1";
const B = "botB-2";

const gen = () => {
  const events = [];
  const g = createPlayGeneration({ logger: (e, d) => events.push([e, d]) });
  return { g, events };
};

// ---------- aturan di DALAM satu sesi tetap utuh ----------

test("sesi sama: playId lebih kecil dari yang terbaru -> BASI (aturan asli dijaga)", () => {
  const { g } = gen();
  g.note({ sessionId: A, playId: 5 });
  assert.equal(g.isStale({ sessionId: A, playId: 3 }), true);
  assert.equal(g.isStale({ sessionId: A, playId: 4 }), true);
});

test("sesi sama: playId terbaru atau lebih besar -> tidak basi, dan generasi naik", () => {
  const { g } = gen();
  g.note({ sessionId: A, playId: 5 });
  assert.equal(g.isStale({ sessionId: A, playId: 5 }), false);
  assert.equal(g.isStale({ sessionId: A, playId: 9 }), false);
  g.note({ sessionId: A, playId: 9 });
  assert.equal(g.latest(), 9);
  assert.equal(g.isStale({ sessionId: A, playId: 5 }), true, "yang lama kini basi");
});

test("playId 0 atau negatif TIDAK PERNAH basi (dipakai alat diagnostik)", () => {
  const { g } = gen();
  g.note({ sessionId: A, playId: 50 });
  for (const playId of [0, -1, undefined, null, NaN]) {
    assert.equal(g.isStale({ sessionId: A, playId }), false, String(playId));
  }
});

// ---------- INTI REGRESI ----------

test("INTI REGRESI: sesi BARU dengan playId=1 saat latest=2 -> TIDAK basi", () => {
  const { g } = gen();
  // sesi bot lama sudah sampai playId 2
  g.note({ sessionId: A, playId: 1 });
  g.note({ sessionId: A, playId: 2 });
  assert.equal(g.latest(), 2);

  // bot di-restart: penghitungnya mulai dari 1 lagi
  assert.equal(g.isStale({ sessionId: B, playId: 1 }), false, "inilah bug yang memblokir semua trigger");
});

test("INTI REGRESI: mengadopsi sesi baru mereset penghitung dan MENCATATNYA", () => {
  const { g, events } = gen();
  g.note({ sessionId: A, playId: 7 });
  g.note({ sessionId: B, playId: 1 });

  assert.equal(g.session(), B);
  assert.equal(g.latest(), 1, "penghitung dimulai ulang untuk sesi baru");

  const adopt = events.filter(([e]) => e === "SERVICE_SESSION_ADOPTED");
  assert.equal(adopt.length, 2, "adopsi pertama dan pergantian keduanya tercatat");
  assert.equal(adopt[1][1].previous, A);
  assert.equal(adopt[1][1].resetFrom, 7, "angka yang dibuang ikut tercatat");
});

test("sesudah adopsi, aturan basi berlaku penuh LAGI di sesi baru", () => {
  const { g } = gen();
  g.note({ sessionId: A, playId: 9 });
  g.note({ sessionId: B, playId: 1 });
  g.note({ sessionId: B, playId: 2 });

  assert.equal(g.isStale({ sessionId: B, playId: 1 }), true, "basi tetap bekerja di dalam sesi");
  assert.equal(g.isStale({ sessionId: B, playId: 2 }), false);
});

// ---------- permintaan tanpa sessionId ----------

test("tanpa sessionId: sesi yang berjalan TIDAK berubah, aturan lama dipakai", () => {
  const { g, events } = gen();
  g.note({ sessionId: A, playId: 5 });

  // mis. curl diagnostik
  assert.equal(g.isStale({ playId: 3 }), true, "aturan lama: 3 < 5");
  g.note({ playId: 0 });

  assert.equal(g.session(), A, "sesi bot tidak boleh tergeser oleh alat diagnostik");
  assert.equal(g.latest(), 5);
  assert.equal(events.filter(([e]) => e === "SERVICE_SESSION_ADOPTED").length, 1);
});

test("sessionId kosong/spasi diperlakukan seperti tidak ada", () => {
  const { g } = gen();
  g.note({ sessionId: A, playId: 5 });
  for (const sid of ["", "   ", null, undefined]) {
    assert.equal(g.isStale({ sessionId: sid, playId: 3 }), true, JSON.stringify(sid));
    assert.equal(g.session(), A, JSON.stringify(sid));
  }
});

// ---------- tingkat service ----------

const CONSOLE = "https://shop.tiktok.com/streamer/live/product/dashboard";
const SHOP = "agen_mulia_abadi";
const PRODUK = "Produk Uji Satu";

function svc() {
  const calls = { pins: 0 };
  return {
    calls,
    s: createService({
      config: { consoleUrl: CONSOLE, expectedShop: SHOP, forbiddenShops: ["garudafood"] },
      allowAutoCommentSend: true,
      deps: {
        launchBrowser: async () => ({ id: "fake" }),
        getPage: async () => ({ url: () => CONSOLE, isClosed: () => false, bringToFront: async () => {} }),
        newPage: async () => ({ url: () => CONSOLE, isClosed: () => false }),
        openConsole: async () => ({ url: CONSOLE, settled: true, readyMs: 1 }),
        closeBrowser: async () => {},
        readIdentity: async () => [SHOP],
        waitForComposerReady: async () => ({ ready: true, ms: 0, polls: 1 }),
        collectProducts: async () => ({
          products: [{ number: 1, title: PRODUK, pinText: "Unpin", badges: [], pinButtons: 1, pinVisible: true, pinDisabled: false }],
          livePinButtonsOnPage: 1,
        }),
        pinProductByTitle: async (_p, key) => {
          calls.pins += 1;
          return { ok: true, title: PRODUK, key };
        },
        readPinState: async () => ({ found: true, buttons: 1, text: "Unpin" }),
        sleep: async () => {},
      },
    }),
  };
}

const doPin = (s, sessionId, playId) => s.handlePin({ scene: "PAX-1", productKey: "uji satu", playId, sessionId });

test("service: sesi sama -> playId mundur tetap ditolak basi", async () => {
  const { s, calls } = svc();
  assert.equal((await doPin(s, A, 5)).ok, true);
  const r = await doPin(s, A, 2);
  assert.equal(r.reason, "stale");
  assert.equal(calls.pins, 1, "pin basi tidak pernah diklik");
});

test("service: INTI REGRESI - restart bot (sesi baru, playId=1) tetap diterima", async () => {
  const { s, calls } = svc();
  assert.equal((await doPin(s, A, 1)).ok, true);
  assert.equal((await doPin(s, A, 2)).ok, true);
  assert.equal(s.__state().latestPlayId, 2);

  // bot di-restart
  const r = await doPin(s, B, 1);
  assert.equal(r.ok, true, "inilah yang dulu gagal dengan reason=stale");
  assert.equal(r.state, "Unpin");
  assert.equal(calls.pins, 3);
  assert.equal(s.__state().latestPlayId, 1, "generasi dimulai ulang untuk sesi baru");
});

test("service: generasi dipakai BERSAMA pin dan komentar di dalam satu sesi", async () => {
  const { s } = svc();
  await doPin(s, A, 11);
  // komentar milik scene lama di sesi yang sama -> basi
  const lama = await s.handleCommentSend({ text: "x", scene: "PAX-3", playId: 10, sessionId: A });
  assert.equal(lama.reason, "stale");
});

test("service: komentar dari sesi BARU dengan playId kecil TIDAK basi", async () => {
  const { s } = svc();
  await doPin(s, A, 11);
  const baru = await s.handleCommentSend({ text: "x", scene: "PAX-1", playId: 1, sessionId: B });
  assert.notEqual(baru.reason, "stale", "bot baru tidak boleh dianggap ketinggalan");
});

test("service: health melaporkan botId dan generasi, tanpa kata sensitif", async () => {
  const { s } = svc();
  await doPin(s, A, 4);
  const h = s.healthPayload();
  assert.equal(h.latestPlayId, 4);
  assert.equal(h.botId, A);
  assert.ok(!JSON.stringify(s.__state()).match(/cookie|token|password/i));
});

// ---------- pembuat ID ----------

test("newSessionId: unik antar panggilan dan berbentuk pendek", () => {
  const ids = new Set();
  for (let i = 0; i < 200; i += 1) ids.add(newSessionId({ pid: 1, now: () => 1000 + i, rand: () => i / 200 }));
  assert.equal(ids.size, 200, "tidak boleh bentrok");
  const one = newSessionId();
  assert.ok(one.length <= 64 && one.startsWith("b"), one);
});

test("newSessionId dipotong aman kalau kepanjangan", () => {
  const { g } = gen();
  g.note({ sessionId: "x".repeat(300), playId: 1 });
  assert.equal(g.session().length, 64, "dipotong, bukan disimpan utuh");
});
