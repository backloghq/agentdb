#!/usr/bin/env npx tsx
/**
 * Inject a topic into the pipeline and wait for the final report.
 */
import { AgentDBClient } from "./mcp-client.js";

const TOPIC = process.argv[2] || "The future of embedded databases for AI agents";

const db = new AgentDBClient("http://127.0.0.1:3001/mcp", "researcher-token");
await db.connect();

await db.callTool("db_insert", {
  collection: "topics",
  record: { title: TOPIC, status: "pending", createdAt: new Date().toISOString() },
});
console.log("Topic injected. Pipeline running...");

// Wait for the report
let attempts = 0;
const check = setInterval(async () => {
  const result = await db.callTool("db_find", { collection: "report" }) as { records: Array<Record<string, unknown>> };
  if (result.records.length > 0) {
    console.log("\n--- FINAL REPORT ---\n");
    console.log(result.records[0].content);
    console.log("\n--- END ---\n");
    clearInterval(check);
    await db.disconnect();
    process.exit(0);
  }
  if (++attempts > 60) {
    console.log("Timeout waiting for report.");
    clearInterval(check);
    await db.disconnect();
    process.exit(1);
  }
}, 2000);
