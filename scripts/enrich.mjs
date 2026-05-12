#!/usr/bin/env node
// Enrich NPS CSV with English translations + topic/sentiment classification via Claude.
// Usage:
//   ANTHROPIC_API_KEY=sk-... node enrich.mjs
//   node enrich.mjs                  (fallback: no translation/classification)
//
// Inputs:  ../data/order_nps_export.csv
// Outputs: ../data/responses.json    (consumed by nps-dashboard.html)
//          ../data/responses.cache.json   (per-id enrichment cache)

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "..", "data");
const CSV_PATH = path.join(DATA_DIR, "order_nps_export.csv");
const OUT_PATH = path.join(DATA_DIR, "responses.json");
const CACHE_PATH = path.join(DATA_DIR, "responses.cache.json");

const MODEL = "claude-haiku-4-5-20251001";
const BATCH_SIZE = 25;
const TOPICS = ["payment_window", "ui", "assortment"];

// ── CSV parsing ───────────────────────────────────────────────────────────
// Handles UTF-8 BOM, ; delimiter, "" quoted fields with embedded ; and "".
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ";") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") { /* skip */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const [header, ...data] = rows;
  return data
    .filter(r => r.length === header.length && r.some(v => v !== ""))
    .map(r => Object.fromEntries(header.map((h, i) => [h.trim(), r[i]])));
}

function normalize(raw) {
  const comment = (raw.comment ?? "").trim();
  return {
    id: Number(raw.id),
    order_id: Number(raw.order_id),
    rating: Number(raw.rating),
    comment: comment || null,
    order_value_usd: raw.order_value_usd ? Number(raw.order_value_usd) : null,
    created_at: raw.created_at ? new Date(raw.created_at.replace(" ", "T") + "Z").toISOString() : null,
  };
}

// ── Claude enrichment ─────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You classify and translate e-commerce NPS comments from a video-game web shop (in-game items, currency packs).

For each input comment, return one JSON object:
- id: number (echo back the input id)
- comment_en: faithful English translation. If already English, copy verbatim. Preserve meaning, do not editorialize.
- comment_lang: ISO 639-1 code of the source language ("en" if already English; "und" only if undetectable / pure emoji / single non-word like "ok").
- topics: array, subset of ["payment_window", "ui", "assortment"]. Empty array if none clearly apply.
    * payment_window: payment flow, checkout UX, card declined, slow/laggy payment, security checks freezing the user, payment methods (Apple Pay, Google Pay, QR), currency conversion, processing center issues, "translation at payment".
    * ui: shop interface (NOT the payment window itself), layout, navigation, slowness of the shop, bugs/glitches, ads in UI, localization of the shop UI, search/filters, multi-purchase ergonomics.
    * assortment: product range, prices being too high/low, missing items, requests for new bundles/items, discount/sale availability, complaints about offers running out.
- sentiment: "positive" | "neutral" | "negative"

Notes:
- A single comment can map to multiple topics.
- Generic praise ("good", "fast", "great", "thanks", "хорошо") → topics:[], sentiment:"positive".
- Empty/spam/noise → topics:[], sentiment:"neutral".

Return ONLY a JSON array of these objects. No prose, no markdown fences.`;

async function enrichBatch(client, items) {
  const userBlock = items.map(it =>
    `id=${it.id} | rating=${it.rating} | comment: ${JSON.stringify(it.comment)}`
  ).join("\n");

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userBlock }],
  });

  const text = resp.content.map(b => b.type === "text" ? b.text : "").join("").trim();
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");

  let parsed;
  try { parsed = JSON.parse(cleaned); }
  catch (e) {
    console.error("  ⚠ failed to parse model output:\n", text.slice(0, 300));
    throw e;
  }
  if (!Array.isArray(parsed)) throw new Error("expected JSON array");

  const byId = new Map(parsed.map(p => [Number(p.id), p]));
  return items.map(it => {
    const p = byId.get(it.id);
    if (!p) {
      return { id: it.id, comment_en: it.comment, comment_lang: "und", topics: [], sentiment: "neutral" };
    }
    return {
      id: it.id,
      comment_en: typeof p.comment_en === "string" ? p.comment_en : it.comment,
      comment_lang: typeof p.comment_lang === "string" ? p.comment_lang : "und",
      topics: Array.isArray(p.topics) ? p.topics.filter(t => TOPICS.includes(t)) : [],
      sentiment: ["positive", "neutral", "negative"].includes(p.sentiment) ? p.sentiment : "neutral",
    };
  });
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  if (!existsSync(CSV_PATH)) {
    console.error(`✗ CSV not found: ${CSV_PATH}`);
    console.error(`  Place the export at ${path.relative(process.cwd(), CSV_PATH)} and re-run.`);
    process.exit(1);
  }

  const csv = await readFile(CSV_PATH, "utf8");
  const raw = parseCsv(csv);
  const rows = raw.map(normalize).filter(r => Number.isFinite(r.id));
  console.log(`✓ parsed ${rows.length} rows from CSV`);

  const cache = existsSync(CACHE_PATH)
    ? JSON.parse(await readFile(CACHE_PATH, "utf8"))
    : {};

  const apiKey = process.env.ANTHROPIC_API_KEY;
  let processed = 0, fromCache = 0, skipped = 0;

  if (!apiKey) {
    console.warn("⚠ no ANTHROPIC_API_KEY — fallback mode (no translation, no classification)");
  }

  const enriched = [];
  const toProcess = [];

  for (const row of rows) {
    if (!row.comment) {
      enriched.push({ ...row, comment_en: null, comment_lang: null, topics: [], sentiment: null });
      skipped++;
      continue;
    }
    if (cache[row.id]) {
      enriched.push({ ...row, ...cache[row.id] });
      fromCache++;
      continue;
    }
    if (!apiKey) {
      enriched.push({ ...row, comment_en: row.comment, comment_lang: "und", topics: [], sentiment: null });
      continue;
    }
    toProcess.push(row);
  }

  if (toProcess.length && apiKey) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey });

    for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
      const batch = toProcess.slice(i, i + BATCH_SIZE);
      const batchNo = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(toProcess.length / BATCH_SIZE);
      process.stdout.write(`  batch ${batchNo}/${totalBatches} (${batch.length} comments)... `);
      try {
        const results = await enrichBatch(client, batch);
        for (const r of results) {
          cache[r.id] = {
            comment_en: r.comment_en,
            comment_lang: r.comment_lang,
            topics: r.topics,
            sentiment: r.sentiment,
          };
        }
        await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2));
        for (const row of batch) enriched.push({ ...row, ...cache[row.id] });
        processed += batch.length;
        console.log("ok");
      } catch (e) {
        console.log("FAIL");
        console.error("   ", e.message || e);
        for (const row of batch) {
          enriched.push({ ...row, comment_en: row.comment, comment_lang: "und", topics: [], sentiment: null });
        }
      }
    }
  }

  enriched.sort((a, b) => a.id - b.id);

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify({
    generated_at: new Date().toISOString(),
    source_csv: path.basename(CSV_PATH),
    model: apiKey ? MODEL : null,
    counts: { total: enriched.length, with_comment: enriched.length - skipped, processed, from_cache: fromCache },
    items: enriched,
  }, null, 2));

  console.log(`\n✓ ${enriched.length} items → ${path.relative(process.cwd(), OUT_PATH)}`);
  console.log(`  ${processed} processed, ${fromCache} from cache, ${skipped} without comment`);
}

main().catch(e => { console.error(e); process.exit(1); });
