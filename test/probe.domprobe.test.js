"use strict";
// Tes probe DOM read-only (scripts/probe/). Tanpa browser, tanpa jaringan.
//
// Fixture-nya DITRANSKRIP dari DOM nyata di arsip .autopin-debug
// (2026-10-06T10-12-30, LIVE katalog 20 produk) - kelas, data-tid, dan
// susunan bersarangnya sama. Itu disengaja: fake yang mengarang bentuk pernah
// meloloskan tiga bug di repo ini, jadi yang diuji di sini harus bentuk yang
// MEMANG pernah terlihat, bukan bentuk yang nyaman untuk tesnya.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { el, withDocument } = require("./fake-dom");
const probe = require("../scripts/probe/dom-probe-page");
const { evaluateSafety, chromePidsUsingProfile } = require("../scripts/probe/probe-guards");

const SEL = probe.SEL;
const ROOT = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// pembangun fixture
// ---------------------------------------------------------------------------

const thumbnail = () =>
  el({
    tag: "span",
    attrs: { class: "sc-eldPxv jBQDpb w-39 h-39 mr-4 border-neutral-line1 rounded-8" },
    kids: [el({ tag: "img", attrs: { class: "sc-eDPEul imhSto rounded-8" } })],
  });

const badgeSlot = (text) =>
  el({
    attrs: { class: "flex items-center justify-center inline-block w-39 h-39 mr-4 rounded-8" },
    kids: [el({ tag: "span", text })],
  });

function strip({ thumbs = 4, badge = "+16", header = true, extraBadge = null } = {}) {
  const kids = [];
  for (let i = 0; i < thumbs; i += 1) kids.push(thumbnail());
  if (badge !== null) kids.push(badgeSlot(badge));
  if (extraBadge !== null) kids.push(badgeSlot(extraBadge));
  const thumbRow = el({ attrs: { class: "flex items-center" }, kids });
  const body = el({
    attrs: { class: "flex justify-between items-center" },
    kids: [thumbRow, el({ attrs: { class: "flex items-center" } })],
  });
  const inner = [];
  if (header) {
    inner.push(el({ attrs: { class: "text-neutral-text1 mb-8 text-body-m-medium" }, text: "Product list in this LIVE" }));
  }
  inner.push(body);
  return el({ attrs: { class: "mb-8 rounded-8 py-12 pl-12 pr-10" }, kids: inner });
}

function searchBox(spec = {}) {
  const attrs = {
    "data-tid": "m4b_input_search",
    placeholder: "Search product ID or product name",
    class: "arco-input arco-input-size-default",
  };
  const extra = {};
  if (spec.valueThrows) extra.valueThrows = true;
  else if (spec.value !== undefined) extra.value = spec.value;
  return el({ tag: "input", attrs, ...extra });
}

function searchArea(spec) {
  if (spec === null) return el({ attrs: { class: "flex-shrink inline-flex items-center w-full" } });
  return el({
    attrs: { class: "flex-shrink inline-flex items-center w-full" },
    kids: [
      el({
        attrs: { class: "w-full" },
        kids: [
          el({
            attrs: { class: "arco-input-group-wrapper arco-input-has-suffix" },
            kids: [el({ tag: "span", attrs: { class: "arco-input-group" }, kids: [el({ tag: "span", attrs: { class: "arco-input-inner-wrapper arco-input-clear-wrapper" }, kids: [searchBox(spec)] })] })],
          }),
        ],
      }),
    ],
  });
}

function categoryButton(text) {
  const inner = text === null ? [] : [el({ attrs: { class: "arco-typography" }, text })];
  return el({
    tag: "button",
    attrs: { "data-tid": "m4b_button", "data-e2e": "9ed553d9-3ba8-d083", class: "arco-btn arco-btn-secondary" },
    kids: [
      el({
        attrs: { class: "w-full flex justify-between items-center" },
        kids: [el({ attrs: { class: "flex items-center mr-12 flex-1" }, kids: [el({ attrs: { class: "flex flex-1 justify-start" }, kids: inner })] })],
      }),
    ],
  });
}

// arco-select TUNGGAL: nilai terpilih ada di title view
function stockSelect(title) {
  const viewAttrs = title === null ? { class: "arco-select-view" } : { title, class: "arco-select-view" };
  return el({
    attrs: { role: "combobox", "aria-haspopup": "listbox", class: "arco-select arco-select-size-default" },
    kids: [el({ attrs: viewAttrs, kids: [el({ tag: "span", attrs: { class: "arco-select-view-value" }, text: title === null ? "" : title })] })],
  });
}

// arco-select-multiple: default = title "" + kelas arco-input-tag-has-placeholder
function activitiesSelect({ title = "", placeholder = true } = {}) {
  const tagCls = "arco-input-tag arco-input-tag-size-mini" + (placeholder ? " arco-input-tag-has-placeholder" : "");
  return el({
    attrs: { role: "combobox", "aria-haspopup": "listbox", class: "arco-select arco-select-multiple" },
    kids: [
      el({
        attrs: { title, class: "arco-select-view" },
        kids: [el({ attrs: { class: tagCls }, kids: [el({ tag: "input", attrs: { placeholder: "All activities", class: "arco-input-tag-input" } })] })],
      }),
    ],
  });
}

function filterRow(spec = {}) {
  const kids = [];
  if (spec.selectAll !== null) {
    kids.push(
      el({
        tag: "label",
        attrs: { "data-tid": "m4b_checkbox", class: "arco-checkbox m4b-checkbox" },
        kids: [el({ tag: "input", attrs: { type: "checkbox" }, checked: spec.selectAllChecked === true })],
      })
    );
  }
  if (spec.category !== undefined) kids.push(categoryButton(spec.category));
  else kids.push(categoryButton("All categories"));
  if (spec.stock !== null) kids.push(stockSelect(spec.stock === undefined ? "All stock" : spec.stock));
  if (spec.activities !== null) kids.push(activitiesSelect(spec.activities || {}));
  return el({ attrs: { class: "w-full flex items-center text-neu h-44 index-module__productFilter--Mq+Zx" }, kids });
}

// Satu baris produk. Judul dan harga DISERTAKAN dengan sengaja: tes privasi di
// bawah membuktikan bahwa keduanya TIDAK PERNAH keluar dari probe.
function productRow(n, title, price) {
  return el({
    attrs: { class: "rounded-4 mb-8" },
    kids: [
      el({
        attrs: { class: "flex flex-col flex-1 overflow-hidden" },
        overflowY: "hidden",
        scrollHeight: 40,
        clientHeight: 40,
        kids: [
          el({ tag: "input", attrs: { "data-tid": "m4b_input_number", "aria-valuenow": String(n) } }),
          el({ attrs: { class: "stock-and-pin-button-wrapper flex" } }),
          el({ attrs: { class: "overflow-ellipsis" }, kids: [el({ tag: "span", text: title })] }),
          el({ tag: "span", attrs: { class: "text-body-l-medium" }, text: price }),
          el({ tag: "button", attrs: { "data-pin-performance-source": "product_card" }, text: "Pin" }),
        ],
      }),
    ],
  });
}

// Dashboard lengkap. Rantai leluhurnya meniru arsip: satu pane ber-overflow-auto
// di luar, lalu beberapa pembungkus overflow-hidden, lalu virtualized-container.
function dashboard(spec = {}) {
  const rows = [];
  const titles = spec.titles || ["Garuda Kacang ATOM 16gr"];
  const prices = spec.prices || ["Rp14.299"];
  const n = spec.rows === undefined ? 1 : spec.rows;
  for (let i = 0; i < n; i += 1) rows.push(productRow(i + 1, titles[i % titles.length], prices[i % prices.length]));

  const head = [];
  if (spec.search !== null) head.push(searchArea(spec.search === undefined ? { value: "" } : spec.search));
  if (spec.filters !== null) head.push(filterRow(spec.filters || {}));
  if (spec.strip !== null) head.push(strip(spec.strip || {}));

  const common = el({ kids: [el({ kids: head }), el({ attrs: { class: "list-area" }, kids: rows })] });
  const virtualized = el({ attrs: { class: "index-module__virtualized-container--nn7XK" }, kids: [common] });
  const spinKids = el({ attrs: { class: "arco-spin-children" }, kids: [virtualized] });
  const spin = el({ attrs: { "data-tid": "m4b_loading", class: "arco-spin m4b-loading" }, kids: [spinKids] });

  // Pembungkus yang MELUAP tapi TIDAK bisa digulir. Inilah yang akan dipilih
  // heuristik produksi (scrollHeight > clientHeight + 10) walau menggulirnya
  // tidak akan pernah memunculkan baris baru.
  const panel = el({
    attrs: { class: "flex-1 flex h-full overflow-hidden rounded-8 styles-module__container-xyz" },
    overflowY: spec.panelOverflowY === undefined ? "hidden" : spec.panelOverflowY,
    scrollHeight: 4000,
    clientHeight: 880,
    kids: [spin],
  });

  // Scroller SUNGGUHAN: satu-satunya overflow-auto di rantai.
  const appPane = el({
    attrs: { class: "flex flex-col m-auto bg-neutral-bg2 min-h-full overflow-auto" },
    overflowY: "auto",
    scrollHeight: 5000,
    clientHeight: 900,
    scrollTop: 0,
    kids: [panel],
  });

  return el({ attrs: { class: "body-root" }, kids: [appPane] });
}

const readAll = (root) =>
  withDocument(root, () => {
    const search = probe.readSearchInPage(SEL);
    const filters = probe.readFiltersInPage(SEL);
    return {
      strip: probe.readStripInPage(SEL),
      rows: probe.readRowsInPage(SEL),
      search,
      filters,
      geometry: probe.readScrollAncestorsInPage(SEL),
      scope: probe.scopeVerdict({ search, filters }),
    };
  });

// ---------------------------------------------------------------------------
// A. strip ringkasan -> kandidat total
// ---------------------------------------------------------------------------

test("strip: 4 thumbnail + badge +16 => kandidat total 20", () => {
  const r = readAll(dashboard({ strip: { thumbs: 4, badge: "+16" } }));
  assert.equal(r.strip.state, "ok");
  assert.equal(r.strip.thumbnails, 4);
  assert.equal(r.strip.badgeValue, 16);
  assert.equal(r.strip.candidateTotal, 20);
  assert.deepEqual(r.strip.anchors, { header: true, badge: true });
});

test("strip: 3 thumbnail tanpa badge => kandidat total 3 (katalog kecil, seperti arsip 2026-10-03)", () => {
  const r = readAll(dashboard({ strip: { thumbs: 3, badge: null } }));
  assert.equal(r.strip.state, "ok");
  assert.equal(r.strip.badgePresent, false);
  assert.equal(r.strip.candidateTotal, 3);
});

test("strip: TIDAK ADA => absent, dan tidak ada kandidat total sama sekali", () => {
  const r = readAll(dashboard({ strip: null }));
  assert.equal(r.strip.state, "absent");
  assert.equal(r.strip.present, false);
  assert.equal(r.strip.candidateTotal, undefined);
  assert.deepEqual(r.strip.anchors, { header: false, badge: false });
});

// Yang paling penting di antara tes strip: badge yang teksnya tidak terbaca
// TIDAK BOLEH diam-diam jadi "tidak ada badge" lalu melaporkan total = jumlah
// thumbnail. Itu salah hitung yang terlihat seperti jawaban sah.
for (const bad of ["16", "+", "+1 6", "~16", "+16a", ""]) {
  test("strip: badge rusak " + JSON.stringify(bad) + " => malformed, BUKAN total 4", () => {
    const r = readAll(dashboard({ strip: { thumbs: 4, badge: bad } }));
    assert.equal(r.strip.state, "malformed");
    assert.equal(r.strip.candidateTotal, undefined);
    assert.equal(r.strip.reason, "badge-unparsed");
  });
}

test("strip: dua slot badge => malformed", () => {
  const r = readAll(dashboard({ strip: { thumbs: 4, badge: "+16", extraBadge: "+9" } }));
  assert.equal(r.strip.state, "malformed");
  assert.equal(r.strip.reason, "multiple-badge-slots");
  assert.equal(r.strip.badgeCount, 2);
  assert.equal(r.strip.candidateTotal, undefined);
});

test("strip: header hilang tapi badge ada => masih terbaca lewat anchor badge", () => {
  const r = readAll(dashboard({ strip: { thumbs: 4, badge: "+16", header: false } }));
  assert.equal(r.strip.anchors.header, false);
  assert.equal(r.strip.anchors.badge, true);
  assert.equal(r.strip.candidateTotal, 20);
});

// ---------------------------------------------------------------------------
// B. baris produk
// ---------------------------------------------------------------------------

test("baris: hitungan, nomor unik, dan container virtualisasi terbaca", () => {
  const r = readAll(dashboard({ rows: 6, titles: ["A", "B", "C", "D", "E", "F"], prices: ["Rp1"] }));
  assert.equal(r.rows.rowMarkers, 6);
  assert.equal(r.rows.numberInputs, 6);
  assert.equal(r.rows.uniqueNumbers, 6);
  assert.deepEqual(r.rows.numbers, [1, 2, 3, 4, 5, 6]);
  assert.equal(r.rows.numbersContiguousFromOne, true);
  assert.equal(r.rows.initialized, true);
  assert.equal(r.rows.livePinControls, true);
  assert.equal(r.rows.virtualizedContainer.found, true);
  assert.match(r.rows.virtualizedContainer.className, /virtualized-container/);
});

test("baris: 6 ter-render dengan kandidat total 20 => BUKAN lengkap (virtualisasi, seperti LIVE 2026-10-06)", () => {
  const r = readAll(dashboard({ rows: 6, strip: { thumbs: 4, badge: "+16" }, titles: ["A"], prices: ["Rp1"] }));
  assert.equal(r.rows.rowMarkers, 6);
  assert.equal(r.strip.candidateTotal, 20);
  assert.ok(r.rows.rowMarkers < r.strip.candidateTotal, "harus terbaca sebagai TIDAK lengkap");
});

test("baris: marker tanpa input nomor => initialized=false (halaman masih merender)", () => {
  const root = dashboard({ rows: 2, titles: ["A"], prices: ["Rp1"] });
  const extra = el({ attrs: { class: "stock-and-pin-button-wrapper flex" } });
  const listArea = withDocument(root, () => document.querySelector(".list-area"));
  extra.parentElement = listArea;
  listArea._kids.push(extra);
  const r = readAll(root);
  assert.equal(r.rows.rowMarkers, 3);
  assert.equal(r.rows.numberInputs, 2);
  assert.equal(r.rows.initialized, false);
});

// ---------------------------------------------------------------------------
// C. pencarian - tanpa pernah membocorkan teksnya
// ---------------------------------------------------------------------------

test("pencarian: kosong terdeteksi sebagai empty", () => {
  const r = readAll(dashboard({ search: { value: "" } }));
  assert.deepEqual(r.search, { found: true, state: "empty", reason: "" });
});

test("pencarian: spasi saja tetap empty", () => {
  const r = readAll(dashboard({ search: { value: "   " } }));
  assert.equal(r.search.state, "empty");
});

test("pencarian: terisi terdeteksi non-empty, dan TEKSNYA tidak ikut keluar", () => {
  const rahasia = "kacang atom rahasia";
  const r = readAll(dashboard({ search: { value: rahasia } }));
  assert.equal(r.search.state, "non-empty");
  const dump = JSON.stringify(r.search);
  assert.ok(!dump.includes(rahasia), "teks pencarian tidak boleh ada di hasil");
  assert.ok(!dump.includes(String(rahasia.length)), "panjang teks pun tidak dilaporkan");
});

test("pencarian: kontrol tidak ada => unknown, bukan empty", () => {
  const r = readAll(dashboard({ search: null }));
  assert.deepEqual(r.search, { found: false, state: "unknown", reason: "control-missing" });
});

test("pencarian: value melempar => unknown, bukan empty", () => {
  const r = readAll(dashboard({ search: { valueThrows: true } }));
  assert.deepEqual(r.search, { found: true, state: "unknown", reason: "value-threw" });
});

test("pencarian: tanpa properti value => unknown", () => {
  const r = readAll(dashboard({ search: {} }));
  assert.equal(r.search.state, "unknown");
  assert.equal(r.search.reason, "value-not-string");
});

// ---------------------------------------------------------------------------
// D. filter - tiga kontrol, tiga konvensi
// ---------------------------------------------------------------------------

test("filter: ketiganya default => scope clean", () => {
  const r = readAll(dashboard());
  assert.equal(r.filters.category.state, "default");
  assert.equal(r.filters.category.basis, "label");
  assert.equal(r.filters.stock.state, "default");
  assert.equal(r.filters.stock.basis, "label");
  assert.equal(r.filters.activities.state, "default");
  assert.equal(r.filters.activities.basis, "structural");
  assert.equal(r.filters.comboboxCount, 2);
  assert.equal(r.scope, "clean");
});

test("filter: activities punya pilihan => non-default dan scope dirty", () => {
  const r = readAll(dashboard({ filters: { activities: { title: "Promo", placeholder: false } } }));
  assert.equal(r.filters.activities.state, "non-default");
  assert.equal(r.filters.activities.reason, "has-selection");
  assert.equal(r.scope, "dirty");
});

test("filter: kategori tak dikenal => UNKNOWN (bukan non-default), dan namanya tidak ikut keluar", () => {
  const r = readAll(dashboard({ filters: { category: "Snack Premium" } }));
  assert.equal(r.filters.category.state, "unknown");
  assert.equal(r.filters.category.reason, "text-not-recognised");
  assert.ok(!JSON.stringify(r.filters).includes("Snack Premium"), "nama kategori tidak boleh keluar");
  assert.equal(r.scope, "unknown");
});

test("filter: stock bukan sentinel => unknown, dan nilainya tidak ikut keluar", () => {
  const r = readAll(dashboard({ filters: { stock: "Out of stock" } }));
  assert.equal(r.filters.stock.state, "unknown");
  assert.equal(r.filters.stock.reason, "title-not-recognised");
  assert.ok(!JSON.stringify(r.filters).includes("Out of stock"));
  assert.equal(r.scope, "unknown");
});

test("filter: title kosong pada select TUNGGAL => unknown (bukan default)", () => {
  const r = readAll(dashboard({ filters: { stock: "" } }));
  assert.equal(r.filters.stock.state, "unknown");
  assert.equal(r.filters.stock.reason, "title-empty");
});

test("filter: activities title kosong TANPA kelas placeholder => unknown", () => {
  const r = readAll(dashboard({ filters: { activities: { title: "", placeholder: false } } }));
  assert.equal(r.filters.activities.state, "unknown");
  assert.equal(r.filters.activities.reason, "empty-title-no-placeholder");
});

test("filter: baris filter hilang seluruhnya => semua unknown, scope unknown", () => {
  const r = readAll(dashboard({ filters: null }));
  assert.equal(r.filters.filterRow.found, false);
  assert.equal(r.filters.category.state, "unknown");
  assert.equal(r.scope, "unknown");
});

test("filter: checkbox All dilaporkan sebagai fakta, TIDAK ikut menentukan scope", () => {
  const r = readAll(dashboard({ filters: { selectAllChecked: true } }));
  assert.deepEqual(r.filters.selectAll, { found: true, checked: true });
  assert.equal(r.scope, "clean", "checkbox tercentang tidak boleh mengotori scope");
});

test("scope: hanya 'clean' yang boleh lolos - pencarian terisi mengalahkan filter default", () => {
  const r = readAll(dashboard({ search: { value: "atom" } }));
  assert.equal(r.scope, "dirty");
});

// ---------------------------------------------------------------------------
// E. geometri - banyak kandidat, dan heuristik produksi bisa salah pilih
// ---------------------------------------------------------------------------

test("geometri: semua leluhur dilaporkan dengan scrollTop/scrollHeight/clientHeight/overflow-y", () => {
  const r = readAll(dashboard({ rows: 2, titles: ["A"], prices: ["Rp1"] }));
  assert.equal(r.geometry.rowFound, true);
  assert.ok(r.geometry.ancestors.length >= 8, "rantainya harus utuh sampai akar");
  for (const a of r.geometry.ancestors) {
    for (const k of ["depth", "tag", "scrollTop", "scrollHeight", "clientHeight", "overflowY", "overflows", "scrollable"]) {
      assert.ok(Object.prototype.hasOwnProperty.call(a, k), "field " + k + " wajib ada");
    }
  }
  assert.equal(r.geometry.ancestors[0].depth, 0);
  assert.ok(r.geometry.ancestors.some((a) => a.isVirtualizedContainer), "container virtualisasi harus ditandai");
});

test("geometri: heuristik produksi memilih pembungkus yang MELUAP TAPI TIDAK BISA DIGULIR", () => {
  const r = readAll(dashboard({ rows: 2, titles: ["A"], prices: ["Rp1"] }));
  const picked = r.geometry.ancestors[r.geometry.wouldPickDepth];
  assert.ok(picked, "harus ada yang terpilih");
  assert.match(picked.className, /styles-module__container/);
  assert.equal(picked.overflowY, "hidden");
  assert.equal(picked.overflows, true);
  assert.equal(picked.scrollable, false);
  // dan scroller sungguhan ada di tempat lain
  assert.equal(r.geometry.realScrollerDepths.length, 1);
  const nyata = r.geometry.ancestors[r.geometry.realScrollerDepths[0]];
  assert.equal(nyata.overflowY, "auto");
  assert.ok(nyata.depth > picked.depth, "scroller sungguhan ada di LUAR yang terpilih");
  assert.equal(r.geometry.heuristicPicksRealScroller, false);
});

test("geometri: kalau pane memang bisa digulir, heuristik dilaporkan TEPAT (kontrol positif)", () => {
  const r = readAll(dashboard({ rows: 2, panelOverflowY: "auto", titles: ["A"], prices: ["Rp1"] }));
  assert.equal(r.geometry.heuristicPicksRealScroller, true);
  assert.ok(r.geometry.realScrollerDepths.length >= 2, "dua kandidat harus sama-sama dilaporkan");
});

test("geometri: tanpa baris produk => rowFound=false dan tidak ada tebakan container", () => {
  const r = readAll(dashboard({ rows: 0 }));
  assert.equal(r.geometry.rowFound, false);
  assert.deepEqual(r.geometry.ancestors, []);
  assert.equal(r.geometry.wouldPickDepth, null);
  assert.equal(r.geometry.heuristicPicksRealScroller, null);
});

test("geometri: atBottom dihitung, bukan ditebak", () => {
  const root = dashboard({ rows: 1, titles: ["A"], prices: ["Rp1"] });
  const r1 = readAll(root);
  const pane = r1.geometry.ancestors[r1.geometry.realScrollerDepths[0]];
  assert.equal(pane.atBottom, false);
});

// ---------------------------------------------------------------------------
// TIDAK ADA GULIR, TIDAK ADA MUTASI
// ---------------------------------------------------------------------------

test("probe TIDAK menggulir: scrollTop setiap leluhur identik sebelum dan sesudah dibaca", () => {
  const root = dashboard({ rows: 6, titles: ["A"], prices: ["Rp1"] });
  const snapshot = (node) => {
    const out = [];
    const walk = (n) => {
      out.push([n.scrollTop, n.scrollHeight, n.clientHeight]);
      for (const k of n._kids) walk(k);
    };
    walk(node);
    return JSON.stringify(out);
  };
  const sebelum = snapshot(root);
  readAll(root);
  readAll(root);
  assert.equal(snapshot(root), sebelum, "tidak satu pun geometri boleh berubah");
});

test("probe TIDAK memutasi DOM: jumlah node dan atribut identik sesudah dibaca", () => {
  const root = dashboard({ rows: 4, titles: ["A"], prices: ["Rp1"] });
  const bentuk = (node) => {
    const out = [];
    const walk = (n) => {
      out.push(n.tagName + "|" + JSON.stringify(n._attrs) + "|" + n._own);
      for (const k of n._kids) walk(k);
    };
    walk(node);
    return JSON.stringify(out);
  };
  const sebelum = bentuk(root);
  readAll(root);
  assert.equal(bentuk(root), sebelum);
});

test("sumber probe tidak memuat satu pun operasi yang dilarang", () => {
  const berkas = ["dom-probe-page.js", "probe-guards.js", "run-dom-probe.js"];
  // Hanya KODE: komentar dibuang lebih dulu, supaya catatan yang MENYEBUT
  // larangan tidak terbaca sebagai pelanggarannya.
  const kodeSaja = (s) =>
    s
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
  const dilarang = [
    [/\.scrollTop\s*=/, "menulis scrollTop"],
    // Dengan tanda kurung: tanpa itu, "scrollTo" cocok di dalam "scrollTop" dan
    // tes ini menuduh pembacaan geometri sebagai penggulingan.
    [/scrollBy\s*\(|scrollTo\s*\(|scrollIntoView\s*\(/, "menggulir"],
    [/\.click\s*\(/, "mengklik"],
    [/\.type\s*\(|keyboard\./, "mengetik"],
    [/setAttribute|removeAttribute|innerHTML|appendChild|\.remove\s*\(/, "memutasi DOM"],
    [/Stop-Process|taskkill/, "mematikan proses"],
    [/rmSync|unlinkSync|rmdirSync/, "menghapus berkas"],
    [/document\.cookie|localStorage|sessionStorage/, "membaca penyimpanan"],
  ];
  for (const f of berkas) {
    const src = kodeSaja(fs.readFileSync(path.join(ROOT, "scripts", "probe", f), "utf8"));
    for (const [re, apa] of dilarang) {
      assert.ok(!re.test(src), f + " tidak boleh " + apa);
    }
  }
});

// ---------------------------------------------------------------------------
// sanitasi keluaran
// ---------------------------------------------------------------------------

test("sanitasi: judul produk dan harga TIDAK PERNAH keluar dari probe", () => {
  const judul = "Garuda Kacang ATOM 16gr Spesial";
  const harga = "Rp14.299";
  const r = readAll(dashboard({ rows: 3, titles: [judul], prices: [harga] }));
  const dump = JSON.stringify(probe.sanitizePass(r));
  assert.ok(!dump.includes(judul), "judul produk tidak boleh keluar");
  assert.ok(!dump.includes("14.299"), "harga tidak boleh keluar");
  assert.ok(!dump.includes("ATOM"), "potongan judul pun tidak");
});

test("sanitasi: field tak terdaftar dibuang, field terdaftar lolos", () => {
  const pass = {
    strip: { state: "ok", candidateTotal: 20, rahasia: "jangan-ikut" },
    rows: { rowMarkers: 6, judulProduk: "Garuda" },
    search: { found: true, state: "empty", reason: "", nilaiAsli: "atom" },
    filters: { comboboxCount: 2, namaKategori: "Snack" },
    geometry: { rowFound: true, wouldPickDepth: 8 },
    scope: "clean",
    htmlMentah: "<div>...</div>",
  };
  const out = probe.sanitizePass(pass);
  const dump = JSON.stringify(out);
  for (const bocor of ["rahasia", "jangan-ikut", "judulProduk", "Garuda", "nilaiAsli", "atom", "namaKategori", "Snack", "htmlMentah"]) {
    assert.ok(!dump.includes(bocor), bocor + " harus dibuang");
  }
  assert.equal(out.strip.candidateTotal, 20);
  assert.equal(out.rows.rowMarkers, 6);
  assert.equal(out.scope, "clean");
});

test("sanitasi: tidak ada field yang membawa HTML atau teks halaman bebas", () => {
  const r = readAll(dashboard({ rows: 2, titles: ["Judul Produk Panjang"], prices: ["Rp9.999"] }));
  const dump = JSON.stringify(probe.sanitizePass(r));
  assert.ok(!dump.includes("<div"), "tidak boleh ada HTML");
  assert.ok(!dump.includes("Judul Produk"), "tidak boleh ada teks produk");
});

// ---------------------------------------------------------------------------
// stabilitas antar lintasan
// ---------------------------------------------------------------------------

test("stabilitas: dua lintasan atas halaman yang sama dilaporkan stabil", () => {
  const root = dashboard({ rows: 4, titles: ["A"], prices: ["Rp1"] });
  const s = probe.stability(readAll(root), readAll(root));
  assert.deepEqual(s, { rowsStable: true, numbersStable: true, stripStable: true, scopeStable: true, geometryStable: true });
});

test("stabilitas: halaman yang berubah di antara lintasan dilaporkan TIDAK stabil", () => {
  const a = readAll(dashboard({ rows: 4, strip: { thumbs: 4, badge: "+16" }, titles: ["A"], prices: ["Rp1"] }));
  const b = readAll(dashboard({ rows: 6, strip: { thumbs: 3, badge: null }, titles: ["A"], prices: ["Rp1"] }));
  const s = probe.stability(a, b);
  assert.equal(s.rowsStable, false);
  assert.equal(s.numbersStable, false);
  assert.equal(s.stripStable, false);
});

// ---------------------------------------------------------------------------
// gerbang kepemilikan profil
// ---------------------------------------------------------------------------

// Bentuk `controller` di sini SENGAJA sama persis dengan yang dikembalikan
// /api/status sungguhan (diverifikasi 2026-10-20): service.running,
// bot.running, automation, login.active, profile.owner di tingkat atas.
// Versi pertama gerbang ini membaca process.service.running - alamat yang tidak
// pernah ada - dan lolos dengan tenang. Fake yang mengarang bentuk adalah
// bagaimana itu bisa terjadi.
const CTRL_AMAN = Object.freeze({
  reachable: true,
  profileOwner: "none",
  serviceRunning: false,
  botRunning: false,
  loginActive: false,
  automationState: "STOPPED",
});
const AMAN = Object.freeze({
  botLockExists: false,
  profileDirExists: true,
  devToolsPortExists: false,
  controller: CTRL_AMAN,
  chromeScanOk: true,
  chromePidsOnProfile: [],
  operatorConfirmed: true,
  liveOnAir: true,
  chromePathGiven: true,
  chromePathExists: true,
  chromeVersion: "142.0.7444.175",
  profileLastVersion: "142.0.7444.175",
});
const kode = (v) => v.refusals.map((r) => r.code).sort();

test("gerbang: keadaan bersih => aman", () => {
  const v = evaluateSafety(AMAN);
  assert.equal(v.safe, true);
  assert.deepEqual(v.refusals, []);
});

test("gerbang: .bot.lock ada => automation-running", () => {
  const v = evaluateSafety({ ...AMAN, botLockExists: true });
  assert.equal(v.safe, false);
  assert.ok(kode(v).includes("automation-running"));
});

test("gerbang: Controller melaporkan service hidup => service-running", () => {
  const v = evaluateSafety({ ...AMAN, controller: { ...CTRL_AMAN, serviceRunning: true } });
  assert.equal(v.safe, false);
  assert.ok(kode(v).includes("service-running"));
});

test("gerbang: Controller melaporkan bot hidup => bot-running", () => {
  const v = evaluateSafety({ ...AMAN, controller: { ...CTRL_AMAN, botRunning: true } });
  assert.equal(v.safe, false);
  assert.ok(kode(v).includes("bot-running"));
});

test("gerbang: jendela login terbuka => login-active (ia memegang profil)", () => {
  const v = evaluateSafety({ ...AMAN, controller: { ...CTRL_AMAN, loginActive: true } });
  assert.equal(v.safe, false);
  assert.ok(kode(v).includes("login-active"));
});

for (const state of ["RUNNING", "STARTING", "STOPPING"]) {
  test("gerbang: automation=" + state + " => automation-running", () => {
    const v = evaluateSafety({ ...AMAN, controller: { ...CTRL_AMAN, automationState: state } });
    assert.equal(v.safe, false);
    assert.ok(kode(v).includes("automation-running"));
  });
}

for (const owner of ["automation", "login"]) {
  test("gerbang: profileOwner=" + owner + " => profile-owned", () => {
    const v = evaluateSafety({ ...AMAN, controller: { ...CTRL_AMAN, profileOwner: owner } });
    assert.equal(v.safe, false);
    assert.ok(kode(v).includes("profile-owned"));
  });
}

// Satu tes per field: alamat field yang SALAH mengembalikan undefined, dan
// `undefined === true` tidak pernah menolak. Tanpa tes-tes ini, gerbang yang
// menebak bentuk /api/status akan selalu hijau.
for (const field of ["profileOwner", "serviceRunning", "botRunning", "loginActive", "automationState"]) {
  test("gerbang: " + field + " tidak terbaca => controller-state-unreadable (fail-closed)", () => {
    const v = evaluateSafety({ ...AMAN, controller: { ...CTRL_AMAN, [field]: undefined } });
    assert.equal(v.safe, false);
    assert.ok(kode(v).includes("controller-state-unreadable"), "field " + field + " harus menolak");
  });
}

test("gerbang: bentuk status yang SALAH ALAMAT (process.service) ditolak, bukan dilewati", () => {
  const v = evaluateSafety({ ...AMAN, controller: { reachable: true, process: { service: { running: false } } } });
  assert.equal(v.safe, false);
  assert.ok(kode(v).includes("controller-state-unreadable"));
});

test("gerbang: Chrome masih memakai profil => chrome-using-profile", () => {
  const v = evaluateSafety({ ...AMAN, chromePidsOnProfile: [1234] });
  assert.equal(v.safe, false);
  assert.ok(kode(v).includes("chrome-using-profile"));
});

test("gerbang: pemindaian proses GAGAL => tidak aman (nol yang menenangkan ditolak)", () => {
  const v = evaluateSafety({ ...AMAN, chromeScanOk: false, chromePidsOnProfile: [] });
  assert.equal(v.safe, false);
  assert.ok(kode(v).includes("chrome-using-profile"));
});

test("gerbang: profil tidak ada => profile-missing", () => {
  const v = evaluateSafety({ ...AMAN, profileDirExists: false });
  assert.equal(v.safe, false);
  assert.ok(kode(v).includes("profile-missing"));
});

test("gerbang: Controller tidak terhubung TANPA konfirmasi => controller-state-unknown", () => {
  const v = evaluateSafety({ ...AMAN, operatorConfirmed: false, controller: { reachable: false } });
  assert.equal(v.safe, false);
  assert.ok(kode(v).includes("controller-state-unknown"));
  assert.ok(kode(v).includes("operator-confirmation-missing"));
});

test("gerbang: Controller tidak terhubung DENGAN konfirmasi => boleh, tapi dicatat", () => {
  const v = evaluateSafety({ ...AMAN, controller: { reachable: false } });
  assert.equal(v.safe, true);
  assert.deepEqual(v.warnings.map((w) => w.code), ["controller-unreachable-acknowledged"]);
});

test("gerbang: tanpa --operator-confirmed selalu ditolak", () => {
  const v = evaluateSafety({ ...AMAN, operatorConfirmed: false });
  assert.equal(v.safe, false);
  assert.ok(kode(v).includes("operator-confirmation-missing"));
});

test("gerbang: tanpa --live-on-air selalu ditolak", () => {
  const v = evaluateSafety({ ...AMAN, liveOnAir: false });
  assert.equal(v.safe, false);
  assert.ok(kode(v).includes("live-not-confirmed"));
});

test("gerbang: fakta kosong => ditolak, bukan diizinkan (fail-closed)", () => {
  const v = evaluateSafety({});
  assert.equal(v.safe, false);
  assert.ok(v.refusals.length >= 5);
});

test("gerbang: DevToolsActivePort yatim jadi CATATAN, bukan penolakan, dan tidak dibersihkan", () => {
  const v = evaluateSafety({ ...AMAN, devToolsPortExists: true });
  assert.equal(v.safe, true);
  assert.deepEqual(v.warnings.map((w) => w.code), ["stale-devtools-port"]);
});

// Membuka profil login dengan build Chrome berbeda bisa meng-upgrade skema
// profil, dan upgrade itu tidak bisa dibatalkan.
test("gerbang: versi Chrome berbeda dari pemakai terakhir profil => ditolak", () => {
  const v = evaluateSafety({ ...AMAN, chromeVersion: "143.0.1.1" });
  assert.equal(v.safe, false);
  assert.ok(kode(v).includes("chrome-version-mismatch"));
  const r = v.refusals.find((x) => x.code === "chrome-version-mismatch");
  assert.match(r.detail, /profil=142\.0\.7444\.175/);
  assert.match(r.detail, /chrome=143\.0\.1\.1/);
});

test("gerbang: versi cocok => aman, tanpa catatan versi", () => {
  const v = evaluateSafety(AMAN);
  assert.equal(v.safe, true);
  assert.ok(!v.warnings.some((w) => w.code === "chrome-version-unverified"));
});

for (const [nama, patch] of [
  ["versi profil tidak terbaca", { profileLastVersion: null }],
  ["versi Chrome tidak terbaca", { chromeVersion: null }],
  ["keduanya tidak terbaca (jalur pengembang)", { profileLastVersion: null, chromeVersion: null, chromePathGiven: false, chromePathExists: false }],
]) {
  test("gerbang: " + nama + " => CATATAN, bukan penolakan", () => {
    const v = evaluateSafety({ ...AMAN, ...patch });
    assert.equal(v.safe, true, "jalur paling aman tidak boleh dimatikan");
    assert.ok(v.warnings.some((w) => w.code === "chrome-version-unverified"));
  });
}

test("gerbang: --chrome-path menunjuk berkas yang tidak ada => ditolak", () => {
  const v = evaluateSafety({ ...AMAN, chromePathExists: false, chromeVersion: null });
  assert.equal(v.safe, false);
  assert.ok(kode(v).includes("chrome-path-missing"));
});

// Gerbang identitas probe HARUS memakai keputusan produksi, bukan salinannya:
// probe yang menyetujui akun yang akan ditolak produksi tidak ada gunanya.
// waitForSettled adalah `while (Date.now() - start < timeoutMs)`. Dengan
// timeoutMs undefined, perbandingannya NaN -> false pada iterasi pertama, jadi
// ia balik settled:false dalam ~0 ms tanpa menunggu apa pun. Probe pertama
// 2026-10-20 gagal dengan identity-not-found justru karena ini.
test("settle: waitForSettled PRODUKSI tidak menunggu sama sekali kalau timeout undefined", async () => {
  const { waitForSettled } = require("../autopin/browser");
  let evaluasi = 0;
  const page = {
    isClosed: () => false,
    evaluate: async () => {
      evaluasi += 1;
      return 100;
    },
  };
  const r = await waitForSettled(page, undefined);
  assert.equal(r.settled, false, "undefined harus menghasilkan settled:false seketika");
  assert.equal(evaluasi, 0, "badan loop tidak pernah berjalan - inilah bug-nya");
});

test("settle: dengan timeout yang BENAR, waitForSettled menunggu sampai tenang", async () => {
  const { waitForSettled } = require("../autopin/browser");
  let n = 0;
  const page = { isClosed: () => false, evaluate: async () => (n++ < 2 ? 100 + n : 500) };
  const r = await waitForSettled(page, 30_000);
  assert.equal(r.settled, true);
  assert.ok(n > 2, "harus memanggil evaluate berkali-kali");
});

test("probe: timeout navigasi/kesiapan diisi, dan nilainya sama dengan default produksi", () => {
  const runner = require("../scripts/probe/run-dom-probe");
  const o = runner.parseArgs([]);
  assert.equal(o.navTimeoutMs, 45_000);
  assert.equal(o.readyTimeoutMs, 30_000);
  const src = fs.readFileSync(path.join(ROOT, "scripts", "probe", "run-dom-probe.js"), "utf8");
  assert.match(src, /navTimeoutMs: opts\.navTimeoutMs/, "bcfg harus meneruskan navTimeoutMs");
  assert.match(src, /readyTimeoutMs: opts\.readyTimeoutMs/, "bcfg harus meneruskan readyTimeoutMs");
});

// --- urutan gerbang, diuji lewat PERILAKU (deps disuntikkan, tanpa browser) ---
//
// Urutan ini adalah properti keselamatannya. Memeriksanya dengan grep atas kode
// sumber bukan bukti: mengganti kondisinya jadi `if (false)` tetap menyisakan
// string yang digrep, dan mutasi itu memang pernah lolos.
const CONSOLE_URL = "https://shop.tiktok.com/streamer/live/product/dashboard";

function rigExecute({ settled = true, identitas = ["agen_mulia_abadi"], url = CONSOLE_URL, root = null, lempar = false } = {}) {
  const jejak = { evaluate: 0, readIdentity: 0, closeBrowser: 0, launch: 0 };
  const dom = root || dashboard({ rows: 4, strip: { thumbs: 4, badge: "+16" }, titles: ["A"], prices: ["Rp1"] });
  const page = {
    url: () => url,
    isClosed: () => false,
    bringToFront: async () => {},
    // Menjalankan fungsi in-page PRODUKSI atas DOM tiruan.
    evaluate: async (fn, sel) => {
      jejak.evaluate += 1;
      if (lempar) throw new Error("pembacaan gagal");
      return withDocument(dom, () => fn(sel));
    },
  };
  const deps = {
    launchBrowser: async () => { jejak.launch += 1; return { id: "fake" }; },
    getPage: async () => page,
    openConsole: async () => ({ url, settled, readyMs: 1234 }),
    closeBrowser: async () => { jejak.closeBrowser += 1; },
    purpose: "runtime",
    isExpectedConsole: (a, b) => {
      try { return new URL(a).pathname === new URL(b).pathname; } catch (e) { return false; }
    },
    readIdentity: async () => { jejak.readIdentity += 1; return identitas; },
    checkIdentity: require("../autopin/core").checkIdentity,
  };
  return { deps, jejak };
}

const OPTS = {
  profileDir: "C:/x/browser-profile", debugDir: "C:/x/debug", consoleUrl: CONSOLE_URL,
  navTimeoutMs: 45000, readyTimeoutMs: 30000, chromePath: "", settleMs: 0,
  expectedShop: "agen_mulia_abadi", forbiddenShops: ["garudafood"],
};

test("urutan gerbang: halaman belum tenang => BERHENTI, nol pembacaan DOM, nol baca identitas", async () => {
  const runner = require("../scripts/probe/run-dom-probe");
  const { deps, jejak } = rigExecute({ settled: false });
  const r = await runner.execute(OPTS, deps);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "page-not-settled");
  assert.match(r.detail, /readyMs=1234/);
  assert.equal(jejak.evaluate, 0, "tidak boleh ada page.evaluate");
  assert.equal(jejak.readIdentity, 0, "identitas pun belum boleh dibaca");
  assert.equal(jejak.closeBrowser, 1, "browser tetap harus ditutup");
});

test("urutan gerbang: halaman tak terduga => BERHENTI sebelum apa pun dibaca", async () => {
  const runner = require("../scripts/probe/run-dom-probe");
  const { deps, jejak } = rigExecute({ url: "https://shop.tiktok.com/streamer/login" });
  const r = await runner.execute(OPTS, deps);
  assert.equal(r.reason, "unexpected-page");
  assert.equal(jejak.evaluate, 0);
  assert.equal(jejak.readIdentity, 0);
  assert.equal(jejak.closeBrowser, 1);
});

for (const [nama, identitas, alasan] of [
  ["identitas tidak terbaca", [], "identity-identity-not-found"],
  ["akun berbeda", ["toko_lain"], "identity-identity-mismatch"],
  ["akun TERLARANG", ["garudafood_official"], "identity-forbidden-shop"],
]) {
  test("urutan gerbang: " + nama + " => BERHENTI, nol pembacaan DOM", async () => {
    const runner = require("../scripts/probe/run-dom-probe");
    const { deps, jejak } = rigExecute({ identitas });
    const r = await runner.execute(OPTS, deps);
    assert.equal(r.ok, false);
    assert.equal(r.reason, alasan);
    assert.equal(r.identity.ok, false);
    assert.equal(jejak.readIdentity, 1, "identitas dibaca");
    assert.equal(jejak.evaluate, 0, "tapi TIDAK ada bukti DOM yang dikumpulkan");
    assert.equal(jejak.closeBrowser, 1);
  });
}

test("urutan gerbang: semua hijau => dua lintasan, lima pembacaan per lintasan", async () => {
  const runner = require("../scripts/probe/run-dom-probe");
  const { deps, jejak } = rigExecute({});
  const r = await runner.execute(OPTS, deps);
  assert.equal(r.ok, true);
  assert.equal(r.identity.ok, true);
  assert.equal(r.identity.observed, "agen_mulia_abadi");
  assert.equal(jejak.evaluate, 10, "5 pembaca x 2 lintasan");
  assert.equal(jejak.closeBrowser, 1);
  assert.equal(r.passes.length, 2);
  assert.equal(r.passes[0].strip.candidateTotal, 20);
  assert.equal(r.passes[0].rows.rowMarkers, 4);
  assert.equal(r.passes[0].scope, "clean");
  assert.equal(r.stability.rowsStable, true);
});

test("urutan gerbang: pembacaan yang melempar tetap menutup browser", async () => {
  const runner = require("../scripts/probe/run-dom-probe");
  const { deps, jejak } = rigExecute({ lempar: true });
  const r = await runner.execute(OPTS, deps);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "probe-failed");
  assert.equal(jejak.closeBrowser, 1);
});

test("identitas: probe memakai checkIdentity PRODUKSI, bukan salinan", () => {
  const src = fs.readFileSync(path.join(ROOT, "scripts", "probe", "run-dom-probe.js"), "utf8");
  assert.match(src, /require\("\.\.\/\.\.\/autopin\/core"\)/, "checkIdentity harus diimpor dari autopin/core");
  assert.match(src, /require\("\.\.\/\.\.\/autopin\/products"\)/, "readIdentity harus diimpor dari autopin/products");
  assert.ok(!/function checkIdentity|normalizeIdentity/.test(src), "tidak boleh menulis ulang keputusan identitas");
});

test("identitas: gerbang dijalankan SEBELUM pembacaan DOM apa pun", () => {
  const src = fs.readFileSync(path.join(ROOT, "scripts", "probe", "run-dom-probe.js"), "utf8");
  const iId = src.indexOf("checkIdentity({");
  const iPass = src.indexOf("await onePass(page)");
  assert.ok(iId > 0 && iPass > 0, "keduanya harus ada");
  assert.ok(iId < iPass, "identitas harus diperiksa lebih dulu");
});

test("identitas: akun yang diharapkan dan terlarang dibaca dari argumen", () => {
  const runner = require("../scripts/probe/run-dom-probe");
  const o = runner.parseArgs(["--expected-shop", "agen_mulia_abadi", "--forbidden-shops", "garudafood, lain"]);
  assert.equal(o.expectedShop, "agen_mulia_abadi");
  assert.deepEqual(o.forbiddenShops, ["garudafood", "lain"]);
  const d = runner.parseArgs([]);
  assert.equal(d.expectedShop, "");
  assert.deepEqual(d.forbiddenShops, []);
});

// Keputusan identitas diperiksa lewat fungsi produksi langsung: ini yang akan
// menolak kalau akun yang login bukan yang dimaksud.
test("identitas: vonis produksi untuk kasus-kasus yang relevan dengan probe", () => {
  const { checkIdentity } = require("../autopin/core");
  const F = ["garudafood"];
  assert.equal(checkIdentity({ expected: "agen_mulia_abadi", observed: ["agen_mulia_abadi"], forbidden: F }).ok, true);
  assert.equal(checkIdentity({ expected: "agen_mulia_abadi", observed: ["garudafood_official"], forbidden: F }).reason, "forbidden-shop");
  assert.equal(checkIdentity({ expected: "agen_mulia_abadi", observed: ["toko_lain"], forbidden: F }).reason, "identity-mismatch");
  assert.equal(checkIdentity({ expected: "agen_mulia_abadi", observed: [], forbidden: F }).reason, "identity-not-found");
  assert.equal(checkIdentity({ expected: "", observed: ["agen_mulia_abadi"], forbidden: F }).reason, "expected-shop-not-configured");
});

test("runner: --chrome-path dibaca dan diteruskan apa adanya", () => {
  const runner = require("../scripts/probe/run-dom-probe");
  assert.equal(runner.parseArgs([]).chromePath, "");
  const o = runner.parseArgs(["--chrome-path", "C:/app/resources/runtime/browser/chrome.exe"]);
  assert.equal(o.chromePath, path.resolve("C:/app/resources/runtime/browser/chrome.exe"));
});

test("gerbang: setiap penolakan punya kalimat untuk operator", () => {
  const v = evaluateSafety({});
  for (const r of v.refusals) {
    assert.ok(typeof r.userMessage === "string" && r.userMessage.length > 10, r.code + " butuh kalimat");
    assert.notEqual(r.userMessage, r.code);
  }
});

test("pemilihan PID: hanya proses yang command line-nya menyebut profil, dan command line TIDAK dikembalikan", () => {
  const procs = [
    { ProcessId: 11, CommandLine: 'chrome.exe --user-data-dir="C:\\x\\autopin-profile" --headless' },
    { ProcessId: 22, CommandLine: "chrome.exe" },
    { ProcessId: 33, CommandLine: 'chrome.exe --user-data-dir="C:\\Users\\b\\AppData\\Local\\Google\\Chrome\\User Data"' },
    { ProcessId: 0, CommandLine: "autopin-profile" },
  ];
  const pids = chromePidsUsingProfile(procs, "autopin-profile");
  assert.deepEqual(pids, [11]);
  assert.ok(pids.every((p) => typeof p === "number"));
});

test("pemilihan PID: cocok tanpa peduli huruf besar-kecil, dan nama profil kosong => kosong", () => {
  assert.deepEqual(chromePidsUsingProfile([{ ProcessId: 7, CommandLine: "--user-data-dir=C:/X/AutoPin-Profile" }], "autopin-profile"), [7]);
  assert.deepEqual(chromePidsUsingProfile([{ ProcessId: 7, CommandLine: "apa saja" }], ""), []);
});

// ---------------------------------------------------------------------------
// KONTRAK: probe dan PRODUKSI harus sepakat
// ---------------------------------------------------------------------------
//
// Sejak v0.3.0, autopin/products.js punya readCatalogueStateInPage sendiri -
// pembaca cakupan dan total yang DIPAKAI PRODUKSI untuk memutuskan coverage.
// Probe punya salinannya, dan salinan selalu menyimpang. Yang menahannya adalah
// tes ini: keduanya dijalankan atas DOM yang SAMA, dan vonisnya harus identik.
//
// Kalau tes ini merah, yang salah bukan tesnya: bukti yang dipakai audit dan
// bukti yang dipakai produksi sudah bukan bukti yang sama.
test("KONTRAK: vonis cakupan probe == vonis cakupan produksi, atas DOM yang sama", () => {
  const prod = require("../autopin/products");
  const kasus = [
    ["bersih", {}],
    ["pencarian terisi", { search: { value: "atom" } }],
    ["pencarian tanpa value", { search: {} }],
    ["kategori tak dikenal", { filters: { category: "Snack Premium" } }],
    ["kategori hilang", { filters: { category: null } }],
    ["stock tak dikenal", { filters: { stock: "Out of stock" } }],
    ["stock kosong", { filters: { stock: "" } }],
    ["activities terpilih", { filters: { activities: { title: "Promo", placeholder: false } } }],
    ["activities tanpa placeholder", { filters: { activities: { title: "", placeholder: false } } }],
    ["baris filter hilang", { filters: null }],
    ["strip hilang", { strip: null }],
    ["strip 3 thumbnail tanpa badge", { strip: { thumbs: 3, badge: null } }],
    ["badge rusak", { strip: { thumbs: 4, badge: "+1 lagi" } }],
  ];
  for (const [nama, spec] of kasus) {
    const root = dashboard({ rows: 4, titles: ["A"], prices: ["Rp1"], ...spec });

    const dariProbe = withDocument(root, () => {
      const search = probe.readSearchInPage(SEL);
      const filters = probe.readFiltersInPage(SEL);
      return {
        scope: probe.scopeVerdict({ search, filters }),
        search: search.state,
        category: filters.category.state,
        stock: filters.stock.state,
        activities: filters.activities.state,
        declaredTotal: probe.readStripInPage(SEL).candidateTotal,
      };
    });

    const dariProduksi = withDocument(root, () => {
      // Produksi tidak punya pembaca cakupan terpisah lagi: buktinya menumpang
      // pada readProductsInPage, dari evaluate yang sama yang membaca baris.
      const st = prod.readProductsInPage(prod.SELECTORS).catalogueEvidence;
      return {
        scope: prod.scopeVerdict(st),
        search: st.search.state,
        category: st.filters.category.state,
        stock: st.filters.stock.state,
        activities: st.filters.activities.state,
        declaredTotal: st.strip.state === "ok" ? st.strip.declaredTotal : undefined,
      };
    });

    assert.deepEqual(dariProbe, dariProduksi, "kasus " + JSON.stringify(nama) + " tidak sepakat");
  }
});

// ---------------------------------------------------------------------------
// isolasi dari produksi
// ---------------------------------------------------------------------------

test("probe TIDAK terjangkau dari entry point produksi mana pun", () => {
  const dirs = ["autopin", "controller", "qa", "autocomment", "tiktok", "runtime", "desktop"];
  const files = ["index.js", "autopin-service.js", "autopin-cli.js"];
  const cari = (p) => {
    const src = fs.readFileSync(p, "utf8");
    assert.ok(!/scripts[\/\\]probe/.test(src), p + " tidak boleh menyebut scripts/probe");
  };
  for (const f of files) cari(path.join(ROOT, f));
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js")) cari(p);
    }
  };
  for (const d of dirs) walk(path.join(ROOT, d));
});

test("scripts/ TIDAK ikut ter-paket ke installer", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const files = pkg.build.files.filter((f) => !String(f).startsWith("!"));
  for (const f of files) {
    assert.ok(!String(f).startsWith("scripts"), "build.files tidak boleh memuat scripts: " + f);
  }
});

test("runner bisa di-require tanpa memuat Puppeteer dan tanpa membuka apa pun", () => {
  const sebelum = Object.keys(require.cache).some((k) => k.includes("puppeteer"));
  const runner = require("../scripts/probe/run-dom-probe");
  assert.equal(typeof runner.parseArgs, "function");
  const sesudah = Object.keys(require.cache).some((k) => k.includes("puppeteer"));
  assert.equal(sesudah, sebelum, "require runner tidak boleh menarik Puppeteer");
});

test("runner: bawaannya TIDAK execute, dan flag operator harus diminta eksplisit", () => {
  const runner = require("../scripts/probe/run-dom-probe");
  const d = runner.parseArgs([]);
  assert.equal(d.execute, false);
  assert.equal(d.operatorConfirmed, false);
  assert.equal(d.liveOnAir, false);
  const on = runner.parseArgs(["--execute", "--operator-confirmed", "--live-on-air"]);
  assert.equal(on.execute, true);
  assert.equal(on.operatorConfirmed, true);
  assert.equal(on.liveOnAir, true);
});

// Lock terpasang di SEBELAH direktori profil di kedua layout (desktop/paths.js:
// DEV_LAYOUT -> repoRoot/.autopin-profile + repoRoot/.bot.lock; PACKAGED_LAYOUT
// -> userData/browser-profile + userData/.bot.lock). Memakukannya ke akar repo
// berarti probe terhadap profil TERINSTAL selalu melihat "tidak ada lock".
test("runner: lock diturunkan dari induk profil, bukan dipakukan ke akar repo", () => {
  const runner = require("../scripts/probe/run-dom-probe");
  const terinstal = runner.parseArgs(["--profile-dir", "C:/Users/x/AppData/Roaming/AI LIVE HOST/browser-profile"]);
  assert.equal(path.basename(terinstal.lockFile), ".bot.lock");
  assert.equal(path.dirname(terinstal.lockFile), path.resolve("C:/Users/x/AppData/Roaming/AI LIVE HOST"));
  assert.notEqual(path.dirname(terinstal.lockFile), ROOT);
});

test("runner: layout pengembang tetap menaruh lock di akar repo", () => {
  const runner = require("../scripts/probe/run-dom-probe");
  const dev = runner.parseArgs([]);
  assert.equal(path.dirname(dev.lockFile), ROOT);
  assert.equal(path.basename(dev.profileDir), ".autopin-profile");
});

test("runner: urutan argumen tidak mengubah turunan lock", () => {
  const runner = require("../scripts/probe/run-dom-probe");
  const a = runner.parseArgs(["--profile-dir", "C:/p/browser-profile", "--execute"]);
  const b = runner.parseArgs(["--execute", "--profile-dir", "C:/p/browser-profile"]);
  assert.equal(a.lockFile, b.lockFile);
  assert.equal(path.dirname(a.lockFile), path.resolve("C:/p"));
});

test("runner: --lock-file menang atas turunan", () => {
  const runner = require("../scripts/probe/run-dom-probe");
  const o = runner.parseArgs(["--profile-dir", "C:/p/browser-profile", "--lock-file", "C:/lain/.bot.lock"]);
  assert.equal(o.lockFile, path.resolve("C:/lain/.bot.lock"));
});

test("runner: --profile-dir dan --console-url dihormati", () => {
  const runner = require("../scripts/probe/run-dom-probe");
  const o = runner.parseArgs(["--profile-dir", "C:/tmp/profil", "--console-url", "https://contoh/x"]);
  assert.match(o.profileDir, /profil$/);
  assert.equal(o.consoleUrl, "https://contoh/x");
  assert.equal(runner.parseArgs([]).consoleUrl, runner.DEFAULT_CONSOLE_URL);
});
