// Tes konektivitas TikTok: observability + reconnect.
// Deterministik: TIDAK butuh TikTok maupun OBS. Koneksi di-inject sebagai fake EventEmitter,
// obs.call di-stub, timer dipalsukan via node:test.

const { test, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

process.env.DOTENV_CONFIG_QUIET = "true";
const bot = require("../index.js");
const { UserOfflineError } = require("tiktok-live-connector");

const PAX4 = bot.SCENES.AILIVE_SKUPAXEMPAT;

let logs = [];
let obsSwitches = [];

const flush = () => new Promise(resolve => setImmediate(resolve));
async function advance(ms) {
  mock.timers.tick(ms);
  await flush();
  await flush(); // connectTikTok() async: beri dua putaran microtask
}

class FakeConn extends EventEmitter {
  constructor() {
    super();
    this.roomId = "ROOM123";
    this.connectCalls = 0;
    this.failWith = null; // kalau diisi, connect() selalu reject dengan ini
  }
  async connect() {
    this.connectCalls++;
    if (this.failWith) throw this.failWith;
    return { roomId: this.roomId };
  }
}

const st = () => bot.__tiktok.getState();
const linesWith = tag => logs.filter(l => l.startsWith(tag));
// urutan delayMs dari log [TIKTOK_RECONNECT]
const delays = () => linesWith("[TIKTOK_RECONNECT]").map(l => Number(/delayMs=(\d+)/.exec(l)[1]));

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
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
  bot.__test.reset();
});

afterEach(() => {
  bot.__tiktok.reset();
  bot.__test.reset();
  mock.timers.reset();
  mock.restoreAll();
});

test("A: connect sukses -> CONNECTED dicatat, tidak ada reconnect dijadwalkan", async () => {
  const conn = new FakeConn();
  await bot.startTikTok({ createConnection: () => conn });

  assert.ok(logs.some(l => l.startsWith("[TIKTOK_CONNECTING]")), "harus ada [TIKTOK_CONNECTING]");
  assert.ok(logs.includes("[TIKTOK_CONNECTED] roomId=ROOM123"), "harus ada [TIKTOK_CONNECTED] dengan roomId");
  assert.equal(conn.connectCalls, 1);
  assert.equal(st().hasReconnectTimer, false);
  assert.equal(st().attempt, 0);
  assert.equal(delays().length, 0);
});

test("B: disconnect -> tepat satu reconnect dijadwalkan (walau event berulang)", async () => {
  const conn = new FakeConn();
  await bot.startTikTok({ createConnection: () => conn });

  conn.emit("disconnected", { code: 1006, reason: "abnormal" });
  conn.emit("disconnected", { code: 1006, reason: "abnormal" }); // duplikat: harus diabaikan
  await flush();

  assert.ok(logs.some(l => l.startsWith("[TIKTOK_DISCONNECTED]")), "disconnect harus terlihat");
  assert.equal(delays().length, 1, "hanya satu reconnect boleh dijadwalkan");
  assert.deepEqual(delays(), [2000]);
  assert.equal(st().hasReconnectTimer, true);
  assert.equal(st().attempt, 1);
});

test("C: kegagalan berulang -> backoff naik dan berhenti di 30s", async () => {
  const conn = new FakeConn();
  conn.failWith = new Error("boom");
  await bot.startTikTok({ createConnection: () => conn });

  assert.deepEqual(delays(), [2000]);
  for (const d of [2000, 5000, 10000, 20000, 30000]) await advance(d);

  assert.deepEqual(delays(), [2000, 5000, 10000, 20000, 30000, 30000], "harus naik lalu mentok 30s");
  assert.equal(st().attempt, 6);
  assert.ok(logs.filter(l => l.startsWith("[TIKTOK_ERROR]")).length >= 6, "tiap kegagalan harus terlihat");
});

test("D: reconnect sukses -> hitungan percobaan direset", async () => {
  const conn = new FakeConn();
  conn.failWith = new Error("boom");
  await bot.startTikTok({ createConnection: () => conn });
  await advance(2000);
  await advance(5000);
  assert.equal(st().attempt, 3);

  conn.failWith = null; // jaringan pulih
  await advance(10000);

  assert.ok(logs.includes("[TIKTOK_RECONNECTED] roomId=ROOM123"), "pemulihan harus dicatat");
  assert.equal(st().attempt, 0, "hitungan harus direset setelah sukses");
  assert.equal(st().hasReconnectTimer, false);
});

test("E: beberapa siklus reconnect -> listener chat tidak pernah dobel", async () => {
  const conn = new FakeConn();
  await bot.startTikTok({ createConnection: () => conn });
  assert.equal(st().chatListeners, 1);

  for (let i = 0; i < 3; i++) {
    conn.emit("disconnected", { code: 1006 });
    await advance(2000);
    assert.equal(st().chatListeners, 1, `siklus ${i + 1}: listener chat harus tetap 1`);
  }

  assert.equal(conn.connectCalls, 4, "1 awal + 3 reconnect");

  // satu komentar harus diproses tepat sekali, bukan tiga kali
  logs = [];
  conn.emit("chat", { nickname: "budi", comment: "etalase 4" });
  await advance(60);

  assert.equal(linesWith("[TIKTOK_CHAT]").length, 1);
  assert.equal(logs.filter(l => l.startsWith("[MATCH]")).length, 1);
  assert.deepEqual(obsSwitches, [PAX4]);
});

test("F: stopTikTok() membersihkan timer reconnect dan tidak menjadwalkan lagi", async () => {
  const conn = new FakeConn();
  await bot.startTikTok({ createConnection: () => conn });

  conn.emit("disconnected", { code: 1006 });
  await flush();
  assert.equal(st().hasReconnectTimer, true);

  bot.stopTikTok();
  assert.equal(st().hasReconnectTimer, false, "timer harus dibersihkan");
  assert.equal(st().stopped, true);

  const before = conn.connectCalls;
  conn.emit("disconnected", { code: 1006 });
  await advance(30000);
  assert.equal(delays().length, 1, "setelah stop tidak boleh ada jadwal baru");
  assert.equal(conn.connectCalls, before, "tidak boleh connect lagi setelah stop");
});

test("G: UserOfflineError -> retry lebih lambat (30s), bukan backoff cepat", async () => {
  const conn = new FakeConn();
  conn.failWith = new UserOfflineError("user tidak online");
  await bot.startTikTok({ createConnection: () => conn });

  assert.deepEqual(delays(), [30000], "percobaan pertama pun harus 30s, bukan 2s");
  assert.ok(logs.some(l => l.includes("LIVE sedang offline")), "offline harus dicatat jelas");
  assert.ok(logs.some(l => l.includes("reason=user-offline")));

  await advance(30000);
  assert.deepEqual(delays(), [30000, 30000], "tetap lambat selama masih offline");
});

test("H: chat dari konektor masuk ke handleChat yang sudah ada (tanpa matching kedua)", async () => {
  const conn = new FakeConn();
  await bot.startTikTok({ createConnection: () => conn });

  conn.emit("chat", { nickname: "viewer1", comment: "etalase 4" });
  await advance(60);

  assert.ok(logs.includes('[TIKTOK_CHAT] user=viewer1 comment="etalase 4"'));
  assert.ok(logs.some(l => l.startsWith(`[MATCH] scene=${PAX4}`)), "harus lewat matching yang sudah ada");
  assert.deepEqual(obsSwitches, [PAX4], "harus sampai ke switch OBS");

  // komentar yang tidak match tidak boleh memicu apa pun
  logs = [];
  obsSwitches = [];
  conn.emit("chat", { nickname: "viewer2", comment: "burik" });
  await advance(60);
  assert.equal(linesWith("[TIKTOK_CHAT]").length, 1);
  assert.equal(logs.filter(l => l.startsWith("[MATCH]")).length, 0);
  assert.deepEqual(obsSwitches, []);
});

test("I: error konektor yang dulu tertelan sekarang terlihat", async () => {
  const conn = new FakeConn();
  await bot.startTikTok({ createConnection: () => conn });

  conn.emit("error", { info: "Failed to retrieve Room ID from main page", exception: new Error("SIGI_STATE missing") });
  await flush();

  const line = linesWith("[TIKTOK_ERROR]")[0];
  assert.ok(line, "error harus dicatat");
  assert.ok(line.includes("Failed to retrieve Room ID from main page"));
  assert.ok(line.includes("SIGI_STATE missing"));
  assert.equal(st().hasReconnectTimer, false, "error saja tidak memicu reconnect; hanya disconnect yang memicu");
});

test("J: tabel backoff sesuai spesifikasi 2/5/10/20/30s", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 99].map(n => bot.__tiktok.backoffMs(n)), [2000, 5000, 10000, 20000, 30000, 30000, 30000]);
});
