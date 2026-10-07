// Validasi pemetaan terhadap dunia nyata, dan penolakan Start yang mengikutinya.
//
// Dua bagian:
//
//   1. validateMappings() sebagai fungsi murni.
//   2. Start yang DITOLAK karena pemetaan tidak lolos — dengan pembuktian bahwa
//      NOL proses dinyalakan. Ini bagian yang penting: pemetaan yang salah harus
//      ditangkap sebelum ada yang menyala, bukan ditemukan saat LIVE lewat pin
//      yang gagal dan penonton yang melihat video produk yang tidak ter-pin.
//
// Semuanya offline: discovery di-inject, child process palsu.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { validateMappings, resolveProduct, normalizeTitleKey } = require("../controller/mapping-validator");
const { normalizeTitleKey: coreNormalizeTitleKey } = require("../autopin/core");
const { createHarness, goodConfig } = require("./helpers/controller-harness");
const { STATES } = require("../controller/state-machine");

const CATALOGUE = [
  { title: "O'CORN Sea Salt 80gr", number: 1, pinAvailable: true },
  { title: "Dilan Cookies Choco Chip", number: 2, pinAvailable: true },
  { title: "Gery Potato Cracker BBQ", number: 3, pinAvailable: true },
  { title: "Gery Potato Cracker Original", number: 4, pinAvailable: true },
];

const SCENES = ["MAIN", "PAX-1", "PAX-2", "PAX-3"];
const PLAYABLE = ["PAX-1", "PAX-2", "PAX-3", "AI LIVE_FAQ_CO"];

const mapping = (over = {}) =>
  Object.assign({ scene: "PAX-1", product: { title: "O'CORN Sea Salt" }, triggers: ["etalase satu"], reply: "sudah dipin" }, over);

// --- resolusi produk ---------------------------------------------------------

test("normalizeTitleKey adalah FUNGSI YANG SAMA dengan jalur pin, bukan salinan", () => {
  // Bukan "hasilnya sama" — benar-benar fungsi yang sama. Salinan akan menyimpang,
  // dan penyimpangannya sudah terbukti saat P2 dibuat: salinan pertama tidak
  // membuang apostrof ("o'corn" vs "o corn") maupun elipsis di ujung judul yang
  // dipotong products.js. Akibatnya Controller bilang "produk ketemu" sementara
  // resolveProductForPin tidak akan menemukannya saat LIVE.
  assert.equal(normalizeTitleKey, coreNormalizeTitleKey);

  // Dan kasus-kasus yang sempat menyimpang itu dijaga eksplisit.
  assert.equal(normalizeTitleKey("O'CORN Sea Salt 80gr"), "o corn sea salt 80gr");
  assert.equal(normalizeTitleKey("Nama Produk Yang Panjang…"), "nama produk yang panjang");
  for (const s of ["  Dilan   Cookies  ", "ＯＣＯＲＮ", "ÉCLAIR", "", null, undefined, "UPPER case MiXeD"]) {
    assert.equal(normalizeTitleKey(s), coreNormalizeTitleKey(s), "beda pada: " + JSON.stringify(s));
  }
});

test("resolveProduct: kunci unik ketemu", () => {
  const r = resolveProduct(CATALOGUE, "O'CORN Sea Salt");
  assert.equal(r.ok, true);
  assert.equal(r.product.number, 1);
});

test("resolveProduct: tidak peka huruf besar/kecil dan spasi berlebih", () => {
  // "O'CORN" menormalkan jadi "o corn" (apostrof jadi pemisah), jadi kunci yang
  // ditulis customer tanpa apostrof pun tetap cocok.
  assert.equal(resolveProduct(CATALOGUE, "  o corn   sea   salt  ").ok, true);
  assert.equal(resolveProduct(CATALOGUE, "O'CORN SEA SALT").ok, true);
});

test("resolveProduct: tidak ketemu -> product-not-found", () => {
  assert.equal(resolveProduct(CATALOGUE, "Produk Yang Tidak Ada").reason, "product-not-found");
});

test("resolveProduct: kunci yang cocok DUA produk -> ambiguous-product", () => {
  // "Gery Potato Cracker" cocok dengan BBQ dan Original. Memilih yang pertama
  // akan memin produk yang salah separuh waktu.
  const r = resolveProduct(CATALOGUE, "Gery Potato Cracker");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "ambiguous-product");
  assert.equal(r.count, 2);
});

test("resolveProduct: kunci kosong -> empty-product-title", () => {
  for (const k of ["", "   ", null, undefined]) {
    assert.equal(resolveProduct(CATALOGUE, k).reason, "empty-product-title");
  }
});

// --- validateMappings --------------------------------------------------------

test("semua benar -> ok", () => {
  const r = validateMappings({
    mappings: [mapping(), mapping({ scene: "PAX-2", product: { title: "Dilan Cookies" }, triggers: ["etalase dua"], reply: "siap" })],
    obsScenes: SCENES,
    products: CATALOGUE,
    playableScenes: PLAYABLE,
  });
  assert.equal(r.ok, true);
  assert.equal(r.mappings.length, 2);
  assert.ok(r.mappings.every((m) => m.ok));
});

test("judul yang BENAR-BENAR terlihat di LIVE dilaporkan", () => {
  // Customer mengetik potongan; UI perlu menunjukkan produk mana yang sungguhnya
  // terpilih, supaya tidak ada salah paham.
  const r = validateMappings({ mappings: [mapping()], obsScenes: SCENES, products: CATALOGUE, playableScenes: PLAYABLE });
  assert.equal(r.mappings[0].resolvedTitle, "O'CORN Sea Salt 80gr");
  assert.equal(r.mappings[0].resolvedNumber, 1);
});

test("pemetaan kosong BUKAN lolos: no-mappings", () => {
  // Sistem yang gunanya memin produk tidak siap jalan tanpa satu pun pemetaan.
  const r = validateMappings({ mappings: [], obsScenes: SCENES, products: CATALOGUE });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no-mappings");
});

test("scene tidak ada di OBS -> obs-scene-missing", () => {
  const r = validateMappings({ mappings: [mapping({ scene: "PAX-9" })], obsScenes: SCENES, products: CATALOGUE });
  assert.equal(r.ok, false);
  assert.equal(r.mappings[0].reason, "obs-scene-missing");
});

test("scene tanpa detail pemutaran -> scene-playback-unknown", () => {
  // Controller tidak tahu nama input media atau durasinya; menebak berarti
  // mengubah perilaku pemutaran scene itu.
  const r = validateMappings({
    mappings: [mapping({ scene: "PAX-BARU" })],
    obsScenes: SCENES.concat(["PAX-BARU"]),
    products: CATALOGUE,
    playableScenes: PLAYABLE,
  });
  assert.equal(r.mappings[0].reason, "scene-playback-unknown");
});

test("scene ganda -> duplicate-scene pada baris kedua", () => {
  const r = validateMappings({
    mappings: [mapping(), mapping({ triggers: ["lain"] })],
    obsScenes: SCENES,
    products: CATALOGUE,
    playableScenes: PLAYABLE,
  });
  assert.equal(r.ok, false);
  assert.equal(r.mappings[0].ok, true);
  assert.equal(r.mappings[1].reason, "duplicate-scene");
});

test("produk tidak ada di katalog -> product-not-found", () => {
  const r = validateMappings({
    mappings: [mapping({ product: { title: "Produk Hantu" } })],
    obsScenes: SCENES,
    products: CATALOGUE,
    playableScenes: PLAYABLE,
  });
  assert.equal(r.mappings[0].reason, "product-not-found");
});

test("produk ambigu -> ambiguous-product dengan jumlah kecocokan", () => {
  const r = validateMappings({
    mappings: [mapping({ product: { title: "Gery Potato Cracker" } })],
    obsScenes: SCENES,
    products: CATALOGUE,
    playableScenes: PLAYABLE,
  });
  assert.equal(r.mappings[0].reason, "ambiguous-product");
  assert.equal(r.mappings[0].matches, 2);
});

test("produk tanpa kontrol pin -> live-pin-control-not-available", () => {
  const r = validateMappings({
    mappings: [mapping()],
    obsScenes: SCENES,
    products: [{ title: "O'CORN Sea Salt 80gr", number: 1, pinAvailable: false }],
    playableScenes: PLAYABLE,
  });
  assert.equal(r.mappings[0].reasons.includes("live-pin-control-not-available"), true);
});

test("produk null sah: scene punya trigger tapi tidak dipin", () => {
  const r = validateMappings({
    mappings: [{ scene: "AI LIVE_FAQ_CO", product: null, triggers: ["cara order"] }],
    obsScenes: SCENES.concat(["AI LIVE_FAQ_CO"]),
    products: CATALOGUE,
    playableScenes: PLAYABLE,
  });
  assert.equal(r.ok, true);
});

test("judul produk kosong -> empty-product-title", () => {
  const r = validateMappings({
    mappings: [mapping({ product: { title: "   " } })],
    obsScenes: SCENES,
    products: CATALOGUE,
    playableScenes: PLAYABLE,
  });
  assert.equal(r.mappings[0].reasons.includes("empty-product-title"), true);
});

test("tanpa trigger -> no-triggers", () => {
  for (const triggers of [[], undefined, ["", "  "]]) {
    const r = validateMappings({
      mappings: [mapping({ triggers })],
      obsScenes: SCENES,
      products: CATALOGUE,
      playableScenes: PLAYABLE,
    });
    assert.equal(r.mappings[0].reasons.includes("no-triggers"), true, JSON.stringify(triggers));
  }
});

test("trigger yang SAMA SESUDAH NORMALISASI di dua scene -> ambiguous-trigger", () => {
  // "Etalase Satu" dan "etalase 1" adalah trigger yang SAMA bagi matcher. Dua
  // scene yang mengklaim keduanya akan saling merebut komentar penonton, dan
  // yang menang ditentukan oleh urutan rule — bukan oleh keputusan customer.
  const r = validateMappings({
    mappings: [
      mapping({ scene: "PAX-1", triggers: ["Etalase Satu"] }),
      mapping({ scene: "PAX-2", product: { title: "Dilan Cookies" }, triggers: ["etalase 1"] }),
    ],
    obsScenes: SCENES,
    products: CATALOGUE,
    playableScenes: PLAYABLE,
  });
  assert.equal(r.ok, false);
  assert.equal(r.mappings[1].reason, "ambiguous-trigger");
  assert.equal(r.mappings[1].conflictsWith, "PAX-1");
  assert.equal(r.mappings[1].conflictingTrigger, "etalase 1");
});

test("trigger yang sama DALAM SATU scene bukan konflik", () => {
  const r = validateMappings({
    mappings: [mapping({ triggers: ["etalase satu", "Etalase 1"] })],
    obsScenes: SCENES,
    products: CATALOGUE,
    playableScenes: PLAYABLE,
  });
  assert.equal(r.ok, true, "duplikat dalam satu scene hanya berlebihan, bukan ambigu");
});

test("trigger yang berbeda sesudah normalisasi tidak konflik", () => {
  const r = validateMappings({
    mappings: [
      mapping({ scene: "PAX-1", triggers: ["etalase satu"] }),
      mapping({ scene: "PAX-2", product: { title: "Dilan Cookies" }, triggers: ["etalase dua"] }),
    ],
    obsScenes: SCENES,
    products: CATALOGUE,
    playableScenes: PLAYABLE,
  });
  assert.equal(r.ok, true);
});

test("AutoComment menyala + produk ada tapi balasan kosong -> ditolak", () => {
  const r = validateMappings({
    mappings: [mapping({ reply: "" })],
    obsScenes: SCENES,
    products: CATALOGUE,
    playableScenes: PLAYABLE,
    autoCommentEnabled: true,
  });
  assert.equal(r.mappings[0].reasons.includes("reply-required-when-autocomment-enabled"), true);
});

test("AutoComment mati: balasan kosong boleh", () => {
  const r = validateMappings({
    mappings: [mapping({ reply: "" })],
    obsScenes: SCENES,
    products: CATALOGUE,
    playableScenes: PLAYABLE,
    autoCommentEnabled: false,
  });
  assert.equal(r.ok, true);
});

test("AutoComment menyala tapi scene tanpa produk: balasan tidak diwajibkan", () => {
  // Scene yang tidak dipin tidak punya apa-apa untuk diumumkan.
  const r = validateMappings({
    mappings: [{ scene: "AI LIVE_FAQ_CO", product: null, triggers: ["cara order"] }],
    obsScenes: SCENES.concat(["AI LIVE_FAQ_CO"]),
    products: CATALOGUE,
    playableScenes: PLAYABLE,
    autoCommentEnabled: true,
  });
  assert.equal(r.ok, true);
});

test("data discovery yang TIDAK ADA membuat pemeriksaannya DILEWATI, bukan dianggap lolos", () => {
  // Tanpa katalog, "ok" hanya berarti belum ada yang membantahnya. Itulah kenapa
  // Controller melaporkan apa yang benar-benar diperiksa.
  const r = validateMappings({
    mappings: [mapping({ product: { title: "Produk Hantu" } })],
    obsScenes: null,
    products: null,
    playableScenes: null,
  });
  assert.equal(r.ok, true, "tidak ada data untuk membantahnya");
});

test("semua alasan dikumpulkan, bukan hanya yang pertama", () => {
  const r = validateMappings({
    mappings: [mapping({ scene: "PAX-9", product: { title: "Hantu" }, triggers: [] })],
    obsScenes: SCENES,
    products: CATALOGUE,
    playableScenes: PLAYABLE,
  });
  assert.ok(r.mappings[0].reasons.length >= 3, JSON.stringify(r.mappings[0].reasons));
  assert.equal(r.mappings[0].reason, r.mappings[0].reasons[0], "satu alasan utama untuk ditampilkan");
});

test("mapping yang bukan objek tidak meledak", () => {
  const r = validateMappings({ mappings: [null, 42, "x"], obsScenes: SCENES, products: CATALOGUE });
  assert.equal(r.ok, false);
  assert.equal(r.mappings.length, 3);
});

// --- Start ditolak karena pemetaan -------------------------------------------

// Config yang pemetaannya COCOK dengan CATALOGUE di atas. goodConfig() memakai
// judul lain ("Garuda Ting Ting", "Gery Potato"), yang di katalog ini tidak ada /
// ambigu — dan itu memang dipakai beberapa tes di bawah dengan sengaja.
function configForCatalogue() {
  const c = goodConfig();
  c.mappings = [
    { scene: "PAX-1", product: { title: "O'CORN Sea Salt" }, triggers: ["etalase satu"], reply: "Etalase 1 sudah aku pin ya kak" },
    { scene: "PAX-2", product: { title: "Dilan Cookies" }, triggers: ["etalase dua"], reply: "Etalase 2 sudah aku pin ya kak" },
  ];
  return c;
}

// Harness dengan discovery palsu yang mengembalikan scene dan katalog tertentu.
function harnessWith({ scenes = SCENES, products = CATALOGUE, config = null, playable = PLAYABLE } = {}) {
  return createHarness({
    config: config || configForCatalogue(),
    playableScenes: playable,
    obsDiscovery: { listScenes: async () => ({ ok: true, connected: true, scenes }) },
    tiktokDiscovery: {
      products: async () => ({ ok: true, count: products.length, products, livePinControlsAvailable: true }),
      status: async () => ({ ok: true, identity: "toko uji", identityOk: true, live: true, dashboardReady: true, chatReady: null, productCount: products.length }),
    },
  });
}

test("Start DITOLAK kalau scene pemetaan tidak ada di OBS, dan NOL proses menyala", async () => {
  const cfg = goodConfig();
  cfg.mappings = [{ scene: "PAX-9", product: { title: "O'CORN Sea Salt" }, triggers: ["etalase sembilan"], reply: "ok" }];
  const h = harnessWith({ config: cfg });

  const r = await h.controller.startAutomation();

  assert.equal(r.ok, false);
  assert.equal(h.world.spawned.length, 0, "tidak boleh ada yang dinyalakan");
  assert.equal(h.controller.state(), STATES.STOPPED);
});

test("Start DITOLAK kalau produk yang dipetakan tidak ada di katalog LIVE", async () => {
  const cfg = goodConfig();
  cfg.mappings = [{ scene: "PAX-1", product: { title: "Produk Hantu" }, triggers: ["etalase satu"], reply: "ok" }];
  const h = harnessWith({ config: cfg });

  const r = await h.controller.startAutomation();

  assert.equal(r.ok, false);
  assert.equal(r.error.code, "mapping-validation-failed");
  assert.equal(h.world.spawned.length, 0);
});

test("Start DITOLAK kalau produk ambigu", async () => {
  const cfg = goodConfig();
  cfg.mappings = [{ scene: "PAX-1", product: { title: "Gery Potato Cracker" }, triggers: ["etalase satu"], reply: "ok" }];
  const h = harnessWith({ config: cfg });

  const r = await h.controller.startAutomation();
  assert.equal(r.ok, false);
  assert.equal(h.world.spawned.length, 0);
  // Baris yang bermasalah ikut dilaporkan, supaya UI bisa menyorotnya.
  const rows = r.preflight.checks.mappings.mappings;
  assert.equal(rows[0].reason, "ambiguous-product");
});

test("Start DITOLAK kalau dua scene memakai trigger yang sama sesudah normalisasi", async () => {
  const cfg = goodConfig();
  cfg.mappings = [
    { scene: "PAX-1", product: { title: "O'CORN Sea Salt" }, triggers: ["etalase satu"], reply: "a" },
    { scene: "PAX-2", product: { title: "Dilan Cookies" }, triggers: ["Etalase 1"], reply: "b" },
  ];
  const h = harnessWith({ config: cfg });

  const r = await h.controller.startAutomation();
  assert.equal(r.ok, false);
  assert.equal(h.world.spawned.length, 0);
});

test("Start DITOLAK kalau pemetaan tanpa trigger", async () => {
  const cfg = goodConfig();
  cfg.mappings = [{ scene: "PAX-1", product: { title: "O'CORN Sea Salt" }, triggers: [], reply: "a" }];
  const h = harnessWith({ config: cfg });

  const r = await h.controller.startAutomation();
  assert.equal(r.ok, false);
  assert.equal(h.world.spawned.length, 0);
});

test("Start DITOLAK kalau TikTok tidak ada produk LIVE", async () => {
  const h = createHarness({
    playableScenes: PLAYABLE,
    obsDiscovery: { listScenes: async () => ({ ok: true, connected: true, scenes: SCENES }) },
    tiktokDiscovery: {
      products: async () => ({ ok: false, reason: "no-live-products" }),
      status: async () => ({ ok: false, reason: "no-live-products" }),
    },
  });

  const r = await h.controller.startAutomation();
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "no-live-products");
  assert.equal(r.error.userMessage, "No LIVE products detected.");
  assert.equal(h.world.spawned.length, 0);
});

test("Start DITOLAK kalau identitas TikTok salah", async () => {
  const h = createHarness({
    playableScenes: PLAYABLE,
    obsDiscovery: { listScenes: async () => ({ ok: true, connected: true, scenes: SCENES }) },
    tiktokDiscovery: {
      products: async () => ({ ok: false, reason: "wrong-tiktok-account" }),
      status: async () => ({ ok: false, reason: "wrong-tiktok-account" }),
    },
  });

  const r = await h.controller.startAutomation();
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "wrong-tiktok-account");
  assert.equal(h.world.spawned.length, 0);
});

test("Start DITOLAK kalau belum login TikTok", async () => {
  const h = createHarness({
    playableScenes: PLAYABLE,
    obsDiscovery: { listScenes: async () => ({ ok: true, connected: true, scenes: SCENES }) },
    tiktokDiscovery: {
      products: async () => ({ ok: false, reason: "tiktok-not-logged-in" }),
      status: async () => ({ ok: false, reason: "tiktok-not-logged-in" }),
    },
  });

  const r = await h.controller.startAutomation();
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "tiktok-not-logged-in");
  assert.equal(h.world.spawned.length, 0);
});

test("Start DITERIMA kalau pemetaan lolos semua, dan menyala tepat satu-satu", async () => {
  const cfg = goodConfig();
  cfg.mappings = [
    { scene: "PAX-1", product: { title: "O'CORN Sea Salt" }, triggers: ["etalase satu"], reply: "a" },
    { scene: "PAX-2", product: { title: "Dilan Cookies" }, triggers: ["etalase dua"], reply: "b" },
  ];
  const h = harnessWith({ config: cfg });

  const r = await h.controller.startAutomation();

  assert.equal(r.ok, true, JSON.stringify(r.error || {}));
  assert.equal(h.controller.state(), STATES.RUNNING);
  assert.equal(h.world.countByScript("autopin-service.js"), 1);
  assert.equal(h.world.countByScript("index.js"), 1);
});

test("validateMappings lewat Controller melaporkan APA YANG DIPERIKSA", async () => {
  const h = harnessWith({});
  const r = await h.controller.validateMappings();
  assert.equal(r.ok, true);
  assert.deepEqual(r.checked, { obsScenes: true, products: true });
});

test("validateMappings jujur kalau discovery tidak tersedia", async () => {
  const h = createHarness({ playableScenes: PLAYABLE });
  const r = await h.controller.validateMappings();
  // Tanpa adapter, tidak ada scene atau katalog untuk dibandingkan.
  assert.deepEqual(r.checked, { obsScenes: false, products: false });
});
