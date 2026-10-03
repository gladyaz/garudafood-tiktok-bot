// Tes service AutoPIN yang TIDAK membuka browser.
// Hanya jalur yang menolak lebih dulu (sebelum halaman dibutuhkan) yang diuji
// di sini; klik sungguhan diverifikasi manual di LIVE, lihat autopin/VERIFICATION.md.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createService, isExpectedConsole } = require("../autopin/service");

const CONSOLE = "https://shop.tiktok.com/streamer/live/product/dashboard";

test("service: halaman dianggap benar hanya kalau origin DAN path sama", () => {
  assert.equal(isExpectedConsole(CONSOLE, CONSOLE), true);
  assert.equal(isExpectedConsole(`${CONSOLE}?tab=1`, CONSOLE), true, "query string tidak menentukan");
  assert.equal(isExpectedConsole("https://shop.tiktok.com/streamer/live-console", CONSOLE), false);
  assert.equal(isExpectedConsole("https://evil.example.com/streamer/live/product/dashboard", CONSOLE), false);
  assert.equal(isExpectedConsole("bukan-url", CONSOLE), false);
});

test("service: kunci produk kosong ditolak tanpa menyentuh browser", async () => {
  const svc = createService({ config: { consoleUrl: CONSOLE, forbiddenShops: ["garudafood"] } });
  for (const bad of [undefined, "", "   ", "!!!", 42]) {
    const r = await svc.handlePin({ scene: "PAX-1", productKey: bad, playId: 1 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "empty-product-key");
  }
  assert.equal(svc.__state().hasPage, false);
});

test("service: permintaan dengan playId lebih lama dibuang (latest-wins)", async () => {
  const svc = createService({ config: { consoleUrl: CONSOLE, forbiddenShops: ["garudafood"] } });
  await svc.handlePin({ scene: "PAX-5", productKey: "bon bon", playId: 9 }).catch(() => {});
  const r = await svc.handlePin({ scene: "PAX-3", productKey: "kue coklat", playId: 4 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "stale");
  assert.equal(svc.__state().latestPlayId, 9);
});
