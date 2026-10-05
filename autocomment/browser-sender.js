"use strict";
// AR3 — pengirim chat yang BISA DIPAKAI BERULANG, tapi berpagar per playId.
//
// Bedanya dengan autocomment/send-once.js (alat diagnostik AR2B yang sengaja
// dibatasi satu kali SEUMUR PROSES): modul ini boleh melayani banyak scene,
// namun tetap memberi jaminan yang sama per pemutaran:
//
//   * satu playId = PALING BANYAK satu kali ketik dan satu kali klik
//   * playId yang sama diminta lagi -> ditolak, tidak pernah mengirim dua kali
//   * playId yang sudah ketinggalan (scene lain sudah mulai) -> ditolak,
//     DIPERIKSA DUA KALI: sebelum mengetik DAN tepat sebelum mengklik
//   * nol retry, nol loop, Enter tidak pernah ditekan
//   * identitas toko harus akun tes; identitas produksi selalu menolak
//   * teks di komposer harus COCOK PERSIS sebelum klik
//   * kontrol kirim harus terbukti enabled sebelum klik
//   * hasil ambigu dilaporkan apa adanya, tidak pernah dicoba ulang
//
// Kalau sebuah permintaan menjadi basi SESUDAH mengetik tapi SEBELUM mengklik,
// teks yang KITA tulis dibersihkan - dan hanya kalau isinya memang persis teks
// itu, supaya ketikan manusia tidak pernah ikut terhapus.

const {
  inspectComposerInPage, decideDryRun,
  CHAT_TEXTAREA, PUBLISH_ICON, UI_MAX_LENGTH, COMPOSER_SCOPE_DEPTH,
} = require("./browser-transport");
const { readComposerTextInPage, resolvePublishElementInPage } = require("./send-once");

// Berapa playId terakhir yang diingat. Cukup untuk satu sesi LIVE (ratusan
// scene) dan tetap terbatas supaya memori tidak tumbuh tanpa batas.
const ATTEMPT_MEMORY = 500;

const REFUSE = (reason, extra) => ({ ok: false, reason, ...extra });

function createBrowserSender({
  getPage,
  allowed = false,              // HANYA dari flag baris perintah service
  config = {},
  readIdentity,
  checkIdentity,
  isStale,                      // (playId) => boolean, generasi scene milik service
  maxLength = UI_MAX_LENGTH,
  logger = console,
} = {}) {
  // Hanya boolean true persis. Nilai truthy lain tidak cukup: otorisasi harus
  // disengaja, bukan kebetulan.
  const armed = allowed === true;
  const attempted = new Set();  // playId yang sudah pernah dicoba

  const log = (line) => {
    try {
      logger.log(line);
    } catch {
      /* logger rusak tidak boleh menjatuhkan apa pun */
    }
  };

  const stale = (playId) => (typeof isStale === "function" ? isStale(playId) === true : false);

  function remember(playId) {
    attempted.add(playId);
    if (attempted.size > ATTEMPT_MEMORY) {
      attempted.delete(attempted.values().next().value);
    }
  }

  const SEL = {
    textarea: CHAT_TEXTAREA,
    publishIcon: PUBLISH_ICON,
    uiMax: maxLength,
    depth: COMPOSER_SCOPE_DEPTH,
  };

  // Membersihkan HANYA teks yang kita tulis sendiri. Kalau isi komposer sudah
  // berbeda (operator mengetik sesuatu), biarkan apa adanya.
  async function clearOwnText(p, expected) {
    try {
      const current = await p.evaluate(readComposerTextInPage, CHAT_TEXTAREA);
      if (current !== expected) return { cleared: false, reason: "not-ours" };
      await p.focus(CHAT_TEXTAREA);
      await p.keyboard.down("Control");
      await p.keyboard.press("KeyA");
      await p.keyboard.up("Control");
      await p.keyboard.press("Backspace");
      const after = await p.evaluate(readComposerTextInPage, CHAT_TEXTAREA);
      return { cleared: after === "" || after === null };
    } catch (err) {
      return { cleared: false, reason: String(err && err.message).slice(0, 60) };
    }
  }

  async function send({ text, scene, playId }) {
    if (!armed) return REFUSE("real-comment-send-disabled");

    const id = Number.isFinite(playId) ? playId : null;
    if (id === null) return REFUSE("play-id-required");
    if (attempted.has(id)) {
      log(`[AUTOCOMMENT_SEND_SKIPPED] scene=${scene} playId=${id} reason=duplicate-play-id`);
      return REFUSE("duplicate-play-id");
    }
    if (typeof text !== "string" || text.trim() === "") return REFUSE("empty-message");
    // Satuan UTF-16, menyamai penghitung TikTok.
    if (text.length > maxLength) return REFUSE("message-too-long");

    // Gerbang basi #1: sebelum menyentuh apa pun.
    if (stale(id)) {
      log(`[AUTOCOMMENT_SEND_STALE] scene=${scene} playId=${id} phase=before-type`);
      return REFUSE("stale");
    }

    let p;
    try {
      p = await getPage();
      if (!p) throw new Error("chat-page-unavailable");
      if (typeof p.isClosed === "function" && p.isClosed()) throw new Error("chat-page-closed");
    } catch (err) {
      return REFUSE("chat-page-unavailable", { detail: String(err && err.message).slice(0, 80) });
    }

    // Identitas: header akun saja, tidak pernah teks produk.
    const observed = await readIdentity(p);
    const verdict = checkIdentity({
      expected: config.expectedShop,
      observed,
      forbidden: config.forbiddenShops,
    });
    if (!verdict.ok) {
      log(`[AUTOCOMMENT_SEND_REFUSED] scene=${scene} playId=${id} reason=identity-${verdict.reason}`);
      return REFUSE(`identity-${verdict.reason}`);
    }

    const before = await p.evaluate(inspectComposerInPage, SEL);
    const ready = decideDryRun(text, before, { uiMax: maxLength });
    if (!ready.ok) {
      log(`[AUTOCOMMENT_SEND_REFUSED] scene=${scene} playId=${id} reason=${ready.reason}`);
      return REFUSE(ready.reason, { composer: before });
    }

    // ---- mulai dari sini halaman benar-benar disentuh ----
    // Jatah playId dipakai SEKARANG: hasil setengah jadi atau ambigu pun tidak
    // boleh membuka percobaan kedua.
    remember(id);
    log(`[AUTOCOMMENT_SEND_TYPING] scene=${scene} playId=${id} shop="${(observed || []).join(" | ")}" chars=${text.length}`);

    try {
      await p.focus(CHAT_TEXTAREA);
      // Bersihkan isi lama lewat seleksi + hapus. Mengisi el.value langsung
      // tidak dilihat React, sehingga tombol kirim tidak akan pernah aktif.
      await p.keyboard.down("Control");
      await p.keyboard.press("KeyA");
      await p.keyboard.up("Control");
      await p.keyboard.press("Backspace");
      // Satu kali ketik. TIDAK ADA Enter: pengiriman hanya lewat klik.
      await p.type(CHAT_TEXTAREA, text, { delay: 25 });
    } catch (err) {
      const detail = String(err && err.message).slice(0, 80);
      log(`[AUTOCOMMENT_SEND_FAILED] scene=${scene} playId=${id} stage=type detail=${detail}`);
      return REFUSE("type-failed", { detail });
    }

    const typed = await p.evaluate(readComposerTextInPage, CHAT_TEXTAREA);
    if (typed !== text) {
      log(`[AUTOCOMMENT_SEND_FAILED] scene=${scene} playId=${id} stage=verify reason=typed-text-mismatch`);
      return REFUSE("typed-text-mismatch", { typed });
    }

    const after = await p.evaluate(inspectComposerInPage, SEL);
    if (!after.foundPublishControl) return REFUSE("publish-control-not-found", { composer: after });
    if (after.publishDisabled) {
      log(`[AUTOCOMMENT_SEND_FAILED] scene=${scene} playId=${id} stage=verify reason=publish-still-disabled`);
      return REFUSE("publish-still-disabled", { composer: after });
    }

    // Gerbang basi #2: tepat sebelum klik. Scene bisa berganti selama mengetik,
    // dan pesan scene lama TIDAK BOLEH muncul setelah scene baru mengambil alih.
    if (stale(id)) {
      const cleanup = await clearOwnText(p, text);
      log(`[AUTOCOMMENT_SEND_STALE] scene=${scene} playId=${id} phase=before-click cleared=${cleanup.cleared}`);
      return REFUSE("stale", { clicked: false, cleared: cleanup.cleared });
    }

    let handle = null;
    try {
      handle = await p.evaluateHandle(resolvePublishElementInPage, {
        textarea: CHAT_TEXTAREA, publishIcon: PUBLISH_ICON, depth: COMPOSER_SCOPE_DEPTH,
      });
      const el = handle && typeof handle.asElement === "function" ? handle.asElement() : null;
      if (!el) return REFUSE("publish-control-not-found");
      await el.click(); // SATU klik. Tanpa retry, tanpa Enter, tanpa klik kedua.
    } catch (err) {
      const detail = String(err && err.message).slice(0, 80);
      log(`[AUTOCOMMENT_SEND_FAILED] scene=${scene} playId=${id} stage=click detail=${detail}`);
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

    // Bacaan sesudah klik: komposer yang kembali kosong adalah sinyal kuat, tapi
    // bukan bukti sampai ke penonton. Karena itu sent tetap "unknown".
    let composerCleared = null;
    try {
      const left = await p.evaluate(readComposerTextInPage, CHAT_TEXTAREA);
      composerCleared = left === "" || left === null;
    } catch {
      composerCleared = null;
    }

    log(`[AUTOCOMMENT_SEND_CLICKED] scene=${scene} playId=${id} clicks=1 composerCleared=${composerCleared}`);
    return { ok: true, reason: "clicked", clicks: 1, sent: "unknown", text, composerCleared };
  }

  return {
    send,
    __state: () => ({ allowed: armed, attempts: attempted.size }),
  };
}

module.exports = { createBrowserSender, ATTEMPT_MEMORY };
