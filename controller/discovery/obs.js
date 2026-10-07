"use strict";
// Penemuan scene OBS. HANYA MEMBACA.
//
// Satu-satunya panggilan yang dipakai adalah GetSceneList. Tidak ada
// SetCurrentProgramScene, tidak ada SetSceneItemEnabled, tidak ada apa pun yang
// mengubah apa yang sedang dilihat penonton. Ini penting bukan cuma secara
// teknis: discovery dipanggil dari UI, mungkin saat LIVE sedang berjalan, dan
// sebuah perpindahan scene yang tidak diminta akan terlihat oleh penonton
// sebagai bot yang kacau.
//
// Koneksinya dibuka, dibaca, lalu DITUTUP. Controller tidak memegang koneksi OBS
// jangka panjang: bot-lah yang memegangnya saat automation berjalan, dan dua
// pemegang koneksi ke OBS yang sama hanya menambah cara untuk saling bingung.
//
// Konfigurasi OBS yang dipakai sama persis dengan yang dibaca core
// (OBS_HOST/OBS_PORT/OBS_PASSWORD -> config.obs), supaya "OBS yang ditemukan
// Controller" dan "OBS yang dipakai bot" tidak pernah bisa jadi dua mesin
// berbeda.

const DEFAULT_TIMEOUT_MS = 5000;

// Klien sungguhan. Dipisah ke fungsi tersendiri supaya tes bisa menyuntikkan
// penggantinya tanpa obs-websocket-js pernah dimuat.
function createRealObsClient() {
  return function connect() {
    let OBSWebSocket;
    try {
      OBSWebSocket = require("obs-websocket-js").default;
    } catch {
      return null;
    }
    return new OBSWebSocket();
  };
}

// Pesan error dari obs-websocket tidak seragam antar versi, jadi klasifikasinya
// dibuat eksplisit dan konservatif: yang TIDAK jelas-jelas soal autentikasi
// dianggap "OBS tidak tersedia", karena itulah tindakan perbaikan yang paling
// sering benar (nyalakan OBS, aktifkan WebSocket server).
function classifyObsError(err) {
  const msg = String((err && err.message) || err || "").toLowerCase();
  if (msg.includes("timeout") || msg.includes("timed out")) return "obs-timeout";
  // obs-websocket mengembalikan code 4009 untuk autentikasi gagal.
  if (msg.includes("auth") || msg.includes("4009") || msg.includes("password")) return "obs-auth-failed";
  return "obs-unavailable";
}

function createObsDiscovery({ createClient = createRealObsClient(), timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  // Mengembalikan { ok, connected, scenes } atau { ok:false, connected, reason }.
  // Bentuknya selalu sama supaya pemanggil tidak perlu menebak.
  async function listScenes({ host, port, password } = {}) {
    const obs = createClient();
    if (!obs) return { ok: false, connected: false, reason: "obs-unavailable" };

    const url = "ws://" + String(host) + ":" + String(port);
    let connected = false;

    // Batas waktu dipasang ke SELURUH urutan baca, bukan hanya ke connect.
    // OBS yang menerima koneksi lalu tidak pernah menjawab GetSceneList adalah
    // kegagalan yang sama buruknya dengan OBS yang mati, dan tanpa batas di sini
    // discovery akan menggantung selamanya — dan UI menunggunya.
    let timer = null;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      if (timer && typeof timer.unref === "function") timer.unref();
    });

    try {
      const work = (async () => {
        await obs.connect(url, password || undefined);
        connected = true;
        const res = await obs.call("GetSceneList");
        const scenes = Array.isArray(res && res.scenes)
          ? res.scenes.map((s) => String(s.sceneName)).filter((n) => n !== "")
          : [];
        return scenes;
      })();

      const scenes = await Promise.race([work, deadline]);
      // Daftar scene tidak dibaca ulang dan tidak diurutkan: urutan dari OBS
      // adalah urutan yang dilihat operator di OBS, dan UI nanti akan
      // menampilkannya begitu.
      return { ok: true, connected: true, scenes };
    } catch (err) {
      return { ok: false, connected, reason: classifyObsError(err) };
    } finally {
      if (timer) clearTimeout(timer);
      try {
        await obs.disconnect();
      } catch {
        // Gagal menutup koneksi tidak mengubah hasil pembacaan, dan tidak boleh
        // menutupi alasan kegagalan yang sebenarnya.
      }
    }
  }

  return { listScenes };
}

module.exports = { createObsDiscovery, classifyObsError, createRealObsClient, DEFAULT_TIMEOUT_MS };
