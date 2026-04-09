# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com),
and this project adheres to [Semantic Versioning](https://semver.org).

## [0.1.0] - 2026-04-09

### Performance
- **Group commit** — `writeMode: "group"` buffers writes, ~12x faster. CLI: `--group-commit`. Env: `AGENTDB_WRITE_MODE=group`. Auto-disabled for multi-writer (agentId).
- **Async write mode** — `writeMode: "async"` resolves writes immediately, ~50x faster. Data lost on crash. CLI: `--write-mode async`. Env: `AGENTDB_WRITE_MODE=async`. Requires opslog v0.5.1.
- **Sorted-array index** — replaced B-tree tree structure with flat sorted array + binary search. Same O(log n) lookups, simpler code, no unbounded leaf growth. `find()` and `count()` use indexes for equality filters.
- **Composite indexes** — `createCompositeIndex(["status", "priority"])` for compound lookups in a single O(log n) scan. Supports equality on leading fields + range on trailing field. Maintained through all mutations.
- **Indexed range queries** — `$gt`, `$gte`, `$lt`, `$lte` operators now use sorted-array index when an index exists on the filtered field. Combined bounds (e.g., `{ $gte: 10, $lte: 90 }`) also use the index. Expected 5-10x speedup on range filters.
- **Count-from-index fast path** — `count()` with a single indexed equality/range field on TTL-free collections returns the index size directly, bypassing per-record fetch and predicate evaluation. O(1) for equality, O(log n) for range.
- **Predicate compilation cache** — compiled filter predicates cached in a 64-entry LRU keyed by JSON-serialized filter. Repeated queries with the same filter skip re-parsing and re-compilation.
- **Incremental index rebuild** — `tail()`, `watch()`, `undo()`, `archive()` now re-index only affected records instead of full rebuild. Text index tokenization skipped for unaffected records. Full rebuild kept for `refresh()` and `batch()` (unknown scope).
- **Direct _id fast path** — `update({ _id: key }, ...)` and `remove({ _id: key })` now short-circuit to O(1) Map lookup instead of linear scan. Eliminates the YCSB-A run-phase bottleneck where 10K-record scans dominated write latency.
- **Partial sort** — `find()` with sort + small limit uses O(n log k) selection instead of O(n log n) full sort when result set >> limit.
- **stripMeta dedup** — `updateBTreeIndexes()` strips meta once per old/new record, reused across all indexes (was per-index).
- **search() early exit** — `search()` skips offset records and stops after limit instead of materializing all matches.
- **getNestedValue fast path** — simple (non-dot) field names skip `path.split(".")` allocation.
- **compare() cache** — `String()` conversions cached in B-tree comparator (was called 2x per value).
- **findAll() single-pass** — replaced `.all().filter().map()` triple-allocation chain with single loop.
- **Cleanup B-tree fix** — `cleanup()` now removes expired records from B-tree indexes (was previously missed).
- **Eliminate double stripMeta** — filter predicates run on raw records (meta fields don't interfere). stripMeta only for output. Removes N object allocations per query.
- **Epoch TTL** — `_expires` stored as epoch ms instead of ISO string. Avoids Date parsing in hot path.
- **estimateTokens without JSON.stringify** — recursive char counting heuristic, no serialization overhead.
- **Remove double batch write on delete** — agent-tagged deletes no longer write a tagged version before deleting.
- **HNSW MaxHeap** — search queue uses binary MaxHeap (O(log n) extract) instead of sorted array + shift (O(n log n + n)). Candidates use binary insert. Preserves >70% recall quality.

### Added
- **Explicit vector API** — `insertVector(id, vector, metadata?)` stores pre-computed vectors without an embedding provider. `searchByVector(vector, opts?)` searches by raw vector with filter/limit support. HNSW auto-initializes from stored vectors on collection open.
- **`db_vector_upsert` tool** — store a vector with metadata via MCP.
- **`db_vector_search` tool** — search by raw vector via MCP.
- **Ollama embedding provider** — local embeddings via Ollama API (`nomic-embed-text`). No API key required.
- **Voyage AI embedding provider** — `voyage-3-lite` model. Batch API.
- **Cohere embedding provider** — `embed-english-v3.0` with `input_type` support.
- **CLI `--embeddings` flag** — configure embedding provider from CLI (e.g. `--embeddings ollama`, `--embeddings openai:text-embedding-3-small`). Env: `AGENTDB_EMBEDDINGS`.
- **Sort on find** — `sort: "name"` (ascending) or `sort: "-score"` (descending). Supports dot notation for nested fields.
- **Max query limit** — `find()` enforces max 10,000 records per query to prevent memory exhaustion.
- **Error sanitization** — filesystem paths stripped from error messages returned to clients.

### Improved (MCP tool quality — backlog patterns adopted)
- Every tool has `title` for human-readable display names
- Every tool has `outputSchema` — typed zod response schemas for structured output
- All 4 MCP annotation hints on every tool: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`
- Responses include `structuredContent` (typed object) alongside text fallback
- Enriched descriptions: explain behavior, cross-reference related tools, document constraints
- Standard annotation constants: `READ`, `WRITE`, `WRITE_IDEMPOTENT`, `DESTRUCTIVE`
- Permission enforcement automatic via `makeSafe()` — derives level from annotations
- `API_NOTE` appended to all descriptions

### Fixed (from security + architecture review)
- **CRITICAL**: Permission enforcement wired into all 24 tool handlers (was configured but never checked)
- **CRITICAL**: Agent identity now from auth token, not self-reported request body
- **CRITICAL**: Constructor no longer drops `backend` and `agentId` options (S3 + multi-writer were silently broken)
- **CRITICAL**: `db_batch` description fixed — updates are not atomic with inserts/deletes
- **HIGH**: Collection names validated — path traversal (`../`) rejected
- **HIGH**: Bearer token uses `crypto.timingSafeEqual` (prevents timing attacks)
- **HIGH**: `$regex` operator rejects nested quantifiers and patterns >200 chars (prevents ReDoS)
- **HIGH**: HTTP transport enforces max 100 sessions + 30-minute idle timeout
- **MEDIUM**: `distinct()` and `schema()` now filter expired records
- **MEDIUM**: `$in`/`$nin` operators use `Set` for O(1) primitive lookups
- **MEDIUM**: `trackMemory` uses lightweight estimate instead of full collection scan
- **MEDIUM**: `getNestedValue` deduplicated (shared between filter.ts and collection.ts)
- **MEDIUM**: Version string centralized from package.json
- **MEDIUM**: `purgeCollection` uses prefix match instead of fuzzy `includes()`
- **MEDIUM**: `PermissionManager` denies undefined agent when rules are configured
- `authContext`/`getCurrentAuth` moved to `src/auth-context.ts` — breaks reverse dependency from tools→mcp
- `S3Backend` now lazy-loaded via `loadS3Backend()` — `@backloghq/opslog-s3` is optional
- `db_batch` deletes now truly atomic via `deleteById()` (was queuing behind serialize lock)
- `dropCollection` cleans up event listeners and memory monitor entries (was leaking)
- `db_delete` accepts compact string filters (aligned with `db_update`/`db_archive`)
- Prototype pollution blocked — `__proto__`, `constructor`, `prototype` added to `PROTECTED_FIELDS`
- Permission hierarchy — `admin` implies `write`, `write` implies `read`
- `$regex` ReDoS check applied to `RegExp` objects (was string-only)
- Multi-token auth uses `timingSafeEqual` iteration (was plain property lookup)
- `$regex` ReDoS denylist catches alternation patterns like `(a|a)*`
- HSTS header added to HTTP transport
- Rate limiter periodically cleans up expired entries
- Signal handlers use `process.once` (no stacking on repeated calls)
- `removeById()` guard uses `.has()` instead of `!== undefined`
- `AgentDB.close()` now cleans up listeners and memory monitor (was leaking like `dropCollection` before fix)
- MCP servers properly disconnected on session cleanup (was only closing transport)
- Archive segment names validated against strict regex (prevents path traversal)
- `incrementalIndexUpdate` strips meta once per record (was per-index)
- `rebuildBTreeIndexes` single-pass all indexes (was one store iteration per index)
- AuditLogger uses O(1) ring buffer (was O(n) `shift()` at 10K entries)
- Agent identity redacted from permission error messages
- Security headers added: `X-Content-Type-Options`, `Cache-Control`, `X-Frame-Options`
- Dynamic port allocation in auth tests (prevents EADDRINUSE)
- `startHttp` returns actual port number for test use

### Security
- Bearer token authentication — `--auth-token` / `AGENTDB_AUTH_TOKEN` for HTTP transport
- Multi-agent token map — different tokens for different agent identities + permissions
- JWT validation via `jose` library — JWKS endpoints, shared secrets, audience/issuer validation
- Pluggable auth middleware — `authFn` interface for custom OAuth/SAML/etc.
- Rate limiting — per-agent token bucket, configurable max/window
- CORS lockdown — configurable allowed origins, default reject cross-origin
- Request size limits via `express.json({ limit })`
- Audit logging — agent identity, method, tool, timestamp per request
- `/health` endpoint bypasses auth for monitoring
- Error handler strips stack traces

### Infrastructure
- Dockerfile (Node 25 Alpine) for containerized deployment

### Added

**Core library:**
- `AgentDB` class with collection manager: lazy loading, LRU eviction, configurable limits
- `Collection` class: insert, insertMany, findOne, find, count, update, upsert, remove
- Update operators: `$set`, `$unset`, `$inc`, `$push`
- Generic JSON filter compiler (`compileFilter`) with 14 operators
- Compact string filter parser (`parseCompactFilter`) with 20+ modifier aliases
- Filter accepts `string | object` across all query methods
- Agent identity on mutations (`agent` + `reason`, visible in history, stripped from reads)
- Optimistic locking (`_version` tracking, `expectedVersion` on mutations)
- Progressive disclosure (summary mode on find)
- Pagination (limit/offset with truncated flag and total count)
- Token budget on find queries (`maxTokens` param, 4 chars/token heuristic)
- TTL / automatic expiry (`ttl` on insert, expired records excluded, `cleanup()`)
- Per-collection undo, history, getOps
- Discovery: `schema()`, `distinct()`, `stats()`
- Collection soft-delete (`dropCollection`) and permanent purge
- Export / import for backup and restore (`db_export`, `db_import`)
- Archive tools (`db_archive`, `db_archive_list`, `db_archive_load`)

**Collection middleware:**
- `validate` hook — reject bad data before it hits opslog
- `computed` fields — calculated on read, not stored
- `virtualFilters` — domain-specific query predicates (`+OVERDUE`, `+BLOCKED`, etc.)

**Indexes:**
- Full-text search via inverted index (`textSearch: true`, `Collection.search()`)
- HNSW index for semantic nearest-neighbor search (pure TypeScript)
- B-tree index for attribute matching (`createIndex`, `dropIndex`, `listIndexes`)
- Bloom filter for probabilistic existence checks (`createBloomFilter`, `mightHave`)
- Query frequency tracker for index suggestions (`suggestIndexes`)

**Semantic search:**
- Embedding provider abstraction (OpenAI, HTTP, custom)
- Int8 quantization (4x smaller than float32)
- `Collection.semanticSearch()` with lazy embedding and hybrid queries
- Auto re-embed when text fields change on update

**Multi-agent:**
- Per-agent permissions (read/write/admin enforcement)
- Change notifications (event emitter on Collection)
- Optimistic locking with conflict detection
- WAL tailing (`tail()`, `watch()`, `unwatch()`) for live cross-process updates

**Named views:**
- Define views via filter expressions with cached results
- Automatic invalidation on mutation

**Memory monitoring:**
- `MemoryMonitor` with per-collection budgets wired into AgentDB

**Tools (24 total):**
- CRUD: db_insert, db_find, db_find_one, db_update, db_upsert, db_delete, db_count, db_batch
- Collections: db_collections, db_create, db_drop, db_purge
- History: db_undo, db_history
- Discovery: db_schema, db_distinct, db_stats
- Archive: db_archive, db_archive_list, db_archive_load
- Semantic: db_semantic_search, db_embed
- Backup: db_export, db_import

**MCP adapter:**
- stdio transport (single client)
- HTTP/Streamable transport (multiple concurrent clients, session management)
- CLI: `npx agentdb --path ./data [--http] [--port 3000]`

**S3 backend:**
- CLI flags: `--backend s3 --bucket <name> --region <region> [--prefix <path>]`
- Environment variables: `AGENTDB_BACKEND`, `AGENTDB_S3_BUCKET`, `AWS_REGION`
- Library: `import { S3Backend } from "agentdb"` + pass to `AgentDB` constructor
- Dynamic import — AWS SDK only loaded when S3 configured

**Storage engine (opslog v0.4.0):**
- Pluggable StorageBackend interface (FsBackend default, S3Backend optional)
- Multi-writer with per-agent WAL streams and Lamport clocks
- WAL tailing for live cross-process updates
- Delta encoding (automatic, JSON diffs when smaller than full prev)
- Async mutation serializer, ftruncate undo, advisory directory lock, readOnly mode

**Testing:**
- 468 tests across 15 test files
- 25 e2e tests (MCP server over JSON-RPC, 21 of 24 tools tested)
- 15 performance benchmarks
- 94.5% line coverage
