// PRIORITAS: aturan terkonfigurasi SELALU menang atas Product Q&A.
//
// Yang diuji di sini bukan modul Q&A sendiri — itu ada di qa.pipeline.test.js.
// Yang diuji di sini adalah handleChat() PRODUKSI di index.js: urutan lapisnya,
// dan fakta bahwa komentar yang sudah diklaim sebuah aturan TIDAK PERNAH
// mencapai Q&A.
//
// Config runtime sintetis memuat trigger PAX *dan* trigger FAQ, supaya
// "cara order tetap FAQ" bisa dibuktikan — bukan diasumsikan. Pada config
// customer hari ini scene FAQ memang belum dipetakan (lihat
// docs/dynamic-product-qa-design-v0.3.0.md §2), jadi tanpa config sintetis
// klaim itu tidak bisa diuji sama sekali.
//
// 100% offline: obs.call di-stub, AutoPIN/AutoComment/Q&A diganti palsu lewat
// hook __test yang sudah ada. Nol TikTok, nol OBS, nol browser.

const { test, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const { buildRuntimeConfig, writeRuntimeConfig, RUNTIME_CONFIG_ENV } = require("../runtime/runtime-config");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ailive-qa-"));

// Trigger PAX + trigger FAQ. FAQ ORDER / FAQ JAWAB AI / BOIKOT AI dipetakan di
// sini SEBAGAI ATURAN TANPA SCENE (switchScene dimatikan) supaya mereka masuk
// indeks matcher tanpa menuntut detail pemutaran.
const MAPPINGS = [
  { scene: "PAX-1", product: { title: "Garuda - Kacang ATOM 16gr 1 RENCENG ISI 10 PCS oat - GRD" }, triggers: ["spill etalase 1"], reply: "Etalase 1 sudah aku pin ya kak" },
  { scene: "PAX-2", product: { title: "GARUDA TING TING PEANUT BAR CANDY ISI 12" }, triggers: ["no 2"], reply: "Etalase 2 sudah aku pin ya kak" },
  { scene: "PAX-3", product: { title: "Gery Saluut Malkist Renceng - Netto 10 bks x 18 gr" }, triggers: ["et 3"], reply: "Etalase 3 sudah aku pin ya kak" },
  { scene: "FAQ ORDER", product: null, triggers: ["cara order"], reply: "Cara ordernya klik keranjang ya kak", actions: { switchScene: false, autoPin: false, autoReply: true } },
  { scene: "FAQ JAWAB AI", product: null, triggers: ["ini ai ya"], reply: "Aku host AI kak", actions: { switchScene: false, autoPin: false, autoReply: true } },
  { scene: "BOIKOT AI", product: null, triggers: ["boikot ai"], reply: "Yuk tetap dukung produk lokal kak", actions: { switchScene: false, autoPin: false, autoReply: true } },
];

const artifact = buildRuntimeConfig({ mappings: MAPPINGS, configVersion: 1 });
const FILE = path.join(TMP, "runtime-" + artifact.id + ".json");
assert.equal(writeRuntimeConfig(FILE, artifact).ok, true);
process.env[RUNTIME_CONFIG_ENV] = FILE;
process.env.DOTENV_CONFIG_QUIET = "true";

const bot = require("../index.js");

// --- palsu -----------------------------------------------------------------
let matched = [];   // scene yang di-enqueue lapis aturan
let qaCalls = [];   // pesan yang SAMPAI ke Q&A

let logs = [];

beforeEach(() => {
  matched = [];
  qaCalls = [];
  logs = [];
  // handleChat PRODUKSI banyak mencetak. Dibiarkan lolos, keluarannya
  // membanjiri IPC node:test dan berkas tes ini gagal dimuat seluruhnya.
  const capture = (...args) => logs.push(args.map(String).join(" "));
  mock.method(console, "log", capture);
  mock.method(console, "warn", capture);
  mock.method(console, "error", capture);
  bot.obs.call = async () => ({});
  bot.__test.setScenePin({ requestPin: async () => ({ ok: true, reason: "pinned" }) });
  bot.__test.setAutoComment({ requestComment: async () => ({ ok: true, reason: "sent" }) });
  // Q&A palsu: HANYA mencatat. Kalau sebuah komentar milik aturan sampai ke
  // sini, berarti urutan lapisnya rusak.
  bot.__test.setPriceQa({
    QA_SCENE: "QA-PRICE",
    // precheck meneruskan SEMUA komentar ke handle(), supaya tes ini mengukur
    // urutan lapis - bukan apakah intent harganya kebetulan cocok.
    precheck: () => ({ price: true, reason: "fake-cue", words: [], number: null }),
    handle: async ({ msgNorm }) => { qaCalls.push(msgNorm); return { handled: false, reason: "fake" }; },
  });
  bot.__test.reset && bot.__test.reset();
});

const chat = (comment) => bot.handleChat({ nickname: "penonton", comment });
const flush = () => new Promise((r) => setImmediate(r));

// --- aturan terkonfigurasi MENANG -----------------------------------------

test("prioritas: trigger PAX berhenti di lapis aturan, Q&A tidak pernah dipanggil", async () => {
  for (const t of ["spill etalase 1", "no 2", "et 3"]) {
    qaCalls = [];
    chat(t);
    await flush();
    assert.deepEqual(qaCalls, [], `"${t}" milik aturan: Q&A tidak boleh melihatnya`);
  }
});

test("prioritas: trigger FAQ tetap FAQ, Q&A tidak pernah dipanggil", async () => {
  // Inilah yang tidak bisa dibuktikan pada config customer hari ini, karena
  // scene FAQ-nya belum dipetakan.
  for (const t of ["cara order", "ini ai ya", "boikot ai"]) {
    qaCalls = [];
    chat(t);
    await flush();
    assert.deepEqual(qaCalls, [], `"${t}" milik aturan FAQ: Q&A tidak boleh melihatnya`);
  }
});

test("prioritas: SETIAP trigger di config tidak pernah mencapai Q&A", async () => {
  // Bukan daftar contoh - SELURUH trigger yang ada di config.
  const semua = MAPPINGS.flatMap((m) => m.triggers);
  assert.ok(semua.length >= 6);
  for (const t of semua) {
    qaCalls = [];
    chat(t);
    await flush();
    assert.deepEqual(qaCalls, [], `trigger "${t}" bocor ke Q&A`);
  }
});

test("prioritas: varian typo yang masih cocok fuzzy juga berhenti di lapis aturan", async () => {
  for (const t of ["spill etalse 1", "cara belii order"]) {
    qaCalls = [];
    chat(t);
    await flush();
    assert.deepEqual(qaCalls, [], `"${t}" cocok fuzzy: Q&A tidak boleh melihatnya`);
  }
});

// --- Q&A dipanggil HANYA di jalur jatuh-bawah -----------------------------

test("prioritas: komentar yang TIDAK cocok aturan mana pun diteruskan ke Q&A", async () => {
  chat("harga garuda atom berapa");
  await flush();
  assert.deepEqual(qaCalls, ["harga garuda atom berapa"]);
});

test("prioritas: Q&A menerima teks yang SUDAH dinormalkan", async () => {
  chat("Harga Garuda ATOM Berapa???");
  await flush();
  assert.deepEqual(qaCalls, ["harga garuda atom berapa"]);
});

test("prioritas: komentar yang dibungkam gerbang spam tidak mencapai Q&A", async () => {
  // Gerbang spam ada SEBELUM kedua lapis aturan, jadi ia juga melindungi Q&A.
  for (let i = 0; i < 12; i += 1) bot.handleChat({ nickname: "spammer", comment: "harga garuda atom berapa" });
  await flush();
  assert.ok(qaCalls.length < 12, `dibungkam setelah ${qaCalls.length} pesan`);
});

// --- PAGAR TINGKAT SUMBER --------------------------------------------------

test("PAGAR: pemanggilan Q&A berada SESUDAH kedua return lapis aturan", () => {
  // Inilah yang membuat prioritas berlaku permanen: urutan kode, bukan daftar
  // pengecualian yang harus dirawat.
  const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const mulai = src.indexOf("function handleChat");
  assert.ok(mulai > 0);
  const akhir = src.indexOf("\n}", src.indexOf("priceQa.handle", mulai));
  const blok = src.slice(mulai, akhir);

  const iPhrase = blok.indexOf("matchPhrase(");
  const iFuzzy = blok.indexOf("matchFuzzy(");
  const iQa = blok.indexOf("priceQa.handle");
  assert.ok(iPhrase > 0, "matchPhrase harus ada di handleChat");
  assert.ok(iFuzzy > iPhrase, "matchFuzzy harus sesudah matchPhrase");
  assert.ok(iQa > iFuzzy, "Q&A harus sesudah matchFuzzy");

  // dan kedua lapis aturan harus `return` sebelum baris Q&A
  const sebelumQa = blok.slice(0, iQa);
  const returns = (sebelumQa.match(/\n    return;/g) || []).length;
  assert.ok(returns >= 2, `harus ada minimal dua return sebelum Q&A, ada ${returns}`);
});

test("PAGAR: Q&A tidak dipanggil dari tempat lain mana pun", () => {
  // Dihitung atas KODE, bukan prosa: komentar di titik sisip menyebut
  // priceQa.handle() untuk menjelaskan kenapa .catch() ada di sana.
  const kode = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  const panggilan = (kode.match(/priceQa\.handle/g) || []).length;
  assert.equal(panggilan, 1, "tepat satu titik pemanggilan");
});

test("PAGAR: matcher global TIDAK diubah oleh v0.3.0", () => {
  // Tidak melemahkan, tidak mengubah ambang, tidak menyisipkan apa pun.
  const { DEFAULT_THRESHOLD, DEFAULT_BUDGET_CELLS } = require("../tiktok/matcher");
  assert.equal(DEFAULT_THRESHOLD, 0.55);
  assert.equal(DEFAULT_BUDGET_CELLS, 60_000);
  const src = fs.readFileSync(path.join(__dirname, "..", "tiktok", "matcher.js"), "utf8");
  assert.ok(!src.includes("qa/"), "matcher tidak boleh tahu apa pun soal Q&A");
  assert.ok(!src.includes("priceQa"), "matcher tidak boleh tahu apa pun soal Q&A");
});

test("PAGAR: pagar angka v0.2.1 masih utuh", () => {
  const { buildMatcherIndex, matchFuzzy, numericIdentity } = require("../tiktok/matcher");
  const { normalizeForMatching } = require("../tiktok/normalize");
  assert.equal(typeof numericIdentity, "function");
  const idx = buildMatcherIndex([{ scene: "PAX-1", keywords: ["spill etalase 1"] }], { normalize: normalizeForMatching });
  assert.equal(matchFuzzy(idx, "spill etalase 2", { threshold: 0.55 }).rule, null);
  assert.ok(matchFuzzy(idx, "spill etalse 1", { threshold: 0.55 }).rule, "typo tetap kena");
});

test("PAGAR: handleChat memakai gerbang SINKRON sebelum jalur async Q&A", async () => {
  // Mutasi yang menghapus gerbang ini TIDAK tertangkap oleh test/load.soak
  // (heap 7,7 MB masih di bawah ambang 10 MB), jadi pagarnya harus di sini.
  //
  // Biaya yang dijaga: tanpa gerbang sinkron, SETIAP komentar LIVE yang tidak
  // cocok aturan mengalokasikan rantai promise hanya untuk ditolak.
  const kode = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  const iPre = kode.indexOf("priceQa.precheck");
  const iHandle = kode.indexOf("priceQa.handle");
  assert.ok(iPre > 0, "handleChat harus memakai precheck()");
  assert.ok(iHandle > iPre, "handle() harus SESUDAH precheck()");
  // dan harus ada return di antaranya, supaya yang bukan harga berhenti
  const antara = kode.slice(iPre, iHandle);
  assert.match(antara, /return;/, "komentar non-harga harus berhenti sebelum jalur async");

  // dibuktikan juga secara perilaku: precheck ASLI menolak, handle tidak dipanggil
  const { createPriceQa } = require("../qa/price-qa");
  const asli = createPriceQa({ readProducts: async () => ({ ok: false }), requestComment: async () => ({ ok: true }) });
  let dipanggil = 0;
  bot.__test.setPriceQa({
    QA_SCENE: "QA-PRICE",
    precheck: (m) => asli.precheck(m),
    handle: async () => { dipanggil += 1; return { handled: false }; },
  });
  chat("mantap kak banget");
  chat("halo kak nanya ongkir");
  await flush();
  assert.equal(dipanggil, 0, "komentar non-harga tidak boleh masuk jalur async");

  chat("harga garuda atom berapa");
  await flush();
  assert.equal(dipanggil, 1, "pertanyaan harga tetap masuk");
});
