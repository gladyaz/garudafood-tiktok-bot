# Dynamic Product Q&A — catatan DESAIN v0.3.0

**Status:** DESAIN/AUDIT SAJA. Nol kode produksi, nol perubahan config, nol build, nol sentuhan artefak pilot.
**Dasar:** v0.2.2 BEKU dan menjadi build pilot yang disarankan — `c5ae600`, installer `a1f53c0e…`, folder pilot `0.2.2/`.
**Cara:** jalur chat produksi dibaca dari sumber; matriks tabrakan dijalankan dengan **matcher + normalizer dari aplikasi TERPASANG v0.2.2**, indeks dari **config customer apa adanya**, dan **katalog 5 produk nyata** dari LIVE 2026-10-19 (`coverage=full`, `source=pin-collect`).
**Prasyarat:** `docs/product-snapshot-foundation-design.md`, `docs/dynamic-product-price-audit-v0.2.1.md`, `docs/trigger-matcher-audit-v0.2.0.md`.
**Cakupan fase pertama:** **hanya pertanyaan HARGA.** Stock Q&A tidak didesain untuk diimplementasikan di sini.

---

## 1. Jalur chat produksi hari ini

Dibaca dari `index.js` dan `autocomment/core.js`, bukan dari ingatan.

```
TikTok comment event
  │
  ├─ attachTikTokListeners  — gerbang chat: pesan bot sendiri, backlog, dan
  │                           antaran ulang TIDAK PERNAH sampai ke handleChat
  ▼
handleChat(data)                                        index.js:1400
  │  nickname, msgRaw = comment.toLowerCase().trim()
  ├─ noteViewerActivity()                               :1412   (hitungan sepi)
  ├─ recordUserMessage() -> check.muted ? return        :1415   (gerbang spam)
  ├─ msgNorm = normalizeForMatching(msgRaw)             :1421
  ├─ idx = fuzzyIndex()                                 :1422
  │
  ├─ LAPIS 1  matchPhrase(idx, msgRaw, msgNorm)         :1427
  │             ketemu -> matchAndEnqueue(rule, via) ; return
  │
  ├─ LAPIS 2  matchFuzzy(idx, msgNorm, threshold 0.55)  :1436
  │             ketemu -> matchAndEnqueue(rule,"fuzzy") ; return
  │
  └─ (jatuh ke bawah) return                            :1445-1446
     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
     TITIK SISIP PALING AMAN. Nol aksi terjadi di sini hari ini.
```

Lalu, kalau sebuah rule cocok:

```
matchAndEnqueue(rule, nickname, via)                    index.js:1394
  └─ enqueueTrigger(rule, nickname)
       ├─ rule TANPA scene  -> dispatchRuleOnly(rule)    :711  (jalan berdampingan
       │                                                        dengan playback;
       │                                                        tidak kena busy/queue/pause)
       └─ rule DENGAN scene -> antrean -> OBS switch -> dispatchAuxiliaries()
                                └─ runAuxiliaries(rule, key, scene, playId, requesters)  :617
                                     ├─ actions.autoPin  -> scenePin.requestPin()
                                     └─ actions.autoReply -> autoComment.requestComment({
                                          scene: key, playId, requesters, pin,
                                          requirePin: actions.autoPin,
                                          priority: autoPin ? HIGH : NORMAL })      :637-655
```

`requestComment()` (`autocomment/core.js:181`) menggerbang dalam urutan ini:

| # | gerbang | letak |
|---|---|---|
| 1 | `enabled` mati -> nol aksi, nol log | `:186` |
| 2 | `scene` kosong / `NEVER_COMMENTED` | `:189-197` |
| 3 | `playId` basi / duplikat | `:201-213` |
| 3.5 | **bukti pin** — dilewati oleh `requirePin:false` | `:233-250` |
| 3.6 | prioritas ditentukan **sesudah** gerbang pin | `:264-267` |
| 4 | **`format(scene)`** -> teks; gagal = DIAM | `:271-277` |
| 5 | rate limit global (`lastAnySentAt` / `lastHighSentAt`) | `:280-285` |
| — | jam dicatat saat **dispatch**, bukan saat sukses | `:299-301` |

Config customer hari ini: `autoCommentMaxPerMinute: 6`, `autoCommentMinIntervalMs: 5000`, `autoCommentTimeoutMs: 8000`.

### Satu temuan yang mengubah bentuk integrasi

**`format` itu BERKUNCI SCENE.** Di mode config ia adalah `runtime.formatSceneMessage(key)` yang mengembalikan balasan yang ditulis customer **untuk scene itu**, dan scene tanpa balasan membuat AutoComment DIAM dengan `no-reply-configured`. Jawaban harga **tidak punya scene** — ia tidak memutar apa pun.

Jadi Q&A tidak bisa menumpang `format(scene)`. Pilihan yang ada:

| opsi | akibat |
|---|---|
| scene sintetis `"QA-PRICE"` + cabang di formatter | formatter hanya kenal `PAX-N`; harus ditambah pengecualian, dan `NEVER_COMMENTED` serta validator Controller ikut terlibat |
| **`requestComment({ text })` yang melewati `format`** | satu field baru, eksplisit, dan `format` tetap satu-satunya sumber teks **berbasis scene** |

**Disarankan: opsi kedua.** `text` yang dioper eksplisit tidak mengaburkan arti `format`, dan jalur scene tidak berubah satu baris pun. Gerbang lain (rate limit, transport, panjang, karakter) tetap berlaku penuh — yang dilewati hanya pemilihan teks, bukan satu pun gerbang keselamatan.

Konsekuensi yang harus diterima sadar: `requirePin:false` wajib untuk Q&A (tidak ada pin yang dijanjikan), dan karena itu prioritasnya **selalu NORMAL** — `core.js:266` menurunkan `high` tanpa `requirePin` dan mencatatnya. Itu tepat: balasan harga tidak boleh pernah membungkam balasan pin produk.

---

## 2. Prioritas aturan — Q&A adalah CADANGAN

Prinsip yang diminta, dan yang sudah terwujud secara struktural oleh titik sisip:

```
1. aturan terkonfigurasi yang cocok   (matchPhrase, lalu matchFuzzy)   <- SUDAH ADA
2. cadangan Product Q&A               (disisipkan di index.js:1445)    <- BARU
3. tidak ada aksi
```

Q&A **tidak bisa** merebut komentar milik aturan terkonfigurasi, dan itu bukan karena disiplin pemanggil melainkan karena urutan kode: kedua lapis aturan `return` sebelum baris Q&A pernah tereksekusi. Dibuktikan oleh matriks §7 — 6 dari 34 kasus berhenti di lapis aturan, dan **nol** di antaranya bocor ke Q&A.

### Yang HARUS diketahui soal indeks matcher hari ini

Di **mode config**, `runtime/mappings.js` membangun `rules` **hanya dari `mappings`** (`:196-223`): `buildRuleFromMapping` memakai `keywords: triggersOf(mapping)`, dan scene yang tidak ada di config **tidak menghasilkan rule sama sekali**. Jadi indeks matcher yang HIDUP hari ini tepat lima aturan:

```
PAX-1[spill etalase 1]  PAX-2[no 2]  PAX-3[et 3]  PAX-4[et 4]  PAX-5[spill etalase 5]
```

**`cara order`, `ini ai ya`, dan `boikot ai` tidak cocok ke apa pun hari ini** — scene FAQ ORDER / FAQ JAWAB AI / BOIKOT AI tidak ada di config customer. Permintaan §8 menyebut ketiganya sebagai milik aturan FAQ; itu benar sebagai **prinsip**, tapi premisnya tidak berlaku pada config sekarang. Lihat [[trigger-config-mengganti-keyword]].

Akibatnya untuk desain ini justru menenangkan: ketiga frasa itu **tetap tidak dijawab Q&A** bukan karena ada aturan yang melindunginya, tapi karena tidak satu pun memuat isyarat harga. Terbukti di matriks: ketiganya `no-price-cue`. Dan begitu customer memetakan scene FAQ di dashboard, lapis 1/2 otomatis mengambilnya lebih dulu — tanpa perubahan apa pun pada Q&A.

---

## 3. Intent HARGA — deterministik, tanpa LLM

Bentuknya satu konjungsi, dan setiap suku punya tugas keselamatan yang berbeda:

```
PRICE  =  ada ISYARAT_HARGA
      AND tidak ada ISYARAT_BUKAN_HARGA
      AND tepat satu produk ter-resolve      <-- gerbang sebenarnya, lihat §4
```

### ISYARAT_HARGA — token utuh, bukan substring

Dicocokkan atas teks yang sudah lewat `normalizeForMatching` (huruf kecil, `[^\p{L}\p{N}]+` -> spasi, `wordNumberToDigit`), sebagai **token utuh** supaya "berapa" di dalam kata lain tidak ikut terhitung:

```
harga  harganya  hrg  hrga  harg
berapa  brp  brpa  brapa  berapaan  brapaan  berp
rp
```

### ISYARAT_BUKAN_HARGA — pemblokir intent lain

Kalau salah satu ada, PRICE **tidak berlaku**, walaupun isyarat harga juga ada:

| kelompok | token | kenapa |
|---|---|---|
| stok | `stok` `stock` `ready` `restock` `sisa` | intent STOCK, belum ada di v0.3.0 |
| etalase | `spill` `pin` | permintaan etalase, milik aturan terkonfigurasi |
| opini | `mahal` `murah` `enak` `suka` `bagus` `jelek` | bukan pertanyaan |
| bukan produk | `viewer` `viewers` `penonton` `nonton` `like` `follower` `subs` | "berapa viewer sekarang" |
| idiom | `diri` | "harga diri" |
| intent lain | `ongkir` `ongkos` `kirim` `voucher` `diskon` `promo` | PROMO/ongkir, belum ada |

### Satu aturan morfologi, dan hanya satu

Sufiks posesif `-nya` dilepas dari token **>= 6 huruf**: `kacangnya -> kacang`, `harganya -> harga`, `atomnya -> atom`. Ini **bukan** stemming umum — satu sufiks, satu aturan, batas panjang supaya `nya` sendiri dan kata pendek tidak rusak.

Alasannya terukur, bukan selera: tanpa aturan ini contoh tujuan Anda **`garuda kacangnya berapa kak` gagal** (ambigu antara #1 dan #2, karena judul memuat token `kacang` tapi bukan `kacangnya`). Dengan aturan ini ia menjawab `#1 Rp14.299`. Dijalankan atas 34 kasus matriks, aturan ini mengubah **tepat satu baris** dan tidak menyentuh satu pun dari delapan kasus negatif. Lihat §7.

### Rujukan nomor yang EKSPLISIT

Hanya kalau penonton menyebut penandanya sendiri: `nomor` `no` `nmr` `etalase` `urutan` `produk` **diikuti** angka 1–2 digit. `"berapa yang nomor 1"` dan `"harga produk nomor 2"` lolos; `"garuda 16gr berapa"` **tidak** memicu jalur nomor (angkanya bukan rujukan posisi).

### Hasil pada contoh yang Anda berikan

| harus LOLOS | hasil |
|---|---|
| `berapa harga garuda atom` | ✅ PRICE, #1 |
| `garuda atom berapa` | ✅ PRICE, #1 |
| `harga garuda kacang` | ✅ PRICE, #1 |
| `garuda kacangnya berapa kak` | ✅ PRICE, #1 *(butuh aturan `-nya`)* |
| `brp gery saluut` | ✅ PRICE — tapi **ambigu**, lihat §4 |
| `yang dalezz harganya berapa` | ✅ PRICE — produk tidak ada di etalase hari ini |
| `berapa yang nomor 1` | ✅ PRICE, #1 lewat nomor |

| TIDAK boleh lolos | ditolak oleh |
|---|---|
| `garuda enak` | `blocked:enak` |
| `aku suka garuda` | `blocked:suka` |
| `spill garuda` | `blocked:spill` |
| `garuda ada?` | `no-price-cue` |
| `garuda stok?` | `blocked:stok` |
| `garuda mahal banget` | `blocked:mahal` |
| `harga diri` | `blocked:diri` |
| `berapa viewer sekarang` | `blocked:viewer` |

**Delapan dari delapan tertolak. Nol positif palsu.**

---

## 4. Resolver produk

Sumbernya **hanya** snapshot service v0.2.2 (`GET /products`). Tidak ada Chrome kedua, tidak ada discovery Controller.

Urutan identitas, persis seperti yang diminta:

1. **`stableId`** — didahulukan di kode, tapi **dorman**: DOM TikTok tidak mengeksposnya dan `toSnapshotProduct` melaporkannya `null` tanpa pernah mengarang. Tidak ada cara penonton menyebutnya, jadi hari ini jalur ini tidak pernah aktif. Ia ada supaya saat `stableId` muncul, urutannya sudah benar.
2. **Tumpang-tindih token judul** — token pesan (buang stopword, buang isyarat harga, panjang >= 3, lepas `-nya`) dicocokkan sebagai **token utuh** ke token judul yang dinormalkan lewat `normalizeTitleKey()` **produksi** (diimpor, bukan disalin — lihat [[jangan-duplikasi-logika-lintas-lapis]]). Skor = jumlah token pesan yang ada di judul. Yang menang harus **satu-satunya pemegang skor tertinggi**.
3. **Alias produk eksplisit** — **tidak** untuk v0.3.0. Alias adalah config baru, UI baru, dan validasi baru; ia hanya layak dibangun kalau matriks nyata menunjukkan ada produk yang tidak bisa dirujuk tanpa alias. Hari ini tidak ada. Tempatnya disediakan di antarmuka (§9), isinya kosong.
4. **Nomor terlihat** — **hanya** kalau penonton menyebut penandanya eksplisit (§3). Nomor **tidak pernah** menjadi identitas tersimpan: ia dibaca dari `aria-valuenow`, yaitu posisi, dan posisi bergeser setiap kali daftar diurutkan ulang.

### Ambiguitas SELALU ditolak

```
0 kandidat        -> product-not-found     -> DIAM
>1 skor tertinggi -> ambiguous-product     -> DIAM
```

Tidak ada "ambil yang pertama", tidak ada "ambil yang skornya paling tinggi tipis". Ini aturan yang sama yang sudah dipercaya jalur pin (`resolveProductForPin`, `autopin/core.js:104`), dan pelajaran hotfix v0.2.1 berlaku penuh: **menyebut harga produk yang salah lebih merusak daripada diam**, persis seperti mem-pin etalase 1 saat penonton meminta etalase 2.

Pada katalog hari ini aturan itu langsung terbukti bekerja:

| pesan | kandidat | hasil |
|---|---|---|
| `garuda kacang` | #1 skor 2, #2 skor 1 | **resolve #1** |
| `garuda` | #1 skor 1, #2 skor 1 | **ambigu -> DIAM** |
| `gery saluut` | #3 skor 2, #4 skor 2 | **ambigu -> DIAM** |
| `dilan` | #5 skor 1 | resolve #5 |
| `ting ting` | #2 skor 2 | resolve #2 |

`gery saluut berapa` memang **tidak terjawab** hari ini, dan itu jawaban yang benar: etalase memuat **dua** produk Gery Saluut (#3 Family Pack, #4 Renceng). Satu-satunya cara menjawabnya aman adalah penonton mempersempit sendiri ("gery saluut renceng berapa") atau menyebut nomor.

### Kecukupan `coverage` — asimetri yang WAJIB ada

Ini kesimpulan keselamatan terpenting dari desain ini, dan ia turun langsung dari alasan yang sudah ditulis fondasi v0.2.2 sendiri.

| cara resolve | `coverage` minimum | alasan |
|---|---|---|
| token judul | **`full`** | pada `viewport`, produk kedua yang cocok bisa berada **di bawah lipatan**. "Ambigu" lalu berubah diam-diam menjadi "unik" — dan kita mengutip produk yang salah. Ini kelas kegagalan yang SAMA dengan `collect-incomplete-budget` di jalur pin. |
| nomor eksplisit | `viewport` **boleh** | nomor dibaca dari baris itu sendiri (`aria-valuenow`), jadi baris yang ADA di snapshot pasti baris yang benar. Resolver tetap menolak kalau nomor itu muncul lebih dari sekali (`ambiguous-number`). Yang mengancam di sini bukan cakupan melainkan kesegaran — nomor bergeser sesudah pin — dan itu sudah dijaga TTL 30 detik. |

**Konsekuensi operasional yang harus diterima:** hari ini hanya `source=pin-collect` yang menghasilkan `coverage=full`. `warmup` dan `refresh` keduanya `viewport`. Jadi Q&A berbasis **judul** akan DIAM sampai pin pertama run itu terjadi; Q&A berbasis **nomor** bekerja sejak warm-up. Pada LIVE jualan yang aktif, pin pertama terjadi dalam hitungan menit, jadi harga yang dibayar kecil — dan arah kegagalannya benar.

Jangan "memperbaiki" ini dengan menyuruh `GET /products` melakukan sapuan gulir 14 lintasan: ia menggeser posisi gulir halaman yang dipakai bersama jalur pin. Kalau nanti `coverage=full` tanpa pin memang dibutuhkan, ia butuh desainnya sendiri (mode `refresh=full` berbatas anggaran, dijadwalkan lewat `runExclusive`) dan **bukan bagian v0.3.0**.

---

## 5. Aturan keselamatan — kapan boleh mengutip

Mengutip harga hanya kalau **SEMUA** benar:

```
1. snapshot ok:true                         (bukan stale, bukan unavailable)
2. ageMs <= 30000                            (ambang kutip; dilaporkan apa adanya)
3. tepat SATU produk ter-resolve
4. coverage cukup untuk cara resolve-nya     (§4: judul -> full, nomor -> viewport)
5. priceState adalah single ATAU sale
6. currentPriceText tidak kosong
```

Kalau satu saja gagal: **jangan mengarang harga.**

| keadaan | yang dilakukan v0.3.0 |
|---|---|
| intent bukan PRICE | diam (tidak ada apa pun yang terjadi hari ini juga) |
| produk tidak ketemu | **diam** |
| produk ambigu | **diam** |
| snapshot stale (30–120 s) | **diam** |
| snapshot unavailable (>120 s / tidak ada) | **diam** |
| `coverage=viewport` tapi resolve lewat judul | **diam** |
| `priceState=unknown` (termasuk rentang & flash sale) | **diam** |
| `currentPriceText` kosong | **diam** |
| pembaca katalog habis waktu (1500 ms) | **diam** |

### Kenapa fail-silent, bukan klarifikasi

Untuk MVP v0.3.0 saya **menyarankan fail-silent penuh**, termasuk untuk kasus ambigu — walaupun klarifikasi terasa lebih ramah. Tiga alasan, dan tidak satu pun soal selera:

1. **Klarifikasi adalah balasan, dan balasan memakan kuota.** `minIntervalMs 5000` + `maxPerMinute 6` dibagi dengan balasan pin produk yang **berprioritas lebih tinggi dan menjanjikan sesuatu**. Satu "maksudnya yang mana kak?" bisa menunda balasan "Etalase 3 sudah aku pin" yang sedang dibutuhkan.
2. **Klarifikasi mengundang percakapan yang tidak kita punya.** Menjawab "yang Family Pack atau yang Renceng?" menjanjikan bahwa jawaban penonton berikutnya akan dipahami. v0.3.0 tidak punya state percakapan, jadi janji itu akan dilanggar di pesan berikutnya.
3. **Diam bukan kegagalan yang mahal di sini.** Penonton bertanya lagi, biasanya lebih spesifik. Harga yang salah tidak bisa ditarik kembali.

Satu pengecualian yang **layak dipertimbangkan setelah v0.3.0 terbukti**, bukan sekarang: ambigu dengan **tepat dua** kandidat yang keduanya punya nomor, dijawab satu kali dengan daftar nomor ("etalase 3 atau 4 ya kak?"). Itu deterministik dan singkat. Tetap ditunda karena ia butuh dedupe per-penanya agar tidak berubah jadi sumber spam.

---

## 6. Kesegaran dan kapan menyegarkan

Memakai Fondasi Snapshot Produk v0.2.2 apa adanya. **Tidak membuka browser kedua.**

```
pertanyaan harga masuk
  │
  ├─ GET /products?maxAgeMs=30000&refresh=if-stale      (pembaca sisi bot, batas 1500 ms)
  │    │
  │    ├─ cache SEGAR (ageMs <= 30 s)  -> dilayani tanpa menyentuh halaman     ~15 ms
  │    ├─ BASI (30–120 s)              -> satu lintasan baca lewat runExclusive ~20–35 ms
  │    │                                  hasilnya coverage=viewport
  │    └─ >120 s / tidak ada           -> ok:false -> DIAM
  │
  └─ habis waktu 1500 ms               -> DIAM
```

Kapan memakai apa, dan kenapa:

| situasi | tindakan | alasan |
|---|---|---|
| snapshot segar | **pakai cache** | nol pekerjaan halaman; pin tidak terganggu sama sekali |
| snapshot basi | **minta `refresh=if-stale`** | satu `page.evaluate`, tanpa gulir, lewat antrean yang sama dengan pin |
| snapshot >120 s | **tolak** | di atas batas keras datanya dianggap TIDAK ADA, bukan tua |
| pin sedang berjalan | **tolak lewat habis waktu** | pembacaan mengantre di belakang pin; terukur 4198 ms, jauh di atas 1500 ms -> pembaca menyerah, dan service tidak mengklik apa pun |

Catatan penting yang harus dibawa ke kalimat balasan: **TTL 30 detik tidak menjamin promosi TikTok tidak berubah.** Ia hanya membatasi seberapa tua data yang kita izinkan diri sendiri pakai.

### Harapan latensi (dari angka v0.2.2 yang SUDAH terukur)

| tahap | sumber angka | nilai |
|---|---|---|
| `GET /products` cache segar | installed, 120 panggilan | med **15,0 ms** · p95 **16,5 ms** · maks **19,9 ms** |
| `GET /products` basi -> segar | installed, 1 sampel | **20,2 ms** |
| idem, rig dev 30 panggilan | dev | med **30,3 ms** · p95 **32,1 ms** · maks **35,4 ms** |
| intent + resolver (murni, in-process) | 5 produk, ~10 token | **< 1 ms** (hanya operasi Set/string) |
| batas pembaca sisi bot | konstanta | **1500 ms** |
| pembacaan yang mengantre di belakang pin | installed | **4198 ms** -> dibatalkan di 1500 ms |

**Perkiraan kasus terburuk yang MASIH menjawab: ~1,5 detik** (batas pembaca). Jalur normal: **~20–35 ms** sebelum AutoComment, lalu gerbang `minIntervalMs 5000` menentukan apakah balasan benar-benar terkirim. Jadi yang membatasi pengalaman penonton bukan latensi pembacaan katalog melainkan kuota balasan — dan itu memang sudah menjadi kebijakan customer.

---

## 7. Matriks tabrakan — dijalankan atas katalog NYATA

Matcher + normalizer dari **aplikasi terpasang v0.2.2**. Indeks dari config customer apa adanya:
`PAX-1[spill etalase 1] PAX-2[no 2] PAX-3[et 3] PAX-4[et 4] PAX-5[spill etalase 5]`
Katalog: `#1 Rp14.299 · #2 Rp30.000 · #3 Rp25.500 · #4 Rp15.015 · #5 Rp15.900`

| teks penonton | ternormalkan | lapis | PRICE? | produk | hasil |
|---|---|---|---|---|---|
| `harga garuda atom berapa` | sama | qa-reply | ya | #1 | **JAWAB Rp14.299** |
| `garuda kacangnya berapa kak` | sama | qa-reply | ya | #1 | **JAWAB Rp14.299** *(butuh `-nya`)* |
| `berapa harga garuda` | sama | qa-decline | ya | #1,#2 | DIAM `ambiguous-product` |
| `garuda berapa` | sama | qa-decline | ya | #1,#2 | DIAM `ambiguous-product` |
| `gery saluut berapa` | sama | qa-decline | ya | #3,#4 | DIAM `ambiguous-product` |
| `berapa yang nomor 1` | sama | qa-reply | ya | #1 (nomor) | **JAWAB Rp14.299** |
| `berapa etalase 1` | sama | **rule** | n/a | — | **RULE PAX-1** fuzzy **0,63** |
| `harga produk nomor 2` | sama | qa-reply | ya | #2 (nomor) | **JAWAB Rp30.000** |
| `harga berapa` | sama | qa-decline | ya | — | DIAM `no-product-reference` |
| `berapa kak` | sama | qa-decline | ya | — | DIAM `no-product-reference` |
| `garuda enak` | sama | none | **tidak** | — | DIAM `blocked:enak` |
| `spill etalase 1` | sama | **rule** | n/a | — | **RULE PAX-1** (frasa) |
| `cara order` | sama | none | **tidak** | — | DIAM `no-price-cue` |
| `ini ai ya` | sama | none | **tidak** | — | DIAM `no-price-cue` |
| `boikot ai` | sama | none | **tidak** | — | DIAM `no-price-cue` |
| `brp gery saluut` | sama | qa-decline | ya | #3,#4 | DIAM `ambiguous-product` |
| `yang dalezz harganya berapa` | sama | qa-decline | ya | — | DIAM `product-not-found` |
| `aku suka garuda` | sama | none | tidak | — | DIAM `blocked:suka` |
| `spill garuda` | sama | none | tidak | — | DIAM `blocked:spill` |
| `garuda ada?` | `garuda ada` | none | tidak | — | DIAM `no-price-cue` |
| `garuda stok?` | `garuda stok` | none | tidak | — | DIAM `blocked:stok` |
| `garuda mahal banget` | sama | none | tidak | — | DIAM `blocked:mahal` |
| `harga diri` | sama | none | tidak | — | DIAM `blocked:diri` |
| `berapa viewer sekarang` | sama | none | tidak | — | DIAM `blocked:viewer` |
| `no 2` | sama | **rule** | n/a | — | **RULE PAX-2** |
| `et 3` | sama | **rule** | n/a | — | **RULE PAX-3** |
| `spill etalase 5` | sama | **rule** | n/a | — | **RULE PAX-5** |
| `harga et 3` | sama | **rule** | n/a | — | **RULE PAX-3** (frasa) |
| `dilan berapa` | sama | qa-reply | ya | #5 | JAWAB Rp15.900 |
| `oat crunch berapa` | sama | qa-reply | ya | #5 | JAWAB Rp15.900 |
| `ting ting berapa` | sama | qa-reply | ya | #2 | JAWAB Rp30.000 |

Ringkasan 34 kasus: **10 `qa-reply` · 7 `qa-decline` · 6 `rule` · 11 `none`**.

### Dua tabrakan yang harus dicatat terang-terangan

**`berapa etalase 1` DIAMBIL aturan PAX-1 lewat fuzzy, skor 0,63.** Penonton bermaksud menanyakan harga; yang ia dapat adalah scene PAX-1 diputar plus balasan "Etalase 1 sudah aku pin ya kak". Itu **bukan bug** — ia konsekuensi langsung dari prinsip prioritas yang Anda minta, dan hasilnya tetap berguna bagi penonton (produknya tampil). Tapi harus disadari: **lapis aturan akan menyerap sebagian pertanyaan harga** yang kebetulan mirip trigger. Hal yang sama terjadi pada `harga et 3` (frasa `et 3` termuat utuh).

Menyetel ini **bukan** pekerjaan v0.3.0. Mengecilkan jangkauan fuzzy demi Q&A berarti melemahkan recall trigger yang sudah terbukti — tukar yang salah arah. Catatan ini cukup, dan daftar yang disentuhnya terukur: dari 34 kasus, 6 berhenti di lapis aturan dan **2** di antaranya sebenarnya berintent harga.

**Delapan kasus negatif: nol dijawab. Empat trigger eksplisit: nol direbut.**

---

## 8. Bukti prioritas aturan tetap utuh

| frasa | diminta tetap milik | hasil terukur |
|---|---|---|
| `spill etalase 1` | PAX rule | ✅ `RULE PAX-1` (frasa) |
| `no 2` | PAX rule | ✅ `RULE PAX-2` |
| `et 3` / `et 4` / `spill etalase 5` | PAX rule | ✅ masing-masing rule-nya |
| `cara order` | FAQ ORDER | ⚠️ **tidak ada rule-nya di config hari ini** → Q&A juga tidak menyentuhnya (`no-price-cue`) |
| `ini ai ya` | FAQ JAWAB AI | ⚠️ idem |
| `boikot ai` | BOIKOT AI | ⚠️ idem |

Tiga baris terakhir adalah temuan §2, bukan kelemahan desain: begitu customer memetakan scene FAQ di dashboard, lapis 1/2 mengambilnya sebelum Q&A pernah dipanggil, tanpa satu pun perubahan di sisi Q&A. Yang membuat ini aman secara permanen adalah **urutan kode**, bukan daftar pengecualian yang harus dirawat.

Pagar yang harus ditulis sebagai tes, bukan sebagai niat:

- Q&A dipanggil **hanya** di jalur jatuh-bawah `handleChat`, sesudah kedua `return` lapis aturan.
- Untuk setiap trigger di config customer, teks trigger itu **tidak pernah** mencapai Q&A.
- Menambah mapping baru untuk scene apa pun **tidak** mengubah satu pun keputusan Q&A pada teks lain.

---

## 9. Perluasan ke intent lain (didesain, TIDAK diimplementasikan)

Antarmuka yang membuat STOCK / PRODUCT_POSITION / PROMO bisa ditambah nanti **tanpa** membongkar apa pun — dan tanpa menjadi agen LLM generik:

```js
// Satu intent = satu objek murni. Deterministik, tanpa jaringan, tanpa model.
{
  name: "PRICE",
  // token pemicu + pemblokir; dicocokkan atas teks yang sudah dinormalkan
  cues: Set<string>,
  blockers: Set<string>,
  // apa yang intent ini butuh dari snapshot sebelum boleh menjawab
  requires: {
    coverageForTitleMatch: "full",
    coverageForNumberMatch: "viewport",
    priceStates: ["single", "sale"],   // khusus PRICE
    maxAgeMs: 30000,
  },
  // produk -> teks, atau null kalau tidak boleh menjawab
  render(product, ctx): string | null,
}
```

Dispatcher-nya tetap sekeras hari ini: **urutan intent dinyatakan, bukan ditawar**, dan intent pertama yang cocok menang — persis idiom "yang pertama cocok menang" yang sudah dipakai `matchPhrase`. Yang **tidak** boleh ada: satu pesan memicu dua intent dan dua balasan.

v0.3.0 mendaftarkan **tepat satu** intent: `PRICE`. `STOCK` sudah punya pemblokirnya di §3 (`stok`, `ready`, `sisa`), jadi ia sudah "dipesan" tanpa diimplementasikan — dan itu disengaja: pertanyaan stok hari ini DIAM, bukan salah dijawab sebagai harga.

---

## 10. Kalimat balasan

### Rekomendasi

```
Harga etalase 1 yang tampil saat ini Rp14.299 ya kak 😊        (55/100 karakter)
```

Cadangan kalau produknya tidak punya nomor terlihat:

```
Harga yang tampil di etalase saat ini Rp14.299 ya kak 😊        (56/100)
```

### Kenapa menyebut NOMOR, bukan nama produk

Bukan selera — **struktural**. Judul produk hari ini mencapai **121 karakter** (#5), sementara anggaran balasan `MAX_LENGTH = 100` (satuan UTF-16, emoji di luar BMP bernilai 2). Menyebut judul utuh **mustahil** untuk sebagian produk, dan memotongnya akan menghasilkan rujukan yang justru membingungkan. Nomor etalase juga sudah menjadi cara LIVE ini bicara soal produk — balasan pin yang customer tulis sendiri berbunyi "Etalase 1 sudah aku pin ya kak". Konsisten dengan kalimat yang sudah dipakai lebih baik daripada memperkenalkan cara rujuk kedua.

Teks penonton **TIDAK PERNAH** dipantulkan ke balasan, sama seperti aturan yang sudah berlaku di `autocomment/formatter.js`.

### Kenapa "yang tampil saat ini", dan bukan "pasti"

`"Harganya pasti Rp14.299"` adalah klaim yang tidak bisa kami dukung: voucher, promo toko, dan flash sale bisa mengubah yang dibayar penonton, dan TTL 30 detik tidak menjamin promosi TikTok tidak berubah. `"yang tampil saat ini"` adalah **satu-satunya klaim yang didukung bukti** — kami benar-benar membaca angka itu dari etalase beberapa detik lalu, dan kami melaporkan `ageMs` untuk membuktikannya.

### Produk diskon: sebut harga sekarang SAJA

Rekomendasi: **jangan sebut `originalPriceText` di v0.3.0.** Empat alasan:

1. **Bukti kami lebih lemah untuk angka itu.** Kami tahu simpul 12px/400 redup itu harga pembanding; kami **tidak** tahu artinya — harga normal, harga sebelum diskon, atau MSRP. Menyebutnya adalah klaim kedua dengan dasar lebih tipis.
2. **Ia mengundang sengketa yang tidak bisa kami selesaikan.** "Kok di keranjang beda" jauh lebih mungkin muncul kalau kami menyebut dua angka.
3. **Anggarannya sempit.** Versi dua harga memakan 77/100 karakter; satu judul panjang atau satu harga 7 digit bisa mendorongnya ke batas, dan balasan yang kepanjangan DIAM (`too-long`) — gagal di tempat yang paling tidak terduga.
4. **Keputusannya bisa dibalik satu arah saja.** Menambahkan harga pembanding nanti itu aditif. Menarik kembali angka "sebelumnya" yang sudah terucap ke penonton tidak bisa.

Jadi #1 dijawab `Rp14.299` tanpa menyebut `Rp23.000`, walaupun `priceState=sale` dan kedua angka tersedia dan benar.

### Gerbang teks yang tetap dipakai ulang

Balasan Q&A **wajib** lewat pemeriksaan yang sama dengan balasan scene: `<>` dilarang, karakter kontrol dilarang, `MAX_LENGTH` 100, dan hasil kosong = DIAM. Fungsinya diimpor, bukan disalin.

---

## 11. Rencana implementasi

Berurutan, dan setiap langkah berhenti rapi tanpa menyisakan setengah fitur:

| # | langkah | sentuhan | terlihat penonton? |
|---|---|---|---|
| 1 | `qa/intent-price.js` — murni: cue, blocker, aturan `-nya`, rujukan nomor | berkas baru + tes | tidak |
| 2 | `qa/resolve-product.js` — token judul + nomor, impor `normalizeTitleKey`, tolak ambigu, gerbang `coverage` | berkas baru + tes | tidak |
| 3 | `qa/reply-price.js` — pembentuk teks, impor gerbang panjang/karakter dari `autocomment/formatter.js` | berkas baru + tes | tidak |
| 4 | `requestComment({ text })` — jalur teks eksplisit yang melewati `format`, gerbang lain tetap | `autocomment/core.js` | tidak |
| 5 | sisipkan di `handleChat` jatuh-bawah + `createCatalogueReader` + dedupe per-pertanyaan | `index.js` | **ya** |
| 6 | tag diagnostik + allowlist `child-trace` (sekalian bereskan backlog v0.2.2 item 1) | `controller/child-trace.js` | tidak |
| 7 | validasi LIVE sungguhan dari aplikasi terpasang | pengamatan | **ya** |

Langkah 1–4 **nol perubahan perilaku penonton** dan bisa dikirim sendiri. Langkah 5 adalah satu-satunya yang menyalakan fitur; ia pantas berdiri sebagai satu commit yang bisa dibalik.

**Yang masih harus diputuskan sebelum langkah 5:** dedupe per-pertanyaan. Q&A tidak punya `playId`, jadi gerbang stale/dedupe `requestComment` (`core.js:201-213`) **terlewat seluruhnya** — hanya rate limit yang menahannya. Usulan: kunci dedupe `(produk, menit)` supaya sepuluh penonton yang menanyakan produk yang sama dalam satu menit menghasilkan **satu** balasan, bukan enam sampai kuota habis. Tanpa ini, satu pertanyaan populer bisa menghabiskan seluruh `maxPerMinute` dan membungkam balasan pin produk.

Versi: langkah 1–4 pantas jadi **v0.2.3** (internal, nol perubahan perilaku). Langkah 5–7 adalah **v0.3.0**.

---

## 12. Rencana tes regresi

### Intent (murni, tanpa browser)

- tujuh contoh positif §3 → PRICE true, dengan cue yang tercatat
- **delapan contoh negatif §3 → PRICE false**, masing-masing dengan pemblokir yang benar (pagar utama)
- `harga diri` dan `berapa viewer sekarang` diuji **terpisah** dan dinamai, karena keduanya adalah jenis positif palsu yang paling memalukan
- cue dicocokkan sebagai **token utuh**: teks yang memuat "berapa" di tengah kata lain tidak memicu
- aturan `-nya` hanya berlaku pada token >= 6 huruf; `nya` sendiri tidak berubah
- rujukan nomor butuh penanda eksplisit: `garuda 16gr berapa` **tidak** memicu jalur nomor

### Resolver

- `garuda kacang` → #1; `garuda` → `ambiguous-product`; `gery saluut` → `ambiguous-product`
- 0 cocok → `product-not-found`; **tidak pernah** memilih kandidat pertama
- memakai `normalizeTitleKey` yang **diimpor** (pagar: nol salinan normalisasi judul kedua di repo)
- `coverage=viewport` + resolve judul → **ditolak**; `coverage=viewport` + nomor eksplisit → **diterima**
- `coverage=full` + resolve judul → diterima
- nomor ganda di snapshot → `ambiguous-number`
- produk `pinAvailable:false` tetap bisa di-resolve (warisan `resolveProductForQuery`)
- `stableId` diutamakan saat ada (dorman hari ini, tetap diuji)

### Keselamatan harga

- `priceState=unknown` → **diam**, dan `currentPriceText` memang kosong
- `currentPriceText` kosong dengan `priceState` terdukung → tetap diam
- `originalPriceText` **tidak pernah** masuk ke teks balasan v0.3.0
- stok tidak pernah bisa menjadi angka harga (sudah dipaku di v0.2.2; ditegaskan di lapis balasan)

### Kesegaran

- `ok:false` apa pun alasannya → diam
- `ageMs` 30 001 → diam walaupun `ok:false` membawa `coverage` dan `capturedAt`
- pembaca habis waktu → diam, dan **tidak melempar** ke `handleChat`
- `GET /products` **tidak pernah** memicu peluncuran browser dari jalur chat

### Prioritas aturan (pagar paling penting)

- untuk **setiap** trigger di config contoh, teks itu berhenti di lapis aturan dan Q&A **tidak pernah dipanggil** (dibuktikan dengan spy pada fungsi Q&A)
- `spill etalase 1` → PAX-1; `no 2` → PAX-2; `et 3` → PAX-3
- pagar tingkat sumber: pemanggilan Q&A di `handleChat` berada **sesudah** kedua `return` lapis aturan
- menambah mapping baru tidak mengubah keputusan Q&A untuk teks lain

### Balasan

- teks lolos gerbang `autocomment/formatter.js` (tanpa `<>`, tanpa karakter kontrol, <= 100)
- teks penonton **tidak pernah** muncul di balasan (uji dengan nickname dan komentar yang memuat token aneh)
- bentuk nomor dipakai saat `number` ada; bentuk cadangan saat `number` null
- balasan Q&A **selalu** `requirePin:false` dan karena itu **selalu** NORMAL — tidak pernah bisa mendahului balasan pin produk
- dedupe `(produk, menit)` menahan pertanyaan berulang

### Verifikasi mutasi yang diharapkan

- hapus satu pemblokir (`stok`) → tes `garuda stok?` merah
- izinkan resolver memilih kandidat pertama saat ambigu → tes `gery saluut` merah
- izinkan resolve judul pada `coverage=viewport` → tes cakupan merah
- pindahkan pemanggilan Q&A ke **atas** lapis aturan → tes prioritas merah
- izinkan `originalPriceText` masuk teks → tes balasan merah

---

## 13. Yang sengaja TIDAK dikerjakan di v0.3.0

- **Stock Q&A** — pemblokirnya sudah ada supaya pertanyaan stok DIAM, bukan salah dijawab sebagai harga.
- **PRODUCT_POSITION dan PROMO** — hanya tempat di antarmuka §9.
- **Alias produk** — belum ada bukti ada produk yang tidak bisa dirujuk tanpanya.
- **Klarifikasi ambigu** — ditunda sampai Q&A dasar terbukti; butuh dedupe per-penanya.
- **`coverage=full` tanpa pin** (mode `refresh=full`) — menggeser posisi gulir halaman yang dipakai jalur pin; butuh desain sendiri.
- **Penyetelan ambang fuzzy** supaya `berapa etalase 1` lolos ke Q&A — melemahkan recall trigger yang sudah terbukti.
- **LLM apa pun.** Semua keputusan di dokumen ini deterministik dan bisa dijalankan tanpa jaringan.

Tetap sengaja belum terselesaikan dari audit v0.2.0, dan tidak disentuh di sini: `boikot garuda`, `boikot`/`host` sendirian, negasi semantik, kebijakan ambang fuzzy, ekspansi slang, perbaikan Unicode/diakritik, klasifikasi intent umum.
