// Default konfigurasi AutoPIN. Tidak membaca .env sungguhan: loadConfig()
// selalu dipanggil dengan environment palsu yang eksplisit.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { loadConfig } = require("../autopin/config");

const VERIFIED_CONSOLE = "https://shop.tiktok.com/streamer/live/product/dashboard";

test("config: tanpa AUTOPIN_CONSOLE_URL -> memakai product dashboard yang terverifikasi", () => {
  assert.equal(loadConfig({}).consoleUrl, VERIFIED_CONSOLE);
});

test("config: default bukan lagi /streamer/live-console yang usang", () => {
  assert.doesNotMatch(loadConfig({}).consoleUrl, /live-console/);
});

test("config: AUTOPIN_CONSOLE_URL eksplisit tetap menang atas default", () => {
  const custom = "https://shop.tiktok.com/streamer/live/product/dashboard?region=id";
  assert.equal(loadConfig({ AUTOPIN_CONSOLE_URL: custom }).consoleUrl, custom);
  assert.equal(
    loadConfig({ AUTOPIN_CONSOLE_URL: "https://example.test/apa-saja" }).consoleUrl,
    "https://example.test/apa-saja",
  );
});

test("config: nilai kosong dianggap tidak diisi, jatuh ke default terverifikasi", () => {
  assert.equal(loadConfig({ AUTOPIN_CONSOLE_URL: "" }).consoleUrl, VERIFIED_CONSOLE);
});

test("config: guard produksi tetap aktif secara default", () => {
  assert.deepEqual(loadConfig({}).forbiddenShops, ["garudafood"]);
  assert.equal(loadConfig({}).expectedShop, "");
});
