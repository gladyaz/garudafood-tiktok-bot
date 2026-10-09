// Kartu kesiapan: apa yang dibaca operator saat belum ada apa pun yang jalan.
//
// Keluhan nyata dari app TERPASANG, 2026-10-09: automation STOPPED, tapi
// kartunya terbaca seperti sistem yang sedang bekerja. Penyebabnya tiga hal
// yang masing-masing kecil dan bersama-sama menyesatkan:
//
//   1. judulnya "Connection & Readiness" — kata "readiness" tidak memberi tahu
//      bahwa ini syarat SEBELUM mulai;
//   2. baris keadaan automation ada di PALING BAWAH, di bawah lima baris hijau;
//   3. `.readiness dd.ready` dan `.readiness dd.running` berwarna SAMA, jadi
//      "produk tersedia" tampak persis seperti "bot berjalan".
//
// Tidak satu pun dari itu bug logika — dan itulah sebabnya tes ini ada. Tanpa
// tes, kalimat dan urutan adalah hal yang paling mudah hilang pada perubahan
// berikutnya, karena tidak ada yang merah kalau ia kembali salah.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const U = require("../controller/public/ui-logic.js");
const S = U.STATES;

const PUBLIC_DIR = path.join(__dirname, "..", "controller", "public");
const readPublic = (name) => fs.readFileSync(path.join(PUBLIC_DIR, name), "utf8");

// Keadaan "semua syarat terpenuhi, tapi automation BERHENTI" — persis keadaan
// yang disalahbaca.
const ALL_GREEN_STOPPED = Object.freeze({
  obs: { ok: true },
  tiktok: { ok: true, identity: "toko uji", live: true, productCount: 5 },
  validation: { ok: true, mappings: [{ ok: true }, { ok: true }, { ok: true }, { ok: true }, { ok: true }] },
  status: { automation: S.STOPPED },
});

// --- urutan ------------------------------------------------------------------

test("REGRESI: keadaan automation dibaca PERTAMA, bukan terakhir", () => {
  const rows = U.readinessRows(ALL_GREEN_STOPPED);
  assert.equal(rows[0].label, "Automation");
  assert.equal(rows[0].value, "Stopped");
  assert.equal(rows[0].tone, U.TONE.NEUTRAL);
});

test("baris automation tetap satu-satunya, tidak terduplikasi", () => {
  const rows = U.readinessRows(ALL_GREEN_STOPPED);
  assert.equal(rows.filter((r) => r.label === "Automation").length, 1);
});

// --- kosakata ----------------------------------------------------------------

test("REGRESI: saat BERHENTI, tidak ada nilai yang berbunyi seperti sedang bekerja", () => {
  const rows = U.readinessRows(ALL_GREEN_STOPPED);
  const values = rows.map((r) => String(r.value).toLowerCase());

  for (const word of ["ready", "active", "running"]) {
    const guilty = values.filter((v) => v.includes(word));
    assert.deepEqual(guilty, [], `nilai tidak boleh memuat "${word}" saat berhenti`);
  }
});

test("tiap baris memakai kata yang sesuai keadaannya sendiri", () => {
  const rows = U.readinessRows(ALL_GREEN_STOPPED);
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));

  assert.equal(byLabel.OBS, "Connected");
  assert.equal(byLabel.TikTok, "Connected");
  assert.equal(byLabel["TikTok sign-in"], "Signed in as toko uji");
  assert.equal(byLabel.LIVE, "On air");
  assert.equal(byLabel.Products, "5 available in your LIVE");
  assert.equal(byLabel.Mappings, "5 mappings OK");

  // Dan tidak satu pun dari lima nilai itu sama dengan yang lain: kata yang
  // dipakai ulang untuk hal yang berbeda adalah asal masalahnya.
  const five = [byLabel.OBS, byLabel.LIVE, byLabel.Products, byLabel.Mappings, byLabel.Automation];
  assert.equal(new Set(five).size, five.length);
});

test("satu pemetaan memakai bentuk tunggal", () => {
  const rows = U.readinessRows({
    validation: { ok: true, mappings: [{ ok: true }] },
    status: { automation: S.STOPPED },
  });
  assert.equal(rows.find((r) => r.label === "Mappings").value, "1 mapping OK");
});

test("LIVE mati tetap berbunyi apa adanya", () => {
  const rows = U.readinessRows({
    tiktok: { ok: true, live: false, productCount: 0 },
    status: { automation: S.STOPPED },
  });
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r]));
  assert.equal(byLabel.LIVE.value, "Not on air");
  assert.equal(byLabel.LIVE.tone, U.TONE.ATTENTION);
  assert.equal(byLabel.Products.value, "None available");
});

// --- warna -------------------------------------------------------------------

test("tone 'tersedia' dan tone 'berjalan' adalah dua kelas yang BERBEDA", () => {
  assert.notEqual(U.TONE.READY, U.TONE.RUNNING);

  const stopped = U.readinessRows(ALL_GREEN_STOPPED);
  // Saat berhenti: tidak boleh ada satu pun baris bertone "running".
  assert.equal(stopped.filter((r) => r.tone === U.TONE.RUNNING).length, 0);

  const running = U.readinessRows(Object.assign({}, ALL_GREEN_STOPPED, { status: { automation: S.RUNNING } }));
  // Saat berjalan: tepat SATU baris bertone "running", yaitu Automation.
  const hot = running.filter((r) => r.tone === U.TONE.RUNNING);
  assert.equal(hot.length, 1);
  assert.equal(hot[0].label, "Automation");
});

test("REGRESI: styles.css tidak boleh menyamakan warna ready dan running", () => {
  const css = readPublic("styles.css");

  // Dulu keduanya satu daftar selektor dengan satu warna hijau.
  assert.ok(
    !/\.readiness\s+dd\.ready\s*,\s*\n?\s*\.readiness\s+dd\.running/.test(css),
    "ready dan running tidak boleh berbagi satu aturan"
  );

  const ruleFor = (selector) => {
    const re = new RegExp(selector.replace(/[.\s]/g, (c) => (c === "." ? "\\." : "\\s+")) + "\\s*\\{([^}]*)\\}");
    const m = re.exec(css);
    assert.ok(m, "aturan tidak ketemu: " + selector);
    return m[1];
  };

  assert.match(ruleFor(".readiness dd.ready"), /var\(--ok\)/);
  assert.match(ruleFor(".readiness dd.running"), /var\(--ready\)/);

  // Dan dua tokennya memang nilai yang berbeda.
  const ok = /--ok:\s*([^;]+);/.exec(css);
  const ready = /--ready:\s*([^;]+);/.exec(css);
  assert.ok(ok && ready);
  assert.notEqual(ok[1].trim(), ready[1].trim());
});

// --- kalimat kepala kartu ----------------------------------------------------

test("saat BERHENTI, kartu mengatakan belum ada yang berjalan", () => {
  const hint = U.readinessHint({ status: { automation: S.STOPPED } });
  assert.match(hint, /Nothing is running yet/);
  assert.match(hint, /START BOT/);
});

test("saat BERJALAN, kalimatnya berubah", () => {
  const hint = U.readinessHint({ status: { automation: S.RUNNING } });
  assert.match(hint, /running/);
  assert.ok(!/Nothing is running yet/.test(hint));
});

test("keadaan peralihan tidak mengarang kalimat", () => {
  for (const state of [S.PREFLIGHT, S.STARTING, S.STOPPING]) {
    assert.equal(U.readinessHint({ status: { automation: state } }), "");
  }
  // Belum ada status sama sekali: diam, bukan menebak.
  assert.equal(U.readinessHint(null), "");
  assert.equal(U.readinessHint({}), "");
});

test("REGRESI: ERROR TIDAK berbunyi \"belum ada yang jalan\"", () => {
  // Versi pertama perbaikan ini menyatukan STOPPED dan ERROR dalam satu kalimat.
  // Itu salah-baca yang sama, hanya terbalik: run yang MATI terbaca seperti mesin
  // yang belum pernah dipakai, dan kata "yet" membuat operator menekan START BOT
  // tanpa membaca sebab kegagalan yang sedang tampil di baris teratas kartu.
  const hint = U.readinessHint({ status: { automation: S.ERROR } });
  assert.ok(!/Nothing is running yet/.test(hint), hint);
  assert.match(hint, /ended with a problem/);
  assert.match(hint, /START BOT/);
});

// --- lapisan DOM tidak boleh punya kalimatnya sendiri ------------------------

test("REGRESI: app.js mengambil kalimat dari ui-logic, tidak menulisnya sendiri", () => {
  const app = readPublic("app.js");
  const body = /function renderReadiness\(\)[\s\S]*?\n  \}/.exec(app);
  assert.ok(body, "renderReadiness harus bisa ditemukan");
  assert.match(body[0], /U\.readinessHint\(state\)/);
  // Kalimat lama yang ditulis langsung di DOM sudah tidak boleh ada di sana.
  assert.ok(!/only read while the automation is stopped/.test(body[0]));
});

test("judul kartu menyebut pre-start, bukan sekadar readiness", () => {
  const html = readPublic("index.html");
  const m = /<h2 id="readiness-title">([^<]*)<\/h2>/.exec(html);
  assert.ok(m, "judul kartu kesiapan harus ada");
  assert.match(m[1], /pre-start/i);
});

// --- label automation --------------------------------------------------------

test("PREFLIGHT memakai kata yang sama dengan judul kartunya", () => {
  assert.equal(U.automationLabel({ automation: S.PREFLIGHT }), "Running pre-start checks…");
});

// ===========================================================================
// Kosakata dashboard yang lain (polish pilot 2026-10-09)
// ===========================================================================

// --- daftar check saat START ------------------------------------------------

const ALL_CHECKS_PASS = Object.freeze({
  ok: true,
  checks: {
    config: { ok: true }, processes: { ok: true }, ports: { ok: true }, obs: { ok: true },
    scenes: { ok: true }, profile: { ok: true }, tiktok: { ok: true }, mappings: { ok: true },
  },
});

test("REGRESI: delapan check TIDAK lagi berbunyi satu kata yang sama", () => {
  const rows = U.preflightRows(ALL_CHECKS_PASS);
  assert.equal(rows.length, 8);

  // Dulu kedelapan baris berbunyi "Ready".
  assert.deepEqual(rows.filter((r) => r.value === "Ready").map((r) => r.label), []);

  // Dan tiap jawaban berdiri sendiri: delapan nilai, delapan kata/kelompok kata
  // yang tidak saling tumpang-tindih kecuali yang memang sama artinya.
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
  assert.equal(byLabel.Settings, "Saved");
  assert.equal(byLabel["Other bots running"], "None");
  assert.equal(byLabel["Ports this app needs"], "Available");
  assert.equal(byLabel.OBS, "Connected");
  assert.equal(byLabel["OBS scenes"], "Found");
  assert.equal(byLabel["Browser profile"], "Available");
  assert.equal(byLabel["TikTok LIVE"], "On air");
  assert.equal(byLabel.Mappings, "OK");
});

test("label check dibaca sebagai pertanyaan, jawabannya tidak mengulanginya", () => {
  // "No other bot running: None running" berbunyi dua kali; label sekarang
  // bertanya, nilainya menjawab.
  const rows = U.preflightRows(ALL_CHECKS_PASS);
  const row = rows.find((r) => r.label === "Other bots running");
  assert.ok(row);
  assert.ok(!/^No /.test(row.label), row.label);
  assert.equal(row.value, "None");
});

test("check yang tidak berlaku berkata 'Not needed', bukan 'Skipped'", () => {
  const rows = U.preflightRows({
    ok: true,
    checks: { config: { ok: true }, tiktok: { ok: true, skipped: true } },
  });
  const tk = rows.find((r) => r.label === "TikTok LIVE");
  assert.equal(tk.value, "Not needed");
  assert.equal(tk.tone, U.TONE.NEUTRAL);
});

test("KONTRAK: lulus/gagal ditentukan tone, BUKAN kata-katanya", () => {
  // Ini yang membuat seluruh perubahan kata di atas aman. Kalau suatu hari
  // failedPreflight ikut membaca `value`, tes ini yang merah — bukan LIVE.
  const mixed = U.failedPreflight({
    ok: false,
    checks: {
      config: { ok: true },
      obs: { ok: false, userMessage: "OBS is not connected." },
      tiktok: { ok: true, skipped: true },
    },
  });
  assert.equal(mixed.length, 1);
  assert.equal(mixed[0].label, "OBS");
  assert.equal(mixed[0].tone, U.TONE.ATTENTION);
});

// --- hint kartu Pemetaan ----------------------------------------------------

test("REGRESI: kunci penyuntingan Pemetaan tidak mengaku 'sedang berjalan'", () => {
  // Keadaan nyata: automation BERHENTI, tapi sebuah penyimpanan sedang jalan.
  // Kalimat lama ("Editing is disabled while the automation is running") adalah
  // pernyataan yang SALAH tentang keadaan sistem, tepat di tempat yang
  // seharusnya menjelaskan kenapa sesuatu terkunci.
  const savingMappings = U.mappingHint({
    busy: true, busyOp: "saveMappings",
    status: { automation: S.STOPPED, config: { present: true } },
  });
  assert.equal(savingMappings, "Saving your mapping…");
  assert.ok(!/running/i.test(savingMappings), savingMappings);

  const savingSettings = U.mappingHint({
    busy: true, busyOp: "saveSettings",
    status: { automation: S.STOPPED, config: { present: true } },
  });
  assert.equal(savingSettings, "Saving your settings…");
});

test("hint Pemetaan: saat memang berjalan, menyebut tombolnya", () => {
  const running = U.mappingHint({ status: { automation: S.RUNNING, config: { present: true } } });
  assert.equal(running, "Mappings can be changed after you press STOP BOT.");
});

test("hint Pemetaan diam saat tidak ada yang mengunci", () => {
  assert.equal(U.mappingHint({ status: { automation: S.STOPPED, config: { present: true } } }), "");
  assert.equal(U.mappingHint({ status: { automation: S.ERROR, config: { present: true } } }), "");
  assert.equal(U.mappingHint(null), "");
  assert.equal(U.mappingHint({}), "");
});

test("REGRESI: app.js mengambil hint Pemetaan dari ui-logic", () => {
  const app = readPublic("app.js");
  assert.match(app, /U\.mappingHint\(state\)/);
  assert.ok(!/Editing is disabled while the automation is running/.test(app));
});

// --- nama komponen internal -------------------------------------------------

test("REGRESI: kata 'Controller' tidak pernah sampai ke layar customer", () => {
  // Komentar dibuang dulu: berkas ini MENYEBUT kalimat lama di komentarnya
  // untuk menjelaskan kenapa ia diganti, dan itu tidak pernah sampai ke layar.
  const code = readPublic("ui-logic.js").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/Controller is not reachable/.test(code), "kalimat lama masih dipakai di kode");

  // Dan ketiga tempatnya memakai SATU kalimat yang sama, bukan tiga salinan.
  const down = { backendUnreachable: true, status: { automation: S.STOPPED, config: { present: true } } };
  const sentence = U.settingsView(down).hint;
  assert.match(sentence, /^AI LIVE HOST is not responding\./);
  assert.equal(U.mappingHint(down), sentence);
  assert.equal(U.controlsFor(down).startReason, sentence);
});

// --- umpan Activity ---------------------------------------------------------

test("REGRESI: nama state mesin tidak bocor ke umpan Activity", () => {
  const items = U.activityItems([
    { id: 1, time: "2026-10-09T10:00:00.000Z", type: "STATE", to: "PREFLIGHT" },
    { id: 2, time: "2026-10-09T10:00:01.000Z", type: "STATE", to: "RUNNING" },
    { id: 3, time: "2026-10-09T10:00:02.000Z", type: "STATE", to: "DEGRADED" },
    { id: 4, time: "2026-10-09T10:00:03.000Z", type: "STATE", to: "STOPPING" },
    { id: 5, time: "2026-10-09T10:00:04.000Z", type: "STATE", to: "STOPPED" },
  ]);
  const texts = items.map((i) => i.text);

  for (const raw of ["PREFLIGHT", "RUNNING", "DEGRADED", "STOPPING", "STOPPED"]) {
    assert.ok(!texts.join(" ").includes(raw), raw + " tidak boleh tampil apa adanya");
  }
  // Kata-katanya sama dengan yang dipakai pil status, bukan kosakata kedua.
  assert.ok(texts.includes("Status: " + U.automationLabel({ automation: "DEGRADED" })));
  assert.ok(texts.includes("Status: Stopped"));
});

test("kejadian balasan chat memakai kalimat yang sama di kedua lapis", () => {
  const items = U.activityItems([
    { id: 1, time: "2026-10-09T10:00:00.000Z", type: "AUTOCOMMENT_SUCCESS", scene: "PAX-1" },
  ]);
  assert.equal(items[0].text, "Reply posted in your LIVE chat");

  // Server punya katalognya sendiri untuk umpan yang sama; dua kalimat berbeda
  // untuk satu kejadian membuat operator mengira ia melihat dua hal.
  const server = require("../controller/activity.js");
  assert.equal(server.MESSAGES.AUTOCOMMENT_SUCCESS, items[0].text);
});

// --- kontrak app.js <-> ui-logic.js ----------------------------------------

test("KONTRAK: setiap U.<fungsi> yang dipakai app.js memang diekspor", () => {
  // Satu-satunya cara perubahan kalimat seperti ini bisa merusak halaman adalah
  // app.js memanggil sesuatu yang tidak ada: `U.mappingHint is not a function`
  // tidak akan terlihat di tes mana pun yang hanya memanggil ui-logic langsung,
  // dan repo ini tidak punya jsdom untuk memuat halamannya.
  const app = readPublic("app.js");
  const used = new Set();
  const re = /\bU\.([A-Za-z_$][A-Za-z0-9_$]*)/g;
  let m;
  while ((m = re.exec(app)) !== null) used.add(m[1]);

  assert.ok(used.size > 10, "harusnya banyak pemakaian U.*, dapat " + used.size);
  const missing = [...used].filter((name) => U[name] === undefined);
  assert.deepEqual(missing, [], "dipakai app.js tapi tidak diekspor ui-logic.js");

  // Dan yang baru ditambahkan memang ikut terpakai, bukan kode mati.
  for (const name of ["readinessHint", "mappingHint"]) {
    assert.ok(used.has(name), "app.js harus memakai U." + name);
    assert.equal(typeof U[name], "function");
  }
});
