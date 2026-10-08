"use strict";
// Hook afterPack electron-builder.
//
// Dijalankan PERSIS di antara "aplikasi sudah dirakit" dan "installer dibentuk".
// Itulah satu-satunya titik di mana audit isi masih bisa MENCEGAH, bukan sekadar
// melaporkan: melempar dari sini membatalkan build, jadi installer yang memuat
// .env atau sesi TikTok pengembang tidak pernah sampai ada sebagai berkas.
//
// Kenapa bukan sekadar skrip npm yang jalan sesudahnya: skrip sesudahnya
// menghasilkan installer dulu, lalu berkata installernya kotor. Berkas itu lalu
// ada di disk, bisa tersalin, bisa terkirim. Pemeriksaan yang hanya melaporkan
// adalah pemeriksaan yang suatu saat akan diabaikan karena "installernya sudah
// jadi kok".

const path = require("node:path");
const { verify, report } = require("./verify-package");

module.exports = async function afterPack(context) {
  const dir = context.appOutDir;

  console.log("[AFTER_PACK] auditing=" + path.basename(dir));

  const result = verify(dir);
  report(result);

  if (!result.ok) {
    const kinds = [...new Set(result.problems.map((p) => p.kind))].join(", ");
    // Pesannya menyebut JENIS temuannya, supaya baris kegagalan electron-builder
    // sendiri sudah memberi tahu apa yang salah tanpa perlu menggulir ke atas.
    throw new Error(
      "audit paket GAGAL (" + result.problems.length + " temuan: " + kinds + "). " +
        "Installer TIDAK dibentuk. Lihat baris [VERIFY_PACKAGE_FAILED] di atas."
    );
  }
};
