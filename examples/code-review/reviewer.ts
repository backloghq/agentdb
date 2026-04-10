#!/usr/bin/env npx tsx
/**
 * Reviewer Agent — reviews code for security/bugs using Ollama (local).
 * Code stays on your machine — never sent to a cloud API.
 */
import { AgentDBClient } from "./mcp-client.js";
import { askOllama } from "./ollama.js";

const db = new AgentDBClient("http://127.0.0.1:3002/mcp", "reviewer-token");
await db.connect();
console.log("[reviewer] Connected (Ollama — local, private)");

async function processCode(id: string): Promise<void> {
  const { record: code } = await db.callTool("db_find_one", { collection: "code", id }) as {
    record: Record<string, unknown> | null;
  };
  if (!code || code.status !== "pending") return;

  try {
    await db.callTool("db_update", {
      collection: "code",
      filter: { _id: id },
      update: { $set: { status: "reviewing", processor: "reviewer" } },
      expectedVersion: code._version,
    });
  } catch { return; }

  console.log(`[reviewer] Reviewing: ${code.filename}`);

  const review = await askOllama(
    `You are a security-focused code reviewer. Review the code for:
1. Security vulnerabilities (injection, auth issues, data exposure)
2. Bugs and edge cases
3. Best practices and code quality

Return a JSON object with:
- issues: array of { severity: "critical"|"warning"|"info", description: string, suggestion: string }
- approved: boolean
- summary: string (1-2 sentence overall assessment)`,
    `Review this ${code.language} code:\n\nFilename: ${code.filename}\n\n${code.code}`,
    { json: true },
  );

  let parsed: { issues: unknown[]; approved: boolean; summary: string };
  try {
    parsed = JSON.parse(review);
  } catch {
    parsed = { issues: [], approved: true, summary: review.substring(0, 200) };
  }

  await db.callTool("db_insert", {
    collection: "reviews",
    record: {
      codeId: id,
      specId: code.specId,
      filename: code.filename,
      issues: parsed.issues,
      approved: parsed.approved,
      summary: parsed.summary,
      author: "reviewer (Ollama)",
      status: "pending",
      timestamp: new Date().toISOString(),
    },
  });

  const issueCount = Array.isArray(parsed.issues) ? parsed.issues.length : 0;
  console.log(`[reviewer] Reviewed: ${code.filename} — ${parsed.approved ? "APPROVED" : "NEEDS WORK"} (${issueCount} issues)`);
  console.log(`[reviewer] ${parsed.summary}\n`);

  await db.callTool("db_update", {
    collection: "code",
    filter: { _id: id },
    update: { $set: { status: "reviewed" } },
  });
}

const { records: existing } = await db.callTool("db_find", {
  collection: "code",
  filter: { status: "pending" },
}) as { records: Array<Record<string, unknown>> };
for (const r of existing) await processCode(r._id as string);

await db.subscribe("code", async (event) => {
  if (event.event !== "db_change" || event.type !== "insert") return;
  for (const id of event.ids as string[]) await processCode(id);
});

console.log("[reviewer] Listening for code to review...\n");
