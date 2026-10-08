// Runtime terbundel: Node, browser, pembersihan Chrome, dan log dukungan.
// SEMUANYA OFFLINE — tidak ada binary yang dijalankan, tidak ada PowerShell.
//
// ---------------------------------------------------------------------------
// TIGA KEGAGALAN YANG DIJAGA BERKAS INI
//
// Ketiganya punya bentuk yang sama: seluruh tes offline tetap hijau, dan
// kerusakannya baru muncul di mesin customer.
//
//   1. Mode terpaket jatuh kembali ke Node sistem. Berhasil di mesin pengembang
//      (yang punya Node), gagal di customer pertama yang tidak punya.
//
//   2. Mode terpaket diam-diam membuka Chrome sistem. Jalur pin lalu berjalan di
//      atas DOM yang belum pernah diuji, dan gagal sebagai "produk tidak ketemu"
//      di tengah LIVE.
//
//   3. Pencarian Chrome automation berhenti cocok dengan letak profilnya. Chrome
//      tertinggal hidup memegang sesi TikTok, sementara setiap laporan
//      pembersihan tetap berbunyi nol. Ini PERSIS bentuk insiden 2026-10-05.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const { resolveNodePath, looksLikeNode, looksLikeElectron } = require("../desktop/node-path");
const { resolveBrowserPath, REQUIRED_SIBLINGS } = require("../desktop/browser-path");
const { resolveAppPaths, BUNDLED } = require("../desktop/paths");
const { createWindowsChromeKiller } = require("../controller/index.js");
const { createSupportLog, redactLine } = require("../desktop/support-log");

const REPO = path.resolve(__dirname, "..");

const RESOURCES = "C:\\Programs\\AI LIVE HOST\\resources";
const USERDATA = "C:\\Users\\Customer\\AppData\\Roaming\\AI LIVE HOST";
const PACKED = resolveAppPaths({
  isPackaged: true,
  resourcesPath: RESOURCES,
  userData: USERDATA,
  moduleDir: path.join(RESOURCES, "app", "desktop"),
});

// fs palsu: daftar berkas yang "ada". Tidak ada disk yang disentuh.
function fakeFs(present = []) {
  const set = new Set(present.map((p) => path.resolve(p)));
  return {
    statSync(file) {
      if (!set.has(path.resolve(file))) {
        const err = new Error("ENOENT");
        err.code = "ENOENT";
        throw err;
      }
      return { isFile: () => true };
    },
  };
}

// --- Node terbundel ----------------------------------------------------------

test("terpaket: Node TERBUNDEL yang dipilih", () => {
  const r = resolveNodePath({
    packaged: true,
    bundledNode: PACKED.bundledNode,
    fs: fakeFs([PACKED.bundledNode]),
  });
  assert.equal(r.ok, true);
  assert.equal(r.nodePath, PACKED.bundledNode);
  assert.equal(r.from, "bundled");
});

test("terpaket: TIDAK PERNAH jatuh kembali ke Node sistem", () => {
  // Diberi PATH yang memuat Node sungguhan DAN override AILIVE_NODE_PATH yang
  // sah. Keduanya harus diabaikan: aplikasi terpaket yang paketnya rusak tidak
  // boleh menyala di mesin yang kebetulan punya Node, karena satu-satunya mesin
  // seperti itu adalah mesin pengembang — dan kerusakannya lalu dikirim ke
  // customer sebagai installer yang "sudah diuji".
  const systemNode = "C:\\Program Files\\nodejs\\node.exe";
  const r = resolveNodePath({
    packaged: true,
    bundledNode: path.join(RESOURCES, "runtime", "node", "node.exe"),
    env: { PATH: "C:\\Program Files\\nodejs", AILIVE_NODE_PATH: systemNode },
    // Node sistem ADA; yang terbundel TIDAK.
    fs: fakeFs([systemNode]),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bundled-node-missing");
  assert.equal("nodePath" in r, false, "tidak boleh mengembalikan path apa pun");
});

test("terpaket: Node terbundel hilang = FAIL CLOSED", () => {
  const r = resolveNodePath({ packaged: true, bundledNode: PACKED.bundledNode, fs: fakeFs([]) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bundled-node-missing");
});

test("terpaket tanpa bundledNode = cacat pemrograman, dan TETAP fail closed", () => {
  // Kalau suatu saat ada yang memanggil resolver tanpa menyebutkan Node
  // terbundel, jawabannya TIDAK boleh menjadi pencarian PATH. Di mesin
  // pengembang pencarian itu berhasil, jadi bug-nya akan lolos review dan lolos
  // tes, lalu muncul hanya di mesin customer.
  const r = resolveNodePath({ packaged: true, env: { PATH: "C:\\Program Files\\nodejs" } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bundled-node-not-configured");
});

test("Electron yang SUDAH DIGANTI NAMA tetap dikenali sebagai bukan Node", () => {
  // electron-builder menamai binary terpasang dengan nama produk, jadi
  // process.execPath di aplikasi terpaket adalah "AI LIVE HOST.exe".
  //
  // Pertanyaan lama ("apakah ini electron.exe?") menjawab TIDAK untuk berkas
  // itu, dan jawabannya adalah "pakai execPath apa adanya sebagai Node". Bot dan
  // service lalu dinyalakan sebagai "AI LIVE HOST.exe" — dan SELURUH
  // perlindungan proses yatim mencari Name='node.exe'. Pemeriksaannya tetap
  // hijau; yang disembunyikannya adalah bot yang hidup di akun sungguhan.
  assert.equal(looksLikeNode("C:\\Programs\\AI LIVE HOST\\AI LIVE HOST.exe"), false);
  assert.equal(looksLikeElectron("C:\\Programs\\AI LIVE HOST\\AI LIVE HOST.exe"), true);

  const r = resolveNodePath({ execPath: "C:\\Programs\\AI LIVE HOST\\AI LIVE HOST.exe", env: {} });
  assert.equal(r.ok, false, "harus menolak, bukan memakai binary Electron sebagai Node");
  assert.equal(r.reason, "node-not-found");
});

test("development: perilaku Node TIDAK berubah dari P4", () => {
  const underNode = resolveNodePath({ execPath: "C:\\Program Files\\nodejs\\node.exe" });
  assert.equal(underNode.ok, true);
  assert.equal(underNode.from, "execPath");

  const noNode = resolveNodePath({ execPath: "C:\\x\\electron.exe", env: {} });
  assert.equal(noNode.ok, false);
  assert.equal(noNode.reason, "node-not-found");
});

// --- browser terbundel -------------------------------------------------------

test("terpaket: browser TERBUNDEL yang dipilih", () => {
  const dir = path.dirname(PACKED.bundledBrowser);
  const r = resolveBrowserPath({
    packaged: true,
    bundledBrowser: PACKED.bundledBrowser,
    fs: fakeFs([PACKED.bundledBrowser].concat(REQUIRED_SIBLINGS.map((n) => path.join(dir, n)))),
  });
  assert.equal(r.ok, true);
  assert.equal(r.browserPath, PACKED.bundledBrowser);
  assert.equal(r.from, "bundled");
});

test("terpaket: browser hilang = FAIL CLOSED, bukan Chrome sistem", () => {
  const r = resolveBrowserPath({ packaged: true, bundledBrowser: PACKED.bundledBrowser, fs: fakeFs([]) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bundled-browser-missing");
  assert.equal("browserPath" in r, false, "tidak boleh menawarkan browser lain");
});

test("terpaket: chrome.exe ADA tapi chrome.dll tidak = dilaporkan TERPISAH", () => {
  // chrome.exe hanya 3 MB; yang membuatnya menyala adalah chrome.dll 266 MB di
  // sebelahnya. Satu aturan allowlist yang terlalu sempit menghasilkan chrome.exe
  // yang ada tapi mati saat dijalankan. Kalau yang diperiksa cuma keberadaan
  // chrome.exe, resolver melaporkan sukses dan kegagalannya pindah ke saat
  // customer menekan LOGIN TIKTOK.
  //
  // Dibedakan dari "missing" karena perbaikannya berbeda: yang satu browsernya
  // tidak ikut, yang satu ikut tapi separuh.
  const r = resolveBrowserPath({
    packaged: true,
    bundledBrowser: PACKED.bundledBrowser,
    fs: fakeFs([PACKED.bundledBrowser]),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bundled-browser-incomplete");
  assert.deepEqual(r.missing, ["chrome.dll"]);
});

test("terpaket tanpa bundledBrowser = fail closed", () => {
  const r = resolveBrowserPath({ packaged: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bundled-browser-not-configured");
});

test("development: browser diserahkan ke Puppeteer, dan itu BUKAN kegagalan", () => {
  const r = resolveBrowserPath({ packaged: false });
  assert.equal(r.ok, true);
  assert.equal(r.browserPath, null, "null berarti: jangan sebutkan executablePath");
  assert.equal(r.from, "puppeteer-cache");
});

// --- KOPLING profil <-> pencarian Chrome -------------------------------------

test("REGRESI: pencarian Chrome automation COCOK dengan letak profil terpaket", () => {
  // Inilah kegagalan paling mungkin dari seluruh fase ini, dan bentuknya persis
  // insiden 2026-10-05.
  //
  // Sampai P4, pola pencariannya adalah substring tetap "autopin-profile", dan
  // itu benar selama profilnya bernama .autopin-profile. Aplikasi terpaket
  // memindahkannya ke %APPDATA%\AI LIVE HOST\browser-profile — yang TIDAK memuat
  // substring itu. Pola tetap lalu cocok dengan nol proses, dan melaporkannya
  // sebagai killed=0: terbaca "tidak ada yang perlu dibersihkan", bukan "saya
  // tidak menemukan apa pun".
  //
  // Akibatnya Chrome automation tertinggal hidup memegang sesi TikTok customer,
  // dan START BOT berikutnya gagal dengan "profile-in-use" tanpa jalan keluar.
  const profileDir = PACKED.profileDir;

  // Pertama: buktikan bahwa token lama memang TIDAK ada di path baru. Kalau
  // suatu saat ini gagal, berarti profilnya dinamai ulang dan tes ini kehilangan
  // artinya — itu pun harus terlihat.
  assert.ok(
    !profileDir.includes("autopin-profile"),
    "premis tes: path terpaket tidak memuat token lama, jadi pola tetap akan buta"
  );

  // Kedua: pola yang dibangun dari path SUNGGUHAN memang memuat path itu.
  const killer = createWindowsChromeKiller({ profileDirName: profileDir });
  assert.ok(
    killer.__pattern.includes("browser-profile"),
    "pola harus diturunkan dari profil yang dipakai, bukan ditulis tetap: " + killer.__pattern
  );
  assert.ok(killer.__pattern.includes("AI LIVE HOST"), killer.__pattern);

  // Ketiga: default lama tetap utuh untuk jalur manual.
  assert.ok(createWindowsChromeKiller().__pattern.includes("autopin-profile"));
});

test("pola pencarian Chrome aman terhadap path yang nakal", () => {
  // *, ?, [ dan ] adalah wildcard di -like PowerShell, dan ' mengakhiri string
  // ber-kutip-satu. Nama folder customer bisa memuat keduanya (mis. "O'Brien",
  // atau sebuah "[backup]"), dan kalau tidak di-escape maka pencariannya berhenti
  // bekerja TANPA error — kelas kegagalan yang sama dengan pola yang tidak cocok.
  const tricky = "C:\\Users\\O'Brien\\AppData\\Roaming\\AI LIVE HOST [v2]\\browser-profile";
  const pat = createWindowsChromeKiller({ profileDirName: tricky }).__pattern;

  assert.ok(pat.startsWith("'") && pat.endsWith("'"), "harus string ber-kutip-satu: " + pat);
  assert.ok(pat.includes("O''Brien"), "kutip satu harus digandakan: " + pat);
  assert.ok(pat.includes("`[v2`]"), "kurung siku harus di-escape dengan backtick: " + pat);
  // Kutip satu yang tidak digandakan akan menutup string lebih awal; buktikan
  // tidak ada kutip satu tunggal di dalam isinya.
  assert.ok(!/[^']'[^']/.test(pat.slice(1, -1)), "tidak boleh ada kutip satu tak berpasangan: " + pat);
});

test("stop-all.ps1 ikut mengenali profil terpaket", () => {
  // Skrip ini adalah alat yang dipercaya operator untuk menjawab "sudah bersih
  // atau belum" sebelum LIVE. Kalau ia hanya melihat profil di repo, ia akan
  // menerbitkan "sisa chrome autopin: 0" sementara Chrome terpaket masih hidup —
  // angka nol yang menenangkan dan salah, yaitu kegagalan yang melahirkan skrip
  // ini pada 2026-10-05.
  const src = fs.readFileSync(path.join(REPO, "scripts", "stop-all.ps1"), "utf8");
  assert.match(src, /autopin-profile/, "profil checkout pengembang");
  assert.match(src, /AI LIVE HOST\\browser-profile/, "profil aplikasi terpasang");
  // Kunci bot juga hidup di dua tempat sejak P5.
  assert.match(src, /APPDATA/, "kunci di %APPDATA% ikut dibersihkan");
});

// --- tiga daftar yang harus tetap sejalan ------------------------------------

test("extraResources, paths.js, dan audit paket menunjuk tata letak yang SAMA", () => {
  // Tiga berkas memutuskan hal yang sama dan tidak saling membaca:
  //
  //   prepare-runtime.js   MENSTAGING ke build/vendor/{node,browser,licenses}
  //   package.json         MEMETAKAN staging -> resources/{runtime,licenses}
  //   desktop/paths.js     MENCARI di resources/runtime/...
  //   verify-package.js    MEWAJIBKAN resources/runtime/...
  //
  // Rename di salah satunya adalah kehilangan diam-diam di dua lainnya, dan
  // satu-satunya yang akan memberitahu adalah menjalankan aplikasi terpaket.
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
  const map = new Map(pkg.build.extraResources.map((e) => [e.from, e.to]));

  assert.equal(map.get("build/vendor/node"), "runtime/node");
  assert.equal(map.get("build/vendor/browser"), "runtime/browser");
  assert.equal(map.get("build/vendor/licenses"), "licenses");
  assert.equal(map.get("build/generated/runtime-manifest.json"), "runtime-manifest.json");

  // Dan paths.js mencari persis di hasil pemetaan itu.
  const toPosix = (p) => p.split(path.sep).join("/");
  assert.equal(toPosix(BUNDLED.NODE), map.get("build/vendor/node") + "/node.exe");
  assert.equal(toPosix(BUNDLED.BROWSER), map.get("build/vendor/browser") + "/chrome.exe");
  assert.equal(BUNDLED.MANIFEST, map.get("build/generated/runtime-manifest.json"));

  // Dan audit paket mewajibkan berkas di tempat yang sama.
  const { REQUIRED } = require("../scripts/package/verify-package");
  const required = REQUIRED.map((r) => r.rel);
  assert.ok(required.includes("resources/" + toPosix(BUNDLED.NODE)), "audit harus mewajibkan node.exe terbundel");
  assert.ok(required.includes("resources/" + toPosix(BUNDLED.BROWSER)), "audit harus mewajibkan chrome.exe terbundel");
  assert.ok(required.includes("resources/runtime/browser/chrome.dll"), "dan DLL yang membuatnya menyala");
  assert.ok(required.includes("resources/licenses/node/LICENSE"), "dan lisensi Node");
});

test("paku runtime ada, dan lisensi Node tersimpan di repo", () => {
  // Binary-nya TIDAK di Git (92,8 MB + 386 MB). Yang di Git adalah pakunya —
  // versi, ukuran, SHA-256 — plus teks lisensi, yang tidak boleh dikarang.
  const pins = JSON.parse(fs.readFileSync(path.join(REPO, "packaging", "runtime-pins.json"), "utf8"));
  assert.match(pins.node.version, /^v\d+\.\d+\.\d+$/);
  assert.match(pins.node.sha256, /^[0-9a-f]{64}$/);
  assert.match(pins.browser.version, /^\d+\.\d+\.\d+\.\d+$/);
  assert.match(pins.browser.sha256, /^[0-9a-f]{64}$/);

  const license = path.join(REPO, pins.node.license.path);
  assert.ok(fs.existsSync(license), "lisensi Node WAJIB ada sebelum runtime-nya didistribusikan");
  assert.equal(fs.statSync(license).size, pins.node.license.size, "teks lisensi tidak boleh berubah tanpa paku ikut berubah");

  // SHA-256 diperiksa di sini juga, bukan hanya di prepare-runtime.js.
  //
  // Alasannya satu: akhir baris. Repo ini dikerjakan dengan core.autocrlf=true,
  // dan konversi LF->CRLF mengubah berkas yang sama menjadi 160.552 byte dengan
  // hash yang berbeda. Build lalu LULUS di mesin yang menulis berkasnya dan
  // GAGAL di setiap clone baru, dengan node-license-sha256-mismatch.
  //
  // Dijaga oleh .gitattributes (`packaging/licenses/** -text`); tes ini yang
  // memberi tahu kalau penjagaan itu hilang — di sini, bukan di mesin orang lain.
  const digest = crypto.createHash("sha256").update(fs.readFileSync(license)).digest("hex");
  assert.equal(digest, pins.node.license.sha256, "byte lisensi harus persis seperti yang dipaku");
});

test(".gitattributes melindungi berkas yang HASH-nya diverifikasi", () => {
  const attrs = fs.readFileSync(path.join(REPO, ".gitattributes"), "utf8");
  assert.match(attrs, /packaging\/licenses\/\*\*\s+-text/, "lisensi tidak boleh dikonversi akhir barisnya");
});

// --- log dukungan ------------------------------------------------------------

test("log dukungan MENYUNTING rahasia", () => {
  // Berkas ini akan hidup lebih lama daripada ingatan siapa pun tentang baris log
  // mana yang aman, dan customer akan MENGIRIMKAN isinya saat melaporkan masalah.
  const cases = [
    ['[CONTROLLER_CONFIG] obs.password=sup3rsecret host=127.0.0.1', "sup3rsecret"],
    ['{"password": "hunter2"}', "hunter2"],
    ["Cookie: sessionid=abc123def456", "abc123def456"],
    ["sid_tt=ZZZbigcookievalue", "ZZZbigcookievalue"],
    ["msToken=qqqqwwwweeee", "qqqqwwwweeee"],
    ["authorization: Bearer eyJhbGciOi", "eyJhbGciOi"],
    ["access_token=tok_live_12345", "tok_live_12345"],
    ["apiKey=verysecretkey", "verysecretkey"],
  ];
  for (const [line, secret] of cases) {
    const out = redactLine(line);
    assert.ok(!out.includes(secret), "rahasia lolos: " + line + " -> " + out);
    assert.ok(out.includes("redacted"), "harus menyisakan jejak bahwa ada yang disunting: " + out);
  }
});

test("log dukungan membiarkan baris teknis APA ADANYA", () => {
  // Penyuntingan yang terlalu rajin menghapus justru baris yang gunanya
  // mendiagnosis, dan log yang tidak berguna sama saja dengan tidak ada log.
  const keep = [
    "[CONTROLLER_BOOT] stage=modules-loaded ms=154",
    "[DESKTOP_CONTROLLER_READY] pid=1234 ms=390",
    "[CONTROLLER_LISTENING] host=127.0.0.1 port=4782 ms=410",
    "[CONTROLLER_STATE] from=IDLE to=PREFLIGHT",
  ];
  for (const line of keep) assert.equal(redactLine(line), line, line);
});

test("log dukungan BERBATAS: berotasi dan menyimpan paling banyak 3 berkas", () => {
  // LIVE berjalan berjam-jam, setiap hari, di mesin customer. Log yang tumbuh
  // tanpa batas pada akhirnya adalah bug.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ailive-log-test-"));
  try {
    const log = createSupportLog({ dir, maxBytes: 400, keep: 3, now: () => new Date(0) });
    for (let i = 0; i < 200; i += 1) log.write("baris pengisi nomor " + i);

    const files = fs.readdirSync(dir).sort();
    assert.ok(files.length <= 4, "1 aktif + paling banyak 3 rotasi, dapat: " + files.join(","));
    assert.ok(files.includes("ai-live-host.log"), files.join(","));
    assert.ok(!files.includes("ai-live-host.log.4"), "rotasi keempat harus dibuang: " + files.join(","));

    for (const f of files) {
      const size = fs.statSync(path.join(dir, f)).size;
      assert.ok(size <= 400 + 200, f + " melewati batas: " + size);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("log dukungan yang TIDAK BISA ditulis tidak menjatuhkan aplikasi", () => {
  // Aplikasi yang menolak menyala karena direktori log-nya tidak bisa dibuat
  // adalah aplikasi yang rusak demi kemampuannya menjelaskan kerusakan.
  const errors = [];
  const log = createSupportLog({
    dir: "Z:\\tidak\\ada\\sama\\sekali",
    fs: {
      mkdirSync() {
        throw new Error("EACCES");
      },
      statSync() {
        throw new Error("ENOENT");
      },
      appendFileSync() {
        throw new Error("EACCES");
      },
      existsSync: () => false,
      renameSync() {},
      rmSync() {},
    },
    onError: (e) => errors.push(String(e.message)),
  });

  assert.doesNotThrow(() => log.write("apa pun"));
  assert.equal(log.write("lagi"), false, "melaporkan gagal, bukan berpura-pura berhasil");
  assert.equal(errors.length, 1, "dilaporkan SEKALI, bukan setiap baris");
});
