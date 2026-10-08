// Biaya boot Controller (P4.2). OFFLINE: tidak ada OBS, tidak ada TikTok, tidak
// ada Chrome. Server HTTP-nya diikat ke 127.0.0.1 pada port sementara.
//
// ---------------------------------------------------------------------------
// ANGKA YANG MELAHIRKAN BERKAS INI
//
// Sebelum P4.2, Controller memuat 504 berkas modul SEBELUM mengikat port 4782.
// Yang benar-benar dibutuhkan untuk menyajikan dashboard hanya 152. Sisanya:
//
//   buildBrowserDeps()    +235 modul  (Puppeteer)
//   readPlayableScenes()  +117 modul  (obs-websocket-js, tiktok-live-connector)
//
// Keduanya dipanggil di main() SEBELUM server.start(), walau komentar di atas
// buildBrowserDeps() sudah mengaku "dimuat malas" — require-nya memang di dalam
// fungsi, tapi fungsinya dipanggil saat boot, jadi kelambatannya nominal saja.
//
// Di mesin dingin, tiap modul adalah satu stat + read, dan di Windows tiap read
// lewat pemindai antivirus. Pada 2026-10-08 launch pertama melampaui batas 20
// detik sementara launch kedua siap dalam 39ms.
//
// Tes di bawah mengikat angka itu supaya muatan berat tidak pelan-pelan kembali
// masuk ke jalur boot tanpa ada yang sadar.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { memoThunk, lazyFacade } = require("../controller/lazy");

const ROOT = path.resolve(__dirname, "..");

// --- controller/lazy.js ------------------------------------------------------

test("memoThunk meneruskan nilai biasa apa adanya", () => {
  // Seluruh pemanggil lama — dan setiap tes yang meng-inject array — harus tetap
  // bekerja tanpa berubah.
  assert.deepEqual(memoThunk(["a", "b"])(), ["a", "b"]);
  assert.equal(memoThunk(null)(), null);
  assert.equal(memoThunk(undefined)(), undefined);
});

test("memoThunk memanggil fungsinya TEPAT SEKALI, walau dipakai berkali-kali", () => {
  let n = 0;
  const t = memoThunk(() => {
    n += 1;
    return ["scene"];
  });
  assert.equal(n, 0, "belum dipanggil sebelum dibutuhkan");
  assert.deepEqual(t(), ["scene"]);
  assert.deepEqual(t(), ["scene"]);
  assert.deepEqual(t(), ["scene"]);
  assert.equal(n, 1);
});

test("memoThunk mengingat undefined juga, bukan mencobanya terus", () => {
  let n = 0;
  const t = memoThunk(() => {
    n += 1;
    return undefined;
  });
  t();
  t();
  assert.equal(n, 1, "hasil kosong tetap hasil; pekerjaan mahalnya jangan diulang");
});

test("lazyFacade: pembungkusnya FUNGSI, dan modulnya belum dimuat sebelum dipanggil", () => {
  // Pembungkus harus bertipe function supaya pemeriksaan kesiapan yang sudah ada
  // (configured() di controller/login.js menuntut setiap dep bertipe fungsi)
  // tetap lolos tanpa tahu soal penundaan ini.
  let loads = 0;
  const f = lazyFacade({
    load: () => {
      loads += 1;
      return { m: { hello: (a, b) => a + b } };
    },
    specs: { hello: ["m", "hello"] },
  });

  assert.equal(typeof f.hello, "function");
  assert.equal(loads, 0, "membuat façade TIDAK boleh memuat apa pun");

  assert.equal(f.hello(2, 3), 5, "argumen diteruskan apa adanya");
  assert.equal(loads, 1);
  f.hello(1, 1);
  assert.equal(loads, 1, "dimuat sekali, lalu dipakai ulang");
});

// --- kontrak playableScenes --------------------------------------------------

test("controller menerima playableScenes sebagai THUNK dan tidak membacanya saat dibangun", () => {
  const { createController } = require("../controller/controller");

  let reads = 0;
  const ctl = createController({
    cwd: ROOT,
    playableScenes: () => {
      reads += 1;
      return ["Scene A"];
    },
  });

  // Inilah intinya: membangun Controller TIDAK boleh menyentuh daftar scene,
  // karena membacanya berarti memuat index.js beserta obs-websocket-js dan
  // tiktok-live-connector sebelum port terikat.
  assert.equal(reads, 0, "daftar scene TIDAK boleh dibaca saat boot");
  assert.equal(typeof ctl.validateMappings, "function");
});

test("playableScenes berupa ARRAY tetap bekerja persis seperti sebelum P4.2", async () => {
  // Kompatibilitas ke belakang bukan kebetulan: puluhan tes meng-inject array.
  const { createController } = require("../controller/controller");
  const ctl = createController({ cwd: ROOT, playableScenes: ["Scene A"] });
  assert.equal(typeof ctl.validateMappings, "function");
});

test("controller/index.js mengoper FUNGSI-nya, bukan hasil pemanggilannya", () => {
  const src = fs.readFileSync(path.join(ROOT, "controller", "index.js"), "utf8");
  // `readPlayableScenes,` (tanpa tanda kurung) = ditunda.
  assert.match(src, /playableScenes:[^\n]*readPlayableScenes\b/);
  assert.ok(
    !/playableScenes: readPlayableScenes\(\),/.test(src),
    "memanggilnya di sini mengembalikan 117 modul ke jalur boot"
  );
  // Dan satu pengecualian yang DISENGAJA: kalau AILIVE_RUNTIME_CONFIG ada, daftarnya
  // dibaca di muka, karena index.js akan process.exit(1) saat dimuat dan
  // process.exit tidak bisa ditangkap try/catch — menundanya berarti memindahkan
  // kematian itu dari boot ke tengah permintaan customer.
  assert.match(src, /RUNTIME_CONFIG_ENV\]\s*\?\s*readPlayableScenes\(\)/);
});

test("buildBrowserDeps memeriksa instalasi tanpa MENJALANKAN modulnya", () => {
  const src = fs.readFileSync(path.join(ROOT, "controller", "index.js"), "utf8");
  // require.resolve() hanya memetakan nama ke path; ia tidak mengeksekusi modul,
  // jadi Puppeteer tidak ikut termuat karena pemeriksaan ini.
  assert.match(src, /require\.resolve\(spec\)/);
  // Instalasi rusak tetap terdeteksi saat boot, persis seperti sebelumnya.
  assert.match(src, /return null;/);
});

// --- bukti sungguhan: proses terpisah ----------------------------------------


// Port diminta dari OS lalu dilepas. listen() ASINKRON, jadi address() harus
// dibaca di dalam callback-nya — membacanya tepat sesudah listen() mengembalikan
// null, dan nilai null itu menjalar sampai Controller jatuh ke port bawaan.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

// Dijalankan di proses sendiri, dengan main() yang SUNGGUHAN — bukan tiruannya.
// Meniru urutan boot di sini berarti menulis salinan kedua dari boot, dan salinan
// itulah yang akan menyimpang.
//
// Port DITANAM ke dalam skripnya. Dengan `node -e`, argumen pertama ada di
// argv[1] dan BUKAN argv[2]; salah indeks di situ membuat port menjadi NaN,
// Controller jatuh ke port bawaan 4782, dan tesnya menggantung alih-alih gagal.
function runBootChild(body, port) {
  const script = [
    'const PORT = ' + port + ';',
    'const INDEX = ' + JSON.stringify(path.join(ROOT, "controller", "index.js")) + ';',
    'const before = Object.keys(require.cache).length;',
    '(async () => {',
    body,
    '  process.exit(0);',
    // Kegagalan harus TERLIHAT, bukan menggantung sampai batas waktu.
    '})().catch((e) => { console.log("CHILD_ERROR " + (e && e.message)); process.exit(3); });',
  ].join("\n");

  return String(
    execFileSync(process.execPath, ["-e", script], { cwd: ROOT, encoding: "utf8", timeout: 60000 })
  );
}

test("[proses terpisah] Puppeteer dan tiktok-live-connector TIDAK termuat sampai port terikat", async () => {
  const out = runBootChild(
    [
      '  const { main } = require(INDEX);',
      '  const { server } = await main(["--port=" + PORT]);',
      '  const loaded = (n) => Object.keys(require.cache).some((k) => k.includes(n));',
      '  const r = await fetch("http://127.0.0.1:" + PORT + "/api/status");',
      '  const st = await r.json();',
      '  console.log("RESULT" + JSON.stringify({',
      '    modules: Object.keys(require.cache).length,',
      '    http: r.status,',
      '    automation: st.automation,',
      '    puppeteer: loaded("puppeteer"),',
      '    tiktok: loaded("tiktok-live-connector"),',
      '    obsws: loaded("obs-websocket-js"),',
      '  }));',
      '  await server.stop();',
    ].join("\n"),
    await freePort()
  );

  const m = /RESULT(\{.*\})/.exec(out);
  assert.ok(m, "proses anak tidak melaporkan hasil. Keluaran:\n" + out);
  const r = JSON.parse(m[1]);

  // Port memang terikat dan melayani. Tanpa ini, "nol modul berat" bisa berarti
  // boot-nya gagal lebih dulu — dan tesnya akan hijau untuk alasan yang salah.
  assert.equal(r.http, 200);
  assert.equal(r.automation, "STOPPED");

  assert.equal(r.puppeteer, false, "Puppeteer tidak boleh termuat untuk menyajikan dashboard");
  assert.equal(r.tiktok, false, "tiktok-live-connector tidak boleh termuat saat boot");
  assert.equal(r.obsws, false, "obs-websocket-js tidak boleh termuat saat boot");

  // Batas longgar tapi bermakna: sebelum P4.2 angkanya 504. Ini bukan patokan
  // kinerja — ini pagar supaya muatan berat tidak kembali diam-diam.
  assert.ok(
    r.modules < 300,
    "boot memuat " + r.modules + " modul; sebelum P4.2 angkanya 504, dan itu yang membuat cold start lewat 20 detik"
  );
});

test("[proses terpisah] tahap boot dicetak berurutan, dengan ms yang tidak menurun", async () => {
  const out = runBootChild(
    [
      '  const { main } = require(INDEX);',
      '  const { server } = await main(["--port=" + PORT]);',
      '  await server.stop();',
    ].join("\n"),
    await freePort()
  );

  const stages = [...out.matchAll(/\[CONTROLLER_BOOT\] stage=([a-z-]+) ms=(\d+)/g)].map((m) => ({
    name: m[1],
    ms: Number(m[2]),
  }));

  assert.deepEqual(
    stages.map((s) => s.name),
    ["modules-loaded", "deps-resolved", "controller-created", "server-created", "listen-begin"],
    "keluaran anak:\n" + out
  );
  for (let i = 1; i < stages.length; i++) {
    assert.ok(stages[i].ms >= stages[i - 1].ms, "ms harus monoton: " + JSON.stringify(stages));
  }

  // Tonggak terakhir membawa ms-nya juga, supaya "sampai melayani" terukur.
  assert.match(out, /\[CONTROLLER_LISTENING\][^\n]*\bms=\d+/);

  // Tidak ada rahasia maupun path di baris tonggak.
  for (const line of out.split("\n").filter((l) => l.includes("[CONTROLLER_BOOT]"))) {
    assert.ok(!/[A-Za-z]:[\/]/.test(line), "tonggak tidak boleh memuat path: " + line);
    assert.ok(!/password/i.test(line), line);
  }
});
