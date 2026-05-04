# AgentDB

AI-first embedded database for LLM agents. Library-first architecture: core library, framework-agnostic tool definitions, MCP adapter. Built on opslog (`@backloghq/opslog`) with optional S3 backend (`@backloghq/opslog-s3`).

**Status: v1.4 — hybrid search (BM25+RRF+vector), disk-backed embeddings, persisted schemas. 1253 tests.**

Major capabilities:
- **Search:** `bm25Search` (BM25 k1/b tunable, `searchable:true` per field, Unicode tokenizer, 256 MB index cap), `semanticSearch` (HNSW, 6 providers, Int8 quantization), `hybridSearch` (RRF fusion, per-arm failure degrades gracefully), `searchByVector`
- **Disk mode:** JSONL for point lookups + Parquet for column scans; LRU cache; async `entries()` iterator; `appendEmbeddings` writes embedding batches durably to JSONL (bypasses eviction race); `embedUnembedded` single-pass disk scan (halves S3 I/O); `reembedAll` for v1.3→v1.4 migration (`_id` was incorrectly included in embedding text) with mid-flight `compactInPlace()` every 8 JSONL files (bounds index rewrite cost for large runs); `rebuildHnswFromDisk` on reopen
- **Embeddings:** batched `embedUnembedded` (configurable `embeddingBatchSize`, continue-on-error per batch); `extractTextFromRecord` excludes explicit `META_FIELDS_FOR_EMBED` set (`_id`,`_version`,`_agent`,`_reason`,`_expires`,`_embedding`) — user `_`-prefixed fields are included; `reembedAll()` returns `ReembedResult{embedded,failed,errors[]}` for structured partial-failure reporting; `db_reembed_all` admin tool (DESTRUCTIVE)
- **Config knobs:** `embeddingBatchSize`, `diskConcurrency`, `cacheSize`, `rowGroupSize` — all follow AgentDB (db-wide default) + CollectionOptions (per-collection override) shape
- **Schemas:** `PersistedSchema` in `meta/{name}.schema.json` (description, instructions, field types); `db_get/set/delete/diff/infer/migrate` lifecycle tools; `validatePersistedSchema` rejects `searchable:true` on non-string types; schema bootstrap from `schemas/*.json` glob
- **Tools:** 39 core / 41 with HTTP (`db_subscribe`/`db_unsubscribe`); auth (bearer, multi-token, JWT, pluggable `authFn`); rate limiting, CORS, audit logging
- **Write modes:** `immediate` (default, crash-safe), `group` (~12x faster), `async` (~50x faster, lossy). Single-writer only for group/async.
- **Other:** $strLen filter operator; _agent audit stamp from authenticated identity; TTL; optimistic locking (_version); import/export; archive; blob store; memory monitor with per-collection budgets

See `CHANGELOG.md` ([Unreleased] section) for current-cycle details.

## Commands

```bash
npm run build          # tsc
npm run lint           # eslint src/ tests/
npm test               # vitest run
npm run test:coverage  # vitest coverage
```

## Coding Conventions

- Zero native dependencies — pure TypeScript/JS. Core uses opslog + hyparquet; tools add zod; MCP adds express, jose, @modelcontextprotocol/sdk
- Always use conventional commits: `type(scope): description`
- Always look up library/framework docs via Context7 before using APIs
- Lint before committing — all code must pass eslint
- Tests for everything — aim for high coverage, run `test:coverage` to verify
- Tests use temp directories, cleaned up after each test
- **IMPORTANT: On every commit, update ALL docs** — README.md, CLAUDE.md, CHANGELOG.md. Never commit code changes without updating docs in the same commit.
- Update `CHANGELOG.md` on every change ([Keep a Changelog](https://keepachangelog.com) format)
- Errors in tools return `{ isError: true, content: [...] }`, never throw across the tool boundary
- NOTES.md is gitignored — it's a private design doc, not shipped

## Package Exports

```
agentdb          — core library (AgentDB, Collection, filters, indexes, embeddings, S3Backend)
agentdb/tools    — framework-agnostic tool definitions (getTools → 39 tools)
agentdb/mcp      — MCP server adapter (stdio + HTTP/Streamable transport)
```

## Source Layout

```
src/
  index.ts              # Core exports
  auth-context.ts       # Shared auth identity (AsyncLocalStorage) — used by tools + mcp
  schema.ts             # defineSchema(), PersistedSchema, extractPersistedSchema, mergeSchemas, mergePersistedSchemas, validatePersistedSchema, import/export
  agentdb.ts            # AgentDB class: collection manager, schema persistence (persistSchema/loadPersistedSchema/deletePersistedSchema/loadSchemasFromFiles), lazy loading, LRU, memory monitor
  collection.ts         # Collection: CRUD, middleware, search, views, TTL, tailing, iterate() async generator; bm25Search() BM25-ranked lexical; hybridSearch() BM25+semantic via RRF
  collection-helpers.ts # Pure utilities: stripMeta, isExpired, applyUpdate, compositeKey, filter cache
  collection-indexes.ts # IndexManager: B-tree, composite, array, bloom filter indexes + query planning
  record-cache.ts       # LRU cache for disk-backed mode (Map insertion-order eviction)
  array-index.ts        # Inverted element index for O(1) $contains on arrays
  disk-store.ts         # Disk-backed storage: Parquet + LRU cache + persistent indexes; entries() async iterator; shouldCompact()/compactInPlace() for mid-flight reembedAll compaction; MERGE_JSONL_THRESHOLD=8 (parity with MERGE_THRESHOLD=10 Parquet limit — both chosen as ~10× batch size for smooth S3 write amplification)
  disk-io.ts            # Parquet compaction + JSONL record store + readers via hyparquet
  filter.ts             # JSON filter compiler (15 operators incl. $strLen, dot-notation)
  compact-filter.ts     # Compact string parser (role:admin age.gt:18)
  hnsw.ts               # HNSW index for approximate nearest neighbor search
  btree.ts              # Sorted-array index + query frequency tracker
  bloom.ts              # Bloom filter for probabilistic existence checks
  text-index.ts         # Inverted index for full-text search; BM25 scoring via searchScored() (k1/b configurable, v2 JSON persistence)
  rrf.ts                # Reciprocal Rank Fusion utility — rrf(lists, opts?) fuses N ranked lists; k configurable (default 60)
  view.ts               # Named views with cache invalidation
  permissions.ts        # Per-agent permission manager
  memory.ts             # Memory monitor with per-collection budgets
  embeddings/
    types.ts            # EmbeddingProvider interface
    openai.ts           # OpenAI embedding provider
    ollama.ts           # Ollama local embedding provider
    voyage.ts           # Voyage AI embedding provider
    cohere.ts           # Cohere embedding provider
    gemini.ts           # Gemini embedding provider
    http.ts             # Custom HTTP embedding provider
    quantize.ts         # Int8 quantization for vector storage
    index.ts            # Provider factory
  tools/                # Tool definitions split into per-domain modules (getTools aggregator → 39 core, 41 with HTTP)
    index.ts            # Aggregator: getTools(db, opts?) composes all domains in canonical order
    shared.ts           # AgentTool type, makeSafe() wrapper (auth identity unification), READ/WRITE/DESTRUCTIVE annotations, shared zod params
    admin.ts            # db_collections, db_create, db_drop, db_purge, db_stats (5 tools)
    crud.ts             # db_insert, db_find, db_find_one, db_update, db_upsert, db_delete, db_batch, db_count, db_undo, db_history, db_distinct (11 tools)
    schema.ts           # db_schema, db_get_schema, db_set_schema, db_delete_schema, db_diff_schema, db_infer_schema (6 tools)
    migrate.ts          # db_migrate — two-phase snapshot, deletion-as-failed, ops cap, prototype-pollution guards (1 tool)
    archive.ts          # db_archive, db_archive_list, db_archive_load (3 tools)
    vector.ts           # db_semantic_search, db_embed, db_vector_upsert, db_vector_search, db_bm25_search, db_reembed_all, db_hybrid_search (7 tools)
    blob.ts             # db_blob_write, db_blob_read, db_blob_list, db_blob_delete (4 tools)
    backup.ts           # db_export, db_import (2 tools)
  mcp/index.ts          # MCP server (stdio + HTTP/Streamable transport); startHttp/startStdio accept schemaPaths option
  mcp/auth.ts           # Auth middleware (bearer token, rate limiter, audit logger)
  mcp/jwt.ts            # JWT validation with jose
  mcp/subscriptions.ts  # NOTIFY/LISTEN: SubscriptionManager for real-time change notifications
  mcp/cli.ts            # CLI: npx @backloghq/agentdb --path ./data [--backend s3 --bucket ...]
```

## Key Design Decisions

- **Schema terminology** — three distinct concepts: `defineSchema()` = code-level (hooks, validators, computed fields, never serialized); `PersistedSchema` = JSON subset in `meta/{name}.schema.json` (description, instructions, field types — agent-facing); `db_schema` tool = samples records to infer shape dynamically, does not read `PersistedSchema`.
- **`searchable: true` on FieldDef** — opt-in BM25 indexing per field; Collection projects to marked string fields before calling TextIndex.add(). Zero-flag fallback: all string fields indexed (v1.3 compat). Non-string fields with searchable:true warn and are ignored.
- **BM25 v2 JSON persistence** — TextIndex.toJSON() emits version:2 with per-doc TF maps and doc lengths; fromJSON() accepts v1 (lazy upgrade: posting-lists only, scores degrade to 0) and v2. avgdl guard: falls back to 1 when totalLen=0 to prevent NaN on v1-loaded indexes.
- Library-first, MCP is just an adapter — see NOTES.md
- opslog Store per collection, lazy-loaded with LRU eviction
- JSON filter syntax primary, compact string syntax secondary
- Collection middleware: validate, computed fields, virtual filters
- Agent identity + reason on every mutation (stored as _agent/_reason, stripped on read)
- Optimistic locking via _version tracking
- S3 backend via @backloghq/opslog-s3, dynamically imported only when configured
- Semantic search requires external embedding provider (OpenAI, HTTP, or custom)
- Auth: bearer token (default), multi-token, JWT via jose, pluggable authFn
- Rate limiting, CORS, audit logging on HTTP transport
- Write modes: "immediate" (default, crash-safe), "group" (~12x faster), "async" (~50x faster, lossy on crash). Single-writer only for group/async.
