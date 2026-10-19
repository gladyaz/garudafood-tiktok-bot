// KESELAMATAN ADMISI: Product Q&A tidak boleh memakan habis anggaran balasan
// yang sudah ada.
//
// Ini bukan tes unit - ini SIMULASI dengan jam deterministik, memakai
// createAutoComment SUNGGUHAN dan angka dari config customer, plus jeda
// per-produk dan plafon admisi global yang SUNGGUHAN.
//
// Kenapa ia ada sebagai tes dan bukan sekadar pengukuran sekali jalan:
// kegagalan yang dijaganya TERUKUR dan NYATA. Sebelum plafon admisi global
// ditambahkan, 5 produk dengan jeda 30 detik menginginkan 10 balasan per menit
// terhadap plafon bersama 6, sehingga Q&A memenuhi SELURUH anggaran. Dan karena
// maxPerMinute berlaku untuk prioritas tinggi juga, balasan pin produk IKUT
// HILANG: 2 dari 2, lalu 3 dari 5. Tanpa tes ini, plafonnya bisa dilepas lagi
// tanpa ada yang berubah merah.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createAutoComment, PIN_POLICY, PRIORITY } = require("../autocomment/core");
const { createQaDedupe, createQaQuota } = require("../qa/dedupe");
const { createPriceQa } = require("../qa/price-qa");
const { normalizeForMatching } = require("../tiktok/normalize");

// Angka dari config customer apa adanya.
const MAX_PER_MINUTE = 6;
const MIN_INTERVAL_MS = 5000;

const P = (number, title, price, state) => ({
  title, number, stableId: null,
  currentPriceText: price, originalPriceText: "", priceRangeText: "", priceState: state,
  stockText: "In stock: 10", pinText: "Pin", pinAvailable: true, pinDisabled: false,
  price, stock: "In stock: 10",
});

const PRODUK = [
  P(1, "Garuda - Kacang ATOM 16gr 1 RENCENG ISI 10 PCS oat - GRD", "Rp14.299", "sale"),
  P(2, "GARUDA TING TING PEANUT BAR CANDY ISI 12", "Rp30.000", "single"),
  P(3, "[COD AFF] Gery - Gery Saluut Malkist Family Pack (100gr) [PILIH VARIAN RASA] - GRY", "Rp25.500", "sale"),
  P(4, "Gery Saluut Malkist Renceng - Netto 10 bks x 18 gr", "Rp15.015", "single"),
  P(5, "[COD] Dilan - Snack Oat Crunch Chocolate Mini Pack 25pcs", "Rp15.900", "sale"),
];
const FULL = { ok: true, capturedAt: 0, ageMs: 100, coverage: "full", source: "pin-collect", products: PRODUK };

// Satu pertanyaan per produk, semuanya ter-resolve unik.
const TANYA = [
  "harga garuda atom berapa",
  "ting ting berapa",
  "gery saluut family pack berapa",
  "gery saluut renceng berapa",
  "dilan oat crunch berapa",
].map((t) => normalizeForMatching(t));

// withQuota=false memodelkan keadaan SEBELUM perbaikan, supaya tes ini bisa
// menunjukkan apa yang sedang dijaganya.
async function simulasi({ qaPerDetik = 1, detik = 120, pinSetiap = 0, withQuota = true } = {}) {
  let t = 0;
  const terkirim = [];
  const ac = createAutoComment({
    enabled: true,
    pinPolicy: PIN_POLICY.CONFIRMED,
    inspectPin: (pin) => ({ confirmed: !!(pin && pin.ok) }),
    format: (scene) => (/^PAX-\d+$/.test(scene)
      ? { ok: true, text: `Etalase ${scene.slice(4)} sudah aku pin ya kak` }
      : { ok: false, reason: "unsupported-scene" }),
    send: async (req) => { terkirim.push({ t, scene: req.scene }); return { ok: true }; },
    logger: { log: () => {} },
    now: () => t,
    minIntervalMs: MIN_INTERVAL_MS,
    maxPerMinute: MAX_PER_MINUTE,
    timeoutMs: 8000,
  });
  const qa = createPriceQa({
    readProducts: async () => FULL,
    requestComment: (req) => ac.requestComment(req),
    dedupe: createQaDedupe({ now: () => t }),
    quota: withQuota ? createQaQuota({ now: () => t }) : null,
    log: () => {},
  });

  let qaDiminta = 0;
  let tahanKuota = 0;
  let tahanJeda = 0;
  let playId = 0;
  let highDiminta = 0;
  let highTerkirim = 0;
  const highGagal = {};

  for (let s = 0; s < detik; s += 1) {
    t = s * 1000;
    for (let i = 0; i < qaPerDetik; i += 1) {
      qaDiminta += 1;
      const h = await qa.handle({ msgNorm: TANYA[(s * qaPerDetik + i) % TANYA.length] });
      if (h.reason === "qa-quota") tahanKuota += 1;
      if (h.reason === "qa-cooldown") tahanJeda += 1;
    }
    if (pinSetiap > 0 && s > 0 && s % pinSetiap === 0) {
      playId += 1;
      highDiminta += 1;
      const res = await ac.requestComment({
        scene: `PAX-${(playId % 5) + 1}`, playId, pin: { ok: true },
        requirePin: true, priority: PRIORITY.HIGH, requesters: 1,
      });
      if (res.ok) highTerkirim += 1;
      else highGagal[res.reason] = (highGagal[res.reason] || 0) + 1;
    }
  }

  const qaKirim = terkirim.filter((x) => x.scene === "QA-PRICE").length;
  // puncak Q&A di jendela 60 detik mana pun
  let puncak = 0;
  for (const x of terkirim) {
    if (x.scene !== "QA-PRICE") continue;
    const n = terkirim.filter((y) => y.scene === "QA-PRICE" && y.t >= x.t && y.t < x.t + 60_000).length;
    if (n > puncak) puncak = n;
  }
  return { qaDiminta, qaKirim, tahanKuota, tahanJeda, puncak, highDiminta, highTerkirim, highGagal };
}

// --- SYARAT PENERIMAAN ---------------------------------------------------

test("admisi: Q&A saja, 1 tanya/detik -> puncak Q&A tidak pernah mencapai plafon bersama", async () => {
  const r = await simulasi({ qaPerDetik: 1, detik: 120 });
  assert.ok(r.puncak <= 2, `puncak ${r.puncak} harus <= 2`);
  assert.ok(r.puncak < MAX_PER_MINUTE, `Q&A tidak boleh memenuhi anggaran bersama (${MAX_PER_MINUTE})`);
  assert.ok(r.tahanKuota > 0, "plafon harus benar-benar menahan sesuatu");
});

test("admisi: Q&A saja, 5 tanya/detik (banjir) -> tetap terbatas", async () => {
  const r = await simulasi({ qaPerDetik: 5, detik: 120 });
  assert.ok(r.puncak <= 2, `puncak ${r.puncak}`);
  assert.equal(r.qaKirim, 4, "120 detik -> dua jendela -> 4 kiriman");
  assert.ok(r.qaDiminta >= 600);
});

test("admisi: Q&A + pin tiap 45 detik -> NOL balasan HIGH hilang", async () => {
  const r = await simulasi({ qaPerDetik: 5, detik: 120, pinSetiap: 45 });
  assert.ok(r.highDiminta > 0, "harus ada pin yang diminta");
  assert.equal(r.highTerkirim, r.highDiminta,
    `semua balasan pin harus terkirim; gagal=${JSON.stringify(r.highGagal)}`);
  assert.deepEqual(r.highGagal, {});
});

test("admisi: Q&A + pin tiap 20 detik -> NOL balasan HIGH hilang", async () => {
  const r = await simulasi({ qaPerDetik: 5, detik: 120, pinSetiap: 20 });
  assert.ok(r.highDiminta >= 5);
  assert.equal(r.highTerkirim, r.highDiminta,
    `semua balasan pin harus terkirim; gagal=${JSON.stringify(r.highGagal)}`);
  assert.deepEqual(r.highGagal, {});
});

// --- BUKTI bahwa plafon inilah yang menyelamatkannya --------------------

test("admisi: TANPA plafon global, balasan HIGH memang HILANG", async () => {
  // Memodelkan keadaan sebelum perbaikan. Kalau tes ini suatu saat lulus
  // dengan withQuota:false, berarti kegagalannya hilang karena hal lain dan
  // seluruh alasan plafon ini harus diperiksa ulang.
  const tanpa = await simulasi({ qaPerDetik: 5, detik: 120, pinSetiap: 45, withQuota: false });
  assert.ok(tanpa.puncak >= MAX_PER_MINUTE,
    `tanpa plafon, Q&A harus memenuhi anggaran bersama: puncak ${tanpa.puncak}`);
  assert.ok(tanpa.highTerkirim < tanpa.highDiminta,
    `tanpa plafon, balasan pin harus hilang: ${tanpa.highTerkirim}/${tanpa.highDiminta}`);

  // dan DENGAN plafon, pada skenario yang SAMA, tidak ada yang hilang
  const dengan = await simulasi({ qaPerDetik: 5, detik: 120, pinSetiap: 45, withQuota: true });
  assert.equal(dengan.highTerkirim, dengan.highDiminta);
});

test("admisi: pertanyaan untuk produk BERBEDA tetap tunduk pada plafon global", async () => {
  // Jeda per-produk saja tidak akan menahan ini: lima produk berbeda.
  let t = 0;
  const kirim = [];
  const ac = createAutoComment({
    enabled: true, pinPolicy: PIN_POLICY.IGNORE,
    format: () => ({ ok: false, reason: "unsupported-scene" }),
    send: async () => { kirim.push(t); return { ok: true }; },
    logger: { log: () => {} }, now: () => t,
    minIntervalMs: 0, maxPerMinute: MAX_PER_MINUTE, timeoutMs: 8000,
  });
  const qa = createPriceQa({
    readProducts: async () => FULL,
    requestComment: (req) => ac.requestComment(req),
    dedupe: createQaDedupe({ now: () => t }),
    quota: createQaQuota({ now: () => t }),
    log: () => {},
  });
  const alasan = [];
  for (let i = 0; i < 5; i += 1) {
    t = i * 1000;
    const h = await qa.handle({ msgNorm: TANYA[i] });
    alasan.push(h.handled ? "KIRIM" : h.reason);
  }
  assert.deepEqual(alasan, ["KIRIM", "KIRIM", "qa-quota", "qa-quota", "qa-quota"]);
  assert.equal(kirim.length, 2);
});
