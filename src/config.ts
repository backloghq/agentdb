/**
 * Config loader for the AgentDB MCP CLI.
 *
 * Three input mechanisms in precedence order (highest first):
 *   1. CLI flags (passed as `cli` argument)
 *   2. Env vars (`AGENTDB_<UPPER_SNAKE>`)
 *   3. Config file (`agentdb.config.json` in cwd, or `--config`/`AGENTDB_CONFIG`)
 *
 * Pure utility — no AgentDB runtime import. Accepts the env source as an
 * injectable parameter for testing.
 */

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class ConfigValidationError extends Error {
  readonly path: string[];
  readonly source: "cli" | "env" | "file";

  constructor(message: string, path: string[], source: "cli" | "env" | "file") {
    super(message);
    this.name = "ConfigValidationError";
    this.path = path;
    this.source = source;
  }
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const HnswConfigSchema = z.object({
  M: z.number().int().positive().optional(),
  efConstruction: z.number().int().positive().optional(),
  efSearch: z.number().int().positive().optional(),
  maxLevel: z.number().int().positive().optional(),
}).optional();

const EmbeddingsConfigSchema = z.object({
  provider: z.string().optional(),
  apiKey: z.string().optional(),
  model: z.string().optional(),
  batchLimit: z.number().int().positive().optional(),
  baseUrl: z.string().optional(),
  url: z.string().optional(),
  dimensions: z.number().int().nonnegative().optional(),
}).optional();

const DbConfigSchema = z.object({
  path: z.string().optional(),
  maxFindLimit: z.number().int().positive().optional(),
  maxIndexCardinality: z.number().int().positive().optional(),
  cacheSize: z.number().int().positive().optional(),
  diskConcurrency: z.number().int().positive().optional(),
  embeddingBatchSize: z.number().int().positive().optional(),
  filterCacheSize: z.number().int().positive().optional(),
  mergeParquetThreshold: z.number().int().positive().optional(),
  mergeJsonlThreshold: z.number().int().positive().optional(),
  memoryBudget: z.number().nonnegative().optional(),
  writeMode: z.enum(["immediate", "group", "async"]).optional(),
  groupCommitSize: z.number().int().positive().optional(),
  groupCommitMs: z.number().int().positive().optional(),
  rowGroupSize: z.number().int().positive().optional(),
  hnsw: HnswConfigSchema,
  embeddings: EmbeddingsConfigSchema,
  storageMode: z.enum(["memory", "disk", "auto"]).optional(),
  diskThreshold: z.number().int().positive().optional(),
  agentId: z.string().optional(),
  readOnly: z.boolean().optional(),
  // CLI/env-only extras (not AgentDBOptions fields directly)
  backend: z.string().optional(),
  s3Bucket: z.string().optional(),
  s3Region: z.string().optional(),
  s3Prefix: z.string().optional(),
  tenantId: z.string().optional(),
  schemaPaths: z.array(z.string()).optional(),
}).optional();

const HttpConfigSchema = z.object({
  port: z.number().int().positive().optional(),
  host: z.string().optional(),
  auth: z.string().optional(),
  multiToken: z.array(z.string()).optional(),
  jwt: z.object({
    secret: z.string().optional(),
    audience: z.string().optional(),
    issuer: z.string().optional(),
  }).optional(),
  maxSessions: z.number().int().positive().optional(),
  sessionIdleMs: z.number().int().positive().optional(),
  auditBufferSize: z.number().int().positive().optional(),
  auditMaxLimit: z.number().int().positive().optional(),
  auditDefaultLimit: z.number().int().positive().optional(),
  rateLimit: z.number().int().nonnegative().optional(),
  rateLimitWindow: z.number().int().positive().optional(),
  cors: z.array(z.string()).optional(),
}).optional();

const CollectionConfigSchema = z.object({
  maxFindLimit: z.number().int().positive().optional(),
  maxIndexCardinality: z.number().int().positive().optional(),
  filterCacheSize: z.number().int().positive().optional(),
  cacheSize: z.number().int().positive().optional(),
  rowGroupSize: z.number().int().positive().optional(),
  mergeParquetThreshold: z.number().int().positive().optional(),
  mergeJsonlThreshold: z.number().int().positive().optional(),
  diskConcurrency: z.number().int().positive().optional(),
  embeddingBatchSize: z.number().int().positive().optional(),
  hnsw: HnswConfigSchema,
  textSearch: z.boolean().optional(),
  storageMode: z.enum(["memory", "disk", "auto"]).optional(),
  bm25K1: z.number().positive().optional(),
  bm25B: z.number().nonnegative().optional(),
});

export const ConfigFileSchema = z.object({
  db: DbConfigSchema,
  http: HttpConfigSchema,
  collections: z.record(z.string(), CollectionConfigSchema).optional(),
});

export type AgentDBConfigFile = z.infer<typeof ConfigFileSchema>;
export type DbConfig = NonNullable<z.infer<typeof DbConfigSchema>>;
export type HttpConfig = NonNullable<z.infer<typeof HttpConfigSchema>>;
export type CollectionConfig = z.infer<typeof CollectionConfigSchema>;

// ---------------------------------------------------------------------------
// Env var specification table
// ---------------------------------------------------------------------------

type EnvVarType =
  | { kind: "number" }
  | { kind: "boolean" }
  | { kind: "string" }
  | { kind: "enum"; values: string[] }
  | { kind: "string[]" }   // comma-split
  | { kind: "json" };      // JSON.parse

interface EnvVarSpec {
  path: string[];         // dot-path into { db, http }
  type: EnvVarType;
}

/** Mapping from env var name → field path and type. */
const ENV_VAR_MAP: Record<string, EnvVarSpec> = {
  // db
  AGENTDB_PATH:                      { path: ["db", "path"],                   type: { kind: "string" } },
  AGENTDB_MAX_FIND_LIMIT:            { path: ["db", "maxFindLimit"],            type: { kind: "number" } },
  AGENTDB_MAX_INDEX_CARDINALITY:     { path: ["db", "maxIndexCardinality"],     type: { kind: "number" } },
  AGENTDB_CACHE_SIZE:                { path: ["db", "cacheSize"],               type: { kind: "number" } },
  AGENTDB_DISK_CONCURRENCY:          { path: ["db", "diskConcurrency"],         type: { kind: "number" } },
  AGENTDB_EMBEDDING_BATCH_SIZE:      { path: ["db", "embeddingBatchSize"],      type: { kind: "number" } },
  AGENTDB_FILTER_CACHE_SIZE:         { path: ["db", "filterCacheSize"],         type: { kind: "number" } },
  AGENTDB_MERGE_PARQUET_THRESHOLD:   { path: ["db", "mergeParquetThreshold"],   type: { kind: "number" } },
  AGENTDB_MERGE_JSONL_THRESHOLD:     { path: ["db", "mergeJsonlThreshold"],     type: { kind: "number" } },
  AGENTDB_MEMORY_BUDGET:             { path: ["db", "memoryBudget"],            type: { kind: "number" } },
  AGENTDB_WRITE_MODE:                { path: ["db", "writeMode"],               type: { kind: "enum", values: ["immediate", "group", "async"] } },
  AGENTDB_GROUP_COMMIT_SIZE:         { path: ["db", "groupCommitSize"],         type: { kind: "number" } },
  AGENTDB_GROUP_COMMIT_MS:           { path: ["db", "groupCommitMs"],           type: { kind: "number" } },
  AGENTDB_ROW_GROUP_SIZE:            { path: ["db", "rowGroupSize"],            type: { kind: "number" } },
  AGENTDB_HNSW_M:                    { path: ["db", "hnsw", "M"],              type: { kind: "number" } },
  AGENTDB_HNSW_EF_CONSTRUCTION:      { path: ["db", "hnsw", "efConstruction"], type: { kind: "number" } },
  AGENTDB_HNSW_EF_SEARCH:            { path: ["db", "hnsw", "efSearch"],       type: { kind: "number" } },
  AGENTDB_HNSW_MAX_LEVEL:            { path: ["db", "hnsw", "maxLevel"],       type: { kind: "number" } },
  AGENTDB_EMBEDDINGS_PROVIDER:       { path: ["db", "embeddings", "provider"],   type: { kind: "string" } },
  AGENTDB_EMBEDDINGS_API_KEY:        { path: ["db", "embeddings", "apiKey"],     type: { kind: "string" } },
  AGENTDB_EMBEDDINGS_MODEL:          { path: ["db", "embeddings", "model"],      type: { kind: "string" } },
  AGENTDB_EMBEDDINGS_BATCH_LIMIT:    { path: ["db", "embeddings", "batchLimit"], type: { kind: "number" } },
  AGENTDB_EMBEDDINGS_URL:            { path: ["db", "embeddings", "url"],        type: { kind: "string" } },
  AGENTDB_EMBEDDINGS_BASE_URL:       { path: ["db", "embeddings", "baseUrl"],    type: { kind: "string" } },
  AGENTDB_EMBEDDINGS_DIMENSIONS:     { path: ["db", "embeddings", "dimensions"], type: { kind: "number" } },
  AGENTDB_OLLAMA_URL:                { path: ["db", "embeddings", "baseUrl"],    type: { kind: "string" } },
  AGENTDB_DISK_THRESHOLD:            { path: ["db", "diskThreshold"],            type: { kind: "number" } },
  AGENTDB_BACKEND:                   { path: ["db", "backend"],                  type: { kind: "string" } },
  AGENTDB_S3_BUCKET:                 { path: ["db", "s3Bucket"],               type: { kind: "string" } },
  AGENTDB_S3_REGION:                 { path: ["db", "s3Region"],               type: { kind: "string" } },
  AGENTDB_S3_PREFIX:                 { path: ["db", "s3Prefix"],               type: { kind: "string" } },
  AGENTDB_AGENT_ID:                  { path: ["db", "agentId"],                type: { kind: "string" } },
  AGENTDB_TENANT_ID:                 { path: ["db", "tenantId"],               type: { kind: "string" } },
  AGENTDB_SCHEMA_PATHS:              { path: ["db", "schemaPaths"],            type: { kind: "string[]" } },
  AGENTDB_STORAGE_MODE:              { path: ["db", "storageMode"],            type: { kind: "enum", values: ["memory", "disk", "auto"] } },
  AGENTDB_READ_ONLY:                 { path: ["db", "readOnly"],               type: { kind: "boolean" } },
  // http
  AGENTDB_HTTP_PORT:                 { path: ["http", "port"],                 type: { kind: "number" } },
  AGENTDB_HTTP_HOST:                 { path: ["http", "host"],                 type: { kind: "string" } },
  AGENTDB_HTTP_AUTH:                 { path: ["http", "auth"],                 type: { kind: "string" } },
  AGENTDB_HTTP_MULTI_TOKEN:          { path: ["http", "multiToken"],           type: { kind: "json" } },
  AGENTDB_HTTP_JWT_SECRET:           { path: ["http", "jwt", "secret"],        type: { kind: "string" } },
  AGENTDB_HTTP_JWT_AUDIENCE:         { path: ["http", "jwt", "audience"],      type: { kind: "string" } },
  AGENTDB_HTTP_JWT_ISSUER:           { path: ["http", "jwt", "issuer"],        type: { kind: "string" } },
  AGENTDB_HTTP_MAX_SESSIONS:         { path: ["http", "maxSessions"],          type: { kind: "number" } },
  AGENTDB_HTTP_SESSION_IDLE_MS:      { path: ["http", "sessionIdleMs"],        type: { kind: "number" } },
  AGENTDB_HTTP_AUDIT_BUFFER_SIZE:    { path: ["http", "auditBufferSize"],      type: { kind: "number" } },
  AGENTDB_HTTP_AUDIT_MAX_LIMIT:      { path: ["http", "auditMaxLimit"],        type: { kind: "number" } },
  AGENTDB_HTTP_AUDIT_DEFAULT_LIMIT:  { path: ["http", "auditDefaultLimit"],    type: { kind: "number" } },
  AGENTDB_HTTP_RATE_LIMIT:           { path: ["http", "rateLimit"],            type: { kind: "number" } },
  AGENTDB_HTTP_RATE_LIMIT_WINDOW:    { path: ["http", "rateLimitWindow"],      type: { kind: "number" } },
  AGENTDB_HTTP_CORS:                 { path: ["http", "cors"],                 type: { kind: "string[]" } },
};

// ---------------------------------------------------------------------------
// Type coercion
// ---------------------------------------------------------------------------

function coerceValue(raw: string, varName: string, spec: EnvVarType, path: string[]): unknown {
  switch (spec.kind) {
    case "number": {
      const n = Number(raw);
      if (Number.isNaN(n)) {
        throw new ConfigValidationError(
          `${varName}='${raw}' is not a number`,
          path,
          "env",
        );
      }
      return n;
    }
    case "boolean": {
      if (raw === "true" || raw === "1") return true;
      if (raw === "false" || raw === "0") return false;
      throw new ConfigValidationError(
        `${varName}='${raw}' is not a boolean (use true/false/1/0)`,
        path,
        "env",
      );
    }
    case "string": {
      return raw;
    }
    case "enum": {
      if (!spec.values.includes(raw)) {
        throw new ConfigValidationError(
          `${varName}='${raw}' must be one of ${spec.values.join("|")}`,
          path,
          "env",
        );
      }
      return raw;
    }
    case "string[]": {
      return raw.split(",").map((s) => s.trim()).filter(Boolean);
    }
    case "json": {
      try {
        return JSON.parse(raw);
      } catch (err) {
        throw new ConfigValidationError(
          `${varName}=<redacted> is not valid JSON (${(err as Error).message})`,
          path,
          "env",
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Deep-set and deep-merge utilities
// ---------------------------------------------------------------------------

/** Set a value at a nested path in an object, creating intermediaries. */
function setAtPath(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (cur[key] === undefined || cur[key] === null || typeof cur[key] !== "object") {
      cur[key] = {};
    }
    cur = cur[key] as Record<string, unknown>;
  }
  cur[path[path.length - 1]] = value;
}

/** Deep-merge `overrides` into `base`, returning a new object. `overrides` wins on leaf conflicts. */
function deepMerge<T extends Record<string, unknown>>(base: T, overrides: Partial<T>): T {
  const result: Record<string, unknown> = { ...base };
  for (const [key, val] of Object.entries(overrides)) {
    if (val === undefined) continue;
    if (
      val !== null &&
      typeof val === "object" &&
      !Array.isArray(val) &&
      result[key] !== null &&
      typeof result[key] === "object" &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        val as Record<string, unknown>,
      );
    } else {
      result[key] = val;
    }
  }
  return result as T;
}

// ---------------------------------------------------------------------------
// Env var parsing
// ---------------------------------------------------------------------------

function parseEnvVars(env: NodeJS.ProcessEnv): AgentDBConfigFile {
  const raw: Record<string, unknown> = {};

  for (const [varName, spec] of Object.entries(ENV_VAR_MAP)) {
    const value = env[varName];
    if (value === undefined || value === "") continue;
    const coerced = coerceValue(value, varName, spec.type, spec.path);
    setAtPath(raw, spec.path, coerced);
  }

  return raw as AgentDBConfigFile;
}

// ---------------------------------------------------------------------------
// Config file loader
// ---------------------------------------------------------------------------

function loadConfigFile(configPath: string, requireFile = false): AgentDBConfigFile {
  let raw: unknown;
  try {
    const text = readFileSync(configPath, "utf8");
    // Warn when the config file is world-readable (POSIX only).
    // Config files often contain secrets (auth tokens, API keys) that should
    // not be visible to other users on the system.
    if (process.platform !== "win32") {
      try {
        const st = statSync(configPath);
        // mode & 0o004 = world-read bit
        if (st.mode & 0o004) {
          console.warn(
            `agentdb: config file ${configPath} is world-readable (mode ${(st.mode & 0o777).toString(8)}). ` +
            `Run \`chmod 600 ${configPath}\` to restrict access.`,
          );
        }
      } catch { /* stat failed — skip the check */ }
    }
    raw = JSON.parse(text);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      if (requireFile) {
        throw new ConfigValidationError(
          `Config file not found: ${configPath}`,
          [],
          "file",
        );
      }
      // File absent — silently use empty config
      return {};
    }
    if (err instanceof SyntaxError) {
      throw new ConfigValidationError(
        `${configPath}: malformed JSON — ${err.message}`,
        [],
        "file",
      );
    }
    throw err;
  }

  const result = ConfigFileSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.map(String);
    throw new ConfigValidationError(
      `${configPath}: ${path.join(".")} — ${issue.message}`,
      path,
      "file",
    );
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// loadAgentDBConfig — public entry point
// ---------------------------------------------------------------------------

export interface LoadConfigOptions {
  /** Path to config file. If omitted, looks for ./agentdb.config.json. */
  configPath?: string;
  /**
   * When true, a missing config file at `configPath` throws a ConfigValidationError.
   * Default false — missing files silently produce an empty config. Set to true when
   * the path was explicitly supplied by the user (e.g. via `--config` CLI flag) so
   * that typos surface as errors rather than silent no-ops.
   */
  requireConfigFile?: boolean;
  /** Env source (process.env by default). Inject for testing. */
  env?: NodeJS.ProcessEnv;
  /** CLI args already parsed. Highest precedence. */
  cli?: Partial<AgentDBConfigFile>;
}

export function loadAgentDBConfig(opts?: LoadConfigOptions): AgentDBConfigFile {
  const env = opts?.env ?? process.env;
  const configPath = opts?.configPath ?? env["AGENTDB_CONFIG"] ?? resolve("agentdb.config.json");
  const requireFile = opts?.requireConfigFile ?? false;

  // Layer 3 (lowest): config file
  const fileConfig = loadConfigFile(configPath, requireFile);

  // Layer 2: env vars
  const envConfig = parseEnvVars(env);

  // Layer 1 (highest): CLI args
  const cliConfig: Partial<AgentDBConfigFile> = opts?.cli ?? {};

  // Merge: file < env < cli
  const merged = deepMerge(
    deepMerge(fileConfig as Record<string, unknown>, envConfig as Record<string, unknown>),
    cliConfig as Record<string, unknown>,
  );

  // Final shape validation — catches env-supplied values that individually
  // coerced fine but produced a wrong-shape object (e.g. JSON array vs string[]).
  const result = ConfigFileSchema.safeParse(merged);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.map(String);
    throw new ConfigValidationError(
      `${path.join(".")} — ${issue.message}`,
      path,
      "env",
    );
  }

  return result.data;
}
