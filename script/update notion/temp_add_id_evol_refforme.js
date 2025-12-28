const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { google } = require("googleapis");

// ============================
// ENV
// ============================
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const { GOOGLE_SHEET_ID, GOOGLE_APPLICATION_CREDENTIALS } = process.env;

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
// UTILS
// ============================
const norm = (s) =>
  (s || "")
    .toString()
    .normalize("NFKC")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const splitList = (raw) =>
  norm(raw)
    .split(",")
    .map((x) => norm(x))
    .filter(Boolean);

// ============================
// MAIN
// ============================
async function main() {
  console.log("🚀 Lecture feuille RefForme");

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: "RefForme",
  });

  const headers = res.data.values[0];
  const rows = res.data.values.slice(1);

  const idxNom = headers.indexOf("Nom");      // colonne A
  const idxId = headers.indexOf("Id");        // colonne B
  const idxColT = headers.indexOf(headers[19]); // colonne T (index 19)
  const idxColV = headers.indexOf(headers[21]); // colonne V (index 21)

  if (idxNom < 0 || idxId < 0) {
    throw new Error(`Colonnes "Nom" ou "Id" introuvables dans RefForme`);
  }

  // ============================
  // INDEX Nom → Id
  // ============================
  const idByName = new Map();

  rows.forEach((r) => {
    const name = norm(r[idxNom]);
    const id = norm(r[idxId]);
    if (name && id) {
      idByName.set(name.toLowerCase(), id);
    }
  });

  // ============================
  // TRAITEMENT
  // ============================
  const updates = [];

  rows.forEach((row, i) => {
    const rowNum = i + 2;
    const rawNames = row[idxColT];

    if (!rawNames) return;

    const names = splitList(rawNames);
    if (!names.length) return;

    const ids = [];
    const missing = [];

    names.forEach((name) => {
      const id = idByName.get(name.toLowerCase());
      if (id) {
        ids.push(id);
      } else {
        missing.push(name);
      }
    });

    if (!ids.length) {
      console.warn(`⚠️ [L${rowNum}] Aucun nom trouvé pour: ${rawNames}`);
      return;
    }

    if (missing.length) {
      console.warn(
        `⚠️ [L${rowNum}] Noms introuvables: ${missing.join(", ")} (ligne ignorée partiellement)`
      );
    }

    updates.push({
      range: `RefForme!V${rowNum}`,
      values: [[ids.join(", ")]],
    });
  });

  // ============================
  // WRITE
  // ============================
  if (!updates.length) {
    console.log("ℹ️ Aucune mise à jour");
    return;
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: GOOGLE_SHEET_ID,
    requestBody: {
      valueInputOption: "RAW",
      data: updates,
    },
  });

  console.log(`✅ ${updates.length} lignes mises à jour dans RefForme!V`);
}

main().catch((err) => {
  console.error("❌ Erreur fatale", err);
  process.exit(1);
});
