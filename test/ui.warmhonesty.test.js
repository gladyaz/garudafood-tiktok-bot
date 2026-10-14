// RUNNING tidak boleh mengaku siap sepenuhnya selagi browser automation
// masih memanas.
//
// Yang terjadi sebelum pass ini: /health menjawab segera saat listen(), jadi
// Controller melihat service "sehat" dan bertransisi ke RUNNING - sementara
// warmUp() masih berjalan di latar membuka halaman produk, lalu warmUpChat()
// membuka komposer. Log run tervalidasi: SERVICE_READY 0,56 detik sesudah
// spawn, jauh lebih cepat daripada peluncuran Chrome mana pun.
//
// Desainnya BENAR - pemanasan sengaja di luar jalur kritis START, dan pass ini
// tidak mengubahnya. Yang belum benar adalah JANJINYA: layar berbunyi "Bot
// mendengarkan chat LIVE Anda" sebelum ada yang bisa mem-pin apa pun, lalu
// pemicu pertama terasa lambat dan customer menyalahkan aturannya.
//
// Sinyalnya NYATA dan sudah ada:
//   [AUTOPIN_SERVICE_WARMED] ok=true       halaman produk terbuka
//   [AUTOPIN_SERVICE_CHAT_WARMED] ok=true  komposer chat siap
// Tidak ada detik berlalu, tidak ada timeout, tidak ada perkiraan 25-30 detik.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const U = require("../controller/public/ui-logic.js");
const I = require("../controller/public/i18n.js");

const CONTROLLER_SRC = fs.readFileSync(path.join(__dirname, "..", "controller", "controller.js"), "utf8");

function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// View RUNNING yang lengkap. `warm` dan `mode` yang diubah per kasus.
function runningView({ warm, reply = true }) {
  return {
    status: {
      automation: "RUNNING",
      config: { present: true },
      bot: { running: true },
      login: { active: false },
      mode: { ok: true, pin: true, reply: reply, needsPin: true },
      service: Object.assign({ running: true, pid: 2 }, warm === undefined ? {} : { warm: warm }),
    },
    config: { mappings: [{ scene: "PAX-1", product: "p1", triggers: ["a"] }] },
    validation: { ok: true },
    busy: false,
    startStage: null,
  };
}

const READY_TITLE = (lang) => I.DICT[lang]["ui.hero.running.title"];
const WARMING_TITLE = (lang) => I.DICT[lang]["ui.hero.warming.title"];
const FAILED_TITLE = (lang) => I.DICT[lang]["ui.hero.warmFailed.title"];

/* === sedang memanas: JANGAN mengaku siap ================================= */

test("RUNNING + belum ada kabar pemanasan TIDAK berbunyi siap sepenuhnya", () => {
  for (const lang of I.LANGS) {
    const h = U.heroView(runningView({ warm: { pin: null, reply: null } }), lang);
    assert.notEqual(h.title, READY_TITLE(lang), lang + " mengaku siap padahal belum hangat");
    assert.equal(h.title, WARMING_TITLE(lang));
    assert.equal(h.tone, "attention", lang + " memakai nada siap/hijau");
    assert.notEqual(h.tone, "running");
  }
});

test("pin sudah hangat tapi komposer chat belum: masih menyiapkan", () => {
  const h = U.heroView(runningView({ warm: { pin: true, reply: null } }), "id");
  assert.equal(U.serviceWarmth(runningView({ warm: { pin: true, reply: null } }).status), U.WARMTH.WARMING);
  assert.equal(h.title, WARMING_TITLE("id"));
  assert.equal(h.tone, "attention");
});

// Field `warm` yang hilang sama sekali diperlakukan sebagai BELUM TAHU, bukan
// sebagai siap. Fail-closed di sisi tampilan: mengaku siap tanpa bukti adalah
// persis cacat yang diperbaiki pass ini.
test("tanpa field warm sama sekali, layar TIDAK mengaku siap", () => {
  const h = U.heroView(runningView({ warm: undefined }), "id");
  assert.equal(U.serviceWarmth(runningView({ warm: undefined }).status), U.WARMTH.UNKNOWN);
  assert.notEqual(h.title, READY_TITLE("id"));
  assert.equal(h.tone, "attention");
});

/* === sudah hangat: keadaan siap yang LAMA, apa adanya ==================== */

test("RUNNING + dua-duanya hangat memakai keadaan siap yang sudah ada", () => {
  for (const lang of I.LANGS) {
    const v = runningView({ warm: { pin: true, reply: true } });
    const h = U.heroView(v, lang);
    assert.equal(U.serviceWarmth(v.status), U.WARMTH.READY);
    assert.equal(h.title, READY_TITLE(lang));
    assert.equal(h.over, I.DICT[lang]["ui.hero.over.running"]);
    assert.equal(h.tone, "running", lang + " kehilangan nada running");
  }
});

// Run yang TIDAK membalas chat tidak boleh menunggu komposer chat: ia akan
// menunggu pekerjaan yang tidak pernah akan dilakukan.
test("run tanpa AutoComment siap begitu pin hangat", () => {
  const v = runningView({ warm: { pin: true, reply: null }, reply: false });
  assert.equal(U.serviceWarmth(v.status), U.WARMTH.READY);
  assert.equal(U.heroView(v, "id").title, READY_TITLE("id"));
  assert.equal(U.heroView(v, "id").tone, "running");
});

test("run tanpa AutoComment tidak peduli komposer chat GAGAL", () => {
  const v = runningView({ warm: { pin: true, reply: false }, reply: false });
  assert.equal(U.serviceWarmth(v.status), U.WARMTH.READY);
  assert.equal(U.heroView(v, "id").tone, "running");
});

/* === gagal / degradasi: TIDAK PERNAH terlihat siap ======================= */

test("pemanasan pin GAGAL tidak pernah terlihat siap", () => {
  for (const lang of I.LANGS) {
    const v = runningView({ warm: { pin: false, reply: null } });
    const h = U.heroView(v, lang);
    assert.equal(U.serviceWarmth(v.status), U.WARMTH.FAILED);
    assert.notEqual(h.title, READY_TITLE(lang));
    assert.equal(h.title, FAILED_TITLE(lang));
    assert.equal(h.tone, "error", lang + ": kegagalan tidak bernada error");
  }
});

test("komposer chat GAGAL saat run MEMANG membalas: dilaporkan, bukan didiamkan", () => {
  const v = runningView({ warm: { pin: true, reply: false }, reply: true });
  assert.equal(U.serviceWarmth(v.status), U.WARMTH.FAILED);
  assert.equal(U.heroView(v, "id").tone, "error");
});

// DEGRADED dan ERROR punya cabangnya sendiri yang sudah ada, dan pass ini tidak
// boleh menyentuhnya - keduanya memang sudah tidak pernah berbunyi siap.
test("DEGRADED dan ERROR tetap memakai cabangnya yang sudah ada", () => {
  for (const automation of ["DEGRADED", "ERROR"]) {
    const v = runningView({ warm: { pin: true, reply: true } });
    v.status.automation = automation;
    const h = U.heroView(v, "id");
    assert.notEqual(h.title, READY_TITLE("id"), automation + " berbunyi siap");
    assert.notEqual(h.tone, "running");
  }
});

/* === tidak ada waktu yang dipakai sebagai bukti ========================== */

// Kalau kesiapan diputuskan dari detik berlalu, ia akan mengaku siap pada
// mesin lambat tepat saat ia paling belum siap.
test("kesiapan TIDAK diturunkan dari waktu", () => {
  const long = runningView({ warm: { pin: null, reply: null } });
  long.status.service.startedAt = 1;
  long.status.bot = { running: true, startedAt: 1 };
  const h = U.heroView(long, "id");
  assert.equal(h.title, WARMING_TITLE("id"), "waktu berlalu membuatnya mengaku siap");

  // Dan fungsi keputusannya murni: hanya warm + mode yang berpengaruh.
  const a = U.serviceWarmth({ service: { warm: { pin: true, reply: true } }, mode: { reply: true } });
  const b = U.serviceWarmth({ service: { warm: { pin: true, reply: true }, startedAt: 999 }, mode: { reply: true } });
  assert.equal(a, b);
});

test("tidak ada timer/ETA di kalimat pemanasan", () => {
  const BANNED = [/\d/, /%/, /\b(detik|menit|seconds?|minutes?)\b/i, /[秒分]/];
  for (const lang of I.LANGS) {
    for (const k of ["ui.hero.warming.title", "ui.hero.warming.body", "ui.hero.warmFailed.title", "ui.hero.warmFailed.body"]) {
      for (const re of BANNED) {
        assert.doesNotMatch(I.DICT[lang][k], re, lang + "/" + k + " memuat waktu/angka");
      }
    }
  }
});

/* === kalimat lengkap di tiga bahasa ====================================== */

test("kalimat pemanasan ada dan BERBEDA di ketiga bahasa", () => {
  for (const k of ["ui.hero.warming.title", "ui.hero.warming.body", "ui.hero.warmFailed.title", "ui.hero.warmFailed.body"]) {
    const seen = I.LANGS.map((l) => I.DICT[l][k]);
    for (const v of seen) assert.ok(typeof v === "string" && v.trim() !== "", k + " kosong");
    assert.equal(new Set(seen).size, 3, k + " tidak beda di tiap bahasa");
  }
  assert.match(I.DICT["zh-CN"]["ui.hero.warming.title"], /[一-鿿]/);
  // Kalimat yang disetujui.
  assert.equal(I.DICT.id["ui.hero.warming.title"], "Bot tersambung. Menyiapkan AutoPIN dan balasan…");
  assert.equal(I.DICT.en["ui.hero.warming.title"], "Bot connected. Preparing AutoPIN and replies…");
});

/* === STOP tetap tersedia selagi memanas ================================== */

test("STOP tetap bisa ditekan selama pemanasan", () => {
  for (const warm of [{ pin: null, reply: null }, { pin: true, reply: null }, { pin: false, reply: null }]) {
    const v = runningView({ warm: warm });
    const c = U.controlsFor(v, "id");
    assert.equal(c.stopEnabled, true, "STOP mati saat " + JSON.stringify(warm));
    assert.equal(c.startEnabled, false, "START hidup padahal sedang berjalan");
  }
});

// Tombol tidak boleh ikut berubah gara-gara pass tampilan ini.
test("kehangatan tidak mengubah satu pun tombol", () => {
  const cold = U.controlsFor(runningView({ warm: { pin: null, reply: null } }), "id");
  const hot = U.controlsFor(runningView({ warm: { pin: true, reply: true } }), "id");
  assert.deepEqual(cold, hot);
});

/* === sinyalnya NYATA, dari baris yang service sudah catat ================ */

test("Controller membaca pemanasan dari baris anak, bukan dari polling baru", () => {
  const code = codeOnly(CONTROLLER_SRC);
  assert.ok(code.indexOf("WARM_LINE_RE") !== -1, "tidak ada pembacaan baris pemanasan");
  assert.ok(code.indexOf("noteWarmLine") !== -1);
  // Dibaca di jalur onLine yang SAMA dengan noteBotReady - bukan poller baru.
  const onLine = CONTROLLER_SRC.slice(CONTROLLER_SRC.indexOf("onLine: ("), CONTROLLER_SRC.indexOf("onExit: ("));
  assert.ok(onLine.indexOf("noteWarmLine") !== -1, "pemanasan tidak dibaca di onLine");
  assert.ok(onLine.indexOf("noteBotReady") !== -1, "jalur bot-ready yang lama hilang");
});

// Pola ini pernah SALAH: versi pertama saya berjangkar pada `^[SERVICE_WARMED]`,
// padahal baris produksinya berawalan AUTOPIN_ dan didahului stempel waktu.
test("pola pemanasan cocok dengan baris PRODUKSI yang sebenarnya", () => {
  const m = /const WARM_LINE_RE = (\/.*\/);/.exec(CONTROLLER_SRC);
  assert.ok(m, "WARM_LINE_RE tidak ditemukan");
  const re = eval(m[1]); // eslint-disable-line no-eval

  // Baris ini DISALIN dari log dukungan produksi.
  const real = "2026-10-08T11:30:41.256Z [CHILD:service] [AUTOPIN_SERVICE_WARMED] ok=true";
  const hit = re.exec(real);
  assert.ok(hit, "baris produksi tidak cocok: " + real);
  assert.equal(hit[1], "SERVICE_WARMED");
  assert.equal(hit[2], "true");

  assert.ok(re.exec("[AUTOPIN_SERVICE_CHAT_WARMED] ok=true"));
  assert.ok(re.exec("[AUTOPIN_SERVICE_WARMED] ok=false"));
  // Dan tidak menyambar baris lain.
  assert.equal(re.exec("[AUTOPIN_SERVICE_PAGE_READY] url=x settled=true readyMs=9957"), null);
  assert.equal(re.exec("[PLAY] scene=PAX-1 count=1"), null);
});

test("kehangatan DIRESET setiap run, tidak terbawa dari run sebelumnya", () => {
  const code = codeOnly(CONTROLLER_SRC);
  const resets = code.split("pinWarm = null").length - 1;
  assert.ok(resets >= 2, "pinWarm hanya direset " + resets + "x; butuh deklarasi + setiap start");
  assert.ok(code.split("replyWarm = null").length - 1 >= 2);
});

/* === otoritas runtime TIDAK berubah ===================================== */

test("REGRESI: kapan automation jadi RUNNING tidak berubah", () => {
  const start = CONTROLLER_SRC.slice(
    CONTROLLER_SRC.indexOf("async function startAutomation"),
    CONTROLLER_SRC.indexOf("async function stopAutomation")
  );
  // RUNNING masih ditentukan oleh bot siap, BUKAN oleh pemanasan service.
  assert.ok(start.indexOf("waitBotReady") !== -1, "jalur kesiapan bot hilang");

  // Kehangatan boleh DIRESET di sini - run baru berarti pemanasan baru - tapi
  // nilainya tidak boleh pernah DIBACA. Jadi setiap kemunculannya harus berupa
  // penugasan null, bukan sebuah syarat atau sesuatu yang di-await.
  for (const name of ["pinWarm", "replyWarm"]) {
    const uses = start.match(new RegExp(name + "[^;\\n]*", "g")) || [];
    for (const use of uses) {
      assert.match(
        use.trim(),
        new RegExp("^" + name + " = null$"),
        "start MEMBACA kehangatan, bukan hanya mereset: " + use.trim()
      );
    }
  }
  assert.equal(start.indexOf("noteWarmLine"), -1, "start memanggil pembaca baris pemanasan");
  // Dan tidak ada yang menunggu kehangatan.
  assert.doesNotMatch(start, /await[^;\n]*Warm/i, "start menunggu pemanasan - jalur kritis berubah");
});

test("REGRESI: pemanasan tidak pernah memblokir atau menunda apa pun", () => {
  const code = codeOnly(CONTROLLER_SRC);
  const fn = code.slice(code.indexOf("function noteWarmLine"), code.indexOf("function noteBotReady"));
  assert.ok(fn.length > 0);
  // Hanya menulis flag: tidak ada await, promise, atau pemberi sinyal.
  for (const re of [/await/, /Promise/, /resolve/, /setTimeout/]) {
    assert.doesNotMatch(fn, re, "noteWarmLine melakukan lebih dari menandai: " + re);
  }
});

test("REGRESI: kebijakan headless dan kepemilikan profil tidak disentuh", () => {
  const code = codeOnly(CONTROLLER_SRC);
  // Pass ini tidak boleh menambah penyebutan apa pun soal browser/profil.
  const fn = code.slice(code.indexOf("function noteWarmLine"), code.indexOf("function noteBotReady"));
  for (const re of [/headless/i, /PURPOSE/, /profileDir/, /ownership/]) {
    assert.doesNotMatch(fn, re);
  }
});

/* === progres START tidak berubah ======================================== */

test("REGRESI: tahap START tetap tujuh dan tetap menang saat busy", () => {
  assert.equal(U.START_STAGES.length, 7);
  const v = runningView({ warm: { pin: null, reply: null } });
  v.busy = true;
  v.startStage = "connecting";
  // Tahap START tetap menang atas kalimat pemanasan selama rantainya berjalan.
  assert.equal(U.heroView(v, "id").title, U.startStageText("connecting", "id"));
});
