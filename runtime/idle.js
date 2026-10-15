"use strict";
// Interaksi saat sepi: KEPUTUSANNYA, bukan mesinnya.
//
// Modul ini MURNI: tidak ada timer, tidak ada I/O, tidak ada jam, tidak ada
// state yang bisa diubah. Yang ada hanya dua pertanyaan yang bisa dijawab dari
// angka:
//
//   shouldEngage()  bolehkah sekarang memutar satu scene interaksi?
//   pickIdle()      kalau boleh, yang mana, dan kursor berikutnya di mana?
//
// Timer, antrean, dan pemutaran tetap milik index.js. Itu disengaja: repo ini
// sudah punya SATU mesin pemutaran yang sudah terbukti (antrean + busy +
// activeScene + failsafe timer + cooldown + playId), dan fitur ini tidak
// membangun yang kedua. Ia hanya menitipkan satu entri ke antrean yang sama
// dengan prioritas yang SELALU kalah.
//
// ---------------------------------------------------------------------------
// KENAPA KEPUTUSANNYA DIPISAH KE SINI
//
// Karena logika yang hidup di dalam callback setTimeout adalah logika yang
// tidak pernah diuji. Dengan dipisah, seluruh matriks keputusan bisa dipanggil
// langsung dari Node tanpa satu pun timer palsu — pola yang sama dengan
// controller/public/ui-logic.js dan alasannya sama.

// Prioritas antrean untuk entri interaksi.
//
// Angka ini yang membuat penonton SELALU menang tanpa ada kode baru yang
// memutuskannya: processQueue() di index.js sudah memilih prioritas tertinggi
// lebih dulu, entri penonton berprioritas 0 (dan 2 kalau dipromote operator),
// jadi -1 tidak pernah bisa mendahului satu pun permintaan penonton.
const IDLE_PRIORITY = -1;

// Batas yang masuk akal untuk "sepi selama". Di bawah 5 detik bot akan bicara
// menimpa percakapan yang sedang berjalan; di atas satu jam ia tidak akan
// pernah terpicu dalam satu sesi LIVE.
const MIN_AFTER_SECONDS = 5;
const MAX_AFTER_SECONDS = 3600;
const DEFAULT_AFTER_SECONDS = 30;

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// Bentuk `idle` di config customer, dengan bawaan yang AMAN.
//
// Ketiadaan blok idle berarti MATI. Config yang ditulis sebelum fitur ini ada
// tidak boleh mendadak mulai bicara sendiri hanya karena aplikasinya diperbarui.
function defaultIdle() {
  return { enabled: false, afterSeconds: DEFAULT_AFTER_SECONDS, items: [] };
}

// Nilai yang BERLAKU dari sebuah blok idle apa pun bentuknya. Dipakai oleh
// pembentuk artefak dan oleh snapshot runtime, supaya "apa yang berlaku" hanya
// dijawab satu kali.
function resolveIdle(raw) {
  const d = defaultIdle();
  if (!isPlainObject(raw)) return d;
  const items = Array.isArray(raw.items) ? raw.items : [];
  return {
    enabled: raw.enabled === true,
    afterSeconds: Number.isInteger(raw.afterSeconds) ? raw.afterSeconds : d.afterSeconds,
    items: items
      .filter(isPlainObject)
      .map((it) => {
        const scene = typeof it.scene === "string" ? it.scene.trim() : "";
        const reply = typeof it.reply === "string" ? it.reply.trim() : "";
        // reply SELALU ada sebagai field, null kalau tidak diisi: bentuk yang
        // tetap lebih mudah divalidasi daripada field yang kadang hilang.
        return { scene, reply: reply === "" ? null : reply };
      })
      .filter((it) => it.scene !== ""),
  };
}

// Aksi sebuah item interaksi. Tiga nilai, dan autoPin SELALU false.
//
// Bukan "biasanya false": interaksi saat sepi tidak pernah boleh menyentuh
// daftar produk. Tidak ada jalan konfigurasi untuk menyalakannya, dan bentuk
// fungsi ini yang menjaminnya.
function idleActionsFor(item) {
  const reply = item && typeof item.reply === "string" ? item.reply.trim() : "";
  return { switchScene: true, autoPin: false, autoReply: reply !== "" };
}

// Rotasi round-robin, DETERMINISTIK.
//
// Tidak ada acak di mana pun: bot yang memilih sendiri urutan bicaranya adalah
// bot yang tidak bisa diuji dan tidak bisa dijelaskan ke customer. Kursor maju
// satu setiap kali sebuah item benar-benar dipakai.
//
// Item yang scene-nya masih dalam cooldown DILEWATI, bukan ditunggu: cooldown
// per-scene adalah milik mesin pemutaran, dan melanggarnya di sini hanya akan
// membuat processQueue membuang entrinya beberapa milidetik kemudian.
//
// Kalau SEMUA item sedang cooldown, hasilnya null -> penelepon diam. Itu bukan
// kegagalan; itu jawaban yang benar untuk "belum ada yang boleh diputar".
function pickIdle({ rules = [], cursor = 0, isCoolingDown = () => false } = {}) {
  const n = rules.length;
  if (n === 0) return null;
  const start = Number.isInteger(cursor) && cursor >= 0 ? cursor % n : 0;
  for (let step = 0; step < n; step += 1) {
    const at = (start + step) % n;
    const rule = rules[at];
    if (!rule || !rule.scene) continue;
    if (isCoolingDown(rule.scene)) continue;
    return { rule, index: at, nextCursor: (at + 1) % n };
  }
  return null;
}

// Bolehkah sekarang? Satu fungsi, satu jawaban, dan ALASANNYA ikut — supaya
// log dan tes bisa membedakan "belum waktunya" dari "sedang ada scene".
//
// Urutan pemeriksaannya sengaja dari yang paling murah dan paling menentukan.
function shouldEngage({
  enabled = false,
  armed = false,
  busy = false,
  queueLength = 0,
  now = 0,
  lastActivityAt = 0,
  afterMs = 0,
  ruleCount = 0,
} = {}) {
  if (!enabled) return { ok: false, reason: "disabled" };
  // Belum tersambung, atau sudah terputus. Memutar scene interaksi ke LIVE yang
  // tidak hidup adalah bicara ke ruangan kosong.
  if (!armed) return { ok: false, reason: "not-armed" };
  if (ruleCount === 0) return { ok: false, reason: "no-items" };
  // Ada scene yang sedang tayang, atau jeda global masih menahan. Jangan
  // menimpa apa pun.
  if (busy) return { ok: false, reason: "busy" };
  // Ada permintaan penonton yang menunggu. Penonton selalu lebih dulu.
  if (queueLength > 0) return { ok: false, reason: "queue-not-empty" };
  const since = now - lastActivityAt;
  if (since < afterMs) return { ok: false, reason: "too-soon", remainingMs: afterMs - since };
  return { ok: true, reason: "idle" };
}

module.exports = {
  IDLE_PRIORITY,
  MIN_AFTER_SECONDS,
  MAX_AFTER_SECONDS,
  DEFAULT_AFTER_SECONDS,
  defaultIdle,
  resolveIdle,
  idleActionsFor,
  pickIdle,
  shouldEngage,
};
