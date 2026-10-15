/* AI LIVE HOST — aksi per-aturan. MURNI, tanpa I/O, tanpa DOM.
 *
 * Satu aturan pemetaan menjawab "kalau penonton mengetik ini, apa yang terjadi".
 * Sampai v0.1.1 jawabannya selalu tiga hal sekaligus: ganti scene, pin produk,
 * balas komentar. Itu benar untuk etalase, dan SALAH untuk semua yang lain —
 * scene FAQ harga tidak punya produk untuk dipin, dan scene "ini AI ya?" tidak
 * pernah ingin menyentuh daftar produk sama sekali.
 *
 * Berkas ini satu-satunya tempat yang memutuskan aksi mana yang berlaku untuk
 * sebuah aturan. Ia dipakai oleh LIMA lapisan:
 *
 *   controller/config-manager.js     validasi bentuk config
 *   controller/mapping-validator.js  validasi terhadap OBS + katalog LIVE
 *   controller/preflight.js          prasyarat sebelum start
 *   runtime/mappings.js              snapshot yang dipakai bot saat LIVE
 *   controller/public/ui-logic.js    penyunting aturan di dashboard
 *
 * Kelimanya MENGIMPOR fungsi ini, tidak menyalinnya. Repo ini sudah pernah
 * membayar harga salinan yang menyimpang: tiruan normalizeTitleKey di validator
 * kehilangan satu aturan pemotongan judul, dan akibatnya Controller mengatakan
 * "produk ketemu" untuk produk yang tidak akan pernah ditemukan saat LIVE.
 * Aturan "lolos validasi" dan "benar-benar dijalankan" tidak boleh bisa berbeda
 * arti, dan satu-satunya cara menjamin itu adalah satu implementasi.
 *
 * Dimuat dua cara, dan harus bekerja di keduanya:
 *   node     require("../runtime/rule-actions.js")  -> module.exports
 *   browser  <script src="/rule-actions.js">        -> window.AiLiveRuleActions
 *
 * ---------------------------------------------------------------------------
 * KENAPA TIDAK ADA YANG DEFAULT-NYA MATI
 *
 * Aturan lama tidak punya field actions. Ia HARUS tetap berperilaku persis
 * seperti sebelumnya, jadi ketiadaan field berarti ketiganya menyala — bukan
 * ketiganya mati, dan bukan "diisi saat aplikasi start".
 *
 * Config customer TIDAK PERNAH ditulis ulang hanya karena aplikasi dibuka.
 * Menuliskan default ke berkas berarti satu versi aplikasi diam-diam mengubah
 * berkas yang dibaca versi lain, dan customer tidak pernah meminta itu.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AiLiveRuleActions = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Urutannya BERARTI: inilah urutan aksi dijalankan saat LIVE, dan urutan
  // ketiga kotak centang tampil di penyunting aturan.
  var ACTION_NAMES = ["switchScene", "autoPin", "autoReply"];

  // Aturan tanpa actions sama sekali. Dibekukan supaya tidak ada pemanggil yang
  // bisa mengubah bawaan untuk pemanggil lain.
  var LEGACY_ACTIONS = Object.freeze({ switchScene: true, autoPin: true, autoReply: true });

  function isPlainObject(v) {
    return !!v && typeof v === "object" && !Array.isArray(v);
  }

  // Aksi yang BERLAKU untuk sebuah pemetaan.
  //
  // Setiap kunci yang hilang — field actions yang tidak ada, atau satu kunci
  // yang tidak ada di dalamnya — berarti MENYALA. Jadi { autoPin: false } pada
  // aturan FAQ tetap mengganti scene dan tetap membalas, dan tidak ada yang
  // perlu mengingat untuk menuliskan dua kunci lainnya.
  //
  // Nilai yang bukan boolean diabaikan, bukan ditebak: "false" sebagai string
  // adalah berkas yang rusak, dan validator-lah yang menolaknya. Di sini ia
  // jatuh ke perilaku lama, yang aman.
  function resolveActions(mapping) {
    var raw = mapping && mapping.actions;
    var out = { switchScene: true, autoPin: true, autoReply: true };
    if (!isPlainObject(raw)) return out;
    for (var i = 0; i < ACTION_NAMES.length; i += 1) {
      var name = ACTION_NAMES[i];
      if (typeof raw[name] === "boolean") out[name] = raw[name];
    }
    return out;
  }

  // Apakah aturan ini MENYATAKAN aksinya sendiri, atau mewarisi bawaan lama.
  //
  // Bedanya penting, dan hanya untuk VALIDASI — bukan untuk apa yang dijalankan.
  // resolveActions() di atas menjawab "apa yang terjadi saat LIVE", dan
  // jawabannya untuk aturan lama selalu ketiganya menyala. Fungsi ini menjawab
  // pertanyaan yang berbeda: "seberapa keras kita boleh menuntut kelengkapan".
  //
  // Kenapa itu tidak boleh dicampur: aturan lama yang sah menuliskan
  // product: null untuk scene FAQ — pernyataan "scene ini sengaja tidak memin
  // apa pun" yang sudah didokumentasikan di controller/config-manager.js dan
  // sudah dipakai customer hari ini. Saat LIVE ia memang mencoba pin, gagal
  // dengan no-mapping, lalu diam; itu perilaku v0.1.1 dan ia dipertahankan.
  //
  // Kalau validator menuntut produk dari SETIAP aturan yang autoPin-nya
  // menyala, setiap scene FAQ yang sudah ada mendadak memblokir START —
  // kerusakan yang jauh lebih besar daripada kelalaian yang mau ditangkap.
  // Jadi tuntutan kelengkapan hanya berlaku untuk aturan yang MEMILIH
  // aksinya: di sana kotak centang "Pin produk" yang menyala tanpa produk
  // benar-benar sebuah kelalaian, dan menolaknya menolong.
  function declaresActions(mapping) {
    return isPlainObject(mapping) && isPlainObject(mapping.actions);
  }

  // Aturan yang semua aksinya mati tidak melakukan apa pun. Ia bukan aturan;
  // ia baris yang menunggu untuk membingungkan orang yang membacanya nanti.
  function anyEnabled(actions) {
    if (!isPlainObject(actions)) return false;
    for (var i = 0; i < ACTION_NAMES.length; i += 1) {
      if (actions[ACTION_NAMES[i]] === true) return true;
    }
    return false;
  }

  // Bentuk actions seperti yang ditulis di berkas config. Mengembalikan daftar
  // { key, code }; key kosong berarti keluhannya tentang actions itu sendiri,
  // bukan tentang salah satu kuncinya.
  //
  // Field yang TIDAK ADA bukan kesalahan: itu aturan lama, dan ia sah.
  function validateActionsShape(raw) {
    if (raw === undefined) return [];
    if (!isPlainObject(raw)) return [{ key: "", code: "must-be-object" }];
    var out = [];
    for (var i = 0; i < ACTION_NAMES.length; i += 1) {
      var name = ACTION_NAMES[i];
      if (raw[name] !== undefined && typeof raw[name] !== "boolean") {
        out.push({ key: name, code: "must-be-boolean" });
      }
    }
    return out;
  }

  // Bentuk yang DISIMPAN saat customer menyunting sebuah aturan.
  //
  // Ketiganya selalu ditulis lengkap, tidak hanya yang mati. Berkas yang
  // menyatakan ketiga aksinya apa adanya bisa dibaca siapa pun tanpa harus tahu
  // bawaan versi mana yang berlaku saat ia ditulis.
  function normalizeActions(actions) {
    var a = resolveActions({ actions: actions });
    return { switchScene: a.switchScene, autoPin: a.autoPin, autoReply: a.autoReply };
  }

  // ---------------------------------------------------------------------------
  // KUNCI ATURAN
  //
  // Seluruh jalur runtime mencari produk dan balasan BERDASARKAN KUNCI: peta
  // scene->produk, peta scene->balasan, cooldown, dan dedupe playId. Sampai
  // v0.1.1 kunci itu adalah nama scene, karena setiap aturan punya scene.
  //
  // Aturan yang tidak mengganti scene tidak punya nama scene untuk dipakai,
  // jadi ia mendapat kunci buatan. Kunci buatan itu:
  //
  //   - deterministik, supaya dua proses anak yang membaca artefak yang sama
  //     sampai pada kunci yang sama
  //   - TIDAK PERNAH bertabrakan dengan nama scene di config yang sama, karena
  //     tabrakan berarti satu aturan memakai produk atau balasan aturan lain
  //   - tidak pernah dikirim ke OBS: yang memutuskan itu actions.switchScene,
  //     bukan bentuk kuncinya
  //
  // Untuk setiap aturan yang PUNYA scene, kuncinya adalah nama scene itu —
  // persis seperti sebelumnya. Jadi setiap config yang sudah ada menghasilkan
  // peta yang identik, bukan peta yang mirip.
  var SYNTHETIC_PREFIX = "#rule-";

  function sceneOf(mapping) {
    return mapping && typeof mapping.scene === "string" ? mapping.scene.trim() : "";
  }

  // mappings -> daftar kunci, satu per pemetaan, dalam urutan yang sama.
  //
  // Nama scene dikumpulkan LEBIH DULU, jadi kunci buatan menghindari seluruh
  // himpunan scene — bukan hanya scene yang kebetulan tertulis sebelumnya.
  function ruleKeys(mappings) {
    var list = Array.isArray(mappings) ? mappings : [];
    var taken = Object.create(null);
    var i;
    for (i = 0; i < list.length; i += 1) {
      var scene = sceneOf(list[i]);
      if (scene) taken[scene] = true;
    }
    var out = [];
    for (i = 0; i < list.length; i += 1) {
      var own = sceneOf(list[i]);
      if (own) {
        out.push(own);
        continue;
      }
      // Nomor barisnya dulu, karena itu yang dilihat customer di dashboard
      // ("Aturan 3"). Kalau ternyata ada scene bernama sama, ditambah akhiran
      // sampai bebas — berurutan, jadi hasilnya tetap bisa diramalkan.
      var base = SYNTHETIC_PREFIX + (i + 1);
      var key = base;
      var n = 2;
      while (taken[key]) {
        key = base + "-" + n;
        n += 1;
      }
      taken[key] = true;
      out.push(key);
    }
    return out;
  }

  // Kunci ini buatan kami, bukan nama scene milik customer. Dipakai jalur log
  // dan UI untuk memutuskan apakah sebuah kunci layak ditampilkan sebagai nama
  // scene kepada orang.
  function isSyntheticKey(key) {
    return typeof key === "string" && key.indexOf(SYNTHETIC_PREFIX) === 0;
  }

  // ---------------------------------------------------------------------------
  // INTERAKSI SAAT SEPI
  //
  // Dua fungsi kecil yang dipakai BERSAMA oleh bot dan dashboard, jadi ia
  // tinggal di modul yang sudah disajikan ke halaman. Logika timer dan rotasi
  // milik runtime/idle.js (hanya Node); yang di sini hanya "aksi apa yang
  // dimiliki sebuah item interaksi", dan itu memang perlu dijawab di dua sisi:
  // bot memakainya untuk menjalankan, dashboard memakainya untuk menggambar
  // rantai "sedang tayang" dengan jujur.
  //
  // autoPin SELALU false. Bukan kebetulan dan bukan bawaan yang bisa diubah:
  // interaksi saat sepi tidak pernah boleh menyentuh daftar produk, dan bentuk
  // fungsi ini yang menjaminnya di kedua sisi sekaligus.
  function idleActionsFor(item) {
    var reply = item && typeof item.reply === "string" ? item.reply.trim() : "";
    return { switchScene: true, autoPin: false, autoReply: reply !== "" };
  }

  // Item interaksi yang memiliki sebuah scene, atau null.
  //
  // Dipakai dashboard untuk mengenali scene yang sedang tayang sebagai scene
  // interaksi SEBELUM ia jatuh ke bawaan lama. Pencarian pakai nama scene apa
  // adanya: nama scene milik customer dan tidak pernah dinormalkan.
  function findIdleItem(items, scene) {
    var list = Array.isArray(items) ? items : [];
    var want = typeof scene === "string" ? scene : "";
    if (want === "") return null;
    for (var i = 0; i < list.length; i += 1) {
      var it = list[i];
      if (it && typeof it.scene === "string" && it.scene === want) return it;
    }
    return null;
  }

  return {
    ACTION_NAMES: ACTION_NAMES,
    LEGACY_ACTIONS: LEGACY_ACTIONS,
    resolveActions: resolveActions,
    declaresActions: declaresActions,
    anyEnabled: anyEnabled,
    validateActionsShape: validateActionsShape,
    normalizeActions: normalizeActions,
    ruleKeys: ruleKeys,
    isSyntheticKey: isSyntheticKey,
    SYNTHETIC_PREFIX: SYNTHETIC_PREFIX,
    idleActionsFor: idleActionsFor,
    findIdleItem: findIdleItem,
  };
});
