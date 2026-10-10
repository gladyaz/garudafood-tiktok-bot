// Logika dashboard. Ini tempat PERILAKU UI diuji.
//
// Repo ini tidak punya jsdom, dan P3 sengaja tidak menambahkannya. Jawabannya
// bukan "berarti UI tidak diuji", tapi memindahkan setiap KEPUTUSAN keluar dari
// handler DOM ke controller/public/ui-logic.js — modul murni yang bisa dipanggil
// langsung dari Node. app.js tinggal memetakan hasilnya ke DOM tanpa percabangan.
//
// Jadi yang diuji di sini adalah hal yang sesungguhnya: tombol mana yang boleh
// ditekan, apa yang muncul di dropdown, kalimat mana yang tampil, dan berapa
// banyak kejadian yang ditahan.
//
// Satu aturan yang dijaga keras: ui-logic.js TIDAK PERNAH membentuk kalimat untuk
// customer dari kode mesin. Server yang mengirimnya. Menyalin katalog
// controller/errors.js ke frontend akan mengulang kesalahan P2, ketika salinan
// normalizeTitleKey menyimpang dan membuat Controller mengatakan hal yang salah.

const { test } = require("node:test");
const assert = require("node:assert/strict");

// Kalimat customer tidak lagi diassert sebagai prosa: ia dibandingkan dengan
// KAMUS. Mengubah kata-kata tidak memerahkan tes; salah kabel tetap merah.
const I18N = require("../controller/public/i18n.js");
const T = (key, vars) => I18N.t("id", key, vars);

const U = require("../controller/public/ui-logic.js");

// --- saran PAX ---------------------------------------------------------------

test("saran PAX dibentuk untuk PAX-1..PAX-10", () => {
  for (let n = 1; n <= 10; n += 1) {
    const s = U.suggestForScene("PAX-" + n);
    assert.equal(s.trigger, "spill etalase " + n);
    assert.equal(s.reply, "Etalase " + n + " sudah aku pin ya kak");
  }
});

test("scene di luar PAX-1..10 tidak punya saran", () => {
  for (const scene of ["PAX-0", "PAX-11", "PAX-99", "MAIN", "AI LIVE_FAQ_CO", "", null, undefined, "pax-1"]) {
    assert.equal(U.suggestForScene(scene), null, String(scene));
  }
});

test("saran MENGISI field yang kosong", () => {
  const r = U.applySuggestion({ trigger: "", reply: "" }, "PAX-3");
  assert.equal(r.trigger, "spill etalase 3");
  assert.equal(r.reply, "Etalase 3 sudah aku pin ya kak");
});

test("saran TIDAK PERNAH menimpa teks yang sudah disunting", () => {
  // Saran yang menimpa tulisan orang adalah cara tercepat membuat orang berhenti
  // mempercayai formulir — dan teks ini adalah kalimat yang dibaca penonton.
  const r = U.applySuggestion({ trigger: "kata kunci milikku", reply: "kalimat milikku" }, "PAX-1");
  assert.equal(r.trigger, "kata kunci milikku");
  assert.equal(r.reply, "kalimat milikku");
});

test("saran mengisi hanya field yang kosong, bukan keduanya sekaligus", () => {
  const a = U.applySuggestion({ trigger: "punyaku", reply: "" }, "PAX-2");
  assert.equal(a.trigger, "punyaku");
  assert.equal(a.reply, "Etalase 2 sudah aku pin ya kak");

  const b = U.applySuggestion({ trigger: "", reply: "punyaku" }, "PAX-2");
  assert.equal(b.trigger, "spill etalase 2");
  assert.equal(b.reply, "punyaku");
});

test("teks berisi spasi saja dianggap kosong dan boleh diisi saran", () => {
  const r = U.applySuggestion({ trigger: "   ", reply: "\n " }, "PAX-5");
  assert.equal(r.trigger, "spill etalase 5");
  assert.equal(r.reply, "Etalase 5 sudah aku pin ya kak");
});

test("scene non-PAX tidak mengubah apa pun", () => {
  const r = U.applySuggestion({ trigger: "", reply: "" }, "AI LIVE_FAQ_CO");
  assert.equal(r.trigger, "");
  assert.equal(r.reply, "");
});

// --- dropdown scene ----------------------------------------------------------

test("dropdown scene memakai scene dari discovery, urutannya dipertahankan", () => {
  const opts = U.sceneOptions(["PAX-5", "MAIN", "PAX-1"]);
  assert.deepEqual(opts.map((o) => o.value), ["PAX-5", "MAIN", "PAX-1"]);
});

test("scene tanpa definisi pemutaran DITAMPILKAN tapi ditandai", () => {
  // Menyembunyikannya membuat operator mencari scene yang ia tahu ada di OBS dan
  // tidak menemukannya, tanpa penjelasan apa pun.
  const opts = U.sceneOptions(["PAX-1", "SCENE-BARU"], { playableScenes: ["PAX-1"] });
  assert.equal(opts.length, 2);
  assert.equal(opts[0].supported, true);
  assert.equal(opts[1].supported, false);
  assert.ok(opts[1].note.length > 0);
});

test("tanpa daftar playable, semua scene dianggap didukung", () => {
  const opts = U.sceneOptions(["A", "B"]);
  assert.ok(opts.every((o) => o.supported === true));
});

test("daftar scene kosong atau bukan array tidak meledak", () => {
  for (const v of [[], null, undefined, "x", 5]) {
    assert.deepEqual(U.sceneOptions(v), []);
  }
});

// --- dropdown produk --------------------------------------------------------

const PRODUCTS = [
  { title: "O'CORN Sea Salt 80gr", number: 1, price: "Rp10.000", stock: "Stok 50", pinAvailable: true },
  { title: "Dilan Cookies Choco Chip", number: 10, price: "Rp12.000", stock: "Stok 20", pinAvailable: true },
  { title: "Tanpa Kontrol Pin", number: 3, price: "", stock: "", pinAvailable: false },
];

test("label produk memuat nomor posisi dan judul", () => {
  assert.equal(U.productLabel(PRODUCTS[1]), "#10 — Dilan Cookies Choco Chip");
});

test("produk tanpa nomor tetap punya label", () => {
  assert.equal(U.productLabel({ title: "Tanpa Nomor", number: null }), "Tanpa Nomor");
});

test("baris kedua memuat harga dan stok", () => {
  assert.equal(U.productSubLabel(PRODUCTS[0]), "Rp10.000 · Stok 50");
});

test("produk tanpa kontrol pin dikatakan apa adanya", () => {
  assert.equal(U.productSubLabel(PRODUCTS[2]), T("ui.rule.f.pinUnavailable"));
});

test("dropdown produk memakai JUDUL sebagai nilai, bukan nomor", () => {
  // Nomor bergeser setiap kali ada aksi pin (lihat autopin/VERIFICATION.md), jadi
  // nomor sebagai identitas adalah identitas yang berubah sendiri.
  const opts = U.productOptions(PRODUCTS);
  assert.deepEqual(opts.map((o) => o.value), [
    "O'CORN Sea Salt 80gr",
    "Dilan Cookies Choco Chip",
    "Tanpa Kontrol Pin",
  ]);
});

test("dropdown produk TIDAK memuat diagnostik internal atau selector", () => {
  const raw = JSON.stringify(
    U.productOptions([
      Object.assign({}, PRODUCTS[0], {
        pinClass: "kelas-internal",
        icons: ["arco-icon-x"],
        ariaOnRow: ["aria-pressed=true"],
        topControls: 1,
        imageKey: "abc.png",
        rowInputs: 1,
      }),
    ])
  );
  for (const leak of ["pinClass", "kelas-internal", "arco-icon", "ariaOnRow", "topControls", "imageKey", "rowInputs"]) {
    assert.ok(!raw.includes(leak), leak + " tidak boleh masuk dropdown");
  }
});

test("nilai tersimpan yang tidak ada di katalog tetap dapat opsinya sendiri", () => {
  // Supaya nilainya tidak hilang dari formulir. Memilih produk lain secara
  // diam-diam akan membuat bot memin barang yang tidak pernah dipilih siapa pun.
  const extra = U.extraProductOption("Produk Yang Sudah Hilang", PRODUCTS);
  assert.ok(extra);
  assert.equal(extra.value, "Produk Yang Sudah Hilang");
  assert.equal(extra.resolved, null);
});

test("nilai tersimpan yang COCOK PERSIS dengan judul katalog tidak perlu opsi tambahan", () => {
  assert.equal(U.extraProductOption("O'CORN Sea Salt 80gr", PRODUCTS), null);
});

test("UI TIDAK memutuskan sendiri apakah produk masih ada di LIVE", () => {
  // Ini batas yang penting. Percobaan pertama mencocokkan judul dengan lowercase +
  // substring, dan LANGSUNG menyimpang dari resolveProductForPin di backend — yang
  // juga mengubah karakter bukan alfanumerik jadi spasi, sehingga "O'CORN" menjadi
  // "o corn". Akibatnya UI akan bilang "produk hilang" padahal jalur pin
  // menemukannya; bentuk kesalahan yang sama dengan salinan normalizeTitleKey di P2.
  //
  // Jadi potongan judul yang SAH (dan akan ditemukan backend) tetap mendapat opsi
  // tambahan di sini — karena `<select>` butuh value yang sama persis — tapi tidak
  // pernah ditandai "hilang" oleh UI.
  const extra = U.extraProductOption("O'CORN Sea Salt", PRODUCTS);
  assert.ok(extra, "butuh opsi supaya nilainya tetap terlihat");
  assert.equal("missing" in extra, false, "UI tidak boleh menyimpulkan hilang/tidak");

  // Dan kalau server sudah memberi tahu judul mana yang sesungguhnya terpilih,
  // itu yang ditampilkan.
  const withResolved = U.extraProductOption("O'CORN Sea Salt", PRODUCTS, "O'CORN Sea Salt 80gr");
  assert.equal(withResolved.resolved, "O'CORN Sea Salt 80gr");
});

test("pesan produk hilang datang dari VALIDASI SERVER, bukan dari UI", () => {
  // Inilah jalur yang sesungguhnya memberi tahu operator.
  const issues = U.mappingIssues(
    {
      ok: false,
      mappings: [{ ok: false, reason: "product-not-found", userMessage: T("err.product-not-found") }],
    },
    1
  );
  assert.equal(issues[0].message, T("err.product-not-found"));
});

test("nilai kosong tidak pernah butuh opsi tambahan", () => {
  for (const v of ["", "   ", null, undefined]) {
    assert.equal(U.extraProductOption(v, PRODUCTS), null);
  }
});

test("katalog kosong: nilai tersimpan tetap dapat opsi supaya tidak hilang", () => {
  const extra = U.extraProductOption("Apa Saja", []);
  assert.ok(extra);
  assert.equal(extra.value, "Apa Saja");
});


// Kesiapan yang LENGKAP. Sejak P4.1.1, Start menuntut semuanya terbukti terpenuhi —
// jadi tes yang ingin melihat Start hidup harus menyediakan semuanya.
function readyView(over) {
  return Object.assign(
    {
      // `mode` ikut di view "siap" karena sejak P5.1.1 startBlockers juga
      // memeriksa mode aksi nyata, dan mode yang BELUM DIKETAHUI memblokir.
      status: {
        automation: "STOPPED",
        config: { present: true },
        login: { active: false },
        mode: { ok: true, pin: true, reply: false, needsPin: true, reason: null, userMessage: null },
      },
      obs: { ok: true, connected: true, scenes: ["MAIN", "PAX-1"] },
      tiktok: { ok: true, identity: "toko uji", identityOk: true, live: true, productCount: 3 },
      validation: { ok: true, mappings: [{ ok: true }] },
    },
    over || {}
  );
}

// --- kendali tombol ----------------------------------------------------------

const S = U.STATES;

test("STOPPED + kesiapan LENGKAP: Start hidup, Stop mati, penyuntingan hidup", () => {
  const c = U.controlsFor(readyView());
  assert.equal(c.startEnabled, true);
  assert.equal(c.stopEnabled, false);
  assert.equal(c.editingEnabled, true);
  assert.equal(c.discoveryAllowed, true);
});

test("RUNNING: Start mati, Stop hidup, penyuntingan MATI", () => {
  // P2 memakai snapshot yang tidak bisa diubah dan menjawab restartRequired untuk
  // perubahan di tengah jalan. Formulir yang bisa disunting saat RUNNING hanya
  // menjanjikan sesuatu yang tidak akan terjadi.
  const c = U.controlsFor({ status: { automation: S.RUNNING } });
  assert.equal(c.startEnabled, false);
  assert.equal(c.stopEnabled, true);
  assert.equal(c.editingEnabled, false);
  assert.equal(c.discoveryAllowed, false);
  assert.equal(c.startReason, T("ui.block.alreadyRunning"));
});

test("DEGRADED: masih bisa dihentikan, tidak bisa disunting", () => {
  const c = U.controlsFor({ status: { automation: S.DEGRADED } });
  assert.equal(c.startEnabled, false);
  assert.equal(c.stopEnabled, true);
  assert.equal(c.editingEnabled, false);
});

test("STARTING dan STOPPING: Start mati", () => {
  for (const st of [S.STARTING, S.STOPPING, S.PREFLIGHT]) {
    const c = U.controlsFor({ status: { automation: st } });
    assert.equal(c.startEnabled, false, st);
    assert.ok(c.startReason.length > 0, st);
  }
});

test("ERROR: boleh mencoba lagi dan boleh membereskan", () => {
  // Sesudah rollback, operator harus bisa mencoba lagi tanpa merestart Controller.
  const c = U.controlsFor(readyView({ status: { automation: S.ERROR, config: { present: true }, login: { active: false }, mode: { ok: true, pin: true, reply: false, needsPin: true, reason: null, userMessage: null } } }));
  assert.equal(c.startEnabled, true);
  assert.equal(c.stopEnabled, true);
  assert.equal(c.editingEnabled, true);
});

test("FAIL-CLOSED: state yang tidak dikenal mematikan Start", () => {
  const c = U.controlsFor({ status: { automation: "SESUATU_YANG_BARU" } });
  assert.equal(c.startEnabled, false);
  assert.equal(c.startReason, T("ui.block.stateUnknown"));
});

test("FAIL-CLOSED: backend tidak terjangkau mematikan Start DAN Stop", () => {
  const c = U.controlsFor({ backendUnreachable: true, status: { automation: S.STOPPED } });
  assert.equal(c.startEnabled, false);
  assert.equal(c.stopEnabled, false);
  assert.equal(c.editingEnabled, false);
  // Refresh tetap hidup: itu satu-satunya cara operator mencoba menyambung lagi.
  assert.equal(c.refreshEnabled, true);
  assert.equal(c.startReason, T("ui.banner.offline"));
});

test("FAIL-CLOSED: status belum dimuat mematikan Start", () => {
  const c = U.controlsFor({});
  assert.equal(c.startEnabled, false);
  assert.equal(c.stopEnabled, false);
  assert.equal(c.editingEnabled, false);
});

test("busy mematikan AKSI: double-click tidak bisa jadi dua operasi", () => {
  // Start/Stop/Refresh tetap dijaga `busy` global: itulah perlindungan
  // double-click, dan menyalakan bot dua kali adalah arah yang berbahaya.
  const c = U.controlsFor({ busy: true, busyOp: "refresh", status: { automation: S.STOPPED } });
  assert.equal(c.startEnabled, false);
  assert.equal(c.stopEnabled, false);
  assert.equal(c.refreshEnabled, false);
  assert.equal(c.startReason, T("ui.working"));
});

test("REGRESI: pekerjaan latar TIDAK mengunci penyuntingan", () => {
  // Terlihat di aplikasi TERPASANG pada 2026-10-08: automation STOPPED, tapi
  // seluruh Settings — termasuk kedua checkbox aksi nyata — mati dan tidak
  // pernah hidup lagi.
  //
  // Sebabnya `editingEnabled = !busy && (stopped || errored)`, dengan `busy`
  // global yang dinyalakan Refresh. Refresh menjalankan discovery TikTok, yang
  // di aplikasi terpasang ikut membuka Chrome (6-12 detik).
  for (const op of ["refresh", "start", "stop", "loginStart", "loginCheck", "loginCancel"]) {
    const c = U.controlsFor({ busy: true, busyOp: op, status: { automation: S.STOPPED } });
    assert.equal(c.editingEnabled, true, op + " tidak boleh mengunci Settings");
  }
});

test("hanya PENYIMPANAN config yang mengunci penyuntingan", () => {
  // Dua penyimpanan bersamaan ke berkas config yang sama memang tidak masuk akal.
  for (const op of ["saveSettings", "saveMappings"]) {
    const c = U.controlsFor({ busy: true, busyOp: op, status: { automation: S.STOPPED } });
    assert.equal(c.editingEnabled, false, op + " HARUS mengunci Settings");
  }
});

test("busy tanpa nama operasi TIDAK mengunci penyuntingan", () => {
  // Arah kegagalan sengaja permisif: mengunci karena salah tebak berarti
  // customer tidak bisa mengatur aplikasinya sama sekali. Yang berbahaya adalah
  // menyalakan bot, dan itu tetap dijaga `busy` global.
  const c = U.controlsFor({ busy: true, status: { automation: S.STOPPED } });
  assert.equal(c.editingEnabled, true);
  assert.equal(c.startEnabled, false, "tapi Start tetap mati");
});

test("hint TIDAK menyuruh menghentikan automation yang SUDAH berhenti", () => {
  // Kalimat lama dipakai untuk semua sebab, dan menjadi salah justru pada kasus
  // paling membingungkan: automation sudah STOPPED tapi Settings mati.
  const stoppedSaving = { busy: true, busyOp: "saveSettings", status: { automation: S.STOPPED, config: { present: true } } };
  const sv = U.settingsView(stoppedSaving);
  assert.equal(sv.editable, false);
  assert.equal(sv.hint, T("ui.rule.savingSettings"));

  // Dan penyimpanan MAPPING tidak mengaku sebagai penyimpanan Settings.
  const savingMappings = U.settingsView({
    busy: true, busyOp: "saveMappings",
    status: { automation: S.STOPPED, config: { present: true } },
  });
  assert.equal(savingMappings.hint, T("ui.rule.savingRules"));
  assert.ok(!/while the automation is stopped/.test(sv.hint), sv.hint);

  // Dan saat memang berjalan, kalimat itu BENAR.
  const running = U.settingsView({ status: { automation: S.RUNNING, config: { present: true } } });
  assert.equal(running.editable, false);
  assert.equal(running.hint, T("ui.set.locked"));

  // Stopped dan tidak ada yang menulis config: tidak ada hint sama sekali.
  const free = U.settingsView({ status: { automation: S.STOPPED, config: { present: true } } });
  assert.equal(free.editable, true);
  assert.equal(free.hint, "");
});

// --- kesiapan ---------------------------------------------------------------

test("baris kesiapan: semuanya hijau", () => {
  const rows = U.readinessRows({
    obs: { ok: true },
    tiktok: { ok: true, identity: "toko uji", live: true, productCount: 20 },
    validation: { ok: true, mappings: [{ ok: true }, { ok: true }] },
    status: { automation: S.STOPPED },
  });
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r]));
  assert.equal(byLabel.OBS.value, T("ui.row.connected"));
  // Identitas tidak diulang di baris ini; baris T("ui.row.signin") yang menyebutkannya.
  assert.equal(byLabel.TikTok.value, T("ui.row.connected"));
  assert.equal(byLabel[T("ui.row.signin")].value, T("ui.login.signedIn", { name: "toko uji" }));
  assert.equal(byLabel[T("ui.row.live")].value, T("ui.row.onair"));
  assert.equal(byLabel[T("ui.row.products")].value, T("ui.row.productsAvailable", { n: 20 }));
  assert.equal(byLabel[T("ui.row.mappings")].value, T("ui.row.mappingsOk", { n: 2 }));
  assert.equal(byLabel[T("ui.row.automation")].value, T("ui.state.stopped"));
});

test("baris kesiapan memakai KALIMAT DARI SERVER, bukan kode mesin", () => {
  const rows = U.readinessRows({
    obs: { ok: false, error: { code: "obs-unavailable", userMessage: T("err.obs-unavailable") } },
    tiktok: { ok: false, error: { code: "no-live-products", userMessage: T("err.no-live-products") } },
    status: { automation: S.STOPPED },
  });
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r]));
  assert.equal(byLabel.OBS.value, T("err.obs-unavailable"));
  assert.equal(byLabel.TikTok.value, T("err.no-live-products"));
  // Dan tidak satu pun kode mesin ikut tampil.
  const raw = JSON.stringify(rows);
  assert.ok(!raw.includes("obs-unavailable"));
  assert.ok(!raw.includes("no-live-products"));
});

test("baris yang BELUM diketahui berkata Checking, bukan berpura-pura hijau", () => {
  const rows = U.readinessRows({ status: null });
  for (const r of rows.slice(0, 5)) {
    assert.equal(r.value, T("ui.state.checking"), r.label);
    assert.equal(r.tone, U.TONE.NEUTRAL);
  }
});

test("LIVE belum on air ditandai perlu perhatian, bukan error", () => {
  const rows = U.readinessRows({ tiktok: { ok: true, live: false, productCount: 5 }, status: { automation: S.STOPPED } });
  const live = rows.find((r) => r.label === T("ui.row.live"));
  assert.equal(live.value, T("ui.row.notOnair"));
  assert.equal(live.tone, U.TONE.ATTENTION);
});

test("nol produk ditandai perlu perhatian", () => {
  const rows = U.readinessRows({ tiktok: { ok: true, live: true, productCount: 0 }, status: { automation: S.STOPPED } });
  assert.equal(rows.find((r) => r.label === T("ui.row.products")).value, T("ui.row.productsNone"));
});

test("pemetaan bermasalah menyebut BERAPA baris, bukan satu pesan umum", () => {
  const rows = U.readinessRows({
    validation: { ok: false, mappings: [{ ok: true }, { ok: false }, { ok: false }] },
    status: { automation: S.STOPPED },
  });
  assert.equal(rows.find((r) => r.label === T("ui.row.mappings")).value, T("ui.row.mappingsBad", { n: 2 }));
});

test("state automation diterjemahkan ke kalimat biasa", () => {
  const expected = {
    STOPPED: T("ui.state.stopped"),
    PREFLIGHT: T("ui.state.preflight"),
    STARTING: T("ui.state.starting"),
    RUNNING: T("ui.state.running"),
    DEGRADED: T("ui.state.degraded"),
    STOPPING: T("ui.state.stopping"),
  };
  for (const [st, label] of Object.entries(expected)) {
    assert.equal(U.automationLabel({ automation: st }), label);
  }
});

test("ERROR memakai kalimat dari lastError kalau ada", () => {
  assert.equal(
    U.automationLabel({ automation: S.ERROR, lastError: { code: "bot-did-not-die", userMessage: T("err.bot-did-not-die") } }),
    T("err.bot-did-not-die")
  );
  assert.equal(U.automationLabel({ automation: S.ERROR }), T("ui.state.error"));
});

// --- pemetaan <-> formulir ---------------------------------------------------

test("trigger ditulis satu per baris, dan dibersihkan saat dibaca", () => {
  assert.deepEqual(U.parseTriggers("spill etalase 1\n etalase satu \n\n"), ["spill etalase 1", "etalase satu"]);
  assert.deepEqual(U.parseTriggers(""), []);
  assert.deepEqual(U.parseTriggers(null), []);
});

test("baris formulir -> pemetaan config", () => {
  const m = U.rowToMapping({
    scene: " PAX-1 ",
    productTitle: " O'CORN Sea Salt ",
    triggersText: "spill etalase 1\netalase satu",
    reply: " sudah dipin ",
  });
  assert.deepEqual(m, {
    scene: "PAX-1",
    product: { title: "O'CORN Sea Salt" },
    triggers: ["spill etalase 1", "etalase satu"],
    reply: "sudah dipin",
  });
});

test("produk kosong jadi null, BUKAN judul kosong", () => {
  // Bedanya disengaja di backend: null = sengaja tidak memin apa pun (scene FAQ),
  // judul kosong = field yang lupa diisi dan ditolak. UI harus menghormatinya.
  const m = U.rowToMapping({ scene: "AI LIVE_FAQ_CO", productTitle: "", triggersText: "cara order" });
  assert.equal(m.product, null);
});

test("balasan kosong tidak dikirim sebagai field kosong", () => {
  const m = U.rowToMapping({ scene: "PAX-1", productTitle: "x", triggersText: "a", reply: "  " });
  assert.equal("reply" in m, false);
});

test("pemetaan config -> baris formulir, dan kembali lagi utuh", () => {
  const original = {
    scene: "PAX-2",
    product: { title: "Dilan Cookies" },
    triggers: ["etalase dua", "kode dua"],
    reply: "siap kak",
  };
  assert.deepEqual(U.rowToMapping(U.mappingToRow(original)), original);
});

test("pemetaan produk null bolak-balik tetap null", () => {
  const original = { scene: "AI LIVE_FAQ_CO", product: null, triggers: ["cara order"] };
  assert.deepEqual(U.rowToMapping(U.mappingToRow(original)), original);
});

test("baris baru kosong dan aman", () => {
  const row = U.mappingToRow(U.blankMapping());
  assert.deepEqual(row, { scene: "", productTitle: "", triggersText: "", reply: "" });
});

test("payload config menukar HANYA mappings, sisanya utuh", () => {
  const base = {
    version: 1,
    tiktok: { username: "akun" },
    obs: { host: "127.0.0.1", port: 4455, passwordSet: true },
    settings: { autopinEnabled: true },
    mappings: [{ scene: "LAMA", product: null, triggers: ["x"] }],
  };
  const out = U.buildConfigPayload(base, [{ scene: "PAX-1", productTitle: "A", triggersText: "a", reply: "r" }]);
  assert.equal(out.version, 1);
  assert.equal(out.tiktok.username, "akun");
  assert.equal(out.settings.autopinEnabled, true);
  assert.deepEqual(out.mappings, [{ scene: "PAX-1", product: { title: "A" }, triggers: ["a"], reply: "r" }]);
});

test("payload config MEMBUANG passwordSet, dan tidak pernah mengirim password", () => {
  // GET /api/config tidak memuat password (hanya passwordSet), dan backend
  // memperlakukan password yang tidak dikirim sebagai "jangan diubah". passwordSet
  // adalah field buatan UI; mengirimnya kembali hanya akan ditolak validator.
  const out = U.buildConfigPayload({ version: 1, obs: { host: "h", port: 1, passwordSet: true }, mappings: [] }, []);
  assert.equal("passwordSet" in out.obs, false);
  assert.equal("password" in out.obs, false);
});

test("payload config tidak mengubah objek aslinya", () => {
  const base = { version: 1, obs: { host: "h", port: 1 }, mappings: [{ scene: "LAMA" }] };
  U.buildConfigPayload(base, [{ scene: "BARU", productTitle: "", triggersText: "" }]);
  assert.deepEqual(base.mappings, [{ scene: "LAMA" }]);
});

test("tanpa config dasar, tidak ada payload yang dibentuk", () => {
  assert.equal(U.buildConfigPayload(null, []), null);
});

// --- kesalahan per pemetaan -------------------------------------------------

test("kesalahan dicocokkan ke baris lewat INDEKS, bukan nama scene", () => {
  // Scene yang sama bisa muncul dua kali — dan itu justru salah satu kesalahan
  // yang dilaporkan. Mencocokkan dengan nama akan menaruh pesan di baris salah.
  const validation = {
    ok: false,
    mappings: [
      { scene: "PAX-1", ok: true },
      { scene: "PAX-1", ok: false, reason: "duplicate-scene", userMessage: "is mapped more than once" },
    ],
  };
  const issues = U.mappingIssues(validation, 2);
  assert.equal(issues[0], null);
  assert.equal(issues[1].message, "is mapped more than once");
  assert.equal(issues[1].reason, "duplicate-scene");
});

test("kesalahan memakai kalimat dari server", () => {
  const issues = U.mappingIssues(
    { ok: false, mappings: [{ ok: false, reason: "product-not-found", userMessage: T("err.product-not-found") }] },
    1
  );
  assert.equal(issues[0].message, T("err.product-not-found"));
});

test("tanpa kalimat dari server, ada kalimat cadangan yang tetap bukan kode mesin", () => {
  const issues = U.mappingIssues({ ok: false, mappings: [{ ok: false, reason: "sesuatu-yang-baru" }] }, 1);
  assert.equal(issues[0].message, T("ui.row.needsAttention"));
  assert.ok(!issues[0].message.includes("sesuatu-yang-baru"));
});

test("baris tanpa hasil validasi tidak ditandai salah", () => {
  // Baris yang baru ditambahkan belum pernah divalidasi.
  const issues = U.mappingIssues({ ok: true, mappings: [{ ok: true }] }, 3);
  assert.deepEqual(issues, [null, null, null]);
});

test("judul yang BENAR-BENAR terpilih dilaporkan per baris", () => {
  const titles = U.resolvedTitles(
    { mappings: [{ ok: true, resolvedTitle: "O'CORN Sea Salt 80gr" }, { ok: false }] },
    2
  );
  assert.deepEqual(titles, ["O'CORN Sea Salt 80gr", null]);
});

// --- activity ---------------------------------------------------------------

const EVENTS = [
  { id: 1, time: "2026-10-07T09:20:00.000Z", type: "PLAY", scene: "PAX-2", message: T("ui.act.playPlain") },
  { id: 2, time: "2026-10-07T09:20:01.000Z", type: "AUTOPIN_SUCCESS", scene: "PAX-2", product: "Gery Potato" },
  { id: 3, time: "2026-10-07T09:20:02.000Z", type: "AUTOCOMMENT_SUCCESS", scene: "PAX-2" },
  { id: 4, time: "2026-10-07T09:20:40.000Z", type: "PLAYBACK_END", scene: "PAX-2", reason: "media-ended" },
];

test("activity: kalimat untuk tiap jenis kejadian", () => {
  const items = U.activityItems(EVENTS);
  const texts = items.map((i) => i.text);
  assert.ok(texts.includes(T("ui.act.play", { scene: "PAX-2" })));
  assert.ok(texts.includes(T("ui.act.pinnedNamed", { product: "Gery Potato" })));
  assert.ok(texts.includes(T("ui.act.replied")));
  assert.ok(texts.includes(T("ui.act.playbackEnd", { scene: "PAX-2" })));
});

test("activity: yang TERBARU di atas", () => {
  const items = U.activityItems(EVENTS);
  assert.equal(items[0].id, 4);
  assert.equal(items[items.length - 1].id, 1);
});

test("activity: kegagalan memakai kalimat dari server, bukan kode mesin", () => {
  const items = U.activityItems([
    {
      id: 1,
      time: "2026-10-07T09:20:00.000Z",
      type: "AUTOPIN_FAILED",
      scene: "PAX-1",
      reason: "budget-exhausted-before-click",
      userMessage: T("err.budget-exhausted-before-click"),
    },
  ]);
  assert.equal(items[0].text, T("err.budget-exhausted-before-click"));
  assert.ok(!items[0].text.includes("budget-exhausted"));
  assert.equal(items[0].tone, U.TONE.ATTENTION);
});

test("activity: crash ditandai error", () => {
  const items = U.activityItems([{ id: 1, time: "2026-10-07T09:20:00.000Z", type: "BOT_CRASHED" }]);
  assert.equal(items[0].text, T("ui.act.botCrashed"));
  assert.equal(items[0].tone, U.TONE.ERROR);
});

test("activity: waktu ditampilkan HH:MM", () => {
  const t = U.activityTime("2026-10-07T09:20:00.000Z");
  assert.match(t, /^\d{2}[:.]\d{2}$/);
  assert.equal(U.activityTime("bukan tanggal"), "");
});

test("activity DIBATASI di frontend, bukan hanya di backend", () => {
  // Halaman ini bisa terbuka berjam-jam selama LIVE. Daftar DOM yang tumbuh terus
  // adalah kebocoran memori yang sama bentuknya dengan yang sudah diperbaiki di
  // sisi backend.
  const many = [];
  for (let i = 1; i <= 500; i += 1) {
    many.push({ id: i, time: "2026-10-07T09:20:00.000Z", type: "PLAY", scene: "PAX-1" });
  }
  assert.equal(U.activityItems(many).length, U.MAX_ACTIVITY_ITEMS);
  assert.equal(U.MAX_ACTIVITY_ITEMS, 50);
  // Yang ditahan adalah yang terbaru.
  assert.equal(U.activityItems(many)[0].id, 500);
});

test("activity: batas bisa ditentukan pemanggil", () => {
  const many = [];
  for (let i = 1; i <= 100; i += 1) many.push({ id: i, time: "2026-10-07T09:20:00.000Z", type: "PLAY" });
  assert.equal(U.activityItems(many, 5).length, 5);
});

test("penggabungan activity: tanpa duplikat, terurut, dan tetap dibatasi", () => {
  const merged = U.mergeActivity(EVENTS, [EVENTS[3], { id: 5, time: "2026-10-07T09:21:00.000Z", type: "PLAY" }]);
  assert.deepEqual(merged.map((e) => e.id), [1, 2, 3, 4, 5]);
});

test("penggabungan activity membuang yang TERTUA saat penuh", () => {
  const first = [];
  for (let i = 1; i <= 50; i += 1) first.push({ id: i, type: "PLAY" });
  const merged = U.mergeActivity(first, [{ id: 51, type: "PLAY" }], 50);
  assert.equal(merged.length, 50);
  assert.equal(merged[0].id, 2);
  assert.equal(merged[merged.length - 1].id, 51);
});

test("penggabungan activity menerima masukan kosong/aneh", () => {
  assert.deepEqual(U.mergeActivity(null, null), []);
  assert.deepEqual(U.mergeActivity([], [null, undefined, {}]), []);
});

// --- preflight --------------------------------------------------------------

test("baris preflight memakai label ramah, bukan nama check internal", () => {
  const rows = U.preflightRows({
    ok: false,
    checks: {
      config: { ok: true },
      processes: { ok: true },
      ports: { ok: true },
      obs: { ok: false, reason: "obs-unavailable", userMessage: T("err.obs-unavailable") },
      scenes: { ok: false, reason: "skipped-obs-unavailable", skipped: true, userMessage: "Something went wrong. Check the logs for details." },
      profile: { ok: true },
      tiktok: { ok: true, skipped: true },
      mappings: { ok: true },
    },
  });
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r]));
  assert.equal(byLabel.OBS.value, T("err.obs-unavailable"));
  assert.equal(byLabel[T("ui.check.config")].value, T("ui.check.config.pass"));
  assert.equal(byLabel[T("ui.check.tiktok")].value, T("ui.check.skipped"));
  // Nama internal tidak muncul.
  const raw = JSON.stringify(rows);
  assert.ok(!raw.includes("obs-unavailable"));
  assert.ok(!raw.includes("profile-dir"));
});

test("hanya check yang GAGAL yang dikumpulkan untuk ditampilkan saat Start ditolak", () => {
  const result = {
    ok: false,
    checks: { config: { ok: true }, obs: { ok: false, userMessage: T("err.obs-unavailable") }, mappings: { ok: false, userMessage: T("err.mapping-validation-failed") } },
  };
  const failed = U.failedPreflight(result);
  assert.equal(failed.length, 2);
  assert.deepEqual(failed.map((f) => f.label).sort(), [T("ui.check.mappings"), T("ui.check.obs")].sort());
});

test("preflight tanpa hasil tidak menghasilkan baris", () => {
  assert.deepEqual(U.preflightRows(null), []);
  assert.deepEqual(U.preflightRows({}), []);
});

// --- rahasia ---------------------------------------------------------------

test("tidak ada fungsi di ui-logic yang pernah menampilkan kode mesin", () => {
  // Diperiksa menyeluruh: apa pun yang keluar dari modul ini untuk ditampilkan
  // tidak boleh memuat kode kebab-case bergaya mesin.
  const outputs = [
    JSON.stringify(U.readinessRows({
      obs: { ok: false, reason: "obs-unavailable" },
      tiktok: { ok: false, reason: "tiktok-not-logged-in" },
      validation: { ok: false, reason: "no-mappings", mappings: [] },
      status: { automation: "ERROR", lastError: { code: "bot-did-not-die" } },
    })),
    JSON.stringify(U.activityItems([{ id: 1, time: "2026-10-07T09:20:00.000Z", type: "AUTOPIN_FAILED", reason: "live-pin-control-not-available" }])),
  ].join(" ");

  for (const code of ["obs-unavailable", "tiktok-not-logged-in", "no-mappings", "bot-did-not-die", "live-pin-control-not-available"]) {
    assert.ok(!outputs.includes(code), code + " tidak boleh tampil ke customer");
  }
});

test("ui-logic TIDAK memuat satu pun kalimat customer", () => {
  // Invarian ini BERUBAH dengan sengaja saat i18n masuk.
  //
  // Dulu: ui-logic tidak boleh menyebut kode server sama sekali, supaya tidak
  // ada salinan katalog di frontend yang bisa menyimpang.
  // Sekarang: katalognya memang ada di frontend - di i18n.js, karena server
  // hanya punya satu bahasa. Yang menjaga agar ia tidak menyimpang bukan lagi
  // "jangan sebut kodenya", melainkan tes kontrak di ui.i18n.test.js yang
  // merah kalau daftar kodenya berbeda dari controller/errors.js.
  //
  // Yang dijaga DI SINI sekarang: ui-logic tidak boleh punya KALIMAT. Ia boleh
  // menyebut kunci; ia tidak boleh menuliskan kata yang dibaca customer.
  const src = require("node:fs").readFileSync(require.resolve("../controller/public/ui-logic.js"), "utf8");
  const NL = String.fromCharCode(10);
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(NL)
    .filter((l) => !/^\s*\/\//.test(l))
    .join(NL);

  const sentences = [];
  for (const m of code.matchAll(/"((?:[^"\\\n]|\\.){6,})"/g)) {
    const v = m[1];
    if (/^(ui|err|field|path)\./.test(v)) continue;      // kunci kamus: boleh
    if (/^(spill etalase |Etalase )/.test(v)) continue;   // konten customer: boleh
    if (/ sudah aku pin ya kak$/.test(v)) continue;        // konten customer: boleh
    // Pemindai kutip sederhana bisa memasangkan kutip PENUTUP satu string
    // dengan kutip PEMBUKA string berikutnya, sehingga potongan KODE di
    // antaranya terbaca sebagai kalimat. Kalimat produk tidak memuat kurung
    // atau panah fungsi; potongan kode hampir selalu memuatnya.
    if (/[(){}]|=>|return /.test(v)) continue;
    if (v === "use strict") continue;                     // direktif, bukan kalimat
    if (!/[a-z] [a-z]/.test(v)) continue;                 // bukan kalimat
    sentences.push(v);
  }
  assert.deepEqual(sentences, [], "kalimat ini harus pindah ke i18n.js");
});

test("modul bisa dimuat sebagai skrip browser maupun modul Node", () => {
  // Pola UMD-nya harus bekerja di dua tempat: halaman memakai <script>, tes
  // memakai require. Kalau salah satu rusak, salah satu dari keduanya mati.
  const fs = require("node:fs");
  const src = fs.readFileSync(require.resolve("../controller/public/ui-logic.js"), "utf8");
  assert.ok(src.includes("module.exports"), "harus bisa di-require");
  assert.ok(src.includes("root.AiLiveUI"), "harus memasang diri di window untuk browser");

  // Dan benar-benar dijalankan sebagai skrip browser, dengan global tiruan.
  const sandbox = {};
  new Function("self", src).call(sandbox, sandbox);
  assert.equal(typeof sandbox.AiLiveUI, "object");
  assert.equal(typeof sandbox.AiLiveUI.suggestForScene, "function");
  assert.deepEqual(sandbox.AiLiveUI.suggestForScene("PAX-4"), U.suggestForScene("PAX-4"));
});

// --- Start digerbang keberadaan config (P4) ---------------------------------

test("config belum pernah disimpan: START BOT MATI", () => {
  // Tanpa config, Start pasti gagal di preflight. Tombol yang mengundang klik yang
  // sudah pasti gagal membuat orang berhenti membaca pesannya — dan pesan
  // preflight-lah yang nanti dibutuhkan saat kegagalannya benar-benar penting.
  const c = U.controlsFor(readyView({ status: { automation: "STOPPED", config: { present: false }, login: { active: false } } }));
  assert.equal(c.startEnabled, false);
  assert.equal(c.startReason, T("ui.login.hintSaveFirst"));
  // Tapi penyuntingan tetap hidup: justru itu yang harus dilakukan customer.
  assert.equal(c.editingEnabled, true);
});

test("config sudah ada DAN kesiapan lengkap: START BOT hidup", () => {
  assert.equal(U.controlsFor(readyView()).startEnabled, true);
});

test("FAIL-CLOSED: kesiapan yang BELUM DIKETAHUI mematikan Start", () => {
  // "Belum tahu" bukan "aman". Satu-satunya cara tombol ini hidup adalah kalau
  // setiap syarat sudah terbukti terpenuhi.
  for (const missing of ["obs", "tiktok", "validation"]) {
    const view = readyView();
    delete view[missing];
    const c = U.controlsFor(view);
    assert.equal(c.startEnabled, false, "tanpa " + missing + " harus mati");
    const CHECKING = [
      T("ui.block.checkingObs"), T("ui.block.checkingTiktok"),
      T("ui.block.checkingProducts"), T("ui.block.checkingMappings"),
      T("ui.block.checkingMode"), T("ui.loading"),
    ];
    assert.ok(CHECKING.includes(c.startReason), missing + ": " + c.startReason);
  }
});

// --- REGRESI P4.1.1: gerbang START BOT ---------------------------------------
//
// Terlihat di UI SUNGGUHAN pada 2026-10-08: START BOT hidup padahal LIVE belum on
// air, nol produk terdeteksi, dan nol pemetaan ada. Preflight memang akan
// menolaknya, tapi tombol yang mengundang klik yang sudah pasti gagal membuat orang
// berhenti membaca pesannya — dan pesan preflight itulah yang nanti dibutuhkan saat
// kegagalannya benar-benar penting.

test("REGRESI screenshot: OBS+TikTok tersambung, tapi LIVE off + 0 produk + 0 mapping => START MATI", () => {
  // Keadaan PERSIS dari layar yang dilaporkan.
  const view = {
    status: {
      automation: "STOPPED",
      config: { present: true },
      login: { active: false, state: "idle", identity: "agen_mulia_abadi" },
      run: { armed: false },
      // Mode aksi nyata SAH di layar itu; yang mematikan START adalah LIVE,
      // produk, dan pemetaan. Disebutkan supaya tes ini tetap menguji ketiganya
      // dan bukan ikut tersandung penghalang mode.
      mode: { ok: true, pin: true, reply: false, needsPin: true, reason: null, userMessage: null },
    },
    obs: { ok: true, connected: true, scenes: ["MAIN", "PAX-1", "PAX-2"] },
    tiktok: { ok: true, identity: "agen_mulia_abadi", identityOk: true, live: false, productCount: 0 },
    validation: { ok: false, reason: "no-mappings", mappings: [], userMessage: T("err.no-mappings") },
  };

  const c = U.controlsFor(view);
  assert.equal(c.startEnabled, false, "START BOT HARUS mati");
  // Dan alasannya yang paling bisa ditindaklanjuti lebih dulu.
  assert.equal(c.startReason, T("err.live-not-active"));

  // Ketiga penghalangnya disebut, bukan hanya satu.
  const keys = U.startBlockers(view).map((b) => b.key);
  assert.deepEqual(keys, ["live", "products", "mappings"]);

  // Stop dan penyuntingan TIDAK terpengaruh: operator tetap harus bisa membetulkan.
  assert.equal(c.editingEnabled, true);
});

test("REGRESI: masing-masing syarat kesiapan sendirian sudah cukup mematikan Start", () => {
  const cases = [
    ["obs mati", { obs: { ok: false, error: { userMessage: T("err.obs-unavailable") } } }, "obs"],
    ["tiktok gagal", { tiktok: { ok: false, error: { userMessage: T("err.tiktok-not-logged-in") } } }, "tiktok"],
    ["akun salah", { tiktok: { ok: true, identityOk: false, live: true, productCount: 5 } }, "identity"],
    ["LIVE off", { tiktok: { ok: true, identityOk: true, live: false, productCount: 5 } }, "live"],
    ["nol produk", { tiktok: { ok: true, identityOk: true, live: true, productCount: 0 } }, "products"],
    ["jumlah produk tak diketahui", { tiktok: { ok: true, identityOk: true, live: true } }, "products"],
    ["mapping bermasalah", { validation: { ok: false, userMessage: T("err.mapping-validation-failed") } }, "mappings"],
  ];
  for (const [label, over, expectedKey] of cases) {
    const view = readyView(over);
    const c = U.controlsFor(view);
    assert.equal(c.startEnabled, false, label + " harus mematikan Start");
    assert.ok(
      U.startBlockers(view).some((b) => b.key === expectedKey),
      label + ": penghalang " + expectedKey + " harus disebut, dapat " + JSON.stringify(U.startBlockers(view).map((b) => b.key))
    );
  }
});

test("REGRESI: kesiapan lengkap TAPI login aktif => Start tetap mati", () => {
  const view = readyView({
    status: { automation: "STOPPED", config: { present: true }, login: { active: true, state: "waiting" } },
  });
  const c = U.controlsFor(view);
  assert.equal(c.startEnabled, false);
  assert.equal(c.startReason, T("ui.login.finishFirst"));
});

test("REGRESI: backend tidak terjangkau mengalahkan kesiapan apa pun", () => {
  const c = U.controlsFor(readyView({ backendUnreachable: true }));
  assert.equal(c.startEnabled, false);
  assert.equal(c.startReason, T("ui.banner.offline"));
  assert.deepEqual(U.startBlockers(readyView({ backendUnreachable: true })).map((b) => b.key), ["backend"]);
});

test("REGRESI: alasan Start tidak pernah berisi kode mesin", () => {
  // Pesannya dari server (userMessage) atau kalimat biasa; tidak pernah kode.
  const view = readyView({
    obs: { ok: false, reason: "obs-unavailable", error: { code: "obs-unavailable", userMessage: T("err.obs-unavailable") } },
    tiktok: { ok: false, reason: "tiktok-not-logged-in", error: { code: "tiktok-not-logged-in", userMessage: T("err.tiktok-not-logged-in") } },
    validation: { ok: false, reason: "no-mappings", userMessage: T("err.no-mappings") },
  });
  const raw = JSON.stringify(U.startBlockers(view));
  for (const code of ["obs-unavailable", "tiktok-not-logged-in", "no-mappings"]) {
    assert.ok(!raw.includes(code), code + " tidak boleh tampil ke customer");
  }
});

test("REGRESI: Stop TIDAK PERNAH diblokir oleh kesiapan", () => {
  // Apa pun keadaan kesiapannya, automation yang berjalan harus selalu bisa
  // dihentikan. Tombol Stop yang mati saat sesuatu masih hidup adalah keadaan yang
  // paling tidak boleh ada.
  for (const st of ["RUNNING", "DEGRADED", "STARTING", "STOPPING", "ERROR"]) {
    const c = U.controlsFor({ status: { automation: st, config: { present: true } } });
    assert.equal(c.stopEnabled, true, st + " harus tetap bisa dihentikan");
  }
});
