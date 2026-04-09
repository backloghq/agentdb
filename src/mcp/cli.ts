#!/usr/bin/env node
import { startStdio } from "./index.js";

const args = process.argv.slice(2);
let dataDir = "./agentdb-data";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--path" && args[i + 1]) {
    dataDir = args[i + 1];
    i++;
  }
}

startStdio(dataDir).catch((err) => {
  console.error("AgentDB MCP server failed to start:", err);
  process.exit(1);
});
