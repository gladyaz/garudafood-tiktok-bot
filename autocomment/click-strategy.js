"use strict";
// Strategi klik tombol Publish, bisa dipilih eksplisit.
//
// ---------------------------------------------------------------------------
// KENAPA MODUL INI ADA
//
// Dua run diagnostik LIVE 2026-10-05 membuktikan ElementHandle.click() milik
// Puppeteer tidak pernah selesai di dashboard LIVE:
//
//   anggaran browser 5300ms  -> jatah klik 3750ms  -> click=3758!   timeout
//   anggaran browser 15500ms -> jatah klik 14022ms -> click=14038!  timeout
//
// Kliknya MENYERAP berapa pun yang diberikan. Waktu dinaikkan 3,7x, kemajuannya
// nol. Itu tanda tangan operasi yang menggantung, bukan yang lambat. Sementara
// tahap pra-klik stabil ~1,5 detik, dan `resolve-publish` - mencari tombolnya -
// hanya 1 ms. Jadi elemennya ketemu instan; yang menggantung murni aksi
// kliknya.
//
// Dugaan penyebabnya: ElementHandle.click() melakukan scroll-into-view lalu
// MENUNGGU bounding box elemen stabil antar-frame sebelum mengirim event mouse.
// Dashboard LIVE tidak pernah berhenti bergerak - chat bergulir, hitungan
// penonton berubah, video berjalan - sehingga penungguan itu tidak pernah
// selesai. Dugaan, bukan kesimpulan: yang TERBUKTI adalah kliknya tidak selesai.
//
// Dua strategi di bawah sama-sama MELEWATI penungguan stabilitas itu. Keduanya
// sengaja TIDAK memakai ElementHandle.click().
// ---------------------------------------------------------------------------
//
// ATURAN YANG TIDAK BOLEH DILANGGAR
//
//   * satu instance strategi = PALING BANYAK satu percobaan klik, selamanya
//   * TIDAK ADA fallback otomatis dari satu strategi ke strategi lain; pemilihan
//     terjadi sekali, di luar modul ini
//   * Enter tidak pernah ditekan; satu-satunya jalur kirim adalah klik
//   * penolakan karena keadaan elemen (tidak ada / tersembunyi / disabled)
//     DIKEMBALIKAN sebagai { ok:false }, karena pada kasus itu kita TAHU tidak
//     ada klik yang terjadi -> pemanggil membersihkan teksnya sendiri
//   * kegagalan yang hasilnya TIDAK DIKETAHUI (deadline, konteks hancur)
//     DILEMPAR, supaya pemanggil menjalankan rekonsiliasi - bukan menyimpulkan
//     gagal
//
// Catatan untuk pembaca berikutnya: page.evaluate() hanya membawa SUMBER fungsi
// ke halaman, tanpa scope modul. Karena itu seluruh helper di dalam fungsi
// in-page WAJIB bersarang. Padanan tingkat-modulnya adalah
// findPublishControlInPage() di browser-transport.js, dan tes kesetaraan
// memastikan keduanya tidak pernah berbeda perilaku.

const {
  CHAT_TEXTAREA, PUBLISH_ICON, COMPOSER_SCOPE_DEPTH,
} = require("./browser-transport");
const { resolvePublishElementInPage } = require("./send-once");

const STRATEGIES = Object.freeze({
  // Warisan: ElementHandle.click(). Masih default produksi sampai tes LIVE
  // menentukan penggantinya. Terbukti menggantung - jangan dipakai untuk jalur
  // baru.
  HANDLE: "handle",
  // Satu round-trip CDP: resolusi DAN klik terjadi di dalam halaman.
  DOM: "dom",
  // Baca kotak pembungkus yang bisa ditindak, lalu kirim event mouse asli ke
  // titik tengahnya.
  MOUSE: "mouse",
});

const REFUSE = (reason, extra) => ({ ok: false, reason, ...extra });

// ---------------------------------------------------------------------------
// fungsi in-page (self-contained, lihat catatan di atas)
// ---------------------------------------------------------------------------

// DOM_CLICK: resolusi + pemeriksaan keadaan + HTMLElement.click(), semuanya di
// dalam halaman, satu round-trip. Kalau pemeriksaan menolak, click() TIDAK
// pernah dipanggil - jadi { ok:false } dari sini selalu berarti "nol klik".
function domClickInPage(sel) {
  function findPublish(textarea, iconSelector, depth) {
    const maxDepth = Number.isInteger(depth) && depth > 0 ? depth : 5;
    let scope = textarea.parentElement;
    let icon = null;
    for (let i = 0; i < maxDepth && scope; i += 1) {
      icon = scope.querySelector(iconSelector);
      if (icon) break;
      scope = scope.parentElement;
    }
    if (!icon) return null;
    let actionable = icon.closest("button, [role=button]");
    if (!actionable) {
      let node = icon.parentElement;
      for (let i = 0; i < 3 && node; i += 1) {
        const cls = String(node.className || "");
        if (/cursor-(not-allowed|pointer)/.test(cls) || (node.hasAttribute && node.hasAttribute("aria-disabled"))) {
          actionable = node;
          break;
        }
        node = node.parentElement;
      }
      actionable = actionable || icon.parentElement;
    }
    return { icon, actionable, scope };
  }

  const ta = document.querySelector(sel.textarea);
  if (!ta) return { ok: false, reason: "chat-input-not-found" };

  const found = findPublish(ta, sel.publishIcon, sel.depth);
  if (!found || !found.icon) return { ok: false, reason: "publish-control-not-found" };

  const el = found.actionable || found.icon;

  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return { ok: false, reason: "publish-control-not-visible" };
  const s = getComputedStyle(el);
  if (s.visibility === "hidden" || s.display === "none" || s.opacity === "0") {
    return { ok: false, reason: "publish-control-not-visible" };
  }

  // Aturan disabled SAMA dengan pemeriksa komposer: tanpa penanda "aktif" yang
  // jelas, dianggap disabled. Menebak "aktif" bisa berujung mengklik sesuatu
  // yang bukan tombol kirim.
  const cls = String(el.className || "");
  let cursor = "";
  try {
    cursor = s.cursor;
  } catch (e) {
    cursor = "";
  }
  const explicitlyDisabled =
    el.disabled === true || (el.getAttribute && el.getAttribute("aria-disabled") === "true");
  const enabledMarker = /cursor-pointer/.test(cls) || cursor === "pointer" || /text-primary-normal/.test(cls);
  if (explicitlyDisabled || !enabledMarker) return { ok: false, reason: "publish-control-disabled" };

  if (typeof el.click !== "function") return { ok: false, reason: "publish-control-not-clickable" };

  // SATU klik. Tidak ada Enter, tidak ada klik kedua, tidak ada retry.
  el.click();
  return {
    ok: true,
    clicked: true,
    tag: String(el.tagName || ""),
    cls: cls.slice(0, 80),
  };
}

// MOUSE_CLICK tahap 1: MURNI MEMBACA. Mengembalikan titik tengah pembungkus
// yang bisa ditindak. Tidak mengklik apa pun - kliknya dikirim dari sisi Node
// lewat page.mouse, supaya tidak ada penungguan stabilitas sama sekali.
function publishBoxInPage(sel) {
  function findPublish(textarea, iconSelector, depth) {
    const maxDepth = Number.isInteger(depth) && depth > 0 ? depth : 5;
    let scope = textarea.parentElement;
    let icon = null;
    for (let i = 0; i < maxDepth && scope; i += 1) {
      icon = scope.querySelector(iconSelector);
      if (icon) break;
      scope = scope.parentElement;
    }
    if (!icon) return null;
    let actionable = icon.closest("button, [role=button]");
    if (!actionable) {
      let node = icon.parentElement;
      for (let i = 0; i < 3 && node; i += 1) {
        const cls = String(node.className || "");
        if (/cursor-(not-allowed|pointer)/.test(cls) || (node.hasAttribute && node.hasAttribute("aria-disabled"))) {
          actionable = node;
          break;
        }
        node = node.parentElement;
      }
      actionable = actionable || icon.parentElement;
    }
    return { icon, actionable, scope };
  }

  const ta = document.querySelector(sel.textarea);
  if (!ta) return { ok: false, reason: "chat-input-not-found" };

  const found = findPublish(ta, sel.publishIcon, sel.depth);
  if (!found || !found.icon) return { ok: false, reason: "publish-control-not-found" };

  const el = found.actionable || found.icon;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return { ok: false, reason: "publish-control-not-visible" };

  const s = getComputedStyle(el);
  if (s.visibility === "hidden" || s.display === "none" || s.opacity === "0") {
    return { ok: false, reason: "publish-control-not-visible" };
  }

  const cls = String(el.className || "");
  let cursor = "";
  try {
    cursor = s.cursor;
  } catch (e) {
    cursor = "";
  }
  const explicitlyDisabled =
    el.disabled === true || (el.getAttribute && el.getAttribute("aria-disabled") === "true");
  const enabledMarker = /cursor-pointer/.test(cls) || cursor === "pointer" || /text-primary-normal/.test(cls);
  if (explicitlyDisabled || !enabledMarker) return { ok: false, reason: "publish-control-disabled" };

  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  // Titik di luar viewport tidak bisa diklik mouse, dan menggulirkan halaman
  // sendiri bukan tugas modul ini. Dilaporkan apa adanya.
  if (!(x >= 0 && y >= 0)) return { ok: false, reason: "publish-control-offscreen" };

  return { ok: true, x, y, width: r.width, height: r.height, tag: String(el.tagName || "") };
}

// ---------------------------------------------------------------------------

function defaultSelectors(depth) {
  return {
    textarea: CHAT_TEXTAREA,
    publishIcon: PUBLISH_ICON,
    depth: Number.isInteger(depth) && depth > 0 ? depth : COMPOSER_SCOPE_DEPTH,
  };
}

// `bounded` dan `timer` disuntik oleh pemanggil supaya deadline dan pengukuran
// tetap satu sumber - modul ini tidak punya jam maupun anggarannya sendiri.
const passthrough = (p) => Promise.resolve(p);
const noTimer = { step: (_name, thunk) => thunk() };

function createClickStrategy({
  strategy = STRATEGIES.HANDLE,
  selectors,
  depth,
  logger = null,
} = {}) {
  const name = String(strategy || "").toLowerCase();
  const sel = selectors || defaultSelectors(depth);

  // Lapis kedua di atas jatah per-playId: satu instance tidak akan pernah
  // mengklik dua kali, apa pun yang memanggilnya.
  let attempted = false;

  const log = (line) => {
    if (!logger) return;
    try {
      logger(line);
    } catch (e) {
      /* logger rusak tidak boleh menjatuhkan jalur kirim */
    }
  };

  async function click({ page, bounded = passthrough, timer = noTimer } = {}) {
    if (attempted) return REFUSE("click-already-attempted", { strategy: name });
    if (!page) return REFUSE("page-unavailable", { strategy: name });
    if (!Object.values(STRATEGIES).includes(name)) {
      // Nilai tak dikenal TIDAK pernah diartikan sebagai salah satu strategi.
      return REFUSE("unknown-click-strategy-" + name, { strategy: name });
    }
    attempted = true;

    if (name === STRATEGIES.DOM) {
      // Satu round-trip: resolusi, pemeriksaan, dan klik semuanya di halaman.
      // Tidak ada tahap resolve-publish terpisah - itu memang bagian dari biaya
      // yang diukur di tahap click.
      const r = await timer.step("click", () => bounded(page.evaluate(domClickInPage, sel), "click"));
      if (!r || r.ok !== true) return REFUSE((r && r.reason) || "publish-control-not-found", { strategy: name });
      log(`[AUTOCOMMENT_CLICK_DOM] tag=${r.tag} cls="${r.cls}"`);
      return { ok: true, clicked: true, clicks: 1, strategy: name, tag: r.tag };
    }

    if (name === STRATEGIES.MOUSE) {
      const box = await timer.step("resolve-publish", () =>
        bounded(page.evaluate(publishBoxInPage, sel), "resolve-publish")
      );
      if (!box || box.ok !== true) {
        return REFUSE((box && box.reason) || "publish-control-not-found", { strategy: name });
      }
      // Event mouse asli ke titik tengah. page.mouse TIDAK melakukan
      // scroll-into-view maupun penungguan stabilitas - itu intinya.
      await timer.step("click", () => bounded(page.mouse.click(box.x, box.y), "click"));
      log(`[AUTOCOMMENT_CLICK_MOUSE] x=${Math.round(box.x)} y=${Math.round(box.y)} w=${Math.round(box.width)} h=${Math.round(box.height)}`);
      return { ok: true, clicked: true, clicks: 1, strategy: name, point: { x: box.x, y: box.y } };
    }

    // STRATEGIES.HANDLE - jalur warisan, dipertahankan apa adanya supaya default
    // produksi tidak berubah sampai tes LIVE memilih penggantinya. TERBUKTI
    // menggantung; jangan dipakai untuk apa pun yang baru.
    let handle = null;
    try {
      handle = await timer.step("resolve-publish", () =>
        bounded(page.evaluateHandle(resolvePublishElementInPage, sel), "resolve-publish")
      );
      const el = handle && typeof handle.asElement === "function" ? handle.asElement() : null;
      if (!el) return REFUSE("publish-control-not-found", { strategy: name });
      await timer.step("click", () => bounded(el.click(), "click"));
      return { ok: true, clicked: true, clicks: 1, strategy: name };
    } finally {
      if (handle && typeof handle.dispose === "function") {
        try {
          await handle.dispose();
        } catch (e) {
          /* abaikan */
        }
      }
    }
  }

  return {
    name,
    click,
    __state: () => ({ strategy: name, attempted, selectors: sel }),
  };
}

module.exports = {
  createClickStrategy,
  domClickInPage,
  publishBoxInPage,
  defaultSelectors,
  STRATEGIES,
};
