"use strict";
// Satu-satunya tempat yang boleh memutuskan: "apakah produk ini BENAR-BENAR
// sudah ter-pin?"
//
// Ini penting karena AutoComment mengirim kalimat "Etalase N sudah aku pin ya
// kak" ke penonton. Kalimat itu adalah KLAIM. Mengirimnya tanpa bukti pin
// berarti membohongi penonton, jadi gerbangnya dibuat ketat dan eksplisit,
// bukan disimpulkan dari "ok: true" belaka.
//
// Bentuk hasil yang dikembalikan service (autopin/service.js guardedPin):
//
//   pin sungguhan berhasil : { ok:true,  reason:"pinned",  clicked:true,
//                              title:"...", state:"Unpin" }
//   dry-run berhasil       : { ok:true,  reason:"dry-run", clicked:false, title:"..." }
//   ditolak / gagal        : { ok:false, reason:"stale" | "identity-..." |
//                              "live-pin-control-not-available" | "timeout" | ... }
//
// `state` berasal dari readPinState(): teks tombol SESUDAH klik. Tombol yang
// sudah ter-pin berbunyi "Unpin" (terverifikasi di LIVE sungguhan, lihat
// autopin/VERIFICATION.md). Kalau teksnya masih "Pin", kliknya tidak berefek -
// itu hasil AMBIGU dan tidak boleh dianggap sukses.

// Teks tombol yang membuktikan produk sedang ter-pin.
const PINNED_BUTTON_TEXT = /^unpin$/i;

function normalizeButtonText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

// true HANYA untuk pin sungguhan yang terbukti. Semua keadaan lain - dry-run,
// timeout, stale, identitas salah, service mati, hasil ambigu - mengembalikan
// false beserta alasannya.
function inspectPinResult(result) {
  if (!result || typeof result !== "object") return { confirmed: false, reason: "no-result" };
  if (result.ok !== true) return { confirmed: false, reason: result.reason || "pin-failed" };

  // Dry-run tidak pernah menyentuh tombol. Apa pun yang dikatakannya, tidak ada
  // produk yang benar-benar ter-pin.
  if (result.dryRun === true || result.reason === "dry-run" || result.clicked === false) {
    return { confirmed: false, reason: "pin-dry-run" };
  }
  if (result.reason !== "pinned") return { confirmed: false, reason: `pin-unexpected-${result.reason}` };
  if (result.clicked !== true) return { confirmed: false, reason: "pin-not-clicked" };

  const state = normalizeButtonText(result.state);
  if (!state) return { confirmed: false, reason: "pin-state-unreadable" };
  if (!PINNED_BUTTON_TEXT.test(state)) return { confirmed: false, reason: "pin-state-not-pinned" };

  return { confirmed: true, reason: "pin-confirmed", title: result.title, state };
}

function isPinConfirmed(result) {
  return inspectPinResult(result).confirmed;
}

module.exports = { isPinConfirmed, inspectPinResult, PINNED_BUTTON_TEXT };
