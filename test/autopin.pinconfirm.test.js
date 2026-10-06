// Konfirmasi pin dari dua sinyal independen.
//
// Aturan yang dijaga di sini, dan yang paling mudah dilanggar tanpa sadar:
// sinyal kedua menyembuhkan KEBUTAAN, bukan membatalkan jawaban. Bacaan tombol
// yang jelas-jelas bilang "Pin" (= TIDAK ter-pin) adalah jawaban SAH, dan
// snapshot TIDAK BOLEH dilihat sama sekali pada keadaan itu. Kalau boleh,
// sistem ini berubah dari "membuktikan" menjadi "mencari pembenaran" - dan
// chat "sudah aku pin" bisa terkirim untuk produk yang tidak ter-pin.
//
// Semua memakai fungsi palsu: tidak ada browser, TikTok, OBS, maupun
// penungguan waktu nyata.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createPinConfirmer, titleKey, VIA } = require("../autopin/pin-confirm");

const PRODUK = "Dilan PANDAN Waffle 1 BOX ISI 12 PCS Soft Wafel Kelapa Coklat";
const KEY = "pandan";

// `reads` adalah urutan hasil sinyal 1; `snapshot` adalah hasil sinyal 2.
function confirmer({ reads = [], snapshot, snapshotThrows = null, readThrows = 0 } = {}) {
  const calls = { reads: 0, snapshots: 0, sleeps: [] };
  let threw = 0;
  let i = 0;

  const c = createPinConfirmer({
    readPinState: async () => {
      calls.reads += 1;
      if (threw < readThrows) {
        threw += 1;
        throw new Error("Execution context was destroyed");
      }
      const v = reads[Math.min(i, reads.length - 1)];
      i += 1;
      return v;
    },
    collectProducts: async () => {
      calls.snapshots += 1;
      if (snapshotThrows) throw new Error(snapshotThrows);
      return snapshot === undefined ? { products: [], livePinButtonsOnPage: 0 } : snapshot;
    },
    sleep: async (ms) => {
      calls.sleeps.push(ms);
    },
  });

  return { c, calls };
}

const produkSnapshot = (over = {}) => ({
  products: [{ number: 1, title: PRODUK, pinText: "", badges: [], ariaOnRow: [], ...over }],
  livePinButtonsOnPage: 1,
});

// ---------- sinyal 1 cukup ----------

test("sinyal 1 terbaca 'Unpin' -> terkonfirmasi, dan snapshot TIDAK disentuh", async () => {
  const { c, calls } = confirmer({ reads: [{ found: true, buttons: 1, text: "Unpin" }] });
  const v = await c.confirm({}, KEY);

  assert.equal(v.confirmed, true);
  assert.equal(v.via, VIA.BUTTON);
  assert.equal(v.state, "Unpin");
  assert.equal(v.reason, "pin-confirmed");
  assert.equal(calls.snapshots, 0, "sinyal 2 tidak perlu dan tidak boleh dipanggil");
  assert.deepEqual(calls.sleeps, []);
});

test("sinyal 1 buta dulu lalu terbaca -> terkonfirmasi lewat tombol, bukan snapshot", async () => {
  const { c, calls } = confirmer({
    reads: [{ found: true, buttons: 0, text: "" }, { found: true, buttons: 0, text: "" }, { found: true, buttons: 1, text: "Unpin" }],
  });
  const v = await c.confirm({}, KEY);

  assert.equal(v.confirmed, true);
  assert.equal(v.via, VIA.BUTTON);
  assert.equal(v.reads, 3);
  assert.equal(calls.snapshots, 0);
});

// ---------- ATURAN PALING PENTING ----------

test("ATURAN: bacaan 'Pin' adalah jawaban SAH -> snapshot TIDAK PERNAH dilihat", async () => {
  // Kalau snapshot sampai dilihat di sini, ia bisa saja bilang "ter-pin" dan
  // chat palsu terkirim. Jadi yang diuji bukan cuma hasilnya, tapi bahwa
  // sinyal 2 benar-benar tidak dipanggil.
  const { c, calls } = confirmer({
    reads: [{ found: true, buttons: 1, text: "Pin" }],
    snapshot: produkSnapshot({ pinText: "Unpin", badges: ["Pinned"] }), // menggoda
  });
  const v = await c.confirm({}, KEY);

  assert.equal(v.confirmed, false);
  assert.equal(v.via, null);
  assert.equal(v.state, "Pin");
  assert.equal(v.reason, "pin-state-not-pinned");
  assert.equal(calls.snapshots, 0, "sinyal 2 WAJIB tidak tersentuh saat ada jawaban jelas");
  assert.equal(v.snapshot, "not-consulted");
});

test("ATURAN: teks tombol aneh pun dihormati sebagai jawaban, bukan dianggap buta", async () => {
  for (const text of ["Pin", "PIN", "Sematkan", "Featured", "???"]) {
    const { c, calls } = confirmer({
      reads: [{ found: true, buttons: 1, text }],
      snapshot: produkSnapshot({ badges: ["Pinned"] }),
    });
    const v = await c.confirm({}, KEY);
    assert.equal(v.confirmed, false, "text=" + text);
    assert.equal(calls.snapshots, 0, "text=" + text + ": snapshot tidak boleh dilihat");
  }
});

// ---------- sinyal 2 menyembuhkan kebutaan ----------

test("sinyal 1 buta total -> sinyal 2 lewat pinText menyelamatkan", async () => {
  const { c, calls } = confirmer({
    reads: [{ found: true, buttons: 0, text: "" }],
    snapshot: produkSnapshot({ pinText: "Unpin" }),
  });
  const v = await c.confirm({}, KEY);

  assert.equal(v.confirmed, true);
  assert.equal(v.via, VIA.SNAPSHOT_BUTTON);
  assert.equal(v.state, "Unpin", "disetarakan supaya gerbang di sisi bot tidak butuh aturan kedua");
  assert.equal(calls.snapshots, 1, "sinyal 2 dipanggil TEPAT sekali");
  assert.ok(v.snapshot.includes("via=snapshot-button"), v.snapshot);
});

test("sinyal 1 buta total -> sinyal 2 lewat badge juga menyelamatkan", async () => {
  for (const badges of [["Pinned"], ["Featured"], ["pinned product"]]) {
    const { c } = confirmer({
      reads: [{ found: true, buttons: 0, text: "" }],
      snapshot: produkSnapshot({ badges }),
    });
    const v = await c.confirm({}, KEY);
    assert.equal(v.confirmed, true, JSON.stringify(badges));
    assert.equal(v.via, VIA.SNAPSHOT_BADGE, JSON.stringify(badges));
  }
});

test("sinyal 1 buta, sinyal 2 bilang TIDAK ter-pin -> tetap ditolak", async () => {
  const { c } = confirmer({
    reads: [{ found: true, buttons: 0, text: "" }],
    snapshot: produkSnapshot({ pinText: "Pin", badges: [] }),
  });
  const v = await c.confirm({}, KEY);

  assert.equal(v.confirmed, false);
  assert.equal(v.reason, "pin-state-not-pinned", "sinyal 2 memberi jawaban negatif yang jelas");
  assert.ok(v.snapshot.includes("snapshot-not-pinned"), v.snapshot);
});

test("kedua sinyal buta -> pin-state-unreadable, dan keduanya tercatat", async () => {
  const { c } = confirmer({
    reads: [{ found: false }],
    snapshotThrows: "Execution context was destroyed",
  });
  const v = await c.confirm({}, KEY);

  assert.equal(v.confirmed, false);
  assert.equal(v.reason, "pin-state-unreadable");
  assert.ok(v.primary.includes("found=false"), "bukti sinyal 1: " + v.primary);
  assert.ok(v.snapshot.includes("snapshot-failed"), "bukti sinyal 2: " + v.snapshot);
});

test("sinyal 2: produk target tidak ada di snapshot -> ditolak, dilaporkan jelas", async () => {
  const { c } = confirmer({
    reads: [{ found: true, buttons: 0, text: "" }],
    snapshot: { products: [{ number: 1, title: "Produk Lain Sama Sekali", pinText: "Unpin", badges: ["Pinned"] }] },
  });
  const v = await c.confirm({}, KEY);

  assert.equal(v.confirmed, false, "produk LAIN yang ter-pin bukan bukti produk KITA ter-pin");
  assert.equal(v.reason, "pin-state-unreadable");
  assert.ok(v.snapshot.includes("snapshot-product-not-found"), v.snapshot);
});

test("sinyal 2: daftar produk kosong -> ditolak", async () => {
  const { c } = confirmer({ reads: [{ found: true, buttons: 0, text: "" }], snapshot: { products: [] } });
  const v = await c.confirm({}, KEY);
  assert.equal(v.confirmed, false);
  assert.ok(v.snapshot.includes("snapshot-no-products"), v.snapshot);
});

test("sinyal 2 tidak tersedia sama sekali -> tetap menolak dengan rapi", async () => {
  const c = createPinConfirmer({
    readPinState: async () => ({ found: true, buttons: 0, text: "" }),
    collectProducts: undefined,
    sleep: async () => {},
    reads: 2,
  });
  const v = await c.confirm({}, KEY);
  assert.equal(v.confirmed, false);
  assert.ok(v.snapshot.includes("snapshot-unavailable"), v.snapshot);
});

// ---------- diagnostik yang dulu hilang ----------

test("DIAGNOSTIK: baris not-found vs tombol-hilang sekarang BISA dibedakan", async () => {
  // Inilah yang dua kali membuat saya salah menebak: keduanya dulu hanya
  // terlihat sebagai state="".
  const hilangBaris = await confirmer({ reads: [{ found: false }] }).c.confirm({}, KEY);
  assert.ok(hilangBaris.primary.includes("found=false"), hilangBaris.primary);

  const hilangTombol = await confirmer({ reads: [{ found: true, buttons: 0, text: "", cls: "" }] }).c.confirm({}, KEY);
  assert.ok(hilangTombol.primary.includes("found=true"), hilangTombol.primary);
  assert.ok(hilangTombol.primary.includes("buttons=0"), hilangTombol.primary);

  assert.notEqual(hilangBaris.primary, hilangTombol.primary, "dua penyebab harus terlihat beda");
});

test("DIAGNOSTIK: pembacaan yang melempar tercatat sebagai error, bukan kosong", async () => {
  const { c } = confirmer({ reads: [{ text: "Unpin" }], readThrows: 99 });
  const v = await c.confirm({}, KEY);
  assert.ok(v.primary.includes("error="), v.primary);
});

// ---------- jendela berbatas, nol mutasi ----------

test("jendela sinyal 1 berbatas, dan sinyal 2 dipanggil paling banyak sekali", async () => {
  const { c, calls } = confirmer({ reads: [{ found: true, buttons: 0, text: "" }], snapshot: { products: [] } });
  await c.confirm({}, KEY);

  assert.equal(calls.reads, 6, "berhenti pada batas");
  assert.equal(calls.sleeps.length, 5, "tidur hanya di ANTARA bacaan");
  assert.equal(calls.sleeps.reduce((a, b) => a + b, 0), 1_250);
  assert.equal(calls.snapshots, 1, "snapshot tidak dipoll berulang");
});

test("confirm() TIDAK PERNAH melempar, apa pun yang rusak", async () => {
  const rusak = createPinConfirmer({
    readPinState: async () => {
      throw new Error("boom");
    },
    collectProducts: async () => {
      throw new Error("boom juga");
    },
    sleep: async () => {},
    reads: 2,
  });
  const v = await rusak.confirm({}, KEY);
  assert.equal(v.confirmed, false);
  assert.equal(v.reason, "pin-state-unreadable");
});

// ---------- pencocokan judul ----------

test("titleKey menormalkan sama dengan resolusi pin, jadi 'produk target' berarti sama", () => {
  assert.equal(titleKey("Dilan PANDAN Waffle 1 BOX"), "dilan pandan waffle 1 box");
  assert.equal(titleKey("Dilan  PANDAN / Waffle…"), "dilan pandan waffle");
  assert.ok(titleKey(PRODUK).includes(titleKey("pandan")));
});
