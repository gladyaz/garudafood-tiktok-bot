# AI LIVE HOST 0.1.0 — kandidat pilot eksternal pertama

Catatan ini adalah berkas serah-terima untuk build pilot. Ia tidak ikut terpaket
(`files` allowlist membuang `**/*.md`).

## Berkas yang diberikan

| | |
|---|---|
| Installer | `AI LIVE HOST Setup 0.1.0.exe` |
| Ukuran | 268.265.038 byte (±256 MiB) |
| SHA-256 | `c0e19bc6f7ce27721cc39c6a3371fd58372dfc97a3763bef2f09f8abfaab214d` |
| Commit | `b221926` di `feat/windows-packaging-p5` |
| Dibangun | 2026-10-09 |

Runtime yang dipaku di dalamnya (`resources/runtime-manifest.json`):

| | |
|---|---|
| Node | v24.19.0 · `3602f2bb…` |
| Chrome for Testing | 142.0.7444.175 · `62ec6f2d…` |
| Node LICENSE | `148eacf7…` |
| asar | `false` (disengaja; BUKAN batas keamanan) |

Build gagal kalau salah satu hash di atas tidak cocok, dan mode terpaket
**fail-closed**: tidak ada jatuh-balik diam-diam ke Node atau Chrome sistem.

## Yang sudah dibuktikan di mesin ini

- **Suite penuh 1539 pass / 0 fail.**
- **Validasi LIVE end-to-end dari app TERPASANG** (P5.1, 2026-10-09): PAX-1
  sampai PAX-5, scene benar, produk benar ter-pin, balasan admin muncul di chat.
  Satu run penutup PAX-1 ditangkap lengkap dengan jejak anak mentah: MATCH
  (`via=keyword`) → QUEUE → PLAY → AUTOPIN_REQUEST → `PINNED after=Unpin
  via=button-text` → AUTOPIN_SUCCESS (2,16 s, `dryRun=false`) → AUTOCOMMENT
  (1,59 s, `clicks=1 composerCleared=true`) → PLAYBACK_END `reason=media-ended`.
  Dari komentar penonton sampai balasan terkirim: 3,8 detik.
- **Kunci bot bersih di kedua ujung**: `reason=stale-before-start result=removed`
  sebelum start, `reason=stopped result=removed` sesudah stop — walaupun Windows
  tetap mematikan child dengan TerminateProcess (`signal=SIGTERM`), yang
  melewati handler milik child itu.
- **Data customer selamat melewati reinstall**: config hidup di
  `%APPDATA%\AI LIVE HOST`, bukan di folder instalasi. Uninstall membuang
  binari dan TIDAK menghapus folder itu.

## Yang HARUS diberitahukan ke pilot

1. **SmartScreen akan memperingatkan.** Build ini tidak ditandatangani kode
   (di luar lingkup P5). Peringatannya wajar untuk installer tanpa signature.
   JANGAN sarankan mematikan SmartScreen atau melemahkan Defender.
2. **Ikon aplikasi masih ikon Electron bawaan.** Belum ada aset merek.
3. **Tidak ada updater, telemetri, atau lisensi.** Tidak ada apa pun yang
   dikirim ke jaringan selain ke TikTok dan OBS milik customer sendiri.
   Dashboard hanya mendengarkan 127.0.0.1.
4. **Prasyarat sebelum START BOT** (fail-closed; START akan menolak kalau belum):
   OBS hidup dengan WebSocket menyala, sudah LOGIN TIKTOK sekali, **LIVE on
   air**, produk sudah ada di showcase LIVE, dan dua saklar di
   "What the bot will do during your LIVE" sudah dinyalakan.
5. **Daftar produk hanya dibaca saat automation berhenti.** Kalau pilot
   menambah produk di tengah LIVE, ia harus STOP BOT lalu START BOT lagi.
6. **Jejak anak (`AILIVE_TRACE_CHILD=1`) mati secara bawaan.** Itu disengaja:
   pilot tidak perlu baris log mentah. Log dukungan tetap ditulis ke
   `%APPDATA%\AI LIVE HOST\logs\ai-live-host.log`, maksimal 5 MB × 3 berkas,
   sudah diredaksi, tanpa kiriman ke cloud.
7. **Satu bot pada satu waktu.** Kalau kuncinya menolak start, itu benar:
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
