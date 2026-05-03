# AgentDB

AI-first embedded database for LLM agents. Library-first architecture: core library, framework-agnostic tool definitions, MCP adapter. Built on opslog (`@backloghq/opslog`) with optional S3 backend (`@backloghq/opslog-s3`).

**Status:** v1.4 + post-v1.4 fixes. 1188 tests. diskConcurrency moved from SchemaDefinition to AgentDBOptions (db-wide default; CollectionOptions.diskConcurrency for per-collection override). defineSchema throws on non-string searchable:true fields (was warn+skip). findAllRaw renamed to findAllForCompaction (@internal, compaction use only). embeddingBatchSize option on SchemaDefinition/CollectionOptions controls provider call chunk size in embedUnembedded (default 256). DiskStore.appendEmbeddings() writes embedding batches durably to JSONL immediately, bypassing LRU eviction race. embedUnembedded disk path uses two-pass scan (pass 1: build diskSeen hasEmbedding map; pass 2: collect+flush only unembedded records) for idempotency across multiple JSONL files. extractTextFromRecord now excludes _id from embedding text (was causing mismatch between stored embeddings and query embeddings). BM25+RRF hybrid search: TextIndex.searchScored() (k1=1.2, b=0.75, v2 JSON persistence), rrf() fusion utility, searchable:true per-field schema opt-in, Collection.bm25Search(), Collection.hybridSearch(), db_hybrid_search MCP tool. materializeCandidates() private helper unifies disk-aware hydration across bm25Search/semanticSearch/searchByVector; rebuildHnswFromDisk() reconstructs HNSW from Parquet after disk-mode reopen (fixes semantic search in disk mode). searchByVector() is now async. v1→v2 BM25 lazy upgrade: searchScored skips v1 placeholder docs (empty tfMap), each add() upgrades that doc in place. hybridSearch per-arm try/catch: runtime failure in one arm degrades gracefully to the other arm instead of rejecting the whole call. BM25 k1/b tunable via schema (bm25:{k1,b} on SchemaDefinition + PersistedSchema; code wins in mergeSchemas, overlay wins in mergePersistedSchemas; validated in validatePersistedSchema). Filter type unified: bm25Search+hybridSearch filter opts now typed as Filter (Record<string,unknown>|string|null|undefined) matching semanticSearch/searchByVector. Over-fetch unified to Math.max(limit*4,50) across all vector search paths. db_bm25_search MCP tool added (pure lexical, no embedding provider needed). IndexFileTooLargeError thrown (not silently skipped) when text-index.json exceeds MAX_INDEX_FILE_SIZE (256 MB, ~25-30K docs) on reopen; exported from core; DiskStore.MAX_INDEX_FILE_SIZE now public static for test overrides. Unicode-aware tokenizer: tokenize() uses [\p{L}\p{M}\p{N}]+/gu + length>0 filter — CJK (東京), accented Latin (café), emoji excluded. TextIndex.estimatedBytes() registered with MemoryMonitor via trackMemory; Collection.stats()+AgentDB.stats()+db_stats all expose textIndexBytes. Bench expanded: 7 new BENCH=1-gated scenarios (1M memory cliff, imbalanced RRF, concurrent query/write, update/delete throughput, Ollama real-embedder [OLLAMA_EMBED=1], S3 bm25Search latency [S3_BENCH=1]). Persisted schemas with agent context (description, instructions, field descriptions), schema merge logic (mergeSchemas + mergePersistedSchemas), version tracking, admin-guarded modifications. Schema lifecycle tools: db_get_schema/db_set_schema/db_delete_schema/db_diff_schema/db_infer_schema/db_migrate. db_migrate uses two-phase snapshot for pagination correctness; ops capped at 100; PROTECTED set blocks prototype-pollution keys. db_infer_schema uses Algorithm R reservoir sampling streamed via Collection.iterate() (O(N) time, O(sampleSize) memory). Portable JSON import/export. db_set_schema uses per-property overlay merge preserving untouched field properties. Schema bootstrap: schemas/*.json auto-loaded on init via loadSchemasFromFiles (overlay semantics, per-file isolation, filename-derived name fallback, 10MB size cap, name-mismatch warning). CLI --schemas <glob> flag loads additional schema files after auto-discover (supports *, ?, multiple flags). startHttp/startStdio accept schemaPaths option. startHttp return includes db instance. $strLen filter operator added. _agent audit stamp uses authenticated identity (auth wins over self-reported). Disk mode: JSONL for point lookups, Parquet for column scans, short-circuit at limit, sorted reads, lazy index loading. Disk mode works on filesystem + S3. 40 tools (38 core + db_subscribe/db_unsubscribe on HTTP). Auth + security hardened.

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
agentdb/tools    — framework-agnostic tool definitions (getTools → 38 tools)
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
  disk-store.ts         # Disk-backed storage: Parquet + LRU cache + persistent indexes; entries() async iterator
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
  tools/                # Tool definitions split into per-domain modules (getTools aggregator → 38 core, 40 with HTTP)
    index.ts            # Aggregator: getTools(db, opts?) composes all domains in canonical order
    shared.ts           # AgentTool type, makeSafe() wrapper (auth identity unification), READ/WRITE/DESTRUCTIVE annotations, shared zod params
    admin.ts            # db_collections, db_create, db_drop, db_purge, db_stats (5 tools)
    crud.ts             # db_insert, db_find, db_find_one, db_update, db_upsert, db_delete, db_batch, db_count, db_undo, db_history, db_distinct (11 tools)
    schema.ts           # db_schema, db_get_schema, db_set_schema, db_delete_schema, db_diff_schema, db_infer_schema (6 tools)
    migrate.ts          # db_migrate — two-phase snapshot, deletion-as-failed, ops cap, prototype-pollution guards (1 tool)
    archive.ts          # db_archive, db_archive_list, db_archive_load (3 tools)
    vector.ts           # db_semantic_search, db_embed, db_vector_upsert, db_vector_search, db_bm25_search, db_hybrid_search (6 tools)
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
