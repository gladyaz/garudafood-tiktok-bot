/* AI LIVE HOST — perekat DOM.
 *
 * Berkas ini SENGAJA bodoh. Ia hanya:
 *   - memanggil API Controller
 *   - menyerahkan hasilnya ke AiLiveUI (ui-logic.js) untuk diputuskan
 *   - menulis hasil keputusan itu ke DOM
 *
 * Tidak ada keputusan di sini: tidak ada aturan tombol mana yang boleh ditekan,
 * tidak ada kalimat untuk customer, tidak ada batas jumlah kejadian. Semuanya ada
 * di ui-logic.js, yang bisa dipanggil langsung dari Node dan karenanya benar-benar
 * teruji. Repo ini tidak punya jsdom, jadi logika yang bersembunyi di dalam
 * handler DOM adalah logika yang tidak akan pernah diuji.
 *
 * Kalau nanti ada yang menambahkan percabangan di berkas ini, pindahkan ke
 * ui-logic.js dulu.
 *
 * BAHASA: tidak satu pun kalimat customer ditulis di berkas ini. Semuanya
 * datang dari i18n.js lewat T(), dan setiap fungsi ui-logic.js menerima bahasa
 * yang sedang dipilih sebagai argumen. Dengan begitu mengganti bahasa tidak
 * bisa meninggalkan satu kata pun dalam bahasa yang lama.
 *
 * TAMPILAN: bahasa dan tema adalah preferensi PRESENTASI. Keduanya disimpan
 * di localStorage lewat prefs.js dan TIDAK PERNAH menyentuh config.json, config
 * runtime, pemetaan, AutoPIN, AutoComment, atau apa pun yang menentukan apa
 * yang dilakukan bot.
 */
(function () {
  "use strict";

  var U = window.AiLiveUI;
  var I18N = window.AiLiveI18N;

  var prefs = window.AiLivePrefs.createPrefs({
    storage: (function () {
      // localStorage bisa melempar di konteks tertentu. Tanpa penyimpanan,
      // prefs tetap bekerja; preferensinya saja yang tidak bertahan.
      try {
        return window.localStorage;
      } catch (e) {
        return null;
      }
    })(),
    matchMedia: typeof window.matchMedia === "function"
      ? function (q) { return window.matchMedia(q); }
      : null,
  });

  // Bahasa yang sedang dipilih. SETIAP panggilan ke ui-logic.js menerima ini.
  function L() {
    return prefs.getLang();
  }

  function T(key, vars) {
    return I18N.t(L(), key, vars);
  }

  var REPLY_MAX = 100;

  // --- state halaman --------------------------------------------------------

  var state = {
    config: null, // config terakhir yang dibaca dari server (sudah teredaksi)
    settings: null, // bentuk formulir Settings; password tersimpan TIDAK ada di sini
    settingsErrors: {}, // pesan per field dari validasi formulir
    settingsDirty: false,
    changingPassword: false, // customer sedang mengganti password OBS
    rows: [], // baris formulir yang sedang disunting
    scenes: [], // dari /api/obs/scenes
    products: [], // dari /api/tiktok/products
    obs: null,
    tiktok: null,
    validation: null,
    status: null,
    activity: [],
    busy: false, // ada operasi Start/Stop/Save yang sedang berjalan
    backendUnreachable: false,
    dirty: false, // ada perubahan yang belum disimpan
    preflight: null,
    // Murni tampilan: tab mana yang terbuka, aturan mana yang sedang disunting,
    // dan aturan mana yang menunggu konfirmasi hapus. Tidak satu pun dikirim ke
    // server.
    tab: "rules",
    editing: null,
    confirmDelete: null,
  };

  var el = {};
  var statusTimer = null;

  function $(id) {
    return document.getElementById(id);
  }

  function cacheEls() {
    [
      "automation-pill", "refresh-btn", "banner", "readiness", "readiness-hint",
      "setup", "mappings", "mappings-empty", "mapping-hint", "add-mapping-btn",
      "save-btn", "save-state", "run-state", "run-note", "start-btn", "stop-btn",
      "preflight", "activity", "activity-empty", "activity-hint",
      "login-btn", "login-check-btn", "login-cancel-btn", "login-hint",
      "settings-hint", "settings-state", "save-settings-btn",
      "set-tiktok-username", "set-expected-shop", "set-obs-host", "set-obs-port",
      "set-obs-password", "obs-password-label", "obs-password-change", "obs-password-cancel",
      "err-tiktokUsername", "err-expectedShop", "err-obsHost", "err-obsPort",
      "set-auto-pin", "set-admin-reply", "err-autoPinProduct", "err-sendAdminReply",
      // Direction D
      "acct-chip", "acct-initials", "acct-name", "hero-over",
      "onair", "onair-title", "onair-sub", "onair-elapsed", "onair-chain",
      "ready-title", "ready-count", "ready-progress", "rules-count", "activity-count", "activity-cap",
      "lang-group", "theme-group",
    ].forEach(function (id) {
      el[id] = $(id);
    });
  }

  // --- transport ------------------------------------------------------------

  // Semua permintaan ke origin yang sama. Tidak ada CORS, tidak ada kredensial,
  // tidak ada header kustom: Controller hanya mendengarkan 127.0.0.1.
  function api(path, options) {
    var opts = Object.assign({ headers: {} }, options || {});
    if (opts.body !== undefined) {
      opts.headers["content-type"] = "application/json";
      opts.body = JSON.stringify(opts.body);
    }
    return fetch(path, opts).then(function (res) {
      return res
        .json()
        .catch(function () {
          return {};
        })
        .then(function (body) {
          return { status: res.status, ok: res.ok, body: body };
        });
    });
  }

  // Kegagalan jaringan adalah "Controller tidak terjangkau", bukan pengecualian
  // yang menghentikan halaman. Dari sana, controlsFor() mematikan Start.
  function guarded(promise) {
    return promise.then(
      function (r) {
        state.backendUnreachable = false;
        return r;
      },
      function () {
        state.backendUnreachable = true;
        return null;
      }
    );
  }

  // --- render ---------------------------------------------------------------

  function setText(node, text) {
    if (node) node.textContent = text === undefined || text === null ? "" : String(text);
  }

  function setTone(node, tone) {
    if (!node) return;
    ["ready", "running", "attention", "error", "neutral"].forEach(function (t) {
      node.classList.remove(t);
    });
    if (tone) node.classList.add(tone);
  }

  // Teks statis halaman, dari data-t="<kunci>". Dijalankan saat memuat DAN
  // setiap kali bahasa diganti, jadi tidak ada label yang bisa tertinggal.
  function fillStatic() {
    var nodes = document.querySelectorAll("[data-t]");
    for (var i = 0; i < nodes.length; i += 1) {
      setText(nodes[i], T(nodes[i].getAttribute("data-t")));
    }
    if (el["lang-group"]) el["lang-group"].setAttribute("aria-label", T("ui.lang.label"));
    if (el["theme-group"]) el["theme-group"].setAttribute("aria-label", T("ui.theme.label"));
  }

  function renderDefinitionList(node, rows) {
    if (!node) return;
    node.textContent = "";
    rows.forEach(function (r) {
      var dt = document.createElement("dt");
      dt.textContent = r.label;
      var dd = document.createElement("dd");
      dd.textContent = r.value;
      dd.className = r.tone || "";
      node.appendChild(dt);
      node.appendChild(dd);
    });
  }

  // Keadaan kosong: judul tebal, lalu satu kalimat yang mengatakan apa yang bisa
  // dilakukan. Keduanya elemen terpisah supaya tidak ada tanda pemisah yang
  // perlu diterjemahkan.
  function setEmpty(node, titleKey, bodyKey) {
    if (!node) return;
    node.textContent = "";
    var b = document.createElement("b");
    b.textContent = T(titleKey);
    var p = document.createElement("span");
    p.className = "muted";
    p.textContent = " " + T(bodyKey);
    node.appendChild(b);
    node.appendChild(p);
  }

  // Chip hitungan di tab. Nol tidak ditampilkan sebagai "0": chipnya yang
  // pergi, karena pil kosong bergaris terbaca sebagai sesuatu yang gagal dimuat.
  function setCount(node, n) {
    if (!node) return;
    node.hidden = !n;
    setText(node, n ? String(n) : "");
  }

  function showBanner(text, tone) {
    if (!el.banner) return;
    if (!text) {
      el.banner.hidden = true;
      setText(el.banner, "");
      return;
    }
    el.banner.hidden = false;
    setText(el.banner, text);
    el.banner.className = "banner" + (tone ? " " + tone : "");
  }

  function option(value, label, disabled) {
    var o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    if (disabled) o.disabled = true;
    return o;
  }

  function field(labelText, control, note) {
    var wrap = document.createElement("div");
    wrap.className = "field";
    var lab = document.createElement("label");
    lab.textContent = labelText;
    wrap.appendChild(lab);
    wrap.appendChild(control);
    if (note) {
      var n = document.createElement("div");
      n.className = "note";
      n.textContent = note;
      wrap.appendChild(n);
    }
    return wrap;
  }

  function chip(text, kind) {
    var s = document.createElement("span");
    s.className = "chip" + (kind ? " " + kind : "");
    s.textContent = text;
    return s;
  }

  function word(text, kind) {
    var s = document.createElement("span");
    s.className = kind || "word";
    s.textContent = text;
    return s;
  }

  function button(text, cls, onClick, disabled) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.textContent = text;
    b.disabled = !!disabled;
    b.addEventListener("click", onClick);
    return b;
  }

  // --- aturan otomatis ------------------------------------------------------

  // Satu aturan = satu kalimat, dan tombol Ubah membuka penyuntingnya di tempat.
  // Formulirnya sendiri tidak berubah dari sebelum Direction D: field yang sama,
  // peristiwa yang sama, dan nilai yang sama yang dikirim ke /api/config.
  function renderMappings() {
    var lang = L();
    var controls = U.controlsFor(state, lang);
    var issues = U.mappingIssues(state.validation, state.rows.length, lang);
    var resolved = U.resolvedTitles(state.validation, state.rows.length);
    var sceneOpts = U.sceneOptions(state.scenes, { playableScenes: null }, lang);
    var productOpts = U.productOptions(state.products, lang);

    el.mappings.textContent = "";
    el["mappings-empty"].hidden = state.rows.length > 0;
    if (state.rows.length === 0) setEmpty(el["mappings-empty"], "ui.rule.empty.title", "ui.rule.empty.body");
    setCount(el["rules-count"], state.rows.length);

    state.rows.forEach(function (row, index) {
      var chips = U.ruleChips(row, { scenes: state.scenes, resolvedTitle: resolved[index] }, lang);
      var editing = state.editing === index;

      var card = document.createElement("div");
      card.className = "rule" + (issues[index] ? " has-error" : "");
      card.setAttribute("data-index", String(index));

      // --- kalimatnya ---
      var main = document.createElement("div");
      main.className = "rule-main";

      var n = document.createElement("div");
      n.className = "rule-n";
      n.textContent = String(index + 1);
      main.appendChild(n);

      var body = document.createElement("div");

      var flow = document.createElement("div");
      flow.className = "flow";
      flow.appendChild(word(T("ui.rule.lead")));
      if (chips.triggers.length) {
        chips.triggers.forEach(function (t) {
          flow.appendChild(chip(t, "trig"));
        });
      } else {
        flow.appendChild(chip(chips.triggersEmpty, "trig off"));
      }
      flow.appendChild(word("→", "arrow"));
      flow.appendChild(word(T("ui.rule.thenScene")));
      flow.appendChild(chip(chips.scene || T("ui.rule.f.scenePick"), chips.scene ? "scene" : "scene off"));
      flow.appendChild(word("→", "arrow"));
      flow.appendChild(word(T("ui.rule.thenPin")));
      flow.appendChild(chip(chips.product || chips.productNone, chips.product ? "prod" : "prod off"));
      body.appendChild(flow);

      if (chips.reply) {
        var rep = document.createElement("div");
        rep.className = "rule-reply";
        rep.appendChild(word(T("ui.rule.reply")));
        var q = document.createElement("q");
        q.textContent = chips.reply;
        rep.appendChild(q);
        body.appendChild(rep);
      }

      // Catatan tentang isi aturan: scene yang tidak ada di OBS, dan judul yang
      // sebenarnya terlihat di LIVE.
      [chips.sceneMissing, chips.resolved].forEach(function (note) {
        if (!note) return;
        var p = document.createElement("div");
        p.className = "rule-reply muted";
        p.textContent = note;
        body.appendChild(p);
      });

      if (issues[index]) {
        var err = document.createElement("p");
        err.className = "rule-error";
        err.textContent = issues[index].message;
        body.appendChild(err);
      }
      main.appendChild(body);

      // --- aksi ---
      var actions = document.createElement("div");
      actions.className = "rule-actions";
      actions.appendChild(
        button(editing ? T("ui.btn.done") : T("ui.btn.edit"), "btn btn-sm", function () {
          state.editing = editing ? null : index;
          state.confirmDelete = null;
          renderMappings();
        }, !controls.editingEnabled)
      );
      // Hapus dalam dua langkah, tanpa jendela modal: klik pertama mengubah
      // tombolnya menjadi konfirmasi. Dialog browser akan membekukan halaman,
      // dan halaman ini dipakai orang di tengah LIVE.
      if (state.confirmDelete === index) {
        actions.appendChild(
          button(T("ui.btn.deleteYes"), "btn btn-sm btn-stop", function () {
            state.rows.splice(index, 1);
            state.editing = null;
            state.confirmDelete = null;
            markDirty();
            renderMappings();
          }, !controls.editingEnabled)
        );
      } else {
        actions.appendChild(
          button(T("ui.btn.deleteRule"), "btn btn-sm", function () {
            state.confirmDelete = index;
            renderMappings();
          }, !controls.editingEnabled)
        );
      }
      main.appendChild(actions);
      card.appendChild(main);

      if (editing) card.appendChild(mappingEditor(row, index, sceneOpts, productOpts, resolved, controls));
      el.mappings.appendChild(card);
    });
  }

  // Penyunting satu aturan. Perilakunya SAMA seperti sebelum Direction D —
  // hanya tempatnya yang berpindah ke dalam kartu.
  function mappingEditor(row, index, sceneOpts, productOpts, resolved, controls) {
    var grid = document.createElement("div");
    grid.className = "rule-edit";

    // --- Scene ---
    var sceneSel = document.createElement("select");
    sceneSel.disabled = !controls.editingEnabled;
    sceneSel.appendChild(option("", state.scenes.length ? T("ui.rule.f.scenePick") : T("ui.rule.f.noScenes")));
    sceneOpts.forEach(function (o) {
      sceneSel.appendChild(option(o.value, o.supported ? o.label : o.label + " (" + o.note + ")"));
    });
    // Scene tersimpan yang tidak ada di daftar discovery tetap ditampilkan apa
    // adanya, supaya nilainya tidak hilang diam-diam dari formulir.
    if (row.scene && !state.scenes.some(function (s) { return s === row.scene; })) {
      sceneSel.appendChild(option(row.scene, T("ui.rule.f.sceneMissing", { scene: row.scene })));
    }
    sceneSel.value = row.scene || "";
    sceneSel.addEventListener("change", function () {
      row.scene = sceneSel.value;
      // Saran PAX hanya mengisi yang masih kosong — keputusannya di ui-logic.js.
      var suggested = U.applySuggestion({ trigger: row.triggersText, reply: row.reply }, row.scene);
      row.triggersText = suggested.trigger || "";
      row.reply = suggested.reply || "";
      markDirty();
      renderMappings();
    });
    grid.appendChild(field(T("ui.rule.f.scene"), sceneSel));

    // --- Product ---
    var prodSel = document.createElement("select");
    prodSel.disabled = !controls.editingEnabled;
    prodSel.appendChild(option("", state.products.length ? T("ui.rule.f.productNone") : T("ui.rule.f.noProducts")));
    productOpts.forEach(function (o) {
      prodSel.appendChild(option(o.value, o.sub ? o.label + " — " + o.sub : o.label));
    });
    // Nilai tersimpan yang bukan salah satu judul katalog tetap dapat opsinya
    // sendiri, supaya tidak hilang dari formulir. Apakah produknya masih ada di
    // LIVE diputuskan server, dan tampil sebagai pesan di baris ini.
    var extra = U.extraProductOption(row.productTitle, state.products, resolved[index]);
    if (extra) {
      prodSel.appendChild(option(extra.value, extra.resolved ? extra.label + " → " + extra.resolved : extra.label));
    }
    prodSel.value = row.productTitle || "";
    prodSel.addEventListener("change", function () {
      row.productTitle = prodSel.value;
      markDirty();
      renderMappings();
    });
    grid.appendChild(
      field(T("ui.rule.f.product"), prodSel, resolved[index] ? T("ui.rule.f.resolved", { title: resolved[index] }) : "")
    );

    // --- Trigger ---
    var trig = document.createElement("textarea");
    trig.disabled = !controls.editingEnabled;
    trig.rows = 3;
    trig.value = row.triggersText || "";
    trig.placeholder = T("ui.rule.f.triggersPlaceholder");
    trig.addEventListener("input", function () {
      row.triggersText = trig.value;
      markDirty();
    });
    grid.appendChild(field(T("ui.rule.f.triggers"), trig, T("ui.rule.f.triggersHelp")));

    // --- Reply ---
    var reply = document.createElement("input");
    reply.type = "text";
    reply.disabled = !controls.editingEnabled;
    reply.value = row.reply || "";
    reply.maxLength = REPLY_MAX;
    var replyField = field(
      T("ui.rule.f.reply"),
      reply,
      T("ui.rule.f.replyHelp", { n: (row.reply || "").length, max: REPLY_MAX })
    );
    reply.addEventListener("input", function () {
      row.reply = reply.value;
      // Hitungan hurufnya ikut mengetik. Tanpa ini customer baru tahu batasnya
      // saat ketikannya terpotong.
      var note = replyField.querySelector(".note");
      if (note) note.textContent = T("ui.rule.f.replyHelp", { n: reply.value.length, max: REPLY_MAX });
      markDirty();
    });
    replyField.className = "field wide";
    grid.appendChild(replyField);

    return grid;
  }

  // --- aktivitas ------------------------------------------------------------

  function renderActivity() {
    var lang = L();
    var items = U.activityItems(state.activity, undefined, lang);
    el.activity.textContent = "";
    el["activity-empty"].hidden = items.length > 0;
    if (!items.length) setEmpty(el["activity-empty"], "ui.act.empty.title", "ui.act.empty.body");
    items.forEach(function (it) {
      var li = document.createElement("li");
      li.className = it.tone || "";
      var at = document.createElement("span");
      at.className = "feed-time";
      at.textContent = it.time;
      var what = document.createElement("span");
      what.className = "feed-what";
      what.textContent = it.text;
      li.appendChild(at);
      li.appendChild(what);
      el.activity.appendChild(li);
    });
    setText(el["activity-hint"], items.length ? T("ui.act.latest", { n: items.length }) : "");
    setCount(el["activity-count"], items.length);
    setText(el["activity-cap"], items.length ? U.activityCapText(lang) : "");
  }

  // --- kendali --------------------------------------------------------------

  function renderControls() {
    var lang = L();
    var c = U.controlsFor(state, lang);
    // Keadaan terkunci Settings disegarkan di sini juga, pada irama yang sama
    // dengan tombol lain. Lihat renderSettingsEnabled().
    renderSettingsEnabled();
    el["start-btn"].disabled = !c.startEnabled;
    el["stop-btn"].disabled = !c.stopEnabled;
    el["refresh-btn"].disabled = !c.refreshEnabled;
    el["add-mapping-btn"].disabled = !c.editingEnabled;
    el["save-btn"].disabled = !c.editingEnabled || !state.dirty;

    // Lampu tally: kosakatanya sendiri, diputuskan di ui-logic.js.
    var tally = U.tallyView(state, lang);
    setText(el["automation-pill"], tally.label);
    el["automation-pill"].className = "tally " + (tally.tone || "neutral");

    // Kartu status.
    var hero = U.heroView(state, lang);
    setText(el["hero-over"], hero.over);
    setText(el["run-state"], hero.title);
    setTone(el["run-state"], hero.tone);
    // Kenapa Start mati, atau apa yang terjadi pada perubahan yang belum
    // disimpan. Keduanya kalimat dari kamus, bukan dari sini.
    if (state.dirty && c.editingEnabled) setText(el["run-note"], T("ui.note.dirtyOnStart"));
    else setText(el["run-note"], hero.note);

    renderOnAir();
    setText(el["mapping-hint"], c.editingEnabled ? "" : U.mappingHint(state, lang));
  }

  // Kartu "sedang tayang". Disembunyikan kalau tidak ada yang tayang; setiap
  // angkanya datang dari kejadian yang sungguh dikirim server.
  function renderOnAir() {
    var v = U.onairView(state, L());
    el.onair.hidden = !v.visible;
    if (!v.visible) return;
    setText(el["onair-title"], v.title);
    setText(el["onair-sub"], v.sub);
    setText(el["onair-elapsed"], v.elapsed);
    el["onair-elapsed"].setAttribute("aria-label", v.elapsedLabel);

    el["onair-chain"].textContent = "";
    v.chain.forEach(function (s) {
      var box = document.createElement("div");
      box.className = "oc" + (s.tone === "ready" ? "" : " wait");
      var lab = document.createElement("span");
      lab.textContent = s.label;
      var val = document.createElement("b");
      val.textContent = s.value;
      box.appendChild(lab);
      box.appendChild(val);
      el["onair-chain"].appendChild(box);
    });
  }

  // --- kesiapan -------------------------------------------------------------

  function renderReadiness() {
    var lang = L();
    renderDefinitionList(
      el.readiness,
      U.readinessRows({ obs: state.obs, tiktok: state.tiktok, status: state.status, validation: state.validation, busy: state.busy }, lang)
    );

    // Hitungan dan sel progres: satu sel per syarat, warnanya mengikuti barisnya.
    // Saat berjalan, readyView mengembalikan daftar kosong - lihat sebabnya di
    // ui-logic.js. Kosong di sini berarti barisnya saja yang bicara.
    var ready = U.readyView(state, lang);
    setText(el["ready-title"], ready.title);
    setText(el["ready-count"], ready.label);
    el["ready-progress"].textContent = "";
    el["ready-progress"].hidden = !ready.counting;
    ready.cells.forEach(function (tone) {
      var s = document.createElement("span");
      if (tone === "ready") s.className = "on";
      else if (tone === "attention") s.className = "bad";
      el["ready-progress"].appendChild(s);
    });

    // Kalimatnya diputuskan di ui-logic.js, bukan di sini: kalimat customer
    // tidak boleh hidup di lapisan DOM, karena di sana ia tidak bisa diuji.
    setText(el["readiness-hint"], U.readinessHint(state, lang));
    renderLogin();
    // Panduan pertama kali hanya saat belum ada config sama sekali.
    var noConfig = !!(state.status && state.status.config && state.status.config.present === false);
    el.setup.hidden = !noConfig;
  }

  function renderLogin() {
    var lv = U.loginView(state, L());
    el["login-btn"].hidden = lv.state === "waiting";
    el["login-btn"].disabled = !lv.canLogin;
    el["login-btn"].textContent = lv.state === "connected" ? T("ui.btn.loginAgain") : T("ui.btn.login");
    el["login-check-btn"].hidden = !lv.canCheck && lv.state !== "waiting";
    el["login-check-btn"].disabled = !lv.canCheck;
    el["login-cancel-btn"].hidden = !lv.canCancel && lv.state !== "waiting";
    el["login-cancel-btn"].disabled = !lv.canCancel;
    setText(el["login-hint"], lv.hint);

    // Chip akun di bilah atas. Nama akunnya datang dari loginView — SATU tempat
    // yang memutuskan siapa yang sedang masuk.
    var name = lv.identity || "";
    el["acct-chip"].hidden = !name;
    if (name) {
      setText(el["acct-name"], name);
      setText(el["acct-initials"], name.slice(0, 2).toUpperCase());
    }
  }

  // Pasangan field formulir <-> elemen input. Satu tempat, supaya membaca dan
  // menulis formulir tidak bisa menyimpang satu sama lain.
  // Pemetaan field <-> id node hidup di ui-logic.js, SATU sumber. Dengan begitu
  // tes bisa menjalankan interaksi yang SAMA atas node palsu — repo ini tidak
  // punya jsdom, dan tes yang hanya mencocokkan teks sumber app.js tidak akan
  // pernah menangkap bug URUTAN seperti yang terjadi pada 2026-10-08.
  var SETTINGS_FIELDS = U.SETTINGS_FIELD_IDS;
  var SETTINGS_TOGGLES = U.SETTINGS_TOGGLE_IDS;

  function readSettingsForm() {
    return U.readSettingsNodes(
      function (id) {
        return el[id];
      },
      state.settings,
      state.changingPassword
    );
  }

  // HANYA keadaan boleh/tidak-boleh disunting: disabled + hint. TIDAK menyentuh
  // satu pun NILAI.
  //
  // Dipisahkan karena keduanya punya irama yang berbeda, dan menyatukannya
  // adalah sebab bug 2026-10-08: renderSettings() menuliskan disabled=true dari
  // dalam jendela busy (renderAll dipanggil DI DALAM withBusy), lalu tidak ada
  // yang pernah menuliskannya kembali — polling hanya memanggil renderControls,
  // renderReadiness, dan renderActivity. Jadi checkbox customer mati dan tidak
  // pernah hidup lagi sampai halaman dimuat ulang.
  //
  // Sekarang fungsi ini dipanggil dari renderControls(), yang ikut setiap
  // polling. Jadi keadaan terkunci TIDAK BISA lagi tertinggal.
  //
  // Dan ia sengaja TIDAK menulis nilai: `state.settings` hanya disegarkan dari
  // server (loadConfig) atau dari formulir saat menyimpan, jadi menulis nilai
  // setiap 2 detik akan MENGHAPUS centang customer sebelum ia menekan Save.
  function renderSettingsEnabled() {
    var sv = U.settingsView(state, L());

    SETTINGS_FIELDS.forEach(function (pair) {
      var node = el[pair[1]];
      if (node) node.disabled = !sv.editable;
    });
    SETTINGS_TOGGLES.forEach(function (pair) {
      var node = el[pair[1]];
      if (node) node.disabled = !sv.editable;
    });

    var pwInput = el["set-obs-password"];
    if (pwInput) pwInput.disabled = !sv.editable;
    el["obs-password-change"].disabled = !sv.editable;
    el["obs-password-cancel"].disabled = !sv.editable;
    // first-run: Save tetap hidup walau belum ada perubahan, supaya customer
    // bisa menyimpan default sebagai config pertamanya.
    el["save-settings-btn"].disabled = !sv.editable || (!state.settingsDirty && sv.configured);

    setText(el["settings-hint"], sv.hint);
  }

  function renderSettings() {
    // Hanya NILAI dan error per field. Keadaan terkunci ada di
    // renderSettingsEnabled().
    var f = state.settings || U.settingsToForm(null);

    // NILAI lewat fungsi yang SAMA yang dijalankan tes interaksi atas node
    // palsu. Kotak yang sedang diketik customer dilewati: polling tidak boleh
    // memindahkan kursor atau menghapus ketikan.
    U.writeSettingsNodes(
      function (id) {
        return el[id];
      },
      f,
      function (id) {
        return !!el[id] && document.activeElement === el[id];
      }
    );

    // Error + aria per field. Satu lintasan untuk field teks DAN saklar; dua
    // salinan loop yang sama hanya menunggu salah satunya menyimpang.
    SETTINGS_FIELDS.concat(SETTINGS_TOGGLES).forEach(function (pair) {
      var node = el[pair[1]];
      var errNode = el["err-" + pair[0]];
      var msg = state.settingsErrors[pair[0]];
      if (errNode) {
        errNode.hidden = !msg;
        setText(errNode, msg || "");
      }
      if (node) node.setAttribute("aria-invalid", msg ? "true" : "false");
    });

    // Password OBS: yang tersimpan tidak pernah ada di halaman, jadi yang
    // ditampilkan hanya keadaannya.
    var pwInput = el["set-obs-password"];
    if (pwInput) {
      pwInput.hidden = !state.changingPassword;
      if (!state.changingPassword) pwInput.value = "";
    }
    setText(
      el["obs-password-label"],
      state.changingPassword
        ? T("ui.set.passwordChangeHelp")
        : f.obsPasswordSet
          ? T("ui.set.passwordSaved")
          : T("ui.set.passwordNone")
    );
    el["obs-password-change"].hidden = state.changingPassword;
    el["obs-password-change"].textContent = f.obsPasswordSet ? T("ui.btn.change") : T("ui.btn.setPw");
    el["obs-password-cancel"].hidden = !state.changingPassword;

    // Keadaan terkunci + hint diurus renderSettingsEnabled(), SATU tempat.
    // Menyalinnya ke sini berarti dua tempat menulis atribut yang sama, dan
    // salah satunya akan menyimpang.
    renderSettingsEnabled();
  }

  function renderAll() {
    renderReadiness();
    renderSettings();
    renderLogin();
    renderMappings();
    renderControls();
    renderActivity();
  }

  function markDirty() {
    state.dirty = true;
    setText(el["save-state"], T("ui.set.dirty"));
    renderControls();
  }

  // --- tab, bahasa, tema ----------------------------------------------------

  // Murni tampilan. Tidak satu pun dari ketiganya mengirim apa pun ke server.
  function renderTabs() {
    var tabs = document.querySelectorAll("[data-tab]");
    for (var i = 0; i < tabs.length; i += 1) {
      var name = tabs[i].getAttribute("data-tab");
      tabs[i].setAttribute("aria-selected", name === state.tab ? "true" : "false");
    }
    var panels = document.querySelectorAll("[data-panel]");
    for (var j = 0; j < panels.length; j += 1) {
      panels[j].hidden = panels[j].getAttribute("data-panel") !== state.tab;
    }
  }

  function renderPrefButtons() {
    var lang = prefs.getLang();
    var theme = prefs.getTheme();
    var lb = document.querySelectorAll("[data-lang-btn]");
    for (var i = 0; i < lb.length; i += 1) {
      lb[i].setAttribute("aria-pressed", lb[i].getAttribute("data-lang-btn") === lang ? "true" : "false");
    }
    var tb = document.querySelectorAll("[data-theme-btn]");
    for (var j = 0; j < tb.length; j += 1) {
      tb[j].setAttribute("aria-pressed", tb[j].getAttribute("data-theme-btn") === theme ? "true" : "false");
    }
  }

  // Bahasa berganti seketika, tanpa memuat ulang dan tanpa menyentuh server:
  // teks statis diisi lagi, lalu seluruh halaman dirender dari state yang SAMA.
  function setLang(value) {
    prefs.setLang(value);
    prefs.applyTo(document.documentElement);
    fillStatic();
    renderPrefButtons();
    renderAll();
  }

  function setTheme(value) {
    prefs.setTheme(value);
    prefs.applyTo(document.documentElement);
    renderPrefButtons();
  }

  // --- pemuatan data --------------------------------------------------------

  function loadConfig() {
    return guarded(api("/api/config")).then(function (r) {
      if (!r) return;
      if (r.body && r.body.ok && r.body.config) {
        state.config = r.body.config;
        state.rows = (r.body.config.mappings || []).map(U.mappingToRow);
      } else if (r.body && r.body.defaults) {
        // Belum ada config: pakai default yang aman sebagai titik awal, dan
        // biarkan operator membuat yang pertama dari UI.
        state.config = r.body.defaults;
        state.rows = [];
      }
      // Formulir Settings dibangun dari config yang sama. Password tersimpan TIDAK
      // ikut — server hanya mengirim passwordSet.
      state.settings = U.settingsToForm(state.config);
      state.settingsErrors = {};
      state.settingsDirty = false;
      state.changingPassword = false;
      state.dirty = false;
      setText(el["save-state"], "");
      setText(el["settings-state"], "");
    });
  }

  function loadStatus() {
    return guarded(api("/api/status")).then(function (r) {
      if (!r) return;
      state.status = r.body;
      if (r.body && r.body.restartRequired) {
        showBanner(T("ui.banner.savedRestart"), "attention");
      }
    });
  }

  function loadActivity() {
    var since = state.activity.length ? state.activity[state.activity.length - 1].id : undefined;
    var path = "/api/activity?limit=" + U.MAX_ACTIVITY_ITEMS + (since ? "&sinceId=" + since : "");
    return guarded(api(path)).then(function (r) {
      if (!r || !r.body || !Array.isArray(r.body.events)) return;
      state.activity = U.mergeActivity(state.activity, r.body.events);
    });
  }

  // Discovery MAHAL (membuka browser), jadi tidak pernah dipanggil dari polling.
  // Hanya saat muat pertama, saat Refresh ditekan, dan sekali sebelum Start.
  function loadDiscovery() {
    var c = U.controlsFor(state, L());
    var jobs = [guarded(api("/api/obs/scenes")).then(function (r) {
      if (!r) return;
      state.obs = r.body;
      state.scenes = r.body && Array.isArray(r.body.scenes) ? r.body.scenes : [];
    })];

    // Discovery TikTok DISERIALKAN, dan itu wajib.
    //
    // /api/tiktok/status dan /api/tiktok/products MASING-MASING membuka Chrome
    // dengan profil automation yang SAMA, dan Chrome mengunci satu direktori
    // profil ke satu proses. Dijalankan bersamaan, salah satunya kalah dengan
    // `profile-in-use`.
    //
    // Terlihat di UI sungguhan pada 2026-10-08: status menang (identitas terbaca,
    // "Connected as <akun>") sementara products kalah, sehingga panel
    // kesiapan melaporkan "Products: None detected" padahal katalognya tidak
    // pernah benar-benar dibaca. Angka yang salah itu sekarang ikut menentukan
    // apakah START BOT boleh ditekan, jadi ia harus benar.
    return Promise.all(jobs).then(function () {
      if (!c.discoveryAllowed) return null;
      return guarded(api("/api/tiktok/status"))
        .then(function (r) {
          if (r) state.tiktok = r.body;
          return guarded(api("/api/tiktok/products"));
        })
        .then(function (r) {
          if (!r) return;
          state.products = r.body && Array.isArray(r.body.products) ? r.body.products : [];
        });
    });
  }

  function loadValidation() {
    return guarded(api("/api/mappings/validate", { method: "POST" })).then(function (r) {
      if (r) state.validation = r.body;
    });
  }

  // --- aksi -----------------------------------------------------------------

  // `target` adalah id label status yang BOLEH ditulis operasi ini.
  //
  // Sebelum P4.1.1 fungsi ini selalu menulis ke "save-state", yaitu label milik
  // bagian Mapping. Akibatnya menyimpan Settings menampilkan "Saving settings…"
  // di sebelah tombol Save Changes milik Mapping — dan label itu tertinggal di
  // sana walau Settings sudah melaporkan "Saved". Refresh, Start, dan Stop juga
  // menimpanya dengan cara yang sama.
  //
  // Sekarang setiap operasi hanya boleh menyentuh labelnya sendiri, dan yang tidak
  // punya label (Refresh/Start/Stop) tidak menulis ke mana pun — kemajuannya sudah
  // terlihat dari tombol yang mati, lampu tally, dan spanduk.
  function withBusy(label, fn, target, op) {
    state.busy = true;
    // Nama operasinya, bukan hanya "ada sesuatu yang berjalan". Penyuntingan
    // Settings hanya dikunci oleh operasi yang BENAR-BENAR menulis config;
    // Refresh/discovery tidak. Lihat CONFIG_WRITE_OPS di ui-logic.js.
    state.busyOp = op || null;
    if (target) setText(el[target], label);
    renderControls();
    return Promise.resolve()
      .then(fn)
      .then(
        function (v) {
          state.busy = false;
          state.busyOp = null;
          renderControls();
          return v;
        },
        function (e) {
          state.busy = false;
          state.busyOp = null;
          renderControls();
          throw e;
        }
      );
  }

  function saveConfig() {
    var payload = U.buildConfigPayload(state.config, state.rows);
    if (!payload) return Promise.resolve({ ok: false });
    return api("/api/config", { method: "PUT", body: payload }).then(function (r) {
      if (r.body && r.body.ok) {
        state.config = r.body.config;
        state.dirty = false;
        state.editing = null;
        setText(el["save-state"], T("ui.set.saved"));
        if (r.body.restartRequired) {
          showBanner(T("ui.banner.savedRestart"), "attention");
        } else {
          showBanner("", null);
        }
        return { ok: true };
      }
      // Kesalahan per field dari server. Jalur mesin seperti mappings[0].product
      // diubah menjadi label yang bisa dibaca customer — kode dan jalur mentah
      // tidak pernah tampil di UI biasa.
      var msgs = (r.body && r.body.errors ? r.body.errors : []).map(function (e) {
        return I18N.fieldProblem(L(), e.path || e.field, e.reason || e.code, e.userMessage);
      });
      setText(el["save-state"], T("ui.set.notSaved"));
      showBanner(
        msgs.length ? msgs.join(" · ") : U.messageOf(L(), r.body, "err.config-write-failed"),
        "error"
      );
      return { ok: false };
    });
  }

  function onSave() {
    return withBusy(T("ui.rule.savingRules"), function () {
      return saveConfig().then(function (r) {
        if (r.ok) return loadValidation().then(renderAll);
        renderAll();
      });
    }, "save-state", "saveMappings");
  }

  function onRefresh() {
    return withBusy("", function () {
      return loadDiscovery()
        .then(loadStatus)
        .then(loadValidation)
        .then(function () {
          renderAll();
        });
    }, null, "refresh");
  }

  // START BOT.
  //
  // Urutannya penting dan tidak boleh dipotong: simpan dulu kalau ada perubahan,
  // segarkan discovery, jalankan preflight, dan HANYA kalau preflight lolos
  // panggil /api/start. Memanggil start lebih dulu berarti menyalakan proses di
  // atas keadaan yang belum diperiksa.
  function onStart() {
    el["start-btn"].disabled = true; // langsung, sebelum apa pun di-await
    return withBusy("", function () {
      showBanner("", null);
      el.preflight.hidden = true;

      var chain = Promise.resolve();
      if (state.dirty) {
        chain = chain.then(saveConfig).then(function (r) {
          if (!r.ok) throw new Error("config-not-saved");
        });
      }

      return chain
        .then(loadDiscovery)
        .then(loadValidation)
        .then(function () {
          return api("/api/preflight", { method: "POST" });
        })
        .then(function (r) {
          state.preflight = r.body;
          var rows = U.preflightRows(r.body, L());
          renderDefinitionList(el.preflight, rows);
          el.preflight.hidden = rows.length === 0;

          if (!r.body || r.body.ok !== true) {
            // Preflight merah: JANGAN panggil /api/start.
            var failed = U.failedPreflight(r.body, L());
            showBanner(
              failed.length
                ? T("ui.banner.notReady", {
                    reasons: failed.map(function (f) { return f.label + " — " + f.value; }).join(" · "),
                  })
                : T("ui.banner.notReadyPlain"),
              "attention"
            );
            return null;
          }
          return api("/api/start", { method: "POST" });
        })
        .then(function (r) {
          if (!r) return null;
          if (r.body && r.body.ok) {
            showBanner("", null);
            return null;
          }
          showBanner(U.messageOf(L(), r.body, "err.controller-start-failed"), "error");
          return null;
        })
        .then(function () {
          return loadStatus();
        })
        .then(function () {
          renderAll();
        })
        .catch(function () {
          // Satu-satunya jalan ke sini adalah penyimpanan yang gagal; pesannya
          // sudah tampil dari saveConfig().
          return loadStatus().then(renderAll);
        });
    }, null, "start");
  }

  function onStop() {
    el["stop-btn"].disabled = true;
    return withBusy("", function () {
      showBanner(T("ui.note.stopping"), null);
      return api("/api/stop", { method: "POST" })
        .then(function (r) {
          if (r.body && r.body.ok) showBanner(T("ui.note.stopped"), "ready");
          else showBanner(U.messageOf(L(), r.body, "err.unknown"), "error");
        })
        .then(loadStatus)
        // LANGSUNG dirender, SEBELUM discovery. Urutan ini tidak boleh diubah.
        //
        // Terbukti dari LIVE 2026-10-10: server melaporkan STOPPED dalam 1,0
        // detik, lalu layar TETAP berbunyi "SEDANG TAYANG" dan "Bot
        // mendengarkan chat LIVE Anda" selama puluhan detik — karena render
        // dulu menunggu loadDiscovery (yang membuka Chrome), sementara
        // withBusy menahan polling sepanjang rantai ini. Spanduk berkata
        // berhenti dan semua yang lain berkata berjalan, di layar yang sama.
        //
        // Customer yang membacanya menyimpulkan STOP gagal, lalu menutup paksa
        // aplikasinya — dan penutupan paksa itulah yang dulu meninggalkan
        // .bot.lock dan Chrome yatim.
        .then(function () {
          renderAll();
        })
        // Katalog produk hanya bisa dibaca saat berhenti, jadi inilah saat yang
        // tepat untuk mengisinya kembali. Lambat, dan boleh lambat: layar sudah
        // jujur sejak baris di atas.
        .then(loadDiscovery)
        .then(loadValidation)
        .then(function () {
          renderAll();
        });
    }, null, "stop");
  }

  // --- Settings -------------------------------------------------------------

  function onSaveSettings() {
    var form = readSettingsForm();

    // Validasi formulir lebih dulu, supaya field yang kurang disorot tanpa perlu
    // bolak-balik ke server.
    var verdict = U.validateSettingsForm(form, L());
    state.settings = form;
    state.settingsErrors = verdict.errors;
    if (!verdict.ok) {
      setText(el["settings-state"], T("ui.set.notSaved"));
      showBanner(T("ui.banner.settingsBad"), "attention");
      renderSettings();
      return Promise.resolve({ ok: false });
    }

    return withBusy(T("ui.rule.savingSettings"), function () {
      // Dibangun dari config yang TERAKHIR DIBACA, jadi mapping dan setelan lain
      // tidak tersentuh. Password yang tidak diubah tidak dikirim sama sekali.
      var payload = U.applySettingsToConfig(state.config, form);
      payload.mappings = (state.rows || []).map(U.rowToMapping);

      return api("/api/config", { method: "PUT", body: payload }).then(function (r) {
        if (!(r.body && r.body.ok)) {
          // Server yang berwenang. Pesan per field darinya ditampilkan dengan
          // label yang bisa dibaca customer; config valid yang terakhir TIDAK
          // tersentuh karena saveConfig memvalidasi sebelum menulis.
          var msgs = (r.body && r.body.errors ? r.body.errors : []).map(function (e) {
            return I18N.fieldProblem(L(), e.path || e.field, e.reason || e.code, e.userMessage);
          });
          setText(el["settings-state"], T("ui.set.notSaved"));
          showBanner(
            msgs.length ? msgs.join(" · ") : U.messageOf(L(), r.body, "err.config-write-failed"),
            "error"
          );
          renderAll();
          return { ok: false };
        }

        // Tersimpan. Formulir dibangun ulang dari hasil server — termasuk
        // passwordSet yang baru — dan kotak password ditutup lagi.
        state.config = r.body.config;
        state.settings = U.settingsToForm(r.body.config);
        state.settingsErrors = {};
        state.settingsDirty = false;
        state.changingPassword = false;
        setText(el["settings-state"], T("ui.set.saved"));
        showBanner(r.body.restartRequired ? T("ui.banner.savedRestart") : "", r.body.restartRequired ? "attention" : null);

        // Kesiapan disegarkan: dengan OBS dan akun terisi, discovery sekarang bisa
        // menjawab, dan LOGIN TIKTOK boleh dipakai.
        return loadStatus()
          .then(loadDiscovery)
          .then(loadValidation)
          .then(function () {
            renderAll();
            return { ok: true };
          });
      });
    }, "settings-state", "saveSettings");
  }

  function markSettingsDirty() {
    // DOM adalah yang PALING BARU, dan state disamakan dengannya DI SINI —
    // sebelum apa pun merender.
    //
    // Tanpa baris ini renderSettings() menuliskan kembali nilai LAMA dari
    // state.settings, dan centang customer hilang seketika. Itu terjadi
    // sungguhan pada 2026-10-08: klik "Auto pin product" tidak bertahan, lalu
    // klik "Send admin reply" melaporkan "Turn on Auto pin product first" —
    // karena dari sudut pandang state, Auto pin memang masih mati.
    //
    // Sejak sekarang state.settings SELALU mencerminkan apa yang TERLIHAT
    // customer, bukan config terakhir yang dibaca dari server.
    state.settings = readSettingsForm();
    state.settingsDirty = true;
    setText(el["settings-state"], T("ui.set.dirty"));
    el["save-settings-btn"].disabled = !U.settingsView(state, L()).editable;
  }

  // --- login TikTok ---------------------------------------------------------
  //
  // Aplikasi TIDAK PERNAH menyentuh kredensial. Tombol ini hanya meminta
  // Controller membuka jendela browser; customer login sendiri di dalamnya.

  function onLogin() {
    return withBusy("", function () {
      showBanner("", null);
      return api("/api/tiktok/login/start", { method: "POST" })
        .then(function (r) {
          if (r.body && r.body.ok) {
            showBanner(T("ui.login.hintWaiting"), null);
          } else {
            showBanner(U.messageOf(L(), r.body, "err.login-browser-failed"), "error");
          }
        })
        .then(loadStatus)
        .then(renderAll);
    }, null, "loginStart");
  }

  function onLoginCheck() {
    return withBusy("", function () {
      return api("/api/tiktok/login/check", { method: "POST" })
        .then(function (r) {
          if (r.body && r.body.ok) {
            showBanner(T("ui.login.signedIn", { name: r.body.identity }), "ready");
          } else {
            // "Belum selesai" bukan kegagalan: customer bisa menekan lagi.
            showBanner(U.messageOf(L(), r.body, "err.login-not-finished"), "attention");
          }
        })
        .then(loadStatus)
        // Login yang berhasil melepas profil, jadi katalog produk bisa dibaca lagi.
        .then(loadDiscovery)
        .then(loadValidation)
        .then(renderAll);
    }, null, "loginCheck");
  }

  function onLoginCancel() {
    return withBusy("", function () {
      return api("/api/tiktok/login/cancel", { method: "POST" })
        .then(function () {
          showBanner("", null);
        })
        .then(loadStatus)
        .then(renderAll);
    }, null, "loginCancel");
  }

  // --- polling --------------------------------------------------------------

  // Status dan activity murah: boleh sering. Discovery TIDAK ikut di sini.
  function startPolling() {
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = setInterval(function () {
      if (state.busy) return;
      Promise.all([loadStatus(), loadActivity()]).then(function () {
        renderControls();
        renderReadiness();
        renderActivity();
      });
    }, 2000);
  }

  // --- awal -----------------------------------------------------------------

  function init() {
    cacheEls();

    // Bahasa dan tema lebih dulu: halaman tidak boleh sempat terlihat dalam
    // bahasa atau tema yang salah.
    prefs.applyTo(document.documentElement);
    fillStatic();
    renderPrefButtons();
    renderTabs();

    el["refresh-btn"].addEventListener("click", onRefresh);
    el["save-btn"].addEventListener("click", onSave);
    el["start-btn"].addEventListener("click", onStart);
    el["stop-btn"].addEventListener("click", onStop);
    el["save-settings-btn"].addEventListener("click", onSaveSettings);
    SETTINGS_FIELDS.forEach(function (pair) {
      var node = el[pair[1]];
      if (node) node.addEventListener("input", markSettingsDirty);
    });
    SETTINGS_TOGGLES.forEach(function (pair) {
      var node = el[pair[1]];
      // "change", bukan "input": itulah peristiwa checkbox.
      if (node) node.addEventListener("change", function () {
        // markSettingsDirty() menyalin DOM -> state.settings LEBIH DULU, jadi
        // validasi dan render di bawah bekerja atas pilihan customer yang BARU.
        markSettingsDirty();
        // Divalidasi dari STATE, bukan dengan membaca DOM lagi: satu sumber,
        // dan tidak ada celah di antara keduanya.
        state.settingsErrors = U.validateSettingsForm(state.settings, L()).errors;
        // Dirender ulang supaya error "nyalakan Auto pin dulu" muncul seketika,
        // bukan baru saat Save ditekan.
        renderSettings();
      });
    });
    el["set-obs-password"].addEventListener("input", markSettingsDirty);
    el["obs-password-change"].addEventListener("click", function () {
      state.changingPassword = true;
      markSettingsDirty();
      renderSettings();
      if (el["set-obs-password"]) el["set-obs-password"].focus();
    });
    el["obs-password-cancel"].addEventListener("click", function () {
      // Membatalkan penggantian: password yang tersimpan dibiarkan apa adanya,
      // karena ia tidak pernah ada di halaman untuk bisa hilang.
      state.changingPassword = false;
      renderSettings();
    });
    el["login-btn"].addEventListener("click", onLogin);
    el["login-check-btn"].addEventListener("click", onLoginCheck);
    el["login-cancel-btn"].addEventListener("click", onLoginCancel);
    el["add-mapping-btn"].addEventListener("click", function () {
      state.rows.push(U.mappingToRow(U.blankMapping()));
      // Aturan yang baru dibuat langsung terbuka: kalimatnya masih kosong, dan
      // yang dibutuhkan customer berikutnya adalah formulirnya.
      state.editing = state.rows.length - 1;
      state.confirmDelete = null;
      markDirty();
      renderMappings();
    });

    // Tab.
    var tabs = document.querySelectorAll("[data-tab]");
    for (var i = 0; i < tabs.length; i += 1) {
      (function (node) {
        node.addEventListener("click", function () {
          state.tab = node.getAttribute("data-tab");
          renderTabs();
        });
      })(tabs[i]);
    }

    // Bahasa dan tema.
    var langBtns = document.querySelectorAll("[data-lang-btn]");
    for (var j = 0; j < langBtns.length; j += 1) {
      (function (node) {
        node.addEventListener("click", function () {
          setLang(node.getAttribute("data-lang-btn"));
        });
      })(langBtns[j]);
    }
    var themeBtns = document.querySelectorAll("[data-theme-btn]");
    for (var k = 0; k < themeBtns.length; k += 1) {
      (function (node) {
        node.addEventListener("click", function () {
          setTheme(node.getAttribute("data-theme-btn"));
        });
      })(themeBtns[k]);
    }
    // Tema "ikut sistem" berarti ikut BERUBAH bersama sistem, juga saat halaman
    // sedang terbuka. Pilihan customer yang eksplisit tidak tersentuh di sini.
    prefs.onSystemChange(function () {
      prefs.applyTo(document.documentElement);
    });

    renderAll();

    loadStatus()
      .then(loadConfig)
      .then(loadDiscovery)
      .then(loadValidation)
      .then(loadActivity)
      .then(function () {
        renderAll();
        startPolling();
      });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
