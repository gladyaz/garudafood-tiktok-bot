// Resolusi path untuk aplikasi terpaket. SEMUANYA OFFLINE, tanpa Electron.
//
// ---------------------------------------------------------------------------
// APA YANG DIJAGA BERKAS INI
//
// Sampai P4, repo ini punya satu gagasan tentang "akar": path.resolve(__dirname,
// ".."). Itu benar selama kode dan data tinggal bersama — yaitu selama
// aplikasinya hanya dijalankan dari checkout pengembang.
//
// Aplikasi yang DIPASANG memecahnya menjadi tiga: kode (hanya baca), resources
// (hanya baca), dan data customer (ditulis terus-menerus). Kalau ketiganya tetap
// dianggap satu, data customer ditulis ke dalam direktori instalasi — dan
// akibatnya TIDAK muncul sebagai error:
//
//   - uninstall menghapus sesi TikTok customer bersama binary-nya
//   - setiap reinstall memaksanya login ulang, terbaca sebagai "aplikasinya lupa"
//   - di lokasi yang tidak bisa ditulis, Simpan gagal tanpa sebab yang terlihat
//
// Tidak satu pun dari itu bisa ditemukan dengan menjalankan aplikasinya di mesin
// pengembang, karena di sana semuanya bisa ditulis. Jadi dijaga di sini.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  resolveAppPaths,
  assertWritableOutsideCode,
  describePaths,
  isInside,
  PRODUCT_NAME,
  BUNDLED,
  MODE,
  PACKAGED_LAYOUT,
  DEV_LAYOUT,
} = require("../desktop/paths");

const REPO = path.resolve(__dirname, "..");

// Dua mode, dibangun sekali di sini dan dipakai seluruh berkas.
const DEV = resolveAppPaths({ isPackaged: false, moduleDir: path.join(REPO, "desktop") });

const INSTALL = "C:\\Users\\Customer\\AppData\\Local\\Programs\\AI LIVE HOST";
const RESOURCES = path.join(INSTALL, "resources");
const USERDATA = "C:\\Users\\Customer\\AppData\\Roaming\\AI LIVE HOST";

const PACKED = resolveAppPaths({
  isPackaged: true,
  resourcesPath: RESOURCES,
  userData: USERDATA,
  moduleDir: path.join(RESOURCES, "app", "desktop"),
});

// --- mode development --------------------------------------------------------

test("development: ketiga akar menjadi akar repo, dan itu disengaja", () => {
  assert.equal(DEV.mode, MODE.DEVELOPMENT);
  assert.equal(DEV.codeRoot, REPO);
  assert.equal(DEV.resourcesRoot, REPO);
  assert.equal(DEV.userDataRoot, REPO);
});

test("development: letak data PERSIS seperti sebelum P5", () => {
  // Nilai-nilai ini bukan pilihan baru. Mereka adalah tempat yang sudah dipakai
  // hari ini, dan tes ini yang menjaga agar packaging TIDAK memindahkannya:
  // memindahkan data development berarti setiap pengembang kehilangan config dan
  // sesi TikTok-nya saat menarik perubahan ini.
  assert.equal(DEV.configFile, path.join(REPO, "data", "config.json"));
  assert.equal(DEV.runtimeDir, path.join(REPO, "data", ".runtime"));
  assert.equal(DEV.profileDir, path.join(REPO, ".autopin-profile"));
  assert.equal(DEV.debugDir, path.join(REPO, ".autopin-debug"));
  assert.equal(DEV.lockFile, path.join(REPO, ".bot.lock"));
});

test("development: TIDAK ada runtime terbundel", () => {
  // Node datang dari PATH dan browser dari cache Puppeteer, seperti sebelum P5.
  assert.equal(DEV.bundledNode, null);
  assert.equal(DEV.bundledBrowser, null);
  assert.equal(DEV.manifestFile, null);
});

// --- mode terpaket -----------------------------------------------------------

test("terpaket: kode di resources/app, data di userData", () => {
  assert.equal(PACKED.mode, MODE.PACKAGED);
  assert.equal(PACKED.codeRoot, path.join(RESOURCES, "app"));
  assert.equal(PACKED.resourcesRoot, RESOURCES);
  assert.equal(PACKED.userDataRoot, USERDATA);
});

test("terpaket: config, profil, runtime, log, dan kunci SEMUANYA di userData", () => {
  assert.equal(PACKED.configFile, path.join(USERDATA, "config.json"));
  assert.equal(PACKED.runtimeDir, path.join(USERDATA, "runtime"));
  assert.equal(PACKED.profileDir, path.join(USERDATA, "browser-profile"));
  assert.equal(PACKED.debugDir, path.join(USERDATA, "browser-debug"));
  assert.equal(PACKED.logsDir, path.join(USERDATA, "logs"));
  assert.equal(PACKED.lockFile, path.join(USERDATA, ".bot.lock"));
});

test("terpaket: runtime terbundel ada di resources, bukan di userData", () => {
  assert.equal(PACKED.bundledNode, path.join(RESOURCES, "runtime", "node", "node.exe"));
  assert.equal(PACKED.bundledBrowser, path.join(RESOURCES, "runtime", "browser", "chrome.exe"));
  assert.equal(PACKED.licensesDir, path.join(RESOURCES, "licenses"));
  assert.equal(PACKED.manifestFile, path.join(RESOURCES, "runtime-manifest.json"));
});

test("terpaket: resourcesPath dan userData WAJIB, tidak boleh ditebak", () => {
  // Menebaknya dari __dirname akan menghasilkan path di dalam direktori
  // instalasi — justru hal yang modul ini ada untuk mencegah. Jadi ketiadaannya
  // adalah error, bukan nilai default.
  assert.throws(() => resolveAppPaths({ isPackaged: true, userData: USERDATA }), /resourcesPath/);
  assert.throws(() => resolveAppPaths({ isPackaged: true, resourcesPath: RESOURCES }), /userData/);
  assert.throws(() => resolveAppPaths({ isPackaged: true, resourcesPath: RESOURCES, userData: "" }), /userData/);
});

// --- pemeriksaan yang paling penting -----------------------------------------

test("terpaket: TIDAK ADA path tulis yang berada di dalam kode atau resources", () => {
  const verdict = assertWritableOutsideCode(PACKED);
  assert.equal(verdict.ok, true, JSON.stringify(verdict.violations || []));
});

test("terpaket: pelanggaran TERDETEKSI, bukan lolos diam-diam", () => {
  // Peta yang dipalsukan: userData diletakkan DI DALAM resources, yaitu bentuk
  // kesalahan yang paling mungkin terjadi kalau suatu saat seseorang
  // "menyederhanakan" resolveAppPaths dengan memakai resourcesPath untuk
  // keduanya. Pemeriksaannya harus menangkap itu.
  const bad = Object.assign({}, PACKED, {
    userDataRoot: path.join(RESOURCES, "app", "data"),
    configFile: path.join(RESOURCES, "app", "data", "config.json"),
    profileDir: path.join(RESOURCES, "app", ".autopin-profile"),
  });

  const verdict = assertWritableOutsideCode(bad);
  assert.equal(verdict.ok, false);
  const names = verdict.violations.map((v) => v.name);
  assert.ok(names.includes("userDataRoot"), "userDataRoot harus dilaporkan");
  assert.ok(names.includes("configFile"), "configFile harus dilaporkan");
  assert.ok(names.includes("profileDir"), "profileDir harus dilaporkan");
});

test("development DIKECUALIKAN dari pemeriksaan, dan itu keputusan yang dinyatakan", () => {
  // Di checkout pengembang ketiga akar memang satu pohon, dan seluruh data yang
  // ditulis sudah gitignored. Kalau pemeriksaan ini berlaku di sana, ia akan
  // selalu gagal — dan pemeriksaan yang selalu gagal akan dimatikan orang.
  assert.equal(assertWritableOutsideCode(DEV).ok, true);
  assert.equal(assertWritableOutsideCode(DEV).mode, MODE.DEVELOPMENT);
});

test("isInside tidak tertipu nama yang berawalan sama", () => {
  // "…\AI LIVE HOST" tidak boleh terbaca sebagai berada di dalam
  // "…\AI LIVE HOSTING". Tanpa perbandingan yang diakhiri pemisah, pemeriksaan
  // di atas akan melaporkan pelanggaran yang tidak ada — atau melewatkan yang ada.
  assert.equal(isInside("C:\\a\\b\\c", "C:\\a\\b"), true);
  assert.equal(isInside("C:\\a\\b", "C:\\a\\b"), true);
  assert.equal(isInside("C:\\a\\bb", "C:\\a\\b"), false);
  assert.equal(isInside("C:\\AI LIVE HOSTING\\x", "C:\\AI LIVE HOST"), false);
});

test("isInside tidak peka huruf besar/kecil di Windows", () => {
  if (process.platform !== "win32") return;
  assert.equal(isInside("C:\\Users\\X\\AppData", "c:\\users\\x"), true);
});

// --- nama produk -------------------------------------------------------------

test("PRODUCT_NAME sama dengan productName di package.json", () => {
  // Dua pihak memakai nama ini dan tidak bisa saling membaca:
  //
  //   Electron          app.setName(PRODUCT_NAME) menentukan %APPDATA%\<nama>,
  //                     yaitu tempat data customer tinggal.
  //   electron-builder  "productName" menentukan nama installer, direktori
  //                     instalasi, dan nama binary.
  //
  // Kalau keduanya berbeda, aplikasi menulis ke folder yang BUKAN folder tempat
  // ia dipasang. package.json tidak bisa meng-require JavaScript, jadi
  // kesamaannya tidak bisa dijamin oleh struktur — inilah yang menjaminnya.
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
  assert.equal(PRODUCT_NAME, "AI LIVE HOST");
  assert.equal(pkg.productName, PRODUCT_NAME, "productName package.json harus sama dengan desktop/paths.js");
  assert.equal(pkg.build.productName, PRODUCT_NAME, "build.productName juga");
});

test("main.js menyetel nama SEBELUM membaca userData", () => {
  // app.getPath("userData") dibentuk dari nama aplikasi. Membacanya lebih dulu
  // akan membekukan nama bawaan Electron, dan data customer mendarat di
  // %APPDATA%\Electron — terbukti di mesin ini pada 2026-10-08, di mana
  // productName di package.json TIDAK cukup dan diabaikan di mode dev.
  //
  // Komentar DIBUANG lebih dulu. Tanpa itu, tes memeriksa prosa: komentar yang
  // MENJELASKAN kenapa urutannya penting sendiri menyebut app.getPath("userData"),
  // dan ia berada di atas setName — jadi tesnya merah karena penjelasannya benar.
  // Pelajaran yang sama sudah ada di test/desktop.security.test.js.
  const raw = fs.readFileSync(path.join(REPO, "desktop", "main.js"), "utf8");
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");

  const setName = src.indexOf("app.setName(");
  const getUserData = src.indexOf('app.getPath("userData")');
  assert.ok(setName !== -1, "app.setName harus dipanggil");
  assert.ok(getUserData !== -1, "userData harus dibaca dari Electron");
  assert.ok(setName < getUserData, "setName harus mendahului pembacaan userData");
});

// --- log yang aman -----------------------------------------------------------

test("describePaths TIDAK memuat path apa pun", () => {
  // Tonggak startup ikut ke log dukungan yang customer KIRIMKAN saat melaporkan
  // masalah. Yang berguna di sana adalah modenya, bukan susunan direktori
  // mesinnya. Kontrak ini juga sudah dijaga sebagai perilaku di
  // test/desktop.startup.test.js ("TIDAK memuat rahasia apa pun").
  for (const paths of [DEV, PACKED]) {
    const dump = JSON.stringify(describePaths(paths));
    assert.ok(!/[A-Za-z]:[\\/]/.test(dump), "tidak boleh ada path absolut: " + dump);
    assert.ok(!/AppData|Users/i.test(dump), dump);
  }
  assert.equal(describePaths(PACKED).bundledNode, "bundled");
  assert.equal(describePaths(DEV).bundledNode, "system");
});

// --- konstanta yang dipakai lintas berkas ------------------------------------

test("tata letak terbundel cocok dengan yang dicari resolver", () => {
  assert.equal(BUNDLED.NODE, path.join("runtime", "node", "node.exe"));
  assert.equal(BUNDLED.BROWSER, path.join("runtime", "browser", "chrome.exe"));
  assert.equal(PACKAGED_LAYOUT.PROFILE, "browser-profile");
  assert.equal(DEV_LAYOUT.PROFILE, ".autopin-profile");
});
