"use strict";
// HTTP API lokal untuk Controller. Lapisan tipis: tidak ada keputusan lifecycle
// di sini, semuanya diteruskan ke controller.js.
//
// Selalu loopback, sama seperti service AutoPIN (autopin/service.js:28). Host-nya
// sengaja TIDAK bisa diubah lewat environment maupun config: endpoint yang bisa
// menyalakan bot yang mengklik akun TikTok sungguhan tidak boleh pernah bisa
// dipanggil dari perangkat lain di jaringan yang sama — termasuk karena salah
// ketik di berkas config.
//
// Pengikatan ke 127.0.0.1 sudah menutup akses dari luar. Pemeriksaan remote
// address di bawah adalah lapis kedua, untuk hal-hal yang bisa melewati itu
// (proxy lokal, port forward, atau pengikatan yang berubah karena kekeliruan di
// masa depan). Dua lapis, sama seperti gerbang kirim chat.

const path = require("node:path");
const express = require("express");
const { redactConfig, mergeSecrets, defaultConfig, CONFIG_VERSION } = require("./config-manager");
const { translate, translateFieldErrors } = require("./errors");

// Direktori berkas statis dashboard. Dipisah dari kode lifecycle: apa pun di
// bawah sini hanya dibaca browser, dan tidak satu pun boleh ikut memutuskan
// kapan bot menyala.
const PUBLIC_DIR = path.join(__dirname, "public");

// Kalimat untuk customer dibentuk di SERVER, bukan di frontend.
//
// Ini pelajaran langsung dari P2: salinan normalizeTitleKey di validator langsung
// menyimpang dari aslinya, dan akibatnya adalah Controller yang bilang "produk
// ketemu" sementara jalur pin tidak menemukannya. Katalog kode -> kalimat ada di
// controller/errors.js; menyalinnya ke app.js akan mengulang kesalahan bentuk
// yang sama, hanya dengan jarak yang lebih jauh (frontend vs backend) sehingga
// penyimpangannya lebih lama tidak terlihat.
//
// Jadi setiap respons yang memuat `reason` juga memuat `userMessage`.
function withUserMessage(obj, reason) {
  if (!reason) return obj;
  return Object.assign({}, obj, { userMessage: translate(reason).userMessage });
}

const DEFAULT_PORT = 4782; // bukan 5055 (AutoPIN) dan bukan 4455 (OBS)
const LOOPBACK = "127.0.0.1";

// Bentuk loopback yang mungkin muncul di req.socket.remoteAddress, termasuk
// bentuk IPv4-mapped yang dipakai Node saat socket-nya dual-stack.
const LOOPBACK_ADDRESSES = Object.freeze(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function isLoopback(req) {
  const addr = req && req.socket && req.socket.remoteAddress;
  if (typeof addr !== "string" || addr === "") return false;
  if (LOOPBACK_ADDRESSES.includes(addr)) return true;
  // 127.0.0.0/8 seluruhnya loopback, bukan hanya 127.0.0.1.
  return /^(::ffff:)?127\.\d+\.\d+\.\d+$/.test(addr);
}

function createServer({ controller, port = DEFAULT_PORT } = {}) {
  if (!controller) throw new Error("server: `controller` wajib diisi");

  const app = express();
  // Batas ukuran body: config dari UI kecil, dan tidak ada alasan menerima
  // kiriman besar lewat endpoint yang bisa mengubah perilaku LIVE.
  app.use(express.json({ limit: "256kb" }));

  // Body JSON yang rusak dibalas sebagai kesalahan config, bukan sebagai stack
  // trace dari express.
  app.use((err, _req, res, next) => {
    if (err && err.type === "entity.parse.failed") {
      return res.status(400).json({ ok: false, error: translate("config-invalid-json") });
    }
    if (err) return res.status(400).json({ ok: false, error: translate("unknown") });
    return next();
  });

  // Gerbang loopback untuk SEMUA endpoint yang mengubah sesuatu.
  function loopbackOnly(req, res, next) {
    if (!isLoopback(req)) {
      return res.status(403).json({ ok: false, error: { code: "not-loopback", userMessage: "This action can only be performed from this computer." } });
    }
    return next();
  }

  // --- baca -----------------------------------------------------------------

  app.get("/api/status", (_req, res) => {
    res.json(controller.status());
  });

  app.get("/api/config", (_req, res) => {
    const loaded = controller.config.loadConfig();
    if (!loaded.ok) {
      // Config belum ada bukan error server: UI harus bisa menampilkan formulir
      // kosong yang sudah terisi default yang aman.
      return res.status(loaded.code === "config-missing" ? 200 : 409).json({
        ok: false,
        error: translate(loaded.code),
        errors: translateFieldErrors(loaded.errors || []),
        // Default dikirim supaya UI punya titik awal, bukan layar kosong.
        defaults: redactConfig(defaultConfig()),
      });
    }
    // redactConfig membuang password OBS dan menggantinya dengan passwordSet.
    res.json({ ok: true, config: redactConfig(loaded.config) });
  });

  app.get("/api/activity", (req, res) => {
    const limit = Number.parseInt(req.query.limit, 10);
    const sinceId = Number.parseInt(req.query.sinceId, 10);
    res.json({
      ok: true,
      events: controller.activity
        .list({
          limit: Number.isInteger(limit) ? limit : undefined,
          sinceId: Number.isInteger(sinceId) ? sinceId : undefined,
        })
        // Kejadian yang punya `reason` ikut membawa kalimatnya. Kode mesinnya
        // TETAP ada: ia yang dicatat di log dan yang dipakai saat menelusuri
        // masalah, sementara kalimatnya yang ditampilkan.
        .map((e) => withUserMessage(e, e.reason)),
      dropped: controller.activity.dropped(),
      max: controller.activity.max,
      lastId: controller.activity.lastId(),
    });
  });

  // --- discovery (P2) -------------------------------------------------------
  //
  // Semuanya HANYA MEMBACA: GET, dan tidak satu pun mengubah OBS, TikTok, atau
  // state Controller. Dibiarkan sebagai GET justru supaya itu jelas.

  app.get("/api/obs/scenes", async (_req, res) => {
    const r = await controller.discoverObsScenes();
    // 200 walau gagal: "OBS tidak nyala" adalah jawaban yang sah untuk
    // pertanyaan "scene apa saja yang ada", bukan kesalahan server. UI
    // menampilkannya sebagai keadaan, bukan sebagai kegagalan permintaan.
    res.json(r);
  });

  app.get("/api/tiktok/status", async (_req, res) => {
    res.json(await controller.discoverTikTokStatus());
  });

  app.get("/api/tiktok/products", async (_req, res) => {
    res.json(await controller.discoverTikTokProducts());
  });

  // --- ubah -----------------------------------------------------------------

  app.put("/api/config", loopbackOnly, (req, res) => {
    const incoming = req.body;
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
      return res.status(400).json({ ok: false, error: translate("config-invalid"), errors: [] });
    }

    // Password yang tidak dikirim berarti "jangan diubah". Tanpa ini, setiap
    // penyimpanan dari UI yang memakai hasil GET /api/config (yang sengaja tidak
    // memuat password) akan menghapus password OBS tanpa ada yang meminta.
    const previous = controller.config.loadConfig();
    const merged = mergeSecrets(incoming, previous.ok ? previous.config : null);

    const saved = controller.config.saveConfig(merged);
    if (!saved.ok) {
      // Config valid yang terakhir TIDAK tersentuh: saveConfig memvalidasi sebelum
      // menulis apa pun.
      return res.status(400).json({
        ok: false,
        error: translate(saved.code),
        errors: translateFieldErrors(saved.errors || []),
      });
    }
    // Perubahan yang disimpan saat automation berjalan TIDAK diterapkan panas.
    // Snapshot yang sedang dipakai tetap berlaku sampai restart — satu pemutaran
    // tidak boleh berpindah trigger atau balasan di tengah jalan.
    const note = controller.noteConfigSaved();
    res.json({
      ok: true,
      config: redactConfig(saved.config),
      version: CONFIG_VERSION,
      restartRequired: note.restartRequired === true,
      ...(note.restartRequired ? { notice: translate("restart-required") } : {}),
    });
  });

  // Validasi pemetaan terhadap scene OBS dan katalog LIVE yang ditemukan.
  // Endpoint terpisah karena UI memerlukannya saat customer menyunting mapping,
  // jauh sebelum ia menekan Start.
  app.post("/api/mappings/validate", loopbackOnly, async (_req, res) => {
    const r = await controller.validateMappings();
    // Satu kalimat per BARIS yang bermasalah. Baris-nya penting: masalah yang
    // dimiliki satu pemetaan tidak boleh tampil sebagai satu spanduk merah umum
    // yang tidak menunjukkan baris mana yang harus dibetulkan.
    res.json(
      Object.assign({}, r, {
        mappings: Array.isArray(r.mappings) ? r.mappings.map((row) => withUserMessage(row, row.reason)) : [],
      })
    );
  });

  app.post("/api/preflight", loopbackOnly, async (_req, res) => {
    const result = await controller.runPreflight();
    // Setiap check yang merah membawa kalimatnya sendiri, supaya UI bisa
    // menampilkan daftar kesiapan baris per baris — bukan satu pesan gabungan
    // yang menyembunyikan mana yang sebenarnya belum siap.
    const checks = {};
    for (const [name, c] of Object.entries(result.checks || {})) {
      checks[name] = c && c.ok === true ? c : withUserMessage(c, c && c.reason);
    }
    res.json({ ok: result.ok, checks });
  });

  app.post("/api/start", loopbackOnly, async (_req, res) => {
    const r = await controller.startAutomation();
    // 409 untuk penolakan yang benar (sudah jalan, preflight merah): itu bukan
    // kesalahan server, dan bukan sesuatu yang perlu dicoba ulang apa adanya.
    res.status(r.ok ? 200 : 409).json(r);
  });

  app.post("/api/stop", loopbackOnly, async (_req, res) => {
    const r = await controller.stopAutomation();
    res.status(r.ok ? 200 : 409).json(r);
  });

  // --- dashboard statis -----------------------------------------------------
  //
  // Dipasang SESUDAH semua rute /api, jadi berkas statis tidak mungkin
  // menaungi endpoint — sebuah berkas bernama `public/api/status` tidak akan
  // pernah menggantikan jawaban Controller.
  //
  // Tidak ada CDN, tidak ada build pipeline: HTML/CSS/JS biasa yang disajikan
  // dari disk. Halaman ini hanya bisa dicapai dari mesin ini sendiri, karena
  // server-nya mengikat 127.0.0.1 (lihat start() di bawah).
  app.use(
    express.static(PUBLIC_DIR, {
      index: "index.html",
      // Dashboard dan API-nya hidup di satu proses dan di-deploy bersama, jadi
      // cache yang menyimpan app.js lama hanya membuat operator melihat UI yang
      // tidak cocok dengan backend-nya tanpa tahu kenapa.
      etag: true,
      maxAge: 0,
      setHeaders: (res) => {
        res.setHeader("Cache-Control", "no-cache");
        // Dashboard tidak memuat apa pun dari luar. Kalau suatu saat ada yang
        // menambahkan <script src="https://..."> , halaman akan menolaknya
        // sendiri daripada diam-diam mengambilnya.
        res.setHeader(
          "Content-Security-Policy",
          "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'"
        );
        res.setHeader("X-Content-Type-Options", "nosniff");
      },
    })
  );

  // Endpoint yang tidak dikenal dibalas JSON, bukan halaman HTML express.
  app.use((_req, res) => {
    res.status(404).json({ ok: false, error: { code: "not-found", userMessage: "Unknown endpoint." } });
  });

  let server = null;

  function start({ port: p = port } = {}) {
    return new Promise((resolve, reject) => {
      server = app.listen(p, LOOPBACK, () => {
        const addr = server.address();
        resolve({ host: addr.address, port: addr.port });
      });
      server.once("error", (err) => reject(err));
    });
  }

  // server.close() berhenti MENERIMA koneksi baru, tapi callback-nya baru dipanggil
  // setelah SEMUA koneksi yang ada selesai. Satu socket keep-alive yang menganggur
  // — dan setiap klien HTTP modern meninggalkannya — membuat callback itu tidak
  // pernah datang.
  //
  // Itu bukan ketidaknyamanan kecil: shutdown Controller menunggu stop() ini, dan
  // Controller yang menggantung saat shutdown berarti proses anaknya hidup lebih
  // lama darinya. Itu bentuk persis insiden 2026-10-05, hanya pintu masuk yang
  // berbeda. Jadi koneksi yang menganggur diputus, dan tunggunya dibatasi.
  function stop({ timeoutMs = 3000 } = {}) {
    return new Promise((resolve) => {
      if (!server) return resolve();
      const srv = server;
      server = null;

      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };

      // Jaring terakhir: kalau toh masih ada yang menahan, shutdown tetap jalan.
      const timer = setTimeout(done, timeoutMs);
      if (timer && typeof timer.unref === "function") timer.unref();

      srv.close(done);
      // Node >= 18.2. Memutus socket keep-alive yang menganggur supaya callback
      // close() benar-benar datang.
      if (typeof srv.closeAllConnections === "function") {
        try {
          srv.closeAllConnections();
        } catch {
          /* batas waktu di atas yang menanggungnya */
        }
      }
    });
  }

  return { app, start, stop, isLoopback, __server: () => server };
}

module.exports = { createServer, DEFAULT_PORT, LOOPBACK, isLoopback, LOOPBACK_ADDRESSES, PUBLIC_DIR };
