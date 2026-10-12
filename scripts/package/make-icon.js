/* Membuat packaging/icon.ico dan packaging/icon.png dari tanda produk.
 *
 * Tandanya BUKAN hal baru: ia lima batang di bilah atas dashboard
 * (`.mark-dots` di controller/public/styles.css), tinggi 16/11/7/11/16, dalam
 * oranye aksen. Ikon memakai tanda yang sama supaya aplikasi di taskbar dan
 * aplikasi di layar adalah benda yang sama.
 *
 * KENAPA GEOMETRI PER UKURAN, bukan satu gambar yang diperkecil:
 * lima batang dengan celah di antaranya adalah bentuk yang paling cepat hancur
 * saat diperkecil. Pada 16 px, batang selebar 1,6 px jatuh di antara piksel dan
 * seluruh tanda jadi bubur abu-abu. Jadi tiap ukuran punya lebar batang dan
 * celah dalam BILANGAN BULAT, dipilih supaya tandanya tetap terbaca dan tetap
 * terpusat. Itu pekerjaan normal seorang perancang ikon, bukan kemewahan.
 *
 * WARNA DIBALIK dari yang di layar. Di dashboard, batang oranye di atas dasar
 * terang. Sebagai ikon, dasarnya yang oranye: ikon duduk di atas wallpaper dan
 * taskbar yang tidak kita kendalikan, dan warna merek sebagai siluet jauh lebih
 * kuat di sana daripada batang tipis di atas kotak gelap.
 *
 *   node scripts/package/make-icon.js
 */
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const REPO = path.join(__dirname, "..", "..");
const OUT_DIR = path.join(REPO, "packaging");

// Dari styles.css: --accent #ff5a1f, --accent-ink #17181c.
const ORANGE = "#ff5a1f";
const INK = "#17181c";

// Rasio tinggi batang, langsung dari .mark-dots: 16 / 11 / 7 / 11 / 16.
const RATIO = [1, 11 / 16, 7 / 16, 11 / 16, 1];

// Geometri per ukuran. b = lebar batang, g = celah, H = tinggi batang tertinggi.
// Semuanya bilangan bulat, dan (S - (5b + 4g)) dipilih genap supaya tandanya
// benar-benar terpusat tanpa sisa setengah piksel.
const GEOM = {
  16: { b: 2, g: 1, H: 10, r: 3 },
  // 24: lebar batang HARUS genap di sini. 5b + 4g hanya genap kalau b genap,
  // dan tanda yang tidak genap lebarnya tidak bisa terpusat tepat di kanvas
  // genap. b=4 membuat tandanya menyentuh tepi, jadi b=2 yang tersisa.
  24: { b: 2, g: 2, H: 14, r: 5 },
  32: { b: 4, g: 2, H: 18, r: 7 },
  48: { b: 6, g: 2, H: 28, r: 10 },
  64: { b: 8, g: 3, H: 36, r: 14 },
  128: { b: 14, g: 7, H: 72, r: 28 },
  256: { b: 28, g: 14, H: 144, r: 56 },
  512: { b: 56, g: 28, H: 288, r: 112 },
};

const SIZES = [16, 24, 32, 48, 64, 128, 256];

function draw(size) {
  const gm = GEOM[size];
  if (!gm) throw new Error("tidak ada geometri untuk " + size);
  const W = 5 * gm.b + 4 * gm.g;
  const x0 = (size - W) / 2;
  if (!Number.isInteger(x0)) throw new Error(size + "px: tanda tidak terpusat tepat (" + x0 + ")");
  const baseline = (size + gm.H) / 2;
  if (!Number.isInteger(baseline)) throw new Error(size + "px: baseline jatuh di setengah piksel");
  return { ...gm, W, x0, baseline };
}

const PAGE = `
<canvas id="c"></canvas>
<script>
function roundRect(ctx, x, y, w, h, r) {
  var rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
  ctx.fill();
}
window.render = function (spec) {
  var c = document.getElementById("c");
  c.width = spec.size;
  c.height = spec.size;
  var ctx = c.getContext("2d");
  ctx.clearRect(0, 0, spec.size, spec.size);

  // Dasar oranye.
  ctx.fillStyle = spec.orange;
  roundRect(ctx, 0, 0, spec.size, spec.size, spec.r);

  // Lima batang, duduk di satu garis dasar — siluetnya lembah, seperti di UI.
  ctx.fillStyle = spec.ink;
  var barR = Math.max(0, Math.round(spec.b * 0.3));
  for (var i = 0; i < 5; i += 1) {
    var h = Math.max(1, Math.round(spec.H * spec.ratio[i]));
    var x = spec.x0 + i * (spec.b + spec.g);
    var y = spec.baseline - h;
    roundRect(ctx, x, y, spec.b, h, barR);
  }
  return c.toDataURL("image/png");
};
</script>
`;

// --- ICO -------------------------------------------------------------------

// Format ICO: header 6 byte, lalu satu entri 16 byte per gambar, lalu datanya.
// Entri boleh berisi PNG utuh (Windows Vista ke atas membacanya), jadi tidak
// perlu menulis DIB sendiri.
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // tipe 1 = ikon
  header.writeUInt16LE(images.length, 4);

  const entries = Buffer.alloc(16 * images.length);
  let offset = 6 + 16 * images.length;

  images.forEach((img, i) => {
    const e = 16 * i;
    // 0 berarti 256 — satu byte tidak bisa memuat angka 256.
    entries.writeUInt8(img.size >= 256 ? 0 : img.size, e + 0);
    entries.writeUInt8(img.size >= 256 ? 0 : img.size, e + 1);
    entries.writeUInt8(0, e + 2); // warna palet: 0 = bukan palet
    entries.writeUInt8(0, e + 3); // reserved
    entries.writeUInt16LE(1, e + 4); // bidang warna
    entries.writeUInt16LE(32, e + 6); // bit per piksel
    entries.writeUInt32LE(img.buf.length, e + 8);
    entries.writeUInt32LE(offset, e + 12);
    offset += img.buf.length;
  });

  return Buffer.concat([header, entries, ...images.map((i) => i.buf)]);
}

// --- jalan -----------------------------------------------------------------

(async () => {
  const browser = await puppeteer.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setContent(PAGE, { waitUntil: "domcontentloaded" });

  async function png(size) {
    const spec = draw(size);
    const url = await page.evaluate(
      (s) => window.render(s),
      { size, orange: ORANGE, ink: INK, ratio: RATIO, b: spec.b, g: spec.g, H: spec.H, r: spec.r, x0: spec.x0, baseline: spec.baseline }
    );
    const buf = Buffer.from(url.split(",")[1], "base64");
    console.log(
      "  " + String(size).padStart(3) + "px  batang " + spec.b + " celah " + spec.g +
        "  lebar tanda " + spec.W + "  tepi " + spec.x0 + "  " + String(buf.length).padStart(6) + " byte"
    );
    return { size, buf };
  }

  console.log("merender:");
  const images = [];
  for (const s of SIZES) images.push(await png(s));

  const ico = buildIco(images);
  fs.writeFileSync(path.join(OUT_DIR, "icon.ico"), ico);
  console.log("\npackaging/icon.ico   " + ico.length + " byte, " + images.length + " ukuran");

  // PNG 512 sebagai sumber: untuk dokumen, web, atau ikon platform lain nanti.
  const big = await png(512);
  fs.writeFileSync(path.join(OUT_DIR, "icon.png"), big.buf);
  console.log("packaging/icon.png   " + big.buf.length + " byte, 512px");

  await browser.close();
})().catch((e) => {
  console.error("GAGAL: " + e.message);
  process.exit(1);
});
