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

const db = new AgentDB("./data");
await db.init();

const tasks = await db.collection("tasks");

// Insert
const id = await tasks.insert(
  { title: "Ship v1", status: "active", priority: 1 },
  { agent: "planner", reason: "Sprint kickoff" },
);

// Find
const result = tasks.find({ filter: { status: "active" } });
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

const db = new AgentDB("./data");
await db.init();

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

const urgent = tasks.find({ filter: { "+URGENT": true } });
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

const db = new AgentDB("./data");
await db.init();

const tools = getTools(db);
// → Array of { name, description, schema, annotations, execute }
```

Framework-agnostic. Each tool has a zod schema and an `execute` function that returns `{ content: [...] }`. Works with Vercel AI SDK, LangChain, or any framework that accepts tool definitions.

### 3. MCP Server

```bash
npx agentdb --path ./data              # stdio (single client)
npx agentdb --path ./data --http       # HTTP (multiple clients)

# Bootstrap schemas at startup (multiple --schemas flags allowed; results unioned)
npx agentdb --path ./data --schemas ./schemas/*.json
npx agentdb --path ./data --schemas ./teams/users.json --schemas ./teams/tasks.json
```

**Schema bootstrap order**: on `db.init()`, `<dataDir>/schemas/*.json` is auto-discovered first, then any `--schemas` paths are loaded on top as overlays. File properties win per-property; untouched persisted properties are preserved.

All 36 tools exposed as MCP tools (38 on HTTP with db_subscribe/db_unsubscribe). Claude Code config (`~/.claude/settings.json`):

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
npx agentdb --backend s3 --bucket my-bucket --region us-east-1
npx agentdb --backend s3 --bucket my-bucket --prefix prod/agentdb --http --port 3000
npx agentdb --backend s3 --bucket my-bucket --agent-id agent-1  # multi-writer
```

### Environment variables

```bash
AGENTDB_BACKEND=s3
AGENTDB_S3_BUCKET=my-bucket
AGENTDB_S3_PREFIX=agentdb        # optional key prefix
AWS_REGION=us-east-1
AGENTDB_AGENT_ID=agent-1         # optional multi-writer
npx agentdb
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

**Operators:** `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$contains`, `$startsWith`, `$endsWith`, `$exists`, `$regex`, `$not`

Top-level keys are implicitly ANDed.

### Compact String Filters

Shorthand for tool calls and quick queries:

```
status:active                          → { status: "active" }
status:active priority.gt:3           → { $and: [{ status: "active" }, { priority: { $gt: 3 } }] }
name.contains:alice                    → { name: { $contains: "alice" } }
(role:admin or role:mod)               → { $or: [{ role: "admin" }, { role: "mod" }] }
tags.in:bug,feature                    → { tags: { $in: ["bug", "feature"] } }
+bug                                   → { tags: { $contains: "bug" } }
-old                                   → { tags: { $not: { $contains: "old" } } }
auth error                             → { $text: "auth error" }
status:active auth                     → { $and: [{ status: "active" }, { $text: "auth" }] }
```

Modifier aliases: `gt`, `gte`, `lt`, `lte`, `ne`, `contains`, `has`, `startsWith`, `starts`, `endsWith`, `ends`, `in`, `nin`, `exists`, `regex`, `match`, `eq`, `is`, `not`, `after`, `before`, `above`, `below`, `over`, `under`

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

## Tool Definitions

`getTools(db)` returns 36 tools:

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
| `db_schema` | Inspect record shape (fields, types, examples) |
| `db_get_schema` | Get persisted schema with context, instructions, fields, indexes |
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
| `db_blob_write` | Attach a file (base64) to a record |
| `db_blob_read` | Read an attached file |
| `db_blob_list` | List files attached to a record |
| `db_blob_delete` | Delete an attached file |
| `db_export` | Export collections as JSON backup |
| `db_import` | Import from a JSON backup |

Each tool returns `{ content: [{ type: "text", text: "..." }] }`. Errors return `{ isError: true, content: [...] }` — they never throw across the tool boundary.

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
npx agentdb --http --auth-token my-secret-token

# Agents send: Authorization: Bearer my-secret-token
```

Or via environment variable:

```bash
AGENTDB_AUTH_TOKEN=my-secret-token npx agentdb --http
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

### Group commit (faster writes)

Buffer writes in memory and flush as a single disk write. ~12x faster for sustained writes. Single-writer only — auto-disabled when `agentId` is set.

```bash
npx agentdb --http --group-commit

# Or via env var
AGENTDB_WRITE_MODE=group npx agentdb --http
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
npx agentdb --http --embeddings ollama

# OpenAI
OPENAI_API_KEY=sk-... npx agentdb --http --embeddings openai:text-embedding-3-small

# Gemini (free tier available)
GEMINI_API_KEY=... npx agentdb --http --embeddings gemini

# Voyage AI / Cohere
AGENTDB_EMBEDDINGS_API_KEY=... npx agentdb --http --embeddings voyage
AGENTDB_EMBEDDINGS_API_KEY=... npx agentdb --http --embeddings cohere
```

**Explicit vector API** (no provider needed):

```typescript
const col = await db.collection("docs");

// Store pre-computed vectors
await col.insertVector("doc1", [0.1, 0.2, ...], { title: "My Document" });

// Search by vector
const results = col.searchByVector([0.1, 0.2, ...], { limit: 10, filter: { status: "active" } });
// → { records: [...], scores: [0.98, 0.91, ...] }
```

MCP tools: `db_vector_upsert`, `db_vector_search`, `db_semantic_search`, `db_embed`.

### Rate limiting and CORS

```bash
npx agentdb --http --auth-token secret --rate-limit 100 --cors https://app.example.com
```

### Real-time notifications

Subscribe to collection changes via `db_subscribe` / `db_unsubscribe` on the HTTP MCP transport. Agents receive push notifications via SSE when records are inserted, updated, or deleted — no polling needed. See [examples/multi-agent/](./examples/multi-agent/) for a working demo.

## Docker

```bash
docker build -t agentdb .
docker run -p 3000:3000 -v ./data:/data agentdb --path /data --http --host 0.0.0.0

# With auth:
docker run -p 3000:3000 -e AGENTDB_AUTH_TOKEN=secret -v ./data:/data agentdb --path /data --http --host 0.0.0.0

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

## Examples

See [examples/](./examples/) for runnable demos powered by Ollama:

- **[Multi-Agent Task Board](./examples/multi-agent/)** — Agents collaborate on a shared task board. Event-driven via NOTIFY/LISTEN.
- **[RAG Knowledge Base](./examples/rag-knowledge-base/)** — Ingest docs, embed with Ollama, answer questions via semantic search.
- **[Research Pipeline](./examples/research-pipeline/)** — 3-stage AI pipeline: Researcher → Analyst → Writer. Each stage triggers the next.
- **[Multi-Model Code Review](./examples/code-review/)** — Gemini generates code, Ollama reviews locally, Gemini writes tests. Multi-provider orchestration.
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
