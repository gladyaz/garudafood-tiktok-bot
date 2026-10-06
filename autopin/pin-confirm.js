"use strict";
// Konfirmasi pin dari DUA sinyal independen.
//
// ---------------------------------------------------------------------------
// APA YANG SEBENARNYA TERJADI DI LIVE
//
// Pada LIVE 2026-10-05, pin PAX-2 berhasil diklik tapi konfirmasinya kosong:
//
//   [AUTOPIN_SERVICE_PINNED] scene=PAX-2 title="Dilan PANDAN ..."   <- tanpa after=
//   [AUTOPIN_SUCCESS] ... clicked=true state=""
//   [AUTOCOMMENT_SKIPPED] reason=pin-state-unreadable
//
// Gerbang semantik menahan chat - itu BENAR, ia tidak boleh mengklaim pin yang
// tak terbukti. Tapi akibatnya kaki AutoComment mati pada pin yang sukses.
//
// Dan inilah bagian yang memalukan: pembacaannya SELAMA INI sudah mengembalikan
// data yang menjelaskan kegagalannya, tapi semuanya dibuang kecuali `text`:
//
//   { found, text, disabled, cls, buttons }
//      ^^^^^                        ^^^^^^^  tidak pernah dicatat
//
// Jadi saat `text=""` tidak ada yang bisa membedakan "baris tidak ketemu"
// (found:false) dari "baris ketemu tapi tombolnya hilang" (buttons:0). Dua
// penyebab yang sangat berbeda, dan dua kali saya salah menebak di antaranya.
// Modul ini mencatat semuanya.
//
// ---------------------------------------------------------------------------
// ATURAN YANG TIDAK BOLEH DILANGGAR
//
// "sudah aku pin" TIDAK PERNAH dikirim kecuali pin terkonfirmasi. Menambah
// sinyal kedua BUKAN melonggarkan gerbang - ia hanya menyembuhkan KEBUTAAN:
//
//   * sinyal 1 (teks tombol) terbaca "Unpin"  -> terkonfirmasi, selesai
//   * sinyal 1 terbaca "Pin" atau apa pun yang jelas BUKAN ter-pin
//     -> TIDAK terkonfirmasi, dan sinyal 2 TIDAK dilihat sama sekali.
//        Bacaan negatif yang jelas adalah jawaban SAH; menimpanya dengan
//        sinyal lain sama dengan mencari pembenaran.
//   * sinyal 1 BUTA (kosong, atau pembacaannya melempar) -> baru sinyal 2
//     dipakai, karena pada keadaan itu kita tidak punya jawaban apa pun.
//
// Sinyal 2 adalah snapshot daftar produk: `pinText` dan badge pada produk
// target. Jalurnya berbeda dari sinyal 1 - ia menggulir dan menyusun seluruh
// daftar, bukan mencari satu baris lalu membaca satu tombol. Harus diakui
// keduanya masih memakai selector yang sama, jadi independensinya PARSIAL:
// ia menyembuhkan balapan render pada satu baris, bukan perubahan selector
// menyeluruh oleh TikTok.

const DEFAULT_READS = 6;
const DEFAULT_POLL_MS = 250;

// Satu-satunya teks tombol yang berarti "produk ini ter-pin".
const PINNED_BUTTON_TEXT = /^unpin$/i;
// Badge/aria yang menandai produk sedang featured.
const PINNED_BADGE = /\b(pinned|featured)\b/i;

const VIA = Object.freeze({
  BUTTON: "button-text",
  SNAPSHOT_BUTTON: "snapshot-button",
  SNAPSHOT_BADGE: "snapshot-badge",
});

const text = (v) => String(v ?? "").replace(/\s+/g, " ").trim();

// Pencocokan judul yang sama dengan resolusi pin, supaya "produk target" berarti
// hal yang sama di kedua sinyal.
function titleKey(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/…+$/, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

// Ringkasan satu bacaan untuk log: cukup untuk mendiagnosis TANPA menebak.
function describePrimary(r) {
  if (!r) return "none";
  if (r.error) return `error="${String(r.error).slice(0, 60)}"`;
  const parts = [`found=${r.found === true}`];
  if (r.found) {
    parts.push(`buttons=${r.buttons === undefined ? "?" : r.buttons}`);
    parts.push(`text="${text(r.text)}"`);
    if (r.cls) parts.push(`cls="${String(r.cls).slice(0, 40)}"`);
  }
  return parts.join(" ");
}

function createPinConfirmer({
  readPinState,
  collectProducts,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  reads = DEFAULT_READS,
  pollMs = DEFAULT_POLL_MS,
} = {}) {
  // Sinyal 1, berulang dalam jendela berbatas. MURNI MEMBACA: tidak mengklik
  // apa pun. Mengulang pembacaan bukan "retry" yang dilarang - aturan nol-retry
  // melindungi dari pin ganda dan pesan ganda.
  async function readUntilReadable(page, productKey) {
    let last = null;
    for (let i = 1; i <= reads; i += 1) {
      try {
        last = await readPinState(page, productKey);
      } catch (err) {
        last = { error: String((err && err.message) || err).slice(0, 80) };
      }
      if (last && !last.error && text(last.text) !== "") {
        return { readable: true, result: last, reads: i };
      }
      if (i < reads) await sleep(pollMs);
    }
    return { readable: false, result: last, reads };
  }

  // Sinyal 2. Dipakai HANYA saat sinyal 1 buta.
  async function readSnapshot(page, productKey) {
    if (typeof collectProducts !== "function") {
      return { ok: false, reason: "snapshot-unavailable" };
    }
    let snap;
    try {
      snap = await collectProducts(page);
    } catch (err) {
      return { ok: false, reason: "snapshot-failed", error: String((err && err.message) || err).slice(0, 80) };
    }
    const products = (snap && snap.products) || [];
    if (products.length === 0) return { ok: false, reason: "snapshot-no-products" };

    const want = titleKey(productKey);
    const hit = products.find((p) => titleKey(p.title).includes(want));
    if (!hit) return { ok: false, reason: "snapshot-product-not-found", products: products.length };

    const pinText = text(hit.pinText);
    const badges = [...(hit.badges || []), ...(hit.ariaOnRow || [])].join(" ");

    if (PINNED_BUTTON_TEXT.test(pinText)) {
      return { ok: true, via: VIA.SNAPSHOT_BUTTON, pinText, badges, title: hit.title };
    }
    if (PINNED_BADGE.test(badges)) {
      return { ok: true, via: VIA.SNAPSHOT_BADGE, pinText, badges, title: hit.title };
    }
    // Snapshot terbaca dan jelas mengatakan TIDAK ter-pin.
    return { ok: false, reason: "snapshot-not-pinned", pinText, badges, title: hit.title };
  }

  // Satu-satunya pintu keluar. TIDAK PERNAH melempar.
  async function confirm(page, productKey) {
    const primary = await readUntilReadable(page, productKey);
    const diag = describePrimary(primary.result);

    if (primary.readable) {
      const state = text(primary.result.text);
      if (PINNED_BUTTON_TEXT.test(state)) {
        return {
          confirmed: true, via: VIA.BUTTON, state,
          reason: "pin-confirmed", reads: primary.reads, primary: diag, snapshot: null,
        };
      }
      // Bacaan negatif yang JELAS. Sinyal 2 sengaja tidak dilihat.
      return {
        confirmed: false, via: null, state,
        reason: "pin-state-not-pinned", reads: primary.reads, primary: diag, snapshot: "not-consulted",
      };
    }

    // Sinyal 1 buta -> sinyal 2.
    const snap = await readSnapshot(page, productKey);
    if (snap.ok) {
      return {
        confirmed: true, via: snap.via,
        // State disetarakan dengan bacaan tombol yang terkonfirmasi supaya
        // gerbang di sisi bot tidak perlu aturan kedua. `via` yang menjelaskan
        // dari mana buktinya datang, dan ia selalu ikut dicatat.
        state: "Unpin",
        reason: "pin-confirmed", reads: primary.reads, primary: diag,
        snapshot: `via=${snap.via} pinText="${snap.pinText}" badges="${snap.badges}"`,
      };
    }

    return {
      confirmed: false, via: null, state: "",
      reason: snap.reason === "snapshot-not-pinned" ? "pin-state-not-pinned" : "pin-state-unreadable",
      reads: primary.reads, primary: diag,
      snapshot: snap.reason + (snap.pinText !== undefined ? ` pinText="${snap.pinText}"` : "") +
        (snap.error ? ` error="${snap.error}"` : ""),
    };
  }

  return { confirm, readUntilReadable, readSnapshot };
}

module.exports = {
  createPinConfirmer,
  titleKey,
  describePrimary,
  PINNED_BUTTON_TEXT,
  PINNED_BADGE,
  VIA,
  DEFAULT_READS,
  DEFAULT_POLL_MS,
};
