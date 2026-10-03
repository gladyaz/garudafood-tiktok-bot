# AutoPIN — catatan verifikasi di LIVE sungguhan

Semua pengujian di bawah dijalankan pada akun tes `agen_mulia_abadi`.
Identitas yang memuat kata `garudafood` adalah produksi dan selalu ditolak
`--confirm` oleh guard di `autopin/core.js`.

Screenshot mentah tersimpan di `.autopin-debug/` yang sengaja di-gitignore
(berisi nama akun, nama penonton, dan angka penjualan), jadi di sini hanya
dicatat nama berkasnya.

## 1. Pin pertama sampai ke penonton — 2026-10-03

Perintah: `node autopin-cli.js pin-title "<judul>" --confirm`

- Produk: **JUNNY Low PH Face Wash**
- DOM: tombol `product_card` berubah `Pin` → `Unpin`
- Sisi penonton: produk muncul sebagai pinned/featured, dikonfirmasi user dari
  perangkat penonton (bukan hanya dari DOM konsol)

## 2. Replacement behavior — 2026-10-03, sesi LIVE mulai 1:08 PM

Tiga produk in-stock di satu sesi. Produk ketiga sengaja tidak disentuh sebagai
kontrol untuk mendeteksi efek samping.

| Peran | Judul | Stok |
| --- | --- | --- |
| A | `Dilan Bon Bon Milk Chocolate / dilan baru / dilan bonbon permen dilan warna warni 1 pack isi 10 saset Food` | Low stock: 8 |
| B | `Dilan PANDAN Waffle 1 BOX ISI 12 PCS Soft Wafel Kelapa Coklat` | Low stock: 15 |
| kontrol | `Dilan Waffle 1 BOX Kue Coklat 16gr Garudafood Cemilan Cokelat` | Low stock: 5 |

Judul produk kontrol memuat kata "Garudafood". Ini TIDAK memicu guard, karena
identitas hanya dibaca dari header akun, tidak pernah dari teks produk.

Urutan: dry-run ketiganya (semua `pinText=Pin`, jadi tidak ada yang ter-pin),
`--confirm` A, dry-run B, lalu `--confirm` B.

Klik pada B menghasilkan **tepat dua** perubahan DOM:

```
[AUTOPIN_DOM_CHANGE] kind=fields title="Dilan Bon Bon Milk Chocolate / ..." delta="pinText:Unpin->Pin ..."
[AUTOPIN_DOM_CHANGE] kind=fields title="Dilan PANDAN Waffle 1 BOX ISI 12 PCS ..." delta="pinText:Pin->Unpin ..."
```

- Produk kontrol tidak muncul di daftar perubahan sama sekali
- `ORDER_BEFORE 1,2,3` → `ORDER_AFTER 1,2,3`
- Hanya satu badge "Pinned" tersisa di konsol
- Screenshot: `2026-10-03T06-13-00-504Z_pin-before.png` → `2026-10-03T06-13-04-326Z_pin-after.png`

Sisi penonton, dikonfirmasi user: PANDAN muncul, Bon Bon hilang, hanya satu
produk featured.

### Konsekuensi untuk desain

**Tidak perlu unpin manual sebelum pin produk berikutnya.** TikTok mengganti
produk featured sendiri dalam satu klik. Integrasi nanti tidak perlu menyimpan
state "produk apa yang sedang ter-pin", tidak perlu urutan unpin→pin yang bisa
gagal di tengah, dan tidak ada jendela waktu di mana penonton melihat nol atau
dua produk featured.

## 3. Perilaku platform yang ditemukan saat pengujian

- Tombol Pin per produk (`button[data-pin-performance-source="product_card"]`)
  **hanya ada selama siaran berjalan**. Di luar LIVE, tombol bertuliskan "Pin"
  yang terbaca adalah kartu voucher — bukan pengganti.
- **Daftar produk LIVE bersifat per-sesi.** Menghentikan lalu memulai siaran
  mengosongkan daftar produk dan menghapus seluruh state pin.
- **Nomor posisi tidak stabil**; satu aksi dapat menggeser nomor banyak produk.
  Karena itu `pin <N>` dimatikan dan target selalu lewat judul.
- `.pc_top_product` adalah kontrol "pindahkan ke atas", **bukan** pin. Baris yang
  sudah di posisi teratas tidak memilikinya. Memakainya sebagai pengganti pin
  hanya akan mengurutkan daftar sambil terlihat seperti berhasil.
- TikTok pernah mencabut 10 produk dari satu sesi LIVE disertai peringatan
  "Non-Interactive Content/Irrelevant Promotion". Penyebabnya belum diselidiki
  dan belum terbukti berkaitan dengan AutoPIN.

## 4. Yang BELUM diverifikasi

- Integrasi dengan `index.js` / scene queue (belum dikerjakan sama sekali)
- Perilaku saat beberapa pin berurutan cepat
- Perilaku saat produk kehabisan stok di tengah siaran
- Apakah tombol pin berbeda pada mode "go LIVE with phone"

Catatan: pesan commit `d930cb0` menulis "Not verified: pin effect as seen by
viewers". Baris itu sudah usang — dokumen ini yang berlaku.
