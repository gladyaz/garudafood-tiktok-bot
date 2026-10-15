// Limiter dua jam: balasan produk yang TERBUKTI ter-pin tidak boleh kalah oleh
// balasan FAQ, tanpa membuka celah spam.
//
// Memakai createAutoComment PRODUKSI dengan jam yang disuntikkan. Tidak ada
// tiruan di sekitar limiter: yang diuji adalah fungsi yang sama yang memutuskan
// saat LIVE.
//
// ---------------------------------------------------------------------------
// MODEL YANG DIUJI
//
//   lastAnySentAt   diperbarui SETIAP kiriman    -> dipakai NORMAL (minIntervalMs)
//   lastHighSentAt  diperbarui kiriman HIGH saja -> dipakai HIGH   (highMinIntervalMs)
//   sentAt[]        jendela 60 detik BERSAMA     -> maxPerMinute, kedua prioritas
//
// Asimetrinya: FAQ tidak bisa membungkam balasan produk, tapi balasan produk
// TETAP menahan FAQ berikutnya selama lima detik penuh.

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  createAutoComment,
  createDryRunTransport,
  PIN_POLICY,
  PRIORITY,
  DEFAULT_MIN_INTERVAL_MS,
  DEFAULT_HIGH_MIN_INTERVAL_MS,
} = require("../autocomment/core");
const { inspectPinResult } = require("../autopin/pin-result");

const NORMAL_MS = DEFAULT_MIN_INTERVAL_MS;   // 5000
const HIGH_MS = DEFAULT_HIGH_MIN_INTERVAL_MS; // 1500

const PIN_CONFIRMED = { ok: true, reason: "pinned", clicked: true, state: "Unpin", title: "Produk Uji" };
const PIN_FAILED = { ok: false, reason: "product-not-found" };

let clock;
let logs;
const now = () => clock;
const at = (ms) => { clock = 1_000_000 + ms; };

// Dispatcher produksi dengan kebijakan pin TERKETAT (transport browser).
function make(overrides = {}) {
  return createAutoComment({
    enabled: true,
    pinPolicy: PIN_POLICY.CONFIRMED,
    inspectPin: inspectPinResult,
    format: (scene) => ({ ok: true, text: "balasan " + scene }),
    send: createDryRunTransport(),
    now,
    logger: { log: (l) => logs.push(String(l)) },
    timeoutMs: 1000,
    ...overrides,
  });
}

// Satu permintaan prioritas tinggi: aturan yang mem-pin, dengan pin TERBUKTI.
let seq = 0;
const high = (ac, pin = PIN_CONFIRMED) =>
  ac.requestComment({ scene: "PAX-1", playId: ++seq, pin, requirePin: true, priority: PRIORITY.HIGH });

// Satu permintaan normal: aturan FAQ yang tidak menjanjikan pin apa pun.
const normal = (ac) =>
  ac.requestComment({ scene: "FAQ-HARGA", playId: ++seq, requirePin: false, priority: PRIORITY.NORMAL });

const reasons = (results) => results.map((r) => r.reason);

beforeEach(() => {
  logs = [];
  seq = 0;
  at(0);
});

// --- urutan yang diminta, satu tes per baris -------------------------------

test("1. NORMAL t=0 -> NORMAL t=2: yang kedua dibuang min-interval", async () => {
  const ac = make();
  at(0);
  const a = await normal(ac);
  at(2_000);
  const b = await normal(ac);
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  assert.equal(b.reason, "min-interval");
});

test("2. NORMAL t=0 -> HIGH t=0.5: KEDUANYA terkirim", async () => {
  // Balasan FAQ tidak boleh membungkam pengumuman produk pertama.
  const ac = make();
  at(0);
  const a = await normal(ac);
  at(500);
  const b = await high(ac);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true, "alasan: " + b.reason);
});

test("3. NORMAL t=0 -> HIGH t=1.2: KEDUANYA terkirim", async () => {
  // Inilah celah yang ditutup. Dengan satu jam bersama dan ambang 1500 ms,
  // balasan produk pada t=1,2 detik akan hilang — dan latensi AutoPIN yang
  // teramati memang di sekitar angka itu.
  const ac = make();
  at(0);
  const a = await normal(ac);
  at(1_200);
  const b = await high(ac);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true, "alasan: " + b.reason);
});

test("4. NORMAL t=0 -> HIGH t=2: KEDUANYA terkirim", async () => {
  const ac = make();
  at(0);
  await normal(ac);
  at(2_000);
  assert.equal((await high(ac)).ok, true);
});

test("5. HIGH t=0 -> HIGH t=1: yang kedua dibuang min-interval-high", async () => {
  const ac = make();
  at(0);
  const a = await high(ac);
  at(1_000);
  const b = await high(ac);
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  assert.equal(b.reason, "min-interval-high", "kode alasannya harus khas prioritas tinggi");
});

test("6. HIGH t=0 -> HIGH t=2: KEDUANYA terkirim", async () => {
  const ac = make();
  at(0);
  assert.equal((await high(ac)).ok, true);
  at(2_000);
  assert.equal((await high(ac)).ok, true);
});

test("7. HIGH t=0 -> NORMAL t=2: NORMAL dibuang karena HIGH memperbarui lastAnySentAt", async () => {
  // Prioritas tidak boleh menjadi celah spam: kiriman high menahan FAQ
  // berikutnya selama lima detik PENUH.
  const ac = make();
  at(0);
  assert.equal((await high(ac)).ok, true);
  at(2_000);
  const b = await normal(ac);
  assert.equal(b.ok, false);
  assert.equal(b.reason, "min-interval");
});

test("7b. HIGH lalu NORMAL baru boleh bicara sesudah lima detik penuh", async () => {
  const ac = make();
  at(0);
  await high(ac);
  at(NORMAL_MS - 1);
  assert.equal((await normal(ac)).reason, "min-interval");
  at(NORMAL_MS);
  assert.equal((await normal(ac)).ok, true);
});

test("8. FAQ-only: perilakunya sama dengan limiter sebelum prioritas ada", async () => {
  // Jalur yang dilalui sebagian besar trafik. Jam high tidak pernah tersentuh,
  // jadi tidak ada satu pun keputusan yang berubah.
  const ac = make();
  const results = [];
  for (const t of [0, 1_000, 2_000, 4_999, 5_000, 6_000, 10_000]) {
    at(t);
    results.push(await normal(ac));
  }
  assert.deepEqual(reasons(results), [
    "dry-run",      // t=0     terkirim
    "min-interval", // t=1s
    "min-interval", // t=2s
    "min-interval", // t=4,999s  tepat sebelum ambang
    "dry-run",      // t=5s      tepat di ambang
    "min-interval", // t=6s
    "dry-run",      // t=10s
  ]);
  assert.equal(ac.__state().lastHighSentAt, -Infinity, "jam high tidak pernah bergerak");
});

test("9. maxPerMinute BERSAMA: prioritas tinggi tidak bisa melewati plafon per menit", async () => {
  const ac = make({ maxPerMinute: 3 });
  // Tiga kiriman high, masing-masing menghormati jeda high-nya sendiri.
  for (const t of [0, HIGH_MS, HIGH_MS * 2]) {
    at(t);
    assert.equal((await high(ac)).ok, true, "t=" + t);
  }
  assert.equal(ac.__state().sentInWindow, 3);
  // Yang keempat: jeda high sudah lewat, tapi plafonnya habis.
  at(HIGH_MS * 3);
  const fourth = await high(ac);
  assert.equal(fourth.ok, false);
  assert.equal(fourth.reason, "rate-limit", "plafon, bukan jeda");
  // Dan normal pun ikut terkena plafon yang sama.
  at(HIGH_MS * 3 + NORMAL_MS);
  assert.equal((await normal(ac)).reason, "rate-limit");
});

test("10. pin GAGAL: high tidak pernah sampai ke limiter, tidak mengirim, tidak memakai kuota", async () => {
  const ac = make();
  at(0);
  const r = await high(ac, PIN_FAILED);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "product-not-found", "ditolak gerbang pin, bukan limiter");
  const s = ac.__state();
  assert.equal(s.sentInWindow, 0, "kuota tidak terbakar");
  assert.equal(s.lastAnySentAt, -Infinity);
  assert.equal(s.lastHighSentAt, -Infinity, "jam high tidak boleh bergerak tanpa bukti pin");
  // Dan karena kuotanya utuh, balasan FAQ sesudahnya tetap bisa bicara.
  at(100);
  assert.equal((await normal(ac)).ok, true);
});

test("10b. pin DRY-RUN tidak dianggap bukti: high tetap dibungkam", async () => {
  const ac = make();
  at(0);
  const r = await high(ac, { ok: true, reason: "dry-run", dryRun: true, clicked: false });
  assert.equal(r.ok, false);
  assert.equal(ac.__state().lastHighSentAt, -Infinity);
});

test("11. stale dan duplikat tetap berlaku untuk prioritas tinggi", async () => {
  const ac = make();
  at(0);
  assert.equal((await ac.requestComment({ scene: "PAX-1", playId: 5, pin: PIN_CONFIRMED, requirePin: true, priority: PRIORITY.HIGH })).ok, true);

  // playId yang lebih lama = sisa pemutaran yang sudah tidak tayang.
  at(5_000);
  const stale = await ac.requestComment({ scene: "PAX-1", playId: 4, pin: PIN_CONFIRMED, requirePin: true, priority: PRIORITY.HIGH });
  assert.equal(stale.reason, "stale");

  // playId yang sama = satu scene-start yang sama, bukan pemutaran baru.
  at(10_000);
  const dup = await ac.requestComment({ scene: "PAX-1", playId: 5, pin: PIN_CONFIRMED, requirePin: true, priority: PRIORITY.HIGH });
  assert.equal(dup.reason, "duplicate-playId");
});

// --- prioritas tidak boleh menjadi jalan memutari gerbang pin --------------

test("PAGAR: high TANPA requirePin diturunkan menjadi normal, bukan dihormati", async () => {
  // Kalau ini longgar, pemanggil bisa meminta keringanan jeda sekaligus meminta
  // gerbang pin dilewati — persis pembobolan yang tidak boleh ada jalannya.
  const ac = make();
  at(0);
  assert.equal((await normal(ac)).ok, true);

  at(500);
  const sneaky = await ac.requestComment({
    scene: "FAQ-HARGA", playId: ++seq, requirePin: false, priority: PRIORITY.HIGH,
  });
  assert.equal(sneaky.ok, false);
  assert.equal(sneaky.reason, "min-interval", "diperlakukan sebagai normal");
  assert.ok(logs.some((l) => l.includes("[AUTOCOMMENT_PRIORITY_DOWNGRADED]")), logs.join("\n"));
  assert.equal(ac.__state().lastHighSentAt, -Infinity, "jam high tidak boleh bergerak");
});

test("PAGAR: saklar global mati mengalahkan prioritas apa pun", async () => {
  const ac = make({ enabled: false });
  at(0);
  const r = await high(ac);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "disabled");
  assert.equal(ac.__state().sentInWindow, 0);
});

test("PAGAR: prioritas yang tidak dikenal diperlakukan sebagai normal", async () => {
  // Default yang aman: hanya string "high" yang persis memberi keringanan.
  const ac = make();
  at(0);
  await normal(ac);
  for (const p of [undefined, null, "HIGH", "urgent", 1, true]) {
    at(1_000);
    const r = await ac.requestComment({ scene: "PAX-1", playId: ++seq, pin: PIN_CONFIRMED, requirePin: true, priority: p });
    assert.equal(r.reason, "min-interval", "priority=" + JSON.stringify(p));
  }
});

// --- diagnostik -------------------------------------------------------------

test("__state melaporkan kedua jam secara terpisah", async () => {
  const ac = make();
  at(0);
  await normal(ac);
  let s = ac.__state();
  assert.equal(s.lastAnySentAt, 1_000_000, "kiriman normal memperbarui jam bersama");
  assert.equal(s.lastHighSentAt, -Infinity, "dan TIDAK memperbarui jam high");

  at(2_000);
  await high(ac);
  s = ac.__state();
  assert.equal(s.lastAnySentAt, 1_002_000, "kiriman high memperbarui KEDUANYA");
  assert.equal(s.lastHighSentAt, 1_002_000);
  assert.equal(s.highMinIntervalMs, HIGH_MS);
  assert.equal(s.minIntervalMs, NORMAL_MS);
});

test("kode alasan tetap tiga, dan khas", async () => {
  // min-interval / min-interval-high / rate-limit. Kalau suatu saat ada yang
  // menyatukan dua yang pertama, perbedaan sebabnya hilang dari log dukungan.
  const ac = make({ maxPerMinute: 1 });
  at(0);
  await high(ac);
  at(100);
  assert.equal((await high(ac)).reason, "min-interval-high");
  assert.equal((await normal(ac)).reason, "min-interval");
  at(HIGH_MS * 2);
  assert.equal((await high(ac)).reason, "rate-limit");
});

// --- nilai bawaan -----------------------------------------------------------

test("bawaan: jeda high lebih pendek daripada jeda normal", () => {
  assert.ok(HIGH_MS > 0, "nol berarti ledakan balasan tanpa lantai");
  assert.ok(HIGH_MS < NORMAL_MS, "kalau tidak, prioritas tidak berarti apa-apa");
  assert.equal(make().__state().highMinIntervalMs, HIGH_MS);
});

test("PAGAR: jeda high BUKAN permukaan config maupun environment", () => {
  // Keputusan sadar, dan tes ini yang menjaganya.
  //
  // Knob environment untuk nilai ini tidak akan pernah sampai ke bot terpaket:
  // controller/process-manager.js membentuk environment anak PENUH, dan hanya
  // lima variabel AUTOCOMMENT_* yang diteruskan toEnv(). Knob yang tidak
  // bekerja lebih buruk daripada tidak ada knob — operator mengubahnya, tidak
  // ada yang berubah, dan tidak ada apa pun yang menjelaskan kenapa.
  //
  // Jadi kalau suatu saat ada yang menambahkannya kembali, ia harus menambahkan
  // jalur propagasinya SEKALIGUS — dan tes ini akan merah lebih dulu.
  const { loadConfig } = require("../autocomment/config");
  const cfg = loadConfig({ AUTOCOMMENT_HIGH_MIN_INTERVAL_MS: "9999" });
  assert.equal("highMinIntervalMs" in cfg, false, "jangan jadikan ini permukaan config");

  // toEnv() tidak MEMBENTUK variabel itu. (toEnv memang meneruskan apa pun yang
  // ada di `base` — `base` itulah daftar izinnya, dan isinya diputuskan
  // controller.js, bukan di sini.)
  const { toEnv, defaultConfig } = require("../controller/config-manager");
  const c = defaultConfig();
  c.tiktok.username = "u";
  const env = toEnv(c);
  assert.equal("AUTOCOMMENT_HIGH_MIN_INTERVAL_MS" in env, false, "toEnv tidak boleh membentuknya");

  // Dan basis env anak di controller.js memang sempit: hanya PATH, SystemRoot,
  // dan saklar headless. Dibaca dari SUMBERNYA, pola yang sama dengan
  // test/browser.mode.test.js, karena yang dijaga di sini adalah keputusan yang
  // tertulis di sana.
  // Akhiran baris dinormalkan: core.autocrlf=true membuat berkas kerja CRLF
  // sementara jangkar di bawah memakai "\n". Tanpa ini indexOf() mengembalikan
  // -1 dan sayatannya menjadi hampir seluruh berkas — pagar yang lolos karena
  // kebetulan, bukan karena isinya benar.
  const src = require("node:fs")
    .readFileSync(require.resolve("../controller/controller.js"), "utf8")
    .replace(/\r\n/g, "\n");
  const from = src.indexOf("const env = toEnv(config, {");
  const to = src.indexOf("paths,\n    });");
  assert.ok(from !== -1 && to > from, "jangkar basis env anak harus ada");
  const base = src.slice(from, to);
  assert.ok(base.includes("PATH: process.env.PATH"), "basis env anak tidak boleh berubah bentuk");
  assert.ok(!base.includes("AUTOCOMMENT_HIGH"), "jangan selundupkan knob ini ke basis env anak");
});

test("bawaan: produksi memakai bawaan internal, tanpa dioper dari mana pun", () => {
  // createAutoComment() tanpa opsi apa pun — bentuk yang dipakai index.js.
  assert.equal(createAutoComment().__state().highMinIntervalMs, HIGH_MS);
  assert.equal(HIGH_MS, 1_500);
});

test("jeda high boleh dimatikan lewat nol, dan plafon per menit tetap menjaga", async () => {
  // Bukan rekomendasi, tapi perilakunya harus tetap terdefinisi: tanpa lantai,
  // yang membatasi ledakan hanya maxPerMinute.
  const ac = make({ highMinIntervalMs: 0, maxPerMinute: 2 });
  at(0);
  assert.equal((await high(ac)).ok, true);
  assert.equal((await high(ac)).ok, true, "tanpa lantai, berurutan pun lolos");
  assert.equal((await high(ac)).reason, "rate-limit", "dan plafonnya yang menahan");
});
