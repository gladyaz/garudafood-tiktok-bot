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
// Aksi per-aturan. Validator ini memeriksa HANYA aksi yang menyala; aksi yang
// mati tidak punya prasyarat, karena ia tidak akan dijalankan. Lihat
// runtime/rule-actions.js, termasuk kenapa `declaresActions` ada.
const { resolveActions, declaresActions, anyEnabled } = require("../runtime/rule-actions");
// Interaksi saat sepi: bentuk yang berlaku. Lihat runtime/idle.js.
const { resolveIdle } = require("../runtime/idle");

// ---------------------------------------------------------------------------
// KETERSEDIAAN PRODUK BUKAN KERUSAKAN STRUKTURAL
//
// Ditemukan pada preflight LIVE NYATA 2026-10-21: tiga dari lima pemetaan
// menunjuk produk yang tidak ada di etalase hari itu, dan SELURUH runtime
// menolak start. Padahal etalase LIVE memang boleh berisi produk apa saja
// dalam urutan apa saja - itu bukan kesalahan customer, dan bukan alasan untuk
// mematikan AutoPIN pada dua pemetaan yang SEHAT, Product PRICE Q&A, balasan
// FAQ, maupun interaksi saat sepi.
//
// Maka alasan di bawah DITURUNKAN menjadi peringatan per-baris. Barisnya tetap
// `ok:false` - operator harus tetap melihat bahwa aturan itu tidak bisa memin
// sekarang - tapi ia TIDAK lagi menjatuhkan verdict global.
//
// Daftarnya SENGAJA pendek, dan hanya memuat kondisi yang dihitung dari
// KATALOG LIVE SAAT ITU:
//
//   product-not-found               produknya tidak ada di etalase sekarang
//   live-pin-control-not-available  produknya ada, tombol pin-nya tidak
//   ambiguous-product               produknya ada LEBIH DARI SATU sekarang
//
// ambiguous-product ikut DITURUNKAN pada 2026-10-21, sesudah pertimbangan
// kedua. Ia memang bukan "produk tidak ada", tapi ia sama-sama dihitung dari
// isi etalase saat itu: operator menambahkan satu produk bernama mirip, dan
// kunci judul yang tadinya unik berhenti unik. Membiarkannya fatal berarti
// satu produk baru bisa mematikan SELURUH otomasi - kelas kegagalan yang sama
// yang perubahan ini ada untuk menghapus.
//
// Yang menjaga keselamatannya BUKAN preflight, dan tidak dilonggarkan:
// resolveProductForPin menolak menebak di antara kandidat, gerbang kelayakan
// di autopin/pin-eligibility.js menidurkan aturannya SEBELUM scene diputar,
// dan aturan itu sembuh sendiri begitu etalase kembali tidak ambigu.
//
// Yang TIDAK masuk, dan alasannya:
//
//   empty-product-title / product-missing
//                       Pin dinyalakan tanpa produk dipilih. Itu config yang
//                       belum selesai, bukan etalase yang berubah.
//   obs-scene-missing / scene-playback-unknown / duplicate-scene /
//   ambiguous-trigger / no-triggers / no-actions-enabled / scene-required /
//   reply-required*     semuanya murni dari config, tidak menyentuh katalog.
//
// Aturan yang TIDAK memin tidak pernah sampai ke sini: pemeriksaan produknya
// dilewati seluruhnya di bawah (lihat `if (!actions.autoPin)`).
const AVAILABILITY_REASONS = Object.freeze(new Set([
  "product-not-found",
  "live-pin-control-not-available",
  "ambiguous-product",
]));

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
  // Blok `idle` dari config customer. null/undefined = tidak diperiksa.
  idle = null,
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
    const actions = resolveActions(m);
    // Aturan yang MEMILIH aksinya sendiri dituntut lengkap; aturan lama tidak.
    // Alasannya panjang dan penting — lihat declaresActions di
    // runtime/rule-actions.js. Ringkasnya: setiap scene FAQ yang sudah ada
    // hari ini ditulis sebagai product:null tanpa field actions, dan menuntut
    // produk darinya akan memblokir START untuk setiap customer yang punya
    // satu pun scene FAQ.
    const explicit = declaresActions(m);
    const row = { scene, ok: true, actions, reason: null };
    const problems = [];

    // --- aksi: setidaknya satu harus menyala ---
    if (!anyEnabled(actions)) problems.push("no-actions-enabled");

    // --- scene: hanya diperiksa kalau aturan ini memang mengganti scene ---
    if (actions.switchScene) {
      if (!scene) {
        problems.push("scene-required");
      } else {
        // --- scene ada di OBS? ---
        if (Array.isArray(obsScenes) && !obsScenes.includes(scene)) problems.push("obs-scene-missing");

        // --- scene bisa diputar? ---
        if (Array.isArray(playableScenes) && !playableScenes.includes(scene)) {
          // Tidak ada mediaInputs/duration untuk scene ini. Menebaknya berarti
          // mengubah perilaku pemutaran scene itu, jadi ia ditolak di sini.
          problems.push("scene-playback-unknown");
        }
      }
    }

    // --- scene ganda? ---
    // Hanya di antara aturan yang BENAR-BENAR memakai scene. Dua aturan tanpa
    // scene tidak bentrok: tidak ada satu pun yang mengirim apa pun ke OBS,
    // jadi tidak ada yang bisa saling menimpa.
    if (scene && actions.switchScene) {
      if (seenScenes.has(scene)) problems.push("duplicate-scene");
      else seenScenes.set(scene, true);
    }

    // --- produk ---
    //
    // SELURUH pemeriksaan produk dilewati kalau aturan ini tidak memin. Bukan
    // dilonggarkan — dilewati. Aturan FAQ tidak ikut dalam fail-closed produk:
    // judul yang tersimpan padanya tidak perlu ada di katalog LIVE, tidak perlu
    // unik, dan ketiadaannya tidak boleh memblokir START.
    const title = m && m.product && typeof m.product.title === "string" ? m.product.title.trim() : "";
    const wantsProduct = !!(m && m.product !== null && m.product !== undefined);

    if (!actions.autoPin) {
      /* aturan ini tidak memin: produk bukan prasyaratnya */
    } else if (explicit && !title) {
      // Kotak centang "Pin produk" menyala tanpa produk terpilih. Ini pilihan
      // yang tidak lengkap, bukan pernyataan.
      problems.push(wantsProduct ? "empty-product-title" : "product-missing");
    } else if (wantsProduct && !title) {
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

    if (actions.autoReply && explicit && !reply) {
      // Kotak centang "Balas komentar" menyala tanpa teks balasan. Aturan ini
      // akan terpicu dan tidak mengatakan apa pun — sesuatu yang customer tidak
      // bisa lihat dari dashboard, jadi dikatakan di sini.
      //
      // Berbeda dari pemeriksaan di bawah: yang ini tidak peduli saklar global.
      // Balasan yang dijanjikan aturan tapi tidak pernah ditulis adalah
      // kelalaian baik AutoComment menyala maupun tidak.
      problems.push("reply-required");
    }

    if (autoCommentEnabled && actions.autoPin && title && !reply) {
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
      // KLASIFIKASI. `reason`/`reasons` SENGAJA tidak diubah bentuknya: UI dan
      // tes yang sudah ada membacanya. Yang ditambahkan di sini menjawab
      // pertanyaan yang BERBEDA - "apakah ini menghalangi START?"
      const blocking = problems.filter((p) => !AVAILABILITY_REASONS.has(p));
      row.blocking = blocking.length > 0;
      if (row.blocking) row.blockingReason = blocking[0];
      if (problems.some((p) => AVAILABILITY_REASONS.has(p))) {
        row.unavailable = true;
        row.unavailableReason = problems.find((p) => AVAILABILITY_REASONS.has(p));
      }
    }
    rows.push(row);
  }

  // --- interaksi saat sepi -------------------------------------------------
  //
  // Diperiksa HANYA kalau menyala. Blok yang mati, atau tidak ada sama sekali,
  // tidak boleh bisa memblokir START — itu akan membuat sebuah fitur opsional
  // menjadi prasyarat.
  //
  // Scene interaksi diperiksa terhadap DUA hal yang sama dengan scene pemetaan:
  // benar-benar ada di OBS, dan dikenal mesin pemutaran. Tidak ada pelonggaran
  // untuk interaksi: Decision 1 MVP menyatakan ia memakai kontrak pemutaran yang
  // sama, jadi scene yang ada di OBS tapi tidak punya detail pemutaran ditolak
  // dengan jujur lewat kode yang sama, bukan diberi durasi cadangan.
  //
  // Yang TIDAK pernah diperiksa untuk interaksi: produk. Tidak ada satu pun
  // jalur yang bisa membuatnya memin, jadi tidak ada prasyarat produk untuknya.
  const idleCfg = resolveIdle(idle);
  const idleRows = [];
  let idleOk = true;
  let idleReason = null;
  if (idle !== null && idle !== undefined && idleCfg.enabled) {
    if (idleCfg.items.length === 0) {
      idleOk = false;
      idleReason = "idle-no-items";
    }
    const seenIdle = new Map();
    const ruleScenes = new Set(
      mappings
        .filter((m) => resolveActions(m).switchScene)
        .map((m) => String((m && m.scene) || "").trim())
        .filter((name) => name !== "")
    );
    for (const item of idleCfg.items) {
      const scene = item.scene;
      const row = { scene, ok: true, reason: null };
      const problems = [];

      if (Array.isArray(obsScenes) && !obsScenes.includes(scene)) problems.push("obs-scene-missing");
      if (Array.isArray(playableScenes) && !playableScenes.includes(scene)) problems.push("scene-playback-unknown");
      if (seenIdle.has(scene)) problems.push("duplicate-scene");
      else seenIdle.set(scene, true);
      // Satu scene tidak boleh dimiliki dua konsep: cooldown per-scene dan
      // playedScenes dipakai bersama, jadi keduanya akan saling membuang.
      if (ruleScenes.has(scene)) problems.push("idle-scene-conflicts-with-rule");

      if (problems.length > 0) {
        row.ok = false;
        row.reason = problems[0];
        row.reasons = problems;
        idleOk = false;
        if (!idleReason) idleReason = problems[0];
      }
      idleRows.push(row);
    }
  }

  // Verdict global dihitung dari baris yang MENGHALANGI, bukan dari baris yang
  // sekadar tidak siap. Pemetaan kosong tetap bukan "semua lolos".
  const blockingRows = rows.filter((r) => r.blocking === true);
  const degradedRows = rows.filter((r) => r.unavailable === true);
  const ok = mappings.length > 0 && blockingRows.length === 0 && idleOk;
  return {
    ok,
    // Pemetaan kosong bukan "semua lolos": sistem yang gunanya memin produk
    // tidak siap jalan tanpa satu pun pemetaan.
    reason: mappings.length === 0 ? "no-mappings" : idleOk ? null : idleReason,
    mappings: rows,
    // Baris interaksi TERPISAH dari baris pemetaan: UI menyorot dua daftar yang
    // berbeda, dan menggabungkannya akan membuat nomor barisnya salah.
    idle: idleRows,
    // Yang benar-benar MENGHALANGI start, dan yang hanya tidak tersedia
    // sekarang. Keduanya diekspos: menyembunyikan `degraded` akan membuat
    // "ok:true" terbaca sebagai "kelima aturan siap memin".
    blocking: blockingRows,
    degraded: degradedRows,
  };
}

module.exports = { validateMappings, resolveProduct, normalizeTitleKey, AVAILABILITY_REASONS };
