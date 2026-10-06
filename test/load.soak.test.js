// Uji beban dan soak, OFFLINE.
//
// Pertanyaan yang dijawab berkas ini: kalau penontonnya banyak dan ramai
// berinteraksi, apa yang tumbuh, apa yang melambat, dan apa yang TETAP tepat
// satu kali. Semuanya tanpa TikTok, OBS, browser, atau jaringan.
//
// Angka yang diukur dicetak supaya bisa dibandingkan antar-rilis. Ambang
// batas assert-nya sengaja longgar - mesin CI dan laptop berbeda jauh - tapi
// yang bersifat JAMINAN (jumlah entri, jumlah klik, batas antrean) di-assert
// ketat, karena itu bukan soal kecepatan melainkan benar atau salah.

const { test, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");

process.env.SCENE_REPLAY_COOLDOWN_MS = "120000";
process.env.DOTENV_CONFIG_QUIET = "true";

const { execFileSync } = require("node:child_process");
const path = require("node:path");

const bot = require("../index.js");
const { buildMatcherIndex, matchFuzzy, levenshteinCapped } = require("../tiktok/matcher");
const { createBoundedStore } = require("../runtime/bounded-store");
const { createOpLog } = require("../runtime/op-log");
const { createChatGate } = require("../tiktok/chat-gate");

const { SCENES, RULES } = bot;
const QUEUE_KICK_MS = 50;
const GLOBAL_PAUSE_MS = 60_000;
const PAX_CONST = ["SATU", "DUA", "TIGA", "EMPAT", "LIMA", "ENAM", "TUJUH", "DELAPAN", "SEMBILAN", "SEPULUH"];
const paxScene = (n) => SCENES[`AILIVE_SKUPAX${PAX_CONST[n - 1]}`];
const ruleFor = (scene) => RULES.find((r) => r.scene === scene);
const inputOf = (scene) => ruleFor(scene).mediaInputs[0];

// Langsung ke stdout: beberapa tes membungkam console.log, dan angka ukur
// TIDAK boleh ikut hilang.
const report = (label, value) => process.stdout.write(`    ${label.padEnd(44)} ${value}
`);
const ms = (fn) => {
  const t = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t) / 1e6;
};

// ===================================================================
// 1. MATCHER: kesetaraan dengan algoritma lama, lalu kecepatannya
// ===================================================================

// Algoritma LAMA ditulis ulang apa adanya. Pembanding yang jujur harus kode,
// bukan ingatan.
function levOld(a, b) {
  if (!a || !b) return a || b ? Math.max(a.length, b.length) : 0;
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i += 1) dp[i][0] = i;
  for (let j = 0; j <= n; j += 1) dp[0][j] = j;
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + c);
    }
  }
  return dp[m][n];
}
function fuzzyOld(rules, msgNorm, norm) {
  let best = { score: 0, rule: null };
  for (const r of rules) {
    if (!Array.isArray(r.keywords)) continue;
    for (const kw of r.keywords) {
      const kn = norm(kw);
      const d = levOld(msgNorm, kn);
      const ml = Math.max(msgNorm.length, kn.length);
      const sc = ml === 0 ? 1 : 1 - d / ml;
      if (sc > best.score) best = { score: sc, rule: r };
    }
  }
  return best.rule && best.score >= 0.55 ? best : { score: best.score, rule: null };
}

// Lalu lintas campur: salah tulis, pertanyaan biasa, pesan sangat pendek dan
// sangat panjang, angka, emoji.
const TRAFFIC = [
  "spill etalase 1", "spil etalas 1 dong kak", "etalse 2 kak", "etalase sepuluh",
  "halo kak mau tanya ongkir ke bandung berapa ya", "bon bon nya masih ada ga",
  "kak kapan restock pandan waffle nya", "ok", "p", "produk no 7 ada diskon",
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "🛒🛒🛒",
  "ETALASE 3 DONG", "etalase   4   ", "mau yg nomer 5", "stok habis ya kak",
];

const norm = bot.normalizeForMatching;
const corpus = [];
for (let i = 0; i < 600; i += 1) corpus.push(norm(TRAFFIC[i % TRAFFIC.length] + (i % 3 ? " " + i : "")));

test("MATCHER: hasilnya IDENTIK dengan algoritma lama di seluruh korpus", () => {
  const rules = bot.activeRules();
  const idx = buildMatcherIndex(rules, { normalize: norm });
  let beda = 0;
  const contoh = [];
  for (const m of corpus) {
    const o = fuzzyOld(rules, m, norm);
    const n = matchFuzzy(idx, m, {});
    const os = o.rule ? o.rule.scene : null;
    const ns = n.rule ? n.rule.scene : null;
    if (os !== ns) {
      beda += 1;
      if (contoh.length < 3) contoh.push(`${JSON.stringify(m)} lama=${os} baru=${ns}`);
    }
  }
  report("pesan diuji", corpus.length);
  report("perbedaan hasil vs algoritma lama", beda);
  assert.equal(beda, 0, "penyaring TIDAK boleh mengubah satu keputusan pun: " + contoh.join(" ; "));
});

test("MATCHER: penyaring aritmetika tidak pernah membuang kecocokan yang mungkin", () => {
  // Pemeriksaan langsung atas batas bawahnya: untuk tiap pasangan yang LOLOS
  // ambang, batas bawah harus <= jarak yang diizinkan.
  const idx = buildMatcherIndex(bot.activeRules(), { normalize: norm });
  let diperiksa = 0;
  for (const m of corpus.slice(0, 120)) {
    for (const e of idx.entries) {
      const maxLen = Math.max(m.length, e.len);
      const allowed = Math.floor(0.45 * maxLen);
      const dist = levOld(m, e.norm);
      if (dist <= allowed) {
        // Pasangan ini BISA lolos ambang -> penyaring wajib meloloskannya.
        assert.ok(Math.abs(m.length - e.len) <= allowed, `panjang membuang kandidat sah: ${m} / ${e.norm}`);
        diperiksa += 1;
      }
    }
  }
  report("pasangan lolos-ambang yang diperiksa", diperiksa);
  assert.ok(diperiksa > 0, "korpusnya harus memuat kecocokan, kalau tidak tes ini hampa");
});

test("MATCHER: latensi dan pengurangan kandidat", () => {
  const rules = bot.activeRules();
  const idx = buildMatcherIndex(rules, { normalize: norm });

  const msOld = ms(() => {
    for (const m of corpus) fuzzyOld(rules, m, norm);
  }) / corpus.length;
  const msNew = ms(() => {
    for (const m of corpus) matchFuzzy(idx, m, {});
  }) / corpus.length;

  let cand = 0;
  let cells = 0;
  for (const m of corpus) {
    const r = matchFuzzy(idx, m, {});
    cand += r.stats.candidates;
    cells += r.stats.cells;
  }

  report("keyword di indeks", idx.size);
  report("LAMA ms/pesan", msOld.toFixed(3) + `  (~${Math.round(1000 / msOld)}/s)`);
  report("BARU ms/pesan", msNew.toFixed(3) + `  (~${Math.round(1000 / msNew)}/s)`);
  report("percepatan", (msOld / msNew).toFixed(1) + "x");
  report("kandidat rata-rata per pesan", (cand / corpus.length).toFixed(1) + " dari " + idx.size);
  report("sel DP rata-rata per pesan", Math.round(cells / corpus.length));

  assert.ok(msNew < msOld, "harus lebih cepat");
  assert.ok(cand / corpus.length < idx.size * 0.5, "mayoritas keyword harus tersaring");
  assert.ok(msNew < 2, "longgar, tapi menangkap regresi besar: " + msNew.toFixed(3) + " ms");
});

test("MATCHER: anggaran kerja melaporkan diri saat tersentuh, dan tidak tersentuh di lalu lintas normal", () => {
  const idx = buildMatcherIndex(bot.activeRules(), { normalize: norm });

  // Mekanismenya: anggaran sangat kecil pada pesan yang MEMANG punya kandidat.
  const kaya = norm("etalase 1");
  const kecil = matchFuzzy(idx, kaya, { budgetCells: 1 });
  assert.equal(kecil.stats.budgetExceeded, true, "anggaran habis harus dilaporkan, bukan didiamkan");
  assert.equal(kecil.rule, null, "tidak boleh mengarang kecocokan dari pekerjaan yang tidak dilakukan");

  // Properti yang sebenarnya penting: anggaran bawaan TIDAK pernah tersentuh
  // oleh lalu lintas nyata, jadi ia murni jaring pengaman.
  let tersentuh = 0;
  let maxCells = 0;
  for (const m of corpus) {
    const r = matchFuzzy(idx, m, {});
    if (r.stats.budgetExceeded) tersentuh += 1;
    if (r.stats.cells > maxCells) maxCells = r.stats.cells;
  }
  report("sel DP terbanyak pada satu pesan", maxCells);
  report("pesan yang menyentuh anggaran", tersentuh + " dari " + corpus.length);
  assert.equal(tersentuh, 0, "lalu lintas normal tidak boleh menyentuh anggaran");

  // Pesan sangat panjang justru tersaring HABIS oleh batas panjang - tidak ada
  // keyword sepanjang itu - jadi biayanya nol, bukan besar.
  const panjang = norm("etalase " + "a".repeat(400));
  const jauh = matchFuzzy(idx, panjang, {});
  report("kandidat untuk pesan 400+ karakter", jauh.stats.candidates);
  assert.equal(jauh.stats.candidates, 0, "penyaring panjang membuang semuanya lebih dulu");
});

test("MATCHER: levenshtein berbatas memberi jarak yang sama dengan versi penuh", () => {
  const pasangan = [["etalase 1", "etalase 2"], ["spil", "spill"], ["", "abc"], ["sama", "sama"], ["panjangsekali", "pendek"]];
  for (const [a, b] of pasangan) {
    const penuh = levOld(a, b);
    const besar = levenshteinCapped(a, b, 999);
    assert.equal(besar, penuh, `${a} / ${b}`);
  }
});

// ===================================================================
// 2. STATE PER-PENONTON: harus BERBATAS
// ===================================================================

test("SOAK: 50.000 penonton unik -> entri TIDAK PERNAH melewati batas", () => {
  bot.__test.setUserStateLimits({ maxSize: 2_000, ttlMs: 600_000 });
  const N = 50_000;

  const dur = ms(() => {
    // Pesan yang TIDAK cocok apa pun: yang diuji state-nya, bukan antreannya.
    for (let i = 0; i < N; i += 1) bot.handleChat({ nickname: "penonton-" + i, comment: "halo kak nanya ongkir" });
  });

  const st = bot.__test.userStateStats();
  report("penonton unik diproses", N);
  report("entri tersimpan", st.size + " (batas " + st.maxSize + ")  <= INI buktinya");
  report("dibuang karena penuh", st.evicted);
  report("ms/pesan (handleChat, 50rb nickname unik)", (dur / N).toFixed(4) + "  (~" + Math.round(1000 / (dur / N)) + "/s)");

  // Jumlah entri adalah bukti yang DETERMINISTIK. Angka heap diukur terpisah
  // di bawah, karena heapUsed di dalam berkas tes multi-tes ikut memuat sisa
  // pekerjaan tes lain - terukur 61 MB di sini versus 0,9 MB saat diisolasi,
  // dan angka yang menyesatkan lebih buruk daripada tidak ada angka.
  assert.ok(st.size <= st.maxSize, "INILAH kebocoran lama: size=" + st.size);
  assert.ok(st.evicted > 0, "pembuangan harus benar-benar terjadi");
  assert.equal(st.size, 2_000);
});

test("SOAK: pertumbuhan heap diukur di PROSES TERPISAH supaya angkanya bisa dipercaya", () => {
  // Satu proses, satu pekerjaan, GC paksa di kedua sisi. Ini satu-satunya cara
  // mendapat angka heap yang berarti.
  const script = [
    "process.env.DOTENV_CONFIG_QUIET='true';",
    "const bot=require(process.argv[1]);",
    "bot.obs.call=async()=>{};",
    "bot.__test.setScenePin({requestPin:async()=>({ok:false,reason:'noop'})});",
    "bot.__test.setAutoComment({requestComment:async()=>({ok:false,reason:'noop'})});",
    "bot.__test.setUserStateLimits({maxSize:2000,ttlMs:600000});",
    "console.log=()=>{};",
    "global.gc();",
    "const before=process.memoryUsage().heapUsed;",
    "for(let i=0;i<50000;i++) bot.handleChat({nickname:'penonton-'+i, comment:'halo kak nanya ongkir'});",
    "const st=bot.__test.userStateStats();",
    "global.gc();",
    "const mb=(process.memoryUsage().heapUsed-before)/1048576;",
    "process.stdout.write(JSON.stringify({mb, size:st.size, evicted:st.evicted}));",
  ].join("");

  const out = execFileSync(process.execPath, ["--expose-gc", "-e", script, path.resolve(__dirname, "../index.js")], {
    encoding: "utf8",
    timeout: 120_000,
  });
  const r = JSON.parse(out.slice(out.indexOf("{")));

  report("[proses terpisah] penonton unik", 50_000);
  report("[proses terpisah] entri tersimpan", r.size);
  report("[proses terpisah] dibuang", r.evicted);
  report("[proses terpisah] heap naik (GC paksa)", r.mb.toFixed(1) + " MB");

  assert.equal(r.size, 2_000, "batas dipatuhi");
  assert.equal(r.evicted, 48_000);
  // Dulu: ~1.454 byte per penonton, permanen -> 50.000 penonton = ~70 MB yang
  // tidak pernah kembali. Sekarang harus hampir rata.
  assert.ok(r.mb < 10, "pertumbuhan heap harus kecil dan tidak sebanding jumlah penonton: " + r.mb.toFixed(1) + " MB");
});

test("SOAK: entri kedaluwarsa dibuang tanpa menunggu penuh", () => {
  let t = 1_000;
  const store = createBoundedStore({ maxSize: 10_000, ttlMs: 60_000, now: () => t });
  for (let i = 0; i < 500; i += 1) store.set("u" + i, { n: i });
  assert.equal(store.size(), 500);

  t += 61_000; // semua lewat TTL
  store.set("baru", { n: 1 });
  const dibuang = store.sweep();

  report("entri kedaluwarsa dibuang", dibuang);
  assert.equal(dibuang, 500);
  assert.equal(store.size(), 1, "hanya yang baru tersisa");
});

test("SOAK: penonton aktif TIDAK terbuang oleh yang diam", () => {
  let t = 1_000;
  const store = createBoundedStore({ maxSize: 3, ttlMs: 600_000, now: () => t });
  store.set("diam1", 1);
  store.set("diam2", 2);
  store.set("aktif", 3);
  t += 10;
  store.set("aktif", 4); // menulis lagi -> pindah ke belakang
  store.set("baru1", 5); // memaksa pembuangan

  assert.equal(store.get("aktif"), 4, "yang masih bicara harus bertahan");
  assert.equal(store.get("diam1"), undefined, "yang paling lama diam yang dibuang");
});

// ===================================================================
// 3. LEDAKAN: berapa lama event loop tersumbat
// ===================================================================

test("BURST: 5.000 komentar sekaligus -> event loop tersumbat dalam batas wajar", () => {
  bot.__test.setUserStateLimits({ maxSize: 5_000, ttlMs: 600_000 });
  bot.__test.reset();
  const N = 5_000;

  // Campuran: salah tulis, pertanyaan, pesan pendek. Tidak ada yang memicu
  // scene supaya yang terukur murni jalur pencocokan.
  const dur = ms(() => {
    for (let i = 0; i < N; i += 1) {
      bot.handleChat({ nickname: "v" + (i % 900), comment: TRAFFIC[i % TRAFFIC.length].replace("etalase", "etalse") + " " + i });
    }
  });

  report("komentar dalam satu ledakan", N);
  report("total event loop tersumbat", dur.toFixed(0) + " ms");
  report("ms/komentar", (dur / N).toFixed(3));
  report("perkiraan kapasitas", Math.round(1000 / (dur / N)) + " komentar/detik");

  // Longgar tapi bermakna: sebelum perbaikan, 5.000 pesan jalur fuzzy penuh
  // memakan belasan detik.
  assert.ok(dur < 8_000, "ledakan tidak boleh menyumbat selama belasan detik: " + dur.toFixed(0) + " ms");
});

// ===================================================================
// 4. GERBANG CHAT di bawah lalu lintas berulang dan pesan sendiri
// ===================================================================

test("GERBANG: 10.000 pesan kembar + pesan sendiri -> nol yang diterima", () => {
  const gate = createChatGate({ selfIdentities: ["agen_mulia_abadi"], now: () => 2_000_000, logger: { log() {} } });
  gate.markConnected();

  // 50 pesan unik, masing-masing diantar 200 kali.
  let diterima = 0;
  for (let r = 0; r < 200; r += 1) {
    for (let i = 0; i < 50; i += 1) {
      if (gate.accept({ uniqueId: "lincoln", nickname: "lincoln", comment: "spill etalase 1", msgId: "m" + i }).ok) diterima += 1;
    }
  }
  // 2.000 pesan dari akun host sendiri.
  let self = 0;
  for (let i = 0; i < 2_000; i += 1) {
    if (!gate.accept({ uniqueId: "agen_mulia_abadi", comment: "Etalase 1 sudah aku pin ya kak", msgId: "s" + i }).ok) self += 1;
  }

  const st = gate.__state();
  report("pesan unik diterima (dari 10.000 antaran)", diterima);
  report("pesan sendiri ditolak", self);
  report("memori msgId (berbatas)", st.seenIds);

  assert.equal(diterima, 50, "tiap pesan unik tepat sekali, sisanya kembar");
  assert.equal(self, 2_000, "pesan sendiri selalu ditolak");
  assert.ok(st.seenIds <= 500, "memori msgId berbatas: " + st.seenIds);
});

// ===================================================================
// 5. LOG: diringkas, bukan satu baris per pesan
// ===================================================================

test("LOG: 20.000 kejadian serupa -> baris log tetap sedikit", () => {
  let t = 1_000;
  const lines = [];
  const ops = createOpLog({ windowMs: 10_000, now: () => t, logger: { log: (l) => lines.push(l) } });

  for (let i = 0; i < 20_000; i += 1) {
    ops.event("BUSY_QUEUED", "scene=PAX-2");
    if (i % 5_000 === 0) t += 11_000; // beberapa jendela berlalu
  }
  ops.flush();

  report("kejadian", 20_000);
  report("baris log tercetak", lines.length);
  assert.ok(lines.length < 20, "dulu 20.000 baris, sekarang: " + lines.length);
  assert.ok(lines.some((l) => l.includes("serupa ditahan")), "jumlah yang ditahan harus terlihat");
  assert.equal(ops.__state().kinds, 1, "satu jenis saja, memorinya tidak tumbuh");
});

// ===================================================================
// 6. SIKLUS SCENE PENUH: nol pin/komentar ganda
// ===================================================================

let pins = [];
let comments = [];
let obsSwitches = [];

beforeEach(() => {
  pins = [];
  comments = [];
  obsSwitches = [];
  mock.method(console, "log", () => {});
  mock.method(console, "warn", () => {});
  mock.method(console, "error", () => {});
  bot.obs.call = async (req, params = {}) => {
    if (req === "SetCurrentProgramScene") obsSwitches.push(params.sceneName);
  };
  bot.__test.setScenePin({
    requestPin: async (req) => {
      pins.push({ scene: req.scene, playId: req.playId });
      return { ok: true, reason: "pinned", dryRun: false, clicked: true, state: "Unpin" };
    },
  });
  bot.__test.setAutoComment({
    requestComment: async (req) => {
      comments.push({ scene: req.scene, playId: req.playId });
      return { ok: true };
    },
  });
  bot.__test.reset();
});

afterEach(() => {
  bot.__test.reset();
  mock.timers.reset();
  mock.restoreAll();
});

const flush = () => new Promise((r) => setImmediate(r));
async function advance(msv) {
  mock.timers.tick(msv);
  await flush();
  await flush();
}
const mediaEnd = (input) => bot.obs.emit("MediaInputPlaybackEnded", { inputName: input, inputUuid: "u-" + input });
const uniq = (arr) => new Set(arr.map((x) => x.scene + "#" + x.playId)).size;

test("BEBAN: 10 scene x 500 permintaan kembar -> tepat SATU pin & SATU chat per pemutaran", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });

  for (let n = 1; n <= 10; n += 1) {
    const scene = paxScene(n);
    // 500 penonton berbeda meminta scene yang sama, serentak.
    for (let i = 0; i < 500; i += 1) bot.handleChat({ nickname: `v${n}-${i}`, comment: `etalase ${n}` });
    await advance(QUEUE_KICK_MS);
    assert.equal(bot.__test.getState().activeScene, scene, "scene " + n + " harus mulai");

    // Lebih banyak permintaan SELAGI scene itu tayang.
    for (let i = 0; i < 500; i += 1) bot.handleChat({ nickname: `w${n}-${i}`, comment: `etalase ${n}` });

    mediaEnd(inputOf(scene));
    await advance(QUEUE_KICK_MS);
    await advance(GLOBAL_PAUSE_MS + QUEUE_KICK_MS);
  }

  report("komentar diproses", 10 * 1000);
  report("scene tayang", obsSwitches.filter((s) => s !== SCENES.AILIVE_MAIN).length);
  report("permintaan pin", pins.length);
  report("permintaan chat", comments.length);
  report("pasangan (scene,playId) unik", uniq(pins));

  assert.equal(pins.length, 10, "satu pin per pemutaran, bukan per komentar");
  assert.equal(comments.length, 10, "satu chat per pemutaran");
  assert.equal(uniq(pins), pins.length, "NOL pin ganda untuk playId yang sama");
  assert.equal(uniq(comments), comments.length, "NOL chat ganda untuk playId yang sama");
  // playId harus naik tanpa terulang: itu yang menjaga gerbang basi tetap benar.
  const ids = pins.map((p) => p.playId);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), "playId harus monoton: " + ids.join(","));
  assert.equal(new Set(ids).size, ids.length, "playId tidak boleh terulang");
});

test("BEBAN: SEMUA scene diminta serentak -> antrean terbatas oleh jumlah scene", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });

  // 10 scene x 300 permintaan, semuanya dalam satu ledakan sebelum apa pun jalan.
  for (let i = 0; i < 300; i += 1) {
    for (let n = 1; n <= 10; n += 1) bot.handleChat({ nickname: `b${n}-${i}`, comment: `etalase ${n}` });
  }

  const q = bot.__test.getState().queue;
  report("komentar dalam ledakan", 3_000);
  report("entri antrean", q.length);
  report("total count di antrean", q.reduce((a, x) => a + x.count, 0));

  assert.ok(q.length <= 10, "antrean dibatasi jumlah scene, bukan jumlah penonton: " + q.length);
  assert.equal(q.reduce((a, x) => a + x.count, 0), 3_000, "setiap permintaan tetap terhitung");
  assert.equal(new Set(q.map((x) => x.scene)).size, q.length, "satu entri per scene");
});

test("BEBAN: scene yang sama diminta terus-menerus -> tetap satu entri, satu pemutaran", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const scene = paxScene(1);

  for (let i = 0; i < 2_000; i += 1) bot.handleChat({ nickname: "u" + i, comment: "etalase 1" });
  assert.deepEqual(bot.__test.getState().queue.map((x) => x.scene), [scene], "2.000 permintaan -> satu entri");

  await advance(QUEUE_KICK_MS);
  for (let i = 0; i < 2_000; i += 1) bot.handleChat({ nickname: "x" + i, comment: "etalase 1" });

  mediaEnd(inputOf(scene));
  await advance(QUEUE_KICK_MS);

  report("permintaan", 4_000);
  report("pemutaran", pins.length);
  assert.equal(pins.length, 1, "4.000 permintaan = satu pemutaran");
  assert.equal(comments.length, 1);
});

test("BEBAN: lalu lintas salah-tulis berat tetap merutekan benar dan tidak menyumbat", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });

  const salahTulis = ["spil etalas 1", "etalse 1 kak", "etalase1", "spill etalase satu"];
  const dur = ms(() => {
    for (let i = 0; i < 2_000; i += 1) bot.handleChat({ nickname: "t" + i, comment: salahTulis[i % salahTulis.length] });
  });

  await advance(QUEUE_KICK_MS);
  report("komentar salah-tulis", 2_000);
  report("ms/komentar", (dur / 2_000).toFixed(3));
  report("scene tayang", bot.__test.getState().activeScene);

  assert.equal(bot.__test.getState().activeScene, paxScene(1), "salah tulis tetap sampai ke PAX-1");
  assert.equal(pins.length, 1, "tetap satu pin");
  assert.ok(dur < 5_000, "lalu lintas fuzzy berat tidak boleh menyumbat lama: " + dur.toFixed(0) + " ms");
});


// ===================================================================
// 7. SATU PEKERJA MUTASI BROWSER, TETAP TERSERIALISASI
// ===================================================================
// Yang dijaga di sini bukan kecepatan, tapi bahwa dua pekerjaan UI tidak
// pernah berjalan berbarengan di satu halaman. Kalau pernah, dua klik bisa
// saling menimpa dan produk yang salah ter-pin.

test("SERIAL: 400 permintaan serentak -> mutasi browser TIDAK PERNAH bertumpuk", async () => {
  const CONSOLE = "https://shop.tiktok.com/streamer/live/product/dashboard";
  const SHOP = "agen_mulia_abadi";
  const P = "Produk Uji Satu";

  let active = 0;
  let maxActive = 0;
  let overlaps = 0;
  let pinCalls = 0;
  const yieldOnce = () => new Promise((r) => setImmediate(r));
  const enter = () => {
    active += 1;
    if (active > maxActive) maxActive = active;
    if (active > 1) overlaps += 1;
  };
  const exit = () => {
    active -= 1;
  };

  const { createService } = require("../autopin/service");
  const svc = createService({
    config: { consoleUrl: CONSOLE, expectedShop: SHOP, forbiddenShops: ["garudafood"] },
    allowAutoCommentSend: true,
    deps: {
      launchBrowser: async () => ({ id: "fake" }),
      getPage: async () => ({ url: () => CONSOLE, isClosed: () => false, bringToFront: async () => {} }),
      newPage: async () => ({ url: () => CONSOLE, isClosed: () => false }),
      openConsole: async () => ({ url: CONSOLE, settled: true, readyMs: 1 }),
      closeBrowser: async () => {},
      readIdentity: async () => [SHOP],
      waitForComposerReady: async () => ({ ready: true, ms: 0, polls: 1 }),
      // Setiap langkah yang menyentuh halaman menandai masuk/keluar, dan
      // menyerahkan kendali di tengah supaya tumpang tindih BISA terjadi
      // kalau serialisasinya bocor.
      collectProducts: async () => {
        enter();
        await yieldOnce();
        exit();
        return {
          products: [{ number: 1, title: P, pinText: "Unpin", badges: [], pinButtons: 1, pinVisible: true, pinDisabled: false }],
          livePinButtonsOnPage: 1,
        };
      },
      pinProductByTitle: async (_p, key) => {
        enter();
        await yieldOnce();
        pinCalls += 1;
        exit();
        return { ok: true, title: P, key };
      },
      readPinState: async () => {
        enter();
        await yieldOnce();
        exit();
        return { found: true, buttons: 1, text: "Unpin" };
      },
      sleep: async () => {},
    },
  });

  // playId 0 sengaja: tidak pernah basi dan tidak menaikkan generasi, jadi
  // SEMUA permintaan benar-benar sampai ke jalur browser.
  const jobs = [];
  for (let i = 0; i < 200; i += 1) {
    jobs.push(svc.handlePin({ scene: "PAX-1", productKey: "uji satu", playId: 0 }));
    jobs.push(svc.handleCommentDryRun({ text: "cek", scene: "PAX-1", playId: 0 }));
  }
  const hasil = await Promise.all(jobs);

  report("permintaan serentak", jobs.length);
  report("pin yang benar-benar diklik", pinCalls);
  report("mutasi browser bersamaan (maks)", maxActive);
  report("tumpang tindih terdeteksi", overlaps);

  assert.equal(overlaps, 0, "dua pekerjaan UI tidak boleh pernah bersamaan");
  assert.equal(maxActive, 1, "satu pekerja, satu pekerjaan");
  assert.equal(hasil.filter((r) => r && r.ok).length > 0, true, "pekerjaannya memang jalan, bukan tertolak semua");
});

test("SERIAL: agregasi scene tetap seperti sebelumnya - satu entri per scene", () => {
  // Pengaman eksplisit untuk item (6): peringkasan permintaan TIDAK berubah.
  bot.__test.reset();
  for (let i = 0; i < 1_000; i += 1) bot.handleChat({ nickname: "agg" + i, comment: "etalase 3" });
  const q = bot.__test.getState().queue;
  assert.equal(q.length, 1, "1.000 permintaan -> satu entri");
  assert.equal(q[0].count, 1_000, "semua tetap terhitung");
  assert.equal(q[0].scene, paxScene(3));
});
