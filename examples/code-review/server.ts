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
  description: "Security and quality reviews produced by the Reviewer agent.",
  instructions: "Each record corresponds to one code_submissions record. Query by submission_id to find the review for a given submission. Do not insert directly — reviews are written by the Reviewer agent.",
  fields: {
    submission_id: { type: "string", required: true, description: "ID of the code_submissions record being reviewed" },
    severity: { type: "enum", values: ["low", "medium", "high", "critical"], required: true, description: "Worst-case issue severity found in the submission" },
    issues: { type: "string", description: "Structured list of issues found, in the reviewer's analysis format" },
    approved: { type: "boolean", required: true, description: "True if the submission passes review with no blocking issues" },
  },
  indexes: ["submission_id", "severity"],
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
