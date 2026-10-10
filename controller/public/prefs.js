/* AI LIVE HOST — preferensi tampilan. MURNI, tanpa DOM langsung.
 *
 * Dua preferensi, dan keduanya HANYA soal tampilan:
 *   bahasa  id | en | zh-CN          bawaan: id
 *   tema    system | light | dark    bawaan: system
 *
 * KENAPA TIDAK DI config.json
 * Config adalah masukan untuk runtime config yang dibaca bot dan service. Ia
 * punya skema bernomor versi, validator, dan tes kontrak; menambah field di
 * sana berarti menyentuh semantik runtime config yang sedang dibekukan. Bahasa
 * dan tema tidak pernah boleh mengubah satu pun keputusan otomasi, jadi ia
 * tidak punya urusan di berkas yang dibaca mesin. Tempatnya localStorage.
 *
 * Konsekuensi yang perlu diketahui: preferensi ini per profil Electron di satu
 * mesin. Ia tidak ikut berpindah komputer, dan kalau data situs dibersihkan ia
 * kembali ke bawaan - yang memang bahasa Indonesia dan tema system.
 *
 * SEMUANYA DISUNTIK
 * `storage`, `matchMedia` dan `root` adalah parameter, bukan global. Tanpa itu
 * modul ini hanya bisa diuji di dalam browser, dan repo ini tidak punya jsdom.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AiLivePrefs = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var LANG_KEY = "ailive:lang";
  var THEME_KEY = "ailive:theme";

  var LANGS = ["id", "en", "zh-CN"];
  var DEFAULT_LANG = "id";

  var THEMES = ["system", "light", "dark"];
  var DEFAULT_THEME = "system";

  /* ----------------------------------------------------------------------
     Validasi. Nilai yang tidak dikenal TIDAK PERNAH dipakai: ia jatuh ke
     bawaan. Berkas localStorage bisa disunting tangan, bisa tersisa dari versi
     lama, dan bisa rusak; satu-satunya jawaban yang aman adalah bawaan.
     ---------------------------------------------------------------------- */

  function normalizeLang(value) {
    if (typeof value !== "string") return DEFAULT_LANG;
    var v = value.trim();
    if (LANGS.indexOf(v) !== -1) return v;
    // Toleran pada bentuk yang wajar: "zh", "zh-Hans", "ZH-hans-CN", "en-GB".
    var low = v.toLowerCase();
    if (low === "zh" || low.indexOf("zh-") === 0 || low.indexOf("zh_") === 0) return "zh-CN";
    var base = low.split(/[-_]/)[0];
    if (base === "id" || base === "in") return "id"; // "in" adalah kode lama Indonesia
    if (base === "en") return "en";
    return DEFAULT_LANG;
  }

  function normalizeTheme(value) {
    if (typeof value !== "string") return DEFAULT_THEME;
    var v = value.trim().toLowerCase();
    return THEMES.indexOf(v) !== -1 ? v : DEFAULT_THEME;
  }

  /* ----------------------------------------------------------------------
     Penyimpanan yang tidak pernah melempar.
     localStorage bisa melempar sendiri di jendela privat atau saat data situs
     diblokir. Dashboard tidak boleh gagal dimuat hanya karena preferensi tidak
     bisa dibaca.
     ---------------------------------------------------------------------- */

  function safeGet(storage, key) {
    try {
      return storage && typeof storage.getItem === "function" ? storage.getItem(key) : null;
    } catch (e) {
      return null;
    }
  }

  function safeSet(storage, key, value) {
    try {
      if (storage && typeof storage.setItem === "function") {
        storage.setItem(key, value);
        return true;
      }
    } catch (e) {
      /* diabaikan dengan sengaja: lihat catatan di atas */
    }
    return false;
  }

  /* ----------------------------------------------------------------------
     createPrefs
     ---------------------------------------------------------------------- */

  function createPrefs(options) {
    var opts = options || {};
    var storage = opts.storage || null;
    var mql = null;

    // matchMedia disuntik supaya preferensi sistem bisa dipalsukan di tes.
    var makeMql = opts.matchMedia || null;

    function systemPrefersDark() {
      if (!makeMql) return false;
      try {
        if (!mql) mql = makeMql("(prefers-color-scheme: dark)");
        return !!(mql && mql.matches);
      } catch (e) {
        return false;
      }
    }

    var lang = normalizeLang(safeGet(storage, LANG_KEY));
    var theme = normalizeTheme(safeGet(storage, THEME_KEY));

    function getLang() { return lang; }

    function setLang(value) {
      var next = normalizeLang(value);
      lang = next;
      safeSet(storage, LANG_KEY, next);
      return next;
    }

    function getTheme() { return theme; }

    function setTheme(value) {
      var next = normalizeTheme(value);
      theme = next;
      safeSet(storage, THEME_KEY, next);
      return next;
    }

    // Tema yang BENAR-BENAR dipakai: "system" diterjemahkan ke terang/gelap di
    // sini, supaya CSS hanya pernah melihat dua nilai dan tidak perlu punya
    // cabang ketiga.
    function effectiveTheme() {
      if (theme === "light" || theme === "dark") return theme;
      return systemPrefersDark() ? "dark" : "light";
    }

    // Satu-satunya tempat yang menyentuh DOM, dan hanya dua atribut.
    function applyTo(el) {
      if (!el) return null;
      var eff = effectiveTheme();
      try {
        el.setAttribute("data-theme", eff);
        el.setAttribute("data-lang", lang);
        if ("lang" in el) el.lang = lang;
      } catch (e) {
        /* elemen palsu di tes boleh saja tidak lengkap */
      }
      return eff;
    }

    // Perubahan preferensi sistem hanya berarti saat tema = system. Kalau
    // customer sudah memilih terang atau gelap, pilihannya menang.
    function onSystemChange(cb) {
      if (!makeMql || typeof cb !== "function") return function () {};
      try {
        if (!mql) mql = makeMql("(prefers-color-scheme: dark)");
        if (!mql) return function () {};
        var handler = function () {
          if (theme === "system") cb(effectiveTheme());
        };
        if (typeof mql.addEventListener === "function") {
          mql.addEventListener("change", handler);
          return function () { mql.removeEventListener("change", handler); };
        }
        if (typeof mql.addListener === "function") {
          mql.addListener(handler);
          return function () { mql.removeListener(handler); };
        }
      } catch (e) {
        /* tanpa matchMedia, tema system tetap jatuh ke terang */
      }
      return function () {};
    }

    return {
      getLang: getLang,
      setLang: setLang,
      getTheme: getTheme,
      setTheme: setTheme,
      effectiveTheme: effectiveTheme,
      systemPrefersDark: systemPrefersDark,
      applyTo: applyTo,
      onSystemChange: onSystemChange,
    };
  }

  return {
    LANG_KEY: LANG_KEY,
    THEME_KEY: THEME_KEY,
    LANGS: LANGS,
    THEMES: THEMES,
    DEFAULT_LANG: DEFAULT_LANG,
    DEFAULT_THEME: DEFAULT_THEME,
    normalizeLang: normalizeLang,
    normalizeTheme: normalizeTheme,
    createPrefs: createPrefs,
  };
});
