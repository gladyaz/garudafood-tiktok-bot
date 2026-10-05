// Default konfigurasi AutoComment. loadConfig() selalu dipanggil dengan env palsu
// eksplisit, jadi suite ini tidak pernah membaca .env sungguhan - dan membuktikan
// bahwa tanpa konfigurasi apa pun fitur ini MATI.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { loadConfig, DEFAULTS } = require("../autocomment/config");

test("config: tanpa env apa pun -> AutoComment MATI", () => {
  assert.equal(loadConfig({}).enabled, false);
  assert.equal(DEFAULTS.enabled, false);
});

test("config: hanya string 'true' (tanpa peduli huruf besar/spasi) yang menyalakan", () => {
  for (const v of ["true", "TRUE", " true ", "True"]) assert.equal(loadConfig({ AUTOCOMMENT_ENABLED: v }).enabled, true, v);
  for (const v of ["1", "yes", "on", "false", "", "  ", "truee", undefined]) {
    assert.equal(loadConfig({ AUTOCOMMENT_ENABLED: v }).enabled, false, String(v));
  }
});

test("config: batas internal konservatif sebagai default (bukan angka resmi TikTok)", () => {
  const c = loadConfig({});
  assert.equal(c.maxPerMinute, 6);
  assert.equal(c.minIntervalMs, 5_000);
  assert.equal(c.timeoutMs, 8_000);
});

test("config: angka valid dipakai; angka rusak jatuh ke default DAN diperingatkan", () => {
  const warned = [];
  const warn = (m) => warned.push(String(m));
  assert.equal(loadConfig({ AUTOCOMMENT_MAX_PER_MINUTE: "3" }, { warn }).maxPerMinute, 3);
  assert.equal(loadConfig({ AUTOCOMMENT_MIN_INTERVAL_MS: "120000" }, { warn }).minIntervalMs, 120_000);
  assert.equal(loadConfig({ AUTOCOMMENT_TIMEOUT_MS: "0" }, { warn }).timeoutMs, 0);
  assert.deepEqual(warned, [], "nilai valid tidak boleh memicu peringatan");
  for (const bad of ["-1", "abc", "1.5", "30s", "30_000", "NaN", "Infinity"]) {
    assert.equal(loadConfig({ AUTOCOMMENT_MAX_PER_MINUTE: bad }, { warn }).maxPerMinute, 6, bad);
    assert.equal(loadConfig({ AUTOCOMMENT_MIN_INTERVAL_MS: bad }, { warn }).minIntervalMs, 5_000, bad);
  }
  assert.equal(warned.length, 14, 'satu peringatan per nilai rusak');
  assert.ok(warned.every((m) => /AUTOCOMMENT_(MAX_PER_MINUTE|MIN_INTERVAL_MS)=/.test(m) && /default/.test(m)));
});

test("config: nilai kosong / tidak diisi tidak memicu peringatan", () => {
  const warned = [];
  loadConfig({ AUTOCOMMENT_MAX_PER_MINUTE: "", AUTOCOMMENT_MIN_INTERVAL_MS: "  " }, { warn: (m) => warned.push(m) });
  loadConfig({}, { warn: (m) => warned.push(m) });
  assert.deepEqual(warned, []);
});

test("config: tidak pernah memuat nilai rahasia atau transport", () => {
  const keys = Object.keys(loadConfig({ OBS_PASSWORD: "x", TIKTOK_USERNAME: "y", AUTOCOMMENT_ENABLED: "true" }));
  assert.deepEqual(keys.sort(), ["enabled", "maxPerMinute", "minIntervalMs", "timeoutMs", "transport"]);
});

// ---------- baris [AUTOCOMMENT_CONFIG] ----------
//
// Regresi insiden LIVE 2026-10-05 (Phase 21). Baris ini dulu mencetak
// "transport=dry-run" secara hardcoded, sehingga bot-p21.log:2 menyatakan dry-run
// padahal bot itu BENAR-BENAR mengirim chat lewat browser. Di sistem yang bisa
// posting ke publik, log yang menyesatkan sama bahayanya dengan bug.

process.env.DOTENV_CONFIG_QUIET = "true";
const bot = require("../index.js");
const line = bot.__test.autocommentConfigLine;
const CFG = { maxPerMinute: 6, minIntervalMs: 5000, timeoutMs: 8000 };

test("log config: transport yang dicetak adalah transport yang BENAR-BENAR dipakai", () => {
  assert.ok(line(CFG, true, "browser").includes("transport=browser"), line(CFG, true, "browser"));
  assert.ok(line(CFG, false, "dry-run").includes("transport=dry-run"));
  // Pengaman inti: "browser" tidak boleh pernah tersamarkan sebagai dry-run.
  assert.ok(!line(CFG, true, "browser").includes("transport=dry-run"));
});

test("log config: enabled dan seluruh batas ikut tercetak apa adanya", () => {
  const l = line({ maxPerMinute: 3, minIntervalMs: 7000, timeoutMs: 9000 }, true, "browser");
  assert.equal(l, "[AUTOCOMMENT_CONFIG] enabled=true maxPerMinute=3 minIntervalMs=7000 timeoutMs=9000 transport=browser");
});

test("log config: nilai bawaan proses ini mencerminkan .env yang sedang aktif", () => {
  assert.ok(line().includes("enabled=" + bot.__test.autocommentEnabled()));
  assert.ok(line().includes("transport=" + bot.__test.autocommentTransport()));
});
