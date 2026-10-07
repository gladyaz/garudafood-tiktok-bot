// State machine Controller: transisi yang SAH, dan penolakan yang tegas.
//
// Yang diuji di sini bukan kerapian diagram, tapi dua hal yang pernah mahal:
//
//   1. STARTING tidak punya jalan langsung ke STOPPED. Kalau ada, start yang
//      gagal bisa "selesai" tanpa pernah melewati cleanup, dan child-nya hidup
//      terus — bentuk persis insiden 2026-10-05.
//   2. Transisi yang tidak sah tidak melempar. Controller tidak boleh mati karena
//      sebuah balasan yang telat mencoba memindahkan state yang sudah berubah.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createStateMachine, STATES, ALLOWED } = require("../controller/state-machine");

test("mulai dari STOPPED", () => {
  assert.equal(createStateMachine().state(), STATES.STOPPED);
});

test("jalur bahagia: STOPPED -> PREFLIGHT -> STARTING -> RUNNING", () => {
  const sm = createStateMachine();
  assert.equal(sm.to(STATES.PREFLIGHT).ok, true);
  assert.equal(sm.to(STATES.STARTING).ok, true);
  assert.equal(sm.to(STATES.RUNNING).ok, true);
  assert.equal(sm.state(), STATES.RUNNING);
});

test("jalur stop: RUNNING -> STOPPING -> STOPPED", () => {
  const sm = createStateMachine({ initial: STATES.RUNNING });
  assert.equal(sm.to(STATES.STOPPING).ok, true);
  assert.equal(sm.to(STATES.STOPPED).ok, true);
});

test("jalur gagal start: STARTING -> ERROR -> STOPPED", () => {
  const sm = createStateMachine({ initial: STATES.STARTING });
  assert.equal(sm.to(STATES.ERROR).ok, true);
  assert.equal(sm.to(STATES.STOPPED).ok, true);
});

test("STARTING TIDAK boleh langsung ke STOPPED", () => {
  // Kalau ini pernah diizinkan, start yang gagal bisa selesai tanpa cleanup.
  const sm = createStateMachine({ initial: STATES.STARTING });
  const r = sm.to(STATES.STOPPED);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "illegal-transition");
  assert.equal(sm.state(), STATES.STARTING, "state lama tetap berlaku");
});

test("STOPPED tidak boleh langsung ke STARTING: start selalu lewat PREFLIGHT", () => {
  const sm = createStateMachine();
  assert.equal(sm.to(STATES.STARTING).ok, false);
  assert.equal(sm.state(), STATES.STOPPED);
});

test("tidak ada self-transition", () => {
  // Stop dua kali dan start dua kali diurus sebagai idempotensi oleh pemanggil.
  // Transisi ke diri sendiri akan menyembunyikan bug "dimulai dua kali".
  for (const s of Object.values(STATES)) {
    const sm = createStateMachine({ initial: s });
    assert.equal(sm.to(s).ok, false, s + " -> " + s + " harus ditolak");
  }
});

test("transisi tidak sah tidak melempar, dan dicatat", () => {
  const sm = createStateMachine();
  assert.doesNotThrow(() => sm.to(STATES.RUNNING));
  assert.doesNotThrow(() => sm.to("TIDAK_ADA"));
  assert.equal(sm.__state().rejected, 2);
  const bad = sm.history().filter((e) => !e.ok);
  assert.equal(bad.length, 2);
  assert.equal(bad[1].reason, "unknown-state");
});

test("isBusyForStart: semua state kecuali STOPPED dan ERROR menolak start baru", () => {
  const busy = [STATES.PREFLIGHT, STATES.STARTING, STATES.RUNNING, STATES.DEGRADED, STATES.STOPPING];
  for (const s of busy) {
    assert.equal(createStateMachine({ initial: s }).isBusyForStart(), true, s + " harus sibuk");
  }
  // ERROR TIDAK sibuk: sesudah rollback, operator harus bisa mencoba lagi tanpa
  // merestart Controller.
  assert.equal(createStateMachine({ initial: STATES.ERROR }).isBusyForStart(), false);
  assert.equal(createStateMachine({ initial: STATES.STOPPED }).isBusyForStart(), false);
});

test("mayHaveChildren: ERROR ikut, supaya stop tetap membersihkan", () => {
  assert.equal(createStateMachine({ initial: STATES.ERROR }).mayHaveChildren(), true);
  assert.equal(createStateMachine({ initial: STATES.STOPPED }).mayHaveChildren(), false);
});

test("ERROR selalu punya jalan keluar", () => {
  // ERROR yang terminal akan membuat Controller butuh restart untuk pulih.
  assert.ok(ALLOWED[STATES.ERROR].length > 0);
  assert.ok(ALLOWED[STATES.ERROR].includes(STATES.STOPPED));
});

test("setiap state punya setidaknya satu transisi keluar", () => {
  for (const s of Object.values(STATES)) {
    assert.ok(Array.isArray(ALLOWED[s]) && ALLOWED[s].length > 0, s + " buntu");
  }
});

test("onTransition dipanggil dengan from dan to", () => {
  const seen = [];
  const sm = createStateMachine({ onTransition: ({ from, to }) => seen.push(from + "->" + to) });
  sm.to(STATES.PREFLIGHT);
  sm.to(STATES.STARTING);
  assert.deepEqual(seen, ["STOPPED->PREFLIGHT", "PREFLIGHT->STARTING"]);
});

test("pendengar yang melempar tidak membatalkan transisi yang sudah sah", () => {
  const sm = createStateMachine({
    onTransition: () => {
      throw new Error("pendengar rusak");
    },
  });
  assert.doesNotThrow(() => sm.to(STATES.PREFLIGHT));
  assert.equal(sm.state(), STATES.PREFLIGHT);
});

test("riwayat dibatasi", () => {
  // Controller hidup selama jam-jam LIVE; riwayat tanpa batas adalah kebocoran
  // memori dalam bentuk yang paling mudah dilupakan.
  const sm = createStateMachine({ historyLimit: 4 });
  for (let i = 0; i < 20; i += 1) {
    sm.to(STATES.PREFLIGHT);
    sm.to(STATES.STOPPED);
  }
  assert.equal(sm.history().length, 4);
});

test("initial yang tidak dikenal ditolak keras", () => {
  // Ini kesalahan programmer, bukan kondisi runtime: lebih baik berisik sekarang.
  assert.throws(() => createStateMachine({ initial: "NGAWUR" }), /initial state tidak dikenal/);
});
