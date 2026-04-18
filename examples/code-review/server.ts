#!/usr/bin/env npx tsx
/**
 * Code Review Pipeline — AgentDB HTTP server.
 */
import { startHttp } from "../../src/mcp/index.js";
import { defineSchema } from "../../src/schema.js";

// Schema with rich agent context: description, instructions, and per-field
// descriptions. Persisted automatically to review-data/meta/reviews.schema.json
// on first open — agents can call db_get_schema to discover the collection's
// purpose and how to use it without reading the source code.
const reviewsSchema = defineSchema({
  name: "reviews",
  version: 1,
  description: "Security and quality reviews produced by the Reviewer agent on generated code.",
  instructions: "One record per code record. Query by codeId to find the review for a given code submission. Status flows pending → testing → tested as the Tester agent picks up the review. Do not insert directly — reviews are written by the Reviewer agent.",
  fields: {
    codeId: { type: "string", required: true, description: "ID of the code record being reviewed" },
    specId: { type: "string", description: "ID of the originating spec record" },
    filename: { type: "string", description: "Generated code filename the review is about" },
    approved: { type: "boolean", required: true, description: "True if the submission passes review with no blocking issues" },
    summary: { type: "string", maxLength: 2000, description: "One-paragraph summary of the review outcome" },
    author: { type: "string", description: "Who wrote the review — provider/model identifier (e.g. 'reviewer (Ollama)')" },
    status: { type: "enum", values: ["pending", "testing", "tested"], default: "pending", description: "Pipeline state — pending until Tester picks it up, then testing, then tested" },
    timestamp: { type: "date", description: "ISO timestamp when the review was written" },
  },
  indexes: ["codeId", "status"],
});

const { port, db } = await startHttp("./review-data", {
  port: 3002,
  host: "127.0.0.1",
  dbOpts: { writeMode: "group" },
  authTokens: {
    "coder-token": { agentId: "coder" },
    "reviewer-token": { agentId: "reviewer" },
    "tester-token": { agentId: "tester" },
  },
});

// Open the collection to trigger schema auto-persistence on first run
await db.collection(reviewsSchema);

console.log(`\n🟢 Code Review server on http://127.0.0.1:${port}/mcp\n`);
