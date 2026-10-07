# data/

Konfigurasi customer. Diurus oleh Controller, bukan disunting tangan.

## Berkas

| Berkas                       | Di git?   | Isi                                                        |
| ---------------------------- | --------- | ---------------------------------------------------------- |
| `config.example.json`        | ya        | Template. Bentuk dan nilai default yang aman.              |
| `config.json`                | **tidak** | Config sungguhan. Berisi password OBS dan username TikTok. |
| `config.json.tmp`            | tidak     | Sisa penulisan atomik. Normalnya tidak pernah ada.         |
| `.runtime/runtime-<id>.json` | tidak     | Artefak config runtime, satu per run. Dihapus saat Stop.   |

`config.json` di-gitignore dengan alasan yang sama seperti `.env`: ia memuat
password OBS dan username TikTok. Jangan pernah meng-commit-nya.

## Memulai

```sh
cp data/config.example.json data/config.json
```

Lalu isi lewat Controller (`PUT /api/config`), bukan dengan editor teks. Validasi
ada di satu tempat — `controller/config-manager.js` — dan menyunting berkasnya
langsung melewati validasi itu.

## Bentuk pemetaan

```json
{
  "scene": "PAX-1",
  "product": { "title": "O'CORN Sea Salt 80gr" },
  "triggers": ["spill etalase 1", "etalase satu"],
  "reply": "Etalase 1 sudah aku pin ya kak"
}
```

Keempatnya **berlaku sungguhan** sejak P2:

| Field      | Mengendalikan                                                     |
| ---------- | ----------------------------------------------------------------- |
| `scene`    | scene OBS yang diputar                                            |
| `product`  | produk yang di-pin AutoPIN (dicocokkan ke katalog LIVE)           |
| `triggers` | kata kunci yang dicari matcher produksi di komentar penonton       |
| `reply`    | teks yang dikirim AutoComment ke chat, **apa adanya**              |

Tiga hal yang perlu diketahui:

- **`triggers` menggantikan, bukan menambah.** Scene yang kamu petakan memakai
  trigger-mu saja; kata kunci bawaan untuk scene itu tidak ikut aktif. Tanpa
  aturan ini, bot akan merespons kata yang tidak terlihat di config dan tidak
  bisa kamu matikan.
- **Hanya scene yang dipetakan yang aktif.** Scene yang tidak ada di `mappings`
  tidak bisa dipicu penonton.
- **`product: null` itu sah** — scene punya trigger tapi tidak pernah di-pin
  (mis. scene FAQ). Yang ditolak adalah `{"title": ""}`: itu field yang lupa
  diisi, bukan keputusan.

### Yang tetap milik `RULES` di `index.js`

`mediaInputs`, `waitForMediaEnd`, dan `duration` **tidak ada** di config, dan itu
disengaja. Ketiganya detail pemutaran OBS: nama input media (mis. `"Media 3"`,
bukan nama berkas) dan durasi failsafe yang diukur dari video aslinya.

Akibatnya: **scene yang tidak ada di `RULES` tidak bisa dipetakan.** Controller
tidak punya cara mengetahui nama input media-nya, dan menebak durasi berarti
mengubah perilaku pemutaran scene itu. Preflight menolaknya dengan
`scene-playback-unknown`.

## Hubungan dengan `.env`

`.env` **tetap ada** dan tetap dibaca oleh core engine.

Yang berjalan lewat **artefak config runtime** (satu berkas JSON, satu variabel
environment `AILIVE_RUNTIME_CONFIG` yang berisi path-nya):

- `mappings[].scene`, `.product`, `.triggers`, `.reply`

Yang **masih** lewat environment, dan alasannya — ini kompatibilitas, bukan
kelalaian. Semuanya dibaca di tingkat modul sebelum apa pun bisa disuntikkan:

| Variabel                                                                                             | Dibaca oleh                |
| ---------------------------------------------------------------------------------------------------- | -------------------------- |
| `TIKTOK_USERNAME`, `OBS_HOST`, `OBS_PORT`, `OBS_PASSWORD`                                            | `index.js`                 |
| `AUTOPIN_ENABLED`, `AUTOPIN_PORT`, `AUTOPIN_TIMEOUT_MS`                                              | `index.js`, `autopin/client.js` |
| `AUTOPIN_CONSOLE_URL`, `_PROFILE_DIR`, `_DEBUG_DIR`, `_EXPECTED_SHOP`, `_FORBIDDEN_SHOPS`, `_CHROME_PATH` | `autopin/config.js`        |
| `AUTOCOMMENT_*`                                                                                      | `autocomment/config.js`    |
| `SCENE_REPLAY_COOLDOWN_MS`                                                                           | `index.js`                 |

`AUTOPIN_PRODUCT_PAX_*` **tidak lagi dibentuk Controller.** Pemetaan produk
berjalan lewat artefak runtime. Dua sumber untuk hal yang sama berarti suatu saat
keduanya berbeda, dan yang menang ditentukan oleh urutan pembacaan — bukan oleh
keputusan siapa pun. Jalur manual `node index.js` tanpa Controller tetap membaca
`AUTOPIN_PRODUCT_*` dari `.env` seperti sebelumnya.

## Dua mode, dan yang legacy adalah default

| Mode       | Kapan                            | Sumber trigger/produk/balasan                    |
| ---------- | -------------------------------- | ------------------------------------------------ |
| **legacy** | `AILIVE_RUNTIME_CONFIG` tidak di-set | array `RULES`, `AUTOPIN_PRODUCT_*`, `DEFAULT_TEMPLATE` |
| **config** | Controller menyuplai artefak      | `data/config.json`                               |

`node index.js` dari terminal tetap mode legacy dan tidak berubah sedikit pun.

Mode config **fail-closed**: kalau artefak yang disuplai Controller tidak bisa
dibaca, bot **menolak menyala** (`[RUNTIME_CONFIG_REFUSED]`, exit 1). Ia tidak
pernah jatuh kembali ke kata kunci bawaan — menyala dengan pemetaan yang tidak
pernah divalidasi, di akun sungguhan, di depan penonton, jauh lebih berbahaya
daripada tidak menyala.

## Perubahan saat automation berjalan

Menyimpan config saat `RUNNING` **tidak** diterapkan panas. `PUT /api/config`
menjawab `restartRequired: true`, dan snapshot yang sedang dipakai tidak disentuh:
satu pemutaran tidak boleh berpindah trigger atau balasan di tengah jalan.

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

Artefak runtime juga tidak pernah memuat cookie, token, data sesi browser, maupun
password OBS. Ia hanya memuat apa yang sudah terlihat penonton: nama scene, judul
produk di daftar LIVE, kata kunci, dan kalimat balasan.
