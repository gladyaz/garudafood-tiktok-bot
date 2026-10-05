// Instrumentasi durasi per tahap AutoComment.
//
// Dibuat sesudah retry Phase 21 (2026-10-05). Klik Publish gagal dengan
// `stage=click detail=deadline-exceeded:click`, dan label itu tidak cukup untuk
// memutuskan apa pun: ia tidak membedakan "kliknya lambat" dari "mengetik 33
// karakter sudah menghabiskan hampir seluruh anggaran sebelum klik dimulai".
//
// Karena instrumentasi ini duduk di jalur yang BISA memposting ke penonton,
// bebannya ada pada instrumentasi itu sendiri untuk membuktikan ia tidak
// mengubah apa pun: jumlah ketik, jumlah klik, jumlah percobaan, urutan
// interaksi halaman, dan isolasi kegagalan harus persis seperti sebelumnya.
//
// Semua memakai halaman palsu dan jam palsu: tidak ada browser, Puppeteer,
// TikTok, OBS, HTTP, maupun penungguan waktu nyata.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createStepTimer, STEP_ORDER } = require("../autocomment/step-timer");
const { createBrowserSender } = require("../autocomment/browser-sender");
const { planTimeouts } = require("../autocomment/timeouts");
const { checkIdentity } = require("../autopin/core");

const SHOP = "agen_mulia_abadi";
const CONFIG = { expectedShop: SHOP, forbiddenShops: ["garudafood"] };
const TEXT = "Etalase 1 sudah aku pin ya kak \u{1F6D2}";
const TIMEOUT_ERR = "deadline-exceeded:click";

// ===================== pengukur sebagai unit =====================

function tickClock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test("timer: tahap sukses terukur", async () => {
  const c = tickClock();
  const timer = createStepTimer({ now: c.now });
  const v = await timer.step("type", async () => {
    c.advance(900);
    return "hasil";
  });

  assert.equal(v, "hasil", "nilai kembalian tidak boleh diubah");
  assert.deepEqual(timer.steps(), [{ name: "type", ms: 900, runs: 1, failed: false }]);
  assert.equal(timer.total(), 900);
});

test("timer: tahap yang GAGAL tetap terukur, dan error-nya naik APA ADANYA", async () => {
  const c = tickClock();
  const timer = createStepTimer({ now: c.now });
  const sentinel = new Error("Node is detached");

  await assert.rejects(
    timer.step("click", async () => {
      c.advance(700);
      throw sentinel;
    }),
    (err) => {
      // Identitas objeknya, bukan cuma pesannya: instrumentasi tidak boleh
      // membungkus, mengganti, atau menelan error.
      assert.equal(err, sentinel);
      return true;
    }
  );

  assert.deepEqual(timer.steps(), [{ name: "click", ms: 700, runs: 1, failed: true }]);
});

test("timer: versi sinkron tidak menyisipkan microtask dan juga melepas error", () => {
  const c = tickClock();
  const timer = createStepTimer({ now: c.now });

  assert.equal(timer.sync("stale", () => false), false);
  const sentinel = new Error("rusak");
  assert.throws(() => timer.sync("stale", () => { throw sentinel; }), (e) => e === sentinel);
  assert.equal(timer.steps()[0].runs, 2, "dua kali jalan diakumulasi");
  assert.equal(timer.steps()[0].failed, true);
});

test("timer: nama yang terulang diakumulasi, bukan saling menimpa", async () => {
  const c = tickClock();
  const timer = createStepTimer({ now: c.now });
  for (const ms of [40, 60, 100]) {
    await timer.step("cleanup", async () => c.advance(ms));
  }
  assert.deepEqual(timer.steps(), [{ name: "cleanup", ms: 200, runs: 3, failed: false }]);
  assert.ok(timer.describe().includes("cleanup=200x3"), timer.describe());
});

test("timer: urutan laporan mengikuti urutan jalannya permintaan, bukan urutan pencatatan", async () => {
  const c = tickClock();
  const timer = createStepTimer({ now: c.now });
  // Dicatat terbalik...
  for (const name of ["click", "type", "getPage"]) {
    await timer.step(name, async () => c.advance(1));
  }
  // ...tapi dilaporkan sesuai alur.
  assert.deepEqual(timer.steps().map((s) => s.name), ["getPage", "type", "click"]);
});

test("timer: tahap tak terdaftar tetap dilaporkan, di belakang", async () => {
  const c = tickClock();
  const timer = createStepTimer({ now: c.now });
  await timer.step("sesuatu-baru", async () => c.advance(5));
  await timer.step("type", async () => c.advance(5));
  assert.deepEqual(timer.steps().map((s) => s.name), ["type", "sesuatu-baru"]);
});

test("timer: tanpa tahap apa pun -> any() false, tidak ada baris log yang perlu dicetak", () => {
  assert.equal(createStepTimer({ now: () => 0 }).any(), false);
});

test("timer: tahap yang gagal ditandai jelas di baris log", async () => {
  const c = tickClock();
  const timer = createStepTimer({ now: c.now });
  await timer.step("type", async () => c.advance(10));
  await timer.step("click", async () => { c.advance(700); throw new Error("x"); }).catch(() => {});
  const d = timer.describe();
  assert.ok(d.includes("type=10 "), d);
  assert.ok(d.includes("click=700!"), "tahap gagal diberi tanda: " + d);
  assert.ok(d.startsWith("total=710ms"), d);
});

test("timer: STEP_ORDER memuat ketiga belas tahap yang diminta diukur", () => {
  for (const name of [
    "getPage", "identity", "inspect-before", "focus", "clear", "type", "verify",
    "inspect-after", "stale", "resolve-publish", "click", "after-click", "reconcile",
  ]) {
    assert.ok(STEP_ORDER.includes(name), "tahap hilang: " + name);
  }
});

// ===================== pengirim: perilaku tidak berubah =====================

// Halaman palsu yang MEMODELKAN keadaan, dan jamnya maju tiap interaksi supaya
// angka durasinya tidak semuanya nol.
function fakePage({
  resolveThrows = null,
  clickThrows = null,
  clickClears = true,
  publishStuck = null,
  hijackOnClick = null,
  tick = () => {},
} = {}) {
  const actions = [];
  let text = "";
  return {
    actions,
    text: () => text,
    isClosed: () => false,
    focus: async () => {
      actions.push(["focus"]);
      tick(10);
    },
    type: async (_sel, t) => {
      actions.push(["type", t]);
      tick(900);
      text = t;
    },
    keyboard: {
      down: async () => tick(5),
      up: async () => tick(5),
      press: async (k) => {
        actions.push(["press", k]);
        tick(20);
        if (k === "Backspace") text = "";
      },
    },
    evaluate: async (_fn, arg) => {
      const wantsText = typeof arg === "string";
      actions.push(["read", wantsText ? "text" : "composer"]);
      tick(40);
      if (wantsText) return text;
      return {
        foundTextarea: true,
        textareaVisible: true,
        textareaDisabled: false,
        foundPublishControl: true,
        publishVisible: true,
        publishDisabled: publishStuck === null ? text === "" : publishStuck,
        maxLength: 100,
      };
    },
    evaluateHandle: async () => {
      actions.push(["resolve-publish"]);
      tick(60);
      if (resolveThrows) throw new Error(resolveThrows);
      return {
        asElement: () => ({
          click: async () => {
            actions.push(["click"]);
            tick(700);
            if (clickClears) text = "";
            if (hijackOnClick !== null) text = hijackOnClick;
            if (clickThrows) throw new Error(clickThrows);
          },
        }),
        dispose: async () => {},
      };
    },
  };
}

const countOf = (p, name) => p.actions.filter((a) => a[0] === name).length;

function harness(pageOpts = {}, over = {}) {
  let t = 1_000;
  const tick = (ms) => {
    t += ms;
  };
  const lines = [];
  const p = fakePage({ ...pageOpts, tick });
  const sender = createBrowserSender({
    getPage: async () => {
      tick(15);
      return p;
    },
    allowed: true,
    config: CONFIG,
    readIdentity: async () => {
      tick(120);
      return [SHOP];
    },
    checkIdentity,
    isStale: () => false,
    // Lihat catatan di test/autocomment.ar3.test.js: suite ini mengukur tahap
    // pada halaman palsu yang mengklik dengan evaluateHandle.
    clickStrategy: "handle",
    timeouts: planTimeouts({ httpTimeoutMs: 8_000 }),
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    logger: { log: (l) => lines.push(l) },
    ...over,
  });
  return { p, sender, lines, timing: () => lines.filter((l) => l.includes("[AUTOCOMMENT_SEND_TIMING]")) };
}

// Kontrak yang dipaku: inilah jumlah dan alasan yang berlaku SEBELUM
// instrumentasi ditambahkan. Kalau satu pun berubah, instrumentasinya mengubah
// perilaku - dan itu yang tidak boleh terjadi.
const CONTRACT = [
  ["sukses", {}, { reason: "clicked", types: 1, clicks: 1 }],
  ["timeout sebelum klik", { resolveThrows: TIMEOUT_ERR }, { reason: "not-sent", types: 1, clicks: 0 }],
  ["timeout sesudah klik, komposer bersih", { clickClears: true, clickThrows: TIMEOUT_ERR }, { reason: "sent-reconciled", types: 1, clicks: 1 }],
  ["timeout sesudah klik, teks utuh", { clickClears: false, clickThrows: TIMEOUT_ERR }, { reason: "not-sent", types: 1, clicks: 1 }],
  ["publish tetap disabled", { publishStuck: true }, { reason: "publish-still-disabled", types: 1, clicks: 0 }],
  ["teks orang lain", { clickClears: false, clickThrows: TIMEOUT_ERR, hijackOnClick: "punya orang" }, { reason: "ambiguous", types: 1, clicks: 1 }],
  ["ambigu", { clickClears: true, clickThrows: TIMEOUT_ERR, publishStuck: false }, { reason: "ambiguous", types: 1, clicks: 1 }],
];

test("instrumentasi TIDAK mengubah alasan maupun jumlah ketik/klik di satu pun jalur", async () => {
  for (const [label, opts, want] of CONTRACT) {
    const { p, sender } = harness(opts);
    const r = await sender.send({ text: TEXT, scene: "PAX-1", playId: 1 });

    assert.equal(r.reason, want.reason, label);
    assert.equal(countOf(p, "type"), want.types, label + ": jumlah ketik");
    assert.equal(countOf(p, "click"), want.clicks, label + ": jumlah klik");
  }
});

test("instrumentasi TIDAK membuka percobaan kedua di satu pun jalur", async () => {
  for (const [label, opts] of CONTRACT) {
    const { p, sender } = harness(opts);
    await sender.send({ text: TEXT, scene: "PAX-1", playId: 9 });
    const again = await sender.send({ text: TEXT, scene: "PAX-1", playId: 9 });

    assert.equal(again.reason, "duplicate-play-id", label);
    assert.ok(countOf(p, "type") <= 1, label + ": tetap paling banyak satu ketik");
    assert.ok(countOf(p, "click") <= 1, label + ": tetap paling banyak satu klik");
  }
});

test("instrumentasi TIDAK menambah satu pun interaksi halaman: urutan aksi sukses persis", async () => {
  const { p, sender } = harness();
  await sender.send({ text: TEXT, scene: "PAX-1", playId: 1 });

  assert.deepEqual(p.actions, [
    ["read", "composer"],   // inspect-before
    ["focus"],
    ["press", "KeyA"],      // clear
    ["press", "Backspace"], // clear
    ["type", TEXT],
    ["read", "text"],       // verify
    ["read", "composer"],   // inspect-after
    ["resolve-publish"],
    ["click"],
    ["read", "text"],       // after-click
  ]);
});

// ===================== isolasi kegagalan =====================

test("isolasi kegagalan: error dari halaman naik APA ADANYA, tidak dibungkus timer", async () => {
  const sentinel = new Error("Execution context was destroyed");
  const { sender } = harness({}, {
    readIdentity: async () => {
      throw sentinel;
    },
  });

  await assert.rejects(
    sender.send({ text: TEXT, scene: "PAX-1", playId: 1 }),
    (err) => {
      assert.equal(err, sentinel, "objek error-nya harus sama persis");
      return true;
    }
  );
});

test("isolasi kegagalan: timing tetap tercetak walau permintaan MELEMPAR", async () => {
  const { sender, timing } = harness({}, {
    readIdentity: async () => {
      throw new Error("Execution context was destroyed");
    },
  });

  await sender.send({ text: TEXT, scene: "PAX-1", playId: 1 }).catch(() => {});

  assert.equal(timing().length, 1, "satu baris timing, bahkan pada error");
  const line = timing()[0];
  assert.ok(line.includes("getPage="), line);
  assert.ok(line.includes("identity=") && line.includes("!"), "tahap yang gagal ditandai: " + line);
});

test("isolasi kegagalan: kegagalan satu tahap tidak menyeret tahap lain", async () => {
  // Klik gagal, tapi tahap sebelumnya tetap terukur sebagai sukses dan
  // rekonsiliasi tetap berjalan sesudahnya.
  const { sender, timing } = harness({ clickClears: false, clickThrows: TIMEOUT_ERR });
  await sender.send({ text: TEXT, scene: "PAX-1", playId: 1 });

  const line = timing()[0];
  assert.ok(line.includes("click=700!"), "hanya klik yang ditandai gagal: " + line);
  assert.ok(line.includes("type=900 "), "ketik tetap sukses: " + line);
  assert.ok(line.includes("reconcile="), "rekonsiliasi tetap jalan: " + line);
  assert.ok(line.includes("cleanup="), "pembersihan tetap jalan: " + line);
  assert.equal((line.match(/!/g) || []).length, 1, "tepat satu tahap gagal: " + line);
});

// ===================== baris timing =====================

test("timing: satu baris per permintaan, memuat seluruh tahap jalur sukses", async () => {
  const { sender, timing } = harness();
  await sender.send({ text: TEXT, scene: "PAX-1", playId: 1 });

  assert.equal(timing().length, 1);
  const line = timing()[0];
  assert.ok(line.startsWith("[AUTOCOMMENT_SEND_TIMING] scene=PAX-1 playId=1 strategy="), line);
  assert.ok(/ strategy=(handle|dom|mouse) /.test(line), "strategi klik harus ikut dilaporkan: " + line);
  assert.ok(/ total=\d+ms /.test(line), line);
  for (const name of [
    "getPage", "identity", "inspect-before", "focus", "clear", "type",
    "verify", "inspect-after", "stale", "resolve-publish", "click", "after-click",
  ]) {
    assert.ok(line.includes(name + "="), "tahap hilang dari laporan: " + name + " | " + line);
  }
});

test("timing: tahap dilaporkan dalam urutan alur, supaya mudah dibaca dan di-grep", async () => {
  const { sender, timing } = harness();
  await sender.send({ text: TEXT, scene: "PAX-1", playId: 1 });

  const names = timing()[0]
    .split(" ")
    .filter((p) => p.includes("=") && !["total", "scene", "playId", "strategy"].includes(p.split("=")[0]))
    .map((p) => p.split("=")[0]);

  const expected = STEP_ORDER.filter((n) => names.includes(n));
  assert.deepEqual(names, expected, "urutan laporan harus mengikuti STEP_ORDER");
});

test("timing: total sama dengan jumlah tahap", async () => {
  const { sender, timing } = harness();
  await sender.send({ text: TEXT, scene: "PAX-1", playId: 1 });

  const line = timing()[0];
  const total = Number(/total=(\d+)ms/.exec(line)[1]);
  const sum = [...line.matchAll(/ ([a-zA-Z-]+)=(\d+)/g)]
    .filter((m) => !["total", "playId"].includes(m[1]))
    .reduce((a, m) => a + Number(m[2]), 0);
  assert.equal(total, sum, line);
});

test("timing: penolakan SEBELUM halaman disentuh tidak mencetak baris apa pun", async () => {
  // Tidak ada tahap yang jalan, jadi tidak ada yang perlu dilaporkan - log
  // tidak boleh jadi berisik karena penolakan murah.
  const notArmed = harness({}, { allowed: false });
  await notArmed.sender.send({ text: TEXT, scene: "PAX-1", playId: 1 });
  assert.deepEqual(notArmed.timing(), []);

  const h = harness();
  await h.sender.send({ text: TEXT, scene: "PAX-1", playId: 1 });
  h.lines.length = 0;
  await h.sender.send({ text: TEXT, scene: "PAX-1", playId: 1 }); // duplicate-play-id
  assert.deepEqual(h.timing(), [], "penolakan playId kembar juga tidak mencetak timing");

  const tooLong = harness();
  await tooLong.sender.send({ text: "x".repeat(200), scene: "PAX-1", playId: 2 });
  assert.deepEqual(tooLong.timing(), []);
});

test("timing: identitas terlarang ditolak dan hanya tahap sebelum penolakan yang terukur", async () => {
  const { sender, timing } = harness({}, { readIdentity: async () => ["garudafood_officialstore"] });
  const r = await sender.send({ text: TEXT, scene: "PAX-1", playId: 1 });

  assert.ok(r.reason.startsWith("identity-"), r.reason);
  const line = timing()[0];
  assert.ok(line.includes("getPage=") && line.includes("identity="), line);
  assert.ok(!line.includes("type="), "tidak pernah mengetik, jadi tidak boleh ada tahap type: " + line);
  assert.ok(!line.includes("click="), line);
});

test("timing: tahap basi sebelum klik ikut terukur bersama pembersihannya", async () => {
  let calls = 0;
  // Basi hanya pada pemeriksaan KEDUA (tepat sebelum klik).
  const { p, sender, timing } = harness({}, { isStale: () => ++calls > 1 });
  const r = await sender.send({ text: TEXT, scene: "PAX-1", playId: 1 });

  assert.equal(r.reason, "stale");
  assert.equal(countOf(p, "click"), 0, "basi berarti tidak pernah mengklik");
  const line = timing()[0];
  assert.ok(line.includes("stale="), line);
  assert.ok(line.includes("cleanup="), "teks sendiri dibersihkan dan terukur: " + line);
});
