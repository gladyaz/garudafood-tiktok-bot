"use strict";
// Pemetaan scene OBS -> kunci judul produk, EKSPLISIT dan dari environment.
//
// Nomor posisi di daftar produk TIDAK PERNAH dipakai: satu aksi pin menggeser
// nomor banyak produk (lihat autopin/VERIFICATION.md). Identitas produk selalu
// judul.
//
// Bentuk env:
//   AUTOPIN_PRODUCT_PAX_1="kue coklat"
//   AUTOPIN_PRODUCT_PAX_2="bon bon"
// Garis bawah pada nama scene ditulis ulang jadi tanda hubung: PAX_1 -> PAX-1.
//
// Tidak ada nilai bawaan. Tanpa konfigurasi, peta kosong dan AutoPIN tidak
// pernah dipanggil untuk scene mana pun.

const PREFIX = "AUTOPIN_PRODUCT_";

// MAIN tidak pernah boleh punya produk: itu scene idle, bukan etalase.
const NEVER_MAPPED = new Set(["MAIN"]);

function loadSceneProductMap(env = process.env) {
  const map = {};
  for (const [name, raw] of Object.entries(env)) {
    if (!name.startsWith(PREFIX)) continue;
    const productKey = String(raw ?? "").trim();
    if (!productKey) continue; // placeholder kosong di .env.example diabaikan
    const scene = name.slice(PREFIX.length).replace(/_/g, "-");
    if (NEVER_MAPPED.has(scene)) continue;
    map[scene] = productKey;
  }
  return map;
}

// Dicetak sekali saat start supaya pemetaan bisa diaudit tanpa membuka .env.
function describeSceneProductMap(map) {
  const scenes = Object.keys(map).sort();
  if (scenes.length === 0) return "(kosong)";
  return scenes.map((s) => `${s}="${map[s]}"`).join(" ");
}

module.exports = { loadSceneProductMap, describeSceneProductMap, PREFIX, NEVER_MAPPED };
