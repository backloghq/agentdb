#!/usr/bin/env node
import { readdir } from "node:fs/promises";
import { dirname, basename, resolve, join } from "node:path";
import { startStdio, startHttp } from "./index.js";
import { validateTenantId } from "./tenant-binding.js";
import { loadAgentDBConfig, ConfigValidationError } from "../config.js";
import type { DbConfig, HttpConfig } from "../config.js";
import type { AgentDBOptions } from "../agentdb.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(`
AgentDB MCP server

Usage:
  npx @backloghq/agentdb [options]

Options:
  --path <dir>              Data directory (default: ./agentdb-data)
  --http                    Use HTTP transport instead of stdio
  --port <n>                HTTP port (default: 3000)
  --host <addr>             HTTP host (default: 127.0.0.1)
  --backend <type>          Storage backend: fs or s3 (default: fs)
  --bucket <name>           S3 bucket name (required for --backend s3)
  --prefix <path>           S3 key prefix
  --region <region>         AWS region for S3
  --agent-id <id>           Agent ID for multi-writer mode
  --auth-token <token>      Bearer token for HTTP authentication
  --tenant-id <id>          Bind this process to a tenant. When set, every
                            authenticated request must carry a matching tenant
                            (singular --auth-token implicitly bound; JWTs must
                            carry the tid claim). Cross-tenant credentials are
                            rejected with a tenant_mismatch security event.
  --rate-limit <n>          Max requests/minute per IP (HTTP only)
  --cors <origins>          Comma-separated allowed CORS origins
  --write-mode <mode>       Write mode: immediate (default), group, or async
  --group-commit            Alias for --write-mode group
  --embeddings <p[:model]>  Embedding provider: ollama, openai, voyage, cohere, gemini, http
  --schemas <glob>          Schema JSON files to load on startup (repeatable, supports * and ?)
  --config <path>           Path to agentdb.config.json (default: ./agentdb.config.json)
  --help, -h                Show this help message

Configuration (precedence: CLI flags > env vars > config file):

  Config file: agentdb.config.json in the current directory, or via --config / AGENTDB_CONFIG.

  Environment variables (AGENTDB_<UPPER_SNAKE>):
    AGENTDB_PATH, AGENTDB_WRITE_MODE, AGENTDB_MAX_FIND_LIMIT, AGENTDB_CACHE_SIZE,
    AGENTDB_DISK_CONCURRENCY, AGENTDB_EMBEDDING_BATCH_SIZE, AGENTDB_FILTER_CACHE_SIZE,
    AGENTDB_MERGE_PARQUET_THRESHOLD, AGENTDB_MERGE_JSONL_THRESHOLD, AGENTDB_MEMORY_BUDGET,
    AGENTDB_GROUP_COMMIT_SIZE, AGENTDB_GROUP_COMMIT_MS, AGENTDB_ROW_GROUP_SIZE,
    AGENTDB_HNSW_M, AGENTDB_HNSW_EF_CONSTRUCTION, AGENTDB_HNSW_EF_SEARCH, AGENTDB_HNSW_MAX_LEVEL,
    AGENTDB_EMBEDDINGS_PROVIDER, AGENTDB_EMBEDDINGS_API_KEY, AGENTDB_EMBEDDINGS_MODEL,
    AGENTDB_HTTP_PORT, AGENTDB_HTTP_HOST, AGENTDB_HTTP_AUTH, AGENTDB_HTTP_MAX_SESSIONS,
    AGENTDB_HTTP_SESSION_IDLE_MS, AGENTDB_HTTP_AUDIT_BUFFER_SIZE, AGENTDB_HTTP_RATE_LIMIT,
    AGENTDB_HTTP_CORS, AGENTDB_BACKEND, AGENTDB_S3_BUCKET, AGENTDB_S3_REGION,
    AGENTDB_S3_PREFIX, AGENTDB_AGENT_ID, AGENTDB_TENANT_ID, AGENTDB_SCHEMA_PATHS,
    AGENTDB_CONFIG, AWS_REGION

  See README.md §Configuration for the full reference.
`.trimStart());
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Parse CLI args into partial config objects
// ---------------------------------------------------------------------------

let configPath: string | undefined;
let transport = "stdio";
const schemaGlobs: string[] = [];
let embeddingsShorthand = "";  // "provider:model" shorthand from --embeddings flag

const cliDb: Partial<DbConfig> = {};
const cliHttp: Partial<HttpConfig> = {};

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  const next = args[i + 1];

  if (arg === "--config" && next) { configPath = next; i++; }
  else if (arg === "--path" && next) { cliDb.path = next; i++; }
  else if (arg === "--http") { transport = "http"; }
  else if (arg === "--port" && next) { cliHttp.port = parseInt(next, 10); i++; }
  else if (arg === "--host" && next) { cliHttp.host = next; i++; }
  else if (arg === "--backend" && next) { cliDb.backend = next; i++; }
  else if (arg === "--bucket" && next) { cliDb.s3Bucket = next; i++; }
  else if (arg === "--prefix" && next) { cliDb.s3Prefix = next; i++; }
  else if (arg === "--region" && next) { cliDb.s3Region = next; i++; }
  else if (arg === "--agent-id" && next) { cliDb.agentId = next; i++; }
  else if (arg === "--auth-token" && next) { cliHttp.auth = next; i++; }
  else if (arg === "--tenant-id" && next) { cliDb.tenantId = next; i++; }
  else if (arg === "--rate-limit" && next) { cliHttp.rateLimit = parseInt(next, 10); i++; }
  else if (arg === "--cors" && next) { cliHttp.cors = next.split(",").map((s) => s.trim()); i++; }
  else if (arg === "--write-mode" && next) { cliDb.writeMode = next as "immediate" | "group" | "async"; i++; }
  else if (arg === "--group-commit") { cliDb.writeMode = "group"; }
  else if (arg === "--embeddings" && next) { embeddingsShorthand = next; i++; }
  else if (arg === "--schemas" && next) { schemaGlobs.push(next); i++; }
}

// Translate --embeddings provider[:model] shorthand into CLI config overrides
if (embeddingsShorthand) {
  const [provider, model] = embeddingsShorthand.split(":");
  if (!cliDb.embeddings) cliDb.embeddings = {};
  cliDb.embeddings.provider = provider;
  if (model) cliDb.embeddings.model = model;
}

// ---------------------------------------------------------------------------
// Load merged config (file < env < CLI)
// ---------------------------------------------------------------------------

let config: import("../config.js").AgentDBConfigFile;
try {
  config = loadAgentDBConfig({
    configPath,
    requireConfigFile: configPath !== undefined,
    env: process.env,
    cli: { db: cliDb, http: cliHttp },
  });
} catch (err) {
  if (err instanceof ConfigValidationError) {
    console.error(`Configuration error (source: ${err.source}): ${err.message}`);
    process.exit(1);
  }
  throw err;
}

// ---------------------------------------------------------------------------
// Resolve data directory (falls back to AGENTDB_PATH env or default)
// ---------------------------------------------------------------------------

const dataDir = config.db?.path ?? "./agentdb-data";

// ---------------------------------------------------------------------------
// Schema glob resolution
// ---------------------------------------------------------------------------

/** Resolve a glob pattern (supports `*` and `?` in the filename) to absolute paths. */
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

// ---------------------------------------------------------------------------
// Backend + AgentDBOptions resolution
// ---------------------------------------------------------------------------

async function resolveAgentDBOpts(): Promise<AgentDBOptions> {
  const db = config.db ?? {};
  const opts: AgentDBOptions = {};

  if (db.agentId) opts.agentId = db.agentId;
  if (db.writeMode && (db.writeMode === "group" || db.writeMode === "async")) {
    opts.writeMode = db.writeMode;
  }
  if (db.groupCommitSize) opts.groupCommitSize = db.groupCommitSize;
  if (db.groupCommitMs) opts.groupCommitMs = db.groupCommitMs;
  if (db.maxFindLimit) opts.maxFindLimit = db.maxFindLimit;
  if (db.maxIndexCardinality) opts.maxIndexCardinality = db.maxIndexCardinality;
  if (db.cacheSize) opts.cacheSize = db.cacheSize;
  if (db.rowGroupSize) opts.rowGroupSize = db.rowGroupSize;
  if (db.diskConcurrency) opts.diskConcurrency = db.diskConcurrency;
  if (db.embeddingBatchSize) opts.embeddingBatchSize = db.embeddingBatchSize;
  if (db.filterCacheSize) opts.filterCacheSize = db.filterCacheSize;
  if (db.mergeParquetThreshold) opts.mergeParquetThreshold = db.mergeParquetThreshold;
  if (db.mergeJsonlThreshold) opts.mergeJsonlThreshold = db.mergeJsonlThreshold;
  if (db.memoryBudget !== undefined) opts.memoryBudget = db.memoryBudget;
  if (db.hnsw) opts.hnsw = db.hnsw;
  if (db.storageMode) opts.storageMode = db.storageMode;
  if (db.diskThreshold) opts.diskThreshold = db.diskThreshold;
  if (db.readOnly) opts.readOnly = db.readOnly;

  // Embeddings
  const emb = db.embeddings;
  if (emb?.provider) {
    const apiKey = emb.apiKey ?? "";
    const model = emb.model;
    const provider = emb.provider;

    if (provider === "ollama") {
      opts.embeddings = {
        provider: "ollama",
        model: model || undefined,
        baseUrl: (emb.baseUrl) || process.env.AGENTDB_OLLAMA_URL || undefined,
      } as import("../embeddings/index.js").EmbeddingConfig;
    } else if (provider === "openai") {
      opts.embeddings = {
        provider: "openai",
        apiKey: apiKey || process.env.OPENAI_API_KEY || "",
        model: model || undefined,
      } as import("../embeddings/index.js").EmbeddingConfig;
    } else if (provider === "voyage") {
      opts.embeddings = { provider: "voyage", apiKey, model: model || undefined } as import("../embeddings/index.js").EmbeddingConfig;
    } else if (provider === "cohere") {
      opts.embeddings = { provider: "cohere", apiKey, model: model || undefined } as import("../embeddings/index.js").EmbeddingConfig;
    } else if (provider === "gemini") {
      opts.embeddings = {
        provider: "gemini",
        apiKey: apiKey || process.env.GEMINI_API_KEY || "",
        model: model || undefined,
      } as import("../embeddings/index.js").EmbeddingConfig;
    } else if (provider === "http") {
      opts.embeddings = {
        provider: "http",
        url: emb.url || model || "",
        dimensions: emb.dimensions ?? 0,
        batchLimit: emb.batchLimit || undefined,
      } as import("../embeddings/index.js").EmbeddingConfig;
    } else {
      console.error(`Unknown embedding provider: ${provider}. Use: ollama, openai, voyage, cohere, gemini, http`);
      process.exit(1);
    }
    console.error(`Embeddings: ${provider}${model ? `:${model}` : ""}`);
  }

  // S3 backend
  const backend = db.backend ?? "fs";
  const s3Bucket = db.s3Bucket ?? "";
  const s3Prefix = db.s3Prefix ?? "";
  const s3Region = db.s3Region ?? process.env.AWS_REGION ?? "";

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
    console.error(`AgentDB using S3 backend: s3://${s3Bucket}/${s3Prefix || ""}`);
  }

  return opts;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tenantId = config.db?.tenantId ?? "";
  if (tenantId) validateTenantId(tenantId);

  const dbOpts = await resolveAgentDBOpts();

  // Schema paths: merge CLI --schemas globs + config.db.schemaPaths
  const allGlobs = [
    ...schemaGlobs,
    ...(config.db?.schemaPaths ?? []),
  ];
  const resolvedPaths = (await Promise.all(allGlobs.map(resolveGlob))).flat();

  const http = config.http ?? {};

  if (transport === "http") {
    const port = http.port ?? 3000;
    const host = http.host ?? "127.0.0.1";
    const authToken = http.auth ?? "";
    const rateLimit = http.rateLimit ?? 0;
    const corsOrigins = http.cors;

    await startHttp(dataDir, {
      port,
      host,
      dbOpts,
      authToken: authToken || undefined,
      rateLimit: rateLimit || undefined,
      corsOrigins: corsOrigins?.length ? corsOrigins : undefined,
      maxSessions: http.maxSessions,
      sessionIdleMs: http.sessionIdleMs,
      auditBufferSize: http.auditBufferSize,
      auditMaxLimit: http.auditMaxLimit,
      auditDefaultLimit: http.auditDefaultLimit,
      schemaPaths: resolvedPaths.length > 0 ? resolvedPaths : undefined,
      expectedTenantId: tenantId || undefined,
    });
    console.error(`AgentDB MCP server running on http://${host}:${port}/mcp`);
    if (authToken) console.error("Authentication: bearer token required");
    if (tenantId) console.error(`Tenant binding: bound to tenant ${tenantId}`);
    if (rateLimit) console.error(`Rate limit: ${rateLimit} requests/minute`);
  } else {
    await startStdio(dataDir, dbOpts, resolvedPaths.length > 0 ? { schemaPaths: resolvedPaths } : undefined);
  }
}

main().catch((err) => {
  console.error("AgentDB MCP server failed to start:", err);
  process.exit(1);
});
