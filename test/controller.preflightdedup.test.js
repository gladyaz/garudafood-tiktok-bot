// P0-3: preflight dijalankan SEKALI per START, bukan dua kali.
//
// Sebelumnya UI memanggil POST /api/preflight tepat sebelum POST /api/start, dan
// startAutomation() menjalankan preflight.run() SENDIRI lagi di dalamnya. Seluruh
// delapan check dikerjakan dua kali - termasuk probeTikTok, yang membuka Chrome
// dan membaca dashboard produk. Terukur ~10,9 detik pada satu aturan dengan
// profil hangat, dan 25,2 detik pada lima aturan.
//
// Yang dibuang HANYA pemeriksaan penasihat milik UI. Gerbang yang sesungguhnya
// tetap preflight server yang segar di dalam startAutomation, dan berkas ini
// menjaga perbedaan itu: kalau suatu saat seseorang "mengoptimalkan" dengan
// memakai ULANG hasil preflight lama, tes di bawah merah.
//
// Dibuktikan lewat server HTTP sungguhan dengan harness yang sama dipakai
// controller.api.test.js - bukan tiruan yang bentuknya dikarang.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { createServer } = require("../controller/server");
const { createHarness } = require("./helpers/controller-harness");
const U = require("../controller/public/ui-logic.js");
const I = require("../controller/public/i18n.js");

const CHECKS = ["config", "processes", "ports", "obs", "scenes", "profile", "tiktok", "mappings"];

async function withServer(overrides, fn) {
  const h = createHarness(overrides);
  const server = createServer({ controller: h.controller });
  const addr = await server.start({ port: 0 });
  const base = "http://127.0.0.1:" + addr.port;
  try {
    await fn({ base, h });
  } finally {
    await h.controller.stopAutomation().catch(() => {});
    await server.stop();
  }
}

async function send(base, p, method) {
  const res = await fetch(base + p, { method });
  return { status: res.status, body: await res.json() };
}

// Pencacah probeTikTok. Inilah check yang MAHAL - satu-satunya yang membuka
// browser - jadi jumlah panggilannya adalah ukuran langsung dari duplikasi.
function countingProbe(result) {
  const calls = { n: 0 };
  return {
    calls,
    deps: {
      probeTikTok: async () => {
        calls.n += 1;
        return result;
      },
    },
  };
}

// Bentuk ini DISALIN dari default harness (test/helpers/controller-harness.js),
// bukan dikarang. Versi pertama saya mengembalikan `products: []` - katalog
// KOSONG - yang membuat check mappings gagal dengan product-not-found, dan
// start-nya 409 karena alasan yang sah. Jumlah panggilannya sudah benar sejak
// awal; fixture sayalah yang salah.
const GOOD_TIKTOK = { ok: true, skipped: true, reason: "not-implemented-p1" };

/* === satu START = satu preflight ========================================= */

test("START menjalankan probeTikTok SEKALI, bukan dua kali", async () => {
  const probe = countingProbe(GOOD_TIKTOK);
  await withServer({ preflightDeps: probe.deps }, async ({ base }) => {
    const { status } = await send(base, "/api/start", "POST");
    assert.equal(status, 200);
    assert.equal(probe.calls.n, 1, "check mahal dikerjakan " + probe.calls.n + "x per START");
  });
});

// Jumlahnya dibandingkan dengan jalur LAMA secara eksplisit, supaya angka 1 di
// atas tidak bisa dibaca sebagai kebetulan.
test("jalur lama (preflight penasihat + start) memang dua kali", async () => {
  const probe = countingProbe(GOOD_TIKTOK);
  await withServer({ preflightDeps: probe.deps }, async ({ base }) => {
    await send(base, "/api/preflight", "POST");
    await send(base, "/api/start", "POST");
    assert.equal(probe.calls.n, 2, "ini bentuk yang DIHINDARI sejak P0-3");
  });
});

/* === gerbangnya TIDAK melemah ============================================ */

// Paku paling penting di berkas ini. Kalau seseorang nanti membuat
// startAutomation memakai ULANG hasil preflight sebelumnya, tes ini merah.
test("startAutomation menjalankan preflight SEGAR setiap kali, tanpa cache", async () => {
  const probe = countingProbe(GOOD_TIKTOK);
  await withServer({ preflightDeps: probe.deps }, async ({ base, h }) => {
    await send(base, "/api/start", "POST");
    assert.equal(probe.calls.n, 1);
    await send(base, "/api/stop", "POST");
    await send(base, "/api/start", "POST");
    assert.equal(probe.calls.n, 2, "start kedua memakai ulang hasil lama");
    assert.equal(h.controller.state(), "RUNNING");
  });
});

test("preflight MERAH tetap menolak start dan tidak menyalakan apa pun", async () => {
  await withServer(
    { preflightDeps: { probeObs: async () => ({ ok: false, reason: "obs-unavailable" }) } },
    async ({ base, h }) => {
      const { status, body } = await send(base, "/api/start", "POST");
      assert.equal(status, 409, "penolakan harus 409, bukan 200");
      assert.equal(body.ok, false);
      assert.equal(h.world.spawned.length, 0, "ada proses yang dinyalakan padahal preflight merah");
      assert.equal(h.controller.state(), "STOPPED");
    }
  );
});

// Penolakan sinkron terjadi SEBELUM await pertama, jadi ia tidak boleh ikut
// berubah gara-gara preflight dipindah.
test("start kedua yang bersamaan tetap ditolak tanpa menambah proses", async () => {
  const probe = countingProbe(GOOD_TIKTOK);
  await withServer({ preflightDeps: probe.deps }, async ({ base, h }) => {
    await send(base, "/api/start", "POST");
    const spawnedAfterFirst = h.world.spawned.length;
    const second = await send(base, "/api/start", "POST");
    assert.equal(second.status, 409);
    assert.equal(h.world.spawned.length, spawnedAfterFirst, "start kedua menambah proses");
  });
});

/* === /api/start membawa baris kesiapan =================================== */

// UI tidak lagi punya sumber lain untuk panel ini, jadi kedua jalur harus
// membawanya. Tanpa jalur SUKSES, panel kosong setiap kali start berhasil.
test("/api/start menyertakan preflight di jalur SUKSES", async () => {
  await withServer({}, async ({ base }) => {
    const { status, body } = await send(base, "/api/start", "POST");
    assert.equal(status, 200);
    assert.ok(body.preflight, "jalur sukses tidak membawa preflight");
    assert.equal(body.preflight.ok, true);
    for (const name of CHECKS) {
      assert.ok(body.preflight.checks[name], "check " + name + " hilang");
    }
  });
});

test("/api/start menyertakan preflight di jalur GAGAL", async () => {
  await withServer(
    { preflightDeps: { probeObs: async () => ({ ok: false, reason: "obs-unavailable" }) } },
    async ({ base }) => {
      const { body } = await send(base, "/api/start", "POST");
      assert.ok(body.preflight, "jalur gagal tidak membawa preflight");
      assert.equal(body.preflight.ok, false);
      assert.equal(body.preflight.checks.obs.ok, false);
      assert.equal(body.preflight.checks.obs.reason, "obs-unavailable");
      assert.equal(body.preflight.checks.config.ok, true, "yang hijau tetap hijau");
    }
  );
});

// Bentuknya harus SAMA dengan /api/preflight, karena satu fungsi yang
// memutuskannya. Dua bentuk berbeda untuk data yang sama akan menyimpang.
test("bentuk preflight di /api/start sama dengan di /api/preflight", async () => {
  await withServer(
    { preflightDeps: { probeObs: async () => ({ ok: false, reason: "obs-unavailable" }) } },
    async ({ base }) => {
      const viaPreflight = (await send(base, "/api/preflight", "POST")).body;
      const viaStart = (await send(base, "/api/start", "POST")).body.preflight;
      assert.deepEqual(Object.keys(viaStart.checks).sort(), Object.keys(viaPreflight.checks).sort());
      assert.equal(viaStart.ok, viaPreflight.ok);
      // Pengayaan userMessage ikut di kedua endpoint.
      assert.equal(typeof viaStart.checks.obs.userMessage, "string");
      assert.equal(viaStart.checks.obs.userMessage, viaPreflight.checks.obs.userMessage);
    }
  );
});

/* === baris render identik ================================================ */

// Yang dilihat customer tidak boleh berubah sedikit pun. Dibandingkan di KETIGA
// bahasa, dari dua sumber yang sekarang berbeda.
test("preflightRows dari /api/start identik dengan dari /api/preflight", async () => {
  await withServer(
    { preflightDeps: { probeObs: async () => ({ ok: false, reason: "obs-unavailable" }) } },
    async ({ base }) => {
      const viaPreflight = (await send(base, "/api/preflight", "POST")).body;
      const viaStart = (await send(base, "/api/start", "POST")).body.preflight;

      for (const lang of I.LANGS) {
        assert.deepEqual(
          U.preflightRows(viaStart, lang),
          U.preflightRows(viaPreflight, lang),
          "baris berbeda di " + lang
        );
      }
    }
  );
});

test("panel kesiapan terisi sesudah start yang BERHASIL", async () => {
  await withServer({}, async ({ base }) => {
    const body = (await send(base, "/api/start", "POST")).body;
    const rows = U.preflightRows(body.preflight, "id");
    assert.equal(rows.length, CHECKS.length, "panel kosong sesudah start berhasil");
    assert.ok(
      rows.every((r) => r.tone === "ready" || r.tone === "neutral"),
      "ada baris merah padahal start berhasil"
    );
  });
});

/* === penjaga sumber: panggilan ganda tidak boleh kembali ================= */

const APP = fs.readFileSync(path.join(__dirname, "..", "controller", "public", "app.js"), "utf8");

// Satu baris `api("/api/preflight", ...)` yang kembali ke onStart akan
// memulihkan duplikasinya tanpa satu pun tes perilaku di atas berubah merah -
// karena jalur servernya memang masih benar. Hanya penjaga sumber yang menangkap.
test("onStart TIDAK memanggil /api/preflight lagi", () => {
  assert.equal(
    /api\(\s*["']\/api\/preflight["']/.test(APP),
    false,
    "preflight penasihat kembali ke UI - duplikasinya pulih"
  );
});

// Tahap START diturunkan dari keadaan server, termasuk fase preflight yang
// sekarang berada DI DALAM /api/start.
test("tahap preflight diturunkan dari automation === PREFLIGHT", () => {
  const body = APP.slice(APP.indexOf("function startWithProgress"), APP.indexOf("function onStop"));
  assert.ok(body.indexOf('"PREFLIGHT"') !== -1, "tahap preflight tidak dibaca dari keadaan server");
  assert.ok(body.indexOf('setStage("preflight")') !== -1);
  assert.ok(body.indexOf('setStage("preparing")') !== -1);
  assert.ok(body.indexOf('setStage("connecting")') !== -1);
});

// Tahapnya tetap utuh dan tetap berkalimat di ketiga bahasa. Jumlahnya turun
// jadi tujuh di P0-1 karena `products` memang bukan pekerjaan terpisah lagi -
// bukan karena ada kalimat kemajuan yang hilang begitu saja.
test("tahap START masih lengkap di ketiga bahasa", () => {
  assert.equal(U.START_STAGES.length, 7);
  for (const lang of I.LANGS) {
    for (const s of U.START_STAGES) {
      assert.ok(U.startStageText(s, lang).length > 0, lang + "/" + s);
    }
  }
});
