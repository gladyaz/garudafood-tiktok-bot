// Unit tests for AutoPIN pure helpers. No browser, no network.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const core = require("../autopin/core");

const product = (number, extra = {}) => ({
  number,
  title: `Produk ${number}`,
  productId: `id-${number}`,
  pinControls: 1,
  pinned: false,
  ...extra,
});

test("parseArgs: command, positional, flags", () => {
  assert.deepEqual(core.parseArgs(["pin", "3", "--dry-run"]), {
    command: "pin", positional: ["3"], confirm: false, dryRun: true, unknownFlags: [],
  });
  assert.equal(core.parseArgs([]).command, "help");
  assert.deepEqual(core.parseArgs(["pin", "3", "--yes"]).unknownFlags, ["--yes"]);
});

test("parseProductNumber: only plain positive integers", () => {
  assert.equal(core.parseProductNumber("3"), 3);
  assert.equal(core.parseProductNumber("10"), 10);
  for (const bad of ["0", "-1", "3.5", "3a", "", undefined, "\"]", "1000"]) {
    assert.equal(core.parseProductNumber(bad), null, `should reject ${bad}`);
  }
});

test("checkIdentity: exact normalized match passes", () => {
  const r = core.checkIdentity({ expected: "@Warung.Ashoy", observed: ["Toko X", " warung.ashoy "], forbidden: ["garudafood"] });
  assert.equal(r.ok, true);
});

test("checkIdentity: refuses when not configured, not found, or mismatched", () => {
  assert.equal(core.checkIdentity({ expected: "", observed: ["warung.ashoy"] }).reason, "expected-shop-not-configured");
  assert.equal(core.checkIdentity({ expected: "warung.ashoy", observed: [] }).reason, "identity-not-found");
  assert.equal(core.checkIdentity({ expected: "warung.ashoy", observed: ["warung.ashoy2"] }).reason, "identity-mismatch");
});

test("checkIdentity: any forbidden production identity on the page blocks, even if expected also matches", () => {
  const r = core.checkIdentity({
    expected: "warung.ashoy",
    observed: ["warung.ashoy", "Garudafood Official Store"],
    forbidden: ["garudafood"],
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "forbidden-shop");
  assert.equal(
    core.checkIdentity({ expected: "garudafood_officialstore", observed: ["garudafood_officialstore"], forbidden: ["garudafood"] }).reason,
    "forbidden-shop",
  );
});

test("resolveProduct: exactly one product with exactly one control", () => {
  const r = core.resolveProduct([product(1), product(3), product(7)], 3);
  assert.equal(r.ok, true);
  assert.equal(r.product.productId, "id-3");
});

test("resolveProduct: not found / ambiguous product / missing or ambiguous control", () => {
  assert.equal(core.resolveProduct([product(1)], 3).reason, "product-not-found");
  assert.equal(core.resolveProduct([product(3), product(3, { productId: "x" })], 3).reason, "ambiguous-product");
  assert.equal(core.resolveProduct([product(3, { pinControls: 0 })], 3).reason, "control-not-found");
  assert.equal(core.resolveProduct([product(3, { pinControls: 2 })], 3).reason, "ambiguous-control");
});

test("verifyPinned: success only when the re-read target is pinned", () => {
  const target = product(3);
  assert.deepEqual(core.verifyPinned([product(1), product(3, { pinned: true })], target), { ok: true, pinnedOthers: [] });
  assert.equal(core.verifyPinned([product(3)], target).reason, "target-not-pinned");
  assert.equal(core.verifyPinned([product(1)], target).reason, "target-not-unique-after-click");
});

test("verifyPinned: reports other products still pinned (replacement behaviour evidence)", () => {
  const r = core.verifyPinned([product(3, { pinned: true }), product(7, { pinned: true })], product(7));
  assert.equal(r.ok, true);
  assert.deepEqual(r.pinnedOthers, [3]);
});

test("verifyPinned: falls back to number+title when productId is missing", () => {
  const target = { number: 3, title: "A", pinControls: 1, pinned: false };
  assert.equal(core.verifyPinned([{ number: 3, title: "A", pinned: true }], target).ok, true);
  assert.equal(core.verifyPinned([{ number: 3, title: "B", pinned: true }], target).ok, false);
});

test("createSerialRunner: tasks never overlap and a failure does not block the next task", async () => {
  const run = core.createSerialRunner();
  const events = [];
  const task = (name, ms, fail = false) => () =>
    new Promise((resolve, reject) => {
      events.push(`start:${name}`);
      setTimeout(() => {
        events.push(`end:${name}`);
        fail ? reject(new Error(name)) : resolve(name);
      }, ms);
    });

  const results = await Promise.allSettled([run(task("a", 20)), run(task("b", 5, true)), run(task("c", 1))]);

  assert.deepEqual(events, ["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
  assert.deepEqual(results.map((r) => r.status), ["fulfilled", "rejected", "fulfilled"]);
});
