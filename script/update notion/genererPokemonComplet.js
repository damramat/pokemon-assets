require("dotenv").config();

const { google } = require("googleapis");
const crypto = require("crypto");
const { Client } = require("@notionhq/client");
const pLimit = require("p-limit").default;

// =====================================================
// CONFIG
// =====================================================
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DB_POKEMON = process.env.NOTION_DATABASE_ID_POKEMON;

const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS;

const SHEET_REF_ETAT = "RefEtat";
const SHEET_REF_FORME = "RefForme";
const SHEET_REF_ESPECE = "RefEspece";

const NOTION_CONCURRENCY = 3;
const SHEET_FLUSH_BATCH = 20;

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
const norm = (v) => (v ?? "").toString().trim();
const sha256 = (t) => crypto.createHash("sha256").update(t).digest("hex");
const nowIso = () => new Date().toISOString();

async function getSheets() {
  const auth = new google.auth.GoogleAuth({
    keyFile: GOOGLE_CREDENTIALS,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth: await auth.getClient() });
}

const colLetter = (i) => {
  let s = "", n = i + 1;
  while (n) {
    s = String.fromCharCode(((n - 1) % 26) + 65) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

// =====================================================
// GOOGLE SHEET FLUSH
// =====================================================
async function flushSheetUpdates(sheets, headers, batch) {
  const idxId = headers.indexOf("notion_page_id_pokemon");
  const idxSync = headers.indexOf("last_sync_pokemon");
  const idxHash = headers.indexOf("sync_hash_pokemon");

  if (idxId === -1 || idxSync === -1 || idxHash === -1) {
    throw new Error("❌ Colonnes techniques Pokémon introuvables dans RefEtat");
  }

  const data = batch.flatMap((u) => {
    const r = u.row + 2;
    return [
      { range: `${SHEET_REF_ETAT}!${colLetter(idxId)}${r}`, values: [[u.pageId]] },
      { range: `${SHEET_REF_ETAT}!${colLetter(idxSync)}${r}`, values: [[u.lastSync]] },
      { range: `${SHEET_REF_ETAT}!${colLetter(idxHash)}${r}`, values: [[u.hash]] },
    ];
  });

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: GOOGLE_SHEET_ID,
    requestBody: { valueInputOption: "RAW", data },
  });

  console.log(`💾 Sheet flush (${batch.length})`);
}

// =====================================================
// MAIN
// =====================================================
async function main() {
  console.log("==============================================");
  console.log("🚀 SYNC RefEtat → Pokémon (Notion)");
  console.log("==============================================");

  const sheets = await getSheets();

  // ===============================
  // Chargement RefEtat
  // ===============================
  const refEtatRes = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: SHEET_REF_ETAT,
  });

  const headers = refEtatRes.data.values[0];
  const rows = refEtatRes.data.values.slice(1);
  const idx = Object.fromEntries(headers.map((h, i) => [h, i]));

  console.log(`📄 RefEtat lignes : ${rows.length}`);

  // ===============================
  // Chargement RefForme → map Id → notion_page_id
  // ===============================
  console.log("📥 Chargement RefForme…");
  const refFormeRes = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: SHEET_REF_FORME,
  });
  const rfHeaders = refFormeRes.data.values[0];
  const rfRows = refFormeRes.data.values.slice(1);
  const rfIdx = Object.fromEntries(rfHeaders.map((h, i) => [h, i]));

  const mapForme = new Map();
  rfRows.forEach((r) => {
    const id = norm(r[rfIdx.Id]);
    const pid = norm(r[rfIdx.notion_page_id]);
    if (id && pid) mapForme.set(id, pid);
  });
  console.log(`✅ RefForme map : ${mapForme.size}`);

  // ===============================
  // Chargement RefEspece → map NumeroDex → notion_page_id
  // ===============================
  console.log("📥 Chargement RefEspece…");
  const refEspeceRes = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: SHEET_REF_ESPECE,
  });
  const reHeaders = refEspeceRes.data.values[0];
  const reRows = refEspeceRes.data.values.slice(1);
  const reIdx = Object.fromEntries(reHeaders.map((h, i) => [h, i]));

  const mapEspece = new Map();
  reRows.forEach((r) => {
    const dex = norm(r[reIdx.NumeroDex]);
    const pid = norm(r[reIdx.notion_page_id]);
    if (dex && pid) mapEspece.set(dex, pid);
  });
  console.log(`✅ RefEspece map : ${mapEspece.size}`);

  // ===============================
  // Writer Sheet (batch)
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
  // Traitement Pokémon
  // ===============================
  let created = 0, updated = 0, skipped = 0;

  await Promise.all(
    rows.map((r, i) =>
      notionLimit(async () => {
        const rowNum = i + 2;

        const numNom = norm(r[idx["Num&Nom"]]);
        const refEtatPageId = norm(r[idx.notion_page_id]);

        const idRefForme = norm(r[idx.IdRefForme]);
        const numeroDex = norm(r[idx.NumeroDex]);

        const refFormePageId = mapForme.get(idRefForme);
        const refEspecePageId = mapEspece.get(numeroDex);

        const imgRaw = norm(r[idx.image_url]);
        const img = imgRaw === "INDISPO" ? MISSING_IMG : imgRaw;

        const hashPayload = {
          numNom,
          refEtatPageId,
          refFormePageId,
          refEspecePageId,
          img,
        };
        const hash = sha256(JSON.stringify(hashPayload));

        const oldHash = norm(r[idx.sync_hash_pokemon]);
        const pageId = norm(r[idx.notion_page_id_pokemon]);

        if (oldHash && oldHash === hash && pageId) {
          skipped++;
          return;
        }

        const props = {
          Nom: { title: [{ text: { content: numNom } }] },
          RefEtat: { relation: [{ id: refEtatPageId }] },
        };

        if (refFormePageId) props.RefForme = { relation: [{ id: refFormePageId }] };
        if (refEspecePageId) props.RefEspece = { relation: [{ id: refEspecePageId }] };

        if (img) {
          props.Image = {
            files: [
              {
                type: "external",
                name: img.split("/").pop() || "image.png",
                external: { url: img },
              },
            ],
          };
        }

        try {
          let finalPageId = pageId;

          if (!pageId) {
            const createdPage = await notion.pages.create({
              parent: { database_id: DB_POKEMON },
              properties: props,
            });
            finalPageId = createdPage.id;
            created++;
            console.log(`➕ [CREATION] L${rowNum} Nom="${numNom}"`);
          } else {
            await notion.pages.update({
              page_id: pageId,
              properties: props,
            });
            updated++;
            console.log(`✏️ [UPDATE] L${rowNum} Nom="${numNom}"`);
          }

          queue.push({
            row: i,
            pageId: finalPageId,
            lastSync: nowIso(),
            hash,
          });
        } catch (e) {
          console.error(`❌ ERREUR Pokémon L${rowNum} "${numNom}" : ${e.message}`);
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
  console.error("❌ ERREUR FATALE:", e);
  process.exit(1);
});
