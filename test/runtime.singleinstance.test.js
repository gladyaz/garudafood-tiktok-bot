// Regresi insiden LIVE 2026-10-05 (Phase 21): TIGA proses `node index.js` hidup
// bersamaan (bot Phase 19, 20, dan 21) tanpa ada yang menyadarinya.
//
// Akibat nyatanya ada di svc-p21.log:
//
//    5  [AUTOPIN_SERVICE_PINNED] scene=PAX-1 ... after=Unpin   <- bot Phase 21: ter-pin
//    6  [AUTOCOMMENT_SEND_TYPING] scene=PAX-1 playId=1
//    7  [AUTOCOMMENT_SEND_CLICKED] scene=PAX-1 playId=1        <- chat "sudah aku pin"
//    8  [AUTOPIN_SERVICE_PINNED] scene=PAX-1 ... after=Pin     <- bot Phase 20: ter-UN-pin
//
// Chat mengumumkan produk ter-pin, lalu proses yang seharusnya sudah mati
// mematikan pin itu. Pengumumannya benar saat dikirim dan jadi salah sesudahnya.
//
// Semua tes di bawah memakai fs palsu kecuali satu yang sengaja memakai fs nyata
// di direktori sementara. Tidak ada proses yang benar-benar dimatikan.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const realFs = require("node:fs");

const { createInstanceLock, pidAlive, LOCK_FILENAME } = require("../runtime/single-instance");

const LOCK = "/fake/.bot.lock";

// fs palsu berbasis peta, mencatat semua tulisan dan penghapusan.
function fakeFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const writes = [];
  const unlinks = [];
  return {
    files,
    writes,
    unlinks,
    readFileSync(p) {
      if (!files.has(p)) {
        const err = new Error("ENOENT");
        err.code = "ENOENT";
        throw err;
      }
      return files.get(p);
    },
    writeFileSync(p, data) {
      writes.push(p);
      files.set(p, data);
    },
    unlinkSync(p) {
      unlinks.push(p);
      files.delete(p);
    },
  };
}

const lockBody = (pid, extra = {}) => JSON.stringify({ pid, startedAt: 1, script: "index.js", ...extra });
const silent = { log() {} };
const mk = (opts) => createInstanceLock({ file: LOCK, logger: silent, now: () => 1, ...opts });

// ---------- pengambilan kunci ----------

test("tidak ada kunci sebelumnya: kunci diambil dan dicatat", () => {
  const fs = fakeFs();
  const lock = mk({ fs, pid: 100, isAlive: () => false });

  const r = lock.acquire();
  assert.equal(r.ok, true);
  assert.equal(r.mode, "fresh");
  assert.deepEqual(fs.writes, [LOCK]);
  assert.equal(JSON.parse(fs.files.get(LOCK)).pid, 100);
});

test("INTI INSIDEN: bot lain masih hidup -> start DITOLAK, kunci tidak ditimpa", () => {
  const fs = fakeFs({ [LOCK]: lockBody(55096) }); // PID asli bot Phase 19
  const lock = mk({ fs, pid: 777, isAlive: (p) => p === 55096 });

  const r = lock.acquire();
  assert.equal(r.ok, false);
  assert.equal(r.reason, "already-running");
  assert.equal(r.pid, 55096);
  assert.deepEqual(fs.writes, [], "kunci milik proses yang hidup tidak boleh ditimpa");
});

test("penolakan menyebut PID dan cara membereskannya", () => {
  const lines = [];
  const fs = fakeFs({ [LOCK]: lockBody(44248) });
  createInstanceLock({ file: LOCK, fs, pid: 777, isAlive: () => true, logger: { log: (l) => lines.push(l) } }).acquire();

  const refused = lines.find((l) => l.startsWith("[SINGLE_INSTANCE_REFUSED]"));
  assert.ok(refused, "penolakan harus terlihat di log");
  assert.ok(refused.includes("pid=44248"), refused);
  assert.ok(refused.includes("stop-all.ps1"), "operator diberi jalan keluar yang konkret");
});

test("kunci yatim (PID sudah mati) diambil alih, bukan memblokir selamanya", () => {
  const fs = fakeFs({ [LOCK]: lockBody(12308) });
  const lines = [];
  const lock = createInstanceLock({ file: LOCK, fs, pid: 900, isAlive: () => false, now: () => 1, logger: { log: (l) => lines.push(l) } });

  const r = lock.acquire();
  assert.equal(r.ok, true);
  assert.equal(r.mode, "stale-taken-over");
  assert.ok(lines.some((l) => l.startsWith("[SINGLE_INSTANCE_STALE_TAKEOVER]")));
  assert.equal(JSON.parse(fs.files.get(LOCK)).pid, 900);
});

test("kunci rusak/bukan JSON tidak memblokir start", () => {
  for (const isi of ["bukan json", "", "{}", '{"pid":"halo"}', '{"pid":-3}']) {
    const fs = fakeFs({ [LOCK]: isi });
    const r = mk({ fs, pid: 900, isAlive: () => true }).acquire();
    assert.equal(r.ok, true, "isi kunci: " + JSON.stringify(isi));
  }
});

test("PID sendiri ada di kunci (restart cepat, PID terpakai lagi) -> tetap boleh", () => {
  const fs = fakeFs({ [LOCK]: lockBody(500) });
  const r = mk({ fs, pid: 500, isAlive: () => true }).acquire();
  assert.equal(r.ok, true);
});

test("gagal menulis kunci TIDAK menggagalkan start: playback lebih penting", () => {
  const fs = fakeFs();
  fs.writeFileSync = () => {
    throw new Error("EACCES: read-only filesystem");
  };
  const lines = [];
  const r = createInstanceLock({ file: LOCK, fs, pid: 100, isAlive: () => false, logger: { log: (l) => lines.push(l) } }).acquire();

  assert.equal(r.ok, true);
  assert.equal(r.mode, "unlocked");
  assert.ok(lines.some((l) => l.startsWith("[SINGLE_INSTANCE_UNLOCKED]")), "keadaan tanpa kunci harus terlihat");
});

// ---------- pelepasan kunci ----------

test("release menghapus kunci milik sendiri", () => {
  const fs = fakeFs();
  const lock = mk({ fs, pid: 100, isAlive: () => false });
  lock.acquire();

  assert.equal(lock.release(), true);
  assert.deepEqual(fs.unlinks, [LOCK]);
  assert.equal(fs.files.has(LOCK), false);
});

test("release TIDAK menghapus kunci yang sudah diambil alih proses lain", () => {
  const fs = fakeFs();
  const lock = mk({ fs, pid: 100, isAlive: () => false });
  lock.acquire();

  // Proses lain mengambil alih sesudah kita dianggap mati.
  fs.files.set(LOCK, lockBody(200));

  assert.equal(lock.release(), false);
  assert.deepEqual(fs.unlinks, [], "kunci milik proses hidup tidak boleh ikut terhapus");
  assert.equal(JSON.parse(fs.files.get(LOCK)).pid, 200);
});

test("release tanpa acquire tidak melakukan apa pun", () => {
  const fs = fakeFs({ [LOCK]: lockBody(999) });
  assert.equal(mk({ fs, pid: 100, isAlive: () => true }).release(), false);
  assert.deepEqual(fs.unlinks, []);
});

test("release dipanggil dua kali (SIGINT lalu exit) aman", () => {
  const fs = fakeFs();
  const lock = mk({ fs, pid: 100, isAlive: () => false });
  lock.acquire();
  assert.equal(lock.release(), true);
  assert.equal(lock.release(), false, "panggilan kedua tidak boleh melempar");
});

// ---------- deteksi proses nyata ----------

test("pidAlive: proses sendiri hidup, PID mustahil tidak", () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(0x7ffffff0), false);
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(-1), false);
  assert.equal(pidAlive(NaN), false);
  assert.equal(pidAlive(undefined), false);
});

// ---------- fs nyata ----------

test("fs nyata: dua instance berurutan - yang kedua tertolak selama yang pertama hidup", () => {
  const dir = realFs.mkdtempSync(path.join(os.tmpdir(), "botlock-"));
  const file = path.join(dir, LOCK_FILENAME);
  try {
    // Proses pertama: PID kita sendiri, jadi benar-benar hidup.
    const a = createInstanceLock({ file, pid: process.pid, logger: silent });
    assert.equal(a.acquire().ok, true);
    assert.equal(realFs.existsSync(file), true);

    // Proses kedua: PID lain, melihat kunci milik proses yang nyata-nyata hidup.
    const b = createInstanceLock({ file, pid: process.pid + 1, logger: silent });
    const r = b.acquire();
    assert.equal(r.ok, false);
    assert.equal(r.reason, "already-running");
    assert.equal(r.pid, process.pid);

    // Sesudah yang pertama melepas, yang kedua boleh masuk.
    assert.equal(a.release(), true);
    assert.equal(b.acquire().ok, true);
  } finally {
    realFs.rmSync(dir, { recursive: true, force: true });
  }
});

test("nama berkas kunci tetap .bot.lock (dipakai scripts/stop-all.ps1)", () => {
  assert.equal(LOCK_FILENAME, ".bot.lock");
});

test("kunci ber-BOM tetap terbaca: BOM TIDAK boleh menjadi celah bot kedua", () => {
  // Ditemukan saat menguji kunci sungguhan: berkas yang dibuat PowerShell
  // (Out-File -Encoding utf8) berawalan BOM, JSON.parse menolaknya, kunci
  // dianggap tidak ada, dan `node index.js` KEDUA benar-benar menyala sampai
  // tersambung ke OBS. Bukti: [SINGLE_INSTANCE_HELD] pid=54428 muncul padahal
  // kunci berisi pid=4 yang hidup.
  const fs2 = fakeFs({ [LOCK]: "﻿" + lockBody(4) });
  const r = mk({ fs: fs2, pid: 777, isAlive: () => true }).acquire();

  assert.equal(r.ok, false, "BOM tidak boleh membuat kunci terlihat kosong");
  assert.equal(r.pid, 4);
  assert.deepEqual(fs2.writes, []);
});

test("fs nyata: kunci ber-BOM dari PowerShell tetap memblokir", () => {
  const dir = realFs.mkdtempSync(path.join(os.tmpdir(), "botlock-bom-"));
  const file = path.join(dir, LOCK_FILENAME);
  try {
    realFs.writeFileSync(file, "﻿" + JSON.stringify({ pid: process.pid, script: "index.js" }), "utf8");
    const r = createInstanceLock({ file, pid: process.pid + 1, logger: silent }).acquire();
    assert.equal(r.ok, false);
    assert.equal(r.reason, "already-running");
    assert.equal(r.pid, process.pid);
  } finally {
    realFs.rmSync(dir, { recursive: true, force: true });
  }
});
