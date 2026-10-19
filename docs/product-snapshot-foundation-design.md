# Fondasi snapshot produk — catatan DESAIN

**Status:** DESAIN SAJA. Nol kode produksi, nol perubahan config, nol build, nol sentuhan artefak pilot. Tidak ada yang diimplementasikan di sini.
**Dasar:** `feat/v0.2.1-trigger-safety` @ `58b7115` (dokumen audit), kode produksi @ `0df032e` (build pilot v0.2.1).
**Prasyarat:** `docs/dynamic-product-price-audit-v0.2.1.md` — seluruh angka dan selector di catatan ini berasal dari sana, tidak diulang pembuktiannya.
**Cakupan:** fondasi internal supaya automation yang BERJALAN bisa mengekspos katalog produk baca-saja yang cukup segar. **Bukan** Q&A harga ke customer; itu fitur berikutnya.

---

## 1. Batas kepemilikan

Satu fakta yang menentukan seluruh desain: **profil Chrome itu pemilik-tunggal.**

```
automation BERJALAN   -> profileOwner=automation
                      -> Controller TIDAK bisa membuka profil
                      -> /api/tiktok/products balik ok=false count=0   (terbukti 2026-10-19)
```

| komponen | memegang browser? | boleh membaca katalog saat run? |
|---|---|---|
| Controller (`controller/discovery/tiktok.js`) | hanya saat automation **berhenti** | **tidak** |
| bot (`index.js`) | tidak pernah — sengaja tidak memuat Puppeteer | **tidak** |
| **service AutoPIN** (`autopin/service.js`) | **ya** — `ensurePage()` menjaga `page` tetap terbuka sepanjang run | **ya, satu-satunya** |

Jadi fondasinya **harus** dimiliki service. Membuka Chrome kedua dilarang bukan karena mahal, tapi karena profilnya terkunci satu proses — percobaan itu akan menjatuhkan jalur pin yang sedang bekerja.

Dan yang membuat ini murah: service **sudah** membaca katalog lengkap pada setiap pin.

```js
// autopin/service.js:338 — di dalam /pin, SEBELUM klik
const snapshot = await stage("collect-before", () => d.collectProducts(p, { remaining: left }));
```

Snapshot itu sengaja **tidak** dipotong anggaran (komentar di kode: koleksi sebelum klik harus lengkap, supaya "ambigu" tidak berubah menjadi "klik yang pertama ketemu"). Ia sudah memuat `price`, `stock`, `pinText`, dan seluruh field per baris. **Hari ini snapshot itu dibuang begitu pin selesai.**

Fondasi ini intinya satu kalimat: **simpan yang sudah dibaca, dan beri satu jalan baca-saja untuk memintanya.**

---

## 2. Arsitektur yang diusulkan

```
                     ┌──────────────────────── service AutoPIN (pemegang browser) ────┐
                     │                                                                 │
  /pin  ──────────►  │  runExclusive( collect-before ──► resolve ──► click ──► confirm )│
                     │                      │                                          │
                     │                      └─► simpan ke  lastCatalogue               │
                     │                                     { capturedAt, products,     │
                     │                                       coverage, source }        │
  GET /products ──►  │  runExclusive( baca lastCatalogue                               │
       (BARU)        │                [opsional] satu lintasan baca ulang viewport )    │
                     │                      │                                          │
                     └──────────────────────┼──────────────────────────────────────────┘
                                            ▼
                               bot (index.js) via autopin/client.js
                                            ▼
                             (nanti) intent PRICE + resolver + balasan
```

Tiga prinsip yang mengikat:

1. **Satu pemilik.** Hanya service menyentuh halaman. Controller dan bot tidak pernah.
2. **Satu antrean.** Pembacaan katalog lewat `runExclusive` yang **sudah ada** (`createSerialRunner()`, `service.js:126`) — sama dengan jalur pin. Tanpa itu, sebuah pembacaan bisa menyelip di tengah `collect → resolve → click → confirm` dan mengubah halaman di bawah tangan jalur pin. Ini bukan kehati-hatian berlebihan: `/pin` memang punya tahap `queue-wait`, yang berarti serialisasi itu sudah dianggap wajib.
3. **Baca-saja, dan dibuktikan oleh bentuknya.** Tidak ada klik, tidak ada navigasi, tidak ada `.pc_top_product`, tidak ada pin/unpin.

### Catatan penting soal "baca ulang yang ringan"

`collectProducts()` memanggil `resetScrollInPage` lalu menggulir sampai 14 gelombang. Itu **mengubah posisi gulir halaman** — bukan mutasi DOM, tapi juga bukan netral, dan di tengah run ia bergerak di halaman yang sama dengan jalur pin.

Jadi dua tingkat cakupan dibedakan **eksplisit**:

| `coverage` | cara | risiko | kapan |
|---|---|---|---|
| `"full"` | `collectProducts()` — menggulir, melihat semua baris | menggeser posisi gulir | hanya sebagai **efek samping** `/pin` yang memang sudah melakukannya |
| `"viewport"` | satu `page.evaluate(readProductsInPage)` — **tanpa** gulir | nol | penyegaran ringan `GET /products` |

Konsekuensi yang harus diterima: snapshot `"viewport"` bisa **tidak memuat** produk yang berada di bawah lipatan. Itu **tidak boleh** dijawab dengan "produk tidak ada" — harus dijawab `catalogue-partial`, dan lapisan di atasnya menolak menyebut harga. Lihat §7.

---

## 3. Skema yang diusulkan

```
GET /products  ->

{
  ok: true,
  capturedAt: 1761880912345,     // epoch ms, saat snapshot DIBACA dari halaman
  ageMs: 4120,                   // dihitung saat respons disusun
  fresh: true,                   // ageMs <= ttlMs — SATU definisi, di sini
  ttlMs: 30000,                  // digaungkan supaya pemanggil tidak menebak
  coverage: "full",              // "full" | "viewport"
  source: "pin-collect",         // "pin-collect" | "warmup" | "refresh"
  products: [
    {
      title: "Garuda - Kacang ATOM 16gr 1 RENCENG ISI 10 PCS oat - GRD",
      number: 1,                 // POSISI TERLIHAT — konteks saja, bukan identitas
      stableId: null,            // tetap null sampai DOM mengeksposnya
      currentPriceText: "Rp14.299",
      originalPriceText: "Rp23.000",
      priceRangeText: "",
      priceState: "sale",        // single | sale | range | unknown
      stockText: "In stock: 863",
      pinText: "Pin",
      pinAvailable: true
    }
  ]
}
```

Tiga aturan bentuk, dan masing-masing mencegah satu kelas kesalahan:

1. **Teks apa adanya, bukan angka hasil parse.** `"Rp14.299"`, bukan `14299`. Balasan yang menyebut persis apa yang tampil di layar lebih mudah dipercaya, dan kita tidak perlu mengambil keputusan soal lokal/pembulatan/mata uang hanya untuk menjawab "berapa".
2. **`""` berarti "tidak ada", bukan "tidak tahu".** Pembacaan yang gagal tidak boleh meninggalkan angka tebakan di field mana pun.
3. **Yang ambigu dibuat TIDAK BISA dikutip.** Kalau `priceState: "unknown"`, maka `currentPriceText` **wajib** `""`. Teks mentahnya boleh disimpan untuk diagnostik (`rawPriceTexts`, tidak untuk dikutip), tapi konsumen yang hanya membaca `currentPriceText` secara struktural tidak mungkin mengutip kartu yang tidak kita pahami. Fail-silent jadi sifat bentuknya, bukan disiplin pemanggil.

---

## 4. Semantik harga

Aturan klasifikasi **hanya** dari keadaan yang sudah teramati (audit §3). Tidak ada selector yang dikarang untuk keadaan yang belum pernah dilihat.

| kondisi DOM di dalam satu baris | `priceState` | `currentPriceText` | `originalPriceText` |
|---|---|---|---|
| tepat 1 elemen `[class*="text-body-l-medium"]` ber-Rp, dan **tidak ada** simpul Rp lain | `single` | teks elemen itu | `""` |
| tepat 1 elemen `text-body-l-medium` ber-Rp **+ tepat 1** simpul Rp redup (12px / weight 400 / `text-neutral-text4`) | `sale` | teks `text-body-l-medium` | teks yang redup |
| **apa pun selain itu** — 0 kecocokan, >1 kecocokan, kelas tak dikenal, teks berbentuk rentang, simpul Rp lebih dari dua | **`unknown`** | **`""`** | `""` |

Yang **sengaja tidak** dipakai sebagai penanda: `text-decoration` / `<del>` / `<s>` / `line-through`. Audit membuktikan harga pembanding **tidak** dicoret CSS (`text-decoration: none` pada keduanya) — pembedanya ukuran, berat, dan warna. Aturan berbasis garis coret akan gagal diam-diam di halaman ini.

`priceRangeText` ada di skema sebagai **tempat yang disengaja kosong**. Belum ada satu pun kartu yang menampilkan rentang — bahkan produk `[PILIH VARIAN RASA]` menampilkan satu harga. Mengisinya sekarang berarti mengarang.

---

## 5. Kebijakan kesegaran

Angka terukur yang jadi dasar (audit §6):

| | terukur |
|---|---|
| `waitForSettled` halaman dingin | **10.330 ms** |
| harga tersedia sesudah settle | **2 ms** |
| baca ulang +8 detik | **identik**, 0 dari 4 baris berubah |
| `page.evaluate` pada halaman yang sudah terbuka | ordo milidetik |

### TTL yang disarankan: **30 detik** untuk mengutip harga; **batas keras 120 detik** untuk mengembalikan data sama sekali.

Alasannya, dan bukan karena angkanya bagus:

- Pin terjadi setiap kali scene produk diputar, dan setiap pin menghasilkan snapshot `"full"` gratis. Pada LIVE yang aktif, snapshot biasanya jauh lebih muda dari 30 detik tanpa usaha apa pun.
- 30 detik cukup pendek sehingga harga yang dikutip masih yang dilihat penonton di layar yang sama.
- Di atas 120 detik, data dianggap **tidak ada** — bukan "tua". Perbedaan itu penting: `ok: false` memaksa penolakan, sedangkan `ageMs` besar mengundang pemanggil berikutnya untuk "ya sudahlah, pakai saja".

**Yang TIDAK dijanjikan TTL ini:** kesegaran promosi TikTok. Flash sale bisa berubah satu detik sesudah `capturedAt`, dan tidak ada TTL yang bisa menangkap itu. TTL hanya membatasi **seberapa tua data yang kita izinkan diri sendiri pakai** — ia bukan jaminan bahwa harga belum berubah. Kalau nanti akurasi harga menjadi janji produk, yang dibutuhkan bukan TTL yang lebih pendek melainkan pembacaan segar pada saat menjawab, dan itu konsekuensinya berbeda (lihat §9 langkah 5).

### Pengisian snapshot, dari termurah ke termahal

1. **`source: "pin-collect"`** — gratis. `/pin` sudah membacanya; cukup disimpan.
2. **`source: "warmup"`** — gratis. `warmUp()` sudah membuka halaman saat service start; satu lintasan baca di situ memberi snapshot awal sebelum pin pertama.
3. **`source: "refresh"`** — murah tapi tidak gratis. Satu `page.evaluate` tanpa gulir, lewat `runExclusive`, hanya kalau `ageMs > ttlMs`. Hasilnya `coverage: "viewport"`.

**Tidak pernah**: membuka browser/halaman baru dari jalur `GET /products`. Kalau halaman tidak terbuka, jawabannya `ok: false reason: "page-not-open"` — bukan membuka sesuatu.

---

## 6. API service

Rute yang ada sekarang: `/health`, `/pin`, `/comment/dry-run`, `/comment/send`, `/comment/send-once`, `/comment/send-once/publish`.

### Usulan: `GET /products`

`GET` dipilih dengan sengaja: ia baca-saja, dan satu-satunya `GET` yang sudah ada (`/health`) juga baca-saja. Seluruh rute yang mengubah sesuatu adalah `POST`. Konvensi itu sudah berlaku di berkas ini; mengikutinya membuat sifat rute terbaca dari metodenya.

**Parameter** (query, semuanya opsional):

| nama | arti | default |
|---|---|---|
| `maxAgeMs` | umur maksimum yang pemanggil mau terima | `ttlMs` service (30000) |
| `refresh` | `"never"` \| `"if-stale"` | `"if-stale"` |

**Respons sukses:** skema §3.

**Respons gagal — selalu `ok: false` + `reason`, tanpa `products`:**

| `reason` | kapan |
|---|---|
| `page-not-open` | service belum/tidak lagi memegang halaman |
| `no-snapshot` | belum pernah ada pembacaan sama sekali |
| `catalogue-stale` | umur melewati batas keras, dan penyegaran tidak diminta/gagal |
| `catalogue-partial` | `coverage: "viewport"` sementara pemanggil butuh kepastian daftar penuh |
| `service-error` | jaring terakhir, sama idiomnya dengan `/pin` |

**Otoritas dan keamanan:**

- Rute ini **tidak** perlu flag otoritas baru. Flag yang ada (`--enable-autocomment-send`, `--allow-comment-send-once`) menggerbang **aksi nyata**; rute ini tidak beraksi. Menambah flag untuk pembacaan akan mengaburkan arti flag yang sudah punya makna tajam: "boleh menyentuh akun customer".
- Service sudah mengikat ke `127.0.0.1` saja (`LOOPBACK`, `service.js:692`). Itu batas yang sama dengan rute lain, dan cukup.
- Satu hal yang **harus** diputuskan sadar: respons memuat judul produk dan harga — milik customer, tapi **bukan rahasia**: keduanya sudah terlihat penonton di etalase LIVE. Yang tidak boleh ikut: jalur profil, kelas DOM internal, `pinClass`, `icons`, `imageKey`. Pola penyempitannya sudah ada di `toPublicProduct` dan sebaiknya ditiru, bukan ditembus.

**Sisi bot:** `autopin/client.js` sekarang hanya mengenal `/pin` (`serviceUrl()` menempelkan `"/pin"`). Perlu satu pembaca sejenis (`createCatalogueReader`) dengan batas waktu sendiri yang **jauh lebih pendek** dari 8 detik milik pin — pembacaan katalog berada di jalur jawab-chat, dan tidak boleh menahan apa pun. Usulan: **1.500 ms**, dan habis waktu = `ok: false`, bukan menunggu.

---

## 7. Identitas produk

**`number` TIDAK boleh menjadi identitas.** Audit membuktikannya: ia dibaca dari `aria-valuenow`, yaitu **posisi terlihat**, dan posisi bergeser kalau daftar diurutkan ulang (`.pc_top_product` melakukan itu — karena itu modul produksi tidak pernah mengkliknya).

Urutan identitas yang disarankan:

1. **`stableId`** — begitu DOM mengeksposnya. Hari ini **selalu `null`**, dan field itu memang tidak pernah dikarang (`toPublicProduct`: *"null, dan tidak pernah dikarang"*). Biarkan di skema supaya saat ia muncul, tidak perlu mengubah bentuk.
2. **Judul yang dinormalkan** — `normalizeTitleKey()` dari `autopin/core.js:91`, **diimpor**, bukan disalin. Ini sudah jadi identitas de-facto di jalur pin, dan menyalinnya pasti menyimpang: pernah terjadi tepat begitu pada `normalizeTitleKey` di P2.
3. **`number`** — hanya konteks presentasi (mis. "etalase 1"), tidak pernah untuk mencocokkan.

### Bagaimana Product Resolver nanti harus mengidentifikasi produk

Yang **sudah ada** dan harus ditiru, bukan diganti: `resolveProductForPin()` (`core.js:104`). Perilaku intinya persis yang dibutuhkan:

```js
const matches = products.filter((p) => normalizeTitleKey(p.title).includes(want));
if (matches.length === 0) return { ok:false, reason:"product-not-found" };
if (matches.length  > 1) return { ok:false, reason:"ambiguous-product", count: matches.length };
```

**Nol cocok → menolak. Lebih dari satu cocok → menolak.** Tidak ada "ambil yang pertama".

Tapi ia **tidak boleh dipakai apa adanya** untuk harga, karena empat pemeriksaan terakhirnya menuntut **kontrol pin** yang sehat:

```js
if (!product.pinButtons)          return { ok:false, reason:"live-pin-control-not-available" };
if (product.pinButtons > 1)       return { ok:false, reason:"ambiguous-control" };
if (product.pinVisible === false) return { ok:false, reason:"control-not-visible" };
if (product.pinDisabled === true) return { ok:false, reason:"control-disabled" };
```

Produk **habis stok** mungkin tidak punya tombol pin tapi **tetap punya harga**, dan menolak menyebut harganya hanya karena ia tidak bisa di-pin adalah penolakan yang salah sebabnya.

Jadi usulannya: `resolveProductForQuery(products, titleKey)` — **mengimpor `normalizeTitleKey` yang sama** dan memakai logika 0/1/banyak yang sama, **tanpa** empat pemeriksaan kontrol pin. Dan pelajaran dari hotfix v0.2.1 berlaku penuh di sini: resolusi dari kalimat bebas penonton (`"garuda kacangnya"`) adalah masalah yang sama dengan trigger fuzzy, dan kita baru saja memperbaiki kelas kegagalan "nomor salah". **Menyebut harga produk yang salah lebih merusak daripada diam** — persis seperti mem-pin etalase 1 saat penonton meminta etalase 2.

---

## 8. Perilaku fail-closed

Satu aturan, berlaku di setiap lapisan: **kalau tidak yakin, jangan menjawab.**

| keadaan | yang dikembalikan fondasi | yang harus dilakukan lapisan jawaban nanti |
|---|---|---|
| halaman tidak terbuka | `ok:false reason:page-not-open` | diam |
| belum ada snapshot | `ok:false reason:no-snapshot` | diam |
| umur > batas keras | `ok:false reason:catalogue-stale` | diam |
| `coverage:"viewport"` & produk tidak ditemukan | `ok:false reason:catalogue-partial` | diam — **bukan** "produk tidak ada" |
| `priceState:"unknown"` | produk ada, `currentPriceText:""` | diam |
| resolver: 0 cocok | `product-not-found` | diam |
| resolver: >1 cocok | `ambiguous-product` | diam |
| `ageMs` di antara TTL dan batas keras | data **dengan** `fresh:false` | diam untuk kutipan harga; boleh dipakai untuk hal non-harga |

"Diam" di sini berarti tidak mengirim balasan harga sama sekali. Penonton akan bertanya lagi; harga yang salah tidak bisa ditarik kembali.

---

## 9. Alur Q&A harga di masa depan (BELUM diimplementasikan)

```
penonton: "garuda kacangnya berapa kak?"
    │
    ├─► intent PRICE                      (BELUM ADA)
    │       gagal/ragu  ──────────────────────────────► diam
    ├─► resolveProductForQuery(snapshot.products, …)   (BELUM ADA, pola dari core.js:104)
    │       0 cocok / >1 cocok ───────────────────────► diam
    ├─► GET /products  (fondasi ini)
    │       ok:false / fresh:false ───────────────────► diam
    ├─► priceState
    │       unknown / range ─────────────────────────► diam
    └─► currentPriceText
            │
            ▼
   "Harga yang tampil di etalase saat ini Rp15.800 ya kak 😊"
```

Kalimatnya sendiri sebaiknya **jujur tentang sumbernya** — "harga yang tampil di etalase saat ini" benar, dan tidak menjanjikan bahwa harga itu akan bertahan. Itu bukan sekadar gaya bahasa: ia satu-satunya klaim yang bisa kita dukung dengan bukti.

Interaksi dengan limiter yang sudah ada: balasan harga **tidak** menuntut bukti pin (`requirePin:false`), jadi ia berprioritas `NORMAL` seperti balasan FAQ, dan jam dua-limiter v0.2.0 berlaku apa adanya — balasan harga tidak akan pernah membungkam balasan pin produk. Tidak ada yang perlu diubah di sana.

---

## 10. Keadaan yang MASIH butuh bukti DOM

Ketiganya **belum pernah teramati satu kali pun**, dan tidak boleh ada selector yang dikarang untuknya. Sampai bukti ada, ketiganya jatuh ke `priceState: "unknown"` dan tidak akan pernah dikutip.

### Kartu flash sale / promo berlabel

Yang perlu ditangkap saat satu muncul:
- seluruh simpul ber-"Rp" di dalam baris: `tagName`, atribut `class` lengkap, `textContent`
- `getComputedStyle` setiap simpul itu: `fontSize`, `fontWeight`, `color`, `textDecorationLine`
- apakah elemen `[class*="text-body-l-medium"]` di baris itu masih **tepat satu**
- setiap elemen berlabel: `[data-tid="m4b_badge"]`, `[class*="badge"]`, `[class*="tag"]`, `[class*="promo"]`, `[class*="discount"]`, beserta teksnya
- `innerText` baris apa adanya, sebagai rujukan tata letak
- apakah ada penghitung waktu/countdown, dan apakah harga berubah tanpa reload selama diamati

### Kartu dengan rentang harga / varian berharga beda

- bentuk teksnya apa adanya: satu simpul `"Rp12.000 - Rp18.000"`, atau dua simpul terpisah dengan pemisah?
- kelas pembawanya: masih `text-body-l-medium` atau lain?
- apakah `clip(…, 40)` produksi memotongnya (rentang panjang bisa melewati 40 karakter)
- apakah ada harga pembanding **juga** di kartu yang sama (jadi tiga nilai Rp)

### Kartu habis stok / nonaktif

- `stockText` apa adanya (mis. `"Sold out"`? `"Out of stock"`?)
- apakah masih ada `button[data-pin-performance-source="product_card"]`, dan `pinDisabled` / `pinVisible`-nya
- apakah harga masih ditampilkan — ini yang menentukan apakah `resolveProductForQuery` benar-benar perlu lepas dari pemeriksaan kontrol pin
- apakah barisnya masih punya `[class*="stock-and-pin-button"]`, karena **itu anchor penemuan baris**; kalau tidak, kartu itu tidak akan terlihat sama sekali oleh `readProductsInPage`

Cara mengambilnya: sonda baca-saja yang sama dengan audit (`price-dom-probe.js` di scratchpad sesi) — Chrome bundel + profil customer + `waitForSettled` produksi, hanya membaca `textContent`/kelas/style, nol klik.

---

## 11. Rencana implementasi

Berurutan, dan setiap langkah bisa berhenti di situ tanpa menyisakan setengah fitur:

| # | langkah | sentuhan |
|---|---|---|
| 1 | pisahkan `currentPriceText` / `originalPriceText` / `priceState` di `readProductsInPage`, dengan aturan §4 dan `unknown` sebagai default aman | `autopin/products.js` + tes kontrak bentuk |
| 2 | sediakan `lastCatalogue` di service: diisi dari `collect-before` milik `/pin` dan dari `warmUp()`, dengan `capturedAt`, `coverage`, `source` | `autopin/service.js` |
| 3 | `GET /products` baca-saja, lewat `runExclusive`, dengan `maxAgeMs`/`refresh` dan seluruh `reason` fail-closed §6 | `autopin/service.js` |
| 4 | pembaca sisi bot (`createCatalogueReader`, batas waktu 1.500 ms) | `autopin/client.js` |
| 5 | kumpulkan bukti tiga keadaan §10 dari LIVE sungguhan — **bukan kode** | pengamatan |
| 6 | `resolveProductForQuery` (impor `normalizeTitleKey`, tanpa pemeriksaan kontrol pin) | `autopin/core.js` |
| 7 | baru sesudah itu: intent PRICE + balasan, dengan ambang kepercayaan ketat | fitur terpisah |

Langkah 1–4 adalah fondasi dan **tidak terlihat customer sama sekali** — tidak ada balasan baru, tidak ada perilaku LIVE yang berubah. Itu memang tujuannya: fondasi bisa dipasang, diuji, dan dikirim tanpa risiko ke pilot.

Versi: langkah 1–4 pantas jadi **v0.2.2** (fondasi internal, nol perubahan perilaku customer). Fitur Q&A harga adalah rilis tersendiri sesudah bukti §10 lengkap.

---

## 12. Rencana tes regresi

### Bentuk & klasifikasi harga (murni, tanpa browser)

- `single`: satu simpul Rp `text-body-l-medium` → `currentPriceText` terisi, `originalPriceText` `""`
- `sale`: dua simpul (16px/500 + 12px/400 redup) → keduanya terisi, yang redup **tidak pernah** jadi `currentPriceText`
- `unknown`: nol kecocokan, dua kecocokan `text-body-l-medium`, kelas tak dikenal, teks berbentuk rentang → `currentPriceText === ""` (**pagar utama**: yang ambigu tidak bisa dikutip)
- fixture DOM memakai kelas dan nilai style **nyata** dari audit, bukan karangan — lihat catatan "fake harus cocok produksi"
- pagar: aturan klasifikasi **tidak** boleh memakai `text-decoration`/`<del>`/`<s>`

### Snapshot & kesegaran (fake clock)

- `ageMs` dihitung saat respons, bukan saat capture
- `fresh` = `ageMs <= ttlMs`, dan `ttlMs` ikut di respons
- umur > batas keras → `ok:false reason:catalogue-stale`, **tanpa** `products`
- `source` dan `coverage` jujur: `pin-collect` → `"full"`, `refresh` → `"viewport"`
- snapshot lama **tidak pernah** dikembalikan sebagai `fresh:true`

### Batas kepemilikan & serialisasi

- `GET /products` **tidak pernah** memanggil `launchBrowser`/`ensurePage` yang membuka halaman baru; halaman tertutup → `page-not-open`
- pembacaan berjalan lewat `runExclusive`: pin yang sedang jalan dan pembacaan **tidak** pernah tumpang-tindih (uji dengan dua panggilan berbarengan + runner palsu yang mencatat urutan)
- penyegaran ringan **tidak** memanggil `resetScrollInPage` maupun menggulir
- nol klik di seluruh jalur: pagar tingkat sumber bahwa `GET /products` tidak menyentuh `PIN_BUTTON` maupun `TOP_CONTROL`

### Identitas

- `resolveProductForQuery`: 0 cocok → `product-not-found`; >1 cocok → `ambiguous-product`; **tidak pernah** memilih yang pertama
- ia memakai `normalizeTitleKey` yang **diimpor** (pagar: nol salinan normalisasi judul kedua di repo)
- produk tanpa kontrol pin **tetap** bisa di-resolve untuk pertanyaan harga
- `number` tidak pernah dipakai mencocokkan: dua produk dengan judul sama dan nomor berbeda → tetap `ambiguous-product`

### Pagar yang tidak boleh ikut berubah

- `toPublicProduct` Controller tetap seperti sekarang (fondasi ini milik service, bukan Controller)
- `/pin` tetap memakai snapshot `collect-before` yang **lengkap**, tidak tergantikan oleh snapshot cache
- `resolveProductForPin` tidak berubah sama sekali
- anggaran waktu `/pin` tidak terpengaruh oleh adanya rute baru

### Verifikasi mutasi yang diharapkan

- hapus pagar "`unknown` → `currentPriceText` kosong" → tes kutipan-ambigu merah
- izinkan `GET /products` mengembalikan snapshot basi → tes `catalogue-stale` merah
- lepas `runExclusive` dari jalur pembacaan → tes tumpang-tindih merah
- pakai `number` sebagai identitas → tes `ambiguous-product` merah
