"use strict";
// Gerbang penerimaan chat TikTok — dipasang SEBELUM handleChat().
//
// Dibuat sesudah insiden LIVE 2026-10-05 (Phase 21): rantai scene -> AutoPIN ->
// AutoComment menyala sendiri tanpa ada penonton yang berkomentar saat itu.
// Buktinya ada di bot-p21.log: dua komentar `lincoln` muncul pada baris 7 dan 12
// (SEBELUM [TIKTOK_CONNECTED] di baris 24), lalu komentar yang SAMA muncul lagi
// di baris 25 dan 29. Konektor mengantar ulang riwayat chat saat connect, dan bot
// tidak punya dedup apa pun, sehingga komentar lama menjadi trigger baru.
//
// Baris 37-40 memperlihatkan cacat kedua: pesan admin kita sendiri
// ("Etalase 1 sudah aku pin ya kak") cocok keyword PAX-1 dan hanya diselamatkan
// [SKIP_ACTIVE] karena PAX-1 kebetulan sedang aktif. Kalau tidak, bot akan
// men-trigger scene dari chat-nya sendiri — umpan balik tanpa ujung.
//
// Tiga penolakan, tanpa satu pun bergantung pada jam dinding yang benar:
//
//   self-message        -> pengirimnya akun host (bot itu sendiri)
//   duplicate-msg-id    -> msgId sudah pernah dilihat
//   pre-connect-backlog -> datang sebelum connect() selesai = riwayat, bukan live
//   backlog-replay      -> isi persis sama dengan pesan backlog, masih dalam
//                          jendela tenggang sesudah connect
//
// Kuncinya: pesan backlog TETAP dicatat walaupun ditolak. Jadi saat konektor
// mengantar ulang pesan yang sama sesudah connect, penolakan kedua terjadi
// otomatis lewat msgId — persis skenario yang lolos pada Phase 21.
//
// Dedup isi SENGAJA hanya berlaku di jendela tenggang yang PENDEK, tidak permanen.
// Dua alasan. Pertama, penonton memang boleh mengirim komentar yang sama dua kali
// (itu pernah diuji sendiri oleh operator) dan itu harus tetap jadi dua trigger
// sah. Kedua, operator biasanya langsung berkomentar begitu [TIKTOK_CONNECTED]
// muncul; jendela yang lebar justru berisiko menelan komentar asli dan membuat
// bot tampak mati. Dedup msgId sudah presisi dan berlaku permanen, jadi jendela
// isi ini hanya perlu menutup ledakan antaran ulang sesaat sesudah connect.

const DEFAULT_GRACE_MS = 10_000;
const DEFAULT_MEMORY = 500;

const REASONS = Object.freeze({
  SELF: "self-message",
  DUPLICATE: "duplicate-msg-id",
  BACKLOG: "pre-connect-backlog",
  REPLAY: "backlog-replay",
});

// Identitas dibandingkan tanpa spasi, garis bawah, maupun huruf besar, supaya
// nickname "Agen Mulia Abadi" dikenali sama dengan uniqueId "agen_mulia_abadi".
function normalizeIdentity(value) {
  if (typeof value !== "string") return "";
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Himpunan dengan batas atas: memori tidak boleh tumbuh sepanjang sesi LIVE.
function boundedSet(limit) {
  const set = new Set();
  return {
    has: (k) => set.has(k),
    add(k) {
      if (k === null || k === undefined || k === "") return;
      set.add(k);
      while (set.size > limit) set.delete(set.values().next().value);
    },
    get size() {
      return set.size;
    },
    clear: () => set.clear(),
  };
}

function readMsgId(ev) {
  const raw = ev?.msgId ?? ev?.msgID ?? ev?.common?.msgId ?? ev?.common?.msgID;
  if (raw === null || raw === undefined) return null;
  const s = String(raw);
  return s === "" || s === "0" ? null : s;
}

function createChatGate({
  selfIdentities = [],
  graceMs = DEFAULT_GRACE_MS,
  memory = DEFAULT_MEMORY,
  now = () => Date.now(),
  logger = console,
} = {}) {
  const self = new Set(
    (Array.isArray(selfIdentities) ? selfIdentities : [selfIdentities])
      .map(normalizeIdentity)
      .filter((v) => v !== "")
  );

  const seenIds = boundedSet(memory);
  const backlogPrints = boundedSet(memory);

  let connected = false;
  let connectedAt = null;
  const counts = { accepted: 0, [REASONS.SELF]: 0, [REASONS.DUPLICATE]: 0, [REASONS.BACKLOG]: 0, [REASONS.REPLAY]: 0 };

  const log = (line) => {
    try {
      logger.log(line);
    } catch {
      /* logger rusak tidak boleh menjatuhkan jalur chat */
    }
  };

  function fingerprint(ev) {
    const who = normalizeIdentity(ev?.uniqueId) || normalizeIdentity(ev?.nickname);
    const text = String(ev?.comment ?? "").trim().toLowerCase();
    return `${who}|${text}`;
  }

  function refuse(reason, ev, msgId) {
    counts[reason] += 1;
    log(`[TIKTOK_CHAT_IGNORED] reason=${reason} user=${ev?.nickname ?? ev?.uniqueId ?? "anon"} msgId=${msgId ?? "-"}`);
    return { ok: false, reason };
  }

  function accept(ev) {
    const msgId = readMsgId(ev);

    // Pesan sendiri: ditolak paling awal, dan tidak ikut dicatat sebagai apa pun.
    const who = normalizeIdentity(ev?.uniqueId) || normalizeIdentity(ev?.nickname);
    if (who !== "" && self.has(who)) return refuse(REASONS.SELF, ev, msgId);

    if (msgId !== null && seenIds.has(msgId)) return refuse(REASONS.DUPLICATE, ev, msgId);

    // Belum connect = riwayat. Dicatat justru supaya antaran ulangnya nanti ikut tertolak.
    if (!connected) {
      seenIds.add(msgId);
      backlogPrints.add(fingerprint(ev));
      return refuse(REASONS.BACKLOG, ev, msgId);
    }

    // Antaran ulang ber-msgId baru masih mungkin; dicocokkan lewat isi, tapi
    // HANYA selama jendela tenggang sesudah connect.
    const withinGrace = connectedAt !== null && now() - connectedAt <= graceMs;
    if (withinGrace && backlogPrints.has(fingerprint(ev))) {
      seenIds.add(msgId);
      return refuse(REASONS.REPLAY, ev, msgId);
    }

    seenIds.add(msgId);
    counts.accepted += 1;
    return { ok: true, msgId };
  }

  return {
    accept,
    // Dipanggil sesudah connect() benar-benar selesai, termasuk setiap reconnect:
    // tiap reconnect membuka jendela tenggang baru karena backlog diantar ulang.
    markConnected() {
      connected = true;
      connectedAt = now();
    },
    markDisconnected() {
      connected = false;
    },
    __state: () => ({
      connected,
      connectedAt,
      self: [...self],
      seenIds: seenIds.size,
      backlogPrints: backlogPrints.size,
      counts: { ...counts },
    }),
  };
}

module.exports = { createChatGate, normalizeIdentity, readMsgId, REASONS, DEFAULT_GRACE_MS, DEFAULT_MEMORY };
