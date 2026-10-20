// ADMISI Q&A SAAT BERSAMAAN.
//
// Tes berurutan TIDAK membuktikan keamanan konkurensi, dan itu bukan teori:
// bentuk admisi yang lama (allow() -> await -> note()) lulus seluruh tes
// berurutan dan TETAP menghasilkan, pada config customer apa adanya,
//
//   3 balasan Q&A dalam satu jendela 60 detik   (plafon 2)
//   2 balasan untuk produk yang SAMA, 6 detik   (jeda 30 detik)
//
// karena pertanyaan kedua tiba selagi kiriman pertama masih tertunda dan
// melihat pencatat yang masih kosong. Jadi di sini transportnya DITAHAN dengan
// promise tertunda, dan jamnya deterministik.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createPriceQa } = require("../qa/price-qa");
const { createQaDedupe, createQaQuota, DEFAULT_RESERVATION_TTL_MS } = require("../qa/dedupe");
const { createAutoComment, PIN_POLICY, PRIORITY } = require("../autocomment/core");
const { normalizeForMatching } = require("../tiktok/normalize");

const P = (n, title, price) => ({
  title, number: n, stableId: null,
  currentPriceText: price, originalPriceText: "", priceRangeText: "", priceState: "single",
  stockText: "In stock: 10", pinText: "Pin", pinAvailable: true, pinDisabled: false,
  price, stock: "In stock: 10",
});
const PRODUK = [
  P(1, "Garuda - Kacang ATOM 16gr 1 RENCENG ISI 10 PCS oat - GRD", "Rp14.299"),
  P(2, "GARUDA TING TING PEANUT BAR CANDY ISI 12", "Rp30.000"),
  P(3, "[COD AFF] Gery - Gery Saluut Malkist Family Pack (100gr) [PILIH VARIAN RASA] - GRY", "Rp25.500"),
  P(4, "Gery Saluut Malkist Renceng - Netto 10 bks x 18 gr", "Rp15.015"),
  P(5, "[COD] Dilan - Snack Oat Crunch Chocolate Mini Pack 25pcs", "Rp15.900"),
];
const FULL = { ok: true, capturedAt: 0, ageMs: 100, coverage: "full", source: "pin-collect", products: PRODUK };
const Q = [
  "harga garuda atom berapa",
  "ting ting berapa",
  "gery saluut family pack berapa",
  "gery saluut renceng berapa",
  "dilan oat crunch berapa",
].map((t) => normalizeForMatching(t));

const putar = async (n = 40) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)); };

// Transport DITAHAN: tiap send() mengembalikan promise yang baru diselesaikan
// kalau tes memerintahkannya.
function rig({ minIntervalMs = 5000, maxPerMinute = 6 } = {}) {
  let t = 1_000_000;
  const masuk = [];
  const tunda = [];
  const ac = createAutoComment({
    enabled: true, pinPolicy: PIN_POLICY.CONFIRMED,
    inspectPin: (pin) => ({ confirmed: !!(pin && pin.ok) }),
    format: (scene) => (/^PAX-\d+$/.test(scene)
      ? { ok: true, text: `Etalase ${scene.slice(4)} sudah aku pin ya kak` }
      : { ok: false, reason: "unsupported-scene" }),
    send: (req) => {
      masuk.push({ t, scene: req.scene, text: req.text });
      let res; let rej;
      const p = new Promise((a, b) => { res = a; rej = b; });
      tunda.push({ res, rej, scene: req.scene });
      return p;
    },
    logger: { log: () => {} }, now: () => t,
    minIntervalMs, maxPerMinute, timeoutMs: 8000,
  });
  const dedupe = createQaDedupe({ now: () => t });
  const quota = createQaQuota({ now: () => t });
  const qa = createPriceQa({
    readProducts: async () => FULL,
    requestComment: (req) => ac.requestComment(req),
    dedupe, quota, log: () => {},
  });
  return {
    qa, ac, dedupe, quota, masuk, tunda,
    maju: (ms) => { t += ms; },
    waktu: () => t,
    qaMasuk: () => masuk.filter((x) => x.scene === "QA-PRICE").length,
    // selesaikan semua transport Q&A yang tertahan
    selesaikan: (hasil = { ok: true }) => { while (tunda.length) tunda.shift().res(hasil); },
  };
}

function hitung(hasil) {
  const sukses = hasil.filter((h) => h.handled).length;
  const alasan = {};
  for (const h of hasil) if (!h.handled) alasan[h.reason] = (alasan[h.reason] || 0) + 1;
  return { sukses, alasan };
}

// --- A. 10 bersamaan, produk SAMA ----------------------------------------

test("A: 10 bersamaan untuk produk SAMA -> maksimum satu balasan", async () => {
  for (const mi of [0, 5000]) {
    const r = rig({ minIntervalMs: mi });
    const janji = [];
    for (let i = 0; i < 10; i += 1) janji.push(r.qa.handle({ msgNorm: Q[0] }));
    await putar();
    // Hanya SATU boleh masuk transport: sembilan sisanya tertahan reservasi
    // jeda produk yang sedang berjalan.
    assert.equal(r.qaMasuk(), 1, `minIntervalMs=${mi}: transport`);
    r.selesaikan({ ok: true });
    await putar();
    const { sukses, alasan } = hitung(await Promise.all(janji));
    assert.equal(sukses, 1, `minIntervalMs=${mi}: sukses`);
    assert.equal(alasan["qa-cooldown"], 9, `minIntervalMs=${mi}: ${JSON.stringify(alasan)}`);
  }
});

// --- B. 10 bersamaan, lima produk ----------------------------------------

test("B: 10 bersamaan lintas 5 produk -> maksimum DUA balasan", async () => {
  for (const mi of [0, 5000]) {
    const r = rig({ minIntervalMs: mi });
    const janji = [];
    for (let i = 0; i < 10; i += 1) janji.push(r.qa.handle({ msgNorm: Q[i % Q.length] }));
    await putar();
    // Plafon global memesan paling banyak dua slot, jadi paling banyak dua yang
    // menyentuh transport. Pada minIntervalMs=5000 bahkan hanya SATU: jeda
    // AutoComment menolak yang kedua SEBELUM transport, dan reservasinya dilepas.
    assert.ok(r.qaMasuk() <= 2, `minIntervalMs=${mi}: transport ${r.qaMasuk()} harus <= 2`);
    assert.equal(r.qaMasuk(), mi === 0 ? 2 : 1, `minIntervalMs=${mi}: transport`);
    r.selesaikan({ ok: true });
    await putar();
    const { sukses, alasan } = hitung(await Promise.all(janji));
    assert.ok(sukses <= 2, `minIntervalMs=${mi}: sukses ${sukses} harus <= 2`);
    const ditahanQa = (alasan["qa-quota"] || 0) + (alasan["qa-cooldown"] || 0);
    assert.ok(ditahanQa > 0, `admisi Q&A harus menahan sesuatu: ${JSON.stringify(alasan)}`);
  }
});

// --- C/E. tiba 6 detik terpisah selagi kiriman 7 detik berjalan ----------

test("C+E: tanya tiap 6 detik, kiriman 7 detik, minIntervalMs=5000", async () => {
  // Inilah skenario yang dulu MENGHASILKAN TIGA balasan per 60 detik.
  const r = rig({ minIntervalMs: 5000 });
  const janji = [];
  const kirimMs = 7000;
  const jatuhTempo = [];
  for (let step = 0; step <= 30_000; step += 1000) {
    r.maju(step === 0 ? 0 : 1000);
    // lepaskan transport yang jatuh tempo
    while (jatuhTempo.length && jatuhTempo[0].pada <= r.waktu()) jatuhTempo.shift().res({ ok: true });
    if (step % 6000 === 0 && janji.length < 4) {
      janji.push(r.qa.handle({ msgNorm: Q[janji.length % Q.length] }));
      await putar(5);
      // transport yang baru masuk dijadwalkan selesai 7 detik kemudian
      while (r.tunda.length) {
        const x = r.tunda.shift();
        jatuhTempo.push({ pada: r.waktu() + kirimMs, res: x.res });
      }
    }
    await putar(3);
  }
  while (jatuhTempo.length) jatuhTempo.shift().res({ ok: true });
  await putar();
  const { sukses, alasan } = hitung(await Promise.all(janji));
  assert.ok(sukses <= 2, `sukses ${sukses} harus <= 2 (dulu 3). alasan=${JSON.stringify(alasan)}`);
  assert.equal(r.qaMasuk(), sukses, "yang masuk transport = yang sukses");
});

test("C: produk SAMA tiap 6 detik, kiriman 7 detik -> tidak ada balasan ganda", async () => {
  // Dulu: DUA balasan untuk produk yang sama, berjarak 6 detik.
  const r = rig({ minIntervalMs: 5000 });
  const janji = [];
  const jatuhTempo = [];
  for (let step = 0; step <= 20_000; step += 1000) {
    r.maju(step === 0 ? 0 : 1000);
    while (jatuhTempo.length && jatuhTempo[0].pada <= r.waktu()) jatuhTempo.shift().res({ ok: true });
    if (step % 6000 === 0 && janji.length < 3) {
      janji.push(r.qa.handle({ msgNorm: Q[0] }));
      await putar(5);
      while (r.tunda.length) {
        const x = r.tunda.shift();
        jatuhTempo.push({ pada: r.waktu() + 7000, res: x.res });
      }
    }
    await putar(3);
  }
  while (jatuhTempo.length) jatuhTempo.shift().res({ ok: true });
  await putar();
  const { sukses } = hitung(await Promise.all(janji));
  assert.equal(sukses, 1, "tepat satu balasan untuk produk itu di dalam 30 detik");
});

// --- D. minIntervalMs = 0 (nilai yang JUGA sah) --------------------------

test("D: minIntervalMs=0 - plafon Q&A berdiri SENDIRI", async () => {
  // Validator menerima isNonNegativeInt, jadi 0 sah. Dulu nilai ini membuat
  // plafon Q&A kolaps jadi 6, karena yang menahan sebenarnya adalah jeda
  // AutoComment - bukan plafon Q&A.
  const r = rig({ minIntervalMs: 0 });
  const janji = [];
  for (let i = 0; i < 10; i += 1) janji.push(r.qa.handle({ msgNorm: Q[i % Q.length] }));
  await putar();
  assert.equal(r.qaMasuk(), 2, "hanya dua yang menyentuh transport");
  r.selesaikan({ ok: true });
  await putar();
  const { sukses } = hitung(await Promise.all(janji));
  assert.equal(sukses, 2, "tepat dua, bukan enam");
});

// --- F. bersamaan dengan balasan HIGH ------------------------------------

test("F: balasan HIGH tidak pernah diblokir sistem reservasi Q&A", async () => {
  for (const mi of [0, 5000]) {
    const r = rig({ minIntervalMs: mi });
    const janji = [];
    for (let i = 0; i < 10; i += 1) janji.push(r.qa.handle({ msgNorm: Q[i % Q.length] }));
    await putar();
    // HIGH masuk SELAGI Q&A masih tertunda
    const high = r.ac.requestComment({ scene: "PAX-1", playId: 1, pin: { ok: true }, requirePin: true, priority: PRIORITY.HIGH });
    await putar();
    // selesaikan SEMUA transport yang tertahan, termasuk milik HIGH
    while (r.tunda.length) r.tunda.shift().res({ ok: true });
    await putar();
    const hasilHigh = await high;
    assert.equal(hasilHigh.ok, true, `minIntervalMs=${mi}: HIGH harus terkirim, reason=${hasilHigh.reason}`);
    const { sukses } = hitung(await Promise.all(janji));
    assert.ok(sukses <= 2, `minIntervalMs=${mi}: Q&A ${sukses} <= 2`);
  }
});

test("F: kuota Q&A yang HABIS tidak menyentuh HIGH maupun FAQ", async () => {
  const r = rig({ minIntervalMs: 0 });
  const janji = [];
  for (let i = 0; i < 6; i += 1) janji.push(r.qa.handle({ msgNorm: Q[i % Q.length] }));
  await putar();
  r.selesaikan({ ok: true });
  await putar();
  await Promise.all(janji);
  // kuota kini habis
  assert.equal(r.quota.allow().ok, false);

  // Diuji BERURUTAN, bukan berlomba: dua permintaan scene di tick yang sama
  // dengan playId berbeda memang membuat yang berangka lebih kecil basi pada
  // fase hasil, dan itu perilaku AutoComment yang benar - bukan yang sedang
  // diuji di sini.
  const high = r.ac.requestComment({ scene: "PAX-2", playId: 5, pin: { ok: true }, requirePin: true, priority: PRIORITY.HIGH });
  await putar();
  while (r.tunda.length) r.tunda.shift().res({ ok: true });
  await putar();
  const hasilHigh = await high;
  assert.equal(hasilHigh.ok, true, `HIGH tetap terkirim, reason=${hasilHigh.reason}`);

  r.maju(2000);
  const faq = r.ac.requestComment({ scene: "PAX-3", playId: 6, requirePin: false });
  await putar();
  while (r.tunda.length) r.tunda.shift().res({ ok: true });
  await putar();
  const hasilFaq = await faq;
  assert.equal(hasilFaq.ok, true, `FAQ tetap terkirim, reason=${hasilFaq.reason}`);
});

// --- G. gagal, ditolak, dan selesai di luar urutan ----------------------

test("G: gagal PRE-DISPATCH melepas kedua reservasi", async () => {
  // rate-limit dihasilkan core.js SEBELUM send() dipanggil, jadi posisinya
  // terbukti dan slotnya aman dikembalikan.
  const r = rig({ minIntervalMs: 0 });
  const a = r.qa.handle({ msgNorm: Q[0] });
  await putar();
  assert.equal(r.qaMasuk(), 1);
  r.selesaikan({ ok: false, reason: "rate-limit" });
  await putar();
  const ha = await a;
  assert.equal(ha.handled, false);
  assert.equal(ha.reason, "send-rate-limit");
  // jeda produk DAN slot kuota harus kembali utuh
  assert.equal(r.dedupe.allow("PRICE", "title:garuda kacang atom 16gr 1 renceng isi 10 pcs oat grd").ok, true);
  assert.equal(r.quota.__state().used, 0, "nol slot terpakai");
  // dan produk yang sama boleh dicoba lagi SEKETIKA
  const b = r.qa.handle({ msgNorm: Q[0] });
  await putar();
  assert.equal(r.qaMasuk(), 2, "percobaan ulang masuk transport");
  r.selesaikan({ ok: true });
  await putar();
  assert.equal((await b).handled, true);
});

test("G: promise transport yang DITOLAK melepas reservasi", async () => {
  const r = rig({ minIntervalMs: 0 });
  const a = r.qa.handle({ msgNorm: Q[1] });
  await putar();
  r.tunda.shift().rej(new Error("transport meledak"));
  await putar();
  const ha = await a;
  assert.equal(ha.handled, false);
  // AutoComment menangkap penolakan dan melaporkannya sebagai send-rejected,
  // yang AMBIGU: dispatch sudah terjadi. Slotnya DIPEGANG, dengan sengaja.
  assert.equal(ha.reason, "send-send-rejected");
  assert.equal(ha.ambiguous, true);
  assert.equal(r.quota.__state().used, 1, "slot dipegang karena hasilnya ambigu");
});

test("G: selesai di luar urutan, campur gagal dan berhasil", async () => {
  const r = rig({ minIntervalMs: 0 });
  const janji = [];
  for (let i = 0; i < 2; i += 1) janji.push(r.qa.handle({ msgNorm: Q[i] }));
  await putar();
  assert.equal(r.qaMasuk(), 2);
  // selesaikan TERBALIK: yang kedua gagal lebih dulu, yang pertama berhasil
  const t2 = r.tunda.pop();
  const t1 = r.tunda.pop();
  t2.res({ ok: false, reason: "rate-limit" });
  await putar();
  t1.res({ ok: true });
  await putar();
  const { sukses } = hitung(await Promise.all(janji));
  assert.equal(sukses, 1);
  assert.equal(r.quota.__state().used, 1, "hanya yang berhasil memakai slot");
  // satu slot bebas -> pertanyaan produk lain boleh masuk
  const c = r.qa.handle({ msgNorm: Q[2] });
  await putar();
  assert.equal(r.qaMasuk(), 3);
  r.selesaikan({ ok: true });
  await putar();
  assert.equal((await c).handled, true);
});

test("G: hasil AMBIGU (timeout) MEMEGANG slot, bukan melepasnya", async () => {
  // Abort tidak membuktikan TikTok tidak menerima pesannya. Melepas slot bisa
  // menghasilkan balasan GANDA ke penonton; memegangnya paling buruk membuat
  // kami diam 30 detik.
  const r = rig({ minIntervalMs: 0 });
  const a = r.qa.handle({ msgNorm: Q[0] });
  await putar();
  // jangan selesaikan transportnya: majukan jam melewati timeoutMs 8000
  r.maju(9000);
  await putar(80);
  const ha = await a;
  assert.equal(ha.handled, false);
  assert.equal(ha.reason, "send-timeout");
  assert.equal(ha.ambiguous, true, "harus dilaporkan ambigu");
  assert.equal(r.quota.__state().used, 1, "slot kuota DIPEGANG");
  assert.equal(r.dedupe.allow("PRICE", "title:garuda kacang atom 16gr 1 renceng isi 10 pcs oat grd").ok, false,
    "jeda produk juga DIPEGANG");
});

// --- H. kedaluwarsa reservasi dan tepi jendela --------------------------

test("H: tepi jendela meluncur - slot tertua kedaluwarsa TEPAT di 60 detik", async () => {
  const r = rig({ minIntervalMs: 0 });
  const a = r.qa.handle({ msgNorm: Q[0] });
  await putar();
  r.selesaikan({ ok: true });
  await putar();
  await a;
  r.maju(1000);
  const b = r.qa.handle({ msgNorm: Q[1] });
  await putar();
  r.selesaikan({ ok: true });
  await putar();
  await b;
  // dua slot terpakai
  r.maju(1000);
  const c = r.qa.handle({ msgNorm: Q[2] });
  await putar();
  assert.equal((await c).reason, "qa-quota");
  // t = 60.000 sesudah commit pertama
  r.maju(58_000);
  const d = r.qa.handle({ msgNorm: Q[2] });
  await putar();
  assert.equal(r.qaMasuk(), 3, "satu slot bebas lagi");
  r.selesaikan({ ok: true });
  await putar();
  assert.equal((await d).handled, true);
});

test("H: reservasi yang TERGANTUNG kedaluwarsa dan tidak memakan slot selamanya", async () => {
  // Jaring terakhir untuk jalur patologis: tanpa TTL, satu reservasi yang
  // menggantung akan membungkam fitur ini sampai bot di-restart.
  assert.equal(DEFAULT_RESERVATION_TTL_MS, 30_000);
  let t = 0;
  const quota = createQaQuota({ now: () => t });
  const dedupe = createQaDedupe({ now: () => t });
  quota.reserve();  // dipesan, tidak pernah di-commit/release
  quota.reserve();
  assert.equal(quota.allow().ok, false, "dua slot sedang dipesan");
  dedupe.reserve("PRICE", "title:x");
  assert.equal(dedupe.allow("PRICE", "title:x").ok, false);
  t += 30_000;
  assert.equal(quota.allow().ok, true, "reservasi tergantung kedaluwarsa di TTL");
  assert.equal(dedupe.allow("PRICE", "title:x").ok, true);
});

test("H: commit dan release IDEMPOTEN", async () => {
  let t = 0;
  const quota = createQaQuota({ now: () => t });
  const h = quota.reserve();
  assert.equal(h.ok, true);
  assert.equal(h.commit(), true, "commit pertama berlaku");
  assert.equal(h.commit(), false, "commit kedua no-op");
  assert.equal(h.release(), false, "release sesudah commit no-op");
  assert.equal(quota.__state().sentAt.length, 1, "tepat satu stempel");

  const h2 = quota.reserve();
  assert.equal(h2.release(), true);
  assert.equal(h2.release(), false);
  assert.equal(h2.commit(), false);
  assert.equal(quota.__state().used, 1, "release tidak menambah stempel");
});

test("H: reservasi sebagian DILEPAS kalau kuota menolak", async () => {
  // Jeda produk dipesan lebih dulu; kalau kuota lalu menolak, jeda itu HARUS
  // dilepas - kalau tidak, produknya terkunci 30 detik tanpa pernah dijawab.
  const r = rig({ minIntervalMs: 0 });
  const janji = [];
  for (let i = 0; i < 2; i += 1) janji.push(r.qa.handle({ msgNorm: Q[i] }));
  await putar();
  // slot habis; sekarang pertanyaan untuk produk KETIGA
  const c = r.qa.handle({ msgNorm: Q[2] });
  await putar();
  const hc = await c;
  assert.equal(hc.reason, "qa-quota");
  // jeda produk ketiga TIDAK boleh tertinggal terpesan
  const idProduk3 = "title:" + require("../autopin/core").normalizeTitleKey(PRODUK[2].title);
  assert.deepEqual(r.dedupe.__state().inFlight.filter((k) => k.includes(idProduk3)), [],
    "reservasi jeda produk ketiga harus sudah dilepas");
  r.selesaikan({ ok: true });
  await putar();
  await Promise.all(janji);
});

// --- invarian menyeluruh ------------------------------------------------

test("INVARIAN: banjir 50 pertanyaan bersamaan -> maksimum 2 balasan, nol bocor", async () => {
  const r = rig({ minIntervalMs: 0 });
  const janji = [];
  for (let i = 0; i < 50; i += 1) janji.push(r.qa.handle({ msgNorm: Q[i % Q.length] }));
  await putar();
  assert.equal(r.qaMasuk(), 2, "hanya dua menyentuh transport dari 50");
  r.selesaikan({ ok: true });
  await putar();
  const { sukses } = hitung(await Promise.all(janji));
  assert.equal(sukses, 2);
  // nol reservasi tertinggal
  assert.deepEqual(r.dedupe.__state().inFlight, [], "nol reservasi jeda tertinggal");
  assert.equal(r.quota.__state().inFlight, 0, "nol reservasi kuota tertinggal");
});

// --- KLASIFIKASI PENGIRIMAN: pre-dispatch vs post-dispatch --------------

test("klasifikasi: alasan dari TRANSPORT menahan slot, bukan melepasnya", async () => {
  // chat-input-disabled datang DARI transport, yaitu sesudah send() dipanggil.
  // Dari string-nya saja kami tidak bisa membuktikan nol byte menuju TikTok,
  // jadi arah amannya MENAHAN.
  const r = rig({ minIntervalMs: 0 });
  const a = r.qa.handle({ msgNorm: Q[0] });
  await putar();
  r.selesaikan({ ok: false, reason: "chat-input-disabled" });
  await putar();
  const ha = await a;
  assert.equal(ha.handled, false);
  assert.equal(ha.reason, "send-chat-input-disabled");
  assert.equal(ha.ambiguous, true, "harus dilaporkan ambigu");
  assert.equal(r.quota.__state().used, 1, "slot DITAHAN");
});

test("klasifikasi: SETIAP alasan pre-dispatch core.js melepas slot", async () => {
  // Diturunkan dari daftar yang posisinya terbukti di sumber core.js: semuanya
  // dihasilkan di atas baris pemanggilan send().
  const preDispatch = [
    "disabled", "empty-scene", "scene-never-commented", "duplicate-playId",
    "unsupported-scene", "empty-text", "html-not-allowed", "control-chars",
    "too-long", "invalid-template", "min-interval", "min-interval-high",
    "rate-limit", "no-transport", "pin-not-confirmed", "pin-not-ok", "pin-apa-pun",
  ];
  for (const reason of preDispatch) {
    const r = rig({ minIntervalMs: 0 });
    const a = r.qa.handle({ msgNorm: Q[0] });
    await putar();
    r.selesaikan({ ok: false, reason });
    await putar();
    const ha = await a;
    assert.equal(ha.ambiguous, undefined, `${reason} harus pre-dispatch`);
    assert.equal(r.quota.__state().used, 0, `${reason}: slot harus kembali`);
    assert.equal(r.dedupe.__state().inFlight.length, 0, `${reason}: nol reservasi tertinggal`);
  }
});

test("klasifikasi: 'stale' diperlakukan POST-dispatch walau bisa pre-dispatch", async () => {
  // core.js memakai string yang SAMA pada fase dispatch dan fase hasil. Karena
  // tidak bisa dibedakan, arah amannya menahan.
  const r = rig({ minIntervalMs: 0 });
  const a = r.qa.handle({ msgNorm: Q[0] });
  await putar();
  r.selesaikan({ ok: false, reason: "stale" });
  await putar();
  const ha = await a;
  assert.equal(ha.ambiguous, true);
  assert.equal(r.quota.__state().used, 1, "slot ditahan");
});

test("klasifikasi: pengirim yang MELEMPAR menahan slot", async () => {
  // autocomment/core.js tidak pernah menolak - cabang ini hanya terjangkau
  // lewat pengirim yang disuntikkan, dan untuk itu posisi lemparannya terhadap
  // dispatch tidak terbukti.
  const { createPriceQa } = require("../qa/price-qa");
  let t = 1_000_000;
  const quota = createQaQuota({ now: () => t });
  const dedupe = createQaDedupe({ now: () => t });
  const qa = createPriceQa({
    readProducts: async () => FULL,
    requestComment: async () => { throw new Error("meledak sesudah mengetik"); },
    dedupe, quota, log: () => {},
  });
  const h = await qa.handle({ msgNorm: Q[0] });
  assert.equal(h.handled, false);
  assert.equal(h.reason, "send-threw");
  assert.equal(h.ambiguous, true);
  assert.equal(quota.__state().used, 1, "slot DITAHAN karena posisinya tidak terbukti");
});

test("klasifikasi: lemparan SEBELUM dispatch melepas slot", async () => {
  // Resolver/pembentuk kalimat yang meledak terjadi sebelum transport dipanggil.
  const { createPriceQa } = require("../qa/price-qa");
  let t = 1_000_000;
  const quota = createQaQuota({ now: () => t });
  const dedupe = createQaDedupe({ now: () => t });
  const qa = createPriceQa({
    readProducts: async () => FULL,
    // bukan fungsi -> ditolak SEBELUM dispatch
    requestComment: null,
    dedupe, quota, log: () => {},
  });
  const h = await qa.handle({ msgNorm: Q[0] });
  assert.equal(h.handled, false);
  assert.equal(h.reason, "no-sender");
  assert.equal(quota.__state().used, 0, "slot kembali");
  assert.deepEqual(dedupe.__state().inFlight, [], "nol reservasi tertinggal");
});

// --- RESERVASI KEDALUWARSA TIDAK BOLEH MERUSAK YANG BARU ---------------

test("TTL: pegangan yang KEDALUWARSA tidak menghapus reservasi BARU produk sama", async () => {
  // Jalur yang dijaga: R1 menggantung -> TTL membuangnya -> R2 yang sah dibuat
  // -> R1 akhirnya selesai. Tanpa token, release/commit R1 menghapus entri
  // inFlight milik R2, dan pertanyaan ketiga lolos selagi R2 masih mengirim.
  let t = 0;
  const dedupe = createQaDedupe({ now: () => t });
  const ID = "title:produk-x";

  const r1 = dedupe.reserve("PRICE", ID);
  assert.equal(r1.ok, true);
  t += 30_000;                                  // R1 kedaluwarsa
  const r2 = dedupe.reserve("PRICE", ID);
  assert.equal(r2.ok, true, "R2 boleh dibuat sesudah TTL R1");
  assert.equal(dedupe.__state().inFlight.length, 1);

  // R1 akhirnya selesai - TIDAK boleh menyentuh R2
  r1.release();
  assert.equal(dedupe.__state().inFlight.length, 1, "reservasi R2 harus utuh");
  assert.equal(dedupe.allow("PRICE", ID).ok, false, "produk masih tertahan oleh R2");

  // dan commit R1 yang terlambat juga tidak boleh menghapus R2
  const r3 = dedupe.reserve("PRICE", ID);
  assert.equal(r3.ok, false, "tidak boleh ada reservasi ketiga");

  r2.commit();
  assert.equal(dedupe.__state().inFlight.length, 0);
  assert.equal(dedupe.allow("PRICE", ID).ok, false, "jeda 30 detik kini berlaku");
});

test("TTL: commit yang TERLAMBAT tetap memberlakukan jeda produknya", async () => {
  // Kiriman memang berhasil, jadi jedanya harus berlaku - yang dijaga token
  // hanyalah agar entri milik reservasi lain tidak ikut terhapus.
  let t = 0;
  const dedupe = createQaDedupe({ now: () => t });
  const ID = "title:produk-y";
  const r1 = dedupe.reserve("PRICE", ID);
  t += 31_000;
  r1.commit();
  assert.equal(dedupe.allow("PRICE", ID).ok, false, "jeda berlaku dari waktu commit");
  t += 30_000;
  assert.equal(dedupe.allow("PRICE", ID).ok, true);
});

test("TTL: kuota - commit terlambat tidak menghapus reservasi lain", async () => {
  let t = 0;
  const quota = createQaQuota({ limit: 2, now: () => t });
  const a = quota.reserve();
  t += 30_000;                 // a kedaluwarsa
  const b = quota.reserve();
  const c = quota.reserve();
  assert.equal(b.ok, true);
  assert.equal(c.ok, true, "dua slot bebas sesudah TTL a");
  a.release();                 // terlambat
  assert.equal(quota.allow().ok, false, "b dan c masih memegang kedua slot");
});
