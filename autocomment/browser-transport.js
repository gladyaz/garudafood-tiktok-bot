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
// arco-icon-publish adalah nama ikon dari design system Arco, bukan kelas hash
// hasil build. Tetap rapuh: kalau TikTok mengganti ikonnya, pemeriksaan ini
// melapor publish-control-not-found dan dry-run menolak — tidak pernah menebak.
const PUBLISH_ICON = "svg.arco-icon-publish";
const UI_MAX_LENGTH = 100; // batas yang terlihat di UI ("0/100")

// Dijalankan DI DALAM halaman. Murni membaca: getComputedStyle,
// getBoundingClientRect, dan pembacaan atribut. Tidak ada focus/klik/ketik.
function inspectComposerInPage(sel) {
  const { textarea: TEXTAREA, publishIcon: PUBLISH, uiMax: UI_MAX } = sel;
  const out = {
    foundTextarea: false,
    foundPublishControl: false,
    textareaVisible: false,
    textareaDisabled: false,
    publishVisible: false,
    publishDisabled: false,
    maxLength: null,
    placeholder: null,
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

  const icon = document.querySelector(PUBLISH);
  if (icon) {
    out.foundPublishControl = true;
    // Naik ke leluhur yang benar-benar bisa ditindak; ikon SVG-nya sendiri
    // bukan tombol. Berhenti di <button>/[role=button] kalau ada, kalau tidak
    // pakai beberapa tingkat span/div pembungkus yang membawa state disabled.
    let actionable = icon.closest("button, [role=button]");
    if (!actionable) {
      let node = icon.parentElement;
      for (let i = 0; i < 3 && node; i++) {
        if (/cursor-(not-allowed|pointer)/.test(node.className || "") || node.hasAttribute("aria-disabled")) {
          actionable = node;
          break;
        }
        node = node.parentElement;
      }
      actionable = actionable || icon.parentElement;
    }
    out.publishVisible = visible(actionable) || visible(icon);
    const cls = String(actionable && actionable.className ? actionable.className : "");
    out.publishDisabled =
      (actionable && actionable.disabled === true) ||
      (actionable && actionable.getAttribute && actionable.getAttribute("aria-disabled") === "true") ||
      /cursor-not-allowed/.test(cls);
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
  if ([...text].length > Math.min(limit, uiMax)) return { ok: false, reason: "message-too-long" };

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
    return page.evaluate(evaluateInPage, { textarea: CHAT_TEXTAREA, publishIcon: PUBLISH_ICON, uiMax });
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
  decideDryRun,
  CHAT_TEXTAREA,
  PUBLISH_ICON,
  UI_MAX_LENGTH,
};
