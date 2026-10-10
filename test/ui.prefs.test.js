// Preferensi tampilan: bahasa dan tema.
//
// Dua hal yang dijaga keras di sini, dan keduanya pernah jadi sumber bug nyata
// di produk lain:
//
//   1. Nilai tersimpan yang TIDAK DIKENAL tidak boleh pernah dipakai. Berkas
//      penyimpanan bisa disunting tangan, bisa sisa versi lama, bisa rusak.
//      Satu-satunya jawaban yang aman adalah bawaan.
//   2. Preferensi ini tidak boleh menyentuh apa pun selain dirinya sendiri.
//      Bahasa dan tema murni tampilan; begitu ia bisa menulis ke config, ia
//      bisa mengubah perilaku otomasi.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const P = require("../controller/public/prefs.js");

/* --- penyimpanan palsu yang mencatat apa saja yang disentuh --------------- */
function fakeStorage(seed) {
  const data = Object.assign({}, seed || {});
  const touched = { get: [], set: [] };
  return {
    data,
    touched,
    getItem(k) { touched.get.push(k); return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem(k, v) { touched.set.push(k); data[k] = String(v); },
  };
}

// matchMedia palsu yang bisa diubah di tengah tes, seperti pengguna mengganti
// tema Windows saat aplikasi terbuka.
function fakeMatchMedia(initialDark) {
  const listeners = [];
  const mql = {
    matches: !!initialDark,
    addEventListener(type, fn) { if (type === "change") listeners.push(fn); },
    removeEventListener(type, fn) {
      const i = listeners.indexOf(fn);
      if (i !== -1) listeners.splice(i, 1);
    },
  };
  const make = () => mql;
  make.set = (dark) => {
    mql.matches = !!dark;
    listeners.slice().forEach((fn) => fn({ matches: mql.matches }));
  };
  make.listenerCount = () => listeners.length;
  return make;
}

/* === bahasa ============================================================== */

test("peluncuran pertama memakai bahasa Indonesia", () => {
  const prefs = P.createPrefs({ storage: fakeStorage() });
  assert.equal(prefs.getLang(), "id");
  assert.equal(P.DEFAULT_LANG, "id");
});

test("pilihan bahasa tersimpan dan dipulihkan pada peluncuran berikutnya", () => {
  const store = fakeStorage();
  const first = P.createPrefs({ storage: store });
  first.setLang("zh-CN");
  assert.equal(store.data["ailive:lang"], "zh-CN");

  // "peluncuran berikutnya": instance baru, penyimpanan yang sama.
  const second = P.createPrefs({ storage: store });
  assert.equal(second.getLang(), "zh-CN");
});

test("bahasa tersimpan yang TIDAK SAH jatuh ke Indonesia", () => {
  for (const bad of ["", "   ", "klingon", "xx-YY", "null", "{}", "123", "de"]) {
    const prefs = P.createPrefs({ storage: fakeStorage({ "ailive:lang": bad }) });
    assert.equal(prefs.getLang(), "id", "untuk nilai tersimpan: " + JSON.stringify(bad));
  }
});

test("bahasa tersimpan yang rusak bentuknya tetap dikenali kalau maksudnya jelas", () => {
  const cases = [
    ["zh", "zh-CN"], ["zh-Hans", "zh-CN"], ["ZH-hans-CN", "zh-CN"], ["zh_CN", "zh-CN"],
    ["en-GB", "en"], ["EN", "en"],
    ["id-ID", "id"], ["in", "id"], // "in" adalah kode ISO lama untuk Indonesia
  ];
  for (const [stored, want] of cases) {
    const prefs = P.createPrefs({ storage: fakeStorage({ "ailive:lang": stored }) });
    assert.equal(prefs.getLang(), want, stored);
  }
});

test("menyetel bahasa tak dikenal tidak menyimpan sampah", () => {
  const store = fakeStorage();
  const prefs = P.createPrefs({ storage: store });
  prefs.setLang("klingon");
  assert.equal(prefs.getLang(), "id");
  assert.equal(store.data["ailive:lang"], "id");
});

/* === tema ================================================================ */

test("bawaan tema adalah system", () => {
  const prefs = P.createPrefs({ storage: fakeStorage() });
  assert.equal(prefs.getTheme(), "system");
  assert.equal(P.DEFAULT_THEME, "system");
});

test("pilihan terang/gelap tersimpan dan dipulihkan", () => {
  const store = fakeStorage();
  P.createPrefs({ storage: store }).setTheme("dark");
  assert.equal(store.data["ailive:theme"], "dark");
  assert.equal(P.createPrefs({ storage: store }).getTheme(), "dark");
});

test("tema tersimpan yang TIDAK SAH jatuh ke system", () => {
  for (const bad of ["", "midnight", "DARKK", "true", "0", "auto"]) {
    const prefs = P.createPrefs({ storage: fakeStorage({ "ailive:theme": bad }) });
    assert.equal(prefs.getTheme(), "system", JSON.stringify(bad));
  }
});

test("system mengikuti preferensi sistem operasi", () => {
  const dark = P.createPrefs({ storage: fakeStorage(), matchMedia: fakeMatchMedia(true) });
  assert.equal(dark.getTheme(), "system");
  assert.equal(dark.effectiveTheme(), "dark");

  const light = P.createPrefs({ storage: fakeStorage(), matchMedia: fakeMatchMedia(false) });
  assert.equal(light.effectiveTheme(), "light");
});

test("pilihan customer MENANG atas preferensi sistem", () => {
  const prefs = P.createPrefs({ storage: fakeStorage(), matchMedia: fakeMatchMedia(true) });
  prefs.setTheme("light");
  assert.equal(prefs.effectiveTheme(), "light", "sistem gelap, tapi customer memilih terang");
  prefs.setTheme("dark");
  assert.equal(prefs.effectiveTheme(), "dark");
});

test("tanpa matchMedia sama sekali, system tetap menghasilkan terang", () => {
  // Lingkungan tanpa matchMedia tidak boleh membuat tema jadi undefined.
  const prefs = P.createPrefs({ storage: fakeStorage() });
  assert.equal(prefs.effectiveTheme(), "light");
});

test("perubahan tema sistem hanya diberitahukan saat tema = system", () => {
  const mm = fakeMatchMedia(false);
  const prefs = P.createPrefs({ storage: fakeStorage(), matchMedia: mm });
  const seen = [];
  prefs.onSystemChange((eff) => seen.push(eff));

  mm.set(true);
  assert.deepEqual(seen, ["dark"], "tema system harus ikut berubah");

  prefs.setTheme("light");
  mm.set(false);
  mm.set(true);
  assert.deepEqual(seen, ["dark"], "sesudah customer memilih sendiri, sistem tidak lagi mengubah apa pun");
});

test("berhenti mendengarkan benar-benar melepas pendengar", () => {
  const mm = fakeMatchMedia(false);
  const prefs = P.createPrefs({ storage: fakeStorage(), matchMedia: mm });
  const off = prefs.onSystemChange(() => {});
  assert.equal(mm.listenerCount(), 1);
  off();
  assert.equal(mm.listenerCount(), 0);
});

/* === menerapkan ke DOM =================================================== */

test("applyTo menulis dua atribut, dan hanya dua", () => {
  const written = {};
  const el = { lang: "", setAttribute(k, v) { written[k] = v; } };
  const prefs = P.createPrefs({ storage: fakeStorage(), matchMedia: fakeMatchMedia(true) });
  prefs.setLang("en");

  const eff = prefs.applyTo(el);
  assert.equal(eff, "dark");
  assert.deepEqual(Object.keys(written).sort(), ["data-lang", "data-theme"]);
  assert.equal(written["data-theme"], "dark");
  assert.equal(written["data-lang"], "en");
  assert.equal(el.lang, "en");
});

/* === pagar: preferensi tampilan tidak boleh menyentuh apa pun yang lain === */

test("PAGAR: hanya dua kunci penyimpanan yang pernah ditulis", () => {
  const store = fakeStorage();
  const prefs = P.createPrefs({ storage: store, matchMedia: fakeMatchMedia(false) });
  prefs.setLang("en");
  prefs.setTheme("dark");
  prefs.setLang("zh-CN");
  prefs.setTheme("system");

  const unique = [...new Set(store.touched.set)].sort();
  assert.deepEqual(unique, ["ailive:lang", "ailive:theme"]);
});

test("PAGAR: modul preferensi tidak menyentuh config sama sekali", () => {
  const src = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "controller", "public", "prefs.js"),
    "utf8"
  );
  // Tidak boleh ada jalan dari sini ke config, runtime config, atau API.
  for (const forbidden of ["/api/", "config", "mapping", "autopin", "autocomment", "runtime"]) {
    assert.ok(
      !new RegExp(forbidden, "i").test(src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")),
      'prefs.js tidak boleh menyebut "' + forbidden + '" di luar komentar'
    );
  }
});

test("penyimpanan yang melempar tidak pernah merusak halaman", () => {
  const hostile = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
  };
  const prefs = P.createPrefs({ storage: hostile });
  assert.equal(prefs.getLang(), "id");
  assert.equal(prefs.getTheme(), "system");
  assert.equal(prefs.setLang("en"), "en", "pilihan tetap berlaku untuk sesi ini");
  assert.equal(prefs.getLang(), "en");
});

test("tanpa penyimpanan sama sekali pun modul tetap bekerja", () => {
  const prefs = P.createPrefs({});
  assert.equal(prefs.getLang(), "id");
  assert.equal(prefs.setTheme("dark"), "dark");
  assert.equal(prefs.effectiveTheme(), "dark");
});
