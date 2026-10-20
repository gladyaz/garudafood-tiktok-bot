"use strict";
// Pembacaan produk + aksi pin pada LIVE console.
//
// Selector ditemukan dari DOM asli (2026-10-02 offline, 2026-10-03 saat LIVE aktif):
//
//   baris produk   : di-anchor ke [class*="stock-and-pin-button"] (satu per baris),
//                    lalu naik ke leluhur terbesar yang masih memuat TEPAT SATU input nomor.
//                    Tidak boleh di-anchor ke input nomor saja: ada input numerik lain
//                    di halaman (aria-valuenow=30) yang bukan produk.
//   nomor produk   : input[data-tid="m4b_input_number"] -> aria-valuenow (nomor TERLIHAT, mudah berubah)
//   PIN SEBENARNYA : button[data-pin-performance-source="product_card"]
//                    Hanya ada selama LIVE aktif. Inilah satu-satunya kontrol pin per produk.
//   BUKAN pin      : button[data-pin-performance-source="shopping_list"]  (level daftar)
//                    button[class*="surprise-"]                           (teks "Pin" juga)
//                    .pc_top_product                                      (hanya mengurutkan daftar)
//
// .pc_top_product TIDAK PERNAH diklik oleh modul ini. Ia hanya dibaca sebagai diagnostik
// urutan daftar (field `topControls`), karena mengkliknya menggeser nomor semua produk.

const { withPriceFields } = require("./price");
const { COVERAGE } = require("./catalogue");

const NUMBER_INPUT = 'input[data-tid="m4b_input_number"]';
const ROW_MARKER = '[class*="stock-and-pin-button"]';
const TOP_CONTROL = ".pc_top_product"; // diagnostik saja — jangan diklik
const PIN_BUTTON = 'button[data-pin-performance-source="product_card"]';
// HARGA. Dua selector, keduanya dari DOM nyata (LIVE 2026-10-19, lihat
// docs/dynamic-product-price-audit-v0.2.1.md):
//   PRICE_PRIMARY : harga sekarang — 16px/500, inilah yang sudah dibaca
//                   sebagai `price` sejak awal. JANGAN diubah: mengubahnya
//                   mengubah harga yang sudah tampil di dropdown customer.
//   PRICE_DIM     : harga pembanding — 12px/400, rgba(0,0,0,.35). Tidak
//                   dicoret CSS, jadi ia tidak bisa dikenali dari
//                   text-decoration; kelas tipografinya yang membedakan.
const PRICE_PRIMARY = '[class*="text-body-l-medium"]';
const PRICE_DIM = '[class*="text-neutral-text4"][class*="text-body-s"]';

// --- dieksekusi DI DALAM halaman: harus self-contained ---
function readProductsInPage(sel) {
  const clip = (s, n) => {
    const t = String(s || "").replace(/\s+/g, " ").trim();
    return t.length > n ? `${t.slice(0, n)}…` : t;
  };
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const count = (el) => el.querySelectorAll(sel.NUMBER_INPUT).length;

  const rows = [];
  const seen = new Set();
  for (const marker of document.querySelectorAll(sel.ROW_MARKER)) {
    let el = marker;
    while (el.parentElement && count(el) === 0) el = el.parentElement;
    while (el.parentElement && count(el.parentElement) === 1) el = el.parentElement;
    if (count(el) !== 1 || seen.has(el)) continue;
    seen.add(el);
    rows.push(el);
  }

  const products = rows.map((row) => {
    const inputs = row.querySelectorAll(sel.NUMBER_INPUT);
    const numberRaw = inputs.length === 1 ? inputs[0].getAttribute("aria-valuenow") : null;
    const number = numberRaw !== null && /^\d+$/.test(numberRaw) ? Number(numberRaw) : null;

    const titleEl =
      row.querySelector('[class*="overflow-ellipsis"] span') ||
      row.querySelector('[class*="overflow-ellipsis"]');
    const priceEl = row.querySelector(sel.PRICE_PRIMARY);
    const stockEl = row.querySelector('[class*="stock-and-ask-to-show"]');
    const img = row.querySelector("img[src]");

    // Seluruh simpul ber-"Rp" di baris ini, APA ADANYA. Di sini TIDAK ada
    // keputusan: yang dilaporkan hanya teksnya dan apakah simpulnya cocok
    // selector harga utama / harga pembanding. Artinya diputuskan di
    // autopin/price.js, yang bisa diuji sebagai fungsi murni — kode di dalam
    // page.evaluate tidak bisa mengimpor apa pun, jadi aturan yang tinggal di
    // sini hanya bisa diuji lewat tiruan DOM yang bentuknya dikarang.
    //
    // Kelas DOM-nya TIDAK ikut keluar: yang keluar sudah berupa dua boolean,
    // jadi struktur internal TikTok tidak pernah merembes ke luar halaman.
    const priceNodes = [];
    for (const el of row.querySelectorAll("*")) {
      let own = "";
      for (const n of el.childNodes) if (n.nodeType === 3) own += ` ${n.textContent}`;
      if (!/rp\s*\d/i.test(own)) continue;
      priceNodes.push({
        text: clip(own, 40),
        primary: el.matches(sel.PRICE_PRIMARY),
        dim: el.matches(sel.PRICE_DIM),
      });
    }

    // Pin per produk — HANYA yang bersumber product_card, dicari di dalam baris ini saja.
    const pinButtons = [...row.querySelectorAll(sel.PIN_BUTTON)];
    const pin = pinButtons[0] || null;

    const icons = [...row.querySelectorAll("svg")]
      .map((s) => String(s.getAttribute("class") || ""))
      .map((c) => (c.match(/arco-icon-[\w-]+/) || [""])[0])
      .filter(Boolean);
    const ariaOnRow = [...row.querySelectorAll("[aria-pressed],[aria-selected],[aria-current],[aria-checked]")]
      .map((el) => [...el.attributes]
        .filter((a) => /^aria-(pressed|selected|current|checked)$/.test(a.name))
        .map((a) => `${a.name}=${a.value}`)
        .join(","))
      .filter(Boolean);
    const badges = [...row.querySelectorAll('[data-tid="m4b_badge"],[class*="badge"]')]
      .map((el) => clip(el.textContent, 30))
      .filter(Boolean);

    return {
      number,
      rowInputs: inputs.length,
      title: clip(titleEl ? titleEl.textContent : "", 120),
      price: clip(priceEl ? priceEl.textContent : "", 40),
      priceNodes,
      stock: clip(stockEl ? stockEl.textContent : "", 60),
      imageKey: img
        ? (() => { try { return new URL(img.src).pathname.split("/").pop() || ""; } catch { return ""; } })()
        : "",
      productId: "", // DOM tidak mengeksposnya
      // kontrol pin SEBENARNYA
      pinButtons: pinButtons.length,
      pinDisabled: pin ? pin.disabled === true || pin.getAttribute("aria-disabled") === "true" : null,
      pinVisible: pin ? visible(pin) : null,
      pinText: pin ? clip(pin.textContent, 24) : "",
      pinClass: pin ? clip(pin.getAttribute("class") || "", 90) : "",
      // diagnostik urutan daftar — tidak pernah diklik
      topControls: row.querySelectorAll(sel.TOP_CONTROL).length,
      icons: [...new Set(icons)].sort(),
      ariaOnRow: [...new Set(ariaOnRow)].sort(),
      badges: [...new Set(badges)].sort(),
    };
  });

  // --- BUKTI KELENGKAPAN, dari evaluate YANG SAMA ---
  //
  // Dilipat ke sini, bukan dibaca lewat page.evaluate kedua. Alasannya diukur:
  // satu perjalanan bolak-balik tambahan per gelombang membuat produk terdalam
  // melewati anggaran pin 12 detik (test/autopin.budget12.test.js), dan margin
  // posisi #20 lebih kecil dari satu evaluate. Jadi buktinya menumpang pada
  // pembacaan yang MEMANG sudah terjadi: sekali di awal, lalu sesudah setiap
  // gelombang gulir. Hasilnya bukan cuma lebih murah, tapi lebih kuat -
  // stabilitas terperiksa SETIAP gelombang, bukan hanya di dua ujung.
  //
  // BIAYA DOM-nya terbatas oleh virtualisasi: yang ada di DOM hanya baris yang
  // ter-render (terukur 6 dari 20 pada LIVE 2026-10-06), jadi pemindaian di
  // bawah berjalan atas ratusan node, bukan ribuan. Pencarian header pun
  // berhenti pada kecocokan pertama.
  //
  // Yang dikembalikan di sini PENGAMATAN MENTAH. Vonisnya - scope bersih atau
  // tidak, sidik jari scroller, coverage - dihitung oleh fungsi MURNI di Node
  // (scopeVerdict, scrollerFingerprint, decideCoverage), supaya aturannya hidup
  // di satu tempat yang bisa diuji tanpa DOM.
  const catalogueEvidence = (() => {
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

    // --- pencarian: hanya empty/non-empty/unknown, teksnya TIDAK PERNAH keluar ---
    let search;
    const inputCari = document.querySelector(sel.SEARCH_INPUT);
    if (!inputCari) search = { found: false, state: "unknown", reason: "control-missing" };
    else {
      let raw;
      try {
        raw = inputCari.value;
      } catch (e) {
        raw = undefined;
      }
      if (typeof raw !== "string") search = { found: true, state: "unknown", reason: "value-unreadable" };
      else search = { found: true, state: raw.trim() === "" ? "empty" : "non-empty", reason: "" };
    }

    // --- filter ---
    const filterRow = document.querySelector(sel.FILTER_ROW);
    const scopeEl = filterRow || document.body;

    let category = { found: false, state: "unknown", basis: "none", reason: "control-missing" };
    if (scopeEl) {
      const btn = scopeEl.querySelector(sel.CATEGORY_BUTTON);
      if (btn) {
        const typo = btn.querySelector(sel.TYPOGRAPHY);
        const text = typo ? ownText(typo) || deepText(typo) : deepText(btn);
        if (text === sel.DEFAULT_CATEGORY_TEXT) category = { found: true, state: "default", basis: "label", reason: "" };
        else if (text === "") category = { found: true, state: "unknown", basis: "label", reason: "text-empty" };
        // SENGAJA unknown, bukan non-default: default berbahasa lain dan filter
        // sungguhan tidak bisa dibedakan dari sini. Nilainya TIDAK dilaporkan.
        else category = { found: true, state: "unknown", basis: "label", reason: "text-not-recognised" };
      }
    }

    let stock = { found: false, state: "unknown", basis: "none", reason: "control-missing" };
    let activities = { found: false, state: "unknown", basis: "none", reason: "control-missing" };
    let comboboxCount = 0;
    for (const cb of document.querySelectorAll(sel.COMBOBOX)) {
      comboboxCount += 1;
      const view = cb.querySelector(sel.SELECT_VIEW);
      const title = view ? view.getAttribute("title") : null;
      if (hasClass(cb, sel.MULTI_MARK)) {
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

    // Checkbox "All": tujuannya BELUM DIKETAHUI (kemungkinan pilih-semua, bukan
    // filter). Dilaporkan sebagai fakta, TIDAK ikut menentukan verdict.
    let selectAll = { found: false, checked: null };
    if (scopeEl) {
      const label = scopeEl.querySelector(sel.CHECKBOX_LABEL);
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

    // --- strip ringkasan -> declaredTotal ---
    const vc = document.querySelector(sel.VIRTUAL_CONTAINER);
    const stripScope = vc || document.body;
    let strip = { present: false, state: "absent", reason: "no-scope", declaredTotal: null };
    if (stripScope) {
      let header = null;
      for (const el of stripScope.querySelectorAll("div")) {
        if (ownText(el) === sel.STRIP_HEADER_TEXT) { header = el; break; }
      }
      const badgeSpans = [];
      for (const el of stripScope.querySelectorAll("span")) {
        if (/^\+\d+$/.test(ownText(el))) badgeSpans.push(el);
      }
      const anchors = { header: !!header, badge: badgeSpans.length > 0 };
      const out = (state, reason, extra) =>
        Object.assign({ present: state !== "absent", state, reason, anchors, declaredTotal: null }, extra || {});

      let root = null;
      if (header && header.parentElement) root = header.parentElement;
      else if (badgeSpans.length === 1 && badgeSpans[0].parentElement && badgeSpans[0].parentElement.parentElement) {
        root = badgeSpans[0].parentElement.parentElement;
      }

      if (!root) strip = out("absent", header || badgeSpans.length ? "root-unresolved" : "strip-not-found");
      else {
        const rootClass = clip(root.getAttribute("class"), 60);
        const imgs = root.querySelectorAll("img");
        if (imgs.length === 0) {
          strip = out("malformed", badgeSpans.length ? "badge-without-thumbnails" : "empty-strip", { thumbnails: 0, rootClass });
        } else {
          const thumbRow = imgs[0].parentElement && imgs[0].parentElement.parentElement;
          if (!thumbRow) strip = out("malformed", "thumb-row-unresolved", { rootClass });
          else {
            let thumbnails = 0;
            const badgeSlots = [];
            for (const child of thumbRow.children) {
              if (child.querySelectorAll("img").length > 0) thumbnails += 1;
              else badgeSlots.push(child);
            }
            if (thumbnails === 0) strip = out("malformed", "no-thumbnails-in-row", { thumbnails, rootClass });
            else if (badgeSlots.length > 1) strip = out("malformed", "multiple-badge-slots", { thumbnails, badgeCount: badgeSlots.length, rootClass });
            else {
              let badgeValue = null;
              let rusak = false;
              if (badgeSlots.length === 1) {
                const t = deepText(badgeSlots[0]);
                if (!/^\+\d+$/.test(t)) rusak = true;
                else {
                  badgeValue = Number(t.slice(1));
                  if (!Number.isInteger(badgeValue)) rusak = true;
                }
              }
              if (rusak) strip = out("malformed", "badge-unparsed", { thumbnails, rootClass });
              else {
                strip = out("ok", "", {
                  thumbnails,
                  badgePresent: badgeValue !== null,
                  badgeValue,
                  declaredTotal: thumbnails + (badgeValue === null ? 0 : badgeValue),
                  rootClass,
                });
              }
            }
          }
        }
      }
    }

    // --- container gulir, DIBACA tanpa menggulir ---
    //
    // Dilipat ke dalam fungsi yang sama, bukan evaluate terpisah: test/helpers/
    // pin-harness.js memodelkan satu page.evaluate sebagai 80 ms, dan jalur pin
    // sudah pernah GAGAL di LIVE 2026-10-06 karena anggaran. Bukti kelengkapan
    // tidak boleh dibayar dengan perjalanan bolak-balik tambahan per gelombang.
    //
    // Kondisinya (`scrollHeight > clientHeight + 10`) sengaja sama kata demi kata
    // dengan scrollProductListInPage. Kalau keduanya menyimpang, sidik jari yang
    // dibandingkan bukan sidik jari elemen yang benar-benar digulir - dan
    // test/autopin.completeness.test.js menguji keduanya memilih elemen yang SAMA.
    let scroller = { found: false, reason: "no-rows" };
    const marker = document.querySelector(sel.ROW_MARKER);
    if (marker) {
      let el = marker;
      let depth = 0;
      while (el && !(el.scrollHeight > el.clientHeight + 10)) { el = el.parentElement; depth += 1; }
      if (!el) scroller = { found: false, reason: "no-scroll-container" };
      else {
        // TIDAK ADA pembacaan gaya terhitung di sini, dan itu bukan kelalaian.
        // (Namanya sengaja tidak ditulis: test/autopin.price.test.js memeriksa
        // sumber fungsi ini sebagai TEKS, dan komentar ikut terbaca.)
        //
        // Fungsi ini dipanggil SETIAP gelombang gulir, dan membaca gaya
        // terhitung memaksa recalc style. Jalur pin punya anggaran keras yang pernah
        // benar-benar habis di LIVE, jadi ia tidak boleh ikut membayarnya -
        // aturan yang sama sudah dijaga test/autopin.price.test.js untuk
        // pembacaan harga, dan berlaku sama persis di sini.
        //
        // Identitas scroller karena itu STRUKTURAL: kedalaman dari baris
        // produk, tag, dan apakah ia container virtualisasi. Ketiganya cukup
        // untuk menjawab "elemen yang digulir berpindah atau tidak" - kalau
        // elemen lain yang menang jalan-naik, kedalaman dan/atau penanda
        // virtualisasinya ikut berubah. scrollTop/scrollHeight/clientHeight
        // tetap dibaca karena scrollProductListInPage memang sudah
        // membacanya tiap gelombang.
        const kelas = String((el.getAttribute && el.getAttribute("class")) || "");
        scroller = {
          found: true,
          depth,
          tag: String(el.tagName || "?").toLowerCase(),
          // Prefiks, BUKAN hash: nama kelas CSS-module berubah tiap build TikTok.
          virtualized: kelas.indexOf("virtualized-container") !== -1,
          scrollTop: Number(el.scrollTop) || 0,
          scrollHeight: Number(el.scrollHeight) || 0,
          clientHeight: Number(el.clientHeight) || 0,
        };
      }
    }

    return {
      search,
      filters: { filterRow: { found: !!filterRow }, comboboxCount, category, stock, activities, selectAll },
      strip,
      scroller,
    };
  })();

  return {
    products,
    markers: rows.length,
    numberInputsOnPage: document.querySelectorAll(sel.NUMBER_INPUT).length,
    // bukti kontrol pin LIVE ada di halaman sama sekali
    livePinButtonsOnPage: document.querySelectorAll(sel.PIN_BUTTON).length,
    catalogueEvidence,
  };
}

// --- dieksekusi DI DALAM halaman ---
function readIdentityInPage() {
  const clip = (s, n) => {
    const t = String(s || "").replace(/\s+/g, " ").trim();
    return t.length > n ? `${t.slice(0, n)}…` : t;
  };
  const out = [];
  const avatar = document.querySelector('[data-tid="m4b_avatar"]');
  if (avatar && avatar.parentElement) {
    for (const el of avatar.parentElement.querySelectorAll("span")) {
      const t = clip(el.textContent, 60);
      if (t && t.length <= 60 && !el.querySelector("img")) out.push(t);
    }
  }
  return [...new Set(out)].filter(Boolean);
}

// --- dieksekusi DI DALAM halaman ---
function resetScrollInPage(sel) {
  const marker = document.querySelector(sel.ROW_MARKER);
  if (!marker) return { ok: false };
  let el = marker;
  while (el && !(el.scrollHeight > el.clientHeight + 10)) el = el.parentElement;
  if (!el) return { ok: false };
  el.scrollTop = 0;
  return { ok: true };
}

// --- dieksekusi DI DALAM halaman ---
function scrollProductListInPage(sel, step) {
  const marker = document.querySelector(sel.ROW_MARKER);
  if (!marker) return { scrolled: false, reason: "no-rows" };
  let el = marker;
  while (el && !(el.scrollHeight > el.clientHeight + 10)) el = el.parentElement;
  if (!el) return { scrolled: false, reason: "no-scroll-container" };
  const before = el.scrollTop;
  el.scrollTop = before + step;
  return { scrolled: el.scrollTop !== before, scrollTop: el.scrollTop, scrollHeight: el.scrollHeight };
}

// --- dieksekusi DI DALAM halaman ---
// Resolusi + klik ATOMIK pada tombol Pin SEBENARNYA. Semua penolakan terjadi di sini
// supaya tidak ada celah antara "memvalidasi" dan "mengklik".
function pinProductInPage(sel, opts) {
  const norm = (s) =>
    String(s || "")
      .normalize("NFKC")
      .replace(/…+$/, "")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const count = (el) => el.querySelectorAll(sel.NUMBER_INPUT).length;

  const rows = [];
  const seen = new Set();
  for (const marker of document.querySelectorAll(sel.ROW_MARKER)) {
    let el = marker;
    while (el.parentElement && count(el) === 0) el = el.parentElement;
    while (el.parentElement && count(el.parentElement) === 1) el = el.parentElement;
    if (count(el) !== 1 || seen.has(el)) continue;
    seen.add(el);
    rows.push(el);
  }

  const titleOf = (row) => {
    const el =
      row.querySelector('[class*="overflow-ellipsis"] span') ||
      row.querySelector('[class*="overflow-ellipsis"]');
    const raw = String(el ? el.textContent : "").replace(/\s+/g, " ").trim();
    return raw.length > 120 ? `${raw.slice(0, 120)}…` : raw;
  };

  // Target diselesaikan lewat JUDUL (identitas stabil), bukan nomor posisi.
  const want = norm(opts.titleKey);
  const matches = rows.filter((row) => norm(titleOf(row)).includes(want));

  if (matches.length === 0) return { ok: false, reason: "row-not-rendered" };
  if (matches.length > 1) return { ok: false, reason: "ambiguous-product", count: matches.length };

  const row = matches[0];
  const title = titleOf(row);

  // HANYA product_card, dicari di dalam baris target. Tidak ada fallback ke
  // shopping_list, ke teks "Pin" generik, maupun ke .pc_top_product.
  const buttons = [...row.querySelectorAll(sel.PIN_BUTTON)];
  if (buttons.length === 0) return { ok: false, reason: "live-pin-control-not-available", title };
  if (buttons.length > 1) return { ok: false, reason: "ambiguous-control", count: buttons.length, title };

  const btn = buttons[0];
  const before = {
    text: String(btn.textContent || "").replace(/\s+/g, " ").trim().slice(0, 24),
    disabled: btn.disabled === true || btn.getAttribute("aria-disabled") === "true",
    cls: String(btn.getAttribute("class") || "").slice(0, 90),
  };

  if (before.disabled) return { ok: false, reason: "control-disabled", title, before };
  if (!visible(btn)) return { ok: false, reason: "control-not-visible", title, before };

  if (opts.dryRun) return { ok: true, title, before, clicked: false };

  btn.scrollIntoView({ block: "center" });
  btn.click();
  return { ok: true, title, before, clicked: true };
}

// --- dieksekusi DI DALAM halaman: baca ulang state tombol milik satu produk ---
function readPinStateInPage(sel, opts) {
  const norm = (s) =>
    String(s || "")
      .normalize("NFKC")
      .replace(/…+$/, "")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase();
  const count = (el) => el.querySelectorAll(sel.NUMBER_INPUT).length;

  for (const marker of document.querySelectorAll(sel.ROW_MARKER)) {
    let el = marker;
    while (el.parentElement && count(el) === 0) el = el.parentElement;
    while (el.parentElement && count(el.parentElement) === 1) el = el.parentElement;
    if (count(el) !== 1) continue;
    const titleEl =
      el.querySelector('[class*="overflow-ellipsis"] span') ||
      el.querySelector('[class*="overflow-ellipsis"]');
    const raw = String(titleEl ? titleEl.textContent : "").replace(/\s+/g, " ").trim();
    if (!norm(raw).includes(norm(opts.titleKey))) continue;
    const btn = el.querySelector(sel.PIN_BUTTON);
    return {
      found: true,
      text: btn ? String(btn.textContent || "").replace(/\s+/g, " ").trim().slice(0, 24) : "",
      disabled: btn ? btn.disabled === true || btn.getAttribute("aria-disabled") === "true" : null,
      cls: btn ? String(btn.getAttribute("class") || "").slice(0, 90) : "",
      buttons: el.querySelectorAll(sel.PIN_BUTTON).length,
    };
  }
  return { found: false };
}

// ---------------------------------------------------------------------------
// BUKTI KELENGKAPAN KATALOG
//
// Semua selector di bawah ditemukan dari DOM NYATA dan DIVERIFIKASI pada LIVE
// 2026-10-20 (akun agen_mulia_abadi, katalog 5 produk). Lihat
// .autopin-debug/*_dom-probe.json dan *_scroll-probe.json.
//
// Kenapa ini ada: sampai v0.2.2, coverage="full" adalah KESIMPULAN dari dua
// flag negatif (ranOutOfTime dan stoppedEarly). Kesimpulan itu bisa salah
// dalam tiga cara yang terbukti - kuota gelombang habis, container gulir
// keliru, dan daftar yang tersaring oleh kotak pencarian/filter. Sekarang
// "full" harus DISAKSIKAN: ada totalnya, posisinya lengkap, cakupannya bersih,
// dan tidak ada yang berubah di tengah jalan.
//
// DAYA TAHAN - dinilai jujur:
//   data-tid=*              test-id TikTok. Anchor terkuat yang ada.
//   role=combobox           standar ARIA. Kuat.
//   arco-select-multiple    kelas komponen Arco. Cukup kuat.
//   *virtualized-container* kelas CSS-module ber-hash. Prefiksnya stabil
//                           (--nn7XK sama pada 2026-10-06 DAN 2026-10-20),
//                           hash-nya TIDAK dijadikan sandaran.
//   teks "All categories" / "All stock" / "Product list in this LIVE"
//                           TEKS INGGRIS. Verdict yang bersandar padanya
//                           ditandai basis:"label", dan label yang tidak
//                           dikenali menjadi "unknown" - BUKAN "default".
const SEARCH_INPUT = 'input[data-tid="m4b_input_search"]';
const COMBOBOX = '[role="combobox"]';
const SELECT_VIEW = '[class*="arco-select-view"]';
const TAG_WRAP = '[class*="arco-input-tag"]';
const CATEGORY_BUTTON = 'button[data-tid="m4b_button"]';
const TYPOGRAPHY = '[class*="arco-typography"]';
const CHECKBOX_LABEL = 'label[data-tid="m4b_checkbox"]';
const VIRTUAL_CONTAINER = '[class*="virtualized-container"]';
const FILTER_ROW = '[class*="productFilter"]';
// Diperiksa DI DALAM JS, bukan lewat selector: `:not()` tidak dipakai di mana
// pun di modul ini, dan menambahkannya hanya untuk ini tidak sepadan.
const MULTI_MARK = "arco-select-multiple";
const TAG_PLACEHOLDER_MARK = "arco-input-tag-has-placeholder";
const STRIP_HEADER_TEXT = "Product list in this LIVE";
const DEFAULT_CATEGORY_TEXT = "All categories";
const DEFAULT_STOCK_TEXT = "All stock";

const SELECTORS = {
  NUMBER_INPUT, ROW_MARKER, TOP_CONTROL, PIN_BUTTON, PRICE_PRIMARY, PRICE_DIM,
  SEARCH_INPUT, COMBOBOX, SELECT_VIEW, TAG_WRAP, CATEGORY_BUTTON, TYPOGRAPHY,
  CHECKBOX_LABEL, VIRTUAL_CONTAINER, FILTER_ROW,
  MULTI_MARK, TAG_PLACEHOLDER_MARK,
  STRIP_HEADER_TEXT, DEFAULT_CATEGORY_TEXT, DEFAULT_STOCK_TEXT,
};

// Kosakata cakupan DIIMPOR, tidak didefinisikan ulang: autopin/catalogue.js
// yang memilikinya, dan dua definisi untuk hal yang sama adalah cara paling
// mudah membuat lapisan pembaca dan penyimpan menyimpang. "unknown" berarti
// barisnya sendiri tidak boleh dipercaya - mis. daftar yang sedang tersaring,
// yang nomor posisinya mungkin sudah dinomori ulang.

// Daftar ter-virtualisasi: hanya sebagian baris ter-render. Gulir bertahap lalu gabungkan.
//
// `until` adalah penghentian dini: dipanggil sesudah setiap gelombang serap
// dengan produk yang SUDAH terkumpul, dan kalau mengembalikan true, penggulirannya
// berhenti di situ.
//
// Kenapa ini ada: pada LIVE 2026-10-06 dengan katalog 20 produk, satu percobaan
// pin menggulir SELURUH katalog DUA KALI - sekali untuk mencari produknya, sekali
// lagi untuk konfirmasi lewat snapshot. Terukur 8 scrollPasses sekali jalan, dan
// gabungannya melewati batas tunggu bot 8 detik:
//
//   [AUTOPIN_FAILED] reason=send-rejected detail=This operation was aborted
//
// padahal service-nya BERHASIL mem-pin dan mengkonfirmasi. Konfirmasi hanya perlu
// menemukan SATU produk, bukan menyusun seluruh daftar, jadi ia boleh berhenti
// begitu produknya ketemu. Bukti yang dibacanya tetap bukti SESUDAH klik - yang
// dipotong hanya penggulirannya, bukan kesegarannya.
// `remaining` adalah anggaran waktu: fungsi yang mengembalikan sisa milidetik.
// Penggulirannya BERHENTI SENDIRI saat waktunya hampir habis - bukan ditinggalkan
// di tengah jalan. Itu bedanya penting: operasi yang ditinggalkan tetap berjalan
// di latar dan bisa tumpang tindih dengan pekerjaan berikutnya, sedangkan yang
// berhenti sendiri selesai rapi dan melaporkan bahwa daftarnya tidak lengkap.
// `sleep` disuntikkan supaya uji anggaran bisa memodelkan waktu tanpa benar-benar
// menunggu: satu koleksi 20 produk memakan ~4,4 detik nyata, dan tes tidak boleh
// membayar itu berkali-kali.
// Verdict cakupan dari SATU pembacaan keadaan. MURNI.
//
// Fail-closed di tiga arah sekaligus: kontrol yang hilang, label yang tidak
// dikenali, dan pilihan yang bukan default semuanya menghalangi "clean". Hanya
// "clean" yang boleh membuka jalan ke coverage="full".
function scopeVerdict(state) {
  const s = state && state.search ? state.search.state : "unknown";
  const f = (state && state.filters) || {};
  const tiga = [
    f.category ? f.category.state : "unknown",
    f.stock ? f.stock.state : "unknown",
    f.activities ? f.activities.state : "unknown",
  ];
  if (s === "non-empty" || tiga.indexOf("non-default") !== -1) return "dirty";
  if (s === "empty" && tiga.every((x) => x === "default")) return "clean";
  return "unknown";
}

// KONTRAK KELENGKAPAN. MURNI, dan inilah satu-satunya tempat coverage diputuskan.
//
// Sebelum ini, pemanggil menyimpulkan "full" dari dua flag negatif. Sekarang
// keputusannya ada di SATU fungsi yang menerima bukti dan tidak bisa menebak:
// tidak ada argumen yang bisa dihilangkan diam-diam, karena yang hilang menjadi
// "unknown", bukan "lolos".
//
// TIGA keadaan, dan bedanya penting:
//
//   full      roster LENGKAP dan tepercaya. Keunikan judul boleh diputuskan.
//   viewport  barisnya TEPERCAYA tapi belum terbukti lengkap. Pertanyaan
//             bernomor eksplisit boleh dijawab; keunikan judul TIDAK.
//   unknown   barisnya sendiri tidak boleh dipercaya - cakupan kotor/tak
//             terbaca, posisi rusak, total goyah, atau container gulir
//             berpindah. Tidak boleh dikutip, tidak boleh disimpan.
//
// DASAR BUKAN BUKTI. LIVE 2026-10-20 menunjukkan scrollHeight berubah
// 1209 -> 1275 saat baris ke-5 dipasang, jadi "scrollTop + clientHeight >=
// scrollHeight" diukur terhadap angka yang masih bergerak. Dasar tetap dipakai
// sebagai alasan BERHENTI, tidak pernah sebagai bukti lengkap.
function decideCoverage(ev) {
  const e = ev || {};
  const alasan = [];
  const tidakPercaya = [];

  // --- integritas: kalau salah satu gagal, barisnya tidak boleh dipercaya ---
  if (e.scopeClean !== true) tidakPercaya.push("scope-" + (e.scopeState || "unknown"));
  if (e.positionsValid !== true) tidakPercaya.push("positions-invalid");
  if (e.scrollerStable !== true) tidakPercaya.push("scroller-unstable");
  if (e.declaredTotalStable !== true) tidakPercaya.push("declared-total-unstable");
  if (e.rowsSane !== true) tidakPercaya.push("rows-malformed");
  // TIDAK ADA saksi "stabilitas terbukti" terpisah di sini, dan itu disengaja.
  //
  // Sejak bukti dilipat ke readProductsInPage, SETIAP pembacaan baris
  // menghasilkan satu cuplikan - jadi "jumlah cuplikan == jumlah pembacaan"
  // selalu benar dan tidak bisa salah. Saksi yang tidak bisa salah adalah saksi
  // yang tidak bisa dibuktikan bekerja: mutasinya tetap hijau.
  //
  // Yang MENGGANTIKANNYA bukan ketiadaan: gelombang yang buktinya tidak terbaca
  // mencatat cuplikan "unknown", dan satu cuplikan unknown sudah membuat
  // scopeClean gagal di atas. Itu jalur yang benar-benar teruji.
  if (e.aborted === true) tidakPercaya.push("aborted-" + (e.abortReason || "unknown"));
  if (tidakPercaya.length) return { coverage: COVERAGE.UNKNOWN, reasons: tidakPercaya };

  // --- kelengkapan: total ADA, dan posisinya membuktikan [1..total] ---
  const total = e.declaredTotal;
  if (!Number.isInteger(total) || total <= 0) {
    alasan.push("declared-total-unavailable");
    return { coverage: COVERAGE.VIEWPORT, reasons: alasan };
  }
  if (e.positionsCoverTotal !== true) {
    // Dasar tercapai TAPI posisi belum lengkap: tetap TIDAK full. Ini jalur
    // yang dulu paling berbahaya - ia terlihat seperti selesai.
    alasan.push(e.bottomReached === true ? "bottom-reached-but-incomplete" : "positions-incomplete");
    return { coverage: COVERAGE.VIEWPORT, reasons: alasan };
  }
  if (e.exhaustedScrolls === true) {
    // Kuota gelombang habis TIDAK PERNAH berarti lengkap. Kalau posisinya
    // ternyata sudah lengkap, yang menentukan adalah posisinya - bukan kuotanya.
    alasan.push("max-scrolls-exhausted");
    return { coverage: COVERAGE.VIEWPORT, reasons: alasan };
  }
  return { coverage: COVERAGE.FULL, reasons: [] };
}

// Apakah himpunan posisi membuktikan [1..total] TEPAT? Bukan panjang array.
function positionsCover(positions, total) {
  if (!Array.isArray(positions) || !Number.isInteger(total) || total <= 0) return false;
  // Tidak ada pemeriksaan "n >= 1 dan bulat" di sini, dan itu disengaja: ia
  // REDUNDAN. Himpunan yang berukuran tepat `total` DAN memuat 1..total tidak
  // mungkin menyimpan nol, negatif, atau pecahan. Pemeriksaan redundan di
  // pembatas keselamatan adalah pembatas yang tidak bisa dibuktikan bekerja -
  // mutasinya tetap hijau. Yang MENOLAK baris bernomor tidak sah adalah
  // absorb() di collectProducts, lewat invalidRows.
  const set = new Set();
  for (const n of positions) set.add(n);
  if (set.size !== total) return false;
  for (let i = 1; i <= total; i += 1) if (!set.has(i)) return false;
  return true;
}

// Sidik jari container gulir: STRUKTURAL, tidak bersandar pada nama kelas
// ber-hash dan tidak membaca gaya terhitung (alasan biayanya ada di
// readProductsInPage). Yang dibandingkan antar gelombang hanya bagian yang
// seharusnya TIDAK berubah; scrollTop/scrollHeight memang berubah saat
// menggulir dan karena itu TIDAK ikut.
function scrollerFingerprint(s) {
  if (!s || s.found !== true) return "";
  return s.depth + "|" + s.tag + "|" + (s.virtualized === true ? "virt" : "plain");
}

async function collectProducts(page, {
  maxScrolls = 14, step = 400, settleMs = 350, until = null, remaining = null,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const byNumber = new Map();
  let invalidRows = 0;
  let passes = 0;
  let livePinButtonsOnPage = 0;
  // Posisi yang BERTENTANGAN: nomor yang sama muncul dengan judul berbeda. Itu
  // bukan duplikat yang tak berbahaya - ia berarti nomor posisi tidak bisa
  // dipakai sebagai identitas pada pembacaan ini.
  let contradictoryPositions = 0;

  const absorb = (batch) => {
    // Bukti diserap DI SINI, di satu tempat yang sama dengan barisnya: pembacaan
    // baris tanpa penyerapan bukti adalah gelombang yang stabilitasnya tidak
    // terperiksa, dan itu tidak boleh bisa terjadi karena lupa.
    serapBukti(batch);
    livePinButtonsOnPage = Math.max(livePinButtonsOnPage, batch.livePinButtonsOnPage || 0);
    for (const p of batch.products) {
      // Nomor posisi harus bilangan bulat POSITIF. `null` sudah ditolak sejak
      // awal; yang baru di sini adalah menolak 0, negatif, dan non-integer.
      if (p.rowInputs !== 1 || p.number === null || !Number.isInteger(p.number) || p.number < 1) {
        invalidRows += 1;
        continue;
      }
      const prev = byNumber.get(p.number);
      if (prev && prev.title && p.title && prev.title !== p.title) contradictoryPositions += 1;
      // Field harga ditambahkan DI SINI, satu kali, supaya setiap pemakai
      // collectProducts (jalur pin, discovery Controller, konfirmasi pin)
      // melihat bentuk produk yang sama. `price` dan `stock` lama tidak
      // disentuh.
      if (!prev || (!prev.title && p.title)) byNumber.set(p.number, withPriceFields(p));
    }
  };

  await page.evaluate(resetScrollInPage, SELECTORS);
  await sleep(settleMs);

  // --- BUKTI, MENUMPANG pada pembacaan yang sudah terjadi ---
  //
  // NOL perjalanan bolak-balik tambahan. readProductsInPage mengembalikan
  // catalogueEvidence dari evaluate yang SAMA yang mengembalikan barisnya, dan
  // pembacaan itu memang sudah terjadi sekali di awal lalu sesudah setiap
  // gelombang gulir. Jadi setiap gelombang ikut menjadi cuplikan bukti.
  //
  // Ini menggantikan cuplikan awal+akhir yang sempat dipakai. Alasannya bukan
  // kerapian: cuplikan dua ujung tidak bisa melihat perubahan yang terjadi DI
  // ANTARA gelombang, sementara versi ini bisa - dan harganya nol.
  const scopeSamples = [];
  const totalSamples = [];
  const scrollerSamples = [];
  let scrollerAkhir = null;
  const serapBukti = (batch) => {
    const ev = batch && batch.catalogueEvidence;
    // Bukti yang HILANG bukan bukti yang lolos: ia dicatat sebagai cuplikan
    // yang tidak terbaca, dan cuplikan seperti itu tidak akan pernah "clean".
    if (!ev) {
      scopeSamples.push("unknown");
      totalSamples.push(null);
      scrollerSamples.push("");
      return;
    }
    scopeSamples.push(scopeVerdict(ev));
    totalSamples.push(ev.strip && ev.strip.state === "ok" ? ev.strip.declaredTotal : null);
    scrollerSamples.push(scrollerFingerprint(ev.scroller));
    scrollerAkhir = ev.scroller || null;
  };

  const sorted = () => [...byNumber.values()].sort((a, b) => a.number - b.number);
  const satisfied = () => {
    if (typeof until !== "function") return false;
    try {
      return until(sorted()) === true;
    } catch (e) {
      // Predikat yang rusak tidak boleh menghentikan koleksi lebih awal.
      return false;
    }
  };

  const first = await page.evaluate(readProductsInPage, SELECTORS);
  absorb(first);
  passes += 1;

  // Satu gelombang berikutnya butuh sekitar: gulir + settle + baca.
  const outOfTime = () =>
    typeof remaining === "function" && remaining() <= settleMs;

  // Total yang diumumkan halaman, dipakai sebagai syarat berhenti dini: begitu
  // [1..total] terbukti terlihat, tidak ada alasan menggulir lagi. Pada LIVE
  // 2026-10-20 ini berhenti sesudah SATU gelombang 400px - 205px sebelum dasar.
  // null, bukan undefined: "tidak ada cuplikan" dan "cuplikan yang totalnya
  // tidak terbaca" harus terlihat sama bagi pemanggil.
  const totalAwal = totalSamples.length ? totalSamples[0] : null;
  const posisiLengkap = () => positionsCover([...byNumber.keys()], totalAwal);

  let ranOutOfTime = false;
  let exhaustedScrolls = false;
  let bottomReached = false;
  let scrollStopReason = "";
  let stoppedEarly = satisfied();
  if (!stoppedEarly && !posisiLengkap()) {
    for (let i = 0; i < maxScrolls; i += 1) {
      if (outOfTime()) {
        ranOutOfTime = true;
        scrollStopReason = "out-of-time";
        break;
      }
      const s = await page.evaluate(scrollProductListInPage, SELECTORS, step);
      if (!s.scrolled) {
        scrollStopReason = s && s.reason ? s.reason : "scroll-ineffective";
        break;
      }
      await sleep(settleMs);
      absorb(await page.evaluate(readProductsInPage, SELECTORS));
      passes += 1;
      if (satisfied()) {
        stoppedEarly = true;
        scrollStopReason = "until-satisfied";
        break;
      }
      if (posisiLengkap()) {
        scrollStopReason = "positions-complete";
        break;
      }
      if (i === maxScrolls - 1) {
        exhaustedScrolls = true;
        scrollStopReason = "max-scrolls";
      }
    }
  } else if (posisiLengkap()) {
    scrollStopReason = "positions-complete-at-start";
  }

  // Cuplikan AKHIR. Dasar dihitung DI SINI, dari geometri yang baru dibaca -
  // bukan dari scrollHeight yang sudah basi. LIVE 2026-10-20 menunjukkan
  // scrollHeight tumbuh 1209 -> 1275 selagi baris dipasang, jadi angka yang
  // dipakai harus angka terbaru, dan hasilnya tetap hanya ALASAN BERHENTI.
  if (scrollerAkhir && scrollerAkhir.found === true) {
    bottomReached = scrollerAkhir.scrollTop + scrollerAkhir.clientHeight >= scrollerAkhir.scrollHeight - 2;
  }

  const posisi = [...byNumber.keys()];
  const adaCuplikan = scopeSamples.length > 0;
  const scopeState = !adaCuplikan
    ? "unknown"
    : (scopeSamples.every((x) => x === "clean")
      ? "clean"
      : (scopeSamples.indexOf("dirty") !== -1 ? "dirty" : "unknown"));
  const declaredTotalStable = adaCuplikan && totalSamples.every((t) => t === totalAwal);
  const scrollerStable = adaCuplikan && scrollerSamples[0] !== "" && scrollerSamples.every((f) => f === scrollerSamples[0]);
  // Dicatat untuk log dukungan, BUKAN dipakai sebagai saksi: lihat alasannya di
  // decideCoverage. Kalau angka ini pernah tidak sama dengan `passes`, ada
  // pembacaan baris yang tidak menyerap buktinya - dan itu bug kami, bukan
  // keadaan halaman.
  const rowsSane = invalidRows === 0 && contradictoryPositions === 0 && byNumber.size > 0;

  const verdict = decideCoverage({
    scopeClean: scopeState === "clean",
    scopeState,
    declaredTotal: totalAwal,
    declaredTotalStable,
    positionsValid: rowsSane,
    positionsCoverTotal: positionsCover(posisi, totalAwal),
    scrollerStable,
    rowsSane,
    exhaustedScrolls,
    bottomReached,
    aborted: ranOutOfTime === true,
    abortReason: ranOutOfTime ? "out-of-time" : "",
  });

  return {
    products: sorted(),
    invalidRows,
    passes,
    // --- BUKTI KELENGKAPAN ---
    // coverage DIPUTUSKAN DI SINI, bukan disimpulkan oleh pemanggil. Sebelum
    // ini, autopin/service.js menyimpulkannya dari dua flag negatif, dan
    // kesimpulan itu terbukti salah pada tiga jalan keluar yang berbeda.
    coverage: verdict.coverage,
    coverageReasons: verdict.reasons,
    completeness: {
      scope: scopeState,
      scopeSamples: scopeSamples.slice(),
      declaredTotal: totalAwal,
      declaredTotalStable,
      positions: posisi.slice().sort((a, b) => a - b),
      positionsCoverTotal: positionsCover(posisi, totalAwal),
      contradictoryPositions,
      scrollerStable,
      evidenceSamples: scopeSamples.length,
      scrollerFingerprint: scrollerSamples[0] || "",
      exhaustedScrolls,
      bottomReached,
      scrollStopReason,
      rowsSane,
    },
    // true berarti penggulirannya DIPOTONG: daftarnya sengaja tidak lengkap.
    // Pemanggil tidak boleh memakai hasil ini untuk menyimpulkan "produk tidak ada".
    stoppedEarly,
    // true berarti dipotong karena ANGGARAN WAKTU, bukan karena ketemu.
    // Resolusi produk TIDAK BOLEH memakai daftar seperti ini: produk kedua yang
    // cocok bisa belum terlihat, dan "ambigu, jangan klik" berubah diam-diam
    // menjadi "klik yang pertama ketemu".
    ranOutOfTime,
    numberInputsOnPage: first.numberInputsOnPage,
    livePinButtonsOnPage,
  };
}

// Pembacaan SATU LINTASAN, tanpa menggulir sama sekali.
//
// Bedanya dengan collectProducts bukan cuma kecepatan: collectProducts memanggil
// resetScrollInPage lalu menggulir sampai 14 gelombang, jadi ia MENGGESER posisi
// gulir halaman — di tengah run itu halaman yang sama dengan jalur pin. Fungsi
// ini tidak menyentuh posisi gulir, dan karena itu hanya melihat baris yang
// kebetulan ter-render.
//
// Konsekuensinya harus dibawa oleh pemanggil: daftar dari sini TIDAK LENGKAP,
// dan ketidakhadiran sebuah produk di dalamnya BUKAN bukti produk itu tidak ada.
// Itulah sebabnya hasilnya ditandai coverage="viewport", bukan "full".
async function readProductsOnce(page) {
  const batch = await page.evaluate(readProductsInPage, SELECTORS);
  const products = [];
  let invalidRows = 0;
  for (const p of batch.products) {
    if (p.rowInputs !== 1 || p.number === null) {
      invalidRows += 1;
      continue;
    }
    products.push(withPriceFields(p));
  }
  products.sort((a, b) => a.number - b.number);
  return {
    products,
    invalidRows,
    passes: 1,
    coverage: "viewport",
    numberInputsOnPage: batch.numberInputsOnPage,
    livePinButtonsOnPage: batch.livePinButtonsOnPage || 0,
  };
}

async function readIdentity(page) {
  return page.evaluate(readIdentityInPage);
}

// Gulir sampai baris target ter-render, lalu jalankan resolusi+klik atomik.
//
// Ini juga tahap yang BISA LAMBAT: pada katalog besar ia menggulir sampai
// maxScrolls kali sebelum barisnya ter-render. Jadi ia ikut menerima anggaran
// waktu. Memotongnya aman: kalau barisnya belum ter-render, hasilnya
// row-not-rendered dan TIDAK ADA klik - gagal yang aman, bukan klik ngawur.
async function pinProductByTitle(page, titleKey, {
  dryRun, maxScrolls = 14, step = 400, settleMs = 350, remaining = null,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const outOfTime = () => typeof remaining === "function" && remaining() <= settleMs;

  await page.evaluate(resetScrollInPage, SELECTORS);
  await sleep(settleMs);

  for (let i = 0; i <= maxScrolls; i += 1) {
    const res = await page.evaluate(pinProductInPage, SELECTORS, { titleKey, dryRun });
    if (res.ok || res.reason !== "row-not-rendered") return { ...res, scrollSteps: i };
    if (outOfTime()) return { ok: false, reason: "row-not-rendered-budget", scrollSteps: i };
    const s = await page.evaluate(scrollProductListInPage, SELECTORS, step);
    if (!s.scrolled) break;
    await sleep(settleMs);
  }
  return { ok: false, reason: "row-not-found-after-scroll" };
}

async function readPinState(page, titleKey) {
  return page.evaluate(readPinStateInPage, SELECTORS, { titleKey });
}

function summarize(products) {
  return products.map((p) => ({
    number: p.number,
    title: p.title,
    controls: p.topControls,
    pinButtons: p.pinButtons,
    pinText: p.pinText || "",
    pinDisabled: String(p.pinDisabled),
    icons: (p.icons || []).join(","),
    aria: (p.ariaOnRow || []).join(","),
    badges: (p.badges || []).join(","),
  }));
}

// Dibandingkan BERDASARKAN JUDUL, karena nomor posisi bisa bergeser.
function diffSnapshots(before, after) {
  const b = new Map(summarize(before).map((p) => [p.title, p]));
  const a = new Map(summarize(after).map((p) => [p.title, p]));
  const moved = [];
  const changed = [];
  for (const [k, av] of a) {
    const bv = b.get(k);
    if (!bv) continue;
    if (bv.number !== av.number) moved.push({ title: k, from: bv.number, to: av.number });
    const fields = ["controls", "pinButtons", "pinText", "pinDisabled", "icons", "aria", "badges"]
      .filter((f) => bv[f] !== av[f])
      .map((f) => `${f}:${bv[f]}->${av[f]}`);
    if (fields.length) changed.push({ title: k, fields: fields.join(" ") });
  }
  return {
    moved,
    changed,
    onlyBefore: [...b.keys()].filter((k) => !a.has(k)),
    onlyAfter: [...a.keys()].filter((k) => !b.has(k)),
  };
}

module.exports = {
  SELECTORS,
  COVERAGE,
  scopeVerdict,
  decideCoverage,
  positionsCover,
  scrollerFingerprint,
  PIN_BUTTON,
  TOP_CONTROL,
  PRICE_PRIMARY,
  PRICE_DIM,
  collectProducts,
  readProductsOnce,
  readIdentity,
  pinProductByTitle,
  readPinState,
  summarize,
  diffSnapshots,
  readProductsInPage,
  readIdentityInPage,
  scrollProductListInPage,
  resetScrollInPage,
  pinProductInPage,
  readPinStateInPage,
};
