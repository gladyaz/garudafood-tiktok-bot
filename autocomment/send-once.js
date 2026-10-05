"use strict";
// AR2B — jalur kirim SUNGGUHAN sekali pakai, berpagar rapat.
//
// Ini satu-satunya tempat di seluruh repo yang boleh menyentuh komposer chat.
// Semuanya dirancang supaya sulit dipakai tanpa sengaja:
//
//   * mati kecuali service dijalankan dengan --allow-comment-send-once
//   * setiap permintaan harus membawa confirm === true secara eksplisit
//   * SATU proses service = PALING BANYAK satu percobaan mengetik dan satu klik
//   * jatah terpakai begitu pengetikan DIMULAI, jadi hasil yang ambigu pun
//     tidak membuka peluang percobaan kedua
//   * nol retry, nol loop, tidak pernah menekan Enter sebagai jalan pintas
//   * identitas toko harus persis akun tes; identitas produksi selalu menolak
//   * mengetik dan mengklik adalah dua langkah TERPISAH: prepare() berhenti
//     tepat sebelum klik dan menunggu persetujuan manusia
//
// Tidak ada nilai environment yang bisa menyalakan ini. Otorisasinya hanya
// lewat argumen baris perintah saat service dijalankan, sehingga tidak bisa
// tertinggal menyala di .env seseorang.

const {
  inspectComposerInPage, decideDryRun,
  CHAT_TEXTAREA, PUBLISH_ICON, UI_MAX_LENGTH,
} = require("./browser-transport");

// Dijalankan di dalam halaman. Membaca isi komposer apa adanya.
function readComposerTextInPage(sel) {
  const el = document.querySelector(sel);
  if (!el) return null;
  return String(el.value == null ? "" : el.value);
}

// Dijalankan di dalam halaman. Mengembalikan ELEMEN publish yang bisa ditindak
// (bukan ikon SVG-nya), memakai aturan penelusuran yang sama dengan AR2A.
// Tidak mengubah apa pun; hanya mengembalikan referensi elemen.
function resolvePublishElementInPage(sel) {
  const icon = document.querySelector(sel);
  if (!icon) return null;
  const direct = icon.closest("button, [role=button]");
  if (direct) return direct;
  let node = icon.parentElement;
  for (let i = 0; i < 3 && node; i++) {
    if (/cursor-(not-allowed|pointer)/.test(node.className || "") || node.hasAttribute("aria-disabled")) return node;
    node = node.parentElement;
  }
  return icon.parentElement || null;
}

const REFUSE = (reason, extra) => ({ ok: false, reason, ...extra });

function createSendOnce({
  getPage,
  allowed = false,                 // HANYA dari flag baris perintah
  config = {},
  readIdentity,
  checkIdentity,
  maxLength = UI_MAX_LENGTH,
  logger = console,
} = {}) {
  // Hanya boolean true persis yang menyalakan. Nilai truthy lain (string "true",
  // angka, objek) TIDAK cukup: otorisasi harus disengaja, bukan kebetulan.
  const armed = allowed === true;

  // Jatah proses. Sekali menjadi true, tidak pernah kembali false.
  let typeAttemptUsed = false;
  let publishAttemptUsed = false;
  let preparedText = null;         // teks yang sudah terketik & terverifikasi

  const log = (line) => {
    try {
      logger.log(line);
    } catch {
      /* logger rusak tidak boleh menjatuhkan apa pun */
    }
  };

  function status() {
    if (!armed) return "disabled";
    if (publishAttemptUsed) return "used";
    if (typeAttemptUsed) return preparedText === null ? "used" : "typed";
    return "armed";
  }

  async function page() {
    const p = await getPage();
    if (!p) throw new Error("chat-page-unavailable");
    if (typeof p.isClosed === "function" && p.isClosed()) throw new Error("chat-page-closed");
    return p;
  }

  // Gerbang identitas: header akun saja, tidak pernah teks produk.
  async function identityOk(p) {
    const observed = await readIdentity(p);
    const verdict = checkIdentity({
      expected: config.expectedShop,
      observed,
      forbidden: config.forbiddenShops,
    });
    return verdict.ok ? { ok: true, observed } : { ok: false, reason: `identity-${verdict.reason}`, observed };
  }

  // Langkah 1-11: periksa, ketik, verifikasi. BERHENTI SEBELUM KLIK.
  async function prepare({ text, confirm } = {}) {
    if (!armed) return REFUSE("real-comment-send-disabled");
    if (confirm !== true) return REFUSE("confirmation-required");
    if (typeAttemptUsed) return REFUSE("real-comment-send-already-used");

    if (typeof text !== "string" || text.trim() === "") return REFUSE("empty-message");
    if ([...text].length > maxLength) return REFUSE("message-too-long");

    let p;
    try {
      p = await page();
    } catch (err) {
      return REFUSE("chat-page-unavailable", { detail: String(err && err.message).slice(0, 80) });
    }

    const ident = await identityOk(p);
    if (!ident.ok) {
      log(`[AUTOCOMMENT_SEND_REFUSED] reason=${ident.reason} observed="${(ident.observed || []).join(" | ")}"`);
      return REFUSE(ident.reason);
    }

    const sel = { textarea: CHAT_TEXTAREA, publishIcon: PUBLISH_ICON, uiMax: maxLength };
    const before = await p.evaluate(inspectComposerInPage, sel);
    const verdict = decideDryRun(text, before, { uiMax: maxLength });
    if (!verdict.ok) {
      log(`[AUTOCOMMENT_SEND_REFUSED] reason=${verdict.reason}`);
      return REFUSE(verdict.reason, { composer: before });
    }

    // ---- mulai dari sini halaman benar-benar disentuh ----
    // Jatah dipakai SEKARANG, sebelum mutasi pertama: kalau pengetikan gagal di
    // tengah atau hasilnya ambigu, tidak boleh ada percobaan kedua.
    typeAttemptUsed = true;
    log(`[AUTOCOMMENT_SEND_TYPING] shop="${(ident.observed || []).join(" | ")}" chars=${[...text].length}`);

    try {
      await p.focus(CHAT_TEXTAREA);
      // Bersihkan isi lama lewat seleksi + hapus. Mengisi el.value langsung
      // tidak dilihat React, jadi tombol publish-nya tidak akan pernah aktif.
      await p.keyboard.down("Control");
      await p.keyboard.press("KeyA");
      await p.keyboard.up("Control");
      await p.keyboard.press("Backspace");
      // Satu kali ketik. TIDAK ADA Enter: pengiriman hanya boleh lewat klik
      // yang disetujui manusia.
      await p.type(CHAT_TEXTAREA, text, { delay: 25 });
    } catch (err) {
      const detail = String(err && err.message).slice(0, 80);
      log(`[AUTOCOMMENT_SEND_FAILED] stage=type detail=${detail}`);
      return REFUSE("type-failed", { detail });
    }

    const typed = await p.evaluate(readComposerTextInPage, CHAT_TEXTAREA);
    if (typed !== text) {
      log(`[AUTOCOMMENT_SEND_FAILED] stage=verify reason=typed-text-mismatch chars=${typed === null ? "null" : [...typed].length}`);
      return REFUSE("typed-text-mismatch", { typed });
    }

    const after = await p.evaluate(inspectComposerInPage, sel);
    if (!after.foundPublishControl) return REFUSE("publish-control-not-found", { composer: after });
    if (after.publishDisabled) {
      log("[AUTOCOMMENT_SEND_FAILED] stage=verify reason=publish-still-disabled");
      return REFUSE("publish-still-disabled", { composer: after });
    }

    preparedText = text;
    log(`[AUTOCOMMENT_SEND_TYPED] text="${text}" publishEnabled=true clicked=no`);
    return { ok: true, stage: "typed", typed, publishEnabled: true, clicked: false, composer: after };
  }

  // Langkah 10: TEPAT SATU klik, hanya setelah prepare() berhasil dan hanya
  // dengan persetujuan eksplisit lagi.
  async function publish({ confirm } = {}) {
    if (!armed) return REFUSE("real-comment-send-disabled");
    if (confirm !== true) return REFUSE("confirmation-required");
    if (publishAttemptUsed) return REFUSE("real-comment-send-already-used");
    if (preparedText === null) return REFUSE("not-prepared");

    // Jatah klik dipakai sebelum klik dilakukan: hasil apa pun, termasuk
    // error, tidak membuka percobaan kedua.
    publishAttemptUsed = true;

    let p;
    try {
      p = await page();
    } catch (err) {
      return REFUSE("chat-page-unavailable", { detail: String(err && err.message).slice(0, 80) });
    }

    let handle = null;
    try {
      handle = await p.evaluateHandle(resolvePublishElementInPage, PUBLISH_ICON);
      const el = handle && typeof handle.asElement === "function" ? handle.asElement() : null;
      if (!el) return REFUSE("publish-control-not-found");
      await el.click(); // SATU klik. Tidak ada percobaan kedua, tidak ada Enter.
    } catch (err) {
      const detail = String(err && err.message).slice(0, 80);
      log(`[AUTOCOMMENT_SEND_FAILED] stage=click detail=${detail}`);
      return REFUSE("click-failed", { detail });
    } finally {
      if (handle && typeof handle.dispose === "function") {
        try {
          await handle.dispose();
        } catch {
          /* abaikan */
        }
      }
    }

    log(`[AUTOCOMMENT_SEND_CLICKED] text="${preparedText}" clicks=1`);
    // Hasilnya sengaja TIDAK disimpulkan di sini. Apakah pesan benar-benar
    // terkirim hanya bisa dipastikan dari perangkat penonton.
    return { ok: true, stage: "clicked", clicks: 1, sent: "unknown", text: preparedText };
  }

  // Pembacaan sesudah klik: murni membaca, untuk laporan.
  async function observeAfterClick() {
    let p;
    try {
      p = await page();
    } catch (err) {
      return REFUSE("chat-page-unavailable", { detail: String(err && err.message).slice(0, 80) });
    }
    const text = await p.evaluate(readComposerTextInPage, CHAT_TEXTAREA);
    const composer = await p.evaluate(inspectComposerInPage, {
      textarea: CHAT_TEXTAREA, publishIcon: PUBLISH_ICON, uiMax: maxLength,
    });
    return { ok: true, composerCleared: text === "" || text === null, composerText: text, composer };
  }

  return {
    prepare,
    publish,
    observeAfterClick,
    status,
    __state: () => ({ allowed: armed, typeAttemptUsed, publishAttemptUsed, prepared: preparedText !== null }),
  };
}

module.exports = {
  createSendOnce,
  readComposerTextInPage,
  resolvePublishElementInPage,
};
