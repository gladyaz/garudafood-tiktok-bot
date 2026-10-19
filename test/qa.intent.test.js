// Intent HARGA Product Q&A. Fungsi murni, tanpa browser, tanpa jaringan.
//
// normalizeForMatching PRODUKSI yang dipakai untuk menormalkan teks penonton -
// bukan tiruan - supaya yang diuji benar-benar teks yang dilihat detektor.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const fs = require("fs");
const path = require("path");
const { normalizeForMatching } = require("../tiktok/normalize");
const intentMod = require("../qa/intent-price");
const {
  detectPriceIntent, stripPossessive, queryTokens, productWords, explicitNumber,
  POSSESSIVE_MIN_LENGTH, PRICE_CUES, NON_PRICE_CUES,
} = intentMod;

const d = (raw) => detectPriceIntent(normalizeForMatching(String(raw).toLowerCase().trim()));

// --- HARUS dikenali sebagai pertanyaan harga -------------------------------

test("intent: contoh positif dari desain semuanya PRICE", () => {
  const positif = [
    "berapa harga garuda atom",
    "garuda atom berapa",
    "harga garuda kacang",
    "garuda kacangnya berapa kak",
    "brp gery saluut",
    "yang dalezz harganya berapa",
    "berapa yang nomor 1",
    "harga garuda atom berapa",
    "harga produk nomor 2",
  ];
  for (const t of positif) {
    const r = d(t);
    assert.equal(r.price, true, `${t} harus PRICE (${r.reason})`);
    assert.ok(r.cues.length > 0, `${t} harus punya isyarat`);
  }
});

test("intent: ragam isyarat harga Indonesia dikenali", () => {
  for (const cue of ["harga", "harganya", "berapa", "brp", "hrg", "brpa", "berapaan"]) {
    const r = d(`garuda atom ${cue}`);
    assert.equal(r.price, true, cue);
  }
});

// --- TIDAK boleh dikenali --------------------------------------------------

test("intent: delapan contoh negatif dari desain SEMUANYA ditolak", () => {
  // Pagar utama. Positif palsu lebih mahal daripada negatif palsu.
  const negatif = {
    "garuda enak": "blocked:enak",
    "aku suka garuda": "blocked:suka",
    "spill garuda": "blocked:spill",
    "garuda ada?": "no-price-cue",
    "garuda stok?": "blocked:stok",
    "garuda mahal banget": "blocked:mahal",
    "harga diri": "blocked:diri",
    "berapa viewer sekarang": "blocked:viewer",
  };
  for (const [teks, alasan] of Object.entries(negatif)) {
    const r = d(teks);
    assert.equal(r.price, false, `${teks} TIDAK boleh PRICE`);
    assert.equal(r.reason, alasan, teks);
  }
});

test("intent: \"harga diri\" ditolak walau memuat isyarat harga", () => {
  // Jenis positif palsu yang paling memalukan: idiom yang kebetulan memuat
  // kata "harga". Diuji sendiri dan dinamai supaya tidak pernah hilang
  // diam-diam di dalam perulangan.
  const r = d("harga diri");
  assert.equal(r.price, false);
  assert.equal(r.reason, "blocked:diri");
});

test("intent: \"berapa viewer\" ditolak walau memuat isyarat harga", () => {
  for (const t of ["berapa viewer", "berapa viewer sekarang", "penonton berapa", "berapa like"]) {
    const r = d(t);
    assert.equal(r.price, false, t);
    assert.match(r.reason, /^blocked:/, t);
  }
});

test("intent: pertanyaan STOK DIAM, tidak salah dijawab sebagai harga", () => {
  // v0.3.0 tidak mengerjakan stok. Pemblokirnya ada supaya pertanyaan stok
  // tidak pernah berubah menjadi jawaban harga.
  for (const t of ["garuda stok", "stok garuda atom masih ada", "garuda atom ready berapa", "sisa berapa garuda"]) {
    const r = d(t);
    assert.equal(r.price, false, t);
    assert.match(r.reason, /blocked:(stok|ready|sisa)/, t);
  }
});

test("intent: pemblokir MENANG atas isyarat harga", () => {
  // Urutan diperiksa: pemblokir dulu, supaya laporannya jujur.
  const r = d("garuda stok berapa harganya");
  assert.equal(r.price, false);
  assert.match(r.reason, /^blocked:/);
});

test("intent: permintaan etalase tetap bukan intent harga", () => {
  for (const t of ["spill garuda", "spill etalase 1", "pin garuda atom"]) {
    assert.equal(d(t).price, false, t);
  }
});

// --- isyarat dicocokkan sebagai TOKEN UTUH --------------------------------

test("intent: isyarat harga bukan substring", () => {
  // "berapa" di dalam kata lain tidak boleh memicu.
  for (const t of ["beraparaan aneh", "hargaan", "rpx"]) {
    const r = d(t);
    assert.equal(r.price, false, `${t} -> ${r.reason}`);
  }
  // tapi token utuh tetap memicu
  assert.equal(d("garuda berapa").price, true);
});

// --- normalisasi posesif KHUSUS QUERY -------------------------------------

test("stripPossessive: satu sufiks, dengan batas panjang", () => {
  assert.equal(POSSESSIVE_MIN_LENGTH, 6);
  assert.equal(stripPossessive("kacangnya"), "kacang");
  assert.equal(stripPossessive("harganya"), "harga");
  assert.equal(stripPossessive("atomnya"), "atom");
  assert.equal(stripPossessive("saluutnya"), "saluut");
  // terlalu pendek: dibiarkan apa adanya
  assert.equal(stripPossessive("nya"), "nya");
  assert.equal(stripPossessive("punya"), "punya");
  // bukan berakhiran -nya
  assert.equal(stripPossessive("garuda"), "garuda");
  assert.equal(stripPossessive(""), "");
  assert.equal(stripPossessive(null), "");
});

test("stripPossessive: BUKAN stemming umum", () => {
  // Hanya -nya. Sufiks Indonesia lain tidak disentuh, dan itu disengaja:
  // stemming umum akan mengubah arti token judul produk.
  assert.equal(stripPossessive("kacangku"), "kacangku");
  assert.equal(stripPossessive("kacangmu"), "kacangmu");
  assert.equal(stripPossessive("berapakah"), "berapakah");
  assert.equal(stripPossessive("makanan"), "makanan");
});

test("queryTokens: posesif dilepas, token kosong dibuang", () => {
  assert.deepEqual(queryTokens("garuda kacangnya berapa kak"), ["garuda", "kacang", "berapa", "kak"]);
  assert.deepEqual(queryTokens(""), []);
  assert.deepEqual(queryTokens(null), []);
});

test("productWords: buang stopword, isyarat harga, dan token pendek", () => {
  assert.deepEqual(productWords("garuda kacangnya berapa kak"), ["garuda", "kacang"]);
  assert.deepEqual(productWords("berapa harga yang itu kak"), []);
  assert.deepEqual(productWords("brp gery saluut"), ["gery", "saluut"]);
});

// --- rujukan nomor --------------------------------------------------------

test("explicitNumber: butuh penanda yang disebut penonton", () => {
  assert.equal(explicitNumber("berapa yang nomor 1"), 1);
  assert.equal(explicitNumber("harga produk nomor 2"), 2);
  assert.equal(explicitNumber("harga no 3"), 3);
  assert.equal(explicitNumber("berapa etalase 4"), 4);
  assert.equal(explicitNumber("urutan 5 berapa"), 5);
});

test("explicitNumber: angka TANPA penanda bukan rujukan posisi", () => {
  // "garuda 16gr" memuat angka, tapi itu berat produk - bukan nomor etalase.
  assert.equal(explicitNumber("garuda 16gr berapa"), null);
  assert.equal(explicitNumber("berapa 1"), null);
  assert.equal(explicitNumber("harga garuda atom"), null);
  // penanda harus BERSEBELAHAN dengan angkanya
  assert.equal(explicitNumber("nomor berapa 1"), null);
});

test("explicitNumber: hanya 1-2 digit", () => {
  assert.equal(explicitNumber("nomor 10"), 10);
  assert.equal(explicitNumber("nomor 100"), null);
});

// --- PAGAR: normalisasi -nya TIDAK boleh masuk matcher global -------------

test("PAGAR: matcher trigger global TIDAK memakai normalisasi posesif", () => {
  // Diminta eksplisit: normalisasi ini milik Q&A saja. Di matcher global ia
  // akan mengubah arti keyword customer yang sudah terbukti.
  for (const rel of ["tiktok/normalize.js", "tiktok/matcher.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    assert.ok(!src.includes("stripPossessive"), `${rel} tidak boleh memakai stripPossessive`);
    assert.ok(!src.includes("POSSESSIVE"), `${rel} tidak boleh tahu soal sufiks posesif`);
    assert.ok(!/endsWith\(\s*["'`]nya["'`]\s*\)/.test(src), `${rel} tidak boleh melepas -nya`);
    assert.ok(!src.includes("qa/"), `${rel} tidak boleh mengimpor modul qa`);
  }
});

test("PAGAR: normalizeForMatching produksi TIDAK berubah perilakunya", () => {
  // Bukti langsung bahwa teks yang sama tetap dinormalkan sama seperti v0.2.2.
  assert.equal(normalizeForMatching("garuda kacangnya berapa kak"), "garuda kacangnya berapa kak");
  assert.equal(normalizeForMatching("Spill Etalase 1!!!"), "spill etalase 1");
  assert.equal(normalizeForMatching("ET  satu"), "et 1");
});

test("PAGAR: Q&A tidak menormalkan sendiri", () => {
  // Ada satu normalizer di repo ini dan ia milik tiktok/normalize.js.
  const src = fs.readFileSync(path.join(__dirname, "..", "qa", "intent-price.js"), "utf8");
  assert.ok(!src.includes("toLowerCase"), "intent tidak boleh menormalkan huruf sendiri");
  assert.ok(!src.includes("NFKC"), "intent tidak boleh menormalkan Unicode sendiri");
});

// --- bentuk hasil ---------------------------------------------------------

test("intent: masukan rusak tidak melempar", () => {
  for (const bad of [null, undefined, "", "   ", 42, {}]) {
    const r = detectPriceIntent(bad);
    assert.equal(r.price, false, JSON.stringify(bad));
  }
});

test("intent: daftar isyarat dan pemblokir tidak beririsan", () => {
  for (const c of PRICE_CUES) {
    assert.ok(!NON_PRICE_CUES.has(c), `${c} tidak boleh ada di kedua daftar`);
  }
});
