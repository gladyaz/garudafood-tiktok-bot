// Anggaran waktu AutoPIN, diuji terhadap katalog sintetis 2 / 20 / 40 / 60 produk.
//
// Kegagalan yang dikejar di sini nyata. LIVE 2026-10-06, katalog 20 produk:
//
//   bot     : [AUTOPIN_FAILED] reason=send-rejected detail=This operation was aborted
//   service : [AUTOPIN_SERVICE_PINNED] after=Unpin via=snapshot-button reads=6
//
// Bot menyerah pada detik 8; service MENYELESAIKAN pin dan konfirmasinya. Jadi
// produknya benar-benar ter-pin, bot tidak tahu, dan chat ikut dilewati. Dua
// pihak, dua cerita.
//
// Yang dijaga berkas ini, dan urutannya memang begitu pentingnya:
//
//   1. service SELALU menjawab sebelum batas tunggu bot habis
//   2. kalau konfirmasi tidak akan kebagian waktu, pin TIDAK diklik sama sekali
//   3. tidak ada pekerjaan yang masih jalan sesudah service menjawab
//   4. paling banyak SATU klik pin, selamanya
//   5. chat tidak pernah terkonfirmasi dari pin yang tidak terkonfirmasi
//
// Jam dipalsukan: satu koleksi 20 produk memakan ~4,4 detik nyata, dan tes tidak
// boleh membayar itu belasan kali. Yang dimodelkan adalah BIAYA WAKTU; logika
// penggulirannya tetap kode produksi yang asli.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createService } = require("../autopin/service");
const { collectProducts } = require("../autopin/products");
const { planPinTimeouts, describePinTimeouts } = require("../autopin/pin-budget");
const { inspectPinResult } = require("../autopin/pin-result");
const { createAutoComment, PIN_POLICY } = require("../autocomment/core");

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

// `primaryBlind` meniru temuan LIVE: pada katalog besar sinyal tombol gagal
// 100% (primary=found=false di keenam bacaan).
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

  const pin = async () => {
    const t0 = clk.now();
    const r = await svc.handlePin({ scene: "PAX-1", productKey: KEY, playId: 1, sessionId: "s-1" });
    return { r, elapsed: clk.now() - t0 };
  };

  return { svc, pin, counters, clk, pinTimeouts };
}

// Gerbang sisi BOT, apa adanya. Kesepakatan diuji dengan menjalankan gerbang
// yang sebenarnya terhadap jawaban service.
const botGate = (r) => inspectPinResult(r);

// ===================================================================
// 1. Katalog 2 / 20 / 40 / 60 produk
// ===================================================================

test("KATALOG: service SELALU menjawab sebelum batas tunggu bot habis", () => {
  // Properti paling penting di berkas ini. Kalau ini pernah gagal, bot dan
  // service bisa punya cerita berbeda lagi.
  const hasil = [];
  const jobs = [
    { total: 2, targetPos: 2 },
    { total: 20, targetPos: 1 },
    { total: 20, targetPos: 10 },
    { total: 20, targetPos: 20 },
    { total: 40, targetPos: 20 },
    { total: 60, targetPos: 30 },
  ];
  return (async () => {
    for (const j of jobs) {
      const h = harness(j);
      const { r, elapsed } = await h.pin();
      hasil.push({ ...j, elapsed, reason: r.reason, ok: r.ok, clicks: h.counters.clicks });
      assert.ok(
        elapsed < h.pinTimeouts.httpTimeoutMs,
        `${j.total} produk: service menjawab di ${elapsed}ms, batas bot ${h.pinTimeouts.httpTimeoutMs}ms`
      );
      // Dan masih di dalam deadline internalnya, bukan cuma di dalam batas HTTP.
      assert.ok(
        elapsed <= h.pinTimeouts.browserDeadlineMs + SETTLE,
        `${j.total} produk: elapsed ${elapsed}ms melewati browserDeadline ${h.pinTimeouts.browserDeadlineMs}ms`
      );
    }
    for (const x of hasil) {
      report(`${x.total} produk (target #${x.targetPos})`, `${x.elapsed} ms  ${x.ok ? "ok" : x.reason}  clicks=${x.clicks}`);
    }
  })();
});

test("KATALOG 2 produk: pin berhasil, terkonfirmasi, TEPAT satu klik", async () => {
  const h = harness({ total: 2, targetPos: 2 });
  const { r, elapsed } = await h.pin();

  assert.equal(r.ok, true);
  assert.equal(r.state, "Unpin");
  assert.equal(h.counters.clicks, 1);
  assert.equal(botGate(r).confirmed, true, "bot dan service sepakat: terkonfirmasi");
  report("2 produk: total", elapsed + " ms, via=" + r.confirmedVia);
});

test("KATALOG 20 produk @8s berada DI BATAS: hasilnya boleh dua arah, invariannya tidak", async () => {
  // Jangan memaku hasil di titik batas. Terukur: dengan jam model collect-before
  // memakan 4.080 ms (sisa 2.640 >= cadangan 2.380 -> diklik), dengan timer nyata
  // 4.411 ms (sisa 2.298 < 2.380 -> ditolak). Selisih ~250 ms menentukan arahnya,
  // jadi tes yang memaku satu arah akan rapuh dan menyesatkan.
  //
  // Yang WAJIB benar di kedua arah: jawabannya sampai pada waktunya, kliknya
  // paling banyak satu, dan bot tidak pernah berbeda pendapat dengan service.
  const h = harness({ total: 20, targetPos: 10, httpTimeoutMs: 8_000 });
  const { r, elapsed } = await h.pin();

  assert.ok(elapsed < 8_000, "jawaban WAJIB sampai sebelum bot menyerah: " + elapsed);
  assert.ok(h.counters.clicks <= 1, "clicks=" + h.counters.clicks);

  const gate = botGate(r);
  if (r.ok) {
    assert.equal(h.counters.clicks, 1);
    assert.equal(gate.confirmed, true, "kalau diklik dan dilaporkan ok, harus terbukti");
  } else {
    assert.equal(h.counters.clicks, 0, "ditolak berarti NOL klik");
    assert.equal(r.clicked, false);
    assert.equal(gate.confirmed, false);
  }
  report("20 produk @8s (di batas)", elapsed + " ms -> " + (r.ok ? "diklik & terkonfirmasi" : r.reason));
});

test("ANGGARAN: timeout 7s dengan 20 produk -> PASTI ditolak sebelum klik", async () => {
  // Di sini tidak ada ambiguitas batas: koleksi selesai utuh, tapi cadangan
  // konfirmasi jelas tidak tersisa. Inilah gerbang sebelum-klik yang sebenarnya.
  const h = harness({ total: 20, targetPos: 10, httpTimeoutMs: 7_000 });
  const { r, elapsed } = await h.pin();

  assert.equal(r.ok, false, "reason=" + r.reason);
  assert.equal(r.reason, "budget-exhausted-before-click");
  assert.equal(r.clicked, false);
  assert.equal(h.counters.clicks, 0, "NOL klik: pin yang tak bisa dikonfirmasi tidak boleh terjadi");
  assert.ok(elapsed < 7_000, elapsed + " ms");
  report("20 produk @7s: ditolak di", elapsed + " ms, reason=" + r.reason);
});

test("KATALOG 20 produk dengan timeout 10s: pin BERHASIL, satu klik", async () => {
  // Ambang yang terukur: menaikkan AUTOPIN_TIMEOUT_MS ke 10 detik membuat
  // seluruh jalur muat, termasuk konfirmasi lewat snapshot.
  const h = harness({ total: 20, targetPos: 10, httpTimeoutMs: 10_000 });
  const { r, elapsed } = await h.pin();

  assert.equal(r.ok, true, "reason=" + r.reason);
  assert.equal(r.state, "Unpin");
  assert.equal(r.confirmedVia, "snapshot-button");
  assert.equal(h.counters.clicks, 1);
  assert.ok(elapsed < 10_000, elapsed + " ms");
  assert.equal(botGate(r).confirmed, true);
  report("20 produk @10s: berhasil di", elapsed + " ms, via=" + r.confirmedVia);
});

test("KATALOG 40 dan 60 produk: daftar tidak lengkap -> ditolak, NOL klik", async () => {
  for (const total of [40, 60]) {
    const h = harness({ total, targetPos: Math.floor(total / 2) });
    const { r } = await h.pin();
    assert.equal(r.ok, false, total + " produk");
    assert.equal(h.counters.clicks, 0, total + " produk: tidak boleh diklik dari daftar tak lengkap");
    // Alasannya harus jujur: BUKAN "produk tidak ada".
    assert.notEqual(r.reason, "product-not-found", total + " produk: jangan bilang produknya tidak ada");
    report(`${total} produk: ditolak`, r.reason);
  }
});

// ===================================================================
// 2. Sinyal snapshot, dan penghematan penghentian dini
// ===================================================================

test("SNAPSHOT: sinyal primer buta -> snapshot menyelamatkan, berhenti dini", async () => {
  const h = harness({ total: 20, targetPos: 1, httpTimeoutMs: 12_000, primaryBlind: true });
  const { r } = await h.pin();

  assert.equal(r.ok, true, "reason=" + r.reason);
  assert.equal(r.confirmedVia, "snapshot-button");
  assert.equal(h.counters.snapshots, 1, "snapshot dipanggil tepat sekali");
  report("snapshot dipakai", "ya, via=" + r.confirmedVia);
});

test("SNAPSHOT: penghentian dini MEMANG menghemat - posisi target mengubah biaya", async () => {
  const biaya = [];
  for (const pos of [1, 10, 20]) {
    const h = harness({ total: 20, targetPos: pos, httpTimeoutMs: 20_000 });
    const { r, elapsed } = await h.pin();
    assert.equal(r.ok, true, "pos " + pos + " reason=" + r.reason);
    biaya.push({ pos, elapsed });
    report(`target di #${pos}`, elapsed + " ms");
  }
  assert.ok(
    biaya[0].elapsed < biaya[2].elapsed,
    "target di awal harus lebih murah daripada di akhir: " + JSON.stringify(biaya)
  );
});

test("SNAPSHOT: sinyal primer terbaca -> snapshot TIDAK dipanggil", async () => {
  const h = harness({ total: 2, targetPos: 2, primaryBlind: false });
  const { r } = await h.pin();
  assert.equal(r.confirmedVia, "button-text");
  assert.equal(h.counters.snapshots, 0, "jawaban jelas tidak boleh dicari pembenarannya");
});

// ===================================================================
// 3 & 4. Anggaran habis, sebelum dan sesudah klik
// ===================================================================

test("ANGGARAN HABIS SEBELUM KLIK: tidak diklik, keduanya sepakat", async () => {
  // Pakai 7s, bukan 8s: 8s ada di titik batas dan arahnya bisa berubah.
  const h = harness({ total: 20, targetPos: 10, httpTimeoutMs: 7_000 });
  const { r } = await h.pin();

  assert.equal(h.counters.clicks, 0);
  assert.equal(r.clicked, false);
  const gate = botGate(r);
  assert.equal(gate.confirmed, false, "bot juga tidak menganggapnya terkonfirmasi");
  // Kesepakatan: service bilang tidak ok, bot gate juga tidak confirmed.
  assert.equal(r.ok, false);
});

test("ANGGARAN HABIS SESUDAH KLIK: dilaporkan jujur, nol klaim palsu, tetap satu klik", async () => {
  // Skenario patologis yang disengaja: satu operasi klik yang TIDAK BISA
  // dihentikan memakan lebih lama daripada seluruh sisa anggaran.
  //
  // BATAS DESAIN yang perlu dinyatakan terang: pada kasus ini service TIDAK
  // BISA sekaligus menyelesaikan operasinya dan menjawab pada waktunya. Pilihan
  // yang tersedia hanya dua - meninggalkan operasi yang masih jalan (yang
  // membuat pekerjaan berikutnya bisa tumpang tindih), atau menyelesaikannya
  // dan menjawab terlambat. Dipilih yang kedua, karena tumpang tindih bisa
  // berarti dua klik pada produk berbeda.
  //
  // Yang TETAP dijamin, dan itulah yang diuji di sini: satu klik saja, nol
  // klaim ter-pin tanpa bukti, dan bot tidak pernah ikut salah.
  const h = harness({ total: 2, targetPos: 2, httpTimeoutMs: 10_000, clickCostMs: 9_900 });
  const { r, elapsed } = await h.pin();

  assert.equal(h.counters.clicks, 1, "tepat satu klik");
  assert.ok(String(r.state || "").toLowerCase() !== "unpin", "tidak boleh mengklaim ter-pin tanpa bukti");
  assert.equal(botGate(r).confirmed, false, "bot juga tidak terkonfirmasi: tidak ada perbedaan pendapat");
  if (r.ok) assert.match(String(r.confirmReason || ""), /out-of-budget|unreadable/);
  report("habis sesudah klik", (r.ok ? 'ok state="" confirmReason=' + r.confirmReason : r.reason) + ", elapsed=" + elapsed + " ms, clicks=" + h.counters.clicks);
});

// ===================================================================
// 5. Tidak ada pekerjaan yang masih jalan sesudah service menjawab
// ===================================================================

test("NOL PEKERJAAN LATAR: sesudah service menjawab, halaman tidak disentuh lagi", async () => {
  for (const cfg of [
    { total: 2, targetPos: 2, httpTimeoutMs: 10_000 },
    { total: 20, targetPos: 10, httpTimeoutMs: 8_000 },
    { total: 60, targetPos: 30, httpTimeoutMs: 8_000 },
  ]) {
    const h = harness(cfg);
    await h.pin();
    const saatJawab = { ...h.counters };

    // Beri kesempatan apa pun yang tertinggal untuk berjalan.
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 30));

    assert.deepEqual(
      h.counters,
      saatJawab,
      `${cfg.total} produk: ada pekerjaan yang masih jalan sesudah jawaban - ini yang membuat operasi bisa tumpang tindih`
    );
  }
});

// ===================================================================
// 6 & 7. Satu klik, dan tidak ada konfirmasi chat yang palsu
// ===================================================================

test("SATU KLIK: apa pun hasilnya, pin diklik paling banyak sekali", async () => {
  for (const cfg of [
    { total: 2, targetPos: 2, httpTimeoutMs: 10_000 },
    { total: 20, targetPos: 10, httpTimeoutMs: 8_000 },
    { total: 20, targetPos: 10, httpTimeoutMs: 10_000 },
    { total: 40, targetPos: 20, httpTimeoutMs: 8_000 },
    { total: 2, targetPos: 2, httpTimeoutMs: 10_000, clickCostMs: 8_300 },
    { total: 2, targetPos: 2, httpTimeoutMs: 10_000, clickOk: false },
  ]) {
    const h = harness(cfg);
    await h.pin();
    assert.ok(h.counters.clicks <= 1, JSON.stringify(cfg) + " -> clicks=" + h.counters.clicks);
  }
});

test("NOL CHAT PALSU: AutoComment hanya terkirim saat pin benar-benar terkonfirmasi", async () => {
  const kirim = [];
  const mk = () =>
    createAutoComment({
      enabled: true,
      pinPolicy: PIN_POLICY.CONFIRMED,
      inspectPin: inspectPinResult,
      send: async (req) => {
        kirim.push(req.scene);
        return { ok: true };
      },
      maxPerMinute: 100,
      minIntervalMs: 0,
      logger: { log() {} },
    });

  // Ditolak sebelum klik -> chat WAJIB dilewati.
  const tolak = harness({ total: 20, targetPos: 10, httpTimeoutMs: 8_000 });
  const a = await tolak.pin();
  await mk().requestComment({ scene: "PAX-1", playId: 1, requesters: 1, pin: a.r });
  assert.deepEqual(kirim, [], "pin yang ditolak tidak boleh menghasilkan chat");

  // Terkonfirmasi -> chat boleh.
  const sukses = harness({ total: 20, targetPos: 10, httpTimeoutMs: 10_000 });
  const b = await sukses.pin();
  assert.equal(b.r.state, "Unpin");
  await mk().requestComment({ scene: "PAX-2", playId: 2, requesters: 1, pin: b.r });
  assert.deepEqual(kirim, ["PAX-2"], "hanya pin terkonfirmasi yang menghasilkan chat");
});

// ===================================================================
// 8. Kesepakatan bot dan service
// ===================================================================

test("KESEPAKATAN: verdict bot selalu konsisten dengan jawaban service", async () => {
  for (const cfg of [
    { total: 2, targetPos: 2, httpTimeoutMs: 10_000 },
    { total: 2, targetPos: 2, httpTimeoutMs: 10_000, primaryBlind: false },
    { total: 20, targetPos: 10, httpTimeoutMs: 8_000 },
    { total: 20, targetPos: 10, httpTimeoutMs: 10_000 },
    { total: 40, targetPos: 20, httpTimeoutMs: 8_000 },
    { total: 60, targetPos: 30, httpTimeoutMs: 12_000 },
  ]) {
    const h = harness(cfg);
    const { r, elapsed } = await h.pin();
    const gate = botGate(r);

    // Jawaban selalu sampai: itu syarat supaya ada kesepakatan sama sekali.
    assert.ok(elapsed < cfg.httpTimeoutMs, JSON.stringify(cfg) + " elapsed=" + elapsed);

    // Terkonfirmasi HANYA kalau service benar-benar mengklik dan membuktikannya.
    if (gate.confirmed) {
      assert.equal(r.ok, true, JSON.stringify(cfg));
      assert.equal(r.clicked, true, JSON.stringify(cfg));
      assert.equal(h.counters.clicks, 1, JSON.stringify(cfg));
    } else {
      // Tidak terkonfirmasi: tidak pernah ada klaim ter-pin.
      assert.notEqual(String(r.state || "").toLowerCase(), "unpin", JSON.stringify(cfg));
    }
  }
});

// ===================================================================
// Model anggaran itu sendiri
// ===================================================================

test("ANGGARAN: invarian browser + margin <= http, dan cadangan selalu ada", () => {
  for (const http of [3_000, 8_000, 10_000, 12_000, 20_000, 60_000]) {
    const t = planPinTimeouts({ httpTimeoutMs: http });
    assert.equal(t.fits, true, "http=" + http);
    assert.ok(t.browserDeadlineMs + t.marginMs <= t.httpTimeoutMs, describePinTimeouts(t));
    assert.ok(t.marginMs >= 1_000, describePinTimeouts(t));
    assert.ok(t.confirmReserveMs > 0, describePinTimeouts(t));
    assert.ok(t.primaryWindowMs > 0 && t.snapshotWindowMs > 0, describePinTimeouts(t));
    assert.ok(t.primaryWindowMs + t.snapshotWindowMs === t.confirmReserveMs, describePinTimeouts(t));
  }
});

test("ANGGARAN: timeout yang terlalu kecil dilaporkan fits=false, bukan didiamkan", () => {
  assert.equal(planPinTimeouts({ httpTimeoutMs: 1_000 }).fits, false);
});

test("ANGGARAN: nilai rusak jatuh ke default", () => {
  for (const bad of [undefined, null, 0, -5, "abc", NaN]) {
    assert.equal(planPinTimeouts({ httpTimeoutMs: bad }).httpTimeoutMs, 8_000, String(bad));
  }
});
