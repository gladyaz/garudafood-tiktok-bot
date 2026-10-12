/* Headed atau headless: kebijakan, penyambungannya, dan pagar-pagarnya.
 *
 * Yang dijaga di sini satu kalimat: customer tidak boleh melihat Chrome
 * muncul-hilang saat bot bekerja, DAN customer harus melihat Chrome saat ia
 * diminta login sendiri. Kedua arah itu sama pentingnya — jendela yang hilang
 * saat login dibutuhkan adalah aplikasi yang menggantung tanpa penjelasan.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const MODE = require("../autopin/browser-mode");
const { PURPOSE, HEADLESS_ENV, resolveHeadless } = MODE;

// ===========================================================================
// Kebijakan
// ===========================================================================

test("login SELALU terlihat, apa pun isi environment", () => {
  const environments = [
    {},
    { [HEADLESS_ENV]: "true" },
    { [HEADLESS_ENV]: "false" },
    { [HEADLESS_ENV]: "TRUE" },
    { [HEADLESS_ENV]: "" },
    { [HEADLESS_ENV]: "yagitu" },
  ];
  for (const env of environments) {
    assert.equal(resolveHeadless(PURPOSE.LOGIN, env), false, JSON.stringify(env));
  }
});

test("runtime headless secara BAWAAN kalau variabelnya tidak diset", () => {
  assert.equal(resolveHeadless(PURPOSE.RUNTIME, {}), true);
  assert.equal(resolveHeadless(PURPOSE.RUNTIME, { LAIN: "x" }), true);
});

test("AILIVE_BROWSER_HEADLESS=false membuat runtime TERLIHAT", () => {
  assert.equal(resolveHeadless(PURPOSE.RUNTIME, { [HEADLESS_ENV]: "false" }), false);
  // Huruf besar-kecil dan spasi tidak boleh jadi perangkap saat mendiagnosa.
  assert.equal(resolveHeadless(PURPOSE.RUNTIME, { [HEADLESS_ENV]: "FALSE" }), false);
  assert.equal(resolveHeadless(PURPOSE.RUNTIME, { [HEADLESS_ENV]: "  false  " }), false);
});

test("AILIVE_BROWSER_HEADLESS=true menjaga runtime tetap headless", () => {
  assert.equal(resolveHeadless(PURPOSE.RUNTIME, { [HEADLESS_ENV]: "true" }), true);
});

test("nilai tak dikenal jatuh ke HEADLESS, bukan ke terlihat", () => {
  // Arah gagalnya dipilih: salah ketik harus memberi customer perilaku
  // produksi yang benar, bukan jendela Chrome di tengah LIVE.
  for (const bad of ["", " ", "0", "no", "off", "nope", "falsy", "1", "yes"]) {
    assert.equal(resolveHeadless(PURPOSE.RUNTIME, { [HEADLESS_ENV]: bad }), true, JSON.stringify(bad));
  }
  // Variabel yang salah ketik namanya juga tidak boleh berpengaruh.
  assert.equal(resolveHeadless(PURPOSE.RUNTIME, { AILIVE_BROWSER_HEADLES: "false" }), true);
});

test("purpose WAJIB: hilang atau tak dikenal melempar, tidak diam-diam memilih", () => {
  for (const bad of [undefined, null, "", "Login", "LOGIN", "runtime ", "debug", 1, {}]) {
    assert.throws(
      () => resolveHeadless(bad, {}),
      (err) => err && err.reason === "browser-purpose-invalid",
      "seharusnya melempar untuk " + JSON.stringify(bad)
    );
  }
});

// ===========================================================================
// Penyambungan di launchBrowser
// ===========================================================================

// launchBrowser memanggil puppeteer.launch sungguhan, jadi yang diperiksa di
// sini adalah PILIHANNYA — lewat modul kebijakan yang sama yang dipakainya —
// plus bentuk sumbernya. Membuka Chrome sungguhan bukan pekerjaan tes unit.
test("launchBrowser menolak purpose yang hilang SEBELUM menyentuh disk atau Chrome", async () => {
  const { launchBrowser } = require("../autopin/browser");
  // profileDir sengaja menunjuk tempat yang tidak boleh dibuat. Kalau penolakan
  // purpose terjadi lebih dulu, berkas itu tidak akan pernah ada.
  const nowhere = path.join(ROOT, "data", ".runtime", "__tidak-boleh-dibuat__");
  await assert.rejects(
    () => launchBrowser({ profileDir: nowhere }, undefined),
    (err) => err && err.reason === "browser-purpose-invalid"
  );
  assert.equal(fs.existsSync(nowhere), false, "purpose harus ditolak sebelum ensurePrivateDir()");
});

test("launchBrowser meneruskan keputusan headless ke puppeteer", () => {
  // Dibaca dari sumber: satu-satunya nilai `headless` yang diteruskan harus
  // berasal dari resolveHeadless(), bukan konstanta.
  const src = read("autopin/browser.js");
  assert.match(src, /const headless = resolveHeadless\(purpose, env\);/);
  assert.match(src, /headless,/, "puppeteer.launch harus memakai variabelnya");
  assert.ok(!/headless:\s*(true|false)/.test(src), "tidak boleh ada headless yang ditulis mati");
});

// ===========================================================================
// PAGAR: jalur produksi baru tidak boleh lupa menyebut purpose
// ===========================================================================

test("PAGAR: setiap pemanggil launchBrowser di produksi menyebut purpose", () => {
  // Inilah tes yang menjaga aturannya saat jalur baru ditambahkan nanti. Tanpa
  // ini, satu `launchBrowser(cfg)` baru akan melempar saat dijalankan di LIVE —
  // bukan di CI.
  const FILES = [
    "autopin/service.js",
    "autopin-cli.js",
    "controller/login.js",
    "controller/discovery/tiktok.js",
  ];

  // Semua berkas .js produksi dipindai, bukan hanya yang di atas: daftar tetap
  // akan basi persis saat ia paling dibutuhkan.
  const scanned = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      if (["node_modules", "dist", "test", ".git", "design", "data"].includes(name)) continue;
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else if (name.endsWith(".js")) scanned.push(full);
    }
  };
  walk(ROOT);
  assert.ok(scanned.length > 20, "pemindaian harus menemukan berkas produksi: " + scanned.length);

  const offenders = [];
  for (const file of scanned) {
    const src = fs.readFileSync(file, "utf8");
    // Baris yang MEMANGGIL launchBrowser (bukan mendefinisikan, mengoper, atau
    // menyebutnya di komentar).
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    // `function launchBrowser(` adalah DEFINISINYA, bukan pemanggil. Ia memang
    // menerima purpose sebagai parameter; menghitungnya sebagai pelanggar
    // membuat pagar ini merah karena berkas yang justru menegakkan aturannya.
    const re = /(?<!function )(?:\b|\.)launchBrowser\(([^)]*)\)/g;
    let m;
    while ((m = re.exec(code))) {
      const args = m[1];
      if (/^\s*$/.test(args)) continue; // launchBrowser() tanpa argumen: bukan pola kita
      const hasPurpose = /PURPOSE\.(LOGIN|RUNTIME)|["'](login|runtime)["']/.test(args);
      if (!hasPurpose) offenders.push(path.relative(ROOT, file) + " -> launchBrowser(" + args.trim() + ")");
    }
  }
  assert.deepEqual(offenders, [], "pemanggil launchBrowser tanpa purpose");

  // Dan keempat berkas yang kita tahu memang memanggilnya memang menyebutkannya.
  for (const rel of FILES) {
    assert.match(read(rel), /launchBrowser\([^)]*PURPOSE\.(LOGIN|RUNTIME)/, rel);
  }
});

test("login memakai PURPOSE.LOGIN dan runtime memakai PURPOSE.RUNTIME", () => {
  assert.match(read("controller/login.js"), /launchBrowser\(bcfg, PURPOSE\.LOGIN\)/);
  assert.match(read("autopin-cli.js"), /cmdLogin[\s\S]{0,400}?launchBrowser\(config, PURPOSE\.LOGIN\)/);

  assert.match(read("controller/discovery/tiktok.js"), /launchBrowser\(bcfg, PURPOSE\.RUNTIME\)/);
  assert.match(read("autopin/service.js"), /launchBrowser\(config, PURPOSE\.RUNTIME\)/);
  assert.match(read("autopin-cli.js"), /withConsole[\s\S]{0,400}?launchBrowser\(config, PURPOSE\.RUNTIME\)/);
});

// ===========================================================================
// Profil: satu, dipakai bersama
// ===========================================================================

test("login dan runtime memakai profil persisten yang SAMA", () => {
  const { toAutopinConfig, defaultConfig } = require("../controller/config-manager");
  const config = defaultConfig();

  // Kedua jalur memakai penerjemah yang sama, jadi profilnya tidak bisa
  // menyimpang. Inilah kenapa sesi yang disimpan login manual langsung bisa
  // dipakai runtime headless tanpa menyalin cookie apa pun.
  const a = toAutopinConfig(config);
  const b = toAutopinConfig(config);
  assert.equal(typeof a.profileDir, "string");
  assert.ok(a.profileDir.length > 0);
  assert.equal(a.profileDir, b.profileDir);

  // Dan sumbernya memang satu fungsi, bukan dua salinan.
  const login = read("controller/login.js");
  const disc = read("controller/discovery/tiktok.js");
  assert.match(login, /toBrowserConfig\(config\)/);
  assert.match(disc, /toBrowserConfig\(config\)/);
});

test("mode browser TIDAK pernah masuk ke config customer", () => {
  // Preferensi presentasi tidak boleh punya jalan ke berkas yang dibaca bot.
  const cm = read("controller/config-manager.js");
  assert.ok(!cm.includes(HEADLESS_ENV), "config-manager tidak boleh menyebut saklar headless");

  const { defaultConfig, validateConfig } = require("../controller/config-manager");
  const asText = JSON.stringify(defaultConfig());
  assert.ok(!asText.includes("headless"), "schema config tidak boleh punya field headless");
  assert.equal(typeof validateConfig, "function");
});

// ===========================================================================
// Penerusan ke proses service
// ===========================================================================

test("saklar diteruskan EKSPLISIT ke anak, karena anak tidak mewarisi env", () => {
  const src = read("controller/controller.js");
  // Anak dibangun dari basis yang sempit dan disengaja; kalau saklar ini tidak
  // ikut, `=false` hanya akan membuat discovery terlihat sementara service
  // tetap headless — setengah diagnosa.
  assert.match(src, /HEADLESS_ENV/, "controller harus menyebut nama saklarnya");
  // Dibaca SEKALI di tingkat createController, bukan di dalam startAutomation:
  // di sana `const env = toEnv(...)` menaungi parameter env dan membacanya di
  // dalam inisialisasi const itu melempar TDZ di SETIAP start.
  assert.match(src, /const headlessOverride = typeof env\[HEADLESS_ENV\] === "string"/);
  assert.match(
    src,
    /\.\.\.\(headlessOverride === null \? \{\} : \{ \[HEADLESS_ENV\]: headlessOverride \}\)/,
    "diteruskan hanya kalau diset"
  );

  // Dan ia masuk ke BASIS env anak, bukan ke tempat lain.
  const base = src.slice(src.indexOf("const env = toEnv(config, {"), src.indexOf("paths,\n    });"));
  assert.ok(base.includes("headlessOverride"), "harus berada di dalam basis env anak");
  assert.ok(base.includes("PATH: process.env.PATH"), "basis env anak tidak boleh berubah bentuk");
});
