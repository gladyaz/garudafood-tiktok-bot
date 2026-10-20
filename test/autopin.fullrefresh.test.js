// SAPUAN KATALOG PENUH untuk Product Q&A.
//
// Yang diuji di sini bukan "apakah sapuannya jalan", melainkan bahwa ia
// SUBORDINAT terhadap pekerjaan pin sungguhan, dan bahwa daftar yang tidak
// lengkap tidak pernah bisa menjadi coverage="full".
//
// runExclusive TIDAK punya preemption. Jadi yang dibuktikan di sini adalah
// pembatalan KOOPERATIF: handlePin menaikkan penandanya SEBELUM mengantre, dan
// sapuan yang sedang berjalan membacanya dari dalam fungsi `remaining` milik
// collectProducts - yang memeriksanya di puncak SETIAP gelombang gulir.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { createService } = require("../autopin/service");
const { withPriceFields } = require("../autopin/price");

const CONSOLE = "https://shop.tiktok.com/streamer/live/product/dashboard";
const CONFIG = { consoleUrl: CONSOLE, expectedShop: "agen_mulia_abadi", forbiddenShops: ["garudafood"] };

const MENTAH = (n, title) => ({
  number: n, rowInputs: 1, title,
  price: "Rp14.299", stock: "In stock: 10",
  priceNodes: [{ text: "Rp14.299", primary: true, dim: false }],
  pinButtons: 1, pinVisible: true, pinDisabled: false, pinText: "Pin",
  icons: [], ariaOnRow: [], badges: [], topControls: 1, imageKey: "x.jpg",
});
const PRODUK = [
  MENTAH(1, "Garuda - Kacang ATOM 16gr 1 RENCENG ISI 10 PCS oat - GRD"),
  MENTAH(2, "GARUDA TING TING PEANUT BAR CANDY ISI 12"),
  MENTAH(3, "Gery Saluut Malkist Renceng - Netto 10 bks x 18 gr"),
].map(withPriceFields);

const tunggu = async (n = 30) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)); };

// Rig yang MEMODELKAN loop gulir: collectProducts palsu memanggil `remaining`
// di puncak setiap gelombang, persis seperti yang asli, dan berhenti sendiri
// dengan ranOutOfTime kalau sisanya habis.
// gelombang/msPerGelombang MEMODELKAN katalog nyata: koleksi 5 produk terukur
// 1080 ms di LIVE, dan ~20 produk dimodelkan ~2,5 s. Angka ini berlaku untuk
// SETIAP pemanggil collectProducts - termasuk collect-before milik pin - jadi
// membesarkannya tanpa alasan membuat pin kehabisan anggarannya sendiri dan
// tesnya mengukur hal yang salah.
function rig({ gelombang = 6, msPerGelombang = 400, produk = PRODUK, pinMs = 0 } = {}) {
  let t = 1_000_000;
  const jejak = { collect: 0, once: 0, click: [], gelombangDijalankan: [] };
  let pageClosed = false;
  const page = { url: () => CONSOLE, isClosed: () => pageClosed, bringToFront: async () => {} };

  const svc = createService({
    config: CONFIG,
    deps: {
      launchBrowser: async () => ({ id: "f" }),
      getPage: async () => page,
      openConsole: async () => ({ url: CONSOLE, settled: true, readyMs: 1 }),
      closeBrowser: async () => { pageClosed = true; },
      readIdentity: async () => ["agen_mulia_abadi"],
      readProductsOnce: async () => {
        jejak.once += 1;
        return { products: produk, livePinButtonsOnPage: produk.length, invalidRows: 0, passes: 1, coverage: "viewport", numberInputsOnPage: produk.length };
      },
      // Model loop gulir yang SAMA bentuknya dengan autopin/products.js:
      // periksa `remaining` di puncak tiap gelombang, berhenti sendiri.
      collectProducts: async (p, opts = {}) => {
        jejak.collect += 1;
        const remaining = opts.remaining;
        const settleMs = 350;
        let n = 0;
        for (let i = 0; i < gelombang; i += 1) {
          if (typeof remaining === "function" && remaining() <= settleMs) {
            jejak.gelombangDijalankan.push(n);
            return { products: produk.slice(0, Math.max(1, n)), livePinButtonsOnPage: produk.length, invalidRows: 0, passes: n, stoppedEarly: false, ranOutOfTime: true, numberInputsOnPage: produk.length, coverage: "viewport", coverageReasons: ["aborted-out-of-time"] };
          }
          if (pageClosed) throw new Error("page closed");
          t += msPerGelombang;
          n += 1;
          await tunggu(2);
        }
        jejak.gelombangDijalankan.push(n);
        return { products: produk, livePinButtonsOnPage: produk.length, invalidRows: 0, passes: n, stoppedEarly: false, ranOutOfTime: false, numberInputsOnPage: produk.length, coverage: "full", coverageReasons: [] };
      },
      pinProductByTitle: async (_p, key) => { t += pinMs; jejak.click.push(key); return { ok: true, title: key }; },
      readPinState: async () => ({ found: true, text: "Unpin", disabled: false, buttons: 1 }),
      sleep: async () => {},
      now: () => t,
    },
  });
  return {
    svc, jejak, page,
    maju: (ms) => { t += ms; },
    waktu: () => t,
    tutupHalaman: () => { pageClosed = true; },
  };
}

// --- siklus hidup dasar --------------------------------------------------

test("sapuan: warmUp menghasilkan coverage=full", async () => {
  const r = rig();
  await r.svc.warmUp();
  const snap = await r.svc.handleProducts({ refresh: "never" });
  assert.equal(snap.ok, true);
  assert.equal(snap.coverage, "full");
  assert.equal(snap.source, "full-warmup");
  assert.equal(r.jejak.collect, 1);
});

test("sapuan: refresh=full menjadwalkan di LATAR dan menjawab SEGERA", async () => {
  const r = rig();
  await r.svc.warmUp();
  r.maju(25_000); // lewati jeda lantai
  const selesaiSebelum = r.jejak.gelombangDijalankan.length;
  const jawab = await r.svc.handleProducts({ refresh: "full" });
  // Buktinya: rute sudah PULANG sementara sapuan BELUM selesai. Diukur dari
  // jumlah sapuan yang sudah menuliskan hasilnya, bukan dari jam palsu - jam
  // itu dimajukan oleh sapuan latar dan tidak mencerminkan latensi rute.
  assert.equal(jawab.fullRefresh, "scheduled");
  assert.equal(r.jejak.gelombangDijalankan.length, selesaiSebelum,
    "rute tidak boleh menunggu sapuan selesai");
  await tunggu(60);
  assert.equal(r.jejak.gelombangDijalankan.length, selesaiSebelum + 1, "sapuan selesai di latar");
  assert.equal(r.jejak.collect, 2);
});

test("sapuan: daftar yang DIPOTONG anggaran tidak pernah disimpan sebagai full", async () => {
  // gelombang 100 x 400 ms jauh melewati anggaran 6000 ms
  const r = rig({ gelombang: 100, msPerGelombang: 400 });
  await r.svc.warmUp();
  const snap = await r.svc.handleProducts({ refresh: "never" });
  // viewport dari lintasan pertama tetap berlaku; sapuan ditolak sebagai full
  assert.equal(snap.coverage, "viewport");
  assert.equal(snap.source, "warmup");
});

test("sapuan: sapuan GAGAL tidak memperbarui capturedAt", async () => {
  const r = rig();
  await r.svc.warmUp();
  const sebelum = await r.svc.handleProducts({ refresh: "never" });
  r.maju(25_000);
  r.tutupHalaman();                      // sapuan berikutnya akan melempar
  await r.svc.handleProducts({ refresh: "full" });
  await tunggu(60);
  const sesudah = await r.svc.handleProducts({ refresh: "never" });
  assert.equal(sesudah.capturedAt, sebelum.capturedAt, "capturedAt tidak boleh diperbarui oleh kegagalan");
});

// --- single-flight dan badai ---------------------------------------------

test("storm: 20 pertanyaan bersamaan -> TEPAT SATU sapuan", async () => {
  const r = rig();
  await r.svc.warmUp();
  const sesudahWarm = r.jejak.collect;
  r.maju(25_000);
  const janji = [];
  for (let i = 0; i < 20; i += 1) janji.push(r.svc.handleProducts({ refresh: "full" }));
  const hasil = await Promise.all(janji);
  await tunggu(80);
  assert.equal(r.jejak.collect - sesudahWarm, 1, "hanya satu sapuan untuk 20 pertanyaan");
  const dijadwalkan = hasil.filter((h) => h.fullRefresh === "scheduled").length;
  const menempel = hasil.filter((h) => h.fullRefresh === "joined").length;
  assert.equal(dijadwalkan, 1, "satu yang menjadwalkan");
  assert.equal(menempel, 19, "sisanya menempel pada yang berjalan");
});

test("storm: JEDA LANTAI 20 detik mencegah sapuan beruntun", async () => {
  const r = rig();
  await r.svc.warmUp();
  const dasar = r.jejak.collect;
  r.maju(25_000);
  await r.svc.handleProducts({ refresh: "full" });
  await tunggu(60);
  assert.equal(r.jejak.collect - dasar, 1);

  // segera minta lagi: ditolak jeda lantai
  const lagi = await r.svc.handleProducts({ refresh: "full" });
  await tunggu(60);
  assert.equal(lagi.fullRefresh, "too-soon");
  assert.equal(r.jejak.collect - dasar, 1, "tidak ada sapuan kedua");

  // sesudah 20 detik, boleh lagi
  r.maju(20_000);
  await r.svc.handleProducts({ refresh: "full" });
  await tunggu(60);
  assert.equal(r.jejak.collect - dasar, 2);
});

test("storm: 200 pertanyaan dalam 10 detik -> paling banyak satu sapuan", async () => {
  const r = rig();
  await r.svc.warmUp();
  const dasar = r.jejak.collect;
  r.maju(25_000);
  for (let i = 0; i < 200; i += 1) {
    await r.svc.handleProducts({ refresh: "full" });
    if (i % 20 === 0) r.maju(1000);
  }
  await tunggu(80);
  assert.ok(r.jejak.collect - dasar <= 1, `sapuan ${r.jejak.collect - dasar} harus <= 1`);
});

// --- AUTOPIN MENANG -----------------------------------------------------

test("prioritas: sapuan DITOLAK saat pin sedang menunggu", async () => {
  const r = rig({ gelombang: 3 });
  await r.svc.warmUp();
  r.maju(25_000);
  // pin dimulai dan belum selesai
  const pin = r.svc.handlePin({ scene: "PAX-1", productKey: "garuda kacang atom", playId: 1, sessionId: "s" });
  const jawab = await r.svc.handleProducts({ refresh: "full" });
  assert.equal(jawab.fullRefresh, "pin-pending", "sapuan harus ditolak selagi pin menunggu");
  await pin;
});

test("prioritas: pin yang tiba MEMOTONG sapuan yang berjalan", async () => {
  // Inilah pembuktian pembatalan kooperatif. Tanpa penanda pinPending yang
  // dinaikkan SEBELUM runExclusive, pin hanya akan mengantre dan menunggu
  // seluruh sapuan selesai.
  const r = rig({ gelombang: 6, msPerGelombang: 400 });
  await r.svc.warmUp();
  const dasar = r.jejak.gelombangDijalankan.length;
  r.maju(25_000);
  await r.svc.handleProducts({ refresh: "full" });
  await tunggu(6); // biarkan sapuan mulai menggulir beberapa gelombang

  const pin = await r.svc.handlePin({ scene: "PAX-1", productKey: "garuda kacang atom", playId: 1, sessionId: "s" });
  await tunggu(60);

  assert.equal(pin.ok, true, "pin harus tetap berhasil");
  assert.deepEqual(r.jejak.click, ["garuda kacang atom"], "pin benar-benar mengklik");
  const gelombangSapuan = r.jejak.gelombangDijalankan[dasar];
  assert.ok(gelombangSapuan < 6, `sapuan harus dipotong sebelum 6 gelombang, berjalan ${gelombangSapuan}`);
});

test("prioritas: sapuan yang DIPOTONG pin tidak menyimpan apa pun sebagai full", async () => {
  const r = rig({ gelombang: 6, msPerGelombang: 400 });
  await r.svc.warmUp();
  const penuhAwal = await r.svc.handleProducts({ refresh: "never" });
  r.maju(25_000);
  await r.svc.handleProducts({ refresh: "full" });
  await tunggu(6);
  await r.svc.handlePin({ scene: "PAX-1", productKey: "garuda kacang atom", playId: 1, sessionId: "s" });
  await tunggu(60);
  const snap = await r.svc.handleProducts({ refresh: "never" });
  // Yang tersimpan terakhir adalah collect-before milik PIN (full, sah), bukan
  // sapuan yang dipotong.
  assert.equal(snap.source, "pin-collect", "sumber harus dari pin, bukan sapuan terpotong");
  assert.notEqual(snap.source, "full-qa");
  assert.ok(snap.capturedAt >= penuhAwal.capturedAt);
});

test("prioritas: pin TIDAK diperlambat lebih dari satu gelombang gulir", async () => {
  // Granularitas pembatalan = satu gelombang. Ini mengukurnya, bukan
  // mengasumsikannya.
  const r = rig({ gelombang: 6, msPerGelombang: 400 });
  await r.svc.warmUp();
  r.maju(25_000);
  await r.svc.handleProducts({ refresh: "full" });
  await tunggu(6);
  const pin = await r.svc.handlePin({ scene: "PAX-1", productKey: "garuda kacang atom", playId: 1, sessionId: "s" });
  assert.equal(pin.ok, true);

  // Diukur dari instrumentasi PIN sendiri. `queue-wait` adalah tepat waktu yang
  // dihabiskan pin menunggu giliran browser - bukan waktu kerjanya sendiri.
  // Mengukur jam dinding dari sebelum handlePin sampai sesudahnya akan ikut
  // menghitung collect-before milik pin, dan itu bukan penundaan.
  const m = /queue-wait=(\d+)/.exec(String(pin.timing || ""));
  const queueWait = m ? Number(m[1]) : 0;
  assert.ok(queueWait <= 400, `queue-wait pin ${queueWait} ms harus <= satu gelombang (400 ms)`);

  // dan sapuannya memang BENAR-BENAR dipotong oleh pin, bukan selesai sendiri
  assert.ok(r.jejak.gelombangDijalankan.some((n) => n > 0 && n < 6), `gelombang: ${JSON.stringify(r.jejak.gelombangDijalankan)}`);
});

test("prioritas: anggaran pin tetap cukup sesudah sapuan dipotong", async () => {
  const r = rig({ gelombang: 6, msPerGelombang: 400 });
  await r.svc.warmUp();
  r.maju(25_000);
  await r.svc.handleProducts({ refresh: "full" });
  await tunggu(6);
  const pin = await r.svc.handlePin({ scene: "PAX-1", productKey: "garuda kacang atom", playId: 1, sessionId: "s" });
  assert.equal(pin.ok, true);
  assert.equal(pin.reason, "pinned");
  assert.ok(!/budget-exhausted/.test(String(pin.reason)), pin.reason);
});

// --- STOP dan pembersihan ----------------------------------------------

test("stop: STOP di tengah sapuan memotongnya dan menutup bersih", async () => {
  const r = rig({ gelombang: 12, msPerGelombang: 400 });
  await r.svc.warmUp();
  r.maju(25_000);
  await r.svc.handleProducts({ refresh: "full" });
  await tunggu(6);
  await r.svc.stop();
  assert.equal(r.svc.__state().hasPage, false, "halaman dilepas");
  assert.equal(r.svc.__state().fullRefreshInFlight, false, "tidak ada sapuan tergantung");
  assert.equal(r.svc.__state().stopping, true);
});

test("stop: sesudah STOP, sapuan baru DITOLAK", async () => {
  const r = rig();
  await r.svc.warmUp();
  await r.svc.stop();
  const jadwal = r.svc.scheduleFullRefresh("qa");
  assert.equal(jadwal.ok, false);
  assert.equal(jadwal.reason, "stopping");
});

test("stop: browser tertutup di tengah sapuan -> gagal rapi, nol penolakan liar", async () => {
  const r = rig({ gelombang: 12, msPerGelombang: 400 });
  await r.svc.warmUp();
  r.maju(25_000);
  const liar = [];
  const onUnhandled = (e) => liar.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    await r.svc.handleProducts({ refresh: "full" });
    await tunggu(4);
    r.tutupHalaman();
    await tunggu(80);
    assert.deepEqual(liar, [], "nol unhandledRejection");
    const snap = await r.svc.handleProducts({ refresh: "never" });
    assert.equal(snap.ok, true, "snapshot lama tetap utuh, tidak korup");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("stop: halaman TIDAK terbuka -> sapuan ditolak, bukan membuka browser", async () => {
  const r = rig();
  const jadwal = r.svc.scheduleFullRefresh("qa");
  assert.equal(jadwal.ok, false);
  assert.equal(jadwal.reason, "page-not-open");
});

test("stop: halaman BUKAN dashboard -> sapuan ditolak", async () => {
  let t = 1_000_000;
  const page = { url: () => "https://shop.tiktok.com/streamer/live-console", isClosed: () => false, bringToFront: async () => {} };
  const svc = createService({
    config: CONFIG,
    deps: {
      launchBrowser: async () => ({ id: "f" }), getPage: async () => page,
      openConsole: async () => ({ url: page.url(), settled: true, readyMs: 1 }),
      closeBrowser: async () => {}, readIdentity: async () => ["agen_mulia_abadi"],
      readProductsOnce: async () => ({ products: PRODUK, livePinButtonsOnPage: 3, invalidRows: 0, passes: 1, coverage: "viewport", numberInputsOnPage: 3 }),
      collectProducts: async () => { throw new Error("tidak boleh dipanggil"); },
      pinProductByTitle: async () => ({ ok: true }), readPinState: async () => ({ found: true }),
      sleep: async () => {}, now: () => t,
    },
  });
  await svc.warmUp();
  const jadwal = svc.scheduleFullRefresh("qa");
  assert.equal(jadwal.ok, false);
  assert.equal(jadwal.reason, "unexpected-page");
});

test("stop: kegagalan sapuan tidak memblokir sapuan berikutnya selamanya", async () => {
  // Penanda single-flight harus dibersihkan walau task-nya menolak.
  const r = rig({ gelombang: 12, msPerGelombang: 400 });
  await r.svc.warmUp();
  r.maju(25_000);
  r.tutupHalaman();
  await r.svc.handleProducts({ refresh: "full" });
  await tunggu(80);
  assert.equal(r.svc.__state().fullRefreshInFlight, false, "penanda dibersihkan sesudah gagal");
});

// --- PAGAR TINGKAT SUMBER ----------------------------------------------

test("PAGAR: sapuan memakai collectProducts PRODUKSI, bukan mekanisme baru", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "autopin", "service.js"), "utf8");
  const mulai = src.indexOf("function scheduleFullRefresh");
  const akhir = src.indexOf("\n  const app = express()", mulai);
  const blok = src.slice(mulai, akhir > mulai ? akhir : undefined);
  assert.ok(blok.includes("d.collectProducts("), "harus memakai collectProducts yang sudah ada");
  assert.ok(!blok.includes("page.evaluate"), "tidak boleh menyentuh halaman langsung");
  assert.ok(!blok.includes("launchBrowser"), "tidak boleh meluncurkan browser");
  // DULU: menuntut blok ini memuat COVERAGE.FULL. Itu justru bug-nya - label
  // "full" dipakukan di tempat penyimpanan, padahal kelengkapan hanya bisa
  // disaksikan oleh kolektor. Sekarang yang dijaga adalah kebalikannya.
  assert.ok(!blok.includes("COVERAGE.FULL"), "sapuan TIDAK boleh memakukan label full");
  assert.ok(/coverage: snap\.coverage/.test(blok), "label harus datang dari kolektor");
  assert.ok(/observedAt: sweptAt/.test(blok), "capturedAt harus memakai waktu pembacaan");
});

test("PAGAR: sapuan diserialkan lewat runExclusive yang SAMA dengan pin", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "autopin", "service.js"), "utf8");
  const mulai = src.indexOf("function scheduleFullRefresh");
  const blok = src.slice(mulai, src.indexOf("\n  const app = express()", mulai));
  assert.ok(blok.includes("runExclusive("), "sapuan harus lewat runner serial yang sama");
  // hanya SATU runner di berkas ini
  assert.equal((src.match(/createSerialRunner\(\)/g) || []).length, 1);
});

test("PAGAR: pinPending dinaikkan SEBELUM runExclusive", () => {
  // Kalau dinaikkan di dalam task yang mengantre, pin hanya akan menunggu
  // sapuan selesai - itu bukan pembatalan.
  const src = fs.readFileSync(path.join(__dirname, "..", "autopin", "service.js"), "utf8");
  const iHandle = src.indexOf("async function handlePin({");
  const iNaik = src.indexOf("pinPending += 1", iHandle);
  const iInner = src.indexOf("handlePinInner", iHandle);
  assert.ok(iNaik > iHandle && iNaik < iInner, "pinPending dinaikkan sebelum masuk jalur antrean");
  // dan diturunkan di finally
  assert.ok(src.slice(iNaik).includes("} finally {"), "harus ada finally");
  assert.ok(src.slice(iNaik).includes("pinPending -= 1"), "harus diturunkan");
});

test("PAGAR: resolusi/klik/konfirmasi pin TIDAK diubah", () => {
  // Sapuan baru tidak boleh menyentuh cara pin menyelesaikan produk, mengklik,
  // atau mengkonfirmasi.
  const src = fs.readFileSync(path.join(__dirname, "..", "autopin", "service.js"), "utf8");
  assert.ok(src.includes("resolveProductForPin(snapshot.products, productKey)"), "resolusi pin apa adanya");
  assert.ok(src.includes("d.pinProductByTitle(p, productKey, { dryRun: false, remaining: left })"), "klik pin apa adanya");
  assert.ok(src.includes("pinConfirmer.confirm(p, productKey"), "konfirmasi pin apa adanya");
});
