"use strict";
// UJUNG-KE-UJUNG: aturan pin yang produknya tidak bisa ditarget TIDAK memutar
// scene-nya. Memakai antrean + processQueue PRODUKSI, dengan gerbang kelayakan
// yang NYATA - hanya pembaca katalognya yang dipalsukan (tidak ada service).
//
// Yang dibuktikan di sini dan tidak bisa dibuktikan oleh tes fungsi murni:
// OBS benar-benar tidak menerima SetCurrentProgramScene, pin tidak diminta,
// balasan tidak dikirim, dan antrean tetap hidup untuk aturan lain.

const { test, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");

const bot = require("../index.js");
const { COVERAGE } = require("../autopin/catalogue");

const TARGET = "Garuda - Kacang ATOM 16gr 1 RENCENG ISI 10 PCS oat - GRD";
const LAIN = "Chocolatos Wafer Roll Chocolate 32gr";

// BENTUK FIXTURE: TERNORMALISASI, bukan mentah.
//
// Gerbang kelayakan membaca snapshot katalog, dan snapshot itu membawa
// pinAvailable/pinDisabled - BUKAN pinButtons/pinVisible (lihat
// toSnapshotProduct di autopin/catalogue.js). Fixture versi pertama mengarang
// `pinButtons: 1`, dan karena itu ia menyembunyikan bug yang baru terlihat di
// LIVE nyata 2026-10-21: setiap produk sehat ditolak
// live-pin-control-not-available.
//
// Kontrak bentuknya diikat terpisah, lewat jalur penyimpanan PRODUKSI, di
// test/autopin.eligibilityshape.test.js.
const P = (number, title, extra = {}) =>
  Object.assign({ number, title, pinAvailable: true, pinDisabled: false }, extra);

let logs;
let obsSwitches;
let pinRequests;
let commentRequests;
let katalog; // diubah di tengah tes: etalase LIVE itu dinamis

function setKatalog(products, coverage = COVERAGE.FULL) {
  katalog = { ok: true, coverage, products, ageMs: 100 };
}

// Timer NYATA di berkas ini, sengaja.
//
// enqueueTrigger menunda processQueue 50 ms, dan gerbang kelayakan menunggu
// satu pembacaan katalog. Dengan mock.timers kedua penundaan itu harus dilepas
// dalam urutan yang tepat, dan versi pertama tes ini HIJAU karena salah: ia
// memeriksa sebelum baris skip-nya tercetak. Yang diuji di sini adalah
// keputusan gerbang, bukan waktu - jadi 90 ms nyata lebih jujur daripada
// orkestrasi timer palsu yang mudah salah.
const tunggu = (ms) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  logs = [];
  obsSwitches = [];
  pinRequests = [];
  commentRequests = [];
  const capture = (...args) => logs.push(args.map(String).join(" "));
  mock.method(console, "log", capture);
  mock.method(console, "warn", capture);
  mock.method(console, "error", capture);

  bot.obs.call = async (request, params = {}) => {
    if (request !== "SetCurrentProgramScene") return;
    obsSwitches.push(params.sceneName);
  };

  // Gerbang NYATA, pembaca PALSU.
  //
  // setProductEligibility DIPULIHKAN ke pemeriksa sungguhan di setiap tes.
  // Tanpa baris ini, afterEach di bawah meninggalkan stub permisif dan setiap
  // tes "harus tidur" sesudah yang pertama akan HIJAU karena alasan yang salah.
  bot.__test.setCatalogueReader(async () => katalog);
  bot.__test.setProductEligibility((rule) => bot.__test.productEligibilityOf(rule));
  bot.__test.setScenePin({
    requestPin: (req) => { pinRequests.push(req); return Promise.resolve({ ok: true, reason: "pinned", clicked: true, state: "Unpin" }); },
  });
  bot.__test.setAutoComment({
    requestComment: (req) => { commentRequests.push(req); return Promise.resolve({ ok: true }); },
  });
  bot.__test.reset();
  setKatalog([P(1, TARGET), P(2, LAIN)]);
});

afterEach(() => {
  mock.restoreAll();
  // Kembalikan gerbang ke bentuk netral supaya berkas tes lain tidak terpengaruh.
  bot.__test.setProductEligibility(() => Promise.resolve({ ok: true, reason: null }));
});

// Aturan PAX yang MEMIN.
const aturanPin = (scene, title) => ({
  scene,
  product: { title },
  triggers: ["spill " + scene],
  reply: "Etalase " + scene + " sudah aku pin ya kak",
  actions: { switchScene: true, autoPin: true, autoReply: true },
  duration: 5000,
});

// Menjalankan satu trigger sampai selesai.
//
// Dua hal yang HARUS dilepas, dan keduanya pernah membuat tes ini salah merah:
//   1. enqueueTrigger menunda processQueue 50 ms supaya permintaan yang
//      berdekatan bisa digabung menjadi satu entri;
//   2. gerbang kelayakan menunggu satu pembacaan katalog (microtask).
async function trigger(rule) {
  bot.enqueueTrigger(rule, "penonton");
  await tunggu(90);
}

const skipLines = () => logs.filter((l) => l.includes("[SKIP_PRODUCT_UNAVAILABLE]"));

// ===========================================================================

test("TARGET ADA: alur sukses tetap sama - scene, pin, balasan", async () => {
  await trigger(aturanPin("PAX-1", TARGET));

  assert.deepEqual(obsSwitches, ["PAX-1"], "scene harus diputar");
  assert.equal(pinRequests.length, 1, "pin harus diminta");
  assert.equal(commentRequests.length, 1, "balasan harus diminta");
  // Balasan tetap menuntut bukti pin, dan prioritasnya tetap HIGH.
  assert.equal(commentRequests[0].requirePin, true);
  assert.equal(commentRequests[0].priority, "high");
  assert.equal(skipLines().length, 0);
});

test("TARGET ABSEN: tanpa scene, tanpa pin, tanpa balasan", async () => {
  setKatalog([P(1, LAIN)]);
  await trigger(aturanPin("PAX-3", TARGET));

  assert.deepEqual(obsSwitches, [], "OBS TIDAK boleh menerima pergantian scene");
  assert.equal(pinRequests.length, 0, "pin TIDAK boleh diminta");
  assert.equal(commentRequests.length, 0, "balasan TIDAK boleh dikirim");
  assert.equal(skipLines().length, 1, JSON.stringify(skipLines()));
  assert.match(skipLines()[0], /scene=PAX-3 reason=product-not-found/);
  // Dan tidak ada aksi tertunda yang menunggu produknya muncul: tidak ada
  // timer yang dipasang gerbang, jadi menunggu lebih lama tidak memunculkan
  // scene/pin/balasan yang "menyusul".
  await tunggu(250);
  assert.deepEqual(obsSwitches, []);
  assert.equal(pinRequests.length, 0);
  assert.equal(commentRequests.length, 0);
});

test("TARGET AMBIGU: tanpa scene, tanpa pin, tanpa balasan, tanpa kandidat ditebak", async () => {
  setKatalog([P(1, "Gery Saluut Chocolate"), P(2, "Gery Saluut Malkist")]);
  await trigger(aturanPin("PAX-2", "Gery Saluut"));

  assert.deepEqual(obsSwitches, []);
  assert.equal(pinRequests.length, 0);
  assert.equal(commentRequests.length, 0);
  assert.match(skipLines()[0], /scene=PAX-2 reason=ambiguous-product/);
});

test("KONTROL PIN TIDAK TERSEDIA: tidur, bukan memutar", async () => {
  setKatalog([P(1, TARGET, { pinAvailable: false })]);
  await trigger(aturanPin("PAX-1", TARGET));

  assert.deepEqual(obsSwitches, []);
  assert.equal(pinRequests.length, 0);
  assert.match(skipLines()[0], /reason=live-pin-control-not-available/);
});

test("BUKTI TIDAK CUKUP: katalog viewport tanpa target -> tidur dengan alasan jujur", async () => {
  setKatalog([P(1, LAIN)], COVERAGE.VIEWPORT);
  await trigger(aturanPin("PAX-3", TARGET));

  assert.deepEqual(obsSwitches, []);
  assert.match(skipLines()[0], /reason=catalogue-coverage-insufficient/);
});

// KONTRA-CONTOH UJUNG-KE-UJUNG: keunikan viewport tidak boleh pernah memulai
// scene. Kalau ia memulainya, koleksi pin yang sungguhan bisa menemukan
// kembaran di luar viewport dan pin gagal SESUDAH video tayang.
test("KONTRA-CONTOH: satu kecocokan di VIEWPORT -> tanpa scene/pin/balasan", async () => {
  setKatalog([P(1, "Garuda Atom")], COVERAGE.VIEWPORT);
  await trigger(aturanPin("PAX-1", "Garuda Atom"));

  assert.deepEqual(obsSwitches, [], "scene TIDAK boleh mulai dari bukti viewport");
  assert.equal(pinRequests.length, 0);
  assert.equal(commentRequests.length, 0);
  assert.match(skipLines()[0], /reason=catalogue-coverage-insufficient/);
});

test("KONTRA-CONTOH: FULL memperlihatkan kembarannya -> ambiguous, tetap tidur", async () => {
  setKatalog([P(1, "Garuda Atom"), P(5, "Garuda Atom")], COVERAGE.FULL);
  await trigger(aturanPin("PAX-2", "Garuda Atom"));

  assert.deepEqual(obsSwitches, []);
  assert.equal(pinRequests.length, 0);
  assert.equal(commentRequests.length, 0);
  assert.match(skipLines()[0], /reason=ambiguous-product/);
});

test("KONTRA-CONTOH: FULL yang benar-benar unik -> alur PAX normal", async () => {
  setKatalog([P(1, "Garuda Atom")], COVERAGE.FULL);
  await trigger(aturanPin("PAX-1", "Garuda Atom"));

  assert.deepEqual(obsSwitches, ["PAX-1"]);
  assert.equal(pinRequests.length, 1);
  assert.equal(commentRequests.length, 1);
  assert.equal(commentRequests[0].requirePin, true);
  assert.equal(commentRequests[0].priority, "high");
  assert.equal(skipLines().length, 0);
});

test("NUDGE: bukti tidak cukup MEMINTA penyegaran FULL terjaga, tanpa menunggu", async () => {
  // Trigger itu sendiri tidak ditahan berdetik-detik; yang dilakukan hanyalah
  // menitipkan satu permintaan penyegaran supaya trigger BERIKUTNYA bisa jalan.
  const panggilan = [];
  bot.__test.setCatalogueReader(async (opts) => { panggilan.push(opts && opts.refresh); return katalog; });
  setKatalog([P(1, "Garuda Atom")], COVERAGE.VIEWPORT);

  await trigger(aturanPin("PAX-1", "Garuda Atom"));

  assert.deepEqual(obsSwitches, [], "tetap tidur");
  assert.ok(panggilan.includes("never"), "gerbangnya membaca snapshot yang ADA: " + JSON.stringify(panggilan));
  assert.ok(panggilan.includes("full"), "dan menitipkan nudge FULL: " + JSON.stringify(panggilan));
});

test("NUDGE: bukti yang CUKUP tidak menitipkan penyegaran apa pun", async () => {
  const panggilan = [];
  bot.__test.setCatalogueReader(async (opts) => { panggilan.push(opts && opts.refresh); return katalog; });
  setKatalog([P(1, "Garuda Atom")], COVERAGE.FULL);

  await trigger(aturanPin("PAX-1", "Garuda Atom"));

  assert.deepEqual(obsSwitches, ["PAX-1"]);
  assert.deepEqual(panggilan, ["never"], "tidak boleh ada sapuan yang diminta sia-sia");
});

test("KATALOG TIDAK TERSEDIA: tidur untuk aturan ITU, otomasi tetap jalan", async () => {
  katalog = { ok: false, error: "product-snapshot-unavailable" };
  await trigger(aturanPin("PAX-3", TARGET));
  assert.deepEqual(obsSwitches, []);
  assert.match(skipLines()[0], /reason=catalogue-unavailable/);

  // Aturan LAIN yang produknya ada tetap bisa main sesudahnya.
  setKatalog([P(1, TARGET)]);
  await trigger(aturanPin("PAX-1", TARGET));
  assert.deepEqual(obsSwitches, ["PAX-1"], "otomasi tidak boleh ikut mati");
});

test("DINAMIS: target ditambahkan kemudian -> jalan TANPA restart", async () => {
  // 1. absen
  setKatalog([P(1, LAIN)]);
  await trigger(aturanPin("PAX-3", TARGET));
  assert.deepEqual(obsSwitches, []);

  // 2. operator menambahkannya di tengah LIVE
  setKatalog([P(1, LAIN), P(2, TARGET)]);
  await trigger(aturanPin("PAX-3", TARGET));
  assert.deepEqual(obsSwitches, ["PAX-3"], "harus bisa main tanpa restart");
  assert.equal(pinRequests.length, 1);
});

test("DINAMIS: target dihapus lagi -> tidur lagi, aman", async () => {
  setKatalog([P(1, TARGET)]);
  await trigger(aturanPin("PAX-1", TARGET));
  assert.deepEqual(obsSwitches, ["PAX-1"]);

  // Scene selesai, lalu produknya dihapus operator.
  bot.endCurrentScene("test", false);
  bot.__test.reset();
  obsSwitches.length = 0;
  pinRequests.length = 0;
  setKatalog([P(1, LAIN)]);

  await trigger(aturanPin("PAX-1", TARGET));
  assert.deepEqual(obsSwitches, [], "harus tidur lagi");
  assert.equal(pinRequests.length, 0);
});

test("DINAMIS: ambiguitas dihapus -> pulih TANPA restart", async () => {
  setKatalog([P(1, "Gery Saluut Chocolate"), P(2, "Gery Saluut Malkist")]);
  await trigger(aturanPin("PAX-2", "Gery Saluut"));
  assert.deepEqual(obsSwitches, []);

  // Pesaingnya dihapus.
  setKatalog([P(1, "Gery Saluut Chocolate")]);
  await trigger(aturanPin("PAX-2", "Gery Saluut"));
  assert.deepEqual(obsSwitches, ["PAX-2"], "harus pulih tanpa restart");
});

test("DIURUT ULANG: identitas mengikuti judul; #1 yang baru tidak dipakai", async () => {
  // Target pindah dari #1 ke #4, dan produk lain menempati #1.
  setKatalog([
    P(1, "Dilan Waffle 1 BOX"),
    P(2, LAIN),
    P(3, "Okky Jelly 150ml"),
    P(4, TARGET),
  ]);
  await trigger(aturanPin("PAX-1", TARGET));

  assert.deepEqual(obsSwitches, ["PAX-1"], "target harus ditemukan di nomor barunya");
  assert.equal(pinRequests.length, 1);
});

test("ATURAN TANPA PIN tidak lewat gerbang sama sekali", async () => {
  // Katalog SENGAJA tidak tersedia: kalau gerbang ikut berlaku, FAQ akan mati.
  katalog = { ok: false, error: "product-snapshot-unavailable" };

  const faq = {
    scene: "PAX-5",
    product: { title: "Produk Yang Sudah Lama Hilang" },
    triggers: ["jam buka"],
    reply: "Buka tiap hari kak",
    actions: { switchScene: true, autoPin: false, autoReply: true },
    duration: 5000,
  };
  await trigger(faq);

  assert.deepEqual(obsSwitches, ["PAX-5"], "scene FAQ harus tetap diputar");
  assert.equal(pinRequests.length, 0, "FAQ memang tidak memin");
  assert.equal(commentRequests.length, 1, "balasan FAQ harus terkirim");
  assert.equal(commentRequests[0].requirePin, false, "FAQ tidak menuntut bukti pin");
  assert.equal(skipLines().length, 0, "tidak boleh ada baris skip untuk FAQ");
});

test("LOG tidak bising: alasan skip yang SAMA berturut-turut dicatat sekali", async () => {
  setKatalog([P(1, LAIN)]);
  const r = aturanPin("PAX-3", TARGET);
  // TANPA reset() di antaranya: reset berarti RUN BARU, dan run baru memang
  // harus mencatat baris pertamanya. Yang diuji di sini adalah empat trigger
  // dalam satu run yang sama.
  //
  // Aturan yang tidur tidak menandai playedScenes dan tidak memulai cooldown,
  // jadi trigger berikutnya benar-benar diproses lagi.
  for (let i = 0; i < 4; i += 1) await trigger(r);
  assert.equal(skipLines().length, 1, "harus satu baris, bukan empat: " + JSON.stringify(skipLines()));
});

test("LOG: alasan yang BERUBAH dicatat lagi", async () => {
  // Scene sendiri (PAX-4): dedupe-nya per KUNCI ATURAN, dan tes sebelumnya
  // sudah meninggalkan PAX-3 pada alasan yang sama.
  const r = aturanPin("PAX-4", TARGET);
  setKatalog([P(1, LAIN)]);
  await trigger(r);
  bot.endCurrentScene("test", false);
  bot.__test.reset();
  // Alasannya berubah: dari tidak ketemu menjadi bukti tidak tersedia.
  katalog = { ok: false, error: "product-snapshot-unavailable" };
  await trigger(r);

  const reasons = skipLines().map((l) => /reason=([a-z-]+)/.exec(l)[1]);
  assert.deepEqual(reasons, ["product-not-found", "catalogue-unavailable"]);
});

test("baris skip TIDAK membawa judul produk, harga, atau identitas penonton", async () => {
  setKatalog([P(1, LAIN)]);
  await trigger(aturanPin("PAX-3", TARGET));
  const line = skipLines()[0];
  assert.ok(!line.includes("Garuda"), line);
  assert.ok(!line.includes("Kacang"), line);
  assert.ok(!/penonton|user=|nickname/.test(line), line);
  assert.ok(!/Rp/.test(line), line);
  // Hanya scene + token alasan.
  assert.match(line, /^\[SKIP_PRODUCT_UNAVAILABLE\] scene=[A-Za-z0-9-]+ reason=[a-z-]+$/);
});
