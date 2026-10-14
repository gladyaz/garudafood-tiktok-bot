# Audit `waitForSettled()` dan kesiapan halaman TikTok — v0.1.1

**Sifat:** BACA-SAJA. Tidak ada kode produksi yang diubah, tidak ada selektor
yang diubah, tidak ada build, tidak ada perubahan discovery reuse maupun
kebijakan headless.

**Tanggal:** 2026-10-14
**Commit saat audit:** `2ac837f` (sesudah P0-3 dan discovery reuse)
**Kondisi mesin:** TikTok LIVE **MATI**, OBS **tidak berjalan**, app terpasang
`A763D20E…`, profil customer asli, runtime headless.

> **Kesimpulan paling penting lebih dulu.** Hipotesis yang mendasari permintaan
> ini — "halaman sering menunggu hampir sepenuh timeout karena konten terus
> berubah" — **tidak terbukti pada pengukuran hari ini**. Dengan LIVE mati,
> `waitForSettled()` justru selesai dalam **5,3–5,7 detik** dengan
> `settled=true`, hanya ~2,8 detik di atas lantai teoretisnya. Dan kondisi
> pengganti berbasis konten yang disarankan di permintaan, kalau diterapkan apa
> adanya, akan membuat jalur ini **jauh lebih lambat**, bukan lebih cepat —
> karena saat LIVE mati penanda produk **tidak pernah muncul sama sekali**.
> Rinciannya di §3 dan §6.

---

## 1. Algoritma tunggu saat ini

`autopin/browser.js:96`

```js
async function waitForSettled(page, timeoutMs) {
  const start = Date.now();
  let lastLen = -1;
  let stableSince = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (page.isClosed()) throw new AutoPinError("NOT_READY", "page-closed");
    let len;
    try {
      len = await page.evaluate(() => (document.body ? document.body.innerText.length : 0));
    } catch (err) {
      if (!NAVIGATION_ERROR_RE.test(err.message)) throw err;
      len = -1;                       // redirect di tengah polling = masih berubah
    }
    if (len !== lastLen) {
      lastLen = len;
      stableSince = Date.now();
    } else if (len > 0 && Date.now() - stableSince >= SETTLE_STABLE_MS) {
      return { settled: true, ms: Date.now() - start };
    }
    await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
  }
  return { settled: false, ms: Date.now() - start };
}
```

### Aturan yang berlaku

| Konstanta | Nilai | Berkas |
|---|---|---|
| `SETTLE_POLL_MS` | 500 ms | `autopin/browser.js:12` |
| `SETTLE_STABLE_MS` | 2.500 ms | `autopin/browser.js:13` |
| `readyTimeoutMs` | 30.000 ms | `autopin/config.js:60` |
| `navTimeoutMs` | 45.000 ms | `autopin/config.js:59` |

### Kondisi kembali lebih awal — PERSIS

Hanya satu: `document.body.innerText.length` **identik** pada dua polling
berurutan, nilainya **> 0**, dan sudah bertahan **≥ 2.500 ms**. Tidak ada
kondisi lain. Tidak ada selektor, tidak ada pemeriksaan konten.

Konsekuensi yang perlu disadari:

* Yang dibandingkan **PANJANG**, bukan isi. Jam yang berdetak
  `12:34` → `12:35` **tidak** menghalangi settle (panjangnya sama). Yang
  menghalangi adalah perubahan panjang: jumlah penonton `999` → `1000`, chat
  yang bertambah, baris produk yang masuk.
* Lantai waktunya **2,5 detik**, apa pun yang terjadi. Halaman yang sudah siap
  dalam 300 ms tetap menunggu 2,5 detik.
* Gagal settle **TIDAK melempar**. `openConsole` mengembalikan
  `{ settled: false, readyMs }` dan pemanggil lanjut saja.

---

## 2. Setiap pemanggil

Satu definisi, satu pemanggil langsung:

| Pemanggil | Berkas | Keterangan |
|---|---|---|
| `openConsole()` | `autopin/browser.js:128` | satu-satunya pemanggil `waitForSettled` |

`openConsole()` dipakai empat jalur produksi:

| Jalur | Berkas | Memakai hasil `settled`? |
|---|---|---|
| service (dashboard produk) | `autopin/service.js:164` | **tidak** — hanya dicatat |
| service (tab chat) | `autopin/service.js:176` | **tidak** — hanya dicatat |
| discovery (status/products/snapshot) | `controller/discovery/tiktok.js:113` | **tidak** — hasilnya dibuang |
| login manual | `controller/login.js:145` | **tidak** — hasilnya dibuang |
| CLI dev | `autopin-cli.js:61`, `:74` | tidak |

### Temuan 2.1 — `settled` tidak pernah dipakai untuk mengambil keputusan

Pencarian seluruh repo atas `.settled`:

```
autopin/service.js:165   log("SERVICE_PAGE_READY", { url, settled: info.settled, readyMs })
autopin/service.js:184   log(..., { url, settled: info.settled, readyMs, ... })
```

Itu saja. Dua-duanya **log**. Tidak ada satu pun percabangan, retry, atau
penolakan yang bergantung padanya. (`settled` di `controller/preflight.js:47`
dan `controller/server.js:354` adalah variabel lokal yang **tidak berhubungan** —
penjaga sekali-jalan.)

**Artinya:** waktu tunggu ini membeli sebuah boolean yang tidak dibaca siapa
pun. Nilainya bukan "gerbang keselamatan", melainkan **jeda sebelum membaca** —
yang memang berguna (memberi halaman kesempatan merender), tapi ia tidak
menjamin apa pun dan tidak menolak apa pun.

---

## 3. Bukti waktu terukur

### 3.1 Probe hari ini — LIVE mati, headless, fungsi produksi

Tiga jalan, memakai `launchBrowser(PURPOSE.RUNTIME)`, `getPage`, `page.goto`
yang sama dengan `openConsole`, lalu `collectProducts` dan `readIdentity`
produksi sebagai pengukur "konten sudah bisa dibaca".

| Tonggak (ms sejak `launchBrowser`) | run 1 | run 2 | run 3 |
|---|---|---|---|
| browser siap | 328 | — | — |
| `domcontentloaded` | 764 | — | — |
| URL dashboard benar | 764 | — | — |
| **`collectProducts` sudah menjawab** | **1.190** | **1.401** | **1.278** |
| **identitas terbaca** | **1.481** | **2.882** | **1.840** |
| `waitForSettled` selesai | 6.417 | 6.114 | 6.045 |
| `settled` | **true** | **true** | **true** |
| `waitForSettled.ms` | 5.652 | 5.343 | 5.307 |

Jejak panjang `innerText` (run 1): `0` pada t+1,2 s → `1175` pada t+5,0 s, dan
**hanya 1–2 perubahan panjang dari 6–7 sampel**. Halaman ini, dengan LIVE mati,
**sangat tenang**.

### 3.2 Log produksi — LIVE menyala

Satu-satunya tempat `settled` tercatat adalah service. Semua kejadian yang ada
di log dukungan:

| Waktu | Peristiwa | `settled` | `readyMs` |
|---|---|---|---|
| 2026-10-08 11:30:41 | `SERVICE_PAGE_READY` | **true** | 9.957 |
| 2026-10-08 11:30:53 | `SERVICE_CHAT_PAGE_READY` | **true** | 12.081 |
| 2026-10-09 10:08:35 | `SERVICE_PAGE_READY` | **true** | 20.461 |
| 2026-10-09 10:08:51 | `SERVICE_CHAT_PAGE_READY` | **true** | 15.652 |

Empat-empatnya **settled=true**, bukan timeout. Tapi 10–20,5 detik, yaitu
**2–4× lebih lama** daripada jalur LIVE-mati di §3.1. Dengan LIVE menyala,
chat dan penghitung penonton mengubah panjang `innerText`, dan jendela
stabil 2,5 detik jadi jauh lebih sulit tercapai.

### 3.3 Koreksi terhadap audit sebelumnya

`docs/performance-audit-v0.1.1.md` §3.2 melaporkan `readyMs` **31.147 / 31.055
ms** dengan `settled: false` pada 2026-10-12 (LIVE mati), dan menyimpulkan
"setiap pembukaan halaman membayar 30 detik penuh".

**Pengukuran hari ini tidak mereproduksi itu.** Kondisi yang sama (LIVE mati,
headless, profil yang sama) menghasilkan 5,3–5,7 detik dengan `settled=true`,
tiga kali berturut-turut.

Penjelasan yang paling mungkin sudah tercatat sendiri: harness A/B waktu itu
menjalankan headless **4 detik sesudah** sesi headed ditutup, dan halamannya
dialihkan ke `business.tiktokshop.com/us/creator/live` — bukan dashboard produk.
Halaman pemasaran itu punya konten yang terus berubah, jadi ia memang tidak
pernah settle. Angka 31 detik itu **sah sebagai pengukuran, tapi bukan pengukuran
jalur normal**; ia mengukur halaman yang salah.

Pernyataan "setiap pembukaan halaman membayar 30 detik penuh" karena itu
**tidak boleh dipakai sebagai dasar perkiraan penghematan**.

---

## 4. Konten yang sudah ada SEBELUM `waitForSettled` selesai

Dengan LIVE **mati** (§3.1):

| Konten | Tersedia pada | `waitForSettled` selesai |
|---|---|---|
| URL dashboard benar | 0,76 s | 6,0–6,4 s |
| `collectProducts` menjawab | 1,19–1,40 s | 6,0–6,4 s |
| identitas terbaca | 1,48–2,88 s | 6,0–6,4 s |

**Jarak: ~3,2–4,8 detik.** Semua yang dibutuhkan discovery — identitas, status
LIVE, katalog — sudah bisa dijawab pembaca produksi jauh sebelum halaman
dinyatakan tenang.

Dengan LIVE **menyala**: jaraknya **belum terukur**. Lihat §6.

---

## 5. Apakah konten yang berubah terus menghalangi settle?

Diukur, bukan diduga. Probe kedua mencatat jumlah elemen per selektor
produksi setiap 250 ms (selektor **dibaca** dari `autopin/products.js`, tidak
ditulis ulang).

LIVE **mati**:

```
t+  728  numInput=0 rowMark=0 top=0 pin=0 spin=1 len=0
t+ 2517  numInput=0 rowMark=0 top=0 pin=0 spin=2 len=331
t+ 3612  numInput=0 rowMark=0 top=0 pin=0 spin=1 len=1175
t+ 4393  numInput=0 rowMark=0 top=0 pin=0 spin=1 len=1175
t+ 5180  numInput=0 rowMark=0 top=0 pin=0 spin=1 len=1175
t+ 5966  numInput=0 rowMark=0 top=0 pin=0 spin=1 len=1175
```

| Penanda | Kemunculan pertama |
|---|---|
| `.pc_top_product` | **TIDAK PERNAH** |
| `[class*="stock-and-pin-button"]` | **TIDAK PERNAH** |
| `input[data-tid="m4b_input_number"]` | **TIDAK PERNAH** |
| `button[data-pin-performance-source="product_card"]` | **TIDAK PERNAH** |
| tidak ada spinner | **TIDAK PERNAH** (selalu ada ≥1) |

### Temuan 5.1 — bukan konten berubah yang jadi masalah di sini

Panjang `innerText` **berhenti berubah pada t+3,6 s** dan tidak berubah lagi.
Settle pada 5,6 s = 3,1 s menunggu konten + 2,5 s jendela stabil. Jadi pada
jalur LIVE-mati, biaya terbesarnya adalah **jendela 2,5 detik yang wajib**,
bukan DOM yang gelisah.

### Temuan 5.2 — saat LIVE mati, area produk TIDAK ADA sama sekali

Ini temuan yang paling penting untuk desain penggantinya. Tidak ada kontainer
produk, tidak ada baris, tidak ada tombol pin — dan **tidak ada penanda
"empty state" yang bisa dikenali**. Halaman cuma tidak punya area itu, dan
sebuah spinner tetap ada selamanya.

### Temuan 5.3 — spinner bukan sinyal yang bisa dipakai

`spin` tidak pernah nol. Kondisi "tunggu sampai tidak ada spinner" akan
menggantung sampai timeout pada setiap pembukaan halaman.

---

## 6. Kondisi kesiapan pengganti yang diusulkan

### 6.1 Mengapa sketsa di permintaan TIDAK bisa dipakai apa adanya

Kondisi yang disarankan:

> identity available → expected dashboard loaded → product panel/container
> present → product rows or an explicit empty-state visible

Dua syarat terakhir **tidak pernah terpenuhi saat LIVE mati** (§5.2). Diterapkan
apa adanya, jalur yang hari ini selesai dalam **5,6 detik** akan menggantung
sampai **30 detik** — regresi 5×, tepat pada jalur yang paling sering dipakai
customer di luar jam LIVE (menyusun mapping, memeriksa kesiapan, Periksa ulang).

### 6.2 Bentuk yang aman: disjungsi dengan kasus negatif yang eksplisit

Siap kalau **salah satu** benar:

1. **Jalur positif** — `isExpectedConsole(url)` **DAN** identitas terbaca
   **DAN** `numberInputsOnPage > 0` (ada baris produk ter-render).
   → inilah jalur LIVE-menyala, dan ia bisa berhenti segera setelah baris
   pertama ada.

2. **Jalur negatif eksplisit** — `isExpectedConsole(url)` **DAN** identitas
   terbaca **DAN** tidak ada penanda produk **DAN** panjang `innerText` stabil
   selama jendela pendek (mis. 1,5 s).
   → inilah jalur LIVE-mati/etalase kosong. Ia **tetap butuh jendela stabil**,
   karena tidak ada penanda yang membedakan "belum dirender" dari "memang tidak
   ada" (§5.2). Jendela ini yang menggantikan `SETTLE_STABLE_MS` 2,5 s.

3. **Batas waktu** — tetap `readyTimeoutMs`, tetap tidak melempar, tetap
   melaporkan `settled: false`. Tidak ada perubahan perilaku gagal.

Keduanya memakai **pembaca produksi yang sama** (`isExpectedConsole`,
`readIdentity`, `collectProducts`/`numberInputsOnPage`), jadi tidak ada selektor
baru dan tidak ada logika identitas yang diduplikasi.

### 6.3 Yang TIDAK boleh ikut berubah

* `openConsole` tetap tidak melempar saat tidak siap.
* Bentuk kembaliannya tetap `{ url, title, settled, readyMs }` — ada kontrak
  tes yang memakukannya (`test/controller.discovery.test.js:482`).
* `readyTimeoutMs` dan `navTimeoutMs` tetap. Audit ini **tidak** mengusulkan
  menaikkan timeout mana pun.
* Gerbang identitas, `checkIdentity`, dan semantik status/products tetap.

---

## 7. Risiko

| # | Risiko | Keparahan | Mitigasi |
|---|---|---|---|
| R1 | Jalur negatif berhenti terlalu cepat dan melaporkan katalog kosong padahal baris produk baru mau masuk → `no-live-products` yang salah, dan START diblokir tanpa sebab | **tinggi** | jendela stabil pada jalur negatif; jangan turunkan di bawah ~1,5 s tanpa pengukuran LIVE-menyala |
| R2 | Jalur positif berhenti pada baris produk **pertama** padahal katalog ter-virtualisasi dan baris lain belum masuk → katalog tidak lengkap | **tinggi** | `collectProducts` sudah punya `stoppedEarly`/`ranOutOfTime` dan penggulirannya sendiri; kesiapan hanya menentukan KAPAN mulai membaca, bukan kapan berhenti. Jangan sampai kesiapan dipakai sebagai pengganti penggulirannya |
| R3 | Katalog besar: baris pertama muncul cepat, tapi `collectProducts` tetap lama | sedang | di luar cakupan audit ini; biaya gulir tidak berubah |
| R4 | Halaman yang salah (redirect pemasaran) lolos jalur negatif | sedang | `isExpectedConsole` wajib di KEDUA jalur; itu memang yang membedakan sesi kadaluarsa hari ini |
| R5 | Penghematan ternyata kecil pada LIVE-menyala | sedang | **belum terukur** — §8 |
| R6 | `settled=false` berubah arti, lalu suatu saat ada yang mulai mempercayainya | rendah | dokumentasikan bahwa ia tetap tidak dipakai mengambil keputusan |

---

## 8. Perkiraan penghematan — dan apa yang belum diketahui

| Jalur | Sekarang (terukur) | Perkiraan sesudah | Dasar |
|---|---|---|---|
| LIVE **mati** (Periksa ulang, menyusun mapping) | 5,3–5,7 s | ~3,0–3,5 s | jendela stabil 2,5 s → 1,5 s; konten siap pada 1,2–2,9 s |
| LIVE **menyala**, dashboard produk | 9,9–20,5 s | **belum diketahui** | baris produk ada lebih awal, tapi *seberapa* awal belum diukur |

**Penghematan pada jalur LIVE-mati: ~2–2,5 detik per pembukaan halaman.** Kecil.

**Jalur LIVE-menyala adalah satu-satunya yang berpotensi besar**, karena di
situlah `waitForSettled` memakan 10–20,5 detik, dan ia terjadi **dua kali** per
START (snapshot penasihat + preflight otoritatif). Kalau baris produk ternyata
hadir pada ~2–4 detik, penghematannya bisa **6–16 detik per pembukaan**, yaitu
**12–32 detik per START**.

Tapi angka itu **belum diukur**, dan audit ini tidak akan menebaknya. Dengan
LIVE mati, penanda produk tidak pernah muncul (§5.2), jadi pertanyaan "kapan
baris produk pertama muncul" **secara struktural tidak bisa dijawab hari ini**.

### Rekomendasi

**Jangan implementasikan dulu.** Jalankan probe yang sama (`probe-markers`,
baca-saja, tanpa klik) sekali saja saat LIVE **menyala**, dan catat kemunculan
pertama `numberInputs` / `rowMarkers` / `pinButtons` dibanding `readyMs`. Satu
pengukuran itu menentukan apakah pekerjaan ini bernilai 12–32 detik atau hanya
2 detik.

Kalau ternyata hanya ~2 detik, prioritasnya lebih rendah daripada dua kandidat
yang tersisa di `docs/performance-audit-v0.1.1.md`.

---

## 9. Tes regresi yang dibutuhkan kalau nanti diimplementasikan

**Kesiapan**

1. Jalur positif: baris produk ada → siap lebih awal, tanpa menunggu jendela penuh.
2. Jalur negatif: tidak ada penanda produk + teks stabil → siap, dan `settled` tetap dilaporkan.
3. URL bukan dashboard → **tidak pernah** dianggap siap lewat jalur mana pun.
4. Identitas belum terbaca → tidak siap, apa pun penanda produknya.
5. Timeout tercapai → `{ settled: false }`, **tidak melempar** (persis seperti sekarang).
6. `page.isClosed()` → tetap `AutoPinError("NOT_READY", "page-closed")`.
7. Redirect di tengah polling (`NAVIGATION_ERROR_RE`) → tetap diperlakukan sebagai masih berubah, bukan error.

**Kontrak yang tidak boleh bergeser**

8. `openConsole` tetap mengembalikan `{ url, title, settled, readyMs }` — tes kontrak yang sudah ada tetap hijau.
9. Tidak ada selektor baru: selektor yang dipakai kesiapan **identik** dengan yang ada di `autopin/products.js`.
10. `readyTimeoutMs` / `navTimeoutMs` tidak berubah nilainya.

**Kebenaran data — yang paling penting**

11. Jumlah produk **identik** antara jalur lama (`settled:true` penuh) dan jalur baru, pada katalog yang sama. Ini syarat mutlak.
12. Katalog ter-virtualisasi: kesiapan dini **tidak** memotong penggulirannya; `stoppedEarly`/`ranOutOfTime` tetap berperilaku sama.
13. Etalase kosong tetap `no-live-products`, bukan "belum siap".
14. LIVE mati tetap `live:false` dengan katalog tetap bisa dibaca kalau ada.
15. Semantik status vs products (§ discovery reuse) tidak berubah.

**Tidak boleh berubah**

16. Headless tetap, profil tetap, `PURPOSE.RUNTIME` tetap.
17. Jumlah peluncuran browser per START tetap **2**.
18. `/api/start` tetap melakukan pembacaan otoritatifnya sendiri.

---

## 10. Ringkasan

1. Algoritmanya menunggu panjang `innerText` stabil 2,5 detik, menyerah pada 30 detik, dan **hasilnya tidak dipakai siapa pun** untuk mengambil keputusan.
2. Dengan LIVE mati ia selesai dalam **5,3–5,7 detik** dan **settled=true** — bukan 30 detik seperti yang diperkirakan audit sebelumnya. Angka 31 detik itu mengukur halaman yang salah (§3.3).
3. Konten yang dibutuhkan siap **3,2–4,8 detik lebih awal** daripada settle pada jalur LIVE-mati.
4. Kondisi berbasis konten yang disarankan **akan memperburuk** jalur LIVE-mati kalau diterapkan apa adanya, karena area produk tidak pernah ada saat LIVE mati.
5. Bentuk yang aman adalah disjungsi: baris produk ada **atau** kasus negatif eksplisit dengan jendela stabil pendek, keduanya di belakang `isExpectedConsole` + identitas.
6. Potensi besar hanya ada pada jalur LIVE-menyala, dan besarnya **belum terukur**. Satu probe baca-saja saat LIVE menyala akan menentukannya.
