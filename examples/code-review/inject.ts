#!/usr/bin/env npx tsx
/**
 * Inject a spec into the pipeline and wait for the test output.
 */
import { AgentDBClient } from "./mcp-client.js";

const SPEC = process.argv[2] || "Implement a rate limiter middleware for Express.js";

const db = new AgentDBClient("http://127.0.0.1:3002/mcp", "coder-token");
await db.connect();

await db.callTool("db_insert", {
  collection: "specs",
  record: {
    title: SPEC,
    description: SPEC,
    status: "pending",
    createdAt: new Date().toISOString(),
  },
});
console.log(`Spec injected: "${SPEC}"\nPipeline running...\n`);

// Wait for tests to appear
let attempts = 0;
const check = setInterval(async () => {
  const result = await db.callTool("db_find", { collection: "tests" }) as { records: Array<Record<string, unknown>> };
  if (result.records.length > 0) {
    const test = result.records[0];
    const reviews = await db.callTool("db_find", { collection: "reviews" }) as { records: Array<Record<string, unknown>> };
    const review = reviews.records[0];

    console.log("═".repeat(60));
    console.log("PIPELINE COMPLETE");
    console.log("═".repeat(60));
    console.log(`\nCode:    output/${(await db.callTool("db_find", { collection: "code" }) as { records: Array<Record<string, unknown>> }).records[0]?.filename}`);
    console.log(`Review:  ${review?.approved ? "APPROVED" : "NEEDS WORK"} — ${review?.summary}`);
    console.log(`Tests:   output/${test.filename}`);
    console.log(`\nFiles saved to ./output/`);
    console.log("═".repeat(60));

    clearInterval(check);
    await db.disconnect();
    process.exit(0);
  }
  if (++attempts > 90) {
    console.log("Timeout waiting for pipeline.");
    clearInterval(check);
    await db.disconnect();
    process.exit(1);
  }
}, 2000);
