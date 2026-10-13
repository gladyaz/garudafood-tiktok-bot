# Audit kesiapan pilot — v0.1.1

Baca-saja. Tidak ada kode produksi yang diubah, tidak ada LIVE dijalankan, tidak
ada installer dibangun, perilaku headless tidak disentuh.

Dasar: `feat/v0.1.1-headless-runtime` @ `3fd60fa`.
Pertanyaan yang dijawab: **apa yang akan menggigit saat aplikasi ini dipakai di
PC customer lain, bukan di mesin ini.**

Batas audit yang perlu dinyatakan di muka: saya tidak punya PC bersih untuk
diuji. Semua temuan di bawah berasal dari pembacaan kode, konfigurasi paket, dan
log run tervalidasi — bukan dari pemasangan sungguhan di mesin orang lain.
Daftar di §5 ada justru untuk menutup celah itu.

---

## Ringkasan

| | Jumlah |
|---|---|
| **P0 — penghalang pilot** | 2 |
| **P1 — penting sebelum pilot lebih luas** | 5 |
| **P2 — rapi-rapi / nanti** | 4 |

Yang **bersih** dan tidak menghasilkan temuan: jalur/nama spesifik mesin,
redaksi log, kelengkapan berkas terpaket, pertumbuhan direktori debug,
persistensi config customer, dan perilaku reinstall.

---

## P0 — penghalang pilot

### P0-1 · Kegagalan yang tidak dikenal berbicara bahasa Inggris di UI Indonesia

**Berkas:** `controller/errors.js translate()` → `FALLBACK`;
`controller/public/ui-logic.js messageOf()`

**Gejala yang dilihat customer:** di tengah dashboard berbahasa Indonesia,
muncul kalimat **"Something went wrong. Check the logs for details."** Customer
pilot tidak membaca bahasa Inggris dengan nyaman, tidak tahu log itu apa, dan
tidak bisa membukanya. Di UI Mandarin efeknya sama.

**Sebab teknis:** `translate(code)` mengembalikan `CATALOG[code] || FALLBACK`,
dan `FALLBACK` adalah kalimat Inggris. `messageOf()` di UI memilih dengan urutan:
kamus menurut kode → `userMessage` dari server → kalimat cadangan pemanggil.
Karena server **selalu** mengisi `userMessage` (dengan FALLBACK Inggris itu),
cabang ketiga — satu-satunya yang berbahasa customer — tidak pernah tercapai
untuk kode yang tidak dikenal.

Diverifikasi: dari 191 `reason`/`code` unik di kode terpaket, **134 tidak ada di
CATALOG maupun kamus UI**. Sebagian besar tag log internal, tapi beberapa
benar-benar sampai ke layar lewat daftar preflight dan kesiapan:

| Kode | Kapan muncul |
|---|---|
| `tiktok-check-failed` | catch-all probe TikTok — jaringan lambat, challenge, halaman berubah |
| `port-check-failed` | check port preflight gagal |
| `process-check-failed` | check proses yatim gagal |
| `skipped-obs-unavailable` | check scene dilewati karena OBS mati |
| `skipped-config-invalid` | semua check dilewati karena config tidak sah |
| `orphan-check-not-configured` | penyapu yatim tidak terpasang |
| `not-run` | check belum dijalankan |

`tiktok-check-failed` yang paling mungkin: ia adalah `catch` paling luar dari
probe TikTok, jadi jaringan lambat di PC customer langsung mendarat di sana.

**Butuh perubahan kode:** ya.

**Perbaikan yang disarankan:** satu baris di `messageOf()` — jangan pakai
`userMessage` server kalau isinya persis `FALLBACK`; jatuhkan ke kalimat
cadangan pemanggil yang sudah berbahasa customer. Itu menutup **semua** 134 kode
sekaligus, termasuk yang belum ada. Terpisah dari itu, tujuh kode di tabel di
atas layak diberi kalimatnya sendiri karena masing-masing punya tindakan yang
berbeda.

**Tes regresi:** kode tak dikenal + bahasa id/en/zh menghasilkan kalimat dari
kamus, bukan FALLBACK Inggris; FALLBACK Inggris tidak pernah muncul di keluaran
UI mana pun; ketujuh kode di atas punya kalimat sendiri di ketiga bahasa; kode
mesin tetap tidak pernah tampil.

**Dampak ke kepemilikan/AutoPIN/AutoComment/fail-closed:** tidak ada. Murni
lapisan kalimat; tidak satu pun keputusan berubah.

---

### P0-2 · MULAI BOT terlihat menggantung selama ~92 detik

**Berkas:** `controller/public/app.js onStart()`; rantai lengkapnya di
`docs/performance-audit-v0.1.1.md`

**Gejala:** customer menekan MULAI BOT. Tombol mati. **Tidak ada apa pun yang
berubah di layar selama satu setengah menit.** Pada PC yang lebih lambat atau
jaringan yang lebih buruk, lebih lama lagi.

**Sebab teknis:** 94 % waktunya membuka halaman dashboard produk TikTok lima
kali berturut-turut; masing-masing membayar peluncuran Chrome dan 30 detik
`waitForSettled` yang hampir selalu habis sampai batasnya. Tidak ada kemajuan
yang dilaporkan ke UI di antara tahap-tahap itu.

**Kenapa ini penghalang pilot, bukan sekadar performa:** aplikasi yang terlihat
membeku akan **ditutup paksa**. Penutupan paksa adalah persis jalur yang dulu
meninggalkan `.bot.lock` basi dan Chrome yatim — dan sekarang, dengan runtime
headless, Chrome yang tertinggal itu **tidak punya jendela untuk ditutup
customer**. Ia hanya memegang profil sampai ada yang menyadarinya.

**Butuh perubahan kode:** ya.

**Perbaikan yang disarankan:** dua lapis, dan yang pertama cukup untuk pilot.
(a) Model progres tujuh tahap dari audit performa §6 — customer melihat
*Memeriksa OBS → Memeriksa LIVE → Membaca produk → …*, sehingga menunggu menjadi
masuk akal. (b) P0-3 audit performa (hapus preflight ganda) memotong 15–25 detik
dengan risiko rendah.

**Tes regresi:** setiap tahap melaporkan dirinya; tahap yang gagal berhenti di
tahap itu dengan sebabnya; tahap yang dilewati mengatakannya; gerbang
fail-closed START tidak berubah; tidak ada tahap yang dilaporkan selesai sebelum
benar-benar selesai.

**Dampak:** model progres murni pelaporan. Penghapusan preflight ganda menyentuh
urutan pemanggilan UI saja — preflight yang berwenang tetap yang di dalam
`startAutomation`, jadi fail-closed justru menguat.

---

## P1 — penting sebelum pilot lebih luas

### P1-1 · Nama klien asal ikut terpaket sebagai nilai bawaan

**Berkas:** `controller/config-manager.js:61` `forbiddenShops: ["garudafood"]`;
`autopin/config.js:23` default yang sama

**Gejala:** customer pilot yang membuka config-nya menemukan nama perusahaan
lain di sana. Tidak ada kerusakan fungsi, tapi ia menjawab pertanyaan yang tidak
pernah ditanyakan: "produk ini sebenarnya dibuat untuk siapa?"

**Sebab teknis:** `forbiddenShops` adalah penjaga keselamatan — identitas toko
yang memuat kata itu tidak boleh diklik — dan nilainya disetel untuk lingkungan
pengembangan kita, bukan untuk customer. `packaging/PILOT-0.1.0.md` sudah
menandai kata ini saat nama paket diganti; nilai bawaannya tertinggal.

Risiko fungsi yang kecil tapi nyata: kalau nama toko pilot kebetulan memuat kata
itu, AutoPIN menolak mengklik dan sebabnya akan terbaca membingungkan.

**Butuh perubahan kode:** ya, satu baris default.

**Perbaikan:** bawaan kosong. Penjaga tetap ada dan tetap berfungsi untuk siapa
pun yang mengisinya; yang hilang hanya nilai yang spesifik ke kita.

**Tes regresi:** daftar kosong tidak pernah memblokir identitas apa pun; daftar
terisi tetap memblokir; config lama yang sudah memuat nilai itu tidak berubah
saat dimuat.

**Dampak:** menyentuh penjaga AutoPIN. Perubahan default saja — **jangan**
ubah logika pencocokannya.

---

### P1-2 · RUNNING dilaporkan sebelum AutoPIN benar-benar siap

**Berkas:** `autopin/service.js startService()` — `warmUp()` tidak di-await;
`controller/controller.js waitServiceHealthy()`

**Gejala:** dashboard berbunyi "Bot mendengarkan chat LIVE Anda", tapi pemicu
pertama dalam ±25–30 detik berikutnya bisa lambat atau gagal karena browser
service masih memanas.

**Sebab teknis:** `/health` menjawab segera saat `listen()`; warmup browser
berjalan di latar. Log run tervalidasi: `SERVICE_READY` **0,56 detik** setelah
spawn — jauh lebih cepat daripada peluncuran Chrome mana pun.

Desainnya sengaja (warmup di luar jalur kritis START) dan itu benar. Yang belum
benar adalah **janjinya**: RUNNING mengatakan lebih dari yang sudah siap.

**Butuh perubahan kode:** ya, kecil.

**Perbaikan:** tampilkan keadaan "Siap — AutoPIN masih menyiapkan diri" sampai
`SERVICE_WARMED`. Jangan tunda RUNNING; itu memperlambat angka tanpa menambah
kebenaran.

**Tes regresi:** keadaan antara dilaporkan dan hilang saat warmup selesai;
warmup gagal mengatakannya alih-alih diam; gerbang START/STOP tidak berubah.

**Dampak:** pelaporan saja. Tidak menyentuh pin, komentar, atau kepemilikan.

---

### P1-3 · Profil browser tumbuh tanpa batas di PC customer

**Berkas:** `autopin/config.js profileDir`; dikelola Chrome

**Gejala:** setelah berbulan-bulan LIVE, `%APPDATA%\AI LIVE HOST\browser-profile`
menjadi besar. Tidak ada di UI yang menyebutkannya dan tidak ada cara
membersihkannya selain menghapus folder — yang juga menghapus sesi login.

**Sebab teknis:** profil Chrome persisten menyimpan cache, service worker, dan
penyimpanan situs. Chrome membatasi sebagian sendiri, tapi tidak semuanya.
Terukur di mesin ini: 767 entri setelah beberapa minggu pemakaian ringan.

**Butuh perubahan kode:** belum tentu — ukur dulu.

**Perbaikan:** pantau pada pilot pertama. Kalau tumbuh berarti, tambahkan
pembersihan cache yang **menyisakan cookie dan sesi**. Jangan hapus profilnya.

**Tes regresi:** sesudah pembersihan apa pun, identitas TikTok masih terbaca
tanpa login ulang.

**Dampak:** menyentuh profil yang memegang sesi login. Berisiko kalau salah;
karena itu diukur dulu, bukan diperbaiki duluan.

---

### P1-4 · Nama akun tes tertulis di komentar sumber yang ikut terpaket

**Berkas:** `tiktok/chat-gate.js:47`

**Gejala:** tidak terlihat di UI. Tapi `asar: false`, jadi seluruh sumber bisa
dibaca siapa pun yang membuka folder instalasi.

**Sebab teknis:** komentar penjelas memakai akun tes sungguhan sebagai contoh.

**Butuh perubahan kode:** ya, satu komentar.

**Perbaikan:** ganti dengan contoh netral.

**Tes regresi:** pemindai yang sudah ada untuk konten customer diperluas ke
komentar berkas terpaket.

**Dampak:** tidak ada.

---

### P1-5 · Installer belum ditandatangani

**Berkas:** `package.json build`

**Gejala:** SmartScreen memperingatkan saat pilot menjalankan installer. Sebagian
orang berhenti di situ.

**Sebab teknis:** tidak ada sertifikat code signing.

**Butuh perubahan kode:** tidak — keputusan pengadaan.

**Perbaikan:** sertifikat OV/EV atau Azure Trusted Signing. Sampai itu ada, ini
hal **pertama** yang harus diberitahukan ke pilot; sudah tercatat di
`packaging/PILOT-0.1.0.md`.

**Dampak:** tidak ada.

---

## P2 — rapi-rapi / nanti

### P2-1 · Artefak config runtime bisa tertinggal setelah penutupan paksa

`controller/controller.js:366 removeRuntimeConfig()` berjalan di jalur stop yang
normal dan di `SHUTDOWN_CLEANUP`. Proses yang dibunuh paksa melewatinya. Berkas
kecil di `%APPDATA%\AI LIVE HOST\runtime`, tidak berbahaya, tapi menumpuk.
**Perbaikan:** sapu artefak yatim saat boot. **Tes:** boot dengan artefak basi
membersihkannya dan tidak pernah memakainya.

### P2-2 · `detail` kesalahan dipotong 200 karakter satu baris

`controller/errors.js translate()`. Baik untuk privasi dan log, tapi saat
mendiagnosa masalah pilot, penyebab akar kadang ada di baris kedua.
**Perbaikan:** simpan versi penuh ke log dukungan saja, bukan ke respons HTTP.

### P2-3 · Dua anggaran waktu yang tidak pernah tercapai bersamaan

`navTimeoutMs` 45 s dan `readyTimeoutMs` 30 s. Bisa disatukan jadi satu anggaran
yang dibaca sekali. Lihat audit performa P2-4.

### P2-4 · Tidak ada cara dalam-aplikasi untuk membuka log dukungan

Kalimat kegagalan menyebut "log", tapi customer tidak diberi jalan ke sana.
**Perbaikan:** tombol "Buka folder log" di Pengaturan. **Tes:** tombol membuka
direktori yang benar di mode terpaket maupun dev.

---

## Yang diperiksa dan BERSIH

| Kategori | Bukti |
|---|---|
| Jalur spesifik mesin | Pemindaian `C:\`, `C:/`, `Users\`, huruf drive atas seluruh berkas terpaket: **nol** |
| Nama pengguna ter-hardcode | Nol di kode; satu di komentar (P1-4) |
| Kelengkapan berkas terpaket | `files` allowlist bersifat inklusif; `design/`, `test/`, `*.md`, `.env*`, `.bot.lock`, profil, dan direktori debug semuanya dibuang. `autopin-cli.js` tidak ikut |
| Asumsi runtime | Node dan Chrome dipaku SHA-256 di `runtime-pins.json`; build gagal kalau tidak cocok; mode terpaket fail-closed tanpa jatuh-balik ke Chrome sistem |
| Pembersihan debug/temp | `saveScreenshot` hanya dipanggil CLI yang tidak terpaket — `browser-debug` tidak tumbuh di produksi |
| Rotasi log | 5 MB × 3 berkas, `desktop/support-log.js` |
| Rahasia di log | Enam aturan redaksi: password, cookie/token sesi, api key, identitas penonton (dimakan sampai `key=` berikutnya, bukan sampai spasi), isi komentar. Beralasan dan menyeluruh |
| Lock basi | `clearLockIfNoBot` sebelum start, `releaseLockFor` oleh INDUK sesudah stop — karena `TerminateProcess` di Windows melewati handler anak. Terbukti dua arah di validasi v0.1.0 |
| Penutupan | `before-quit` dan `window-all-closed` terpasang; `SHUTDOWN_CLEANUP` membersihkan jendela login, menghentikan automation, dan mencabut otoritas run |
| OBS mati | `obs-unavailable` → "OBS tidak tersambung." Terjemahan ada di tiga bahasa |
| Sesi TikTok kedaluwarsa | `tiktok-not-logged-in` dan `identity-mismatch` punya kalimatnya sendiri; discovery gagal tertutup, UI menyuruh LOGIN TIKTOK |
| Kepemilikan profil | `profile-owner.js` murni, saling eksklusif, fail-closed. Tidak disentuh v0.1.1 |
| Persistensi config | `%APPDATA%\AI LIVE HOST\config.json`, tulis atomik lewat berkas sementara + rename |
| Reinstall/uninstall | Terbukti dua kali: SHA-256 config identik sebelum/sesudah, profil utuh |
| Tema terang/gelap/sistem | Token semantik, bukan dua lembar gaya; tervalidasi visual di 18 keadaan pada v0.1.0 |
| Teks UI belum diterjemahkan | Tes memaku paritas 384 kunci × 3 bahasa dan nol `data-t` kosong. Celahnya bukan di sini melainkan di P0-1 |

---

## Clean-machine acceptance checklist

Dijalankan di PC yang **belum pernah** memasang AI LIVE HOST, dengan akun
Windows yang berbeda dari mesin pengembangan.

**Pemasangan**
- [ ] Installer berjalan tanpa hak admin
- [ ] Peringatan SmartScreen muncul dan bisa dilewati; teksnya cocok dengan yang diberitahukan ke pilot
- [ ] Terpasang ke `%LOCALAPPDATA%\Programs\ai-live-host`
- [ ] Shortcut Desktop dan Start Menu ada, dan **membawa ikon produk**, bukan ikon Electron
- [ ] Aplikasi TIDAK ikut menyala saat Windows login

**Pertama kali dibuka**
- [ ] Dashboard terbuka dalam **Bahasa Indonesia**
- [ ] Tema mengikuti pengaturan Windows
- [ ] Panduan "Langkah pertama" muncul karena belum ada config
- [ ] MULAI BOT mati, dan kartu status menyebut apa yang kurang
- [ ] Tidak ada kalimat berbahasa Inggris di mana pun

**Pengaturan dan login**
- [ ] Pengaturan bisa diisi dan disimpan; `%APPDATA%\AI LIVE HOST\config.json` muncul
- [ ] LOGIN TIKTOK membuka jendela yang **terlihat**
- [ ] Setelah login, CEK LOGIN mengenali identitas
- [ ] Jendela login tertutup sendiri dan pemilik profil kembali `none`

**Kesiapan**
- [ ] Dengan OBS **mati**: baris OBS merah dan berbunyi "OBS tidak tersambung."
- [ ] Dengan OBS hidup tapi LIVE mati: LIVE berbunyi "Belum tayang", START tetap mati
- [ ] Dengan satu aturan menunjuk produk yang tidak ada: aturan itu bergaris merah dan menyebut sebabnya; START mati untuk SEMUA aturan
- [ ] Cabut jaringan lalu tekan Periksa ulang: kalimatnya **berbahasa Indonesia** dan menyebut tindakan *(ini yang diuji P0-1)*

**Menjalankan**
- [ ] Setelah START, **tidak ada jendela Chrome yang muncul** *(perilaku baru v0.1.1)*
- [ ] Customer mendapat kabar kemajuan, bukan tombol mati tanpa penjelasan *(P0-2)*
- [ ] Sesudah RUNNING, pemicu pertama bekerja — atau UI mengatakan AutoPIN masih menyiapkan diri *(P1-2)*

**Berhenti dan menutup**
- [ ] HENTIKAN BOT membuat layar **langsung** berbunyi berhenti
- [ ] Setelah stop: nol proses bot/service, nol Chrome automation, port 5055 bebas, tidak ada `.bot.lock`
- [ ] Tutup aplikasi lewat tombol X, lalu periksa Task Manager: tidak ada `chrome.exe` yang tertinggal memegang profil
- [ ] **Bunuh paksa** aplikasi lewat Task Manager, buka lagi: lock basi dibersihkan dan START tetap bisa ditekan

**Pasang ulang**
- [ ] Jalankan installer lagi di atas pemasangan yang sama
- [ ] `config.json` dan profil browser utuh; tidak perlu login TikTok ulang

**Tiga bahasa, tiga tema**
- [ ] ID / EN / 中文 berganti seketika dan bertahan setelah aplikasi dibuka ulang
- [ ] Sistem / Terang / Gelap bertahan; "ikut sistem" mengikuti saat tema Windows diubah
- [ ] Nama akun, judul produk, kata pemicu, dan balasan **tidak pernah** ikut diterjemahkan

**Log**
- [ ] `%APPDATA%\AI LIVE HOST\logs\ai-live-host.log` ada setelah satu sesi
- [ ] Tidak ada password, cookie, token, atau nama penonton di dalamnya

---

## Urutan pengerjaan terhadap tes LIVE headless

| Temuan | Boleh dikerjakan sebelum tes LIVE? | Alasan |
|---|---|---|
| P0-1 kalimat kegagalan | **ya** | Lapisan kalimat; nol keputusan berubah |
| P0-2 model progres | **ya** | Pelaporan; tidak menyentuh jalur browser |
| P0-2 hapus preflight ganda | **ya** | Urutan panggilan UI saja |
| P1-1 `forbiddenShops` bawaan | **ya** | Satu nilai default |
| P1-4 komentar akun tes | **ya** | Komentar |
| P1-2 kejujuran RUNNING | **ya** | Pelaporan |
| P1-3 pertumbuhan profil | **tidak** — ukur dulu | Menyentuh profil yang memegang sesi, dan sesi headless baru saja berubah |
| P1-5 code signing | kapan saja | Pengadaan, bukan kode |
| P2-* | ya | Tidak ada yang menyentuh jalur browser |

Satu aturan yang mengikat semuanya: **jangan ubah apa pun di jalur baca produk
sebelum tes LIVE headless selesai.** Tes itu adalah pengukuran dasar untuk
headless, dan mengubah jalur yang sama di waktu yang sama membuat kegagalan apa
pun punya dua tersangka. Tidak satu pun temuan P0/P1 di atas menyentuh jalur itu
kecuali P1-3, yang karena itu ditahan.
