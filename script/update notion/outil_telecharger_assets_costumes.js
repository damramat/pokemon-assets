const fs = require("fs");
const path = require("path");
const axios = require("axios");
const dotenv = require("dotenv");
const pLimit = require("p-limit").default;
const sharp = require("sharp");
const { google } = require("googleapis");

// ============================
// INIT ENV
// ============================
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const {
  GOOGLE_SHEET_ID,
  GOOGLE_APPLICATION_CREDENTIALS,
  CONCURRENCY = 3,
} = process.env;

if (!GOOGLE_SHEET_ID || !GOOGLE_APPLICATION_CREDENTIALS) {
  throw new Error("Variables GOOGLE_SHEET_ID ou GOOGLE_APPLICATION_CREDENTIALS manquantes");
}

// ============================
// OUTPUT DIR
// ============================
const OUTPUT_DIR = path.resolve(__dirname, "../assets/costumes");
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const limit = pLimit(Number(CONCURRENCY));

// ============================
// GOOGLE SHEETS
// ============================
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, "..", GOOGLE_APPLICATION_CREDENTIALS),
      "utf8"
    )
  ),
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});

const sheets = google.sheets({ version: "v4", auth });

// ============================
// UTILS
// ============================
const getBaseNameFromUrl = (url) => {
  try {
    const name = decodeURIComponent(url.split("/").pop().split("?")[0]);
    return name.replace(/\.[^.]+$/, ""); // sans extension
  } catch {
    return `image_${Date.now()}`;
  }
};

// ============================
// DOWNLOAD + NORMALIZE (PNG 256x256)
// ============================
const downloadAndNormalizeImage = async (url) => {
  const baseName = getBaseNameFromUrl(url);
  const finalFilename = `${baseName}.png`;
  const outputPath = path.join(OUTPUT_DIR, finalFilename);

  if (fs.existsSync(outputPath)) {
    console.log(`⏩ Déjà présent: ${finalFilename}`);
    return;
  }

  const response = await axios({
    url,
    method: "GET",
    responseType: "arraybuffer",
    timeout: 20000,
    validateStatus: (status) => status >= 200 && status < 300,
  });

  const buffer = Buffer.from(response.data);

  await sharp(buffer)
    .resize(256, 256, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toFile(outputPath);

  console.log(`🖼️ Normalisé 256×256: ${finalFilename}`);
};

// ============================
// MAIN
// ============================
async function main() {
  console.log("🚀 Lecture Google Sheet : Costumes");

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: "Costumes!H2:H",
  });

  const urls = (res.data.values || [])
    .flat()
    .map((u) => (u ? u.trim() : null))
    .filter(Boolean);

  console.log(`📦 ${urls.length} URLs trouvées`);

  await Promise.all(
    urls.map((url) =>
      limit(() =>
        downloadAndNormalizeImage(url).catch((err) => {
          console.error(`❌ Erreur ${url} → ${err.message}`);
        })
      )
    )
  );

  console.log("🎉 Tous les assets sont en PNG 256×256");
}

main().catch((err) => {
  console.error("💥 Erreur fatale", err);
  process.exit(1);
});
