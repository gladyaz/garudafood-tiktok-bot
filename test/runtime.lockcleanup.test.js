// Pembersihan kunci bot oleh INDUK. OFFLINE, fs palsu, tanpa proses.
//
// ---------------------------------------------------------------------------
// KEJADIAN YANG MELAHIRKAN BERKAS INI
//
// Validasi LIVE 2026-10-09 pada aplikasi TERPASANG. Lima scene berhasil, stop
// bersih, nol proses tersisa — tapi:
//
//   %APPDATA%\AI LIVE HOST\.bot.lock  masih ada, pid=38576, dan pid itu MATI
//
// Sebabnya terlihat langsung di log run yang sama:
//
//   [CONTROLLER_CHILD_EXIT] role=bot pid=38576 code=null signal=SIGTERM
//
// Di Windows `child.kill("SIGTERM")` memanggil TerminateProcess. Handler
// SIGINT/SIGTERM/exit di index.js — yang memanggil lock.release() — TIDAK
// PERNAH berjalan. Jadi bot secara struktural tidak bisa membersihkan kuncinya
// sendiri di platform ini.
//
// Maka yang membersihkan adalah pihak yang MEMBUKTIKAN kematiannya: induk.
//
// ---------------------------------------------------------------------------
// YANG TIDAK BOLEH IKUT BERUBAH
//
// acquire() TETAP fail-closed. Satu pun pelonggaran di sana akan mengizinkan bot
// kedua menyala saat bot pertama masih hidup, dan itu adalah insiden LIVE
// 2026-10-05 yang melahirkan kunci ini. Tes di bagian akhir berkas memaku itu.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createInstanceLock,
  releaseLockFor,
  clearLockIfNoBot,
  readLock,
  LOCK_FILENAME,
  LOCK_FILE_ENV,
} = require("../runtime/single-instance");

const LOCK = "/fake/userData/.bot.lock";

// fs palsu berbasis Map. Mencatat setiap unlink supaya tes bisa membuktikan
// bahwa sebuah berkas TIDAK disentuh, bukan hanya bahwa ia masih ada.
function fakeFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const unlinks = [];
  return {
    files,
    unlinks,
    readFileSync(p) {
      if (!files.has(p)) {
        const err = new Error("ENOENT: " + p);
        err.code = "ENOENT";
        throw err;
      }
      return files.get(p);
    },
    writeFileSync(p, data) {
      files.set(p, String(data));
    },
    unlinkSync(p) {
      unlinks.push(p);
      if (!files.has(p)) {
        const err = new Error("ENOENT: " + p);
        err.code = "ENOENT";
        throw err;
      }
      files.delete(p);
    },
  };
}

function lockBody(pid, script = "index.js") {
  return JSON.stringify({ pid, startedAt: 1_700_000_000_000, script }, null, 2);
}

// --- 1. bot start -> kunci dibuat -------------------------------------------

test("start bot: kunci DIBUAT di berkas yang ditunjuk environment", () => {
  // Jalur produksi: Controller mengisi AILIVE_LOCK_FILE lewat toEnv(), dan bot
  // memanggil createInstanceLock tanpa menyebut `file`.
  const fs = fakeFs();
  const lock = createInstanceLock({
    fs,
    pid: 4242,
    script: "index.js",
    env: { [LOCK_FILE_ENV]: LOCK },
    logger: { log: () => {} },
  });

  const r = lock.acquire();
  assert.equal(r.ok, true);
  assert.equal(r.mode, "fresh");
  assert.equal(fs.files.has(LOCK), true, "kunci harus ada di " + LOCK);

  const onDisk = readLock(LOCK, fs);
  assert.equal(onDisk.pid, 4242);
  assert.equal(onDisk.script, "index.js");
});

// --- 2. normal stop -> child mati -> kunci hilang ---------------------------

test("normal stop: child TERBUKTI mati -> kunci DIHAPUS", () => {
  // Inilah temuan 2026-10-09. Bot tidak sempat melepas kuncinya karena
  // TerminateProcess, jadi induk yang melakukannya.
  const fs = fakeFs({ [LOCK]: lockBody(38576) });

  const r = releaseLockFor({ file: LOCK, pid: 38576, fs, isAlive: () => false });

  assert.equal(r.ok, true);
  assert.equal(r.code, "removed");
  assert.equal(r.pid, 38576);
  assert.equal(fs.files.has(LOCK), false, "kunci harus hilang sesudah stop bersih");
});

test("normal stop saat kunci sudah tidak ada: bukan kegagalan", () => {
  // Bot yang SEMPAT melepas kuncinya sendiri (mis. di platform yang mengantar
  // sinyal) tidak boleh membuat Stop melaporkan masalah.
  const fs = fakeFs();
  const r = releaseLockFor({ file: LOCK, pid: 38576, fs, isAlive: () => false });
  assert.equal(r.ok, true);
  assert.equal(r.code, "no-lock");
  assert.deepEqual(fs.unlinks, [], "tidak ada yang perlu dihapus");
});

// --- 3. crash -> kunci basi bisa dibersihkan / di-takeover ------------------

test("crash: kunci basi DIBERSIHKAN induk", () => {
  const fs = fakeFs({ [LOCK]: lockBody(999) });
  const r = releaseLockFor({ file: LOCK, pid: 999, fs, isAlive: () => false });
  assert.equal(r.code, "removed");
  assert.equal(fs.files.has(LOCK), false);
});

test("crash: kunci basi yang TIDAK dibersihkan tetap bisa di-TAKEOVER", () => {
  // Jalur fallback: kalau induknya sendiri mati sebelum sempat membersihkan,
  // bot berikutnya masih boleh mengambil alih kunci yang pid-nya sudah mati.
  // Perilaku ini TIDAK berubah.
  const fs = fakeFs({ [LOCK]: lockBody(999) });
  const lines = [];
  const lock = createInstanceLock({
    file: LOCK,
    fs,
    pid: 1000,
    isAlive: () => false,
    logger: { log: (l) => lines.push(l) },
  });

  const r = lock.acquire();
  assert.equal(r.ok, true);
  assert.equal(r.mode, "stale-taken-over");
  assert.equal(readLock(LOCK, fs).pid, 1000, "pemilik baru tercatat");
  assert.ok(lines.some((l) => l.includes("SINGLE_INSTANCE_STALE_TAKEOVER")), lines.join("\n"));
});

// --- 4. pid hidup yang sah TIDAK boleh dibersihkan sembarangan -------------

test("pid yang MASIH HIDUP tidak pernah dibersihkan", () => {
  // Menghapus kunci milik bot yang masih berjalan akan mengizinkan bot kedua
  // menyala di sampingnya — insiden 2026-10-05.
  const fs = fakeFs({ [LOCK]: lockBody(38576) });

  const r = releaseLockFor({ file: LOCK, pid: 38576, fs, isAlive: () => true });

  assert.equal(r.ok, false);
  assert.equal(r.code, "still-alive");
  assert.equal(fs.files.has(LOCK), true, "kunci harus TETAP ada");
  assert.deepEqual(fs.unlinks, [], "unlink tidak boleh pernah dicoba");
});

test("kunci milik pid LAIN tidak pernah disentuh", () => {
  // Induk hanya berwenang atas kuncinya sendiri. Kunci bot lain — hidup atau
  // mati — bukan urusannya.
  const fs = fakeFs({ [LOCK]: lockBody(1234) });

  for (const alive of [true, false]) {
    const r = releaseLockFor({ file: LOCK, pid: 38576, fs, isAlive: () => alive });
    assert.equal(r.ok, true);
    assert.equal(r.code, "not-ours");
    assert.equal(r.pid, 1234);
  }
  assert.equal(fs.files.has(LOCK), true);
  assert.deepEqual(fs.unlinks, [], "unlink tidak boleh pernah dicoba");
});

test("tanpa file atau tanpa pid: tidak melakukan apa pun", () => {
  const fs = fakeFs({ [LOCK]: lockBody(1) });
  assert.equal(releaseLockFor({ pid: 1, fs }).code, "no-file");
  assert.equal(releaseLockFor({ file: LOCK, fs }).code, "no-pid");
  assert.equal(releaseLockFor({ file: LOCK, pid: 0, fs }).code, "no-pid");
  assert.equal(releaseLockFor({ file: LOCK, pid: -5, fs }).code, "no-pid");
  assert.equal(fs.files.has(LOCK), true);
  assert.deepEqual(fs.unlinks, []);
});

// --- 5. pid reuse Windows TIDAK menyebabkan penolakan yang salah -----------

test("REGRESI: pid yang dipakai ulang Windows tidak membuat start ditolak", () => {
  // Keadaannya: kunci basi berisi pid 38576. Bot sudah lama mati, tapi Windows
  // memakai ulang pid itu untuk proses lain yang TIDAK ADA hubungannya — jadi
  // process.kill(pid, 0) menjawab "hidup".
  //
  // Dengan hanya pid, tidak ada cara membedakan "bot kita masih hidup" dari
  // "pid-nya dipakai proses lain". Jadi buktinya datang dari LUAR: penyapu yatim
  // menghitung proses node.exe yang command line-nya memuat index.js. Nol bot
  // berarti kunci yang tersisa tidak mungkin milik bot yang hidup.
  const fs = fakeFs({ [LOCK]: lockBody(38576) });

  // Jalur per-pid menolak bertindak, dan itu BENAR: ia tidak bisa membuktikan apa pun.
  const perPid = releaseLockFor({ file: LOCK, pid: 38576, fs, isAlive: () => true });
  assert.equal(perPid.code, "still-alive");
  assert.equal(fs.files.has(LOCK), true);

  // Bukti dari penyapu: NOL bot hidup.
  const cleared = clearLockIfNoBot({ file: LOCK, fs, botAlive: false });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.code, "removed");
  assert.equal(cleared.pid, 38576);
  assert.equal(fs.files.has(LOCK), false, "kunci basi harus hilang supaya start tidak ditolak salah");
});

test("FAIL-CLOSED: tanpa bukti, clearLockIfNoBot tidak menghapus apa pun", () => {
  // null/undefined/true semuanya berarti "belum terbukti". Hanya `false` yang
  // berarti "terbukti tidak ada bot hidup".
  for (const botAlive of [undefined, null, true]) {
    const fs = fakeFs({ [LOCK]: lockBody(38576) });
    const r = clearLockIfNoBot({ file: LOCK, fs, botAlive });
    assert.equal(r.code, "unproven", "botAlive=" + String(botAlive));
    assert.equal(fs.files.has(LOCK), true);
    assert.deepEqual(fs.unlinks, []);
  }
});

test("clearLockIfNoBot tanpa kunci: bukan kegagalan", () => {
  const fs = fakeFs();
  const r = clearLockIfNoBot({ file: LOCK, fs, botAlive: false });
  assert.equal(r.ok, true);
  assert.equal(r.code, "no-lock");
});

// --- yang TIDAK boleh berubah: acquire() tetap fail-closed -----------------

test("acquire() TETAP menolak saat pemilik kunci masih hidup", () => {
  // Perlindungan Phase-21. Pembersihan oleh induk TIDAK boleh melonggarkan ini.
  const fs = fakeFs({ [LOCK]: lockBody(38576) });
  const lines = [];
  const r = createInstanceLock({
    file: LOCK,
    fs,
    pid: 777,
    isAlive: () => true,
    logger: { log: (l) => lines.push(l) },
  }).acquire();

  assert.equal(r.ok, false);
  assert.equal(r.reason, "already-running");
  assert.equal(r.pid, 38576);
  assert.ok(lines.some((l) => l.includes("SINGLE_INSTANCE_REFUSED")), lines.join("\n"));
  // Dan jalan keluarnya tetap disebutkan ke operator.
  assert.ok(lines.some((l) => l.includes("stop-all.ps1")), "operator diberi jalan keluar konkret");
});

test("nama berkas kunci tidak berubah (dipakai scripts/stop-all.ps1)", () => {
  assert.equal(LOCK_FILENAME, ".bot.lock");
});

test("kunci ber-BOM tetap terbaca oleh pembaca BERSAMA", () => {
  // readLock dipakai bot DAN induk. Kalau BOM membuatnya mengembalikan null,
  // induk akan menganggap tidak ada kunci dan bot kedua bisa ikut menyala —
  // kebalikan dari gunanya kunci ini.
  const fs = fakeFs({ [LOCK]: "﻿" + lockBody(4) });
  assert.equal(readLock(LOCK, fs).pid, 4);

  // Dan induk tetap mengenali kepemilikannya.
  const r = releaseLockFor({ file: LOCK, pid: 4, fs, isAlive: () => false });
  assert.equal(r.code, "removed");
});

test("kunci yang rusak diperlakukan sebagai tidak ada, dan tidak dihapus per-pid", () => {
  const fs = fakeFs({ [LOCK]: "{ bukan json" });
  assert.equal(readLock(LOCK, fs), null);

  // Per-pid: tidak ada pemilik yang bisa dibuktikan, jadi tidak ada yang dihapus.
  assert.equal(releaseLockFor({ file: LOCK, pid: 1, fs, isAlive: () => false }).code, "no-lock");
  assert.deepEqual(fs.unlinks, []);

  // Dengan bukti dari penyapu, berkas rusak itu pun tidak dihapus: readLock
  // mengembalikan null, jadi tidak ada kunci yang perlu dibersihkan. Berkasnya
  // tetap ada, dan acquire() akan menimpanya sebagai "fresh".
  assert.equal(clearLockIfNoBot({ file: LOCK, fs, botAlive: false }).code, "no-lock");
  assert.equal(fs.files.has(LOCK), true);
});

test("unlink yang gagal dilaporkan, bukan disembunyikan", () => {
  const fs = fakeFs({ [LOCK]: lockBody(5) });
  fs.unlinkSync = () => {
    throw new Error("EACCES");
  };
  const r = releaseLockFor({ file: LOCK, pid: 5, fs, isAlive: () => false });
  assert.equal(r.ok, false);
  assert.equal(r.code, "unlink-failed");
});

// ---------------------------------------------------------------------------
// INTEGRASI CONTROLLER: siapa yang benar-benar membersihkan, dan kapan
// ---------------------------------------------------------------------------

const {
  createClock,
  createFakeFs,
  createFakeWorld,
  goodConfig,
  passingPreflightDeps,
  sayBotConnected,
  CONFIG_PATH,
} = require("./helpers/controller-harness");

const USERDATA_LOCK = "/fake/userData/.bot.lock";

// Controller dengan `paths.lockFile` terisi — yaitu mode aplikasi terpasang.
// `paths: null` berarti jalur manual, dan Controller tidak tahu di mana kunci
// bot berada.
function makeController({ managed = true, seedLock = null } = {}) {
  const clock = createClock();
  const world = createFakeWorld({
    onSpawn: (child) => {
      if (!child.script.includes("index.js")) return;
      setImmediate(() => {
        if (world.alive.has(child.pid)) sayBotConnected(child);
      });
    },
  });
  const seed = { [CONFIG_PATH]: JSON.stringify(goodConfig(), null, 2) };
  if (seedLock !== null) seed[USERDATA_LOCK] = seedLock;
  const fs = createFakeFs(seed);
  const logs = [];

  const { createController } = require("../controller/controller");
  const controller = createController({
    cwd: "/fake",
    configFile: CONFIG_PATH,
    fs,
    spawn: world.spawn,
    nodePath: "/fake/node",
    pidAlive: world.pidAlive,
    now: clock.now,
    sleep: clock.sleep,
    logger: { log: (l) => logs.push(l) },
    stopGraceMs: 20,
    preflightDeps: passingPreflightDeps(),
    fetchHealth: async () => ({ ok: true, body: { ok: true } }),
    timeouts: { serviceHealthMs: 5000, botReadyMs: 5000, healthPollMs: 100 },
    orphanSweeper: async () => ({ count: 0, killed: 0, remaining: 0 }),
    killAutomationChrome: async () => ({ killed: 0 }),
    runtimeDir: "/fake/data/.runtime",
    paths: managed ? { lockFile: USERDATA_LOCK } : null,
  });
  return { controller, world, fs, logs, clock };
}

test("Controller meneruskan letak kunci ke bot lewat environment", async () => {
  // Bot-lah yang membuat kuncinya, dan ia hanya tahu letaknya dari sini.
  const h = makeController();
  const r = await h.controller.startAutomation();
  assert.equal(r.ok, true, JSON.stringify(r.error || {}));

  const botSpawn = h.world.spawned.find((s) => s.script.includes("index.js"));
  assert.ok(botSpawn, "bot harus di-spawn");
  assert.equal(botSpawn.spawnEnv[LOCK_FILE_ENV], USERDATA_LOCK, "bot harus diberi letak kuncinya");
  await h.controller.stopAutomation();
});

test("normal stop: Controller MENGHAPUS kunci milik bot yang baru dimatikan", async () => {
  const h = makeController();
  const r = await h.controller.startAutomation();
  assert.equal(r.ok, true, JSON.stringify(r.error || {}));

  // Bot sungguhan menulis kuncinya dengan pid-nya sendiri. Ditirukan di sini,
  // dengan pid yang BENAR-BENAR dipakai child palsu.
  const botPid = h.controller.processes.getProcessState().bot.pid;
  assert.ok(botPid > 0);
  h.fs.writeFileSync(USERDATA_LOCK, lockBody(botPid));
  assert.equal(h.fs.files.has(USERDATA_LOCK), true);

  const stopped = await h.controller.stopAutomation();
  assert.equal(stopped.ok, true, JSON.stringify(stopped.error || {}));

  assert.equal(h.fs.files.has(USERDATA_LOCK), false, "kunci harus hilang sesudah stop bersih");
  assert.ok(
    h.logs.some((l) => l.includes("[CONTROLLER_BOT_LOCK]") && l.includes("result=removed") && l.includes("reason=stopped")),
    h.logs.filter((l) => l.includes("BOT_LOCK")).join("\n") || "(tidak ada baris BOT_LOCK)"
  );
});

test("crash bot: Controller membersihkan kunci yang ditinggalkan", async () => {
  const h = makeController();
  const r = await h.controller.startAutomation();
  assert.equal(r.ok, true, JSON.stringify(r.error || {}));

  const botPid = h.controller.processes.getProcessState().bot.pid;
  h.fs.writeFileSync(USERDATA_LOCK, lockBody(botPid));

  // Bot mati sendiri. Di jalur ini bot paling pasti tidak sempat melepas kunci.
  h.world.byScript("index.js")[0].exit(1, null);

  assert.equal(h.fs.files.has(USERDATA_LOCK), false, "kunci harus dibersihkan sesudah crash");
  assert.ok(
    h.logs.some((l) => l.includes("[CONTROLLER_BOT_LOCK]") && l.includes("reason=bot-crashed")),
    h.logs.filter((l) => l.includes("BOT_LOCK")).join("\n") || "(tidak ada baris BOT_LOCK)"
  );
  await h.controller.stopAutomation();
});

test("start: kunci BASI dibersihkan sesudah penyapu membuktikan nol bot", async () => {
  // Kunci dari sesi SEBELUMNYA, pid-nya tidak dikenal world palsu (= mati).
  // Penyapu melaporkan remaining=0, jadi kunci itu terbukti bukan milik bot
  // yang hidup.
  const h = makeController({ seedLock: lockBody(999999) });
  assert.equal(h.fs.files.has(USERDATA_LOCK), true);

  const r = await h.controller.startAutomation();
  assert.equal(r.ok, true, JSON.stringify(r.error || {}));

  assert.ok(
    h.logs.some((l) => l.includes("[CONTROLLER_BOT_LOCK]") && l.includes("reason=stale-before-start")),
    h.logs.filter((l) => l.includes("BOT_LOCK")).join("\n") || "(tidak ada baris BOT_LOCK)"
  );
  await h.controller.stopAutomation();
});

test("jalur MANUAL: Controller tidak menyentuh kunci apa pun", async () => {
  // `node controller/index.js` tanpa aplikasi desktop: paths kosong, jadi
  // Controller tidak tahu di mana bot menaruh kuncinya dan tidak boleh menebak.
  const h = makeController({ managed: false, seedLock: lockBody(999999) });

  const r = await h.controller.startAutomation();
  assert.equal(r.ok, true, JSON.stringify(r.error || {}));
  const botPid = h.controller.processes.getProcessState().bot.pid;
  h.fs.writeFileSync(USERDATA_LOCK, lockBody(botPid));

  await h.controller.stopAutomation();

  assert.equal(h.fs.files.has(USERDATA_LOCK), true, "jalur manual: kunci TIDAK disentuh");
  // Dan Controller tidak mengaku melakukan apa pun terhadapnya. Ia keluar
  // sebelum mencatat: menerbitkan baris "not-managed" di setiap Stop hanya
  // menambah kebisingan pada jalur yang memang bukan urusannya.
  const claims = h.logs.filter((l) => l.includes("[CONTROLLER_BOT_LOCK]"));
  assert.deepEqual(claims, [], "tidak boleh ada klaim pembersihan di jalur manual");
});

test("stop yang TIDAK bersih tidak menghapus kunci", async () => {
  // Kalau bot tidak terbukti mati, kuncinya tidak boleh dihapus: kunci yang
  // hilang sementara prosesnya hidup mengizinkan bot kedua menyala.
  const h = makeController();
  const r = await h.controller.startAutomation();
  assert.equal(r.ok, true, JSON.stringify(r.error || {}));

  const botPid = h.controller.processes.getProcessState().bot.pid;
  h.fs.writeFileSync(USERDATA_LOCK, lockBody(botPid));

  // Child yang menolak mati: stopAll tidak bisa membuktikan kematiannya.
  h.world.byScript("index.js")[0].ignoreSignals = true;
  h.world.byScript("autopin-service.js")[0].ignoreSignals = true;
  const stopped = await h.controller.stopAutomation();
  assert.equal(stopped.ok, false, "stop harus melaporkan tidak bersih");
  assert.equal(h.fs.files.has(USERDATA_LOCK), true, "kunci TETAP ada selama kematian belum terbukti");
});
