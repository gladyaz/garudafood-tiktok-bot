// Unit test inti AutoComment: formatter + dispatcher.
// Tidak ada TikTok, browser, HTTP, maupun OBS. Transport disuntik sebagai fungsi palsu.

const { test, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");

const { formatSceneMessage, etalaseNumber, MAX_LENGTH } = require("../autocomment/formatter");
const { createAutoComment, createDryRunTransport, RATE_WINDOW_MS } = require("../autocomment/core");

let logs = [];
const logger = { log: (line) => logs.push(String(line)) };
const tag = (t) => logs.filter((l) => l.startsWith(`[${t}]`));

// jam yang bisa dimajukan manual: rate limit jadi deterministik tanpa timer palsu
let clock = 1_000_000;
const now = () => clock;

function make(overrides = {}) {
  return createAutoComment({ enabled: true, send: createDryRunTransport(), logger, now, timeoutMs: 1000, ...overrides });
}

beforeEach(() => {
  logs = [];
  clock = 1_000_000;
});
afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

// ---------------- formatter ----------------

test("formatter: PAX-1 dan PAX-10 menghasilkan teks yang benar dan deterministik", () => {
  assert.equal(formatSceneMessage("PAX-1").text, "Etalase 1 sudah aku pin ya kak 🛒");
  assert.equal(formatSceneMessage("PAX-10").text, "Etalase 10 sudah aku pin ya kak 🛒");
  assert.equal(formatSceneMessage("PAX-3").text, formatSceneMessage("PAX-3").text);
});

test("formatter: semua PAX-1..PAX-10 <= 100 karakter", () => {
  for (let n = 1; n <= 10; n++) {
    const r = formatSceneMessage(`PAX-${n}`);
    assert.equal(r.ok, true);
    assert.ok([...r.text].length <= MAX_LENGTH, `PAX-${n}: ${[...r.text].length} karakter`);
    assert.equal(r.etalase, n);
  }
});

test("formatter: scene tanpa nomor etalase -> tidak ada pesan", () => {
  for (const s of ["MAIN", "AI LIVE_FAQ_CO", "PAX-0", "PAX-11", "PAX-", "pax-1", "", null, 7]) {
    const r = formatSceneMessage(s);
    assert.equal(r.ok, false, `scene ${JSON.stringify(s)} seharusnya ditolak`);
    assert.equal(r.reason, "unsupported-scene");
  }
  assert.equal(etalaseNumber("PAX-7"), 7);
  assert.equal(etalaseNumber("PAX-99"), null);
});

test("formatter: template tanpa {n}, berisi HTML, atau kepanjangan ditolak", () => {
  assert.equal(formatSceneMessage("PAX-1", { template: "tanpa placeholder" }).reason, "invalid-template");
  assert.equal(formatSceneMessage("PAX-1", { template: "<b>Etalase {n}</b>" }).reason, "html-not-allowed");
  assert.equal(formatSceneMessage("PAX-1", { template: "Etalase {n} " + "x".repeat(120) }).reason, "too-long");
  assert.equal(formatSceneMessage("PAX-1", { template: "Etalase {n}\x07" }).reason, "control-chars");
});

test("formatter: tidak pernah memantulkan teks penonton (hanya nomor yang disisipkan)", () => {
  const r = formatSceneMessage("PAX-2", { template: "Etalase {n} siap" });
  assert.equal(r.text, "Etalase 2 siap");
  assert.ok(!r.text.includes("{n}"));
});

// ---------------- dispatcher: gerbang ----------------

test("flag mati -> tidak ada transport dipanggil dan tidak ada log", async () => {
  let calls = 0;
  const ac = make({ enabled: false, send: () => { calls++; return { ok: true, dryRun: true }; } });
  const r = await ac.requestComment({ scene: "PAX-1", playId: 1 });
  assert.equal(calls, 0);
  assert.equal(r.reason, "disabled");
  assert.deepEqual(logs, []);
});

test("MAIN tidak pernah menghasilkan komentar", async () => {
  let calls = 0;
  const ac = make({ send: () => { calls++; return { ok: true, dryRun: true }; } });
  const r = await ac.requestComment({ scene: "MAIN", playId: 1 });
  assert.equal(calls, 0);
  assert.equal(r.reason, "scene-never-commented");
  assert.equal(tag("AUTOCOMMENT_SKIPPED").length, 1);
});

test("scene tanpa nomor etalase -> dilewati tanpa memanggil transport", async () => {
  let calls = 0;
  const ac = make({ send: () => { calls++; return { ok: true, dryRun: true }; } });
  let playId = 0;
  for (const scene of ["AI LIVE_FAQ_STOKHABIS", "PAX-11", ""]) {
    const r = await ac.requestComment({ scene, playId: ++playId });
    assert.equal(r.ok, false, scene);
    assert.equal(r.reason, scene === "" ? "empty-scene" : "unsupported-scene", scene);
  }
  assert.equal(calls, 0);
  assert.equal(tag("AUTOCOMMENT_SKIPPED").filter((l) => /reason=unsupported-scene/.test(l)).length, 2);
});

test("PAX-1 mulai -> tepat satu pesan terencana dengan teks yang benar", async () => {
  const seen = [];
  const ac = make({ send: (req) => { seen.push(req); return { ok: true, dryRun: true }; } });
  const r = await ac.requestComment({ scene: "PAX-1", playId: 4, requesters: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.reason, "dry-run");
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { text: "Etalase 1 sudah aku pin ya kak 🛒", scene: "PAX-1", playId: 4 });
  assert.match(tag("AUTOCOMMENT_REQUEST")[0], /scene=PAX-1 playId=4 requesters=1/);
  assert.equal(tag("AUTOCOMMENT_DRYRUN").length, 1);
});

test("PAX-10 -> teks 'Etalase 10 ...' dan panjang <= 100", async () => {
  const seen = [];
  const ac = make({ send: (req) => { seen.push(req); return { ok: true, dryRun: true }; } });
  await ac.requestComment({ scene: "PAX-10", playId: 1 });
  assert.equal(seen[0].text, "Etalase 10 sudah aku pin ya kak 🛒");
  assert.ok([...seen[0].text].length <= 100);
});

test("transport dry-run bawaan membalas ok+dryRun tanpa efek samping", async () => {
  const send = createDryRunTransport();
  const r = await send({ text: "x", scene: "PAX-1", playId: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
});

test("hasil transport sungguhan (tanpa dryRun) dicatat sebagai SUCCESS, bukan DRYRUN", async () => {
  const ac = make({ send: () => ({ ok: true }) });
  const r = await ac.requestComment({ scene: "PAX-1", playId: 1 });
  assert.equal(r.reason, "sent");
  assert.equal(tag("AUTOCOMMENT_SUCCESS").length, 1);
  assert.equal(tag("AUTOCOMMENT_DRYRUN").length, 0);
});

// ---------------- dedupe / agregasi ----------------

test("playId yang sama dua kali -> hanya satu pesan", async () => {
  let calls = 0;
  const ac = make({ send: () => { calls++; return { ok: true, dryRun: true }; } });
  await ac.requestComment({ scene: "PAX-3", playId: 7 });
  clock += 10_000;
  const r = await ac.requestComment({ scene: "PAX-3", playId: 7 });
  assert.equal(calls, 1);
  assert.equal(r.reason, "duplicate-playId");
  assert.match(tag("AUTOCOMMENT_SKIPPED")[0], /reason=duplicate-playId/);
});

test("20 penonton teragregasi -> satu scene start -> satu pesan, requesters hanya di log", async () => {
  const seen = [];
  const ac = make({ send: (req) => { seen.push(req); return { ok: true, dryRun: true }; } });
  await ac.requestComment({ scene: "PAX-3", playId: 8, requesters: 20 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].text, "Etalase 3 sudah aku pin ya kak 🛒", "teks tidak boleh memuat jumlah/nama penonton");
  assert.match(tag("AUTOCOMMENT_REQUEST")[0], /requesters=20/);
});

// ---------------- isolasi kegagalan ----------------

test("transport melempar sinkron -> tidak ada exception bocor", async () => {
  const ac = make({ send: () => { throw new Error("boom"); } });
  const r = await ac.requestComment({ scene: "PAX-1", playId: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "send-threw");
  assert.match(tag("AUTOCOMMENT_FAILED")[0], /reason=send-threw/);
});

test("transport menolak (rejected promise) -> ditangkap", async () => {
  const ac = make({ send: () => Promise.reject(new Error("mati")) });
  const r = await ac.requestComment({ scene: "PAX-1", playId: 1 });
  assert.equal(r.reason, "send-rejected");
});

test("transport menggantung -> selesai lewat timeout sendiri", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const ac = make({ timeoutMs: 1000, send: () => new Promise(() => {}) });
  const p = ac.requestComment({ scene: "PAX-1", playId: 1 });
  mock.timers.tick(1000);
  const r = await p;
  assert.equal(r.reason, "timeout");
  assert.match(tag("AUTOCOMMENT_FAILED")[0], /reason=timeout/);
});

test("transport membalas ok:false -> dicatat gagal dengan alasan aslinya", async () => {
  const ac = make({ send: () => ({ ok: false, reason: "chat-input-missing" }) });
  const r = await ac.requestComment({ scene: "PAX-1", playId: 1 });
  assert.equal(r.reason, "chat-input-missing");
});

test("tanpa transport -> gagal rapi", async () => {
  const ac = createAutoComment({ enabled: true, logger, now });
  const r = await ac.requestComment({ scene: "PAX-1", playId: 1 });
  assert.equal(r.reason, "no-transport");
});

test("logger rusak dan argumen sampah tidak menjatuhkan dispatcher", async () => {
  const ac = createAutoComment({ enabled: true, send: () => ({ ok: true, dryRun: true }), now,
    logger: { log: () => { throw new Error("logger mati"); } } });
  assert.equal((await ac.requestComment({ scene: "PAX-1", playId: 1 })).ok, true);
  for (const bad of [undefined, null, 0, "PAX-1", { scene: 123 }]) {
    const r = await ac.requestComment(bad);
    assert.equal(typeof r.ok, "boolean");
  }
});

// ---------------- stale ----------------

test("playId lebih lama tiba belakangan -> tidak dikirim", async () => {
  const seen = [];
  const ac = make({ send: (req) => { seen.push(req.playId); return { ok: true, dryRun: true }; } });
  await ac.requestComment({ scene: "PAX-5", playId: 9 });
  clock += 10_000;
  const r = await ac.requestComment({ scene: "PAX-3", playId: 4 });
  assert.deepEqual(seen, [9]);
  assert.equal(r.reason, "stale");
  assert.match(tag("AUTOCOMMENT_STALE")[0], /phase=dispatch/);
});

test("hasil yang datang setelah scene berganti tidak dianggap sukses", async () => {
  let release;
  const ac = make({
    minIntervalMs: 0,
    send: (req) => (req.playId === 1 ? new Promise((res) => { release = () => res({ ok: true, dryRun: true }); }) : { ok: true, dryRun: true }),
  });
  const slow = ac.requestComment({ scene: "PAX-3", playId: 1 });
  clock += 100;
  await ac.requestComment({ scene: "PAX-5", playId: 2 });
  release();
  const r = await slow;
  assert.equal(r.reason, "stale");
  assert.match(tag("AUTOCOMMENT_STALE")[0], /phase=result/);
  assert.equal(tag("AUTOCOMMENT_DRYRUN").length, 1, "hanya PAX-5 yang dihitung sukses");
});

// ---------------- rate limit ----------------

test("rate limit: pesan ke-N+1 dalam satu menit DIBUANG, bukan diantrekan", async () => {
  let calls = 0;
  const ac = make({ maxPerMinute: 3, minIntervalMs: 0, send: () => { calls++; return { ok: true, dryRun: true }; } });
  const results = [];
  for (let i = 1; i <= 5; i++) {
    results.push((await ac.requestComment({ scene: "PAX-1", playId: i })).reason);
    clock += 1_000;
  }
  assert.equal(calls, 3);
  assert.deepEqual(results, ["dry-run", "dry-run", "dry-run", "rate-limit", "rate-limit"]);
  assert.equal(tag("AUTOCOMMENT_SKIPPED").filter((l) => /reason=rate-limit/.test(l)).length, 2);
});

test("rate limit: jendela 60 detik bergeser dan kuota pulih", async () => {
  let calls = 0;
  const ac = make({ maxPerMinute: 2, minIntervalMs: 0, send: () => { calls++; return { ok: true, dryRun: true }; } });
  await ac.requestComment({ scene: "PAX-1", playId: 1 });
  clock += 1_000;
  await ac.requestComment({ scene: "PAX-1", playId: 2 });
  clock += 1_000;
  assert.equal((await ac.requestComment({ scene: "PAX-1", playId: 3 })).reason, "rate-limit");
  clock += RATE_WINDOW_MS; // kedua kiriman pertama keluar dari jendela
  assert.equal((await ac.requestComment({ scene: "PAX-1", playId: 4 })).reason, "dry-run");
  assert.equal(calls, 3);
});

test("min-interval: dua pesan terlalu rapat -> yang kedua dibuang", async () => {
  let calls = 0;
  const ac = make({ maxPerMinute: 100, minIntervalMs: 5_000, send: () => { calls++; return { ok: true, dryRun: true }; } });
  await ac.requestComment({ scene: "PAX-1", playId: 1 });
  clock += 2_000;
  assert.equal((await ac.requestComment({ scene: "PAX-2", playId: 2 })).reason, "min-interval");
  clock += 3_000;
  assert.equal((await ac.requestComment({ scene: "PAX-3", playId: 3 })).reason, "dry-run");
  assert.equal(calls, 2);
});

test("kiriman yang gagal tetap dihitung ke rate limit (tidak ada celah retry)", async () => {
  let n = 0;
  const ac = make({ maxPerMinute: 2, minIntervalMs: 0, send: () => { n++; throw new Error("gagal"); } });
  await ac.requestComment({ scene: "PAX-1", playId: 1 });
  clock += 1_000;
  await ac.requestComment({ scene: "PAX-1", playId: 2 });
  clock += 1_000;
  assert.equal((await ac.requestComment({ scene: "PAX-1", playId: 3 })).reason, "rate-limit");
  assert.equal(n, 2);
});

test("__state melaporkan konfigurasi untuk audit", () => {
  const ac = make({ maxPerMinute: 4, minIntervalMs: 2_500 });
  assert.deepEqual(ac.__state(), { enabled: true, latestPlayId: 0, handled: 0, sentInWindow: 0, lastSentAt: -Infinity, maxPerMinute: 4, minIntervalMs: 2_500 });
});


test("min-interval lebih panjang dari 60 detik tetap dihormati (tidak terpotong oleh jendela)", async () => {
  let calls = 0;
  const ac = make({ maxPerMinute: 100, minIntervalMs: 120_000, send: () => { calls++; return { ok: true, dryRun: true }; } });
  assert.equal((await ac.requestComment({ scene: "PAX-1", playId: 1 })).reason, "dry-run");
  clock += 61_000; // sudah keluar dari jendela 60 detik, tapi belum 120 detik
  assert.equal((await ac.requestComment({ scene: "PAX-2", playId: 2 })).reason, "min-interval");
  clock += 60_000; // total 121 detik sejak kirim terakhir
  assert.equal((await ac.requestComment({ scene: "PAX-3", playId: 3 })).reason, "dry-run");
  assert.equal(calls, 2);
});

test("playId NaN/Infinity tidak meracuni proteksi stale (permintaannya tetap diproses)", async () => {
  const seen = [];
  const ac = make({ minIntervalMs: 0, send: (req) => { seen.push(req.playId); return { ok: true, dryRun: true }; } });
  await ac.requestComment({ scene: "PAX-1", playId: 5 });
  for (const bad of [NaN, Infinity, -Infinity]) {
    clock += 1_000;
    const r = await ac.requestComment({ scene: "PAX-2", playId: bad });
    assert.equal(r.reason, "dry-run", String(bad)); // tanpa playId valid: tetap diproses, tanpa dedupe/stale
    assert.equal(ac.__state().latestPlayId, 5, String(bad));
  }
  assert.equal(seen.length, 4);
  assert.ok(Number.isNaN(seen[1]));
  clock += 1_000;
  assert.equal((await ac.requestComment({ scene: "PAX-3", playId: 4 })).reason, "stale");
});

test("minIntervalMs=0 benar-benar menonaktifkan pemeriksaan, walau jam mundur", async () => {
  let calls = 0;
  const ac = make({ maxPerMinute: 100, minIntervalMs: 0, send: () => { calls++; return { ok: true, dryRun: true }; } });
  await ac.requestComment({ scene: "PAX-1", playId: 1 });
  clock -= 30_000; // jam dinding mundur
  assert.equal((await ac.requestComment({ scene: "PAX-2", playId: 2 })).reason, "dry-run");
  assert.equal(calls, 2);
});
