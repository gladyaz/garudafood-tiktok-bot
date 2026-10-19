// Resolver produk + kalimat jawaban + jeda per-produk Product Q&A.
//
// Fixture katalog adalah SNAPSHOT NYATA dari LIVE 2026-10-19, diambil apa
// adanya dari GET /products aplikasi terpasang v0.2.2 (coverage=full,
// source=pin-collect). Tiruan yang bentuknya dikarang pernah meloloskan tiga
// bug sekaligus; di sini tidak ada satu pun nilai yang saya karang.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { resolveProductForQuestion, productIdentity } = require("../qa/resolve-product");
const { buildPriceReply, TEMPLATE } = require("../qa/reply-price");
const { createQaDedupe, DEFAULT_COOLDOWN_MS } = require("../qa/dedupe");
const { detectPriceIntent } = require("../qa/intent-price");
const { normalizeForMatching } = require("../tiktok/normalize");
const { MAX_LENGTH } = require("../autocomment/formatter");

const PRODUK = [
  { title: "Garuda - Kacang ATOM 16gr 1 RENCENG ISI 10 PCS oat - GRD", number: 1, stableId: null, currentPriceText: "Rp14.299", originalPriceText: "Rp23.000", priceRangeText: "", priceState: "sale", stockText: "In stock: 863", pinText: "Pin", pinAvailable: true, pinDisabled: false, price: "Rp14.299", stock: "In stock: 863" },
  { title: "GARUDA TING TING PEANUT BAR CANDY ISI 12", number: 2, stableId: null, currentPriceText: "Rp30.000", originalPriceText: "", priceRangeText: "", priceState: "single", stockText: "Low stock: 10", pinText: "Pin", pinAvailable: true, pinDisabled: false, price: "Rp30.000", stock: "Low stock: 10" },
  { title: "[COD AFF] Gery - Gery Saluut Malkist Family Pack (100gr) [PILIH VARIAN RASA] - GRY", number: 3, stableId: null, currentPriceText: "Rp25.500", originalPriceText: "Rp49.999", priceRangeText: "", priceState: "sale", stockText: "In stock: 572", pinText: "Pin", pinAvailable: true, pinDisabled: false, price: "Rp25.500", stock: "In stock: 572" },
  { title: "Gery Saluut Malkist Renceng - Netto 10 bks x 18 gr", number: 4, stableId: null, currentPriceText: "Rp15.015", originalPriceText: "", priceRangeText: "", priceState: "single", stockText: "In stock: 34", pinText: "Pin", pinAvailable: true, pinDisabled: false, price: "Rp15.015", stock: "In stock: 34" },
  { title: "[COD] Dilan - Snack Oat Crunch Chocolate & Crunchy Caramel Mini Pack 25pcs – Pilih Varian | Snack Oat | Cemilan Crunchy …", number: 5, stableId: null, currentPriceText: "Rp15.900", originalPriceText: "Rp65.956", priceRangeText: "", priceState: "sale", stockText: "In stock: 73", pinText: "Pin", pinAvailable: true, pinDisabled: false, price: "Rp15.900", stock: "In stock: 73" },
];

const FULL = (products = PRODUK) => ({ ok: true, capturedAt: 1_000_000, ageMs: 500, coverage: "full", source: "pin-collect", products });
const VIEWPORT = (products = PRODUK) => ({ ok: true, capturedAt: 1_000_000, ageMs: 500, coverage: "viewport", source: "refresh", products });

// Jalur yang sama dengan produksi: normalisasi -> intent -> resolver.
function resolveDari(teks, snapshot = FULL()) {
  const norm = normalizeForMatching(String(teks).toLowerCase().trim());
  const intent = detectPriceIntent(norm);
  return resolveProductForQuestion(snapshot, { words: intent.words, number: intent.number });
}

// --- resolusi yang HARUS berhasil -----------------------------------------

test("resolver: contoh yang harus terjawab dari desain", () => {
  const harus = {
    "harga garuda atom berapa": 1,
    "garuda kacangnya berapa kak": 1,
    "harga garuda kacang": 1,
    "gery saluut family pack berapa": 3,
    "berapa yang nomor 1": 1,
    "harga produk nomor 2": 2,
  };
  for (const [teks, nomor] of Object.entries(harus)) {
    const r = resolveDari(teks);
    assert.equal(r.ok, true, `${teks} harus ter-resolve (${r.reason})`);
    assert.equal(r.product.number, nomor, teks);
  }
});

test("resolver: nomor eksplisit memakai jalur visible-number", () => {
  assert.equal(resolveDari("berapa yang nomor 1").via, "visible-number");
  assert.equal(resolveDari("harga produk nomor 2").via, "visible-number");
  assert.equal(resolveDari("harga garuda kacang").via, "title-tokens");
});

// --- ambiguitas SELALU ditolak -------------------------------------------

test("resolver: contoh ambigu dari desain ditolak, tanpa memilih siapa pun", () => {
  for (const teks of ["garuda berapa", "berapa harga garuda", "gery saluut berapa", "brp gery saluut"]) {
    const r = resolveDari(teks);
    assert.equal(r.ok, false, `${teks} harus ambigu`);
    assert.equal(r.reason, "ambiguous-product", teks);
    assert.equal(r.product, undefined, `${teks} tidak boleh membawa produk`);
    assert.ok(r.count >= 2, teks);
  }
});

test("resolver: dua produk Gery Saluut memang ada di katalog nyata", () => {
  // Bukti bahwa ambiguitas di atas nyata, bukan artefak fixture.
  const gery = PRODUK.filter((p) => /gery saluut/i.test(p.title));
  assert.equal(gery.length, 2);
  assert.deepEqual(gery.map((p) => p.number), [3, 4]);
});

test("resolver: mempersempit menyelesaikan ambiguitas", () => {
  assert.equal(resolveDari("gery saluut renceng berapa").product.number, 4);
  assert.equal(resolveDari("gery saluut family pack berapa").product.number, 3);
  assert.equal(resolveDari("garuda ting ting berapa").product.number, 2);
});

test("resolver: tidak ketemu -> product-not-found", () => {
  const r = resolveDari("yang dalezz harganya berapa");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "product-not-found");
});

test("resolver: tanpa rujukan produk -> no-product-reference", () => {
  for (const t of ["harga berapa", "berapa kak"]) {
    const r = resolveDari(t);
    assert.equal(r.ok, false, t);
    assert.equal(r.reason, "no-product-reference", t);
  }
});

// --- COVERAGE: asimetri yang wajib --------------------------------------

test("coverage: resolusi JUDUL menolak snapshot viewport", () => {
  // Pada viewport, produk kedua yang cocok bisa di bawah lipatan: "ambigu"
  // akan berubah diam-diam menjadi "unik" dan kita mengutip produk yang SALAH.
  const r = resolveDari("harga garuda kacang", VIEWPORT());
  assert.equal(r.ok, false);
  assert.equal(r.reason, "coverage-insufficient");
  assert.equal(r.coverage, "viewport");
});

test("coverage: resolusi NOMOR eksplisit BOLEH pada viewport", () => {
  const r = resolveDari("berapa yang nomor 1", VIEWPORT());
  assert.equal(r.ok, true);
  assert.equal(r.via, "visible-number");
  assert.equal(r.product.number, 1);
});

test("coverage: nomor yang tidak terlihat di viewport BUKAN product-not-found", () => {
  // Ketidakhadiran dari snapshot sebagian bukan bukti produk itu tidak ada.
  const sebagian = VIEWPORT(PRODUK.slice(0, 2)); // hanya #1 dan #2 ter-render
  const r = resolveProductForQuestion(sebagian, { number: 5 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "coverage-insufficient");
  assert.notEqual(r.reason, "product-not-found");
});

test("coverage: pada FULL, nomor di luar katalog memang tidak ada", () => {
  const r = resolveProductForQuestion(FULL(), { number: 9 });
  assert.equal(r.reason, "number-not-in-catalogue");
});

test("coverage: judul BOLEH pada full", () => {
  assert.equal(resolveProductForQuestion(FULL(), { words: ["garuda", "kacang"] }).ok, true);
});

// --- urutan identitas ----------------------------------------------------

test("identitas: stableId diutamakan di atas judul", () => {
  const dengan = PRODUK.map((p, i) => ({ ...p, stableId: `sku-${i + 1}` }));
  const r = resolveProductForQuestion(FULL(dengan), { stableId: "sku-3" });
  assert.equal(r.ok, true);
  assert.equal(r.via, "stableId");
  assert.equal(r.product.number, 3);
});

test("identitas: stableId yang tidak ada TIDAK jatuh ke judul", () => {
  const dengan = PRODUK.map((p, i) => ({ ...p, stableId: `sku-${i + 1}` }));
  const r = resolveProductForQuestion(FULL(dengan), { stableId: "sku-99", words: ["garuda", "kacang"] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "product-not-found");
});

test("identitas: nomor TIDAK PERNAH jadi identitas dedupe", () => {
  // Nomor bergeser sesudah pin; kunci yang bergeser berarti produk yang sama
  // bisa dijawab dua kali.
  const p = PRODUK[0];
  const id = productIdentity(p);
  assert.ok(id.startsWith("title:"), id);
  // nomor berubah -> identitas TETAP. Inilah pembuktiannya; mencari digit di
  // dalam kunci tidak sah, karena judulnya sendiri memuat angka ("16gr").
  assert.equal(productIdentity({ ...p, number: 4 }), id);
  assert.equal(productIdentity({ ...p, number: 99 }), id);
  // judul berubah -> identitas berubah
  assert.notEqual(productIdentity({ ...p, title: "Produk Lain" }), id);
});

test("identitas: stableId dipakai kalau ada", () => {
  assert.equal(productIdentity({ title: "A", stableId: "sku-7" }), "id:sku-7");
  assert.equal(productIdentity({ title: "" }), "");
  assert.equal(productIdentity(null), "");
});

test("resolver: nomor ganda di snapshot -> ambiguous-number", () => {
  const kembar = [PRODUK[0], { ...PRODUK[1], number: 1 }];
  const r = resolveProductForQuestion(FULL(kembar), { number: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "ambiguous-number");
});

test("resolver: katalog kosong -> catalogue-empty", () => {
  assert.equal(resolveProductForQuestion(FULL([]), { words: ["garuda"] }).reason, "catalogue-empty");
  assert.equal(resolveProductForQuestion(null, { words: ["garuda"] }).reason, "catalogue-empty");
});

test("resolver: produk yang tidak bisa di-pin tetap bisa ditanyakan", () => {
  const habis = PRODUK.map((p) => ({ ...p, pinAvailable: false, pinDisabled: true, pinText: "" }));
  const r = resolveProductForQuestion(FULL(habis), { words: ["garuda", "kacang"] });
  assert.equal(r.ok, true);
});

test("resolver: memakai normalizeTitleKey yang DIIMPOR", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "qa", "resolve-product.js"), "utf8");
  assert.ok(/require\(["']\.\.\/autopin\/core["']\)/.test(src), "harus mengimpor dari autopin/core");
  assert.ok(!src.includes("NFKC"), "tidak boleh menormalkan judul sendiri");
  assert.ok(!src.includes("toLowerCase"), "tidak boleh menormalkan judul sendiri");
});

// --- kalimat jawaban -----------------------------------------------------

test("balasan: kalimat yang disetujui, dan panjangnya aman", () => {
  const r = buildPriceReply(PRODUK[0]);
  assert.equal(r.ok, true);
  assert.equal(r.text, "Harga yang tampil di etalase saat ini Rp14.299 ya kak 😊");
  assert.ok(r.text.length <= MAX_LENGTH, `${r.text.length} <= ${MAX_LENGTH}`);
});

test("balasan: kelima produk nyata menghasilkan kalimat yang lolos gerbang", () => {
  for (const p of PRODUK) {
    const r = buildPriceReply(p);
    assert.equal(r.ok, true, p.title);
    assert.ok(r.text.includes(p.currentPriceText), p.title);
    assert.ok(r.text.length <= MAX_LENGTH, `${p.number}: ${r.text.length}`);
  }
});

test("balasan: TIDAK PERNAH menyebut originalPriceText", () => {
  // Produk #1 sedang diskon dan kedua angkanya tersedia & benar. v0.3.0 hanya
  // menyebut harga sekarang.
  const r = buildPriceReply(PRODUK[0]);
  assert.ok(!r.text.includes("Rp23.000"), "harga pembanding tidak boleh ikut");
  for (const p of PRODUK) {
    if (!p.originalPriceText) continue;
    assert.ok(!buildPriceReply(p).text.includes(p.originalPriceText), p.title);
  }
});

test("balasan: TIDAK mengklaim kepastian", () => {
  const r = buildPriceReply(PRODUK[0]);
  for (const kata of ["pasti", "dijamin", "fix", "tetap"]) {
    assert.ok(!r.text.toLowerCase().includes(kata), `tidak boleh mengklaim "${kata}"`);
  }
  assert.match(r.text, /tampil/, "harus menyebut bahwa ini yang TAMPIL");
  assert.match(r.text, /saat ini/, "harus menyebut bahwa ini keadaan SAAT INI");
});

test("balasan: priceState tak terdukung -> TIDAK ada kalimat", () => {
  for (const st of ["unknown", "range", "", undefined, "SINGLE"]) {
    const r = buildPriceReply({ ...PRODUK[0], priceState: st });
    assert.equal(r.ok, false, String(st));
    assert.match(r.reason, /^price-state-/, String(st));
  }
});

test("balasan: currentPriceText kosong -> TIDAK ada kalimat", () => {
  for (const v of ["", "   ", null, undefined, 14299]) {
    const r = buildPriceReply({ ...PRODUK[0], currentPriceText: v });
    assert.equal(r.ok, false, String(v));
    assert.equal(r.reason, "empty-price");
  }
});

test("balasan: TIDAK ada cadangan ke price legacy", () => {
  // `price` legacy sengaja tetap terisi walau priceState unknown (v0.2.2).
  // Jalur kutipan tidak boleh pernah memakainya.
  const r = buildPriceReply({ ...PRODUK[0], priceState: "unknown", currentPriceText: "", price: "Rp14.299" });
  assert.equal(r.ok, false);
  const src = fs.readFileSync(path.join(__dirname, "..", "qa", "reply-price.js"), "utf8");
  assert.ok(!/\bp\.price\b/.test(src), "tidak boleh membaca field price legacy");
  assert.ok(!src.includes("originalPriceText") || /TIDAK|tidak/.test(src), "originalPriceText hanya boleh disebut di komentar");
});

test("balasan: gerbang teks DIIMPOR, bukan ditulis ulang", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "qa", "reply-price.js"), "utf8");
  assert.ok(/require\(["']\.\.\/autocomment\/formatter["']\)/.test(src));
  assert.ok(!src.includes("MAX_LENGTH ="), "tidak boleh punya batas panjang sendiri");
  assert.ok(!src.includes("[<>]"), "tidak boleh punya gerbang HTML sendiri");
});

test("balasan: template yang terlalu panjang DITOLAK, bukan dipotong", () => {
  const r = buildPriceReply(PRODUK[0], { template: "x".repeat(120) + " {price}" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "too-long");
});

test("balasan: template wajib punya {price}", () => {
  assert.equal(buildPriceReply(PRODUK[0], { template: "tanpa placeholder" }).reason, "invalid-template");
  assert.ok(TEMPLATE.includes("{price}"));
});

test("balasan: teks penonton tidak pernah bisa masuk", () => {
  // Kalimatnya dibangun dari template + currentPriceText saja. Tidak ada jalur
  // yang menerima teks penonton.
  // Diperiksa pada PARAMETER dan pemakaiannya, bukan dengan mencari kata di
  // seluruh teks: "comment" muncul di dalam require("../autocomment/formatter")
  // yang sah, dan pencarian kata akan salah menuduhnya.
  const src = fs.readFileSync(path.join(__dirname, "..", "qa", "reply-price.js"), "utf8");
  for (const t of ["msgNorm", "msgRaw", "nickname", "viewerText"]) {
    assert.ok(!src.includes(t), `${t} tidak boleh ada di pembentuk kalimat`);
  }
  // Satu-satunya masukannya adalah produk + template: teksnya SELALU sama
  // dengan template yang diisi currentPriceText, apa pun yang penonton tulis.
  const r = buildPriceReply(PRODUK[0]);
  assert.equal(r.text, TEMPLATE.split("{price}").join(PRODUK[0].currentPriceText));
});

// --- jeda per-produk -----------------------------------------------------

test("dedupe: jeda 30 detik, meluncur", () => {
  assert.equal(DEFAULT_COOLDOWN_MS, 30_000);
});

test("dedupe: kunci adalah intent + identitas produk", () => {
  let t = 0;
  const d = createQaDedupe({ now: () => t });
  const a = productIdentity(PRODUK[0]);
  const b = productIdentity(PRODUK[1]);
  assert.equal(d.allow("PRICE", a).ok, true);
  d.note("PRICE", a);
  assert.equal(d.allow("PRICE", a).ok, false, "produk sama -> ditahan");
  assert.equal(d.allow("PRICE", b).ok, true, "produk lain -> boleh");
  assert.equal(d.allow("STOCK", a).ok, true, "intent lain -> kunci berbeda");
});

test("dedupe: identitas kosong ditolak, bukan dilewatkan", () => {
  const d = createQaDedupe();
  assert.equal(d.allow("PRICE", "").ok, false);
  assert.equal(d.allow("PRICE", "").reason, "qa-no-identity");
});

test("dedupe: tidak memakai ember menit kalender", () => {
  // Ember menit punya tepi: dua pertanyaan berjarak satu detik yang
  // menyeberangi pergantian menit akan dijawab dua kali.
  const src = fs.readFileSync(path.join(__dirname, "..", "qa", "dedupe.js"), "utf8");
  for (const terlarang of ["getMinutes", "Math.floor(t / 60", "60_000)", "minuteBucket"]) {
    assert.ok(!src.includes(terlarang), `${terlarang} menandakan ember menit`);
  }
});
