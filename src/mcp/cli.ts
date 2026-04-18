#!/usr/bin/env node
import { readdir } from "node:fs/promises";
import { dirname, basename, resolve, join } from "node:path";
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

// Write mode
let writeMode = process.env.AGENTDB_WRITE_MODE ?? "immediate";

// Embeddings
let embeddings = process.env.AGENTDB_EMBEDDINGS ?? "";

// Schema bootstrap
const schemaGlobs: string[] = [];

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
  else if (arg === "--write-mode" && next) { writeMode = next; i++; }
  else if (arg === "--group-commit") { writeMode = "group"; }
  else if (arg === "--embeddings" && next) { embeddings = next; i++; }
  else if (arg === "--schemas" && next) { schemaGlobs.push(next); i++; }
}

/** Resolve a glob pattern (supports `*` and `?` in the filename) to absolute file paths. */
async function resolveGlob(pattern: string): Promise<string[]> {
  const abs = resolve(pattern);
  const dir = dirname(abs);
  const file = basename(abs);

  if (!file.includes("*") && !file.includes("?")) return [abs];

  const regexStr = file
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  const re = new RegExp(`^${regexStr}$`);

  try {
    const entries = await readdir(dir);
    return entries.filter(e => re.test(e)).map(e => join(dir, e));
  } catch {
    return [];
  }
}

async function resolveBackend(): Promise<AgentDBOptions> {
  const opts: AgentDBOptions = {};

  if (agentId) opts.agentId = agentId;
  if (writeMode === "group" || writeMode === "async") opts.writeMode = writeMode;

  // Parse --embeddings provider[:model] (e.g. "ollama", "openai:text-embedding-3-small", "voyage", "cohere")
  if (embeddings) {
    const [provider, model] = embeddings.split(":");
    const apiKey = process.env.AGENTDB_EMBEDDINGS_API_KEY ?? "";
    if (provider === "ollama") {
      opts.embeddings = { provider: "ollama", model: model || undefined, baseUrl: process.env.AGENTDB_OLLAMA_URL || undefined } as import("../embeddings/index.js").EmbeddingConfig;
    } else if (provider === "openai") {
      opts.embeddings = { provider: "openai", apiKey: apiKey || process.env.OPENAI_API_KEY || "", model: model || undefined } as import("../embeddings/index.js").EmbeddingConfig;
    } else if (provider === "voyage") {
      opts.embeddings = { provider: "voyage", apiKey, model: model || undefined } as import("../embeddings/index.js").EmbeddingConfig;
    } else if (provider === "cohere") {
      opts.embeddings = { provider: "cohere", apiKey, model: model || undefined } as import("../embeddings/index.js").EmbeddingConfig;
    } else if (provider === "gemini") {
      opts.embeddings = { provider: "gemini", apiKey: apiKey || process.env.GEMINI_API_KEY || "", model: model || undefined } as import("../embeddings/index.js").EmbeddingConfig;
    } else if (provider === "http") {
      opts.embeddings = { provider: "http", url: model || "", dimensions: 0 } as import("../embeddings/index.js").EmbeddingConfig;
    } else {
      console.error(`Unknown embedding provider: ${provider}. Use: ollama, openai, voyage, cohere, gemini, http`);
      process.exit(1);
    }
    console.error(`Embeddings: ${provider}${model ? `:${model}` : ""}`);
  }

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

  const resolvedPaths = (await Promise.all(schemaGlobs.map(resolveGlob))).flat();

  if (mode === "http") {
    await startHttp(dataDir, {
      port,
      host,
      dbOpts,
      authToken: authToken || undefined,
      rateLimit: rateLimit || undefined,
      corsOrigins: corsOrigins ? corsOrigins.split(",").map((s) => s.trim()) : undefined,
      schemaPaths: resolvedPaths.length > 0 ? resolvedPaths : undefined,
    });
    console.error(`AgentDB MCP server running on http://${host}:${port}/mcp`);
    if (authToken) console.error("Authentication: bearer token required");
    if (rateLimit) console.error(`Rate limit: ${rateLimit} requests/minute`);
  } else {
    await startStdio(dataDir, dbOpts, resolvedPaths.length > 0 ? { schemaPaths: resolvedPaths } : undefined);
  }
}

main().catch((err) => {
  console.error("AgentDB MCP server failed to start:", err);
  process.exit(1);
});
