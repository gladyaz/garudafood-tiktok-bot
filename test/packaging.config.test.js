// Konfigurasi electron-builder, diperiksa dari SUMBERNYA.
//
// Tidak ada build yang dijalankan di sini: satu build memakan ratusan MB dan
// puluhan detik, dan tes yang semahal itu akan dimatikan orang. Yang diperiksa
// adalah keputusan-keputusan yang kalau salah akan menghasilkan installer yang
// TETAP BERJALAN SEMPURNA di mesin pengembang:
//
//   - memuat .env, config, atau profil browser berisi sesi TikTok pengembang
//   - menjalankan BOT sebagai proses utama Electron, bukan shell-nya
//   - menghapus data customer saat uninstall
//   - meminta Administrator untuk sesuatu yang per-user
//
// Audit isi paket yang sungguhan ada di scripts/package/verify-package.js dan
// dijalankan oleh hook afterPack, yaitu SEBELUM installer dibentuk.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
const build = pkg.build || {};

// --- identitas ---------------------------------------------------------------

test("appId, productName, dan versi pilot sesuai keputusan P5", () => {
  assert.equal(build.appId, "com.ailivehost.desktop");
  assert.equal(build.productName, "AI LIVE HOST");
  assert.equal(pkg.version, "0.1.0");
});

test("nama paket menentukan direktori instalasi, jadi ia harus nama PRODUK", () => {
  // Direktori instalasi per-user dibentuk electron-builder dari package.json
  // `name` APA ADANYA, bukan dari productName:
  //
  //   app-builder-lib/out/targets/nsis/NsisTarget.js:171
  //     APP_PACKAGE_NAME: getWindowsInstallationAppPackageName(appInfo.name)
  //   app-builder-lib/out/appInfo.js:115
  //     get name() { return this.info.metadata.name }
  //
  // Terbukti di mesin ini pada 2026-10-08: dengan name lama, aplikasi terpasang
  // di %LOCALAPPDATA%\Programs\garudafood-tiktok-bot sementara produknya bernama
  // AI LIVE HOST.
  //
  // Yang membuatnya lebih dari soal kerapian: nama lama MENYEBUTKAN nama klien
  // asal, dan installer pilot ini akan diberikan ke orang lain. Kata itu juga
  // nilai di forbiddenShops — penjaga produksi — jadi ia memang tidak boleh
  // tersebar bersama produk.
  assert.equal(pkg.name, "ai-live-host");
  assert.ok(!/garudafood/i.test(pkg.name), "nama klien tidak boleh muncul di direktori instalasi customer");
  // npm mewajibkan huruf kecil tanpa spasi, jadi ia tidak bisa persis productName.
  assert.match(pkg.name, /^[a-z0-9][a-z0-9-]*$/, "harus nama paket npm yang sah");
});

test("versi di package.json dipakai electron-builder untuk metadata installer", () => {
  // Tidak ada versi kedua yang bisa menyimpang: artifactName dibentuk dari
  // ${version}, jadi nama installer dan metadata executable selalu satu angka.
  assert.match(String(build.win.artifactName), /\$\{version\}/);
  assert.match(String(build.win.artifactName), /\$\{productName\}/);
});

// --- entry point: kesalahan paling berbahaya di seluruh konfigurasi ----------

test("aplikasi terpaket menjalankan SHELL, bukan bot", () => {
  // package.json repo memakai "main": "index.js" — itu BOT, dan itu benar untuk
  // jalur legacy `node index.js` yang masih dipakai.
  //
  // Kalau nilai itu lolos ke aplikasi terpaket, Electron akan menjalankan bot
  // sebagai proses utamanya: tanpa jendela, tanpa Controller, dan bot yang
  // menyentuh TikTok dari dalam proses yang dikira cuma shell. Tidak ada tes
  // offline lain yang bisa melihat itu, karena di repo "main" memang index.js.
  assert.equal(pkg.main, "index.js", "jalur legacy tidak boleh berubah");
  assert.equal(build.extraMetadata.main, "desktop/main.js", "yang terpaket WAJIB shell Electron");
});

// --- asar: keputusan yang disengaja -----------------------------------------

test("asar MATI, dan itu keputusan pilot yang dinyatakan", () => {
  // Controller, bot, dan service dijalankan oleh node.exe SUNGGUHAN yang kita
  // bundel. Node biasa tidak mengerti filesystem virtual app.asar seperti
  // Electron, jadi path anak-anak itu harus path filesystem nyata.
  //
  // Konsekuensinya source bisa dibaca. Itu DITERIMA: asar bukan batas keamanan,
  // ia hanya arsip tanpa enkripsi yang bisa dibongkar dengan satu perintah.
  assert.equal(build.asar, false);
});

// --- allowlist ---------------------------------------------------------------

test("allowlist memuat SEMUA yang dijalankan saat runtime", () => {
  const files = build.files.filter((f) => !String(f).startsWith("!"));
  const joined = files.join("\n");
  // Empat entry point: shell, Controller, bot, service.
  for (const needed of ["desktop/", "controller/", "index.js", "autopin-service.js"]) {
    assert.ok(joined.includes(needed), "allowlist harus memuat " + needed);
  }
  // Dan modul yang hanya dimuat MALAS — saat customer menekan LOGIN TIKTOK atau
  // discovery. Tidak satu pun dari ini terlihat dari require di tingkat atas,
  // jadi allowlist yang disusun dari pembacaan statis akan melewatkannya.
  // Lihat controller/lazy.js dan buildBrowserDeps() di controller/index.js.
  for (const lazy of ["autopin/", "autocomment/", "tiktok/", "runtime/"]) {
    assert.ok(joined.includes(lazy), "allowlist harus memuat " + lazy + " (dimuat malas)");
  }
});

test("allowlist MENOLAK artefak pengembang", () => {
  const deny = build.files.filter((f) => String(f).startsWith("!")).join("\n");
  // Lapis kedua: daftar `files` sudah menolak secara default, tapi hal-hal ini
  // kalau ikut bukan sekadar pemborosan ukuran.
  assert.match(deny, /\.env/, ".env pengembang (password OBS, username TikTok)");
  assert.match(deny, /\.autopin-profile/, "profil browser memuat SESI TIKTOK");
  assert.match(deny, /\.bot\.lock/, "state runtime");
});

test("allowlist TIDAK memuat tes, data pengembang, maupun skrip build", () => {
  const allow = build.files.filter((f) => !String(f).startsWith("!"));
  for (const f of allow) {
    const g = String(f);
    assert.ok(!g.startsWith("test"), "tes tidak boleh dipaketkan: " + g);
    assert.ok(!g.startsWith("data"), "data/ pengembang tidak boleh dipaketkan: " + g);
    assert.ok(!g.startsWith("scripts"), "skrip build tidak boleh dipaketkan: " + g);
    assert.ok(!g.startsWith("packaging"), "sumber paku tidak boleh dipaketkan: " + g);
    assert.ok(!g.startsWith("build"), "staging vendor masuk lewat extraResources: " + g);
    assert.ok(g !== "**/*" && g !== "**", "allowlist tidak boleh memaketkan seluruh repo: " + g);
  }
});

test("autopin-cli.js TIDAK dipaketkan: Controller tidak pernah menjalankannya", () => {
  // Daftar skrip yang Controller boleh jalankan tertutup dan berisi dua nama
  // saja (controller/process-manager.js SCRIPTS). CLI pengembang tidak termasuk,
  // dan memaketkannya hanya menambah permukaan tanpa ada yang memakainya.
  const allow = build.files.filter((f) => !String(f).startsWith("!"));
  assert.ok(!allow.includes("autopin-cli.js"));
});

// --- runtime terbundel -------------------------------------------------------

test("Node dan browser terbundel ikut lewat extraResources", () => {
  const map = new Map(build.extraResources.map((e) => [e.from, e.to]));
  assert.equal(map.get("build/vendor/node"), "runtime/node");
  assert.equal(map.get("build/vendor/browser"), "runtime/browser");
  assert.equal(map.get("build/vendor/licenses"), "licenses");
  assert.equal(map.get("build/generated/runtime-manifest.json"), "runtime-manifest.json");
});

test("lisensi Node ikut didistribusikan bersama runtime-nya", () => {
  // Membundel node.exe adalah redistribusi, dan redistribusi punya kewajiban.
  // Teksnya TIDAK dikarang: ia datang dari repositori resmi nodejs/node pada tag
  // versi yang dibundel — lihat packaging/licenses/node/PROVENANCE.md.
  const froms = build.extraResources.map((e) => e.from);
  assert.ok(froms.includes("build/vendor/licenses"));
  assert.ok(fs.existsSync(path.join(REPO, "packaging", "licenses", "node", "LICENSE")));
  assert.ok(fs.existsSync(path.join(REPO, "packaging", "licenses", "node", "PROVENANCE.md")));
});

// --- NSIS --------------------------------------------------------------------

test("target Windows adalah NSIS x64, dan hanya itu", () => {
  // P5 tidak memaketkan macOS/Linux, dan tidak ada arsitektur kedua: setiap
  // target tambahan adalah target yang tidak diuji.
  assert.deepEqual(build.win.target, [{ target: "nsis", arch: ["x64"] }]);
  assert.equal("mac" in build, false, "P5 tidak memaketkan macOS");
  assert.equal("linux" in build, false, "P5 tidak memaketkan Linux");
});

test("instalasi PER-USER dan tanpa Administrator", () => {
  assert.equal(build.nsis.perMachine, false);
  assert.equal(build.nsis.allowElevation, false);
  assert.equal(build.nsis.oneClick, true);
});

test("shortcut Desktop dan Start Menu dibuat", () => {
  assert.equal(build.nsis.createDesktopShortcut, true);
  assert.equal(build.nsis.createStartMenuShortcut, true);
  assert.equal(build.nsis.shortcutName, "AI LIVE HOST");
});

test("UNINSTALL TIDAK MENGHAPUS data customer", () => {
  // Yang dipertaruhkan: %APPDATA%\AI LIVE HOST memuat profil browser dengan SESI
  // TIKTOK customer. Uninstall yang menghapusnya membuat setiap reinstall
  // memaksa login ulang, dan uninstall yang tidak disengaja menghancurkan
  // seluruh setup-nya. Default-nya memang false; disebutkan eksplisit karena
  // nilainya terlalu mahal untuk bergantung pada default.
  assert.equal(build.nsis.deleteAppDataOnUninstall, false);
});

test("installer TIDAK menyalakan aplikasi, dan TIDAK ada autostart Windows", () => {
  // Aplikasi ini menyalakan Controller dan membuka browser automation. Tidak
  // satu pun dari itu boleh terjadi sebagai efek samping sebuah installer, atau
  // sebagai efek samping dari customer menyalakan komputernya.
  assert.equal(build.nsis.runAfterFinish, false);
  const text = JSON.stringify(build);
  assert.ok(!/autostart|startOnLogin|launchOnLogin/i.test(text), "tidak boleh ada autostart");
});

// --- yang BELUM boleh ada di P5 ---------------------------------------------

test("TIDAK ada auto-updater di konfigurasi", () => {
  // Aplikasi yang bisa memperbarui dirinya sendiri adalah aplikasi yang bisa
  // mengganti engine LIVE di tengah LIVE. P5 sengaja tidak punya itu.
  const text = JSON.stringify(build);
  assert.ok(!/electron-updater|autoUpdate|generateUpdatesFilesForAllChannels/i.test(text));
  assert.equal("publish" in build, false, "tanpa target publish, tanpa saluran update");
});

test("TIDAK ada code signing yang dikonfigurasi di P5", () => {
  // Installer pilot ini TIDAK bertanda tangan, dan SmartScreen bisa
  // memperingatkan. Itu dilaporkan apa adanya; yang TIDAK boleh adalah
  // mematikan SmartScreen atau melemahkan Defender.
  for (const key of ["certificateFile", "certificateSubjectName", "certificateSha1", "signingHashAlgorithms"]) {
    assert.equal(key in build.win, false, key + " belum boleh ada di P5");
  }
});

// --- keluaran build ----------------------------------------------------------

test("keluaran build ke dist/, dan dist/ DI-GITIGNORE", () => {
  assert.equal(build.directories.output, "dist");
  const ignore = fs.readFileSync(path.join(REPO, ".gitignore"), "utf8");
  const lines = ignore.split(/\r?\n/).map((l) => l.trim());
  assert.ok(lines.includes("dist/"), "installer ratusan MB tidak boleh bisa ter-commit");
  assert.ok(lines.includes("build/vendor/"), "binary Node/Chrome tidak boleh ter-commit");
  assert.ok(lines.includes("build/generated/"), "manifest hasil build tidak ter-commit");
});

// --- gerbang audit -----------------------------------------------------------

test("hook afterPack terpasang: temuan audit MENGGAGALKAN build", () => {
  // Tanpa hook ini, audit hanya bisa melapor SESUDAH installer ada sebagai
  // berkas — dan berkas itu lalu bisa tersalin dan terkirim. Pemeriksaan yang
  // hanya melaporkan adalah pemeriksaan yang suatu saat diabaikan.
  assert.equal(build.afterPack, "scripts/package/after-pack.js");
  assert.ok(fs.existsSync(path.join(REPO, "scripts", "package", "after-pack.js")));
  assert.equal(typeof require("../scripts/package/after-pack.js"), "function");
});

test("audit paket mencari rahasia dari MESIN INI, bukan daftar pola", () => {
  // Pola hanya menemukan rahasia yang bentuknya sudah kita duga. Yang dicari di
  // sini adalah NILAI yang benar-benar ada di mesin build — password OBS dan
  // username TikTok dari .env dan data/config.json.
  const { collectSecrets } = require("../scripts/package/verify-package");
  const secrets = collectSecrets();
  assert.ok(Array.isArray(secrets));
  // Nilainya tidak diperiksa di sini (dan tidak pernah dicetak); yang diperiksa
  // adalah bahwa mekanismenya benar-benar menemukan sesuatu di mesin ini.
  assert.ok(secrets.length > 0, "mesin build ini punya .env, jadi harus ada yang dicari");
  for (const s of secrets) {
    assert.equal(typeof s.label, "string");
    assert.ok(s.value.length >= 6, "nilai terlalu pendek akan cocok dengan apa saja");
  }
});

// --- skrip npm ---------------------------------------------------------------

test("skrip packaging ada, dan prepare selalu mendahului build", () => {
  // Build yang dijalankan tanpa prepare akan memaketkan direktori vendor yang
  // kosong atau basi, dan hasilnya adalah installer tanpa runtime — yang baru
  // terlihat saat dijalankan di mesin tanpa Node.
  assert.match(pkg.scripts["package:win"], /package:prepare/);
  assert.match(pkg.scripts["package:win:unpacked"], /package:prepare/);
  assert.match(pkg.scripts["package:win"], /electron-builder/);
  assert.match(pkg.scripts["package:win:unpacked"], /--dir/);
  assert.ok(pkg.scripts["package:verify"], "audit bisa dijalankan sendiri juga");
  // Dan jalur development TIDAK berubah.
  assert.equal(pkg.scripts.desktop, "electron desktop/main.js");
});

test("tes packaging ikut dijalankan npm test", () => {
  // Tes yang tidak terdaftar adalah tes yang tidak pernah dijalankan.
  for (const name of ["packaging.paths.test.js", "packaging.config.test.js", "packaging.runtime.test.js"]) {
    assert.ok(pkg.scripts.test.includes(name), name + " harus terdaftar di npm test");
  }
});
