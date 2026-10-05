"use strict";
// Pengukur durasi per tahap untuk satu permintaan AutoComment.
//
// Dibuat sesudah retry Phase 21 (2026-10-05). Klik Publish gagal karena habis
// anggaran browser:
//
//   [AUTOCOMMENT_SEND_FAILED] scene=PAX-1 playId=1 stage=click
//                             detail=deadline-exceeded:click
//
// Masalahnya: label `stage=click` tidak cukup untuk memutuskan apa pun. Ia hanya
// memberi tahu bahwa pencarian tombol sudah lolos. Ia TIDAK membedakan antara
// "kliknya sendiri lambat" dan "mengetik 33 karakter sudah menghabiskan hampir
// seluruh anggaran sebelum klik dimulai". Pembandingnya tajam: kirim sukses
// pertama (AR2B) menyelesaikan seluruh rantai dalam 1672 ms.
//
// Tanpa angka per tahap, satu-satunya tindakan yang tersisa adalah menaikkan
// timeout secara buta - yang hanya memindahkan kegagalan, dan kalau anggaran
// browser melewati timeout HTTP bot justru membuka kembali jendela "entah" yang
// ditutup commit e1ce6cd.
//
// Modul ini MURNI MENGAMATI. Ia tidak menelan error, tidak mengubah nilai
// kembalian, tidak menambah percobaan, dan tidak menyentuh halaman. Pencatatan
// terjadi di `finally`, jadi tahap yang gagal pun terukur - dan error-nya tetap
// naik ke pemanggil tanpa diubah sedikit pun.

// Urutan tahap sesuai jalannya satu permintaan. Dipakai untuk menjaga urutan
// pelaporan tetap sama walau sebuah permintaan berhenti di tengah.
const STEP_ORDER = Object.freeze([
  "getPage",
  "identity",
  "inspect-before",
  "focus",
  "clear",
  "type",
  "verify",
  "inspect-after",
  "stale",
  "resolve-publish",
  "click",
  "after-click",
  "reconcile",
  "cleanup",
]);

function createStepTimer({ now = () => Date.now() } = {}) {
  // name -> { ms, runs, failed }
  const marks = new Map();

  function mark(name, ms, failed) {
    const prev = marks.get(name);
    if (prev) {
      prev.ms += ms;
      prev.runs += 1;
      if (failed) prev.failed = true;
      return;
    }
    marks.set(name, { ms, runs: 1, failed: !!failed });
  }

  // Membungkus satu operasi async. Error TIDAK ditangkap: ia hanya diukur lalu
  // dilepas kembali apa adanya, supaya isolasi kegagalan persis seperti sebelum
  // instrumentasi ada.
  async function step(name, thunk) {
    const t0 = now();
    let failed = false;
    try {
      return await thunk();
    } catch (err) {
      failed = true;
      throw err;
    } finally {
      mark(name, now() - t0, failed);
    }
  }

  // Versi sinkron, untuk tahap yang memang bukan async (mis. pemeriksaan basi).
  // Dibuat sinkron supaya tidak menyisipkan microtask yang tidak ada sebelumnya.
  function sync(name, fn) {
    const t0 = now();
    let failed = false;
    try {
      return fn();
    } catch (err) {
      failed = true;
      throw err;
    } finally {
      mark(name, now() - t0, failed);
    }
  }

  function ordered() {
    const seen = [...marks.keys()];
    const known = STEP_ORDER.filter((n) => marks.has(n));
    const extra = seen.filter((n) => !STEP_ORDER.includes(n));
    return [...known, ...extra].map((name) => ({ name, ...marks.get(name) }));
  }

  const total = () => ordered().reduce((sum, s) => sum + s.ms, 0);

  // Satu baris, mudah dibaca mata dan mudah di-grep.
  function describe() {
    const parts = ordered().map((s) => {
      const runs = s.runs > 1 ? `x${s.runs}` : "";
      const bad = s.failed ? "!" : "";
      return `${s.name}=${s.ms}${runs}${bad}`;
    });
    return `total=${total()}ms ${parts.join(" ")}`.trim();
  }

  return {
    step,
    sync,
    mark: (name, ms) => mark(name, ms, false),
    steps: ordered,
    total,
    describe,
    any: () => marks.size > 0,
  };
}

module.exports = { createStepTimer, STEP_ORDER };
