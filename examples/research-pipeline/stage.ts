#!/usr/bin/env npx tsx
/**
 * Pipeline stage agent — generic stage that watches an input collection,
 * processes items with Ollama, and writes to an output collection.
 *
 * Usage: npx tsx stage.ts <name> <token> <input-collection> <output-collection> <system-prompt>
 */
import { AgentDBClient } from "./mcp-client.js";
import { askOllama } from "./ollama.js";

const NAME = process.argv[2] || "stage";
const TOKEN = process.argv[3] || "researcher-token";
const INPUT = process.argv[4] || "sources";
const OUTPUT = process.argv[5] || "insights";
const PROMPT = process.argv[6] || "Process the input and produce output.";

const db = new AgentDBClient("http://127.0.0.1:3001/mcp", TOKEN);
await db.connect();
console.log(`[${NAME}] Connected — watching "${INPUT}" → "${OUTPUT}"`);

let processing = false;

async function processItem(id: string): Promise<void> {
  if (processing) return;

  const { record } = await db.callTool("db_find_one", { collection: INPUT, id }) as {
    record: Record<string, unknown> | null;
  };
  if (!record || record.status !== "pending") return;

  // Claim it
  try {
    await db.callTool("db_update", {
      collection: INPUT,
      filter: { _id: id },
      update: { $set: { status: "processing", processor: NAME } },
      expectedVersion: record._version,
    });
  } catch { return; }

  processing = true;
  console.log(`[${NAME}] Processing: "${record.title || record._id}"`);

  const content = record.content || record.text || record.title || JSON.stringify(record);
  const result = await askOllama(PROMPT, content as string);

  // Write output
  await db.callTool("db_insert", {
    collection: OUTPUT,
    record: {
      sourceId: id,
      title: record.title,
      content: result,
      stage: NAME,
      status: "pending",
      timestamp: new Date().toISOString(),
    },
  });

  // Mark input as done
  await db.callTool("db_update", {
    collection: INPUT,
    filter: { _id: id },
    update: { $set: { status: "done" } },
  });

  console.log(`[${NAME}] Done: "${record.title || record._id}" → output in "${OUTPUT}"`);
  processing = false;
}

// Process existing items
const { records: existing } = await db.callTool("db_find", {
  collection: INPUT,
  filter: { status: "pending" },
}) as { records: Array<Record<string, unknown>> };

for (const r of existing) await processItem(r._id as string);

// Subscribe for new items
await db.subscribe(INPUT, async (event) => {
  if (event.event !== "db_change" || event.type !== "insert") return;
  for (const id of event.ids as string[]) await processItem(id);
});

console.log(`[${NAME}] Listening for new items in "${INPUT}"...\n`);
