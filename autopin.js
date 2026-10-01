const express = require("express");
const puppeteer = require("puppeteer");

const app = express();
app.use(express.json());

let browser, page;

// Start browser (hanya 1x)
async function initBrowser() {
  browser = await puppeteer.launch({
    headless: false,   // biar kelihatan
    args: ["--no-sandbox"]
  });
  page = await browser.newPage();

  // buka LIVE console (kamu HARUS login manual 1x)
  await page.goto("https://shop.tiktok.com/streamer/live-console", {
    waitUntil: "networkidle2"
  });

  console.log("Browser ready — please login manually once.");
}

initBrowser();


// ========== API ENDPOINT: menerima perintah untuk PIN produk ==========
app.post("/pin", async (req, res) => {
  const { product_number } = req.body; // contoh: 1 atau 2 atau 3

  console.log("Received PIN request for product:", product_number);

  try {
    // Selector DOM untuk tombol PIN
    const selector = `div[data-product-index="${product_number}"] button:has-text("Pin")`;

    // Tunggu elemen PIN muncul
    await page.waitForSelector(selector, { timeout: 5000 });

    // Klik tombol PIN
    await page.click(selector);

    console.log("DONE pin product:", product_number);
    return res.send("OK");
  } catch (err) {
    console.error("Error PIN:", err);
    return res.status(500).send("ERR");
  }
});

app.listen(5001, () => console.log("AutoPIN server running on port 5001"));