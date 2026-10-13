// Daftar toko terlarang: "tidak disetel" vs "sengaja dikosongkan".
//
// forbiddenShops adalah lapis KEDUA. Penjaga utama ada di checkIdentity()
// (autopin/core.js): identitas yang terlihat harus cocok PERSIS dengan
// expectedShop, dan apa pun selain itu diblokir sebagai identity-mismatch.
// Daftar ini menambahkan satu hal yang tidak ditangkap kecocokan persis -
// operator yang salah mengisi expectedShop dengan nama toko produksi.
//
// Masalahnya, nilai bawaannya dulu berisi nama klien pertama, dan nama itu
// mengalir ke setiap config yang baru dibuat - tidak ada artinya bagi customer
// lain, dan membocorkan nama klien sebelumnya.
//
// Yang lebih halus: config-manager.js menulis daftar ini dengan .join(","),
// jadi daftar KOSONG menjadi string "". Dengan `|| "garudafood"` di
// autopin/config.js, string kosong itu jatuh ke fallback - sehingga Controller
// yakin daftarnya kosong sementara anak runtime memakai nama lama. Dua lapis
// yang menyimpang, dan yang menyimpang bukan yang kelihatan.
//
// Berkas ini memakai fungsi PRODUKSI yang sebenarnya - loadConfig milik anak,
// toEnv milik Controller, checkIdentity milik mesin - bukan tiruannya. Tiruan
// yang mengarang bentuk sudah pernah meloloskan tiga bug di repo ini.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { loadConfig } = require("../autopin/config.js");
const { defaultConfig, validateConfig, toEnv } = require("../controller/config-manager.js");
const { checkIdentity } = require("../autopin/core.js");

const LEGACY = "garudafood";
const ENV_KEY = "AUTOPIN_FORBIDDEN_SHOPS";

/* === tidak disetel vs sengaja dikosongkan ================================ */

test("env TIDAK ADA dan env KOSONG adalah dua hal berbeda", () => {
  const absent = loadConfig({}).forbiddenShops;
  const empty = loadConfig({ [ENV_KEY]: "" }).forbiddenShops;

  assert.notDeepEqual(absent, empty, "keduanya masih diperlakukan sama");
  assert.deepEqual(empty, [], "env kosong harus tetap kosong");
  assert.ok(absent.length > 0, "env yang tidak ada harus memakai fallback legacy");
});

// Jalur `node autopin-cli.js` tanpa Controller tidak pernah menerima env ini.
// Perilakunya SENGAJA tidak diubah - itu batas pengecualian yang diberikan.
test("env yang tidak ada tetap memakai fallback legacy (kompatibilitas)", () => {
  assert.deepEqual(loadConfig({}).forbiddenShops, [LEGACY]);
  // Nilai bukan-string diperlakukan sebagai tidak ada, bukan sebagai kosong.
  assert.deepEqual(loadConfig({ [ENV_KEY]: undefined }).forbiddenShops, [LEGACY]);
});

test("daftar kosong yang EKSPLISIT tetap kosong di anak runtime", () => {
  assert.deepEqual(loadConfig({ [ENV_KEY]: "" }).forbiddenShops, []);
  // Hanya pemisah, tanpa isi: tetap kosong, tidak jatuh ke fallback.
  assert.deepEqual(loadConfig({ [ENV_KEY]: "  " }).forbiddenShops, []);
  assert.deepEqual(loadConfig({ [ENV_KEY]: " , , " }).forbiddenShops, []);

  for (const raw of ["", "  ", " , , "]) {
    assert.ok(
      loadConfig({ [ENV_KEY]: raw }).forbiddenShops.indexOf(LEGACY) === -1,
      "nama klien lama disuntik kembali untuk " + JSON.stringify(raw)
    );
  }
});

test("nilai yang TIDAK kosong tetap diteruskan apa adanya", () => {
  assert.deepEqual(loadConfig({ [ENV_KEY]: "pt resmi" }).forbiddenShops, ["pt resmi"]);
  assert.deepEqual(loadConfig({ [ENV_KEY]: "pt resmi,toko lain" }).forbiddenShops, [
    "pt resmi",
    "toko lain",
  ]);
  // Spasi di sekitar pemisah dirapikan, isinya tidak diubah.
  assert.deepEqual(loadConfig({ [ENV_KEY]: " a , b ,, c " }).forbiddenShops, ["a", "b", "c"]);
  // Termasuk kalau customer memang MEMILIH nama lama itu sendiri.
  assert.deepEqual(loadConfig({ [ENV_KEY]: LEGACY }).forbiddenShops, [LEGACY]);
});

/* === perjalanan utuh Controller -> anak runtime ========================== */

// Lapisnya diuji BERSAMBUNG, dengan toEnv produksi. Menguji kedua ujung secara
// terpisah adalah justru cara ketidakcocokan ini lolos pertama kali.
test("apa yang Controller simpan adalah apa yang anak runtime lihat", () => {
  const CASES = [[], ["pt resmi"], ["pt resmi", "toko lain"], [LEGACY]];

  for (const list of CASES) {
    const cfg = defaultConfig();
    cfg.settings.forbiddenShops = list;
    cfg.settings.expectedShop = "agen_mulia_abadi";

    const verdict = validateConfig(cfg);
    assert.equal(verdict.ok, true, JSON.stringify(list) + " ditolak validasi");

    const env = toEnv(cfg);
    assert.equal(typeof env[ENV_KEY], "string", "Controller harus SELALU mengirim kuncinya");

    const seen = loadConfig(env).forbiddenShops;
    assert.deepEqual(seen, list, "lapis menyimpang untuk " + JSON.stringify(list));
  }
});

/* === penjaga utama TIDAK berubah ========================================= */

// Kalau daftar kosong melemahkan kecocokan persis, maka menghapus nilai bawaan
// akan menjadi lubang keselamatan. Tes ini yang membuktikan ia bukan.
test("kecocokan PERSIS expectedShop tidak berubah oleh daftar kosong", () => {
  const EXPECTED = "agen_mulia_abadi";

  for (const forbidden of [[], [LEGACY], ["pt resmi"]]) {
    // Akun yang SALAH tetap diblokir, apa pun isi daftarnya.
    const wrong = checkIdentity({ expected: EXPECTED, observed: ["toko_orang_lain"], forbidden });
    assert.equal(wrong.ok, false, JSON.stringify(forbidden) + ": akun salah lolos");
    assert.equal(wrong.reason, "identity-mismatch");

    // Akun yang BENAR tetap lolos.
    const right = checkIdentity({ expected: EXPECTED, observed: [EXPECTED], forbidden });
    assert.equal(right.ok, true, JSON.stringify(forbidden) + ": akun benar diblokir");

    // Identitas yang tidak terbaca tetap diblokir (fail-closed).
    const none = checkIdentity({ expected: EXPECTED, observed: [], forbidden });
    assert.equal(none.ok, false);
    assert.equal(none.reason, "identity-not-found");

    // expectedShop yang belum diisi tetap memblokir semua klik.
    const unset = checkIdentity({ expected: "", observed: [EXPECTED], forbidden });
    assert.equal(unset.ok, false);
    assert.equal(unset.reason, "expected-shop-not-configured");
  }
});

// Lapis kedua masih bekerja saat daftarnya memang diisi - yang dihapus hanya
// nilai BAWAANNYA, bukan kemampuannya.
test("daftar yang diisi tetap memblokir seperti sebelumnya", () => {
  const forbidden = ["pt resmi"];

  const observedHit = checkIdentity({
    expected: "agen_mulia_abadi",
    observed: ["pt resmi official"],
    forbidden,
  });
  assert.equal(observedHit.ok, false);
  assert.equal(observedHit.reason, "forbidden-shop");

  // Operator yang salah mengisi expectedShop dengan toko produksi: inilah satu
  // hal yang TIDAK ditangkap kecocokan persis, dan alasan lapis ini ada.
  //
  // Identitas yang terlihat di sini BERSIH dengan sengaja. Pemeriksaan
  // identitas terlihat (autopin/core.js:59) berjalan lebih dulu, jadi kalau
  // keduanya memuat kata terlarang yang keluar adalah `forbidden-shop` - dan
  // cabang expectedShop tidak pernah terbukti teruji.
  const expectedHit = checkIdentity({
    expected: "pt resmi official",
    observed: ["toko_yang_terbuka"],
    forbidden,
  });
  assert.equal(expectedHit.ok, false);
  assert.equal(expectedHit.reason, "expected-shop-is-forbidden");

  // Urutannya dipaku: identitas terlihat menang saat keduanya kena.
  const both = checkIdentity({
    expected: "pt resmi official",
    observed: ["pt resmi official"],
    forbidden,
  });
  assert.equal(both.reason, "forbidden-shop");
});

/* === tidak ada nama klien lama di config baru ============================ */

test("default untuk instalasi baru KOSONG, dan tetap valid", () => {
  const cfg = defaultConfig();
  assert.deepEqual(cfg.settings.forbiddenShops, []);
  // Daftar kosong memang sah menurut skema, bukan kebetulan.
  assert.deepEqual(
    (validateConfig(cfg).errors || []).filter((e) => /forbiddenShops/.test(e.path)),
    []
  );
});

test("nama klien lama tidak ada lagi di config bawaan maupun contohnya", () => {
  const dflt = JSON.stringify(defaultConfig());
  assert.ok(dflt.toLowerCase().indexOf(LEGACY) === -1, "defaultConfig masih memuat nama klien lama");

  const examplePath = path.join(__dirname, "..", "data", "config.example.json");
  const example = fs.readFileSync(examplePath, "utf8");
  assert.ok(
    example.toLowerCase().indexOf(LEGACY) === -1,
    "data/config.example.json masih memuat nama klien lama"
  );
  // Contohnya harus tetap bisa dipakai apa adanya.
  const parsed = JSON.parse(example.replace(/^﻿/, ""));
  assert.deepEqual(parsed.settings.forbiddenShops, []);
});

// Config customer yang SUDAH ADA tidak boleh ikut berubah. loadConfig() di
// config-manager mengembalikan hasil parse apa adanya - tidak ada penggabungan
// default, tidak ada penulisan ulang - jadi nilai lama di disk tetap berlaku.
test("config yang sudah tersimpan tetap dihormati, termasuk nilai lama", () => {
  const existing = defaultConfig();
  existing.settings.forbiddenShops = [LEGACY];
  existing.settings.expectedShop = "agen_mulia_abadi";

  assert.equal(validateConfig(existing).ok, true, "config lama harus tetap valid");
  // Dan ia sampai ke anak runtime tanpa diubah.
  assert.deepEqual(loadConfig(toEnv(existing)).forbiddenShops, [LEGACY]);
});
