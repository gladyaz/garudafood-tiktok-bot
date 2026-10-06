"use strict";
// Log operasional yang diringkas, bukan satu baris per pesan chat.
//
// ---------------------------------------------------------------------------
// MASALAH YANG DIPERBAIKI
//
// Diukur pada 2026-10-05: 20.000 komentar menghasilkan 20.000 baris
// `▶ Became busy before processing queue`. Saat chat ramai, log-nya sendiri
// jadi beban - menulis ke stdout itu sinkron dan memblokir event loop yang
// sama dengan penanganan OBS - dan terminalnya tidak bisa dibaca manusia lagi.
// Justru pada saat paling butuh dibaca, log-nya paling tidak berguna.
//
// ---------------------------------------------------------------------------
// KEBIJAKAN
//
// Kejadian PERTAMA tiap jenis selalu ditampilkan langsung. Kejadian serupa
// berikutnya di dalam jendela ditahan dan DIHITUNG, lalu jumlahnya menempel
// pada kemunculan berikutnya:
//
//   [BUSY_QUEUED] scene=PAX-2
//   [BUSY_QUEUED] scene=PAX-5 (+1843 serupa ditahan)
//
// Tanpa timer sama sekali: peringkasan terjadi saat kejadian berikutnya tiba.
// Timer berkala akan membangunkan proses tanpa guna dan menambah satu sumber
// kesalahan; di sini tidak ada yang perlu dibangunkan. Konsekuensinya jujur:
// kalau kejadian berhenti sama sekali, sisa hitungan terakhir baru muncul saat
// `flush()` dipanggil - dan playback memanggilnya di akhir tiap scene.
//
// Yang TIDAK pernah diringkas: apa pun yang menyentuh akun sungguhan. Pin,
// pengiriman chat, penolakan identitas, dan hasil rekonsiliasi tetap satu
// baris per kejadian, karena masing-masing peristiwa unik yang harus bisa
// diaudit satu per satu.

const DEFAULT_WINDOW_MS = 10_000;
// Jenis kejadian seharusnya label tetap dan sedikit. Batas ini hanya jaring
// kalau ada pemanggil yang keliru memakai nilai dinamis (mis. nickname).
const MAX_KINDS = 64;

function createOpLog({
  windowMs = DEFAULT_WINDOW_MS,
  logger = console,
  now = () => Date.now(),
} = {}) {
  const state = new Map(); // kind -> { lastShownAt, suppressed }
  let shown = 0;
  let suppressed = 0;

  const write = (line) => {
    try {
      logger.log(line);
    } catch (e) {
      /* logger rusak tidak boleh menjatuhkan jalur chat */
    }
  };

  function slot(kind) {
    let st = state.get(kind);
    if (!st) {
      if (state.size >= MAX_KINDS) {
        // Buang jenis terlama supaya peta ini tidak pernah tumbuh tanpa batas.
        state.delete(state.keys().next().value);
      }
      st = { lastShownAt: 0, suppressed: 0 };
      state.set(kind, st);
    }
    return st;
  }

  // Mengembalikan "shown" atau "suppressed" supaya bisa diuji tanpa membaca log.
  function event(kind, detail = "") {
    const t = now();
    const st = slot(kind);

    if (t - st.lastShownAt >= windowMs) {
      const extra = st.suppressed > 0 ? ` (+${st.suppressed} serupa ditahan)` : "";
      write(`[${kind}] ${detail}${extra}`.trim());
      st.lastShownAt = t;
      st.suppressed = 0;
      shown += 1;
      return "shown";
    }

    st.suppressed += 1;
    suppressed += 1;
    return "suppressed";
  }

  // Mengeluarkan sisa hitungan. Dipanggil di titik tenang - akhir scene,
  // shutdown - supaya tidak ada kejadian yang hilang tanpa jejak.
  function flush() {
    const parts = [];
    for (const [kind, st] of state) {
      if (st.suppressed > 0) {
        parts.push(`${kind}=${st.suppressed}`);
        st.suppressed = 0;
      }
    }
    if (parts.length === 0) return 0;
    write(`[OPS_SUPPRESSED] ${parts.join(" ")} window=${windowMs}ms`);
    return parts.length;
  }

  return {
    event,
    flush,
    __state: () => ({ kinds: state.size, shown, suppressed, windowMs }),
  };
}

module.exports = { createOpLog, DEFAULT_WINDOW_MS, MAX_KINDS };
