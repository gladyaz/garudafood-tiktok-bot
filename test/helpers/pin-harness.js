"use strict";
// Harness bersama untuk menguji anggaran waktu AutoPIN terhadap katalog sintetis.
//
// Dipakai oleh test/autopin.budget.test.js (model anggarannya) dan
// test/autopin.budget12.test.js (titik operasi 12 detik yang dipakai produksi).
// Satu salinan saja: kalau biaya yang dimodelkan di sini menyimpang antar berkas,
// dua berkas itu akan mengukur dunia yang berbeda tanpa ada yang sadar.
//
// Jam dipalsukan. Satu koleksi 20 produk memakan ~4,4 detik nyata, dan tes tidak
// boleh membayar itu berpuluh kali. Yang dipalsukan BIAYA WAKTU-nya; logika
// penggulirannya tetap kode produksi yang asli (`collectProducts` sungguhan
// berjalan di atas halaman palsu ini).

const { createService } = require("../../autopin/service");
const { collectProducts } = require("../../autopin/products");
const { planPinTimeouts } = require("../../autopin/pin-budget");
const { inspectPinResult } = require("../../autopin/pin-result");

const CONSOLE = "https://shop.tiktok.com/streamer/live/product/dashboard";
const SHOP = "agen_mulia_abadi";
const TARGET = "TARGET Kacang ATOM 16gr";
const KEY = "target kacang atom";

// Biaya yang dimodelkan, diambil dari parameter nyata: settleMs produksi 350 ms,
// dan satu page.evaluate ~80 ms.
const EVAL_MS = 80;
const SETTLE = 350;
const ROWS_PER_SCROLL = 3;

const report = (label, value) => process.stdout.write(`    ${label.padEnd(46)} ${value}\n`);

function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    sleep: async (ms) => {
      t += ms;
    },
  };
}

// Halaman palsu: daftar ter-virtualisasi, tiap gulir memunculkan beberapa baris.
// Setiap evaluate memajukan jam palsu, jadi anggaran benar-benar terasa.
function fakePage(clk, total, targetPos, counters) {
  let offset = 0;
  return {
    url: () => CONSOLE,
    isClosed: () => false,
    bringToFront: async () => {},
    evaluate: async (fn, sel, step) => {
      counters.evaluates += 1;
      clk.advance(EVAL_MS);
      const src = fn.toString();
      if (/scrollTop\s*=\s*0/.test(src) || src.includes("resetScroll")) {
        offset = 0;
        return {};
      }
      if (/scrolled/.test(src) || src.includes("scrollBy")) {
        if (offset >= total) return { scrolled: false };
        offset += ROWS_PER_SCROLL;
        return { scrolled: true };
      }
      const a = Math.max(0, offset - 6);
      const b = Math.min(total, offset + 6);
      const products = [];
      for (let i = a; i < b; i += 1) {
        const n = i + 1;
        products.push({
          number: n,
          title: n === targetPos ? TARGET : "Produk Lain " + n,
          rowInputs: 1,
          pinButtons: 1,
          pinVisible: true,
          pinDisabled: false,
          // Sesudah di-pin, snapshot melihat "Unpin" pada produk target.
          pinText: n === targetPos ? "Unpin" : "Pin",
          badges: [],
        });
      }
      return { products, numberInputsOnPage: total, livePinButtonsOnPage: products.length };
    },
  };
}

// `primaryBlind` meniru temuan LIVE 2026-10-06 pada posisi dalam: sinyal tombol
// gagal (primary=found=false di keenam bacaan). Tapi pada posisi #1 LIVE yang
// sama menunjukkan sinyal tombol JUSTRU terbaca di bacaan pertama, jadi kedua
// mode harus bisa diuji.
function harness({
  total = 20,
  targetPos = 10,
  httpTimeoutMs = 8_000,
  primaryBlind = true,
  clickCostMs = 200,
  clickOk = true,
} = {}) {
  const clk = clock();
  const counters = { evaluates: 0, clicks: 0, stateReads: 0, snapshots: 0 };
  const page = fakePage(clk, total, targetPos, counters);
  const pinTimeouts = planPinTimeouts({ httpTimeoutMs });

  const svc = createService({
    config: { consoleUrl: CONSOLE, expectedShop: SHOP, forbiddenShops: ["garudafood"] },
    pinTimeouts,
    deps: {
      launchBrowser: async () => ({ id: "fake" }),
      getPage: async () => page,
      newPage: async () => page,
      openConsole: async () => ({ url: CONSOLE, settled: true, readyMs: 1 }),
      closeBrowser: async () => {},
      readIdentity: async () => {
        clk.advance(EVAL_MS);
        return [SHOP];
      },
      waitForComposerReady: async () => ({ ready: true, ms: 0, polls: 1 }),
      // collectProducts ASLI di atas halaman palsu: penghentian dini dan
      // pemotongan anggaran benar-benar dijalankan, bukan dipalsukan.
      collectProducts: (p, opts = {}) => {
        if (opts.until) counters.snapshots += 1;
        return collectProducts(p, { settleMs: SETTLE, sleep: clk.sleep, ...opts });
      },
      pinProductByTitle: async (_p, _key, opts = {}) => {
        // Biaya penggulirannya dimodelkan; yang penting di sini adalah
        // jumlah kliknya dan apakah ia pernah terjadi.
        clk.advance(clickCostMs);
        if (!clickOk) return { ok: false, reason: "row-not-rendered" };
        counters.clicks += 1;
        return { ok: true, title: TARGET };
      },
      readPinState: async () => {
        counters.stateReads += 1;
        clk.advance(EVAL_MS);
        return primaryBlind ? { found: false } : { found: true, buttons: 1, text: "Unpin" };
      },
      sleep: clk.sleep,
      now: clk.now,
    },
  });

  // Nilai bawaannya sengaja sama dengan pemanggilan lama `h.pin()` supaya
  // berkas tes yang sudah ada tidak berubah artinya.
  const pin = async ({ scene = "PAX-1", playId = 1, sessionId = "s-1" } = {}) => {
    const t0 = clk.now();
    const r = await svc.handlePin({ scene, productKey: KEY, playId, sessionId });
    return { r, elapsed: clk.now() - t0 };
  };

  return { svc, pin, counters, clk, pinTimeouts };
}

// Gerbang sisi BOT, apa adanya. Kesepakatan diuji dengan menjalankan gerbang
// yang sebenarnya terhadap jawaban service.
const botGate = (r) => inspectPinResult(r);

module.exports = {
  harness, botGate, report, clock, fakePage,
  CONSOLE, SHOP, TARGET, KEY, EVAL_MS, SETTLE, ROWS_PER_SCROLL,
};
