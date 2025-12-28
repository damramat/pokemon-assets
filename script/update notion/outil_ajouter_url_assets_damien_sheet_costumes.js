const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { google } = require("googleapis");

// ============================
// ENV
// ============================
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const {
  GOOGLE_SHEET_ID,
  GOOGLE_APPLICATION_CREDENTIALS,
} = process.env;

if (!GOOGLE_SHEET_ID || !GOOGLE_APPLICATION_CREDENTIALS) {
  throw new Error("Variables GOOGLE_SHEET_ID ou GOOGLE_APPLICATION_CREDENTIALS manquantes");
}

const PREFIX =
  "https://raw.githubusercontent.com/damramat/pokemon-assets/main/costume_shiny/";

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
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

// ============================
// UTILS
// ============================
const extractShinyPngUrlFromUrl = (url) => {
  if (!url) return "";

  try {
    const filename = decodeURIComponent(
      url.split("/").pop().split("?")[0]
    );

    // retire l’extension existante
    const baseName = filename.replace(/\.[^.]+$/, "");

    return `${PREFIX}${baseName}_shiny.png`;
  } catch {
    return "";
  }
};

// ============================
// MAIN
// ============================
async function main() {
  console.log("🚀 Lecture colonne I (Costumes)");

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: "Costumes!I2:I",
  });

  const rows = res.data.values || [];

  console.log(`📦 ${rows.length} lignes lues`);

  const valuesToWrite = rows.map(([url]) => [
    extractShinyPngUrlFromUrl(url),
  ]);

  if (valuesToWrite.length === 0) {
    console.log("⚠️ Rien à écrire");
    return;
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: `Costumes!J2:J${valuesToWrite.length + 1}`,
    valueInputOption: "RAW",
    requestBody: {
      values: valuesToWrite,
    },
  });

  console.log("✅ Colonne J mise à jour (assets shiny)");
}

main().catch((err) => {
  console.error("💥 Erreur fatale", err);
  process.exit(1);
});
