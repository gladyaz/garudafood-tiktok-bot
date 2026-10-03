// Unit test dispatcher AutoPIN. Tidak ada browser, tidak ada TikTok, tidak ada HTTP:
// transport-nya disuntik sebagai fungsi palsu.

const { test, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");

const { createScenePin } = require("../autopin/scene-pin");

const MAPPING = { "PAX-1": "kue coklat", "PAX-3": "bon bon" };

let logs = [];
const logger = { log: (line) => logs.push(String(line)) };
const tag = (t) => logs.filter((l) => l.startsWith(`[${t}]`));
const flush = () => new Promise((r) => setImmediate(r));

function make(overrides = {}) {
  return createScenePin({ enabled: true, mapping: MAPPING, logger, timeoutMs: 1000, ...overrides });
}

beforeEach(() => {
  logs = [];
  mock.timers.enable({ apis: ["setTimeout"] });
});
afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

test("flag mati -> tidak ada transport dipanggil dan tidak ada log sama sekali", async () => {
  let calls = 0;
  const pin = make({ enabled: false, send: () => { calls++; return { ok: true }; } });
  const r = await pin.requestPin({ scene: "PAX-1", playId: 1 });
  assert.equal(calls, 0);
  assert.equal(r.reason, "disabled");
  assert.deepEqual(logs, []);
});

test("MAIN tidak pernah dipin walau seseorang memetakannya", async () => {
  let calls = 0;
  const pin = createScenePin({
    enabled: true, logger, mapping: { MAIN: "apa saja" }, send: () => { calls++; return { ok: true }; },
  });
  const r = await pin.requestPin({ scene: "MAIN", playId: 1 });
  assert.equal(calls, 0);
  assert.equal(r.reason, "scene-never-mapped");
  assert.equal(tag("AUTOPIN_SKIPPED").length, 1);
});

test("scene tanpa pemetaan -> dilewati, tidak menebak produk", async () => {
  let calls = 0;
  const pin = make({ send: () => { calls++; return { ok: true }; } });
  const r = await pin.requestPin({ scene: "PAX-7", playId: 1 });
  assert.equal(calls, 0);
  assert.equal(r.reason, "no-mapping");
  assert.match(tag("AUTOPIN_SKIPPED")[0], /reason=no-mapping/);
});

test("scene kosong ditolak", async () => {
  const pin = make({ send: () => ({ ok: true }) });
  const r = await pin.requestPin({ scene: "", playId: 1 });
  assert.equal(r.reason, "empty-scene");
});

test("scene termapping -> tepat satu permintaan dengan kunci judul yang benar", async () => {
  const seen = [];
  const pin = make({ send: (req) => { seen.push(req); return { ok: true }; } });
  const r = await pin.requestPin({ scene: "PAX-3", playId: 4 });
  assert.equal(r.ok, true);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { scene: "PAX-3", productKey: "bon bon", playId: 4 });
  assert.equal(tag("AUTOPIN_REQUEST").length, 1);
  assert.equal(tag("AUTOPIN_SUCCESS").length, 1);
});

test("transport melempar sinkron -> tidak ada exception bocor, dilaporkan gagal", async () => {
  const pin = make({ send: () => { throw new Error("boom"); } });
  const r = await pin.requestPin({ scene: "PAX-1", playId: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "send-threw");
  assert.match(tag("AUTOPIN_FAILED")[0], /reason=send-threw/);
});

test("transport menolak (rejected promise) -> ditangkap, bukan unhandled rejection", async () => {
  const pin = make({ send: () => Promise.reject(new Error("jaringan mati")) });
  const r = await pin.requestPin({ scene: "PAX-1", playId: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "send-rejected");
});

test("transport menggantung -> selesai lewat timeout sendiri", async () => {
  const pin = make({ timeoutMs: 1000, send: () => new Promise(() => {}) });
  const p = pin.requestPin({ scene: "PAX-1", playId: 1 });
  mock.timers.tick(1000);
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(r.reason, "timeout");
  assert.match(tag("AUTOPIN_FAILED")[0], /reason=timeout/);
});

test("service membalas ok:false -> dicatat sebagai gagal dengan alasan aslinya", async () => {
  const pin = make({ send: () => ({ ok: false, reason: "live-pin-control-not-available" }) });
  const r = await pin.requestPin({ scene: "PAX-1", playId: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "live-pin-control-not-available");
  assert.match(tag("AUTOPIN_FAILED")[0], /reason=live-pin-control-not-available/);
});

test("playId lebih lama tiba belakangan -> tidak dikirim sama sekali", async () => {
  const seen = [];
  const pin = make({ send: (req) => { seen.push(req.playId); return { ok: true }; } });
  await pin.requestPin({ scene: "PAX-1", playId: 9 });
  const r = await pin.requestPin({ scene: "PAX-3", playId: 4 });
  assert.deepEqual(seen, [9]);
  assert.equal(r.reason, "stale");
  assert.match(tag("AUTOPIN_STALE")[0], /phase=dispatch/);
});

test("hasil yang datang setelah scene berganti tidak dianggap sukses", async () => {
  let release;
  const pin = make({
    send: (req) => (req.playId === 1 ? new Promise((res) => { release = () => res({ ok: true }); }) : { ok: true }),
  });

  const slow = pin.requestPin({ scene: "PAX-1", playId: 1 }); // masih menggantung
  await pin.requestPin({ scene: "PAX-3", playId: 2 });        // scene berikutnya menyusul
  release();
  const r = await slow;

  assert.equal(r.ok, false);
  assert.equal(r.reason, "stale");
  assert.match(tag("AUTOPIN_STALE")[0], /phase=result/);
  assert.equal(tag("AUTOPIN_SUCCESS").length, 1); // hanya PAX-3
});

test("tanpa transport terpasang -> gagal rapi, bukan crash", async () => {
  const pin = createScenePin({ enabled: true, mapping: MAPPING, logger });
  const r = await pin.requestPin({ scene: "PAX-1", playId: 1 });
  assert.equal(r.reason, "no-transport");
});

test("logger yang rusak tidak menjatuhkan dispatcher", async () => {
  const pin = createScenePin({
    enabled: true, mapping: MAPPING, send: () => ({ ok: true }),
    logger: { log: () => { throw new Error("logger mati"); } },
  });
  const r = await pin.requestPin({ scene: "PAX-1", playId: 1 });
  assert.equal(r.ok, true);
});

test("requestPin tidak pernah melempar walau argumennya sampah", async () => {
  const pin = make({ send: () => ({ ok: true }) });
  for (const bad of [undefined, null, 0, "PAX-1", { scene: 123 }]) {
    const r = await pin.requestPin(bad);
    assert.equal(typeof r.ok, "boolean");
  }
  await flush();
});

// ---- pemetaan scene -> produk (env-driven, tanpa nilai bawaan) ----

const { loadSceneProductMap, describeSceneProductMap } = require("../autopin/scene-map");

test("scene-map: tanpa konfigurasi -> peta kosong (AutoPIN tidak pernah terpanggil)", () => {
  assert.deepEqual(loadSceneProductMap({}), {});
  assert.equal(describeSceneProductMap({}), "(kosong)");
});

test("scene-map: garis bawah jadi tanda hubung dan nilai di-trim", () => {
  const m = loadSceneProductMap({ AUTOPIN_PRODUCT_PAX_1: "  kue coklat  ", AUTOPIN_PRODUCT_PAX_10: "bon bon" });
  assert.deepEqual(m, { "PAX-1": "kue coklat", "PAX-10": "bon bon" });
});

test("scene-map: MAIN tidak bisa dipetakan walau diisi di env", () => {
  assert.deepEqual(loadSceneProductMap({ AUTOPIN_PRODUCT_MAIN: "apa saja" }), {});
});

test("scene-map: placeholder kosong dan variabel lain diabaikan", () => {
  const m = loadSceneProductMap({ AUTOPIN_PRODUCT_PAX_2: "", AUTOPIN_PRODUCT_PAX_3: "   ", OBS_PASSWORD: "rahasia" });
  assert.deepEqual(m, {});
});
