// Keandalan startup desktop (P4.2). SEMUANYA OFFLINE, tanpa Electron sama sekali.
//
// ---------------------------------------------------------------------------
// KEJADIAN YANG MELAHIRKAN BERKAS INI
//
// 2026-10-08, launch desktop pertama yang sungguhan:
//
//   [DESKTOP_NODE_RESOLVED] from=PATH
//   [dotenv@17.2.3] injecting env (0) from .env
//   [DESKTOP_CONTROLLER_KILLED] reason=start-failed
//   [DESKTOP_CONTROLLER_NOT_READY] code=controller-start-timeout
//   [DESKTOP_CONTROLLER_START_FAILED] code=controller-start-timeout
//
// Launch kedua siap dalam 39ms. Tapi yang paling merusak bukan kegagalannya —
// melainkan bahwa aplikasi yang gagal itu TETAP HIDUP memegang kunci
// satu-instance, sehingga double-click berikutnya keluar diam-diam tanpa pesan
// apa pun. Dari sisi customer: "pertama gagal, kedua diam".
//
// Sebabnya satu baris di main.js:
//
//   dialog.showErrorBox(...)   // MODAL, memblokir sampai diklik
//   app.exit(1);               // tidak pernah tercapai
//
// Tidak ada jendela saat itu, jadi kotak dialognya tidak terlihat dan tidak ada
// yang bisa mengkliknya. Maka tes di bawah ini memeriksa satu hal di atas segala
// hal lain: KELUARNYA APLIKASI TIDAK BOLEH BERGANTUNG PADA DIALOG.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { createStartupFlow, createExitAnnouncer, STAGE, FAIL_MESSAGE } = require("../desktop/startup");

// --- dunia palsu -------------------------------------------------------------

// Jam + penjadwal virtual: batas waktu diuji tanpa benar-benar menunggu, dan
// hasilnya tidak tergantung beban mesin.
function fakeTimers() {
  let t = 1_700_000_000_000;
  const pending = new Map();
  let id = 0;
  return {
    now: () => t,
    setTimer: (fn, ms) => {
      id += 1;
      pending.set(id, { at: t + Math.max(0, Number(ms) || 0), fn });
      return id;
    },
    clearTimer: (h) => pending.delete(h),
    // Memajukan waktu dan menjalankan apa yang jatuh tempo.
    advance(ms) {
      t += ms;
      for (const [h, job] of [...pending.entries()]) {
        if (job.at <= t) {
          pending.delete(h);
          job.fn();
        }
      }
    },
    pendingCount: () => pending.size,
  };
}

function mk(over = {}) {
  const timers = fakeTimers();
  const calls = {
    resolveNode: 0,
    buildLifecycle: 0,
    start: 0,
    stop: 0,
    createWindow: 0,
    showFailure: 0,
    exits: [],
    logs: [],
  };

  // Dialog yang TIDAK PERNAH selesai. Inilah default-nya, dan itu disengaja:
  // kondisi default tes harus kondisi yang dulu mematahkan aplikasi.
  let resolveDialog = null;
  const dialogPromise = new Promise((r) => {
    resolveDialog = r;
  });

  const lifecycle = {
    start: async () => {
      calls.start += 1;
      return over.startResult !== undefined ? over.startResult : { ok: true, pid: 4242 };
    },
    stop: async () => {
      calls.stop += 1;
      return { ok: true };
    },
  };

  const deps = {
    resolveNode: () => {
      calls.resolveNode += 1;
      if (over.node) return over.node;
      return { ok: true, nodePath: "C:/Program Files/nodejs/node.exe", from: "PATH" };
    },
    buildLifecycle: (nodePath) => {
      calls.buildLifecycle += 1;
      calls.nodePathSeen = nodePath;
      if (over.buildLifecycleThrows) throw new Error("boom");
      return over.lifecycle === undefined ? lifecycle : over.lifecycle;
    },
    createWindow: () => {
      calls.createWindow += 1;
      if (over.windowThrows) throw new Error("no display");
    },
    showFailure: (arg) => {
      calls.showFailure += 1;
      calls.failureArg = arg;
      if (over.dialogThrows) throw new Error("dialog unavailable");
      if (over.dialogSync) return undefined;
      return dialogPromise;
    },
    exit: (code) => {
      calls.exits.push(code);
    },
    log: (tag, fields) => calls.logs.push({ tag, fields: fields || {} }),
    now: timers.now,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  };

  const flow = createStartupFlow(Object.assign(deps, over.deps || {}));
  return { flow, calls, timers, lifecycle, ackDialog: () => resolveDialog(), deps };
}

const tagsOf = (calls) => calls.logs.map((l) => l.tag);

// --- jalan normal ------------------------------------------------------------

test("Controller siap sebelum batas waktu -> aplikasi menyala dan jendela dibuat", async () => {
  const { flow, calls } = mk();
  const r = await flow.run();

  assert.equal(r.ok, true);
  assert.equal(r.pid, 4242);
  assert.equal(flow.stage(), STAGE.READY);
  assert.equal(calls.createWindow, 1);
  // Tidak ada dialog, dan TIDAK ADA exit: aplikasi yang sehat harus tetap hidup.
  assert.equal(calls.showFailure, 0);
  assert.deepEqual(calls.exits, []);
  assert.equal(flow.exited(), false);
});

test("Node dicari SEBELUM Controller dinyalakan", async () => {
  // Controller yang berjalan tanpa bisa menyalakan bot-nya adalah aplikasi yang
  // terlihat sehat sampai customer menekan START BOT. Dulu jaminan ini diuji
  // dengan membandingkan urutan teks di main.js; sekarang ia perilaku.
  const { flow, calls } = mk({ node: { ok: false, reason: "node-not-found" } });
  const r = await flow.run();

  assert.equal(r.ok, false);
  assert.equal(r.code, "node-not-found");
  assert.equal(calls.resolveNode, 1);
  assert.equal(calls.buildLifecycle, 0, "lifecycle TIDAK boleh dibangun tanpa Node");
  assert.equal(calls.start, 0, "Controller TIDAK boleh dinyalakan tanpa Node");
  assert.equal(calls.createWindow, 0);
});

test("path Node yang ditemukan diteruskan ke lifecycle apa adanya", async () => {
  const { flow, calls } = mk();
  await flow.run();
  assert.equal(calls.nodePathSeen, "C:/Program Files/nodejs/node.exe");
});

// --- kegagalan: child mati sebelum siap --------------------------------------

test("child Controller mati sebelum siap -> startup gagal, jendela tidak pernah dibuat", async () => {
  const { flow, calls } = mk({ startResult: { ok: false, code: "controller-start-failed" } });
  const r = await flow.run();

  assert.equal(r.ok, false);
  assert.equal(r.code, "controller-start-failed");
  assert.equal(flow.stage(), STAGE.FAILED);
  assert.equal(calls.createWindow, 0, "jendela tanpa backend adalah aplikasi bohong");
});

test("timeout kesiapan diteruskan dengan kodenya sendiri, bukan diratakan", async () => {
  // Kode yang berbeda berarti penelusuran yang berbeda. Yang DISATUKAN hanya
  // kalimat untuk customer, bukan kode untuk kita.
  const { flow } = mk({ startResult: { ok: false, code: "controller-start-timeout" } });
  const r = await flow.run();
  assert.equal(r.code, "controller-start-timeout");
});

test("lifecycle.start() yang MELEMPAR tetap berakhir sebagai kegagalan startup", async () => {
  const { flow, calls, timers } = mk({
    lifecycle: {
      start: async () => {
        throw new Error("boom");
      },
      stop: async () => ({ ok: true }),
    },
  });
  const r = await flow.run();
  assert.equal(r.ok, false);
  assert.equal(calls.createWindow, 0);
  // Dialognya di sini tidak pernah diklik, jadi yang membuktikan keluarnya adalah
  // jaring waktu. Itu memang jaminan yang lebih kuat: exception sekalipun tidak
  // bisa meninggalkan aplikasi menggantung memegang kunci.
  assert.deepEqual(calls.exits, []);
  timers.advance(15000);
  assert.deepEqual(calls.exits, [1]);
});

test("buildLifecycle yang MELEMPAR tidak meninggalkan aplikasi menggantung", async () => {
  const { flow, calls, timers } = mk({ buildLifecycleThrows: true });
  const r = await flow.run();
  assert.equal(r.code, "lifecycle-build-failed");
  assert.equal(calls.start, 0, "Controller tidak pernah dinyalakan");
  timers.advance(15000);
  assert.deepEqual(calls.exits, [1]);
});

// --- INTI P4.2: keluar tidak bergantung pada dialog --------------------------

test("REGRESI P4.2: startup gagal -> aplikasi KELUAR walau dialog TIDAK PERNAH diklik", () => {
  // Inilah kegagalan 2026-10-08 yang sesungguhnya. Dialog di sini sengaja dibuat
  // tidak pernah selesai, persis seperti kotak modal yang tidak terlihat dan
  // tidak bisa ditekan siapa pun.
  const { flow, calls, timers } = mk({ startResult: { ok: false, code: "controller-start-timeout" } });

  return flow.run().then((r) => {
    assert.equal(r.ok, false);
    assert.equal(calls.showFailure, 1, "customer tetap diberi tahu");
    // Belum keluar: jaringnya belum jatuh tempo, dan dialognya belum diklik.
    assert.deepEqual(calls.exits, [], "jangan keluar sebelum ada kesempatan membaca");

    timers.advance(15000);

    assert.deepEqual(calls.exits, [1], "WAJIB keluar walau tidak ada yang mengklik");
    assert.equal(flow.exited(), true);
    const exitLog = calls.logs.find((l) => l.tag === "EXIT");
    assert.equal(exitLog.fields.via, "timeout");
  });
});

test("REGRESI P4.2: dialog yang DIKLIK membuat aplikasi keluar segera", async () => {
  const h = mk({ startResult: { ok: false, code: "controller-start-timeout" } });
  await h.flow.run();
  assert.deepEqual(h.calls.exits, []);

  h.ackDialog();
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(h.calls.exits, [1], "menutup dialog harus mengakhiri aplikasi");
  const exitLog = h.calls.logs.find((l) => l.tag === "EXIT");
  assert.equal(exitLog.fields.via, "acknowledged");
  // Jaringnya dicabut, bukan dibiarkan menyala dan memanggil exit kedua.
  assert.equal(h.timers.pendingCount(), 0);
});

test("REGRESI P4.2: dialog yang MELEMPAR tetap membuat aplikasi keluar", async () => {
  const { flow, calls } = mk({
    startResult: { ok: false, code: "controller-start-timeout" },
    dialogThrows: true,
  });
  await flow.run();
  assert.deepEqual(calls.exits, [1]);
  assert.equal(calls.logs.find((l) => l.tag === "EXIT").fields.via, "dialog-failed");
});

test("REGRESI P4.2: dialog sinkron (tanpa Promise) juga berakhir keluar", async () => {
  const { flow, calls } = mk({
    startResult: { ok: false, code: "controller-start-timeout" },
    dialogSync: true,
  });
  await flow.run();
  assert.deepEqual(calls.exits, [1]);
});

test("REGRESI P4.2: exit dipanggil TEPAT SEKALI, walau dialog dan batas waktu berbarengan", async () => {
  // Dua exit berarti dua kode keluar, dan yang kedua bisa menimpa yang pertama.
  const h = mk({ startResult: { ok: false, code: "controller-start-timeout" } });
  await h.flow.run();

  h.ackDialog();
  await Promise.resolve();
  await Promise.resolve();
  h.timers.advance(60000);

  assert.deepEqual(h.calls.exits, [1], "tidak boleh ada exit kedua");
});

test("kalimat untuk customer adalah kalimat P4.2, dan tidak memuat kode mesin", async () => {
  const { flow, calls } = mk({ startResult: { ok: false, code: "controller-start-timeout" } });
  await flow.run();

  assert.equal(calls.failureArg.message, FAIL_MESSAGE);
  assert.equal(FAIL_MESSAGE, "AI LIVE HOST could not start. Please try opening the app again.");
  const shown = calls.failureArg.title + " " + calls.failureArg.message;
  for (const code of ["controller-start-timeout", "node-not-found", "ECONN", "4782", "undefined"]) {
    assert.ok(!shown.includes(code), "kalimat customer tidak boleh memuat " + code);
  }
});

test("kalimatnya SAMA untuk sebab yang berbeda; yang berbeda hanya log", async () => {
  // Customer tidak bisa berbuat apa pun yang berbeda, jadi membedakan kalimatnya
  // hanya menambah kebingungan. Kodenya tetap ada di log.
  const a = mk({ node: { ok: false, reason: "node-not-found" } });
  await a.flow.run();
  const b = mk({ startResult: { ok: false, code: "controller-start-timeout" } });
  await b.flow.run();

  assert.equal(a.calls.failureArg.message, b.calls.failureArg.message);
  assert.ok(tagsOf(a.calls).includes("NODE_NOT_FOUND"));
  const aFail = a.calls.logs.find((l) => l.tag === "STARTUP_FAILED");
  const bFail = b.calls.logs.find((l) => l.tag === "STARTUP_FAILED");
  assert.equal(aFail.fields.code, "node-not-found");
  assert.equal(bFail.fields.code, "controller-start-timeout");
});

// --- kunci satu-instance -----------------------------------------------------

test("REGRESI P4.2: startup gagal -> kunci satu-instance TERLEPAS, launch berikutnya diterima", () => {
  // Kunci satu-instance Electron terikat pada hidupnya PROSES. Satu-satunya cara
  // melepasnya adalah keluar. Jadi "kunci terlepas" diuji sebagai: proses keluar.
  //
  // Kunci aslinya milik Electron (app.requestSingleInstanceLock) dan TIDAK diganti
  // berkas kunci buatan sendiri; yang ditiru di sini hanya pemiliknya.
  const lock = { heldBy: null };
  const tryAcquire = (who) => {
    if (lock.heldBy !== null) return false;
    lock.heldBy = who;
    return true;
  };

  assert.equal(tryAcquire("A"), true);
  assert.equal(tryAcquire("B"), false, "selama A hidup, B harus ditolak");

  const a = mk({ startResult: { ok: false, code: "controller-start-timeout" } });
  // Keluarnya A melepas kuncinya, persis seperti proses Electron yang mati.
  a.deps.exit = () => {
    lock.heldBy = null;
  };
  const flowA = createStartupFlow(a.deps);

  return flowA.run().then(() => {
    a.timers.advance(15000);
    assert.equal(lock.heldBy, null, "kunci WAJIB terlepas sesudah startup gagal");
    assert.equal(tryAcquire("B"), true, "launch kedua harus diterima tanpa Task Manager");
  });
});

test("startup yang BERHASIL tetap memegang kuncinya", async () => {
  const { flow, calls } = mk();
  await flow.run();
  assert.deepEqual(calls.exits, [], "aplikasi sehat tidak boleh melepas kunci");
});

// --- tidak ada child tertinggal ----------------------------------------------

test("startup gagal TIDAK meninggalkan child yang dilacak", async () => {
  // Pembuktian kematian child dilakukan lifecycle.stop()/killController, dan
  // diuji di test/desktop.lifecycle.test.js. Yang diperiksa di sini: startup
  // tidak membuat jalur kedua yang melewati pembereskan itu.
  const { flow, calls } = mk({ startResult: { ok: false, code: "controller-start-timeout" } });
  await flow.run();
  assert.equal(calls.createWindow, 0);
  // Tidak memanggil stop() dua kali di atas kegagalan yang sudah dibereskan
  // lifecycle.start() sendiri.
  assert.equal(calls.stop, 0);
});

test("jendela yang gagal dibuat MENGHENTIKAN Controller, bukan meninggalkannya yatim", async () => {
  const { flow, calls } = mk({ windowThrows: true });
  const r = await flow.run();

  assert.equal(r.ok, false);
  assert.equal(r.code, "window-failed");
  assert.equal(calls.stop, 1, "Controller tanpa jendela harus dihentikan");
  assert.deepEqual(calls.exits, [], "belum: dialog baru saja ditampilkan");
});

// --- polling berhenti --------------------------------------------------------

test("run() tidak bisa dijalankan dua kali: Controller kedua tidak boleh lahir", async () => {
  const { flow, calls } = mk();
  const a = await flow.run();
  const b = await flow.run();

  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  assert.equal(b.code, "startup-already-run");
  assert.equal(calls.start, 1, "lifecycle.start() hanya sekali");
  assert.equal(calls.createWindow, 1);
});

test("tidak ada timer yang tertinggal sesudah startup BERHASIL", async () => {
  const { flow, timers } = mk();
  await flow.run();
  assert.equal(timers.pendingCount(), 0, "jalur sukses tidak memasang timer apa pun");
});

test("dep yang kurang ditolak, bukan dijalankan separuh", async () => {
  const flow = createStartupFlow({ resolveNode: () => ({ ok: true, nodePath: "x" }) });
  const r = await flow.run();
  assert.equal(r.code, "startup-not-configured");
});

// --- announcer dipakai bersama ----------------------------------------------

test("createExitAnnouncer dipakai BERSAMA jalur penutupan, bukan disalin", () => {
  // Menyalin mekanisme keluar ke dua tempat berarti salah satunya akan menyimpang,
  // dan yang menyimpang adalah yang jarang dijalankan — jalur kegagalan.
  const MAIN = fs.readFileSync(path.resolve(__dirname, "..", "desktop", "main.js"), "utf8");
  assert.match(MAIN, /createExitAnnouncer/);

  const timers = fakeTimers();
  const exits = [];
  const ann = createExitAnnouncer({
    showFailure: () => new Promise(() => {}),
    exit: (c) => exits.push(c),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  ann.announceThenExit(1, { title: "t", message: "m" });
  assert.deepEqual(exits, []);
  timers.advance(15000);
  assert.deepEqual(exits, [1]);
});

// --- instrumentasi tahap -----------------------------------------------------

test("tonggak startup punya milidetik, dan TIDAK memuat rahasia apa pun", async () => {
  const { flow, calls } = mk();
  await flow.run();

  const start = calls.logs.find((l) => l.tag === "START");
  const ready = calls.logs.find((l) => l.tag === "CONTROLLER_READY");
  assert.ok(start, "harus ada tonggak awal");
  assert.equal(typeof ready.fields.ms, "number");

  // Tidak ada path, tidak ada password, tidak ada isi config di tonggak mana pun.
  const dump = JSON.stringify(calls.logs);
  assert.ok(!/node\.exe/.test(dump), "path Node tidak boleh ikut dicatat");
  assert.ok(!/autopin-profile/.test(dump));
  assert.ok(!/password/i.test(dump));
  assert.ok(!/[A-Za-z]:[\\/]/.test(dump), "tidak boleh ada path absolut");
});

test("tahap boot Controller dicatat dengan ms, dan isinya hanya nama tahap", () => {
  // Kontrak dengan controller/index.js: satu baris per tonggak, hanya nama dan
  // angka. Kalau cold start melambat lagi, baris inilah yang menjawab "di mana".
  const src = fs.readFileSync(path.resolve(__dirname, "..", "controller", "index.js"), "utf8");
  assert.match(src, /\[CONTROLLER_BOOT\] stage=/);
  assert.match(src, /process\.uptime\(\)/, "harus diukur dari awal proses");

  const stages = [...src.matchAll(/bootStage\("([a-z-]+)"\)/g)].map((m) => m[1]);
  for (const want of ["modules-loaded", "deps-resolved", "controller-created", "server-created", "listen-begin"]) {
    assert.ok(stages.includes(want), "tahap hilang: " + want);
  }
  // Baris CONTROLLER_LISTENING ikut membawa ms-nya.
  assert.match(src, /CONTROLLER_LISTENING\] host=.*ms=/);
});
