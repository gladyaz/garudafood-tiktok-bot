# data/

Konfigurasi customer. Diurus oleh Controller, bukan disunting tangan.

## Berkas

| Berkas                | Di git? | Isi                                                        |
| --------------------- | ------- | ---------------------------------------------------------- |
| `config.example.json` | ya      | Template. Bentuk dan nilai default yang aman.              |
| `config.json`         | **tidak** | Config sungguhan. Berisi password OBS dan username TikTok. |
| `config.json.tmp`     | tidak   | Sisa penulisan atomik. Normalnya tidak pernah ada.         |

`config.json` di-gitignore dengan alasan yang sama seperti `.env`: ia memuat
password OBS dan username TikTok. Jangan pernah meng-commit-nya.

## Memulai

```sh
cp data/config.example.json data/config.json
```

Lalu isi lewat Controller (`PUT /api/config`), bukan dengan editor teks. Validasi
ada di satu tempat — `controller/config-manager.js` — dan menyunting berkasnya
langsung melewati validasi itu.

## Hubungan dengan `.env`

`.env` **tetap ada** dan tetap dibaca oleh core engine. Pembagiannya:

- `data/config.json` — semua yang diurus **customer**: username TikTok, OBS,
  pemetaan scene → produk, batas waktu, gerbang AutoPIN/AutoComment.
- `.env` — default **internal**, rahasia pengembang, kompatibilitas development.

Controller menerjemahkan `config.json` menjadi environment yang sudah dipahami
core (`controller/config-manager.js` → `toEnv()`), lalu meneruskannya ke proses
anak. Tidak ada nama variabel baru: semuanya sudah dibaca oleh `index.js`,
`autopin/*.js`, dan `autocomment/*.js` sebelum Controller ada.

## Yang belum berlaku

Dua field disimpan dan divalidasi, tetapi **belum diterapkan ke core**:

| Field                  | Kenapa belum                                                            |
| ---------------------- | ----------------------------------------------------------------------- |
| `mappings[].triggers`  | Kata kunci masih di array `RULES` di `index.js`.                         |
| `mappings[].reply`     | Teks masih `DEFAULT_TEMPLATE` di `autocomment/formatter.js`, dan `index.js` tidak pernah mengopernya. |

Menerapkan keduanya berarti mengubah core, dan core sedang frozen. Mengisinya
sekarang tidak merusak apa pun — ia hanya belum berpengaruh. `GET /api/status`
melaporkannya di `config.notAppliedToCore` supaya ini tidak pernah tersembunyi.

## Yang tidak pernah datang dari berkas ini

Izin melakukan aksi nyata ke akun TikTok tetap **hanya dari baris perintah**
operator, persis seperti sebelum Controller ada:

```
--enable-autocomment-send     chat otomatis sesudah pin terkonfirmasi
--allow-comment-send-once     tepat satu percobaan kirim
--click-strategy=<...>        strategi klik
--dry-run                     service tidak mengklik
```

`autoCommentEnabled: true` di `config.json` **tidak cukup** untuk mengirim chat.
Dua lapis, dan itu disengaja.
