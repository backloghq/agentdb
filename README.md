# AgentDB

[![CI](https://github.com/backloghq/agentdb/actions/workflows/ci.yml/badge.svg)](https://github.com/backloghq/agentdb/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

AI-first embedded database for LLM agents. Zero native dependencies, pure TypeScript.

## Install

```bash
npm install @backloghq/agentdb
```

## Quick Start

```typescript
import { AgentDB } from "@backloghq/agentdb";

// Recommended: one-call factory that constructs and initializes
const db = await AgentDB.open("./data");

const tasks = await db.collection("tasks");

// Insert
const id = await tasks.insert(
  { title: "Ship v1", status: "active", priority: 1 },
  { agent: "planner", reason: "Sprint kickoff" },
);

// Find
const result = await tasks.find({ filter: { status: "active" } });
// → { records: [...], total: 1, truncated: false }

// Update
await tasks.update(
  { _id: id },
  { $set: { status: "done" } },
  { agent: "planner", reason: "Completed" },
);

// Clean up
await db.close();
```

## Declarative Schemas

Define typed, validated collections in one place:

```typescript
import { AgentDB, defineSchema } from "@backloghq/agentdb";

const db = await AgentDB.open("./data");

const tasks = await db.collection(defineSchema({
  name: "tasks",
  version: 1,
  description: "Project tasks tracked by the team",
  instructions: "Set priority based on urgency. Close done tasks after review.",
  fields: {
    title: { type: "string", required: true, maxLength: 200, description: "Short task summary" },
    status: { type: "enum", values: ["pending", "done"], default: "pending", description: "Current state" },
    priority: { type: "enum", values: ["H", "M", "L"], default: "M", description: "H=urgent, M=normal, L=backlog" },
    score: { type: "number", min: 0, max: 100 },
    tags: { type: "string[]" },
  },
  indexes: ["status", "priority"],
  arrayIndexes: ["tags"],           // O(1) $contains lookups
  computed: {
    isUrgent: (r) => r.priority === "H" && r.status === "pending",
  },
  virtualFilters: {
    "+URGENT": (r) => r.priority === "H" && r.status === "pending",
  },
  hooks: {
    beforeInsert: (record) => ({ ...record, createdAt: new Date().toISOString() }),
  },
}));
// Schema auto-persisted to meta/tasks.schema.json — any agent can discover it

await tasks.insert({ title: "Fix critical bug", priority: "H" });
// → status defaults to "pending", priority validated, createdAt auto-set

const urgent = await tasks.find({ filter: { "+URGENT": true } });
```

Fields support: `string`, `number`, `boolean`, `date`, `enum`, `string[]`, `number[]`, `object`, `autoIncrement`. Constraints: `required`, `maxLength`, `min`, `max`, `pattern`, `default`, `resolve`.

**Field resolve** — transform values before validation (e.g. parse natural language dates):

```typescript
fields: {
  due: { type: "date", resolve: (v) => v === "tomorrow" ? nextDay() : v },
  score: { type: "number", resolve: (v) => typeof v === "string" ? parseInt(v) : v },
}
```

**Custom tag field** — `+tag`/`-tag` syntax queries "tags" by default, configurable via `tagField`:

```typescript
defineSchema({ tagField: "labels", fields: { labels: { type: "string[]" } } })
// +bug → { labels: { $contains: "bug" } }
```

## Three Ways to Use It

### 1. Direct Import

```typescript
import { AgentDB } from "@backloghq/agentdb";
```

Full programmatic access. Use `AgentDB` to manage collections, `Collection` for CRUD.

### 2. Tool Definitions

```typescript
import { AgentDB } from "@backloghq/agentdb";
import { getTools } from "@backloghq/agentdb/tools";

const db = await AgentDB.open("./data");

const tools = getTools(db);
// → Array of { name, description, schema, annotations, execute }
```

Framework-agnostic. Each tool has a zod schema and an `execute` function that returns `{ content: [...] }`. Works with Vercel AI SDK, LangChain, or any framework that accepts tool definitions.

### 3. MCP Server

```bash
npx @backloghq/agentdb --path ./data              # stdio (single client)
npx @backloghq/agentdb --path ./data --http       # HTTP (multiple clients)
```

**Schema bootstrap — two ways to ship schemas with your data.**

A schema file is a single JSON document describing one collection — the same shape as `meta/{name}.schema.json` after `defineSchema` auto-persists:

```json
{
  "name": "tickets",
  "version": 1,
  "description": "Customer support tickets — queue for the on-call team",
  "instructions": "Set priority from customer tier (enterprise=high). Resolve before closing.",
  "fields": {
    "title":    { "type": "string", "required": true, "maxLength": 200, "description": "Short summary; first line of the issue" },
    "status":   { "type": "enum", "values": ["open", "in_progress", "resolved", "closed"], "default": "open" },
    "priority": { "type": "enum", "values": ["low", "medium", "high"], "description": "Set from customer tier" },
    "openedAt": { "type": "date", "required": true }
  },
  "indexes": ["status", "priority"]
}
```

**Option 1 — auto-discovery.** Drop files into `<dataDir>/schemas/` and every `*.json` there is loaded on `db.init()`:

```bash
mkdir -p ./data/schemas
cp tickets.json ./data/schemas/
npx @backloghq/agentdb --path ./data
# → [agentdb] schemas/*.json: loaded 1
```

Bad files are logged and skipped; missing directory is silently ignored. The schemas travel with the data directory on backup/move.

**Option 2 — `--schemas` flag.** Point at any path or glob; multiple flags are unioned:

```bash
npx @backloghq/agentdb --path ./data --schemas ./schemas/*.json
npx @backloghq/agentdb --path ./data --schemas ./teams/users.json --schemas ./teams/tasks.json
```

Useful when schemas live in a separate repo or are generated by a build step.

**Load order**: auto-discover from `<dataDir>/schemas/` runs first during `db.init()`, then `--schemas` paths load on top as overlays. File properties win per-property; untouched persisted properties are preserved.

**Option 3 — at runtime via MCP tools.** Agents with admin permission can create collections and attach schemas without a restart (see [Tool Definitions](#tool-definitions) for the full tool reference):

```
db_set_schema {
  collection: "tickets",
  schema: {
    description: "Customer support tickets",
    instructions: "Set priority from customer tier.",
    fields: {
      title:  { type: "string", required: true, maxLength: 200 },
      status: { type: "enum", values: ["open", "closed"], default: "open" }
    },
    indexes: ["status"]
  }
}
```

The schema file is written to `meta/tickets.schema.json` immediately. If the collection doesn't exist yet, it materializes on the first insert — no separate `db_create` call needed. Re-calling `db_set_schema` merges with the existing schema (overlay semantics, same as `--schemas`). `db_diff_schema` previews changes first; `db_delete_schema` removes the file.

All tools exposed as MCP tools (with additional `db_subscribe`/`db_unsubscribe` on HTTP transport). Claude Code config (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "agentdb": {
      "command": "npx",
      "args": ["agentdb", "--path", "/absolute/path/to/data"]
    }
  }
}
```

## Disk-Backed Storage

For large collections that exceed available RAM, enable disk-backed mode. Collections are compacted to Parquet files with persistent indexes.

```typescript
// Global: all collections use disk mode
const db = new AgentDB("./data", {
  storageMode: "disk",   // "memory" (default) | "disk" | "auto"
  cacheSize: 10_000,     // LRU cache size (records)
  rowGroupSize: 5000,    // Parquet row group size
});

// Per-collection via schema
const events = await db.collection(defineSchema({
  name: "events",
  storageMode: "disk",
  fields: { ... },
  indexes: ["type", "timestamp"],
  arrayIndexes: ["tags"],
}));

// Auto mode: switches to disk when collection exceeds threshold
const db = new AgentDB("./data", {
  storageMode: "auto",
  diskThreshold: 10_000,  // default
});
```

Disk mode opens with `skipLoad` — records are NOT loaded into memory. On close, compaction writes two artifacts:

- **Parquet** — `_id` + extracted columns only. For `count()`, column scans, and skip-scanning. No full records stored.
- **JSONL record store** — full records, one per line. For `findOne()` and `find(limit:N)` via byte-range seeks.

Point lookups use `readBlobRange` to seek directly to a record's byte offset in the JSONL file — O(1) per record on filesystem, single HTTP Range request on S3. No row group parsing, no full-file reads.

Compaction is incremental — close writes only new records, not the full dataset. Auto-merges after 10 incremental files. Indexes are lazy-loaded on first query.

All disk I/O goes through `StorageBackend` — works identically on filesystem and S3. Zero native dependencies.

## S3 Backend

Store data in Amazon S3 instead of the local filesystem. Zero code changes — just configure via CLI flags or environment variables.

### CLI flags

```bash
npx @backloghq/agentdb --backend s3 --bucket my-bucket --region us-east-1
npx @backloghq/agentdb --backend s3 --bucket my-bucket --prefix prod/agentdb --http --port 3000
npx @backloghq/agentdb --backend s3 --bucket my-bucket --agent-id agent-1  # multi-writer
```

### Environment variables

```bash
AGENTDB_BACKEND=s3
AGENTDB_S3_BUCKET=my-bucket
AGENTDB_S3_PREFIX=agentdb        # optional key prefix
AWS_REGION=us-east-1
AGENTDB_AGENT_ID=agent-1         # optional multi-writer
npx @backloghq/agentdb
```

### Library usage

```typescript
import { AgentDB, loadS3Backend } from "@backloghq/agentdb";

const { S3Backend } = await loadS3Backend(); // optional — requires @backloghq/opslog-s3
const db = new AgentDB("mydb", {
  backend: new S3Backend({
    bucket: "my-bucket",
    prefix: "agentdb",
    region: "us-east-1",
  }),
  agentId: "agent-1",  // optional: enables multi-writer
});
await db.init();
```

AWS credentials use the standard SDK chain (env vars, IAM role, `~/.aws/config`). The AWS SDK is only loaded when S3 is configured — filesystem users never pay the cost.

### Text search on S3

When agentdb detects an S3 opslog backend, text indexes automatically use `@backloghq/termlog-s3` instead of the local filesystem. No configuration needed — the same bucket and prefix are used, with a per-collection subpath (`<prefix>/<collection>/text/`). Install the optional peer dependency to enable it:

```bash
npm install @backloghq/termlog-s3
```

### Single-writer constraint

Both `@backloghq/opslog-s3` and `@backloghq/termlog-s3` require that only **one agentdb process** writes to a given `(bucket, prefix)` at a time. Multiple concurrent writers will corrupt the WAL. For multi-process setups, use the HTTP MCP server as a single-writer proxy.

### S3 lifecycle recommendation

Configure an `AbortIncompleteMultipartUpload` lifecycle rule (1-day expiry) on the bucket. This cleans up orphaned multipart uploads from crashed writers. See the [termlog-s3 README](https://github.com/backloghq/termlog-s3#readme) for bucket setup details.

## Filter Syntax

Two syntaxes. JSON is primary, compact string is secondary.

### JSON Filters

```typescript
// Equality (implicit)
tasks.find({ filter: { status: "active" } });

// Comparison operators
tasks.find({ filter: { priority: { $gt: 3 } } });

// Dot-notation for nested fields
tasks.find({ filter: { "metadata.tags": { $contains: "urgent" } } });

// Logical operators
tasks.find({
  filter: {
    $or: [{ status: "active" }, { priority: { $gte: 5 } }],
  },
});
```

**Operators:** `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$contains`, `$startsWith`, `$endsWith`, `$exists`, `$regex`, `$not`, `$strLen`

Top-level keys are implicitly ANDed.

### Compact String Filters

Shorthand for tool calls and quick queries:

```
status:active                          → { status: "active" }
status:active priority.gt:3           → { $and: [{ status: "active" }, { priority: { $gt: 3 } }] }
name.contains:alice                    → { name: { $contains: "alice" } }
(role:admin or role:mod)               → { $or: [{ role: "admin" }, { role: "mod" }] }
tags.in:bug,feature                    → { tags: { $in: ["bug", "feature"] } }
title.strLen:20                        → { title: { $strLen: 20 } }
title.strLen.gt:10                     → { title: { $strLen: { $gt: 10 } } }
+bug                                   → { tags: { $contains: "bug" } }
-old                                   → { tags: { $not: { $contains: "old" } } }
auth error                             → { $text: "auth error" }
status:active auth                     → { $and: [{ status: "active" }, { $text: "auth" }] }
```

Modifier aliases: `gt`, `gte`, `lt`, `lte`, `ne`, `contains`, `has`, `startsWith`, `starts`, `endsWith`, `ends`, `in`, `nin`, `exists`, `regex`, `match`, `eq`, `is`, `not`, `after`, `before`, `above`, `below`, `over`, `under`, `strLen`

## Collection API

> **v1.2 breaking change:** `findOne`, `find`, `findAll`, `count`, `search`, `queryView` are now async and return Promises.

```typescript
const col = await db.collection("tasks");

// Insert
const id = await col.insert(doc, opts?);
const ids = await col.insertMany(docs, opts?);

// Read (async)
const record = await col.findOne(id);
const result = await col.find({ filter?, limit?, offset?, summary?, sort?, maxTokens? });
const n = await col.count(filter?);

// Update
const modified = await col.update(filter, { $set?, $unset?, $inc?, $push? }, opts?);
const { id, action } = await col.upsert(id, doc, opts?);
const results = await col.upsertMany([{ _id, ...doc }, ...], opts?);

// Delete
const deleted = await col.remove(filter, opts?);

// History
const undone = await col.undo();
const ops = col.history(id);

// Inspect
const shape = col.schema(sampleSize?);
const uniq = col.distinct(field);
```

All mutation methods accept `opts?: { agent?: string; reason?: string }`.

## Schema Lifecycle for Agents

> **Terminology** — three distinct "schema" concepts:
> - **`defineSchema()`** — code-level API; includes hooks, validators, computed fields. Lives in memory only; never serialized.
> - **`PersistedSchema`** — JSON-serializable subset (description, instructions, field types, constraints, indexes). Stored in `meta/{name}.schema.json`. This is what agents read and write.
> - **`db_schema`** — tool that *samples actual records* to infer field shapes dynamically. Does not read the `PersistedSchema` file; works even with no schema defined.

AgentDB treats schemas as first-class runtime objects that agents can inspect, evolve, and reason about — not just static type definitions. Here's the full six-step lifecycle:

### 1. Define — declare your schema in code

```typescript
const tasks = await db.collection(defineSchema({
  name: "tasks",
  version: 1,
  description: "Project tasks tracked by the team",
  instructions: "Set priority based on urgency.",
  fields: {
    title: { type: "string", required: true, maxLength: 200 },
    status: { type: "enum", values: ["pending", "done"], default: "pending" },
  },
  indexes: ["status"],
}));
```

### 2. Persist — schema auto-saved to disk

`defineSchema` collections automatically persist to `{dataDir}/meta/{name}.schema.json` on first open. The file contains the agent-facing context (description, instructions, field descriptions) but not runtime-only config (hooks, computed fields). The file can be committed to source control, loaded at startup, or shipped as a seed.

### 3. Discover — agents find and read schemas at runtime

```
db_collections          → lists all collections with record count + schema summary
db_get_schema tasks     → returns full persisted schema: description, instructions,
                          field types, constraints, indexes, version
```

Any agent can call these without knowing the codebase. They answer "what data exists and how should I use it?"

### 4. Diff — preview schema changes before committing

```
db_diff_schema tasks { fields: { priority: { type: "enum", values: ["H","M","L"] } } }
→ { added: ["priority"], changed: [], removed: [], warnings: [], impact: { ... } }
```

`db_diff_schema` uses `mergePersistedSchemas` internally (same semantics as `db_set_schema`), so it accurately shows what would change — including record-impact counts for constraint tightening (e.g. how many strings exceed a new `maxLength`).

### 5. Migrate — apply bulk data changes

```
db_migrate tasks { ops: [{ op: "default", field: "priority", value: "M" }] }
→ { scanned: 1200, updated: 843, unchanged: 357, failed: 0 }
```

`db_migrate` supports `set`, `unset`, `rename`, `default`, and `copy` ops. Use `dryRun: true` to preview counts. Records that fail validation or are deleted mid-run land in `errors[]` with per-record context.

### 6. Infer — bootstrap a schema from existing data (cold start)

When you have data but no schema, `db_infer_schema` samples the collection and proposes a `PersistedSchema`:

```
db_infer_schema tasks { sampleSize: 200 }
→ { proposed: { fields: { title: { type: "string", maxLength: 180 }, ... } }, notes: [...] }
```

The proposed schema passes `validatePersistedSchema` and can be forwarded directly to `db_set_schema`.

### Forward compatibility

Schema JSON files are forward-compatible by design. Unknown top-level and field-level properties are silently ignored by `validatePersistedSchema` — a file written by a newer version of AgentDB can be loaded by an older version without error. Unknown properties also round-trip cleanly: loading a schema with extra fields and persisting it back preserves those fields unmodified.

This means you can safely commit schema files generated by a newer version of the library and roll back without data loss or startup errors.

### Library API: programmatic schema management

```typescript
// Load JSON schema files at startup (overlay semantics, per-file isolation)
const result = await db.loadSchemasFromFiles(["./schemas/tasks.json"]);
// → { loaded: 1, skipped: 0, failed: [] }

// Merge two persisted schemas with overlay (used internally by db_set_schema)
import { mergePersistedSchemas } from "@backloghq/agentdb";
const merged = mergePersistedSchemas(existing, incoming);
// Overlay wins per-property, not per-field — updating { type } preserves { description }

// Reconcile code-level schema with persisted schema at collection open time
import { mergeSchemas } from "@backloghq/agentdb";
const { persisted, warnings } = mergeSchemas(codeSchema, persistedSchema);
// Code wins for validation, persisted wins for agent context
```

## Tool Definitions

`getTools(db)` returns tools covering:

| Tool | Description |
|------|-------------|
| `db_collections` | List all collections with record counts and schema summaries |
| `db_create` | Create a collection (idempotent) |
| `db_drop` | Soft-delete a collection |
| `db_purge` | Permanently delete a dropped collection |
| `db_insert` | Insert one or more records |
| `db_find` | Query with filter, pagination, summary mode, token budget |
| `db_find_one` | Get a single record by ID |
| `db_update` | Update matching records ($set, $unset, $inc, $push) |
| `db_upsert` | Insert or update by ID |
| `db_delete` | Delete matching records |
| `db_count` | Count matching records |
| `db_batch` | Execute multiple mutations atomically |
| `db_undo` | Undo last mutation |
| `db_history` | Mutation history for a record |
| `db_schema` | Sample records to infer field shapes dynamically — no stored schema required |
| `db_get_schema` | Read the PersistedSchema (description, instructions, field types, indexes) from `meta/` |
| `db_set_schema` | Create/update persisted schema (admin-only, partial merge) |
| `db_delete_schema` | Delete persisted schema for a collection (admin-only, idempotent) |
| `db_diff_schema` | Preview what db_set_schema would change — structured diff with warnings and record impact counts |
| `db_infer_schema` | Sample existing records and propose a PersistedSchema — cold-start schema bootstrap |
| `db_migrate` | Declarative bulk record update via set/unset/rename/default/copy ops with dryRun and per-record error tracking |
| `db_distinct` | Unique values for a field |
| `db_stats` | Database-level statistics |
| `db_archive` | Move records to cold storage |
| `db_archive_list` | List archive segments |
| `db_archive_load` | View archived records |
| `db_semantic_search` | Search by meaning (requires embedding provider) |
| `db_embed` | Manually trigger embedding |
| `db_vector_upsert` | Store a pre-computed vector with metadata |
| `db_vector_search` | Search by raw vector (no embedding provider needed) |
| `db_bm25_search` | Pure BM25 lexical search (no embedding provider needed) |
| `db_hybrid_search` | Hybrid BM25 + semantic search fused via RRF (degrades gracefully) |
| `db_reembed_all` | Force-reembed all records in a collection — use when upgrading from v1.3 (admin-only, DESTRUCTIVE) |
| `db_rebuild_text_index` | Rebuild the BM25 text index from scratch — use after upgrading from v1.4 (admin-only) |
| `db_blob_write` | Attach a file (base64) to a record |
| `db_blob_read` | Read an attached file |
| `db_blob_list` | List files attached to a record |
| `db_blob_delete` | Delete an attached file |
| `db_export` | Export collections as JSON backup |
| `db_import` | Import from a JSON backup |

Each tool returns `{ content: [{ type: "text", text: "..." }] }`. Tools with an `outputSchema` also include `structuredContent` for typed programmatic access — clients that know the shape can use it directly instead of parsing the text. Errors return `{ isError: true, content: [...] }` — they never throw across the tool boundary.

## Agent Identity

Every mutation accepts `agent` and `reason`. These are stored internally and visible in history, but stripped from query results.

```typescript
await col.insert(
  { title: "Fix login bug" },
  { agent: "triage-bot", reason: "Auto-filed from error spike" },
);

// History shows who did what and why
col.history(id);
// → [{ type: "set", key: "...", value: { ..., _agent: "triage-bot", _reason: "..." }, ... }]
```

## Authentication

### Bearer token (simplest)

```bash
npx @backloghq/agentdb --http --auth-token my-secret-token

# Agents send: Authorization: Bearer my-secret-token
```

Or via environment variable:

```bash
AGENTDB_AUTH_TOKEN=my-secret-token npx @backloghq/agentdb --http
```

No token configured = open access (backward compatible). Health check at `/health` always works.

### Multi-agent tokens

Map different tokens to different agent identities and permissions:

```typescript
startHttp(dir, {
  authTokens: {
    "token-reader": { agentId: "reader", permissions: { read: true, write: false, admin: false } },
    "token-writer": { agentId: "writer", permissions: { read: true, write: true, admin: false } },
  },
});
```

### Agent identity and the `agent` parameter

All mutation tools accept an `agent` parameter to stamp who made a change. **Over an authenticated HTTP transport, this parameter is silently overridden with the authenticated identity — the value you supply is ignored.** The authenticated identity (from bearer token or JWT) always wins.

Library callers without auth context (in-process `new AgentDB(...)` use) still control the field directly.

| Context | Behavior |
|---|---|
| HTTP + auth configured | Authenticated identity wins; `agent` arg ignored |
| HTTP + no auth | `agent` arg used as-is |
| Library (in-process) | `agent` arg used as-is |

### JWT (production)

Validate JWTs from any OAuth provider (Auth0, WorkOS, etc.):

```typescript
import { startHttp, createJwtAuth } from "@backloghq/agentdb/mcp";

startHttp(dir, {
  authFn: createJwtAuth({
    jwksUrl: "https://your-domain.auth0.com/.well-known/jwks.json",
    audience: "agentdb",
    issuer: "https://your-domain.auth0.com",
  }),
});
```

### Auth priority when multiple mechanisms are configured

If more than one mechanism is set in the same config, the CLI enforces a fixed priority and emits a warning at startup:

```
jwt > multi-token > bearer
```

| What you configured | What is enforced |
|---|---|
| `AGENTDB_HTTP_JWT_SECRET` only | JWT |
| `AGENTDB_HTTP_MULTI_TOKEN` only | multi-token |
| `AGENTDB_AUTH_TOKEN` only | bearer |
| JWT + multi-token (or bearer) | JWT wins; others are silently ignored after warning |
| multi-token + bearer | multi-token wins; bearer is silently ignored after warning |

The warning is emitted to stderr and names the active mechanisms, the winner, and the priority order.

**JWT secret minimum length:** use at least 32 characters (256 bits) for HMAC-SHA256 secrets. Shorter keys are cryptographically weak and may be rejected by strict JWT libraries. A good default: `openssl rand -hex 32`.

### Group commit (faster writes)

Buffer writes in memory and flush as a single disk write. ~12x faster for sustained writes. Single-writer only — auto-disabled when `agentId` is set.

```bash
npx @backloghq/agentdb --http --group-commit

# Or via env var
AGENTDB_WRITE_MODE=group npx @backloghq/agentdb --http
```

```typescript
const db = new AgentDB("./data", { writeMode: "group" });
```

**Tradeoff:** A crash can lose buffered ops (up to 100ms of data). Default `"immediate"` mode is safe — every write survives a crash.

### Read-only mode

Open a read-only instance alongside a running writer — no write locks, safe for dashboards and monitoring:

```typescript
const reader = new AgentDB("./data", { readOnly: true });
await reader.init();
const col = await reader.collection("tasks");
await col.tail(); // pick up latest writes
```

### Blob storage

Attach files to records — images, PDFs, code, any binary. Stored outside the WAL via the StorageBackend (works on filesystem and S3).

```typescript
const col = await db.collection("tasks");
await col.insert({ _id: "task-1", title: "Fix auth" });

// Attach files
await col.writeBlob("task-1", "spec.md", "# Spec\n\nDetails...");
await col.writeBlob("task-1", "screenshot.png", imageBuffer);

// Read back
const spec = await col.readBlob("task-1", "spec.md");
const blobs = await col.listBlobs("task-1"); // → ["spec.md", "screenshot.png"]

// Delete
await col.deleteBlob("task-1", "spec.md");
```

Blobs are automatically cleaned up when their parent record is deleted.

### Embeddings and vector search

AgentDB supports semantic search via embedding providers and explicit vector storage.

**Embedding providers** (for automatic text embedding):

```bash
# Local via Ollama (no API key)
npx @backloghq/agentdb --http --embeddings ollama

# OpenAI
OPENAI_API_KEY=sk-... npx @backloghq/agentdb --http --embeddings openai:text-embedding-3-small

# Gemini (free tier available)
GEMINI_API_KEY=... npx @backloghq/agentdb --http --embeddings gemini

# Voyage AI / Cohere
AGENTDB_EMBEDDINGS_API_KEY=... npx @backloghq/agentdb --http --embeddings voyage
AGENTDB_EMBEDDINGS_API_KEY=... npx @backloghq/agentdb --http --embeddings cohere
```

**Explicit vector API** (no provider needed):

```typescript
const col = await db.collection("docs");

// Store pre-computed vectors
await col.insertVector("doc1", [0.1, 0.2, ...], { title: "My Document" });

// Search by vector
const results = await col.searchByVector([0.1, 0.2, ...], { limit: 10, filter: { status: "active" } });
// → { records: [...], scores: [0.98, 0.91, ...] }
```

MCP tools: `db_vector_upsert`, `db_vector_search`, `db_semantic_search`, `db_embed`.

**What text gets embedded?**

When AgentDB embeds a record automatically (via `embedUnembedded` or on insert), it concatenates the string values of all user-defined fields. Internal metadata fields — `_id`, `_version`, `_agent`, `_reason`, `_expires`, `_embedding` — are excluded.

This matters if you compute query embeddings client-side: embed only the user-field content, not any `_`-prefixed keys. Using the same field set for both indexing and querying is what makes retrieval work correctly.

```typescript
// Correct: embed only user fields
const queryText = `${record.title} ${record.body}`;
const [queryVec] = await provider.embed([queryText]);
const results = await col.searchByVector(queryVec, { limit: 10 });

// Wrong: including _id shifts the embedding away from query embeddings
const queryText = `${record._id} ${record.title} ${record.body}`; // don't do this
```

**v1.3 → v1.4 migration:** v1.3 incorrectly included `_id` in the embedding text. If you have a disk-mode collection indexed by v1.3, call `col.reembedAll()` once after upgrading to fix the stored embeddings. The `db_reembed_all` MCP tool does the same thing (requires admin permission).

**Memory note:** `embedUnembedded` (lazy path) holds all unembedded record references in memory before batching — roughly 1 KB/record, so ~1 GB at 1M unembedded. For large collections, call `col.reembedAll()` instead: it streams and flushes mid-run with bounded memory. `reembedAll` triggers an internal `compactInPlace()` every 8 batches, which itself fully materializes the on-disk dataset (~1 KB/record peak per compaction); cost is amortized across the run.

### Hybrid search (BM25 + semantic)

Combines BM25 lexical scoring with vector similarity, fused via Reciprocal Rank Fusion. Catches exact-term matches that semantic search misses, and semantic matches that keyword search misses.

**Schema — mark fields as searchable:**

```typescript
const notes = await db.collection(defineSchema({
  name: "notes",
  textSearch: true,
  fields: {
    title: { type: "string", searchable: true },  // BM25-indexed
    body:  { type: "string", searchable: true },  // BM25-indexed
    tags:  { type: "string[]" },                  // not indexed for BM25
  },
}));
```

`searchable: true` is opt-in. Collections without any `searchable` fields fall back to indexing all string fields (v1.3 behaviour preserved).

**Library API:**

```typescript
// BM25-only (no embedding provider needed)
const { records, scores } = await notes.bm25Search("typescript generics", {
  limit: 10,
  filter: { status: "published" },
});

// Hybrid: BM25 + semantic, fused via RRF
const { records, scores } = await notes.hybridSearch("typescript generics", {
  limit: 10,
  k: 60,          // RRF k parameter — higher = less rank-position sensitive
  filter: { status: "published" },
});
```

**Degraded modes** — hybrid degrades gracefully:
- No embedding provider configured → BM25-only ranking
- No `textSearch: true` → vector-only ranking
- Neither available → throws

**MCP tool:**

```json
{ "name": "db_hybrid_search", "arguments": { "collection": "notes", "query": "typescript generics", "limit": 10 } }
```

**BM25 defaults:** `k1=1.2`, `b=0.75` (Okapi BM25 standard). Configurable via `Collection` constructor options. **RRF default:** `k=60` (Cormack et al. 2009).

**Upgrading from v1.4:** v1.4 stored BM25 indexes as a single JSON blob (`indexes/text-index.json`). v2.0 uses `@backloghq/termlog` (segment-based LSM). On first open with `textSearch: true`, AgentDB detects the old blob and throws `LegacyTextIndexError`. See [Migration from v1.4](#migration-from-v14) below.

**Unicode normalisation:** AgentDB does not normalise Unicode before tokenizing. Precomposed (`é`, U+00E9) and decomposed (`e` + U+0301) forms of the same character are treated as distinct tokens. Ensure your application uses consistent Unicode normalisation (e.g. NFC) on both indexed text and queries; otherwise the same word in different normal forms will not match.

#### Limits

v2.0+ uses `@backloghq/termlog` (segment-based LSM) for BM25 — there is no per-collection document cap. The old 256 MB `IndexFileTooLargeError` ceiling is gone.

### Embedding and disk performance knobs

Two options control embedding throughput and disk-mode concurrency. Both follow the same placement rule: set a db-wide default in `AgentDBOptions`; override per-collection in `CollectionOptions`.

**`embeddingBatchSize`** — number of records sent to the embedding provider in a single `embed()` call during `embedUnembedded`. Default: `256`.

```typescript
// db-wide default
const db = new AgentDB("./data", { embeddingBatchSize: 128 });

// per-collection override (wins over db-wide)
const col = await db.collection("articles", { embeddingBatchSize: 64 });
```

Smaller batches reduce peak memory and provider timeout risk; larger batches reduce round-trips. Most hosted providers cap at 512–2048 texts per call — stay below their limit. All embedding providers (OpenAI, Voyage, Cohere, Gemini, Ollama, HTTP) automatically chunk each `embed()` call into provider-safe batches, so `embeddingBatchSize` can be set independently of API limits.

**`diskConcurrency`** — maximum number of concurrent `DiskStore.get()` calls when materializing BM25/vector candidates in disk mode. Default: `20` for non-local-filesystem backends (e.g. S3); local filesystem is unbounded.

```typescript
// db-wide default (applied to every disk-mode collection)
const db = new AgentDB("./data", { diskConcurrency: 32 });

// per-collection override
const col = await db.collection("embeddings", { diskConcurrency: 8 });
```

S3 sizing guidance: the default of `20` prevents per-prefix request throttling at typical QPS. If you are running at very high query concurrency (dozens of simultaneous `hybridSearch` calls) and observe `SlowDown` errors, raise to `32`. If you share an S3 prefix with other workloads, lower to `8` to leave headroom.

### Rate limiting and CORS

```bash
npx @backloghq/agentdb --http --auth-token secret --rate-limit 100 --cors https://app.example.com
```

### Real-time notifications

Subscribe to collection changes via `db_subscribe` / `db_unsubscribe` on the HTTP MCP transport. Agents receive push notifications via SSE when records are inserted, updated, or deleted — no polling needed. See [examples/multi-agent/](./examples/multi-agent/) for a working demo.

## Docker

```bash
docker build -t agentdb .
docker run -p 3000:3000 -v ./data:/data agentdb --path /data --http --host 0.0.0.0

# With auth:
docker run -p 3000:3000 -e AGENTDB_AUTH_TOKEN=secret -v ./data:/data agentdb --path /data --http --host 0.0.0.0

# With a config file (mount the file and point --config at it):
docker run -p 3000:3000 \
  -v ./data:/data \
  -v ./agentdb.config.json:/etc/agentdb/config.json:ro \
  agentdb --path /data --http --host 0.0.0.0 --config /etc/agentdb/config.json

# With S3:
docker run -p 3000:3000 \
  -e AGENTDB_BACKEND=s3 \
  -e AGENTDB_S3_BUCKET=my-bucket \
  -e AWS_REGION=us-east-1 \
  agentdb --http --host 0.0.0.0
```

## Sorting

```typescript
col.find({ filter: { status: "active" }, sort: "name" });     // ascending
col.find({ filter: { status: "active" }, sort: "-score" });    // descending
col.find({ sort: "-metadata.priority" });                       // nested field
```

## Progressive Disclosure

Use `summary: true` on find to get compact results. Omits long text fields (>200 chars), nested objects, and large arrays (>10 items). Useful for agents scanning many records before drilling into one.

```typescript
col.find({ filter: { status: "active" }, summary: true });
```

## Deployment Patterns

| Scenario | Pattern | Storage Mode | Latency |
|----------|---------|-------------|---------|
| Small datasets (<10K records) | Direct import / stdio MCP | memory (default) | <1ms |
| Large datasets (10K-1M+) | Direct import / HTTP MCP | disk | <1ms findOne, ~10ms find |
| Auto-scaling | Any | auto (switches at threshold) | varies |
| Multiple agents, same machine | HTTP MCP server | memory or disk | ~1-5ms |
| Multiple agents, distributed | HTTP MCP + S3 backend | disk | ~50ms |
| Decentralized, no server | Multi-writer S3 | memory | ~50ms |

**Storage mode guide:**
- `memory` — all records in RAM. Fastest queries. Use for <10K records.
- `disk` — records in JSONL + Parquet on disk/S3. Handles 1M+ records. Lazy index loading for fast cold open.
- `auto` — starts in memory, switches to disk when collection exceeds `diskThreshold`.

**Default recommendation:** Use `memory` for small datasets, `disk` or `auto` for anything that might grow.

## Configuration

The MCP CLI accepts configuration from three sources. Precedence (highest first):

1. **CLI flags** — passed directly to `npx @backloghq/agentdb`
2. **Environment variables** — `AGENTDB_*` prefixed vars
3. **Config file** — `agentdb.config.json` in the working directory, or the path from `--config` / `AGENTDB_CONFIG`

### 1. CLI flags

Every option has a flag. Flags win over env vars and the config file:

```bash
npx @backloghq/agentdb \
  --path ./data \
  --http --port 3000 \
  --backend s3 --bucket my-bucket \
  --write-mode group \
  --embeddings openai \
  --schemas "schemas/*.json" \
  --auth-token secret \
  --tenant-id org-123
```

Run `npx @backloghq/agentdb --help` for the full flag list.

### 2. Environment variables

All flags have an `AGENTDB_` equivalent. Useful for container deployments and secrets managers:

```bash
AGENTDB_PATH=./data
AGENTDB_WRITE_MODE=group
AGENTDB_BACKEND=s3
AGENTDB_S3_BUCKET=my-bucket
AGENTDB_S3_REGION=us-east-1
AGENTDB_HTTP_AUTH=secret
AGENTDB_TENANT_ID=org-123
AGENTDB_EMBEDDINGS_PROVIDER=openai
AGENTDB_EMBEDDINGS_API_KEY=sk-...
```

Full reference:

| Variable | Type | Description |
|---|---|---|
| `AGENTDB_CONFIG` | string | Path to config file (overrides auto-discovery) |
| `AGENTDB_PATH` | string | Data directory |
| `AGENTDB_WRITE_MODE` | `immediate`\|`group`\|`async` | Write durability mode |
| `AGENTDB_GROUP_COMMIT_SIZE` | number | Batch size for group/async mode |
| `AGENTDB_GROUP_COMMIT_MS` | number | Max latency (ms) for group commit |
| `AGENTDB_MAX_FIND_LIMIT` | number | Cap on records returned by `find()` |
| `AGENTDB_MAX_INDEX_CARDINALITY` | number | B-tree index cardinality threshold |
| `AGENTDB_CACHE_SIZE` | number | Disk LRU record cache size |
| `AGENTDB_DISK_CONCURRENCY` | number | Parallel JSONL reads |
| `AGENTDB_EMBEDDING_BATCH_SIZE` | number | Records per embedding batch |
| `AGENTDB_FILTER_CACHE_SIZE` | number | Compiled-filter LRU cache size |
| `AGENTDB_MERGE_PARQUET_THRESHOLD` | number | Parquet file compaction trigger |
| `AGENTDB_MERGE_JSONL_THRESHOLD` | number | JSONL file compaction trigger |
| `AGENTDB_MEMORY_BUDGET` | number | Memory budget in bytes (0 = unlimited) |
| `AGENTDB_ROW_GROUP_SIZE` | number | Parquet row group size |
| `AGENTDB_HNSW_M` | number | HNSW M parameter |
| `AGENTDB_HNSW_EF_CONSTRUCTION` | number | HNSW efConstruction |
| `AGENTDB_HNSW_EF_SEARCH` | number | HNSW efSearch |
| `AGENTDB_HNSW_MAX_LEVEL` | number | HNSW max level cap |
| `AGENTDB_EMBEDDINGS_PROVIDER` | string | Embedding provider: `ollama`, `openai`, `voyage`, `cohere`, `gemini`, `http` |
| `AGENTDB_EMBEDDINGS_API_KEY` | string | API key for the embedding provider |
| `AGENTDB_EMBEDDINGS_MODEL` | string | Model name |
| `AGENTDB_EMBEDDINGS_BATCH_LIMIT` | number | Max texts per API call (HTTP provider) |
| `AGENTDB_EMBEDDINGS_URL` | string | HTTP embedding provider URL |
| `AGENTDB_EMBEDDINGS_BASE_URL` | string | Ollama base URL (same as `AGENTDB_OLLAMA_URL`) |
| `AGENTDB_EMBEDDINGS_DIMENSIONS` | number | Embedding vector dimensions (HTTP provider) |
| `AGENTDB_OLLAMA_URL` | string | Ollama base URL (alias for `AGENTDB_EMBEDDINGS_BASE_URL`) |
| `AGENTDB_DISK_THRESHOLD` | number | Record count at which `auto` mode switches to disk |
| `AGENTDB_BACKEND` | `fs`\|`s3` | Storage backend |
| `AGENTDB_S3_BUCKET` | string | S3 bucket name |
| `AGENTDB_S3_REGION` | string | AWS region |
| `AGENTDB_S3_PREFIX` | string | S3 key prefix |
| `AGENTDB_AGENT_ID` | string | Agent ID for multi-writer mode |
| `AGENTDB_TENANT_ID` | string | Tenant binding |
| `AGENTDB_SCHEMA_PATHS` | comma-list | Schema JSON files to load on startup |
| `AGENTDB_STORAGE_MODE` | `memory`\|`disk`\|`auto` | Storage mode |
| `AGENTDB_READ_ONLY` | boolean | Open collections read-only |
| `AGENTDB_HTTP_PORT` | number | HTTP port |
| `AGENTDB_HTTP_HOST` | string | HTTP bind address |
| `AGENTDB_HTTP_AUTH` | string | Bearer token |
| `AGENTDB_HTTP_MULTI_TOKEN` | JSON array | Multiple bearer tokens (JSON) |
| `AGENTDB_HTTP_JWT_SECRET` | string | JWT signing secret |
| `AGENTDB_HTTP_JWT_AUDIENCE` | string | JWT audience |
| `AGENTDB_HTTP_JWT_ISSUER` | string | JWT issuer |
| `AGENTDB_HTTP_MAX_SESSIONS` | number | Max concurrent MCP sessions |
| `AGENTDB_HTTP_SESSION_IDLE_MS` | number | Session idle timeout (ms) |
| `AGENTDB_HTTP_AUDIT_BUFFER_SIZE` | number | Audit log ring-buffer size |
| `AGENTDB_HTTP_AUDIT_MAX_LIMIT` | number | Audit query max page size |
| `AGENTDB_HTTP_AUDIT_DEFAULT_LIMIT` | number | Audit query default page size |
| `AGENTDB_HTTP_RATE_LIMIT` | number | Max requests/minute per IP |
| `AGENTDB_HTTP_RATE_LIMIT_WINDOW` | number | Rate limit window (ms) |
| `AGENTDB_HTTP_CORS` | comma-list | Allowed CORS origins |
| `AWS_REGION` | string | AWS region fallback (standard SDK var) |

> **Security note:** environment variables set in a process are readable from `/proc/<pid>/environ` on Linux by any user with access to that file (root, or the process owner). For long-lived server processes, prefer injecting secrets via a secrets manager, a read-protected config file (`chmod 600 agentdb.config.json`), or systemd `EnvironmentFile=` with appropriate permissions — rather than exporting tokens directly in shell startup scripts.

### 3. Config file

`agentdb.config.json` in the working directory is loaded automatically when present. Use `--config <path>` or `AGENTDB_CONFIG=<path>` to point at a different file.

**Note:** if you pass `--config` explicitly and the file does not exist, the CLI exits 1. The auto-discovered `./agentdb.config.json` silently produces an empty config when absent (no error), so you can safely omit it in development.

```json
{
  "db": {
    "path": "./data",
    "writeMode": "group",
    "maxFindLimit": 5000,
    "memoryBudget": 1073741824,
    "hnsw": { "M": 32, "efSearch": 100 },
    "embeddings": {
      "provider": "openai",
      "model": "text-embedding-3-small"
    }
  },
  "http": {
    "port": 3000,
    "host": "0.0.0.0",
    "auth": "change-me",
    "maxSessions": 200,
    "sessionIdleMs": 600000,
    "cors": ["https://myapp.example.com"]
  },
  "collections": {
    "notes": {
      "maxFindLimit": 500,
      "mergeParquetThreshold": 5,
      "hnsw": { "efSearch": 200 }
    }
  }
}
```

The `collections` key supports per-collection overrides for most storage and search knobs. Any key omitted falls back to the db-wide value.

### Library API

The config pipeline is also available as a library function. The CLI uses it internally; library users are not affected by any of the above:

```typescript
import { loadAgentDBConfig, ConfigValidationError } from "@backloghq/agentdb";

try {
  const config = loadAgentDBConfig({
    configPath: "./my-config.json", // optional; auto-discovers agentdb.config.json by default
    requireConfigFile: true,        // error if configPath is missing (default: false)
    env: process.env,               // injectable for testing
    cli: { db: { path: "./data" } }, // highest precedence
  });
  console.log(config.db?.path);
} catch (e) {
  if (e instanceof ConfigValidationError) {
    console.error(`Config error (${e.source}): ${e.message}`);
  }
}
```

`ConfigValidationError` carries `.source` (`"file"` | `"env"` | `"cli"`), `.path[]` (the field path that failed), and `.message`.

### Restart required

Configuration is read once at startup. Changing env vars, the config file, or CLI flags takes effect only after restarting the process. There is no hot-reload.

## Production Tuning

Every configurable knob, its location, default, and the workload signal that should prompt you to change it.

`AgentDB` options propagate as defaults to every collection; per-collection `CollectionOptions` override them.

### Storage and query knobs

| Option | Location | Default | Tune when… | Recommended range |
|--------|----------|---------|-----------|-------------------|
| `maxFindLimit` | `AgentDB` / `Collection` | `10_000` | batch exports need >10K records per page, or you want to enforce a lower cap | 1K – unlimited |
| `maxIndexCardinality` | `AgentDB` / `Collection` | `1_000` | `console.warn` fires at collection open naming a field that exceeds the threshold; queries on that field fall back to full Parquet scan | 100 – 100K |
| `filterCacheSize` | `AgentDB` / `Collection` | `64` | a collection has many distinct query shapes (>64 unique filters in a session) | 32 – 256 |
| `cacheSize` | `AgentDB` / `Collection` | `1_000` | `metrics().recordCacheHits / recordCacheFetches` hit rate is low (<50%) on a hot collection | 100 – 100K |
| `rowGroupSize` | `AgentDB` / `Collection` | `5_000` | column scan performance is slow (lower = smaller seek range, higher = fewer S3 requests) | 1K – 20K |
| `mergeParquetThreshold` | `AgentDB` / `Collection` | `10` | S3 per-request cost is high (raise), or local read amplification is high (lower) | 4 – 50 |
| `mergeJsonlThreshold` | `AgentDB` / `Collection` | `8` | same as `mergeParquetThreshold` — controls JSONL delta file accumulation before full merge | 4 – 40 |
| `diskConcurrency` | `AgentDB` / `Collection` | `20` | S3 point-lookup latency is high (raise to overlap more requests); has no effect on local FS | 4 – 64 |
| `embeddingBatchSize` | `AgentDB` / `Collection` | `256` | embedding provider rate-limit errors or timeouts on large batch runs | 8 – 512 |
| `hnsw.M` | `AgentDB` / `Collection` | `16` | recall is low (raise) or index build is slow and you accept lower recall (lower) | 4 – 64 |
| `hnsw.efConstruction` | `AgentDB` / `Collection` | `200` | index build time is too slow (lower) or initial recall on a fresh dataset is unsatisfactory (raise) | 50 – 500 |
| `hnsw.efSearch` | `AgentDB` / `Collection` | `50` | `semanticSearch` / `hybridSearch` recall is insufficient (raise) or query latency is high (lower) | 10 – 500 |

### Write mode and commit knobs

| Option | Location | Default | Tune when… | Notes |
|--------|----------|---------|-----------|-------|
| `writeMode` | `AgentDB` | `"immediate"` | write throughput is the bottleneck (switch to `"group"` for ~12x, `"async"` for ~50x) | `"group"` / `"async"` require single-writer; `"async"` loses unflushed ops on crash |
| `groupCommitSize` | `AgentDB` | `50` | group-commit batches are too small (raise) or latency per op is too high (lower) | Only effective when `writeMode: "group"` |
| `groupCommitMs` | `AgentDB` | `100` | you need lower write latency at the cost of smaller batches (lower) or higher throughput at higher latency (raise) | Only effective when `writeMode: "group"` |

### Memory and budget knobs

| Option | Location | Default | Tune when… | Notes |
|--------|----------|---------|-----------|-------|
| `memoryBudget` | `AgentDB` | `0` (unlimited) | you want a `console.warn` when total collection memory exceeds a threshold | Set in bytes; `0` disables the check; check fires at mutation time via the memory monitor |

### HTTP / MCP server knobs

| Option | Location | Default | Tune when… | Recommended range |
|--------|----------|---------|-----------|-------------------|
| `maxSessions` | `HttpOptions` | `100` | multi-agent orchestrators fan out more than 100 concurrent connections | 10 – 1000 |
| `sessionIdleMs` | `HttpOptions` | `1_800_000` (30 min) | agents hold long-lived idle connections (raise) or session memory is expensive (lower) | 60K – 86_400_000 |
| `auditBufferSize` | `HttpOptions` | `10_000` | audit entries are silently dropped (observable via log volume drops) | 1K – 100K |

### Observability

Use `col.metrics()` to read live counters without any instrumentation cost:

```typescript
const m = col.metrics();
// Filter cache hit rate — low values mean filterCacheSize should be raised
console.log(m.filterCacheHits / (m.filterCacheHits + m.filterCompilations));
// Disk LRU hit rate — low values mean cacheSize should be raised
console.log(m.recordCacheHits / m.recordCacheFetches);
// findTruncations — non-zero means some queries hit the maxFindLimit cap
console.log(m.findTruncations);
// Index sizes
console.log(m.bm25SegmentCount, m.hnswNodeCount, m.walRecordCount, m.parquetRowGroups);
// BM25 detail — doc count (flushed) and whether a merge pass would reduce segment count
console.log(m.bm25DocCount, m.bm25NeedsMerge);
// Write mode this collection is running under
console.log(m.writeMode);
```

**Verifying configuration changes:** after adjusting a knob (e.g. raising `cacheSize` or `filterCacheSize`), call `col.metrics()` after a warm-up period of representative traffic. Compare `recordCacheHits / recordCacheFetches` or `filterCacheHits / (filterCacheHits + filterCompilations)` before and after to confirm the new limit is having the intended effect. All counters are lifetime values since the collection was opened.

## Limits and Ceilings

Every hard cap in the system, what triggers it, and how to change it.

| Cap | Default | What triggers it | Effect | How to change |
|-----|---------|-----------------|--------|---------------|
| `maxFindLimit` | `10_000` | `find()` called with `limit` exceeding the cap | Result is truncated (`truncated: true`); `console.warn` printed; `metrics().findTruncations` incremented | `CollectionOptions.maxFindLimit` or `AgentDBOptions.maxFindLimit` |
| `maxIndexCardinality` | `1_000` | Field cardinality exceeds threshold at index load | B-tree index for that field is skipped; queries fall back to full Parquet scan; `console.warn` printed once per field | `CollectionOptions.maxIndexCardinality` or `AgentDBOptions.maxIndexCardinality` |
| `maxSessions` | `100` | 101st concurrent MCP HTTP session arrives | HTTP 503 returned | `HttpOptions.maxSessions` |
| `auditBufferSize` | `10_000` | 10,001st audit log entry recorded | Oldest entry silently dropped (ring buffer) | `HttpOptions.auditBufferSize` |
| `auditMaxLimit` | `10_000` | `/audit?limit=N` with N exceeding cap | `limit` silently capped at maximum | `HttpOptions.auditMaxLimit` |
| `mergeParquetThreshold` | `10` | 10 incremental Parquet files accumulate before compaction | Full merge triggered on next close | `AgentDB/CollectionOptions.mergeParquetThreshold` |
| `mergeJsonlThreshold` | `8` | 8 incremental JSONL delta files accumulate | Full merge triggered on next close | `AgentDB/CollectionOptions.mergeJsonlThreshold` |

**Removed in v2.0:** the 256 MB per-collection text index cap (~25–30K document ceiling) is gone. termlog uses a segment-based LSM with no in-memory size limit.

## Migration from v1.4

v2.0 replaces the in-house `TextIndex` JSON blob with `@backloghq/termlog` (segment-based LSM). The change is automatic for new collections. Existing collections that have a v1.4 BM25 index on disk require a one-time rebuild.

**Detection:** on the first open with `textSearch: true`, AgentDB checks for `indexes/text-index.json` (v1.4 format) without a termlog manifest. If found, it throws `LegacyTextIndexError` (exported from core) with a `legacyPath` field pointing at the old file.

**Rebuild via library API:**

```typescript
import { AgentDB, LegacyTextIndexError, defineSchema } from "@backloghq/agentdb";

const schema = defineSchema({ name: "notes", textSearch: true, fields: { ... } });
const db = await AgentDB.open("./data");

try {
  await db.collection(schema);
} catch (e) {
  if (e instanceof LegacyTextIndexError) {
    await db.rebuildTextIndex("notes");  // re-indexes all records into a fresh TermLog
    await db.collection(schema);         // succeeds now
  }
}
```

**Disk space:** in FS mode, `rebuildTextIndex` builds the new index in `text.new/` while the original `text/` remains intact and queryable. Both directories coexist until the atomic rename swap completes — plan for ~2× your current text-index size in free disk space during the rebuild. In S3 mode, the old index is wiped before rebuilding (no rename is possible for blob stores).

**Write safety:** records inserted, updated, or deleted during an in-flight rebuild are captured in the new index. Concurrent `bm25Search` calls during a rebuild are safe — they read from the old index until the swap completes.

**Rebuild via MCP tool** (no code change required):

```json
{ "name": "db_rebuild_text_index", "arguments": { "collection": "notes" } }
```

Returns `{ rebuiltDocCount: N }`. Requires admin permission.

**What's new in v2.1.1 (patch):**
- HNSW graph persistence — disk-mode collections now persist the graph to `<dir>/hnsw/graph.bin` on close and load it on reopen, eliminating the O(N) rebuild for embedded collections
- HNSW determinism — new `HnswOptions.seed` for reproducible layer assignments across processes
- `bm25DocCount` no longer inflates 2× after the first BM25 search in a session
- Composite and bloom indexes now populate from disk on reopen (were silently empty in disk mode)
- Five memory-leak fixes (HNSW orphans on delete, MemoryMonitor LRU cleanup, close() listener teardown, subscription pin-while-subscribed, S3 rebuild close interlock)
- Targeted leak regression bench (`npm run bench:leak`) gated by CI

**What's new in v2.1:**
- `AgentDB.open(dir, opts)` static factory — async one-call entry point; replaces the `new AgentDB(...); await db.init()` two-step
- Lazy auto-init — calling `db.collection(...)` without explicit `init()` now Just Works
- Configuration: optional `agentdb.config.json` + 47 `AGENTDB_*` env vars for the MCP CLI (precedence CLI > env > file > defaults)
- Per-collection overrides via `collectionOverrides` (db-wide) or the config file's `collections` block
- Production-readiness knobs: `maxFindLimit`, `maxIndexCardinality`, `mergeParquetThreshold`, `mergeJsonlThreshold`, `filterCacheSize`, HNSW `M`/`efConstruction`/`efSearch`/`maxLevel`, `maxSessions`/`sessionIdleMs`, audit buffer/limits
- Ergonomics: `onProgress` callbacks for `reembedAll`/`rebuildTextIndex`/`db_import`; `AbortSignal` for `find`, `reembedAll`, `rebuildTextIndex`; `col.metrics()` for cache hit-rate / index usage / BM25 segment count / write mode
- Auth hardening: JWT secret minimum 32 bytes (HS256 RFC 7518); auth precedence (JWT > multi-token > bearer) with conflict warn
- `rebuildTextIndex` now uses snapshot-then-swap with concurrent-write capture and crash recovery — runs safely against live collections (FS mode)

See [MIGRATION-2.0.md](./MIGRATION-2.0.md#new-in-v21) for the full v2.1 list and [CHANGELOG.md](./CHANGELOG.md) for the detailed entry.

**What's new in v2.0:**
- No per-collection document cap (256 MB / ~25–30K doc ceiling is gone)
- S3-backed text indexes via `@backloghq/termlog-s3` (auto-wired when opslog uses S3)
- Segment-based LSM — writes never block reads; compaction happens in the background
- BM25 scores are deterministic across close/reopen (WAL replay double-count bug fixed)

**S3 text search** — install the optional peer dependency:

```bash
npm install @backloghq/termlog-s3
```

Text indexes are then automatically stored in S3 alongside opslog data. No configuration needed beyond the existing S3 backend setup.

## Examples

See [examples/](./examples/) for runnable demos powered by Ollama:

- **[Multi-Agent Task Board](./examples/multi-agent/)** — Agents collaborate on a shared task board. Event-driven via NOTIFY/LISTEN.
- **[RAG Knowledge Base](./examples/rag-knowledge-base/)** — Ingest docs, embed with Ollama, answer questions via hybrid search (BM25 + semantic, fused via RRF). Updated for v2.0.
- **[Research Pipeline](./examples/research-pipeline/)** — 3-stage AI pipeline: Researcher → Analyst → Writer. Each stage triggers the next.
- **[Multi-Model Code Review](./examples/code-review/)** — Gemini generates code, Ollama reviews locally, Gemini writes tests. Multi-provider orchestration. Updated for v2.0: shows schema lifecycle (`defineSchema` with description/instructions/field descriptions, auto-persistence, `db_get_schema` discovery).
- **[Live Dashboard](./examples/live-dashboard/)** — Real-time CLI view of any running demo's collections.

## Development

```bash
npm run build          # tsc
npm run lint           # eslint src/ tests/
npm test               # vitest run
npm run test:coverage  # vitest coverage
```

Built on [@backloghq/opslog](https://github.com/backloghq/opslog) -- every mutation is an operation in an append-only log. You get crash safety, undo, and audit trails for free.

## License

MIT
