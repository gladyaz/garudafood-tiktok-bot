"use strict";
// Pembentuk teks AutoComment. Deterministik, tanpa LLM, tanpa teks bebas.
//
// Hanya scene etalase (PAX-N) yang punya pesan. Scene lain -> tidak ada pesan,
// dan itu disengaja: AutoComment tidak boleh "mengarang" untuk scene yang tidak
// dikenal. Komentar penonton TIDAK PERNAH dipantulkan ke dalam pesan.

const MAX_LENGTH = 100; // batas yang terlihat di UI LIVE Manager (indikator 0/100)
const DEFAULT_TEMPLATE = "Etalase {n} sudah aku pin ya kak 🛒";
const PAX_RE = /^PAX-(\d{1,2})$/;

// Nomor etalase dari nama scene OBS. Hanya PAX-1..PAX-10 yang dikenal.
function etalaseNumber(scene) {
  if (typeof scene !== "string") return null;
  const m = PAX_RE.exec(scene.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 10 ? n : null;
}

// Mengembalikan { ok:true, text, etalase } atau { ok:false, reason }.
// Template hanya boleh memuat placeholder {n}; tidak ada interpolasi lain.
function formatSceneMessage(scene, { template = DEFAULT_TEMPLATE } = {}) {
  const n = etalaseNumber(scene);
  if (n === null) return { ok: false, reason: "unsupported-scene" };

  if (typeof template !== "string" || !template.includes("{n}")) {
    return { ok: false, reason: "invalid-template" };
  }
  const text = template.split("{n}").join(String(n)).replace(/\s+/g, " ").trim();

  if (!text) return { ok: false, reason: "empty-text" };
  if (/[<>]/.test(text)) return { ok: false, reason: "html-not-allowed" };
  if (/[\x00-\x1f\x7f]/.test(text)) return { ok: false, reason: "control-chars" };
  if ([...text].length > MAX_LENGTH) return { ok: false, reason: "too-long" };

  return { ok: true, text, etalase: n };
}

module.exports = { formatSceneMessage, etalaseNumber, MAX_LENGTH, DEFAULT_TEMPLATE };
