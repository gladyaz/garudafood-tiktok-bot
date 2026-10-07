"use strict";
// Validasi pemetaan terhadap DUNIA NYATA: scene yang benar-benar ada di OBS, dan
// produk yang benar-benar ada di katalog LIVE.
//
// Ini berbeda dari validasi skema di controller/config-manager.js. Yang di sana
// menjawab "bentuknya benar?". Yang di sini menjawab "isinya cocok dengan mesin
// dan akun yang akan dipakai?". Pemetaan bisa sempurna secara bentuk dan tetap
// menunjuk ke scene yang sudah dihapus operator di OBS, atau ke produk yang
// sudah habis dan hilang dari daftar LIVE.
//
// Kenapa ini penting dan bukan kemewahan: tanpa pemeriksaan ini, kegagalannya
// muncul SAAT LIVE — scene berpindah, lalu pin gagal dengan product-not-found,
// dan penonton melihat video produk yang tidak pernah ter-pin. Dua run LIVE
// pernah terbuang karena prasyarat seperti ini tidak diperiksa lebih dulu.
//
// Modul ini MURNI: ia menerima hasil discovery, bukan melakukan discovery.

const { normalizeForMatching } = require("../tiktok/normalize");
// Normalisasi judul produk DI-IMPOR dari jalur pin, tidak diduplikasi.
//
// Percobaan pertama menduplikasinya di sini "supaya validator tidak memuat jalur
// browser". Itu salah dua kali: autopin/core.js memang pure helpers tanpa satu
// pun require (jadi tidak ada browser yang ikut termuat), dan salinannya langsung
// menyimpang — ia tidak membuang apostrof, dan tidak membuang elipsis di ujung
// judul yang dipotong products.js ("Nama Produk Panjang…").
//
// Akibat penyimpangan itu persis kegagalan yang validator ini dibuat untuk
// mencegah: Controller mengatakan "produk ketemu" sementara resolveProductForPin
// tidak akan menemukannya saat LIVE. Satu implementasi, tidak ada drift.
const { normalizeTitleKey } = require("../autopin/core");

// Mengembalikan { ok, reason?, count?, product? } untuk satu kunci judul.
function resolveProduct(catalogue, titleKey) {
  const want = normalizeTitleKey(titleKey);
  if (!want) return { ok: false, reason: "empty-product-title" };
  const matches = catalogue.filter((p) => normalizeTitleKey(p.title).includes(want));
  if (matches.length === 0) return { ok: false, reason: "product-not-found" };
  // Dua produk yang cocok berarti kunci yang dipilih customer tidak cukup unik.
  // Memilih yang pertama akan memin produk yang salah separuh waktu, jadi ini
  // ditolak, bukan ditebak.
  if (matches.length > 1) return { ok: false, reason: "ambiguous-product", count: matches.length };
  return { ok: true, product: matches[0] };
}

// Hasil per-mapping plus ringkasan. Bentuknya tetap supaya UI bisa menyorot baris
// yang bermasalah tanpa menebak dari kalimat.
function validateMappings({
  mappings = [],
  obsScenes = null,
  products = null,
  autoCommentEnabled = false,
  // Scene yang punya detail pemutaran (mediaInputs/duration) di RULES. Scene di
  // luar daftar ini tidak bisa diputar; lihat runtime/mappings.js.
  playableScenes = null,
} = {}) {
  const rows = [];
  const seenScenes = new Map();
  // Trigger yang sudah dinormalkan -> scene pertama yang memakainya.
  const triggerOwner = new Map();

  for (const m of mappings) {
    const scene = String((m && m.scene) || "").trim();
    const row = { scene, ok: true, reason: null };
    const problems = [];

    // --- scene ada di OBS? ---
    if (Array.isArray(obsScenes)) {
      if (!obsScenes.includes(scene)) problems.push("obs-scene-missing");
    }

    // --- scene bisa diputar? ---
    if (Array.isArray(playableScenes) && !playableScenes.includes(scene)) {
      // Tidak ada mediaInputs/duration untuk scene ini. Menebaknya berarti
      // mengubah perilaku pemutaran scene itu, jadi ia ditolak di sini.
      problems.push("scene-playback-unknown");
    }

    // --- scene ganda? ---
    if (seenScenes.has(scene)) problems.push("duplicate-scene");
    else seenScenes.set(scene, true);

    // --- produk ---
    const title = m && m.product && typeof m.product.title === "string" ? m.product.title.trim() : "";
    const wantsProduct = !!(m && m.product !== null && m.product !== undefined);

    if (wantsProduct && !title) {
      problems.push("empty-product-title");
    } else if (title && Array.isArray(products)) {
      const resolved = resolveProduct(products, title);
      if (!resolved.ok) {
        problems.push(resolved.reason);
        if (resolved.count) row.matches = resolved.count;
      } else {
        // Judul yang BENAR-BENAR terlihat di daftar LIVE, bukan potongan yang
        // diketik customer. Dipakai UI untuk menunjukkan produk mana yang
        // sesungguhnya terpilih.
        row.resolvedTitle = resolved.product.title;
        row.resolvedNumber = Number.isInteger(resolved.product.number) ? resolved.product.number : null;
        if (resolved.product.pinAvailable === false) problems.push("live-pin-control-not-available");
      }
    }

    // --- trigger ---
    const triggers = Array.isArray(m && m.triggers) ? m.triggers.filter((t) => typeof t === "string" && t.trim() !== "") : [];
    if (triggers.length === 0) {
      // Scene tanpa trigger tidak akan pernah bisa diminta penonton. Ia bukan
      // pemetaan, ia baris yang tidak berguna.
      problems.push("no-triggers");
    }
    for (const t of triggers) {
      // Dinormalkan dengan normalisasi PRODUKSI, bukan dengan trim biasa:
      // "Etalase Satu" dan "etalase 1" adalah trigger yang SAMA bagi matcher,
      // dan dua scene yang mengklaim keduanya akan saling merebut komentar.
      const key = normalizeForMatching(t);
      if (!key) continue;
      if (triggerOwner.has(key) && triggerOwner.get(key) !== scene) {
        problems.push("ambiguous-trigger");
        row.conflictsWith = triggerOwner.get(key);
        row.conflictingTrigger = t;
      } else if (!triggerOwner.has(key)) {
        triggerOwner.set(key, scene);
      }
    }

    // --- balasan ---
    const reply = m && typeof m.reply === "string" ? m.reply.trim() : "";
    if (autoCommentEnabled && title && !reply) {
      // Produk yang akan dipin tapi tidak punya kalimat pengumuman, padahal
      // AutoComment menyala. Diam adalah hasil yang sah, tapi di sini ia hampir
      // pasti kelalaian: customer menyalakan AutoComment lalu lupa mengisi.
      problems.push("reply-required-when-autocomment-enabled");
    }

    if (problems.length > 0) {
      row.ok = false;
      // Satu alasan utama untuk ditampilkan, daftar lengkap untuk yang mau tahu.
      row.reason = problems[0];
      row.reasons = problems;
    }
    rows.push(row);
  }

  const ok = mappings.length > 0 && rows.every((r) => r.ok);
  return {
    ok,
    // Pemetaan kosong bukan "semua lolos": sistem yang gunanya memin produk
    // tidak siap jalan tanpa satu pun pemetaan.
    reason: mappings.length === 0 ? "no-mappings" : null,
    mappings: rows,
  };
}

module.exports = { validateMappings, resolveProduct, normalizeTitleKey };
