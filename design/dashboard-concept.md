# Catatan desain: konsep dashboard

Catatan internal untuk `design/dashboard-concept.html`. Dipindah ke berkas ini
2026-10-09, karena sebelumnya ia tampil sebagai seksi "About this concept" di
dalam prototipe — dan prototipe harus bisa dipakai untuk menunjukkan "inilah
yang diterima customer", bukan dokumen yang menjelaskan dirinya sendiri.

Keduanya tidak mungkin ikut terpaket: allowlist `files` di `package.json`
bersifat inklusif dan `design/` tidak ada di dalamnya, dan `!**/*.md` membuang
berkas markdown.

## Apa yang ada di prototipe

Proposal, bukan dashboard yang bekerja. Tidak terhubung ke API mana pun.

Isinya nyata: etalase, frasa trigger, balasan, dan waktu di Activity berasal
dari run LIVE yang tervalidasi 9 Oktober 2026. Nama akun **sengaja** bukan akun
uji yang sebenarnya — akun uji pernah bocor ke `index.html` sebagai placeholder
dan tertangkap audit paket, dan berkas konsep adalah tempat paling mudah bagi
nilai seperti itu untuk menyelinap kembali.

Satu-satunya elemen yang bukan milik customer adalah **dok pratinjau** yang
mengapung di kanan bawah. Ia hidup di luar seluruh markup dashboard, memakai
warna perkakas, dan bisa ditutup dengan `×`. Sesudah ditutup, tombol `1` `2` `3`
tetap mengganti keadaan; muat ulang halaman untuk memunculkan doknya kembali.

## Keputusan, dan sebabnya

### Warna hanya berarti keadaan

Tidak ada aksen merek. Hijau hanya berarti **berjalan / sedang tayang**, amber
hanya **perlu dibereskan**, merah hanya **berhenti**. Identitas dibawa struktur
(pita navy penuh) dan tipografi, bukan warna.

Ini bukan selera: pada 2026-10-08 dashboard produksi memakai satu warna hijau
untuk "siap" dan "berjalan" sekaligus, sehingga automation yang BERHENTI terbaca
seperti sistem yang sedang bekerja. Aksen merek yang ikut bersaing dengan empat
warna keadaan adalah cara tercepat mengulang kesalahan itu.

### Keadaan dijawab satu kalimat

"Siap dimulai", di paling atas, di sebelah satu-satunya tombol yang
mengubahnya. Angka besar dengan label kecil adalah perlakuan bawaan untuk hero
dan ia menjawab pertanyaan yang salah: operator tidak mencari metrik, ia mencari
tahu apakah botnya nyala.

Di dashboard produksi jawaban itu masih terpecah ke tiga tempat: pil di bilah
atas, satu baris di daftar kesiapan, dan kartu Automation.

### Strip atas memantau, daftar bawah mengatur

Strip hanya memuat hal yang **berubah** saat siaran: etalase mana yang tayang,
sisa waktunya, kapan masing-masing terakhir tayang. Tidak ada judul produk dan
tidak ada frasa trigger — keduanya milik daftar di bawah dan muncul tepat sekali
di halaman.

Menghapus pengulangan itu juga yang membayar sebagian besar pengurangan tinggi:
satu slot turun dari 109,6px menjadi 60,2px.

### Tiga keadaan di sisi berhenti

| keadaan | kapan | yang terlihat |
|---|---|---|
| Siap | semua pemeriksaan lolos | "Siap dimulai", strip diam, pemeriksaan satu baris |
| Perlu diperiksa | ada yang benar-benar menghalangi | judul menghangat, START mati, kartu membuka dirinya di baris yang menghalangi |
| Berjalan | bot jalan | strip hidup, pemeriksaan hilang, penyuntingan tertutup |

"Perlu diperiksa" **hanya** muncul pada keadaan ketiga, dan selalu membawa cara
membereskannya.

Satu sebab ditampilkan sebagai **satu** masalah: LIVE yang belum tayang
berwarna amber, sedangkan "Produk di LIVE Anda" dibiarkan abu-abu, karena
katalog yang belum terbaca adalah akibat dari LIVE yang gelap, bukan masalah
kedua. Menampilkan keduanya amber membuat operator mencari dua kerusakan padahal
ada satu. Ringkasannya pun berbunyi "7 pemeriksaan lolos, 1 perlu dibereskan",
bukan 6 dan 2.

### Pemeriksaan menyusut saat lolos

Delapan baris hijau adalah delapan baris tanpa pekerjaan. Lolos menjadi satu
baris; yang menghalangi membuka dirinya sendiri.

### Baris etalase ringkas sampai disunting

Satu baris per etalase: nomor, trigger, produk. `Ubah` membuka baris itu di
tempat, dan hanya satu baris terbuka pada satu waktu — dua formulir terbuka
berdampingan membuat orang lupa yang mana yang sedang ia ubah. Saat bot
berjalan, penyuntingan ditutup, bukan sekadar dianjurkan untuk tidak dipakai.

### Activity terbatas, dan batasnya disebutkan

Rantai terbaru terbuka, yang lebih tua diringkas satu baris, gulir dibatasi, dan
batas **50** disebutkan di kakinya — angka yang sama dengan `MAX_ACTIVITY_ITEMS`
di `controller/public/ui-logic.js`. Yang lebih lama ada di log dukungan.

Rantainya memang berurutan (diminta → scene → pin → balasan → selesai), jadi ia
digambar sebagai urutan dengan garis penghubung, bukan nomor 01/02/03 yang
ditempel di depan tiap baris.

### Bahasa adalah fitur produk

Bawaan peluncuran pertama: **bahasa Indonesia**. Pemilih `ID / EN / 中文` duduk
di bilah atas, tepat di sebelah Pengaturan.

Kalimat dirender dari kamus, jadi teks terjemahan dan konten customer terpisah
**secara struktur**: judul produk, frasa trigger, balasan admin, dan nama scene
seperti `PAX-1` tidak punya kunci kamus, jadi tidak mungkin ikut diterjemahkan
walaupun seseorang mencoba.

Beberapa hal yang membedakan ini dari terjemahan mesin:

- Desimal ikut bahasa: `36,4s` di Indonesia, `36.4s` di yang lain.
- Mandarin memakai kosakata penjual live sungguhan: **橱窗** untuk etalase
  produk dan **置顶** untuk pin, bukan terjemahan harfiah dari "showcase" dan
  "pin".
- `lang` pada elemen akar ikut berganti (`id` / `en` / `zh-Hans`), sehingga
  pemutus baris dan pemilihan muka huruf browser bekerja benar.

### Muat tiga bahasa tanpa pecah

Indonesia kira-kira 20% lebih panjang dari Inggris, Mandarin kira-kira 30% lebih
pendek. Tidak ada yang diukur menurut panjang satu kalimat: tombol tumbuh
mengikuti labelnya, judul memakai skala `clamp`, label pemeriksaan yang panjang
boleh membungkus sementara nilainya tetap satu baris, dan setiap anak flex yang
memuat teks diberi `min-width: 0` supaya ia terpotong alih-alih mendorong
barisnya melebar.

Kalimat pendukung di hero dipangkas sampai ~100 karakter supaya ketiga bahasa
sama-sama jatuh di dua baris. Versi Indonesia yang 146 karakter menjadi tiga
baris sementara Mandarin hanya satu, yang membuat pita melompat tingginya setiap
kali bahasa diganti.

## Angka

Tinggi pita gelap, dihitung dari nilai CSS-nya sendiri pada lebar 1280px
(aritmetika, bukan pengukuran render):

```
            SEBELUM   SESUDAH
padding       64,0      60,0
judul         46,2      44,8   (42px -> 40px)
kalimat       79,8      50,4   (3 baris -> 2)
kepala strip  30,0      48,6   (baris peran baru)
satu slot    109,6      60,2
TOTAL        329,5     264,0px   = -19,9%
```

Versi pertama turun **28,6%**, dan itu terlalu banyak: judulnya ikut menyusut
jadi 34px, padahal pita ini elemen yang harus paling kuat. Ruangnya dikembalikan
sampai judul kembali 40px dan pengurangannya mendarat di rentang yang diminta.

Kolom pertama kini mulai **188px** lebih tinggi: 569px menjadi 381px (pita -66,
kartu pemeriksaan -110, jarak -12). Pada laptop 1280x800, Etalase dan Activity
sudah terlihat tanpa menggulir.

## Biaya kalau diadopsi

- Setiap `id` dan kait kelas yang dipakai `app.js` bisa tetap seperti sekarang.
- **IBM Plex Sans** berarti self-host satu subset woff2 ~30 KB, karena aplikasi
  ini sengaja tidak memuat apa pun dari jaringan. Di Segoe UI Variable desainnya
  tetap berdiri.
- **Mandarin tidak butuh unduhan apa pun**: tumpukan font jatuh ke Microsoft
  YaHei yang sudah ada di Windows.
- Kamusnya harus hidup di `ui-logic.js`, bukan `app.js`, supaya bisa diuji —
  pelajaran yang sudah dibayar sekali ketika kalimat customer tinggal di lapisan
  DOM dan tidak ada satu tes pun yang bisa melihatnya.

## Yang belum diputuskan

**Tema gelap.** Operator bekerja di samping OBS yang gelap, tapi aplikasi ini
sejak awal hanya terang. Ini keputusan yang perlu diambil, bukan diasumsikan.

## Cara memeriksa prototipe tanpa browser

Dua skrip pemeriksa dipakai saat membangunnya, karena console browser tidak bisa
dibaca dari sesi terminal:

- struktur HTML seimbang, dan setiap `id` yang dirujuk JS memang ada di markup
  (37 id);
- kamus tiga bahasa: 89 kunci identik di ketiganya, placeholder cocok, tidak ada
  kunci tak terpakai, dan tidak ada konten customer yang menyelinap masuk.

Yang **tidak** bisa diperiksa dengan cara itu: tampilan sesungguhnya. Prototipe
ini belum pernah dilihat terender.
