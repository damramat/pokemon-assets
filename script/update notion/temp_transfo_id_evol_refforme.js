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
// CONVERSION (ROBUSTE)
// ============================
const convertId = (rawId) => {
  if (!rawId) return "";

  const id = rawId.trim();

  // sécurité : uniquement chiffres, au moins 3
  if (!/^\d{3,}$/.test(id)) return id;

  const forme = id.slice(-2);       // 2 derniers chiffres
  const dex = id.slice(0, -2);      // le reste

  const newForme = forme.padStart(3, "0");

  return `${dex}${newForme}`;
};

const convertCell = (cell) => {
  if (!cell) return "";

  return cell
    .split(",")
    .map((id) => convertId(id))
    .join(", ");
};

// ============================
// MAIN
// ============================
async function main() {
  console.log("🚀 Lecture RefForme colonne U");

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: "RefForme!U2:U",
  });

  const rows = res.data.values || [];

  console.log(`📦 ${rows.length} lignes lues`);

  const valuesToWrite = rows.map(([cell]) => [
    convertCell(cell),
  ]);

  await sheets.spreadsheets.values.update({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: `RefForme!V2:V${valuesToWrite.length + 1}`,
    valueInputOption: "RAW",
    requestBody: {
      values: valuesToWrite,
    },
  });

  console.log("✅ Colonne V correctement mise à jour");
}

main().catch((err) => {
  console.error("💥 Erreur fatale", err);
  process.exit(1);
});
