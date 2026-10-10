// Kamus tiga bahasa.
//
// Yang dijaga di sini bukan kualitas terjemahan - itu urusan manusia yang
// membacanya. Yang dijaga adalah hal-hal yang bisa rusak diam-diam:
//
//   kunci yang hilang di satu bahasa  -> satu kalimat tiba-tiba berbahasa lain
//   kode server yang tidak tertutup   -> kalimat Inggris bocor ke layar Indonesia
//   placeholder yang hilang           -> "{n} hal perlu dicek" tampil apa adanya
//   konten customer masuk kamus       -> judul produk ikut berganti bahasa
//
// Tiga yang terakhir tidak akan pernah terlihat di tes unit lain, dan ketiganya
// baru ketahuan di depan penonton.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const I = require("../controller/public/i18n.js");
const { CATALOG, FIELD_PROBLEMS } = require("../controller/errors.js");

const LANGS = I.LANGS;
const keysOf = (lang) => Object.keys(I.DICT[lang]).sort();
const placeholders = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join(",");

/* === paritas kunci ======================================================= */

test("tiga bahasa punya daftar kunci yang PERSIS SAMA", () => {
  assert.deepEqual(LANGS, ["id", "en", "zh-CN"]);
  const base = keysOf("id");
  assert.ok(base.length > 300, "kamus terlalu kecil, ada yang belum terisi: " + base.length);

  for (const lang of LANGS) {
    const mine = keysOf(lang);
    const missing = base.filter((k) => mine.indexOf(k) === -1);
    const extra = mine.filter((k) => base.indexOf(k) === -1);
    assert.deepEqual(missing, [], lang + " kehilangan kunci");
    assert.deepEqual(extra, [], lang + " punya kunci yang tidak ada di Indonesia");
  }
});

test("tidak ada nilai kosong di bahasa mana pun", () => {
  // field.sep SENGAJA kosong di Mandarin: tidak ada spasi antara label dan
  // lanjutan kalimat. Itu satu-satunya nilai kosong yang sah.
  const MAY_BE_EMPTY = ["field.sep"];
  for (const lang of LANGS) {
    const empty = Object.keys(I.DICT[lang]).filter((k) => {
      if (MAY_BE_EMPTY.indexOf(k) !== -1) return false;
      const v = I.DICT[lang][k];
      return typeof v !== "string" || v.trim() === "";
    });
    assert.deepEqual(empty, [], lang + " punya nilai kosong");
  }
  // tapi ia tetap harus ADA dan berupa string di ketiga bahasa
  for (const lang of LANGS) assert.equal(typeof I.DICT[lang]["field.sep"], "string", lang);
});

/* === kode mesin dari server ============================================== */

test("SETIAP kode di errors.js CATALOG punya kalimatnya di tiga bahasa", () => {
  const codes = Object.keys(CATALOG);
  assert.ok(codes.length > 90, "jumlah kode tak terduga: " + codes.length);
  for (const lang of LANGS) {
    const missing = codes.filter((c) => I.DICT[lang]["err." + c] === undefined);
    assert.deepEqual(missing, [], lang + " belum menutup kode server");
  }
});

test("SETIAP kode FIELD_PROBLEMS punya potongannya di tiga bahasa", () => {
  const codes = Object.keys(FIELD_PROBLEMS);
  for (const lang of LANGS) {
    const missing = codes.filter((c) => I.DICT[lang]["field." + c] === undefined);
    assert.deepEqual(missing, [], lang + " belum menutup kode field");
  }
});

test("tidak ada kunci err.* yang bukan kode server sungguhan", () => {
  const codes = Object.keys(CATALOG);
  const invented = Object.keys(I.DICT.id)
    .filter((k) => k.indexOf("err.") === 0)
    .map((k) => k.slice(4))
    .filter((c) => c !== "unknown" && codes.indexOf(c) === -1);
  assert.deepEqual(invented, [], "kunci ini tidak pernah dikirim server, jadi ia kode mati");
});

/* === placeholder ========================================================= */

test("placeholder sama persis di tiga bahasa", () => {
  const base = Object.keys(I.DICT.id);
  const bad = [];
  for (const key of base) {
    const want = placeholders(I.DICT.id[key]);
    for (const lang of LANGS) {
      const got = placeholders(I.DICT[lang][key]);
      if (got !== want) bad.push(lang + " " + key + ": [" + got + "] bukan [" + want + "]");
    }
  }
  assert.deepEqual(bad, []);
});

test("placeholder benar-benar diisi, bukan ditampilkan apa adanya", () => {
  for (const lang of LANGS) {
    const out = I.t(lang, "ui.pill.blocked", { n: 3 });
    assert.ok(out.indexOf("{n}") === -1, lang + " meninggalkan {n} di layar");
    assert.ok(out.indexOf("3") !== -1, lang + " kehilangan angkanya");
  }
});

test("placeholder yang tidak diberi nilai dibiarkan utuh, bukan jadi undefined", () => {
  const out = I.t("id", "ui.pill.blocked", {});
  assert.ok(out.indexOf("undefined") === -1, out);
});

/* === konten customer TIDAK BOLEH ada di kamus ============================ */

test("PAGAR: tidak ada konten milik customer di kamus mana pun", () => {
  // Kalau salah satu dari ini masuk kamus, ia akan ikut berganti saat bahasa
  // diganti - dan judul produk yang berubah sendiri berarti produk yang salah
  // di-pin di depan penonton.
  const FORBIDDEN = [
    "Garuda", "Gery", "Dilan", "Kacang Atom", "Malkist", "Waffle",
    "spill etalase", "sudah aku pin", "tokosnackku", "agen_mulia_abadi",
    "PAX-1", "PAX-2", "PAX-3", "PAX-4", "PAX-5",
  ];
  for (const lang of LANGS) {
    const blob = JSON.stringify(I.DICT[lang]);
    for (const bad of FORBIDDEN) {
      assert.ok(blob.indexOf(bad) === -1, lang + ' memuat konten customer: "' + bad + '"');
    }
  }
});

test("PAGAR: nama scene hanya pernah muncul sebagai placeholder", () => {
  for (const lang of LANGS) {
    for (const [key, val] of Object.entries(I.DICT[lang])) {
      assert.ok(!/PAX-\d/.test(val), lang + " " + key + " menuliskan nama scene");
    }
  }
});

/* === resolver ============================================================ */

test("bahasa bawaan adalah Indonesia", () => {
  assert.equal(I.DEFAULT_LANG, "id");
});

test("kunci yang hilang ditambal Indonesia, bukan dikosongkan", () => {
  const saved = I.DICT.en["ui.btn.start"];
  try {
    delete I.DICT.en["ui.btn.start"];
    assert.equal(I.t("en", "ui.btn.start"), I.DICT.id["ui.btn.start"]);
  } finally {
    I.DICT.en["ui.btn.start"] = saved;
  }
});

test("kunci yang tidak dikenal menghasilkan kosong, bukan nama kunci", () => {
  assert.equal(I.t("id", "ui.tidak.pernah.ada"), "");
});

test("fromServer: kamus menang, lalu kalimat server, lalu Indonesia", () => {
  // 1. kamus punya kodenya
  assert.equal(
    I.fromServer("id", "obs-unavailable", "OBS is not connected."),
    I.DICT.id["err.obs-unavailable"]
  );
  // 2. kode tak dikenal: kalimat server dipakai apa adanya
  assert.equal(I.fromServer("id", "kode-yang-tidak-ada", "Sesuatu terjadi."), "Sesuatu terjadi.");
  // 3. kode tak dikenal DAN server diam: tetap kalimat, bukan kode
  const out = I.fromServer("id", "kode-yang-tidak-ada", "");
  assert.ok(out.length > 0);
  assert.ok(out.indexOf("kode-yang-tidak-ada") === -1, "kode mesin bocor ke layar: " + out);
});

test("PAGAR: kode mesin tidak pernah sampai ke layar", () => {
  const codes = Object.keys(CATALOG).concat(["kode-karangan", "", null, undefined]);
  for (const lang of LANGS) {
    for (const c of codes) {
      const out = I.fromServer(lang, c, "");
      assert.ok(typeof out === "string" && out.trim() !== "", lang + " " + c + " menghasilkan kosong");
      if (typeof c === "string" && c !== "") {
        assert.ok(out.indexOf(c) === -1, lang + ' menampilkan kode mentah "' + c + '"');
      }
    }
  }
});

test("fieldProblem menempelkan LABEL yang bisa dibaca, bukan path mesin", () => {
  const out = I.fieldProblem("id", "obs.port", "must-be-port", "");
  assert.ok(out.indexOf("Port OBS") === 0, out);
  assert.ok(out.indexOf("obs.port") === -1, "path mentah bocor: " + out);
  // tanpa path, tetap jadi kalimat yang bisa dibaca
  assert.ok(I.fieldProblem("id", "", "must-be-port", "").length > 0);
});

test("path aturan jadi nomor yang dikenal customer, dihitung dari 1", () => {
  // Validator menghitung dari nol; pemilik toko menghitung dari satu.
  assert.equal(I.fieldLabel("id", "mappings[0].product"), "Aturan 1 — Produk");
  assert.equal(I.fieldLabel("en", "mappings[0].product"), "Rule 1 — Product");
  assert.equal(I.fieldLabel("id", "mappings[1].triggers[2]"), "Aturan 2 — Kata pemicu 3");
  assert.equal(I.fieldLabel("id", "mappings[3]"), "Aturan 4");
  assert.equal(I.fieldLabel("id", "mappings[2].scene"), "Aturan 3 — Scene");
  assert.equal(I.fieldLabel("id", "mappings[0].product.title"), "Aturan 1 — Judul produk");
  assert.equal(I.fieldLabel("id", "mappings[4].reply"), "Aturan 5 — Balasan di chat");
});

test("field yang bukan kendali customer memakai satu label umum", () => {
  // "settings.autoCommentMinIntervalMs" sama tidak berartinya dengan path
  // mentah bagi pemilik toko.
  assert.equal(I.fieldLabel("id", "settings.autoCommentMinIntervalMs"), "Pengaturan lanjutan");
  assert.equal(I.fieldLabel("id", "settings.autopinTimeoutMs"), "Pengaturan lanjutan");
  // sementara yang MEMANG kendali customer punya namanya sendiri
  assert.equal(I.fieldLabel("id", "settings.expectedShop"), "Nama toko");
  assert.equal(I.fieldLabel("id", "settings.autopinEnabled"), "Pin produk otomatis");
});

test("PAGAR: path mesin tidak pernah muncul di kalimat mana pun", () => {
  // Setiap bentuk path yang benar-benar dikirim config-manager.js.
  const paths = [
    "", "version", "tiktok", "tiktok.username", "obs", "obs.host", "obs.port",
    "obs.password", "settings", "settings.expectedShop", "settings.autopinEnabled",
    "settings.autoCommentEnabled", "settings.forbiddenShops", "settings.chromePath",
    "settings.consoleUrl", "settings.profileDir", "settings.debugDir",
    "settings.sceneReplayCooldownMs", "settings.autoCommentTransport", "mappings",
    "mappings[0]", "mappings[0].scene", "mappings[0].product", "mappings[0].product.title",
    "mappings[0].triggers", "mappings[0].triggers[0]", "mappings[0].reply",
    "mappings[12].triggers[7]",
  ];
  for (const lang of LANGS) {
    for (const p of paths) {
      const label = I.fieldLabel(lang, p);
      const sentence = I.fieldProblem(lang, p, "must-be-string", "");
      assert.ok(label.length > 0, lang + " " + p + " menghasilkan label kosong");
      for (const needle of ["mappings[", "settings.", "obs.", "tiktok.", "product.title", "[0]"]) {
        assert.ok(label.indexOf(needle) === -1, lang + ' label "' + label + '" memuat path mentah');
        assert.ok(sentence.indexOf(needle) === -1, lang + ' kalimat "' + sentence + '" memuat path mentah');
      }
    }
  }
});

test("Mandarin tidak memberi spasi antara label dan lanjutannya", () => {
  const zh = I.fieldProblem("zh-CN", "obs.port", "must-be-port", "");
  assert.ok(zh.indexOf("OBS 端口必须") === 0, zh);
  // sementara Latin tetap memakai spasi
  assert.ok(/^OBS port must/.test(I.fieldProblem("en", "obs.port", "must-be-port", "")));
});

test("normalizeLang menerima bentuk yang wajar dan menolak sisanya", () => {
  assert.equal(I.normalizeLang("zh"), "zh-CN");
  assert.equal(I.normalizeLang("zh-Hans"), "zh-CN");
  assert.equal(I.normalizeLang("en-GB"), "en");
  assert.equal(I.normalizeLang("klingon"), "id");
  assert.equal(I.normalizeLang(null), "id");
});

/* === format angka dan waktu lewat Intl =================================== */

test("desimal mengikuti bahasa", () => {
  // Menulis "36.4" kepada pembaca Indonesia bukan terjemahan yang selesai.
  assert.equal(I.num("id", 36.4), "36,4");
  assert.equal(I.num("en", 36.4), "36.4");
  assert.equal(I.num("zh-CN", 36.4), "36.4");
});

test("milidetik jadi detik dengan satu angka di belakang koma", () => {
  assert.equal(I.seconds("id", 2160), "2,2");
  assert.equal(I.seconds("en", 2160), "2.2");
  assert.equal(I.seconds("id", 36400), "36,4");
  assert.equal(I.seconds("en", 50), "0.1");
});

test("KONTRAK: ICU runtime benar-benar punya data id-ID", () => {
  // Kalau Electron terpaket ternyata ber-ICU kecil, id-ID diam-diam jatuh ke
  // format Inggris dan tidak ada yang merah sampai ada yang melihat layarnya.
  // Tes ini yang merah lebih dulu.
  assert.notEqual(I.num("id", 1234.5), I.num("en", 1234.5), "id-ID tidak dibedakan dari en-US");
  assert.equal(I.localeOf("id"), "id-ID");
  assert.equal(I.localeOf("zh-CN"), "zh-CN");
});

test("jam ditampilkan 24 jam di ketiga bahasa", () => {
  const iso = "2026-10-10T09:24:11.000Z";
  for (const lang of LANGS) {
    const out = I.clockTime(lang, iso);
    assert.match(out, /\d{1,2}[:.]\d{2}[:.]\d{2}/, lang + ": " + out);
    assert.ok(!/AM|PM|am|pm/.test(out), lang + " memakai 12 jam: " + out);
  }
});

test("waktu yang tidak sah tidak merusak apa pun", () => {
  assert.equal(I.clockTime("id", "bukan tanggal"), "");
  assert.equal(I.num("id", NaN), "");
  assert.equal(I.seconds("id", undefined), "");
});
