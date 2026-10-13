# Audit performa START BOT — v0.1.1

Baca-saja. Tidak ada perilaku produksi yang diubah, tidak ada LIVE dijalankan,
tidak ada installer dibangun, dan mesin automation tidak disentuh.

Dasar: `feat/v0.1.1-headless-runtime` @ `0381606`.
Bukti waktu: log dukungan `%APPDATA%\AI LIVE HOST\logs\ai-live-host.log` dari
run tervalidasi 2026-10-10, plus pengukuran A/B headed-vs-headless 2026-10-12.

---

## 1. Temuan utama dalam satu kalimat

Satu klik MULAI BOT membuka halaman dashboard produk TikTok **lima kali
berturut-turut sebelum bot menyala**, dan setiap pembukaan membayar peluncuran
Chrome penuh plus penantian "halaman berhenti berubah" yang hampir selalu habis
sampai batasnya.

Itu bukan satu tahap yang lambat. Itu satu tahap yang sama, diulang lima kali.

---

## 2. Rantai panggilan, tahap demi tahap

Dari menekan MULAI BOT sampai `automation=RUNNING`.

Singkatan kolom: **Seq** = berurutan terhadap tahap sebelumnya ·
**Chrome** = meluncurkan browser · **Ulang** = mengulang pekerjaan yang sudah
dilakukan tahap sebelumnya · **Blokir** = menahan customer mencapai RUNNING.

### 2.1 Dikerjakan UI, SEBELUM `/api/start` dipanggil

| # | Tahap | Berkas / fungsi | Seq | Anggaran | Chrome | Ulang | Blokir |
|---|---|---|---|---|---|---|---|
| 1 | Simpan config kalau ada perubahan | `app.js onStart` → `saveConfig()` | ya | — | tidak | tidak | ya |
| 2 | Scene OBS | `app.js loadDiscovery` → `GET /api/obs/scenes` | paralel dgn #3 | 45 s | tidak | tidak | ya |
| 3 | Status TikTok | `GET /api/tiktok/status` → `discovery/tiktok.js status()` | ya | 45 s | **ya** | — | ya |
| 4 | Produk TikTok | `GET /api/tiktok/products` → `products()` | ya | 45 s | **ya** | **ya — pekerjaan halaman identik dgn #3** | ya |
| 5 | Validasi pemetaan | `POST /api/mappings/validate` → `controller.js:959` → `tiktokDiscovery.products()` | ya | 45 s | **ya** | **ya — baca katalog ketiga kalinya** | ya |
| 6 | Preflight | `POST /api/preflight` → `runPreflightOnly()` → `preflight.run()` → `probeTikTok` → `products()` | ya | 45 s | **ya** | **ya — keempat** | ya |

Catatan #2: OBS berjalan paralel dengan cabang TikTok lewat `Promise.all`, tapi
cabang TikTok sendiri **diserialkan dengan sengaja** — lihat §4.

### 2.2 Dikerjakan server di dalam `POST /api/start`

`controller/controller.js startAutomation()`

| # | Tahap | Fungsi | Seq | Anggaran | Chrome | Ulang | Blokir |
|---|---|---|---|---|---|---|---|
| 7 | Penolakan sinkron (sudah jalan / login aktif) | `sm.state()`, `loginFlow` | ya | — | tidak | tidak | ya |
| 8 | Muat + validasi config | `configManager.loadConfig()` | ya | — | tidak | tidak | ya |
| 9 | Verdict mode aksi nyata | `describeMode()` | ya | — | tidak | tidak | ya |
| 10 | **Preflight** | `preflight.run(config)` | ya | lihat bawah | **ya** | **ya — kelima** | ya |
| 11 | Sapu proses yatim | `pm.cleanupOrphans()` | ya | — | tidak | tidak | ya |
| 12 | Bersihkan `.bot.lock` basi | `clearLockIfNoBot()` | ya | — | tidak | tidak | ya |
| 13 | Ambil kepemilikan profil | `ownership.acquire(AUTOMATION)` | ya | — | tidak | tidak | ya |
| 14 | Persenjatai otoritas run | `runAuthority.arm()` | ya | — | tidak | tidak | ya |
| 15 | Tulis artefak config runtime | `writeRuntimeConfig()` | ya | — | tidak | tidak | ya |
| 16 | Spawn service | `pm.startService()` | ya | — | tidak | tidak | ya |
| 17 | Tunggu service sehat | `waitServiceHealthy()` | ya | 45 s, poll 500 ms | tidak | tidak | ya |
| 18 | Spawn bot | `pm.startBot()` | ya | — | tidak | tidak | ya |
| 19 | Tunggu bot tersambung ke chat LIVE | `waitBotReady()` | ya | 60 s | tidak | tidak | ya |
| 20 | Transisi ke RUNNING | `sm.to(RUNNING)` | ya | — | tidak | tidak | — |

Di dalam #10, `preflight.run()` menjalankan delapan check **berurutan**:
`config → processes → ports → obs → scenes → profile → tiktok → mappings`.
Hanya `obs` (socket) dan `tiktok` (browser) yang mahal; sisanya pemeriksaan
lokal di bawah satu detik. `scenes` dan `mappings` memakai hasil `obs` dan
`tiktok`, jadi keduanya memang harus menunggu — tapi `obs` dan `tiktok` sendiri
tidak saling membutuhkan.

### 2.3 Dikerjakan service, SESUDAH RUNNING dilaporkan

| # | Tahap | Fungsi | Seq | Chrome | Blokir |
|---|---|---|---|---|---|
| 21 | `/health` menjawab | `service.js app.get("/health")` | — | tidak | ya (#17) |
| 22 | Warmup halaman produk | `warmUp()` → `ensurePage()` → `launchBrowser` | latar | **ya** | **tidak** |
| 23 | Warmup tab chat / komposer | `warmUpChat()` → `ensureChatPage()` + `waitForComposerReady` | latar, sesudah #22 | tidak (tab kedua) | **tidak** |

Ini sudah dirancang benar: `/health` menjawab segera saat `listen()`, dan
`warmUp()` **tidak di-await** sebelum resolve. Peluncuran Chrome milik service
ada di luar jalur kritis.

Konsekuensinya perlu dicatat, dan ini bukan soal performa melainkan janji:
**RUNNING dilaporkan sebelum AutoPIN benar-benar siap memin.** Pemicu yang
datang di jendela itu menunggu browser service selesai memanas.

---

## 3. Bukti waktu nyata

### 3.1 Run tervalidasi 2026-10-10, LIVE menyala

Dari log dukungan, run yang UI-nya mencatat **92,0 detik** dari klik sampai
RUNNING:

```
09:58:25.042  STOPPED -> PREFLIGHT        /api/start diterima
09:58:50.225  PREFLIGHT_OK                preflight server  = 25,2 s
09:58:50.227  PREFLIGHT -> STARTING
09:58:51.282  RUN_START                   sweep+lock+owner+arm = 1,06 s
09:58:51.584  CHILD_STARTED service       spawn = 0,30 s
09:58:52.139  SERVICE_READY               health = 0,56 s
09:58:52.145  CHILD_STARTED bot
09:58:55.207  BOT_READY                   bot -> chat LIVE = 3,06 s
09:58:55.209  STARTING -> RUNNING
```

| Bagian | Durasi | Porsi |
|---|---|---|
| **UI, sebelum `/api/start`** (#1–#6) | **~61,8 s** | **67 %** |
| Preflight server (#10) | 25,2 s | 27 % |
| Sisa server (#11–#20) | 5,0 s | 5 % |
| **Total** | **92,0 s** | |

**94 % waktunya dihabiskan membaca halaman TikTok yang sama berulang kali.**
Spawn, lock, ownership, arming, service health, dan koneksi chat bot
*bersama-sama* hanya 5 detik.

### 3.2 Biaya satu pembacaan halaman, diukur terpisah (2026-10-12, LIVE mati)

Dari harness A/B, memakai fungsi produksi yang sama:

| | headed | headless |
|---|---|---|
| `openConsole` readyMs | 31.147 ms | 31.055 ms |
| `settled` | **false** | **false** |
| total satu probe | 42.467 ms | 32.092 ms |

`settled: false` adalah intinya. `waitForSettled()` menunggu teks body berhenti
berubah selama `SETTLE_STABLE_MS` (2,5 s) dan menyerah pada `readyTimeoutMs`
(**30 s**). Dashboard LIVE punya penghitung dan koneksi panjang, jadi ia
**tidak pernah tenang** — setiap pembukaan halaman membayar 30 detik penuh lalu
melanjutkan dengan hasil yang sama saja.

Dengan LIVE menyala angkanya lebih baik (~15–25 s per probe menurut rekonstruksi
§3.1), tapi mekanismenya sama: batas waktu yang tercapai, bukan halaman yang
siap.

### 3.3 Anggaran waktu yang berlaku

| Konstanta | Nilai | Berkas |
|---|---|---|
| `navTimeoutMs` | 45 s | `autopin/config.js` |
| `readyTimeoutMs` | **30 s** | `autopin/config.js` |
| `SETTLE_STABLE_MS` | 2,5 s | `autopin/browser.js` |
| `SETTLE_POLL_MS` | 0,5 s | `autopin/browser.js` |
| discovery `DEFAULT_TIMEOUT_MS` | 45 s | `controller/discovery/tiktok.js` |
| `PROTOCOL_TIMEOUT_MS` | 30 s | `autocomment/timeouts.js` |
| `serviceHealthMs` | 45 s | `controller/controller.js` |
| `botReadyMs` | 60 s | `controller/controller.js` |

---

## 4. Duplikasi dan serialisasi yang ditemukan

### 4.1 `status()` dan `products()` menjalankan pekerjaan halaman yang IDENTIK

`controller/discovery/tiktok.js`:

```
status()   → withPage → readObserved → verifyIdentity → collectProducts
products() → withPage → readObserved → verifyIdentity → collectProducts
```

Urutan dalam-halamannya sama persis. Yang berbeda hanya bentuk kembalian dan
**kebijakan gagal**:

| | `status()` | `products()` |
|---|---|---|
| identitas tidak cocok | dilaporkan sebagai field | **gagal tertutup** |
| katalog kosong | `productCount: 0` | **gagal `no-live-products`** |

Jadi keduanya bukan duplikat yang bisa digabung begitu saja — penggabungan naif
akan mengubah semantik gagal-tertutup. Yang bisa dibagi adalah **satu kali
pembacaan halaman**, dengan dua penafsiran di atasnya.

### 4.2 Katalog produk dibaca lima kali per START

Pembukaan halaman #3, #4, #5, #6, #10 semuanya menjalankan
`collectProducts()` atas profil yang sama, akun yang sama, halaman yang sama,
dalam rentang kurang dari dua menit.

### 4.3 Preflight dijalankan DUA KALI, berurutan

`POST /api/preflight` (#6) dan `preflight.run()` di dalam `startAutomation` (#10)
adalah dua preflight penuh yang terpisah beberapa detik. Yang kedua benar dan
wajib — server tidak boleh mempercayai klien soal kesiapan. Yang pertama ada
untuk menampilkan baris kesiapan di UI sebelum menyalakan.

### 4.4 Serialisasi dipaksa oleh kunci profil Chrome, bukan oleh `profile-owner.js`

Ini penting dan mudah salah dibaca.

`controller/profile-owner.js` hanya mengatur LOGIN vs AUTOMATION. **Discovery
tidak pernah `acquire()`.** Yang mencegah dua probe berjalan bersamaan adalah
Chrome sendiri: satu direktori profil dikunci ke satu proses, dan
`launchBrowser` menerjemahkan kegagalannya menjadi `profile-in-use`.

Akibatnya: **#3, #4, #5, #6, #10 TIDAK BISA diparalelkan** selama masing-masing
membuka browsernya sendiri. Paralelisasi di sini bukan optimasi — ia akan
membuat satu dari dua probe gagal. Jalan keluarnya bukan paralel, melainkan
**tidak membuka berkali-kali**.

`controller.js profileBusy()` juga menolak discovery saat service hidup, jadi
setelah RUNNING tidak ada kontensi baru.

### 4.5 Yang TIDAK duplikat, dan sebaiknya dibiarkan

- Scene OBS dibaca dua kali (#2 dan di dalam preflight), tapi lewat socket
  WebSocket, bukan browser. Biayanya milidetik.
- `cleanupOrphans`, `clearLockIfNoBot`, `acquire`, `arm`, `writeRuntimeConfig`:
  bersama-sama 1,06 detik. Tidak ada yang bisa diambil di sini.
- `waitBotReady` 3,06 detik adalah koneksi jaringan sungguhan ke TikTok.

---

## 5. Backlog optimasi, terurut

### P0 — penundaan paling terasa, risiko rendah

#### P0-1 · Satu pembacaan halaman untuk seluruh jalur START

**Apa:** satu snapshot katalog+identitas per siklus START, dipakai bersama oleh
status, products, validasi pemetaan, dan preflight. Implementasinya bisa cache
ber-TTL pendek di sisi server (mis. 60–90 detik) yang dikunci pada
`(profileDir, username)`, **dibatalkan paksa** saat: start, stop, login selesai,
config disimpan, dan saat kepemilikan profil berpindah.

**Manfaat:** menghapus 3–4 dari 5 pembukaan halaman. Perkiraan **45–60 detik**
dari 92 detik. Ini satu-satunya usulan yang mengubah angka besar.

**Risiko teknis:** sedang-rendah. Bahayanya bukan performa melainkan **katalog
basi**: pemetaan divalidasi terhadap daftar produk yang sudah berubah. Mitigasi:
TTL pendek, pembatalan eksplisit di lima titik di atas, dan **preflight di dalam
`startAutomation` TETAP membaca segar** (lihat P0-2 soal batasnya).

**Tes regresi yang dibutuhkan:**
- katalog dibaca tepat sekali untuk satu siklus START
- cache dibatalkan oleh: start, stop, login selesai, simpan config, perpindahan kepemilikan
- entri kedaluwarsa tidak pernah dipakai preflight
- identitas tidak cocok tetap gagal tertutup, dari cache maupun dari pembacaan segar
- katalog kosong tetap menghasilkan `no-live-products`
- cache tidak pernah dibagi antar profil atau antar username

**Dampak ke kepemilikan/AutoPIN/AutoComment/fail-closed:** tidak ada perubahan
semantik kepemilikan. Fail-closed harus dipertahankan dengan tes di atas — ini
bagian paling berisiko dari seluruh usulan dan tidak boleh dikerjakan terburu.

#### P0-2 · Hentikan menunggu halaman yang tidak akan pernah tenang

**Apa:** `waitForSettled()` menghabiskan 30 detik penuh pada setiap pembukaan
karena dashboard LIVE memang tidak pernah berhenti berubah. Gantikan "tunggu
sampai tenang" dengan "tunggu sampai yang DIBUTUHKAN muncul" — yaitu header
identitas dan baris produk pertama — dengan batas atas yang sama sebagai jaring.

**Manfaat:** memotong sebagian besar dari 30 detik per pembukaan. Berdiri
sendiri ia bisa memotong **20–25 detik**; digabung dengan P0-1 manfaatnya
sebagian tumpang tindih.

**Risiko teknis:** sedang. Ini menyentuh jalur yang dipakai `collectProducts()`
dan jalur pin. Membaca terlalu dini = daftar produk ter-virtualisasi belum
ter-render = **nol produk yang terlihat seperti etalase kosong**, yaitu mode
kegagalan paling berbahaya di sistem ini.

**Tes regresi:** jumlah produk identik antara `settled:true` dan jalur baru,
pada etalase kecil dan besar; headed dan headless; dan satu tes yang gagal kalau
pembacaan terjadi sebelum baris pertama ada.

**Dampak:** menyentuh jalur yang sama dengan AutoPIN. **Jangan dikerjakan
sebelum tes LIVE headless selesai** — lihat §7.

#### P0-3 · Jangan jalankan preflight dua kali berturut-turut

**Apa:** UI memanggil `POST /api/preflight` lalu `POST /api/start`, dan yang
kedua menjalankan preflight lagi. Buat `/api/start` mengembalikan hasil
preflight-nya sendiri, dan UI berhenti memanggil endpoint terpisah di jalur
START. Endpoint tetap ada untuk tombol pemeriksaan manual.

**Manfaat:** menghapus satu pembukaan halaman penuh, **~15–25 detik**.

**Risiko teknis:** rendah. Murni urutan pemanggilan di UI; tidak ada semantik
server yang berubah, dan preflight yang berwenang tetap yang di dalam
`startAutomation`.

**Tes regresi:** start yang gagal preflight tetap menampilkan baris kesiapan
yang sama; `/api/start` tidak pernah dipanggil saat preflight merah; tombol
pemeriksaan manual tetap bekerja.

**Dampak:** tidak ada. Fail-closed justru menguat — satu sumber kebenaran, bukan
dua yang bisa menyimpang.

---

### P1 — perbaikan berarti, risiko sedang

#### P1-1 · Jalankan check OBS dan TikTok bersamaan di dalam preflight

Keduanya tidak saling membutuhkan: satu socket, satu browser. `scenes` dan
`mappings` tetap menunggu keduanya.

**Manfaat:** beberapa detik (OBS biasanya cepat). Kecil, tapi gratis.
**Risiko:** rendah-sedang; urutan laporan check harus tetap stabil.
**Tes:** urutan `CHECK_NAMES` tidak berubah; kegagalan OBS dan kegagalan TikTok
sama-sama masih dilaporkan dengan sebab yang benar.
**Dampak:** tidak ada.

#### P1-2 · Mulai warmup browser service LEBIH AWAL

Service baru di-spawn pada #16, yaitu sesudah preflight selesai. Warmup
browsernya (±25–30 detik) berjalan di latar sesudah RUNNING. Kalau profil bebas,
warmup bisa dimulai lebih awal sehingga AutoPIN benar-benar siap saat RUNNING
diumumkan.

**Manfaat:** bukan mempercepat RUNNING, melainkan membuat RUNNING **jujur**.
**Risiko:** **tinggi** — ini langsung bertabrakan dengan kunci profil. Service
yang memanas lebih awal akan memegang profil yang masih dibutuhkan preflight.
**Tes:** tidak boleh ada dua pemegang profil; preflight tidak pernah gagal
`profile-in-use` karena warmup.
**Dampak:** menyentuh kepemilikan profil secara langsung. Hanya aman kalau
digabung dengan P0-1 (preflight tidak lagi membuka browser sendiri).

#### P1-3 · Laporkan RUNNING hanya setelah AutoPIN siap, atau katakan apa adanya

Terkait P1-2. Pilihannya dua: tunda RUNNING sampai `SERVICE_WARMED`, atau
tampilkan keadaan "siap sebagian" di UI. Yang pertama memperlambat angka; yang
kedua jujur tanpa biaya.

**Risiko:** rendah untuk opsi kedua.
**Dampak:** tidak ada perubahan mesin.

---

### P2 — kebersihan

- **P2-1** `status()` dan `products()` berbagi satu fungsi pembaca halaman,
  dengan dua penafsir di atasnya. Menghapus duplikasi kode, bukan waktu.
- **P2-2** `/api/obs/scenes` dibaca UI dan preflight terpisah. Murah, tapi bisa
  ikut satu snapshot.
- **P2-3** Catat durasi tiap tahap ke log dukungan (`PREFLIGHT_STAGE ms=`),
  supaya audit berikutnya tidak perlu merekonstruksi dari selisih stempel waktu.
- **P2-4** `navTimeoutMs` 45 s dan `readyTimeoutMs` 30 s tidak pernah tercapai
  bersamaan di jalur normal; keduanya bisa disatukan jadi satu anggaran yang
  dibaca sekali.

---

## 6. Model progres untuk MULAI BOT (usulan, belum diimplementasikan)

Hari ini tombol mati dan tidak ada apa pun selama 92 detik. Model yang jujur
memakai tahap yang **benar-benar ada** di rantai, bukan animasi:

| Urutan | Kalimat | Dipicu oleh |
|---|---|---|
| 1 | Memeriksa OBS | check `obs` dimulai |
| 2 | Memeriksa LIVE Anda | probe TikTok dimulai |
| 3 | Membaca produk | `collectProducts` dimulai |
| 4 | Memeriksa aturan | check `mappings` |
| 5 | Menyiapkan AutoPIN | service di-spawn, `SERVICE_READY` |
| 6 | Menyambung ke chat LIVE | bot di-spawn, menunggu `BOT_READY` |
| 7 | Siap | transisi RUNNING |

Tiga catatan desain:

- Tahap yang **dilewati** harus mengatakannya, bukan diam — konsisten dengan
  aturan kartu kesiapan yang sudah ada.
- Kalau sebuah tahap gagal, kalimatnya berhenti di tahap itu dan sebabnya tampil
  di sana. Itu memberi customer letak kegagalan, bukan hanya fakta kegagalan.
- Dengan P1-3, tahap 7 sebaiknya berbunyi "Siap — AutoPIN masih menyiapkan diri"
  selama warmup belum selesai, selama RUNNING masih diumumkan lebih dulu.

Implementasinya butuh server mengalirkan kemajuan (SSE atau polling tahap di
`/api/status`). Belum dikerjakan.

---

## 7. Apa yang harus menunggu tes LIVE headless

v0.1.1 mengubah runtime menjadi headless, dan **discovery produk belum pernah
divalidasi dengan LIVE menyala di mode headless**. Satu-satunya pengukuran
headless yang ada diambil saat LIVE mati, jadi `collectProducts()` mengembalikan
nol di kedua mode — paritas terbukti, kemampuan belum.

Karena itu:

| Usulan | Boleh dikerjakan sebelum tes LIVE? |
|---|---|
| P0-3 (hapus preflight ganda) | **ya** — murni urutan panggilan UI |
| P0-1 (satu pembacaan, cache ber-TTL) | **sebaiknya sesudah** — ia mengubah dari mana katalog berasal, dan katalog headless belum terbukti |
| P0-2 (ganti tunggu-tenang) | **TIDAK** — langsung menyentuh jalur baca produk yang sedang diuji |
| P1-1 (paralel OBS+TikTok) | ya |
| P1-2 (warmup lebih awal) | tidak — bertabrakan dengan kunci profil |
| P1-3 (kejujuran RUNNING) | ya |
| P2-* | ya |

Alasannya sederhana: tes LIVE berikutnya adalah pengukuran dasar untuk headless.
Mengubah jalur baca produk di waktu yang sama membuat kegagalan apa pun punya
dua tersangka.
