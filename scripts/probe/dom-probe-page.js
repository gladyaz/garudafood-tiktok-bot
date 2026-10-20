"use strict";
// PROBE DOM read-only untuk audit kelengkapan katalog (v0.3.0).
//
// ---------------------------------------------------------------------------
// APA MODUL INI, DAN APA YANG BUKAN
//
// Ini ALAT DIAGNOSA, bukan modul produksi. Ia tidak di-require oleh index.js,
// autopin-service.js, controller/, maupun desktop/, dan `scripts/` TIDAK ada di
// build.files package.json - jadi ia tidak pernah ikut terpaket ke installer.
//
// Tujuannya satu: mengumpulkan bukti yang TIDAK BISA diambil alat yang sudah
// ada, supaya kontrak kelengkapan (coverage="full") bisa dirancang di atas
// pengamatan, bukan dugaan. Dua alat yang ada tidak bisa menjawabnya:
//
//   autopin/inspect.js     sengaja MEMBUANG nilai input ("Tanpa cookie,
//                          storage, value input, query string") dan tidak
//                          pernah membaca geometri sama sekali.
//   discovery/tiktok.js    semua jalurnya memanggil collectProducts, dan
//                          collectProducts MENGGULIR daftar.
//
// ---------------------------------------------------------------------------
// YANG TIDAK PERNAH DILAKUKAN MODUL INI
//
// Tidak menulis scrollTop. Tidak mengklik apa pun. Tidak mengetik. Tidak
// mengubah filter. Tidak menyentuh urutan produk. Tidak memanggil
// setAttribute/innerHTML/remove/appendChild. Tidak membaca cookie,
// localStorage, sessionStorage, atau header. Tidak mengembalikan HTML mentah.
//
// Kondisi penentu container gulir di readScrollAncestorsInPage SENGAJA ditulis
// sama persis dengan milik produksi (`scrollHeight > clientHeight + 10`, lihat
// scrollProductListInPage di autopin/products.js) supaya laporannya menjawab
// "elemen mana yang AKAN dipilih produksi" tanpa pernah menggulirnya.
//
// ---------------------------------------------------------------------------
// PRIVASI
//
// Yang keluar dari halaman hanya: hitungan, enum, flag boolean, angka
// geometri, dan nama kelas/tag yang dipangkas. TIDAK ADA judul produk, harga,
// deskripsi, nama kategori, teks pencarian, atau identitas siapa pun.
//
// Kotak pencarian dilaporkan sebagai "empty" | "non-empty" | "unknown" -
// panjangnya pun tidak, karena panjang adalah kebocoran kecil yang tidak
// dibutuhkan audit ini.
//
// Verdict filter dilaporkan sebagai "default" | "non-default" | "unknown".
// Nama kategori yang sedang terpilih TIDAK pernah ikut: itu metadata katalog
// customer, dan audit ini tidak membutuhkannya.

// Selector. Yang turunan dari DOM NYATA (arsip .autopin-debug 2026-10-02 s/d
// 2026-10-06) diberi tanda; yang lain adalah anchor struktural umum Arco.
//
// PERINGATAN DAYA TAHAN - dinilai jujur, karena kontrak kelengkapan nanti
// bergantung padanya:
//
//   data-tid=*           test-id milik TikTok. Anchor TERKUAT yang tersedia.
//   role=combobox        standar ARIA. Kuat.
//   arco-select-multiple kelas komponen Arco. Cukup kuat.
//   *virtualized-container*  kelas CSS-module ber-hash (--nn7XK). Prefiksnya
//                        stabil, hash-nya TIDAK. Dicocokkan dengan *substring*
//                        prefiks saja - jangan pernah dipakukan ke hash.
//   *productFilter*      idem (--Mq+Zx).
//   "Product list in this LIVE" / "All categories" / "All stock"
//                        TEKS INGGRIS. Akan putus kalau locale dashboard
//                        berubah. Karena itu setiap verdict yang bersandar
//                        padanya ditandai basis:"label", dan pemanggil WAJIB
//                        memperlakukan "label" sebagai bukti lemah.
const SEL = Object.freeze({
  ROW_MARKER: '[class*="stock-and-pin-button"]',
  NUMBER_INPUT: 'input[data-tid="m4b_input_number"]',
  PIN_BUTTON: 'button[data-pin-performance-source="product_card"]',
  SEARCH_INPUT: 'input[data-tid="m4b_input_search"]',
  COMBOBOX: '[role="combobox"]',
  SELECT_VIEW: '[class*="arco-select-view"]',
  TAG_WRAP: '[class*="arco-input-tag"]',
  CATEGORY_BUTTON: 'button[data-tid="m4b_button"]',
  TYPOGRAPHY: '[class*="arco-typography"]',
  CHECKBOX_LABEL: 'label[data-tid="m4b_checkbox"]',
  VIRTUAL_CONTAINER: '[class*="virtualized-container"]',
  FILTER_ROW: '[class*="productFilter"]',
  // penanda kelas yang diperiksa DI DALAM JS, bukan lewat selector: matcher
  // tiruan di tes tidak mendukung :not(), dan produksi pun tidak memakainya.
  MULTI_MARK: "arco-select-multiple",
  TAG_PLACEHOLDER_MARK: "arco-input-tag-has-placeholder",
  // sentinel bahasa - lihat PERINGATAN DAYA TAHAN di atas
  STRIP_HEADER_TEXT: "Product list in this LIVE",
  DEFAULT_CATEGORY_TEXT: "All categories",
  DEFAULT_STOCK_TEXT: "All stock",
});

// --- dieksekusi DI DALAM halaman: setiap fungsi WAJIB self-contained ---
// Puppeteer mengirim fungsi ini sebagai STRING. Apa pun yang ditutup dari
// lingkup modul tidak akan ada di halaman, jadi helper kecil diulang di dalam
// tiap fungsi dengan sengaja.

// A. Strip ringkasan "Product list in this LIVE" -> kandidat total produk.
//
// DUA anchor yang saling memeriksa, karena satu anchor saja tidak bisa
// dibedakan dari "halamannya berubah":
//   byHeader  teks header (lemah: bahasa Inggris)
//   byBadge   <span> yang teksnya cocok pola +N (lebih kuat: struktural)
// Kalau keduanya ketemu tapi TIDAK SEPAKAT, hasilnya "malformed", bukan salah
// satu yang dipilih diam-diam.
function readStripInPage(sel) {
  const clip = (s, n) => {
    const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n) : t;
  };
  const ownText = (el) => {
    let t = "";
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.textContent;
    return t.replace(/\s+/g, " ").trim();
  };

  const deepText = (el) => String(el && el.textContent ? el.textContent : "").replace(/\s+/g, " ").trim();

  const vc = document.querySelector(sel.VIRTUAL_CONTAINER);
  const scope = vc || document.body;
  if (!scope) return { present: false, state: "absent", reason: "no-scope", anchors: { header: false, badge: false } };

  // anchor 1: header teks (lemah - bahasa Inggris)
  let header = null;
  for (const el of scope.querySelectorAll("div")) {
    if (ownText(el) === sel.STRIP_HEADER_TEXT) { header = el; break; }
  }

  // anchor 2: <span> yang teksnya cocok pola +N (struktural)
  const badgeSpans = [];
  for (const el of scope.querySelectorAll("span")) {
    if (/^\+\d+$/.test(ownText(el))) badgeSpans.push(el);
  }

  const anchors = { header: !!header, badge: badgeSpans.length > 0 };
  const out = (state, reason, extra) =>
    Object.assign({ present: state !== "absent", state, reason, anchors }, extra || {});

  // akar strip: utamakan header, jatuh ke leluhur badge
  let root = null;
  if (header && header.parentElement) root = header.parentElement;
  else if (badgeSpans.length === 1 && badgeSpans[0].parentElement && badgeSpans[0].parentElement.parentElement) {
    root = badgeSpans[0].parentElement.parentElement;
  }
  if (!root) return out("absent", header || badgeSpans.length ? "root-unresolved" : "strip-not-found");

  const rootClass = clip(root.getAttribute("class"), 60);

  // Baris thumbnail: induk dari pembungkus <img> pertama. Dari situ setiap anak
  // elemen adalah SALAH SATU dari dua hal - thumbnail (memuat <img>) atau slot
  // badge (tidak memuat <img>).
  //
  // Inilah kenapa badge dihitung lewat STRUKTUR, bukan lewat pencarian pola:
  // badge yang teksnya tidak terbaca ("16", "+1 6", "~16") tidak boleh lolos
  // sebagai "tidak ada badge" dan diam-diam menghasilkan total = jumlah
  // thumbnail. Itu persis bentuk salah hitung yang paling berbahaya di sini -
  // ia terlihat seperti jawaban yang sah.
  const imgs = root.querySelectorAll("img");
  if (imgs.length === 0) {
    return out("malformed", badgeSpans.length ? "badge-without-thumbnails" : "empty-strip", { thumbnails: 0, rootClass });
  }
  const thumbRow = imgs[0].parentElement && imgs[0].parentElement.parentElement;
  if (!thumbRow) return out("malformed", "thumb-row-unresolved", { rootClass });

  let thumbnails = 0;
  const badgeSlots = [];
  for (const child of thumbRow.children) {
    if (child.querySelectorAll("img").length > 0) thumbnails += 1;
    else badgeSlots.push(child);
  }

  if (thumbnails === 0) return out("malformed", "no-thumbnails-in-row", { thumbnails, rootClass });
  if (badgeSlots.length > 1) return out("malformed", "multiple-badge-slots", { thumbnails, badgeCount: badgeSlots.length, rootClass });

  let badgeValue = null;
  if (badgeSlots.length === 1) {
    const t = deepText(badgeSlots[0]);
    if (!/^\+\d+$/.test(t)) return out("malformed", "badge-unparsed", { thumbnails, rootClass });
    badgeValue = Number(t.slice(1));
    if (!Number.isInteger(badgeValue)) return out("malformed", "badge-unparsed", { thumbnails, rootClass });
  }

  return out("ok", "", {
    thumbnails,
    badgePresent: badgeValue !== null,
    badgeValue,
    // KANDIDAT, bukan otoritas. Pemanggil tidak boleh memakai ini untuk
    // memutuskan coverage sebelum ia terkonfirmasi di LIVE nyata.
    candidateTotal: thumbnails + (badgeValue === null ? 0 : badgeValue),
    rootClass,
  });
}

// B. Baris produk. Hitungan dan nomor posisi saja - tanpa judul, tanpa harga.
function readRowsInPage(sel) {
  const clip = (s, n) => {
    const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n) : t;
  };
  const rowMarkers = document.querySelectorAll(sel.ROW_MARKER).length;
  const numberEls = document.querySelectorAll(sel.NUMBER_INPUT);
  const pinButtons = document.querySelectorAll(sel.PIN_BUTTON).length;

  const numbers = [];
  let unreadable = 0;
  for (const el of numberEls) {
    const raw = el.getAttribute("aria-valuenow");
    const n = raw === null ? NaN : Number(raw);
    if (Number.isInteger(n)) numbers.push(n); else unreadable += 1;
  }
  const unique = [];
  for (const n of numbers) if (unique.indexOf(n) === -1) unique.push(n);
  unique.sort((a, b) => a - b);

  const vc = document.querySelector(sel.VIRTUAL_CONTAINER);

  return {
    rowMarkers,
    numberInputs: numberEls.length,
    pinButtons,
    numbersUnreadable: unreadable,
    uniqueNumbers: unique.length,
    numbers: unique,
    numbersContiguousFromOne: unique.length > 0 && unique[0] === 1 && unique[unique.length - 1] === unique.length,
    virtualizedContainer: { found: !!vc, className: vc ? clip(vc.getAttribute("class"), 60) : "" },
    // "ter-inisialisasi penuh": satu input nomor per baris, dan ada barisnya.
    // Ketidakcocokan = halaman masih merender, dan pembacaan apa pun atasnya
    // tidak boleh dipercaya.
    initialized: rowMarkers > 0 && rowMarkers === numberEls.length && unreadable === 0,
    // pinButtons 0 dengan baris ADA = dashboard terbuka tapi LIVE belum on air
    livePinControls: pinButtons > 0,
  };
}

// C. Kotak pencarian. Hanya empty/non-empty/unknown - teksnya TIDAK PERNAH
// keluar, panjangnya pun tidak.
function readSearchInPage(sel) {
  const el = document.querySelector(sel.SEARCH_INPUT);
  if (!el) return { found: false, state: "unknown", reason: "control-missing" };
  let raw;
  try {
    raw = el.value;
  } catch (e) {
    return { found: true, state: "unknown", reason: "value-threw" };
  }
  if (typeof raw !== "string") return { found: true, state: "unknown", reason: "value-not-string" };
  return { found: true, state: raw.trim() === "" ? "empty" : "non-empty", reason: "" };
}

// D. Filter. Tiga kontrol, dan arsip menunjukkan TIGA konvensi berbeda untuk
// "default":
//   kategori    <button> yang teks render-nya "All categories"  -> basis label
//   stock       arco-select tunggal, title="All stock"           -> basis label
//   activities  arco-select-multiple, title="" + kelas
//               arco-input-tag-has-placeholder (= tidak ada yang
//               dipilih)                                        -> basis STRUKTURAL
//
// Satu heuristik umum "apakah ini default" akan salah untuk setidaknya satu di
// antaranya. Jadi tiap kontrol dibaca dengan caranya sendiri, dan `basis`
// dilaporkan supaya pemanggil tahu verdict mana yang layak dipercaya.
//
// Yang TIDAK dikenali menjadi "unknown", BUKAN "default". Label yang kebetulan
// terlihat seperti default bukan bukti bahwa tidak ada filter terpasang.
function readFiltersInPage(sel) {
  const clip = (s, n) => {
    const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n) : t;
  };
  const ownText = (el) => {
    let t = "";
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.textContent;
    return t.replace(/\s+/g, " ").trim();
  };
  const deepText = (el) => String(el && el.textContent ? el.textContent : "").replace(/\s+/g, " ").trim();
  const hasClass = (el, mark) => String((el && el.getAttribute("class")) || "").indexOf(mark) !== -1;

  const filterRow = document.querySelector(sel.FILTER_ROW);
  const scope = filterRow || document.body;

  // --- kategori: tombol, nilai terpilih hanya muncul sebagai teks render ---
  let category = { found: false, state: "unknown", basis: "none", reason: "control-missing" };
  if (scope) {
    const btn = scope.querySelector(sel.CATEGORY_BUTTON);
    if (btn) {
      const typo = btn.querySelector(sel.TYPOGRAPHY);
      const text = typo ? (ownText(typo) || deepText(typo)) : deepText(btn);
      if (text === sel.DEFAULT_CATEGORY_TEXT) {
        category = { found: true, state: "default", basis: "label", reason: "" };
      } else if (text === "") {
        category = { found: true, state: "unknown", basis: "label", reason: "text-empty" };
      } else {
        // SENGAJA unknown, bukan non-default: default berbahasa lain dan filter
        // sungguhan tidak bisa dibedakan dari sini. Nilainya TIDAK dilaporkan.
        category = { found: true, state: "unknown", basis: "label", reason: "text-not-recognised" };
      }
    }
  }

  // --- combobox: stock (tunggal) dan activities (multiple) ---
  let stock = { found: false, state: "unknown", basis: "none", reason: "control-missing" };
  let activities = { found: false, state: "unknown", basis: "none", reason: "control-missing" };
  let comboboxCount = 0;
  for (const cb of document.querySelectorAll(sel.COMBOBOX)) {
    comboboxCount += 1;
    const view = cb.querySelector(sel.SELECT_VIEW);
    const title = view ? view.getAttribute("title") : null;
    const multiple = hasClass(cb, sel.MULTI_MARK);

    if (multiple) {
      if (activities.found) continue;
      const tag = cb.querySelector(sel.TAG_WRAP);
      const placeholder = tag ? hasClass(tag, sel.TAG_PLACEHOLDER_MARK) : false;
      if (title === null) activities = { found: true, state: "unknown", basis: "structural", reason: "view-missing" };
      else if (title === "" && placeholder) activities = { found: true, state: "default", basis: "structural", reason: "" };
      else if (title !== "") activities = { found: true, state: "non-default", basis: "structural", reason: "has-selection" };
      else activities = { found: true, state: "unknown", basis: "structural", reason: "empty-title-no-placeholder" };
    } else {
      if (stock.found) continue;
      if (title === null) stock = { found: true, state: "unknown", basis: "label", reason: "view-missing" };
      else if (title === sel.DEFAULT_STOCK_TEXT) stock = { found: true, state: "default", basis: "label", reason: "" };
      else if (title === "") stock = { found: true, state: "unknown", basis: "label", reason: "title-empty" };
      else stock = { found: true, state: "unknown", basis: "label", reason: "title-not-recognised" };
    }
  }

  // --- checkbox "All": tujuannya BELUM DIKETAHUI (kemungkinan pilih-semua,
  // bukan filter). Dilaporkan sebagai fakta, tidak ikut menentukan verdict.
  let selectAll = { found: false, checked: null };
  if (scope) {
    const label = scope.querySelector(sel.CHECKBOX_LABEL);
    if (label) {
      const box = label.querySelector('input[type="checkbox"]');
      let checked = null;
      if (box) {
        try {
          checked = box.checked === true;
        } catch (e) {
          checked = null;
        }
      }
      selectAll = { found: true, checked };
    }
  }

  return {
    filterRow: { found: !!filterRow, className: filterRow ? clip(filterRow.getAttribute("class"), 60) : "" },
    comboboxCount,
    category,
    stock,
    activities,
    selectAll,
  };
}

// E. Geometri. MEMBACA saja - tidak ada satu pun penulisan scrollTop di sini.
//
// `wouldPickDepth` meniru kondisi produksi (scrollHeight > clientHeight + 10)
// supaya laporannya bisa menjawab "elemen mana yang AKAN dipilih
// scrollProductListInPage", lalu membandingkannya dengan elemen yang MEMANG
// bisa digulir (overflow-y auto|scroll). Kalau keduanya berbeda, di situlah
// label coverage="full" bisa lahir dari gulir yang tidak pernah berefek.
function readScrollAncestorsInPage(sel) {
  const clip = (s, n) => {
    const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n) : t;
  };
  const marker = document.querySelector(sel.ROW_MARKER);
  if (!marker) return { rowFound: false, ancestors: [], wouldPickDepth: null, realScrollerDepths: [], heuristicPicksRealScroller: null };

  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const ancestors = [];
  let el = marker;
  let depth = 0;
  let wouldPickDepth = null;

  while (el && depth < 40) {
    let overflowY = "unknown";
    try {
      if (typeof getComputedStyle === "function") {
        const cs = getComputedStyle(el);
        if (cs && cs.overflowY) overflowY = String(cs.overflowY);
      }
    } catch (e) {
      overflowY = "unknown";
    }
    const scrollHeight = num(el.scrollHeight);
    const clientHeight = num(el.clientHeight);
    const scrollTop = num(el.scrollTop);
    // KONDISI PRODUKSI, dicocokkan kata demi kata
    const overflows = scrollHeight > clientHeight + 10;
    const scrollable = overflowY === "auto" || overflowY === "scroll";
    if (wouldPickDepth === null && overflows) wouldPickDepth = depth;

    const cls = clip(el.getAttribute ? el.getAttribute("class") : "", 70);
    ancestors.push({
      depth,
      tag: String(el.tagName || "?").toLowerCase(),
      className: cls,
      dataTid: el.getAttribute ? clip(el.getAttribute("data-tid"), 30) : "",
      scrollTop,
      scrollHeight,
      clientHeight,
      overflowY,
      overflows,
      scrollable,
      atBottom: scrollTop + clientHeight >= scrollHeight - 2,
      isVirtualizedContainer: cls.indexOf("virtualized-container") !== -1,
    });
    el = el.parentElement;
    depth += 1;
  }

  const realScrollerDepths = [];
  for (const a of ancestors) if (a.scrollable && a.overflows) realScrollerDepths.push(a.depth);

  return {
    rowFound: true,
    ancestors,
    wouldPickDepth,
    realScrollerDepths,
    // null kalau produksi tidak akan memilih apa pun (ia lalu melaporkan
    // no-scroll-container, dan itu jalan keluar yang SEHAT)
    heuristicPicksRealScroller:
      wouldPickDepth === null ? null : realScrollerDepths.indexOf(wouldPickDepth) !== -1,
  };
}

// --- murni, dijalankan di Node (bukan di halaman) ---

// Verdict gabungan "apakah daftar sedang tidak tersaring".
//
// FAIL-CLOSED: hanya "clean" yang boleh dipakai nanti sebagai izin
// coverage="full". Satu saja tidak diketahui -> "unknown", bukan "clean".
function scopeVerdict({ search, filters } = {}) {
  const s = search && search.state ? search.state : "unknown";
  const f = filters || {};
  const states = [
    f.category ? f.category.state : "unknown",
    f.stock ? f.stock.state : "unknown",
    f.activities ? f.activities.state : "unknown",
  ];
  if (s === "non-empty" || states.indexOf("non-default") !== -1) return "dirty";
  if (s === "empty" && states.every((x) => x === "default")) return "clean";
  return "unknown";
}

// Pembanding dua lintasan: bukti bahwa halamannya TENANG, bukan sedang berubah
// di bawah kaki kita.
function stability(a, b) {
  const g = (p, k) => (p && p[k] !== undefined ? p[k] : null);
  return {
    rowsStable: g(a.rows, "rowMarkers") === g(b.rows, "rowMarkers"),
    numbersStable: JSON.stringify(g(a.rows, "numbers")) === JSON.stringify(g(b.rows, "numbers")),
    stripStable:
      g(a.strip, "state") === g(b.strip, "state") &&
      g(a.strip, "candidateTotal") === g(b.strip, "candidateTotal"),
    scopeStable: a.scope === b.scope,
    geometryStable:
      JSON.stringify((g(a.geometry, "ancestors") || []).map((x) => [x.depth, x.scrollHeight, x.clientHeight])) ===
      JSON.stringify((g(b.geometry, "ancestors") || []).map((x) => [x.depth, x.scrollHeight, x.clientHeight])),
  };
}

// Gerbang terakhir sebelum apa pun ditulis ke disk. Hanya kunci yang ada di
// daftar ini yang boleh lolos; sisanya dibuang, termasuk kalau ada yang
// menambah field baru di atas tanpa memikirkan privasinya.
const ALLOWED = Object.freeze({
  strip: ["present", "state", "reason", "thumbnails", "badgePresent", "badgeValue", "candidateTotal", "anchors", "rootClass", "badgeCount"],
  rows: ["rowMarkers", "numberInputs", "pinButtons", "numbersUnreadable", "uniqueNumbers", "numbers", "numbersContiguousFromOne", "virtualizedContainer", "initialized", "livePinControls"],
  search: ["found", "state", "reason"],
  filters: ["filterRow", "comboboxCount", "category", "stock", "activities", "selectAll"],
  geometry: ["rowFound", "ancestors", "wouldPickDepth", "realScrollerDepths", "heuristicPicksRealScroller"],
});

function sanitizePass(pass) {
  const out = {};
  for (const section of Object.keys(ALLOWED)) {
    const src = pass && pass[section];
    if (!src || typeof src !== "object") continue;
    const keep = {};
    for (const k of ALLOWED[section]) if (src[k] !== undefined) keep[k] = src[k];
    out[section] = keep;
  }
  if (pass && typeof pass.scope === "string") out.scope = pass.scope;
  return out;
}

module.exports = {
  SEL,
  readStripInPage,
  readRowsInPage,
  readSearchInPage,
  readFiltersInPage,
  readScrollAncestorsInPage,
  scopeVerdict,
  stability,
  sanitizePass,
  ALLOWED,
};
