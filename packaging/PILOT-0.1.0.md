# AI LIVE HOST 0.1.0 — kandidat pilot eksternal pertama

Catatan ini adalah berkas serah-terima untuk build pilot. Ia tidak ikut terpaket
(`files` allowlist membuang `**/*.md`).

## Berkas yang diberikan

| | |
|---|---|
| Installer | `AI LIVE HOST Setup 0.1.0.exe` |
| Ukuran | 268.294.074 byte (±256 MiB) |
| SHA-256 | `F1E71D085DE3DF8DA82E7D0E43513A0D44675A45084B0178A95B209B913C0C48` |
| Commit | `f40d97e1cc835b081f5886188f129b2e30f2b6c1` di `feat/windows-packaging-p5` |
| Dibangun | 2026-10-10 |

Runtime yang dipaku di dalamnya (`resources/runtime-manifest.json`):

| | |
|---|---|
| Node | v24.19.0 · `3602f2bb…` |
| Chrome for Testing | 142.0.7444.175 · `62ec6f2d…` |
| Node LICENSE | `148eacf7…` |
| asar | `false` (disengaja; BUKAN batas keamanan) |

Build gagal kalau salah satu hash di atas tidak cocok, dan mode terpaket
**fail-closed**: tidak ada jatuh-balik diam-diam ke Node atau Chrome sistem.

## Yang dibuktikan untuk build INI (2026-10-10)

- **Suite penuh 1616 pass / 0 fail.**
- **Berkas UI di aplikasi terpasang cocok dengan commit.** Keenam berkas
  (`app.js`, `i18n.js`, `index.html`, `prefs.js`, `styles.css`, `ui-logic.js`)
  di `%LOCALAPPDATA%\Programs\ai-live-host\resources\app\controller\public`
  di-hash dan dibandingkan dengan isi `f40d97e`. Identik. Jadi installer ini
  memang berasal dari revisi itu, bukan sekadar dibangun di dekatnya.
- **Validasi repaint START → STOP dari app TERPASANG, diukur.** Sampel tiap
  120 ms sejak klik HENTIKAN BOT:

  | | |
  |---|---|
  | `/api/stop` selesai | 747 ms |
  | `/api/status` pertama `STOPPED` | 834 ms |
  | tally merah ON AIR hilang | **834 ms** |
  | hero berhenti mengaku bot mendengarkan | **834 ms** |
  | START tersedia lagi / rantai `onStop` selesai | 43.792 ms |

  **Jeda layar basi sesudah `STOPPED` diketahui = 0 ms.** Discovery TikTok
  tetap berjalan sesudahnya (status 17,0 s · produk 30,3 s · validasi 43,7 s),
  yaitu 42.958 ms yang pada build sebelumnya ditampilkan sebagai "SEDANG
  TAYANG". Dari 328 sampel sesudah titik jujur, nol yang kambuh ke keadaan
  siaran.
- **Keadaan akhir bersih**: `automation=STOPPED`, `armed=false`,
  `realSend=false`, `runId=null`, bot dan service 0 proses, Chrome profil
  automation 0, port 5055 bebas, `.bot.lock` tidak ada di kedua lokasi.
- **Config customer dipulihkan byte-per-byte** sesudah pengujian: SHA-256
  `48CF1AD2…`, 1991 byte, identik dengan sebelum sesi pengujian dimulai.
- **Reinstall tidak menyentuh data customer** (bukti kedua, sesudah 2026-10-08):
  `config.json` SHA-256 identik sebelum dan sesudah, profil browser 767 entri
  utuh. Tidak perlu login TikTok ulang.

## Yang dibuktikan sebelumnya, dan masih berlaku

Mesin automation tidak berubah sejak kedua validasi di bawah. Lihat catatan
nomor 4 di "Hal yang sudah diketahui" untuk batas klaim ini.

- **Rantai LIVE PAX-1 dari app TERPASANG (2026-10-10, commit `71edb8e`,
  installer `EF2E139C…`)**: komentar penonton → scene PAX-1 → AutoPIN berhasil
  (`ms=2716`) → AutoComment berhasil (`ms=1808`) → `PLAYBACK_END
  reason=media-ended`. Ketiganya terkorelasi `playId=1`, dengan
  `mode: pin=true reply=true ok=true` — aksi nyata, bukan latihan.
- **Validasi LIVE end-to-end PAX-1..PAX-5 (P5.1, 2026-10-09)**: scene benar,
  produk benar ter-pin, balasan admin muncul di chat. Satu run penutup PAX-1
  ditangkap lengkap dengan jejak anak mentah: MATCH (`via=keyword`) → QUEUE →
  PLAY → AUTOPIN_REQUEST → `PINNED after=Unpin via=button-text` →
  AUTOPIN_SUCCESS (2,16 s, `dryRun=false`) → AUTOCOMMENT (1,59 s, `clicks=1
  composerCleared=true`) → PLAYBACK_END `reason=media-ended`. Dari komentar
  penonton sampai balasan terkirim: 3,8 detik.
- **Kunci bot bersih di kedua ujung**: `reason=stale-before-start result=removed`
  sebelum start, `reason=stopped result=removed` sesudah stop — walaupun Windows
  tetap mematikan child dengan TerminateProcess (`signal=SIGTERM`), yang
  melewati handler milik child itu.
- **Data customer selamat melewati reinstall**: config hidup di
  `%APPDATA%\AI LIVE HOST`, bukan di folder instalasi. Uninstall membuang
  binari dan TIDAK menghapus folder itu.

## Hal yang sudah diketahui, dan TIDAK menghalangi pilot

1. **START bisa makan sekitar 92 detik** sampai bot benar-benar berjalan, pada
   lingkungan yang diamati. Itu mencakup preflight, discovery, dan boot
   bot/service. Bukan kemacetan — beri tahu pilot supaya ia tidak mengira
   aplikasinya menggantung dan menutupnya paksa di tengah jalan.
2. **`PLAYBACK_END` bisa membawa `userMessage` dukungan yang generik dan salah**
   untuk `reason=media-ended`, yaitu akhir scene yang normal. Layar customer
   BENAR — feed menampilkan "Scene PAX-1 selesai" dari kamusnya sendiri — jadi
   ini hanya mengotori log dukungan. Masuk daftar bersih-bersih pasca-pilot.
3. **Installer belum ditandatangani kode**, jadi Windows SmartScreen akan
   memperingatkan. Lihat juga poin 1 di bagian berikutnya.
4. **Commit final tidak mengulang smoke test AutoPIN/AutoComment.** Satu-satunya
   perubahan kode sesudah rantai LIVE yang berhasil adalah urutan repaint STOP
   di `controller/public/app.js`. Diff `71edb8e..f40d97e` tepat dua berkas:
   `controller/public/app.js` (18 baris) dan `test/ui.readiness.test.js`. Nol
   berkas mesin automation tersentuh. Jadi perilaku pin/comment identik secara
   konstruksi; yang berubah hanya kapan layar dicat.

## Yang HARUS diberitahukan ke pilot

1. **SmartScreen akan memperingatkan.** Build ini tidak ditandatangani kode
   (di luar lingkup P5). Peringatannya wajar untuk installer tanpa signature.
   JANGAN sarankan mematikan SmartScreen atau melemahkan Defender.
2. **Ikon aplikasi masih ikon Electron bawaan.** Belum ada aset merek.
3. **Tidak ada updater, telemetri, atau lisensi.** Tidak ada apa pun yang
   dikirim ke jaringan selain ke TikTok dan OBS milik customer sendiri.
   Dashboard hanya mendengarkan 127.0.0.1.
4. **Prasyarat sebelum MULAI BOT** (fail-closed; START akan menolak kalau belum):
   OBS hidup dengan WebSocket menyala, sudah LOGIN TIKTOK sekali, **LIVE on
   air**, produk sudah ada di etalase LIVE, dan dua saklar di "Yang dilakukan
   bot selama LIVE" sudah dinyalakan.
5. **Satu aturan tidak valid memblokir SEMUANYA.** Kalau satu produk yang
   dipetakan tidak ada di etalase LIVE hari itu, START menolak untuk semua
   aturan — bukan hanya aturan itu. Itu disengaja. Kartu aturannya akan
   bergaris merah dan menyebut sebabnya.
6. **Daftar produk hanya dibaca saat automation berhenti.** Kalau pilot
   menambah produk di tengah LIVE, ia harus HENTIKAN BOT lalu MULAI BOT lagi.
   Selama berjalan, tiga baris kesiapan memang berbunyi "Belum bisa diperiksa".
7. **Bahasa dan tema adalah preferensi tampilan.** Bawaan: Bahasa Indonesia dan
   ikut sistem. Keduanya disimpan di browser lokal, tidak menyentuh
   `config.json`, dan tidak mengubah apa pun yang dilakukan bot.
8. **Jejak anak (`AILIVE_TRACE_CHILD=1`) mati secara bawaan.** Itu disengaja:
   pilot tidak perlu baris log mentah. Log dukungan tetap ditulis ke
   `%APPDATA%\AI LIVE HOST\logs\ai-live-host.log`, maksimal 5 MB × 3 berkas,
   sudah diredaksi, tanpa kiriman ke cloud.
9. **Satu bot pada satu waktu.** Kalau kuncinya menolak start, itu benar:
   lihat insiden 2026-10-05 di `runtime/single-instance.js`.

## Cara memasang

```
AI LIVE HOST Setup 0.1.0.exe        (klik dua kali; atau /S untuk senyap)
```
Per-user, satu klik, tanpa admin. Terpasang ke
`%LOCALAPPDATA%\Programs\ai-live-host`, dengan shortcut Desktop dan Start Menu.
Tidak ikut menyala saat Windows login, dan tidak menjalankan bot sendiri sesudah
pemasangan.

## Verifikasi hash sebelum dibagikan

```powershell
Get-FileHash ".\AI LIVE HOST Setup 0.1.0.exe" -Algorithm SHA256
```
Harus sama dengan SHA-256 di tabel pertama.
