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

const NUMBER_INPUT = 'input[data-tid="m4b_input_number"]';
const ROW_MARKER = '[class*="stock-and-pin-button"]';
const TOP_CONTROL = ".pc_top_product"; // diagnostik saja — jangan diklik
const PIN_BUTTON = 'button[data-pin-performance-source="product_card"]';

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
    const priceEl = row.querySelector('[class*="text-body-l-medium"]');
    const stockEl = row.querySelector('[class*="stock-and-ask-to-show"]');
    const img = row.querySelector("img[src]");

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

  return {
    products,
    markers: rows.length,
    numberInputsOnPage: document.querySelectorAll(sel.NUMBER_INPUT).length,
    // bukti kontrol pin LIVE ada di halaman sama sekali
    livePinButtonsOnPage: document.querySelectorAll(sel.PIN_BUTTON).length,
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

const SELECTORS = { NUMBER_INPUT, ROW_MARKER, TOP_CONTROL, PIN_BUTTON };

// Daftar ter-virtualisasi: hanya sebagian baris ter-render. Gulir bertahap lalu gabungkan.
async function collectProducts(page, { maxScrolls = 14, step = 400, settleMs = 350 } = {}) {
  const byNumber = new Map();
  let invalidRows = 0;
  let passes = 0;
  let livePinButtonsOnPage = 0;

  const absorb = (batch) => {
    livePinButtonsOnPage = Math.max(livePinButtonsOnPage, batch.livePinButtonsOnPage || 0);
    for (const p of batch.products) {
      if (p.rowInputs !== 1 || p.number === null) {
        invalidRows += 1;
        continue;
      }
      const prev = byNumber.get(p.number);
      if (!prev || (!prev.title && p.title)) byNumber.set(p.number, p);
    }
  };

  await page.evaluate(resetScrollInPage, SELECTORS);
  await new Promise((r) => setTimeout(r, settleMs));

  const first = await page.evaluate(readProductsInPage, SELECTORS);
  absorb(first);
  passes += 1;

  for (let i = 0; i < maxScrolls; i += 1) {
    const s = await page.evaluate(scrollProductListInPage, SELECTORS, step);
    if (!s.scrolled) break;
    await new Promise((r) => setTimeout(r, settleMs));
    absorb(await page.evaluate(readProductsInPage, SELECTORS));
    passes += 1;
  }

  return {
    products: [...byNumber.values()].sort((a, b) => a.number - b.number),
    invalidRows,
    passes,
    numberInputsOnPage: first.numberInputsOnPage,
    livePinButtonsOnPage,
  };
}

async function readIdentity(page) {
  return page.evaluate(readIdentityInPage);
}

// Gulir sampai baris target ter-render, lalu jalankan resolusi+klik atomik.
async function pinProductByTitle(page, titleKey, { dryRun, maxScrolls = 14, step = 400, settleMs = 350 } = {}) {
  await page.evaluate(resetScrollInPage, SELECTORS);
  await new Promise((r) => setTimeout(r, settleMs));

  for (let i = 0; i <= maxScrolls; i += 1) {
    const res = await page.evaluate(pinProductInPage, SELECTORS, { titleKey, dryRun });
    if (res.ok || res.reason !== "row-not-rendered") return { ...res, scrollSteps: i };
    const s = await page.evaluate(scrollProductListInPage, SELECTORS, step);
    if (!s.scrolled) break;
    await new Promise((r) => setTimeout(r, settleMs));
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
  PIN_BUTTON,
  TOP_CONTROL,
  collectProducts,
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
