// Jejak baris mentah bot/service. OFFLINE, tanpa proses, tanpa berkas.
//
// ---------------------------------------------------------------------------
// APA YANG DIJAGA
//
// Jejak ini ada supaya rantai satu run LIVE bisa diaudit sesudahnya. Tapi
// stdout anak memuat SELURUH ISI CHAT PENONTON:
//
//   index.js:1207  [TIKTOK_CHAT] user=<nama> comment="<isi>"
//   index.js:949   💬 <nama>: <isi>
//
// Mencatat semuanya berarti menulis komentar setiap penonton ke berkas di disk
// customer — berkas yang justru DIKIRIMKAN customer saat melaporkan masalah.
//
// Jadi yang diuji di sini bukan "apakah jejaknya jalan", melainkan **apa yang
// TIDAK boleh pernah ikut**, dan bahwa arah kegagalannya menutup.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createChildTracer,
  shouldTrace,
  traceTagOf,
  traceEnabled,
  TRACE_ENV,
  TRACE_TAGS,
  TRACE_DENY,
} = require("../controller/child-trace");
const { redactLine } = require("../desktop/support-log");

// --- MATI secara default -----------------------------------------------------

test("jejak MATI kecuali diminta eksplisit", () => {
  // Default mati bukan karena ragu: menulis stdout itu sinkron dan memblokir
  // event loop yang sama dengan penanganan OBS — itu sebabnya
  // runtime/op-log.js ada. Lihat catatan di controller/child-trace.js.
  assert.equal(traceEnabled({}), false);
  assert.equal(traceEnabled({ [TRACE_ENV]: "" }), false, "variabel kosong TIDAK menyalakan");
  assert.equal(traceEnabled({ [TRACE_ENV]: "0" }), false);
  assert.equal(traceEnabled({ [TRACE_ENV]: "no" }), false);
  assert.equal(traceEnabled({ [TRACE_ENV]: "1" }), true);
  assert.equal(traceEnabled({ [TRACE_ENV]: "true" }), true);
  assert.equal(traceEnabled({ [TRACE_ENV]: "TRUE" }), true);
});

test("tracer yang MATI tidak menulis apa pun", () => {
  const out = [];
  const trace = createChildTracer({ enabled: false, write: (t) => out.push(t) });
  assert.equal(trace("bot", "[MATCH] scene=PAX-1 user=Budi via=spill etalase 1"), false);
  assert.deepEqual(out, []);
});

// --- yang TIDAK BOLEH ikut ---------------------------------------------------

test("isi chat penonton TIDAK PERNAH ikut", () => {
  // Dua bentuk, dan keduanya ditutup oleh mekanisme yang berbeda.
  //
  //   [TIKTOK_CHAT]   ada tag-nya, tapi ada di daftar TOLAK
  //   💬 <nama>: ...  tidak bertag, jadi tidak pernah lolos allowlist
  assert.equal(shouldTrace('[TIKTOK_CHAT] user=Budi comment="spill etalase 1"'), false);
  assert.equal(shouldTrace("💬 Budi: spill etalase 1"), false);
});

test("baris TANPA tag tidak pernah dicatat", () => {
  // Inilah yang menutup baris 💬 tanpa perlu mengenalinya secara khusus, dan
  // juga menutup setiap baris bebas di masa depan.
  for (const line of [
    "💬 Budi: halo kak",
    "⚠ Ignore: Budi is muted",
    " - PAX-1 | count=2 | requesters=Budi, Siti",
    "sembarang teks tanpa tag",
    "",
  ]) {
    assert.equal(shouldTrace(line), false, "harus ditolak: " + line);
  }
});

test("FAIL CLOSED: daftar TOLAK menang atas daftar izin", () => {
  // Secara teknis TIKTOK_CHAT sudah cukup dengan tidak ada di daftar izin.
  // Tes ini mengikat lapis kedua: kalau suatu saat seseorang menambahkannya ke
  // daftar izin sambil lalu, isi chat penonton TETAP tidak tercatat.
  assert.ok(TRACE_DENY.includes("TIKTOK_CHAT"));
  assert.ok(!TRACE_TAGS.includes("TIKTOK_CHAT"), "dan ia tidak ada di daftar izin");
});

test("tag yang TIDAK dikenal ditolak, bukan dibiarkan lewat", () => {
  // Arah kegagalan: tag baru di masa depan tidak ikut tercatat sampai seseorang
  // menambahkannya dengan sengaja.
  assert.equal(shouldTrace("[SOMETHING_NEW] scene=PAX-1"), false);
  assert.equal(shouldTrace("[VIEWER_PROFILE] name=Budi"), false);
});

// --- rantai audit yang HARUS ikut -------------------------------------------

test("seluruh rantai audit ikut tercatat", () => {
  // Persis rantai yang diminta untuk validasi P5.1.
  const chain = [
    "[MATCH] scene=PAX-1 user=Budi via=spill etalase 1",
    "[QUEUE] scene=PAX-1 queueLen=1",
    "[PLAY] scene=PAX-1 count=1 requesters=1",
    '[AUTOPIN_REQUEST] scene=PAX-1 playId=1 key="TARGET Kacang ATOM 16gr"',
    "[AUTOPIN_SERVICE_PINNED] scene=PAX-1 after=Unpin via=snapshot-button reads=6",
    '[AUTOPIN_SUCCESS] scene=PAX-1 playId=1 key="TARGET Kacang ATOM 16gr" ms=1200 dryRun=false clicked=true state="Unpin"',
    "[AUTOCOMMENT_REQUEST] scene=PAX-1 playId=1",
    "[AUTOCOMMENT_SEND_TYPED] scene=PAX-1 ms=95",
    "[AUTOCOMMENT_SEND_CLICKED] scene=PAX-1 ms=95",
    "[AUTOCOMMENT_SEND_RECONCILED] scene=PAX-1 outcome=sent",
    "[AUTOCOMMENT_SUCCESS] scene=PAX-1 playId=1 ms=1400",
    "[PLAYBACK_END] scene=PAX-1 reason=media-end",
  ];
  for (const line of chain) {
    assert.equal(shouldTrace(line), true, "harus ikut: " + line);
  }
});

test("keluarga AUTOPIN_/AUTOCOMMENT_ ikut tanpa harus didaftar satu per satu", () => {
  assert.equal(shouldTrace("[AUTOPIN_STALE] scene=PAX-1"), true);
  assert.equal(shouldTrace("[AUTOCOMMENT_SEND_REFUSED] reason=real-comment-send-disabled"), true);
  assert.equal(shouldTrace("[AUTOPIN_SERVICE_COMMENT_STALE] scene=PAX-1"), true);
});

test("tag dibaca dari awal baris saja", () => {
  assert.equal(traceTagOf("[MATCH] x=1"), "MATCH");
  assert.equal(traceTagOf("  [PLAY] x=1"), "PLAY");
  assert.equal(traceTagOf("teks lalu [MATCH] x=1"), null, "tag di tengah baris bukan tag");
  assert.equal(traceTagOf(null), null);
});

// --- bentuk keluaran ---------------------------------------------------------

test("baris jejak menyebut ASALNYA dan tidak bisa terbaca sebagai kabar Controller", () => {
  // desktop/controller-child.js mencocokkan ^\[CONTROLLER_BOOT\] dan
  // ^\[CONTROLLER_(FATAL|BOOT_FAILED)\] pada stdout Controller. Baris anak TIDAK
  // boleh pernah bisa dikira kabar fatal Controller — kalau bisa, satu baris log
  // anak akan membatalkan startup.
  const out = [];
  const trace = createChildTracer({ enabled: true, write: (t) => out.push(t) });

  trace("bot", "[MATCH] scene=PAX-1 user=Budi via=spill etalase 1");
  trace("service", "[AUTOPIN_SERVICE_PINNED] scene=PAX-1 after=Unpin via=snapshot-button");

  assert.equal(out.length, 2);
  assert.ok(out[0].startsWith("[CHILD:bot] "), out[0]);
  assert.ok(out[1].startsWith("[CHILD:service] "), out[1]);
  for (const line of out) {
    assert.ok(!/^\[CONTROLLER_/.test(line), "tidak boleh berawalan [CONTROLLER_: " + line);
  }
  // Peran ikut dicatat karena rantainya melintasi dua proses: permintaan pin
  // dari bot, konfirmasinya dari service.
  assert.match(out[1], /after=Unpin/);
  assert.match(out[1], /via=snapshot-button/);
});

test("write yang melempar tidak menjatuhkan Controller", () => {
  const trace = createChildTracer({
    enabled: true,
    write: () => {
      throw new Error("disk penuh");
    },
  });
  assert.doesNotThrow(() => trace("bot", "[MATCH] scene=PAX-1 user=Budi via=x"));
});

// --- REDACTION: lapis kedua di log dukungan ---------------------------------

test("nama penonton DISUNTING, dan trigger-nya TETAP terbaca", () => {
  const line = "[CHILD:bot] [MATCH] scene=PAX-1 user=Budi via=spill etalase 1";
  const out = redactLine(line);
  assert.ok(!out.includes("Budi"), out);
  assert.match(out, /user=<redacted>/);
  // Yang dibutuhkan audit tetap utuh.
  assert.match(out, /scene=PAX-1/);
  assert.match(out, /via=spill etalase 1/, "trigger yang cocok harus tetap terbaca");
});

test("REGRESI: nama penonton BERSPASI disunting SELURUHNYA", () => {
  // Pola `user=(\S+)` hanya menyunting kata pertama lalu membiarkan sisanya
  // tertulis — penyuntingan yang terlihat berhasil padahal bocor. Nama penonton
  // TikTok hampir selalu memuat spasi, jadi justru kasus inilah yang normal.
  const line = "[CHILD:bot] [MATCH] scene=PAX-1 user=Budi Santoso Jaya via=spill etalase 1";
  const out = redactLine(line);
  for (const part of ["Budi", "Santoso", "Jaya"]) {
    assert.ok(!out.includes(part), "bocor '" + part + "': " + out);
  }
  assert.match(out, /via=spill etalase 1/);
});

test("nama penonton di akhir baris juga disunting", () => {
  const out = redactLine("[CHILD:bot] [TIKTOK_CONNECTING] user=@agen_tes_123");
  assert.ok(!out.includes("agen_tes_123"), out);
  assert.match(out, /user=<redacted>/);
});

test("isi komentar disunting kalau sampai lolos ke log", () => {
  const out = redactLine('[TIKTOK_CHAT] user=Budi comment="tolong spill harga dong"');
  assert.ok(!out.includes("tolong spill harga"), out);
  assert.ok(!out.includes("Budi"), out);
});

test("field teknis TIDAK ikut tersunting", () => {
  // Penyuntingan yang terlalu rajin menghapus justru yang gunanya mendiagnosis.
  const lines = [
    '[CHILD:service] [AUTOPIN_SUCCESS] scene=PAX-1 playId=1 key="TARGET Kacang ATOM 16gr" ms=1200 dryRun=false clicked=true state="Unpin"',
    "[CHILD:service] [AUTOPIN_SERVICE_PINNED] scene=PAX-1 after=Unpin via=snapshot-button reads=6",
    "[CHILD:bot] [PLAY] scene=PAX-1 count=1 requesters=1",
    "[CHILD:bot] [PLAYBACK_END] scene=PAX-1 reason=media-end",
    "[CHILD:service] [AUTOCOMMENT_SEND_RECONCILED] scene=PAX-1 outcome=sent",
  ];
  for (const line of lines) {
    assert.equal(redactLine(line), line, "tidak boleh berubah: " + line);
  }
});

test("requesters berupa ANGKA tidak disunting (itu hitungan, bukan nama)", () => {
  // `[PLAY] ... requesters=1` adalah jumlah peminta. Menyuntingnya akan
  // membuang field yang berguna tanpa melindungi apa pun.
  const line = "[CHILD:bot] [PLAY] scene=PAX-1 count=3 requesters=3";
  assert.equal(redactLine(line), line);
});

test("rahasia teknis tetap tersunting seperti sebelumnya", () => {
  // Penambahan pola identitas tidak boleh melemahkan yang sudah ada.
  for (const [line, secret] of [
    ["[CONTROLLER_CONFIG] obs.password=sup3rsecret host=127.0.0.1", "sup3rsecret"],
    ["Cookie: sessionid=abc123def456", "abc123def456"],
    ["authorization: Bearer eyJhbGciOi", "eyJhbGciOi"],
  ]) {
    const out = redactLine(line);
    assert.ok(!out.includes(secret), "bocor: " + out);
  }
});

// --- pengumuman saat boot ----------------------------------------------------

test("jejak yang MENYALA diumumkan saat boot, jejak yang mati TIDAK", () => {
  // Jejak yang diminta tapi diam-diam MATI (variabel tidak sampai ke proses,
  // nilai salah ketik) baru terlihat SESUDAH run LIVE selesai — yaitu saat
  // buktinya sudah hilang dan LIVE-nya harus diulang. Satu baris di muka
  // mengubahnya menjadi sesuatu yang bisa diperiksa SEBELUM START BOT ditekan.
  const { createController } = require("../controller/controller");
  const {
    createClock,
    createFakeFs,
    goodConfig,
    passingPreflightDeps,
    CONFIG_PATH,
  } = require("./helpers/controller-harness");

  function build(env) {
    const clock = createClock();
    const lines = [];
    createController({
      cwd: "/fake",
      configFile: CONFIG_PATH,
      fs: createFakeFs({ [CONFIG_PATH]: JSON.stringify(goodConfig()) }),
      spawn: () => ({ pid: undefined }),
      nodePath: "/fake/node",
      pidAlive: () => false,
      now: clock.now,
      sleep: clock.sleep,
      logger: { log: (l) => lines.push(l) },
      preflightDeps: passingPreflightDeps(),
      fetchHealth: async () => ({ ok: true, body: { ok: true } }),
      env,
    });
    return lines.some((l) => /\[CONTROLLER_CHILD_TRACE\].*enabled=true/.test(l));
  }

  assert.equal(build({ AILIVE_TRACE_CHILD: "1" }), true, "menyala harus diumumkan");
  assert.equal(build({}), false, "mati tidak boleh mengumumkan apa pun");
});
