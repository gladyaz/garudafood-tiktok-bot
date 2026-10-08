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

  function renderAll() {
    renderReadiness();
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
      state.dirty = false;
      setText(el["save-state"], "");
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

    if (c.discoveryAllowed) {
      jobs.push(guarded(api("/api/tiktok/status")).then(function (r) {
        if (r) state.tiktok = r.body;
      }));
      jobs.push(guarded(api("/api/tiktok/products")).then(function (r) {
        if (!r) return;
        state.products = r.body && Array.isArray(r.body.products) ? r.body.products : [];
      }));
    }
    return Promise.all(jobs);
  }

  function loadValidation() {
    return guarded(api("/api/mappings/validate", { method: "POST" })).then(function (r) {
      if (r) state.validation = r.body;
    });
  }

  // --- aksi -----------------------------------------------------------------

  function withBusy(label, fn) {
    state.busy = true;
    setText(el["save-state"], label);
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
    });
  }

  function onRefresh() {
    return withBusy("Refreshing…", function () {
      return loadDiscovery()
        .then(loadStatus)
        .then(loadValidation)
        .then(function () {
          setText(el["save-state"], state.dirty ? "Unsaved changes" : "");
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
          setText(el["save-state"], "");
          renderAll();
        });
    });
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
