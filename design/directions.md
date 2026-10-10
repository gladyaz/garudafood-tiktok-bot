# Tiga arah visual untuk AI LIVE HOST

Studi desain, bukan kode produksi. Ketiganya memecahkan alur kerja operator yang
sama dengan konten yang sama, dan masing-masing menampilkan tiga keadaan.
Semuanya di `design/`, yang tidak ada dalam allowlist `files` sehingga tidak
mungkin ikut terpaket.

| | berkas | gagasan penyusun | perangkat identitas |
|---|---|---|---|
| A | `direction-a-console.html` | satu permukaan utuh, tanpa panel dan tanpa kartu | rel keadaan di tepi kiri; satu kolom angka bersama |
| B | `direction-b-timetable.html` | waktu sebagai sumbu utama; lima jalur dan penggaris waktu | balok berdurasi nyata; pita adegan dengan tanda pin dan balasan |
| C | `direction-c-inspector.html` | master–detail seperti perkakas profesional | bilah status tipis yang tidak pernah bergerak; panel detail per etalase |
| D | `direction-d-rulebook.html` | aturan dibaca sebagai kalimat utuh | satu baris = pemicu → scene → produk → balasan; checklist berprogres |

## Tiga keadaan

Tiga keadaan hanya berbeda kalau dibaca begini, dan ketiganya memakai
pembacaan ini:

- **Berhenti** — otomasi mati DAN ada syarat yang belum terpenuhi. Mulai tidak tersedia.
- **Siap** — otomasi mati, semua syarat terpenuhi. Mulai tersedia.
- **Tayang** — sedang mengudara, etalase 1 berjalan, sisa 31 detik.

Mati dengan semua syarat terpenuhi bukan keadaan keempat; itu "siap".

Cara meninjau: buka berkasnya, pakai dok mengapung di kanan bawah, atau tekan
`1` `2` `3`. Tombol `×` menutup dok untuk tangkapan layar yang bersih; angka
tetap bekerja sesudahnya.

## A — Console

Satu permukaan putih. Tidak ada satu pun elemen dashboard yang punya border
penuh. Pengelompokan dikerjakan garis, perataan, dan jarak — tidak ada kotak.

Yang bekerja: tabel etalase terbaca sekali lihat dan memuat seluruh konfigurasi
dalam satu baris per etalase; kolom angka kanan (46s, 52s, 69s, 36,4s, 31s)
benar-benar menjadi jalur pindaian; keadaan berhenti menaikkan daftar syarat ke
atas tabel sehingga yang menghalangi dibaca lebih dulu, dan baris yang
menghalangi diberi catatan "Satu-satunya yang menahan tombol Mulai".

Yang lemah: delapan baris syarat punya bobot yang persis sama, jadi bagian itu
paling terasa seperti lembar sebar; dan saat tayang, daftar syarat sebenarnya
tidak lagi berguna tapi tetap memakan ruang.

Diperbaiki sesudah tinjauan: rel keadaan kini dibedakan **bentuk**, bukan rona
(kosong / satu blok amber / penuh hijau) dan lebarnya 7px. Versi pertama memakai
abu penuh untuk siap dan hijau penuh untuk tayang — keduanya hanya berbeda
1,06:1 dalam luminans, jadi dari jarak kerja keduanya satu batang gelap yang
sama. Data sesi juga dirapikan supaya 2 permintaan benar-benar berarti satu
selesai dan satu tayang.

## B — Timetable

Lima jalur terhadap penggaris waktu bersama, dengan penanda "sekarang". Balok
digambar sepanjang durasi sebenarnya, dan di bawahnya ada pita adegan yang
memperbesar satu adegan: tanda pin pada 2,2s dan balasan pada 3,8s di dalam
balok 36,4s.

Yang bekerja: pita adegan itu gagasan terbaik dari ketiga arah — ia menjawab
"apakah pin dan balasan mendarat, dan secepat apa" tanpa satu kata pun. Satu
objek menggantikan strip status dan umpan aktivitas sekaligus.

Yang lemah, dan ini struktural: objek paling besar di layar memuat paling
sedikit informasi. Lima jalur selama delapan belas menit berisi dua kejadian,
jadi sebagian besar permukaan yang paling menonjol adalah ruang kosong. Untuk
layar yang dilihat sambil siaran, itu pertukaran yang mahal.

Diperbaiki sesudah tinjauan: "Siaran TikTok / Sedang tayang" tidak lagi hijau di
keadaan siap. Siaran yang hidup sementara bot mati bukan "berjalan", dan hijau
hanya milik otomasi.

## C — Inspector

Bilah status gelap setinggi 30px yang tidak pernah berpindah, lalu daftar lima
etalase di kiri dan panel detail di kanan. Memilih satu etalase memunculkan
seluruh isinya: konfigurasi dan riwayat permintaannya sendiri.

Yang bekerja: kepadatan operasional tertinggi dari ketiganya. Rantai enam
langkah per permintaan — termasuk jeda 120 detik — dengan waktu terukur, dan
saat tayang etalase yang sedang berjalan memilih dirinya sendiri. Keadaan
berhenti memakai panel besar itu untuk menjelaskan apa yang menghalangi.

Yang lemah: kolom kiri punya ruang mati cukup besar antara log sesi dan tombol
di bawahnya; dan tiga tempat mengatakan hal yang sama saat berhenti (kepala
inspector, baris syarat, alasan tombol Mulai).

Diperbaiki sesudah tinjauan: panel detail dulu identik antara berhenti dan siap
— dua dari tiga keadaan praktis sama di 896 dari 1280 piksel. Sekarang panel itu
sendiri membawa pembedanya.

## D — Rulebook

Berasal dari desain yang Anda buat sendiri di Claude Design
(`claude.ai/artifact/Adt7x65M8jsGJ7d86b1Xq6`). Versi aslinya tersimpan utuh di
riwayat git sebagai `design/claude-design-dashboard.html` sebelum saya ubah.

Gagasannya: satu aturan dibaca sebagai satu kalimat — *"Kalau penonton ketik
`spill etalase 1` → ganti scene `PAX-1` → pin `Garuda Kacang Atom`"* — lengkap
dengan balasan chat di bawahnya. Untuk penjual yang tidak teknis ini lebih mudah
dipahami daripada tabel berkolom mana pun di arah A, B atau C. Checklist
"Sebelum mulai" dengan bilah progres lima segmen juga paling ramah dari semuanya.

Yang saya ubah supaya bisa dibandingkan dengan yang lain:

- **Data nyata.** Produk karangan ("Dilan Cookies Original/Matcha/Brownies")
  diganti lima produk asli, pemicu asli, balasan asli, panjang scene asli.
- **Akun disamarkan** menjadi `tokosnackku`. Versi artifact memuat akun uji yang
  sebenarnya, nilai yang sengaja kita keluarkan dari berkas customer setelah
  audit paket menemukannya di `index.html`.
- **Keadaan tayang ditambahkan.** Ini yang paling tidak ada: versi aslinya punya
  penghitung di hero, tapi tidak pernah memberi tahu etalase mana yang jalan,
  sisa berapa, dan apakah pin serta balasannya mendarat. Sekarang ada blok
  tayang dengan hitung mundur dan rantai enam langkah berwaktu nyata.
- **Perancah demo dibuang.** Panel "Mode uji" dan simulator komentar penonton
  tampil sebagai UI produk padahal keduanya alat demo; digantikan dok pratinjau
  yang sama dengan arah lain.
- **Config tidak lagi dibaca dari localStorage.** Siapa pun yang pernah membuka
  versi artifact punya produk karangan tersimpan di sana dan ia akan muncul lagi
  diam-diam.

Ketiga keadaan tidak digambar terpisah: dok memutar tuas yang memang sudah
dipakai dashboard ini (`test.*` dan `run.*`), jadi yang terlihat adalah reaksi
logikanya sendiri.

Yang berbeda dari daftar larangan brief tiga arah sebelumnya, dan **sengaja
dibiarkan** karena ini bahasa visual pilihan Anda, bukan cacat: kartu bersudut
membulat dengan bayangan, label kapital bertracking lebar, JetBrains Mono untuk
frasa pemicu, dan ikon SVG. Satu yang layak dipertimbangkan ulang: merah dipakai
untuk dua arti sekaligus — lencana "ON AIR" dan hitung mundur memakai merah yang
sama dengan tombol "Hentikan Bot".

## Yang belum dibereskan

Dilaporkan, bukan diperbaiki, karena ini keputusan desain bukan cacat:

- **B** — tiga dari empat sel fakta di kepala mengulang baris syarat yang
  terlihat di layar yang sama; balok etalase 5 digambar 46s padahal pita di
  bawahnya menyebut 36,4s; dua aturan gutter layar sempit mati karena kalah
  spesifisitas.
- **C** — mengetik di formulir konfigurasi hilang saat render berikutnya; pada
  tinggi 660px kalimat perbaikan dan tombol Periksa ulang terdorong keluar.
- **A** — kata "sedang tayang" dipakai untuk siaran TikTok, untuk adegan, dan
  untuk otomasi. Tiga hal, satu frasa.
- Ketiganya memuat IBM-kelas webfont dari Google Fonts. Untuk dipakai sungguhan
  masing-masing berarti self-host satu subset, karena aplikasi ini sengaja tidak
  memuat apa pun dari jaringan.

## Cara memeriksanya tanpa membuka browser

Dua skrip dipakai saat meninjau: pemeriksa mekanis (struktur, id yang dirujuk
JS, daftar larangan, tiga keadaan, lantai aksesibilitas, kontras dihitung dari
token palet, hijau hanya pada selektor tayang, konten customer utuh) dan
perender yang mengukur gulir halaman serta isi di bawah lipatan.

Hasil akhir: ketiganya nol temuan keras, nol galat JS, nol gulir halaman pada
1280x800 di ketiga keadaan, dan nol elemen yatim di bawah lipatan.

Satu catatan jujur tentang proses: pengganda `×` pada judul produk etalase 3
sempat berubah menjadi `x` di ketiga berkas. Sumbernya adalah brief yang saya
tulis sendiri — saya mengetik `x` di sana lalu menilai hasilnya dengan aturan
"konten customer tidak boleh diubah". Sudah dikembalikan di ketiganya.
