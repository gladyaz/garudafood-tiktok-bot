/* Lapisan tampilan Direction D, dan kontrak tema terang/gelap.
 *
 * Yang dijaga di sini bukan selera, melainkan tiga hal yang pernah salah di
 * layar sungguhan:
 *
 *   1. otomasi yang BERHENTI tidak boleh terbaca seperti sedang berjalan
 *   2. hijau HANYA untuk berjalan/boleh-mulai; merah siaran HANYA untuk tayang
 *   3. tidak ada angka di layar yang tidak datang dari kejadian sungguhan
 *
 * Semua fungsi di bawah murni, jadi ia dipanggil langsung dari Node. Repo ini
 * tidak punya jsdom; percabangan yang hanya hidup di handler DOM adalah
 * percabangan yang tidak diuji.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const PUBLIC_DIR = path.join(__dirname, "..", "controller", "public");
const U = require(path.join(PUBLIC_DIR, "ui-logic.js"));
const I18N = require(path.join(PUBLIC_DIR, "i18n.js"));

const readPublic = (name) => fs.readFileSync(path.join(PUBLIC_DIR, name), "utf8");
const T = (key, vars) => I18N.t("id", key, vars);

// Keadaan yang semua syaratnya terpenuhi dan otomasinya BERHENTI.
const READY = Object.freeze({
  status: { automation: "STOPPED", config: { present: true }, mode: { ok: true }, login: {} },
  obs: { ok: true },
  tiktok: { ok: true, live: true, productCount: 5, identityOk: true, identity: "akun_tes" },
  validation: { ok: true, mappings: [{ ok: true }, { ok: true }] },
  rows: [{}, {}],
  activity: [],
});

const clone = (extra) => Object.assign({}, READY, extra || {});

// ===========================================================================
// Kartu status
// ===========================================================================

test("BERHENTI tapi semua syarat terpenuhi: kartunya mengajak mulai, bukan melaporkan berjalan", () => {
  const h = U.heroView(READY, "id");
  assert.equal(h.title, T("ui.hero.ready.title"));
  assert.equal(h.tone, "ready");
  // Dan tidak satu pun kata yang menyatakan sesuatu sedang berlangsung.
  for (const word of [T("ui.state.running"), T("ui.pill.onair"), T("ui.row.onair")]) {
    assert.ok(h.title.indexOf(word) === -1 && h.note.indexOf(word) === -1, word + " -> " + h.title);
  }
});

test("BERJALAN: kartunya menyebut bot mendengarkan, dan nadanya running", () => {
  const h = U.heroView(clone({ status: { automation: "RUNNING", config: { present: true } } }), "id");
  assert.equal(h.title, T("ui.hero.running.title"));
  assert.equal(h.over, T("ui.hero.over.running"));
  assert.equal(h.tone, "running");
});

test("terhalang: judulnya MENGHITUNG apa yang perlu dibereskan", () => {
  const blocked = { status: { automation: "STOPPED", config: { present: true }, mode: { ok: true }, login: {} }, rows: [] };
  const h = U.heroView(blocked, "id");
  const n = U.realBlockers(blocked, "id").length;
  assert.ok(n > 1, "keadaan uji ini harus punya lebih dari satu penghalang");
  assert.equal(h.title, T("ui.hero.blocked.title", { n: n }));
  // Banyak penghalang: tunjuk daftarnya. Menyebut satu dari enam membuat lima
  // lainnya tidak terlihat.
  assert.equal(h.note, T("ui.hero.blocked.body"));
  // Abu-abu, bukan kuning: belum-pernah-dijalankan adalah keadaan istirahat.
  assert.equal(h.tone, "neutral");
});

test("satu penghalang saja: kartunya menyebut penghalang itu, bukan menunjuk daftar", () => {
  // Semua syarat terpenuhi kecuali LIVE belum tayang.
  const one = clone({ tiktok: { ok: true, live: false, productCount: 5, identityOk: true, identity: "akun_tes" } });
  const blockers = U.realBlockers(one, "id");
  assert.equal(blockers.length, 1, JSON.stringify(blockers));
  const h = U.heroView(one, "id");
  assert.equal(h.title, T("ui.hero.blocked.title", { n: 1 }));
  assert.equal(h.note, blockers[0].message);
});

test("ERROR: judulnya adalah SEBAB kegagalannya, bukan kata 'Bermasalah'", () => {
  const errored = clone({
    status: { automation: "ERROR", config: { present: true }, lastError: { reason: "obs-unavailable" } },
  });
  const h = U.heroView(errored, "id");
  assert.equal(h.title, I18N.DICT.id["err.obs-unavailable"]);
  assert.equal(h.tone, "error");
});

test("penghalang SEMU tidak pernah ikut dihitung di judul", () => {
  // Menyimpan pengaturan membuat startBlockers() mengembalikan "ada operasi
  // berjalan". Kalau itu ikut dihitung, judulnya berbunyi "Belum bisa mulai:
  // 1 hal perlu dibereskan" lalu angkanya hilang sendiri sedetik kemudian.
  const busy = clone({ busy: true, busyOp: "saveSettings" });
  assert.deepEqual(U.realBlockers(busy, "id"), []);
  const h = U.heroView(busy, "id");
  assert.equal(h.title, T("ui.working"));
  assert.ok(h.title.indexOf("1") === -1, h.title);
});

test("backend mati: kartunya mengatakannya, dan Start tetap mati", () => {
  const down = clone({ backendUnreachable: true });
  assert.equal(U.heroView(down, "id").title, T("ui.banner.offline"));
  assert.equal(U.heroView(down, "id").tone, "error");
  assert.equal(U.controlsFor(down, "id").startEnabled, false);
});

// ===========================================================================
// Lampu tally
// ===========================================================================

test("tally: hijau HANYA kalau MULAI BOT benar-benar bisa ditekan", () => {
  const t = U.tallyView(READY, "id");
  assert.equal(t.tone, "ready");
  assert.equal(U.controlsFor(READY, "id").startEnabled, true);

  // Satu syarat hilang -> tidak hijau lagi, dan tombolnya memang mati.
  const blocked = clone({ obs: { ok: false, reason: "obs-unavailable" } });
  assert.notEqual(U.tallyView(blocked, "id").tone, "ready");
  assert.equal(U.controlsFor(blocked, "id").startEnabled, false);
});

test("tally: merah siaran HANYA saat benar-benar tayang", () => {
  const states = {
    RUNNING: "running",
    DEGRADED: "attention",
    ERROR: "error",
    STOPPED: "neutral",
    STARTING: "attention",
    STOPPING: "attention",
    PREFLIGHT: "attention",
  };
  Object.keys(states).forEach((s) => {
    const v = U.tallyView(clone({ status: { automation: s, config: { present: true }, mode: { ok: true }, login: {} } }), "id");
    if (s === "RUNNING") assert.equal(v.tone, "running", s);
    else assert.notEqual(v.tone, "running", s + " tidak boleh memakai warna siaran");
  });
  assert.equal(U.tallyView(clone({ status: { automation: "RUNNING", config: { present: true } } }), "id").label, T("ui.pill.onair"));
});

test("tally dan kartu status memakai kosakata yang BERBEDA untuk hal yang sama", () => {
  // Lampu dibaca dalam satu lirikan, kartu menjelaskan. Kalau keduanya berbunyi
  // sama, salah satunya tidak perlu ada.
  const run = clone({ status: { automation: "RUNNING", config: { present: true } } });
  assert.notEqual(U.tallyView(run, "id").label, U.heroView(run, "id").title);
});

// ===========================================================================
// Hitungan kesiapan
// ===========================================================================

test("hitungan kesiapan TIDAK memasukkan baris keadaan otomasi", () => {
  const rows = U.readinessRows(READY, "id");
  const view = U.readyView(READY, "id");
  // Baris pertama adalah keadaan otomasi, dan ia bukan syarat.
  assert.equal(rows[0].label, T("ui.row.automation"));
  assert.equal(view.total, rows.length - 1);
  // Semua syarat terpenuhi walaupun otomasinya BERHENTI.
  assert.equal(view.ok, view.total);
  assert.equal(view.label, T("ui.ready.allClear", { total: view.total }));
});

test("satu sel progres per syarat, dan warnanya mengikuti barisnya", () => {
  const v = U.readyView(clone({ obs: { ok: false, reason: "obs-unavailable" } }), "id");
  assert.equal(v.cells.length, v.total);
  assert.equal(v.cells.filter((c) => c === "attention").length, 1);
  assert.equal(v.ok, v.total - 1);
  assert.equal(v.label, T("ui.ready.count", { ok: v.ok, total: v.total }));
});

test("saat BERJALAN, kartu kesiapan berhenti menghitung dan berganti judul", () => {
  // Rel ini adalah daftar SEBELUM MULAI. Selama berjalan, service memegang
  // profil Chrome, jadi tiga syarat memang tidak bisa dibaca lagi - dan sebuah
  // pecahan "3 dari 6" di layar yang menemani run yang SEHAT membaca seperti
  // separuh sistem rusak.
  const run = clone({ status: { automation: "RUNNING", config: { present: true } }, tiktok: null, obs: null });
  const v = U.readyView(run, "id");
  assert.equal(v.counting, false);
  assert.equal(v.label, "");
  assert.deepEqual(v.cells, []);
  assert.equal(v.title, T("ui.ready.titleRunning"));
  // Dan saat berhenti ia kembali menghitung, dengan judul "sebelum mulai".
  assert.equal(U.readyView(READY, "id").counting, true);
  assert.equal(U.readyView(READY, "id").title, T("ui.ready.title"));
});

test("saat BERJALAN, baris yang tidak bisa dibaca mengatakannya - bukan 'Memeriksa...'", () => {
  // "Memeriksa..." yang tidak pernah selesai adalah pernyataan yang SALAH yang
  // bertahan sepanjang LIVE, dan operator menunggu sesuatu yang tidak akan
  // pernah datang.
  const run = clone({ status: { automation: "RUNNING", config: { present: true } }, tiktok: null, obs: null });
  const values = U.readinessRows(run, "id").map((r) => r.value);
  assert.ok(values.includes(T("ui.row.cannotCheck")), values.join(" | "));
  assert.ok(!values.includes(T("ui.state.checking")), values.join(" | "));

  // Saat BERHENTI, datum yang belum terbaca memang sedang dibaca.
  const loading = { status: { automation: "STOPPED", config: { present: true } } };
  assert.ok(U.readinessRows(loading, "id").map((r) => r.value).includes(T("ui.state.checking")));
});

// ===========================================================================
// Kartu "sedang tayang"
// ===========================================================================

const PLAY_AT = Date.parse("2026-10-10T09:24:00.000Z");
const RUN_WITH = (events) => ({ status: { automation: "RUNNING", config: { present: true } }, activity: events });

test("tidak tayang: kartunya tersembunyi, dan tidak ada angka yang dikarang", () => {
  assert.equal(U.onairView(READY, "id", PLAY_AT).visible, false);
  // Berjalan tapi belum ada scene yang mulai: tetap tersembunyi.
  assert.equal(U.onairView(RUN_WITH([]), "id", PLAY_AT).visible, false);
  const v = U.onairView(RUN_WITH([]), "id", PLAY_AT);
  assert.equal(v.elapsed, "");
  assert.equal(v.elapsedSeconds, 0);
});

test("waktu berjalan dihitung dari stempel waktu PLAY, bukan dari panjang scene", () => {
  const v = U.onairView(
    RUN_WITH([{ id: 1, type: "PLAY", scene: "SCENE-UJI", time: "2026-10-10T09:24:00.000Z" }]),
    "id",
    PLAY_AT + 84000
  );
  assert.equal(v.visible, true);
  assert.equal(v.elapsedSeconds, 84);
  assert.equal(v.elapsed, "1:24");
  // Dan ia MENANJAK, bukan menurun: tidak ada hitungan mundur, karena panjang
  // scene tidak pernah dikirim ke UI.
  assert.ok(U.onairView(
    RUN_WITH([{ id: 1, type: "PLAY", scene: "SCENE-UJI", time: "2026-10-10T09:24:00.000Z" }]),
    "id",
    PLAY_AT + 120000
  ).elapsedSeconds > v.elapsedSeconds);
});

test("scene yang sudah selesai TIDAK terus dipamerkan", () => {
  const events = [
    { id: 1, type: "PLAY", scene: "SCENE-UJI", time: "2026-10-10T09:24:00.000Z" },
    { id: 2, type: "PLAYBACK_END", scene: "SCENE-UJI", time: "2026-10-10T09:25:40.000Z" },
  ];
  assert.equal(U.onairView(RUN_WITH(events), "id", PLAY_AT + 200000).visible, false);
});

test("rantai pin dan balasan: menunggu, berhasil, dan gagal masing-masing berbeda", () => {
  const play = { id: 1, type: "PLAY", scene: "SCENE-UJI", time: "2026-10-10T09:24:00.000Z" };

  const waiting = U.onairView(RUN_WITH([play]), "id", PLAY_AT + 2000);
  assert.deepEqual(waiting.chain.map((c) => c.value), [T("ui.onair.waiting"), T("ui.onair.waiting")]);
  assert.deepEqual(waiting.chain.map((c) => c.tone), ["neutral", "neutral"]);

  const done = U.onairView(
    RUN_WITH([
      play,
      { id: 2, type: "AUTOPIN_SUCCESS", product: "Produk Uji", time: "2026-10-10T09:24:06.000Z" },
      { id: 3, type: "AUTOCOMMENT_SUCCESS", time: "2026-10-10T09:24:09.000Z" },
    ]),
    "id",
    PLAY_AT + 20000
  );
  assert.deepEqual(done.chain.map((c) => c.tone), ["ready", "ready"]);
  // Judulnya menjadi produk yang SUNGGUH ter-pin; nama scene turun ke bawahnya.
  assert.equal(done.title, "Produk Uji");
  assert.equal(done.sub, T("ui.onair.scene", { scene: "SCENE-UJI" }));

  const failed = U.onairView(
    RUN_WITH([play, { id: 2, type: "AUTOPIN_FAILED", reason: "live-pin-control-not-available", time: "2026-10-10T09:24:06.000Z" }]),
    "id",
    PLAY_AT + 20000
  );
  assert.equal(failed.chain[0].tone, "attention");
  assert.equal(failed.chain[0].value, I18N.DICT.id["err.live-pin-control-not-available"]);
});

test("kejadian dari scene SEBELUMNYA tidak dihitung sebagai hasil scene sekarang", () => {
  const events = [
    { id: 1, type: "PLAY", scene: "SCENE-A", time: "2026-10-10T09:20:00.000Z" },
    { id: 2, type: "AUTOPIN_SUCCESS", product: "Produk A", time: "2026-10-10T09:20:05.000Z" },
    { id: 3, type: "PLAYBACK_END", scene: "SCENE-A", time: "2026-10-10T09:23:00.000Z" },
    { id: 4, type: "PLAY", scene: "SCENE-B", time: "2026-10-10T09:24:00.000Z" },
  ];
  const v = U.onairView(RUN_WITH(events), "id", PLAY_AT + 5000);
  assert.equal(v.scene, "SCENE-B");
  // Pin milik SCENE-A tidak boleh muncul sebagai pin milik SCENE-B.
  assert.equal(v.title, T("ui.onair.scene", { scene: "SCENE-B" }));
  assert.equal(v.chain[0].value, T("ui.onair.waiting"));
});

// ===========================================================================
// Aturan sebagai kalimat
// ===========================================================================

test("aturan kosong: kalimatnya mengatakan apa yang belum diisi, bukan menuduh", () => {
  const c = U.ruleChips(U.mappingToRow(U.blankMapping()), { scenes: [], resolvedTitle: null }, "id");
  assert.deepEqual(c.triggers, []);
  assert.equal(c.triggersEmpty, T("ui.rule.f.triggersEmpty"));
  assert.equal(c.productNone, T("ui.rule.f.productNone"));
  assert.equal(c.noReply, T("ui.rule.noReply"));
  // Daftar scene masih kosong: JANGAN mengaku scene-nya hilang dari OBS.
  assert.equal(c.sceneMissing, "");
});

test("scene disebut hilang HANYA kalau daftar scene memang sudah dibaca", () => {
  const row = { scene: "SCENE-HANTU", productTitle: "", triggersText: "", reply: "" };
  // Discovery belum pernah berhasil -> tidak menuduh.
  assert.equal(U.ruleChips(row, { scenes: [] }, "id").sceneMissing, "");
  // Daftar sudah dibaca dan scene-nya tidak ada -> baru boleh mengatakannya.
  assert.equal(
    U.ruleChips(row, { scenes: ["SCENE-LAIN"] }, "id").sceneMissing,
    T("ui.rule.f.sceneMissing", { scene: "SCENE-HANTU" })
  );
});

test("isi aturan adalah milik customer: dikembalikan apa adanya, tanpa diterjemahkan", () => {
  const row = { scene: "SCENE-UJI", productTitle: "Judul Produk Customer", triggersText: "pemicu satu\npemicu dua", reply: "balasan customer" };
  I18N.LANGS.forEach((L) => {
    const c = U.ruleChips(row, { scenes: ["SCENE-UJI"], resolvedTitle: null }, L);
    assert.deepEqual(c.triggers, ["pemicu satu", "pemicu dua"]);
    assert.equal(c.scene, "SCENE-UJI");
    assert.equal(c.product, "Judul Produk Customer");
    assert.equal(c.reply, "balasan customer");
  });
});

test("judul yang sebenarnya terlihat di LIVE hanya disebut kalau ia BERBEDA", () => {
  const row = { scene: "S", productTitle: "Potongan Judul", triggersText: "x", reply: "" };
  assert.equal(
    U.ruleChips(row, { scenes: ["S"], resolvedTitle: "Potongan Judul Lengkap 110g" }, "id").resolved,
    T("ui.rule.f.resolved", { title: "Potongan Judul Lengkap 110g" })
  );
  // Sama persis: tidak perlu diulang.
  assert.equal(U.ruleChips(row, { scenes: ["S"], resolvedTitle: "Potongan Judul" }, "id").resolved, "");
});

// ===========================================================================
// Bahasa
// ===========================================================================

test("setiap kalimat Direction D ada di KETIGA bahasa, dan berbeda satu sama lain", () => {
  const run = clone({
    status: { automation: "RUNNING", config: { present: true } },
    activity: [{ id: 1, type: "PLAY", scene: "SCENE-UJI", time: "2026-10-10T09:24:00.000Z" }],
  });
  const seen = {};
  I18N.LANGS.forEach((L) => {
    const h = U.heroView(run, L);
    const t = U.tallyView(run, L);
    const r = U.readyView(run, L);
    const o = U.onairView(run, L, PLAY_AT + 5000);
    [h.over, h.title, h.note, t.label, r.title, o.chain[0].label, U.activityCapText(L)].forEach((s) => {
      assert.ok(s && String(s).length > 0, L + " ada kalimat yang kosong");
    });
    seen[L] = [h.title, t.label, r.title].join("|");
  });
  // Tiga bahasa, tiga bunyi. Kunci yang lupa diterjemahkan akan jatuh ke
  // cadangan Indonesia dan membuat dua di antaranya identik.
  assert.notEqual(seen.id, seen.en);
  assert.notEqual(seen.en, seen["zh-CN"]);
  assert.notEqual(seen.id, seen["zh-CN"]);
});

test("tidak ada kode mesin yang pernah sampai ke kalimat Direction D", () => {
  const errored = clone({
    status: { automation: "ERROR", config: { present: true }, lastError: { reason: "obs-unavailable" } },
  });
  const blocked = { status: { automation: "STOPPED", config: { present: true }, mode: { ok: true }, login: {} }, rows: [] };
  I18N.LANGS.forEach((L) => {
    const sentences = [
      U.heroView(errored, L).title,
      U.heroView(errored, L).note,
      U.heroView(blocked, L).title,
      U.heroView(blocked, L).note,
      U.tallyView(errored, L).label,
      U.readyView(blocked, L).label,
    ];
    sentences.forEach((s) => {
      // Kode mesin berbentuk kata-kata-berhubung-tanda-minus.
      assert.ok(!/\b[a-z]+(-[a-z]+){2,}\b/.test(s), L + ": " + s);
      assert.ok(s.indexOf("mappings[") === -1, L + ": " + s);
      assert.ok(s.indexOf("undefined") === -1 && s.indexOf("{") === -1, L + ": " + s);
    });
  });
});

// ===========================================================================
// Tema: token semantik, satu lembar gaya
// ===========================================================================

const CSS = readPublic("styles.css");

test("tema gelap mendefinisikan ULANG token yang sama, bukan lembar gaya kedua", () => {
  const SEMANTIC = [
    "bg", "surface", "surface-raised", "text", "text-muted", "border",
    "input-bg", "hover", "disabled", "accent", "success", "warning", "danger",
  ];
  const light = /:root\s*\{([\s\S]*?)\}/.exec(CSS);
  const dark = /:root\[data-theme="dark"\]\s*\{([\s\S]*?)\}/.exec(CSS);
  assert.ok(light && dark, "kedua blok tema harus ada");

  SEMANTIC.forEach((name) => {
    assert.match(light[1], new RegExp("--" + name + ":"), "terang kehilangan --" + name);
    assert.match(dark[1], new RegExp("--" + name + ":"), "gelap kehilangan --" + name);
  });

  // Dan tidak ada komponen yang ditulis dua kali untuk tema gelap. Satu-satunya
  // aturan yang boleh disaring per tema adalah yang memang menyangkut tema.
  const darkRules = (CSS.match(/:root\[data-theme="dark"\]/g) || []).length;
  assert.ok(darkRules <= 3, "tema gelap tidak boleh menjadi lembar gaya kedua: " + darkRules);
});

test("tidak ada warna mentah di satu pun aturan komponen", () => {
  // Hex hanya boleh hidup di dalam dua blok definisi token. Di luar itu, warna
  // yang ditulis langsung adalah warna yang tidak ikut berganti tema.
  const withoutTokens = CSS
    .replace(/:root\s*\{[\s\S]*?\}/, "")
    .replace(/:root\[data-theme="dark"\]\s*\{[\s\S]*?\}/, "");
  const hexes = (withoutTokens.match(/#[0-9a-fA-F]{3,8}\b/g) || []);
  // Putih dan hitam murni pada tombol destruktif/mulai boleh: keduanya harus
  // tetap kontras di kedua tema, dan itu memang keputusan yang disengaja.
  const bad = hexes.filter((h) => !/^#(fff|000)$/i.test(h));
  assert.deepEqual(bad, [], "warna mentah di luar blok token");
});

test("halaman tidak memuat satu pun font atau skrip dari jaringan", () => {
  // Aplikasi ini harus utuh di komputer tanpa internet.
  const html = readPublic("index.html");
  [html, CSS].forEach((src) => {
    assert.ok(!/https?:\/\//.test(src.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "")), "tidak ada URL luar");
    assert.ok(!/@import/.test(src), "tidak ada @import");
  });
  assert.ok(!/fonts\.googleapis|fonts\.gstatic/.test(CSS));
});

test("tema dan bahasa hanya pernah menulis dua atribut, dan tidak menyentuh config", () => {
  const app = readPublic("app.js");
  // Preferensi presentasi tidak boleh punya jalan ke config atau runtime.
  const setPrefs = app.slice(app.indexOf("function setLang("), app.indexOf("// --- pemuatan data"));
  assert.ok(setPrefs.length > 0);
  assert.ok(!/\/api\//.test(setPrefs), "mengganti bahasa/tema tidak memanggil API");
  assert.ok(!/config|mappings|autoPin|autoComment/i.test(setPrefs), setPrefs);
  // Dan keduanya memang diterapkan ke DOM lewat prefs.js, satu tempat.
  assert.match(setPrefs, /prefs\.applyTo\(document\.documentElement\)/);
});

test("mengganti bahasa mengisi ulang SELURUH teks statis", () => {
  // Kalau hanya sebagian yang diisi ulang, sisanya tertinggal dalam bahasa lama.
  const app = readPublic("app.js");
  const setLang = app.slice(app.indexOf("function setLang("), app.indexOf("function setTheme("));
  assert.match(setLang, /fillStatic\(\)/);
  assert.match(setLang, /renderAll\(\)/);

  // Dan setiap teks statis di halaman memang terikat ke kunci kamus.
  const html = readPublic("index.html").replace(/<!--[\s\S]*?-->/g, "");
  const keys = [...html.matchAll(/data-t="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length > 30, "halaman harus mengikat banyak teks statis: " + keys.length);
  const missing = keys.filter((k) => I18N.DICT.id[k] === undefined);
  assert.deepEqual(missing, [], "kunci dirujuk halaman tapi tidak ada di kamus");
});

test("kata customer tidak ditulis di app.js: semuanya dari kamus", () => {
  const app = readPublic("app.js");
  const code = app
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");

  const found = [];
  for (const m of code.matchAll(/"((?:[^"\\\n]|\\.){8,})"/g)) {
    const v = m[1];
    if (/^(ui|err|field|path)\./.test(v)) continue; // kunci kamus
    if (/^[a-z-]+$/.test(v)) continue; // id node, nama operasi
    if (v.indexOf("/api/") === 0 || v.indexOf("application/json") === 0) continue;
    if (/^[\w-]+$/.test(v)) continue;
    if (/^[a-z][a-z0-9 -]*$/.test(v)) continue; // daftar kelas CSS, pragma
    if (/[(){}]|=>|return /.test(v)) continue; // potongan kode, bukan kalimat
    if (!/[a-z] [a-z]/.test(v)) continue; // harus terbaca sebagai kalimat
    found.push(v);
  }
  assert.deepEqual(found, [], "kalimat customer harus hidup di i18n.js");
});
