// API Controller lokal: /api/status, /api/config, /api/preflight, /api/start,
// /api/stop, /api/activity.
//
// Server HTTP di sini SUNGGUHAN (express mendengarkan di 127.0.0.1 pada port
// sementara), tapi segala sesuatu di belakangnya palsu: child process palsu,
// fs palsu, preflight yang di-inject. Tidak ada TikTok, OBS, browser, atau proses
// nyata yang disentuh.
//
// Dua hal yang diuji paling keras:
//
//   1. Pengikatan HANYA ke loopback. Endpoint yang bisa menyalakan bot yang
//      mengklik akun TikTok sungguhan tidak boleh bisa dipanggil dari perangkat
//      lain di jaringan yang sama.
//   2. TIDAK ADA rahasia di balasan. Password OBS, cookie, token, data sesi
//      browser, dan environment mentah tidak boleh pernah keluar — balasan ini
//      akan dibaca UI yang bisa tampil di layar yang sedang di-share saat LIVE.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");

const { createServer, isLoopback, DEFAULT_PORT } = require("../controller/server");
const { createHarness, goodConfig } = require("./helpers/controller-harness");
const { redactConfig } = require("../controller/config-manager");

// Server dinyalakan di port 0 (dipilih OS) supaya tes tidak pernah bentrok dengan
// Controller sungguhan atau dengan tes lain yang berjalan bersamaan.
async function withServer(overrides, fn) {
  const h = createHarness(overrides);
  const server = createServer({ controller: h.controller });
  const addr = await server.start({ port: 0 });
  const base = "http://127.0.0.1:" + addr.port;
  try {
    await fn({ base, h, addr, server });
  } finally {
    // Child palsu dibereskan supaya tes berikutnya mulai dari nol.
    await h.controller.stopAutomation().catch(() => {});
    await server.stop();
  }
}

async function get(base, path) {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json() };
}

async function send(base, path, method, body) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// --- pengikatan --------------------------------------------------------------

test("server mengikat 127.0.0.1, bukan 0.0.0.0", async () => {
  await withServer({}, async ({ addr }) => {
    assert.equal(addr.host, "127.0.0.1");
  });
});

test("port default 4782: bukan 5055 (AutoPIN) dan bukan 4455 (OBS)", () => {
  assert.equal(DEFAULT_PORT, 4782);
  assert.notEqual(DEFAULT_PORT, 5055);
  assert.notEqual(DEFAULT_PORT, 4455);
});

test("TIDAK bisa dihubungi dari alamat LAN mesin ini", async () => {
  await withServer({}, async ({ addr }) => {
    // Alamat non-loopback milik mesin ini sendiri. Kalau server mengikat
    // 0.0.0.0, permintaan ini akan BERHASIL — dan itulah yang tidak boleh.
    const lan = Object.values(os.networkInterfaces())
      .flat()
      .filter((i) => i && i.family === "IPv4" && !i.internal)
      .map((i) => i.address);

    if (lan.length === 0) return; // mesin tanpa antarmuka jaringan: tidak ada yang bisa diuji

    for (const ip of lan) {
      await assert.rejects(
        fetch("http://" + ip + ":" + addr.port + "/api/status", { signal: AbortSignal.timeout(2000) }),
        "harus ditolak dari " + ip
      );
    }
  });
});

test("isLoopback mengenali bentuk loopback, dan menolak yang lain", () => {
  for (const a of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "127.0.0.53", "::ffff:127.1.2.3"]) {
    assert.equal(isLoopback({ socket: { remoteAddress: a } }), true, a);
  }
  for (const a of ["192.168.1.10", "10.0.0.5", "::ffff:192.168.1.10", "", undefined, null]) {
    assert.equal(isLoopback({ socket: { remoteAddress: a } }), false, String(a));
  }
});

// --- status ------------------------------------------------------------------

test("GET /api/status saat STOPPED", async () => {
  await withServer({}, async ({ base }) => {
    const { status, body } = await get(base, "/api/status");
    assert.equal(status, 200);
    assert.equal(body.controller, "RUNNING");
    assert.equal(body.automation, "STOPPED");
    assert.deepEqual(body.service, { running: false, pid: null });
    assert.deepEqual(body.bot, { running: false, pid: null });
  });
});

test("GET /api/status saat RUNNING menampilkan PID kedua anak", async () => {
  await withServer({}, async ({ base, h }) => {
    await h.controller.startAutomation();
    const { body } = await get(base, "/api/status");

    assert.equal(body.automation, "RUNNING");
    assert.equal(body.service.running, true);
    assert.equal(body.bot.running, true);
    assert.equal(typeof body.service.pid, "number");
    assert.equal(typeof body.bot.pid, "number");
    // PID yang dilaporkan harus PID yang sungguhan dipakai, bukan angka hiasan.
    assert.equal(body.service.pid, h.world.liveByScript("autopin-service.js")[0].pid);
    assert.equal(body.bot.pid, h.world.liveByScript("index.js")[0].pid);
  });
});

test("/api/status TIDAK PERNAH memuat password OBS atau rahasia lain", async () => {
  await withServer({}, async ({ base, h }) => {
    await h.controller.startAutomation();
    const { body } = await get(base, "/api/status");
    const text = JSON.stringify(body);

    assert.ok(!text.includes("rahasia-obs"), "password OBS tidak boleh keluar");
    assert.ok(!/password/i.test(text), "kata password pun tidak perlu ada");
    // Environment mentah, cookie, token, dan data sesi browser juga tidak.
    assert.ok(!text.includes("PATH"));
    assert.ok(!/cookie|token|session[iI]d|authorization/i.test(text));
    assert.ok(!text.includes(".autopin-profile"), "path profil browser tidak perlu diekspos");
  });
});

test("/api/status melaporkan field yang BELUM sampai ke core", async () => {
  await withServer({}, async ({ base }) => {
    const { body } = await get(base, "/api/status");
    // Keterbatasan dibuat terlihat, bukan disembunyikan.
    const fields = body.config.notAppliedToCore.map((f) => f.field);
    assert.deepEqual(fields, ["mappings[].triggers", "mappings[].reply"]);
  });
});

test("/api/status melaporkan ringkasan config tanpa isinya", async () => {
  await withServer({}, async ({ base }) => {
    const { body } = await get(base, "/api/status");
    assert.equal(body.config.present, true);
    assert.equal(body.config.version, 1);
    assert.equal(body.config.mappings, 2);
    assert.equal(body.config.tiktokUsername, "agen_mulia_abadi");
    // Judul produk tidak perlu ada di status: itu isi config, bukan status.
    assert.ok(!JSON.stringify(body).includes("Garuda Ting Ting"));
  });
});

test("/api/status saat config belum ada: jujur, bukan meledak", async () => {
  await withServer({ configText: null }, async ({ base }) => {
    const { status, body } = await get(base, "/api/status");
    assert.equal(status, 200);
    assert.equal(body.config.present, false);
    assert.equal(body.config.problem, "config-missing");
  });
});

test("/api/status melaporkan batas activity buffer", async () => {
  await withServer({}, async ({ base }) => {
    const { body } = await get(base, "/api/status");
    assert.equal(body.activity.max, 500);
    assert.equal(typeof body.activity.count, "number");
    assert.equal(typeof body.activity.dropped, "number");
  });
});

// --- config ------------------------------------------------------------------

test("GET /api/config menyembunyikan password dan menyebut passwordSet", async () => {
  await withServer({}, async ({ base }) => {
    const { status, body } = await get(base, "/api/config");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal("password" in body.config.obs, false);
    assert.equal(body.config.obs.passwordSet, true);
    assert.ok(!JSON.stringify(body).includes("rahasia-obs"));
  });
});

test("GET /api/config saat belum ada: mengirim default, bukan layar kosong", async () => {
  await withServer({ configText: null }, async ({ base }) => {
    const { status, body } = await get(base, "/api/config");
    assert.equal(status, 200);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "config-missing");
    assert.equal(body.error.userMessage, "No configuration has been saved yet.");
    // UI butuh titik awal yang aman.
    assert.equal(body.defaults.version, 1);
    assert.equal(body.defaults.settings.autopinEnabled, false);
  });
});

test("PUT /api/config menyimpan, dan GET mengembalikannya", async () => {
  await withServer({}, async ({ base }) => {
    const next = goodConfig();
    next.tiktok.username = "akun_baru";
    next.mappings = [{ scene: "PAX-3", product: { title: "Chocolatos Pillow" } }];

    const put = await send(base, "/api/config", "PUT", next);
    assert.equal(put.status, 200);
    assert.equal(put.body.ok, true);

    const { body } = await get(base, "/api/config");
    assert.equal(body.config.tiktok.username, "akun_baru");
    assert.equal(body.config.mappings[0].scene, "PAX-3");
  });
});

test("PUT /api/config: config TIDAK VALID ditolak dan tidak menimpa yang valid", async () => {
  await withServer({}, async ({ base, h }) => {
    const before = h.fs.files.get(h.CONFIG_PATH);

    const bad = goodConfig();
    bad.mappings = [{ scene: "PAX-1", product: { title: "" } }];
    const put = await send(base, "/api/config", "PUT", bad);

    assert.equal(put.status, 400);
    assert.equal(put.body.ok, false);
    assert.equal(put.body.error.code, "config-invalid");
    // Kalimat per field, dengan path-nya, supaya UI bisa menyorot yang salah.
    assert.ok(put.body.errors.length > 0);
    assert.equal(put.body.errors[0].path, "mappings[0].product.title");
    assert.equal(put.body.errors[0].userMessage, "mappings[0].product.title needs to be filled in");

    // Yang tersimpan tidak berubah SAMA SEKALI.
    assert.equal(h.fs.files.get(h.CONFIG_PATH), before);
  });
});

test("PUT /api/config: password yang tidak dikirim tidak terhapus", async () => {
  await withServer({}, async ({ base, h }) => {
    // Inilah bentuk nyata alur UI: GET lalu PUT kembali apa yang diterima.
    const { body } = await get(base, "/api/config");
    const edited = body.config;
    edited.tiktok.username = "diubah";

    const put = await send(base, "/api/config", "PUT", edited);
    assert.equal(put.status, 200);

    // Password OBS harus masih ada di berkas, walau tidak pernah dikirim bolak-balik.
    const saved = JSON.parse(h.fs.files.get(h.CONFIG_PATH));
    assert.equal(saved.obs.password, "rahasia-obs");
    assert.equal(saved.tiktok.username, "diubah");
  });
});

test("PUT /api/config: JSON rusak dibalas sebagai kesalahan config, bukan stack trace", async () => {
  await withServer({}, async ({ base }) => {
    const res = await fetch(base + "/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{ ini bukan json",
    });
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(body.error.code, "config-invalid-json");
    assert.ok(!/\bat \w+ \(/.test(JSON.stringify(body)), "tidak boleh ada jejak stack");
  });
});

test("PUT /api/config: body yang bukan objek ditolak", async () => {
  await withServer({}, async ({ base }) => {
    for (const body of [[], "teks", 42, null]) {
      const r = await send(base, "/api/config", "PUT", body);
      assert.equal(r.status, 400, JSON.stringify(body));
    }
  });
});

test("PUT /api/config: versi yang tidak didukung ditolak", async () => {
  await withServer({}, async ({ base }) => {
    const future = goodConfig();
    future.version = 2;
    const r = await send(base, "/api/config", "PUT", future);
    assert.equal(r.status, 400);
    assert.equal(r.body.errors[0].code, "version-unsupported");
  });
});

// --- preflight ---------------------------------------------------------------

test("POST /api/preflight hijau mengembalikan semua check", async () => {
  await withServer({}, async ({ base }) => {
    const { status, body } = await send(base, "/api/preflight", "POST");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    for (const name of ["config", "processes", "ports", "obs", "scenes", "profile", "tiktok"]) {
      assert.equal(body.checks[name].ok, true, name);
    }
  });
});

test("POST /api/preflight merah: menyebut check yang gagal dan alasannya", async () => {
  await withServer(
    { preflightDeps: { probeObs: async () => ({ ok: false, reason: "obs-unavailable" }) } },
    async ({ base }) => {
      const { body } = await send(base, "/api/preflight", "POST");
      assert.equal(body.ok, false);
      assert.equal(body.checks.obs.ok, false);
      assert.equal(body.checks.obs.reason, "obs-unavailable");
      assert.equal(body.checks.config.ok, true, "yang hijau tetap dilaporkan hijau");
    }
  );
});

test("POST /api/preflight TIDAK menyalakan apa pun", async () => {
  await withServer({}, async ({ base, h }) => {
    await send(base, "/api/preflight", "POST");
    assert.equal(h.world.spawned.length, 0);
    assert.equal(h.controller.state(), "STOPPED");
  });
});

// --- start / stop ------------------------------------------------------------

test("DoD P1: POST /api/start -> GET /api/status RUNNING -> POST /api/stop -> STOPPED tanpa yatim", async () => {
  await withServer({}, async ({ base, h }) => {
    // 1. start
    const start = await send(base, "/api/start", "POST");
    assert.equal(start.status, 200);
    assert.equal(start.body.ok, true);
    assert.equal(start.body.state, "RUNNING");

    // 2. status menampilkan RUNNING + PID kedua anak
    const status = await get(base, "/api/status");
    assert.equal(status.body.automation, "RUNNING");
    assert.equal(status.body.service.running, true);
    assert.equal(status.body.bot.running, true);
    assert.equal(h.world.countByScript("autopin-service.js"), 1, "tepat satu service");
    assert.equal(h.world.countByScript("index.js"), 1, "tepat satu bot");

    // 3. stop
    const stop = await send(base, "/api/stop", "POST");
    assert.equal(stop.status, 200);
    assert.equal(stop.body.ok, true);
    assert.equal(stop.body.state, "STOPPED");

    const after = await get(base, "/api/status");
    assert.equal(after.body.automation, "STOPPED");
    assert.equal(after.body.service.running, false);
    assert.equal(after.body.bot.running, false);
    // Angka yang tidak bisa dibohongi oleh state Controller sendiri.
    assert.equal(h.world.liveCount(), 0, "zero orphan child process");
  });
});

test("POST /api/start dua kali: yang kedua 409 dan tidak menambah proses", async () => {
  await withServer({}, async ({ base, h }) => {
    await send(base, "/api/start", "POST");
    const second = await send(base, "/api/start", "POST");

    assert.equal(second.status, 409);
    assert.equal(second.body.ok, false);
    assert.equal(second.body.error.code, "start-rejected-busy");
    assert.equal(second.body.error.userMessage, "The automation is already starting or running.");
    assert.equal(h.world.countByScript("index.js"), 1);
  });
});

test("POST /api/start yang gagal preflight: 409, kalimat untuk manusia, nol spawn", async () => {
  await withServer(
    { preflightDeps: { probeObs: async () => ({ ok: false, reason: "obs-unavailable" }) } },
    async ({ base, h }) => {
      const r = await send(base, "/api/start", "POST");
      assert.equal(r.status, 409);
      assert.equal(r.body.error.code, "obs-unavailable");
      assert.equal(r.body.error.userMessage, "OBS is not connected.");
      // Hasil preflight ikut, supaya UI tidak perlu memanggil /api/preflight lagi.
      assert.equal(r.body.preflight.checks.obs.ok, false);
      assert.equal(h.world.spawned.length, 0);
    }
  );
});

test("POST /api/stop dua kali: keduanya 200", async () => {
  await withServer({}, async ({ base }) => {
    await send(base, "/api/start", "POST");
    const first = await send(base, "/api/stop", "POST");
    const second = await send(base, "/api/stop", "POST");

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(second.body.code, "already-stopped");
  });
});

test("POST /api/stop tanpa start: aman", async () => {
  await withServer({}, async ({ base, h }) => {
    const r = await send(base, "/api/stop", "POST");
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(h.world.spawned.length, 0);
  });
});

test("balasan start yang gagal tidak membocorkan rahasia", async () => {
  await withServer(
    { preflightDeps: { probeObs: async () => ({ ok: false, reason: "obs-auth-failed" }) } },
    async ({ base }) => {
      const r = await send(base, "/api/start", "POST");
      assert.ok(!JSON.stringify(r.body).includes("rahasia-obs"));
    }
  );
});

// --- activity ----------------------------------------------------------------

test("GET /api/activity mengembalikan kejadian dari stdout anak", async () => {
  await withServer({}, async ({ base, h }) => {
    await send(base, "/api/start", "POST");
    h.world.liveByScript("index.js")[0].say("[PLAY] scene=PAX-2 count=1 requesters=1");
    await new Promise((r) => setImmediate(r));

    const { status, body } = await get(base, "/api/activity");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(body.events.some((e) => e.type === "PLAY" && e.scene === "PAX-2"));
    assert.equal(body.max, 500);
  });
});

test("GET /api/activity?limit= dan ?sinceId= dihormati", async () => {
  await withServer({}, async ({ base, h }) => {
    for (let i = 0; i < 10; i += 1) h.controller.activity.push({ type: "PLAY", scene: "PAX-" + i });

    const limited = await get(base, "/api/activity?limit=3");
    assert.equal(limited.body.events.length, 3);
    assert.equal(limited.body.events[2].scene, "PAX-9", "yang terbaru yang dikirim");

    const lastId = limited.body.lastId;
    const after = await get(base, "/api/activity?sinceId=" + lastId);
    assert.deepEqual(after.body.events, [], "tidak ada yang lebih baru");
  });
});

test("GET /api/activity: buffer TERBATAS dan melaporkan yang dibuang", async () => {
  await withServer({ activityMax: 5 }, async ({ base, h }) => {
    for (let i = 0; i < 40; i += 1) h.controller.activity.push({ type: "PLAY", scene: "s" + i });

    const { body } = await get(base, "/api/activity");
    assert.equal(body.events.length, 5, "tidak boleh tumbuh tanpa batas");
    assert.equal(body.max, 5);
    assert.equal(body.dropped, 35, "yang dibuang dilaporkan, bukan disembunyikan");
  });
});

test("/api/activity tidak pernah memuat nama penonton", async () => {
  await withServer({}, async ({ base, h }) => {
    await send(base, "/api/start", "POST");
    h.world.liveByScript("index.js")[0].say('[TIKTOK_CHAT] user=@penonton_asli text="spill etalase 1"');
    await new Promise((r) => setImmediate(r));

    const { body } = await get(base, "/api/activity");
    assert.ok(!JSON.stringify(body).includes("penonton_asli"));
  });
});

test("parameter query yang ngawur diabaikan, tidak meledak", async () => {
  await withServer({}, async ({ base }) => {
    for (const q of ["?limit=abc", "?limit=-5", "?sinceId=xyz", "?limit=&sinceId="]) {
      const r = await get(base, "/api/activity" + q);
      assert.equal(r.status, 200, q);
      assert.equal(r.body.ok, true);
    }
  });
});

// --- lain-lain ---------------------------------------------------------------

test("endpoint tidak dikenal dibalas JSON 404, bukan HTML express", async () => {
  await withServer({}, async ({ base }) => {
    const res = await fetch(base + "/api/ngawur");
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("content-type").includes("application/json"), true);
    const body = await res.json();
    assert.equal(body.error.code, "not-found");
  });
});

test("server tanpa controller ditolak keras", () => {
  assert.throws(() => createServer({}), /wajib diisi/);
});

test("body raksasa ditolak", async () => {
  await withServer({}, async ({ base }) => {
    const huge = goodConfig();
    huge.settings.expectedShop = "x".repeat(400000);
    const res = await fetch(base + "/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(huge),
    });
    assert.ok(res.status >= 400, "status=" + res.status);
  });
});

test("redactConfig dipakai konsisten antara GET dan PUT", async () => {
  await withServer({}, async ({ base }) => {
    const put = await send(base, "/api/config", "PUT", goodConfig());
    const got = await get(base, "/api/config");
    assert.deepEqual(put.body.config, got.body.config);
    assert.deepEqual(put.body.config, redactConfig(goodConfig()));
  });
});
