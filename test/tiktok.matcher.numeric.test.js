// PAGAR ANGKA pada fallback fuzzy: angka TIDAK boleh diperlakukan sebagai typo.
//
// ---------------------------------------------------------------------------
// KEJADIAN YANG MELAHIRKAN BERKAS INI
//
// Audit matcher 2026-10-17 (docs/trigger-matcher-audit-v0.2.0.md) menemukan ini
// AKTIF pada config pilot v0.2.0, bukan sebagai kemungkinan teoretis:
//
//   penonton: "spill etalase 2"
//   trigger : "spill etalase 1"
//   jarak   : 1 karakter pada frasa 15 karakter -> skor 0,933
//   ambang  : 0,55
//
// Hasilnya bot mem-pin produk yang SALAH dan menulis di chat "Etalase 1 sudah
// aku pin ya kak". Di LIVE commerce itu kelas kesalahan termahal: penonton minta
// barang A, yang ter-pin barang B, dan chat mengklaim sesuatu yang salah.
//
// Menaikkan ambang bukan jawabannya - 0,933 tetap lolos pada ambang 0,9. Yang
// salah adalah anggapan bahwa angka adalah ejaan.
//
// Tes ini memakai matcher PRODUKSI langsung (tanpa index.js, tanpa browser,
// tanpa OBS) supaya ia menguji keputusan yang sesungguhnya, bukan tiruannya.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildMatcherIndex, matchPhrase, matchFuzzy, numericIdentity, DEFAULT_THRESHOLD,
} = require("../tiktok/matcher");
const { normalizeForMatching, containsPhrase } = require("../tiktok/normalize");

// Jalur yang SAMA dengan handleChat() di index.js:1421-1444: frasa dulu, lalu
// fuzzy. Diulang di sini karena yang diuji adalah keputusan gabungan keduanya.
function decide(index, raw) {
  const msgRaw = String(raw).toLowerCase().trim();
  const msgNorm = normalizeForMatching(msgRaw);
  const ph = matchPhrase(index, msgRaw, msgNorm, { containsPhrase });
  if (ph) return { via: ph.via, scene: ph.rule.scene, keyword: ph.keyword || null, score: 1 };
  const fz = matchFuzzy(index, msgNorm, { threshold: DEFAULT_THRESHOLD });
  if (fz.rule) return { via: "fuzzy", scene: fz.rule.scene, keyword: fz.keyword, score: fz.score, stats: fz.stats };
  return { via: null, scene: null, keyword: null, score: fz.score, stats: fz.stats };
}

const idx = (rules) => buildMatcherIndex(rules, { normalize: normalizeForMatching });

// Config customer pilot APA ADANYA (trigger persis seperti yang terpasang saat
// audit), karena di sinilah cacatnya ditemukan.
const PILOT = [
  { scene: "PAX-1", keywords: ["spill etalase 1"] },
  { scene: "PAX-2", keywords: ["no 2"] },
  { scene: "PAX-3", keywords: ["et 3"] },
  { scene: "PAX-4", keywords: ["et 4"] },
  { scene: "PAX-5", keywords: ["spill etalase 5"] },
];

// --- identitas angka itu sendiri ---------------------------------------------

test("numericIdentity: deretan digit, berurutan, dari teks yang SUDAH dinormalkan", () => {
  assert.equal(numericIdentity("spill etalase 1"), "1");
  assert.equal(numericIdentity("spill etalase 10"), "10");
  assert.equal(numericIdentity("etalase1"), "1", "digit yang menempel huruf tetap terbaca");
  assert.equal(numericIdentity("boikot ai"), "", "tanpa angka = string kosong");
  assert.equal(numericIdentity("no 2"), "2");
  assert.equal(numericIdentity("1 dan 2"), "1 2", "urutan dipertahankan");
  assert.equal(numericIdentity(""), "");
  assert.equal(numericIdentity(null), "", "nilai kosong tidak boleh melempar");
});

test("numericIdentity TIDAK menduplikasi peta angka-kata: ia dibaca SESUDAH normalisasi", () => {
  // Peta `satu` -> `1` hidup di tiktok/normalize.js dan hanya di sana. Pagar ini
  // membacanya lewat hasilnya, jadi tidak ada dua sumber kebenaran.
  assert.equal(numericIdentity(normalizeForMatching("spill etalase satu")), "1");
  assert.equal(numericIdentity(normalizeForMatching("spill etalase 1")), "1");
  // `sepuluh` memang TIDAK ada di peta itu - dicatat, bukan diperbaiki di sini.
  assert.equal(numericIdentity(normalizeForMatching("spill etalase sepuluh")), "");
});

// --- inti perbaikan: produk salah tidak boleh lagi menang --------------------

test("KRITIS: etalase lain TIDAK BOLEH mendarat di PAX-1", () => {
  const i = idx(PILOT);
  for (const msg of [
    "spill etalase 2",
    "spill etalase 3",
    "spill etalase 4",
    "spill etalase 6",
    "spill etalase 10",
    "spill etalase 11",
    "spill etalase dua",
  ]) {
    const r = decide(i, msg);
    assert.notEqual(r.scene, "PAX-1", msg + " -> " + r.scene + " (via " + r.via + ")");
    assert.equal(r.scene, null, msg + " seharusnya tidak cocok ke apa pun, dapat " + r.scene);
  }
});

test("KRITIS: identitas angka tidak boleh saling menyeberang", () => {
  const satu = idx([{ scene: "PAX-1", keywords: ["spill etalase 1"] }]);
  const dua = idx([{ scene: "PAX-2", keywords: ["spill etalase 2"] }]);
  assert.equal(decide(satu, "spill etalase 2").scene, null, "pesan 2 vs trigger 1");
  assert.equal(decide(dua, "spill etalase 1").scene, null, "pesan 1 vs trigger 2");
  assert.equal(decide(satu, "spill etalase 10").scene, null, "pesan 10 vs trigger 1");

  const no2 = idx([{ scene: "PAX-2", keywords: ["nomor 2"] }]);
  assert.equal(decide(no2, "nomor 1").scene, null, "nomor 1 vs trigger nomor 2");

  const et2 = idx([{ scene: "PAX-2", keywords: ["et 2"] }]);
  assert.equal(decide(et2, "et 1").scene, null, "et 1 vs trigger et 2");
});

test("KRITIS: trigger pendek berangka pada config pilot", () => {
  // `et 3` dan `no 2` panjangnya 4 karakter -> allowed = 1, yaitu persis satu
  // digit. Inilah kenapa `et 1` dulu mendarat di PAX-3.
  const i = idx(PILOT);
  for (const [msg, dulu] of [["et 1", "PAX-3"], ["et 2", "PAX-3"], ["no 1", "PAX-2"], ["no 3", "PAX-2"]]) {
    const r = decide(i, msg);
    assert.equal(r.scene, null, msg + " (dulu " + dulu + ") -> " + r.scene);
  }
});

// --- recall yang WAJIB tetap hidup -------------------------------------------

test("RECALL: typo di dalam KATA tetap cocok kalau angkanya sama", () => {
  const i = idx(PILOT);
  assert.equal(decide(i, "spill etalse 1").scene, "PAX-1", "satu huruf hilang");
  assert.equal(decide(i, "spill etalase1").scene, "PAX-1", "angka menempel");
  assert.equal(decide(i, "spil etalase 1").scene, "PAX-1", "huruf hilang di kata lain");
  assert.equal(decide(i, "spill etalse 5").scene, "PAX-5");
  assert.equal(decide(i, "etalase 1").scene, "PAX-1", "kata dibuang, angka tetap");
  assert.equal(decide(i, "nomor 2").scene, "PAX-2", "sinonim pendek, angka sama");
});

test("RECALL: angka-kata tetap setara dengan digit lewat normalisasi produksi", () => {
  const i = idx(PILOT);
  const r = decide(i, "spill etalase satu");
  assert.equal(r.scene, "PAX-1");
  assert.equal(r.via, "keyword", "ia cocok lewat containment, bukan fuzzy");
});

test("RECALL: trigger TANPA angka tidak tersentuh pagar ini", () => {
  const i = idx([
    { scene: "BOIKOT AI", keywords: ["boikot ai"] },
    { scene: "FAQ ORDER", keywords: ["cara order", "cara beli", "belinya gimana"] },
    { scene: "FAQ JAWAB AI", keywords: ["hostnya robot", "ini ai ya"] },
  ]);
  const harus = [
    ["boikott ai", "BOIKOT AI"],
    ["boikot aii", "BOIKOT AI"],
    ["boikotai", "BOIKOT AI"],
    ["cara belii", "FAQ ORDER"],
    ["belinya gmn", "FAQ ORDER"],
    ["host nya robot", "FAQ JAWAB AI"],
    ["ini ai yaa", "FAQ JAWAB AI"],
  ];
  for (const [msg, scene] of harus) {
    assert.equal(decide(i, msg).scene, scene, msg);
  }
});

test("RECALL: trigger tanpa angka tetap cocok walau PESAN memuat angka", () => {
  // Arah yang SENGAJA dibiarkan: trigger yang tidak mengklaim nomor apa pun
  // tidak boleh kehilangan toleransi typo hanya karena penonton menambah angka.
  const i = idx([{ scene: "BOIKOT AI", keywords: ["boikot ai"] }]);
  assert.equal(decide(i, "boikott ai 2").scene, "BOIKOT AI");
  assert.equal(decide(i, "boikot aii 3").scene, "BOIKOT AI");
});

// --- arah asimetris yang dipilih sadar ---------------------------------------

test("KEPUTUSAN: pesan TANPA angka tidak boleh mendarat di trigger BERANGKA", () => {
  // Diukur sebelum perubahan: `spill etalase` dulu mendarat di PAX-1 (0,867),
  // `spill etalasenya` (0,813), `spill etalase dong` (0,778), dan
  // `spill etalase sepuluh` (0,667). Tidak satu pun dari pesan itu menyebut
  // barang mana; memilih yang pertama di config adalah tebakan, bukan permintaan
  // - dan untuk `sepuluh` tebakan itu bahkan pasti salah.
  const i = idx(PILOT);
  for (const msg of ["spill etalase", "spill etalase dong", "spill etalasenya", "spill etalase sepuluh", "spill etalase ya kak"]) {
    assert.equal(decide(i, msg).scene, null, msg + " seharusnya tidak memilih etalase mana pun");
  }
});

// --- tabrakan antar-nomor ----------------------------------------------------

test("TABRAKAN: tiga nomor berdampingan, masing-masing hanya cocok ke dirinya", () => {
  const rules = [
    { scene: "PAX-1", keywords: ["spill etalase 1"] },
    { scene: "PAX-2", keywords: ["spill etalase 2"] },
    { scene: "PAX-10", keywords: ["spill etalase 10"] },
  ];
  const i = idx(rules);
  assert.equal(decide(i, "spill etalase 1").scene, "PAX-1");
  assert.equal(decide(i, "spill etalase 2").scene, "PAX-2");
  assert.equal(decide(i, "spill etalase 10").scene, "PAX-10");
  // Nomor yang tidak dipetakan tidak boleh "dibulatkan" ke tetangganya.
  assert.equal(decide(i, "spill etalase 3").scene, null);
  assert.equal(decide(i, "spill etalase 11").scene, null);
  // Typo pada KATA tetap bekerja, dan tetap ke nomor yang benar.
  assert.equal(decide(i, "spill etalse 10").scene, "PAX-10");
  assert.equal(decide(i, "spill etalse 2").scene, "PAX-2");
});

test("TABRAKAN: URUTAN CONFIG tidak bisa membuat satu nomor mencuri nomor lain", () => {
  // Urutan config menentukan pemenang saat skor seri (lihat matcher.js), jadi
  // sebelum pagar ini `spill etalase 2` selalu jatuh ke entri BERANGKA pertama.
  // Sesudahnya, urutan tidak lagi bisa mengubah identitas angka.
  const maju = [
    { scene: "PAX-1", keywords: ["spill etalase 1"] },
    { scene: "PAX-2", keywords: ["spill etalase 2"] },
    { scene: "PAX-10", keywords: ["spill etalase 10"] },
  ];
  const mundur = [...maju].reverse();
  for (const msg of ["spill etalase 1", "spill etalase 2", "spill etalase 10", "spill etalase 3", "spill etalase 11"]) {
    const a = decide(idx(maju), msg);
    const b = decide(idx(mundur), msg);
    assert.equal(a.scene, b.scene, msg + ": urutan config mengubah hasil (" + a.scene + " vs " + b.scene + ")");
  }
});

// --- yang TIDAK boleh ikut berubah -------------------------------------------

test("PAGAR: lintasan frasa (containment) tidak disentuh pagar angka", () => {
  const i = idx(PILOT);
  // Containment tetap menang lebih dulu, termasuk untuk frasa berangka.
  for (const [msg, scene] of [
    ["spill etalase 1", "PAX-1"],
    ["spill etalase 5", "PAX-5"],
    ["et 3", "PAX-3"],
    ["no 2", "PAX-2"],
    ["kak spill etalase 1 dong", "PAX-1"],
    ["spill etalase 1!!!", "PAX-1"],
  ]) {
    const r = decide(i, msg);
    assert.equal(r.scene, scene, msg);
    assert.equal(r.via, "keyword", msg + " harus lewat containment, bukan fuzzy");
  }
});

test("PAGAR: ambang dan algoritma jarak TIDAK diubah hotfix ini", () => {
  assert.equal(DEFAULT_THRESHOLD, 0.55, "ambang tidak boleh ikut digeser di hotfix ini");
  // Skor untuk kandidat yang angkanya SAMA harus tetap seperti sebelumnya.
  const i = idx([{ scene: "PAX-1", keywords: ["spill etalase 1"] }]);
  const r = decide(i, "spill etalse 1");
  assert.equal(r.via, "fuzzy");
  assert.ok(Math.abs(r.score - 14 / 15) < 1e-9, "skor berubah: " + r.score);
});

test("PAGAR: kandidat yang didiskualifikasi DILAPORKAN di stats, bukan didiamkan", () => {
  const i = idx(PILOT);
  const fz = matchFuzzy(i, normalizeForMatching("spill etalase 2"), { threshold: DEFAULT_THRESHOLD });
  assert.equal(fz.rule, null);
  assert.ok(fz.stats.skippedNumeric > 0, "harus terlihat berapa kandidat yang ditolak angkanya");
  assert.equal(fz.stats.calls, 0, "tidak ada Levenshtein yang perlu dihitung untuk kandidat itu");
});

test("PAGAR: pesan tanpa angka vs trigger tanpa angka berjalan seperti sebelumnya", () => {
  const i = idx([{ scene: "FAQ ORDER", keywords: ["cara order"] }]);
  const fz = matchFuzzy(i, normalizeForMatching("cara ordernya"), { threshold: DEFAULT_THRESHOLD });
  assert.equal(fz.stats.skippedNumeric, 0, "pagar tidak boleh ikut campur di jalur non-angka");
  assert.ok(fz.rule, "dan kecocokannya tetap ada");
});
