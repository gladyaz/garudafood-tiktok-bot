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
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AiLiveUI = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

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
  function sceneOptions(scenes, opts) {
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
        note: supported ? "" : "not configured for automation",
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
  function productSubLabel(p) {
    if (!p) return "";
    var parts = [];
    if (!isBlank(p.price)) parts.push(String(p.price));
    if (!isBlank(p.stock)) parts.push(String(p.stock));
    if (p.pinAvailable === false) parts.push("Pin control unavailable");
    return parts.join(" · ");
  }

  function productOptions(products) {
    var list = Array.isArray(products) ? products : [];
    return list.map(function (p) {
      return {
        value: String(p.title || ""),
        label: productLabel(p),
        sub: productSubLabel(p),
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
  function readinessRows(data) {
    var obs = (data && data.obs) || null;
    var tiktok = (data && data.tiktok) || null;
    var status = (data && data.status) || null;
    var validation = (data && data.validation) || null;

    function unknown(label) {
      return { label: label, value: "Checking…", tone: TONE.NEUTRAL };
    }

    var rows = [];

    // OBS
    if (!obs) rows.push(unknown("OBS"));
    else if (obs.ok) rows.push({ label: "OBS", value: "Connected", tone: TONE.READY });
    else rows.push({ label: "OBS", value: messageOf(obs, "Not connected"), tone: TONE.ATTENTION });

    // TikTok
    if (!tiktok) rows.push(unknown("TikTok"));
    else if (tiktok.ok) {
      rows.push({
        label: "TikTok",
        value: tiktok.identity ? "Connected as " + tiktok.identity : "Connected",
        tone: TONE.READY,
      });
    } else rows.push({ label: "TikTok", value: messageOf(tiktok, "Not connected"), tone: TONE.ATTENTION });

    // LIVE
    if (!tiktok) rows.push(unknown("LIVE"));
    else if (!tiktok.ok) rows.push({ label: "LIVE", value: "Unknown", tone: TONE.NEUTRAL });
    else rows.push(tiktok.live
      ? { label: "LIVE", value: "Active", tone: TONE.READY }
      : { label: "LIVE", value: "Not on air", tone: TONE.ATTENTION });

    // Produk
    if (!tiktok) rows.push(unknown("Products"));
    else if (typeof tiktok.productCount === "number") {
      rows.push(tiktok.productCount > 0
        ? { label: "Products", value: tiktok.productCount + " detected", tone: TONE.READY }
        : { label: "Products", value: "None detected", tone: TONE.ATTENTION });
    } else rows.push({ label: "Products", value: "Unknown", tone: TONE.NEUTRAL });

    // Pemetaan
    if (!validation) rows.push(unknown("Mappings"));
    else if (validation.ok) {
      var n = Array.isArray(validation.mappings) ? validation.mappings.length : 0;
      rows.push({ label: "Mappings", value: n + (n === 1 ? " mapping ready" : " mappings ready"), tone: TONE.READY });
    } else {
      var bad = Array.isArray(validation.mappings) ? validation.mappings.filter(notOk).length : 0;
      rows.push({
        label: "Mappings",
        value: bad > 0 ? bad + (bad === 1 ? " mapping needs attention" : " mappings need attention")
                       : messageOf(validation, "Needs attention"),
        tone: TONE.ATTENTION,
      });
    }

    // Akun TikTok: keadaan login, terpisah dari "TikTok terhubung".
    var lv = loginView(data);
    rows.push({ label: "TikTok Account", value: lv.label, tone: lv.tone });

    // Automation
    rows.push({ label: "Automation", value: automationLabel(status), tone: automationTone(status) });

    return rows;
  }

  function notOk(row) {
    return !row || row.ok !== true;
  }

  // Kalimat dari server kalau ada. TIDAK PERNAH kode mesin: `reason` tetap
  // tersedia di objeknya untuk ditelusuri, tapi tidak pernah ditampilkan.
  function messageOf(obj, fallback) {
    if (!obj) return fallback;
    if (obj.userMessage) return String(obj.userMessage);
    if (obj.error && obj.error.userMessage) return String(obj.error.userMessage);
    return fallback;
  }

  function automationLabel(status) {
    if (!status) return "Checking…";
    switch (status.automation) {
      case STATES.STOPPED: return "Stopped";
      case STATES.PREFLIGHT: return "Checking readiness…";
      case STATES.STARTING: return "Starting…";
      case STATES.RUNNING: return "Running";
      case STATES.DEGRADED: return "Running with problems";
      case STATES.STOPPING: return "Stopping…";
      case STATES.ERROR: return messageOf(status.lastError, "Error");
      default: return "Unknown";
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
  function loginView(view) {
    var status = (view && view.status) || null;
    var login = status && status.login ? status.login : null;
    var tiktok = (view && view.tiktok) || null;
    var busy = !!(view && view.busy);
    var automation = status ? status.automation : null;
    var stopped = automation === STATES.STOPPED || automation === STATES.ERROR;

    if (!status) {
      return { state: "unknown", label: "Checking…", tone: TONE.NEUTRAL, canLogin: false, canCheck: false, canCancel: false, hint: "" };
    }

    if (login && login.active) {
      return {
        state: "waiting",
        label: "Waiting for login…",
        tone: TONE.ATTENTION,
        canLogin: false,
        canCheck: !busy,
        canCancel: !busy,
        hint: "Complete the TikTok login in the browser window, then press Check Login.",
      };
    }

    // Identitas yang terbukti: dari login yang berhasil, atau dari discovery yang
    // berhasil membaca halaman dashboard.
    var identity = (login && login.identity) || (tiktok && tiktok.ok && tiktok.identity) || null;
    if (identity) {
      return {
        state: "connected",
        label: "Connected as " + identity,
        tone: TONE.READY,
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
      label: "Not signed in",
      tone: TONE.ATTENTION,
      // Login hanya saat berhenti: service memegang profil Chrome saat berjalan.
      canLogin: stopped && !busy && !noConfig,
      canCheck: false,
      canCancel: false,
      hint: noConfig ? "Save your settings first." : stopped ? "" : "Stop the automation first.",
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
  function validateSettingsForm(form) {
    var f = form || {};
    var errors = {};

    if (isBlank(f.tiktokUsername)) {
      errors.tiktokUsername = "Enter the TikTok username that goes LIVE.";
    }
    if (isBlank(f.expectedShop)) {
      errors.expectedShop = "Enter the account name exactly as it appears in your LIVE console.";
    }
    if (isBlank(f.obsHost)) {
      errors.obsHost = "Enter the computer running OBS, usually 127.0.0.1.";
    }

    var portRaw = String(f.obsPort === undefined || f.obsPort === null ? "" : f.obsPort).trim();
    if (portRaw === "") {
      errors.obsPort = "Enter the OBS WebSocket port, usually 4455.";
    } else if (!/^[0-9]+$/.test(portRaw)) {
      errors.obsPort = "The port must be a whole number.";
    } else {
      var port = Number(portRaw);
      if (port < PORT_MIN || port > PORT_MAX) {
        errors.obsPort = "The port must be between " + PORT_MIN + " and " + PORT_MAX + ".";
      }
    }

    // Password OBS OPSIONAL: OBS bisa dijalankan tanpa autentikasi, dan memaksa
    // password di sini akan menolak konfigurasi OBS yang sah.

    // Balasan admin hanya dikirim SESUDAH sebuah produk terkonfirmasi ter-pin —
    // itu seluruh dasar AR3. Jadi menyalakannya tanpa pin menjanjikan sesuatu
    // yang tidak pernah bisa terjadi, dan ditolak di sini supaya customer tahu
    // SAAT MENYIMPAN, bukan nanti saat START BOT mati tanpa ia mengerti kenapa.
    if (f.sendAdminReply === true && f.autoPinProduct !== true) {
      errors.sendAdminReply = "Turn on Auto pin product first. The reply is only sent after a product is pinned.";
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
  function settingsView(view) {
    var status = (view && view.status) || null;
    var controls = controlsFor(view);
    return {
      // Belum ada config: itulah pekerjaan pertama customer.
      firstRun: !!(status && status.config && status.config.present === false),
      configured: !!(status && status.config && status.config.present === true),
      editable: controls.editingEnabled,
      hint: controls.editingEnabled ? "" : "Settings can only be changed while the automation is stopped.",
    };
  }

  // ---------------------------------------------------------------------------
  // Kendali tombol
  // ---------------------------------------------------------------------------

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
  function startBlockers(view) {
    var v = view || {};
    var status = v.status || null;

    // Tiga hal ini menutup semuanya, jadi tidak perlu daftar panjang.
    if (v.backendUnreachable) return [{ key: "backend", message: "Controller is not reachable." }];
    if (!status) return [{ key: "status", message: "Loading…" }];
    if (v.busy) return [{ key: "busy", message: "Working…" }];

    var out = [];

    // --- syarat dasar ---
    if (status.config && status.config.present === false) {
      out.push({ key: "config", message: "Save your settings first." });
    }
    if (status.login && status.login.active) {
      out.push({ key: "login", message: "Finish or cancel the TikTok sign-in first." });
    }

    var s = status.automation;
    var stopped = s === STATES.STOPPED;
    var errored = s === STATES.ERROR;
    var known =
      stopped || errored || s === STATES.RUNNING || s === STATES.DEGRADED ||
      s === STATES.STARTING || s === STATES.STOPPING || s === STATES.PREFLIGHT;

    if (!known) out.push({ key: "state", message: "Automation state is unknown." });
    else if (s === STATES.RUNNING || s === STATES.DEGRADED) out.push({ key: "state", message: "Automation is already running." });
    else if (s === STATES.STARTING || s === STATES.PREFLIGHT) out.push({ key: "state", message: "Automation is already starting." });
    else if (s === STATES.STOPPING) out.push({ key: "state", message: "Automation is still stopping." });

    // --- kesiapan. Kalimatnya dari server kalau ada; "Checking…" berarti BELUM
    //     DIKETAHUI, dan itu tetap memblokir. ---
    var obs = v.obs;
    if (!obs) out.push({ key: "obs", message: "Checking OBS…" });
    else if (obs.ok !== true) out.push({ key: "obs", message: messageOf(obs, "OBS is not connected.") });

    var tk = v.tiktok;
    if (!tk) {
      out.push({ key: "tiktok", message: "Checking TikTok…" });
    } else if (tk.ok !== true) {
      out.push({ key: "tiktok", message: messageOf(tk, "TikTok is not ready.") });
    } else {
      if (tk.identityOk === false) out.push({ key: "identity", message: "The TikTok account on screen is not the one you configured." });
      if (tk.live !== true) out.push({ key: "live", message: "Your TikTok LIVE is not on air yet." });
      if (typeof tk.productCount !== "number") out.push({ key: "products", message: "Checking LIVE products…" });
      else if (tk.productCount < 1) out.push({ key: "products", message: "No LIVE products detected." });
    }

    var val = v.validation;
    if (!val) out.push({ key: "mappings", message: "Checking your mappings…" });
    else if (val.ok !== true) out.push({ key: "mappings", message: messageOf(val, "Some of your scene mappings need fixing.") });

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
      if (!mode) out.push({ key: "mode", message: "Checking automation mode…" });
      else if (mode.ok !== true) {
        out.push({ key: "mode", message: mode.userMessage || "Real automation actions are not enabled." });
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
  function controlsFor(view) {
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
        startReason: "Controller is not reachable.",
      };
    }
    if (!status) {
      return {
        startEnabled: false, stopEnabled: false, editingEnabled: false,
        refreshEnabled: false, discoveryAllowed: false, startReason: "Loading…",
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
    var editingEnabled = !busy && (stopped || errored);

    // Start hidup HANYA kalau tidak ada satu pun penghalang. Semua syaratnya ada
    // di startBlockers(), termasuk kesiapan yang belum diketahui.
    var blockers = startBlockers(view);

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
  function mappingIssues(validation, count) {
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
        message: messageOf(r, "This mapping needs attention."),
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
  function activityText(e) {
    if (!e) return "";
    var scene = e.scene ? String(e.scene) : "";
    switch (e.type) {
      case "PLAY": return scene ? "Playing " + scene : "Scene started";
      case "PLAYBACK_END": return scene ? "Finished " + scene : "Scene finished";
      case "AUTOPIN_SUCCESS": return e.product ? "Product pinned — " + e.product : "Product pinned";
      case "AUTOPIN_FAILED": return messageOf(e, "Product was not pinned.");
      case "AUTOCOMMENT_SUCCESS": return "Admin reply sent";
      case "AUTOCOMMENT_FAILED": return messageOf(e, "Admin reply was not sent.");
      case "TIKTOK_CONNECTED": return "Connected to TikTok LIVE";
      case "TIKTOK_RECONNECTED": return "Reconnected to TikTok LIVE";
      case "TIKTOK_DISCONNECTED": return "Disconnected from TikTok LIVE";
      case "BOT_CRASHED": return "The bot stopped unexpectedly";
      case "SERVICE_CRASHED": return "The pin service stopped unexpectedly";
      case "LOGIN_WAITING": return "Waiting for TikTok login";
      case "LOGIN_OK": return "Signed in to TikTok";
      case "STATE": return e.to ? "Status: " + e.to : "Status changed";
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
  function activityTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
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
  function activityItems(events, limit) {
    var max = typeof limit === "number" && limit > 0 ? limit : MAX_ACTIVITY_ITEMS;
    var list = Array.isArray(events) ? events.slice() : [];
    // Server mengirim yang tertua lebih dulu; yang paling baru yang paling
    // berguna, jadi urutannya dibalik untuk tampilan.
    list.reverse();
    return list.slice(0, max).map(function (e) {
      return { id: e.id, time: activityTime(e.time), text: activityText(e), tone: activityTone(e) };
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
  var CHECK_LABELS = {
    config: "Settings",
    processes: "No other bot running",
    ports: "Ports available",
    obs: "OBS",
    scenes: "OBS scenes",
    profile: "Browser profile",
    tiktok: "TikTok LIVE",
    mappings: "Mappings",
  };

  function preflightRows(result) {
    if (!result || !result.checks) return [];
    var out = [];
    for (var name in CHECK_LABELS) {
      if (!Object.prototype.hasOwnProperty.call(CHECK_LABELS, name)) continue;
      var c = result.checks[name];
      if (!c) continue;
      if (c.ok === true) {
        out.push({ label: CHECK_LABELS[name], value: c.skipped ? "Skipped" : "Ready", tone: c.skipped ? TONE.NEUTRAL : TONE.READY });
      } else {
        out.push({ label: CHECK_LABELS[name], value: messageOf(c, "Not ready"), tone: TONE.ATTENTION });
      }
    }
    return out;
  }

  // Check yang gagal saja, untuk ditampilkan saat Start ditolak.
  function failedPreflight(result) {
    return preflightRows(result).filter(function (r) { return r.tone === TONE.ATTENTION; });
  }

  return {
    STATES: STATES,
    TONE: TONE,
    MAX_ACTIVITY_ITEMS: MAX_ACTIVITY_ITEMS,
    CHECK_LABELS: CHECK_LABELS,
    paxNumber: paxNumber,
    suggestForScene: suggestForScene,
    applySuggestion: applySuggestion,
    sceneOptions: sceneOptions,
    productOptions: productOptions,
    productLabel: productLabel,
    productSubLabel: productSubLabel,
    extraProductOption: extraProductOption,
    readinessRows: readinessRows,
    automationLabel: automationLabel,
    automationTone: automationTone,
    controlsFor: controlsFor,
    startBlockers: startBlockers,
    loginView: loginView,
    settingsToForm: settingsToForm,
    validateSettingsForm: validateSettingsForm,
    applySettingsToConfig: applySettingsToConfig,
    settingsView: settingsView,
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
  };
});
