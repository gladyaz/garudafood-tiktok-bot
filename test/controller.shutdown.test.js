// Shutdown Controller harus SELESAI, bukan menggantung.
//
// Regresi dari smoke test 2026-10-07: proses Controller tetap hidup sesudah
// menerima sinyal berhenti. Port-nya sudah dilepas, jadi handler-nya memang
// berjalan — tapi server.close() tidak pernah memanggil callback-nya, karena satu
// socket keep-alive yang menganggur dari klien HTTP sebelumnya masih terbuka.
// close() berhenti menerima koneksi baru, lalu menunggu yang lama selesai, dan
// socket menganggur tidak pernah selesai dengan sendirinya.
//
// Kenapa ini serius dan bukan kerapian: shutdown Controller menunggu server.stop(),
// dan stopAutomation() dipanggil di jalur yang sama. Controller yang menggantung
// saat shutdown berarti bot dan service AutoPIN hidup lebih lama darinya — bentuk
// persis insiden 2026-10-05, hanya lewat pintu masuk yang berbeda.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createServer } = require("../controller/server");
const { createHarness } = require("./helpers/controller-harness");

test("stop() selesai walau ada koneksi keep-alive yang menganggur", async () => {
  const h = createHarness();
  const server = createServer({ controller: h.controller });
  const addr = await server.start({ port: 0 });
  const base = "http://127.0.0.1:" + addr.port;

  // Agent dengan keep-alive: socket-nya sengaja DIBIARKAN terbuka sesudah
  // balasan diterima, persis seperti yang dilakukan klien HTTP sungguhan.
  const http = require("node:http");
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

  await new Promise((resolve, reject) => {
    const req = http.get(base + "/api/status", { agent }, (res) => {
      res.resume();
      res.on("end", resolve);
    });
    req.on("error", reject);
  });

  // Tanpa pemutusan koneksi menganggur, stop() di sini tidak akan pernah selesai
  // dan tes ini akan habis waktu, bukan gagal dengan rapi.
  const t0 = Date.now();
  await server.stop();
  const elapsed = Date.now() - t0;

  // Harus selesai cepat lewat closeAllConnections(), bukan lewat batas waktu 3s.
  assert.ok(elapsed < 2500, "stop() terlalu lama: " + elapsed + "ms");

  agent.destroy();
  await h.controller.stopAutomation().catch(() => {});
});

test("stop() aman dipanggil dua kali", async () => {
  const h = createHarness();
  const server = createServer({ controller: h.controller });
  await server.start({ port: 0 });

  await server.stop();
  await server.stop();
  assert.equal(server.__server(), null);
});

test("stop() tanpa start sama sekali: langsung selesai", async () => {
  const h = createHarness();
  const server = createServer({ controller: h.controller });
  await server.stop();
  assert.equal(server.__server(), null);
});

test("port benar-benar dilepas sesudah stop(), jadi bisa diikat lagi", async () => {
  const h = createHarness();
  const first = createServer({ controller: h.controller });
  const addr = await first.start({ port: 0 });
  await first.stop();

  // Kalau port tidak benar-benar dilepas, start berikutnya akan gagal EADDRINUSE —
  // dan operator akan melihatnya sebagai "Controller tidak bisa menyala lagi".
  const second = createServer({ controller: h.controller });
  const again = await second.start({ port: addr.port });
  assert.equal(again.port, addr.port);
  await second.stop();
});

test("shutdown Controller mematikan child WALAU server punya koneksi menganggur", async () => {
  // Gabungan dari dua masalah: koneksi menganggur yang menahan server, dan child
  // yang harus mati. Yang kedua tidak boleh menjadi korban dari yang pertama.
  const h = createHarness();
  const server = createServer({ controller: h.controller });
  const addr = await server.start({ port: 0 });

  const http = require("node:http");
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: addr.port,
        path: "/api/start",
        method: "POST",
        agent,
        headers: { "content-type": "application/json" },
      },
      (res) => {
        res.resume();
        res.on("end", resolve);
      }
    );
    req.on("error", reject);
    req.end();
  });

  assert.equal(h.world.liveCount(), 2, "dua child harus hidup dulu");

  const r = await h.controller.shutdown();
  await server.stop();

  assert.equal(r.ok, true);
  assert.equal(h.world.liveCount(), 0, "child tidak boleh hidup lebih lama dari Controller");
  agent.destroy();
});
