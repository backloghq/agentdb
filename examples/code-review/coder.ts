#!/usr/bin/env npx tsx
/**
 * Coder Agent — generates code from specs using Gemini 3 Flash.
 * Writes code to AgentDB + saves to output/ directory.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { AgentDBClient } from "./mcp-client.js";
import { askGemini } from "./gemini.js";

const db = new AgentDBClient("http://127.0.0.1:3002/mcp", "coder-token");
await db.connect();
console.log("[coder] Connected (Gemini 3 Flash)");

await mkdir("./output", { recursive: true });

async function processSpec(id: string): Promise<void> {
  const { record: spec } = await db.callTool("db_find_one", { collection: "specs", id }) as {
    record: Record<string, unknown> | null;
  };
  if (!spec || spec.status !== "pending") return;

  try {
    await db.callTool("db_update", {
      collection: "specs",
      filter: { _id: id },
      update: { $set: { status: "processing", processor: "coder" } },
      expectedVersion: spec._version,
    });
  } catch { return; }

  console.log(`[coder] Generating code for: "${spec.title}"`);

  const result = await askGemini(
    `You are an expert programmer. Generate clean, well-documented code for the given specification.
Return a JSON object with: filename (string), language (string), code (string).
The code should be production-ready with proper error handling.`,
    `Specification: ${spec.title}\n\nDetails: ${spec.description || spec.title}`,
    { json: true },
  );

  let parsed: { filename: string; language: string; code: string };
  try {
    parsed = JSON.parse(result);
  } catch {
    parsed = { filename: "implementation.ts", language: "typescript", code: result };
  }

  // Save to AgentDB
  await db.callTool("db_insert", {
    collection: "code",
    record: {
      specId: id,
      filename: parsed.filename,
      language: parsed.language,
      code: parsed.code,
      author: "coder (Gemini)",
      status: "pending",
      timestamp: new Date().toISOString(),
    },
  });

  // Save to disk
  await writeFile(`./output/${parsed.filename}`, parsed.code, "utf-8");
  console.log(`[coder] Generated: ${parsed.filename} (${parsed.language}) → output/${parsed.filename}`);

  await db.callTool("db_update", {
    collection: "specs",
    filter: { _id: id },
    update: { $set: { status: "coded" } },
  });
}

// Check existing specs
const { records: existing } = await db.callTool("db_find", {
  collection: "specs",
  filter: { status: "pending" },
}) as { records: Array<Record<string, unknown>> };
for (const r of existing) await processSpec(r._id as string);

// Subscribe for new specs
await db.subscribe("specs", async (event) => {
  if (event.event !== "db_change" || event.type !== "insert") return;
  for (const id of event.ids as string[]) await processSpec(id);
});

console.log("[coder] Listening for specs...\n");
