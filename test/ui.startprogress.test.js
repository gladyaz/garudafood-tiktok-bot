// Kemajuan MULAI BOT.
//
// Satu klik START terukur 92 detik pada lima aturan dari keadaan dingin, dan
// sampai v0.1.0 layar hanya berbunyi satu kalimat statis selama itu. Aplikasi
// yang terlihat membeku akan ditutup paksa - dan penutupan paksa adalah persis
// jalur yang meninggalkan .bot.lock basi dan Chrome yatim yang, sejak runtime
// headless, tidak punya jendela untuk ditutup customer sendiri.
//
// Yang DIJAGA di sini adalah kejujurannya, bukan keindahannya:
//
//   - tidak ada persentase palsu dan tidak ada perkiraan waktu selesai
//   - tidak ada tahap yang tampil sebelum operasinya benar-benar dimulai
//   - tidak ada tahap basi yang tertinggal sesudah sukses MAUPUN gagal
//   - RUNNING tidak pernah diumumkan sebelum server mengatakannya
//
// Sebagian tes membaca SUMBER app.js. Itu disengaja: urutan "tandai dulu, baru
// kerjakan" tidak bisa dibuktikan dari modul murni, dan kalau dibalik nanti,
// tidak ada satu pun tes perilaku yang akan merah.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const I = require("../controller/public/i18n.js");
const U = require("../controller/public/ui-logic.js");

const LANGS = I.LANGS;
const HAN = /[一-鿿]/;

const APP = fs.readFileSync(path.join(__dirname, "..", "controller", "public", "app.js"), "utf8");

// Status server minimal. Hanya field yang benar-benar dibaca heroView.
const stopped = () => ({ automation: "STOPPED", config: { present: true } });
// RUNNING yang sudah hangat sepenuhnya. Sejak pass kejujuran pemanasan,
// RUNNING tanpa service.warm SENGAJA tidak berbunyi "siap sepenuhnya", jadi
// helper ini harus menyebutkannya - kalau tidak, yang diuji di bawah bukan
// lagi keadaan yang dimaksud.
const running = () => ({
  automation: "RUNNING",
  config: { present: true },
  service: { running: true, pid: 2, warm: { pin: true, reply: true } },
});

/* === bentuk daftar tahap ================================================= */

test("START_STAGES adalah urutan NYATA onStart, beku dan tanpa duplikat", () => {
  // Tahap `products` DIBUANG di P0-1. Pembacaan identitas/LIVE dan pembacaan
  // katalog dulu dua kali membuka Chrome, jadi dua tahap memang dua pekerjaan.
  // Sejak keduanya jadi SATU pembacaan, dua tahap akan berarti dua kalimat
  // lambat untuk satu pekerjaan - kemajuan yang dikarang.
  assert.deepEqual(U.START_STAGES, [
    "saving",
    "obs",
    "tiktok",
    "rules",
    "preflight",
    "preparing",
    "connecting",
  ]);
  assert.equal(Object.isFrozen(U.START_STAGES), true);
  assert.equal(new Set(U.START_STAGES).size, U.START_STAGES.length);
});

test("isStartStage menerima semuanya dan menolak yang bukan", () => {
  for (const s of U.START_STAGES) assert.equal(U.isStartStage(s), true, s);
  for (const junk of ["", null, undefined, "Obs", "menyiapkan", "preparing ", 0, {}]) {
    assert.equal(U.isStartStage(junk), false, JSON.stringify(junk));
  }
});

test("setiap tahap punya kalimatnya sendiri di KETIGA bahasa", () => {
  for (const s of U.START_STAGES) {
    const seen = LANGS.map((lang) => U.startStageText(s, lang));
    for (const text of seen) {
      assert.ok(text && text.length > 0, "tahap " + s + " kosong di salah satu bahasa");
    }
    // Tiga bahasa berbeda harus menghasilkan tiga kalimat berbeda. Dua yang
    // sama berarti satu bahasa belum diterjemahkan dan diam-diam memakai lain.
    assert.equal(new Set(seen).size, 3, "tahap " + s + " tidak beda di tiap bahasa: " + seen);
    assert.match(U.startStageText(s, "zh-CN"), HAN, "tahap " + s + " belum berbahasa Mandarin");
    assert.doesNotMatch(U.startStageText(s, "id"), HAN, "tahap " + s + " Indonesia kemasukan Han");
  }
});

// Tahap yang salah ketik harus HILANG dari layar, bukan menampilkan sesuatu
// yang terlihat benar. Pemanggilnya jatuh ke kalimat "sedang bekerja" yang lama.
test("tahap yang tidak dikenal mengembalikan string kosong", () => {
  for (const lang of LANGS) {
    for (const junk of ["prepare", "", null, undefined, "ui.start.obs"]) {
      assert.equal(U.startStageText(junk, lang), "", lang + " / " + junk);
    }
  }
});

/* === tidak ada angka yang dikarang ======================================= */

// REGRESI: tidak ada perkiraan waktu, dan tidak ada persen, di SELURUH teks
// kemajuan START - judul tahap MAUPUN catatan di bawahnya.
//
// Versi pertama catatan ini berbunyi "bisa berjalan sampai sekitar satu menit",
// dan angka itu SALAH: START terukur ~92 detik pada lima aturan dari keadaan
// dingin. Kalimat yang menjanjikan satu menit lalu berjalan satu setengah menit
// lebih buruk daripada tidak menjanjikan apa pun - ia mengajari customer bahwa
// layarnya macet. Customer yang yakin layarnya macet akan menutup paksa, dan
// penutupan paksa meninggalkan .bot.lock basi plus Chrome headless yatim yang
// tidak punya jendela untuk ditutup sendiri.
//
// Persentase punya cacat yang sama: pada pekerjaan yang durasinya tidak
// diketahui ia angka karangan, dan ia merusak kepercayaan tepat saat ia
// berhenti bergerak.
//
// Durasi START bergantung pada jumlah aturan, apakah profil Chrome dingin, dan
// seberapa lambat TikTok hari itu. Ia tidak bisa dijanjikan, jadi ia tidak
// boleh disebut.
test("REGRESI: teks kemajuan START tidak memuat perkiraan waktu atau persen", () => {
  const BANNED = [
    [/%/, "tanda persen"],
    [/\d/, "angka"],
    [/\b(detik|menit|jam)\b/i, "satuan waktu Indonesia"],
    [/\b(seconds?|minutes?|hours?|sec|min)\b/i, "satuan waktu Inggris"],
    [/[秒分时]/, "satuan waktu Mandarin"],
    [/\b(sekitar|kurang lebih|kira-kira)\b/i, "pendekatan durasi Indonesia"],
    [/\b(about|around|roughly|approximately|up to)\b/i, "pendekatan durasi Inggris"],
    [/(大约|左右)/, "pendekatan durasi Mandarin"],
    [/\b(eta|remaining|tersisa)\b/i, "hitungan sisa"],
  ];

  for (const lang of LANGS) {
    const note = I.DICT[lang]["ui.start.note"];
    assert.ok(note && note.length > 0, lang + " belum punya ui.start.note");

    // Judul tahap DAN catatan: keduanya teks kemajuan, keduanya dibaca customer.
    const copy = U.START_STAGES.map((st) => U.startStageText(st, lang)).concat([note]);

    for (const text of copy) {
      for (const pair of BANNED) {
        assert.doesNotMatch(text, pair[0], lang + " memuat " + pair[1] + ": " + JSON.stringify(text));
      }
    }
  }
});


/* === tahap menang selama rantainya berjalan ============================== */

test("tahap tampil di kartu status, dengan nada perhatian", () => {
  for (const lang of LANGS) {
    const hero = U.heroView({ status: stopped(), busy: true, startStage: "tiktok" }, lang);
    assert.equal(hero.title, U.startStageText("tiktok", lang));
    assert.equal(hero.note, I.DICT[lang]["ui.start.note"]);
    assert.equal(hero.tone, "attention");
  }
});

// Server bertransisi STOPPED -> PREFLIGHT -> STARTING selama rantai berjalan.
// Cabang-cabang itu dulu menang dan menimpa tahap dengan satu kata yang jauh
// lebih sedikit artinya bagi customer.
test("tahap menang atas STOPPED, PREFLIGHT, dan STARTING", () => {
  for (const automation of ["STOPPED", "PREFLIGHT", "STARTING"]) {
    const view = {
      status: { automation: automation, config: { present: true } },
      busy: true,
      startStage: "connecting",
    };
    const hero = U.heroView(view, "id");
    assert.equal(hero.title, U.startStageText("connecting", "id"), automation);
  }
});

test("tanpa tahap, kalimat 'sedang bekerja' yang lama tetap dipakai", () => {
  // Jalur ini milik Refresh dan Simpan, yang tidak punya tahap. Tidak boleh
  // berubah gara-gara START.
  for (const lang of LANGS) {
    const hero = U.heroView({ status: stopped(), busy: true }, lang);
    assert.equal(hero.title, I.DICT[lang]["ui.working"]);
    // Tahap yang salah ketik berakhir di sini juga, bukan di layar kosong.
    const typo = U.heroView({ status: stopped(), busy: true, startStage: "prepare" }, lang);
    assert.equal(typo.title, I.DICT[lang]["ui.working"]);
  }
});

/* === tidak ada tahap basi ================================================ */

// Nilai yang tertinggal di state tidak boleh bisa tampil. Ini lapis kedua:
// app.js memang mengosongkannya, tapi kalau suatu saat ia lupa, busy yang turun
// sudah cukup untuk menyembunyikannya.
test("tahap yang tertinggal TIDAK tampil begitu rantainya berhenti", () => {
  const hero = U.heroView({ status: stopped(), busy: false, startStage: "preparing" }, "id");
  assert.notEqual(hero.title, U.startStageText("preparing", "id"));
  assert.notEqual(hero.note, I.DICT.id["ui.start.note"]);
});

test("sesudah GAGAL, layar tidak berbunyi 'Menyiapkan automation...'", () => {
  const PREPARING = U.startStageText("preparing", "id");
  // Dua ujung kegagalan yang nyata: preflight merah (server tetap STOPPED) dan
  // start yang meledak (server melaporkan ERROR).
  for (const automation of ["STOPPED", "ERROR"]) {
    const hero = U.heroView(
      {
        status: { automation: automation, config: { present: true }, lastError: { code: "runtime-exited" } },
        busy: false,
        startStage: "preparing",
      },
      "id"
    );
    assert.notEqual(hero.title, PREPARING, automation);
    assert.notEqual(hero.note, I.DICT.id["ui.start.note"], automation);
  }
});

/* === RUNNING tidak diumumkan lebih awal ================================== */

test("selama tahap berjalan, judulnya BUKAN judul RUNNING", () => {
  for (const lang of LANGS) {
    const RUNNING_TITLE = I.DICT[lang]["ui.hero.running.title"];
    for (const s of U.START_STAGES) {
      const hero = U.heroView({ status: stopped(), busy: true, startStage: s }, lang);
      assert.notEqual(hero.title, RUNNING_TITLE, lang + "/" + s);
      assert.notEqual(hero.tone, "running", lang + "/" + s);
    }
  }
});

// "connecting" adalah tahap TERAKHIR, dan ia paling mirip "sudah jalan".
// Ia tetap tidak boleh terbaca sebagai RUNNING sampai server mengatakannya.
test("RUNNING baru muncul setelah server melaporkannya dan tahap dikosongkan", () => {
  const mid = U.heroView({ status: running(), busy: true, startStage: "connecting" }, "id");
  assert.equal(mid.title, U.startStageText("connecting", "id"), "tahap masih yang berlaku");
  assert.notEqual(mid.tone, "running");

  const done = U.heroView({ status: running(), busy: false, startStage: null }, "id");
  assert.equal(done.title, I.DICT.id["ui.hero.running.title"]);
  assert.equal(done.tone, "running");
});

/* === lampu tally tidak boleh berbohong =================================== */

// Satu toko yang benar-benar siap: tanpa ini, lampunya memang abu-abu karena
// ada penghalang, dan tesnya lulus tanpa membuktikan apa pun.
const readyShop = () => ({
  status: {
    automation: "STOPPED",
    config: { present: true },
    bot: { running: false },
    login: { active: false },
    mode: { ok: true },
  },
  obs: { ok: true, scenes: ["PAX-1"] },
  tiktok: { ok: true, live: true, identityOk: true, productCount: 1 },
  products: [{ id: "p1" }],
  scenes: ["PAX-1"],
  config: { mappings: [{ scene: "PAX-1", product: "p1", triggers: ["pax 1"] }] },
  validation: { ok: true },
  dirty: false,
  busy: false,
  startStage: null,
});

// Hijau di lampu ini punya SATU arti: MULAI BOT benar-benar bisa ditekan.
// Selama rantai START berjalan tombolnya justru mati - jadi hijau berbohong,
// dan ia berbohong paling lama tepat di fase yang paling terasa menggantung:
// server masih STOPPED sementara UI sudah membuka Chrome tiga kali.
test("selama rantai START, lampu tally TIDAK hijau", () => {
  for (const lang of LANGS) {
    const idle = U.tallyView(readyShop(), lang);
    assert.equal(idle.tone, "ready", lang + ": prasyarat, toko ini memang siap");

    for (const s of U.START_STAGES) {
      const view = Object.assign(readyShop(), { busy: true, startStage: s });
      const tally = U.tallyView(view, lang);
      assert.notEqual(tally.tone, "ready", lang + "/" + s + ": lampu hijau selama START");
      assert.notEqual(tally.label, I.DICT[lang]["ui.pill.ready"], lang + "/" + s);
      assert.equal(tally.tone, "attention", lang + "/" + s);
    }
  }
});

test("label PREFLIGHT dan STARTING yang lebih spesifik TIDAK ditimpa", () => {
  // Cabang baru diletakkan SESUDAH switch justru supaya dua label ini bertahan.
  const at = (automation) =>
    U.tallyView(
      Object.assign(readyShop(), {
        status: Object.assign(readyShop().status, { automation: automation }),
        busy: true,
        startStage: "obs",
      }),
      "id"
    ).label;

  const generic = I.DICT.id["ui.pill.checking"];
  assert.notEqual(at("PREFLIGHT"), generic, "label preflight ikut tergeneralisasi");
  assert.notEqual(at("STARTING"), generic, "label starting ikut tergeneralisasi");
  assert.equal(at("STOPPED"), generic, "fase paling awal harus memakai label umum");
});

test("hijau kembali begitu rantainya selesai", () => {
  // Tahap yang tertinggal tidak boleh menahan lampunya tetap kuning.
  const after = Object.assign(readyShop(), { busy: false, startStage: "connecting" });
  assert.equal(U.tallyView(after, "id").tone, "ready");
});

/* === yang TIDAK boleh berubah ============================================ */

test("tahap tidak menyentuh tombol: START mati, STOP apa adanya", () => {
  const base = { status: { automation: "STOPPED", config: { present: true } }, busy: true };
  const withStage = Object.assign({}, base, { startStage: "preparing" });

  const a = U.controlsFor(base, "id");
  const b = U.controlsFor(withStage, "id");

  assert.equal(a.startEnabled, false, "START harus mati selama rantai berjalan");
  assert.equal(b.startEnabled, false);
  // Semantik STOP dipertahankan APA ADANYA pada pass ini, tidak dirapikan.
  assert.equal(b.stopEnabled, a.stopEnabled);
  assert.equal(b.editingEnabled, a.editingEnabled);
  assert.equal(b.refreshEnabled, a.refreshEnabled);
  assert.equal(b.discoveryAllowed, a.discoveryAllowed);
});

/* === app.js: tandai DULU, baru kerjakan ================================== */

// Penandanya muncul dengan DUA nama: `setStage("x")` di onStart, dan `stage("x")`
// di dalam loadDiscovery - yang menerimanya sebagai callback, supaya Periksa
// ulang dan Stop tidak ikut berubah. Keduanya dicari; yang paling awal dipakai.
const marks = (stage) => {
  const hits = ['setStage("' + stage + '")', 'stage("' + stage + '")']
    .map((needle) => APP.indexOf(needle))
    .filter((i) => i !== -1);
  return hits.length ? Math.min.apply(null, hits) : -1;
};

// Badan startWithProgress, dipakai beberapa tes di bawah.
const startBody = () =>
  APP.slice(APP.indexOf("function startWithProgress"), APP.indexOf("function onStop"));

// `connecting` adalah SATU-SATUNYA tahap yang tidak ditandai lewat nama literal:
// ia DITURUNKAN dari bot.running di dalam startWithProgress. Itu memang yang
// diminta - tahap ini milik keadaan server, bukan milik urutan panggilan UI.
const DERIVED = ["connecting"];

test("setiap tahap benar-benar ditandai di app.js", () => {
  for (const s of U.START_STAGES) {
    if (DERIVED.indexOf(s) !== -1) continue;
    assert.ok(marks(s) !== -1, "tahap " + s + " ada di kamus tapi tidak pernah ditandai");
  }

  const body = startBody();
  for (const s of DERIVED) {
    assert.ok(
      body.indexOf('"' + s + '"') !== -1,
      "tahap " + s + " ada di kamus tapi tidak diturunkan di startWithProgress"
    );
  }
});

// Tahap yang dilaporkan SESUDAH pekerjaannya selesai adalah tahap yang bohong
// tentang apa yang sedang terjadi sekarang.
test("penanda tahap berada SEBELUM operasi yang diwakilinya", () => {
  const PAIRS = [
    ["obs", "/api/obs/scenes"],
    // Satu pembacaan untuk identitas, status LIVE, katalog, DAN verdict
    // pemetaan. Tahap `rules` ditandai saat verdict itu diterapkan, dan ia
    // memang lewat cepat - tidak ada jeda yang ditambahkan.
    ["tiktok", "/api/discovery"],
    ["rules", "state.validation"],
    // Sejak P0-3 tahap ini TIDAK lagi menandai POST /api/preflight milik UI -
    // panggilan itu dibuang karena startAutomation() menjalankan preflight
    // sendiri, sehingga seluruh delapan check dikerjakan dua kali per START.
    // Tahapnya sekarang menandai awal /api/start, yang pekerjaan pertamanya
    // memang preflight server. Lihat test/controller.preflightdedup.test.js.
    ["preflight", "startWithProgress()"],
  ];
  for (const [stage, op] of PAIRS) {
    const marker = marks(stage);
    const call = APP.indexOf(op, marker);
    assert.ok(marker !== -1, "penanda " + stage + " hilang");
    assert.ok(call !== -1, "operasi " + op + " tidak ditemukan setelah penandanya");
    assert.ok(marker < call, stage + " ditandai SETELAH " + op + " dipanggil");
  }
});

test("tahap dikosongkan di jalur sukses MAUPUN gagal", () => {
  const cleared = APP.split("setStage(null)").length - 1;
  assert.ok(cleared >= 2, "setStage(null) hanya muncul " + cleared + "x; butuh sukses dan gagal");
});

// Poll yang tidak pernah dimatikan akan terus menembak /api/status selamanya
// sesudah START selesai, dan setiap jawabannya menulis ulang tahap.
test("poll selama /api/start selalu dimatikan di kedua ujung", () => {
  const body = startBody();
  assert.ok(body.length > 0, "startWithProgress tidak ditemukan");
  assert.ok(body.indexOf("clearInterval") !== -1, "timernya tidak pernah dimatikan");
  // done() dipanggil di jalur resolve DAN reject.
  assert.ok(body.split("done()").length - 1 >= 3, "done() tidak dipanggil di kedua ujung");
});

// Tahap diturunkan dari keadaan server, bukan dari state machine kedua di UI.
test("tahap 'connecting' diturunkan dari laporan server, bukan dikarang", () => {
  const body = startBody();
  assert.ok(body.indexOf("/api/status") !== -1, "tidak membaca keadaan server");
  assert.ok(body.indexOf("bot") !== -1 && body.indexOf("running") !== -1, "tidak membaca bot.running");
  // Tidak boleh menulis state.status: polling yang menulis bisa menimpa
  // kebenaran yang sedang ditampilkan.
  assert.equal(body.indexOf("state.status ="), -1, "poll menulis ke state.status");
});

// startPolling() 2 detik akan mengecat ulang kartu status dengan status server
// mentah di tengah rantai, menimpa tahap. Ia dijaga oleh penjaga busy.
test("polling 2 detik tidak berjalan selama rantai START", () => {
  const body = APP.slice(APP.indexOf("function startPolling"), APP.indexOf("function init"));
  assert.ok(body.length > 0, "startPolling tidak ditemukan");
  assert.ok(body.indexOf("if (state.busy) return;") !== -1, "penjaga busy hilang dari polling");
});
