#!/usr/bin/env npx tsx
/**
 * Research Pipeline server — shared AgentDB for 3-stage pipeline.
 */
import { startHttp } from "../../src/mcp/index.js";

const { port } = await startHttp("./pipeline-data", {
  port: 3001,
  host: "127.0.0.1",
  dbOpts: { writeMode: "group" },
  authTokens: {
    "researcher-token": { agentId: "researcher" },
    "analyst-token": { agentId: "analyst" },
    "writer-token": { agentId: "writer" },
  },
});

console.log(`\n🟢 Pipeline server on http://127.0.0.1:${port}/mcp\n`);
