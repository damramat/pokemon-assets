const path = require("path");
require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
});

const { Client } = require("@notionhq/client");
const { google } = require("googleapis");
const crypto = require("crypto");
const pLimit = require("p-limit").default;

// =====================================================
// CONFIG
// =====================================================
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DB_REF_FORME = process.env.NOTION_DATABASE_ID_REF_FORME;
const NOTION_DB_REF_ESPECE = process.env.NOTION_DATABASE_ID_REF_ESPECE;

const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;

const fs = require("fs");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const GOOGLE_CREDENTIALS_REL = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const GOOGLE_CREDENTIALS_PATH = path.resolve(
  PROJECT_ROOT,
  GOOGLE_CREDENTIALS_REL
);

if (!fs.existsSync(GOOGLE_CREDENTIALS_PATH)) {
  throw new Error(
    `❌ Credentials Google introuvables : ${GOOGLE_CREDENTIALS_PATH}`
  );
}

const NOTION_CONCURRENCY = 3;
const SHEET_FLUSH_BATCH = 20;
const DRY_RUN = false;

const MISSING_IMG =
  "https://raw.githubusercontent.com/damramat/pokemon-assets/main/missing.png";

// =====================================================
// INIT
// =====================================================
const notion = new Client({ auth: NOTION_TOKEN });
const notionLimit = pLimit(NOTION_CONCURRENCY);

// =====================================================
// HELPERS
// =====================================================

// =====================================================
// CACHE RefForme Notion (Id -> page_id)
// =====================================================
const refFormeById = new Map();

async function loadRefFormeCache() {
  console.log("📦 Chargement cache RefForme (Id → page_id)");

  let cursor = undefined;

  do {
    const res = await notion.databases.query({
      database_id: NOTION_DB_REF_FORME,
      start_cursor: cursor,
      page_size: 100,
    });

    res.results.forEach((page) => {
      const idProp = page.properties?.Id;
      if (idProp?.type === "number" && idProp.number !== null) {
        refFormeById.set(String(idProp.number), page.id);
      }
    });

    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  console.log(`✅ Cache RefForme chargé (${refFormeById.size} pages)`);
}

function buildEvolutionsRelation(ligne, rowNum) {
  const raw = (ligne.evol_ids || "").toString().trim();
  if (!raw) return null;

  const relations = [];

  raw.split(",").map((s) => s.trim()).forEach((evolId) => {
    const pageId = refFormeById.get(evolId);

    if (!pageId) {
      console.error(
        `⚠️ [EVOL NOT FOUND] L${rowNum} → evol_id=${evolId} (aucune page RefForme avec Id=${evolId})`
      );
      return;
    }

    relations.push({ id: pageId });
  });

  if (!relations.length) return null;

  return { relation: relations };
}

const sha256 = (t) => crypto.createHash("sha256").update(t).digest("hex");

const yesNoVersBool = (v) =>
  ["yes", "true", "oui", "1"].includes((v || "").toString().toLowerCase());

const parseNumber = (v) => {
  if (v === undefined || v === null) return null;
  const n = Number(v.toString().trim());
  return Number.isNaN(n) ? null : n;
};

function parseDateSheet(v) {
  if (!v) return null;
  const s = v.toString().trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

const COLONNES_HASH = [
  "Nom","Id","NumeroDex","Num&Nom","Forme_Type","Dispo","Evol bonbon",
  "Forme_NomForme","Effet aventure existant","Nom Effet Aventure","PC Max",
  "Stats","Types","Région","exclusifs régionaux","exclusifs région lieux",
  "carte exclusifs régionaux","NomEn","EvolTexte","evol_ids","image_url","DateAjout"
];

function calculerHash(ligne) {
  const data = {};
  COLONNES_HASH.forEach((c) => (data[c] = (ligne[c] || "").toString().trim()));
  return sha256(JSON.stringify(data));
}

// =====================================================
// GOOGLE SHEET
// =====================================================
async function getSheets() {
  if (!GOOGLE_CREDENTIALS_PATH) {
    throw new Error("GOOGLE_APPLICATION_CREDENTIALS non défini");
  }

  if (!require("fs").existsSync(GOOGLE_CREDENTIALS_PATH)) {
    throw new Error(`Credentials introuvables : ${GOOGLE_CREDENTIALS_PATH}`);
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: GOOGLE_CREDENTIALS_PATH,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  return google.sheets({ version: "v4", auth: await auth.getClient() });
}


function colLetter(i) {
  let s = "", n = i + 1;
  while (n) {
    s = String.fromCharCode(((n - 1) % 26) + 65) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

async function flushSheetBatch(sheets, headers, batch) {
  const iId = headers.indexOf("notion_page_id");
  const iSync = headers.indexOf("last_sync");
  const iHash = headers.indexOf("sync_hash");

  const data = batch.flatMap((b) => [
    { range: `RefForme!${colLetter(iId)}${b.row}`, values: [[b.pageId]] },
    { range: `RefForme!${colLetter(iSync)}${b.row}`, values: [[b.lastSync]] },
    { range: `RefForme!${colLetter(iHash)}${b.row}`, values: [[b.hash]] },
  ]);

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: GOOGLE_SHEET_ID,
    requestBody: { valueInputOption: "RAW", data },
  });

  console.log(`💾 Sheet flush (${batch.length})`);
}

// =====================================================
// NOTION HELPERS
// =====================================================
function buildIcon(ligne) {
  const url = resolveImageUrl(ligne);
  if (!url) return null;
  return {
    type: "external",
    external: { url },
  };
}


function resolveImageUrl(ligne) {
  const raw = (ligne.image_url || "").toString().trim();
  if (!raw) return null;
  if (raw === "INDISPO") return MISSING_IMG;
  if (raw.startsWith("http")) return raw;
  return null;
}

function setRich(props, k, v) {
  if (!v) return;
  props[k] = { rich_text: [{ text: { content: v.toString().trim() } }] };
}
function setSelect(props, k, v) {
  if (!v) return;
  props[k] = { select: { name: v.toString().trim() } };
}
function setMulti(props, k, v) {
  if (!v) return;
  const arr = v.split(",").map((s) => s.trim()).filter(Boolean);
  if (arr.length) props[k] = { multi_select: arr.map((x) => ({ name: x })) };
}

function buildProps(ligne) {
  const p = {};
  if (ligne.Nom) p.Nom = { title: [{ text: { content: ligne.Nom } }] };

  const id = parseNumber(ligne.Id);
  if (id !== null) p.Id = { number: id };

  setRich(p, "Num&Nom", ligne["Num&Nom"]);
  setSelect(p, "Forme_Type", ligne.Forme_Type);
  p.Dispo = { checkbox: yesNoVersBool(ligne.Dispo) };
  setMulti(p, "Evol bonbon", ligne["Evol bonbon"]);
  setRich(p, "Forme_NomForme", ligne.Forme_NomForme);
  p["Effet aventure existant"] = { checkbox: yesNoVersBool(ligne["Effet aventure existant"]) };
  setRich(p, "Nom Effet Aventure", ligne["Nom Effet Aventure"]);
  const pc = parseNumber(ligne["PC Max"]);
  if (pc !== null) p["PC Max"] = { number: pc };
  setRich(p, "Stats", ligne.Stats);
  setMulti(p, "Types", ligne.Types);
  setSelect(p, "Région", ligne.Région);
  p["exclusifs régionaux"] = { checkbox: yesNoVersBool(ligne["exclusifs régionaux"]) };
  setRich(p, "exclusifs région lieux", ligne["exclusifs région lieux"]);
  setRich(p, "carte exclusifs régionaux", ligne["carte exclusifs régionaux"]);
  setRich(p, "NomEn", ligne.NomEn);
  setRich(p, "EvolTexte", ligne.EvolTexte);

  const dateAjout = parseDateSheet(ligne.DateAjout);
  if (dateAjout) p.DateAjout = { date: { start: dateAjout } };
  
  const imageUrl = resolveImageUrl(ligne);
  if (imageUrl) {
    p.Image = {
      files: [
        {
          type: "external",
          name: imageUrl.split("/").pop() || "image.png",
          external: { url: imageUrl },
        },
      ],
    };
  }
  
  // ⚠️ Évolutions gérées ailleurs (nécessite le cache)

  return p;
}

// =====================================================
// MAIN
// =====================================================
async function main() {
  console.log("==============================================");
  console.log("🚀 SYNC RefForme SHEET → NOTION (CONCURRENT)");
  console.log("==============================================");

  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: "RefForme",
  });

  const headers = res.data.values[0];
  const rows = res.data.values.slice(1);

  const sheetQueue = [];
  let writerRunning = true;

  const writer = (async () => {
    while (writerRunning || sheetQueue.length) {
      if (sheetQueue.length >= SHEET_FLUSH_BATCH || (!writerRunning && sheetQueue.length)) {
        const batch = sheetQueue.splice(0, SHEET_FLUSH_BATCH);
        await flushSheetBatch(sheets, headers, batch);
      } else {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  })();

  let created = 0, updated = 0, skipped = 0;
  const nowIso = new Date().toISOString();
  await loadRefFormeCache();

  await Promise.all(
    rows.map((r, i) =>
      notionLimit(async () => {
        const ligne = {};
        headers.forEach((h, idx) => (ligne[h] = r[idx] ?? ""));
        const rowNum = i + 2;

        const id = (ligne.Id || "").toString().trim();
        const nom = (ligne.Nom || "").toString().trim();

        const hash = calculerHash(ligne);
        const oldHash = (ligne.sync_hash || "").trim();
        const pageId = (ligne.notion_page_id || "").trim();

        if (oldHash && oldHash === hash && pageId) {
          skipped++;
          return;
        }

        const props = buildProps(ligne);
		
		// ============================
		// ÉVOLUTIONS (relation RefForme)
		// ============================
		const evolRelation = buildEvolutionsRelation(ligne, rowNum);
		if (evolRelation) {
		  props["Évolutions"] = evolRelation;
		}

        const icon = buildIcon(ligne);

        try {
          let finalPageId = pageId;

          if (!pageId) {
            if (!DRY_RUN) {
              const page = await notion.pages.create({
                parent: { database_id: NOTION_DB_REF_FORME },
                properties: props,
                icon,
              });
              finalPageId = page.id;
            }
            created++;
            console.log(`➕ [CREATION] L${rowNum} - Id=${id} Nom="${nom}"`);
          } else {
            if (!DRY_RUN) {
              await notion.pages.update({
                page_id: pageId,
                properties: props,
                icon,
              });
            }
            updated++;
            console.log(`✏️ [UPDATE] L${rowNum} - Id=${id} Nom="${nom}"`);
          }

          sheetQueue.push({
            row: rowNum,
            pageId: finalPageId,
            lastSync: nowIso,
            hash,
          });
        } catch (e) {
          console.error(`❌ ERREUR L${rowNum} Id=${id} : ${e.message}`);
        }
      })
    )
  );

  writerRunning = false;
  await writer;

  console.log("==============================================");
  console.log(`✅ FIN — create:${created} update:${updated} skip:${skipped}`);
  console.log("==============================================");
}

main().catch((e) => {
  console.error("❌ ERREUR FATALE", e);
});
