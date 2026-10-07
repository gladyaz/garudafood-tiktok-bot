// Titik operasi yang BENAR-BENAR akan dipakai: katalog 20 produk, batas tunggu
// bot 12 detik.
//
// test/autopin.budget.test.js menguji MODEL anggarannya (2/20/40/60 produk,
// 7/8/10 detik, batas-batasnya). Berkas ini menguji satu konfigurasi saja -
// yang hendak dipasang di produksi - dan menanyakan hal yang berbeda:
//
//   * apakah produk di posisi ATAS, TENGAH, dan BAWAH sama-sama muat?
//   * apakah restart bot di tengah tekanan anggaran tetap aman?
//   * apakah ledakan permintaan penonton tetap menghasilkan paling banyak
//     SATU pin dan SATU chat per playId?
//
// Angka 12 detik bukan tebakan. Pada katalog 20 produk, 8 detik terbukti
// menolak sebelum klik di SEMUA posisi, dan 10 detik masih menolak kalau
// produknya duduk di ujung daftar. Tes kedua di bawah ini yang menjaga alasan
// itu tetap terlihat kalau suatu saat ada yang mau menurunkannya lagi.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { inspectPinResult } = require("../autopin/pin-result");
const { createAutoComment, PIN_POLICY } = require("../autocomment/core");
const { harness, botGate, report } = require("./helpers/pin-harness");

const HTTP = 12_000;
const TOTAL = 20;
// Atas, tengah, bawah. Posisi bawah yang paling mahal: snapshot harus menggulir
// sampai ujung daftar sebelum menemukan produknya.
const POSISI = [
  ["atas", 1],
  ["tengah", 10],
  ["bawah", 20],
];

// ===================================================================
// 1. Titik operasi 12 detik, posisi atas / tengah / bawah
// ===================================================================

test("12 DETIK: posisi atas, tengah, dan bawah - semuanya muat, TEPAT satu klik", async () => {
  for (const [label, pos] of POSISI) {
    const h = harness({ total: TOTAL, targetPos: pos, httpTimeoutMs: HTTP });
    const { r, elapsed } = await h.pin();

    assert.equal(r.ok, true, `${label} (#${pos}): seharusnya berhasil, dapat ${r.reason}`);
    assert.equal(r.state, "Unpin", `${label}: state akhir harus Unpin`);
    assert.equal(h.counters.clicks, 1, `${label}: harus TEPAT satu klik`);
    assert.equal(botGate(r).confirmed, true, `${label}: bot harus setuju terkonfirmasi`);

    // Jawaban harus sampai sebelum bot berhenti mendengar, dengan margin.
    assert.ok(elapsed < HTTP, `${label}: dijawab ${elapsed}ms, batas bot ${HTTP}ms`);
    assert.ok(
      elapsed <= h.pinTimeouts.browserDeadlineMs,
      `${label}: ${elapsed}ms melewati deadline browser ${h.pinTimeouts.browserDeadlineMs}ms`
    );

    report(`${label} (#${pos})`, `${elapsed} ms  sisa=${HTTP - elapsed} ms  via=${r.confirmedVia}`);
  }
});

test("MENGAPA 12 DETIK: 8 detik kehilangan tengah dan bawah, 10 detik kehilangan bawah", async () => {
  // Kalau suatu saat ada yang menurunkan angkanya lagi, tes ini yang
  // menjelaskan apa yang hilang - per posisi, bukan sebagai kesan umum.
  //
  // Yang diperiksa keras di sini hanya kasus yang MENENTUKAN. Posisi #1 di 8
  // detik sengaja TIDAK dipatok arahnya: ia lolos di model dengan sisa ~780 ms,
  // dan dengan timer nyata (koleksi ~4400 ms, bukan 4160 ms) justru menolak.
  // Mematok arah di titik sedekat itu berarti menguji ketepatan jam palsu,
  // bukan perilaku yang kita pedulikan.
  const kasus = [
    { http: 8_000, pos: 10, label: "tengah", harusDitolak: true },
    { http: 8_000, pos: 20, label: "bawah", harusDitolak: true },
    { http: 10_000, pos: 20, label: "bawah", harusDitolak: true },
    { http: HTTP, pos: 1, label: "atas", harusDitolak: false },
    { http: HTTP, pos: 10, label: "tengah", harusDitolak: false },
    { http: HTTP, pos: 20, label: "bawah", harusDitolak: false },
  ];

  for (const k of kasus) {
    const h = harness({ total: TOTAL, targetPos: k.pos, httpTimeoutMs: k.http });
    const { r, elapsed } = await h.pin();
    const nama = `${k.http / 1000}s ${k.label} (#${k.pos})`;

    if (k.harusDitolak) {
      assert.equal(r.ok, false, `${nama}: seharusnya ditolak`);
      assert.equal(r.reason, "budget-exhausted-before-click", `${nama}: alasannya anggaran`);
      assert.equal(r.clicked, false, `${nama}: penolakan harus TANPA klik`);
      assert.equal(h.counters.clicks, 0, `${nama}: tidak boleh ada klik sama sekali`);
    } else {
      assert.equal(r.ok, true, `${nama}: seharusnya berhasil, dapat ${r.reason}`);
      assert.equal(h.counters.clicks, 1, `${nama}: tepat satu klik`);
      assert.equal(botGate(r).confirmed, true, `${nama}: bot setuju terkonfirmasi`);
    }
    report(nama, r.ok ? `ok   ${elapsed} ms  klik=1` : `TOLAK ${r.reason}  klik=0`);
  }

  // Posisi atas di 8 detik: arahnya bebas, invariannya tidak.
  const mepet = harness({ total: TOTAL, targetPos: 1, httpTimeoutMs: 8_000 });
  const m = await mepet.pin();
  assert.ok(mepet.counters.clicks <= 1, "apa pun hasilnya, paling banyak satu klik");
  assert.ok(m.elapsed < 8_000, "apa pun hasilnya, dijawab sebelum batas bot");
  if (!m.r.ok) assert.equal(m.r.clicked, false, "kalau ditolak, tidak boleh ada klik");
  report("8s atas (#1) - memang mepet", `${m.r.ok ? "ok" : m.r.reason}  ${m.elapsed} ms`);
});

test("12 DETIK: makin dalam posisinya, makin mahal snapshot-nya - jaminannya tidak berubah", async () => {
  const baris = [];
  for (const [label, pos] of POSISI) {
    const h = harness({ total: TOTAL, targetPos: pos, httpTimeoutMs: HTTP });
    const { r, elapsed } = await h.pin();
    const m = /snapshot-confirm=(\d+)/.exec(r.timing || "");
    baris.push({ label, pos, elapsed, snapshotMs: m ? Number(m[1]) : 0, clicks: h.counters.clicks });
  }

  // Biayanya naik...
  assert.ok(
    baris[0].snapshotMs <= baris[1].snapshotMs && baris[1].snapshotMs <= baris[2].snapshotMs,
    "biaya snapshot harus naik (atau tetap) seiring posisi makin dalam: " +
      baris.map((b) => `${b.label}=${b.snapshotMs}ms`).join(" ")
  );
  // ...tapi jaminannya tidak.
  for (const b of baris) {
    assert.equal(b.clicks, 1, `${b.label}: tetap satu klik`);
    assert.ok(b.elapsed < HTTP, `${b.label}: tetap dijawab tepat waktu`);
    report(`snapshot ${b.label} (#${b.pos})`, `${b.snapshotMs} ms   total ${b.elapsed} ms`);
  }
});

test("SINYAL PRIMER TERBACA: seperti LIVE posisi #1 - snapshot tidak dipakai", async () => {
  // LIVE 2026-10-06: pin produk #1 dari 20 terkonfirmasi lewat sinyal TOMBOL
  // pada bacaan pertama (via=button-text reads=1), snapshot tidak pernah jalan,
  // total 3596 ms. Jadi asumsi "primer selalu buta" yang dipakai model anggaran
  // memang pesimis - dan tes ini yang menjaga jalur murahnya tetap ada.
  const h = harness({ total: TOTAL, targetPos: 1, httpTimeoutMs: HTTP, primaryBlind: false });
  const { r, elapsed } = await h.pin();

  assert.equal(r.ok, true);
  assert.equal(r.confirmedVia, "button-text", "harus lewat sinyal tombol, bukan snapshot");
  assert.equal(h.counters.snapshots, 0, "snapshot TIDAK boleh dipanggil saat primer terbaca");
  assert.equal(h.counters.clicks, 1);

  const buta = harness({ total: TOTAL, targetPos: 1, httpTimeoutMs: HTTP, primaryBlind: true });
  const b = await buta.pin();
  assert.ok(
    elapsed < b.elapsed,
    `jalur primer (${elapsed}ms) harus lebih murah daripada jalur snapshot (${b.elapsed}ms)`
  );
  report("primer terbaca vs buta", `${elapsed} ms  vs  ${b.elapsed} ms`);
});

// ===================================================================
// 2. Restart sesi di bawah tekanan anggaran
// ===================================================================

test("RESTART SESI: sesi baru dengan playId kecil tetap diterima dan tetap di-pin", async () => {
  // Regresi 2026-10-05: restart bot membuat playId mundur ke 1 sementara
  // service masih ingat latest=3, dan semua pin baru ditolak "stale". Di sini
  // diuji LAGI, tapi di bawah tekanan anggaran katalog 20 produk.
  const h = harness({ total: TOTAL, targetPos: 10, httpTimeoutMs: HTTP });

  const lama = await h.pin({ playId: 3, sessionId: "sesi-A" });
  assert.equal(lama.r.ok, true, "pin sesi lama harus berhasil");
  assert.equal(h.counters.clicks, 1);

  const baru = await h.pin({ playId: 1, sessionId: "sesi-B" });
  assert.equal(baru.r.ok, true, "restart bot TIDAK boleh membuat pin baru dianggap basi");
  assert.notEqual(baru.r.reason, "stale");
  assert.equal(h.counters.clicks, 2, "dua pemutaran berbeda -> dua klik, masing-masing satu");
  assert.ok(baru.elapsed < HTTP, "sesudah restart pun jawabannya tetap tepat waktu");
  report("restart sesi A#3 -> B#1", `keduanya ok, klik total ${h.counters.clicks}`);
});

test("SESI SAMA: playId mundur tetap basi, NOL klik tambahan", async () => {
  const h = harness({ total: TOTAL, targetPos: 10, httpTimeoutMs: HTTP });
  await h.pin({ playId: 5, sessionId: "sesi-A" });
  assert.equal(h.counters.clicks, 1);

  const mundur = await h.pin({ playId: 2, sessionId: "sesi-A" });
  assert.equal(mundur.r.ok, false);
  assert.equal(mundur.r.reason, "stale");
  assert.equal(h.counters.clicks, 1, "permintaan basi tidak boleh menambah klik");
});

// ===================================================================
// 3. Ledakan permintaan penonton (burst / antrean)
// ===================================================================

test("BURST: playId yang SAMA diulang berurutan -> paling banyak SATU klik", async () => {
  // Satu pemutaran = satu playId = paling banyak satu pin. Permintaan kedua
  // untuk playId yang sama adalah duplikat (pengiriman ulang, atau proses bot
  // kembar), bukan pemutaran baru.
  const h = harness({ total: TOTAL, targetPos: 10, httpTimeoutMs: HTTP });
  const a = await h.pin({ playId: 1 });
  const b = await h.pin({ playId: 1 });

  assert.equal(a.r.ok, true, "permintaan pertama harus berhasil");
  assert.equal(
    h.counters.clicks,
    1,
    `playId yang sama tidak boleh diklik dua kali (dapat ${h.counters.clicks})`
  );
  assert.equal(b.r.ok, false, "permintaan kedua untuk playId yang sama harus ditolak");
  assert.equal(b.r.reason, "duplicate-playId");
  assert.equal(b.r.clicked, false);
});

test("BURST: 50 permintaan SERENTAK untuk playId yang sama -> tetap satu klik", async () => {
  const h = harness({ total: TOTAL, targetPos: 10, httpTimeoutMs: HTTP });
  const hasil = await Promise.all(
    Array.from({ length: 50 }, () => h.pin({ playId: 7, sessionId: "sesi-A" }))
  );

  assert.equal(h.counters.clicks, 1, `50 permintaan kembar -> harus 1 klik, dapat ${h.counters.clicks}`);
  const sukses = hasil.filter((x) => x.r.ok).length;
  assert.equal(sukses, 1, `hanya satu yang boleh melapor berhasil, dapat ${sukses}`);
  const duplikat = hasil.filter((x) => x.r.reason === "duplicate-playId").length;
  assert.equal(duplikat, 49, `sisanya harus ditolak duplicate-playId, dapat ${duplikat}`);
  report("burst 50x playId sama", `klik=${h.counters.clicks} ok=${sukses} duplikat=${duplikat}`);
});

test("PUTAR ULANG: scene yang sama dengan playId BARU tetap boleh di-pin lagi", async () => {
  // Penjaga duplikat tidak boleh kebablasan. Di sisi bot playId naik setiap kali
  // sebuah scene MULAI di-switch (index.js nextPlayId), jadi memutar ulang scene
  // yang sama - termasuk lewat `force` - selalu membawa playId baru dan WAJIB
  // tetap bisa mem-pin. Yang ditolak hanya playId yang benar-benar terulang.
  const h = harness({ total: TOTAL, targetPos: 10, httpTimeoutMs: HTTP });

  const pertama = await h.pin({ scene: "PAX-1", playId: 1 });
  const ulang = await h.pin({ scene: "PAX-1", playId: 2 });

  assert.equal(pertama.r.ok, true, "pemutaran pertama harus berhasil");
  assert.equal(ulang.r.ok, true, "pemutaran ULANG dengan playId baru harus tetap berhasil");
  assert.notEqual(ulang.r.reason, "duplicate-playId");
  assert.equal(h.counters.clicks, 2, "dua pemutaran berbeda -> dua klik");
});

test("DIAGNOSTIK: playId 0 tidak kena dedupe (alat baca-saja boleh diulang)", async () => {
  // playId <= 0 dipakai alat diagnostik dan sudah dikecualikan dari aturan basi.
  // Dedupe harus mengikuti pengecualian yang sama, kalau tidak alat itu cuma
  // bisa dipakai sekali per proses.
  const h = harness({ total: TOTAL, targetPos: 10, httpTimeoutMs: HTTP });
  const a = await h.pin({ playId: 0 });
  const b = await h.pin({ playId: 0 });

  assert.equal(a.r.ok, true);
  assert.equal(b.r.ok, true, "playId 0 tidak boleh ditolak sebagai duplikat");
  assert.notEqual(b.r.reason, "duplicate-playId");
});

test("BURST: playId menaik serentak -> yang lama basi, satu klik saja", async () => {
  const h = harness({ total: TOTAL, targetPos: 10, httpTimeoutMs: HTTP });
  const hasil = await Promise.all([1, 2, 3, 4, 5].map((id) => h.pin({ playId: id })));

  assert.equal(h.counters.clicks, 1, "yang menang hanya pemutaran terbaru");
  const menang = hasil.filter((x) => x.r.ok);
  assert.equal(menang.length, 1);
  const basi = hasil.filter((x) => x.r.reason === "stale").length;
  assert.equal(basi, 4, `empat permintaan lama harus basi, dapat ${basi}`);
});

test("BURST: di bawah beban, service TETAP menjawab sebelum batas tunggu bot", async () => {
  // Properti yang paling tidak boleh hilang: tidak peduli seramai apa, bot
  // tidak boleh menyerah sementara service diam-diam masih mengklik.
  const h = harness({ total: TOTAL, targetPos: 20, httpTimeoutMs: HTTP });
  const hasil = await Promise.all(
    Array.from({ length: 30 }, (_, i) => h.pin({ playId: 1 + (i % 3), sessionId: "sesi-A" }))
  );

  for (const x of hasil) {
    assert.ok(x.elapsed < HTTP, `ada jawaban yang telat: ${x.elapsed}ms >= ${HTTP}ms`);
  }
  assert.ok(h.counters.clicks <= 3, `tiga playId -> paling banyak tiga klik, dapat ${h.counters.clicks}`);
  report("burst 30x (3 playId)", `klik=${h.counters.clicks} jawaban terlambat=0`);
});

// ===================================================================
// 4. Waktu tunggu antrean ikut memakan anggaran
// ===================================================================

test("ANTREAN: waktu menunggu giliran ikut terhitung - yang telat ditolak TANPA klik", async () => {
  // Hanya satu mutasi UI boleh jalan pada satu waktu. Dulu jam anggaran baru
  // mulai ketika guardedPin mulai, jadi permintaan yang menunggu 7 detik di
  // antrean masih merasa punya 10,2 detik penuh - dan baru menjawab di detik
  // ~14,7, padahal bot sudah menyerah di detik 12. Sekarang jamnya mulai sejak
  // permintaan DITERIMA.
  //
  // Tiga sesi bot berbeda: masing-masing tidak pernah "basi" terhadap yang lain
  // (sesi berbeda tidak dibandingkan), jadi ketiganya benar-benar antre.
  const h = harness({ total: TOTAL, targetPos: 10, httpTimeoutMs: HTTP });
  const hasil = await Promise.all([
    h.pin({ scene: "PAX-1", playId: 1, sessionId: "bot-A" }),
    h.pin({ scene: "PAX-2", playId: 1, sessionId: "bot-B" }),
    h.pin({ scene: "PAX-3", playId: 1, sessionId: "bot-C" }),
  ]);

  // Satu yang kebagian, dua sisanya ditolak - dan ditolak TANPA menyentuh apa pun.
  assert.equal(h.counters.clicks, 1, `hanya satu yang boleh mengklik, dapat ${h.counters.clicks}`);
  const sukses = hasil.filter((x) => x.r.ok);
  assert.equal(sukses.length, 1);
  const tertolak = hasil.filter((x) => !x.r.ok);
  for (const t of tertolak) {
    assert.equal(t.r.reason, "budget-exhausted-in-queue", "alasannya harus menyebut antrean");
    assert.equal(t.r.clicked, false, "penolakan karena antrean harus NOL mutasi");
  }

  // Dan yang paling penting: semuanya menjawab sebelum bot berhenti mendengar.
  for (const x of hasil) {
    assert.ok(x.elapsed < HTTP, `jawaban telat: ${x.elapsed}ms >= ${HTTP}ms`);
  }
  report("antre 3 sesi bot", `klik=1 tertolak=${tertolak.length} jawaban terlambat=0`);
});

test("ANTREAN: waktu tunggu tercatat di instrumentasi (queue-wait)", async () => {
  // Kalau waktu tunggunya tidak terlihat di log, bottleneck antrean mustahil
  // didiagnosis dari lapangan.
  const h = harness({ total: 2, targetPos: 1, httpTimeoutMs: HTTP });
  const hasil = await Promise.all([
    h.pin({ scene: "PAX-1", playId: 1, sessionId: "bot-A" }),
    h.pin({ scene: "PAX-2", playId: 1, sessionId: "bot-B" }),
  ]);

  // Katalog 2 produk murah, jadi yang kedua masih kebagian anggaran - tapi ia
  // menunggu, dan tunggunya harus tercatat.
  const kedua = hasil[1];
  assert.equal(kedua.r.ok, true, "katalog kecil: yang kedua masih harus kebagian");
  assert.match(
    kedua.r.timing || "",
    /queue-wait=\d+/,
    `waktu tunggu harus muncul di timing, dapat: ${kedua.r.timing}`
  );
  const m = /queue-wait=(\d+)/.exec(kedua.r.timing);
  assert.ok(Number(m[1]) > 0, "waktu tunggunya harus lebih dari nol");
  report("queue-wait tercatat", `${m[1]} ms`);
});

// ===================================================================
// 5. Satu AutoComment per playId
// ===================================================================

test("SATU CHAT PER playId: permintaan chat kembar -> hanya satu yang terkirim", async () => {
  const kirim = [];
  const ac = createAutoComment({
    enabled: true,
    pinPolicy: PIN_POLICY.CONFIRMED,
    inspectPin: inspectPinResult,
    send: async (req) => {
      kirim.push(`${req.scene}#${req.playId}`);
      return { ok: true };
    },
    maxPerMinute: 100,
    minIntervalMs: 0,
    logger: { log() {} },
  });

  const h = harness({ total: TOTAL, targetPos: 10, httpTimeoutMs: HTTP });
  const { r } = await h.pin({ playId: 4 });
  assert.equal(r.ok, true);

  // Lima permintaan chat untuk pemutaran yang SAMA.
  for (let i = 0; i < 5; i += 1) {
    await ac.requestComment({ scene: "PAX-1", playId: 4, requesters: 1, pin: r });
  }
  assert.deepEqual(kirim, ["PAX-1#4"], `satu chat per playId, dapat ${JSON.stringify(kirim)}`);
});

test("NOL CHAT PALSU di 12 detik: pin yang ditolak anggaran tidak menghasilkan chat", async () => {
  const kirim = [];
  const ac = createAutoComment({
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

  // 40 produk tidak muat walau di 12 detik: daftarnya tidak pernah lengkap.
  const h = harness({ total: 40, targetPos: 20, httpTimeoutMs: HTTP });
  const { r } = await h.pin({ playId: 1 });
  assert.equal(r.ok, false);
  assert.equal(h.counters.clicks, 0, "tidak lengkap -> tidak boleh diklik");

  await ac.requestComment({ scene: "PAX-1", playId: 1, requesters: 1, pin: r });
  assert.deepEqual(kirim, [], "pin yang tidak terkonfirmasi tidak boleh menghasilkan chat");
});
