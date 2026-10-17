# Audit ketahanan matcher trigger — v0.2.0

**Status:** BACA-SAJA. Tidak ada kode produksi, config, paket, atau artefak pilot yang disentuh.
**Dasar:** `feat/v0.2.0-rule-actions` @ `10e62742732c0ca1c75b1dc7f21460361ee55496` (checkpoint PILOT-READY, installer `89b5445f…`).
**Tanggal:** 2026-10-17.
**Cara:** harness audit di luar repo memanggil modul produksi apa adanya (`tiktok/matcher.js`, `tiktok/normalize.js`) lewat jalur yang sama dengan `handleChat()`. Tidak ada perilaku yang ditiru ulang.

---

## 1. Ringkasan eksekutif

Matcher sekarang **sangat toleran terhadap typo** dan **sangat rentan terhadap pemicu salah**. Toleransinya bukan masalah; kerentanannya iya, dan satu kelasnya sudah aktif di config pilot hari ini.

**Temuan paling penting — produk salah ter-pin.** Pada config customer yang terpasang sekarang, penonton yang mengetik `spill etalase 2` akan memicu **PAX-1**, lalu bot mem-pin produk etalase 1 dan menulis di chat *"Etalase 1 sudah aku pin ya kak"*. Begitu juga `spill etalase 3`, `4`, `6`, `10`, dan `spill etalase dua`.

| diketik penonton | aturan yang menang | skor | yang terjadi |
|---|---|---|---|
| `spill etalase 2` | **PAX-1** | 0,933 | produk SALAH di-pin, klaim salah di chat |
| `spill etalase 3` | **PAX-1** | 0,933 | idem |
| `spill etalase 4` | **PAX-1** | 0,933 | idem |
| `spill etalase 6` | **PAX-1** | 0,933 | produk yang tidak ada → PAX-1 |
| `spill etalase 10` | **PAX-1** | 0,938 | idem |
| `et 1` | **PAX-3** | 0,750 | produk salah |
| `no 1` | **PAX-2** | 0,750 | produk salah |
| `no 3` | **PAX-2** | 0,750 | produk salah |

Sebabnya aritmetika, bukan kebetulan: `spill etalase 2` berbeda **satu karakter** dari `spill etalase 1`, pada `maxLen=15`, jadi skornya `1 − 1/15 = 0,933` — jauh di atas ambang `0,55`. **Menaikkan ambang tidak menyelesaikan kelas ini**: ia akan tetap lolos pada ambang 0,9 sekalipun.

Prinsip produk yang Anda tetapkan — *false positive lebih mahal daripada false negative* — langsung menunjuk ke kesimpulan: masalah utama bukan recall, tapi **angka yang diperlakukan sebagai typo**.

Tiga risiko lain yang terdokumentasi di bawah: trigger pendek (4 karakter) hanya butuh 1 karakter berbeda, trigger luas bisa "mencuri" frasa trigger lain lewat containment dan hasilnya **tergantung urutan config**, dan negasi (`jangan boikot ai`) tidak dikenali sama sekali.

Rekomendasi: **satu perubahan bedah** (diskualifikasi kandidat fuzzy yang angkanya berbeda), bukan penguatan fuzzy, bukan klasifikasi intent. Rinciannya di §10.

---

## 2. Arsitektur sekarang — ditelusuri dari kode

Jalur dari komentar penonton sampai aturan terpilih, `index.js:1400` `handleChat(data)`:

| # | langkah | berkas:baris |
|---|---|---|
| 0 | gerbang chat menolak pesan bot sendiri / backlog **sebelum** `handleChat` | `tiktok/chat-gate.js` |
| 1 | `msgRaw = (data.comment \|\| "").toLowerCase().trim()` | `index.js:1402` |
| 2 | `noteViewerActivity()` — hitungan sepi idle di-reset | `index.js:1412` |
| 3 | `recordUserMessage()` — penonton yang dibungkam spam langsung `return` | `index.js:1415` |
| 4 | `msgNorm = normalizeForMatching(msgRaw)` | `index.js:1421` |
| 5 | `idx = fuzzyIndex()` — indeks dibangun dari `activeRules()`, di-cache per tanda tangan kunci aturan | `index.js:1241` |
| 6 | **lintasan frasa** `matchPhrase(idx, msgRaw, msgNorm, {containsPhrase})` → `via=pattern` / `via=keyword` | `tiktok/matcher.js:151` |
| 7 | **lintasan fuzzy** `matchFuzzy(idx, msgNorm, {threshold, budgetCells})` → `via=fuzzy` | `tiktok/matcher.js:164` |
| 8 | `matchAndEnqueue(rule, nickname, via)` → `[MATCH] scene=… via=…` | `index.js:1429`, `1443` |
| 9 | tidak ada yang cocok → fungsi selesai tanpa jejak `[MATCH]` | `index.js:1445` |

### Urutan dan pemenang

- **Lintasan frasa** mengiterasi `index.groups` **per aturan, dalam urutan config**, dan di dalam satu aturan **per trigger, dalam urutan trigger**. **Yang pertama cocok langsung menang** (`return` seketika) — tidak ada skor, tidak ada perbandingan.
- **Lintasan fuzzy** mengiterasi `index.entries` (rata, urutan aturan lalu trigger) dan mencari **skor tertinggi**, dengan `>` ketat sehingga **saat skor seri, entri yang lebih dulu dalam urutan config yang menang**.
- Frasa **selalu** dievaluasi lebih dulu dan seluruhnya; fuzzy hanya jalan kalau tidak satu pun frasa cocok.

### Beberapa trigger dalam satu aturan

Dianggap setara — masing-masing menjadi satu entri indeks tersendiri dengan `rule` yang sama. Trigger duplikat (di aturan sama atau beda) tidak ditolak; yang lebih dulu dalam urutan yang menang, dan yang belakangan tidak pernah terpakai.

### Yang memakai matcher yang SAMA

- **Aturan produk (PAX) dan aturan FAQ**: jalur identik. Tidak ada pembedaan sama sekali di matcher — perbedaannya hanya pada `actions` sesudah aturan terpilih.
- **Aturan tanpa scene (balas-saja)**: ikut masuk `activeRules()` dan karenanya ikut ke indeks yang sama. `index.js:856` memisahkannya **sesudah** pencocokan, bukan sebelum.
- **Interaksi saat sepi (idle)**: **TIDAK** ada di indeks. Scene idle dibangun ke `idleRules` terpisah di `runtime/mappings.js`, bukan ke `rules`, jadi penonton **tidak bisa** memicu scene idle dengan mengetik namanya. Dipaku tes `prasyarat: scene interaksi TIDAK bisa dipicu penonton`. Idle juga tidak memengaruhi pencocokan; ia hanya ikut `noteViewerActivity()` di langkah 2.

### Frasa pendek

Tidak ada perlakuan khusus. Tidak ada minimum panjang, tidak ada bobot panjang, tidak ada penalti untuk trigger pendek. Satu-satunya efek panjang adalah lewat rumus `allowed` (§8) — dan efeknya justru membuat trigger pendek **lebih** longgar secara relatif.

### `via=pattern` adalah kode mati

`matchPhrase` mendukung `rule.pattern` (regex, diuji terhadap **`msgRaw`** yang belum dinormalkan). Hasil pencarian: **tidak ada satu pun `pattern:` di seluruh repo** — tidak di `RULES` hardcoded, tidak di aturan hasil config (`runtime/mappings.js` tidak pernah menyetelnya). Jadi `via=pattern` tidak pernah muncul di produksi.

---

## 3. Pipeline normalisasi — apa yang SUNGGUH terjadi

`normalizeForMatching(s)` = `wordNumberToDigit(normalizeText(s))`, `tiktok/normalize.js`:

```js
normalizeText(s)  = s.toLowerCase()
                     .replace(/[^\p{L}\p{N}]+/gu, " ")   // non huruf/angka -> spasi
                     .trim().replace(/\s+/g, " ")
wordNumberToDigit = satu..sembilan, nol  ->  digit   (per batas kata)
```

| aspek | ditangani? | bukti terukur |
|---|---|---|
| huruf besar | **ya** | `BOIKOT AI` → `boikot ai` |
| tanda baca ekor | **ya** | `boikot ai!!!` → `boikot ai` |
| tanda baca di tengah | **ya** | `boikot-ai`, `boikot_ai` → `boikot ai` |
| spasi ganda | **ya** | `boikot   ai` → `boikot ai` |
| tab / newline | **ya** | `boikot\tai\n` → `boikot ai` |
| emoji (ekor & tengah) | **ya, dibuang** | `boikot 😊 ai` → `boikot ai` |
| angka kata 1–9, 0 | **ya** | `etalase satu` → `etalase 1` |
| **`sepuluh`** | **TIDAK** | `etalase sepuluh` tetap `etalase sepuluh` — disengaja & dicatat di kode |
| belasan/puluhan lain | TIDAK | `sebelas`, `dua puluh`, dll. tidak ada di peta |
| aksen / diakritik | **TIDAK** | `bóikot aí` tetap `bóikot aí` |
| Unicode lebar (fullwidth) | **TIDAK** | `ＢＯＩＫＯＴ　ＡＩ` → `ｂｏｉｋｏｔ ａｉ` (titik kode berbeda) |
| huruf berulang | TIDAK | `boikooot aiii` tetap apa adanya |
| gabung kata | TIDAK (ditolong fuzzy) | `boikotai` tetap `boikotai` |
| pisah kata | TIDAK (ditolong fuzzy) | `host nya robot` tetap apa adanya |
| slang (`gmn`, `gmna`) | TIDAK | tidak ada kamus slang |

### `containsPhrase` — arti `via=keyword` yang sebenarnya

```js
containsPhrase(h, n) = ` ${h} `.includes(` ${n} `)
```

Ini **containment pada batas kata**, bukan kesamaan. Konsekuensinya penting:

- `ayo boikot ai dong` → **keyword** (frasa trigger utuh ada di dalamnya)
- `etalase 10` **tidak** cocok dengan trigger `etalase 1` (batas kata menyelamatkan) — tapi lihat §5, fuzzy membatalkan perlindungan ini
- `ini ai ya kak`, `apa ini ai ya`, `ini ai ya bukan` → semuanya **keyword**

---

## 4. `via=keyword` vs `via=fuzzy`, dan kasus nyata `ini ai ya`

Kedua nilai itu lahir di satu tempat saja:

| nilai | asal | arti sesungguhnya |
|---|---|---|
| `pattern` | `tiktok/matcher.js:154` | regex `rule.pattern` cocok — **kode mati**, lihat §2 |
| `keyword` | `tiktok/matcher.js:156` | frasa trigger yang sudah dinormalkan **terkandung** di pesan, pada batas kata |
| `fuzzy` | `index.js:1443` | **tidak satu pun** trigger terkandung di pesan; Levenshtein terbaik ≥ 0,55 |

### Kenapa run 2026-10-17 mencatat `ini ai ya` sebagai `via=fuzzy`

Saya uji config Phase 3 yang persis (dua aturan, trigger `cara order` dan `ini ai ya`) dengan matcher produksi:

| diketik | hasil |
|---|---|
| `ini ai ya` | **`via=keyword`** |
| `ini ai ya?` / `INI AI YA` / `ini  ai  ya` | **`via=keyword`** |
| `ini ai ya 😊` / `ini ai ya?????` | **`via=keyword`** |
| `ini ai ya kak` / `apa ini ai ya` | **`via=keyword`** |
| `ini ai yaa` | `via=fuzzy` 0,900 |
| `ini ai yaaa` | `via=fuzzy` 0,818 |
| `ini aii ya` | `via=fuzzy` 0,900 |
| `ni ai ya` | `via=fuzzy` 0,889 |
| `iniai ya` | `via=fuzzy` 0,889 |
| `ini ai yak` / `ini ai yh` | `via=fuzzy` 0,900 / 0,889 |
| `ini ai` | `via=fuzzy` 0,667 |

**Kesimpulan: bukan bug, dan bukan juga soal istilah logger.** `via=fuzzy` adalah bukti **negatif** yang kuat: pesan yang masuk **tidak memuat** frasa `ini ai ya` sebagai urutan token — kalau memuatnya, lintasan frasa sudah menang lebih dulu dan tidak mungkin sampai ke fuzzy. Jadi teks yang sebenarnya diketik pasti sedikit berbeda, dan yang paling lazim di chat Indonesia justru ada di daftar di atas: vokal akhir berulang (`yaa`), satu huruf hilang (`ni ai ya`), atau kata menempel (`iniai ya`).

**Yang tidak bisa saya buktikan, dan sengaja saya sebut:** teks mentahnya **tidak bisa dipulihkan** dari log. `[TIKTOK_CHAT]` ada di `TRACE_DENY` (`controller/child-trace.js`) justru karena ia memuat identitas penonton, dan baris `💬 <nama>: <isi>` tidak bertag sehingga tracer mengabaikannya. Jadi daftar di atas adalah himpunan kemungkinan yang terbukti, bukan tebakan tentang satu teks tertentu.

Lima penyebab yang Anda ajukan, dijawab satu per satu:

| hipotesis | verdict |
|---|---|
| "keyword" berarti lebih sempit dari exact match | **TIDAK** — justru lebih LUAS (containment, bukan kesamaan) |
| perbedaan normalisasi | **TIDAK** — kedua sisi memakai `normalizeForMatching` yang sama; trigger dinormalkan sekali saat indeks dibangun |
| trigger diganti / keadaan config | **TIDAK** — config Phase 3 memang memuat `ini ai ya`, dan validasi pemetaan melaporkannya `ok` |
| urutan pencocokan | **TIDAK** — frasa selalu dievaluasi seluruhnya sebelum fuzzy |
| istilah logger | **TIDAK** — `via` diteruskan apa adanya dari `matchPhrase`/fuzzy |
| **teks yang diketik tidak memuat frasa trigger** | **YA** — satu-satunya penjelasan yang konsisten |

---

## 5. Matriks uji

Config audit (bentuk mode config, trigger = keyword aturan):
`PAX-1` ← `spill etalase 1` · `FAQ ORDER` ← `cara order`, `cara beli`, `belinya gimana`, `pesennya gimana` · `FAQ JAWAB AI` ← `ini ai ya`, `host ai`, `hostnya robot`, `ini robot ya` · `BOIKOT AI` ← `boikot ai`.

### Grup A — target `boikot ai`

| input | normalisasi | via | aturan | skor | klasifikasi |
|---|---|---|---|---|---|
| `boikot ai` | `boikot ai` | keyword | BOIKOT AI | — | EXPECTED MATCH |
| `BOIKOT AI` | `boikot ai` | keyword | BOIKOT AI | — | EXPECTED MATCH |
| `BOIKOT AI!!!` | `boikot ai` | keyword | BOIKOT AI | — | EXPECTED MATCH |
| `boikot   ai` | `boikot ai` | keyword | BOIKOT AI | — | EXPECTED MATCH |
| `ayo boikot ai` | `ayo boikot ai` | keyword | BOIKOT AI | — | EXPECTED MATCH |
| `ayo boikot ai dong` | — | keyword | BOIKOT AI | — | EXPECTED MATCH |
| `boikott ai` | `boikott ai` | fuzzy | BOIKOT AI | 0,900 | EXPECTED MATCH |
| `boikot aii` | — | fuzzy | BOIKOT AI | 0,900 | EXPECTED MATCH |
| `boikoot ai` | — | fuzzy | BOIKOT AI | 0,900 | EXPECTED MATCH |
| `boiot ai` | — | fuzzy | BOIKOT AI | 0,889 | EXPECTED MATCH |
| `boikt ai` | — | fuzzy | BOIKOT AI | 0,889 | EXPECTED MATCH |
| `boikotai` | — | fuzzy | BOIKOT AI | 0,889 | EXPECTED MATCH |
| `boikot-ai` / `boikot_ai` | `boikot ai` | keyword | BOIKOT AI | — | EXPECTED MATCH |
| `boikot host ai` | — | keyword | **FAQ JAWAB AI** | — | **AMBIGUOUS** (dicuri trigger `host ai`) |
| `boikot hostnya ai` | — | TIDAK COCOK | — | 0,53 | FALSE NEGATIVE (tipis) |
| `boikot artificial intelligence` | — | TIDAK COCOK | — | 0,30 | FALSE NEGATIVE |
| `aku boikot ai` | — | keyword | BOIKOT AI | — | EXPECTED MATCH |
| `jangan boikot ai` | — | keyword | **BOIKOT AI** | — | **FALSE POSITIVE** (negasi diabaikan) |
| `nggak usah boikot ai` | — | keyword | **BOIKOT AI** | — | **FALSE POSITIVE** (negasi) |
| `ga suka ai` | — | TIDAK COCOK | — | 0,40 | EXPECTED NO MATCH |
| `aku suka ai` | — | TIDAK COCOK | — | 0,36 | EXPECTED NO MATCH |
| `ai bagus` | — | TIDAK COCOK | — | 0,27 | EXPECTED NO MATCH |
| `harga ai` | — | TIDAK COCOK | — | 0,50 | EXPECTED NO MATCH |
| `ai` | — | TIDAK COCOK | — | 0,29 | EXPECTED NO MATCH |
| `boikot` | `boikot` | fuzzy | **BOIKOT AI** | 0,667 | **FALSE POSITIVE** (kata tunggal) |
| `boikot produk` | — | TIDAK COCOK | — | **0,54** | EXPECTED NO MATCH — **selisih 0,01 dari ambang** |
| `boikot garuda` | — | fuzzy | **BOIKOT AI** | 0,615 | **FALSE POSITIVE** (niat berbeda: boikot merek) |

### Grup B — FAQ AI

| input | via | aturan | skor | klasifikasi |
|---|---|---|---|---|
| `ini ai ya` / `ini AI ya?` | keyword | FAQ JAWAB AI | — | EXPECTED MATCH |
| `ini aii ya` / `ini ai yah` | fuzzy | FAQ JAWAB AI | 0,900 | EXPECTED MATCH |
| `ini ai kah` | fuzzy | FAQ JAWAB AI | 0,800 | EXPECTED MATCH |
| `ini tuh ai ya` | fuzzy | FAQ JAWAB AI | 0,692 | EXPECTED MATCH |
| `ini host ai ya` | keyword | FAQ JAWAB AI | — | EXPECTED MATCH |
| `hostnya ai` | fuzzy | FAQ JAWAB AI | 0,700 | EXPECTED MATCH |
| `host nya ai` | fuzzy | FAQ JAWAB AI | 0,636 | EXPECTED MATCH |
| `hostnya robot` | keyword | FAQ JAWAB AI | — | EXPECTED MATCH |
| `host nya robot` | fuzzy | FAQ JAWAB AI | 0,929 | EXPECTED MATCH |
| `host robot` | fuzzy | FAQ JAWAB AI | 0,769 | EXPECTED MATCH |
| `robot ya` | fuzzy | FAQ JAWAB AI | 0,667 | EXPECTED MATCH |
| `ini robot` / `ini robot ya?` | fuzzy / keyword | FAQ JAWAB AI | 0,750 / — | EXPECTED MATCH |
| `ini manusia atau ai` | TIDAK COCOK | — | 0,42 | FALSE NEGATIVE |
| `host palsu nih` | TIDAK COCOK | — | 0,50 | FALSE NEGATIVE (tipis) |
| `ini host virtual` | TIDAK COCOK | — | 0,44 | FALSE NEGATIVE |
| `kok pake ai` / `kok pakai ai` | TIDAK COCOK | — | 0,36 / 0,42 | FALSE NEGATIVE |
| `ai host` | TIDAK COCOK | — | 0,33 | FALSE NEGATIVE |

### Grup C — FAQ ORDER

| input | via | skor | klasifikasi |
|---|---|---|---|
| `cara order` / `cara order?` / `gimana cara order` | keyword | — | EXPECTED MATCH |
| `cara ordernya` | fuzzy | 0,769 | EXPECTED MATCH |
| `cara belii` | fuzzy | 0,900 | EXPECTED MATCH |
| `cara belinya` | fuzzy | 0,750 | EXPECTED MATCH |
| `belinya gmn` | fuzzy | 0,786 | EXPECTED MATCH |
| `belinya gimanaa` | fuzzy | 0,933 | EXPECTED MATCH |
| `pesennya gmna` | fuzzy | 0,867 | EXPECTED MATCH |
| `cara pesen` | fuzzy (→`cara order`) | 0,600 | EXPECTED MATCH (kebetulan beruntung) |
| `cara pesan` | fuzzy (→`cara beli`) | 0,600 | EXPECTED MATCH (kebetulan beruntung) |
| `gimana beli` | fuzzy | 0,636 | EXPECTED MATCH |
| `mau beli` | fuzzy | 0,667 | EXPECTED MATCH |
| `beli dimana` | fuzzy | 0,714 | EXPECTED MATCH |

Grup C adalah grup paling sehat: recall tinggi, dan karena keempat trigger menunjuk **satu** aturan, salah pilih antar-trigger tidak berakibat apa pun.

### Grup D — produk, pada **config customer sungguhan**

Trigger nyata: `PAX-1` ← `spill etalase 1` · `PAX-2` ← `no 2` · `PAX-3` ← `et 3` · `PAX-4` ← `et 4` · `PAX-5` ← `spill etalase 5`

| input | via | aturan | skor | klasifikasi |
|---|---|---|---|---|
| `spill etalase 1` | keyword | PAX-1 | — | EXPECTED MATCH |
| `spill etalase 5` | keyword | PAX-5 | — | EXPECTED MATCH |
| `spill etalase satu` | keyword | PAX-1 | — | EXPECTED MATCH |
| `spill etalase 2` | fuzzy | **PAX-1** | 0,933 | **FALSE POSITIVE KRITIS** |
| `spill etalase 3` | fuzzy | **PAX-1** | 0,933 | **FALSE POSITIVE KRITIS** |
| `spill etalase 4` | fuzzy | **PAX-1** | 0,933 | **FALSE POSITIVE KRITIS** |
| `spill etalase 6` | fuzzy | **PAX-1** | 0,933 | **FALSE POSITIVE KRITIS** |
| `spill etalase 10` | fuzzy | **PAX-1** | 0,938 | **FALSE POSITIVE KRITIS** |
| `spill etalase dua` | fuzzy | **PAX-1** | 0,933 | **FALSE POSITIVE KRITIS** |
| `etalase 1` | fuzzy | PAX-1 | 0,600 | EXPECTED MATCH |
| `etalase 2` | TIDAK COCOK | — | 0,53 | EXPECTED NO MATCH (beruntung) |
| `et 1` | fuzzy | **PAX-3** | 0,750 | **FALSE POSITIVE** |
| `et 2` | fuzzy | **PAX-3** | 0,750 | **FALSE POSITIVE** |
| `no 1` | fuzzy | **PAX-2** | 0,750 | **FALSE POSITIVE** |
| `no 3` | fuzzy | **PAX-2** | 0,750 | **FALSE POSITIVE** |
| `nomor 2` | fuzzy | PAX-2 | 0,571 | EXPECTED MATCH |
| `spill 1` / `spill 2` / `spill` / `produk 2` | TIDAK COCOK | — | ≤0,47 | EXPECTED NO MATCH |

---

## 6. Audit false positive

Diurutkan dari paling mahal.

1. **Angka diperlakukan sebagai typo.** Ini kelas terburuk dan sudah aktif di config pilot. Satu digit berbeda pada frasa 15 karakter = skor 0,933. Akibatnya bukan "bot salah paham" tapi **produk salah di-pin di LIVE commerce**, ditambah balasan yang mengklaim produk yang salah. Jawaban langsung atas pertanyaan Anda: **ya, `spill etalase 2` bisa dan memang resolve ke PAX-1** kalau PAX-2 tidak punya trigger yang lebih dekat.
2. **Trigger pendek, perlindungan tipis.** `et 3` dan `no 2` panjangnya 4 karakter → `allowed = floor(0,45 × 4) = 1`. **Satu** karakter berbeda sudah cukup, dan di domain ini karakter yang berbeda itu justru angkanya.
3. **Satu kata memicu scene.** `boikot` (tanpa `ai`) → BOIKOT AI pada 0,667. `host` → FAQ JAWAB AI pada 0,571. Pesan pendek yang menyinggung sebagian trigger sudah cukup.
4. **Niat berbeda, skor cukup.** `boikot garuda` → BOIKOT AI (0,615). Penonton memboikot merek, bot menjawab soal AI.
5. **Pencurian frasa lewat containment.** `boikot host ai` → **FAQ JAWAB AI** lewat trigger `host ai`, bukan ke aturan `boikot ai`. Deterministik, tapi mengejutkan: aturan yang lebih luas mencuri frasa aturan yang lebih spesifik.
6. **Negasi tidak dikenali.** `jangan boikot ai` dan `nggak usah boikot ai` **memicu** BOIKOT AI. Sesuai instruksi, ini hanya **didokumentasikan sebagai batasan**, bukan diselesaikan sekarang. Catatan desain: negasi tidak bisa diselesaikan oleh matcher berbasis jarak karakter sama sekali — ia butuh lapisan yang mengerti kalimat, dan itu topik terpisah.
7. **Margin ambang setipis 0,01.** `boikot produk` mendapat 0,54 dan tidak cocok; `boikot garuda` mendapat 0,615 dan cocok. Perbedaan antara "aman" dan "salah pemicu" di sini bukan desain, tapi kebetulan ejaan.

---

## 7. Audit false negative

Secara keseluruhan recall-nya **tinggi**; false negative yang ada hampir semuanya adalah parafrase, bukan typo.

| kategori | contoh | skor | catatan |
|---|---|---|---|
| parafrase semantik | `ini manusia atau ai` | 0,42 | butuh alias atau lapisan intent |
| parafrase semantik | `ini host virtual`, `host palsu nih` | 0,44 / 0,50 | idem |
| sinonim | `kok pakai ai` | 0,42 | idem |
| urutan kata berubah | `ai ya ini` | 0,22 | Levenshtein karakter tidak mengenal urutan token |
| frasa diperluas | `boikot hostnya ai` | 0,53 | **selisih 0,02** dari ambang |
| ejaan panjang | `boikot artificial intelligence` | 0,30 | |
| Unicode lebar | `ＢＯＩＫＯＴ　ＡＩ` | — | normalisasi tidak melipat fullwidth |
| aksen | `bóikot aí` | 0,778 | masih cocok lewat fuzzy, tapi containment gagal |
| `sepuluh` | `spill etalase sepuluh` | 0,667 → **PAX-1** | lebih buruk dari gagal: ia cocok ke aturan yang SALAH |

Catatan penting soal urutan kata: matcher membandingkan **karakter**, bukan token. Jadi perubahan urutan kata hampir selalu gagal, sementara typo di dalam kata hampir selalu lolos.

---

## 8. Keamanan ambang

```
DEFAULT_THRESHOLD   = 0.55          tiktok/matcher.js:45
DEFAULT_BUDGET_CELLS = 60_000       tiktok/matcher.js:49
allowed = floor((1 - 0.55) * maxLen) = floor(0.45 * maxLen)
score   = 1 - dist / maxLen         maxLen = max(len(pesan), len(trigger))
```

Ambangnya **tetap**, tidak bervariasi menurut panjang. Tapi karena `allowed` dihitung dari `maxLen`, **toleransi absolutnya tumbuh linear**:

| panjang frasa | jarak edit yang masih lolos |
|---|---|
| 2 | 0 |
| 3–4 | 1 |
| 5–6 | 2 |
| 7 | 3 |
| 9–10 | 4 |
| 12 | 5 |
| 15 | **6** |
| 20 | 9 |
| 30 | 13 |

Trigger terpendek di config customer sungguhan: **`no 2`, `et 3`, `et 4` — 4 karakter, `allowed = 1`.**

**Apakah ambang tetap lebih aman atau lebih berbahaya untuk frasa pendek?** Keduanya, dan itulah masalahnya:

- Untuk frasa pendek ia **berbahaya**, karena satu karakter adalah seluruh pembeda maknanya. `no 2` vs `no 1`: jarak 1, skor 0,75 — lolos.
- Untuk frasa panjang ia **terlalu longgar secara absolut**: pada 15 karakter, **enam** karakter boleh berbeda. `spill etalase 1` dan `spill etalase 2` hanya berbeda satu.

Contoh di sekitar ambang (semua terukur):

| tepat di ATAS ambang | skor | | tepat di BAWAH ambang | skor |
|---|---|---|---|---|
| `nomor 2` → PAX-2 | 0,571 | | `ini manusia atau ai` | 0,42 |
| `host` → FAQ JAWAB AI | 0,571 | | `ga suka ai` | 0,40 |
| `ini ya ai` → FAQ JAWAB AI | 0,556 | | `boikot hostnya ai` | 0,53 |
| `boikot garuda` → BOIKOT AI | 0,615 | | `boikot produk` | 0,54 |

Empat baris terakhir itu menunjukkan bahwa ambang 0,55 jatuh **tepat di tengah zona campur**: di kedua sisinya ada kasus yang diinginkan dan yang tidak diinginkan sekaligus. Tidak ada satu angka ambang yang memisahkan keduanya dengan bersih.

---

## 9. Audit tabrakan aturan

### Tabrakan frasa bersarang

Aturan: `A = boikot ai`, `B = boikot host ai`, `C = host ai`.

| input | urutan config A,B,C | urutan config C,B,A |
|---|---|---|
| `boikot host ai` | **B** (keyword, benar) | **C** (keyword, salah) |
| `boikott host ai` *(1 typo)* | **C** (keyword) | **C** (keyword) |
| `host ai` | C | C |
| `boikot ai` | A | A |
| `boikot hostai` | B (fuzzy 0,929) | B (fuzzy 0,929) |

**Tie-breaking deterministik? Ya. Urutan config menentukan pemenang? Ya.** Dua temuan dari tabel ini:

1. Memindahkan aturan yang lebih luas (`host ai`) ke atas membuatnya **mencuri** `boikot host ai`. Customer yang menyusun ulang daftar aturannya mengubah perilaku pencocokan tanpa mengubah satu pun trigger.
2. **Satu typo pada kata pertama membelokkan hasil ke aturan yang lebih luas**: `boikott host ai` tidak lagi mengandung `boikot host ai`, tapi masih mengandung `host ai` — dan lintasan frasa menang sebelum fuzzy pernah dijalankan. Jadi fuzzy tidak pernah mendapat kesempatan memperbaiki typo itu.

### Tabrakan angka

Dengan ketiga aturan ada (`spill etalase 1`, `spill etalase 2`, `spill etalase 10`), containment menyelamatkan semuanya: ketiganya cocok ke aturan masing-masing lewat `keyword`, termasuk `spill etalase dua` (lewat peta angka kata). **Tapi**:

| input | hasil | catatan |
|---|---|---|
| `spill etalase 11` | **PAX-1** (fuzzy 0,938) | etalase yang tidak ada → produk pertama |
| `spill etalase 3` | **PAX-1** (fuzzy 0,933) | etalase yang tidak dipetakan → produk pertama |
| `spill etalase sepuluh` | **PAX-1** (fuzzy 0,667) | `sepuluh` tidak ada di peta angka |

Jadi perlindungan containment hanya bekerja untuk angka yang **memang dipetakan**. Setiap angka di luar itu jatuh ke fuzzy dan mendarat di entri pertama yang skornya tertinggi — dalam praktiknya **aturan paling atas dengan frasa serupa**, yaitu PAX-1.

---

## 10. Rekomendasi — TIDAK diimplementasikan

Jawaban atas pilihan Anda: **bukan A, bukan E.** Yang saya sarankan adalah kombinasi sempit **D (dibatasi) + B**, dengan satu langkah pertama yang jelas dan terpisah dari sisanya.

### Langkah 1 — wajib, dan sendirian sudah menutup kelas terburuk

**Diskualifikasi kandidat fuzzy yang himpunan angkanya berbeda dari pesan.**

Aturannya: sebelum menghitung Levenshtein, bandingkan deretan digit pada `msgNorm` dan pada trigger. Kalau berbeda, kandidat itu dilewati — bukan diberi skor rendah, tapi **tidak dipertimbangkan**.

Kenapa ini jawaban yang benar, bukan menaikkan ambang:

- angka adalah **pembeda identitas**, bukan ejaan. `etalase 2` bukan versi salah-tulis dari `etalase 1`; ia barang lain.
- ambang berapa pun tidak bisa memisahkannya: skornya 0,933 **karena** frasanya memang nyaris identik.
- efeknya terukur pada seluruh kelas: `spill etalase 2/3/4/6/10/11`, `et 1`, `et 2`, `no 1`, `no 3`, `spill etalase dua`, `spill etalase sepuluh` — semuanya berhenti mendarat di aturan yang salah.
- **nol kehilangan recall pada typo**: `boikott ai`, `belinya gmn`, `host nya robot`, `cara belii` tidak memuat angka sama sekali, jadi tidak tersentuh. Yang memuat angka dan masih benar — `etalase 1` → `spill etalase 1`, `spill etalase satu`, `nomor 2` → `no 2` — angkanya **sama**, jadi tetap lolos.
- hasilnya menjadi "tidak cocok" alih-alih "cocok ke produk salah". Sesuai prinsip Anda: penonton akan mengetik ulang; produk yang salah ter-pin tidak bisa ditarik kembali.

### Langkah 2 — sesudahnya, kalau masih dirasa perlu

**Tambah `sepuluh` (dan belasan kalau mau) ke `wordNumberToDigit`.** Setelah Langkah 1, `spill etalase sepuluh` akan berhenti mendarat di PAX-1; menambahkannya ke peta angka membuatnya mendarat **benar** di PAX-10. Perubahan kecil, tapi ia mengubah pencocokan produksi — jadi tes regresi dulu, jangan digabung dengan Langkah 1.

**Lipat fullwidth dan diakritik di normalisasi.** Murni menambah recall, nol risiko false positive baru, karena ia hanya membuat dua ejaan bertemu di bentuk yang sama.

### Langkah 3 — hanya kalau ada bukti dari pilot

**Naikkan ambang, dan bayar harganya dengan alias.** Dari §8, ambang 0,75 akan menutup `boikot` (0,667), `boikot garuda` (0,615), `host` (0,571), `ini ya ai` (0,556) — tapi juga membuang `cara pesen` (0,600), `mau beli` (0,667), `robot ya` (0,667), `hostnya ai` (0,700), `beli dimana` (0,714). Recall yang hilang itu **harus** dikembalikan sebagai trigger eksplisit di config, dan itu justru lebih baik: alias yang ditulis customer bersifat deterministik, bisa dilihat, dan bisa dimatikan. Jangan lakukan ini tanpa data pilot tentang frasa yang penonton sungguhan pakai.

### Yang saya sarankan TIDAK dilakukan sekarang

- **A (cukup, hanya alias)** — tidak bisa dipilih: kelas angka adalah cacat aktif, bukan kekurangan recall.
- **C (toleransi typo hanya untuk frasa panjang)** — tidak menyelesaikan apa pun di sini. Frasa yang paling bermasalah (`spill etalase 1`, 15 karakter) justru yang **panjang**.
- **E (klasifikasi intent)** — menambah model/latensi/ketidakpastian ke jalur yang berjalan di event loop yang sama dengan OBS dan media-end, demi masalah (negasi, parafrase) yang bukan risiko termahal kita. Catat sebagai mungkin-nanti, bukan sekarang.

### Peringkat menurut kriteria Anda

| | risiko salah pemicu | prediktabilitas | latensi | bisa diatur customer | kerumitan | cocok untuk LIVE commerce |
|---|---|---|---|---|---|---|
| **Langkah 1** angka | **turun drastis** | naik (deterministik) | **turun** (kandidat dilewati lebih awal) | tidak perlu diatur | **rendah** (~10 baris di `matchFuzzy`) | **sangat cocok** |
| Langkah 2 normalisasi | netral | naik | netral | tidak perlu | rendah | cocok |
| Langkah 3 ambang + alias | turun | naik | netral | **ya** (alias) | rendah, tapi butuh data | cocok, perlu bukti |
| E intent | tidak jelas | **turun** | **naik** | tidak | tinggi | belum |

---

## 11. Rencana tes regresi kalau nanti diubah

Kalau Langkah 1 dikerjakan, tes berikut harus ada **sebelum** perubahan dianggap selesai. Semuanya murni, tanpa browser, lewat `tiktok/matcher.js` langsung.

**Harus berhenti cocok (inti perbaikan):**
- `spill etalase 2`, `3`, `4`, `6`, `10`, `11` dengan hanya PAX-1 & PAX-5 di config → **tidak cocok** (sekarang: PAX-1)
- `et 1`, `et 2` dengan trigger `et 3` → tidak cocok
- `no 1`, `no 3` dengan trigger `no 2` → tidak cocok
- `spill etalase dua` → tidak cocok ke PAX-1

**Harus TETAP cocok (pagar recall):**
- `boikott ai`, `boikot aii`, `boikotai`, `boikt ai` → BOIKOT AI, skor tidak berubah
- `belinya gmn`, `belinya gimanaa`, `cara belii`, `pesennya gmna` → FAQ ORDER
- `host nya robot`, `ini aii ya`, `ini ai yaa` → FAQ JAWAB AI
- `etalase 1` → PAX-1 (angka SAMA)
- `spill etalase satu` → PAX-1 lewat `keyword` (peta angka kata)
- `nomor 2` → PAX-2 (angka sama)

**Harus tetap seperti sekarang (tidak boleh ikut berubah):**
- lintasan frasa menang sebelum fuzzy, dan `via` tetap `keyword` untuk containment
- saat skor seri, entri yang lebih dulu dalam urutan config tetap menang
- `budgetExceeded` tetap dilaporkan, bukan didiamkan
- scene idle tetap TIDAK bisa dipicu penonton
- aturan tanpa scene memakai matcher yang sama

**Pagar tingkat sumber:** nilai `DEFAULT_THRESHOLD` dipaku di tes, supaya perubahan ambang tidak bisa menyelinap tanpa keputusan.

**Verifikasi mutasi:** lepas diskualifikasi angka → kelompok "harus berhenti cocok" harus merah seluruhnya.

---

## 12. Lampiran — fakta yang dipakai audit ini

- ambang: `0.55`; anggaran sel DP: `60_000`
- indeks dibangun dari `activeRules()`, di-cache, dan dibangun ulang kalau tanda tangan kunci aturan berubah (`index.js:1241`)
- penyaring pra-Levenshtein (selisih panjang, batas bawah histogram) **tidak** mengubah hasil — ia hanya melewati kandidat yang secara aritmetika mustahil mencapai ambang (`tiktok/matcher.js:16-38`)
- `via=pattern` tidak pernah terjadi: nol `pattern:` di repo
- teks komentar mentah tidak ada di log dukungan: `[TIKTOK_CHAT]` ada di `TRACE_DENY`, dan baris `💬` tidak bertag
- harness audit berada di luar repo (direktori scratchpad sesi) dan memanggil modul produksi tanpa memodifikasinya
