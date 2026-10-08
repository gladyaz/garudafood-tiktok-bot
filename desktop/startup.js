"use strict";
// Jalur startup aplikasi desktop. MURNI — tidak pernah meng-import Electron.
//
// ---------------------------------------------------------------------------
// KENAPA INI DIPISAH DARI main.js
//
// Pada 2026-10-08 launch pertama gagal dengan controller-start-timeout, dan
// aplikasinya TETAP HIDUP memegang kunci satu-instance sampai dimatikan lewat
// Task Manager. Sebabnya ada di main.js, dan bentuknya halus:
//
//     dialog.showErrorBox(...)   // MODAL, memblokir sampai diklik
//     app.exit(1);               // tidak pernah tercapai
//
// showErrorBox menahan eksekusi sampai ada yang menekan OK. Saat startup gagal
// belum ada jendela sama sekali, jadi kotak itu tidak terlihat — dan baris
// keluarnya tidak pernah dijalankan. Akibatnya persis gejala yang dilaporkan:
// "double click pertama gagal, kedua diam", karena instance kedua menabrak kunci
// milik instance pertama yang masih menggantung.
//
// Maka aturannya di sini: KELUAR TIDAK BOLEH BERGANTUNG PADA DIALOG. Dialog
// hanyalah kabar untuk customer; yang menentukan nasib proses adalah kode ini.
//
// Dipisahkan sebagai modul murni supaya seluruh perilaku di atas bisa diuji
// offline — termasuk kasus terpenting, yaitu dialog yang TIDAK PERNAH diklik.

// Satu kalimat untuk SEMUA kegagalan startup. Customer tidak bisa berbuat apa pun
// yang berbeda untuk sebab yang berbeda, jadi membedakannya hanya menambah
// kebingungan. Rinciannya tetap ada — di log, dengan kodenya.
const FAIL_TITLE = "AI LIVE HOST could not start.";
const FAIL_MESSAGE = "AI LIVE HOST could not start. Please try opening the app again.";

// Batas menunggu customer menekan OK. Sesudah ini aplikasi keluar sendiri.
//
// Ini BUKAN timeout kesiapan; keputusan gagalnya sudah diambil. Ini hanya jaring
// supaya dialog yang tidak terlihat, tidak terjangkau, atau gagal tampil tidak
// bisa menyandera proses — persis kegagalan yang modul ini dibuat untuk mencegah.
const ACK_TIMEOUT_MS = 15000;

const STAGE = Object.freeze({
  IDLE: "idle",
  STARTING: "starting",
  READY: "ready",
  FAILED: "failed",
});

// Satu mekanisme keluar, dipakai jalur startup DAN jalur penutupan.
//
// Menyalinnya ke dua tempat berarti salah satunya akan menyimpang, dan yang
// menyimpang adalah yang jarang dijalankan — jalur kegagalan. Lihat catatan
// "jangan duplikasi logika lintas lapis".
function createExitAnnouncer({
  // ({ title, message }) -> Promise. Boleh tidak pernah selesai; itu diuji.
  showFailure = null,
  exit = null,
  log = () => {},
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
  ackTimeoutMs = ACK_TIMEOUT_MS,
} = {}) {
  let exited = false;

  // Keluar SEKALI. Dipanggil dari dua arah — dialog diklik, dan batas waktu
  // habis — dan yang pertama datang yang menang.
  function exitOnce(code) {
    if (exited) return false;
    exited = true;
    try {
      exit(code);
    } catch {
      /* exit yang gagal tidak boleh melahirkan exit kedua */
    }
    return true;
  }

  // Memberi tahu customer, lalu keluar — dalam urutan itu, tapi TANPA keluarnya
  // bergantung pada selesainya pemberitahuan.
  function announceThenExit(code, { title, message }) {
    let timer = null;

    const done = (via) => {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      if (exitOnce(code)) log("EXIT", { code, via });
    };

    // Jaringnya dipasang LEBIH DULU, supaya showFailure yang menggantung,
    // melempar, atau mengembalikan sesuatu yang bukan Promise tetap tertangkap.
    timer = setTimer(() => done("timeout"), ackTimeoutMs);

    let p = null;
    try {
      p = showFailure({ title, message });
    } catch {
      done("dialog-failed");
      return;
    }
    if (p && typeof p.then === "function") {
      p.then(() => done("acknowledged"), () => done("dialog-failed"));
    } else {
      // Dialog sinkron: sudah ditampilkan dan sudah ditutup saat kembali ke sini.
      done("acknowledged");
    }
  }

  return { announceThenExit, exitNow: exitOnce, exited: () => exited };
}

function createStartupFlow({
  // () -> { ok, nodePath, from, reason }
  resolveNode = null,
  // (nodePath) -> lifecycle
  buildLifecycle = null,
  // () -> void. Dipanggil HANYA sesudah Controller siap.
  createWindow = null,
  // ({ title, message }) -> Promise. Boleh tidak pernah selesai; itu diuji.
  showFailure = null,
  // (code) -> void
  exit = null,
  log = () => {},
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
  ackTimeoutMs = ACK_TIMEOUT_MS,
} = {}) {
  let stage = STAGE.IDLE;
  let lifecycle = null;
  let t0 = null;

  const announcer = createExitAnnouncer({ showFailure, exit, log, setTimer, clearTimer, ackTimeoutMs });

  function configured() {
    return [resolveNode, buildLifecycle, createWindow, showFailure, exit].every(
      (f) => typeof f === "function"
    );
  }

  const elapsed = () => (t0 === null ? 0 : Math.max(0, now() - t0));

  const announceThenExit = (code) =>
    announcer.announceThenExit(code, { title: FAIL_TITLE, message: FAIL_MESSAGE });

  function fail(code) {
    stage = STAGE.FAILED;
    log("STARTUP_FAILED", { code, ms: elapsed() });
    announceThenExit(1);
    return { ok: false, code };
  }

  async function run() {
    if (!configured()) return { ok: false, code: "startup-not-configured" };
    if (stage !== STAGE.IDLE) return { ok: false, code: "startup-already-run" };

    stage = STAGE.STARTING;
    t0 = now();
    log("START", { ms: 0 });

    // Node sungguhan dicari LEBIH DULU. Kalau tidak ada, aplikasi TIDAK menyala:
    // Controller yang berjalan tanpa bisa menyalakan bot-nya adalah aplikasi yang
    // terlihat sehat sampai customer menekan START BOT.
    let node;
    try {
      node = resolveNode();
    } catch {
      node = { ok: false, reason: "node-resolve-failed" };
    }
    if (!node || node.ok !== true || !node.nodePath) {
      log("NODE_NOT_FOUND", { reason: (node && node.reason) || "unknown" });
      return fail("node-not-found");
    }
    log("NODE_RESOLVED", { from: node.from, ms: elapsed() });

    try {
      lifecycle = buildLifecycle(node.nodePath);
    } catch {
      return fail("lifecycle-build-failed");
    }
    if (!lifecycle || typeof lifecycle.start !== "function") {
      return fail("lifecycle-build-failed");
    }

    let started;
    try {
      started = await lifecycle.start();
    } catch {
      started = { ok: false, code: "controller-start-failed" };
    }

    if (!started || started.ok !== true) {
      // lifecycle.start() sudah membereskan child-nya sendiri saat gagal dan
      // MEMBUKTIKAN kematiannya; lihat desktop/lifecycle.js. Yang tersisa untuk
      // dilakukan di sini adalah mematikan Electron, karena kunci satu-instance
      // hanya terlepas kalau prosesnya benar-benar keluar.
      return fail((started && started.code) || "controller-start-failed");
    }

    stage = STAGE.READY;
    log("CONTROLLER_READY", { pid: started.pid, ms: elapsed() });

    try {
      createWindow();
    } catch {
      // Jendela yang gagal dibuat meninggalkan Controller hidup tanpa ada yang
      // memakainya. Itu kegagalan startup juga, dan dibereskan lewat jalur yang
      // sama supaya tidak ada Controller yatim.
      stage = STAGE.FAILED;
      log("WINDOW_FAILED", { ms: elapsed() });
      try {
        await lifecycle.stop();
      } catch {
        /* dilaporkan lewat kode kegagalan di bawah */
      }
      announceThenExit(1);
      return { ok: false, code: "window-failed" };
    }

    return { ok: true, pid: started.pid };
  }

  return {
    run,
    stage: () => stage,
    lifecycle: () => lifecycle,
    exited: announcer.exited,
  };
}

module.exports = {
  createStartupFlow,
  createExitAnnouncer,
  STAGE,
  FAIL_TITLE,
  FAIL_MESSAGE,
  ACK_TIMEOUT_MS,
};
