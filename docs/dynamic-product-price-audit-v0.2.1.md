# Audit harga produk dinamis — v0.2.1

**Status:** BACA-SAJA. Nol perubahan kode produksi, config, paket, dan artefak pilot. Nol klik di halaman TikTok.
**Dasar:** `feat/v0.2.1-trigger-safety` @ `0df032e60bf72bb0a14987541b81bf1b4ebc74c3` (build pilot yang disarankan, installer `0c7c8093…`).
**Tanggal:** 2026-10-19, LIVE sungguhan on air, 4 produk di etalase, akun `agen_mulia_abadi`.
**Cara:** dua sumber bukti — (1) jalur produksi apa adanya lewat `/api/tiktok/products`, (2) sonda DOM baca-saja memakai Chrome yang DIBUNDEL aplikasi terpasang, profil customer, dan `waitForSettled` produksi. Sonda hanya membaca `textContent`, kelas, dan style terhitung; tidak pernah mengklik, tidak pernah menyentuh `.pc_top_product`.

---

## 1. Ringkasan eksekutif

**Harga sudah diekstrak hari ini.** Ini bukan fitur yang perlu dibangun dari nol — `autopin/products.js` sudah membaca harga per baris produk, `toPublicProduct` sudah mengeluarkannya ke API, tes kontrak sudah memakunya, dan dashboard sudah **menampilkannya** ke customer sebagai baris kedua di dropdown produk.

**Dan ekstraksinya ternyata lebih tepat daripada dugaan awal.** Kekhawatiran yang masuk akal sebelum melihat DOM adalah "`querySelector` mengambil yang pertama, jadi harga coret bisa tertukar dengan harga jual". Bukti DOM membantah itu untuk keempat kartu: TikTok memakai **kelas tipografi yang berbeda** untuk harga sekarang dan harga pembanding, dan selector produksi hanya cocok dengan yang pertama — **tepat satu elemen per baris, di keempat baris**.

| | harga sekarang | harga pembanding |
|---|---|---|
| kelas | `text-body-l-medium` | `… text-neutral-text4 text-body-s ml-4` |
| ukuran | **16px** | 12px |
| berat | **500** | 400 |
| warna | `rgb(0, 0, 0)` | `rgba(0, 0, 0, 0.35)` |
| `text-decoration` | `none` | **`none`** — bukan dicoret CSS |
| cocok selector produksi | **ya** | tidak |

**Verdict: SAFE WITH SMALL EXTRACTION WORK.** Nilai harganya sudah benar dan sudah tersedia; yang belum ada adalah **jalan bagi bot untuk memintanya saat run berjalan**. Profil Chrome itu pemilik-tunggal, jadi saat automation jalan Controller tidak bisa membaca etalase (terbukti hari ini: panggilan produk balik kosong selagi `profileOwner=automation`). Satu-satunya komponen yang memegang browser saat run adalah **service AutoPIN** — dan ia sudah membaca seluruh baris produk beserta harganya pada setiap pin (tahap `collect-before`), tapi **tidak punya satu pun rute yang mengembalikannya**.

Kerja yang dibutuhkan karena itu kecil dan berbentuk jelas: satu rute baca-saja di service + pemakaiannya di sisi bot. Bukan scraping baru, bukan selector baru.

---

## 2. Arsitektur discovery produk sekarang

| # | langkah | berkas |
|---|---|---|
| 1 | `launchBrowser(config, PURPOSE.RUNTIME)` — headless wajib untuk runtime | `autopin/browser.js`, `autopin/browser-mode.js` |
| 2 | `openConsole(page, config)` → `page.goto(consoleUrl)` lalu `waitForSettled` | `autopin/browser.js:122` |
| 3 | `collectProducts(page, …)` — reset gulir, baca, lalu sampai 14 gelombang gulir dengan `settleMs=350` | `autopin/products.js:283` |
| 4 | `readProductsInPage(SELECTORS)` — dieksekusi DI DALAM halaman | `autopin/products.js:26` |
| 5 | `toPublicProduct(p)` — penyempitan untuk Controller/UI | `controller/discovery/tiktok.js:47` |
| 6 | `/api/tiktok/products`, `/api/discovery` | `controller/server.js:142`, `:225` |
| 7 | `productSubLabel(p)` → `"harga · stok"` di dropdown produk | `controller/public/ui-logic.js:166`, `app.js:540` |

### Selector yang dipakai produksi

```js
const NUMBER_INPUT = 'input[data-tid="m4b_input_number"]';
const ROW_MARKER   = '[class*="stock-and-pin-button"]';
const PIN_BUTTON   = 'button[data-pin-performance-source="product_card"]';
const TOP_CONTROL  = ".pc_top_product";   // diagnostik, TIDAK PERNAH diklik
// di dalam satu baris:
titleEl = row.querySelector('[class*="overflow-ellipsis"] span') || row.querySelector('[class*="overflow-ellipsis"]');
priceEl = row.querySelector('[class*="text-body-l-medium"]');       // <- HARGA
stockEl = row.querySelector('[class*="stock-and-ask-to-show"]');    // <- STOK
```

Baris produk di-anchor ke `[class*="stock-and-pin-button"]` lalu naik ke leluhur terbesar yang masih memuat **tepat satu** input nomor. Nomor produk dibaca dari `aria-valuenow` — nomor **terlihat**, yang bisa bergeser kalau daftar diurutkan ulang.

### Field yang diekstrak per produk

Internal (`readProductsInPage`): `number`, `rowInputs`, `title`, **`price`**, **`stock`**, `imageKey`, `productId` (selalu `""` — DOM tidak mengeksposnya), `pinButtons`, `pinDisabled`, `pinVisible`, `pinText`, `pinClass`, `topControls`, `icons`, `ariaOnRow`, `badges`.

Publik (`toPublicProduct`), dan ini **dipaku tes kontrak** di `controller.discovery.test.js:440` dan `controller.p2api.test.js:191`:

```
title, number, price, stock, pinText, pinAvailable, pinDisabled, stableId
```

**Jadi jawaban langsung untuk §1 pertanyaan Anda: ya, harga sudah diekstrak, dan `stock` serta `pinText` juga.** `price` dipotong 40 karakter, `stock` 60 karakter (`clip()`); harga nyata ~8 karakter, jadi pemotongan tidak pernah aktif hari ini.

---

## 3. Bukti DOM nyata

Keempat kartu, dibaca 2 ms sesudah `waitForSettled` selesai (`settled=true`, 10.330 ms):

### Kartu #1 — `Garuda - Kacang ATOM 16gr 1 RENCENG ISI 10 PCS oat - GRD`

```
teks baris apa adanya:
  "… Rp14.299 Rp23.000 In stock: 863 Pin Clicks 0 | Added to cart 0 | Attr. items sold 0"

elemen ber-"Rp" di kartu ini: 2
  "Rp14.299"  span  cls=text-body-l-medium                                  16px/500  rgb(0,0,0)        <- DIBACA PRODUKSI
  "Rp23.000"  span  cls=sc-eIcdZJ cSPnAS text-neutral-text4 text-body-s ml-4  12px/400  rgba(0,0,0,0.35)

selector produksi cocok: 1 elemen
stock: "In stock: 863"     pinText: "Pin"     badge/label: []
```

### Kartu #3 — produk VARIAN `[PILIH VARIAN RASA]`

```
teks baris apa adanya:
  "… [PILIH VARIAN RASA] - GRY Rp25.500 Rp49.999 In stock: 572 Pin Clicks 0 | …"

  "Rp25.500"  cls=text-body-l-medium        16px/500  rgb(0,0,0)        <- DIBACA PRODUKSI
  "Rp49.999"  cls=… text-neutral-text4 …    12px/400  rgba(0,0,0,0.35)

selector produksi cocok: 1 elemen
```

**Penting:** produk varian ini **tidak** menampilkan rentang harga. Ia menampilkan satu harga sekarang + satu harga pembanding, sama seperti produk non-varian yang sedang diskon.

### Kartu #2 dan #4 — tanpa diskon

```
#2 "GARUDA TING TING PEANUT BAR CANDY ISI 12"   Rp30.000   satu-satunya nilai Rp   stock "Low stock: 10"
#4 "Gery Saluut Malkist Renceng …"              Rp15.015   satu-satunya nilai Rp   stock "In stock: 35"
```

### Hasil jalur produksi (`/api/tiktok/products`)

```json
{"title":"Garuda - Kacang ATOM 16gr …","number":1,"price":"Rp14.299","stock":"In stock: 863","pinText":"Pin","pinAvailable":true,"pinDisabled":false,"stableId":null}
{"title":"GARUDA TING TING PEANUT BAR …","number":2,"price":"Rp30.000","stock":"Low stock: 10", …}
{"title":"[COD AFF] Gery - Gery Saluut …","number":3,"price":"Rp25.500","stock":"In stock: 572", …}
{"title":"Gery Saluut Malkist Renceng …","number":4,"price":"Rp15.015","stock":"In stock: 35", …}
```

Harga yang keluar dari API **identik** dengan nilai 16px/500 di DOM pada keempat kartu.

---

## 4. Semantik harga

Apa yang dibedakan halaman, berdasarkan bukti:

| jenis | ada di DOM? | cara membedakan |
|---|---|---|
| harga sekarang / jual | **ya** | `text-body-l-medium`, 16px, weight 500, hitam penuh |
| harga asli / pembanding | **ya** | `text-neutral-text4 text-body-s`, 12px, weight 400, hitam 35% — **selalu lebih besar nilainya** (23.000 > 14.299; 49.999 > 25.500) |
| dicoret (strikethrough) | **tidak** | `text-decoration: none` pada keduanya. Pembeda harga pembanding adalah **ukuran, berat, dan warna** — bukan garis coret. Ekstraksi yang mengandalkan `<del>`, `<s>`, atau `line-through` **tidak akan bekerja di sini.** |
| rentang harga | **tidak teramati** | bahkan pada produk `[PILIH VARIAN RASA]` |
| harga voucher | **tidak teramati** | tidak ada elemen bernilai Rp selain dua di atas |
| harga flash sale | **tidak teramati** | `badges: []` pada keempat kartu |
| harga per varian | **tidak teramati** | kartu varian hanya menampilkan satu harga sekarang |

**Nilai mana yang paling dekat dengan "harga yang tampil di etalase saat ini"?**

Yang 16px/weight-500/hitam-penuh — yaitu **tepat yang dibaca produksi hari ini**. Itu nilai yang dilihat penonton sebagai harga berlaku; yang satunya adalah harga sebelum diskon yang ditampilkan kecil dan redup di sebelahnya.

Dan sesuai peringatan Anda: **"teks pertama yang memuat Rp" bukan jawaban yang benar sebagai aturan**. Kebetulan di keempat kartu ini harga sekarang memang muncul lebih dulu, tapi yang membuat ekstraksi produksi tepat bukan urutannya — melainkan kelas tipografinya. Kalau suatu saat TikTok menukar urutan tata letaknya, aturan "yang pertama" akan salah sementara aturan "kelas `text-body-l-medium`" tetap benar.

---

## 5. Keandalan

| aspek | hasil |
|---|---|
| konsistensi selector | `[class*="text-body-l-medium"]` cocok **tepat 1 elemen** di **4 dari 4** baris. Nol baris dengan 0 kecocokan, nol baris dengan >1 |
| harga hilang | tidak ada; keempat kartu punya harga |
| beberapa nilai Rp dalam satu kartu | **ya, 2 dari 4 kartu** (yang sedang diskon). Yang kedua **tidak** cocok selector produksi |
| angka stok dekat harga | `stock` elemen terpisah (`stock-and-ask-to-show`), berisi angka tapi **tanpa "Rp"** → tidak bisa tertukar |
| angka lain di kartu | ada: `"Clicks 0 | Added to cart 0 | Attr. items sold 0"` — semuanya tanpa "Rp" dan di luar elemen harga |
| format lokal | harga `Rp14.299` (titik ribuan, gaya Indonesia); stok `"In stock: 863"` / `"Low stock: 10"` (**bahasa Inggris**). Satu halaman, dua lokal |
| perubahan DOM saat state berubah | **belum teruji** — tidak ada produk yang berubah harga/promo selama pengamatan |
| kartu tersembunyi/nonaktif | **belum teruji** — keempat kartu aktif, `pinDisabled=false`, `pinAvailable=true` |

**Apakah ada satu selector stabil?** Untuk keadaan yang teramati: **ya**. `[class*="text-body-l-medium"]` di dalam baris produk cukup, dan konteks strukturalnya (baris yang di-anchor ke `stock-and-pin-button`) sudah dilakukan produksi.

**Tapi keandalan itu belum terbukti lintas keadaan promo.** `text-body-l-medium` adalah kelas **tipografi**, bukan kelas semantik "harga". Ia bisa saja dipakai elemen lain di tata letak yang belum pernah kita lihat — misalnya kartu flash sale, kartu habis stok, atau kartu dengan rentang harga. Tiga keadaan itu belum ada bukti sama sekali.

---

## 6. Kesegaran

Terukur:

- `waitForSettled` → `settled=true` dalam **10.330 ms** sesudah `goto`
- harga **sudah ada 2 ms sesudah settle** — tidak ada render tertunda untuk harga
- baca ulang **+8 detik**: keempat harga, stok, dan jumlah nilai Rp **identik** (0 dari 4 baris berubah)

Biaya satu pembacaan segar: peluncuran browser + `goto` + settle (~10 s terukur) + gelombang `collectProducts`. Itu untuk halaman yang **belum** terbuka. Kalau halaman sudah terbuka (seperti di service saat run), biayanya hanya `page.evaluate` — ordo milidetik.

Batasan arsitektur yang menentukan: **profil Chrome itu pemilik-tunggal.** Terbukti hari ini — selagi `profileOwner=automation`, `/api/tiktok/products` mengembalikan `ok=false count=0`. Jadi saat LIVE berjalan, Controller **tidak bisa** membaca harga; hanya service AutoPIN yang bisa, karena ia yang memegang browser.

### Rekomendasi strategi kesegaran

**C — cache ber-TTL pendek, diisi oleh service AutoPIN.**

Alasannya:

- **bukan B (refresh tiap pertanyaan harga)**: kalau halaman belum terbuka, 10+ detik; dan selagi run jalan, Controller tidak punya akses profil sama sekali. Penonton yang bertanya harga tidak bisa menunggu selama itu, dan memaksa discovery kedua akan berebut profil dengan jalur pin.
- **bukan A saja (snapshot katalog terakhir)**: snapshot Controller dibuat **sebelum** START (saat preflight) dan tidak pernah diperbarui selama run. Satu jam ke dalam LIVE, ia bisa sangat basi — dan harga adalah hal yang paling tidak boleh basi saat diucapkan ke penonton.
- **C cocok dengan yang sudah ada**: service memanggil `collectProducts` pada **setiap** pin (tahap `collect-before`, `autopin/service.js:338`), dan snapshot itu sudah memuat `price` untuk semua baris. Jadi cache-nya praktis sudah terisi sendiri setiap kali ada pin; yang perlu ditambahkan hanya menyimpan snapshot terakhir beserta umurnya, plus pembacaan segar (murah, halaman sudah terbuka) kalau umurnya melewati TTL.

TTL yang masuk akal untuk dibahas nanti: puluhan detik, bukan menit. Dan kalau umur snapshot melebihi TTL **dan** pembacaan segar gagal, jawabannya harus **menolak menyebut harga** — bukan menyebut angka basi.

---

## 7. Risiko salah-baca, diurutkan

| # | risiko | status hari ini | tingkat |
|---|---|---|---|
| 1 | **harga asli terbaca sebagai harga jual** | tidak terjadi: kelasnya berbeda dan selector produksi tidak cocok dengannya. Tapi inilah kesalahan **termahal** — menyebut Rp23.000 padahal penonton melihat Rp14.299 | **TINGGI** (dampak), rendah (peluang hari ini) |
| 2 | **keadaan promo yang belum pernah dilihat** (flash sale, rentang harga, varian berharga beda) mengubah tata letak dan membuat `text-body-l-medium` menunjuk elemen lain | belum ada bukti sama sekali; nol badge teramati | **TINGGI** (ketidaktahuan) |
| 3 | **kelas tipografi dipakai elemen non-harga** di kartu jenis lain, sehingga `querySelector` mengambil yang bukan harga | 4/4 baris cocok tepat 1 elemen; belum teruji di kartu habis stok/nonaktif | **SEDANG** |
| 4 | **harga basi** disebut sebagai harga sekarang | nyata kalau memakai snakshot pra-START (lihat §6) | **SEDANG**, bisa dihilangkan oleh TTL + penolakan |
| 5 | **nomor produk bergeser** antara pembacaan dan jawaban (nomor itu `aria-valuenow`, posisi terlihat) sehingga harga benar diberi label produk salah | nyata secara struktural; `stableId` memang `null` karena DOM tidak mengeksposnya | **SEDANG** — jawaban sebaiknya mengacu **judul**, bukan nomor |
| 6 | stok tertukar dengan harga | elemen terpisah dan tanpa "Rp" | **RENDAH** |
| 7 | angka analitik (`Clicks 0`, `Added to cart 0`) tertukar dengan harga | di luar elemen harga, tanpa "Rp" | **RENDAH** |
| 8 | nilai voucher tertukar dengan harga | tidak teramati sama sekali | **RENDAH**, tapi belum terbukti |
| 9 | `clip(…, 40)` memotong harga | harga ~8 karakter; hanya relevan kalau suatu saat ada rentang panjang | **RENDAH** |

---

## 8. Bentuk data yang diusulkan (belum diimplementasikan)

Bentuk sekarang sudah membawa `price` sebagai **satu string apa adanya**. Yang kurang adalah pembedaan eksplisit, supaya lapisan jawaban tidak perlu menebak:

```
{
  title,                 // sudah ada
  number,                // sudah ada — posisi TERLIHAT, bisa bergeser
  currentPriceText,      // = `price` sekarang: 16px/500, hitam penuh
  originalPriceText,     // BARU: 12px/400, hitam 35% — "" kalau tidak ada diskon
  priceRangeText,        // BARU: "" sampai ada bukti rentang; jangan dikarang
  stockText,             // = `stock` sekarang
  pinAvailable,          // sudah ada
  pinText,               // sudah ada
  priceReadAt            // BARU: kapan dibaca, supaya TTL bisa dinilai pemanggil
}
```

Tiga prinsip yang saya sarankan mengikat bentuk ini:

1. **Teks apa adanya, bukan angka hasil parse.** Simpan `"Rp14.299"`, jangan `14299`. Parsing memaksa keputusan soal lokal, pembulatan, dan mata uang yang tidak perlu diambil untuk menjawab "harganya berapa" — dan kalimat jawabannya justru lebih dipercaya kalau menyebut persis apa yang tampil di layar.
2. **`""` berarti "tidak ada", bukan "tidak tahu".** Kalau pembacaan gagal, field-nya tidak boleh berisi angka tebakan. Lapisan jawaban harus bisa memilih diam.
3. **Jangan tambahkan field yang belum ada buktinya.** `priceRangeText` masuk daftar hanya sebagai tempat yang disengaja kosong sampai ada kartu yang benar-benar menampilkan rentang. Mengisi sesuatu yang belum pernah dilihat adalah cara tercepat menyebut harga yang salah.

---

## 9. Kelayakan balasan harga dinamis

### Verdict: **SAFE WITH SMALL EXTRACTION WORK**

Yang **sudah** ada:

- nilai harga sekarang, benar, dari selector yang membedakan harga jual dari harga pembanding (4/4 kartu)
- ia sudah melewati jalur produksi sampai API dan UI, dan bentuknya dipaku tes kontrak
- service AutoPIN sudah membaca seluruh baris + harga pada setiap pin (`collect-before`)
- harga tersedia segera sesudah settle dan stabil pada pembacaan ulang

Yang **belum** ada, dan inilah "small extraction work"-nya:

1. **Rute baca-saja di service AutoPIN** (mis. `GET /products`) yang mengembalikan snapshot terakhir + umurnya, atau membaca segar dari halaman yang sudah terbuka. Tanpa ini bot tidak punya cara meminta harga saat run berjalan — Controller tidak bisa karena profil pemilik-tunggal.
2. **Pemisahan `currentPriceText` / `originalPriceText`** di `readProductsInPage`, supaya kartu diskon tidak pernah bisa menjawab dengan nilai pembanding bahkan kalau tata letaknya berubah.
3. **Cap waktu + TTL** (§6) dan aturan "lebih baik diam daripada menyebut harga basi".
4. **Bukti untuk tiga keadaan yang belum pernah dilihat**: flash sale, rentang harga, kartu habis stok/nonaktif. Ini bukan kode — ini pengamatan yang harus dikumpulkan dari LIVE sungguhan sebelum fitur ini dinyalakan untuk customer.

### Alur yang dibayangkan (TIDAK diimplementasikan di audit ini)

```
penonton: "garuda kacangnya berapa kak?"
   -> deteksi intent PRICE          (belum ada)
   -> resolusi produk               (belum ada; harus mengacu JUDUL, bukan nomor)
   -> baca harga sekarang           (ada; butuh rute service + TTL)
   -> balas
"Harga yang tampil di etalase saat ini Rp14.299 ya kak 😊"
```

Catatan yang relevan dari audit matcher sebelumnya (`docs/trigger-matcher-audit-v0.2.0.md`): resolusi produk dari kalimat bebas seperti `"garuda kacangnya"` adalah **masalah yang sama** dengan trigger fuzzy, dan di sana kita baru saja memperbaiki kelas kegagalan "nomor salah". Resolver produk untuk harga harus belajar dari itu: **lebih baik tidak menjawab daripada menyebut harga produk yang salah.** Menyebut Rp30.000 untuk produk yang harganya Rp14.299 lebih merusak daripada diam, persis seperti mem-pin etalase 1 saat penonton meminta etalase 2.

### Langkah implementasi berikutnya, kalau diteruskan

1. kumpulkan bukti DOM untuk flash sale / rentang / habis stok (pengamatan, bukan kode)
2. pisahkan `currentPriceText` dan `originalPriceText` + tes kontrak bentuk baru
3. rute `GET /products` baca-saja di service + cap waktu
4. TTL + aturan menolak menjawab saat basi/gagal
5. baru sesudah itu: intent PRICE dan resolver produk, dengan ambang kepercayaan yang ketat
6. validasi LIVE terpaket, pola yang sama seperti v0.2.0/v0.2.1

---

## 10. Lampiran — cara bukti ini diambil

- `/api/tiktok/products` dipanggil lewat Controller aplikasi **terpasang** (v0.2.1), jalur produksi apa adanya
- sonda DOM: `puppeteer-core` + **Chrome yang dibundel aplikasi terpasang** (`resources/runtime/browser/chrome.exe`) + profil customer (`%APPDATA%\AI LIVE HOST\browser-profile`) + `waitForSettled` **produksi**
- baris produk ditemukan dengan algoritma yang **sama** dengan produksi (anchor `stock-and-pin-button`, naik ke leluhur dengan tepat satu input nomor)
- sonda hanya membaca: `textContent` simpul teks sendiri, `class`, dan `getComputedStyle` (`textDecorationLine`, `color`, `fontSize`, `fontWeight`)
- dua kali baca, jeda 8 detik, untuk menilai kesegaran dan kestabilan
- nol klik, nol navigasi selain `goto` ke dashboard, nol sentuhan pada `.pc_top_product`, nol perubahan state
- berkas bukti mentah ada di direktori scratchpad sesi (`price-dom-read1.json`, `price-dom-read2.json`) — di luar repo
