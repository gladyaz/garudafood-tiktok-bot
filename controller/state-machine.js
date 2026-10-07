"use strict";
// State machine Controller. Deterministik, tanpa efek samping, tanpa I/O.
//
// Kenapa eksplisit dan bukan sekumpulan boolean: insiden LIVE 2026-10-05
// (Phase 21) terjadi karena tidak ada satu pun tempat yang tahu "sistem ini
// sedang apa". Tiga bot hidup bersamaan dan setiap pemeriksaan menjawab dari
// tebakannya sendiri. Di sini hanya ada SATU state, dan satu-satunya cara
// memindahkannya adalah lewat transisi yang sudah didaftarkan di bawah.
//
// Arah kegagalannya sama dengan runtime/single-instance.js: kalau ragu, TOLAK.
// Transisi yang tidak terdaftar tidak pernah "kira-kira boleh" — ia ditolak dan
// dicatat, dan state lama tetap berlaku.

const STATES = Object.freeze({
  STOPPED: "STOPPED",
  PREFLIGHT: "PREFLIGHT",
  STARTING: "STARTING",
  RUNNING: "RUNNING",
  DEGRADED: "DEGRADED",
  STOPPING: "STOPPING",
  ERROR: "ERROR",
});

// Peta transisi yang SAH. Tidak ada self-transition: "start saat sudah RUNNING"
// dan "stop saat sudah STOPPED" diurus oleh pemanggil sebagai idempotensi, bukan
// dengan diam-diam memindahkan state ke dirinya sendiri (yang akan menyembunyikan
// bug di mana sesuatu dimulai dua kali).
const ALLOWED = Object.freeze({
  // Start selalu lewat PREFLIGHT lebih dulu: tidak ada jalan pintas ke STARTING.
  [STATES.STOPPED]: [STATES.PREFLIGHT],
  // Preflight gagal = NOL proses pernah dinyalakan, jadi aman kembali ke STOPPED
  // tanpa cleanup. ERROR disediakan untuk preflight yang gagal karena kesalahan
  // tak terduga, bukan karena check-nya merah.
  [STATES.PREFLIGHT]: [STATES.STARTING, STATES.STOPPED, STATES.ERROR],
  // Dari STARTING tidak ada jalan langsung ke STOPPED: kalau start gagal setelah
  // ada child yang hidup, ia WAJIB lewat ERROR/STOPPING supaya cleanup terjadi.
  [STATES.STARTING]: [STATES.RUNNING, STATES.ERROR, STATES.STOPPING],
  [STATES.RUNNING]: [STATES.DEGRADED, STATES.STOPPING, STATES.ERROR],
  [STATES.DEGRADED]: [STATES.RUNNING, STATES.STOPPING, STATES.ERROR],
  [STATES.STOPPING]: [STATES.STOPPED, STATES.ERROR],
  // ERROR tidak pernah menjadi terminal: cleanup harus selalu punya jalan keluar,
  // termasuk lewat STOPPING kalau masih ada child yang perlu dimatikan.
  [STATES.ERROR]: [STATES.STOPPING, STATES.STOPPED],
});

// State di mana sebuah permintaan start baru harus DITOLAK, bukan diantrekan.
// Mengantrekan start kedua adalah cara paling rapi untuk menyalakan dua bot.
const BUSY_FOR_START = Object.freeze([
  STATES.PREFLIGHT,
  STATES.STARTING,
  STATES.RUNNING,
  STATES.DEGRADED,
  STATES.STOPPING,
]);

// State yang berarti "ada atau mungkin ada child yang hidup". Stop harus tetap
// mengerjakan cleanup di semua state ini, termasuk ERROR.
const MAY_HAVE_CHILDREN = Object.freeze([
  STATES.STARTING,
  STATES.RUNNING,
  STATES.DEGRADED,
  STATES.ERROR,
]);

function createStateMachine({
  initial = STATES.STOPPED,
  onTransition = null,
  historyLimit = 50,
  now = () => Date.now(),
} = {}) {
  if (!Object.prototype.hasOwnProperty.call(ALLOWED, initial)) {
    throw new Error(`state-machine: initial state tidak dikenal: ${initial}`);
  }

  let current = initial;
  // Riwayat dibatasi: Controller hidup selama jam-jam LIVE, dan riwayat yang
  // tumbuh tanpa batas adalah kebocoran memori yang sama seperti log tanpa batas.
  const history = [];
  let rejected = 0;

  function record(entry) {
    history.push(entry);
    if (history.length > historyLimit) history.splice(0, history.length - historyLimit);
  }

  function can(next) {
    const outgoing = ALLOWED[current];
    return Array.isArray(outgoing) && outgoing.includes(next);
  }

  // Tidak melempar: Controller tidak boleh mati karena sebuah balasan yang telat
  // mencoba transisi yang sudah tidak berlaku. Hasilnya dikembalikan supaya
  // pemanggil memutuskan, dan penolakannya tetap tercatat supaya terlihat.
  function to(next, meta = {}) {
    const from = current;
    if (!Object.prototype.hasOwnProperty.call(ALLOWED, next)) {
      rejected += 1;
      record({ at: now(), from, to: next, ok: false, reason: "unknown-state" });
      return { ok: false, from, to: next, reason: "unknown-state" };
    }
    if (!can(next)) {
      rejected += 1;
      record({ at: now(), from, to: next, ok: false, reason: "illegal-transition" });
      return { ok: false, from, to: next, reason: "illegal-transition" };
    }
    current = next;
    const entry = { at: now(), from, to: next, ok: true, ...(meta.reason ? { reason: meta.reason } : {}) };
    record(entry);
    if (typeof onTransition === "function") {
      // Pendengar yang melempar tidak boleh membatalkan transisi yang sudah sah.
      try {
        onTransition({ from, to: next, meta });
      } catch {
        /* diabaikan dengan sengaja */
      }
    }
    return { ok: true, from, to: next };
  }

  return {
    state: () => current,
    can,
    to,
    isBusyForStart: () => BUSY_FOR_START.includes(current),
    mayHaveChildren: () => MAY_HAVE_CHILDREN.includes(current),
    history: () => history.slice(),
    __state: () => ({ current, rejected, historySize: history.length }),
  };
}

module.exports = { createStateMachine, STATES, ALLOWED, BUSY_FOR_START, MAY_HAVE_CHILDREN };
