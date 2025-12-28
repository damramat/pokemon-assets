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
// CONFIG
// ============================
const DEBUG_FIRST_N = 30;

// ============================
// NORMALISATION
// ============================
function norm(s) {
  return (s || "")
    .toString()
    .normalize("NFKC")
    .replace(/\u00A0/g, " ")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function keyPokemonCostume(pokemon, costume) {
  return `${norm(pokemon).toLowerCase()}|${norm(costume).toLowerCase()}`;
}

// Split "Pokemon – Costume" ou "Pokemon - Costume"
function splitPokemonCostume(labelRaw) {
  const label = norm(labelRaw);
  if (!label) return null;

  const idx = label.indexOf(" - ");
  if (idx > 0) {
    return {
      pokemon: norm(label.slice(0, idx)),
      costume: norm(label.slice(idx + 3)),
    };
  }

  const dashIdx = label.indexOf("-");
  if (dashIdx > 0) {
    return {
      pokemon: norm(label.slice(0, dashIdx)),
      costume: norm(label.slice(dashIdx + 1)),
    };
  }

  return null;
}

function splitList(raw) {
  return norm(raw)
    .split(",")
    .map((x) => norm(x))
    .filter(Boolean);
}

// ============================
// MAIN
// ============================
async function main() {
  console.log("🚀 Lecture sheets Costumes & RefForme");

  const costumesRes = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: "Costumes",
  });

  const refFormeRes = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: "RefForme",
  });

  const costumesHeaders = costumesRes.data.values[0];
  const costumesRows = costumesRes.data.values.slice(1);

  const refHeaders = refFormeRes.data.values[0];
  const refRows = refFormeRes.data.values.slice(1);

  // ===== Colonnes Costumes =====
  const idxCostNom = costumesHeaders.indexOf("Nom");
  const idxCostIdRefForme = costumesHeaders.indexOf("IdRefForme"); // COL L
  const idxCostEvolOut = costumesHeaders.indexOf("evol_ids");      // COL O

  if (idxCostNom < 0 || idxCostIdRefForme < 0 || idxCostEvolOut < 0) {
    throw new Error(
      `Headers Costumes manquants: besoin de "Nom", "IdRefForme"(col L), "evol_ids"(col O).\nReçu: ${costumesHeaders.join(", ")}`
    );
  }

  // ===== Colonnes RefForme =====
  const idxRefNom = refHeaders.indexOf("Nom");
  const idxRefId = refHeaders.indexOf("Id");
  const idxRefEvolIds = refHeaders.indexOf("evol_ids");

  if (idxRefNom < 0 || idxRefId < 0 || idxRefEvolIds < 0) {
    throw new Error(
      `Headers RefForme manquants: besoin de "Nom", "Id", "evol_ids".\nReçu: ${refHeaders.join(", ")}`
    );
  }

  // ============================
  // INDEX RefForme
  // ============================
  const refByName = new Map(); // name(lower) -> row
  const refById = new Map();   // id -> row

  for (const r of refRows) {
    const name = norm(r[idxRefNom]);
    const id = norm(r[idxRefId]);
    if (name) refByName.set(name.toLowerCase(), r);
    if (id) refById.set(id, r);
  }

  // ============================
  // INDEX Costumes par (pokemon + costume) -> IdRefForme (col L)
  // ============================
  const refFormeIdByKey = new Map();

  costumesRows.forEach((r) => {
    const parsed = splitPokemonCostume(r[idxCostNom]);
    if (!parsed) return;

    const idRefForme = norm(r[idxCostIdRefForme]); // colonne L
    if (!idRefForme) return;

    const k = keyPokemonCostume(parsed.pokemon, parsed.costume);
    if (!refFormeIdByKey.has(k)) {
      refFormeIdByKey.set(k, idRefForme);
    }
  });

  // ============================
  // TRAITEMENT
  // ============================
  const updates = [];
  let analysed = 0;
  let written = 0;

  for (let i = 0; i < costumesRows.length; i++) {
    const row = costumesRows[i];
    const rowNum = i + 2;

    const rawLabel = row[idxCostNom];
    const parsed = splitPokemonCostume(rawLabel);

    if (!parsed) {
      if (rowNum <= DEBUG_FIRST_N) {
        console.warn(`🧩 [L${rowNum}] IMPOSSIBLE SPLIT: "${norm(rawLabel)}"`);
      }
      continue;
    }

    analysed++;

    const baseName = parsed.pokemon;
    const costume = parsed.costume;

    if (rowNum <= DEBUG_FIRST_N) {
      console.log(`🔎 [L${rowNum}] base="${baseName}" costume="${costume}"`);
    }

    const refBase = refByName.get(baseName.toLowerCase());
    if (!refBase) {
      console.warn(`⚠️ [L${rowNum}] RefForme introuvable pour base="${baseName}"`);
      continue;
    }

    const evolRaw = refBase[idxRefEvolIds];
    const evolIdsRef = splitList(evolRaw);

    if (!evolIdsRef.length) {
      if (rowNum <= DEBUG_FIRST_N) {
        console.log(`↪️ [L${rowNum}] Pas d'évolution RefForme pour "${baseName}"`);
      }
      continue;
    }

    const foundEvolRefFormeIds = [];
    const missing = [];

    for (const evolRefId of evolIdsRef) {
      const refEvol = refById.get(evolRefId);
      if (!refEvol) {
        missing.push(`RefFormeIdInexistant:${evolRefId}`);
        continue;
      }

      const evolName = norm(refEvol[idxRefNom]);
      const k = keyPokemonCostume(evolName, costume);
      const evolRefFormeId = refFormeIdByKey.get(k);

      if (evolRefFormeId) {
        foundEvolRefFormeIds.push(evolRefFormeId);
        if (rowNum <= DEBUG_FIRST_N) {
          console.log(`✅ [L${rowNum}] evol "${evolName}" -> IdRefForme="${evolRefFormeId}"`);
        }
      } else {
        missing.push(evolName);
        if (rowNum <= DEBUG_FIRST_N) {
          console.log(`… [L${rowNum}] evol "${evolName}" non trouvée avec costume="${costume}"`);
        }
      }
    }

    if (!foundEvolRefFormeIds.length) {
      console.warn(
        `⚠️ [L${rowNum}] Aucune évolution costume trouvée pour "${baseName} - ${costume}". ` +
        `CandidatsRefForme=[${evolIdsRef.join(", ")}] Missing=[${missing.join(" | ")}]`
      );
      continue;
    }

    const outValue = foundEvolRefFormeIds.join(", ");

    updates.push({
      range: `Costumes!O${rowNum}`,
      values: [[outValue]],
    });
    written++;

    if (missing.length) {
      console.warn(
        `⚠️ [L${rowNum}] Évolution partielle pour "${baseName} - ${costume}" → écrit "${outValue}", manquants: ${missing.join(" | ")}`
      );
    }
  }

  // ============================
  // WRITE
  // ============================
  if (!updates.length) {
    console.log(`ℹ️ Aucune mise à jour (analysed=${analysed})`);
    return;
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: GOOGLE_SHEET_ID,
    requestBody: {
      valueInputOption: "RAW",
      data: updates,
    },
  });

  console.log(`✅ ${written} lignes mises à jour dans Costumes!O (IdRefForme des évolutions)`);
}

main().catch((err) => {
  console.error("❌ Erreur fatale", err);
  process.exit(1);
});
