#!/usr/bin/env npx tsx
/**
 * Multi-agent AgentDB server.
 */
import { startHttp } from "../../src/mcp/index.js";

const PORT = 3000;
const DATA_DIR = "./taskboard-data";

const { port } = await startHttp(DATA_DIR, {
  port: PORT,
  host: "127.0.0.1",
  dbOpts: { writeMode: "group" },
  authTokens: {
    "planner-token": { agentId: "planner", permissions: { read: true, write: true, admin: true } },
    "worker-code-token": { agentId: "worker-code", permissions: { read: true, write: true, admin: false } },
    "worker-research-token": { agentId: "worker-research", permissions: { read: true, write: true, admin: false } },
  },
});

console.log(`\n🟢 AgentDB server running on http://127.0.0.1:${port}/mcp\n`);
