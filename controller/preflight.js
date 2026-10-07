"use strict";
// Preflight: semua yang harus benar SEBELUM satu proses pun dinyalakan.
//
// Kenapa ini ada sebagai lapisan sendiri: dua run LIVE pernah terbuang karena
// prasyarat tidak diperiksa lebih dulu — LIVE belum on air, atau produk sudah
// ter-pin dari run sebelumnya, atau masih ada bot yatim yang hidup. Memeriksanya
// setelah bot menyala berarti menemukan masalahnya lewat kerusakan.
//
// Dua aturan yang dipegang di sini:
//
//   1. FAIL-CLOSED. Check yang tidak bisa dijawab adalah check yang GAGAL, bukan
//      check yang dilewati. Validasi platform yang lambat (collect 6613ms pada
//      2026-10-07) sudah membuktikan bentuk kegagalan ini benar: lebih baik
//      menolak start daripada menyalakan sesuatu di atas kondisi yang tidak
//      diketahui.
//   2. SEMUA probe dunia nyata di-inject. Tanpa injeksi, modul ini tidak membuka
//      socket, tidak membuka browser, dan tidak menyentuh TikTok. Itulah yang
//      membuat seluruh tes P1 bisa 100% offline tanpa menirukan apa pun yang
//      penting.

const netDefault = require("node:net");
const { validateMappings } = require("./mapping-validator");
const fsDefault = require("node:fs");
const pathDefault = require("node:path");

// Port yang harus bisa diikat oleh AutoPIN service. Port Controller sendiri TIDAK
// diperiksa di sini: Controller sudah memegangnya, jadi ia pasti "terpakai".
const LOOPBACK = "127.0.0.1";

// Nama check yang selalu ada di hasil, dalam urutan yang sama. Bentuk yang tetap
// membuat UI nanti tidak perlu menebak apakah sebuah check dijalankan atau tidak.
// P2 menambah "mappings": pemeriksaan pemetaan terhadap scene OBS dan katalog
// LIVE yang BENAR-BENAR ditemukan. Letaknya paling akhir karena ia memakai hasil
// dua check sebelumnya (obs dan tiktok).
const CHECK_NAMES = Object.freeze(["config", "processes", "ports", "obs", "scenes", "profile", "tiktok", "mappings"]);

// --- probe bawaan (produksi) -------------------------------------------------

// Mengembalikan true kalau port BEBAS. Caranya dengan mencoba mengikatnya, bukan
// dengan mencoba menyambung: port yang tidak ada yang mendengarkan tapi tetap
// tidak bisa diikat (mis. dicadangkan Windows) akan lolos kalau diperiksa dengan
// connect, lalu gagal saat service benar-benar start.
function defaultPortFree({ port, host = LOOPBACK, net = netDefault } = {}) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    let settled = false;
    const done = (free) => {
      if (settled) return;
      settled = true;
      try {
        srv.close();
      } catch {
        /* diabaikan */
      }
      resolve(free);
    };
    srv.once("error", () => done(false));
    srv.once("listening", () => done(true));
    try {
      srv.listen(port, host);
    } catch {
      done(false);
    }
  });
}

// Probe OBS sungguhan. Dipakai hanya di produksi; tes selalu meng-inject.
// Koneksinya ditutup lagi segera: preflight tidak memegang koneksi OBS, bot yang
// memegangnya.
async function defaultProbeObs({ host, port, password, timeoutMs = 5000 }) {
  let OBSWebSocket;
  try {
    OBSWebSocket = require("obs-websocket-js").default;
  } catch {
    return { ok: false, reason: "obs-unavailable" };
  }
  const obs = new OBSWebSocket();
  const url = "ws://" + host + ":" + port;
  try {
    await Promise.race([
      obs.connect(url, password || undefined),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs)),
    ]);
    const { scenes } = await obs.call("GetSceneList");
    const names = Array.isArray(scenes) ? scenes.map((s) => s.sceneName) : [];
    return { ok: true, scenes: names };
  } catch (err) {
    const msg = String((err && err.message) || "").toLowerCase();
    // Password salah dibedakan dari OBS yang mati: tindakan customer-nya berbeda.
    if (msg.includes("auth")) return { ok: false, reason: "obs-auth-failed" };
    return { ok: false, reason: "obs-unavailable" };
  } finally {
    try {
      await obs.disconnect();
    } catch {
      /* diabaikan */
    }
  }
}

// Direktori profil browser harus bisa DITULIS, bukan hanya ada. Profil yang ada
// tapi read-only membuat Chrome gagal start dengan pesan yang tidak jelas.
function defaultCheckProfileDir({ dir, fs = fsDefault }) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = pathDefault.join(dir, ".controller-write-probe");
    fs.writeFileSync(probe, "ok", "utf8");
    fs.unlinkSync(probe);
    return { ok: true };
  } catch {
    return { ok: false, reason: "profile-dir-unusable" };
  }
}

// Adapter TikTok untuk P1: sengaja TIDAK diimplementasikan.
//
// Memeriksa LIVE on air, daftar produk, atau komposer chat butuh browser
// sungguhan di akun sungguhan. Itu pekerjaan P2. Di sini ia adalah stub yang
// JUJUR: ia melaporkan dirinya dilewati, dan tidak pernah mengaku ok.
function defaultProbeTikTok() {
  return { ok: true, skipped: true, reason: "not-implemented-p1" };
}

// --- preflight ---------------------------------------------------------------

function createPreflight({
  portFree = defaultPortFree,
  probeObs = defaultProbeObs,
  checkProfileDir = defaultCheckProfileDir,
  probeTikTok = defaultProbeTikTok,
  listOrphans = null,
  validateConfig = null,
  // P2: scene yang punya detail pemutaran (mediaInputs/duration) di RULES.
  // Pemetaan ke scene di luar daftar ini ditolak, karena Controller tidak punya
  // cara mengetahui nama input media-nya dan menebak durasi berarti mengubah
  // perilaku pemutaran. null = jangan periksa.
  playableScenes = null,
  cwd = process.cwd(),
  path = pathDefault,
} = {}) {
  // Hasil selalu punya SEMUA nama check, supaya tidak ada check yang hilang tanpa
  // terlihat. Check yang tidak dijalankan ditandai skipped, bukan dihapus.
  function blank() {
    const checks = {};
    for (const name of CHECK_NAMES) checks[name] = { ok: false, reason: "not-run" };
    return checks;
  }

  async function run(config) {
    const checks = blank();

    // --- config -------------------------------------------------------------
    if (typeof validateConfig === "function") {
      const verdict = validateConfig(config);
      checks.config = verdict.ok ? { ok: true } : { ok: false, reason: "config-invalid", errors: verdict.errors };
    } else {
      checks.config = { ok: true };
    }

    // Config yang tidak valid membuat seluruh sisanya tidak punya arti: port mana
    // yang diperiksa, scene mana yang dicari, semuanya datang dari config.
    // Berhenti di sini, dan katakan sisanya tidak dijalankan.
    if (!checks.config.ok) {
      for (const name of CHECK_NAMES) {
        if (name !== "config") checks[name] = { ok: false, reason: "skipped-config-invalid", skipped: true };
      }
      return { ok: false, checks };
    }

    const s = config.settings;

    // Hal-hal yang valid secara skema tapi tetap belum siap dipakai. Ini bukan
    // kesalahan bentuk, jadi tempatnya di preflight, bukan di validator config.
    if (!String(config.tiktok.username || "").trim()) {
      checks.config = { ok: false, reason: "tiktok-username-missing" };
      for (const name of CHECK_NAMES) {
        if (name !== "config") checks[name] = { ok: false, reason: "skipped-config-invalid", skipped: true };
      }
      return { ok: false, checks };
    }

    // --- processes ----------------------------------------------------------
    // Bot/service yatim dari sesi sebelumnya. Memeriksanya lebih dulu, karena
    // kalau ada yang hidup maka port akan terpakai dan check port di bawah akan
    // melaporkan gejala, bukan sebabnya.
    if (typeof listOrphans === "function") {
      try {
        const r = await listOrphans();
        const count = r && Number.isInteger(r.count) ? r.count : 0;
        checks.processes = count === 0 ? { ok: true } : { ok: false, reason: "already-running", count };
      } catch {
        // Tidak bisa memeriksa = gagal. Inilah pelajaran stop-all.ps1: laporan
        // "sisa bot: 0" yang tidak bisa dipercaya lebih berbahaya daripada tidak
        // ada laporan.
        checks.processes = { ok: false, reason: "process-check-failed" };
      }
    } else {
      checks.processes = { ok: true, skipped: true, reason: "orphan-check-not-configured" };
    }

    // --- ports --------------------------------------------------------------
    try {
      const free = await portFree({ port: s.autopinPort, host: LOOPBACK });
      checks.ports = free
        ? { ok: true, port: s.autopinPort }
        : { ok: false, reason: "port-in-use", port: s.autopinPort };
    } catch {
      checks.ports = { ok: false, reason: "port-check-failed", port: s.autopinPort };
    }

    // --- obs + scenes -------------------------------------------------------
    let obsScenes = null;
    try {
      const r = await probeObs({
        host: config.obs.host,
        port: config.obs.port,
        password: config.obs.password,
      });
      if (r && r.ok) {
        checks.obs = { ok: true };
        obsScenes = Array.isArray(r.scenes) ? r.scenes : null;
      } else {
        checks.obs = { ok: false, reason: (r && r.reason) || "obs-unavailable" };
      }
    } catch {
      checks.obs = { ok: false, reason: "obs-unavailable" };
    }

    if (!checks.obs.ok) {
      // Tanpa OBS, daftar scene tidak bisa dibandingkan dengan apa pun.
      checks.scenes = { ok: false, reason: "skipped-obs-unavailable", skipped: true };
    } else if (obsScenes === null) {
      checks.scenes = { ok: false, reason: "obs-scene-list-unreadable" };
    } else {
      const wanted = config.mappings.map((m) => String(m.scene).trim());
      if (wanted.length === 0) {
        // Tidak ada pemetaan = AutoPIN tidak akan pernah melakukan apa pun. Itu
        // bukan kondisi siap-jalan untuk sebuah produk yang gunanya memin produk.
        checks.scenes = { ok: false, reason: "no-mappings" };
      } else {
        const missing = wanted.filter((name) => !obsScenes.includes(name));
        checks.scenes =
          missing.length === 0
            ? { ok: true, count: wanted.length }
            : { ok: false, reason: "obs-scene-missing", missing };
      }
    }

    // --- profile ------------------------------------------------------------
    try {
      const dir = path.isAbsolute(s.profileDir) ? s.profileDir : path.resolve(cwd, s.profileDir);
      const r = await checkProfileDir({ dir });
      checks.profile = r && r.ok ? { ok: true } : { ok: false, reason: (r && r.reason) || "profile-dir-unusable" };
    } catch {
      checks.profile = { ok: false, reason: "profile-dir-unusable" };
    }

    // --- tiktok -------------------------------------------------------------
    // Di P1 ini stub. Sejak P2 adapter sungguhan bisa di-inject lewat probeTikTok,
    // dan hasilnya membawa katalog produk yang dipakai check pemetaan di bawah.
    let catalogue = null;
    try {
      const r = await probeTikTok({ config });
      if (r && r.ok) {
        checks.tiktok = Object.assign(
          { ok: true },
          r.skipped ? { skipped: true, reason: r.reason } : {},
          // LIVE belum on air dilaporkan sebagai informasi, bukan sebagai
          // kegagalan check ini: mapping tetap bisa disusun sebelum LIVE mulai.
          typeof r.live === "boolean" ? { live: r.live } : {},
          Number.isInteger(r.productCount) ? { productCount: r.productCount } : {}
        );
        if (Array.isArray(r.products)) catalogue = r.products;
      } else {
        checks.tiktok = { ok: false, reason: (r && r.reason) || "tiktok-check-failed" };
      }
    } catch {
      checks.tiktok = { ok: false, reason: "tiktok-check-failed" };
    }

    // --- mappings -----------------------------------------------------------
    // Pemeriksaan terakhir, dan satu-satunya yang menjawab "apakah pemetaan ini
    // benar-benar akan bekerja". Scene OBS dari check obs, katalog dari check
    // tiktok; keduanya dilewatkan apa adanya kalau tidak tersedia, dan
    // validateMappings akan melewati pemeriksaan yang datanya tidak ada.
    try {
      const verdict = validateMappings({
        mappings: config.mappings,
        obsScenes,
        products: catalogue,
        autoCommentEnabled: s.autoCommentEnabled === true,
        playableScenes,
      });
      checks.mappings = verdict.ok
        ? { ok: true, count: config.mappings.length }
        : {
            ok: false,
            reason: verdict.reason || "mapping-validation-failed",
            // Hasil per baris ikut, supaya UI bisa menyorot pemetaan yang salah
            // tanpa menebak dari kalimat ringkasannya.
            mappings: verdict.mappings.filter((row) => !row.ok),
          };
    } catch {
      checks.mappings = { ok: false, reason: "mapping-validation-failed" };
    }

    const ok = CHECK_NAMES.every((name) => checks[name].ok === true);
    return { ok, checks };
  }

  return { run, CHECK_NAMES };
}

// Check pertama yang gagal, untuk dijadikan satu kalimat bagi customer. Urutannya
// mengikuti CHECK_NAMES, jadi yang dilaporkan adalah sebab paling awal — bukan
// gejala yang muncul sesudahnya.
function firstFailure(result) {
  if (!result || result.ok) return null;
  for (const name of CHECK_NAMES) {
    const c = result.checks[name];
    if (c && c.ok !== true) return { check: name, reason: c.reason || "unknown" };
  }
  return null;
}

module.exports = {
  createPreflight,
  firstFailure,
  CHECK_NAMES,
  defaultPortFree,
  defaultProbeObs,
  defaultCheckProfileDir,
  defaultProbeTikTok,
  LOOPBACK,
};
