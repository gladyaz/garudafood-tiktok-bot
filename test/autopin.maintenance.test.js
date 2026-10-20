"use strict";
// Pemeliharaan kesegaran katalog di latar: keputusan, backoff, dan keselamatan.
//
// Semua dengan JAM PALSU dan TIMER PALSU. Tidak ada setTimeout nyata, tidak ada
// browser, tidak ada tidur. Penjadwal yang diuji dengan menunggu waktu nyata
// hanya bisa diuji lambat dan goyah - dan yang paling penting di sini justru
// URUTAN: pin selalu menang.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const {
  createCatalogueMaintenance, decideMaintenance, isFailure, backoffFor,
  MAINT_THRESHOLD_MS, MAINT_BACKOFF_MS, MAINT_HOLD_CHECK_MS, DEFERRED,
} = require("../autopin/catalogue-maintenance");

const ROOT = path.resolve(__dirname, "..");
const FULL = (ageMs) => ({ has: true, coverage: "full", ageMs, count: 5 });
const VIEWPORT = (ageMs) => ({ has: true, coverage: "viewport", ageMs, count: 5 });
const KOSONG = { has: false };

// ===========================================================================
// KEPUTUSAN (fungsi murni)
// ===========================================================================

test("1. FULL umur 0 s: tidak menyegarkan", () => {
  const k = decideMaintenance({ now: 1000, snapshot: FULL(0) });
  assert.equal(k.act, false);
  assert.equal(k.reason, "fresh-full");
  assert.equal(k.nextCheckMs, MAINT_THRESHOLD_MS, "tidur tepat sampai ambang");
});

test("2. FULL umur 19.999 s: tidak menyegarkan", () => {
  const k = decideMaintenance({ now: 1000, snapshot: FULL(19_999) });
  assert.equal(k.act, false);
  assert.equal(k.reason, "fresh-full");
  assert.equal(k.nextCheckMs, 1, "sisa 1 ms menuju ambang");
});

test("3. FULL umur >= 20 s: satu penyegaran diminta", () => {
  for (const umur of [20_000, 20_001, 29_999, 45_000, 120_000]) {
    const k = decideMaintenance({ now: 1000, snapshot: FULL(umur) });
    assert.equal(k.act, true, "umur " + umur);
    assert.equal(k.reason, "stale-full");
  }
});

test("3b. ambang diturunkan dari angka yang ada, bukan dikarang", () => {
  const { QUOTE_FRESH_MS } = require("../autopin/catalogue");
  const src = fs.readFileSync(path.join(ROOT, "autopin", "service.js"), "utf8");
  const m = /FULL_REFRESH_BUDGET_MS = ([\d_]+)/.exec(src);
  assert.ok(m, "anggaran sapuan harus konstanta yang bisa dibaca");
  const anggaran = Number(m[1].replace(/_/g, ""));
  assert.equal(QUOTE_FRESH_MS, 30_000);
  assert.equal(anggaran, 6_000);
  // 30s umur kutip - 6s anggaran sapuan - 4s margin = 20s
  assert.equal(MAINT_THRESHOLD_MS, QUOTE_FRESH_MS - anggaran - 4_000);
  assert.ok(MAINT_THRESHOLD_MS + anggaran < QUOTE_FRESH_MS, "sapuan terburuk harus selesai sebelum kedaluwarsa");
});

test("tanpa snapshot sama sekali: menyegarkan", () => {
  const k = decideMaintenance({ now: 1000, snapshot: KOSONG });
  assert.equal(k.act, true);
  assert.equal(k.reason, "no-snapshot");
});

test("11. hanya ada snapshot viewport: berusaha mendapatkan FULL", () => {
  for (const umur of [0, 5_000, 19_000]) {
    const k = decideMaintenance({ now: 1000, snapshot: VIEWPORT(umur) });
    assert.equal(k.act, true, "viewport umur " + umur + " tetap bukan full");
    assert.equal(k.reason, "no-full-coverage");
  }
});

test("umur yang tidak terbaca diperlakukan sebagai alasan menyegarkan", () => {
  for (const umur of [undefined, null, NaN, -1, "lama"]) {
    const k = decideMaintenance({ now: 1000, snapshot: { has: true, coverage: "full", ageMs: umur } });
    assert.equal(k.act, true, "ageMs=" + String(umur));
  }
});

test("8. pin menunggu: pemeliharaan TIDAK dimulai", () => {
  const k = decideMaintenance({ now: 1000, snapshot: FULL(60_000), pinPending: true });
  assert.equal(k.act, false);
  assert.equal(k.reason, "pin-pending");
  assert.equal(k.nextCheckMs, MAINT_HOLD_CHECK_MS, "periksa lagi sebentar, tanpa menyelip");
});

test("sapuan lain sedang berjalan: tidak meminta yang kedua", () => {
  const k = decideMaintenance({ now: 1000, snapshot: FULL(60_000), inFlight: true });
  assert.equal(k.act, false);
  assert.equal(k.reason, "in-flight");
});

test("13. STOP: tidak ada pemeriksaan berikutnya sama sekali", () => {
  const k = decideMaintenance({ now: 1000, snapshot: KOSONG, stopping: true });
  assert.equal(k.act, false);
  assert.equal(k.reason, "stopping");
  assert.equal(k.nextCheckMs, null, "null = jangan jadwalkan apa pun");
});

test("STOP menang atas pin, in-flight, dan backoff", () => {
  for (const extra of [{ pinPending: true }, { inFlight: true }, { backoffUntil: 9_999_999 }]) {
    const k = decideMaintenance({ now: 1000, snapshot: KOSONG, stopping: true, ...extra });
    assert.equal(k.reason, "stopping", JSON.stringify(extra));
    assert.equal(k.nextCheckMs, null);
  }
});

test("7. backoff dihormati, dan tidurnya tepat sampai habis", () => {
  const k = decideMaintenance({ now: 10_000, snapshot: KOSONG, backoffUntil: 15_000 });
  assert.equal(k.act, false);
  assert.equal(k.reason, "backoff");
  assert.equal(k.nextCheckMs, 5_000);
  // dan begitu lewat, ia jalan lagi
  assert.equal(decideMaintenance({ now: 15_000, snapshot: KOSONG, backoffUntil: 15_000 }).act, true);
});

test("backoff: 5s -> 10s -> 20s, dibatasi 20s", () => {
  assert.deepEqual(MAINT_BACKOFF_MS, [5_000, 10_000, 20_000]);
  assert.equal(backoffFor(1), 5_000);
  assert.equal(backoffFor(2), 10_000);
  assert.equal(backoffFor(3), 20_000);
  assert.equal(backoffFor(4), 20_000, "dibatasi");
  assert.equal(backoffFor(99), 20_000);
  assert.equal(backoffFor(0), 0);
});

test("klasifikasi: penundaan BUKAN kegagalan", () => {
  assert.equal(isFailure({ ok: true }), false);
  for (const r of DEFERRED) assert.equal(isFailure({ ok: false, reason: r }), false, r);
  for (const r of ["empty", "error", "aborted-budget", "would-downgrade", "threw", ""]) {
    assert.equal(isFailure({ ok: false, reason: r }), true, r);
  }
  assert.equal(isFailure(null), true, "hasil yang hilang = gagal");
  assert.equal(isFailure(undefined), true);
});

// ===========================================================================
// PENJADWAL (timer palsu)
// ===========================================================================

function rig({ state = KOSONG, hasil = { ok: true, count: 5 }, pin = false, stop = false, inFlight = false } = {}) {
  let t = 1_000_000;
  let snapshot = state;
  let pinPending = pin;
  let stopping = stop;
  let sweeping = inFlight;
  const timers = [];
  const jejak = { requests: 0, log: [] };
  let hasilSekarang = hasil;

  const m = createCatalogueMaintenance({
    now: () => t,
    setTimer: (fn, ms) => { const h = { fn, at: t + ms }; timers.push(h); return h; },
    clearTimer: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
    readState: () => snapshot,
    isPinPending: () => pinPending,
    isStopping: () => stopping,
    isSweepInFlight: () => sweeping,
    requestRefresh: async () => {
      jejak.requests += 1;
      const r = typeof hasilSekarang === "function" ? hasilSekarang() : hasilSekarang;
      if (r && r.throwNow) throw new Error("sapuan meledak");
      return { ok: true, reason: "scheduled", task: Promise.resolve(r) };
    },
    log: (tag, f) => jejak.log.push(tag + " " + JSON.stringify(f || {})),
  });

  return {
    m, jejak, timers,
    waktu: () => t,
    maju: (ms) => { t += ms; },
    setSnapshot: (s) => { snapshot = s; },
    setPin: (v) => { pinPending = v; },
    setStop: (v) => { stopping = v; },
    setSweeping: (v) => { sweeping = v; },
    setHasil: (h) => { hasilSekarang = h; },
    // jalankan timer yang jatuh tempo, satu putaran
    async jalankanTimer() {
      const due = timers.filter((h) => h.at <= t);
      for (const h of due) {
        const i = timers.indexOf(h);
        if (i >= 0) timers.splice(i, 1);
        await h.fn();
      }
    },
    tagTerakhir: () => jejak.log[jejak.log.length - 1] || "",
    tagYangAda: (tag) => jejak.log.some((l) => l.startsWith(tag)),
  };
}

test("4. penyegaran berhasil: tidak langsung minta lagi", async () => {
  const r = rig({ state: KOSONG, hasil: { ok: true, count: 5, ms: 1100 } });
  r.m.start();
  await r.jalankanTimer();
  assert.equal(r.jejak.requests, 1);
  assert.ok(r.tagYangAda("CATALOGUE_MAINT_OK"));

  // Snapshot sekarang segar: pemeriksaan berikutnya harus MELEWATI.
  r.setSnapshot(FULL(0));
  r.maju(MAINT_HOLD_CHECK_MS);
  await r.jalankanTimer();
  assert.equal(r.jejak.requests, 1, "tidak ada permintaan kedua selagi masih segar");
  assert.ok(r.tagTerakhir().startsWith("CATALOGUE_MAINT_SKIPPED"));
  assert.match(r.tagTerakhir(), /fresh-full/);
  r.m.stop();
});

test("4b. penyegaran berhasil mereset backoff", async () => {
  const r = rig({ state: KOSONG, hasil: { ok: false, reason: "error" } });
  r.m.start();
  await r.jalankanTimer();
  assert.equal(r.m.stats().streak, 1);
  assert.ok(r.m.stats().backoffUntil > r.waktu());

  r.setHasil({ ok: true, count: 5 });
  r.maju(10_000);
  await r.jalankanTimer();
  assert.equal(r.m.stats().streak, 0, "berhasil -> streak nol");
  assert.equal(r.m.stats().backoffUntil, 0);
  r.m.stop();
});

test("5. banyak tik penjadwal: tetap hanya SATU sapuan in-flight", async () => {
  let lepas = null;
  const r = rig({ state: KOSONG });
  r.setHasil(() => ({ ok: true, count: 5 }));
  // requestRefresh yang menggantung: tik berikutnya tidak boleh ikut meminta.
  const asli = r.m.tick;
  r.m.start();
  const p1 = asli();            // mulai, menggantung di await
  const p2 = asli();            // tik kedua di tengah pekerjaan
  const p3 = asli();
  await Promise.all([p1, p2, p3]);
  assert.equal(r.jejak.requests, 1, "hanya satu permintaan: " + r.jejak.requests);
  assert.ok(lepas === null);
  r.m.stop();
});

test("6. kegagalan: TIDAK memalsukan kesegaran", async () => {
  const r = rig({ state: KOSONG, hasil: { ok: false, reason: "empty" } });
  r.m.start();
  await r.jalankanTimer();
  assert.equal(r.jejak.requests, 1);
  assert.ok(r.tagYangAda("CATALOGUE_MAINT_FAILED"));
  assert.ok(!r.tagYangAda("CATALOGUE_MAINT_OK"), "gagal tidak boleh dilaporkan ok");
  // Snapshot TIDAK disentuh oleh pemeliharaan: ia tetap kosong.
  assert.equal(r.m.stats().ok, 0);
  assert.equal(r.m.stats().failed, 1);
  r.m.stop();
});

test("7b. kegagalan berulang: backoff naik 5 -> 10 -> 20 dan berhenti di 20", async () => {
  const r = rig({ state: KOSONG, hasil: { ok: false, reason: "error" } });
  r.m.start();
  const diharapkan = [5_000, 10_000, 20_000, 20_000];
  for (let i = 0; i < diharapkan.length; i += 1) {
    const sebelum = r.waktu();
    await r.jalankanTimer();
    assert.equal(r.m.stats().streak, i + 1, "streak ke-" + (i + 1));
    assert.equal(r.m.stats().backoffUntil - sebelum, diharapkan[i], "backoff ke-" + (i + 1));
    // lewati backoff supaya percobaan berikutnya boleh jalan
    r.maju(diharapkan[i]);
    r.maju(MAINT_HOLD_CHECK_MS);
  }
  r.m.stop();
});

test("7c. selama backoff belum habis, tidak ada permintaan baru", async () => {
  const r = rig({ state: KOSONG, hasil: { ok: false, reason: "error" } });
  r.m.start();
  await r.jalankanTimer();
  assert.equal(r.jejak.requests, 1);
  r.maju(MAINT_HOLD_CHECK_MS);
  await r.jalankanTimer();
  assert.equal(r.jejak.requests, 1, "masih dalam backoff");
  assert.match(r.tagTerakhir(), /backoff/);
  r.maju(5_000);
  await r.jalankanTimer();
  assert.equal(r.jejak.requests, 2, "backoff habis -> coba lagi");
  r.m.stop();
});

test("8b. pin menunggu: penjadwal TIDAK meminta sapuan", async () => {
  const r = rig({ state: KOSONG, pin: true });
  r.m.start();
  await r.jalankanTimer();
  assert.equal(r.jejak.requests, 0, "pin menunggu -> nol permintaan");
  assert.match(r.tagTerakhir(), /pin-pending/);
  // dan begitu pin selesai, ia jalan
  r.setPin(false);
  r.maju(MAINT_HOLD_CHECK_MS);
  await r.jalankanTimer();
  assert.equal(r.jejak.requests, 1);
  r.m.stop();
});

test("9. pin datang saat sapuan berjalan: dilaporkan preempted, bukan gagal", async () => {
  const r = rig({ state: KOSONG, hasil: { ok: false, reason: "aborted-pin-preempted" } });
  r.m.start();
  await r.jalankanTimer();
  assert.equal(r.m.stats().cancelled, 1);
  assert.equal(r.m.stats().failed, 0, "preemption BUKAN kegagalan");
  assert.equal(r.m.stats().streak, 0, "dan tidak menaikkan backoff");
  assert.ok(r.tagYangAda("CATALOGUE_MAINT_CANCELLED"));
  r.m.stop();
});

test("10. pin menyumbang FULL segar: pemeliharaan jadi tidak perlu dan dilewati", async () => {
  const r = rig({ state: FULL(25_000) });
  r.m.start();
  // Pin menerbitkan full tepat sebelum tik pemeliharaan.
  r.setSnapshot(FULL(0));
  await r.jalankanTimer();
  assert.equal(r.jejak.requests, 0, "tidak perlu menyapu");
  assert.match(r.tagTerakhir(), /fresh-full/);
  r.m.stop();
});

test("12. keadaan katalog unknown: boleh coba lagi, TIDAK menyentuh filter", async () => {
  const r = rig({ state: KOSONG, hasil: { ok: false, reason: "error" } });
  r.m.start();
  await r.jalankanTimer();
  assert.equal(r.jejak.requests, 1, "boleh mencoba");
  // Satu-satunya jalan keluar modul ini adalah requestRefresh. Tidak ada
  // kemampuan mengetik/mengklik di mana pun di dalamnya.
  const src = fs.readFileSync(path.join(ROOT, "autopin", "catalogue-maintenance.js"), "utf8");
  for (const dilarang of [/\.click\s*\(/, /\.type\s*\(/, /setAttribute/, /\.value\s*=/, /page\./, /evaluate/]) {
    assert.ok(!dilarang.test(src), "pemeliharaan tidak boleh menyentuh DOM: " + dilarang);
  }
  r.m.stop();
});

test("13b. STOP: tidak ada penyegaran yang jalan sesudahnya", async () => {
  const r = rig({ state: KOSONG });
  r.m.start();
  r.setStop(true);
  await r.jalankanTimer();
  assert.equal(r.jejak.requests, 0);
  assert.equal(r.m.isRunning(), false, "penjadwal berhenti sendiri");
  assert.equal(r.m.hasTimer(), false, "tidak ada timer tertinggal");
  // dan tik paksa pun tidak melakukan apa pun
  await r.m.tick();
  assert.equal(r.jejak.requests, 0);
});

test("13c. STOP di setiap tahap: tidak ada timer dan tidak ada permintaan baru", async () => {
  // sebelum mulai
  {
    const r = rig({ state: KOSONG });
    r.m.stop();
    await r.m.tick();
    assert.equal(r.jejak.requests, 0);
    assert.equal(r.m.hasTimer(), false);
  }
  // sedang tidur menuju ambang
  {
    const r = rig({ state: FULL(0) });
    r.m.start();
    await r.jalankanTimer();
    assert.equal(r.m.hasTimer(), true, "ada timer tidur");
    r.m.stop();
    assert.equal(r.m.hasTimer(), false, "STOP membersihkannya");
    r.maju(MAINT_THRESHOLD_MS * 2);
    await r.jalankanTimer();
    assert.equal(r.jejak.requests, 0);
  }
  // mengantre di belakang pin
  {
    const r = rig({ state: KOSONG, pin: true });
    r.m.start();
    await r.jalankanTimer();
    r.m.stop();
    r.setPin(false);
    r.maju(10_000);
    await r.jalankanTimer();
    assert.equal(r.jejak.requests, 0);
  }
  // selagi sapuan berjalan: STOP tiba di tengah await
  {
    const r = rig({ state: KOSONG });
    let selesaikan = null;
    r.setHasil({ ok: true, count: 5 });
    const m = createCatalogueMaintenance({
      now: r.waktu,
      setTimer: (fn, ms) => ({ fn, at: 0 }),
      clearTimer: () => {},
      readState: () => KOSONG,
      isPinPending: () => false,
      isStopping: () => r.jejak.stopNow === true,
      isSweepInFlight: () => false,
      requestRefresh: () => new Promise((res) => { selesaikan = () => res({ ok: true, task: Promise.resolve({ ok: true, count: 5 }) }); }),
      log: () => {},
    });
    m.start();
    const p = m.tick();
    r.jejak.stopNow = true;         // STOP tiba selagi sapuan berjalan
    selesaikan();
    await p;
    assert.equal(m.isRunning(), false, "tidak menjadwalkan ulang sesudah STOP");
    assert.equal(m.hasTimer(), false);
  }
  // selama backoff
  {
    const r = rig({ state: KOSONG, hasil: { ok: false, reason: "error" } });
    r.m.start();
    await r.jalankanTimer();
    assert.ok(r.m.stats().backoffUntil > 0);
    r.m.stop();
    r.maju(60_000);
    await r.jalankanTimer();
    assert.equal(r.jejak.requests, 1, "tidak ada percobaan baru sesudah STOP");
  }
});

test("4c. jeda lantai: TIDAK ada badai permintaan setiap detik", async () => {
  // scheduleFullRefresh menolak dengan too-soon + retryAfterMs selagi jeda
  // lantai 20 detik berlaku. Kalau penjadwal mengabaikan retryAfterMs dan
  // memeriksa lagi tiap detik, satu LIVE 10 menit menghasilkan ratusan
  // permintaan untuk belasan sapuan - terukur 130 untuk 21 pada katalog lambat.
  const r = rig({ state: KOSONG, hasil: { ok: false, reason: "too-soon", retryAfterMs: 20_000 } });
  r.m.start();
  await r.jalankanTimer();
  assert.equal(r.jejak.requests, 1);

  // Satu detik kemudian TIDAK boleh ada permintaan baru.
  for (let i = 0; i < 10; i += 1) {
    r.maju(1_000);
    await r.jalankanTimer();
  }
  assert.equal(r.jejak.requests, 1, "masih dalam jeda lantai: " + r.jejak.requests);

  // Sesudah jeda lantainya habis, ia mencoba lagi.
  r.maju(11_000);
  await r.jalankanTimer();
  assert.equal(r.jejak.requests, 2);
  r.m.stop();
});

test("4d. penundaan tanpa retryAfterMs memakai jeda penundaan, bukan satu detik", async () => {
  const { MAINT_DEFER_CHECK_MS } = require("../autopin/catalogue-maintenance");
  const r = rig({ state: KOSONG, hasil: { ok: false, reason: "pin-pending" } });
  r.m.start();
  await r.jalankanTimer();
  assert.equal(r.jejak.requests, 1);
  r.maju(MAINT_DEFER_CHECK_MS - 1);
  await r.jalankanTimer();
  assert.equal(r.jejak.requests, 1, "belum waktunya");
  r.maju(1);
  await r.jalankanTimer();
  assert.equal(r.jejak.requests, 2);
  r.m.stop();
});

test("log: alasan skip yang SAMA berturut-turut dicatat sekali", async () => {
  const r = rig({ state: KOSONG, pin: true });
  r.m.start();
  for (let i = 0; i < 8; i += 1) {
    r.maju(MAINT_HOLD_CHECK_MS);
    await r.jalankanTimer();
  }
  const skips = r.jejak.log.filter((l) => l.startsWith("CATALOGUE_MAINT_SKIPPED"));
  assert.equal(skips.length, 1, "delapan pemeriksaan, satu baris: " + skips.length);
  assert.equal(r.m.stats().skipped >= 8, true, "tapi hitungannya tetap lengkap");

  // Alasan BERUBAH -> dicatat lagi.
  r.setPin(false);
  r.setSnapshot(FULL(0));
  r.maju(MAINT_HOLD_CHECK_MS);
  await r.jalankanTimer();
  const skips2 = r.jejak.log.filter((l) => l.startsWith("CATALOGUE_MAINT_SKIPPED"));
  assert.equal(skips2.length, 2);
  assert.match(skips2[1], /fresh-full/);
  r.m.stop();
});

test("DEFERRED cocok dengan alasan yang BENAR-BENAR dikembalikan service", () => {
  const src = fs.readFileSync(path.join(ROOT, "autopin", "service.js"), "utf8");
  const i = src.indexOf("function scheduleFullRefresh");
  const j = src.indexOf("createCatalogueMaintenance({");
  const blok = src.slice(i, j);
  const nyata = new Set();
  for (const m of blok.matchAll(/reason: "([a-z-]+)"/g)) nyata.add(m[1]);
  for (const r of DEFERRED) {
    if (r.startsWith("aborted-")) continue; // dibentuk dari template `aborted-${sebab}`
    assert.ok(nyata.has(r), "DEFERRED menyebut alasan yang tidak pernah muncul: " + r);
  }
  // page-not-open SENGAJA bukan penundaan: ia harus kena backoff.
  assert.ok(nyata.has("page-not-open"));
  assert.ok(!DEFERRED.includes("page-not-open"));
  assert.equal(isFailure({ ok: false, reason: "page-not-open" }), true);
});

test("4e. tick() PAKSA tidak bisa melewati jeda: penjaga ada di keputusan", async () => {
  // Penjaga yang hanya dihormati saat menjadwalkan timer bukan penjaga: satu
  // pemanggil yang menekan tick() lebih awal akan melewatinya. Di sini tick()
  // dipanggil langsung, berulang, tanpa timer sama sekali.
  const r = rig({ state: KOSONG, hasil: { ok: false, reason: "too-soon", retryAfterMs: 20_000 } });
  r.m.start();
  await r.m.tick();
  assert.equal(r.jejak.requests, 1);
  for (let i = 0; i < 15; i += 1) {
    r.maju(1_000);
    await r.m.tick();
  }
  assert.equal(r.jejak.requests, 1, "tick paksa tetap tertahan: " + r.jejak.requests);
  r.maju(6_000);
  await r.m.tick();
  assert.equal(r.jejak.requests, 2);
  r.m.stop();
});

test("4f. backoff kegagalan juga tidak bisa dilewati tick() paksa", async () => {
  const r = rig({ state: KOSONG, hasil: { ok: false, reason: "error" } });
  r.m.start();
  await r.m.tick();
  assert.equal(r.jejak.requests, 1);
  for (let i = 0; i < 4; i += 1) { r.maju(1_000); await r.m.tick(); }
  assert.equal(r.jejak.requests, 1, "masih dalam backoff 5 s");
  r.maju(1_000);
  await r.m.tick();
  assert.equal(r.jejak.requests, 2);
  r.m.stop();
});

test("sapuan yang MELEMPAR tidak menjatuhkan penjadwal, dan dihitung gagal", async () => {
  const r = rig({ state: KOSONG, hasil: { throwNow: true } });
  r.m.start();
  await r.jalankanTimer();
  assert.equal(r.m.stats().failed, 1);
  assert.ok(r.m.stats().backoffUntil > r.waktu());
  assert.equal(r.m.isRunning(), true, "tetap hidup");
  r.m.stop();
});

test("start dua kali tidak menghasilkan dua timer", async () => {
  const r = rig({ state: FULL(0) });
  r.m.start();
  await r.jalankanTimer();
  const n = r.timers.length;
  r.m.start();
  r.m.start();
  assert.equal(r.timers.length, n, "tidak ada timer kembar");
  r.m.stop();
});

// ===========================================================================
// INTEGRASI SERVICE + PRIVASI
// ===========================================================================

test("service: timer pemeliharaan di-unref supaya tidak menahan proses", () => {
  const src = fs.readFileSync(path.join(ROOT, "autopin", "service.js"), "utf8");
  const i = src.indexOf("createCatalogueMaintenance({");
  assert.ok(i > 0, "pemeliharaan harus dipasang di service");
  const blok = src.slice(i, i + 1_200);
  assert.match(blok, /t\.unref\(\)/, "timer wajib di-unref");
  assert.match(blok, /requestRefresh: \(\) => scheduleFullRefresh\("maintenance"\)/, "harus memakai sapuan yang SAMA");
  assert.match(blok, /isPinPending: \(\) => pinPending > 0/);
  assert.match(blok, /isStopping: \(\) => stopping === true/);
  assert.match(blok, /isSweepInFlight: \(\) => !!fullRefresh/);
});

test("service: STOP mematikan penjadwal LEBIH DULU", () => {
  const src = fs.readFileSync(path.join(ROOT, "autopin", "service.js"), "utf8");
  const i = src.indexOf("async function stop() {");
  const blok = src.slice(i, i + 600);
  const iMaint = blok.indexOf("maintenance.stop()");
  const iStopping = blok.indexOf("stopping = true");
  assert.ok(iMaint > 0, "stop() harus mematikan pemeliharaan");
  assert.ok(iMaint < iStopping, "dimatikan sebelum apa pun yang lain");
});

test("service: TIDAK ada implementasi sapuan kedua", () => {
  const src = fs.readFileSync(path.join(ROOT, "autopin", "catalogue-maintenance.js"), "utf8");
  for (const dilarang of [/collectProducts/, /launchBrowser/, /readProductsOnce/, /discover/i, /puppeteer/i]) {
    assert.ok(!dilarang.test(src), "pemeliharaan tidak boleh punya jalur sapuan sendiri: " + dilarang);
  }
});

// ===========================================================================
// JEJAK DUKUNGAN: dibuktikan dari baris yang BENAR-BENAR dicetak
// ===========================================================================
//
// Versi pertama tes ini menuliskan sendiri daftar tag yang diharapkan
// ("AUTOPIN_SERVICE_CATALOGUE_MAINT_*") dan memeriksa shouldTrace atasnya. Itu
// membuktikan hal yang salah: tag itu TIDAK PERNAH dipancarkan. Yang dipakai
// modul ini adalah log() produksi dari autopin/core.js, dan ia mencetak
// `[AUTOPIN_${tag}]` - jadi literal "CATALOGUE_MAINT_OK" sampai ke log sebagai
// "AUTOPIN_CATALOGUE_MAINT_OK", tanpa segmen SERVICE_.
//
// Tes yang menuliskan sendiri tag yang diharapkan akan tetap hijau walau tag
// sebenarnya diganti menjadi sesuatu yang TIDAK terlihat di jejak dukungan.
// Jadi tag-nya sekarang DITANGKAP dari modul: kalau namanya berubah, atau
// prefiks log berubah, tes ini ikut berubah dengan sendirinya.

// Menjalankan pemeliharaan dengan log PRODUKSI dan menangkap stdout-nya.
async function tangkapBaris() {
  const { log } = require("../autopin/core");
  const keluar = [];
  const asli = console.log;
  console.log = (...a) => keluar.push(a.join(" "));
  try {
    const jalankan = async ({ state, hasil, pin = false }) => {
      let t = 1_000_000;
      const m = createCatalogueMaintenance({
        now: () => t,
        setTimer: () => null,
        clearTimer: () => {},
        readState: () => state,
        isPinPending: () => pin,
        isStopping: () => false,
        isSweepInFlight: () => false,
        requestRefresh: async () => ({ ok: true, reason: "scheduled", task: Promise.resolve(hasil) }),
        log,
      });
      m.start();
      await m.tick();
      m.stop();
    };
    // Kelima keadaan yang WAJIB bisa dibedakan operator.
    await jalankan({ state: KOSONG, hasil: { ok: true, count: 5, ms: 1180, coverage: "full" } });
    await jalankan({ state: FULL(0), hasil: { ok: true } });
    await jalankan({ state: KOSONG, hasil: { ok: true }, pin: true });
    await jalankan({ state: KOSONG, hasil: { ok: false, reason: "empty" } });
    await jalankan({ state: KOSONG, hasil: { ok: false, reason: "aborted-pin-preempted" } });
  } finally {
    console.log = asli;
  }
  return keluar;
}

test("JEJAK: setiap tag yang BENAR-BENAR dipancarkan lolos shouldTrace produksi", async () => {
  const { shouldTrace, traceTagOf, TRACE_FAMILIES, TRACE_TAGS, TRACE_DENY } = require("../controller/child-trace");
  const baris = await tangkapBaris();
  assert.ok(baris.length >= 5, "harus ada baris yang tertangkap: " + baris.length);

  const tags = new Set();
  for (const b of baris) {
    const tag = traceTagOf(b);
    assert.ok(tag !== null, "baris tanpa tag tidak akan pernah masuk jejak: " + b);
    tags.add(tag);
    assert.equal(shouldTrace(b), true, "tag tidak terlihat di jejak dukungan: " + tag);
  }

  // MEKANISMENYA, bukan sekadar "lolos lewat salah satu".
  //
  // `lewatKeluarga || lewatDaftar` dulu cukup untuk membuktikan bahwa tag-nya
  // terlihat, tapi ia tidak mengikat LEWAT APA. Kalau suatu hari keluarga
  // "AUTOPIN_" dihapus dan kelima tag didaftarkan satu-satu di TRACE_TAGS,
  // tes berbentuk OR tetap hijau - padahal kebijakannya sudah berubah, dan
  // tag pemeliharaan BERIKUTNYA tidak akan ikut terlihat lagi.
  //
  // Jadi yang diikat di sini adalah: kelimanya lolos lewat PREFIKS KELUARGA,
  // tidak satu pun didaftarkan eksplisit, dan tidak satu pun ditolak.
  const keluargaDipakai = new Set();
  for (const tag of tags) {
    assert.match(tag, /^AUTOPIN_CATALOGUE_MAINT_/, "bentuk tag yang dipancarkan berubah: " + tag);

    const keluarga = TRACE_FAMILIES.filter((p) => tag.startsWith(p));
    assert.deepEqual(keluarga, ["AUTOPIN_"],
      tag + " harus lolos TEPAT lewat prefiks keluarga AUTOPIN_, bukan yang lain: " + keluarga.join(","));
    keluargaDipakai.add(keluarga[0]);

    assert.ok(!TRACE_TAGS.includes(tag),
      tag + " tidak boleh didaftarkan eksplisit - keluarga sudah menanggungnya, " +
      "dan dua jalur untuk hal yang sama akan menyimpang");
    assert.ok(!TRACE_DENY.includes(tag), tag + " tidak boleh ada di daftar TOLAK");
  }
  assert.deepEqual([...keluargaDipakai], ["AUTOPIN_"], "satu mekanisme untuk kelimanya");

  // Dan konsekuensinya dinyatakan: karena yang menanggung adalah PREFIKS,
  // tag CATALOGUE_MAINT_* baru apa pun otomatis ikut terlihat tanpa menyentuh
  // controller/child-trace.js. Itulah alasan tidak ada perubahan produksi yang
  // dibutuhkan untuk mengekspos kelima event ini.
  assert.equal(shouldTrace("[AUTOPIN_CATALOGUE_MAINT_SESUATU_YANG_BARU] reason=x"), true,
    "prefiks keluarga harus menanggung tag pemeliharaan yang belum ada");
  // Sebaliknya, tag TANPA prefiks itu TIDAK ikut - termasuk salah tulis yang
  // masuk akal seperti menghilangkan segmen AUTOPIN_.
  assert.equal(shouldTrace("[CATALOGUE_MAINT_OK] state=sleeping"), false,
    "tanpa prefiks keluarga, tag pemeliharaan TIDAK terlihat");

  // Dan isi chat penonton tetap ditolak, apa pun yang ditambahkan di atas.
  assert.equal(shouldTrace("[TIKTOK_CHAT] apa pun"), false);
});

test("JEJAK: kelima keadaan yang wajib dibedakan ADA di baris nyata", async () => {
  const baris = await tangkapBaris();
  const ada = (re) => baris.some((b) => re.test(b));

  // 1. penyegaran diminta
  assert.ok(ada(/^\[AUTOPIN_CATALOGUE_MAINT_REQUESTED\] reason=/), "diminta");
  // 2. dilewati karena FULL masih segar
  assert.ok(ada(/^\[AUTOPIN_CATALOGUE_MAINT_SKIPPED\].*reason=fresh-full/), "dilewati: masih segar");
  // 3. dilewati/ditunda karena pekerjaan pin menang
  assert.ok(ada(/^\[AUTOPIN_CATALOGUE_MAINT_SKIPPED\].*reason=pin-pending/), "dilewati: pin menunggu");
  assert.ok(ada(/^\[AUTOPIN_CATALOGUE_MAINT_CANCELLED\].*reason=aborted-pin-preempted/), "ditunda: pin mendahului");
  // 4. berhasil
  assert.ok(ada(/^\[AUTOPIN_CATALOGUE_MAINT_OK\].*count=5/), "berhasil");
  // 5. gagal / tidak lengkap
  assert.ok(ada(/^\[AUTOPIN_CATALOGUE_MAINT_FAILED\].*reason=empty/), "gagal");

  // Alasan "diminta" harus menjelaskan KENAPA, bukan hanya bahwa ia terjadi.
  const diminta = baris.filter((b) => b.includes("MAINT_REQUESTED"));
  for (const b of diminta) {
    assert.match(b, /reason=(no-snapshot|stale-full|no-full-coverage|age-unreadable)/, b);
  }
});

test("JEJAK: UMUR SNAPSHOT ikut tercatat di titik keputusan", async () => {
  // Seluruh keputusan modul ini digerakkan umur. Tanpa angkanya di log,
  // "kenapa pemeliharaan jalan / tidak jalan" hanya bisa disimpulkan dari
  // nextMs - dan itu cuma mungkin pada cabang fresh-full.
  const baris = await tangkapBaris();
  const fresh = baris.find((b) => b.includes("MAINT_SKIPPED") && b.includes("reason=fresh-full"));
  assert.ok(fresh, "harus ada baris fresh-full");
  assert.match(fresh, /ageMs=0 nextMs=/, "umur yang DILIHAT keputusan harus tercatat: " + fresh);

  const pin = baris.find((b) => b.includes("reason=pin-pending"));
  assert.ok(pin, "harus ada baris pin-pending");
  // Snapshot kosong -> umur tidak diketahui, dan core.log membuang field null.
  // Yang dilarang adalah MENGARANG angka, bukan menghilangkannya.
  assert.ok(!/ageMs=/.test(pin), "umur yang tidak diketahui tidak boleh dikarang: " + pin);

  // Dan pada keputusan yang BERTINDAK karena umur, angkanya juga ada.
  let t = 1_000_000;
  const { log } = require("../autopin/core");
  const keluar = [];
  const asli = console.log;
  console.log = (...a) => keluar.push(a.join(" "));
  try {
    const m = createCatalogueMaintenance({
      now: () => t, setTimer: () => null, clearTimer: () => {},
      readState: () => FULL(25_000),
      isPinPending: () => false, isStopping: () => false, isSweepInFlight: () => false,
      requestRefresh: async () => ({ ok: true, task: Promise.resolve({ ok: true, count: 5, ms: 1180, coverage: "full" }) }),
      log,
    });
    m.start();
    await m.tick();
    m.stop();
  } finally {
    console.log = asli;
  }
  const diminta = keluar.find((b) => b.includes("MAINT_REQUESTED"));
  assert.match(diminta, /reason=stale-full/);
  assert.match(diminta, /ageMs=25000/, "umur yang memicu sapuan harus tercatat: " + diminta);
});

test("JEJAK: pesan exception TIDAK PERNAH ikut ke log", () => {
  // Pesan exception bisa membawa potongan teks halaman. Ia memang dibentuk
  // (reason:"threw" + detail) supaya klasifikasi kegagalan tetap akurat, tapi
  // `detail` tidak pernah dioper ke log - dan allowlist field menegakkannya.
  const src = fs.readFileSync(path.join(ROOT, "autopin", "catalogue-maintenance.js"), "utf8");
  const panggilan = src.match(/log\("CATALOGUE_MAINT_[A-Z]+",[^;]*\);/g) || [];
  assert.equal(panggilan.length, 5);
  for (const p of panggilan) assert.ok(!/detail/.test(p), "detail exception tidak boleh dicatat: " + p);
});

test("PRIVASI: baris nyata hanya membawa field teknis", async () => {
  const baris = await tangkapBaris();
  // Diperiksa dari KELUARAN, bukan dari kode sumber: grep atas sumber tidak
  // tahu apa yang benar-benar sampai ke disk.
  const terlarang = [
    /nickname/i, /username/i, /viewer/i, /penonton/i, /komentar/i, /comment/i,
    /cookie/i, /token/i, /password/i, /sandi/i,
    /\bRp\s*\d/, /Garuda/i, /Gery/i, /Dilan/i,       // judul/harga produk
    /agen_mulia_abadi/,                                // identitas toko
    /search=|query=|q=/,                               // teks pencarian
  ];
  for (const b of baris) {
    for (const t of terlarang) assert.ok(!t.test(b), "baris membawa yang dilarang (" + t + "): " + b);
  }

  // Dan kuncinya memang hanya yang aman.
  // Tepat tujuh kategori yang disetujui: reason, keadaan pemeliharaan, umur
  // snapshot, coverage, count, elapsed ms, dan retry/backoff ms (nextMs dan
  // backoffMs keduanya jeda retry).
  const DIIZINKAN = new Set(["reason", "state", "ageMs", "coverage", "count", "ms", "nextMs", "backoffMs"]);
  const ANGKA = new Set(["ageMs", "count", "ms", "nextMs", "backoffMs"]);
  for (const b of baris) {
    const field = b.slice(b.indexOf("]") + 1).trim();
    if (!field) continue;
    for (const pasangan of field.split(" ")) {
      const k = pasangan.split("=")[0];
      if (!k) continue;
      assert.ok(DIIZINKAN.has(k), "field tak terduga di log pemeliharaan: " + k + " (" + b + ")");
      // Kuncinya saja TIDAK cukup. `reason="<judul produk>"` punya kunci yang
      // sah dan isi yang tidak - dan daftar hitam nama merek hanya menangkap
      // merek yang kebetulan sudah ditulis di tes ini. Jadi NILAInya juga
      // dibatasi bentuknya: angka, atau token teknis pendek.
      const v = pasangan.slice(k.length + 1);
      if (ANGKA.has(k)) assert.match(v, /^-?\d+$/, "field angka berisi bukan angka: " + pasangan);
      else assert.match(v, /^[a-z0-9-]{1,40}$/, "field teks di luar bentuk token: " + pasangan);
    }
  }
});

test("JEJAK: KEADAAN pemeliharaan tercatat di setiap event, kosakata tertutup", async () => {
  const baris = await tangkapBaris();
  const SAH = new Set(["stopped", "working", "holding", "sleeping"]);

  for (const b of baris) {
    const m = /state=([a-z-]+)/.exec(b);
    assert.ok(m, "setiap event harus membawa keadaan: " + b);
    assert.ok(SAH.has(m[1]), "keadaan di luar kosakata: " + m[1] + " (" + b + ")");
  }

  // Keadaan menjawab hal yang BERBEDA dari reason, dan pasangannya harus masuk akal.
  const cari = (tag) => baris.find((b) => b.includes(tag));
  assert.match(cari("MAINT_REQUESTED"), /state=working/, "saat meminta, loop sedang bekerja");
  assert.match(cari("MAINT_OK"), /state=sleeping/, "sesudah berhasil, loop kembali tidur");
  assert.match(cari("MAINT_FAILED"), /state=holding/, "sesudah gagal, loop menahan (backoff)");
  assert.match(cari("MAINT_CANCELLED"), /state=holding/, "sesudah ditunda, loop menahan");
  assert.match(cari("reason=fresh-full"), /state=sleeping/, "masih segar -> tidur");
});

test("JEJAK: baris STOP melaporkan state=stopped, bukan sleeping", async () => {
  // Urutannya penting: kalau penjadwal dimatikan SESUDAH dicatat, barisnya
  // melaporkan keadaan yang sudah tidak benar saat ia ditulis.
  const { log } = require("../autopin/core");
  const keluar = [];
  const asli = console.log;
  console.log = (...a) => keluar.push(a.join(" "));
  let m;
  try {
    let t = 1_000_000;
    m = createCatalogueMaintenance({
      now: () => t, setTimer: () => null, clearTimer: () => {},
      readState: () => KOSONG,
      isPinPending: () => false, isStopping: () => true, isSweepInFlight: () => false,
      requestRefresh: async () => ({ ok: true }),
      log,
    });
    m.start();
    await m.tick();
  } finally {
    console.log = asli;
  }
  const b = keluar.find((x) => x.includes("MAINT_SKIPPED"));
  assert.ok(b, "harus ada baris SKIPPED: " + JSON.stringify(keluar));
  assert.match(b, /reason=stopping/);
  assert.match(b, /state=stopped/, "keadaan harus sudah stopped saat dicatat: " + b);
  assert.equal(m.isRunning(), false);
  assert.equal(m.hasTimer(), false);
});

test("JEJAK: `streak` TIDAK dicatat - backoffMs sudah menyebutkannya", async () => {
  const { backoffFor, MAINT_BACKOFF_MS } = require("../autopin/catalogue-maintenance");
  const baris = await tangkapBaris();
  const gagal = baris.find((b) => b.includes("MAINT_FAILED"));
  assert.ok(gagal, "harus ada baris FAILED");
  assert.ok(!/streak=/.test(gagal), "streak tidak boleh dicatat: " + gagal);
  assert.match(gagal, /backoffMs=5000/, "jeda retry harus tercatat: " + gagal);

  // Dan tidak ada informasi yang hilang: tangga backoff memetakan 1:1 ke
  // posisi kegagalan sampai ia jenuh.
  assert.deepEqual(MAINT_BACKOFF_MS, [5_000, 10_000, 20_000]);
  assert.equal(backoffFor(1), 5_000);
  assert.equal(backoffFor(2), 10_000);
  assert.equal(backoffFor(3), 20_000);
});

test("PRIVASI: modul pemeliharaan tidak MENGAKSES sumber data sensitif", () => {
  // Yang diperiksa di sini adalah KODE, jadi komentarnya dibuang lebih dulu.
  //
  // Versi pertama tes ini mem-grep seluruh berkas, dan langsung merah begitu
  // sebuah komentar menjelaskan KENAPA cookie tidak bisa lolos penjaga bentuk.
  // Itu bukan temuan - itu batas dari grep atas sumber: ia tidak bisa
  // membedakan "membaca cookie" dari "menulis kalimat tentang cookie".
  //
  // Pembuktian yang sesungguhnya ada di tes taint di bawah, yang memeriksa
  // KELUARAN. Tes ini tinggal mengerjakan satu hal yang masih berguna dan tidak
  // bisa dilihat dari keluaran: modul ini tidak punya jalan untuk MENGAMBIL
  // data sensitif - tidak ada document., tidak ada cookies(), tidak ada
  // pembacaan field identitas penonton.
  const mentah = fs.readFileSync(path.join(ROOT, "autopin", "catalogue-maintenance.js"), "utf8");
  const kode = mentah
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  // Sanity: pembuang komentar memang bekerja, kalau tidak tesnya jadi vakum.
  assert.ok(kode.includes("function logNumber"), "kode harus tersisa");
  assert.ok(!kode.includes("MASALAH YANG DIPERBAIKI"), "komentar harus terbuang");

  const DILARANG = [
    /\bdocument\./,        // tidak ada akses DOM
    /\bpage\./,            // tidak ada akses halaman Puppeteer
    /\bcookies?\s*\(/,     // tidak ada pembacaan cookie
    /\bnickname\b/,        // tidak ada identitas penonton
    /\bmsgNorm\b/,         // tidak ada komentar penonton yang dinormalisasi
    /\bsearchValue\b/,     // tidak ada teks pencarian
    /\bevaluate\s*\(/,     // tidak ada eksekusi dalam halaman
  ];
  for (const d of DILARANG) {
    assert.ok(!d.test(kode), "modul tidak boleh mengakses: " + d);
  }
});

test("JEJAK: TIDAK ada event duplikat yang dibuat hanya untuk penamaan", async () => {
  const baris = await tangkapBaris();
  const tags = new Set(baris.map((b) => b.slice(1, b.indexOf("]"))));
  // Lima keadaan, lima tag. Pembedaan lebih halus (kenapa dilewati, kenapa
  // gagal) dibawa oleh field `reason`, bukan oleh tag baru - jejak dukungan
  // yang kembung justru lebih sulit dibaca, dan itu alasan modul child-trace
  // memilih allowlist sejak awal.
  assert.equal(tags.size, 5, "harus tepat lima tag: " + [...tags].join(", "));
  const src = fs.readFileSync(path.join(ROOT, "autopin", "catalogue-maintenance.js"), "utf8");
  const dipanggil = new Set((src.match(/log\("([A-Z_]+)"/g) || []).map((x) => x.slice(5, -1)));
  assert.equal(dipanggil.size, 5, "lima pemanggilan log yang berbeda: " + [...dipanggil].join(", "));
});

// ===========================================================================
// PRIVASI JEJAK: dibuktikan dengan MERACUNI masukan, bukan dengan berharap
// ===========================================================================
//
// Tes privasi versi pertama menjalankan pemeliharaan dengan nilai yang wajar
// saja, lalu memastikan keluarannya bersih. Itu membuktikan terlalu sedikit:
// data sensitif tidak pernah TERSEDIA untuk dibocorkan, jadi tes itu tidak bisa
// membedakan "modul menolak mencatatnya" dari "tidak ada yang bisa dicatat".
//
// Yang di bawah membalik arahnya: data sensitif DIOPERKAN lewat setiap field
// yang datang dari pemanggil, lalu keluarannya diperiksa. Saat ditulis, probe
// yang sama membocorkan 6 nilai di 3 baris - dan ketiganya lolos shouldTrace,
// artinya ketiganya akan tertulis ke berkas yang dikirim customer.

// Kanari: bentuk-bentuk nyata yang TIDAK boleh pernah sampai ke log dukungan.
const KANARI = Object.freeze([
  "Gery Saluut Chocolatos 12pcs",  // judul produk sewenang-wenang
  "budi_santoso_88",               // identitas penonton
  "sessionid=abc123",              // cookie/token
  "berapa harga yang coklat itu",  // komentar mentah penonton
  "kacang atom rasa pedas",        // teks yang diketik di kotak pencarian
  "KANARI_UNIK_9f3a",              // penanda generik
]);

// Menjalankan satu tik dengan hasil/snapshot yang DIRACUNI, memakai log
// produksi, lalu mengembalikan baris yang benar-benar dicetak.
async function tangkapTeracuni(hasil, snapshot) {
  const { log } = require("../autopin/core");
  const keluar = [];
  const asli = console.log;
  console.log = (...a) => keluar.push(a.join(" "));
  try {
    let t = 1_000_000;
    const m = createCatalogueMaintenance({
      now: () => t,
      setTimer: () => null,
      clearTimer: () => {},
      readState: () => snapshot || KOSONG,
      isPinPending: () => false,
      isStopping: () => false,
      isSweepInFlight: () => false,
      requestRefresh: async () => {
        if (hasil instanceof Error) throw hasil;
        return { ok: true, reason: "scheduled", task: Promise.resolve(hasil) };
      },
      log,
    });
    m.start();
    await m.tick();
    m.stop();
  } finally {
    console.log = asli;
  }
  return keluar;
}

test("PRIVASI: data sensitif dari pemanggil TIDAK sampai ke log dukungan", async () => {
  const { shouldTrace } = require("../controller/child-trace");
  // Setiap field yang BUKAN milik modul ini, diracuni satu per satu.
  const kasus = [
    { nama: "coverage + count + ms pada jalur OK",
      hasil: { ok: true, count: "Gery Saluut Chocolatos 12pcs", ms: "sessionid=abc123", coverage: "budi_santoso_88" } },
    { nama: "reason pada jalur FAILED",
      hasil: { ok: false, reason: "Gery Saluut Chocolatos 12pcs Rp25.000" } },
    { nama: "reason pada jalur CANCELLED",
      hasil: { ok: false, reason: "pin-pending KANARI_UNIK_9f3a berapa harga yang coklat itu" } },
    { nama: "pesan exception",
      hasil: new Error("gagal membaca KANARI_UNIK_9f3a budi_santoso_88 sessionid=abc123") },
    { nama: "coverage + ageMs dari snapshot katalog",
      hasil: { ok: true },
      snapshot: { has: true, coverage: "budi_santoso_88", ageMs: "KANARI_UNIK_9f3a", count: 5 } },
    { nama: "retryAfterMs yang membawa teks",
      hasil: { ok: false, reason: "too-soon", retryAfterMs: "KANARI_UNIK_9f3a" } },
    { nama: "teks pencarian lewat reason",
      hasil: { ok: false, reason: "scope-dirty kacang atom rasa pedas" } },
    { nama: "teks pencarian lewat coverage",
      hasil: { ok: true, coverage: "kacang atom rasa pedas" } },
  ];

  for (const k of kasus) {
    const baris = await tangkapTeracuni(k.hasil, k.snapshot);
    assert.ok(baris.length > 0, "harus ada baris: " + k.nama);
    for (const b of baris) {
      for (const kan of KANARI) {
        assert.ok(!b.includes(kan), "BOCOR lewat " + k.nama + " [" + kan + "]: " + b);
      }
      // Dan bocor-tidaknya memang penting: barisnya LOLOS ke jejak dukungan.
      assert.equal(shouldTrace(b), true, "baris ini memang ikut tercatat: " + b);
    }
  }
});

test("PRIVASI: bentuk yang ditolak dicatat sebagai fakta, bukan dipotong", async () => {
  // Memotong judul produk 40 karakter tetap menuliskan judul produk. Yang
  // dicatat adalah bahwa bentuknya salah - itu tetap bisa didiagnosis operator
  // tanpa membawa isinya.
  const baris = await tangkapTeracuni({ ok: false, reason: "Gery Saluut Chocolatos 12pcs Rp25.000" });
  const gagal = baris.find((b) => b.includes("MAINT_FAILED"));
  assert.ok(gagal, "harus ada baris FAILED");
  assert.match(gagal, /reason=non-token/, "bentuk yang ditolak harus terlihat: " + gagal);
  assert.ok(!/Gery|Saluut|Chocolatos|Rp25/.test(gagal), gagal);
  // Backoff tetap jalan: privasi tidak boleh menelan klasifikasi kegagalan.
  assert.match(gagal, /backoffMs=5000/, gagal);
});

test("PRIVASI: child-trace meneruskan baris APA ADANYA, tidak menyensor field", () => {
  // createChildTracer hanya memutuskan IKUT atau TIDAK. Ia tidak pernah
  // membuang field, jadi apa pun yang dipancarkan titik pancar akan sampai
  // utuh ke lapis berikutnya.
  const { createChildTracer } = require("../controller/child-trace");
  const tertulis = [];
  const trace = createChildTracer({ enabled: true, write: (x) => tertulis.push(x) });

  const baris = "[AUTOPIN_CATALOGUE_MAINT_FAILED] reason=empty state=holding backoffMs=5000";
  assert.equal(trace("service", baris), true);
  assert.equal(tertulis.length, 1);
  // Satu-satunya yang ditambahkan adalah awalan peran; isi barisnya utuh.
  assert.equal(tertulis[0], "[CHILD:service] " + baris);
  assert.ok(tertulis[0].endsWith(baris), "isi baris diteruskan apa adanya");

  // Dan nilai BERTANDA KUTIP pun diteruskan utuh. Ini bukan detail: log()
  // produksi mengutip setiap nilai yang memuat spasi, jadi justru nilai
  // berkutip itulah bentuk yang akan dipakai sebuah kebocoran. Tanpa baris di
  // bawah, penyensor yang membersihkan `"..."` di lapis ini tidak akan terlihat
  // - dan tes ini akan mengklaim "apa adanya" untuk lapis yang tidak lagi
  // meneruskannya apa adanya.
  const berkutip = '[AUTOPIN_CATALOGUE_MAINT_OK] state=sleeping coverage="dua kata" count=5';
  assert.equal(trace("service", berkutip), true);
  assert.equal(tertulis[1], "[CHILD:service] " + berkutip,
    "nilai berkutip harus diteruskan tanpa diubah: " + tertulis[1]);
});

test("PRIVASI: lapis kedua redactLine TIDAK menutupi field pemeliharaan", () => {
  // Klaim pertama di tes ini salah dan sudah diperbaiki: lapis kedua MEMANG
  // ada - desktop/support-log.js redactLine, dipanggil di setiap penulisan log
  // dukungan - dan ia bekerja.
  //
  // Tapi ia berbasis NAMA FIELD, dan tidak satu pun nama field yang dicatat
  // modul pemeliharaan ada di daftarnya. Itulah yang membuat penjaga bentuk di
  // titik pancar memikul bebannya, dan itu dibuktikan di sini supaya klaimnya
  // tidak perlu dipercaya begitu saja.
  const { redactLine } = require("../desktop/support-log");

  // KONTROL: untuk field yang DIKENALI, lapis kedua jelas bekerja.
  assert.match(redactLine("[CHILD:bot] [MATCH] scene=PAX-1 user=Budi Santoso via=trigger"),
    /user=<redacted>/, "user= memang disunting");
  assert.match(redactLine('[CHILD:bot] [X] comment="berapa harga coklat"'),
    /comment="<redacted>"/, 'comment=" memang disunting');
  assert.match(redactLine("[CHILD:bot] [X] sessionid=abc123"),
    /sessionid=<redacted>/, "sessionid= memang disunting");

  // DAN INI INTINYA: baris yang BENAR-BENAR dibocorkan modul ini sebelum
  // penjaga bentuk dipasang, dijalankan lewat lapis kedua - dan lolos.
  const bocorDulu = [
    '[CHILD:service] [AUTOPIN_CATALOGUE_MAINT_OK] state=sleeping count="Gery Saluut Chocolatos 12pcs" coverage=budi_santoso_88',
    '[CHILD:service] [AUTOPIN_CATALOGUE_MAINT_FAILED] reason="Gery Saluut Chocolatos 12pcs Rp25.000" state=holding',
  ];
  for (const b of bocorDulu) {
    const out = redactLine(b);
    assert.ok(out.includes("Gery Saluut Chocolatos"),
      "lapis kedua tidak mengenali field ini - penjaga bentuk di titik pancar yang menahannya: " + out);
  }
  assert.ok(redactLine(bocorDulu[0]).includes("budi_santoso_88"),
    "nama penonton di coverage= pun lolos lapis kedua");
});

test("PRIVASI: KELIMA titik pancar melewatkan nilainya lewat penjaga bentuk", () => {
  // Dua mutasi - `reason` pada CANCELLED dan `ageMs` pada SKIPPED - tetap HIJAU
  // kalau penjaganya dilepas, karena hari ini nilai keduanya sudah dibatasi di
  // hulu: reason CANCELLED selalu anggota DEFERRED (daftar beku berisi token
  // bersih), dan ageMs sudah dinormalisasi decideMaintenance menjadi angka atau
  // null. Jadi tidak ada masukan yang bisa membuat perbedaannya terlihat di
  // keluaran.
  //
  // Yang dijaga di sini karena itu bukan akibatnya, tapi sifatnya: SETIAP nilai
  // di SETIAP panggilan log melewati penjaga bentuk. Itu yang membuat berkas ini
  // bisa dibaca tanpa membuktikan keterjangkauan per-field lebih dulu - dan
  // keterjangkauan itu yang berubah diam-diam saat orang lain mengubah hulu.
  const src = fs.readFileSync(path.join(ROOT, "autopin", "catalogue-maintenance.js"), "utf8");
  const panggilan = src.match(/log\("CATALOGUE_MAINT_[A-Z]+",\s*\{[\s\S]*?\}\);/g) || [];
  assert.equal(panggilan.length, 5, "harus tepat lima panggilan log");

  // `state` dikecualikan: ia dihitung keadaan() dari boolean internal dan tidak
  // bisa berasal dari data. Kosakatanya dijaga tes tersendiri.
  const BEBAS = new Set(["state"]);
  for (const p of panggilan) {
    const isi = p.slice(p.indexOf("{") + 1, p.lastIndexOf("}"));
    // Setiap `kunci: nilai` di dalam objek field.
    const field = isi.match(/([a-zA-Z]+)\s*:\s*([^,]+?)(?=,\s*[a-zA-Z]+\s*:|,?\s*$)/g) || [];
    assert.ok(field.length >= 2, "panggilan log harus punya field: " + p);
    for (const f of field) {
      const kunci = f.slice(0, f.indexOf(":")).trim();
      const nilai = f.slice(f.indexOf(":") + 1).trim();
      if (BEBAS.has(kunci)) continue;
      assert.match(nilai, /^log(Token|Number)\(/,
        "field `" + kunci + "` tidak melewati penjaga bentuk: " + nilai);
    }
  }
});

test("PRIVASI: logToken hanya meloloskan token teknis pendek", () => {
  const { logToken } = require("../autopin/catalogue-maintenance");
  // Yang sah: alasan yang BENAR-BENAR dipakai produksi.
  for (const t of ["empty", "pin-pending", "aborted-pin-preempted", "too-soon", "newer-full-exists",
                   "page-not-open", "unexpected-page", "would-downgrade", "threw", "error",
                   "full", "viewport", "unknown", "-"]) {
    assert.equal(logToken(t, "x"), t, "token sah harus lolos: " + t);
  }
  // Yang ditolak: apa pun yang berbentuk teks manusia atau kredensial.
  for (const t of ["Gery Saluut", "budi_santoso_88", "sessionid=abc123", "berapa harga coklat",
                   "Rp 25.000", "FULL", "a".repeat(41), "judul/produk", "x y"]) {
    assert.equal(logToken(t, "x"), "non-token", "harus ditolak: " + t);
  }
  // Kosong -> bawaan, supaya baris log tidak kehilangan artinya.
  assert.equal(logToken(null, "unknown"), "unknown");
  assert.equal(logToken(undefined, "deferred"), "deferred");
  assert.equal(logToken("", "-"), "-");
});

test("PRIVASI: logNumber hanya meloloskan angka", () => {
  const { logNumber } = require("../autopin/catalogue-maintenance");
  assert.equal(logNumber(0), 0);
  assert.equal(logNumber(5000), 5000);
  assert.equal(logNumber(-1), -1);
  assert.equal(logNumber(1180.7), 1181, "dibulatkan, bukan ditolak");
  assert.equal(logNumber("25000"), 25000, "angka dalam string tetap angka");
  // Yang membawa teks berhenti di sini - termasuk yang diawali angka.
  for (const v of ["KANARI_UNIK_9f3a", "25000 Gery", "Rp25.000", "abc", {}, [], NaN, Infinity]) {
    assert.equal(logNumber(v), null, "harus jadi null: " + String(v));
  }
  // null/undefined tetap null supaya log() membuang fieldnya.
  assert.equal(logNumber(null), null);
  assert.equal(logNumber(undefined), null);
});

test("PRIVASI: angka yang ditolak HILANG dari baris, tidak jadi 'non-token'", async () => {
  // Kalau field angka diisi teks, yang benar adalah field itu tidak muncul -
  // bukan muncul sebagai string. Parser log dukungan membaca ini sebagai angka.
  const baris = await tangkapTeracuni({ ok: false, reason: "too-soon", retryAfterMs: "KANARI_UNIK_9f3a" });
  const dibatalkan = baris.find((b) => b.includes("MAINT_CANCELLED"));
  assert.ok(dibatalkan, "harus ada baris CANCELLED: " + JSON.stringify(baris));
  const m = /nextMs=(\S+)/.exec(dibatalkan);
  assert.ok(m, "nextMs harus ada (jatuh ke jeda penundaan): " + dibatalkan);
  assert.match(m[1], /^\d+$/, "nextMs harus angka: " + dibatalkan);
  assert.equal(Number(m[1]), 5_000, "retryAfterMs tak terbaca -> jeda penundaan: " + dibatalkan);
});

// ===========================================================================
// SURVIVAL: setiap keputusan WAJIB sampai ke BERKAS, bukan cuma lolos filter
// ===========================================================================
//
// `shouldTrace(baris) === true` membuktikan satu lapis dari empat. Di antara
// titik pancar dan berkas yang dikirim customer masih ada:
//
//   1. autopin/core.js log()            -> membentuk & MEMBUANG field kosong
//   2. controller/child-trace.js        -> allowlist tag + awalan peran
//   3. desktop/support-log.js redactLine -> penyuntingan berbasis NAMA FIELD
//   4. desktop/support-log.js write()    -> pemotongan MAX_LINE + rotasi
//
// Lapis 3 dan 4 bisa MERUSAK baris yang lolos lapis 2. redactLine memakan nilai
// sampai `key=` berikutnya untuk beberapa pola, dan pola `[a-z_]*token` cocok
// dengan NAMA KUNCI apa pun yang berakhiran "token" - jadi "baris ini terlihat
// aman" bukan hal yang boleh disimpulkan dengan membaca. Diuji ujung-ke-ujung.

// Keenam pembedaan yang WAJIB bisa dilakukan operator dari log dukungan.
// Daftarnya adalah kontraknya: entri di sini harus tetap terbaca di berkas.
const WAJIB = Object.freeze([
  { nama: "penyegaran diminta", cocok: /\[AUTOPIN_CATALOGUE_MAINT_REQUESTED\] reason=[a-z-]+/ },
  { nama: "dilewati: FULL masih segar", cocok: /\[AUTOPIN_CATALOGUE_MAINT_SKIPPED\].*reason=fresh-full/ },
  { nama: "dilewati-ditunda: pin menang", cocok: /\[AUTOPIN_CATALOGUE_MAINT_SKIPPED\].*reason=pin-pending/ },
  { nama: "berhasil", cocok: /\[AUTOPIN_CATALOGUE_MAINT_OK\].*count=\d+.*coverage=full/ },
  { nama: "gagal: tidak lengkap", cocok: /\[AUTOPIN_CATALOGUE_MAINT_FAILED\].*reason=empty.*backoffMs=\d+/ },
  { nama: "dibatalkan: pin mendahului", cocok: /\[AUTOPIN_CATALOGUE_MAINT_CANCELLED\].*reason=aborted-pin-preempted/ },
]);

// Menjalankan SEMUA keputusan wajib melalui rantai produksi yang LENGKAP dan
// mengembalikan isi berkas log yang benar-benar tertulis ke disk.
async function tulisKeBerkas(extra = []) {
  const { log } = require("../autopin/core");
  const { createChildTracer } = require("../controller/child-trace");
  const { createSupportLog } = require("../desktop/support-log");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ailive-maint-log-"));
  const sup = createSupportLog({ dir, now: () => new Date(0) });
  const trace = createChildTracer({ enabled: true, write: (teks) => sup.write(teks) });

  const keluar = [];
  const asli = console.log;
  console.log = (...a) => keluar.push(a.join(" "));
  try {
    const jalankan = async ({ state, hasil, pin = false }) => {
      let waktu = 1_000_000;
      const m = createCatalogueMaintenance({
        now: () => waktu,
        setTimer: () => null,
        clearTimer: () => {},
        readState: () => state,
        isPinPending: () => pin,
        isStopping: () => false,
        isSweepInFlight: () => false,
        requestRefresh: async () => ({ ok: true, reason: "scheduled", task: Promise.resolve(hasil) }),
        log,
      });
      m.start();
      await m.tick();
      m.stop();
    };
    await jalankan({ state: KOSONG, hasil: { ok: true, count: 5, ms: 1180, coverage: "full" } });
    await jalankan({ state: FULL(0), hasil: { ok: true } });
    await jalankan({ state: KOSONG, hasil: { ok: true }, pin: true });
    await jalankan({ state: KOSONG, hasil: { ok: false, reason: "empty" } });
    await jalankan({ state: KOSONG, hasil: { ok: false, reason: "aborted-pin-preempted" } });
  } finally {
    console.log = asli;
  }

  // Lewatkan setiap baris melalui rantai anak -> log dukungan, persis seperti
  // controller/controller.js melakukannya.
  for (const b of keluar) trace("service", b);
  for (const b of extra) trace("bot", b);

  const berkas = path.join(dir, "ai-live-host.log");
  const isi = fs.existsSync(berkas) ? fs.readFileSync(berkas, "utf8") : "";
  fs.rmSync(dir, { recursive: true, force: true });
  return { isi, dipancarkan: keluar };
}

test("SURVIVAL: keenam keputusan wajib SAMPAI ke berkas log dukungan", async () => {
  const { isi, dipancarkan } = await tulisKeBerkas();
  assert.ok(isi.length > 0, "berkas log tidak boleh kosong");

  for (const w of WAJIB) {
    assert.match(isi, w.cocok, "keputusan wajib HILANG dari berkas: " + w.nama);
  }

  // Dan tiap baris di berkas memang baris pemeliharaan yang utuh - bukan
  // potongan yang kehilangan field keputusannya.
  const baris = isi.trim().split("\n").filter((l) => l.includes("CATALOGUE_MAINT"));
  // Enam PEMBEDAAN, bukan enam baris: REQUESTED muncul sekali per sapuan,
  // jadi barisnya lebih banyak dari pembedaannya. Yang diikat di sini adalah
  // "tidak ada yang hilang di perjalanan ke disk" - dibandingkan dengan yang
  // BENAR-BENAR dipancarkan, bukan dengan angka yang ditulis tangan.
  assert.equal(baris.length, dipancarkan.length,
    "ada baris yang hilang ke disk: " + dipancarkan.length + " dipancarkan, " + baris.length + " tertulis");
  assert.ok(baris.length >= WAJIB.length, "minimal satu baris per pembedaan wajib");
  for (const b of baris) {
    assert.ok(!b.includes("…"), "baris tidak boleh terpotong MAX_LINE: " + b);
    assert.ok(!b.includes("<redacted>"), "field keputusan tidak boleh tersunting: " + b);
    assert.match(b, /\[CHILD:service\] \[AUTOPIN_CATALOGUE_MAINT_/, "awalan peran harus utuh: " + b);
    assert.match(b, /state=(stopped|working|holding|sleeping)/, "keadaan harus selamat: " + b);
  }
});

test("SURVIVAL: redactLine tidak merusak satu pun field keputusan", async () => {
  // Diperiksa dengan membandingkan apa yang DIPANCARKAN dengan apa yang
  // TERTULIS: setiap baris harus sampai utuh, karakter per karakter.
  const { isi, dipancarkan } = await tulisKeBerkas();
  const tertulis = isi.trim().split("\n").filter((l) => l.includes("CATALOGUE_MAINT"));
  assert.equal(tertulis.length, dipancarkan.length, "jumlah baris harus sama");

  for (let i = 0; i < dipancarkan.length; i += 1) {
    // Format berkas: "<stempel> [CHILD:service] <baris>"
    const akhir = tertulis[i].slice(tertulis[i].indexOf("[CHILD:service] ") + "[CHILD:service] ".length);
    assert.equal(akhir, dipancarkan[i],
      "baris berubah di perjalanan ke disk:\n  pancar : " + dipancarkan[i] + "\n  tertulis: " + akhir);
  }
});

test("SURVIVAL: isi chat penonton TIDAK sampai ke berkas yang sama", async () => {
  // Kontrol arah sebaliknya. Tes di atas membuktikan enam baris SELAMAT; tanpa
  // yang ini, "selamat" bisa saja berarti filternya mati dan semuanya lewat.
  const { isi } = await tulisKeBerkas([
    '[TIKTOK_CHAT] user=Budi comment="berapa harga yang coklat itu"',
    "\u{1F4AC} Budi: berapa harga yang coklat itu",   // baris tanpa tag
  ]);

  // Keenam keputusan tetap ada...
  for (const w of WAJIB) assert.match(isi, w.cocok, "keputusan wajib hilang: " + w.nama);
  // ...dan chat penonton tidak.
  assert.ok(!isi.includes("TIKTOK_CHAT"), "baris chat tidak boleh ikut: " + isi);
  assert.ok(!isi.includes("berapa harga yang coklat itu"), "komentar penonton bocor ke berkas");
  assert.ok(!isi.includes("Budi"), "nama penonton bocor ke berkas");
});

test("SURVIVAL: keputusan wajib tetap selamat saat log BEROTASI", async () => {
  // Log dukungan berotasi pada 5 MB di mesin customer yang LIVE berjam-jam.
  // Rotasi yang memotong baris di tengah akan menghilangkan keputusan justru
  // pada run panjang - run yang paling perlu diaudit.
  const { log } = require("../autopin/core");
  const { createChildTracer } = require("../controller/child-trace");
  const { createSupportLog } = require("../desktop/support-log");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ailive-maint-rot-"));
  try {
    const sup = createSupportLog({ dir, maxBytes: 600, keep: 3, now: () => new Date(0) });
    const trace = createChildTracer({ enabled: true, write: (teks) => sup.write(teks) });

    const keluar = [];
    const asli = console.log;
    console.log = (...a) => keluar.push(a.join(" "));
    try {
      let waktu = 1_000_000;
      const m = createCatalogueMaintenance({
        now: () => waktu, setTimer: () => null, clearTimer: () => {},
        readState: () => KOSONG,
        isPinPending: () => false, isStopping: () => false, isSweepInFlight: () => false,
        requestRefresh: async () => ({ ok: true, reason: "scheduled", task: Promise.resolve({ ok: false, reason: "empty" }) }),
        log,
      });
      m.start();
      // Cukup banyak untuk memaksa beberapa kali rotasi.
      for (let i = 0; i < 40; i += 1) { await m.tick(); waktu += 60_000; }
      m.stop();
    } finally {
      console.log = asli;
    }
    for (const b of keluar) trace("service", b);

    // Berkas aktif + rotasinya: keputusannya harus masih terbaca di SALAH SATU.
    const semua = ["ai-live-host.log", "ai-live-host.log.1", "ai-live-host.log.2", "ai-live-host.log.3"]
      .map((n) => path.join(dir, n))
      .filter((p) => fs.existsSync(p))
      .map((p) => fs.readFileSync(p, "utf8"))
      .join("\n");

    assert.ok(semua.includes("AUTOPIN_CATALOGUE_MAINT_REQUESTED"), "REQUESTED harus selamat dari rotasi");
    assert.ok(semua.includes("AUTOPIN_CATALOGUE_MAINT_FAILED"), "FAILED harus selamat dari rotasi");
    assert.match(semua, /reason=empty/, "alasan kegagalan harus selamat dari rotasi");
    // Dan rotasinya memang terjadi - kalau tidak, tesnya tidak membuktikan apa pun.
    assert.ok(fs.existsSync(path.join(dir, "ai-live-host.log.1")), "rotasi harus benar-benar terjadi");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// PENYARINGAN child-trace: yang WAJIB lewat, dan yang WAJIB tetap ditolak
// ===========================================================================
//
// Ketiga sifat di bawah diuji lewat SATU instance tracer yang sama. Itu
// disengaja: "pemeliharaan terlihat" dan "chat penonton tertolak" bukan dua
// kebijakan terpisah yang bisa dibuktikan sendiri-sendiri - keduanya hasil dari
// filter yang SAMA, dan yang berbahaya justru pelonggaran yang meloloskan
// keduanya sekaligus.
//
// Perkabelan produksinya sudah diperiksa: controller/controller.js meneruskan
// SETIAP baris anak lewat traceChildLine(role, line) di dalam onLine, tanpa
// memilih role - dan role "service" ditangani eksplisit beberapa baris di
// atasnya (noteWarmLine). Jadi baris pemeliharaan, yang dipancarkan proses
// service, memang melewati filter ini di produksi.

// Satu baris nyata untuk setiap pembedaan WAJIB, diambil dari modul.
async function barisWajib() {
  const { isi, dipancarkan } = await tulisKeBerkas();
  void isi;
  const pilih = (re) => {
    const b = dipancarkan.find((x) => re.test(x));
    assert.ok(b, "tidak ada baris untuk " + re);
    return b;
  };
  return {
    diminta: pilih(/MAINT_REQUESTED/),
    segar: pilih(/MAINT_SKIPPED.*reason=fresh-full/),
    pinMenang: pilih(/MAINT_SKIPPED.*reason=pin-pending/),
    berhasil: pilih(/MAINT_OK/),
    gagal: pilih(/MAINT_FAILED/),
    didahului: pilih(/MAINT_CANCELLED/),
  };
}

test("FILTER: keenam keputusan wajib LOLOS penyaringan child-trace", async () => {
  const { createChildTracer } = require("../controller/child-trace");
  const wajib = await barisWajib();

  const tertulis = [];
  const trace = createChildTracer({ enabled: true, write: (x) => tertulis.push(x) });

  for (const [nama, baris] of Object.entries(wajib)) {
    assert.equal(trace("service", baris), true, "keputusan wajib DITOLAK filter: " + nama + " -> " + baris);
  }
  assert.equal(tertulis.length, 6, "keenamnya harus tercatat: " + tertulis.length);
  for (const x of tertulis) assert.match(x, /^\[CHILD:service\] \[AUTOPIN_CATALOGUE_MAINT_/, x);

  // Dan tidak satu pun terpotong oleh batas baris process-manager (2000 char),
  // yang berlaku SEBELUM filter ini.
  for (const baris of Object.values(wajib)) {
    assert.ok(baris.length < 2000, "baris pemeliharaan harus jauh di bawah batas: " + baris.length);
  }
});

test("FILTER: jejak MATI secara bawaan - keputusan hanya terlihat kalau diminta", async () => {
  // Sifat ini disebut di sini supaya tidak dibaca berlebihan dari tes di atas:
  // keputusan pemeliharaan LOLOS filter, tapi filter itu sendiri tidak menyala
  // kecuali AILIVE_TRACE_CHILD diminta. Tanpa baris ini, "setiap keputusan
  // sampai ke log dukungan" terbaca sebagai berlaku di setiap run - padahal
  // pada run biasa tidak ada satu pun yang tertulis.
  const { createChildTracer, traceEnabled, TRACE_ENV } = require("../controller/child-trace");
  const wajib = await barisWajib();

  assert.equal(traceEnabled({}), false, "bawaannya MATI");
  assert.equal(traceEnabled({ [TRACE_ENV]: "" }), false, "ada tapi kosong tetap MATI");
  assert.equal(traceEnabled({ [TRACE_ENV]: "1" }), true);
  assert.equal(traceEnabled({ [TRACE_ENV]: "true" }), true);

  const tertulis = [];
  const mati = createChildTracer({ enabled: false, write: (x) => tertulis.push(x) });
  for (const baris of Object.values(wajib)) assert.equal(mati("service", baris), false);
  assert.equal(tertulis.length, 0, "jejak mati tidak boleh menulis apa pun");
});

test("FILTER: chat TikTok MENTAH tetap ditolak oleh filter yang sama", async () => {
  const { createChildTracer, shouldTrace, TRACE_DENY, TRACE_TAGS } = require("../controller/child-trace");
  const wajib = await barisWajib();

  const tertulis = [];
  const trace = createChildTracer({ enabled: true, write: (x) => tertulis.push(x) });

  // Filter yang SAMA: keputusan lewat...
  assert.equal(trace("service", wajib.berhasil), true);

  // ...dan chat penonton tidak, dalam SETIAP bentuk yang benar-benar ada di
  // index.js (lihat komentar controller/child-trace.js).
  const DITOLAK = [
    '[TIKTOK_CHAT] user=Budi comment="berapa harga yang coklat itu"',
    '[TIKTOK_CHAT] user=penonton_88 comment="spill etalase 1"',
    "\u{1F4AC} Budi: berapa harga yang coklat itu",          // baris tanpa tag
    "Budi: berapa harga yang coklat itu",                     // tanpa tag, tanpa emoji
    "  [TIKTOK_CHAT] user=x comment=\"y\"",                   // berindentasi
  ];
  for (const b of DITOLAK) {
    assert.equal(trace("bot", b), false, "chat penonton LOLOS filter: " + b);
    assert.equal(shouldTrace(b), false, "shouldTrace meloloskan chat: " + b);
  }

  // Hanya satu baris tercatat: yang keputusan.
  assert.equal(tertulis.length, 1, "hanya keputusan yang boleh tercatat: " + JSON.stringify(tertulis));

  // Penolakannya dua lapis, dan keduanya dinyatakan - bukan kebetulan.
  assert.ok(TRACE_DENY.includes("TIKTOK_CHAT"), "ada di daftar TOLAK");
  assert.ok(!TRACE_TAGS.includes("TIKTOK_CHAT"), "dan tidak ada di daftar IZIN");

  // Dan menambahkan keluarga pemeliharaan TIDAK melonggarkan apa pun:
  // tidak ada tag chat yang berawalan keluarga yang diizinkan.
  assert.ok(!"TIKTOK_CHAT".startsWith("AUTOPIN_"), "keluarga AUTOPIN_ tidak menaungi chat");
});

test("FILTER: identitas penonton tetap ditolak - dan tidak ada di baris pemeliharaan", async () => {
  const { redactLine } = require("../desktop/support-log");
  const wajib = await barisWajib();

  // 1. Baris pemeliharaan tidak PERNAH membawa field identitas sama sekali.
  //    Ini yang paling kuat: bukan disunting, tapi tidak ada.
  const FIELD_IDENTITAS = /\b(user|nickname|uniqueId|displayName|requesterNickname)=/;
  for (const [nama, baris] of Object.entries(wajib)) {
    assert.ok(!FIELD_IDENTITAS.test(baris), "baris pemeliharaan membawa identitas (" + nama + "): " + baris);
    assert.ok(!/comment=/.test(baris), "baris pemeliharaan membawa komentar: " + baris);
  }

  // 2. Dan untuk tag yang DIIZINKAN tapi memang membawa identitas - [MATCH]
  //    membawa user= dan ia ada di daftar izin - lapis kedua tetap menyuntingnya.
  const cocok = "[CHILD:bot] [MATCH] scene=PAX-1 user=Budi Santoso via=spill etalase 1";
  const keluar = redactLine(cocok);
  assert.match(keluar, /user=<redacted>/, "identitas pada tag yang diizinkan harus tersunting: " + keluar);
  assert.ok(!keluar.includes("Budi"), "nama penonton lolos: " + keluar);
  // via= yang dibutuhkan audit tetap ada - penyuntingan tidak boleh menelan diagnosa.
  assert.match(keluar, /via=/, "via= harus tetap ada: " + keluar);

  // 3. Keputusan pemeliharaan melewati lapis kedua itu TANPA berubah, karena
  //    tidak ada satu pun field identitas di dalamnya yang bisa dikenali.
  for (const baris of Object.values(wajib)) {
    assert.equal(redactLine(baris), baris, "baris keputusan tidak boleh berubah: " + baris);
  }
});

test("PENCARIAN: tidak ada field pencarian yang DIPERKENALKAN ke jejak pemeliharaan", async () => {
  // Pemeliharaan tidak menambah satu pun field baru soal pencarian, dan tidak
  // boleh. Keadaan pencarian sudah dibawa `coverage`/`coverageReasons` sebagai
  // token (lihat test/autopin.completeness.test.js), dan itu sudah cukup untuk
  // menjelaskan kenapa sebuah sapuan tidak menghasilkan FULL.
  const { isi, dipancarkan } = await tulisKeBerkas();
  const semua = dipancarkan.join("\n") + "\n" + isi;

  for (const d of [/\bsearch\b/i, /\bquery\b/i, /\bkeyword\b/i, /\bcari\b/i, /\bq=/]) {
    assert.ok(!d.test(semua), "field pencarian muncul di jejak: " + d + "\n" + semua);
  }

  // Dan modulnya memang tidak punya jalan untuk membacanya.
  const src = fs.readFileSync(path.join(ROOT, "autopin", "catalogue-maintenance.js"), "utf8");
  const kode = src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  for (const d of [/SEARCH_INPUT/, /m4b_input_search/, /\.value\b/, /searchValue/]) {
    assert.ok(!d.test(kode), "modul tidak boleh menyentuh kotak pencarian: " + d);
  }
});

// ===========================================================================
// RAHASIA: tidak bisa DIPEROLEH, dan batas penjaga bentuk dicatat apa adanya
// ===========================================================================

test("RAHASIA: modul tidak punya jalan untuk MEMPEROLEH rahasia apa pun", () => {
  // Ini argumen yang paling kuat yang tersedia, dan ia struktural - bukan hasil
  // mencoba beberapa masukan. Seluruh permukaan data modul ini adalah sembilan
  // dependensi yang DISUNTIKKAN, dan hanya dua di antaranya mengembalikan data
  // (readState, requestRefresh). Tidak ada require, tidak ada process.env,
  // tidak ada config, tidak ada halaman, tidak ada cookie.
  //
  // Artinya "rahasia tidak diperkenalkan" tidak bergantung pada penyaringan:
  // tidak ada rahasia yang bisa SAMPAI ke modul ini untuk mulai dengan.
  const src = fs.readFileSync(path.join(ROOT, "autopin", "catalogue-maintenance.js"), "utf8");
  const kode = src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(kode.includes("function logNumber"), "kode harus tersisa");

  for (const d of [/\bprocess\.env\b/, /\brequire\s*\(/, /\bpassword\b/i, /\bcookie\b/i,
                   /\bsecret\b/i, /\bcredential/i, /\bconfig\b/, /\bpage\b/, /\bdocument\./]) {
    assert.ok(!d.test(kode), "modul tidak boleh menyentuh: " + d);
  }

  // Dan Phase B tidak menambah satu pun panggilan log di service.
  const svc = fs.readFileSync(path.join(ROOT, "autopin", "service.js"), "utf8");
  const kodeSvc = svc.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  assert.ok(!/log\("SERVICE_CATALOGUE_MAINT/.test(kodeSvc),
    "pemeliharaan tidak boleh memancarkan baris service terpisah");
});

test("RAHASIA: bentuk rahasia nyata tidak lolos ke log, lewat reason maupun coverage", async () => {
  // Diracuni lewat kedua field string yang DIRELAI dari pemanggil.
  const BENTUK = [
    "Sup3rSecret!",                                       // sandi campuran
    "tok_live_12345",                                     // api key bergaris bawah
    "sessionid=abc123def456",                             // cookie TikTok
    "ZZZbigcookievalue",                                  // sid_tt
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",              // JWT
    "a1f53c0eba80fe87fd46e8e70b991ef6d14000efb18f8fba99cdebdc298962e1", // hash 64
  ];
  for (const r of BENTUK) {
    for (const hasil of [{ ok: false, reason: r }, { ok: true, coverage: r }]) {
      const baris = await tangkapTeracuni(hasil);
      for (const b of baris) {
        assert.ok(!b.includes(r), "bentuk rahasia lolos ke log: " + r + " -> " + b);
      }
    }
  }
});

test("RAHASIA: BATAS penjaga bentuk - huruf kecil+angka saja TIDAK tertahan", () => {
  // Dicatat dengan sengaja, bukan disembunyikan. Penjaga bentuk menahan sesuatu
  // karena BENTUKNYA, jadi ia tidak bisa membedakan `empty` dari `hunter2`:
  // keduanya huruf kecil pendek. Yang tertahan adalah apa pun yang memuat huruf
  // besar, garis bawah, spasi, `=`, atau lebih dari 40 karakter - dan itu
  // mencakup cookie TikTok, JWT, api key, serta sandi campuran.
  //
  // Yang TIDAK tertahan: sandi huruf-kecil-semua seperti "sup3rsecret".
  //
  // Kenapa ini tetap bukan kebocoran: tes di atas membuktikan modul ini tidak
  // punya jalan untuk MEMPEROLEH rahasia, dan satu-satunya cara nilai seperti
  // itu muncul adalah kalau seseorang mengoperkannya lewat `reason`/`coverage`
  // hasil scheduleFullRefresh - yang hari ini literal tertutup semuanya.
  //
  // Lapis kedua (redactLine) TIDAK menolong di sini, karena ia mencocokkan NAMA
  // field, dan nama field pemeliharaan bukan nama rahasia. Jadi kalau suatu
  // hari sebuah rahasia memang dirutekan ke field keputusan, yang menahannya
  // harus daftar kosakata tertutup - bukan bentuk. Keputusan itu sengaja TIDAK
  // diambil sekarang: kosakata tertutup akan menampilkan `non-token` untuk
  // setiap alasan baru yang sah, dan alasan sebenarnya memang sudah tercatat di
  // baris SERVICE_CATALOGUE_* yang bersebelahan.
  const { logToken } = require("../autopin/catalogue-maintenance");

  // Tertahan:
  for (const v of ["Sup3rSecret!", "tok_live_12345", "sessionid=abc", "ZZZbig", "a".repeat(41)]) {
    assert.equal(logToken(v, "x"), "non-token", "harus tertahan: " + v);
  }
  // TIDAK tertahan - batas yang dicatat:
  for (const v of ["sup3rsecret", "verysecretkey", "qqqqwwwweeee"]) {
    assert.equal(logToken(v, "x"), v,
      "batas yang diketahui: huruf kecil+angka lolos bentuk (lihat komentar)");
  }

  // Dan lapis kedua memang tidak menutupinya, karena nama fieldnya bukan rahasia.
  const { redactLine } = require("../desktop/support-log");
  const baris = "[AUTOPIN_CATALOGUE_MAINT_FAILED] reason=sup3rsecret state=holding";
  assert.equal(redactLine(baris), baris, "redactLine berbasis nama field, jadi ia tidak ikut");
});
