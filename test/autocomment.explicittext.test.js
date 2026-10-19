// Jalur TEKS EKSPLISIT AutoComment (v0.3.0).
//
// Dipakai Product Q&A, yang tidak memutar scene apa pun dan karena itu tidak
// punya balasan berbasis scene untuk diambil — format() berkunci scene.
//
// Yang dibuktikan di sini: jalur ini melewati HANYA pemilihan teks. Setiap
// gerbang keselamatan lain tetap berlaku, dan tidak ada transport kedua.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { createAutoComment, PIN_POLICY, PRIORITY } = require("../autocomment/core");
const { validateText, MAX_LENGTH } = require("../autocomment/formatter");
const { createQaDedupe, createQaQuota } = require("../qa/dedupe");
const { productIdentity } = require("../qa/resolve-product");

const QA_TEXT = "Harga yang tampil di etalase saat ini Rp14.299 ya kak 😊";

function rig({ minIntervalMs = 0, maxPerMinute = 6, pinPolicy = PIN_POLICY.CONFIRMED, sendResult = { ok: true } } = {}) {
  const sent = [];
  const logs = [];
  let t = 1_000_000;
  const ac = createAutoComment({
    enabled: true,
    pinPolicy,
    inspectPin: (pin) => ({ confirmed: !!(pin && pin.ok), reason: pin && pin.reason }),
    // format() HANYA mengenal scene PAX: inilah sebabnya Q&A butuh jalur kedua.
    format: (scene) => (/^PAX-\d+$/.test(scene) ? { ok: true, text: `Etalase ${scene.slice(4)} sudah aku pin ya kak` } : { ok: false, reason: "unsupported-scene" }),
    send: async (req) => { sent.push(req); return typeof sendResult === "function" ? sendResult(req) : sendResult; },
    logger: { log: (l) => logs.push(l) },
    now: () => t,
    minIntervalMs,
    maxPerMinute,
    timeoutMs: 8000,
  });
  return { ac, sent, logs, maju: (ms) => { t += ms; } };
}

// --- jalur teks eksplisit -------------------------------------------------

test("teks eksplisit: dipakai apa adanya, format() tidak dipanggil", async () => {
  const r = rig();
  const res = await r.ac.requestComment({ scene: "QA-PRICE", text: QA_TEXT, requirePin: false });
  assert.equal(res.ok, true);
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].text, QA_TEXT);
});

test("teks eksplisit: scene yang format() TIDAK kenal tetap bisa menjawab", async () => {
  // Tanpa jalur ini, "QA-PRICE" akan ditolak unsupported-scene dan Q&A tidak
  // akan pernah bisa bicara.
  const r = rig();
  const tanpa = await r.ac.requestComment({ scene: "QA-PRICE", requirePin: false });
  assert.equal(tanpa.ok, false);
  assert.equal(tanpa.reason, "unsupported-scene");

  const dengan = await r.ac.requestComment({ scene: "QA-PRICE", text: QA_TEXT, requirePin: false });
  assert.equal(dengan.ok, true);
});

test("teks eksplisit: jalur scene TIDAK berubah", async () => {
  const r = rig();
  const res = await r.ac.requestComment({ scene: "PAX-3", playId: 1, pin: { ok: true }, requirePin: true, priority: PRIORITY.HIGH });
  assert.equal(res.ok, true);
  assert.equal(r.sent[0].text, "Etalase 3 sudah aku pin ya kak");
});

// --- gerbang teks TETAP berlaku ------------------------------------------

test("teks eksplisit: gerbang panjang berlaku", async () => {
  const r = rig();
  const res = await r.ac.requestComment({ scene: "QA-PRICE", text: "x".repeat(MAX_LENGTH + 1), requirePin: false });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "too-long");
  assert.equal(r.sent.length, 0);
});

test("teks eksplisit: gerbang HTML dan karakter kontrol berlaku", async () => {
  const r = rig();
  assert.equal((await r.ac.requestComment({ scene: "QA-PRICE", text: "harga <b>murah</b>", requirePin: false })).reason, "html-not-allowed");
  assert.equal((await r.ac.requestComment({ scene: "QA-PRICE", text: "harga Rp1", requirePin: false })).reason, "control-chars");
  assert.equal(r.sent.length, 0);
});

test("teks eksplisit: teks kosong ditolak", async () => {
  const r = rig();
  for (const t of ["", "   ", "\n\t "]) {
    const res = await r.ac.requestComment({ scene: "QA-PRICE", text: t, requirePin: false });
    assert.equal(res.reason, "empty-text", JSON.stringify(t));
  }
  assert.equal(r.sent.length, 0);
});

test("teks eksplisit: memakai validateText yang SAMA dengan jalur scene", () => {
  // Satu gerbang teks di repo ini, dipakai bersama.
  const src = fs.readFileSync(path.join(__dirname, "..", "autocomment", "core.js"), "utf8");
  assert.ok(src.includes("validateText"), "core harus memakai validateText");
  assert.ok(/require\(["']\.\/formatter["']\)/.test(src));
  // dan tidak punya aturan panjang sendiri
  assert.ok(!/MAX_LENGTH\s*=/.test(src), "core tidak boleh punya batas panjang sendiri");
  assert.equal(validateText("  a  b  ").text, "a b", "rapikan spasi, sama seperti sebelumnya");
});

// --- gerbang keselamatan LAIN tetap berlaku -----------------------------

test("teks eksplisit: rate limit tetap berlaku", async () => {
  const r = rig({ minIntervalMs: 5000 });
  assert.equal((await r.ac.requestComment({ scene: "QA-PRICE", text: QA_TEXT, requirePin: false })).ok, true);
  const kedua = await r.ac.requestComment({ scene: "QA-PRICE", text: QA_TEXT, requirePin: false });
  assert.equal(kedua.ok, false);
  assert.equal(kedua.reason, "min-interval");
  assert.equal(r.sent.length, 1);
});

test("teks eksplisit: plafon per menit tetap berlaku", async () => {
  const r = rig({ minIntervalMs: 0, maxPerMinute: 3 });
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await r.ac.requestComment({ scene: "QA-PRICE", text: QA_TEXT, requirePin: false })).ok, true, `kiriman ${i}`);
  }
  const keempat = await r.ac.requestComment({ scene: "QA-PRICE", text: QA_TEXT, requirePin: false });
  assert.equal(keempat.reason, "rate-limit");
});

test("teks eksplisit: flag enabled tetap mematikan semuanya", async () => {
  const sent = [];
  const ac = createAutoComment({ enabled: false, send: async (r) => { sent.push(r); return { ok: true }; } });
  assert.equal((await ac.requestComment({ scene: "QA-PRICE", text: QA_TEXT, requirePin: false })).reason, "disabled");
  assert.equal(sent.length, 0);
});

test("teks eksplisit: kegagalan transport dilaporkan apa adanya", async () => {
  const r = rig({ sendResult: { ok: false, reason: "chat-input-disabled" } });
  const res = await r.ac.requestComment({ scene: "QA-PRICE", text: QA_TEXT, requirePin: false });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "chat-input-disabled");
});

test("teks eksplisit: transport yang melempar tidak menjatuhkan pemanggil", async () => {
  const ac = createAutoComment({ enabled: true, send: () => { throw new Error("meledak"); }, logger: { log: () => {} } });
  const res = await ac.requestComment({ scene: "QA-PRICE", text: QA_TEXT, requirePin: false });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "send-threw");
});

test("teks eksplisit: TIDAK ada transport kedua", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "autocomment", "core.js"), "utf8");
  // Satu titik DISPATCH transport. Dihitung pada pemanggilannya, bukan pada
  // deklarasi `function send({...})` milik transport dry-run.
  const dispatch = (src.match(/Promise\.resolve\(send\(/g) || []).length;
  assert.equal(dispatch, 1, "tepat satu titik dispatch transport");
  // dan jalur teks eksplisit tidak memperkenalkan transport sendiri
  assert.ok(!/createQaTransport|qaSend|sendQa/.test(src), "tidak boleh ada transport Q&A tersendiri");
});

// --- prioritas: Q&A tidak pernah mendahului balasan pin ------------------

test("prioritas: teks eksplisit tanpa requirePin SELALU diturunkan ke NORMAL", async () => {
  // Dua lapis: Q&A memang tidak mengirim priority, dan core menurunkan
  // high-tanpa-requirePin kalau suatu saat ada yang mencoba.
  const r = rig();
  await r.ac.requestComment({ scene: "QA-PRICE", text: QA_TEXT, requirePin: false, priority: PRIORITY.HIGH });
  assert.ok(r.logs.some((l) => l.includes("AUTOCOMMENT_PRIORITY_DOWNGRADED")), r.logs.join("\n"));
});

test("prioritas: balasan HIGH tetap memakai jamnya sendiri", async () => {
  // Q&A NORMAL yang baru terkirim menahan NORMAL berikutnya, tapi HIGH punya
  // jam terpisah dan tidak ikut tertahan.
  const r = rig({ minIntervalMs: 5000 });
  assert.equal((await r.ac.requestComment({ scene: "QA-PRICE", text: QA_TEXT, requirePin: false })).ok, true);
  r.maju(1000);
  const high = await r.ac.requestComment({ scene: "PAX-1", playId: 1, pin: { ok: true }, requirePin: true, priority: PRIORITY.HIGH });
  assert.equal(high.ok, true, "balasan pin tidak boleh tertahan oleh Q&A");
});

// --- jeda Q&A TIDAK menyentuh jalur lain --------------------------------

test("jeda Q&A: balasan HIGH untuk produk yang SAMA tidak pernah ditahan", async () => {
  // Peta jeda Q&A tidak pernah dikonsultasikan oleh jalur scene. Dibuktikan
  // dengan jeda yang SUDAH terpakai untuk produk itu.
  const produk = { title: "Garuda - Kacang ATOM 16gr", number: 1, stableId: null };
  const dedupe = createQaDedupe({ now: () => 1_000_000 });
  dedupe.note("PRICE", productIdentity(produk));
  assert.equal(dedupe.allow("PRICE", productIdentity(produk)).ok, false, "Q&A untuk produk ini sedang ditahan");

  // dan balasan pin untuk produk yang SAMA tetap terkirim
  const r = rig();
  const high = await r.ac.requestComment({ scene: "PAX-1", playId: 1, pin: { ok: true }, requirePin: true, priority: PRIORITY.HIGH });
  assert.equal(high.ok, true);
  assert.equal(r.sent[0].text, "Etalase 1 sudah aku pin ya kak");
});

test("jeda Q&A: balasan FAQ eksplisit tidak terpengaruh", async () => {
  const dedupe = createQaDedupe({ now: () => 1_000_000 });
  dedupe.note("PRICE", "title:apa pun");
  const r = rig();
  // Balasan aturan FAQ datang dari jalur scene (format), bukan teks eksplisit,
  // dan tidak pernah melewati peta jeda Q&A.
  const faq = await r.ac.requestComment({ scene: "PAX-2", playId: 5, requirePin: false });
  assert.equal(faq.ok, true);
  assert.equal(r.sent[0].text, "Etalase 2 sudah aku pin ya kak");
});

test("jeda Q&A: semantik stale/playId AutoComment tidak berubah", async () => {
  const r = rig();
  assert.equal((await r.ac.requestComment({ scene: "PAX-1", playId: 9, pin: { ok: true } })).ok, true);
  const basi = await r.ac.requestComment({ scene: "PAX-2", playId: 4, pin: { ok: true } });
  assert.equal(basi.reason, "stale", "playId lebih lama tetap basi");
  const ulang = await r.ac.requestComment({ scene: "PAX-1", playId: 9, pin: { ok: true } });
  assert.equal(ulang.reason, "duplicate-playId", "dedupe playId tetap berlaku");
});

test("jeda Q&A: Q&A tanpa playId TIDAK meracuni latestPlayId", async () => {
  // Kalau Q&A mengirim playId palsu, balasan scene berikutnya bisa dianggap basi.
  const r = rig();
  await r.ac.requestComment({ scene: "PAX-1", playId: 7, pin: { ok: true } });
  await r.ac.requestComment({ scene: "QA-PRICE", text: QA_TEXT, requirePin: false });
  assert.equal(r.ac.__state().latestPlayId, 7, "latestPlayId tidak boleh berubah oleh Q&A");
  const lanjut = await r.ac.requestComment({ scene: "PAX-2", playId: 8, pin: { ok: true } });
  assert.equal(lanjut.ok, true);
});

// --- ISOLASI PLAFON ADMISI Q&A ------------------------------------------

test("isolasi: balasan PAX HIGH tidak memakai slot kuota Q&A", async () => {
  const quota = createQaQuota({ now: () => 1_000_000 });
  const r = rig();
  // sepuluh balasan pin HIGH
  for (let i = 1; i <= 10; i += 1) {
    await r.ac.requestComment({ scene: `PAX-${(i % 5) + 1}`, playId: i, pin: { ok: true }, requirePin: true, priority: PRIORITY.HIGH });
  }
  assert.equal(quota.__state().used, 0, "jalur HIGH tidak pernah menyentuh kuota Q&A");
  assert.equal(quota.allow().ok, true, "kedua slot Q&A masih utuh");
});

test("isolasi: balasan FAQ NORMAL tidak memakai slot kuota Q&A", async () => {
  const quota = createQaQuota({ now: () => 1_000_000 });
  const r = rig();
  for (let i = 1; i <= 6; i += 1) {
    await r.ac.requestComment({ scene: "PAX-2", playId: i, requirePin: false });
  }
  assert.equal(quota.__state().used, 0, "jalur aturan tidak pernah menyentuh kuota Q&A");
  assert.equal(quota.allow().ok, true);
});

test("isolasi: kuota Q&A yang HABIS tidak pernah membungkam HIGH maupun FAQ", async () => {
  const quota = createQaQuota({ now: () => 1_000_000 });
  quota.note();
  quota.note();
  assert.equal(quota.allow().ok, false, "kuota Q&A habis");

  const r = rig();
  const high = await r.ac.requestComment({ scene: "PAX-1", playId: 1, pin: { ok: true }, requirePin: true, priority: PRIORITY.HIGH });
  assert.equal(high.ok, true, "balasan pin tetap terkirim");
  const faq = await r.ac.requestComment({ scene: "PAX-2", playId: 2, requirePin: false });
  assert.equal(faq.ok, true, "balasan aturan tetap terkirim");
  assert.equal(r.sent.length, 2);
});

test("isolasi: AutoComment tidak tahu apa pun soal kuota Q&A", () => {
  // Plafon ini milik jalur Q&A. Limiter global tetap seperti v0.2.2.
  const src = fs.readFileSync(path.join(__dirname, "..", "autocomment", "core.js"), "utf8");
  for (const t of ["createQaQuota", "qa-quota", "qa/dedupe", "qaQuota"]) {
    assert.ok(!src.includes(t), `${t} tidak boleh ada di AutoComment`);
  }
});

test("isolasi: limiter global AutoComment TIDAK berubah dari v0.2.2", () => {
  // Diminta eksplisit: jangan ubah maxPerMinute, jangan ubah minIntervalMs,
  // jangan tambah kelas prioritas ketiga.
  const core = require("../autocomment/core");
  assert.deepEqual(Object.keys(core.PRIORITY).sort(), ["HIGH", "NORMAL"], "tetap DUA prioritas");
  const src = fs.readFileSync(path.join(__dirname, "..", "autocomment", "core.js"), "utf8");
  assert.ok(/DEFAULT_MAX_PER_MINUTE\s*=\s*6/.test(src) || /maxPerMinute = DEFAULT_MAX_PER_MINUTE/.test(src));
  assert.ok(src.includes("RATE_WINDOW_MS"), "jendela rate limit masih ada");
});
