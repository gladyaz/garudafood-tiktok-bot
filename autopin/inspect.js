"use strict";
// Riset DOM AutoPIN: outline DOM yang disanitasi + kandidat kontrol "pin".
// Output hanya ke folder debug yang di-gitignore. Tanpa cookie, storage, value input, query string.

const fs = require("fs");
const path = require("path");
const { ensurePrivateDir, safeUrl } = require("./browser");

// Dieksekusi DI DALAM halaman (harus self-contained).
function pageOutline(opts) {
  const SENSITIVE_ATTR = /token|auth|session|csrf|secret|password|cookie|sign|ticket/i;
  const KEEP_ATTR = /^(id|role|type|name|title|placeholder|disabled|href|src|alt|tabindex)$|^data-|^aria-/;
  const SKIP_TAGS = new Set(["script", "style", "noscript", "path", "defs", "link", "meta", "use", "g"]);
  const clip = (s, n) => {
    const t = String(s).replace(/\s+/g, " ").trim();
    return t.length > n ? `${t.slice(0, n)}…` : t;
  };
  const cleanUrl = (v) => {
    try {
      const u = new URL(v, location.href);
      return u.protocol === "data:" ? "data:…" : `${u.origin}${u.pathname}`;
    } catch {
      return clip(v, 40);
    }
  };
  const attrs = (el) => {
    const out = [];
    for (const a of el.attributes) {
      if (SENSITIVE_ATTR.test(a.name)) out.push(`${a.name}=<redacted>`);
      else if (a.name === "class") out.push(`class=${JSON.stringify(clip(a.value, 90))}`);
      else if (KEEP_ATTR.test(a.name)) {
        const v = a.name === "href" || a.name === "src" ? cleanUrl(a.value) : clip(a.value, 60);
        out.push(`${a.name}=${JSON.stringify(v)}`);
      }
    }
    return out.length ? ` ${out.join(" ")}` : "";
  };
  const ownText = (el) => {
    let t = "";
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.textContent;
    return clip(t, 70);
  };

  const lines = [];
  let count = 0;
  const walk = (el, depth) => {
    if (count >= opts.maxNodes) return;
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return;
    count += 1;
    const isField = tag === "input" || tag === "textarea";
    const text = isField ? "" : ownText(el);
    lines.push(
      `${"  ".repeat(depth)}<${tag}${attrs(el)}>${text ? ` ${JSON.stringify(text)}` : ""}${el.shadowRoot ? " [shadow-root]" : ""}`,
    );
    if (isField || tag === "svg" || depth >= opts.maxDepth) return;
    if (el.shadowRoot) for (const c of el.shadowRoot.children) walk(c, depth + 1);
    for (const c of el.children) walk(c, depth + 1);
  };
  if (document.body) walk(document.body, 0);
  return { lines, nodes: count, truncated: count >= opts.maxNodes, iframes: document.querySelectorAll("iframe").length };
}

// Dieksekusi DI DALAM halaman: elemen kecil yang teks/label-nya menyebut pin/semat + rantai leluhurnya.
function pinCandidates() {
  const RE = /\b(pin|unpin|pinned|sematkan|disematkan|semat|lepas(kan)?( sematan)?)\b/i;
  const clip = (s, n) => {
    const t = String(s || "").replace(/\s+/g, " ").trim();
    return t.length > n ? `${t.slice(0, n)}…` : t;
  };
  const describe = (el) => {
    const keep = [];
    for (const a of el.attributes) {
      if (/^data-|^aria-|^role$|^id$|^class$|^disabled$/.test(a.name)) keep.push(`${a.name}=${JSON.stringify(clip(a.value, 70))}`);
    }
    return `<${el.tagName.toLowerCase()} ${keep.join(" ")}> ${JSON.stringify(clip(el.innerText, 80))}`;
  };
  const out = [];
  for (const el of document.querySelectorAll("button, [role=button], a, span, div, i")) {
    const label = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""}`;
    const text = clip(el.innerText, 40);
    const hit = (text.length <= 30 && RE.test(text)) || RE.test(label);
    if (!hit) continue;
    if ([...el.children].some((c) => RE.test(clip(c.innerText, 40)))) continue; // simpan yang paling dalam saja
    const chain = [];
    for (let a = el.parentElement, i = 0; a && i < 8; a = a.parentElement, i += 1) chain.push(describe(a));
    out.push({ element: describe(el), ancestors: chain });
  }
  return out;
}

async function inspectPage(page, config) {
  ensurePrivateDir(config.debugDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = path.join(config.debugDir, `${stamp}_dom-outline.txt`);
  const sections = [];
  const frames = page.frames();
  let candidates = [];

  for (const [i, frame] of frames.entries()) {
    try {
      const outline = await frame.evaluate(pageOutline, { maxNodes: 8000, maxDepth: 60 });
      const pins = await frame.evaluate(pinCandidates);
      candidates = candidates.concat(pins.map((p) => ({ frame: i, ...p })));
      sections.push(
        `===== FRAME ${i} ${safeUrl(frame.url())} nodes=${outline.nodes} truncated=${outline.truncated} iframes=${outline.iframes}`,
        ...outline.lines,
      );
    } catch (err) {
      sections.push(`===== FRAME ${i} ${safeUrl(frame.url())} ERROR ${err.message}`);
    }
  }

  fs.writeFileSync(outFile, sections.join("\n"), { mode: 0o600 });
  const candFile = path.join(config.debugDir, `${stamp}_pin-candidates.json`);
  fs.writeFileSync(candFile, JSON.stringify(candidates, null, 2), { mode: 0o600 });
  return { outFile, candFile, frames: frames.length, pinCandidates: candidates.length };
}

module.exports = { inspectPage, pageOutline, pinCandidates };
