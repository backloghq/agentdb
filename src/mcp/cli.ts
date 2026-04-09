#!/usr/bin/env node
import { startStdio, startHttp } from "./index.js";
import type { AgentDBOptions } from "../agentdb.js";

const args = process.argv.slice(2);
let dataDir = process.env.AGENTDB_PATH ?? "./agentdb-data";
let mode = "stdio";
let port = 3000;
let host = "127.0.0.1";

// S3 config
let backend = process.env.AGENTDB_BACKEND ?? "fs";
let s3Bucket = process.env.AGENTDB_S3_BUCKET ?? "";
let s3Prefix = process.env.AGENTDB_S3_PREFIX ?? "";
let s3Region = process.env.AWS_REGION ?? process.env.AGENTDB_S3_REGION ?? "";
let agentId = process.env.AGENTDB_AGENT_ID ?? "";

// Auth config
let authToken = process.env.AGENTDB_AUTH_TOKEN ?? "";
let rateLimit = parseInt(process.env.AGENTDB_RATE_LIMIT ?? "0", 10) || 0;
let corsOrigins = process.env.AGENTDB_CORS_ORIGINS ?? "";

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  const next = args[i + 1];
  if (arg === "--path" && next) { dataDir = next; i++; }
  else if (arg === "--http") { mode = "http"; }
  else if (arg === "--port" && next) { port = parseInt(next, 10); i++; }
  else if (arg === "--host" && next) { host = next; i++; }
  else if (arg === "--backend" && next) { backend = next; i++; }
  else if (arg === "--bucket" && next) { s3Bucket = next; i++; }
  else if (arg === "--prefix" && next) { s3Prefix = next; i++; }
  else if (arg === "--region" && next) { s3Region = next; i++; }
  else if (arg === "--agent-id" && next) { agentId = next; i++; }
  else if (arg === "--auth-token" && next) { authToken = next; i++; }
  else if (arg === "--rate-limit" && next) { rateLimit = parseInt(next, 10); i++; }
  else if (arg === "--cors" && next) { corsOrigins = next; i++; }
}

async function resolveBackend(): Promise<AgentDBOptions> {
  const opts: AgentDBOptions = {};

  if (agentId) opts.agentId = agentId;

  if (backend === "s3") {
    if (!s3Bucket) {
      console.error("Error: --bucket (or AGENTDB_S3_BUCKET) is required for S3 backend");
      process.exit(1);
    }
    const { S3Backend } = await import("@backloghq/opslog-s3");
    opts.backend = new S3Backend({
      bucket: s3Bucket,
      prefix: s3Prefix || undefined,
      region: s3Region || undefined,
    });
    if (!process.env.AGENTDB_PATH && dataDir === "./agentdb-data") {
      dataDir = s3Prefix || "agentdb";
    }
    console.error(`AgentDB using S3 backend: s3://${s3Bucket}/${s3Prefix || ""}`);
  }

  return opts;
}

async function main(): Promise<void> {
  const dbOpts = await resolveBackend();

  if (mode === "http") {
    await startHttp(dataDir, {
      port,
      host,
      dbOpts,
      authToken: authToken || undefined,
      rateLimit: rateLimit || undefined,
      corsOrigins: corsOrigins ? corsOrigins.split(",").map((s) => s.trim()) : undefined,
    });
    console.error(`AgentDB MCP server running on http://${host}:${port}/mcp`);
    if (authToken) console.error("Authentication: bearer token required");
    if (rateLimit) console.error(`Rate limit: ${rateLimit} requests/minute`);
  } else {
    await startStdio(dataDir, dbOpts);
  }
}

main().catch((err) => {
  console.error("AgentDB MCP server failed to start:", err);
  process.exit(1);
});
