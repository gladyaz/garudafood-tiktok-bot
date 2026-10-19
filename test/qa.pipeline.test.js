// Jalur Product Q&A dari ujung ke ujung, TANPA browser dan TANPA jaringan.
// Pembaca katalog dan AutoComment disuntikkan; yang diuji adalah urutan
// gerbang, perilaku jeda, dan kegagalan snapshot.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { createPriceQa, QA_SCENE } = require("../qa/price-qa");
const { createQaDedupe, createQaQuota, DEFAULT_QUOTA_LIMIT, DEFAULT_QUOTA_WINDOW_MS } = require("../qa/dedupe");
const { productIdentity } = require("../qa/resolve-product");
const { normalizeForMatching } = require("../tiktok/normalize");

// Pagar tingkat sumber diperiksa atas KODE, bukan atas prosa. Berkas-berkas ini
// menjelaskan dalam komentarnya apa yang sengaja TIDAK mereka lakukan
// ("tidak pernah jatuh ke discovery Controller", "tidak menyentuh playId"), dan
// pencarian kata mentah akan salah menuduh komentar itu sebagai pelanggaran.
function kodeSaja(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

const PRODUK = [
  { title: "Garuda - Kacang ATOM 16gr 1 RENCENG ISI 10 PCS oat - GRD", number: 1, stableId: null, currentPriceText: "Rp14.299", originalPriceText: "Rp23.000", priceRangeText: "", priceState: "sale", stockText: "In stock: 863", pinText: "Pin", pinAvailable: true, pinDisabled: false, price: "Rp14.299", stock: "In stock: 863" },
  { title: "GARUDA TING TING PEANUT BAR CANDY ISI 12", number: 2, stableId: null, currentPriceText: "Rp30.000", originalPriceText: "", priceRangeText: "", priceState: "single", stockText: "Low stock: 10", pinText: "Pin", pinAvailable: true, pinDisabled: false, price: "Rp30.000", stock: "Low stock: 10" },
  { title: "[COD AFF] Gery - Gery Saluut Malkist Family Pack (100gr) [PILIH VARIAN RASA] - GRY", number: 3, stableId: null, currentPriceText: "Rp25.500", originalPriceText: "Rp49.999", priceRangeText: "", priceState: "sale", stockText: "In stock: 572", pinText: "Pin", pinAvailable: true, pinDisabled: false, price: "Rp25.500", stock: "In stock: 572" },
  { title: "Gery Saluut Malkist Renceng - Netto 10 bks x 18 gr", number: 4, stableId: null, currentPriceText: "Rp15.015", originalPriceText: "", priceRangeText: "", priceState: "single", stockText: "In stock: 34", pinText: "Pin", pinAvailable: true, pinDisabled: false, price: "Rp15.015", stock: "In stock: 34" },
  { title: "[COD] Dilan - Snack Oat Crunch Chocolate & Crunchy Caramel Mini Pack 25pcs", number: 5, stableId: null, currentPriceText: "Rp15.900", originalPriceText: "Rp65.956", priceRangeText: "", priceState: "sale", stockText: "In stock: 73", pinText: "Pin", pinAvailable: true, pinDisabled: false, price: "Rp15.900", stock: "In stock: 73" },
];

const FULL = { ok: true, capturedAt: 1_000_000, ageMs: 500, coverage: "full", source: "pin-collect", products: PRODUK };

// Rig: pembaca katalog + AutoComment palsu yang mencatat semua permintaan.
function rig({ snapshot = FULL, sendResult = { ok: true, reason: "sent" }, cooldownMs = 30_000, enabled = true, quotaLimit = 2 } = {}) {
  let t = 1_000_000;
  const kirim = [];
  const baca = [];
  const log = [];
  const qa = createPriceQa({
    enabled,
    readProducts: async (opts) => { baca.push(opts); return typeof snapshot === "function" ? snapshot() : snapshot; },
    requestComment: async (req) => { kirim.push(req); return typeof sendResult === "function" ? sendResult(req) : sendResult; },
    dedupe: createQaDedupe({ cooldownMs, now: () => t }),
    // Rig MENIRU produksi: plafon admisi global ikut dipasang.
    quota: createQaQuota({ limit: quotaLimit, now: () => t }),
    log: (line) => log.push(line),
  });
  return {
    qa, kirim, baca, log,
    maju: (ms) => { t += ms; },
    tanya: (teks) => qa.handle({ msgNorm: normalizeForMatching(String(teks).toLowerCase().trim()), nickname: "penonton" }),
  };
}

// --- jalur bahagia --------------------------------------------------------

test("pipeline: pertanyaan harga yang jelas dijawab satu kali", async () => {
  const r = rig();
  const hasil = await r.tanya("harga garuda atom berapa");
  assert.equal(hasil.handled, true);
  assert.equal(r.kirim.length, 1);
  assert.equal(r.kirim[0].text, "Harga yang tampil di etalase saat ini Rp14.299 ya kak 😊");
});

test("pipeline: permintaan kirim memakai requirePin=false dan NORMAL", async () => {
  const r = rig();
  await r.tanya("harga garuda atom berapa");
  const req = r.kirim[0];
  assert.equal(req.requirePin, false, "Q&A tidak menjanjikan pin apa pun");
  assert.equal(req.priority, undefined, "prioritas dibiarkan bawaan = NORMAL");
  assert.notEqual(req.priority, "high");
  assert.equal(req.scene, QA_SCENE);
  assert.equal(req.playId, undefined, "Q&A tidak memutar apa pun: playId tidak dioper");
});

test("pipeline: label scene Q&A bukan scene OBS dan bukan PAX", () => {
  assert.equal(QA_SCENE, "QA-PRICE");
  const { etalaseNumber } = require("../autocomment/formatter");
  assert.equal(etalaseNumber(QA_SCENE), null, "tidak boleh cocok PAX-N di formatter");
  assert.notEqual(QA_SCENE, "MAIN");
});

test("pipeline: minta snapshot dengan ambang kutip dan refresh if-stale", async () => {
  const r = rig();
  await r.tanya("harga garuda atom berapa");
  assert.equal(r.baca.length, 1);
  assert.equal(r.baca[0].maxAgeMs, 30_000);
  assert.equal(r.baca[0].refresh, "if-stale");
});

// --- yang TIDAK boleh memicu Q&A -----------------------------------------

test("pipeline: komentar non-harga tidak membaca katalog dan tidak mengirim", async () => {
  const r = rig();
  for (const t of ["garuda enak", "aku suka garuda", "spill garuda", "garuda ada", "garuda stok", "garuda mahal", "harga diri", "berapa viewer", "cara order", "ini ai ya", "boikot ai"]) {
    const hasil = await r.tanya(t);
    assert.equal(hasil.handled, false, t);
  }
  assert.equal(r.kirim.length, 0, "nol kiriman");
  assert.equal(r.baca.length, 0, "nol pembacaan katalog: intent gagal lebih dulu");
  assert.equal(r.log.length, 0, "nol log: mayoritas komentar LIVE lewat sini");
});

test("pipeline: ambigu -> DIAM, dan tidak mengirim apa pun", async () => {
  const r = rig();
  for (const t of ["garuda berapa", "berapa harga garuda", "gery saluut berapa"]) {
    const hasil = await r.tanya(t);
    assert.equal(hasil.handled, false, t);
    assert.equal(hasil.reason, "ambiguous-product", t);
  }
  assert.equal(r.kirim.length, 0);
});

// --- kegagalan snapshot: SEMUA gagal-tertutup ----------------------------

test("snapshot: tidak tersedia -> DIAM", async () => {
  const r = rig({ snapshot: { ok: false, error: "product-snapshot-unavailable" } });
  const hasil = await r.tanya("harga garuda atom berapa");
  assert.equal(hasil.handled, false);
  assert.equal(hasil.reason, "product-snapshot-unavailable");
  assert.equal(r.kirim.length, 0);
});

test("snapshot: basi -> DIAM", async () => {
  const r = rig({ snapshot: { ok: false, error: "product-snapshot-stale", ageMs: 45_000 } });
  const hasil = await r.tanya("harga garuda atom berapa");
  assert.equal(hasil.reason, "product-snapshot-stale");
  assert.equal(r.kirim.length, 0);
});

test("snapshot: viewport + resolusi judul -> DIAM", async () => {
  const r = rig({ snapshot: { ...FULL, coverage: "viewport", source: "refresh" } });
  const hasil = await r.tanya("harga garuda atom berapa");
  assert.equal(hasil.reason, "coverage-insufficient");
  assert.equal(r.kirim.length, 0);
});

test("snapshot: viewport + nomor eksplisit -> BOLEH menjawab", async () => {
  const r = rig({ snapshot: { ...FULL, coverage: "viewport", source: "warmup" } });
  const hasil = await r.tanya("berapa yang nomor 1");
  assert.equal(hasil.handled, true);
  assert.equal(r.kirim.length, 1);
});

test("snapshot: priceState unknown -> DIAM walau legacy price terisi", async () => {
  const rusak = [{ ...PRODUK[0], priceState: "unknown", currentPriceText: "", price: "Rp14.299" }];
  const r = rig({ snapshot: { ...FULL, products: rusak } });
  const hasil = await r.tanya("harga garuda atom berapa");
  assert.equal(hasil.handled, false);
  assert.match(hasil.reason, /price-state-unknown|empty-price/);
  assert.equal(r.kirim.length, 0);
});

test("snapshot: currentPriceText kosong -> DIAM", async () => {
  const r = rig({ snapshot: { ...FULL, products: [{ ...PRODUK[0], currentPriceText: "" }] } });
  assert.equal((await r.tanya("harga garuda atom berapa")).handled, false);
  assert.equal(r.kirim.length, 0);
});

test("snapshot: bentuk rentang tak didukung -> DIAM", async () => {
  const rentang = [{ ...PRODUK[0], priceState: "range", currentPriceText: "", priceRangeText: "Rp12.000 - Rp18.000" }];
  const r = rig({ snapshot: { ...FULL, products: rentang } });
  const hasil = await r.tanya("harga garuda atom berapa");
  assert.equal(hasil.handled, false);
  assert.equal(r.kirim.length, 0);
});

test("snapshot: pembaca habis waktu / melempar -> DIAM, tidak melempar keluar", async () => {
  const qa = createPriceQa({
    readProducts: async () => { throw new Error("aborted"); },
    requestComment: async () => ({ ok: true, reason: "sent" }),
    dedupe: createQaDedupe(),
  });
  const hasil = await qa.handle({ msgNorm: "harga garuda atom berapa" });
  assert.equal(hasil.handled, false);
  assert.equal(hasil.reason, "qa-threw");
});

test("snapshot: tanpa pembaca -> DIAM", async () => {
  const qa = createPriceQa({ requestComment: async () => ({ ok: true }), dedupe: createQaDedupe() });
  assert.equal((await qa.handle({ msgNorm: "harga garuda atom berapa" })).reason, "no-catalogue-reader");
});

test("pipeline: TIDAK ADA cadangan ke browser kedua / discovery Controller", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "qa", "price-qa.js"), "utf8");
  const deps = [...src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
  // Daftar dependensi TERTUTUP: inilah pagar sebenarnya.
  assert.deepEqual(deps.sort(), ["./intent-price", "./reply-price", "./resolve-product"]);
  const kode = kodeSaja(src);
  for (const t of ["puppeteer", "launchBrowser", "discovery", "api/tiktok", "collectProducts"]) {
    assert.ok(!kode.includes(t), `${t} tidak boleh jadi cadangan`);
  }
});

// --- JEDA PER-PRODUK -----------------------------------------------------

test("dedupe: kirim sekali, lalu DIAM di detik ke-5 dan ke-29,9", async () => {
  const r = rig();
  assert.equal((await r.tanya("harga garuda atom berapa")).handled, true);
  assert.equal(r.kirim.length, 1);

  r.maju(5_000);
  let h = await r.tanya("harga garuda atom berapa");
  assert.equal(h.handled, false, "5 detik -> ditahan");
  assert.equal(h.reason, "qa-cooldown");

  r.maju(24_900); // total 29.900 ms
  h = await r.tanya("garuda kacangnya berapa kak");
  assert.equal(h.handled, false, "29,9 detik -> masih ditahan");
  assert.equal(h.reason, "qa-cooldown");
  assert.equal(r.kirim.length, 1, "tetap satu kiriman");
});

test("dedupe: sesudah 30 detik boleh menjawab lagi", async () => {
  const r = rig();
  await r.tanya("harga garuda atom berapa");
  r.maju(30_000);
  const h = await r.tanya("harga garuda atom berapa");
  assert.equal(h.handled, true);
  assert.equal(r.kirim.length, 2);
});

test("dedupe: produk LAIN tetap boleh dijawab di dalam jendela", async () => {
  const r = rig();
  await r.tanya("harga garuda atom berapa");
  r.maju(3_000);
  const h = await r.tanya("ting ting berapa");
  assert.equal(h.handled, true, "produk berbeda -> boleh");
  assert.equal(r.kirim.length, 2);
  assert.ok(r.kirim[1].text.includes("Rp30.000"));
});

test("dedupe: kiriman GAGAL tidak memakan jendela", async () => {
  // Kalau jendelanya termakan oleh kegagalan, produk itu bungkam 30 detik
  // tanpa pernah ada satu pun penonton yang mendapat jawaban.
  let gagalDulu = true;
  const r = rig({
    sendResult: () => {
      if (gagalDulu) { gagalDulu = false; return { ok: false, reason: "min-interval" }; }
      return { ok: true, reason: "sent" };
    },
  });
  const pertama = await r.tanya("harga garuda atom berapa");
  assert.equal(pertama.handled, false);
  assert.match(pertama.reason, /^send-/);

  r.maju(1_000); // masih jauh di dalam 30 detik
  const kedua = await r.tanya("harga garuda atom berapa");
  assert.equal(kedua.handled, true, "percobaan ulang TIDAK boleh ter-dedupe");
  assert.equal(r.kirim.length, 2);
});

test("dedupe: kiriman dry-run DIANGGAP terkirim", async () => {
  // Dry-run adalah gladi bersih dari kiriman yang berhasil; memperlakukannya
  // sebagai gagal akan membuat gladi bersih bebas spam dengan cara yang
  // produksi tidak, sehingga justru menyembunyikan masalah.
  const r = rig({ sendResult: { ok: true, reason: "dry-run", dryRun: true } });
  assert.equal((await r.tanya("harga garuda atom berapa")).handled, true);
  r.maju(2_000);
  assert.equal((await r.tanya("harga garuda atom berapa")).reason, "qa-cooldown");
});

test("dedupe: identitas memakai judul, jadi pergeseran NOMOR tidak membuka jendela", async () => {
  // Sesudah pin, nomor etalase bergeser. Kunci yang memakai nomor akan
  // menganggap produk yang sama sebagai produk baru.
  const digeser = PRODUK.map((p) => ({ ...p, number: p.number + 1 }));
  let katalog = FULL;
  const r = rig({ snapshot: () => katalog });
  await r.tanya("harga garuda atom berapa");
  assert.equal(r.kirim.length, 1);

  katalog = { ...FULL, products: digeser };
  r.maju(2_000);
  const h = await r.tanya("harga garuda atom berapa");
  assert.equal(h.reason, "qa-cooldown", "produk yang sama walau nomornya bergeser");
  assert.equal(r.kirim.length, 1);
});

test("dedupe: jeda Q&A TIDAK menyentuh jalur lain", () => {
  // Lingkupnya sempit: hanya jalur Q&A yang memanggil modul ini.
  const peta = kodeSaja(fs.readFileSync(path.join(__dirname, "..", "qa", "dedupe.js"), "utf8"));
  assert.ok(!peta.includes("requirePin"), "dedupe tidak tahu apa pun soal pin");
  assert.ok(!peta.includes("playId"), "dedupe tidak menyentuh semantik playId");
  assert.ok(!peta.includes("priority"), "dedupe tidak tahu apa pun soal prioritas");

  // dan tidak ada pemakai lain di repo selain jalur Q&A
  const root = path.join(__dirname, "..");
  const pemakai = [];
  for (const dir of ["", "autocomment", "autopin", "runtime", "controller", "tiktok", "qa"]) {
    const d = path.join(root, dir);
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      if (!f.isFile() || !f.name.endsWith(".js")) continue;
      const src = fs.readFileSync(path.join(d, f.name), "utf8");
      if (src.includes("qa/dedupe") || src.includes("./dedupe")) pemakai.push(path.join(dir, f.name));
    }
  }
  assert.deepEqual(pemakai.sort(), ["index.js", path.join("qa", "price-qa.js")].sort());
});

test("dedupe: ingatan tidak tumbuh tanpa batas", () => {
  let t = 0;
  const d = createQaDedupe({ now: () => t });
  for (let i = 0; i < 2_000; i += 1) {
    d.note("PRICE", `title:produk-${i}`);
    t += 1_000;
  }
  assert.ok(d.__state().size <= 600, `ukuran ${d.__state().size}`);
});

// --- Q&A dimatikan bersama AutoComment -----------------------------------

test("pipeline: Q&A mati kalau AutoComment mati", async () => {
  const r = rig({ enabled: false });
  const h = await r.tanya("harga garuda atom berapa");
  assert.equal(h.handled, false);
  assert.equal(h.reason, "disabled");
  assert.equal(r.baca.length, 0);
  assert.equal(r.kirim.length, 0);
});

// --- GERBANG SINKRON: biaya per-komentar ---------------------------------

test("precheck: SINKRON, tidak mengembalikan promise", () => {
  // Kalau penolakan murah ini terjadi di dalam fungsi async, setiap komentar
  // LIVE mengalokasikan rantai promise hanya untuk dibuang. Terukur: 50.000
  // komentar menaikkan heap 10,4 MB sebelum perbaikan ini, 1,2 MB sesudahnya
  // (test/load.soak.test.js).
  const r = rig();
  const hasil = r.qa.precheck("mantap kak");
  assert.equal(typeof hasil.then, "undefined", "precheck tidak boleh async");
  assert.equal(hasil.price, false);
});

test("precheck: menolak pemblokir dan komentar tanpa isyarat harga", () => {
  const r = rig();
  for (const t of ["mantap kak", "halo kak nanya ongkir", "garuda enak", "garuda stok"]) {
    assert.equal(r.qa.precheck(normalizeForMatching(t)).price, false, t);
  }
  assert.equal(r.qa.precheck(normalizeForMatching("harga garuda atom berapa")).price, true);
});

test("precheck: Q&A yang dimatikan menolak di gerbang sinkron", () => {
  const r = rig({ enabled: false });
  const hasil = r.qa.precheck("harga garuda atom berapa");
  assert.equal(hasil.price, false);
  assert.equal(hasil.reason, "disabled");
});

test("precheck: intent yang sudah dihitung DIPAKAI ULANG oleh handle", async () => {
  // Tanpa ini, intent dihitung dua kali per pertanyaan harga.
  const r = rig();
  const intent = r.qa.precheck(normalizeForMatching("harga garuda atom berapa"));
  // intent palsu yang mustahil dihasilkan dari teksnya: kalau handle
  // menghitung ulang, ia akan mengabaikan nilai ini dan tetap menjawab #1.
  const hasil = await r.qa.handle({ msgNorm: "teks yang tidak relevan", intent: { ...intent, words: ["ting", "ting"] } });
  assert.equal(hasil.handled, true);
  assert.equal(hasil.product, 2, "harus memakai intent yang dioper, bukan menghitung ulang");
});

// =========================================================================
// PLAFON ADMISI GLOBAL Q&A: 2 kiriman BERHASIL per 60 detik meluncur
// =========================================================================

test("kuota: kebijakan 2 per 60 detik, meluncur", () => {
  assert.equal(DEFAULT_QUOTA_LIMIT, 2);
  assert.equal(DEFAULT_QUOTA_WINDOW_MS, 60_000);
});

test("kuota: dua produk BERBEDA lolos, yang ketiga ditahan di dalam 60 detik", async () => {
  const r = rig();
  assert.equal((await r.tanya("harga garuda atom berapa")).handled, true, "pertama lolos");
  r.maju(1_000);
  assert.equal((await r.tanya("ting ting berapa")).handled, true, "kedua, produk lain, lolos");
  r.maju(1_000);
  const ketiga = await r.tanya("gery saluut renceng berapa");
  assert.equal(ketiga.handled, false, "ketiga harus ditahan plafon global");
  assert.equal(ketiga.reason, "qa-quota");
  assert.equal(r.kirim.length, 2, "tepat dua kiriman");
});

test("kuota: pada TEPAT 60 detik slot tertua kedaluwarsa", async () => {
  const r = rig();
  await r.tanya("harga garuda atom berapa");   // t = 0
  r.maju(1_000);
  await r.tanya("ting ting berapa");            // t = 1000
  r.maju(1_000);
  assert.equal((await r.tanya("gery saluut renceng berapa")).reason, "qa-quota");

  // maju ke tepat 60.000 ms sesudah kiriman PERTAMA
  r.maju(58_000); // total 60.000
  const lagi = await r.tanya("gery saluut renceng berapa");
  assert.equal(lagi.handled, true, "slot pertama sudah kedaluwarsa di tepat 60 detik");
  assert.equal(r.kirim.length, 3);
});

test("kuota: sebelum 60 detik, slot tertua BELUM kedaluwarsa", async () => {
  const r = rig();
  await r.tanya("harga garuda atom berapa");
  r.maju(1_000);
  await r.tanya("ting ting berapa");
  r.maju(58_998); // total 59.998 - masih di dalam jendela
  assert.equal((await r.tanya("gery saluut renceng berapa")).reason, "qa-quota");
});

test("kuota: kiriman GAGAL tidak memakai slot", async () => {
  let gagal = 2;
  const r = rig({ sendResult: () => (gagal-- > 0 ? { ok: false, reason: "min-interval" } : { ok: true, reason: "sent" }) });
  // dua pertanyaan pertama GAGAL terkirim
  assert.equal((await r.tanya("harga garuda atom berapa")).handled, false);
  r.maju(1_000);
  assert.equal((await r.tanya("ting ting berapa")).handled, false);
  r.maju(1_000);
  // kuota harus masih penuh dua slot
  assert.equal((await r.tanya("gery saluut renceng berapa")).handled, true);
  r.maju(1_000);
  assert.equal((await r.tanya("gery saluut family pack berapa")).handled, true);
  r.maju(1_000);
  const kelima = await r.tanya("dilan oat crunch berapa");
  assert.equal(kelima.reason, "qa-quota", "baru sekarang kuotanya habis");
});

test("kuota: pertanyaan yang ter-DEDUPE tidak memakai slot", async () => {
  const r = rig();
  assert.equal((await r.tanya("harga garuda atom berapa")).handled, true);
  r.maju(1_000);
  // produk SAMA -> ditahan jeda 30 detik, BUKAN kuota
  const ulang = await r.tanya("garuda kacangnya berapa kak");
  assert.equal(ulang.reason, "qa-cooldown", "ditahan jeda per-produk");
  r.maju(1_000);
  // kuota masih punya satu slot
  assert.equal((await r.tanya("ting ting berapa")).handled, true);
  r.maju(1_000);
  assert.equal((await r.tanya("gery saluut renceng berapa")).reason, "qa-quota");
});

test("kuota: pertanyaan ambigu / basi / unknown tidak memakai apa pun", async () => {
  const r = rig();
  for (let i = 0; i < 10; i += 1) {
    await r.tanya("garuda berapa");       // ambigu
    await r.tanya("yang dalezz berapa");  // tidak ketemu
    r.maju(100);
  }
  assert.equal(r.kirim.length, 0);
  // kuota utuh: dua kiriman masih mungkin
  assert.equal((await r.tanya("harga garuda atom berapa")).handled, true);
  r.maju(1_000);
  assert.equal((await r.tanya("ting ting berapa")).handled, true);
});

test("kuota: snapshot basi tidak memakai slot", async () => {
  const basi = rig({ snapshot: { ok: false, error: "product-snapshot-stale", ageMs: 45_000 } });
  for (let i = 0; i < 5; i += 1) { await basi.tanya("harga garuda atom berapa"); basi.maju(100); }
  assert.equal(basi.kirim.length, 0);
});

test("kuota: jeda per-produk dan plafon global BERSUSUN benar", async () => {
  // Tiga produk, jeda 30 detik, plafon 2 per 60 detik. Yang mengikat lebih dulu
  // harus yang paling ketat pada saat itu.
  const r = rig();
  const urut = [];
  const tanya = async (teks, label) => {
    const h = await r.tanya(teks);
    urut.push(`${label}:${h.handled ? "KIRIM" : h.reason}`);
  };
  await tanya("harga garuda atom berapa", "t0-p1");      // KIRIM (slot 1)
  r.maju(2_000);
  await tanya("ting ting berapa", "t2-p2");               // KIRIM (slot 2)
  r.maju(2_000);
  await tanya("gery saluut renceng berapa", "t4-p4");     // kuota
  r.maju(2_000);
  await tanya("harga garuda atom berapa", "t6-p1");       // jeda produk (diperiksa SEBELUM kuota)
  r.maju(55_000); // t = 61.000 -> slot t0 kedaluwarsa; jeda p1 (30s) juga lewat
  await tanya("harga garuda atom berapa", "t61-p1");      // KIRIM
  r.maju(500);
  await tanya("gery saluut renceng berapa", "t61-p4");    // kuota: slot t2 masih hidup? t2+60000=62000 > 61500 -> ya
  assert.deepEqual(urut, [
    "t0-p1:KIRIM",
    "t2-p2:KIRIM",
    "t4-p4:qa-quota",
    "t6-p1:qa-cooldown",
    "t61-p1:KIRIM",
    "t61-p4:qa-quota",
  ], urut.join(" | "));
});

test("kuota: TIDAK diantrekan untuk nanti", () => {
  // Jawaban harga yang telat lebih buruk daripada diam.
  const kode = kodeSaja(fs.readFileSync(path.join(__dirname, "..", "qa", "dedupe.js"), "utf8"));
  for (const t of ["setTimeout", "setInterval", "queue", "pending", "defer"]) {
    assert.ok(!kode.includes(t), `${t} menandakan penundaan`);
  }
});

test("kuota: jendela MELUNCUR, bukan ember menit kalender", () => {
  const kode = kodeSaja(fs.readFileSync(path.join(__dirname, "..", "qa", "dedupe.js"), "utf8"));
  for (const t of ["getMinutes", "getSeconds", "minuteBucket", "Math.floor"]) {
    assert.ok(!kode.includes(t), `${t} menandakan ember`);
  }
  // dan dibuktikan pada tepi: dua kiriman berjarak 1 detik yang menyeberangi
  // pergantian menit tetap memakai dua slot.
  let t = 59_500;
  const q = createQaQuota({ now: () => t });
  assert.equal(q.allow().ok, true); q.note();
  t = 60_500; // menyeberangi menit
  assert.equal(q.allow().ok, true); q.note();
  t = 60_600;
  assert.equal(q.allow().ok, false, "ember menit akan membiarkan ini lolos");
});

test("kuota: urutan gerbang - kuota diperiksa SESUDAH jeda, SEBELUM kirim", () => {
  const kode = kodeSaja(fs.readFileSync(path.join(__dirname, "..", "qa", "price-qa.js"), "utf8"));
  const iDedupe = kode.indexOf("dedupe.allow");
  const iQuota = kode.indexOf("quota.allow");
  const iSend = kode.indexOf("requestComment({");
  const iNoteD = kode.indexOf("dedupe.note");
  const iNoteQ = kode.indexOf("quota.note");
  assert.ok(iDedupe > 0 && iQuota > iDedupe, "kuota sesudah jeda per-produk");
  assert.ok(iSend > iQuota, "kirim sesudah kuota");
  assert.ok(iNoteD > iSend && iNoteQ > iSend, "KEDUA pencatat sesudah kirim");
});
