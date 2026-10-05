"use strict";
// Transport browser AutoComment — AR2A: HANYA BACA, TIDAK PERNAH MENGIRIM.
//
// Modul ini boleh MELIHAT komposer chat di LIVE Manager dan melaporkan apakah
// sebuah pesan "akan bisa" dikirim. Ia TIDAK BOLEH mengetik, mengisi nilai,
// mengirim event keyboard, atau mengklik kontrol apa pun. Satu-satunya hasil
// yang mungkin adalah { ok, dryRun: true, wouldSend } atau penolakan beralasan.
//
// Dukungan kirim sungguhan adalah pekerjaan AR2B dan sengaja TIDAK ADA di sini:
// tidak ada parameter, flag, maupun cabang kode yang bisa mengaktifkannya.
//
// Bukti selector (AR0, DOM konsol LIVE Manager yang tersimpan saat siaran aktif):
//   textarea[data-tid="m4b_input_textarea"]  placeholder "Type something..."
//   svg.arco-icon-publish  di dalam span yang ber-class "cursor-not-allowed"
//                          selama textarea kosong
//   penghitung "0/100" di div ber-class index-module__length--<hash>
// Yang BELUM terbukti: atribut maxlength pada textarea (alat capture tidak
// menyimpannya), identitas baris komentar, dan tombol balas per komentar.

const CHAT_TEXTAREA = 'textarea[data-tid="m4b_input_textarea"]';
// Kontrol kirim BERGANTI WUJUD menurut isi komposer (dibuktikan di LIVE Manager
// sungguhan, 2026-10-05):
//   kosong : <span ... text-neutral-text3 cursor-not-allowed><svg class="arco-icon arco-icon-publish">
//   terisi : <span ... text-primary-normal  cursor-pointer   ><svg class="arco-icon arco-icon-publish_management_fill">
// Mencari svg.arco-icon-publish saja membuat tombolnya HILANG begitu teks masuk.
// Karena itu polanya memakai awalan yang sama-sama dimiliki kedua varian.
// Tidak ada data-tid/role/aria-label pada kontrol ini; satu-satunya jangkar
// stabil di area komposer adalah textarea, jadi pencarian selalu bermula dari sana.
const PUBLISH_ICON = 'svg[class*="arco-icon-publish"]';
// Seberapa jauh naik dari textarea untuk menemukan blok komposer yang memuat ikon.
const COMPOSER_SCOPE_DEPTH = 5;
const UI_MAX_LENGTH = 100; // batas yang terlihat di UI ("0/100")

// Dijalankan DI DALAM halaman. Mencari kontrol kirim dengan bertolak dari
// textarea (satu-satunya elemen ber-data-tid di komposer), naik maksimal
// COMPOSER_SCOPE_DEPTH tingkat sampai menemukan blok yang memuat ikon publish,
// lalu menentukan elemen yang benar-benar bisa ditindak. Murni membaca.
function findPublishControlInPage(textarea, iconSelector, depth) {
  const maxDepth = Number.isInteger(depth) && depth > 0 ? depth : 5;
  let scope = textarea.parentElement;
  let icon = null;
  for (let i = 0; i < maxDepth && scope; i += 1) {
    icon = scope.querySelector(iconSelector);
    if (icon) break;
    scope = scope.parentElement;
  }
  if (!icon) return null;

  // <button>/[role=button] kalau halaman menyediakannya; kalau tidak, naik
  // sampai pembungkus terdekat yang membawa penanda state.
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

// Dijalankan DI DALAM halaman. Murni membaca: getComputedStyle,
// getBoundingClientRect, dan pembacaan atribut. Tidak ada focus/klik/ketik.
function inspectComposerInPage(sel) {
  const { textarea: TEXTAREA, publishIcon: PUBLISH, uiMax: UI_MAX, depth: DEPTH } = sel;
  // CATATAN: page.evaluate() hanya membawa SUMBER fungsi ini ke halaman, tanpa
  // scope modul. Jadi helper di bawah WAJIB bersarang, bukan di-import.
  // Padanan tingkat-modulnya adalah findPublishControlInPage(), dan sebuah tes
  // kesetaraan memastikan keduanya tidak pernah berbeda perilaku.
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

  const out = {
    foundTextarea: false,
    foundPublishControl: false,
    textareaVisible: false,
    textareaDisabled: false,
    publishVisible: false,
    publishDisabled: false,
    maxLength: null,
    placeholder: null,
    publishIconClass: null,
    publishState: null,
  };

  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
  };

  const ta = document.querySelector(TEXTAREA);
  if (ta) {
    out.foundTextarea = true;
    out.textareaVisible = visible(ta);
    out.textareaDisabled = ta.disabled === true || ta.readOnly === true || ta.getAttribute("aria-disabled") === "true";
    out.placeholder = ta.getAttribute("placeholder");
    const ml = Number(ta.getAttribute("maxlength"));
    if (Number.isInteger(ml) && ml > 0) out.maxLength = ml;
  }

  // Penghitung "0/100" dipakai hanya kalau textarea tidak punya maxlength.
  if (out.maxLength === null && ta && ta.parentElement) {
    const scope = ta.closest("div") || ta.parentElement;
    const m = /\b\d+\s*\/\s*(\d+)\b/.exec(scope ? scope.innerText || "" : "");
    if (m) {
      const n = Number(m[1]);
      if (Number.isInteger(n) && n > 0) out.maxLength = n;
    }
  }
  if (out.maxLength === null) out.maxLength = UI_MAX;

  // Pencarian kontrol kirim SELALU berjangkar pada textarea lalu dibatasi pada
  // blok komposer. Tanpa pembatasan itu, ikon mirip di bagian lain halaman bisa
  // tertangkap - termasuk tombol "New" (gulir ke pesan baru) yang berukuran 0x0
  // dan sama sekali bukan tombol kirim.
  const found = ta ? findPublish(ta, PUBLISH, DEPTH) : null;
  if (found && found.icon) {
    out.foundPublishControl = true;
    out.publishIconClass = String(found.icon.getAttribute("class") || "").trim();
    const actionable = found.actionable || found.icon;
    out.publishVisible = visible(actionable) || visible(found.icon);

    // State dibaca dari penanda semantik yang memang dipakai halaman: kelas
    // cursor-*/text-* dan cursor hasil komputasi. Bukan kelas hash, bukan posisi.
    const cls = String(actionable.className || "");
    let cursor = "";
    try {
      cursor = getComputedStyle(actionable).cursor;
    } catch {
      cursor = "";
    }
    const explicitlyDisabled =
      actionable.disabled === true ||
      (actionable.getAttribute && actionable.getAttribute("aria-disabled") === "true");
    const disabledMarker = /cursor-not-allowed/.test(cls) || cursor === "not-allowed" || /text-neutral-text3/.test(cls);
    const enabledMarker = /cursor-pointer/.test(cls) || cursor === "pointer" || /text-primary-normal/.test(cls);

    // Tanpa penanda yang jelas, dianggap disabled: menebak "aktif" bisa berujung
    // mengklik sesuatu yang bukan tombol kirim.
    out.publishDisabled = Boolean(explicitlyDisabled || !enabledMarker || (disabledMarker && !enabledMarker));
    out.publishState = out.publishDisabled ? "disabled" : "enabled";
  }

  return out;
}

// Catatan penting untuk pembaca berikutnya: saat komposer KOSONG, kontrol
// publish memang bertanda cursor-not-allowed. Itu keadaan normal, bukan tanda
// komposer rusak. Karena AR2A tidak pernah mengetik, kita TIDAK bisa membedakan
// "disabled karena kosong" dari "disabled karena akun dibatasi" — maka
// publishDisabled dilaporkan apa adanya dan TIDAK dipakai untuk menolak dry-run.
function decideDryRun(text, composer, { uiMax = UI_MAX_LENGTH } = {}) {
  if (typeof text !== "string" || text.trim() === "") return { ok: false, reason: "empty-message" };
  if (!composer) return { ok: false, reason: "composer-not-ready" };
  if (!composer.foundTextarea) return { ok: false, reason: "chat-input-not-found" };
  if (!composer.textareaVisible) return { ok: false, reason: "composer-not-ready" };
  if (composer.textareaDisabled) return { ok: false, reason: "chat-input-disabled" };
  if (!composer.foundPublishControl) return { ok: false, reason: "publish-control-not-found" };

  const limit = Number.isInteger(composer.maxLength) && composer.maxLength > 0 ? composer.maxLength : uiMax;
  // TikTok menghitung dalam satuan UTF-16, bukan code point: penghitungnya
  // menulis "27/100" untuk pesan 26 code point yang memuat satu emoji. Memakai
  // code point membuat batas kita LEBIH LONGGAR daripada batas platform.
  if (text.length > Math.min(limit, uiMax)) return { ok: false, reason: "message-too-long" };

  return { ok: true };
}

function createBrowserTransport({
  getPage,
  dryRun = true,
  logger = console,
  uiMax = UI_MAX_LENGTH,
  evaluateInPage = inspectComposerInPage,
} = {}) {
  // Satu-satunya mode yang ada di AR2A. Dibuat eksplisit supaya salah
  // konfigurasi berhenti di sini, bukan berubah jadi kiriman sungguhan.
  if (dryRun !== true) {
    throw new Error("browser-transport AR2A hanya mendukung dryRun:true; pengiriman sungguhan adalah pekerjaan AR2B");
  }

  const log = (line) => {
    try {
      logger.log(line);
    } catch {
      /* logger rusak tidak boleh menjatuhkan pemanggil */
    }
  };

  async function inspectChatComposer() {
    const page = await getPage();
    if (!page) throw new Error("chat-page-unavailable");
    if (typeof page.isClosed === "function" && page.isClosed()) throw new Error("chat-page-closed");
    return page.evaluate(evaluateInPage, { textarea: CHAT_TEXTAREA, publishIcon: PUBLISH_ICON, uiMax, depth: COMPOSER_SCOPE_DEPTH });
  }

  // Antarmuka yang sama dengan transport dry-run AR1: send({text, scene, playId}).
  async function send({ text, scene, playId } = {}) {
    let composer;
    try {
      composer = await inspectChatComposer();
    } catch (err) {
      const reason = err && err.message ? String(err.message).slice(0, 80) : "inspect-failed";
      log(`[AUTOCOMMENT_BROWSER_FAILED] scene=${scene} playId=${playId} reason=${reason}`);
      return { ok: false, reason: "composer-inspect-failed", detail: reason };
    }

    log(
      `[AUTOCOMMENT_BROWSER_READY] scene=${scene} playId=${playId}` +
        ` textarea=${composer.foundTextarea}/${composer.textareaVisible}` +
        ` publish=${composer.foundPublishControl}/${!composer.publishDisabled}` +
        ` maxLength=${composer.maxLength}`
    );

    const verdict = decideDryRun(text, composer, { uiMax });
    if (!verdict.ok) {
      log(`[AUTOCOMMENT_BROWSER_FAILED] scene=${scene} playId=${playId} reason=${verdict.reason}`);
      return { ok: false, reason: verdict.reason, composer };
    }

    log(`[AUTOCOMMENT_BROWSER_DRYRUN] scene=${scene} playId=${playId} wouldSend="${text}"`);
    return { ok: true, dryRun: true, wouldSend: text, composer };
  }

  return { send, inspectChatComposer, __selectors: { CHAT_TEXTAREA, PUBLISH_ICON, UI_MAX_LENGTH: uiMax } };
}

module.exports = {
  createBrowserTransport,
  inspectComposerInPage,
  findPublishControlInPage,
  decideDryRun,
  CHAT_TEXTAREA,
  PUBLISH_ICON,
  UI_MAX_LENGTH,
  COMPOSER_SCOPE_DEPTH,
};
