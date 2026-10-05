// Regresi insiden LIVE 2026-10-05 (Phase 21): rantai scene -> AutoPIN ->
// AutoComment menyala TANPA ada penonton yang berkomentar saat itu.
//
// Urutan di bawah bukan karangan. Ia disalin dari bot-p21.log yang nyata:
//
//    7  [TIKTOK_CHAT] user=lincoln comment="spill etalase 1"     <- sebelum connect
//   12  [TIKTOK_CHAT] user=lincoln comment="spill etalase 2"     <- sebelum connect
//   24  [TIKTOK_CONNECTED] roomId=7693084879961066261
//   25  [TIKTOK_CHAT] user=lincoln comment="spill etalase 1"     <- antaran ULANG
//   29  [TIKTOK_CHAT] user=lincoln comment="spill etalase 2"     <- antaran ULANG
//   37  [TIKTOK_CHAT] user=Agen Mulia Abadi comment="Etalase 1 sudah aku pin ya kak"
//   39  [MATCH] scene=PAX-1 user=Agen Mulia Abadi via=keyword    <- chat SENDIRI cocok
//
// Semuanya memakai konektor palsu: tidak ada TikTok, OBS, browser, maupun jaringan.

const { test, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { createChatGate, normalizeIdentity, readMsgId, REASONS, DEFAULT_GRACE_MS } = require("../tiktok/chat-gate");

process.env.DOTENV_CONFIG_QUIET = "true";
const bot = require("../index.js");

const SELF = "agen_mulia_abadi";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}
function gateWith(opts = {}) {
  const c = opts.clock || clock();
  const gate = createChatGate({ selfIdentities: [SELF], now: c.now, logger: { log() {} }, ...opts });
  return { gate, clock: c };
}
const ev = (uniqueId, comment, msgId) => ({ uniqueId, nickname: uniqueId, comment, msgId });

// ---------- identitas ----------

test("identitas dinormalkan: nickname berspasi dikenali sama dengan uniqueId bergaris bawah", () => {
  assert.equal(normalizeIdentity("Agen Mulia Abadi"), "agenmuliaabadi");
  assert.equal(normalizeIdentity("agen_mulia_abadi"), "agenmuliaabadi");
  assert.equal(normalizeIdentity("AGEN-MULIA-ABADI"), "agenmuliaabadi");
  assert.equal(normalizeIdentity(undefined), "");
});

test("chat milik akun host ditolak: cegah bot men-trigger scene dari pesannya sendiri", () => {
  const { gate } = gateWith();
  gate.markConnected();
  // Persis baris 37-39 bot-p21.log, yang dulu hanya diselamatkan [SKIP_ACTIVE].
  const r = gate.accept({
    uniqueId: SELF,
    nickname: "Agen Mulia Abadi",
    comment: "Etalase 1 sudah aku pin ya kak",
    msgId: "m-self",
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, REASONS.SELF);
});

test("pesan sendiri ditolak walau hanya nickname yang terbaca", () => {
  const { gate } = gateWith();
  gate.markConnected();
  const r = gate.accept({ nickname: "Agen Mulia Abadi", comment: "etalase 1", msgId: "m1" });
  assert.equal(r.reason, REASONS.SELF);
});

test("penonton lain TIDAK pernah ikut tertolak sebagai pesan sendiri", () => {
  const { gate } = gateWith();
  gate.markConnected();
  assert.equal(gate.accept(ev("lincoln", "spill etalase 1", "m1")).ok, true);
});

// ---------- backlog pra-connect ----------

test("chat sebelum connect ditolak: itu riwayat yang diantar konektor, bukan live", () => {
  const { gate } = gateWith();
  const r = gate.accept(ev("lincoln", "spill etalase 1", "m1"));
  assert.equal(r.ok, false);
  assert.equal(r.reason, REASONS.BACKLOG);
});

test("INTI INSIDEN: pesan backlog tetap dicatat, jadi antaran ulangnya ikut tertolak", () => {
  const { gate } = gateWith();
  gate.accept(ev("lincoln", "spill etalase 1", "m1")); // pra-connect
  gate.markConnected();
  const again = gate.accept(ev("lincoln", "spill etalase 1", "m1")); // msgId SAMA
  assert.equal(again.ok, false);
  assert.equal(again.reason, REASONS.DUPLICATE, "inilah celah yang meloloskan Phase 21");
  assert.equal(gate.__state().counts.accepted, 0);
});

test("antaran ulang ber-msgId BARU tetap tertolak selama jendela tenggang", () => {
  const { gate } = gateWith();
  gate.accept(ev("lincoln", "spill etalase 1", "m1"));
  gate.markConnected();
  const r = gate.accept(ev("lincoln", "spill etalase 1", "m-berbeda"));
  assert.equal(r.reason, REASONS.REPLAY);
});

test("sesudah jendela tenggang, komentar sama dari penonton DITERIMA kembali", () => {
  const c = clock();
  const { gate } = gateWith({ clock: c });
  gate.accept(ev("lincoln", "spill etalase 1", "m1"));
  gate.markConnected();
  c.advance(DEFAULT_GRACE_MS + 1);
  // Operator pernah sengaja menguji komentar kembar; itu harus tetap jadi trigger sah.
  assert.equal(gate.accept(ev("lincoln", "spill etalase 1", "m-baru")).ok, true);
});

test("jendela tenggang pendek supaya tidak menelan komentar asli operator", () => {
  assert.equal(DEFAULT_GRACE_MS, 10_000);
});

// ---------- dedup msgId ----------

test("msgId kembar ditolak walau keduanya datang sesudah connect", () => {
  const { gate } = gateWith();
  gate.markConnected();
  assert.equal(gate.accept(ev("lincoln", "spill etalase 1", "m1")).ok, true);
  assert.equal(gate.accept(ev("lincoln", "spill etalase 1", "m1")).reason, REASONS.DUPLICATE);
});

test("dedup msgId permanen, tidak ikut kedaluwarsa bersama jendela tenggang", () => {
  const c = clock();
  const { gate } = gateWith({ clock: c });
  gate.markConnected();
  gate.accept(ev("lincoln", "etalase 1", "m1"));
  c.advance(60 * 60 * 1000);
  assert.equal(gate.accept(ev("lincoln", "etalase 1", "m1")).reason, REASONS.DUPLICATE);
});

test("tanpa msgId: pesan tetap lewat, tidak ada yang hilang karena field kosong", () => {
  const { gate } = gateWith();
  gate.markConnected();
  assert.equal(gate.accept({ uniqueId: "lincoln", comment: "etalase 4" }).ok, true);
  assert.equal(
    gate.accept({ uniqueId: "lincoln", comment: "etalase 4" }).ok,
    true,
    "tanpa msgId tidak boleh saling meniadakan"
  );
});

test("msgId dibaca dari bentuk pipih maupun dari common (konektor legacy)", () => {
  assert.equal(readMsgId({ msgId: 123 }), "123");
  assert.equal(readMsgId({ common: { msgId: "abc" } }), "abc");
  assert.equal(readMsgId({ msgId: "0" }), null, "0 bukan id sah");
  assert.equal(readMsgId({}), null);
});

test("memori msgId berbatas: sesi panjang tidak menggelembungkan memori", () => {
  const { gate } = gateWith({ memory: 10 });
  gate.markConnected();
  for (let i = 0; i < 100; i++) gate.accept(ev("lincoln", "pesan " + i, "m" + i));
  assert.ok(gate.__state().seenIds <= 10, "seenIds=" + gate.__state().seenIds);
});

// ---------- reconnect ----------

test("reconnect: backlog diantar ulang lagi, dan ditolak lagi", () => {
  const { gate } = gateWith();
  gate.markConnected();
  assert.equal(gate.accept(ev("lincoln", "etalase 1", "m1")).ok, true);

  gate.markDisconnected();
  const r = gate.accept(ev("lincoln", "etalase 2", "m2"));
  assert.equal(r.reason, REASONS.BACKLOG, "saat terputus, chat dianggap riwayat lagi");

  gate.markConnected();
  assert.equal(gate.accept(ev("lincoln", "etalase 2", "m2")).reason, REASONS.DUPLICATE);
});

// ---------- integrasi lewat listener nyata ----------

const flush = () => new Promise((r) => setImmediate(r));

// Mendorong waktu maju melewati timer "allow merge" 50ms plus switchScene, supaya
// rantai scene -> AutoPIN -> AutoComment BENAR-BENAR sempat jalan. Tanpa ini,
// pernyataan "0 AutoPIN" cuma berarti belum ada waktu, bukan benar-benar nol.
async function settle() {
  for (let i = 0; i < 6; i++) {
    mock.timers.tick(100);
    await flush();
    await flush();
  }
}

// AutoPIN dan AutoComment palsu yang MENCATAT setiap permintaan, supaya bisa
// dibuktikan keduanya tidak pernah tersentuh.
function countingAux() {
  const pins = [];
  const comments = [];
  bot.__test.setScenePin({
    requestPin: (req) => {
      pins.push(req);
      return Promise.resolve({ ok: false, reason: "test-noop" });
    },
  });
  bot.__test.setAutoComment({
    requestComment: (req) => {
      comments.push(req);
      return Promise.resolve({ ok: false, reason: "test-noop" });
    },
  });
  return { pins, comments };
}

const brokenGate = (accept) => ({ accept, markConnected() {}, markDisconnected() {}, __state: () => ({}) });

// Konektor yang meniru perilaku nyata: riwayat chat diantar SEBELUM connect() selesai.
class BacklogConn extends EventEmitter {
  constructor(backlog = []) {
    super();
    this.roomId = "ROOM_P21";
    this.backlog = backlog;
  }
  async connect() {
    for (const e of this.backlog) this.emit("chat", e);
    return { roomId: this.roomId };
  }
}

let logs = [];
let obsSwitches = [];

beforeEach(() => {
  logs = [];
  obsSwitches = [];
  const cap = (...a) => logs.push(a.map(String).join(" "));
  mock.method(console, "log", cap);
  mock.method(console, "warn", cap);
  mock.method(console, "error", cap);
  bot.obs.call = async (request, params = {}) => {
    if (request === "SetCurrentProgramScene") obsSwitches.push(params.sceneName);
  };
  bot.__tiktok.reset();
  bot.__test.setScenePin({ requestPin: () => Promise.resolve({ ok: false, reason: "test-noop" }) });
  bot.__test.setAutoComment({ requestComment: () => Promise.resolve({ ok: false, reason: "test-noop" }) });
  bot.__test.reset();
});

afterEach(() => {
  bot.__tiktok.reset();
  bot.__test.reset();
  mock.timers.reset();
  mock.restoreAll();
});

test("REGRESI PHASE 21: urutan asli bot-p21.log TIDAK menyalakan satu scene pun", async () => {
  const backlog = [
    { uniqueId: "lincoln", nickname: "lincoln", comment: "spill etalase 1", msgId: "p21-a" },
    { uniqueId: "lincoln", nickname: "lincoln", comment: "spill etalase 2", msgId: "p21-b" },
  ];
  const conn = new BacklogConn(backlog);
  await bot.startTikTok({ createConnection: () => conn });
  await flush();

  // Antaran ULANG sesudah connect, persis baris 25 dan 29.
  for (const e of backlog) conn.emit("chat", e);
  // Lalu chat admin kita sendiri, persis baris 37.
  conn.emit("chat", {
    uniqueId: SELF,
    nickname: "Agen Mulia Abadi",
    comment: "Etalase 1 sudah aku pin ya kak",
    msgId: "p21-self",
  });
  await flush();

  assert.deepEqual(obsSwitches, [], "tidak boleh ada perpindahan scene: tidak ada penonton yang benar-benar berkomentar");
  assert.deepEqual(bot.__test.getState().queue, [], "antrean harus kosong");

  const counts = bot.__test.chatGateState().counts;
  assert.equal(counts.accepted, 0, "nol chat diterima");
  assert.equal(counts[REASONS.BACKLOG], 2, "dua pesan pra-connect");
  assert.equal(counts[REASONS.DUPLICATE], 2, "dua antaran ulang");
  assert.equal(counts[REASONS.SELF], 1, "satu chat milik bot sendiri");
  assert.ok(logs.some((l) => l.startsWith("[TIKTOK_CHAT_IGNORED]")), "setiap penolakan terlihat di log");
});

test("sesudah gerbang: komentar penonton yang BENAR-BENAR baru tetap menyalakan scene", async () => {
  const conn = new BacklogConn([
    { uniqueId: "lincoln", nickname: "lincoln", comment: "spill etalase 1", msgId: "p21-a" },
  ]);
  await bot.startTikTok({ createConnection: () => conn });
  await flush();

  conn.emit("chat", { uniqueId: "lincoln", nickname: "lincoln", comment: "spill etalase 4", msgId: "fresh-1" });
  await flush();

  assert.equal(bot.__test.chatGateState().counts.accepted, 1);
  assert.ok(
    obsSwitches.length === 1 || bot.__test.getState().queue.length === 1,
    "komentar sah tetap sampai ke antrean/OBS: switches=" + JSON.stringify(obsSwitches)
  );
});

// ---------- fail-closed ----------
//
// Gerbang yang rusak TIDAK boleh menjadi pintu terbuka. Satu chat yang lolos
// tanpa tersaring bisa berujung pada klik Pin nyata plus pesan nyata ke penonton,
// dan keduanya tidak bisa ditarik kembali - persis kerusakan Phase 21. Kehilangan
// satu trigger hanya berarti penonton mengulang komentarnya.

test("FAIL-CLOSED: gerbang melempar -> 0 MATCH, 0 QUEUE, 0 scene, 0 AutoPIN, 0 AutoComment", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const aux = countingAux();
  const conn = new BacklogConn();
  await bot.startTikTok({ createConnection: () => conn });
  bot.__test.setChatGate(brokenGate(() => {
    throw new Error("gerbang rusak");
  }));

  conn.emit("chat", { uniqueId: "lincoln", nickname: "lincoln", comment: "spill etalase 4", msgId: "x1" });
  await settle();

  const err = logs.find((l) => l.startsWith("[TIKTOK_CHAT_GATE_ERROR]"));
  assert.ok(err, "kerusakan gerbang harus terlihat, tidak boleh senyap");
  assert.ok(err.includes("action=drop"), "log menyebut pesannya DIBUANG: " + err);

  assert.deepEqual(logs.filter((l) => l.startsWith("[MATCH]")), [], "0 MATCH");
  assert.deepEqual(logs.filter((l) => l.startsWith("[QUEUE]")), [], "0 QUEUE");
  assert.deepEqual(obsSwitches, [], "0 perpindahan scene");
  assert.deepEqual(bot.__test.getState().queue, [], "antrean tetap kosong");
  assert.equal(bot.__test.getState().busy, false, "tidak pernah menjadi sibuk");
  assert.equal(bot.__test.getState().activeScene, null);
  assert.deepEqual(aux.pins, [], "0 AutoPIN");
  assert.deepEqual(aux.comments, [], "0 AutoComment");
});

test("KONTROL POSITIF: chat sah tetap sampai ke AutoPIN dan AutoComment", async () => {
  // Tanpa tes ini, angka 0 di tes sebelumnya tidak membuktikan apa pun: bisa jadi
  // rantainya memang tidak pernah jalan di harness ini.
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const aux = countingAux();
  const conn = new BacklogConn();
  await bot.startTikTok({ createConnection: () => conn });

  conn.emit("chat", { uniqueId: "lincoln", nickname: "lincoln", comment: "spill etalase 4", msgId: "ok-1" });
  await settle();

  assert.ok(logs.some((l) => l.startsWith("[MATCH]")), "chat sah tetap cocok");
  assert.deepEqual(obsSwitches.length, 1, "tepat satu perpindahan scene");
  assert.equal(aux.pins.length, 1, "AutoPIN diminta tepat sekali");
  assert.equal(aux.comments.length, 1, "AutoComment diminta tepat sekali");
});

test("FAIL-CLOSED: verdict yang bukan { ok: true } persis juga dibuang", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });

  for (const bad of [undefined, null, {}, { ok: "true" }, { ok: 1 }, { ok: false }, "lanjut", 1]) {
    const label = " verdict=" + JSON.stringify(bad);
    bot.__tiktok.reset();
    bot.__test.reset();
    obsSwitches.length = 0;

    const aux = countingAux();
    const conn = new BacklogConn();
    await bot.startTikTok({ createConnection: () => conn });
    bot.__test.setChatGate(brokenGate(() => bad));

    conn.emit("chat", { uniqueId: "lincoln", nickname: "lincoln", comment: "spill etalase 4", msgId: "b1" });
    await settle();

    assert.deepEqual(obsSwitches, [], "0 scene," + label);
    assert.deepEqual(aux.pins, [], "0 AutoPIN," + label);
    assert.deepEqual(aux.comments, [], "0 AutoComment," + label);
  }
});

test("FAIL-CLOSED: penolakan biasa dari gerbang nyata juga nol aksi", async () => {
  // Bukan hanya gerbang rusak: penolakan sah (backlog, kembar, pesan sendiri)
  // harus berhenti di titik yang sama, sebelum handleChat.
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const aux = countingAux();
  const backlog = [{ uniqueId: "lincoln", nickname: "lincoln", comment: "spill etalase 4", msgId: "p-a" }];
  const conn = new BacklogConn(backlog);
  await bot.startTikTok({ createConnection: () => conn });

  for (const e of backlog) conn.emit("chat", e); // antaran ulang
  conn.emit("chat", { uniqueId: SELF, nickname: "Agen Mulia Abadi", comment: "spill etalase 4", msgId: "p-self" });
  await settle();

  assert.deepEqual(obsSwitches, [], "0 scene");
  assert.deepEqual(aux.pins, [], "0 AutoPIN");
  assert.deepEqual(aux.comments, [], "0 AutoComment");
});
