#!/usr/bin/env npx tsx
/**
 * Tester Agent — generates tests based on code + review using Gemini 3 Flash.
 * Reads the review feedback to write targeted tests.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { AgentDBClient } from "./mcp-client.js";
import { askGemini } from "./gemini.js";

const db = new AgentDBClient("http://127.0.0.1:3002/mcp", "tester-token");
await db.connect();
console.log("[tester] Connected (Gemini 3 Flash)");

await mkdir("./output", { recursive: true });

async function processReview(id: string): Promise<void> {
  const { record: review } = await db.callTool("db_find_one", { collection: "reviews", id }) as {
    record: Record<string, unknown> | null;
  };
  if (!review || review.status !== "pending") return;

  try {
    await db.callTool("db_update", {
      collection: "reviews",
      filter: { _id: id },
      update: { $set: { status: "testing", processor: "tester" } },
      expectedVersion: review._version,
    });
  } catch { return; }

  // Fetch the original code
  const { record: code } = await db.callTool("db_find_one", { collection: "code", id: review.codeId as string }) as {
    record: Record<string, unknown> | null;
  };
  if (!code) return;

  console.log(`[tester] Writing tests for: ${code.filename}`);

  const result = await askGemini(
    `You are an expert test engineer. Write comprehensive tests for the given code.
Consider the review feedback — write extra tests for any issues flagged.
Return a JSON object with: filename (string), code (string).
Use a popular testing framework appropriate for the language.`,
    `Code to test (${code.language}):\n\nFilename: ${code.filename}\n${code.code}\n\nReview feedback:\n${review.summary}\nIssues: ${JSON.stringify(review.issues)}`,
    { json: true },
  );

  let parsed: { filename: string; code: string };
  try {
    parsed = JSON.parse(result);
  } catch {
    const testFile = (code.filename as string).replace(/\.\w+$/, ".test$&");
    parsed = { filename: testFile, code: result };
  }

  await db.callTool("db_insert", {
    collection: "tests",
    record: {
      codeId: review.codeId,
      reviewId: id,
      specId: review.specId,
      filename: parsed.filename,
      code: parsed.code,
      author: "tester (Gemini)",
      timestamp: new Date().toISOString(),
    },
  });

  await writeFile(`./output/${parsed.filename}`, parsed.code, "utf-8");
  console.log(`[tester] Generated: ${parsed.filename} → output/${parsed.filename}`);

  await db.callTool("db_update", {
    collection: "reviews",
    filter: { _id: id },
    update: { $set: { status: "tested" } },
  });
}

const { records: existing } = await db.callTool("db_find", {
  collection: "reviews",
  filter: { status: "pending" },
}) as { records: Array<Record<string, unknown>> };
for (const r of existing) await processReview(r._id as string);

await db.subscribe("reviews", async (event) => {
  if (event.event !== "db_change" || event.type !== "insert") return;
  for (const id of event.ids as string[]) await processReview(id);
});

console.log("[tester] Listening for reviews to generate tests...\n");
