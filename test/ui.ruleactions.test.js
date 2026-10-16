// Penyunting aturan: aksi saat terpicu, dan apa yang terjadi pada formulir
// ketika sebuah aksi dimatikan.
//
// Semua KEPUTUSAN-nya ada di controller/public/ui-logic.js, jadi tes ini
// memanggilnya langsung — tanpa jsdom, dan tanpa menebak dari dalam handler
// DOM. app.js hanya memasang hasilnya.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const I18N = require("../controller/public/i18n.js");
const U = require("../controller/public/ui-logic.js");
const { MAX_REPLY_LENGTH } = require("../controller/config-manager");

const T = (key, vars) => I18N.t("id", key, vars);
const EDITABLE = { editingEnabled: true };
const LOCKED = { editingEnabled: false };
const ALL_ON = { switchScene: true, autoPin: true, autoReply: true };

function row(over) {
  return Object.assign(
    {
      scene: "FAQ-HARGA",
      productTitle: "Garuda Kacang Atom 80gr",
      triggersText: "berapa harganya\nharga berapa",
      reply: "Harga terbarunya bisa dicek di etalase ya kak",
      actions: ALL_ON,
    },
    over || {}
  );
}

// --- kotak centang -----------------------------------------------------------

test("ketiga kotak centang muncul, dalam urutan aksi dijalankan", () => {
  const ed = U.ruleEditorView(row(), EDITABLE, null, "id");
  assert.deepEqual(ed.boxes.map((b) => b.key), ["switchScene", "autoPin", "autoReply"]);
  assert.deepEqual(ed.boxes.map((b) => b.label), [
    T("ui.rule.f.actScene"),
    T("ui.rule.f.actPin"),
    T("ui.rule.f.actReply"),
  ]);
  assert.deepEqual(ed.boxes.map((b) => b.checked), [true, true, true]);
});

test("LEGACY: aturan tanpa field actions terlihat sebagai ketiganya tercentang", () => {
  const ed = U.ruleEditorView(row({ actions: undefined }), EDITABLE, null, "id");
  assert.deepEqual(ed.boxes.map((b) => b.checked), [true, true, true]);
  assert.deepEqual(ed.actions, ALL_ON);
});

test("penyuntingan yang terkunci mematikan kotak centang, bukan menyembunyikannya", () => {
  const ed = U.ruleEditorView(row(), LOCKED, null, "id");
  assert.deepEqual(ed.boxes.map((b) => b.disabled), [true, true, true]);
  assert.equal(ed.boxes.length, 3);
});

test("mencentang satu aksi tidak mengubah objek aksi yang lama", () => {
  // row.actions bisa berasal dari pembacaan config; menulis ke dalamnya berarti
  // mengubah objek yang bukan milik formulir.
  const r = row();
  const before = r.actions;
  const next = U.toggleAction(r, "autoPin", false);
  assert.notEqual(next, before);
  assert.deepEqual(before, ALL_ON, "objek lama tidak boleh tersentuh");
  assert.deepEqual(next, { switchScene: true, autoPin: false, autoReply: true });
});

test("kunci aksi yang tidak dikenal tidak bisa menyelinap masuk", () => {
  assert.deepEqual(U.toggleAction(row(), "hapusSemua", true), ALL_ON);
});

// --- field mengikuti aksinya -------------------------------------------------

test("GANTI SCENE mati: field scene mati dan dijelaskan", () => {
  const ed = U.ruleEditorView(row({ actions: { switchScene: false, autoPin: false, autoReply: true } }), EDITABLE, null, "id");
  assert.equal(ed.sceneDisabled, true);
  assert.equal(ed.sceneNote, T("ui.rule.f.sceneOffNote"));
  assert.ok(ed.sceneNote.length > 0);
});

test("PIN PRODUK mati: dropdown produk mati, dan alasannya yang tampil — bukan judul LIVE", () => {
  const ed = U.ruleEditorView(
    row({ actions: { switchScene: true, autoPin: false, autoReply: true } }),
    EDITABLE,
    "Garuda Kacang Atom 80gr isi 10",
    "id"
  );
  assert.equal(ed.productDisabled, true);
  assert.equal(ed.productNote, T("ui.rule.f.pinOffNote"));
  // Judul yang terlihat di LIVE tidak berarti apa pun untuk aturan yang tidak
  // akan mem-pin; menampilkannya menjanjikan sesuatu yang tidak akan terjadi.
  assert.ok(!ed.productNote.includes("isi 10"));
});

test("PIN PRODUK menyala: catatannya kembali menjadi judul yang sungguh terpilih", () => {
  const ed = U.ruleEditorView(row(), EDITABLE, "Garuda Kacang Atom 80gr isi 10", "id");
  assert.equal(ed.productDisabled, false);
  assert.equal(ed.productNote, T("ui.rule.f.resolved", { title: "Garuda Kacang Atom 80gr isi 10" }));
});

test("BALAS KOMENTAR mati: field balasan mati, hitungan huruf diganti penjelasan", () => {
  const ed = U.ruleEditorView(row({ actions: { switchScene: true, autoPin: true, autoReply: false } }), EDITABLE, null, "id");
  assert.equal(ed.replyDisabled, true);
  assert.equal(ed.replyNote, T("ui.rule.f.replyOffNote"));
});

test("BALAS KOMENTAR menyala: hitungan huruf memakai batas yang SAMA dengan server", () => {
  // Halaman ini tidak boleh menjanjikan ruang yang nanti ditolak validator.
  assert.equal(U.MAX_REPLY_LENGTH, MAX_REPLY_LENGTH);
  const ed = U.ruleEditorView(row({ reply: "abc" }), EDITABLE, null, "id");
  assert.ok(
    ed.replyNote.startsWith(T("ui.rule.f.replyCount", { n: 3, max: MAX_REPLY_LENGTH })),
    ed.replyNote
  );
});

test("TIGA BAHASA: penyambung catatan balasan adalah TATA LETAK, bukan kalimat", () => {
  // ui.rule.f.replyNote hanya menyambung hitungan huruf dengan kalimatnya, jadi
  // ia DIKECUALIKAN dari pagar "tidak boleh sama dengan bahasa Indonesia" di
  // bawah: "{count} {sentence}" memang identik di ID dan EN, dan itu benar.
  //
  // Yang dijaga di sini justru alasan ia ada: bahasa Tionghoa tidak memberi
  // spasi sesudah tanda titik penuh, dan keputusan tipografi seperti itu milik
  // kamus - bukan kode yang menyambung dengan " " untuk semua bahasa.
  for (const lang of I18N.LANGS) {
    const val = I18N.DICT[lang]["ui.rule.f.replyNote"];
    assert.ok(val.includes("{count}"), lang + " kehilangan {count}");
    assert.ok(val.includes("{sentence}"), lang + " kehilangan {sentence}");
  }
  assert.equal(I18N.DICT["zh-CN"]["ui.rule.f.replyNote"], "{count}{sentence}", "tanpa spasi");
  assert.ok(/\{count\} \{sentence\}/.test(I18N.DICT.id["ui.rule.f.replyNote"]), "ID memakai spasi");
  assert.ok(/\{count\} \{sentence\}/.test(I18N.DICT.en["ui.rule.f.replyNote"]), "EN memakai spasi");

  // Dan hasil akhirnya memang rapi di ketiga bahasa.
  const faq = { switchScene: true, autoPin: false, autoReply: true };
  assert.ok(!/\s\s/.test(U.replyNoteFor(faq, 36, "id")), "tidak boleh ada spasi ganda");
  assert.ok(!/。\s/.test(U.replyNoteFor(faq, 36, "zh-CN")), "zh tidak boleh ada spasi sesudah titik penuh");
});

// --- kalimat balasan mengikuti AKSI ------------------------------------------
//
// Kalimat v0.1.1 hanya satu: "Dikirim setelah pin terkonfirmasi." Itu benar
// selama setiap aturan memin. Untuk aturan FAQ ia menjanjikan sesuatu yang tidak
// pernah bisa terjadi - tidak ada pin yang akan dikonfirmasi - dan di layar itu
// terbaca seperti fitur yang rusak, bukan seperti aturan yang memang tidak
// memin.

test("BALAS + PIN: kalimatnya menjanjikan balasan SETELAH pin", () => {
  const ed = U.ruleEditorView(row({ reply: "abc", actions: ALL_ON }), EDITABLE, null, "id");
  assert.ok(ed.replyNote.includes(T("ui.rule.f.replyAfterPin")), ed.replyNote);
  assert.ok(!ed.replyNote.includes(T("ui.rule.f.replyOnTrigger")), ed.replyNote);
  // Hitungan hurufnya tidak hilang: ia satu-satunya tanda batas ketikan.
  assert.ok(ed.replyNote.includes("3"), ed.replyNote);
});

test("BALAS tanpa PIN: kalimatnya menjanjikan balasan SAAT TERPICU", () => {
  const faq = { switchScene: true, autoPin: false, autoReply: true };
  const ed = U.ruleEditorView(row({ reply: "abc", actions: faq }), EDITABLE, null, "id");
  assert.ok(ed.replyNote.includes(T("ui.rule.f.replyOnTrigger")), ed.replyNote);
  assert.ok(!ed.replyNote.includes(T("ui.rule.f.replyAfterPin")), ed.replyNote);
  assert.equal(ed.replyDisabled, false, "balasan tetap bisa diisi");
});

test("BALAS mati: field mati dan kalimatnya menjelaskan, bukan menghitung huruf", () => {
  const ed = U.ruleEditorView(row({ actions: { switchScene: true, autoPin: true, autoReply: false } }), EDITABLE, null, "id");
  assert.equal(ed.replyDisabled, true);
  assert.equal(ed.replyNote, T("ui.rule.f.replyOffNote"));
});

test("replyNoteFor: SATU sumber kalimat untuk kartu dan untuk handler ketik", () => {
  // app.js memperbarui catatan ini setiap huruf diketik. Sebelum perbaikan ini
  // ia menulis sendiri kunci kalimatnya, jadi kartunya bisa mengatakan satu hal
  // dan huruf pertama yang diketik mengubahnya menjadi hal lain.
  const faq = { switchScene: true, autoPin: false, autoReply: true };
  const ed = U.ruleEditorView(row({ reply: "abc", actions: faq }), EDITABLE, null, "id");
  assert.equal(ed.replyNote, U.replyNoteFor(faq, 3, "id"), "kartu dan handler harus sama persis");

  // Dan panjang yang berubah hanya mengubah angkanya, bukan janjinya.
  const after = U.replyNoteFor(faq, 40, "id");
  assert.ok(after.includes(T("ui.rule.f.replyOnTrigger")), after);
  assert.ok(after.includes("40"), after);

  // Aturan lama tanpa field actions diperlakukan memin, jadi kalimatnya yang
  // lama pula - kompatibilitas ke belakang sampai ke tingkat kalimat.
  assert.ok(U.replyNoteFor(undefined, 1, "id").includes(T("ui.rule.f.replyAfterPin")));
});

// --- opsi kosong dropdown produk ---------------------------------------------

test("PIN mati: dropdown produk mengatakan TIDAK DIGUNAKAN, bukan menyuruh menyegarkan", () => {
  // "Belum ada produk. Tekan Segarkan koneksi." salah dua kali untuk aturan FAQ:
  // menyuruh memperbaiki yang tidak rusak, dan membuat aturan sehat tampak gagal.
  const faq = { switchScene: true, autoPin: false, autoReply: true };
  for (const count of [0, 10]) {
    const ed = U.ruleEditorView(row({ actions: faq }), EDITABLE, null, "id", count);
    assert.equal(ed.productPlaceholder, T("ui.rule.f.productNotUsed"), "jumlah produk=" + count);
    assert.equal(ed.productDisabled, true);
    assert.equal(ed.productNote, T("ui.rule.f.pinOffNote"));
  }
});

test("PIN menyala: kalimat katalog yang SUDAH ADA kembali apa adanya", () => {
  const kosong = U.ruleEditorView(row(), EDITABLE, null, "id", 0);
  assert.equal(kosong.productPlaceholder, T("ui.rule.f.noProducts"));

  const ada = U.ruleEditorView(row(), EDITABLE, null, "id", 10);
  assert.equal(ada.productPlaceholder, T("ui.rule.f.productNone"));
  assert.equal(ada.productDisabled, false);
});

test("mematikan PIN TIDAK menghapus produk tersimpan, dan menyalakannya kembali memulihkannya", () => {
  // Inti item ini: yang berubah hanya tampilan. Nilai di baris formulir tetap.
  const r = row();
  const tersimpan = r.productTitle;

  // Mematikan aksi hanya mengganti objek AKSI; nilai produknya tidak disentuh.
  r.actions = U.toggleAction(r, "autoPin", false);
  const off = U.ruleEditorView(r, EDITABLE, null, "id", 10);
  assert.equal(off.productPlaceholder, T("ui.rule.f.productNotUsed"));
  assert.equal(r.productTitle, tersimpan, "produk tersimpan tidak boleh ikut terhapus");

  // Dan menyalakannya kembali memunculkan pilihan yang SAMA, bukan field kosong.
  r.actions = U.toggleAction(r, "autoPin", true);
  assert.equal(r.productTitle, tersimpan, "pilihan lama harus masih ada");
  const on = U.ruleEditorView(r, EDITABLE, "Garuda Kacang Atom 80gr isi 10", "id", 10);
  assert.equal(on.productDisabled, false);
  assert.equal(on.productPlaceholder, T("ui.rule.f.productNone"));
  assert.equal(on.productNote, T("ui.rule.f.resolved", { title: "Garuda Kacang Atom 80gr isi 10" }));
});

test("PEMICU tidak pernah dimatikan oleh aksi apa pun: ia selalu wajib", () => {
  for (const actions of [ALL_ON, { switchScene: false, autoPin: false, autoReply: true }, { switchScene: true, autoPin: false, autoReply: false }]) {
    assert.equal(U.ruleEditorView(row({ actions }), EDITABLE, null, "id").triggersDisabled, false, JSON.stringify(actions));
  }
});

test("penyuntingan terkunci mematikan SEMUA field, lepas dari aksinya", () => {
  const ed = U.ruleEditorView(row(), LOCKED, null, "id");
  assert.equal(ed.sceneDisabled, true);
  assert.equal(ed.productDisabled, true);
  assert.equal(ed.triggersDisabled, true);
  assert.equal(ed.replyDisabled, true);
});

// --- minimal satu aksi -------------------------------------------------------

test("ALL OFF: pesan validasi muncul di kartunya, tidak menunggu Save ditolak", () => {
  const ed = U.ruleEditorView(row({ actions: { switchScene: false, autoPin: false, autoReply: false } }), EDITABLE, null, "id");
  assert.equal(ed.actionsError, T("ui.rule.f.actionsNone"));
  assert.equal(ed.actionsHelp, "", "bantuan biasa digantikan peringatan, bukan ditumpuk");
});

test("satu aksi menyala sudah cukup: tidak ada peringatan", () => {
  for (const key of ["switchScene", "autoPin", "autoReply"]) {
    const actions = { switchScene: false, autoPin: false, autoReply: false };
    actions[key] = true;
    const ed = U.ruleEditorView(row({ actions }), EDITABLE, null, "id");
    assert.equal(ed.actionsError, "", key);
    assert.equal(ed.actionsHelp, T("ui.rule.f.actionsHelp"));
  }
});

test("ALL OFF juga dikatakan di kalimat aturannya", () => {
  const chips = U.ruleChips(row({ actions: { switchScene: false, autoPin: false, autoReply: false } }), {}, "id");
  assert.equal(chips.actionsNone, T("ui.rule.f.actionsNone"));
});

// --- kalimat aturan ----------------------------------------------------------

test("kalimat aturan hanya menyebut aksi yang BENAR-BENAR terjadi", () => {
  const faq = U.ruleChips(row({ actions: { switchScene: true, autoPin: false, autoReply: true } }), { scenes: ["FAQ-HARGA"] }, "id");
  assert.deepEqual(faq.actions, { switchScene: true, autoPin: false, autoReply: true });
  // Produk tidak lagi dipamerkan, dan "tidak mem-pin apa pun" bukan kalimat yang
  // benar di sini: yang benar adalah kalimat tentang aksinya.
  assert.equal(faq.productNone, "");
  assert.equal(faq.pinOff, T("ui.rule.f.pinOffNote"));
  assert.equal(faq.reply, "Harga terbarunya bisa dicek di etalase ya kak");
});

test("balasan yang tersimpan TIDAK dipamerkan kalau ia tidak akan dikirim", () => {
  const chips = U.ruleChips(row({ actions: { switchScene: true, autoPin: true, autoReply: false } }), {}, "id");
  assert.equal(chips.reply, "", "kalimat yang tidak akan dikirim bukan janji yang boleh tampil");
  assert.equal(chips.noReply, "", "dan ia juga bukan 'tanpa balasan' yang perlu dikeluhkan");
});

test("scene tersimpan yang hilang dari OBS tidak dikeluhkan kalau aturan tidak mengganti scene", () => {
  const off = U.ruleChips(
    row({ scene: "SCENE-SUDAH-DIHAPUS", actions: { switchScene: false, autoPin: false, autoReply: true } }),
    { scenes: ["FAQ-HARGA"] },
    "id"
  );
  assert.equal(off.sceneMissing, "", "pekerjaan yang tidak ada gunanya untuk customer");

  const on = U.ruleChips(row({ scene: "SCENE-SUDAH-DIHAPUS", actions: ALL_ON }), { scenes: ["FAQ-HARGA"] }, "id");
  assert.ok(on.sceneMissing.length > 0, "tapi scene yang MEMANG akan diganti tetap dikeluhkan");
});

test("judul yang terlihat di LIVE tidak ditempel pada aturan yang tidak mem-pin", () => {
  const chips = U.ruleChips(
    row({ productTitle: "Kacang Atom", actions: { switchScene: true, autoPin: false, autoReply: true } }),
    { resolvedTitle: "Garuda Kacang Atom 80gr" },
    "id"
  );
  assert.equal(chips.resolved, "");
});

// --- nilai tidak hilang karena aksinya dimatikan -----------------------------

test("nilai yang sudah diketik bertahan OFF -> ON tanpa diketik ulang", () => {
  // Mematikan sebuah aksi adalah keputusan tentang apa yang DIKERJAKAN aturan,
  // bukan perintah membuang pilihan customer.
  const r = row();
  r.actions = U.toggleAction(r, "autoPin", false);
  r.actions = U.toggleAction(r, "autoReply", false);
  r.actions = U.toggleAction(r, "switchScene", false);

  assert.equal(r.scene, "FAQ-HARGA");
  assert.equal(r.productTitle, "Garuda Kacang Atom 80gr");
  assert.equal(r.reply, "Harga terbarunya bisa dicek di etalase ya kak");
  assert.equal(r.triggersText, "berapa harganya\nharga berapa");

  r.actions = U.toggleAction(r, "autoPin", true);
  const ed = U.ruleEditorView(r, EDITABLE, null, "id");
  assert.equal(ed.productDisabled, false);
  assert.equal(r.productTitle, "Garuda Kacang Atom 80gr");
});

// --- contoh FAQ dari ujung ke ujung -----------------------------------------

test("CONTOH FAQ: dibuat tanpa menyentuh JSON, dan tanpa produk apa pun", () => {
  // Bentuk yang diminta §8: scene FAQ-HARGA, balas, tidak mem-pin, dan tidak
  // ada produk yang perlu dipilih.
  const r = {
    scene: "FAQ-HARGA",
    productTitle: "",
    triggersText: "berapa harganya\nharga berapa\nbrp kak\nharganya kak",
    reply: "Harga terbarunya bisa langsung dicek di etalase ya kak 😊",
    actions: { switchScene: true, autoPin: false, autoReply: true },
  };
  const m = U.rowToMapping(r);
  assert.deepEqual(m, {
    scene: "FAQ-HARGA",
    product: null,
    triggers: ["berapa harganya", "harga berapa", "brp kak", "harganya kak"],
    reply: "Harga terbarunya bisa langsung dicek di etalase ya kak 😊",
    actions: { switchScene: true, autoPin: false, autoReply: true },
  });
  // Dan validator config menerimanya apa adanya.
  const { validateConfig, defaultConfig } = require("../controller/config-manager");
  const c = defaultConfig();
  c.tiktok.username = "akun";
  c.mappings = [m];
  assert.deepEqual(validateConfig(c).errors, []);
});

// --- rantai "sedang tayang" --------------------------------------------------

function onairFor(rows, actsOn = ["AUTOPIN_SUCCESS", "AUTOCOMMENT_SUCCESS"]) {
  const activity = [{ id: 1, type: "PLAY", scene: "FAQ-HARGA", time: new Date().toISOString() }];
  let id = 2;
  for (const type of actsOn) activity.push({ id: id++, type, scene: "FAQ-HARGA", time: new Date().toISOString() });
  return U.onairView({ status: { automation: "RUNNING" }, activity, rows }, "id");
}

test("ON AIR: langkah pin TIDAK ditampilkan untuk scene yang sengaja tidak mem-pin", () => {
  // Tanpa ini, scene FAQ memamerkan "Produk di-pin: menunggu" selamanya — sebuah
  // langkah yang tidak pernah datang, di kartu yang dibaca operator untuk
  // memutuskan kapan bicara.
  const v = onairFor([{ scene: "FAQ-HARGA", actions: { switchScene: true, autoPin: false, autoReply: true } }], []);
  assert.equal(v.visible, true);
  assert.deepEqual(v.chain.map((s) => s.label), [T("ui.onair.replied")]);
});

test("ON AIR: scene etalase tetap menampilkan kedua langkah, persis seperti sebelumnya", () => {
  const v = onairFor([{ scene: "FAQ-HARGA", actions: { switchScene: true, autoPin: true, autoReply: true } }], []);
  assert.deepEqual(v.chain.map((s) => s.label), [T("ui.onair.pinned"), T("ui.onair.replied")]);
});

test("ON AIR: baris aturan belum terbaca => kedua langkah tampil, bawaan lama", () => {
  // Dashboard yang baru dibuka belum punya daftar aturan. Menyembunyikan langkah
  // berdasarkan daftar yang belum ada adalah pernyataan yang salah tentang
  // keadaan sistem.
  const v = onairFor([], []);
  assert.deepEqual(v.chain.map((s) => s.label), [T("ui.onair.pinned"), T("ui.onair.replied")]);
});

test("ON AIR: scene khusus-scene tidak menampilkan satu langkah pun", () => {
  const v = onairFor([{ scene: "FAQ-HARGA", actions: { switchScene: true, autoPin: false, autoReply: false } }], []);
  assert.equal(v.visible, true);
  assert.deepEqual(v.chain, []);
});

// --- tiga bahasa -------------------------------------------------------------

test("TIGA BAHASA: setiap kalimat baru ada di id, en, dan zh-CN", () => {
  // Kontrak kesamaan kunci sudah dijaga test/ui.i18n.test.js; yang dijaga di
  // sini adalah bahwa kunci yang BENAR-BENAR dipakai penyunting ini memang ada,
  // dan tidak satu pun jatuh kembali ke bahasa Indonesia.
  const keys = [
    "ui.rule.f.actions",
    "ui.rule.f.actionsHelp",
    "ui.rule.f.actionsNone",
    "ui.rule.f.actScene",
    "ui.rule.f.actPin",
    "ui.rule.f.actReply",
    "ui.rule.f.sceneOffNote",
    "ui.rule.f.pinOffNote",
    "ui.rule.f.replyOffNote",
    "ui.rule.f.replyAfterPin",
    "ui.rule.f.replyOnTrigger",
    "ui.rule.f.replyCount",
    "ui.rule.f.productNotUsed",
    "ui.rule.thenReply",
    "path.rule.actions",
    "err.no-actions-enabled",
    "err.scene-required",
    "err.reply-required",
    "field.no-actions-enabled",
  ];
  for (const lang of I18N.LANGS) {
    for (const key of keys) {
      const val = I18N.DICT[lang][key];
      assert.equal(typeof val, "string", lang + " " + key);
      assert.ok(val.trim().length > 0, lang + " " + key + " kosong");
      if (lang !== "id") {
        assert.notEqual(val, I18N.DICT.id[key], lang + " " + key + " masih bahasa Indonesia");
      }
    }
  }
});

test("TIGA BAHASA: penyunting benar-benar berganti bahasa, bukan hanya labelnya", () => {
  const faq = row({ actions: { switchScene: true, autoPin: false, autoReply: true } });
  const seen = new Set();
  for (const lang of I18N.LANGS) {
    const ed = U.ruleEditorView(faq, EDITABLE, null, lang);
    assert.equal(ed.productNote, I18N.t(lang, "ui.rule.f.pinOffNote"));
    assert.deepEqual(ed.boxes.map((b) => b.label), [
      I18N.t(lang, "ui.rule.f.actScene"),
      I18N.t(lang, "ui.rule.f.actPin"),
      I18N.t(lang, "ui.rule.f.actReply"),
    ]);
    seen.add(ed.productNote);
  }
  assert.equal(seen.size, I18N.LANGS.length, "ketiganya harus berbeda");
});

test("PAGAR: isi aturan milik customer tidak pernah diterjemahkan", () => {
  // Nama scene, judul produk, pemicu, dan teks balasan dikembalikan APA ADANYA
  // di bahasa apa pun.
  for (const lang of I18N.LANGS) {
    const chips = U.ruleChips(row(), { scenes: ["FAQ-HARGA"] }, lang);
    assert.equal(chips.scene, "FAQ-HARGA");
    assert.equal(chips.product, "Garuda Kacang Atom 80gr");
    assert.deepEqual(chips.triggers, ["berapa harganya", "harga berapa"]);
    assert.equal(chips.reply, "Harga terbarunya bisa dicek di etalase ya kak");
  }
});
