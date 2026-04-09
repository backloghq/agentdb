#!/usr/bin/env node
import { startStdio, startHttp } from "./index.js";

const args = process.argv.slice(2);
let dataDir = "./agentdb-data";
let mode = "stdio";
let port = 3000;
let host = "127.0.0.1";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--path" && args[i + 1]) {
    dataDir = args[i + 1];
    i++;
  } else if (args[i] === "--http") {
    mode = "http";
  } else if (args[i] === "--port" && args[i + 1]) {
    port = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === "--host" && args[i + 1]) {
    host = args[i + 1];
    i++;
  }
}

if (mode === "http") {
  startHttp(dataDir, { port, host }).then(() => {
    console.error(`AgentDB MCP server running on http://${host}:${port}/mcp`);
  }).catch((err) => {
    console.error("AgentDB MCP HTTP server failed to start:", err);
    process.exit(1);
  });
} else {
  startStdio(dataDir).catch((err) => {
    console.error("AgentDB MCP server failed to start:", err);
    process.exit(1);
  });
}
