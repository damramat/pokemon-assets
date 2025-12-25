const path = require("path");
require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
});

const { google } = require("googleapis");
const axios = require("axios");
const crypto = require("crypto");
const { Client } = require("@notionhq/client");
const pLimit = require("p-limit").default;

// =====================================================
// CONFIG
// =====================================================
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DB_REF_ETAT2 = process.env.NOTION_DATABASE_ID_REF_ETAT2;
const DB_REF_ESPECE = process.env.NOTION_DATABASE_ID_REF_ESPECE;
const DB_REF_FORME = process.env.NOTION_DATABASE_ID_REF_FORME;

const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;

const fs = require("fs");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const GOOGLE_CREDENTIALS_ABS_PATH = path.resolve(
  PROJECT_ROOT,
  process.env.GOOGLE_APPLICATION_CREDENTIALS
);

if (!fs.existsSync(GOOGLE_CREDENTIALS_ABS_PATH)) {
  throw new Error(
    `❌ Credentials Google introuvables : ${GOOGLE_CREDENTIALS_ABS_PATH}`
  );
}

const SHEET_NAME = "RefEtat";

const TEST_DEX1 = (process.env.TEST_DEX1 ?? "false").toLowerCase() === "true";
const NOTION_CONCURRENCY = 3;
const SHEET_FLUSH_BATCH = Number(process.env.SHEET_FLUSH_BATCH ?? "20");

const MISSING_IMG_RAW =
  "https://raw.githubusercontent.com/damramat/pokemon-assets/main/missing.png";

// =====================================================
// INIT
// =====================================================
const notion = new Client({ auth: NOTION_TOKEN });
const notionLimit = pLimit(NOTION_CONCURRENCY);

// =====================================================
// HELPERS
// =====================================================
const nowIso = () => new Date().toISOString();
const sha256 = (t) => crypto.createHash("sha256").update(t).digest("hex");
const norm = (v) => (v ?? "").toString().trim();

const splitMulti = (v) =>
  norm(v).split(",").map((x) => x.trim()).filter(Boolean);

const dispoToBool = (v) =>
  ["yes", "true", "1"].includes(norm(v).toLowerCase());

function toNotionDate(v) {
  if (!v) return null;
  const s = norm(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

// =====================================================
// GOOGLE SHEETS
// =====================================================
async function getSheets() {
  const auth = new google.auth.GoogleAuth({
    keyFile: GOOGLE_CREDENTIALS_ABS_PATH,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  return google.sheets({
    version: "v4",
    auth: await auth.getClient(),
  });
}

const colLetter = (i) => {
  let s = "", n = i + 1;
  while (n) {
    s = String.fromCharCode(((n - 1) % 26) + 65) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

async function flushSheetUpdates(sheets, headers, batch) {
  const idxId = headers.indexOf("notion_page_id");
  const idxSync = headers.indexOf("last_sync");
  const idxHash = headers.indexOf("sync_hash");

  const data = batch.flatMap((u) => {
    const r = u.row + 2;
    return [
      { range: `${SHEET_NAME}!${colLetter(idxId)}${r}`, values: [[u.pageId]] },
      { range: `${SHEET_NAME}!${colLetter(idxSync)}${r}`, values: [[u.lastSync]] },
      { range: `${SHEET_NAME}!${colLetter(idxHash)}${r}`, values: [[u.hash]] },
    ];
  });

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: GOOGLE_SHEET_ID,
    requestBody: { valueInputOption: "RAW", data },
  });

  console.log(`💾 Sheet flush (${batch.length})`);
}

// =====================================================
// NOTION LOADERS
// =====================================================
async function fetchAll(databaseId) {
  let res = [], cursor;
  do {
    const q = await notion.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
      page_size: 100,
    });
    res.push(...q.results);
    cursor = q.next_cursor;
  } while (cursor);
  return res;
}

async function withNotionRetry(fn, label, maxRetry = 5) {
  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (e) {
      attempt++;

      const status = e.status || e.code;
      const retryable =
        status === 503 ||
        status === 429 ||
        e.code === "service_unavailable" ||
        e.code === "rate_limited";

      if (!retryable || attempt > maxRetry) {
        console.error(`❌ NOTION FAIL [${label}]`, e.message);
        throw e;
      }

      const wait = 1000 * attempt;
      console.warn(
        `⚠️ Notion retry ${attempt}/${maxRetry} [${label}] (${status}) → wait ${wait}ms`
      );

      await new Promise((r) => setTimeout(r, wait));
    }
  }
}


// =====================================================
// MAIN
// =====================================================
async function main() {
  console.log("==============================================");
  console.log("🚀 SYNC SHEET → NOTION (FAST & SAFE)");
  console.log("==============================================");

  const sheets = await getSheets();

  const sheetRes = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: SHEET_NAME,
  });

  const headers = sheetRes.data.values[0];
  const rows = sheetRes.data.values.slice(1);
  const idx = Object.fromEntries(headers.map((h, i) => [h, i]));

  console.log(`📄 Lignes sheet : ${rows.length}`);

  console.log("📥 Chargement RefEspece / RefForme…");
  const espece = new Map(
    (await fetchAll(DB_REF_ESPECE)).map((p) => [
      String(p.properties.NumeroDex?.number),
      p.id,
    ])
  );
  const forme = new Map(
    (await fetchAll(DB_REF_FORME)).map((p) => [
      String(p.properties.Id?.number),
      p.id,
    ])
  );
  console.log("✅ Référentiels chargés");

  // ===============================
  // WRITER GOOGLE SHEET (batch)
  // ===============================
  const queue = [];
  let writerRunning = true;

  const writer = (async () => {
    while (writerRunning || queue.length > 0) {
      if (queue.length >= SHEET_FLUSH_BATCH || (!writerRunning && queue.length)) {
        const batch = queue.splice(0, SHEET_FLUSH_BATCH);
        await flushSheetUpdates(sheets, headers, batch);
      } else {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  })();

  // ===============================
  // SCAN RAPIDE DU SHEET
  // ===============================
  console.log("🔎 Scan rapide du sheet…");

  const actions = [];
  let skipped = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const dex = norm(r[idx.NumeroDex]);
    if (TEST_DEX1 && dex !== "1") continue;

    const payload = {
      Nom: norm(r[idx.Nom]),
      Id: Number(r[idx.Id]),
      Etat: splitMulti(r[idx["État"]]),
      Dispo: dispoToBool(r[idx.Dispo]),
      NumNom: norm(r[idx["Num&Nom"]]),
      Date: toNotionDate(r[idx.DateAjout]),
      Dex: dex,
      Forme: norm(r[idx.IdRefForme]),
      Img: norm(r[idx.image_url]),
    };

    let img = null;
    let isMissingImage = false;

    if (payload.Img.includes("INDISPO")) {
      img = MISSING_IMG_RAW;
      isMissingImage = true;
    } else if (payload.Img.startsWith("http")) {
      img = payload.Img;
    }

    const hash = sha256(JSON.stringify({ ...payload, ImageManquante: isMissingImage }));
    const sheetHash = norm(r[idx.sync_hash]);
    const pageId = norm(r[idx.notion_page_id]);

    if (sheetHash && sheetHash === hash && pageId) {
      skipped++;
      continue;
    }

    actions.push({ row: i, payload, img, isMissingImage, hash, pageId });
  }

  console.log(`📊 Scan terminé — actions:${actions.length} skip:${skipped}`);

  // ===============================
  // APPLY NOTION (limit = 3)
  // ===============================
  let created = 0;
  let updated = 0;

  console.log("🚀 Application Notion…");

  await Promise.all(
    actions.map((a) =>
      notionLimit(async () => {
        const p = a.payload;

        const props = {
          Nom: { title: [{ text: { content: p.Nom } }] },
          Id: { number: p.Id },
          État: { multi_select: p.Etat.map((n) => ({ name: n })) },
          Dispo: { checkbox: p.Dispo },
          "Num&Nom": p.NumNom
            ? { rich_text: [{ text: { content: p.NumNom } }] }
            : { rich_text: [] },
          ImageManquante: { checkbox: a.isMissingImage },
        };

        if (p.Date) props.DateAjout = { date: { start: p.Date } };
        if (espece.get(p.Dex)) props.RefEspece = { relation: [{ id: espece.get(p.Dex) }] };
        if (forme.get(p.Forme)) props.RefForme = { relation: [{ id: forme.get(p.Forme) }] };

        if (a.img) {
          props.Image = {
            files: [
              {
                type: "external",
                name: a.img.split("/").pop(),
                external: { url: a.img },
              },
            ],
          };
        }

        let pageId = a.pageId;

        const icon = a.img
          ? { type: "external", external: { url: a.img } }
          : undefined;
        
        try {
          if (!pageId) {
            const createdPage = await withNotionRetry(
              () =>
                notion.pages.create({
                  parent: { database_id: DB_REF_ETAT2 },
                  properties: props,
                  icon,
                }),
              `CREATE ${p.Nom}`
            );
        
            pageId = createdPage.id;
            created++;
            console.log(`➕ CREATE [${p.Nom}]`);
          } else {
            await withNotionRetry(
              () =>
                notion.pages.update({
                  page_id: pageId,
                  properties: props,
                  icon,
                }),
              `UPDATE ${p.Nom}`
            );
        
            updated++;
            console.log(`✏️ UPDATE [${p.Nom}]`);
          }
        
          // ✅ On écrit dans le sheet SEULEMENT si Notion a réussi
          queue.push({
            row: a.row,
            pageId,
            lastSync: nowIso(),
            hash: a.hash,
          });
        } catch (e) {
          // ❗ ligne en échec → NON marquée comme syncée
          console.error(`🚨 ABANDON [${p.Nom}] — sera reprise au prochain run`);
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
  console.error("❌ ERREUR:", e);
  process.exit(1);
});
