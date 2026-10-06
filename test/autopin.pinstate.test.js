// Pembacaan state pin sesudah klik.
//
// Regresi LIVE 2026-10-05. Tiga dari empat pin terakhir mengembalikan state
// KOSONG walau kliknya berhasil:
//
//   [AUTOPIN_SERVICE_PINNED] scene=PAX-1 title="Dilan Bon Bon ..."   <- tanpa after=
//   [AUTOPIN_SUCCESS] ... clicked=true state=""
//   [AUTOCOMMENT_SKIPPED] reason=pin-state-unreadable
//
// Kartu produk ter-render ulang begitu menjadi featured: barisnya masih ketemu
// lewat judul, tapi tombol Pin/Unpin di dalamnya sesaat tidak ada, jadi
// `btn ? btn.textContent : ""` pulang kosong. Gerbang semantik lalu menahan chat
// - itu BENAR, ia tidak boleh mengklaim pin yang tak terbukti - tapi akibatnya
// kaki AutoComment mati padahal pin-nya sukses.
//
// Yang diuji di sini: pembacaannya diulang dalam jendela berbatas, MURNI
// MEMBACA, dan tidak pernah menghasilkan klik pin kedua.
//
// Semua memakai halaman palsu: tidak ada browser, TikTok, OBS, maupun
// penungguan waktu nyata.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createService } = require("../autopin/service");
const { inspectPinResult } = require("../autopin/pin-result");

const CONSOLE = "https://shop.tiktok.com/streamer/live/product/dashboard";
const SHOP = "agen_mulia_abadi";
const PRODUK = "Dilan PANDAN Waffle 1 BOX ISI 12 PCS Soft Wafel Kelapa Coklat";

// Service dengan halaman palsu. `states` adalah urutan hasil baca state pin:
// tiap permintaan baca mengambil elemen berikutnya, dan elemen terakhir
// dipakai terus kalau pembacaan berlanjut.
function svcWith({ states, readThrows = 0 } = {}) {
  const calls = { pinClicks: 0, stateReads: 0, sleeps: [] };
  let threw = 0;
  let i = 0;

  const svc = createService({
    config: { consoleUrl: CONSOLE, expectedShop: SHOP, forbiddenShops: ["garudafood"] },
    deps: {
      launchBrowser: async () => ({ id: "fake" }),
      getPage: async () => ({ url: () => CONSOLE, isClosed: () => false, bringToFront: async () => {} }),
      newPage: async () => ({ url: () => CONSOLE, isClosed: () => false }),
      openConsole: async () => ({ url: CONSOLE, settled: true, readyMs: 1 }),
      closeBrowser: async () => {},
      readIdentity: async () => [SHOP],
      waitForComposerReady: async () => ({ ready: true, ms: 0, polls: 1 }),
      collectProducts: async () => ({
        products: [{ number: 1, title: PRODUK, pinButtons: 1, pinVisible: true, pinDisabled: false }],
        livePinButtonsOnPage: 1,
      }),
      pinProductByTitle: async (_p, key) => {
        calls.pinClicks += 1;
        return { ok: true, title: PRODUK, key };
      },
      readPinState: async () => {
        calls.stateReads += 1;
        if (threw < readThrows) {
          threw += 1;
          throw new Error("Execution context was destroyed");
        }
        const v = states[Math.min(i, states.length - 1)];
        i += 1;
        return v;
      },
      // Tidur palsu: jendela diuji tanpa benar-benar menunggu.
      sleep: async (ms) => {
        calls.sleeps.push(ms);
      },
    },
  });

  return { svc, calls };
}

const pin = (svc) => svc.handlePin({ scene: "PAX-2", productKey: "pandan", playId: 1 });

// ---------- pembacaan langsung berhasil ----------

test("state terbaca pada bacaan pertama: satu baca, NOL tidur", async () => {
  const { svc, calls } = svcWith({ states: [{ text: "Unpin" }] });
  const r = await pin(svc);

  assert.equal(r.ok, true);
  assert.equal(r.state, "Unpin");
  assert.equal(calls.stateReads, 1);
  assert.deepEqual(calls.sleeps, [], "tidak perlu menunggu kalau sudah terbaca");
  assert.equal(inspectPinResult(r).confirmed, true, "gerbang semantik meloloskan");
});

// ---------- INTI REGRESI ----------

test("INTI REGRESI: state kosong dulu lalu terbaca -> pin TETAP terkonfirmasi", async () => {
  // Inilah kejadian di LIVE: bacaan pertama kosong karena kartu ter-render
  // ulang. Sebelum perbaikan, di sini chat langsung ditahan.
  const { svc, calls } = svcWith({ states: [{ text: "" }, { text: "" }, { text: "Unpin" }] });
  const r = await pin(svc);

  assert.equal(r.ok, true);
  assert.equal(r.state, "Unpin", "state akhirnya terbaca");
  assert.equal(calls.stateReads, 3);
  assert.deepEqual(calls.sleeps, [250, 250], "dua kali menunggu di antara bacaan");

  const gate = inspectPinResult(r);
  assert.equal(gate.confirmed, true, "chat sekarang boleh dikirim");
  assert.equal(gate.reason, "pin-confirmed");
});

test("INTI REGRESI: pembacaan berulang TIDAK PERNAH mengklik pin lagi", async () => {
  // Pembatas terpenting. Mengulang baca itu aman; mengulang klik akan
  // membatalkan pin yang baru saja dibuat.
  const { svc, calls } = svcWith({ states: [{ text: "" }, { text: "" }, { text: "" }, { text: "Unpin" }] });
  await pin(svc);

  assert.equal(calls.pinClicks, 1, "tepat satu klik pin, apa pun jumlah bacaannya");
  assert.ok(calls.stateReads >= 4, "bacaannya memang berulang: " + calls.stateReads);
});

test("state hanya berisi spasi dianggap belum terbaca", async () => {
  const { svc, calls } = svcWith({ states: [{ text: "   " }, { text: "Unpin" }] });
  const r = await pin(svc);
  assert.equal(r.state, "Unpin");
  assert.equal(calls.stateReads, 2);
});

// ---------- tidak pernah terbaca ----------

test("tidak pernah terbaca: jendela BERBATAS, dan dilaporkan apa adanya", async () => {
  const { svc, calls } = svcWith({ states: [{ text: "" }] });
  const r = await pin(svc);

  assert.equal(r.ok, true, "pin-nya sendiri tetap sukses: kliknya terjadi");
  assert.equal(r.state, "");
  assert.equal(calls.stateReads, 6, "berhenti pada batas, bukan menunggu selamanya");
  assert.equal(calls.sleeps.length, 5, "tidur hanya di ANTARA bacaan");
  assert.equal(calls.pinClicks, 1);

  // Gerbang semantik tetap menahan - itu memang tugasnya, dan modul pembacaan
  // tidak boleh menebak demi melewatinya.
  const gate = inspectPinResult(r);
  assert.equal(gate.confirmed, false);
  assert.equal(gate.reason, "pin-state-unreadable");
});

test("jendela total tetap pendek: scene masih tayang puluhan detik sesudahnya", async () => {
  const { svc, calls } = svcWith({ states: [{ text: "" }] });
  await pin(svc);
  const total = calls.sleeps.reduce((a, b) => a + b, 0);
  assert.equal(total, 1_250, "6 bacaan, 5 jeda 250ms");
  assert.ok(total < 2_000, "jauh di bawah durasi video PAX");
});

// ---------- pembacaan yang melempar ----------

test("pembacaan melempar lalu pulih: tetap bisa terkonfirmasi", async () => {
  const { svc, calls } = svcWith({ states: [{ text: "Unpin" }], readThrows: 2 });
  const r = await pin(svc);

  assert.equal(r.state, "Unpin");
  assert.equal(calls.stateReads, 3, "dua lemparan lalu berhasil");
  assert.equal(calls.pinClicks, 1);
});

test("pembacaan selalu melempar: tidak bocor ke pemanggil, menyerah rapi", async () => {
  const { svc, calls } = svcWith({ states: [{ text: "Unpin" }], readThrows: 99 });
  const r = await pin(svc);

  assert.equal(r.ok, true, "kegagalan membaca bukan alasan menggagalkan pin");
  assert.equal(r.state, "");
  assert.equal(calls.pinClicks, 1);
  assert.equal(inspectPinResult(r).reason, "pin-state-unreadable");
});

// ---------- state yang terbaca tapi BUKAN ter-pin ----------

test("state terbaca 'Pin' -> ditolak gerbang, dan TIDAK dibaca ulang", async () => {
  // "Pin" artinya produknya justru TIDAK ter-pin (kliknya mematikan pin).
  // Itu bacaan yang SAH, jadi tidak boleh dipoll ulang berharap berubah.
  const { svc, calls } = svcWith({ states: [{ text: "Pin" }] });
  const r = await pin(svc);

  assert.equal(r.state, "Pin");
  assert.equal(calls.stateReads, 1, "bacaan sah langsung dipakai");
  assert.deepEqual(calls.sleeps, []);
  assert.equal(inspectPinResult(r).reason, "pin-state-not-pinned");
});

// ---------- fungsi pembacaan sebagai unit ----------

test("confirmer melaporkan jumlah bacaan supaya terlihat di log", async () => {
  const { svc } = svcWith({ states: [{ found: true, buttons: 0, text: "" }, { found: true, buttons: 1, text: "Unpin" }] });
  const v = await svc.pinConfirmer.confirm({}, "pandan");
  assert.equal(v.confirmed, true);
  assert.equal(v.via, "button-text");
  assert.equal(v.reads, 2, "angka ini yang muncul sebagai reads= di [AUTOPIN_SERVICE_PINNED]");
});

test("confirmer tidak pernah melempar, dan mencatat bukti apa adanya", async () => {
  const { svc } = svcWith({ states: [{ text: "Unpin" }], readThrows: 99 });
  const v = await svc.pinConfirmer.confirm({}, "pandan");
  assert.equal(v.confirmed, false);
  assert.equal(v.state, "");
  assert.equal(v.reads, 6);
  assert.ok(v.primary.includes("error="), "penyebab bacaan gagal ikut tercatat: " + v.primary);
});
