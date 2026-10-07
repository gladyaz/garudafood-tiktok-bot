// Activity feed: parser baris log core, dan buffer yang BENAR-BENAR dibatasi.
//
// Format yang di-parse di bawah diambil dari kode yang MENCETAKNYA, bukan
// dikarang:
//
//   index.js:1191              [TIKTOK_CONNECTED] roomId=...
//   index.js:513               [PLAY] scene=... count=... requesters=...
//   index.js:354               [PLAYBACK_END] scene=... reason=...
//   autopin/scene-pin.js:135   [AUTOPIN_SUCCESS] scene=... playId=... key="..." ms=...
//   autocomment/core.js:213    [AUTOCOMMENT_SUCCESS] scene=... playId=... ms=...
//
// Kalau core mengubah format barisnya, tes di sini yang harus merah lebih dulu —
// bukan feed yang diam-diam jadi kosong saat LIVE.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createActivityFeed, parseLine, DEFAULT_MAX } = require("../controller/activity");

// --- parser ------------------------------------------------------------------

test("parse [TIKTOK_CONNECTED]", () => {
  const ev = parseLine("[TIKTOK_CONNECTED] roomId=7300000000000000000");
  assert.equal(ev.type, "TIKTOK_CONNECTED");
  assert.equal(ev.message, "Connected to TikTok LIVE");
});

test("parse [TIKTOK_RECONNECTED] sebagai kejadian tersendiri", () => {
  assert.equal(parseLine("[TIKTOK_RECONNECTED] roomId=73").type, "TIKTOK_RECONNECTED");
});

test("parse [PLAY] dengan scene", () => {
  const ev = parseLine("[PLAY] scene=PAX-2 count=3 requesters=2");
  assert.equal(ev.type, "PLAY");
  assert.equal(ev.scene, "PAX-2");
  assert.equal(ev.message, "Scene started");
});

test("parse [PLAYBACK_END] dengan reason", () => {
  const ev = parseLine("[PLAYBACK_END] scene=PAX-2 reason=media-ended");
  assert.equal(ev.type, "PLAYBACK_END");
  assert.equal(ev.scene, "PAX-2");
  assert.equal(ev.reason, "media-ended");
});

test("parse [AUTOPIN_SUCCESS] lengkap, termasuk judul berspasi dalam tanda kutip", () => {
  const line =
    '[AUTOPIN_SUCCESS] scene=PAX-1 playId=7 key="Garuda Ting Ting Pouch" ms=1240 dryRun=false clicked=true state="Unpin"';
  const ev = parseLine(line);
  assert.equal(ev.type, "AUTOPIN_SUCCESS");
  assert.equal(ev.scene, "PAX-1");
  assert.equal(ev.playId, 7);
  assert.equal(ev.ms, 1240);
  // Nilai berspasi di-JSON-quote oleh formatValue di autopin/core.js.
  assert.equal(ev.product, "Garuda Ting Ting Pouch");
  assert.equal(ev.message, "Product pinned");
});

test("parse [AUTOPIN_FAILED] dengan reason yang bisa diterjemahkan", () => {
  const ev = parseLine("[AUTOPIN_FAILED] scene=PAX-3 playId=9 reason=budget-exhausted-before-click");
  assert.equal(ev.type, "AUTOPIN_FAILED");
  assert.equal(ev.reason, "budget-exhausted-before-click");
  assert.equal(ev.message, "Product was not pinned");
});

test("parse [AUTOCOMMENT_SUCCESS] dan [AUTOCOMMENT_FAILED]", () => {
  assert.equal(parseLine("[AUTOCOMMENT_SUCCESS] scene=PAX-1 playId=3 ms=900").type, "AUTOCOMMENT_SUCCESS");
  const f = parseLine("[AUTOCOMMENT_FAILED] scene=PAX-1 playId=3 reason=timeout ms=8000");
  assert.equal(f.type, "AUTOCOMMENT_FAILED");
  assert.equal(f.reason, "timeout");
});

test("playId dan ms jadi angka, bukan string", () => {
  const ev = parseLine("[AUTOCOMMENT_SUCCESS] scene=PAX-1 playId=3 ms=900");
  assert.equal(typeof ev.playId, "number");
  assert.equal(typeof ev.ms, "number");
});

test("playId yang bukan angka tidak dipaksa jadi angka", () => {
  const ev = parseLine("[AUTOPIN_FAILED] scene=PAX-1 playId=abc reason=x");
  assert.equal("playId" in ev, false);
});

test("[TIKTOK_CHAT] TIDAK PERNAH jadi activity", () => {
  // Berisi nama penonton. Direktori logs/ di-gitignore justru karena itu.
  assert.equal(parseLine('[TIKTOK_CHAT] user=@penonton text="spill etalase 1"'), null);
});

test("tag yang tidak dikenal diabaikan, bukan ditebak artinya", () => {
  for (const line of [
    "[AUTOPIN_SERVICE_PINNED] scene=PAX-1",
    "[SKIP_COOLDOWN] scene=PAX-1",
    "[QUEUE] scene=PAX-2",
    "[MATCH] scene=PAX-1",
    "[AGGREGATE] scene=PAX-1",
  ]) {
    assert.equal(parseLine(line), null, line + " seharusnya diabaikan");
  }
});

test("baris yang bukan log berformat tag diabaikan", () => {
  for (const line of ["", "   ", "📭 Aggregate queue kosong.", "undefined", "Error: boom", null, 42, {}]) {
    assert.equal(parseLine(line), null);
  }
});

test("tag di tengah baris tidak dihitung: hanya di awal", () => {
  // Supaya baris yang MENYEBUT sebuah tag (mis. di komentar atau pesan error)
  // tidak berubah menjadi kejadian palsu.
  assert.equal(parseLine("note: lihat [AUTOPIN_SUCCESS] di log"), null);
});

test("spasi berlebih di awal/akhir tetap terbaca", () => {
  assert.equal(parseLine("   [PLAY] scene=PAX-1   ").type, "PLAY");
});

test("waktu bisa diberikan dari luar, supaya urutannya mengikuti waktu child", () => {
  const ev = parseLine("[PLAY] scene=PAX-1", { at: "2026-10-07T10:00:00.000Z" });
  assert.equal(ev.time, "2026-10-07T10:00:00.000Z");
});

// --- buffer ------------------------------------------------------------------

test("buffer DIBATASI, dan yang terbaru yang disimpan", () => {
  const feed = createActivityFeed({ max: 10 });
  for (let i = 1; i <= 50; i += 1) feed.push({ type: "PLAY", scene: "PAX-" + i });

  assert.equal(feed.size(), 10, "tidak boleh tumbuh melewati batas");
  const list = feed.list();
  // Yang dibuang adalah yang TERTUA: operator ingin tahu apa yang baru terjadi.
  assert.equal(list[0].scene, "PAX-41");
  assert.equal(list[9].scene, "PAX-50");
  assert.equal(feed.dropped(), 40);
});

test("batas default 500", () => {
  const feed = createActivityFeed();
  assert.equal(feed.max, DEFAULT_MAX);
  assert.equal(DEFAULT_MAX, 500);
  for (let i = 0; i < 600; i += 1) feed.push({ type: "PLAY" });
  assert.equal(feed.size(), 500);
  assert.equal(feed.dropped(), 100);
});

test("batas yang tidak masuk akal jatuh ke default, bukan jadi tak terbatas", () => {
  for (const max of [0, -5, 1.5, "100", null]) {
    const feed = createActivityFeed({ max });
    assert.equal(feed.max, DEFAULT_MAX, "max=" + max);
  }
});

test("id naik terus dan tidak pernah dipakai ulang", () => {
  // sinceId pada /api/activity bergantung pada ini: id yang dipakai ulang akan
  // membuat UI melewatkan kejadian.
  const feed = createActivityFeed({ max: 3 });
  for (let i = 0; i < 10; i += 1) feed.push({ type: "PLAY" });
  const ids = feed.list().map((e) => e.id);
  assert.deepEqual(ids, [8, 9, 10]);
  assert.equal(feed.lastId(), 10);
});

test("sinceId hanya mengembalikan yang lebih baru", () => {
  const feed = createActivityFeed();
  feed.push({ type: "PLAY", scene: "A" });
  feed.push({ type: "PLAY", scene: "B" });
  feed.push({ type: "PLAY", scene: "C" });

  assert.deepEqual(feed.list({ sinceId: 1 }).map((e) => e.scene), ["B", "C"]);
  assert.deepEqual(feed.list({ sinceId: 3 }), []);
});

test("limit mengembalikan yang TERBARU, bukan yang terawal", () => {
  const feed = createActivityFeed();
  for (const s of ["A", "B", "C", "D"]) feed.push({ type: "PLAY", scene: s });
  assert.deepEqual(feed.list({ limit: 2 }).map((e) => e.scene), ["C", "D"]);
});

test("list mengembalikan salinan: pemanggil tidak bisa merusak buffer", () => {
  const feed = createActivityFeed();
  feed.push({ type: "PLAY", scene: "A" });
  const list = feed.list();
  list[0].scene = "DIUBAH";
  list.push({ type: "PALSU" });
  assert.equal(feed.list()[0].scene, "A");
  assert.equal(feed.size(), 1);
});

test("ingest: baris dikenal masuk, baris tidak dikenal tidak dihitung dibuang", () => {
  const feed = createActivityFeed();
  assert.ok(feed.ingest({ line: "[PLAY] scene=PAX-1" }));
  assert.equal(feed.ingest({ line: "sesuatu yang bukan kejadian" }), null);
  assert.equal(feed.size(), 1);
  // Baris yang bukan kejadian memang bukan kejadian: ia tidak "hilang".
  assert.equal(feed.dropped(), 0);
});

test("push menolak yang bukan objek", () => {
  const feed = createActivityFeed();
  for (const v of [null, undefined, 42, "x"]) assert.equal(feed.push(v), null);
  assert.equal(feed.size(), 0);
});

test("setiap item punya waktu", () => {
  const feed = createActivityFeed({ now: () => "2026-10-07T12:00:00.000Z" });
  const item = feed.push({ type: "PLAY" });
  assert.equal(item.time, "2026-10-07T12:00:00.000Z");
});

test("clear mengosongkan tanpa mereset id", () => {
  const feed = createActivityFeed();
  feed.push({ type: "PLAY" });
  feed.clear();
  assert.equal(feed.size(), 0);
  // id tidak direset: UI yang sedang memegang sinceId lama tidak boleh tiba-tiba
  // menerima kejadian lama sebagai kejadian baru.
  assert.equal(feed.push({ type: "PLAY" }).id, 2);
});

test("seribu baris campur aduk: buffer tetap di batasnya", () => {
  const feed = createActivityFeed({ max: 50 });
  for (let i = 0; i < 1000; i += 1) {
    feed.ingest({ line: "[PLAY] scene=PAX-" + (i % 10) });
    feed.ingest({ line: '[TIKTOK_CHAT] user=@orang' + i + ' text="spill"' });
    feed.ingest({ line: "baris acak " + i });
  }
  assert.equal(feed.size(), 50);
  assert.ok(!JSON.stringify(feed.list()).includes("orang"), "nama penonton tidak boleh ikut");
});
