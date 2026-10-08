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
 */
(function () {
  "use strict";

  var U = window.AiLiveUI;

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
      n.className = "field-note";
      n.textContent = note;
      wrap.appendChild(n);
    }
    return wrap;
  }

  function renderMappings() {
    var controls = U.controlsFor(state);
    var issues = U.mappingIssues(state.validation, state.rows.length);
    var resolved = U.resolvedTitles(state.validation, state.rows.length);
    var sceneOpts = U.sceneOptions(state.scenes, { playableScenes: null });
    var productOpts = U.productOptions(state.products);

    el.mappings.textContent = "";
    el["mappings-empty"].hidden = state.rows.length > 0;

    state.rows.forEach(function (row, index) {
      var card = document.createElement("div");
      card.className = "mapping" + (issues[index] ? " has-error" : "");
      card.setAttribute("data-index", String(index));

      var head = document.createElement("div");
      head.className = "mapping-head";
      var title = document.createElement("span");
      title.className = "mapping-title";
      title.textContent = "Mapping " + (index + 1);
      var remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn btn-ghost";
      remove.textContent = "Remove";
      remove.disabled = !controls.editingEnabled;
      remove.addEventListener("click", function () {
        state.rows.splice(index, 1);
        markDirty();
        renderMappings();
      });
      head.appendChild(title);
      head.appendChild(remove);
      card.appendChild(head);

      var grid = document.createElement("div");
      grid.className = "mapping-grid";

      // --- Scene ---
      var sceneSel = document.createElement("select");
      sceneSel.disabled = !controls.editingEnabled;
      sceneSel.appendChild(option("", state.scenes.length ? "Select a scene…" : "No scenes discovered yet"));
      sceneOpts.forEach(function (o) {
        sceneSel.appendChild(option(o.value, o.supported ? o.label : o.label + " (" + o.note + ")"));
      });
      // Scene tersimpan yang tidak ada di daftar discovery tetap ditampilkan apa
      // adanya, supaya nilainya tidak hilang diam-diam dari formulir.
      if (row.scene && !state.scenes.some(function (s) { return s === row.scene; })) {
        sceneSel.appendChild(option(row.scene, row.scene + " (not found in OBS)"));
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
      grid.appendChild(field("Scene", sceneSel));

      // --- Product ---
      var prodSel = document.createElement("select");
      prodSel.disabled = !controls.editingEnabled;
      prodSel.appendChild(option("", state.products.length ? "No product (scene only)" : "No products discovered yet"));
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
      grid.appendChild(field("Product", prodSel, resolved[index] ? "Matches: " + resolved[index] : ""));

      // --- Trigger ---
      var trig = document.createElement("textarea");
      trig.disabled = !controls.editingEnabled;
      trig.value = row.triggersText || "";
      trig.placeholder = "spill etalase 1";
      trig.addEventListener("input", function () {
        row.triggersText = trig.value;
        markDirty();
      });
      grid.appendChild(field("Viewer Trigger", trig, "One trigger per line."));

      // --- Reply ---
      var reply = document.createElement("input");
      reply.type = "text";
      reply.disabled = !controls.editingEnabled;
      reply.value = row.reply || "";
      reply.maxLength = 100;
      reply.placeholder = "Etalase 1 sudah aku pin ya kak";
      reply.addEventListener("input", function () {
        row.reply = reply.value;
        markDirty();
      });
      grid.appendChild(field("Admin Reply", reply, "Sent to chat after the pin is confirmed."));

      card.appendChild(grid);

      if (issues[index]) {
        var err = document.createElement("p");
        err.className = "mapping-error";
        err.textContent = issues[index].message;
        card.appendChild(err);
      }

      el.mappings.appendChild(card);
    });
  }

  function renderActivity() {
    var items = U.activityItems(state.activity);
    el.activity.textContent = "";
    el["activity-empty"].hidden = items.length > 0;
    items.forEach(function (it) {
      var li = document.createElement("li");
      li.className = it.tone || "";
      var at = document.createElement("span");
      at.className = "at";
      at.textContent = it.time;
      var what = document.createElement("span");
      what.className = "what";
      what.textContent = it.text;
      li.appendChild(at);
      li.appendChild(what);
      el.activity.appendChild(li);
    });
    setText(el["activity-hint"], items.length ? "Latest " + items.length : "");
  }

  function renderControls() {
    var c = U.controlsFor(state);
    el["start-btn"].disabled = !c.startEnabled;
    el["stop-btn"].disabled = !c.stopEnabled;
    el["refresh-btn"].disabled = !c.refreshEnabled;
    el["add-mapping-btn"].disabled = !c.editingEnabled;
    el["save-btn"].disabled = !c.editingEnabled || !state.dirty;

    var label = U.automationLabel(state.status);
    var tone = U.automationTone(state.status);
    setText(el["run-state"], label);
    setTone(el["run-state"], tone);
    setText(el["automation-pill"], label);
    setTone(el["automation-pill"], tone);
    el["automation-pill"].className = "pill " + (tone || "neutral");

    // Kenapa Start mati, kalau memang mati karena sesuatu.
    if (!c.startEnabled && c.startReason) setText(el["run-note"], c.startReason);
    else if (state.dirty && c.editingEnabled) setText(el["run-note"], "You have unsaved changes. They will be saved when you press START BOT.");
    else setText(el["run-note"], "");

    setText(el["mapping-hint"], c.editingEnabled ? "" : "Editing is disabled while the automation is running.");
  }

  function renderReadiness() {
    renderDefinitionList(
      el.readiness,
      U.readinessRows({ obs: state.obs, tiktok: state.tiktok, status: state.status, validation: state.validation })
    );
    var c = U.controlsFor(state);
    setText(
      el["readiness-hint"],
      c.discoveryAllowed ? "" : "Product details are only read while the automation is stopped."
    );
    renderLogin();
    // Panduan pertama kali hanya saat belum ada config sama sekali.
    var noConfig = !!(state.status && state.status.config && state.status.config.present === false);
    el.setup.hidden = !noConfig;
  }

  function renderLogin() {
    var lv = U.loginView(state);
    el["login-btn"].hidden = lv.state === "waiting";
    el["login-btn"].disabled = !lv.canLogin;
    el["login-btn"].textContent = lv.state === "connected" ? "SIGN IN AGAIN" : "LOGIN TIKTOK";
    el["login-check-btn"].hidden = !lv.canCheck && lv.state !== "waiting";
    el["login-check-btn"].disabled = !lv.canCheck;
    el["login-cancel-btn"].hidden = !lv.canCancel && lv.state !== "waiting";
    el["login-cancel-btn"].disabled = !lv.canCancel;
    setText(el["login-hint"], lv.hint);
  }

  // Pasangan field formulir <-> elemen input. Satu tempat, supaya membaca dan
  // menulis formulir tidak bisa menyimpang satu sama lain.
  var SETTINGS_FIELDS = [
    ["tiktokUsername", "set-tiktok-username"],
    ["expectedShop", "set-expected-shop"],
    ["obsHost", "set-obs-host"],
    ["obsPort", "set-obs-port"],
  ];

  function readSettingsForm() {
    var f = Object.assign({}, state.settings || {});
    SETTINGS_FIELDS.forEach(function (pair) {
      f[pair[0]] = el[pair[1]] ? el[pair[1]].value : "";
    });
    // Password hanya dibaca kalau customer memang sedang menggantinya.
    f.obsPassword = state.changingPassword && el["set-obs-password"] ? el["set-obs-password"].value : "";
    f.obsPasswordClear = state.changingPassword && f.obsPassword === "" ? true : false;
    return f;
  }

  function renderSettings() {
    var sv = U.settingsView(state);
    var f = state.settings || U.settingsToForm(null);

    SETTINGS_FIELDS.forEach(function (pair) {
      var node = el[pair[1]];
      if (!node) return;
      // Nilai hanya ditulis ulang kalau customer tidak sedang mengetik di kotak itu;
      // polling status tidak boleh memindahkan kursor atau menghapus ketikan.
      if (document.activeElement !== node) node.value = f[pair[0]] === undefined ? "" : String(f[pair[0]]);
      node.disabled = !sv.editable;

      var errNode = el["err-" + pair[0]];
      var msg = state.settingsErrors[pair[0]];
      if (errNode) {
        errNode.hidden = !msg;
        setText(errNode, msg || "");
      }
      node.setAttribute("aria-invalid", msg ? "true" : "false");
    });

    // Password OBS: yang tersimpan tidak pernah ada di halaman, jadi yang
    // ditampilkan hanya keadaannya.
    var pwInput = el["set-obs-password"];
    if (pwInput) {
      pwInput.hidden = !state.changingPassword;
      pwInput.disabled = !sv.editable;
      if (!state.changingPassword) pwInput.value = "";
    }
    setText(
      el["obs-password-label"],
      state.changingPassword
        ? "Type the new password, or leave empty to remove it."
        : f.obsPasswordSet
          ? "Password is configured."
          : "No password set."
    );
    el["obs-password-change"].hidden = state.changingPassword;
    el["obs-password-change"].disabled = !sv.editable;
    el["obs-password-change"].textContent = f.obsPasswordSet ? "Change" : "Set password";
    el["obs-password-cancel"].hidden = !state.changingPassword;
    el["obs-password-cancel"].disabled = !sv.editable;

    el["save-settings-btn"].disabled = !sv.editable || (!state.settingsDirty && sv.configured);
    setText(el["settings-hint"], sv.hint);
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
    setText(el["save-state"], "Unsaved changes");
    renderControls();
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
        showBanner("Changes saved. Stop and restart the automation to apply them.", "attention");
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
    var c = U.controlsFor(state);
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
  // terlihat dari tombol yang mati, pill automation, dan spanduk.
  function withBusy(label, fn, target) {
    state.busy = true;
    if (target) setText(el[target], label);
    renderControls();
    return Promise.resolve()
      .then(fn)
      .then(
        function (v) {
          state.busy = false;
          renderControls();
          return v;
        },
        function (e) {
          state.busy = false;
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
        setText(el["save-state"], "Saved");
        if (r.body.restartRequired) {
          showBanner("Changes saved. Stop and restart the automation to apply them.", "attention");
        } else {
          showBanner("", null);
        }
        return { ok: true };
      }
      // Kesalahan per field dari server. Ditampilkan apa adanya: kalimatnya
      // dibentuk di controller/errors.js, bukan di sini.
      var msgs = (r.body && r.body.errors ? r.body.errors : []).map(function (e) {
        return e.userMessage;
      });
      setText(el["save-state"], "Not saved");
      showBanner(msgs.length ? msgs.join(" · ") : U.messageOf(r.body, "The configuration could not be saved."), "error");
      return { ok: false };
    });
  }

  function onSave() {
    return withBusy("Saving…", function () {
      return saveConfig().then(function (r) {
        if (r.ok) return loadValidation().then(renderAll);
        renderAll();
      });
    }, "save-state");
  }

  function onRefresh() {
    return withBusy("Refreshing…", function () {
      return loadDiscovery()
        .then(loadStatus)
        .then(loadValidation)
        .then(function () {
          renderAll();
        });
    });
  }

  // START BOT.
  //
  // Urutannya penting dan tidak boleh dipotong: simpan dulu kalau ada perubahan,
  // segarkan discovery, jalankan preflight, dan HANYA kalau preflight lolos
  // panggil /api/start. Memanggil start lebih dulu berarti menyalakan proses di
  // atas keadaan yang belum diperiksa.
  function onStart() {
    el["start-btn"].disabled = true; // langsung, sebelum apa pun di-await
    return withBusy("Starting…", function () {
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
          var rows = U.preflightRows(r.body);
          renderDefinitionList(el.preflight, rows);
          el.preflight.hidden = rows.length === 0;

          if (!r.body || r.body.ok !== true) {
            // Preflight merah: JANGAN panggil /api/start.
            var failed = U.failedPreflight(r.body);
            showBanner(
              failed.length
                ? "Not ready to start: " + failed.map(function (f) { return f.label + " — " + f.value; }).join(" · ")
                : "Not ready to start.",
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
          showBanner(U.messageOf(r.body, "The automation could not be started."), "error");
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
    });
  }

  function onStop() {
    el["stop-btn"].disabled = true;
    return withBusy("Stopping safely…", function () {
      showBanner("Stopping safely…", null);
      return api("/api/stop", { method: "POST" })
        .then(function (r) {
          if (r.body && r.body.ok) showBanner("Automation stopped", "ready");
          else showBanner(U.messageOf(r.body, "The automation could not be stopped."), "error");
        })
        .then(loadStatus)
        // Katalog produk hanya bisa dibaca saat berhenti, jadi inilah saat yang
        // tepat untuk mengisinya kembali.
        .then(loadDiscovery)
        .then(loadValidation)
        .then(function () {
          renderAll();
        });
    });
  }

  // --- Settings -------------------------------------------------------------

  function onSaveSettings() {
    var form = readSettingsForm();

    // Validasi formulir lebih dulu, supaya field yang kurang disorot tanpa perlu
    // bolak-balik ke server.
    var verdict = U.validateSettingsForm(form);
    state.settings = form;
    state.settingsErrors = verdict.errors;
    if (!verdict.ok) {
      setText(el["settings-state"], "Not saved");
      showBanner("Some settings need attention.", "attention");
      renderSettings();
      return Promise.resolve({ ok: false });
    }

    return withBusy("Saving settings…", function () {
      // Dibangun dari config yang TERAKHIR DIBACA, jadi mapping dan setelan lain
      // tidak tersentuh. Password yang tidak diubah tidak dikirim sama sekali.
      var payload = U.applySettingsToConfig(state.config, form);
      payload.mappings = (state.rows || []).map(U.rowToMapping);

      return api("/api/config", { method: "PUT", body: payload }).then(function (r) {
        if (!(r.body && r.body.ok)) {
          // Server yang berwenang. Pesan per field darinya ditampilkan apa adanya;
          // config valid yang terakhir TIDAK tersentuh karena saveConfig
          // memvalidasi sebelum menulis.
          var msgs = (r.body && r.body.errors ? r.body.errors : []).map(function (e) {
            return e.userMessage;
          });
          setText(el["settings-state"], "Not saved");
          showBanner(msgs.length ? msgs.join(" · ") : U.messageOf(r.body, "The settings could not be saved."), "error");
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
        setText(el["settings-state"], "Saved");
        showBanner(r.body.restartRequired ? "Changes saved. Stop and restart the automation to apply them." : "", r.body.restartRequired ? "attention" : null);

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
    }, "settings-state");
  }

  function markSettingsDirty() {
    state.settingsDirty = true;
    setText(el["settings-state"], "Unsaved changes");
    el["save-settings-btn"].disabled = !U.settingsView(state).editable;
  }

  // --- login TikTok ---------------------------------------------------------
  //
  // Aplikasi TIDAK PERNAH menyentuh kredensial. Tombol ini hanya meminta
  // Controller membuka jendela browser; customer login sendiri di dalamnya.

  function onLogin() {
    return withBusy("Opening sign-in…", function () {
      showBanner("", null);
      return api("/api/tiktok/login/start", { method: "POST" })
        .then(function (r) {
          if (r.body && r.body.ok) {
            showBanner("Complete the TikTok login in the browser window, then press Check Login.", null);
          } else {
            showBanner(U.messageOf(r.body, "The sign-in window could not be opened."), "error");
          }
        })
        .then(loadStatus)
        .then(renderAll);
    });
  }

  function onLoginCheck() {
    return withBusy("Checking sign-in…", function () {
      return api("/api/tiktok/login/check", { method: "POST" })
        .then(function (r) {
          if (r.body && r.body.ok) {
            showBanner("Signed in as " + r.body.identity, "ready");
          } else {
            // "Belum selesai" bukan kegagalan: customer bisa menekan lagi.
            showBanner(U.messageOf(r.body, "Sign-in is not finished yet."), "attention");
          }
        })
        .then(loadStatus)
        // Login yang berhasil melepas profil, jadi katalog produk bisa dibaca lagi.
        .then(loadDiscovery)
        .then(loadValidation)
        .then(renderAll);
    });
  }

  function onLoginCancel() {
    return withBusy("Cancelling…", function () {
      return api("/api/tiktok/login/cancel", { method: "POST" })
        .then(function () {
          showBanner("", null);
        })
        .then(loadStatus)
        .then(renderAll);
    });
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

    el["refresh-btn"].addEventListener("click", onRefresh);
    el["save-btn"].addEventListener("click", onSave);
    el["start-btn"].addEventListener("click", onStart);
    el["stop-btn"].addEventListener("click", onStop);
    el["save-settings-btn"].addEventListener("click", onSaveSettings);
    SETTINGS_FIELDS.forEach(function (pair) {
      var node = el[pair[1]];
      if (node) node.addEventListener("input", markSettingsDirty);
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
      markDirty();
      renderMappings();
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
