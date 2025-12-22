const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const PROJECT_ROOT = path.resolve(__dirname, ".."); // dossier qui contient .env
const GOOGLE_CREDENTIALS_ABS_PATH = path.resolve(
  PROJECT_ROOT,
  process.env.GOOGLE_APPLICATION_CREDENTIALS
);

const { Client } = require("@notionhq/client");
const { google } = require("googleapis");
const crypto = require("crypto");
const pLimit = require("p-limit").default;
const https = require("https");

// =====================================================
// CONFIG
// =====================================================
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DB_REF_ESPECE = process.env.NOTION_DATABASE_ID_REF_ESPECE;

const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_CREDENTIALS_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS;

const SHEET_TAB = "RefEspece";
const NOTION_CONCURRENCY = 3;
const SHEET_FLUSH_BATCH = 20;
const DRY_RUN = false;

const MISSING_IMAGE_URL = "https://raw.githubusercontent.com/damramat/pokemon-assets/main/missing.png";

// Colonnes incluses dans le hash
const COLONNES_HASH = [
  "Nom",
  "NumeroDex",
  "Statut",
  "Bébé",
  "NomEn",
  "Gen",
  "image_url",
];

// Colonnes techniques (⚠️ image_url = H → décale J/K/L en K/L/M)
const TECH_COLS = {
  pageId: 10,   // K
  lastSync: 11, // L
  hash: 12,     // M
};

// =====================================================
// INIT
// =====================================================
const notion = new Client({ auth: NOTION_TOKEN });
const notionLimit = pLimit(NOTION_CONCURRENCY);

// =====================================================
// HELPERS
// =====================================================
const sha256 = (x) =>
  crypto.createHash("sha256").update(x, "utf8").digest("hex");

const yesNoVersBool = (v) =>
  ["yes", "true", "oui", "1"].includes((v ?? "").toString().toLowerCase());

const parseNombreOuNull = (v) => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
};

function calculerSyncHash(ligne) {
  const d = {};
  for (const col of COLONNES_HASH) {
    d[col] = (ligne[col] ?? "").toString().trim();
  }
  return sha256(JSON.stringify(d));
}

function colLetter(i) {
  let s = "", n = i + 1;
  while (n) {
    s = String.fromCharCode(((n - 1) % 26) + 65) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function isValidHttpUrl(value) {
  if (!value) return false;
  if (typeof value !== "string") return false;

  const v = value.trim().toLowerCase();

  // règles métier explicites
  if (v === "indispo" || v === "n/a" || v === "na") return false;

  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function checkImageUrl(url) {
  return new Promise((resolve) => {
    if (!isValidHttpUrl(url)) {
      return resolve(false);
    }

    https
      .request(url, { method: "HEAD", timeout: 5000 }, (res) => {
        resolve(res.statusCode >= 200 && res.statusCode < 300);
      })
      .on("error", () => resolve(false))
      .end();
  });
}

// =====================================================
// GOOGLE SHEET
// =====================================================
async function getSheets() {
  if (!GOOGLE_CREDENTIALS_ABS_PATH) {
    throw new Error("GOOGLE_APPLICATION_CREDENTIALS non défini");
  }

  if (!require("fs").existsSync(GOOGLE_CREDENTIALS_ABS_PATH)) {
    throw new Error(`Credentials introuvables : ${GOOGLE_CREDENTIALS_ABS_PATH}`);
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: GOOGLE_CREDENTIALS_ABS_PATH,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  return google.sheets({ version: "v4", auth: await auth.getClient() });
}

async function flushSheetBatch(sheets, batch) {
  const data = batch.flatMap((b) => [
    {
      range: `${SHEET_TAB}!${colLetter(TECH_COLS.pageId)}${b.row}`,
      values: [[b.pageId]],
    },
    {
      range: `${SHEET_TAB}!${colLetter(TECH_COLS.lastSync)}${b.row}`,
      values: [[b.lastSync]],
    },
    {
      range: `${SHEET_TAB}!${colLetter(TECH_COLS.hash)}${b.row}`,
      values: [[b.hash]],
    },
  ]);

  if (!DRY_RUN) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: GOOGLE_SHEET_ID,
      requestBody: { valueInputOption: "RAW", data },
    });
  }

  console.log(`💾 Sheet flush (${batch.length})`);
}

// =====================================================
// NOTION – Statut select auto-create
// =====================================================
let statutOptions = null;
let schemaLock = Promise.resolve();

async function loadStatutOptions() {
  const db = await notion.databases.retrieve({
    database_id: NOTION_DB_REF_ESPECE,
  });

  const prop = db.properties["Statut"];
  if (!prop || prop.type !== "select") {
    throw new Error(`❌ Propriété Notion "Statut" invalide`);
  }

  return new Set(prop.select.options.map((o) => o.name));
}

async function ensureStatutOptionExists(value) {
  if (!value) return;

  if (!statutOptions) statutOptions = await loadStatutOptions();
  if (statutOptions.has(value)) return;

  schemaLock = schemaLock.then(async () => {
    statutOptions = await loadStatutOptions();
    if (statutOptions.has(value)) return;

    console.log(`🧩 Ajout option Statut : "${value}"`);

    if (!DRY_RUN) {
      await notion.databases.update({
        database_id: NOTION_DB_REF_ESPECE,
        properties: {
          Statut: {
            select: {
              options: [...statutOptions].map((n) => ({ name: n })).concat([{ name: value }]),
            },
          },
        },
      });
    }

    statutOptions.add(value);
  });

  await schemaLock;
}

// =====================================================
// NOTION – Build properties
// =====================================================
function construireProps(ligne, imageOk, finalImageUrl) {
  const props = {};

  props["Nom"] = {
    title: [{ text: { content: ligne["Nom"].toString().trim() } }],
  };

  const numDex = parseNombreOuNull(ligne["NumeroDex"]);
  if (numDex !== null) props["NumeroDex"] = { number: numDex };

  const gen = parseNombreOuNull(ligne["Gen"]);
  if (gen !== null) props["Gen"] = { number: gen };

  const statut = ligne["Statut"]?.toString().trim();
  if (statut) props["Statut"] = { select: { name: statut } };

  props["Bébé"] = { checkbox: yesNoVersBool(ligne["Bébé"]) };

  if (ligne["NomEn"]) {
    props["NomEn"] = {
      rich_text: [{ text: { content: ligne["NomEn"].toString().trim() } }],
    };
  }

  props["ImageManquante"] = { checkbox: !imageOk };

  props["Image"] = {
    files: [
   	 {
   	 type: "external",
   	 name: imageOk ? "image" : "missing",
   	 external: { url: finalImageUrl },
   	 },
    ],
  };

  return props;
}

// =====================================================
// MAIN
// =====================================================
async function main() {
  console.log("==============================================");
  console.log("🚀 SYNC RefEspece SHEET → NOTION (avec images)");
  console.log("==============================================");

  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: SHEET_TAB,
  });

  const headers = res.data.values[0];
  const rows = res.data.values.slice(1);

  let created = 0, updated = 0, skipped = 0;
  const nowIso = new Date().toISOString();
  const sheetQueue = [];
  let writerRunning = true;

  const writer = (async () => {
    while (writerRunning || sheetQueue.length) {
      if (sheetQueue.length >= SHEET_FLUSH_BATCH || (!writerRunning && sheetQueue.length)) {
        await flushSheetBatch(sheets, sheetQueue.splice(0, SHEET_FLUSH_BATCH));
      } else {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
  })();

  await Promise.all(
    rows.map((r, i) =>
      notionLimit(async () => {
        const rowNum = i + 2;
        const ligne = {};
        headers.forEach((h, idx) => (ligne[h] = r[idx] ?? ""));

        if (!ligne["Nom"]) {
          skipped++;
          return;
        }

        const oldHash = ligne["sync_hash"];
        const hash = calculerSyncHash(ligne);
        const pageId = ligne["notion_page_id"];

        if (pageId && oldHash === hash) {
          skipped++;
          return;
        }

        const rawImageUrl = ligne["image_url"]?.toString().trim();

		let finalImageUrl = rawImageUrl;
		let imageOk = await checkImageUrl(rawImageUrl);
		
		if (!imageOk) {
			finalImageUrl = MISSING_IMAGE_URL;
		}

        await ensureStatutOptionExists(ligne["Statut"]);

        const props = construireProps(ligne, imageOk, finalImageUrl);

        let finalPageId = pageId;

        if (!pageId) {
          if (!DRY_RUN) {
            const page = await notion.pages.create({
              parent: { database_id: NOTION_DB_REF_ESPECE },
              icon: {
				type: "external",
				external: { url: finalImageUrl },
			  },
              properties: props,
            });
            finalPageId = page.id;
          }
          created++;
          console.log(`➕ [CREATION] ${ligne["Nom"]} (#${ligne["NumeroDex"]})`);
        } else {
          if (!DRY_RUN) {
            await notion.pages.update({
              page_id: pageId,
              icon: {
				type: "external",
				external: { url: finalImageUrl },
			  },
              properties: props,
            });
          }
          updated++;
          console.log(`✏️ [UPDATE] ${ligne["Nom"]} (#${ligne["NumeroDex"]})`);
        }

        sheetQueue.push({
          row: rowNum,
          pageId: finalPageId,
          lastSync: nowIso,
          hash,
        });
      })
    )
  );

  writerRunning = false;
  await writer;

  console.log("==============================================");
  console.log(`✅ FIN — create:${created} update:${updated} skip:${skipped}`);
  console.log("==============================================");
}

main().catch((e) => console.error("❌ ERREUR FATALE", e));
