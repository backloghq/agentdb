#!/usr/bin/env npx tsx
/**
 * Code Review Pipeline — AgentDB HTTP server.
 */
import { startHttp } from "../../src/mcp/index.js";

const { port } = await startHttp("./review-data", {
  port: 3002,
  host: "127.0.0.1",
  dbOpts: { writeMode: "group" },
  authTokens: {
    "coder-token": { agentId: "coder" },
    "reviewer-token": { agentId: "reviewer" },
    "tester-token": { agentId: "tester" },
  },
});

console.log(`\n🟢 Code Review server on http://127.0.0.1:${port}/mcp\n`);
