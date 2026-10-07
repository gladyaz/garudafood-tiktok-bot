// Simulasi OFFLINE 500 penonton terhadap pipeline produksi yang sebenarnya.
//
// ---------------------------------------------------------------------------
// APA YANG ASLI DI SINI, DAN APA YANG TIDAK
//
// Asli (kode produksi, bukan tiruan):
//   tiktok/chat-gate  -> index.js handleChat -> matcher -> agregasi antrean
//   -> pergantian scene -> autopin/scene-pin -> autopin/service (anggaran,
//      runner serial, dedupe playId) -> autocomment/core (gerbang pin)
//
// Palsu (hanya di tepi sistem):
//   OBS          -> obs.call dicatat, tidak ada WebSocket
//   halaman chat -> transport AutoComment mencatat, tidak mengirim ke mana pun
//   halaman produk -> daftar 20 produk ter-virtualisasi, biaya waktunya
//                     dimodelkan dari parameter nyata (settle 350 ms, eval 80 ms)
//
// ---------------------------------------------------------------------------
// YANG TIDAK BISA DIBUKTIKAN BERKAS INI
//
// Latensi DOM TikTok yang sebenarnya. Halaman palsu di sini patuh dan konsisten;
// halaman asli bisa menggantung, berubah selector, atau menyembunyikan baris
// yang baru saja di-pin (lihat autopin/pin-confirm.js). Jadi hijaunya berkas ini
// membuktikan LOGIKA dan SKALABILITAS, bukan integrasi platform. Satu validasi
// LIVE tetap diperlukan sesudah ini.
//
// Jam dipalsukan (setTimeout + Date lewat node:test). Semua biaya waktu mengalir
// lewat setTimeout, jadi tick() yang menggerakkan dunia - deterministik, dan
// 20 ribu komentar tidak perlu dibayar dengan puluhan detik nyata. Metrik
// performa (latensi, lag event loop) diukur dengan process.hrtime.bigint() yang
// TIDAK ikut dipalsukan, jadi angkanya tetap waktu nyata.

process.env.DOTENV_CONFIG_QUIET = "true";
process.env.SCENE_REPLAY_COOLDOWN_MS = "120000";

const { test, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");

const bot = require("../index.js");
const { createChatGate } = require("../tiktok/chat-gate");
const { createScenePin } = require("../autopin/scene-pin");
const { createAutoComment, PIN_POLICY } = require("../autocomment/core");
const { inspectPinResult } = require("../autopin/pin-result");
const { createService } = require("../autopin/service");
const { collectProducts } = require("../autopin/products");
const { planPinTimeouts } = require("../autopin/pin-budget");

// --- parameter yang ditiru dari lapangan -----------------------------------
const HTTP = 12_000; // AUTOPIN_TIMEOUT_MS yang hendak dipakai produksi
const KATALOG = 20;
// 100 ms, bukan 80 seperti di test/helpers/pin-harness.js. Dua alasan:
// waktu di sini dimajukan per 50 ms, jadi biaya yang bukan kelipatan 50 akan
// dibulatkan naik dan jadi artefak; dan 100 ms membuat simulasi ini kira-kira
// 10% lebih pesimis daripada model jam-eksak. Itu disengaja - dan hasilnya
// langsung terlihat: produk di posisi #20 yang di model punya sisa 1300 ms
// menjadi DITOLAK di sini. Lihat uji "DEGRADASI AMAN" di bawah.
const EVAL_MS = 100;
const SETTLE = 350;
const CLICK_MS = 200;
const CONSOLE = "https://shop.tiktok.com/streamer/live/product/dashboard";
const SHOP = "agen_mulia_abadi";
const SESSION = "sim-bot-1";

const GLOBAL_PAUSE_MS = 60_000;
const QUEUE_KICK_MS = 50;

// Scene -> posisi produk di katalog. Atas, tengah, bawah, plus satu lagi.
const POSISI_SCENE = { "PAX-1": 1, "PAX-2": 10, "PAX-3": 20, "PAX-4": 5 };

// Kunci produk: dua huruf, panjangnya sama, jadi tidak ada kunci yang menjadi
// potongan kunci lain (kalau tidak, resolusi produk jadi ambigu dan menolak).
const suffix = (n) => String.fromCharCode(97 + Math.floor((n - 1) / 26)) + String.fromCharCode(97 + ((n - 1) % 26));
const judulProduk = (n) => `Produk Uji ${n} SKU ${suffix(n).toUpperCase()}`;
const kunciProduk = (n) => `sku ${suffix(n)}`;

const report = (label, value) => process.stdout.write(`    ${label.padEnd(44)} ${value}\n`);
const flush = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function advance(ms) {
  mock.timers.tick(ms);
  await flush();
}

function persentil(arr, p) {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

// --- halaman produk palsu ---------------------------------------------------
// Daftar ter-virtualisasi: tiap gulir memunculkan beberapa baris, jadi
// collectProducts yang ASLI benar-benar harus menggulir. Biayanya lewat
// setTimeout, bukan jam sintetis, supaya sejalan dengan timer bot.
function halamanProduk(ctx) {
  let offset = 0;
  const ROWS = 3;
  return {
    url: () => CONSOLE,
    isClosed: () => false,
    bringToFront: async () => {},
    evaluate: async (fn, sel, step) => {
      ctx.masuk();
      try {
        await sleep(EVAL_MS);
        const src = fn.toString();
        if (/scrollTop\s*=\s*0/.test(src) || src.includes("resetScroll")) {
          offset = 0;
          return {};
        }
        if (/scrolled/.test(src) || src.includes("scrollBy")) {
          if (offset >= KATALOG) return { scrolled: false };
          offset += ROWS;
          return { scrolled: true };
        }
        const a = Math.max(0, offset - 6);
        const b = Math.min(KATALOG, offset + 6);
        const products = [];
        for (let i = a; i < b; i += 1) {
          const n = i + 1;
          products.push({
            number: n,
            title: judulProduk(n),
            rowInputs: 1,
            pinButtons: 1,
            pinVisible: true,
            pinDisabled: false,
            // Hanya produk yang BENAR-BENAR diklik yang berbunyi "Unpin".
            // Inilah yang membuat "salah produk" bisa ketahuan.
            pinText: n === ctx.terpin ? "Unpin" : "Pin",
            badges: [],
          });
        }
        return { products, numberInputsOnPage: KATALOG, livePinButtonsOnPage: products.length };
      } finally {
        ctx.keluar();
      }
    },
  };
}

// --- dunia simulasi ---------------------------------------------------------
function buatDunia() {
  const ctx = {
    terpin: 0,
    inflight: 0,
    maxInflight: 0,
    masuk() {
      this.inflight += 1;
      if (this.inflight > this.maxInflight) this.maxInflight = this.inflight;
    },
    keluar() {
      this.inflight -= 1;
    },
  };
  const metrik = {
    klikPin: 0,
    pinPerPlay: new Map(), // playId -> jumlah klik
    produkDiklik: [], // { scene, playId, number }
    chat: [], // { scene, playId, text }
    pinDurasi: [],
    antreTunggu: [],
    pinGagal: [],
  };

  const page = halamanProduk(ctx);
  const svc = createService({
    config: { consoleUrl: CONSOLE, expectedShop: SHOP, forbiddenShops: ["garudafood"] },
    pinTimeouts: planPinTimeouts({ httpTimeoutMs: HTTP }),
    deps: {
      launchBrowser: async () => ({ id: "fake" }),
      getPage: async () => page,
      newPage: async () => page,
      openConsole: async () => ({ url: CONSOLE, settled: true, readyMs: 1 }),
      closeBrowser: async () => {},
      readIdentity: async () => {
        await sleep(EVAL_MS);
        return [SHOP];
      },
      waitForComposerReady: async () => ({ ready: true, ms: 0, polls: 1 }),
      collectProducts: (p, opts = {}) => collectProducts(p, { settleMs: SETTLE, sleep, ...opts }),
      pinProductByTitle: async (_p, key, opts = {}) => {
        ctx.masuk();
        try {
          await sleep(CLICK_MS);
          const n = Number(
            Object.keys(POSISI_SCENE)
              .map((s) => POSISI_SCENE[s])
              .find((num) => kunciProduk(num) === String(key).trim().toLowerCase())
          );
          if (!Number.isFinite(n)) return { ok: false, reason: "row-not-rendered" };
          ctx.terpin = n; // mem-pin produk lain otomatis melepas yang lama
          metrik.klikPin += 1;
          metrik.produkDiklik.push({ number: n, key: String(key) });
          return { ok: true, title: judulProduk(n) };
        } finally {
          ctx.keluar();
        }
      },
      // Meniru temuan LIVE pada posisi dalam: sinyal tombol buta, jadi jalur
      // snapshot yang mahal itulah yang dipakai - kasus terburuknya.
      readPinState: async () => {
        await sleep(EVAL_MS);
        return { found: false };
      },
      sleep,
      now: () => Date.now(),
    },
  });

  // Dispatcher AutoPIN ASLI, transport-nya diarahkan ke service asli.
  const scenePin = createScenePin({
    enabled: true,
    mapping: Object.fromEntries(Object.entries(POSISI_SCENE).map(([s, n]) => [s, kunciProduk(n)])),
    timeoutMs: HTTP,
    logger: { log() {} },
    send: async ({ scene, productKey, playId }) => {
      const t0 = Date.now();
      const r = await svc.handlePin({ scene, productKey, playId, sessionId: SESSION });
      const ms = Date.now() - t0;
      metrik.pinDurasi.push(ms);
      const w = /queue-wait=(\d+)/.exec(r.timing || "");
      if (w) metrik.antreTunggu.push(Number(w[1]));
      if (r.ok && r.clicked === true) {
        metrik.pinPerPlay.set(playId, (metrik.pinPerPlay.get(playId) || 0) + 1);
        const last = metrik.produkDiklik[metrik.produkDiklik.length - 1];
        if (last) {
          last.scene = scene;
          last.playId = playId;
        }
      } else if (!r.ok) {
        metrik.pinGagal.push({ scene, playId, reason: r.reason });
      }
      return r;
    },
  });

  // AutoComment ASLI, dengan gerbang "hanya setelah pin terkonfirmasi".
  const autoComment = createAutoComment({
    enabled: true,
    pinPolicy: PIN_POLICY.CONFIRMED,
    inspectPin: inspectPinResult,
    maxPerMinute: 100_000,
    minIntervalMs: 0,
    logger: { log() {} },
    send: async (req) => {
      metrik.chat.push({ scene: req.scene, playId: req.playId, text: req.text });
      return { ok: true };
    },
  });

  bot.__test.setScenePin(scenePin);
  bot.__test.setAutoComment(autoComment);
  return { ctx, metrik, svc };
}

// --- lalu lintas penonton ---------------------------------------------------
const VARIAN = {
  1: ["spill etalase 1", "spill etalase satu", "spil etalse 1", "etalase 1 dong", "no 1", "produk 1"],
  2: ["spill etalase 2", "etalase dua", "spil etalase 2", "no 2", "spill etalase 2 kak"],
  3: ["spill etalase 3", "etalase tiga", "spill no 3", "produk tiga"],
};
const NOISE = [
  "halo kak",
  "ongkir ke bandung berapa",
  "kak itu ready ga",
  "mantap banget",
  "salam dari surabaya",
  "kapan diskon lagi",
];

// Campuran sesuai permintaan: 40% etalase 1, 25% etalase 2, 15% etalase 3,
// sisanya noise, spam berulang, antaran kembar, dan pesan host sendiri.
function buatLaluLintas(jumlah, penonton) {
  const out = [];
  let msgId = 0;
  for (let i = 0; i < jumlah; i += 1) {
    const r = (i * 7919) % 100; // deterministik, tanpa Math.random
    const v = `penonton-${i % penonton}`;
    let ev;
    if (r < 40) {
      ev = { nickname: v, comment: VARIAN[1][i % VARIAN[1].length], etalase: 1 };
    } else if (r < 65) {
      ev = { nickname: v, comment: VARIAN[2][i % VARIAN[2].length], etalase: 2 };
    } else if (r < 80) {
      ev = { nickname: v, comment: VARIAN[3][i % VARIAN[3].length], etalase: 3 };
    } else if (r < 88) {
      ev = { nickname: v, comment: NOISE[i % NOISE.length], etalase: 0 };
    } else if (r < 93) {
      // spam: satu penonton mengulang kalimat yang sama terus-menerus
      ev = { nickname: "pengganggu-" + (i % 5), comment: "spill etalase 1", etalase: 1, spam: true };
    } else if (r < 97) {
      // antaran kembar: msgId yang persis sama dikirim ulang
      ev = { nickname: v, comment: "spill etalase 2", etalase: 2, kembar: true };
    } else {
      // komentar dari akun host sendiri - tidak boleh memicu apa pun
      ev = { nickname: SHOP, uniqueId: SHOP, comment: "Etalase 1 sudah aku pin ya kak", host: true };
    }
    ev.msgId = ev.kembar ? "dup-" + (i % 20) : "m" + msgId++;
    out.push(ev);
  }
  return out;
}

// --- kerangka tes -----------------------------------------------------------
let dunia;
let gate;
let obsSwitches;
let logs;

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  logs = [];
  obsSwitches = [];
  const capture = (...a) => logs.push(a.map(String).join(" "));
  mock.method(console, "log", capture);
  mock.method(console, "warn", capture);
  mock.method(console, "error", capture);
  bot.obs.call = async (req, params = {}) => {
    if (req === "SetCurrentProgramScene") obsSwitches.push(params.sceneName);
  };
  dunia = buatDunia();
  // Gerbang chat ASLI, dirangkai persis seperti jalur konektor di index.js:
  //   verdict = chatGate.accept(data); if (!verdict.ok) return; handleChat(data);
  gate = createChatGate({ selfIdentities: [SHOP], logger: { log() {} } });
  gate.markConnected();
  bot.__test.reset();
});

afterEach(() => {
  bot.__test.reset();
  mock.timers.reset();
  mock.restoreAll();
});

// Satu antaran lewat jalur produksi, lengkap dengan gerbangnya.
function antar(ev) {
  let verdict;
  try {
    verdict = gate.accept(ev);
  } catch {
    return false;
  }
  if (!verdict || verdict.ok !== true) return false;
  bot.handleChat(ev);
  return true;
}

const state = () => bot.__test.getState();
const ruleFor = (scene) => bot.RULES.find((r) => r.scene === scene);

// Menyelesaikan scene yang sedang tayang lewat event media-end yang asli.
async function selesaikanScene(scene) {
  const rule = ruleFor(scene);
  for (const input of rule.mediaInputs || []) {
    if (input) bot.obs.emit("MediaInputPlaybackEnded", { inputName: input, inputUuid: "uuid-" + input });
  }
  await flush();
}

// Memajukan waktu SELANGKAH DEMI SELANGKAH sampai syaratnya terpenuhi.
//
// Ini bukan kerewelan: mock.timers.tick() menjalankan timer secara sinkron,
// sedangkan lanjutan `await` di belakangnya baru jalan sebagai microtask.
// Jadi satu tick besar hanya memajukan SATU langkah rantai async. AutoPIN
// katalog 20 produk punya puluhan langkah berurutan (gulir, settle, baca),
// jadi ia harus ditick berkali-kali diselingi flush - kalau tidak, pin-nya
// tidak pernah selesai dan tesnya lulus dengan tangan kosong.
async function majuSampai(syarat, { stepMs = 50, maxSteps = 1_200 } = {}) {
  for (let i = 0; i < maxSteps; i += 1) {
    if (syarat()) return true;
    mock.timers.tick(stepMs);
    await flush();
  }
  return syarat();
}

// Memutar satu scene sampai tuntas: mulai -> AutoPIN -> AutoComment -> media
// end -> jeda global. Mengembalikan nama scene yang tayang.
async function putarSatuScene() {
  await majuSampai(() => state().activeScene !== null, { stepMs: QUEUE_KICK_MS, maxSteps: 60 });
  const scene = state().activeScene;
  if (!scene) return null;

  // Tunggu AutoPIN playback ini benar-benar selesai (berhasil ATAU ditolak).
  const selesai = () => dunia.metrik.pinPerPlay.size + dunia.metrik.pinGagal.length;
  const sebelum = selesai();
  await majuSampai(() => selesai() > sebelum, { stepMs: 50, maxSteps: 1_200 });
  // Lalu beri AutoComment kesempatan menyusul.
  await majuSampai(() => false, { stepMs: 50, maxSteps: 20 });

  await selesaikanScene(scene);
  // Jeda global antar-scene, lalu antrean berikutnya diproses.
  await majuSampai(() => state().activeScene === null && state().busy === false, { stepMs: 1_000, maxSteps: 120 });
  return scene;
}

// ===================================================================
// 1. Simulasi besar
// ===================================================================

async function jalankanSimulasi(jumlahKomentar, penonton) {
  const traffic = buatLaluLintas(jumlahKomentar, penonton);

  const heapAwal = process.memoryUsage().heapUsed;
  const latensi = [];
  let lagMaks = 0;
  let diterima = 0;

  const t0 = process.hrtime.bigint();
  for (let i = 0; i < traffic.length; i += 1) {
    const a = process.hrtime.bigint();
    if (antar(traffic[i])) diterima += 1;
    latensi.push(Number(process.hrtime.bigint() - a) / 1e6);

    // Setiap 500 pesan, lepaskan event loop dan ukur keterlambatannya.
    if (i % 500 === 499) {
      const jadwal = process.hrtime.bigint();
      await flush();
      const lag = Number(process.hrtime.bigint() - jadwal) / 1e6;
      if (lag > lagMaks) lagMaks = lag;
    }
  }
  const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const heapAkhir = process.memoryUsage().heapUsed;

  return { traffic, latensi, lagMaks, diterima, totalMs, heapAwal, heapAkhir };
}

test("SIMULASI 500 PENONTON: 5.000 komentar -> antrean dibatasi scene, nol duplikat", async () => {
  const penonton = 500;
  const hasil = await jalankanSimulasi(5_000, penonton);
  const { metrik, ctx } = dunia;

  // --- antrean teragregasi, bukan satu entri per penonton ---
  const antreanPuncak = state().queue;
  const uniqueScenes = new Set(antreanPuncak.map((q) => q.scene));
  assert.ok(
    antreanPuncak.length <= Object.keys(POSISI_SCENE).length + 1,
    `antrean harus dibatasi jumlah scene, dapat ${antreanPuncak.length} entri`
  );
  assert.equal(antreanPuncak.length, uniqueScenes.size, "tidak boleh ada scene kembar di antrean");
  const totalPermintaan = antreanPuncak.reduce((s, q) => s + q.count, 0);

  // --- mainkan antreannya sampai habis ---
  const urutan = [];
  for (let i = 0; i < 8; i += 1) {
    const s = await putarSatuScene();
    if (!s) break;
    urutan.push(s);
  }

  // --- simulasi ini WAJIB benar-benar menjalankan jalurnya ---
  // Tanpa penjaga ini, semua perulangan di bawah akan melintasi map kosong dan
  // tesnya lulus tanpa membuktikan apa pun.
  assert.ok(metrik.pinPerPlay.size >= 1,
    `AutoPIN tidak pernah berhasil sekali pun - simulasinya tidak menguji apa-apa (gagal: ${JSON.stringify(metrik.pinGagal)})`);
  assert.ok(metrik.chat.length >= 1, "AutoComment tidak pernah terkirim - gerbangnya tidak teruji");
  assert.ok(urutan.length >= 1, "tidak ada scene yang tayang");
  assert.ok((gate.__state().counts["self-message"] || 0) > 0, "pesan host tidak pernah teruji");
  assert.ok((gate.__state().counts["duplicate-msg-id"] || 0) > 0, "antaran kembar tidak pernah teruji");

  // --- invarian pin & chat ---
  for (const [playId, n] of metrik.pinPerPlay) {
    assert.equal(n, 1, `playId ${playId} diklik ${n} kali, harus tepat 1`);
  }
  const chatPerPlay = new Map();
  for (const c of metrik.chat) chatPerPlay.set(c.playId, (chatPerPlay.get(c.playId) || 0) + 1);
  for (const [playId, n] of chatPerPlay) {
    assert.equal(n, 1, `playId ${playId} dapat ${n} chat, harus tepat 1`);
  }
  // Tiap chat harus punya pin terkonfirmasi untuk playId yang sama.
  for (const c of metrik.chat) {
    assert.equal(metrik.pinPerPlay.get(c.playId), 1, `chat playId ${c.playId} tanpa pin terkonfirmasi`);
  }
  // Degradasi aman: pin yang DITOLAK tidak boleh meninggalkan jejak apa pun -
  // tidak ada chat untuk playId itu, dan tidak ada klik yang tercatat untuknya.
  // Di simulasi ini posisi #20 memang tertolak (halamannya dimodelkan ~10%
  // lebih lambat daripada model jam-eksak), jadi jalur ini benar-benar teruji.
  for (const g of metrik.pinGagal) {
    assert.equal(metrik.pinPerPlay.get(g.playId), undefined,
      `pin ${g.scene} ditolak (${g.reason}) tapi tercatat mengklik`);
    assert.equal(metrik.chat.filter((c) => c.playId === g.playId).length, 0,
      `pin ${g.scene} ditolak (${g.reason}) tapi chat-nya tetap terkirim`);
  }

  // Produk yang diklik harus sesuai scene-nya - tidak boleh salah produk.
  for (const p of metrik.produkDiklik) {
    if (!p.scene) continue;
    assert.equal(p.number, POSISI_SCENE[p.scene], `scene ${p.scene} mem-pin produk #${p.number}, seharusnya #${POSISI_SCENE[p.scene]}`);
  }
  // Satu mutasi UI pada satu waktu.
  assert.equal(ctx.maxInflight, 1, `konkurensi mutasi browser harus 1, dapat ${ctx.maxInflight}`);

  // --- urutan scene deterministik, bukan acak ---
  assert.deepEqual(urutan, [...new Set(urutan)], "satu scene tidak boleh tayang dua kali dalam satu putaran");

  // --- memori berbatas ---
  const us = bot.__test.userStateStats();
  assert.ok(us.size <= us.maxSize, `state penonton harus berbatas: ${us.size}/${us.maxSize}`);

  // --- laporan ---
  const gs = gate.__state();
  report("total penonton unik", penonton);
  report("total komentar", hasil.traffic.length);
  report("komentar/detik (nyata)", Math.round(hasil.traffic.length / (hasil.totalMs / 1000)));
  report("lolos gerbang", hasil.diterima);
  report("ditolak gerbang (total)", hasil.traffic.length - hasil.diterima);
  report("  - pesan host sendiri", gs.counts["self-message"] || 0);
  report("  - antaran kembar", gs.counts["duplicate-msg-id"] || 0);
  report("MATCH (dari log)", logs.filter((l) => l.startsWith("[MATCH]")).length);
  report("antrean puncak (entri)", antreanPuncak.length + " entri / " + totalPermintaan + " permintaan");
  report("rasio agregasi", (totalPermintaan / Math.max(1, antreanPuncak.length)).toFixed(1) + "x");
  report("scene unik di antrean", uniqueScenes.size);
  report("urutan tayang", urutan.join(" -> ") || "(tidak ada)");
  report("AutoPIN: klik", metrik.klikPin);
  report("AutoPIN: sukses/gagal", metrik.pinPerPlay.size + " / " + metrik.pinGagal.length);
  if (metrik.pinGagal.length) report("AutoPIN: alasan gagal", JSON.stringify(metrik.pinGagal));
  report("AutoComment: terkirim", metrik.chat.length);
  report("konkurensi mutasi browser (maks)", ctx.maxInflight);
  report("latensi match p50/p95/p99 (ms)",
    persentil(hasil.latensi, 50).toFixed(4) + " / " + persentil(hasil.latensi, 95).toFixed(4) + " / " + persentil(hasil.latensi, 99).toFixed(4));
  report("lag event loop maks (ms)", hasil.lagMaks.toFixed(2));
  report("durasi AutoPIN p50/p95 (ms)",
    persentil(metrik.pinDurasi, 50) + " / " + persentil(metrik.pinDurasi, 95));
  report("tunggu antrean p50/p95 (ms)",
    metrik.antreTunggu.length ? persentil(metrik.antreTunggu, 50) + " / " + persentil(metrik.antreTunggu, 95) : "0 / 0");
  report("heap sebelum/sesudah (MB)",
    (hasil.heapAwal / 1048576).toFixed(1) + " / " + (hasil.heapAkhir / 1048576).toFixed(1));
  report("state penonton (entri/batas)", us.size + " / " + us.maxSize + "  dibuang=" + us.evicted);
});

test("SIMULASI 500 PENONTON: 20.000 komentar -> tetap bounded dan tetap tepat", async () => {
  const penonton = 500;
  const hasil = await jalankanSimulasi(20_000, penonton);
  const { metrik, ctx } = dunia;

  const antrean = state().queue;
  assert.ok(antrean.length <= Object.keys(POSISI_SCENE).length + 1, `antrean ${antrean.length} entri`);
  assert.equal(antrean.length, new Set(antrean.map((q) => q.scene)).size);

  for (let i = 0; i < 8; i += 1) if (!(await putarSatuScene())) break;

  assert.ok(metrik.pinPerPlay.size >= 1, "AutoPIN tidak pernah berhasil - simulasi 20rb tidak menguji apa-apa");
  assert.ok(metrik.chat.length >= 1, "AutoComment tidak pernah terkirim");
  for (const [playId, n] of metrik.pinPerPlay) assert.equal(n, 1, `playId ${playId}: ${n} klik`);
  const perChat = new Map();
  for (const c of metrik.chat) perChat.set(c.playId, (perChat.get(c.playId) || 0) + 1);
  for (const [playId, n] of perChat) assert.equal(n, 1, `playId ${playId}: ${n} chat`);
  for (const c of metrik.chat) assert.equal(metrik.pinPerPlay.get(c.playId), 1, "chat tanpa pin terkonfirmasi");
  assert.equal(ctx.maxInflight, 1, `konkurensi ${ctx.maxInflight}`);

  const us = bot.__test.userStateStats();
  assert.ok(us.size <= us.maxSize);

  report("20rb: komentar/detik (nyata)", Math.round(hasil.traffic.length / (hasil.totalMs / 1000)));
  report("20rb: latensi p50/p95/p99 (ms)",
    persentil(hasil.latensi, 50).toFixed(4) + " / " + persentil(hasil.latensi, 95).toFixed(4) + " / " + persentil(hasil.latensi, 99).toFixed(4));
  report("20rb: lag event loop maks (ms)", hasil.lagMaks.toFixed(2));
  report("20rb: antrean puncak", antrean.length + " entri");
  report("20rb: klik pin / chat", metrik.klikPin + " / " + metrik.chat.length);
  report("20rb: heap sebelum/sesudah (MB)",
    (hasil.heapAwal / 1048576).toFixed(1) + " / " + (hasil.heapAkhir / 1048576).toFixed(1));
  report("20rb: state penonton", us.size + " / " + us.maxSize);
});

// ===================================================================
// 2. Typo tidak boleh nyasar ke scene lain
// ===================================================================

test("TYPO: setiap varian dirutekan ke scene yang BENAR, tidak ada yang nyasar", async () => {
  for (const [etalase, varian] of Object.entries(VARIAN)) {
    const harapan = `PAX-${etalase}`;
    for (const kalimat of varian) {
      bot.__test.reset();
      obsSwitches.length = 0;
      antar({ nickname: "uji-" + kalimat.replace(/\W+/g, ""), comment: kalimat, msgId: "t" + Math.random() });
      await advance(QUEUE_KICK_MS);
      const aktif = bot.__test.getState().activeScene;
      assert.equal(aktif, harapan, `"${kalimat}" seharusnya ke ${harapan}, dapat ${aktif}`);
    }
  }
  report("varian typo diuji", Object.values(VARIAN).flat().length + " kalimat, 0 nyasar");
});

// ===================================================================
// 3. Urutan antrean banyak scene
// ===================================================================

test("ANTREAN BANYAK SCENE: urutannya deterministik, bukan pindah-pindah acak", async () => {
  // PAX-1 paling ramai, lalu PAX-2, PAX-3, PAX-4 - persis pola yang diminta.
  const beban = [["PAX-1", 180], ["PAX-2", 120], ["PAX-3", 70], ["PAX-4", 40]];
  for (const [scene, n] of beban) {
    const etalase = scene.split("-")[1];
    for (let i = 0; i < n; i += 1) {
      antar({ nickname: `p${scene}-${i}`, comment: `spill etalase ${etalase}`, msgId: `${scene}-${i}` });
    }
  }

  const antrean = state().queue;
  assert.equal(antrean.length, 4, `harus 4 entri (satu per scene), dapat ${antrean.length}`);
  assert.deepEqual(
    antrean.map((q) => q.scene),
    ["PAX-1", "PAX-2", "PAX-3", "PAX-4"],
    "urutan antrean harus mengikuti kedatangan pertama"
  );

  const urutan = [];
  for (let i = 0; i < 5; i += 1) {
    const s = await putarSatuScene();
    if (!s) break;
    urutan.push(s);
  }
  assert.deepEqual(urutan, ["PAX-1", "PAX-2", "PAX-3", "PAX-4"], "tayangnya harus berurutan, bukan acak");
  report("antrean 180/120/70/40", "4 entri -> " + urutan.join(" -> "));
});

// ===================================================================
// 4. Burst saat browser masih sibuk
// ===================================================================

test("BURST SAAT SIBUK: scene lain datang selagi AutoPIN jalan -> konkurensi tetap 1", async () => {
  const { ctx, metrik } = dunia;

  // PAX-1 mulai dan AutoPIN-nya berjalan (katalog 20 produk, beberapa detik).
  antar({ nickname: "a", comment: "spill etalase 1", msgId: "b1" });
  await advance(QUEUE_KICK_MS);
  assert.equal(state().activeScene, "PAX-1");

  // Selagi pin PAX-1 masih bekerja, tiga scene lain datang hampir bersamaan.
  await advance(1_500);
  for (const n of [2, 3, 4]) {
    for (let i = 0; i < 50; i += 1) {
      antar({ nickname: `burst${n}-${i}`, comment: `spill etalase ${n}`, msgId: `b${n}-${i}` });
    }
  }

  // Tuntaskan semuanya.
  for (let i = 0; i < 6; i += 1) {
    const s = await putarSatuScene();
    if (!s) break;
  }

  assert.equal(ctx.maxInflight, 1, `mutasi browser tidak boleh bertumpuk, dapat ${ctx.maxInflight}`);
  assert.ok(metrik.pinPerPlay.size >= 2,
    `burst ini harus memutar beberapa scene, dapat ${metrik.pinPerPlay.size} pin berhasil`);
  for (const [playId, n] of metrik.pinPerPlay) assert.equal(n, 1, `playId ${playId}: ${n} klik`);
  for (const p of metrik.produkDiklik) {
    if (p.scene) assert.equal(p.number, POSISI_SCENE[p.scene], `salah produk untuk ${p.scene}`);
  }
  report("burst saat sibuk", `konkurensi maks=${ctx.maxInflight} klik=${metrik.klikPin} chat=${metrik.chat.length}`);
});

// ===================================================================
// 5. Pesan host sendiri tidak pernah memicu scene
// ===================================================================

test("PESAN HOST: 2.000 komentar dari akun sendiri -> nol scene, nol pin, nol chat", async () => {
  const { metrik } = dunia;
  for (let i = 0; i < 2_000; i += 1) {
    antar({ nickname: SHOP, uniqueId: SHOP, comment: "spill etalase 1", msgId: "self" + i });
  }
  await advance(QUEUE_KICK_MS);

  assert.equal(state().activeScene, null, "pesan host tidak boleh memulai scene");
  assert.equal(state().queue.length, 0, "pesan host tidak boleh masuk antrean");
  assert.equal(metrik.klikPin, 0, "pesan host tidak boleh mem-pin apa pun");
  assert.equal(metrik.chat.length, 0, "pesan host tidak boleh memicu chat");
  report("2.000 pesan host", "0 scene, 0 pin, 0 chat");
});
