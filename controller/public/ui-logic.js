/* AI LIVE HOST — logika dashboard. MURNI, tanpa DOM.
 *
 * Setiap KEPUTUSAN tampilan ada di berkas ini: apa yang muncul di dropdown,
 * tombol mana yang boleh ditekan, kalimat mana yang tampil, dan berapa banyak
 * kejadian yang ditahan. app.js hanya memetakan hasilnya ke DOM dan tidak
 * mengambil keputusan apa pun.
 *
 * Pemisahan itu bukan selera: tanpa jsdom di repo ini, satu-satunya cara menguji
 * perilaku UI dengan sungguhan adalah membuat perilakunya hidup di tempat yang
 * bisa dipanggil langsung dari Node. Logika yang bersembunyi di dalam handler DOM
 * adalah logika yang tidak pernah diuji.
 *
 * Berkas ini dimuat dua cara, dan harus bekerja di keduanya:
 *   browser  <script src="ui-logic.js">  -> window.AiLiveUI
 *   node     require(".../ui-logic.js")  -> module.exports
 *
 * Satu aturan yang dipegang di sini: KALIMAT UNTUK CUSTOMER TIDAK DIBENTUK DI
 * SINI. Server yang mengirimnya (userMessage), karena katalog kode -> kalimat ada
 * di controller/errors.js. Menyalin katalog itu ke frontend akan mengulang
 * kesalahan yang sudah terjadi di P2, ketika salinan normalizeTitleKey menyimpang
 * dari aslinya dan membuat Controller mengatakan hal yang tidak benar.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./i18n.js"));
  else root.AiLiveUI = factory(root.AiLiveI18N);
})(typeof self !== "undefined" ? self : this, function (I18N) {
  "use strict";

  // SETIAP kalimat customer datang dari i18n.js. Tidak ada satu pun literal
  // bahasa di berkas ini, dan tidak ada di app.js - itulah gunanya modul kamus.
  //
  // Kenapa fungsi di sini menerima `lang` dan bukan mengembalikan kunci mentah:
  // kalau app.js yang menerima kunci, ia harus memanggil t() di puluhan tempat,
  // dan SATU yang terlewat akan menampilkan "ui.row.connected" ke customer.
  // Dengan lang, satu-satunya cara gagal adalah lupa meneruskannya - dan itu
  // jatuh ke bahasa Indonesia, bawaan yang aman, bukan kunci mentah.
  function tr(lang, key, vars) {
    return I18N.t(lang || I18N.DEFAULT_LANG, key, vars);
  }

  // Scene etalase. Hanya PAX-1..PAX-10 yang punya saran otomatis, sejalan dengan
  // autocomment/formatter.js yang juga hanya mengenal nomor 1..10.
  var PAX_RE = /^PAX-(\d{1,2})$/;

  var MAX_ACTIVITY_ITEMS = 50;

  // State automation yang dikenal, dari controller/state-machine.js.
  var STATES = {
    STOPPED: "STOPPED",
    PREFLIGHT: "PREFLIGHT",
    STARTING: "STARTING",
    RUNNING: "RUNNING",
    DEGRADED: "DEGRADED",
    STOPPING: "STOPPING",
    ERROR: "ERROR",
  };

  // Satu kalimat untuk "halaman tidak bisa bicara dengan aplikasinya", dipakai
  // di tiga tempat: hint Settings, hint Pemetaan, dan sebab START ditolak.
  // Dulu tiga salinan literal yang menyebut "Controller" - nama komponen yang
  // tidak pernah muncul di layar mana pun. Sekarang satu kunci.
  var BACKEND_DOWN_KEY = "ui.banner.offline";

  // Nada warna. Dipakai sebagai nama kelas CSS; artinya tetap di satu tempat.
  var TONE = { READY: "ready", RUNNING: "running", ATTENTION: "attention", ERROR: "error", NEUTRAL: "neutral" };

  // ---------------------------------------------------------------------------
  // Saran PAX
  // ---------------------------------------------------------------------------

  function paxNumber(scene) {
    var m = PAX_RE.exec(String(scene || "").trim());
    if (!m) return null;
    var n = Number(m[1]);
    return n >= 1 && n <= 10 ? n : null;
  }

  // Saran untuk scene etalase, atau null kalau scene-nya bukan PAX-1..10.
  function suggestForScene(scene) {
    var n = paxNumber(scene);
    if (n === null) return null;
    return {
      trigger: "spill etalase " + n,
      reply: "Etalase " + n + " sudah aku pin ya kak",
    };
  }

  function isBlank(v) {
    return v === undefined || v === null || String(v).trim() === "";
  }

  // Mengisi trigger/reply HANYA kalau keduanya masih kosong.
  //
  // Tidak pernah menimpa teks yang sudah disunting operator. Saran yang menimpa
  // tulisan orang adalah cara tercepat membuat orang berhenti mempercayai
  // formulir — dan di sini teks itu adalah kalimat yang akan dibaca penonton.
  function applySuggestion(row, scene) {
    var next = { trigger: row && row.trigger, reply: row && row.reply };
    var s = suggestForScene(scene);
    if (!s) return next;
    if (isBlank(next.trigger)) next.trigger = s.trigger;
    if (isBlank(next.reply)) next.reply = s.reply;
    return next;
  }

  // ---------------------------------------------------------------------------
  // Pilihan dropdown
  // ---------------------------------------------------------------------------

  // Scene dari discovery OBS. SEMUA scene ditampilkan, termasuk yang belum punya
  // definisi pemutaran — tapi yang belum punya ditandai, bukan disembunyikan.
  // Menyembunyikannya membuat operator mencari scene yang ia tahu ada di OBS dan
  // tidak menemukannya, tanpa penjelasan apa pun.
  function sceneOptions(scenes, opts, lang) {
    var playable = opts && Array.isArray(opts.playableScenes) ? opts.playableScenes : null;
    var list = Array.isArray(scenes) ? scenes : [];
    return list.map(function (name) {
      var supported = playable === null ? true : playable.indexOf(name) !== -1;
      return {
        value: name,
        label: name,
        supported: supported,
        // Kalimatnya tetap dari server lewat validasi; ini hanya penanda ringkas
        // di dalam dropdown.
        note: supported ? "" : tr(lang, "ui.rule.f.sceneNotPlayable"),
      };
    });
  }

  // Label produk: nomor posisi + judul. Nomor ikut karena operator melihatnya di
  // dashboard LIVE dan memakainya untuk mencocokkan dengan mata.
  function productLabel(p) {
    if (!p) return "";
    var n = p.number === null || p.number === undefined ? "" : "#" + p.number + " — ";
    return n + String(p.title || "");
  }

  // Baris kedua: harga dan stok kalau ada. Tidak pernah kelas DOM, selector,
  // maupun apa pun dari struktur internal halaman TikTok.
  function productSubLabel(p, lang) {
    if (!p) return "";
    var parts = [];
    if (!isBlank(p.price)) parts.push(String(p.price));
    if (!isBlank(p.stock)) parts.push(String(p.stock));
    if (p.pinAvailable === false) parts.push(tr(lang, "ui.rule.f.pinUnavailable"));
    return parts.join(" · ");
  }

  function productOptions(products, lang) {
    var list = Array.isArray(products) ? products : [];
    return list.map(function (p) {
      return {
        value: String(p.title || ""),
        label: productLabel(p),
        sub: productSubLabel(p, lang),
        number: p.number === undefined ? null : p.number,
        pinAvailable: p.pinAvailable !== false,
      };
    });
  }

  // Opsi tambahan untuk nilai tersimpan yang BUKAN salah satu judul di katalog.
  //
  // Fungsi ini TIDAK memutuskan apakah produknya masih ada di LIVE. Ia hanya
  // menjawab satu pertanyaan DOM: `<select>` hanya bisa menampilkan nilai yang
  // punya `<option>` dengan value yang sama persis, jadi nilai tersimpan yang
  // tidak ada di daftar butuh opsinya sendiri supaya tidak hilang dari formulir.
  //
  // Kenapa tidak mencocokkan sendiri: percobaan pertama di sini membandingkan
  // judul dengan lowercase + substring, dan itu LANGSUNG menyimpang dari
  // resolveProductForPin di backend — yang juga mengubah setiap karakter bukan
  // alfanumerik jadi spasi, sehingga "O'CORN" menjadi "o corn". Akibatnya UI
  // menyatakan produk hilang padahal jalur pin menemukannya.
  //
  // Itu bentuk kesalahan yang sama dengan salinan normalizeTitleKey di P2. Jadi
  // keputusan "produk ini ada atau tidak" tetap milik server, lewat
  // POST /api/mappings/validate, dan ditampilkan sebagai pesan per baris.
  function extraProductOption(savedTitle, products, resolvedTitle) {
    if (isBlank(savedTitle)) return null;
    var list = Array.isArray(products) ? products : [];
    var exact = list.some(function (p) {
      return String(p.title || "") === String(savedTitle);
    });
    if (exact) return null;
    return {
      value: savedTitle,
      label: savedTitle,
      // Kalau server sudah memberi tahu judul mana yang sesungguhnya terpilih,
      // itu yang ditampilkan — bukan dugaan kita sendiri.
      resolved: isBlank(resolvedTitle) ? null : String(resolvedTitle),
    };
  }

  // ---------------------------------------------------------------------------
  // Kesiapan
  // ---------------------------------------------------------------------------

  function tri(okValue, tone) {
    return okValue ? tone || TONE.READY : TONE.ATTENTION;
  }

  // Baris-baris panel kesiapan. Bentuknya tetap: UI tidak perlu menebak baris
  // mana yang ada, dan baris yang belum diketahui berkata "Checking…" daripada
  // berpura-pura hijau.
  function readinessRows(data, lang) {
    var obs = (data && data.obs) || null;
    var tiktok = (data && data.tiktok) || null;
    var status = (data && data.status) || null;
    var validation = (data && data.validation) || null;

    // Datum yang belum ada punya DUA sebab yang berbeda, dan keduanya tidak
    // boleh berbunyi sama.
    //
    // Saat berhenti, ia memang sedang dibaca: "Memeriksa..." benar. Saat
    // BERJALAN, service memegang profil Chrome dan discovery tidak dijalankan
    // sama sekali - jadi "Memeriksa..." adalah pernyataan yang salah yang
    // bertahan di layar sepanjang LIVE, dan operator menunggu sesuatu yang
    // tidak akan pernah datang.
    var s = status ? status.automation : null;
    var busyRunning = s === STATES.RUNNING || s === STATES.DEGRADED;
    function unknown(labelKey) {
      return {
        label: tr(lang, labelKey),
        value: tr(lang, busyRunning ? "ui.row.cannotCheck" : "ui.state.checking"),
        tone: TONE.NEUTRAL,
      };
    }

    var rows = [];

    // Automation DULU, bukan terakhir.
    //
    // Sampai 2026-10-09 baris ini ada di PALING BAWAH, di bawah lima baris yang
    // semuanya hijau. Kartu yang dibaca dari atas berbunyi "tersambung, on air,
    // produk tersedia, pemetaan siap" — dan operator membacanya sebagai "bot
    // sedang bekerja", padahal belum ada apa pun yang jalan. Keadaan JALAN atau
    // TIDAK adalah hal pertama yang perlu ia tahu, jadi ia dibaca pertama.
    rows.push({
      label: tr(lang, "ui.row.automation"),
      value: automationLabel(status, lang),
      tone: automationTone(status),
    });

    // OBS
    if (!obs) rows.push(unknown("ui.row.obs"));
    else if (obs.ok) rows.push({ label: tr(lang, "ui.row.obs"), value: tr(lang, "ui.row.connected"), tone: TONE.READY });
    else rows.push({ label: tr(lang, "ui.row.obs"), value: messageOf(lang, obs, "ui.row.notConnected"), tone: TONE.ATTENTION });

    // TikTok
    // Identitasnya SENGAJA tidak diulang di sini: baris "TikTok sign-in" di
    // bawah sudah menyebutkannya, dan dua baris berbunyi "Connected as X" membuat
    // operator mengira ia membaca dua hal padahal satu.
    if (!tiktok) rows.push(unknown("ui.row.tiktok"));
    else if (tiktok.ok) rows.push({ label: tr(lang, "ui.row.tiktok"), value: tr(lang, "ui.row.connected"), tone: TONE.READY });
    else rows.push({ label: tr(lang, "ui.row.tiktok"), value: messageOf(lang, tiktok, "ui.row.notConnected"), tone: TONE.ATTENTION });

    // LIVE
    //
    // "On air", bukan "Active": kata "active" dipakai orang untuk bot yang
    // sedang bekerja, sedangkan baris ini hanya berbicara soal siarannya.
    if (!tiktok) rows.push(unknown("ui.row.live"));
    else if (!tiktok.ok) rows.push({ label: tr(lang, "ui.row.live"), value: tr(lang, "ui.row.cannotCheck"), tone: TONE.NEUTRAL });
    else rows.push(tiktok.live
      ? { label: tr(lang, "ui.row.live"), value: tr(lang, "ui.row.onair"), tone: TONE.READY }
      : { label: tr(lang, "ui.row.live"), value: tr(lang, "ui.row.notOnair"), tone: TONE.ATTENTION });

    // Produk
    //
    // "available", bukan "detected": yang kedua adalah bahasa alat ukur, dan
    // tidak memberi tahu apa pun tentang apa yang bisa dilakukan dengannya.
    if (!tiktok) rows.push(unknown("ui.row.products"));
    else if (typeof tiktok.productCount === "number") {
      rows.push(tiktok.productCount > 0
        ? { label: tr(lang, "ui.row.products"), value: tr(lang, "ui.row.productsAvailable", { n: tiktok.productCount }), tone: TONE.READY }
        : { label: tr(lang, "ui.row.products"), value: tr(lang, "ui.row.productsNone"), tone: TONE.ATTENTION });
    } else rows.push({ label: tr(lang, "ui.row.products"), value: tr(lang, "ui.row.cannotCheck"), tone: TONE.NEUTRAL });

    // Pemetaan
    if (!validation) rows.push(unknown("ui.row.mappings"));
    else if (validation.ok) {
      var n = Array.isArray(validation.mappings) ? validation.mappings.length : 0;
      // Kalimatnya netral-angka di setiap bahasa: bentuk jamak tidak dihitung
      // di sini, karena Indonesia dan Mandarin tidak menandainya dan Inggris
      // sudah ditulis supaya benar pada angka berapa pun.
      rows.push({ label: tr(lang, "ui.row.mappings"), value: tr(lang, "ui.row.mappingsOk", { n: n }), tone: TONE.READY });
    } else {
      var bad = Array.isArray(validation.mappings) ? validation.mappings.filter(notOk).length : 0;
      rows.push({
        label: tr(lang, "ui.row.mappings"),
        value: bad > 0
          ? tr(lang, "ui.row.mappingsBad", { n: bad })
          : messageOf(lang, validation, "ui.row.needsAttention"),
        tone: TONE.ATTENTION,
      });
    }

    // Akun TikTok: keadaan login, terpisah dari "TikTok terhubung".
    var lv = loginView(data, lang);
    rows.push({ label: tr(lang, "ui.row.signin"), value: lv.label, tone: lv.tone });

    return rows;
  }

  // Satu kalimat di kepala kartu kesiapan, dan ia BERBEDA menurut keadaan.
  //
  // Sebelumnya tempat ini hanya pernah berisi satu kalimat soal discovery, dan
  // kosong selebihnya — jadi kartu berisi enam baris hijau tanpa satu pun kata
  // yang memberi tahu bahwa belum ada apa pun yang berjalan.
  function readinessHint(view, lang) {
    var status = (view && view.status) || null;
    if (!status) return "";
    switch (status.automation) {
      case STATES.STOPPED:
        return tr(lang, "ui.ready.hint.stopped");
      // ERROR TIDAK boleh ikut kalimat di atas. Baris teratas kartu ini sedang
      // menampilkan sebab kegagalannya; "nothing is running YET" di sebelahnya
      // membuat run yang mati terbaca seperti mesin yang belum pernah dipakai,
      // dan operator menekan START BOT tanpa membaca pesannya.
      case STATES.ERROR:
        return tr(lang, "ui.ready.hint.error");
      case STATES.RUNNING:
      case STATES.DEGRADED:
        return tr(lang, "ui.ready.hint.running");
      default:
        return "";
    }
  }

  function notOk(row) {
    return !row || row.ok !== true;
  }

  // Kalimat untuk sebuah hasil dari server.
  //
  // Server mengirim KODE bersama kalimatnya (withUserMessage memakai
  // Object.assign, jadi `reason` tetap ada; translate() mengembalikan
  // {code, userMessage}). Jadi kode itu yang dipakai mencari terjemahan, dan
  // kalimat server hanya jaring kalau kodenya belum dikenal kamus.
  //
  // Urutannya: kamus[bahasa][kode] -> userMessage server -> kalimat cadangan.
  // Kode mesin tidak pernah ditampilkan.
  function messageOf(lang, obj, fallbackKey) {
    if (!obj) return tr(lang, fallbackKey);
    var err = obj.error || null;
    var code = obj.reason || obj.code || (err && (err.reason || err.code)) || "";
    var server = obj.userMessage || (err && err.userMessage) || "";
    // Kode yang DIKENAL kamus menang; kode yang belum dikenal jatuh ke kalimat
    // server; dan kalau server pun diam, yang dipakai adalah kalimat cadangan
    // yang DIMINTA PEMANGGIL - bukan "terjadi masalah tak dikenal", karena
    // pemanggil tahu konteksnya dan kalimat umum menghapus konteks itu.
    if (code && I18N.DICT[I18N.normalizeLang(lang)]["err." + code] !== undefined) {
      return I18N.fromServer(lang, code, server);
    }
    if (server) return String(server);
    return tr(lang, fallbackKey);
  }

  function automationLabel(status, lang) {
    if (!status) return tr(lang, "ui.state.checking");
    switch (status.automation) {
      case STATES.STOPPED: return tr(lang, "ui.state.stopped");
      case STATES.PREFLIGHT: return tr(lang, "ui.state.preflight");
      case STATES.STARTING: return tr(lang, "ui.state.starting");
      case STATES.RUNNING: return tr(lang, "ui.state.running");
      case STATES.DEGRADED: return tr(lang, "ui.state.degraded");
      case STATES.STOPPING: return tr(lang, "ui.state.stopping");
      case STATES.ERROR: return messageOf(lang, status.lastError, "ui.state.error");
      default: return tr(lang, "ui.state.unknown");
    }
  }

  function automationTone(status) {
    if (!status) return TONE.NEUTRAL;
    switch (status.automation) {
      case STATES.RUNNING: return TONE.RUNNING;
      case STATES.DEGRADED: return TONE.ATTENTION;
      case STATES.ERROR: return TONE.ERROR;
      case STATES.STARTING:
      case STATES.PREFLIGHT:
      case STATES.STOPPING: return TONE.ATTENTION;
      default: return TONE.NEUTRAL;
    }
  }


  // ---------------------------------------------------------------------------
  // Login TikTok
  // ---------------------------------------------------------------------------

  // Satu tempat yang memutuskan bagaimana bagian "TikTok Account" tampil.
  //
  // Tiga keadaan, dan tombolnya berbeda di tiap keadaan. `identity` yang
  // ditampilkan adalah nama akun yang TERBUKTI dibaca dari halaman — bukan nilai
  // yang ditulis customer di config, karena yang kedua hanya harapan.
  function loginView(view, lang) {
    var status = (view && view.status) || null;
    var login = status && status.login ? status.login : null;
    var tiktok = (view && view.tiktok) || null;
    var busy = !!(view && view.busy);
    var automation = status ? status.automation : null;
    var stopped = automation === STATES.STOPPED || automation === STATES.ERROR;

    if (!status) {
      return { state: "unknown", label: tr(lang, "ui.state.checking"), tone: TONE.NEUTRAL, identity: "", canLogin: false, canCheck: false, canCancel: false, hint: "" };
    }

    if (login && login.active) {
      return {
        state: "waiting",
        label: tr(lang, "ui.login.waiting"),
        tone: TONE.ATTENTION,
        identity: "",
        canLogin: false,
        canCheck: !busy,
        canCancel: !busy,
        hint: tr(lang, "ui.login.hintWaiting"),
      };
    }

    // Identitas yang terbukti: dari login yang berhasil, atau dari discovery yang
    // berhasil membaca halaman dashboard.
    var identity = (login && login.identity) || (tiktok && tiktok.ok && tiktok.identity) || null;
    if (identity) {
      return {
        state: "connected",
        // Nama akun adalah milik customer: ia masuk sebagai nilai, bukan
        // diterjemahkan.
        label: tr(lang, "ui.login.signedIn", { name: identity }),
        tone: TONE.READY,
        identity: String(identity),
        canLogin: stopped && !busy && !(status.config && status.config.present === false),
        canCheck: false,
        canCancel: false,
        hint: "",
      };
    }

    // Login butuh expectedShop untuk memeriksa akun yang masuk. Tanpa config, ia
    // pasti gagal dengan expected-shop-not-configured — jadi tombolnya tidak boleh
    // mengundang klik itu.
    var noConfig = !!(status.config && status.config.present === false);

    return {
      state: "signed-out",
      label: tr(lang, "ui.login.none"),
      tone: TONE.ATTENTION,
      identity: "",
      // Login hanya saat berhenti: service memegang profil Chrome saat berjalan.
      canLogin: stopped && !busy && !noConfig,
      canCheck: false,
      canCancel: false,
      hint: noConfig ? tr(lang, "ui.login.hintSaveFirst") : stopped ? "" : tr(lang, "ui.login.hintStopFirst"),
    };
  }

  // ---------------------------------------------------------------------------
  // Settings (P4.1)
  // ---------------------------------------------------------------------------

  // Batas port. Nilainya sengaja sama dengan validator di
  // controller/config-manager.js, dan ada tes kontrak yang membandingkan
  // penerimaan/penolakan keduanya pada nilai batas (1, 65535, 0, 65536) — supaya
  // kalau salah satu berubah, yang merah adalah tesnya, bukan LIVE.
  var PORT_MIN = 1;
  var PORT_MAX = 65535;

  // Config -> bentuk formulir.
  //
  // Password OBS TIDAK PERNAH ikut: server hanya mengirim `passwordSet` (lihat
  // redactConfig). Formulir cukup tahu "sudah diisi atau belum", bukan isinya.
  // Nilai yang tidak pernah sampai ke halaman tidak bisa bocor dari halaman.
  // Pemetaan field formulir <-> id node. SATU sumber, dipakai app.js (untuk
  // cacheEls, membaca, dan merender) dan dipakai tes (dengan node palsu).
  //
  // Ada di modul MURNI ini, bukan di app.js, karena repo ini tidak punya jsdom:
  // satu-satunya cara menguji interaksi klik yang SUNGGUHAN adalah dengan
  // menjalankan fungsi yang sama atas node palsu. Tes yang hanya mencocokkan
  // teks sumber app.js tidak akan pernah menangkap bug urutan — dan bug urutan
  // itulah yang terjadi pada 2026-10-08.
  var SETTINGS_FIELD_IDS = [
    ["tiktokUsername", "set-tiktok-username"],
    ["expectedShop", "set-expected-shop"],
    ["obsHost", "set-obs-host"],
    ["obsPort", "set-obs-port"],
  ];

  var SETTINGS_TOGGLE_IDS = [
    ["autoPinProduct", "set-auto-pin"],
    ["sendAdminReply", "set-admin-reply"],
  ];

  // DOM -> formulir. `get(id)` mengembalikan node atau null.
  //
  // `prev` dipertahankan untuk field yang tidak diurus formulir ini (mis.
  // obsPasswordSet, penanda buatan server).
  function readSettingsNodes(get, prev, changingPassword) {
    var f = Object.assign({}, prev || {});

    SETTINGS_FIELD_IDS.forEach(function (pair) {
      var n = get(pair[1]);
      f[pair[0]] = n ? n.value : "";
    });

    // Saklar: ketiadaan node diperlakukan sebagai MATI, bukan sebagai menyala.
    SETTINGS_TOGGLE_IDS.forEach(function (pair) {
      var n = get(pair[1]);
      f[pair[0]] = n ? n.checked === true : false;
    });

    // Password hanya dibaca kalau customer memang sedang menggantinya.
    var pw = get("set-obs-password");
    f.obsPassword = changingPassword && pw ? pw.value : "";
    f.obsPasswordClear = changingPassword && f.obsPassword === "" ? true : false;
    return f;
  }

  // Formulir -> DOM. Hanya NILAI; keadaan terkunci diurus di tempat lain.
  //
  // `isFocused(id)` menjaga kotak yang sedang diketik customer: polling tidak
  // boleh memindahkan kursor atau menghapus ketikan. Checkbox tidak punya kursor,
  // jadi ia tidak butuh penjagaan itu — yang menjaganya adalah bahwa `form`
  // SUDAH disinkronkan dari DOM sebelum render dipanggil.
  function writeSettingsNodes(get, form, isFocused) {
    var f = form || {};

    SETTINGS_FIELD_IDS.forEach(function (pair) {
      var n = get(pair[1]);
      if (!n) return;
      if (isFocused && isFocused(pair[1])) return;
      n.value = f[pair[0]] === undefined ? "" : String(f[pair[0]]);
    });

    SETTINGS_TOGGLE_IDS.forEach(function (pair) {
      var n = get(pair[1]);
      if (n) n.checked = f[pair[0]] === true;
    });
  }

  function settingsToForm(config) {
    var c = config || {};
    var obs = c.obs || {};
    var st = c.settings || {};
    return {
      tiktokUsername: (c.tiktok && c.tiktok.username) || "",
      expectedShop: st.expectedShop || "",
      obsHost: obs.host || "",
      obsPort: obs.port === undefined || obs.port === null ? "" : String(obs.port),
      // Dua saklar yang menentukan apakah run melakukan AKSI NYATA.
      //
      // Sengaja dinamai dari sudut pandang customer, bukan dari nama field
      // config. Yang ia putuskan adalah "pin produknya" dan "balas di chat";
      // bahwa itu berarti autopinEnabled / autoCommentEnabled+transport adalah
      // urusan applySettingsToConfig, bukan urusannya.
      autoPinProduct: st.autopinEnabled === true,
      sendAdminReply: st.autoCommentEnabled === true,
      obsPasswordSet: obs.passwordSet === true,
      // Password BARU yang sedang diketik. Kosong = jangan diubah.
      obsPassword: "",
      // true hanya kalau customer sengaja memilih mengosongkan password.
      obsPasswordClear: false,
    };
  }

  // Validasi formulir.
  //
  // Lebih KETAT daripada skema config, dan itu disengaja. Skema harus tetap
  // menerima `tiktok.username: ""` karena defaultConfig() memakainya — kalau skema
  // mewajibkan non-empty, config bawaan menjadi tidak valid dan Controller tidak
  // bisa memberi UI titik awal apa pun.
  //
  // Pembagiannya: skema menjaga BENTUK, formulir menjaga KELENGKAPAN, preflight
  // menjaga KESIAPAN. Server tetap yang berwenang — pesan per field darinya
  // ditampilkan apa adanya kalau ia menolak.
  function validateSettingsForm(form, lang) {
    var f = form || {};
    var errors = {};

    if (isBlank(f.tiktokUsername)) {
      errors.tiktokUsername = tr(lang, "ui.valid.username");
    }
    if (isBlank(f.expectedShop)) {
      errors.expectedShop = tr(lang, "ui.valid.shop");
    }
    if (isBlank(f.obsHost)) {
      errors.obsHost = tr(lang, "ui.valid.host");
    }

    var portRaw = String(f.obsPort === undefined || f.obsPort === null ? "" : f.obsPort).trim();
    if (portRaw === "") {
      errors.obsPort = tr(lang, "ui.valid.port");
    } else if (!/^[0-9]+$/.test(portRaw)) {
      errors.obsPort = tr(lang, "ui.valid.portNumber");
    } else {
      var port = Number(portRaw);
      if (port < PORT_MIN || port > PORT_MAX) {
        errors.obsPort = tr(lang, "ui.valid.portRange", { min: PORT_MIN, max: PORT_MAX });
      }
    }

    // Password OBS OPSIONAL: OBS bisa dijalankan tanpa autentikasi, dan memaksa
    // password di sini akan menolak konfigurasi OBS yang sah.

    // Balasan admin hanya dikirim SESUDAH sebuah produk terkonfirmasi ter-pin —
    // itu seluruh dasar AR3. Jadi menyalakannya tanpa pin menjanjikan sesuatu
    // yang tidak pernah bisa terjadi, dan ditolak di sini supaya customer tahu
    // SAAT MENYIMPAN, bukan nanti saat START BOT mati tanpa ia mengerti kenapa.
    if (f.sendAdminReply === true && f.autoPinProduct !== true) {
      errors.sendAdminReply = tr(lang, "ui.valid.replyNeedsPin");
    }

    var keys = Object.keys(errors);
    return { ok: keys.length === 0, errors: errors, fields: keys };
  }

  // Formulir -> potongan config. Hanya field yang diurus formulir ini yang
  // disentuh; sisanya (gerbang AutoPIN/AutoComment, batas waktu, direktori)
  // dibiarkan apa adanya.
  function applySettingsToConfig(base, form) {
    if (!base) return null;
    var next = JSON.parse(JSON.stringify(base));
    var f = form || {};

    next.tiktok = next.tiktok || {};
    next.tiktok.username = String(f.tiktokUsername || "").trim();

    next.settings = next.settings || {};
    next.settings.expectedShop = String(f.expectedShop || "").trim();

    // Dua saklar -> tiga field. Istilah "dry-run" dan "browser" TIDAK PERNAH
    // sampai ke customer: ia memilih "balas di chat atau tidak", dan di sinilah
    // pilihan itu diterjemahkan menjadi jalur kirim yang sungguhan.
    //
    // Saat balasan dimatikan, transport dikembalikan ke nilai yang AMAN, bukan
    // dibiarkan apa adanya. Transport "browser" yang tertinggal dari pengaturan
    // sebelumnya tidak berbahaya hari ini (autoCommentEnabled=false sudah
    // menutup jalurnya), tapi ia membuat config membaca seolah jalur kirim
    // nyata masih menyala — dan config yang membaca salah akan dipercaya salah.
    next.settings.autopinEnabled = f.autoPinProduct === true;
    next.settings.autoCommentEnabled = f.sendAdminReply === true;
    next.settings.autoCommentTransport = f.sendAdminReply === true ? "browser" : "dry-run";

    next.obs = next.obs || {};
    next.obs.host = String(f.obsHost || "").trim();
    next.obs.port = Number(String(f.obsPort).trim());

    // passwordSet adalah penanda buatan server, bukan field config. Mengirimnya
    // kembali hanya akan ditolak validator.
    delete next.obs.passwordSet;
    delete next.obs.password;

    var typed = String(f.obsPassword || "");
    if (f.obsPasswordClear === true) {
      // Dikosongkan dengan sengaja.
      next.obs.password = "";
    } else if (typed !== "") {
      next.obs.password = typed;
    }
    // Kalau keduanya tidak ada, field password SENGAJA tidak dikirim: backend
    // memperlakukan password yang tidak dikirim sebagai "jangan diubah"
    // (mergeSecrets). Itulah yang membuat password tidak perlu pernah kembali ke
    // halaman.

    return next;
  }

  // Apakah bagian Settings perlu terbuka, dan apakah ia boleh disunting.
  // Kenapa Settings tidak bisa disunting, kalau memang tidak bisa.
  //
  // Dulu SATU kalimat dipakai untuk semua sebab: "Settings can only be changed
  // while the automation is stopped." Kalimat itu menjadi salah justru pada kasus
  // yang paling membingungkan — automation SUDAH stopped, tapi Settings tetap
  // mati. Customer lalu membaca kalimat yang menyuruhnya melakukan hal yang sudah
  // ia lakukan.
  function settingsHint(view, lang) {
    if (view && view.backendUnreachable) return tr(lang, BACKEND_DOWN_KEY);
    var status = (view && view.status) || null;
    // Belum dimuat: jangan menuduh apa pun.
    if (!status) return "";
    // Dibedakan per operasi: "Saving your settings" saat sebuah penyimpanan
    // MAPPING sedang berjalan adalah kalimat yang salah, dan kalimat yang
    // salah di tempat yang menjelaskan kenapa sesuatu terkunci justru yang
    // paling membingungkan.
    if (view && view.busyOp === "saveSettings") return tr(lang, "ui.rule.savingSettings");
    if (view && view.busyOp === "saveMappings") return tr(lang, "ui.rule.savingRules");
    var s = status.automation;
    if (s === STATES.STOPPED || s === STATES.ERROR) return "";
    return tr(lang, "ui.set.locked");
  }

  // Kenapa Pemetaan tidak bisa disunting. Kembaran settingsHint, dan dengan
  // sengaja berbentuk sama: sebabnya sama, jadi pembedaan per sebabnya juga harus
  // sama.
  //
  // Sampai 2026-10-09 kartu Pemetaan memakai SATU kalimat yang ditulis langsung
  // di app.js: "Editing is disabled while the automation is running." Penyuntingan
  // dikunci oleh (stopped || errored) && !writingConfig — jadi kalimat itu tampil
  // juga saat automation BERHENTI dan sebuah penyimpanan sedang jalan, yaitu
  // pernyataan yang SALAH tentang keadaan sistem, di layar yang sedang dipakai
  // orang mencari sesuatu untuk dihentikan.
  function mappingHint(view, lang) {
    if (view && view.backendUnreachable) return tr(lang, BACKEND_DOWN_KEY);
    var status = (view && view.status) || null;
    if (!status) return "";
    if (view && view.busyOp === "saveSettings") return tr(lang, "ui.rule.savingSettings");
    if (view && view.busyOp === "saveMappings") return tr(lang, "ui.rule.savingRules");
    var s = status.automation;
    if (s === STATES.STOPPED || s === STATES.ERROR) return "";
    return tr(lang, "ui.rule.locked");
  }

  function settingsView(view, lang) {
    var status = (view && view.status) || null;
    var controls = controlsFor(view, lang);
    return {
      // Belum ada config: itulah pekerjaan pertama customer.
      firstRun: !!(status && status.config && status.config.present === false),
      configured: !!(status && status.config && status.config.present === true),
      editable: controls.editingEnabled,
      hint: controls.editingEnabled ? "" : settingsHint(view, lang),
    };
  }

  // ---------------------------------------------------------------------------
  // Kendali tombol
  // ---------------------------------------------------------------------------

  // Operasi yang BENAR-BENAR menulis config. Hanya ini yang boleh mengunci
  // penyuntingan.
  //
  // ---------------------------------------------------------------------------
  // KENAPA INI TIDAK BOLEH MEMAKAI `busy` GLOBAL
  //
  // Sampai sekarang: editingEnabled = !busy && (stopped || errored). `busy`
  // dinyalakan oleh SETIAP operasi — termasuk Refresh, yang menjalankan discovery
  // TikTok dan di aplikasi terpasang ikut MEMBUKA CHROME (terukur 6-12 detik).
  //
  // Akibatnya seluruh Settings terkunci oleh pekerjaan yang tidak ada
  // hubungannya dengan Settings. Dan lebih buruk, ia MENGUNCI PERMANEN:
  // renderSettings() yang menuliskan disabled=true dipanggil dari renderAll() DI
  // DALAM jendela busy, sementara jalur yang membebaskannya tidak pernah
  // dijalankan lagi — polling hanya memanggil renderControls/renderReadiness/
  // renderActivity. Jadi sesudah satu kali Refresh, checkbox customer mati dan
  // tidak pernah hidup lagi. Terlihat di aplikasi terpasang pada 2026-10-08.
  //
  // Arah kegagalan di sini SENGAJA permisif: op yang tidak dikenal TIDAK
  // mengunci. Mengunci karena salah tebak berarti customer tidak bisa mengatur
  // aplikasinya sama sekali — yaitu bug yang sedang diperbaiki. Sementara
  // menyunting saat sesuatu berjalan paling buruk berarti satu simpanan yang
  // tetap divalidasi server dan tetap atomik. Yang BERBAHAYA adalah menyalakan
  // bot, dan itu tetap memakai `busy` global di bawah.
  var CONFIG_WRITE_OPS = ["saveSettings", "saveMappings"];

  function writingConfig(view) {
    var op = view && view.busyOp;
    return typeof op === "string" && CONFIG_WRITE_OPS.indexOf(op) !== -1;
  }

  // Semua alasan START BOT tidak boleh ditekan, dalam urutan paling bisa
  // ditindaklanjuti lebih dulu.
  //
  // FAIL-CLOSED SEPENUHNYA. Sebelum P4.1.1 fungsi ini hanya melihat state
  // automation, sehingga START BOT tetap hidup walau LIVE belum on air, nol produk
  // terdeteksi, dan nol pemetaan ada — terlihat di UI sungguhan pada 2026-10-08.
  // Preflight memang akan menolaknya, tapi tombol yang mengundang klik yang sudah
  // pasti gagal membuat orang berhenti membaca pesannya. Dan pesan preflight itulah
  // yang nanti dibutuhkan saat kegagalannya benar-benar penting.
  //
  // Kesiapan yang BELUM DIKETAHUI juga memblokir. "Belum tahu" bukan "aman":
  // satu-satunya cara tombol ini hidup adalah kalau setiap syarat sudah terbukti
  // terpenuhi.
  function startBlockers(view, lang) {
    var v = view || {};
    var status = v.status || null;

    // Tiga hal ini menutup semuanya, jadi tidak perlu daftar panjang.
    if (v.backendUnreachable) return [{ key: "backend", message: tr(lang, BACKEND_DOWN_KEY) }];
    if (!status) return [{ key: "status", message: tr(lang, "ui.loading") }];
    if (v.busy) return [{ key: "busy", message: tr(lang, "ui.working") }];

    var out = [];

    // --- syarat dasar ---
    if (status.config && status.config.present === false) {
      out.push({ key: "config", message: tr(lang, "ui.login.hintSaveFirst") });
    }
    if (status.login && status.login.active) {
      out.push({ key: "login", message: tr(lang, "ui.login.finishFirst") });
    }

    var s = status.automation;
    var stopped = s === STATES.STOPPED;
    var errored = s === STATES.ERROR;
    var known =
      stopped || errored || s === STATES.RUNNING || s === STATES.DEGRADED ||
      s === STATES.STARTING || s === STATES.STOPPING || s === STATES.PREFLIGHT;

    if (!known) out.push({ key: "state", message: tr(lang, "ui.block.stateUnknown") });
    else if (s === STATES.RUNNING || s === STATES.DEGRADED) out.push({ key: "state", message: tr(lang, "ui.block.alreadyRunning") });
    else if (s === STATES.STARTING || s === STATES.PREFLIGHT) out.push({ key: "state", message: tr(lang, "ui.block.alreadyStarting") });
    else if (s === STATES.STOPPING) out.push({ key: "state", message: tr(lang, "ui.block.stillStopping") });

    // --- kesiapan. Kalimatnya dari server kalau ada; "Checking…" berarti BELUM
    //     DIKETAHUI, dan itu tetap memblokir. ---
    var obs = v.obs;
    if (!obs) out.push({ key: "obs", message: tr(lang, "ui.block.checkingObs") });
    else if (obs.ok !== true) out.push({ key: "obs", message: messageOf(lang, obs, "err.obs-unavailable") });

    var tk = v.tiktok;
    if (!tk) {
      out.push({ key: "tiktok", message: tr(lang, "ui.block.checkingTiktok") });
    } else if (tk.ok !== true) {
      out.push({ key: "tiktok", message: messageOf(lang, tk, "err.tiktok-not-logged-in") });
    } else {
      if (tk.identityOk === false) out.push({ key: "identity", message: tr(lang, "err.identity-mismatch") });
      if (tk.live !== true) out.push({ key: "live", message: tr(lang, "err.live-not-active") });
      if (typeof tk.productCount !== "number") out.push({ key: "products", message: tr(lang, "ui.block.checkingProducts") });
      else if (tk.productCount < 1) out.push({ key: "products", message: tr(lang, "err.no-live-products") });
    }

    var val = v.validation;
    if (!val) out.push({ key: "mappings", message: tr(lang, "ui.block.checkingMappings") });
    else if (val.ok !== true) out.push({ key: "mappings", message: messageOf(lang, val, "err.mapping-validation-failed") });

    // --- mode aksi nyata. Verdict dan kalimatnya datang dari SERVER. ---
    //
    // TIDAK dihitung di sini dengan sengaja. Kalau halaman memutuskannya
    // sendiri, suatu saat ia akan menyimpang dari apa yang server tolak — dan
    // yang menyimpang akan menjadi tombol hijau untuk run yang tidak bisa memin
    // apa pun. Itu persis yang terjadi pada 2026-10-08: semua indikator hijau,
    // scene berganti, nol produk ter-pin. Lihat controller/automation-mode.js.
    //
    // Config yang sudah ada tapi TANPA verdict mode diperlakukan sebagai BELUM
    // DIKETAHUI, dan itu tetap memblokir — sama seperti "Checking…" di atas.
    if (status.config && status.config.present === true) {
      var mode = status.mode;
      if (!mode) out.push({ key: "mode", message: tr(lang, "ui.block.checkingMode") });
      else if (mode.ok !== true) {
        // mode membawa `reason` (controller/automation-mode.js), jadi kamus
        // yang menjawab; kalimat server hanya jaring kalau kodenya baru.
        out.push({ key: "mode", message: messageOf(lang, mode, "ui.block.modeOff") });
      }
    }

    return out;
  }

  // Satu-satunya tempat yang memutuskan tombol mana boleh ditekan.
  //
  // FAIL-CLOSED: state yang tidak dikenal, backend yang tidak terjangkau, atau
  // operasi yang sedang berjalan semuanya MEMATIKAN Start. Tombol Start yang
  // hidup saat keadaan tidak jelas adalah tombol yang bisa menyalakan sesuatu di
  // akun sungguhan atas dasar tebakan.
  function controlsFor(view, lang) {
    var status = (view && view.status) || null;
    var busy = !!(view && view.busy);
    var reachable = !(view && view.backendUnreachable);

    if (!reachable) {
      return {
        startEnabled: false,
        stopEnabled: false,
        editingEnabled: false,
        refreshEnabled: true,
        discoveryAllowed: false,
        startReason: tr(lang, BACKEND_DOWN_KEY),
      };
    }
    if (!status) {
      return {
        startEnabled: false, stopEnabled: false, editingEnabled: false,
        refreshEnabled: false, discoveryAllowed: false, startReason: tr(lang, "ui.loading"),
      };
    }

    // Jendela login terbuka memegang profil Chrome yang dibutuhkan service, jadi
    // selama itu Start TIDAK boleh hidup. Server juga menolaknya; ini lapis
    // pertama supaya tombolnya tidak pernah mengundang klik yang pasti gagal.
    var loginActive = !!(status.login && status.login.active);

    // Config belum pernah disimpan: Start PASTI gagal di preflight. Tombol yang
    // mengundang klik yang sudah pasti gagal membuat orang berhenti membaca
    // pesannya — dan pesan preflight-lah yang nanti dibutuhkan saat kegagalannya
    // benar-benar penting.
    var noConfig = !!(status.config && status.config.present === false);

    var s = status.automation;
    var stopped = s === STATES.STOPPED;
    var running = s === STATES.RUNNING || s === STATES.DEGRADED;
    var transitioning = s === STATES.STARTING || s === STATES.STOPPING || s === STATES.PREFLIGHT;
    var errored = s === STATES.ERROR;
    var known = stopped || running || transitioning || errored;

    // Menyunting pemetaan hanya saat benar-benar berhenti. P2 memakai snapshot
    // yang tidak bisa diubah dan menjawab restartRequired untuk perubahan di
    // tengah jalan, jadi formulir yang bisa disunting saat RUNNING hanya
    // menjanjikan sesuatu yang tidak akan terjadi.
    // Penyuntingan hanya bergantung pada: automation memang berhenti, DAN
    // tidak ada penyimpanan config yang sedang berjalan. Pekerjaan latar
    // (discovery/refresh) tidak mengunci apa pun di sini.
    var editingEnabled = (stopped || errored) && !writingConfig(view);

    // Start hidup HANYA kalau tidak ada satu pun penghalang. Semua syaratnya ada
    // di startBlockers(), termasuk kesiapan yang belum diketahui.
    var blockers = startBlockers(view, lang);

    return {
      startEnabled: blockers.length === 0,
      startBlockers: blockers,
      stopEnabled: !busy && (running || transitioning || errored),
      editingEnabled: editingEnabled,
      refreshEnabled: !busy && !loginActive,
      // Discovery produk memakai profil Chrome yang dipegang service saat
      // berjalan. P2 menolaknya di server; UI tidak boleh terus memintanya.
      // Discovery produk juga memakai profil itu.
      discoveryAllowed: (stopped || errored) && !loginActive,
      // Penghalang PERTAMA, yaitu yang paling bisa ditindaklanjuti.
      startReason: blockers.length > 0 ? blockers[0].message : "",
    };
  }

  // ---------------------------------------------------------------------------
  // Pemetaan
  // ---------------------------------------------------------------------------

  // Hasil validasi dicocokkan ke baris pemetaan lewat INDEKS, bukan nama scene.
  // Scene yang sama bisa muncul dua kali (dan itu justru salah satu kesalahan
  // yang dilaporkan), jadi mencocokkan dengan nama akan menaruh pesan di baris
  // yang salah.
  function mappingIssues(validation, count, lang) {
    var rows = validation && Array.isArray(validation.mappings) ? validation.mappings : [];
    var n = typeof count === "number" ? count : rows.length;
    var out = [];
    for (var i = 0; i < n; i += 1) {
      var r = rows[i];
      if (!r || r.ok === true) {
        out.push(null);
        continue;
      }
      out.push({
        message: messageOf(lang, r, "ui.row.needsAttention"),
        reason: r.reason || null,
        resolvedTitle: r.resolvedTitle || null,
      });
    }
    return out;
  }

  // Judul yang BENAR-BENAR terlihat di daftar LIVE, per baris. Dipakai untuk
  // menunjukkan produk mana yang sungguhnya terpilih dari potongan judul.
  function resolvedTitles(validation, count) {
    var rows = validation && Array.isArray(validation.mappings) ? validation.mappings : [];
    var n = typeof count === "number" ? count : rows.length;
    var out = [];
    for (var i = 0; i < n; i += 1) out.push((rows[i] && rows[i].resolvedTitle) || null);
    return out;
  }

  // Baris pemetaan kosong, untuk tombol Add Mapping.
  function blankMapping() {
    return { scene: "", product: { title: "" }, triggers: [], reply: "" };
  }

  // Bentuk formulir -> bentuk config. Trigger ditulis satu per baris di textarea
  // karena satu scene bisa punya banyak trigger dan koma bisa muncul di dalam
  // kata kunci itu sendiri.
  function parseTriggers(text) {
    return String(text === undefined || text === null ? "" : text)
      .split("\n")
      .map(function (t) { return t.trim(); })
      .filter(function (t) { return t !== ""; });
  }

  function formatTriggers(triggers) {
    return (Array.isArray(triggers) ? triggers : []).join("\n");
  }

  // Satu baris formulir -> satu pemetaan config.
  //
  // Produk kosong menjadi null, bukan { title: "" }: null berarti "scene ini
  // sengaja tidak memin apa pun" dan diterima backend, sementara judul kosong
  // ditolak sebagai field yang lupa diisi. Bedanya disengaja (lihat
  // controller/config-manager.js), dan UI harus menghormatinya.
  function rowToMapping(row) {
    var title = row && row.productTitle ? String(row.productTitle).trim() : "";
    var reply = row && row.reply ? String(row.reply).trim() : "";
    var m = {
      scene: row && row.scene ? String(row.scene).trim() : "",
      product: title === "" ? null : { title: title },
      triggers: parseTriggers(row && row.triggersText),
    };
    if (reply !== "") m.reply = reply;
    return m;
  }

  function mappingToRow(m) {
    return {
      scene: (m && m.scene) || "",
      productTitle: m && m.product && m.product.title ? m.product.title : "",
      triggersText: formatTriggers(m && m.triggers),
      reply: (m && m.reply) || "",
    };
  }

  // Config lengkap untuk PUT /api/config.
  //
  // Dibangun dari config yang TERAKHIR DIBACA, dengan hanya `mappings` yang
  // diganti. Penting: hasil GET /api/config tidak memuat password OBS (hanya
  // passwordSet), dan backend memperlakukan password yang tidak dikirim sebagai
  // "jangan diubah". Jadi passwordSet dibuang di sini supaya ia tidak pernah
  // terkirim sebagai field yang tidak dikenal.
  function buildConfigPayload(baseConfig, rows) {
    var base = baseConfig ? JSON.parse(JSON.stringify(baseConfig)) : null;
    if (!base) return null;
    if (base.obs && Object.prototype.hasOwnProperty.call(base.obs, "passwordSet")) delete base.obs.passwordSet;
    base.mappings = (Array.isArray(rows) ? rows : []).map(rowToMapping);
    return base;
  }

  // ---------------------------------------------------------------------------
  // Activity feed
  // ---------------------------------------------------------------------------

  // Kalimat untuk tiap jenis kejadian. Scene disisipkan kalau ada, supaya
  // operator tahu baris itu milik etalase mana.
  function activityText(e, lang) {
    if (!e) return "";
    // Nama scene dan judul produk adalah milik customer: keduanya masuk sebagai
    // NILAI ke dalam kalimat, tidak pernah diterjemahkan.
    var scene = e.scene ? String(e.scene) : "";
    switch (e.type) {
      case "PLAY": return scene ? tr(lang, "ui.act.play", { scene: scene }) : tr(lang, "ui.act.playPlain");
      case "PLAYBACK_END": return scene ? tr(lang, "ui.act.playbackEnd", { scene: scene }) : tr(lang, "ui.act.endPlain");
      case "AUTOPIN_SUCCESS": return e.product ? tr(lang, "ui.act.pinnedNamed", { product: e.product }) : tr(lang, "ui.act.pinned");
      case "AUTOPIN_FAILED": return messageOf(lang, e, "ui.act.pinFailed");
      case "AUTOCOMMENT_SUCCESS": return tr(lang, "ui.act.replied");
      case "AUTOCOMMENT_FAILED": return messageOf(lang, e, "ui.act.replyFailed");
      case "TIKTOK_CONNECTED": return tr(lang, "ui.act.connected");
      case "TIKTOK_RECONNECTED": return tr(lang, "ui.act.reconnected");
      case "TIKTOK_DISCONNECTED": return tr(lang, "ui.act.disconnected");
      case "BOT_CRASHED": return tr(lang, "ui.act.botCrashed");
      case "SERVICE_CRASHED": return tr(lang, "ui.act.pinCrashed");
      case "LOGIN_WAITING": return tr(lang, "ui.act.loginWaiting");
      case "LOGIN_OK": return tr(lang, "ui.act.loginOk");
      // Nama state internal (PREFLIGHT, DEGRADED, STOPPING) tidak pernah tampil:
      // dipakai fungsi yang SUDAH menerjemahkannya untuk pil status, supaya
      // halaman ini tidak punya dua kosakata untuk satu hal yang sama.
      case "STATE": return e.to
        ? tr(lang, "ui.act.status", { state: automationLabel({ automation: e.to }, lang) })
        : tr(lang, "ui.act.statusChanged");
      default: return e.message ? String(e.message) : String(e.type || "");
    }
  }

  function activityTone(e) {
    if (!e) return TONE.NEUTRAL;
    if (e.type === "AUTOPIN_SUCCESS" || e.type === "AUTOCOMMENT_SUCCESS" || e.type === "TIKTOK_CONNECTED") return TONE.READY;
    if (e.type === "BOT_CRASHED" || e.type === "SERVICE_CRASHED") return TONE.ERROR;
    if (e.type === "AUTOPIN_FAILED" || e.type === "AUTOCOMMENT_FAILED" || e.type === "TIKTOK_DISCONNECTED") return TONE.ATTENTION;
    return TONE.NEUTRAL;
  }

  // HH:MM waktu lokal. Tanggal tidak ditampilkan: feed ini untuk sesi yang sedang
  // berjalan, dan tanggal hanya menambah bising.
  function activityTime(iso, lang) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    // Jam mengikuti kebiasaan bahasanya lewat Intl, bukan dirakit tangan.
    var viaIntl = I18N.clockTime(lang, d);
    if (viaIntl) return viaIntl.slice(0, 5);
    var hh = String(d.getHours()).padStart(2, "0");
    var mm = String(d.getMinutes()).padStart(2, "0");
    return hh + ":" + mm;
  }

  // Kejadian terbaru lebih dulu, DIBATASI.
  //
  // Backend sudah membatasi buffer-nya (500); frontend tidak boleh menumbuhkan
  // riwayatnya sendiri tanpa batas. Halaman ini bisa terbuka berjam-jam selama
  // LIVE, dan daftar DOM yang tumbuh terus adalah kebocoran memori yang sama
  // bentuknya dengan yang sudah diperbaiki di sisi backend.
  function activityItems(events, limit, lang) {
    var max = typeof limit === "number" && limit > 0 ? limit : MAX_ACTIVITY_ITEMS;
    var list = Array.isArray(events) ? events.slice() : [];
    // Server mengirim yang tertua lebih dulu; yang paling baru yang paling
    // berguna, jadi urutannya dibalik untuk tampilan.
    list.reverse();
    return list.slice(0, max).map(function (e) {
      return { id: e.id, time: activityTime(e.time, lang), text: activityText(e, lang), tone: activityTone(e) };
    });
  }

  // Gabungkan kejadian baru ke yang lama, tetap dibatasi dan tanpa duplikat.
  function mergeActivity(existing, incoming, limit) {
    var max = typeof limit === "number" && limit > 0 ? limit : MAX_ACTIVITY_ITEMS;
    var seen = {};
    var out = [];
    var all = (Array.isArray(existing) ? existing : []).concat(Array.isArray(incoming) ? incoming : []);
    for (var i = 0; i < all.length; i += 1) {
      var e = all[i];
      if (!e || e.id === undefined || seen[e.id]) continue;
      seen[e.id] = true;
      out.push(e);
    }
    out.sort(function (a, b) { return a.id - b.id; });
    // Yang tertua dibuang kalau melewati batas.
    return out.slice(Math.max(0, out.length - max));
  }

  // ---------------------------------------------------------------------------
  // Preflight
  // ---------------------------------------------------------------------------

  // Daftar kesiapan saat Start, baris per baris. Label-nya ramah; nama check
  // internal tidak ditampilkan.
  //
  // Label dibaca sebagai PERTANYAAN, nilainya sebagai JAWABAN. Karena itu
  // "No other bot running" diubah menjadi "Other bots running": label yang sudah
  // memuat jawabannya sendiri membuat barisnya berbunyi dua kali.
  // Urutan check, dan HANYA urutannya. Kalimatnya ada di kamus dengan kunci
  // "ui.check.<nama>" dan "ui.check.<nama>.pass" - berkas ini tidak lagi
  // memiliki satu pun kata yang dibaca customer.
  var CHECK_NAMES = ["config", "processes", "ports", "obs", "scenes", "profile", "tiktok", "mappings"];

  // Kata LULUS per check.
  //
  // Sampai 2026-10-09 kedelapan baris ini berbunyi satu kata yang sama: "Ready".
  // Itu masalahnya sendiri — "Other bots running: Ready" membaca kebalikan dari
  // yang dibuktikan check itu, dan satu kolom penuh "Ready" yang masih tertinggal
  // di layar sesudah STOP BOT adalah persis salah-baca "berhenti terlihat seperti
  // berjalan" yang diperbaiki di kartu kesiapan. Tiap check menjawab pertanyaan
  // yang berbeda, jadi tiap check berbicara dengan kata-katanya sendiri.
  //
  // Hanya TAMPILAN: failedPreflight() menyaring pada r.tone, tidak pernah pada
  // r.value, jadi tidak ada satu pun keputusan lulus/gagal yang bergantung pada
  // kata-kata di bawah ini.
  function checkLabel(name, lang) { return tr(lang, "ui.check." + name); }
  function checkPass(name, lang) { return tr(lang, "ui.check." + name + ".pass"); }

  function preflightRows(result, lang) {
    if (!result || !result.checks) return [];
    var out = [];
    for (var i = 0; i < CHECK_NAMES.length; i += 1) {
      var name = CHECK_NAMES[i];
      var c = result.checks[name];
      if (!c) continue;
      if (c.ok === true) {
        // "Tidak perlu", bukan "Dilewati": yang kedua dibaca sebagai "gagal
        // sehingga dilompati", padahal artinya check ini tidak berlaku di sini.
        out.push({
          label: checkLabel(name, lang),
          value: c.skipped ? tr(lang, "ui.check.skipped") : checkPass(name, lang),
          tone: c.skipped ? TONE.NEUTRAL : TONE.READY,
        });
      } else {
        out.push({ label: checkLabel(name, lang), value: messageOf(lang, c, "ui.check.notReady"), tone: TONE.ATTENTION });
      }
    }
    return out;
  }

  // Check yang gagal saja, untuk ditampilkan saat Start ditolak.
  function failedPreflight(result, lang) {
    return preflightRows(result, lang).filter(function (r) { return r.tone === TONE.ATTENTION; });
  }

  // ---------------------------------------------------------------------------
  // Tampilan Direction D
  // ---------------------------------------------------------------------------
  //
  // Bagian ini memutuskan BUNYI kartu status, lampu tally, hitungan kesiapan,
  // kartu "sedang tayang", dan kalimat satu aturan. Ia tinggal di sini dan bukan
  // di app.js karena setiap percabangan di bawah bisa salah membaca keadaan
  // sistem — dan percabangan yang bersembunyi di dalam handler DOM adalah
  // percabangan yang tidak akan pernah diuji. Lihat kepala app.js.

  // Jumlah aturan untuk KALIMAT, bukan untuk keputusan. Yang sudah divalidasi
  // server lebih dipercaya daripada isi formulir yang belum disimpan.
  function ruleCount(view) {
    var val = view && view.validation;
    if (val && Array.isArray(val.mappings)) return val.mappings.length;
    return Array.isArray(view && view.rows) ? view.rows.length : 0;
  }

  // Penghalang yang BENAR-BENAR milik kesiapan.
  //
  // startBlockers() juga mengembalikan tiga penghalang semu — backend mati,
  // status belum dimuat, ada operasi berjalan — dan ketiganya bukan "syarat yang
  // perlu dibereskan customer". Kalau ikut dihitung, menyimpan pengaturan
  // membuat judul berbunyi "Belum bisa mulai: 1 hal perlu dibereskan", lalu
  // angka itu menghilang sendiri sedetik kemudian.
  var PSEUDO_BLOCKERS = { backend: true, status: true, busy: true };

  function realBlockers(view, lang) {
    return startBlockers(view, lang).filter(function (b) {
      return !PSEUDO_BLOCKERS[b.key];
    });
  }

  // Lampu tally di bilah atas.
  //
  // Kosakatanya SENGAJA berbeda dari kartu status: lampu ini menjawab "apa yang
  // sedang terjadi sekarang" dalam satu lirikan di tengah LIVE, kartu yang
  // menjelaskannya. Merah siaran HANYA berarti sedang mengudara, dan hijau HANYA
  // berarti MULAI BOT benar-benar bisa ditekan.
  function tallyView(view, lang) {
    var status = (view && view.status) || null;
    if (view && view.backendUnreachable) return { label: tr(lang, "ui.pill.problem"), tone: TONE.ERROR };
    if (!status) return { label: tr(lang, "ui.pill.checking"), tone: TONE.NEUTRAL };

    switch (status.automation) {
      case STATES.RUNNING: return { label: tr(lang, "ui.pill.onair"), tone: TONE.RUNNING };
      case STATES.DEGRADED: return { label: tr(lang, "ui.pill.problem"), tone: TONE.ATTENTION };
      case STATES.ERROR: return { label: tr(lang, "ui.pill.problem"), tone: TONE.ERROR };
      case STATES.STARTING:
      case STATES.PREFLIGHT:
      case STATES.STOPPING:
        return { label: automationLabel(status, lang), tone: TONE.ATTENTION };
      default: break;
    }

    var blockers = realBlockers(view, lang);
    // Abu-abu, bukan kuning. Belum-bisa-mulai adalah keadaan ISTIRAHAT yang
    // normal pada peluncuran pertama; kalau ia kuning, tidak ada warna yang
    // tersisa untuk "ada yang rusak".
    if (blockers.length) return { label: tr(lang, "ui.pill.blocked", { n: blockers.length }), tone: TONE.NEUTRAL };
    return { label: tr(lang, "ui.pill.ready"), tone: TONE.READY };
  }

  // Kartu status: satu judul yang menjawab "apa yang sedang terjadi", dan satu
  // kalimat yang menjawab "lalu saya harus apa".
  function heroView(view, lang) {
    var status = (view && view.status) || null;
    var OVER = "ui.hero.over.status";

    if (view && view.backendUnreachable) {
      return { over: tr(lang, OVER), title: tr(lang, BACKEND_DOWN_KEY), note: "", tone: TONE.ERROR };
    }
    if (!status) {
      return { over: tr(lang, OVER), title: tr(lang, "ui.hero.checking.title"), note: "", tone: TONE.NEUTRAL };
    }

    var n = ruleCount(view);
    switch (status.automation) {
      case STATES.RUNNING:
        return {
          over: tr(lang, "ui.hero.over.running"),
          title: tr(lang, "ui.hero.running.title"),
          note: tr(lang, "ui.hero.running.body", { n: n }),
          tone: TONE.RUNNING,
        };
      case STATES.DEGRADED:
        return {
          over: tr(lang, "ui.hero.over.running"),
          title: tr(lang, "ui.hero.problem.title"),
          note: tr(lang, "ui.ready.hint.running"),
          tone: TONE.ATTENTION,
        };
      case STATES.ERROR:
        // Judulnya adalah sebab kegagalannya sendiri: itu satu hal yang paling
        // perlu dibaca orang yang menemukan layar ini.
        return {
          over: tr(lang, OVER),
          title: automationLabel(status, lang),
          note: tr(lang, "ui.ready.hint.error"),
          tone: TONE.ERROR,
        };
      case STATES.STARTING:
      case STATES.PREFLIGHT:
      case STATES.STOPPING:
        return { over: tr(lang, OVER), title: automationLabel(status, lang), note: "", tone: TONE.ATTENTION };
      default: break;
    }

    // Berhenti. Tidak satu pun cabang di bawah boleh berbunyi seperti sesuatu
    // yang sedang berjalan.
    if (view && view.busy) {
      return { over: tr(lang, OVER), title: tr(lang, "ui.working"), note: "", tone: TONE.ATTENTION };
    }

    var blockers = realBlockers(view, lang);
    if (blockers.length) {
      return {
        over: tr(lang, OVER),
        title: tr(lang, "ui.hero.blocked.title", { n: blockers.length }),
        // Satu penghalang: sebut saja apa. Banyak penghalang: tunjuk daftarnya,
        // karena menyebut satu dari enam membuat lima lainnya tidak terlihat.
        note: blockers.length === 1 ? blockers[0].message : tr(lang, "ui.hero.blocked.body"),
        tone: TONE.NEUTRAL,
      };
    }

    return {
      over: tr(lang, OVER),
      title: tr(lang, "ui.hero.ready.title"),
      note: tr(lang, "ui.hero.ready.body", { n: n }),
      tone: TONE.READY,
    };
  }

  // Hitungan di kepala rel kesiapan, dan satu sel progres per syarat.
  //
  // Baris PERTAMA readinessRows() adalah KEADAAN otomasi, bukan syarat, jadi ia
  // tidak ikut dihitung — kalau ikut, "Berhenti" membuat hitungannya selalu
  // kurang satu dan customer mencari syarat yang tidak ada.
  function readyView(view, lang) {
    var status = (view && view.status) || null;
    var s = status ? status.automation : null;
    // Hitungannya milik "sebelum mulai", dan HANYA itu.
    //
    // Selama berjalan, service memegang profil Chrome, jadi katalog produk dan
    // identitas TikTok memang tidak bisa dibaca lagi - tiga baris tinggal
    // "Memeriksa...". Menghitungnya tetap membuat run yang SEHAT berbunyi
    // "3 dari 6 siap", yaitu angka yang membaca seperti separuh sistem rusak di
    // layar yang dipakai orang memutuskan apakah perlu menekan HENTIKAN BOT.
    var counting = s !== STATES.RUNNING && s !== STATES.DEGRADED;
    var rows = readinessRows(view, lang).slice(1);
    var cells = rows.map(function (r) {
      if (r.tone === TONE.READY) return TONE.READY;
      if (r.tone === TONE.ATTENTION || r.tone === TONE.ERROR) return TONE.ATTENTION;
      return TONE.NEUTRAL;
    });
    var ok = cells.filter(function (c) { return c === TONE.READY; }).length;
    var total = cells.length;
    return {
      counting: counting,
      // "Sebelum mulai" di atas kartu yang sedang menemani sebuah run adalah
      // judul yang salah: tidak ada lagi yang "sebelum".
      title: tr(lang, counting ? "ui.ready.title" : "ui.ready.titleRunning"),
      ok: ok,
      total: total,
      cells: counting ? cells : [],
      label: !counting
        ? ""
        : total > 0 && ok === total
          ? tr(lang, "ui.ready.allClear", { total: total })
          : tr(lang, "ui.ready.count", { ok: ok, total: total }),
    };
  }

  // m:ss. Angka, jadi tidak butuh terjemahan.
  function clock(sec) {
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return m + ":" + (s < 10 ? "0" + s : String(s));
  }

  // Kartu "sedang tayang".
  //
  // SETIAP angka di sini datang dari kejadian yang sungguh dikirim server.
  // Panjang scene TIDAK PERNAH ada di /api/status, jadi tidak ada hitungan
  // mundur: yang ditampilkan adalah waktu BERJALAN sejak kejadian PLAY, yang
  // memang punya stempel waktu. Hitungan mundur palsu di layar yang dipakai
  // orang memutuskan kapan bicara jauh lebih buruk daripada tidak ada angka.
  function onairView(view, lang, now) {
    var status = (view && view.status) || null;
    var s = status ? status.automation : null;
    var hidden = { visible: false, scene: "", title: "", sub: "", elapsed: "", elapsedSeconds: 0, elapsedLabel: "", chain: [] };
    if (s !== STATES.RUNNING && s !== STATES.DEGRADED) return hidden;

    var events = Array.isArray(view && view.activity) ? view.activity : [];

    // Dibaca dari yang TERBARU. Kalau yang ditemui lebih dulu adalah akhir
    // scene, berarti sekarang tidak ada yang tayang — dan kartunya tidak boleh
    // tetap memamerkan scene yang sudah selesai.
    var play = null;
    for (var i = events.length - 1; i >= 0; i -= 1) {
      var e = events[i];
      if (!e) continue;
      if (e.type === "PLAYBACK_END") break;
      if (e.type === "PLAY") { play = e; break; }
    }
    if (!play) return hidden;

    var after = events.filter(function (x) { return x && x.id > play.id; });
    function last(type) {
      for (var j = after.length - 1; j >= 0; j -= 1) if (after[j].type === type) return after[j];
      return null;
    }
    var pinOk = last("AUTOPIN_SUCCESS");
    var pinBad = last("AUTOPIN_FAILED");
    var repOk = last("AUTOCOMMENT_SUCCESS");
    var repBad = last("AUTOCOMMENT_FAILED");

    function step(labelKey, ok, bad) {
      if (ok) return { label: tr(lang, labelKey), value: activityTime(ok.time, lang), tone: TONE.READY };
      if (bad) return { label: tr(lang, labelKey), value: messageOf(lang, bad, "ui.row.needsAttention"), tone: TONE.ATTENTION };
      return { label: tr(lang, labelKey), value: tr(lang, "ui.onair.waiting"), tone: TONE.NEUTRAL };
    }

    var at = Date.parse(play.time);
    var nowMs = typeof now === "number" ? now : Date.now();
    var sec = isFinite(at) ? Math.max(0, Math.floor((nowMs - at) / 1000)) : 0;

    // Judulnya milik customer kalau ada: judul produk yang SUNGGUH ter-pin.
    // Nama scene bukan kalimat, jadi ia menjadi judul hanya kalau tidak ada yang
    // lebih baik.
    var scene = play.scene ? String(play.scene) : "";
    var product = pinOk && pinOk.product ? String(pinOk.product) : "";
    var sceneLine = scene ? tr(lang, "ui.onair.scene", { scene: scene }) : "";

    return {
      visible: true,
      scene: scene,
      title: product || sceneLine,
      sub: product ? sceneLine : "",
      elapsed: clock(sec),
      elapsedSeconds: sec,
      elapsedLabel: tr(lang, "ui.onair.elapsed", { sec: I18N.num(lang, sec, 0) }),
      chain: [step("ui.onair.pinned", pinOk, pinBad), step("ui.onair.replied", repOk, repBad)],
    };
  }

  function activityCapText(lang) {
    return tr(lang, "ui.act.cap", { n: MAX_ACTIVITY_ITEMS });
  }

  // Satu aturan sebagai KALIMAT — inti Direction D. Pemicu, scene, produk,
  // balasan; dibaca seperti instruksi, bukan seperti baris tabel berkolom.
  //
  // Isi aturan adalah milik customer dan dikembalikan APA ADANYA. Yang
  // diterjemahkan hanya catatan tentang isinya.
  function ruleChips(row, ctx, lang) {
    var c = ctx || {};
    var triggers = parseTriggers(row && row.triggersText);
    var scene = row && row.scene ? String(row.scene) : "";
    var product = row && row.productTitle ? String(row.productTitle) : "";
    var scenes = Array.isArray(c.scenes) ? c.scenes : [];
    var resolved = c.resolvedTitle ? String(c.resolvedTitle) : "";

    return {
      triggers: triggers,
      // Kosong itu KEADAAN, bukan kesalahan: aturan yang baru ditambahkan memang
      // belum punya pemicu, dan ia belum disimpan ke mana pun.
      triggersEmpty: triggers.length === 0 ? tr(lang, "ui.rule.f.triggersEmpty") : "",
      scene: scene,
      // Hanya mengaku "tidak ada di OBS" kalau daftar scene MEMANG sudah dibaca.
      // Dengan daftar kosong, discovery belum pernah berhasil — dan menuduh
      // scene customer hilang berdasarkan daftar yang belum ada adalah
      // pernyataan yang salah tentang keadaan sistem.
      sceneMissing: scene !== "" && scenes.length > 0 && scenes.indexOf(scene) === -1
        ? tr(lang, "ui.rule.f.sceneMissing", { scene: scene })
        : "",
      product: product,
      productNone: product === "" ? tr(lang, "ui.rule.f.productNone") : "",
      // Judul yang BENAR-BENAR terlihat di LIVE, dan hanya kalau ia berbeda dari
      // potongan judul yang disimpan customer.
      resolved: resolved && product && resolved !== product
        ? tr(lang, "ui.rule.f.resolved", { title: resolved })
        : "",
      reply: row && row.reply ? String(row.reply) : "",
      noReply: row && row.reply ? "" : tr(lang, "ui.rule.noReply"),
    };
  }

  return {
    STATES: STATES,
    TONE: TONE,
    MAX_ACTIVITY_ITEMS: MAX_ACTIVITY_ITEMS,
    CHECK_NAMES: CHECK_NAMES,
    checkLabel: checkLabel,
    checkPass: checkPass,
    paxNumber: paxNumber,
    suggestForScene: suggestForScene,
    applySuggestion: applySuggestion,
    sceneOptions: sceneOptions,
    productOptions: productOptions,
    productLabel: productLabel,
    productSubLabel: productSubLabel,
    extraProductOption: extraProductOption,
    readinessRows: readinessRows,
    readinessHint: readinessHint,
    mappingHint: mappingHint,
    automationLabel: automationLabel,
    automationTone: automationTone,
    controlsFor: controlsFor,
    startBlockers: startBlockers,
    loginView: loginView,
    settingsToForm: settingsToForm,
    SETTINGS_FIELD_IDS: SETTINGS_FIELD_IDS,
    SETTINGS_TOGGLE_IDS: SETTINGS_TOGGLE_IDS,
    readSettingsNodes: readSettingsNodes,
    writeSettingsNodes: writeSettingsNodes,
    validateSettingsForm: validateSettingsForm,
    applySettingsToConfig: applySettingsToConfig,
    settingsView: settingsView,
    settingsHint: settingsHint,
    CONFIG_WRITE_OPS: CONFIG_WRITE_OPS,
    writingConfig: writingConfig,
    PORT_MIN: PORT_MIN,
    PORT_MAX: PORT_MAX,
    mappingIssues: mappingIssues,
    resolvedTitles: resolvedTitles,
    blankMapping: blankMapping,
    parseTriggers: parseTriggers,
    formatTriggers: formatTriggers,
    rowToMapping: rowToMapping,
    mappingToRow: mappingToRow,
    buildConfigPayload: buildConfigPayload,
    activityText: activityText,
    activityTone: activityTone,
    activityTime: activityTime,
    activityItems: activityItems,
    mergeActivity: mergeActivity,
    preflightRows: preflightRows,
    failedPreflight: failedPreflight,
    messageOf: messageOf,
    ruleCount: ruleCount,
    realBlockers: realBlockers,
    tallyView: tallyView,
    heroView: heroView,
    readyView: readyView,
    onairView: onairView,
    activityCapText: activityCapText,
    ruleChips: ruleChips,
  };
});
