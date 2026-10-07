"use strict";
// Activity feed: menerjemahkan baris stdout/stderr child menjadi kejadian yang
// bisa dibaca manusia, dalam buffer yang DIBATASI.
//
// Dibatasi dengan sengaja, bukan untuk kerapian. Controller hidup selama jam-jam
// LIVE dan bot bisa mengeluarkan ribuan baris; buffer tanpa batas adalah
// kebocoran memori yang persis sama bentuknya dengan yang sudah diperbaiki di
// runtime/bounded-store.js untuk state per-penonton.
//
// Dua hal yang SENGAJA tidak masuk ke sini:
//
//   1. [TIKTOK_CHAT] — berisi nama penonton. Direktori logs/ sudah di-gitignore
//      justru karena itu; memindahkan nama penonton ke dalam feed yang dibaca
//      oleh UI (dan nanti bisa tampil di layar yang di-share) akan membatalkan
//      alasan itu. Baris chat tetap ada di log mentah, tidak di feed.
//   2. Baris yang tidak dikenal. Feed ini untuk kejadian, bukan cermin log.
//      Log mentah tetap ditulis seperti sebelumnya dan tidak berubah.
//
// Parser ini HANYA MEMBACA. Tidak satu pun tag di bawah ditambahkan ke core —
// semuanya sudah dicetak oleh index.js / autopin / autocomment sebelum
// Controller ada, dan formatnya diambil dari kode yang mencetaknya.

const DEFAULT_MAX = 500;

// Tag -> tipe activity. Daftar TERTUTUP: tag yang tidak ada di sini tidak pernah
// menjadi activity, supaya baris log baru dari core tidak diam-diam berubah
// menjadi kejadian yang artinya ditebak.
const TAG_TYPES = Object.freeze({
  // index.js:1191 — `[TIKTOK_CONNECTED] roomId=...`
  TIKTOK_CONNECTED: "TIKTOK_CONNECTED",
  TIKTOK_RECONNECTED: "TIKTOK_RECONNECTED",
  // index.js:1175 — `[TIKTOK_DISCONNECTED] code=... reason="..."`
  TIKTOK_DISCONNECTED: "TIKTOK_DISCONNECTED",
  // index.js:513 — `[PLAY] scene=... count=... requesters=...`
  PLAY: "PLAY",
  // index.js:354 — `[PLAYBACK_END] scene=... reason=...`
  PLAYBACK_END: "PLAYBACK_END",
  // autopin/scene-pin.js:135 — `[AUTOPIN_SUCCESS] scene=... playId=... key="..." ms=...`
  AUTOPIN_SUCCESS: "AUTOPIN_SUCCESS",
  AUTOPIN_FAILED: "AUTOPIN_FAILED",
  // autocomment/core.js:213 — `[AUTOCOMMENT_SUCCESS] scene=... playId=... ms=...`
  AUTOCOMMENT_SUCCESS: "AUTOCOMMENT_SUCCESS",
  AUTOCOMMENT_FAILED: "AUTOCOMMENT_FAILED",
});

// Kalimat untuk manusia. Pendek, tanpa jargon, tanpa detail teknis — detailnya
// tetap ada di field terstruktur dan di log mentah.
const MESSAGES = Object.freeze({
  TIKTOK_CONNECTED: "Connected to TikTok LIVE",
  TIKTOK_RECONNECTED: "Reconnected to TikTok LIVE",
  TIKTOK_DISCONNECTED: "Disconnected from TikTok LIVE",
  PLAY: "Scene started",
  PLAYBACK_END: "Scene finished",
  AUTOPIN_SUCCESS: "Product pinned",
  AUTOPIN_FAILED: "Product was not pinned",
  AUTOCOMMENT_SUCCESS: "Reply sent to chat",
  AUTOCOMMENT_FAILED: "Reply was not sent",
});

const TAG_RE = /^\[([A-Z0-9_]+)\]\s*(.*)$/;

// key=value dan key="value with spaces" — bentuk yang dipakai semua log core
// (lihat formatValue di autopin/core.js, yang meng-JSON-quote nilai berspasi).
const FIELD_RE = /([a-zA-Z][a-zA-Z0-9_]*)=("(?:[^"\\]|\\.)*"|[^\s]*)/g;

function parseFields(rest) {
  const out = {};
  let m;
  FIELD_RE.lastIndex = 0;
  while ((m = FIELD_RE.exec(rest)) !== null) {
    const key = m[1];
    let raw = m[2];
    if (raw.startsWith('"')) {
      try {
        raw = JSON.parse(raw);
      } catch {
        raw = raw.slice(1, -1);
      }
    }
    out[key] = raw;
  }
  return out;
}

// Mengembalikan objek activity, atau null untuk baris yang bukan kejadian yang
// kita kenal. null adalah jawaban yang normal dan sering: sebagian besar baris
// log bukan kejadian.
function parseLine(line, { at = null } = {}) {
  if (typeof line !== "string") return null;
  const m = TAG_RE.exec(line.trim());
  if (!m) return null;

  const tag = m[1];
  const type = TAG_TYPES[tag];
  if (!type) return null;

  const f = parseFields(m[2]);
  const ev = {
    time: at || new Date().toISOString(),
    type,
    message: MESSAGES[type],
  };

  if (f.scene) ev.scene = f.scene;
  if (f.reason) ev.reason = f.reason;
  if (f.playId !== undefined && /^\d+$/.test(f.playId)) ev.playId = Number(f.playId);
  if (f.ms !== undefined && /^\d+$/.test(f.ms)) ev.ms = Number(f.ms);
  // `key` adalah judul produk yang dicari, bukan rahasia: ia sudah terlihat oleh
  // penonton di daftar produk LIVE.
  if (f.key) ev.product = f.key;

  return ev;
}

function createActivityFeed({ max = DEFAULT_MAX, now = () => new Date().toISOString() } = {}) {
  const limit = Number.isInteger(max) && max > 0 ? max : DEFAULT_MAX;
  const items = [];
  let seq = 0;
  // Jumlah yang pernah dibuang karena buffer penuh. Dilaporkan supaya "feed ini
  // tidak lengkap" terlihat, bukan ditebak dari jumlah yang kelihatan sedikit.
  let dropped = 0;

  function push(ev) {
    if (!ev || typeof ev !== "object") return null;
    seq += 1;
    const item = Object.assign({ id: seq, time: now() }, ev);
    items.push(item);
    if (items.length > limit) {
      dropped += items.length - limit;
      items.splice(0, items.length - limit);
    }
    return item;
  }

  // Baris mentah dari child -> activity. Baris yang tidak dikenal diabaikan dan
  // TIDAK dihitung sebagai dibuang: ia memang bukan kejadian.
  function ingest({ line, at } = {}) {
    const ev = parseLine(line, { at });
    if (!ev) return null;
    return push(ev);
  }

  function list({ limit: n, sinceId } = {}) {
    let out = items;
    if (Number.isInteger(sinceId)) out = out.filter((i) => i.id > sinceId);
    if (Number.isInteger(n) && n > 0 && out.length > n) out = out.slice(-n);
    return out.map((i) => Object.assign({}, i));
  }

  return {
    push,
    ingest,
    list,
    size: () => items.length,
    dropped: () => dropped,
    lastId: () => seq,
    clear: () => {
      items.splice(0);
    },
    max: limit,
  };
}

module.exports = { createActivityFeed, parseLine, TAG_TYPES, MESSAGES, DEFAULT_MAX };
