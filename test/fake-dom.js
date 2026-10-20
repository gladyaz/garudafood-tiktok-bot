"use strict";
// DOM tiruan untuk tes yang menjalankan FUNGSI IN-PAGE PRODUKSI di Node.
//
// Semantik selector-nya sengaja sama dengan tiruan yang sudah dipakai
// test/autopin.price.test.js: tag opsional + sejumlah .class / [attr] /
// [attr="v"] / [attr*="v"], keturunan dipisah spasi, daftar dipisah koma.
// `:not()` TIDAK didukung - dan itu batasan yang berguna, karena produksi pun
// tidak memakainya.
//
// Tambahan di sini dibanding tiruan lama, semuanya OPSIONAL dan aditif:
//   - geometri: scrollTop / scrollHeight / clientHeight / overflowY
//   - properti: value (input teks), checked (checkbox)
//   - withDocument(): memasang global.document + global.getComputedStyle,
//     lalu MENGEMBALIKANNYA seperti semula - termasuk saat tes melempar.
//
// CATATAN: test/autopin.price.test.js masih memakai salinan matcher-nya
// sendiri. Menyatukannya ke modul ini adalah pekerjaan rapi-rapi yang berdiri
// sendiri; tidak dilakukan di sini supaya diff persiapan probe tetap sempit.

function parseSimple(part) {
  const s = part.trim();
  const m = /^([a-zA-Z*]+)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/.exec(s);
  if (!m) throw new Error("selector tiruan tidak mendukung: " + part);
  const tag = m[1] && m[1] !== "*" ? m[1].toLowerCase() : null;
  const classes = (m[2] || "").split(".").filter(Boolean);
  const conds = [];
  for (const raw of (m[3] || "").match(/\[[^\]]+\]/g) || []) {
    const body = raw.slice(1, -1);
    const eq = /^([a-zA-Z-]+)(\*?)=\s*"([^"]*)"$/.exec(body);
    if (eq) conds.push({ name: eq[1], sub: eq[2] === "*", value: eq[3] });
    else conds.push({ name: body, exists: true });
  }
  return { tag, classes, conds };
}

function matchSimple(node, part) {
  const { tag, classes, conds } = parseSimple(part);
  if (tag && String(node.tagName || "").toLowerCase() !== tag) return false;
  if (classes.length) {
    const own = String(node.getAttribute("class") || "").split(/\s+/).filter(Boolean);
    for (const c of classes) if (!own.includes(c)) return false;
  }
  for (const c of conds) {
    const v = node.getAttribute(c.name);
    if (c.exists) {
      if (v === null) return false;
    } else if (c.sub) {
      if (v === null || !String(v).includes(c.value)) return false;
    } else if (v !== c.value) return false;
  }
  return true;
}

function matchSelector(node, selector, scope) {
  for (const group of String(selector).split(",")) {
    const parts = group.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;
    const self = parts[parts.length - 1];
    if (!matchSimple(node, self)) continue;
    if (parts.length === 1) return true;
    let a = node.parentElement;
    let ok = false;
    while (a && a !== scope) {
      if (matchSimple(a, parts[0])) { ok = true; break; }
      a = a.parentElement;
    }
    if (ok) return true;
  }
  return false;
}

// spec: { tag, cls, attrs, text, kids, hidden, disabled,
//         scrollTop, scrollHeight, clientHeight, overflowY, value, checked }
function el(spec = {}) {
  const node = {
    tagName: String(spec.tag || "div").toUpperCase(),
    _attrs: { ...(spec.cls === undefined ? {} : { class: spec.cls }), ...(spec.attrs || {}) },
    _own: spec.text === undefined ? "" : String(spec.text),
    _kids: [],
    parentElement: null,
    disabled: spec.disabled === true,
    scrollTop: Number(spec.scrollTop || 0),
    scrollHeight: Number(spec.scrollHeight || 0),
    clientHeight: Number(spec.clientHeight || 0),
    __overflowY: spec.overflowY === undefined ? "visible" : String(spec.overflowY),
  };
  // Hanya dipasang kalau spec menyebutnya: input tanpa `value` di spec harus
  // berperilaku seperti elemen tanpa properti value, bukan seperti "".
  if (spec.value !== undefined) node.value = spec.value;
  if (spec.checked !== undefined) node.checked = spec.checked;
  // Pintu untuk menguji jalur "value melempar" (input yang dilindungi framework).
  if (spec.valueThrows === true) {
    Object.defineProperty(node, "value", {
      get() {
        throw new Error("value tidak bisa dibaca");
      },
    });
  }

  node.getAttribute = (n) =>
    Object.prototype.hasOwnProperty.call(node._attrs, n) ? String(node._attrs[n]) : null;
  node.getBoundingClientRect = () => (spec.hidden ? { width: 0, height: 0 } : { width: 40, height: 20 });

  Object.defineProperty(node, "childNodes", {
    get() {
      const out = [];
      if (node._own !== "") out.push({ nodeType: 3, textContent: node._own });
      for (const k of node._kids) out.push(k);
      return out;
    },
  });
  Object.defineProperty(node, "children", { get: () => node._kids.slice() });
  Object.defineProperty(node, "textContent", {
    get() {
      let t = node._own;
      for (const k of node._kids) t += ` ${k.textContent}`;
      return t;
    },
  });

  node._descendants = () => {
    const out = [];
    const walk = (n) => {
      for (const k of n._kids) {
        out.push(k);
        walk(k);
      }
    };
    walk(node);
    return out;
  };
  node.querySelectorAll = (sel) => node._descendants().filter((n) => matchSelector(n, sel, node));
  node.querySelector = (sel) => node.querySelectorAll(sel)[0] || null;
  node.matches = (sel) => matchSelector(node, sel, null);

  for (const k of spec.kids || []) {
    k.parentElement = node;
    node._kids.push(k);
  }
  return node;
}

// Dokumen tiruan: body + delegasi query ke akar.
function makeDocument(root) {
  return {
    body: root,
    querySelector: (sel) => root.querySelector(sel),
    querySelectorAll: (sel) => root.querySelectorAll(sel),
  };
}

// Menjalankan fn() dengan global.document dan global.getComputedStyle
// terpasang, lalu MENGEMBALIKAN keadaan semula apa pun yang terjadi.
function withDocument(root, fn) {
  const prevDoc = global.document;
  const prevCS = global.getComputedStyle;
  global.document = makeDocument(root);
  global.getComputedStyle = (node) => ({ overflowY: node && node.__overflowY ? node.__overflowY : "visible" });
  try {
    return fn();
  } finally {
    if (prevDoc === undefined) delete global.document;
    else global.document = prevDoc;
    if (prevCS === undefined) delete global.getComputedStyle;
    else global.getComputedStyle = prevCS;
  }
}

module.exports = { el, makeDocument, withDocument, matchSelector };
