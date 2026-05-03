# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com),
and this project adheres to [Semantic Versioning](https://semver.org).

## [Unreleased]

### Added
- **`Collection.materializeCandidates()`** — private helper factoring the fetch→filter→compute→summarize loop shared by `bm25Search`, `semanticSearch`, and `searchByVector`; disk-mode aware (parallel `Promise.all` via `_diskStore`) vs in-memory path.
- **HNSW rebuild from disk on reopen** — `Collection.rebuildHnswFromDisk()` reconstructs the HNSW index from `_diskStore` entries after a disk-mode open (where `skipLoad=true` prevents the WAL-based HNSW rebuild); called by `AgentDB._openCollection` after `setDiskStore`.
- **Disk-mode hybrid search test** — `tests/hybrid-search.test.ts` extended with a close/reopen disk-mode test asserting both semantic-arm-only and BM25-arm-only docs appear in `hybridSearch` results after reopen.
- **BM25 tuning via schema** — `bm25?: { k1?: number; b?: number }` added to `SchemaDefinition`, `PersistedSchema`, and `CollectionOptions` (`bm25K1`/`bm25B`); `Collection` constructor passes these to `new TextIndex({ k1, b })`; `extractPersistedSchema`, `mergeSchemas` (code wins), `mergePersistedSchemas` (overlay wins), and `validatePersistedSchema` all handle the new field.

### Fixed
- **`_id`/`_version` leaked into BM25 index in fallback mode** — `Collection.textRecord` fallback (no `searchableFields`) returned the full `stripMeta` record, which still contains `_id` and `_version`; now explicitly excludes those keys so UUID tokens and version numbers are never indexed.
- **Semantic search broken in disk mode** — `semanticSearch` and `searchByVector` used `this.store.get(id)` (memory-only opslog store), missing records in Parquet/JSONL; fixed via `materializeCandidates` which checks `_diskStore` first.
- **Sequential disk hydration in BM25 search** — `bm25Search` was awaiting each `_diskStore.get(id)` serially; replaced with parallel `Promise.all` via `materializeCandidates`.
- **`searchByVector` now async** — was synchronous, preventing disk hydration; return type changed to `Promise<{ records, scores }>`.
- **v1→v2 BM25 mixed-corpus ghost results** — `searchScored` was returning v1 docs with score=0, tie-broken by id (silently wrong rank order); v1 placeholder docs (empty tfMap, no TF data) are now skipped. A v1-only corpus returns `[]` from `searchScored`; mixed corpora return only v2-indexed docs. AND-search (`search()`) is unaffected. Each `add()` call upgrades that doc in place.
- **`hybridSearch` per-arm error isolation** — a runtime failure in one arm (e.g. embedding provider throws) no longer rejects the entire call; the failing arm is treated as empty and the other arm's results are returned via RRF as usual.

## [1.4.0] - 2026-05-02

### Added
- **BM25 scoring on `TextIndex`** — `searchScored(query, opts?)` returns OR-semantics BM25-ranked results; `k1`/`b` configurable via constructor; `toJSON` bumped to v2 (per-doc TF map + length); `fromJSON` accepts v1 (lazy upgrade) and v2.
- **RRF fusion utility** — `rrf(lists, opts?)` in `src/rrf.ts`, exported from the core library; fuses N ranked lists via Reciprocal Rank Fusion (Cormack et al. 2009); `k` configurable (default 60); deduplicates within a list using first-occurrence rank.
- **Schema-declared BM25 fields** — `searchable?: boolean` on `FieldDef` and `PersistedFieldDef`; Collection projects records to marked fields before text indexing; zero-flag fallback preserves full-record indexing for backwards compat; `Collection.searchableFields()` getter for introspection; non-string/string[] fields with `searchable:true` warn and are ignored.
- **`Collection.bm25Search()`** — BM25-ranked full-text search at the Collection layer; supports optional attribute filter, summary projection, and `candidateLimit` overscan; returns `{ records, scores }` aligned by index.
- **`Collection.hybridSearch()`** — fuses BM25 + semantic arms via RRF; both arms run in parallel; degrades to single-arm when embedding provider or text index is absent; throws only when both are unavailable; `k`, `candidateLimit`, `filter`, `summary` all forwarded to arms.
- **`db_hybrid_search` MCP tool** — exposes `hybridSearch` via the tool layer; 37 core tools (39 with HTTP subscriptions).
- **BM25 disk persistence tests** — `tests/text-index-persistence.test.ts` verifies that BM25 corpus stats (TF maps, per-doc lengths, avgdl) survive close/reopen via TextIndex v2 JSON; also covers v1→v2 upgrade path (posting-list-only index loads, AND search works, BM25 scores are ≥0).
- **BM25 math tests** — `tests/text-index.test.ts` extended with 8 hand-calculated cases: exact single-term score, multi-term sum, two-doc corpus scores, IDF rare-vs-common contrast, b=1 length normalization penalty, k1 TF-saturation slope, avgdl accuracy, and v1-upgrade NaN guard.
- **RRF correctness tests** — `tests/rrf.test.ts` extended with a >2-list partial-overlap case: 3 lists, 4 unique ids with partial membership, hand-calculated scores and expected rank order verified.
- **Hybrid search integration tests** — new `tests/hybrid-search.test.ts` (11 tests): combined BM25+semantic ranking, filter respected across both arms, disk-mode BM25 persistence through close/reopen, degraded-BM25-only mode (no embedding provider), degraded-vector-only mode (no text index), both-unavailable error, and `db_hybrid_search` tool round-trip. Also covers 3 `Collection.bm25Search` scenarios: filter pruning, candidateLimit overscan, and summary projection.
- **BM25 + hybrid search benchmarks** — new `tests/bench-bm25.test.ts` (8 scenarios, gated behind `BENCH=1`): indexing throughput at 10K/100K docs, query latency p50/p95/p99 at 100K corpus (1/2/5-term), disk-mode cold-start for v2 and v1-upgrade indexes, hybrid vs BM25-only relative latency, RRF fusion overhead at 1K/10K list sizes, schema-projected vs all-strings indexing speed.

### Fixed
- **`TextIndex.searchScored` NaN scores on v1 indexes** — when `totalLen` is 0 (v1 upgrade, no length data), `avgdl` is now forced to 1 instead of dividing by N, preventing `dl/avgdl = 0/0 = NaN` in the BM25 norm term.

## [1.3.1] - 2026-04-19

### Added

#### Per-process tenant binding (MCP)
- **`AGENTDB_TENANT_ID` env / `--tenant-id` CLI flag** — binds the process to a single tenant. Validated at startup (non-empty, no edge whitespace, ≤256 chars); misconfiguration crashes so orchestrators surface it as a provisioning failure.
- **`JwtAuthOptions.tenantIdClaim` (default `"tid"`) + `expectedTenantId`** — JWTs whose tenant claim does not match are rejected. Verified *before* permissions extraction; case-exact byte comparison; non-string claim values rejected (no coercion).
- **`TokenMap` entries may declare `tenantId`** — missing `tenantId` fails closed when `expectedTenantId` is set. The singular `--auth-token` is implicitly bound to the process tenant.
- **`TenantMismatchError`** — JWT path signals binding failures distinctly from generic auth failures (bad signature, aud, iss, expired).
- **`tenant_mismatch` audit security event** — emitted on binding failures so operators can alert on cross-tenant credential exposure separately from log-spam auth failures. Audit entries record `tenantId` on every authenticated request.
- HTTP error responses never echo the expected tenant ID (generic 401) to avoid fingerprinting the pod's tenant from the outside.
- `/health` stays unauthenticated and unaffected.
- Fully backwards-compatible: all options are opt-in.

#### Audit streaming endpoint (MCP)
- **`GET /audit?cursor={id}&limit={n}`** — paginated, cursor-based JSON endpoint so a control-plane shipper can drain audit entries off the pod without shelling into the container or mounting the data volume.
- **Opaque monotonic cursor** — lex-sortable zero-padded sequence. Pagination is `entry.id > cursor`; cursor-ascending order across and within pages.
- **Default limit 1000, hard cap 10000** — oversize requests are silently capped and return a `nextCursor` for re-polling. Empty stream returns `{entries: [], nextCursor: null}` (not 204).
- **Same auth surface as `/mcp`** — bearer token, `authFn`, or `tokens` map.
- **Bound-tenant filter** — when `AGENTDB_TENANT_ID` is set, only entries whose `tenantId` matches are returned (defence-in-depth on top of per-process binding).
- **Additive `event` field on audit entries** — `tenant_mismatch` security events are surfaced so operators can alert on cross-tenant exposure separately from request-level entries.
- **`AUDIT_DEFAULT_LIMIT` / `AUDIT_MAX_LIMIT`** — exported named constants so the shipper can size requests against the documented contract.
- **`AuditLogger.query({cursor, limit, tenantFilter})`** — returns `{entries, nextCursor}` page. `log()` now returns the assigned entry so callers can correlate. `metadata` is captured for `tools/call` invocations (tool params). Existing `recent()` API unchanged.

### Fixed

- **Docs** — replace `npx agentdb` with `npx @backloghq/agentdb` across README, DEPLOYMENT, CLI `--help`, and CLAUDE.md. The bare `agentdb` name resolves to an unrelated package on npm; the scoped name is required.

## [1.3.0] - 2026-04-18

### Added

#### Persisted schemas
- **Persisted schemas** — schemas stored as `{dbPath}/meta/{collection}.schema.json`. Auto-persisted on first `defineSchema()` open, survives restart.
- **Agent context on schemas** — `description`, `instructions` on collections, `description` on fields. Any agent can discover how to use a collection via `db_get_schema`.
- **Schema version tracking** — `version` field on schemas, warnings on mismatch between code-level and persisted schemas.
- **`PersistedSchema` / `PersistedFieldDef` interfaces** — JSON-serializable schema subset (no functions, RegExp, or non-static defaults).
- **`extractPersistedSchema()`** — extract serializable parts from a `SchemaDefinition`.
- **`validatePersistedSchema()`** — validate schema structure loaded from JSON.
- **`mergeSchemas()`** — merge code-level and persisted schemas with clear precedence rules. Persisted wins for agent context, code wins for runtime config, indexes unioned.
- **`mergePersistedSchemas(base, overlay)`** — merge two `PersistedSchema` objects with overlay semantics. Overlay wins per-property (not per-field), so updating one field property (e.g. `type`) preserves untouched properties (e.g. `description`, `required`). Indexes are unioned. Exported from main package.
- **`loadSchemaFromJSON()` / `exportSchemaToJSON()`** — portable JSON import/export for schema definitions.
- **Admin-guarded schema modifications** — `persistSchema` and `deletePersistedSchema` require admin permission when called with agent identity.
- **`AgentDB.persistSchema()` / `loadPersistedSchema()` / `deletePersistedSchema()`** — programmatic schema persistence API.
- **`AgentDB.getSchema()`** — access in-memory compiled schema for a collection.
- **`AgentDB.getCollectionNames()`** — lightweight getter returning active collection names without opening any collections. Used by `db_diff_schema` to detect non-existent collections without creating them as a side effect.
- **`CollectionSchema.definition`** — retains original `SchemaDefinition` for persistence extraction.

#### Schema bootstrap (drop-in JSON files)
- **Schema bootstrap auto-discover** — `db.init()` now scans `<dataDir>/schemas/*.json` on startup. Valid files are loaded as persisted schemas (file acts as overlay via `mergePersistedSchemas`). Missing directory is silently ignored; bad files are logged and skipped without aborting init.
- **`AgentDB.loadSchemasFromFiles(paths)`** — load a list of JSON schema files into persisted storage. Per-file isolation, filename-derived name fallback, file-as-overlay precedence. Returns `{ loaded, skipped, failed }`. Exported as `SchemaLoadResult` type.
- **`SchemaLoadResult` type** exported from main package.
- **`--schemas <glob>` CLI flag** — load schema JSON files at startup. Multiple `--schemas` flags allowed (results unioned). Supports `*`/`?` glob wildcards. Per-file failures do not abort startup. Overlays on top of auto-discovered `schemas/` files. Works with both `stdio` and `--http` transports.
- **`schemaPaths` option on `startHttp`/`startStdio`** — programmatic equivalent of `--schemas`. `startHttp` now returns `db` in its result object.
- **`--help` / `-h` CLI flag** — prints usage and all flags to stdout, exits 0.
- **`loadSchemasFromFiles` name-mismatch warning** — emits `console.warn` when a file's explicit `name` field differs from the filename-derived name. The file's `name` still wins (overlay semantics); the warning is informational.
- **`loadSchemasFromFiles` `skipped` semantics** — files are now counted as `skipped` (not `loaded`) when the merged schema is structurally identical to the existing persisted schema. Uses key-sorted JSON for the comparison to avoid false mismatches from key-ordering differences.
- **E2E subprocess test for `--schemas` argv** — spawns `dist/mcp/cli.js` with `--schemas <path>` and verifies schema is persisted and queryable via `db_get_schema` MCP tool call. Also covers multiple `--schemas` flags.

#### Schema tools (agent UX)
- **`db_get_schema` tool** — read-only tool returns full persisted schema with context, instructions, fields, and indexes.
- **`db_set_schema` tool** — admin-only tool to create or update persisted schema with partial merge support.
- **`db_delete_schema` tool** — admin-only tool to delete the persisted schema for a collection. Idempotent (no-op if none exists). Returns `{ deleted: boolean }`.
- **`db_diff_schema` tool** — read-only tool that previews what `db_set_schema` would change before committing. Uses `mergePersistedSchemas` internally (same semantics as `db_set_schema`), so partial candidates correctly show no-change for omitted fields. Returns `{ added, removed, changed, warnings, impact? }` with declared `outputSchema`. `warnings` covers type changes (high), removed enum values (high), new required fields (medium), tightened constraints (medium), removed fields (medium), and removed description/instructions (low). `includeImpact: true` (default) queries the collection for affected record counts embedded in warnings and an `impact` summary; `maxLength`/`min`/`max` impact scans use `col.count()` with `$strLen`/`$gt`/`$lt` pushdown filters.
- **`db_migrate` tool** — declarative bulk record update via 5 ordered ops: `set`, `unset`, `rename`, `default`, `copy`. Per-record atomicity; validation fires normally; schema-violating records land in `errors[]`. `dryRun: true` returns counts without writing. `batchSize` (default 100) bounds memory. Agent/reason stamped on each written record; `_version` optimistic locking honored. Protected meta-fields (`_id`, `_version`, `_agent`, `_reason`, `_expires`, `_embedding`) silently skipped. Matching records are snapshotted by ID at migration start — all matches processed even if ops cause records to leave the filter mid-run; snapshot versions used for optimistic locking so concurrent writes to the same record fail into `errors[]`. Records deleted between snapshot and processing also land in `errors[]` with `"record deleted before migration"` so the invariant `scanned == updated + unchanged + failed` always holds.
- **`db_infer_schema` tool** — samples existing records and proposes a `PersistedSchema` (cold-start schema bootstrap). Detects `boolean`, `number`, `string` (with `maxLength`), `date` (ISO prefix heuristic `/^\d{4}-\d{2}-\d{2}(T|Z|$)/` to avoid space-separator false positives), `enum` (distinct count ≤ `enumThreshold`), `string[]`, `number[]`, `object`. Marks fields `required` when presence fraction ≥ `requiredThreshold` (default 0.95). Mixed-type fields are skipped with a note. Uses Vitter's Algorithm R reservoir sampling for uniform random selection when `totalRecords > sampleSize`. Emits a note when the collection already has a persisted schema, pointing to `db_diff_schema` and `db_set_schema`. Output `proposed` schema passes `validatePersistedSchema` and can be forwarded directly to `db_set_schema`. READ permission, no mutation.
- **Enhanced `db_collections` tool** — now includes schema summary (description, field count, has instructions, version) per collection.

#### Filter operators
- **`$strLen` operator** — compares the character length of a string field. Accepts a number (exact match) or operator object (`{ $gt: N }`, `{ $gte: N, $lte: M }`, etc.). Non-string values return false. Used internally by `db_diff_schema` for `maxLength` impact scans. Also available in compact-filter syntax: `field.strLen:N` (exact) and `field.strLen.op:N` (e.g. `title.strLen.gt:10`). Performance characteristic: latency is comparable to manual `find()` + JS-side filtering in both in-memory and disk-backed mode (benchmarked: ~0.8ms for 10K records in-memory, ~58ms for 100K records from Parquet); the primary benefit is ergonomics (inline pushdown syntax) rather than a throughput advantage.

### Fixed
- **`db_set_schema` field-property preservation** — partial schema updates no longer drop untouched field properties. Previously `{ title: { type: "string" } }` overwrote the entire field, losing `required`, `description`, etc. Now uses `mergePersistedSchemas()` with per-property overlay semantics.
- **Schema cleanup on drop/purge** — `dropCollection()` now deletes the persisted schema file; `purgeCollection()` defensively removes it too.
- **`db_migrate` pagination correctness** — original offset-based pagination silently dropped records when migrations changed a filter-matched field. Replaced with two-phase snapshot approach (collect IDs first, then process by `$in` with snapshot versions for optimistic locking) so all matching records at migration start are processed.
- **`db_infer_schema` O(N²) → O(N)** — original offset-based pagination scaled quadratically (446ms at 50K records, ~40s extrapolated at 1M). Root cause: `find()` with offset scans all matching records before slicing. Replaced with single-pass `col.iterate()` async generator + Algorithm R reservoir sampling. Disk-mode memory stays O(`sampleSize`) by streaming from `DiskStore.entries()` rather than loading the full collection.
- **`db_migrate` ops cap** — `ops` array now limited to 100 elements (Zod schema + runtime guard); exceeding the limit returns a validation error. Prevents CPU exhaustion from oversized op lists.
- **`db_migrate` prototype-pollution guard** — `__proto__`, `constructor`, and `prototype` added to PROTECTED set; ops targeting these fields are silently skipped, preventing in-memory prototype-chain corruption during `applyOps`.
- **`loadSchemasFromFiles` 10MB size cap** — files larger than 10MB are skipped before `readFile` (logged warning + `failed[]` entry with `"file size exceeds 10MB limit"`). Prevents accidental OOM from oversized schema files.
- **Unified `_agent` audit stamp** — `makeSafe()` now stamps the authenticated identity (from auth context) on records, instead of self-reported `args.agent`. Previously HTTP-authenticated agents could record any string in `_agent` even though the permission gate used the real auth identity. Behavior: auth identity always wins; library/no-auth callers retain `args.agent` unchanged.
- **`persistSchema` concurrent-write race** — tmp file name now includes pid + timestamp + random suffix to guarantee uniqueness per write. Rename is wrapped in try/catch: on failure, tmp is cleaned up with `rm({ force: true })`. Previously, concurrent writes on the same collection could share a `.tmp` filename when `Date.now()` collided within the same millisecond, causing silent content corruption and ENOENT on the loser's rename. Negative-path test verifies the cleanup fires on rename failure.
- **Path sanitization regex in error messages** — changed `/\/[^\s'":]+\//g` to `/\/[^\s'":]+/g` (drop trailing-slash requirement). The old regex only stripped path prefixes with a trailing slash, leaving terminal filenames (e.g. `tickets.schema.json`) visible in tool error messages — exposing collection names. The new regex strips the full path including the filename.
- **Orphaned `meta/*.tmp` cleanup on init** — `AgentDB.init()` scans `meta/` for `*.tmp` files after creating the directory and removes them with `rm({force:true})`. Prevents accumulation of tmp files left by hard crashes between `writeFile` and `rename` in `persistSchema` or `writeMeta`.
- **`writeMeta()` unique tmp filename** — changed static `manifest.json.tmp` to `pid+timestamp+random.tmp` (same pattern as `persistSchema` from the second-pass fix). Prevents concurrent writers in multi-process deployments (shared data directory) from clobbering each other's in-flight writes. Rename failure cleans up tmp and re-throws.

### Internal
- **`src/tools/index.ts` split into per-domain modules** — `shared.ts` (types, `makeSafe`, `getAgent`, shared schemas/annotations), `admin.ts`, `crud.ts`, `schema.ts`, `migrate.ts`, `archive.ts`, `vector.ts`, `blob.ts`, `backup.ts`. `index.ts` is now a pure aggregator. Public API (`getTools`, `AgentTool`, `ToolResult`) unchanged. Canonical tool order locked via snapshot test: admin → crud → schema → migrate → archive → vector → blob → backup.
- **`tests/tools.test.ts` and `tests/schema.test.ts` split** — test files mirror the source split: `tests/tools/{admin,crud,schema,migrate,archive,vector,blob,backup}.test.ts` and `tests/schema-lib/{define,persist,merge,validate,bootstrap,json-io}.test.ts`. Pure structural move; same test count (997).
- **`Collection.iterate()`** — new async-iterable method streams records sequentially from in-memory or disk-backed storage without buffering more than one row-group's worth in memory. Used internally by `db_infer_schema`; available for future tools needing memory-bounded full scans.
- **`getAgent(args)` helper** — exported from `src/tools/shared.ts` to DRY the repeated `args.agent as string | undefined` cast across mutation tool handlers.
- **`PersistedSchema` forward-compat policy** — `validatePersistedSchema` is documented as lenient on unknown top-level and field-level properties; `persistSchema` round-trip preserves unknowns. Future agentdb versions can add optional schema fields without breaking older installations reading those files. Verified by unit tests + a round-trip integration test.
- **README: Schema lifecycle for agents** — new section walks through the 6-step workflow (define → persist → discover → diff → migrate → infer) with code examples and library API references for `loadSchemasFromFiles`, `mergePersistedSchemas`, and `mergeSchemas`.
- **README: Authentication — agent identity** — new sub-section documents that over an authenticated HTTP transport, the `agent` parameter is silently overridden with the authenticated identity (3-row behavior matrix).
- **`code-review` example refreshed for v1.3** — `defineSchema` with `description`/`instructions`/per-field descriptions; example README walks through the 3-step lifecycle (define, auto-persist, agent discovery via `db_get_schema`).
- **JSDoc on merge functions** — `mergeSchemas` and `mergePersistedSchemas` now document precedence rules and when to use each.
- **MCP server instructions rewrite** — `createMcpServer` emits a 5-step "Start here" block: `db_collections` → `db_get_schema` → `db_find`/`db_find_one` → mutations → schema lifecycle (`db_set_schema`, `db_diff_schema`, `db_infer_schema`, `db_delete_schema`). Regression tests verify all schema lifecycle tool names appear.
- **Schema terminology disambiguation** — README and CLAUDE.md now clearly distinguish `defineSchema()` (code-level, never serialized), `PersistedSchema` (JSON subset in `meta/`), and `db_schema` (samples records dynamically).
- **README reorder** — "Schema Lifecycle for Agents" section moved to appear immediately before "Tool Definitions" so the lifecycle walkthrough directly precedes the tool reference.
- **`db_distinct` indexing guidance** — tool description now advises adding an index on the target field to avoid a full scan on large collections.
- **`validateCollectionName` dead-code removal** — removed redundant `name.includes("..")` check; `VALID_NAME_RE` already rejects all dots.
- **Bench drift detection fix** — stress bench uses p99 (not p50) for find-latency drift comparison, with a 0.5ms floor. Eliminates false `>2×` alarms on sub-millisecond baselines.

## [1.2.1] - 2026-04-11

### Fixed
- **opslog v0.8.1** — fixes loading pretty-printed legacy JSON snapshots where first line is `{`.

## [1.2.0] - 2026-04-11

### Added
- **`RecordCache`** — LRU cache with Map insertion-order eviction, configurable max size, hit/miss/eviction stats. For disk-backed collections.
- **`ArrayIndex`** — inverted element index for O(1) `$contains` lookups on array fields. `createArrayIndex("tags")` makes `+tag`/`-tag` and `{ tags: { $contains: "bug" } }` queries use O(1) Set lookup instead of O(n) full scan.
- **`defineSchema({ arrayIndexes })` option** — auto-create array indexes on collection open.
- **Persistent B-tree serialization** — `BTreeIndex.toJSON()`/`fromJSON()` for disk persistence. Load indexes on open without full record scan.
- **Persistent text index serialization** — `TextIndex.toJSON()`/`fromJSON()` for disk persistence.
- **Persistent array index serialization** — `ArrayIndex.toJSON()`/`fromJSON()` for disk persistence.
- **`hyparquet` + `hyparquet-writer`** — pure JS Parquet read/write for disk-backed storage.
- **opslog v0.7.1** — `skipLoad`, `streamSnapshot()`, `getWalOps()`, `getManifest()`, JSONL snapshots, streaming snapshot write (fixes V8 string limit at 1M+ records).
- **Disk-backed storage mode** — `storageMode: "disk"` compacts collections to Parquet on close, persists indexes to disk, loads both on next open. Configurable globally or per-collection via `defineSchema({ storageMode })`.
- **`DiskStore`** — disk-backed record storage with LRU cache, offset index, Parquet compaction lifecycle, persistent index save/load.
- **Parquet compaction** — `compactToParquet()` writes records as Parquet files via hyparquet-writer with configurable row groups and extracted columns for skip-scanning.
- **Parquet reader** — `readByIds()` for point lookups batched by row group, `readAllFromParquet()` for full reads, `getParquetMetadata()` for row group stats.
- **`storageMode: "auto"`** — auto-detect disk mode when collection exceeds `diskThreshold` records (default: 10K).
- **`cacheSize` / `rowGroupSize` options** — configurable LRU cache size and Parquet row group size.

### Changed (BREAKING)
- **Async Collection read methods** — `findOne`, `find`, `findAll`, `count`, `search`, `queryView` now return Promises. All callers must `await` them. Enables disk-backed reads without loading all records into memory. `searchByVector` stays synchronous.
- **Disk mode uses `skipLoad`** — records NOT loaded into memory on open. Reads merge DiskStore (Parquet) with Map (session writes). Initial open compacts snapshot to Parquet. Subsequent opens load offset index only.
- **`storageMode: "auto"`** — evaluates record count on open against `diskThreshold` (default 10K). Switches to disk mode when collection exceeds threshold. Per-collection schema `storageMode` overrides global setting.

### Fixed
- **Prototype pollution** — replaced `Object.assign(textIndex, restored)` with `TextIndex.loadFromJSON()` instance method. Prevents crafted index files from polluting prototypes.
- **WAL replay O(n²)** — initial compaction used `findIndex()` per WAL op. Now uses Map for O(1) lookups.
- **Close compacts unconditionally** — `DiskStore.isDirty` flag prevents unnecessary Parquet rewrites on read-only sessions.
- **Stale deleted records** — `cacheDelete()` now removes from offset index, preventing deleted records from resurfacing via Parquet reads.
- **Index file size validation** — index files capped at 256MB to prevent DoS via crafted JSON.
- **Parquet path traversal** — `readCompactionMeta()` rejects `..` and absolute paths in `parquetFile` field.
- **Full scan warning** — `console.warn` emitted when disk-mode find() does unindexed scan on >10K records.
- **DiskStore dirty tracking** — mutations (insert/update/delete) now mark DiskStore dirty via `emitChange()`, ensuring `close()` compacts to Parquet. Previously records were lost after close/reopen in disk mode.
- **Programmatic index cardinality** — `saveIndexes()` computes cardinality from B-tree data for all indexed fields (not just schema `extractColumns`). Fixes cardinality being empty for programmatic indexes on reopen.
- **Bulk mutation regression** — `emitChange()` no longer calls `cacheWrite()` per mutation ID. Uses `markDirty()` once instead. Records are in the opslog Map during the session — cache is only for Parquet reads on reopen. Restores bulk insert throughput.
- **S3 support for disk mode** — all Parquet and DiskStore I/O routed through `StorageBackend` (writeBlob/readBlob/listBlobs/deleteBlob). Disk mode works on both filesystem (FsBackend) and S3 (S3Backend) transparently. Verified with real S3 integration test.
- **Parquet buffer caching** — Parquet file read once on first query, cached as ArrayBuffer for all subsequent reads. Eliminates per-query file I/O. Cleared on compaction.
- **JSONL record store** — compaction writes `records.jsonl` alongside Parquet. Point lookups (`findOne`, `find(limit:N)`) use byte-range reads via `readBlobRange` instead of Parquet row group parsing. O(1) per record on filesystem, single HTTP Range request on S3.
- **Parquet is now a column index** — `_data` column removed from Parquet. Full records live in JSONL only. Parquet stores `_id` + extracted columns for count/column-scan. Reduces storage duplication.
- **find() short-circuit at limit** — disk mode fetches candidates in batches of 2x limit, stops when enough found. `find({ status: "open" }, limit: 10)` with 30K candidates now fetches ~20 records instead of 30K.
- **Sorted JSONL reads** — byte-range reads sorted by offset for sequential I/O locality. Small batches parallel, larger batches sequential.
- **Binary offset index** — record offset index stored as compact binary (48 bytes/entry) instead of JSON (~80 bytes/entry). 3.6x faster load at 1M records (~300ms vs ~1000ms). Supports variable-length IDs and offsets up to 256TB (uint48).
- **Lazy index loading** — B-tree/array/text indexes discovered on open but deserialized on first query. Cold open loads only offset index + metadata, skipping heavy JSON parsing. Concurrent callers serialized via promise lock.
- **Batched-parallel JSONL reads** — byte-range reads in groups of 20, sorted by offset for disk locality.
- **Incremental compaction** — close writes only new records to new JSONL + Parquet files instead of rewriting everything. Auto-merges at 10 files. Multi-session growth is O(K) per close instead of O(N).
- **Hydrate-from-disk** — `update()`, `remove()`, `upsert()` load records from DiskStore into the Map before mutating. Batch hydration via `getMany` for filter-based updates.
- **Opslog checkpoints disabled in disk mode** — prevents quadratic snapshot growth (~29GB WAL debris at 1M records). Persistence is via JSONL + Parquet compaction on close. WAL ops file cleaned up after close.
- **opslog v0.8.0** — `readBlobRange(path, offset, length)` for byte-range reads on StorageBackend.

### Performance
- **Column-only Parquet scan** — `count()` with a simple equality filter on an extracted column reads only that column from Parquet, skipping `_data` deserialization entirely. ~1MB vs ~50MB at 100K records.
- **Skip WAL replay on fresh Parquet** — disk mode open skips WAL replay when no ops exist since last compaction.
- **LRU cache default reduced** — 1K records (from 10K) to enforce tighter memory budgets in disk mode.
- **Compound filter index intersection** — multi-field filters like `{ status: "open", priority: "H" }` now intersect candidate sets from all matching single-field indexes (smallest-first). Previously only used the first matching index.
- **Multi-field `isFullyCoveredByIndex`** — `count()` fast path now works for compound filters when all fields have indexes.
- **Hybrid cardinality-based indexing** — during Parquet compaction, cardinality per extracted column is computed and stored. On reopen, high-cardinality fields (>1000 unique values) skip in-memory B-tree — use column-only Parquet scans instead. Low-cardinality fields (enums, status) keep full in-memory indexes. First session creates all indexes (no cardinality data yet); subsequent sessions use the computed cardinality.

## [1.1.1] - 2026-04-11

### Fixed
- **`insertMany()` schema bypass** — `insertMany()` now applies schema defaults, `beforeInsert`/`afterInsert` hooks, and auto-increment counters. Previously bypassed the schema pipeline, causing missing defaults and IDs when used with `defineSchema()`.

## [1.1.0] - 2026-04-10

### Added
- **`defineSchema()`** — declarative collection definitions. Define fields with types (string, number, boolean, date, enum, arrays, autoIncrement), constraints (required, maxLength, min/max, pattern), defaults, computed fields, virtual filters, lifecycle hooks with collection context, and auto-indexing.
- **`$contains` operator** — filter array fields: `{ tags: { $contains: "bug" } }`.
- **`+tag`/`-tag` in compact filter** — `+bug` matches records where tags contains "bug", `-old` excludes.
- **`$text` in find()** — combine text search with attribute filters: `find({ filter: { $text: "auth", status: "open" } })`. Also works in compact filters as bare words.
- **Auto-increment IDs** — `{ type: "autoIncrement" }` in schema fields assigns sequential integers (1, 2, 3...). Continues from max on reopen.
- **Hook context** — lifecycle hooks receive `{ collection }` for side effects (recurrence, cascading updates).
- **Field resolve** — `{ type: "date", resolve: (v) => myDateParser(v) }` transforms values before validation. For parsing "tomorrow" → ISO date, "42" → number, etc.
- **Configurable tagField** — `tagField: "labels"` in schema changes which field `+tag`/`-tag` queries target. Default: "tags".
- **`upsertMany()`** — atomic bulk create-or-update. Each doc must have `_id`.
- **Blob storage** — `writeBlob(id, name, content)`, `readBlob()`, `listBlobs()`, `deleteBlob()`. Stores files outside the WAL via StorageBackend — works on both filesystem and S3 transparently. Cascade delete: blobs auto-cleaned when records are deleted. For attaching code, images, PDFs to records.
- **MCP blob tools** — `db_blob_write` (base64 content), `db_blob_read`, `db_blob_list`, `db_blob_delete`.

### Fixed
- **Compact filter `tagField` propagation** — `+tag`/`-tag` syntax now correctly uses the schema's `tagField` setting. Previously always queried "tags" regardless of configuration.
- **Blob path traversal** — `blobPath()` now validates both `recordId` and `name` centrally, rejecting `..`, `/`, `\` characters. Previously `readBlob`/`deleteBlob` skipped name validation.
- **Auto-increment counter initialization** — uses `find({ sort: "-field", limit: 1 })` instead of scanning up to 10K records on collection open. O(n log 1) vs O(n).
- **`upsertMany()` schema support** — now applies schema defaults, `beforeInsert`/`afterInsert` hooks. Previously bypassed schema wrapping.
- **Compact filter thread safety** — removed module-level mutable `_tagField` state; `tagField` is now threaded as a parameter through the parser.
- **Schema hook listener accumulation** — schema `afterUpdate`/`afterDelete` hooks merged into a single change listener with memory tracking; properly cleaned up on LRU eviction and close.
- **`resolve()` error handling** — field resolve functions now wrapped in try-catch with clear error messages and `cause` chain; prevents uncaught throws from bypassing validation.
- **Blob path resolution** — Collection now initializes its own FsBackend with the collection directory. Previously blobs were written to CWD instead of inside the collection directory, breaking multi-collection isolation.

## [1.0.0] - 2026-04-10

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

### Changed
- **`readOnly` mode** — `new AgentDB(dir, { readOnly: true })` opens without write locks, rejects mutations. Safe to run alongside a writer process. Used by the live dashboard demo.
- **Zod v4** — upgraded from zod 3.25 to 4.3. `z.record()` calls updated to include key type (`z.record(z.string(), z.unknown())`). `.describe()` still works (backward compat).
- **JSON import** — replaced `createRequire` hack with `import pkg from "../package.json" with { type: "json" }` (Node 20.10+ / TS 6.0).
- **tsconfig** — removed redundant `esModuleInterop` (TS 6.0 default), added `resolveJsonModule`.

### Added
- **5 runnable demos** — multi-agent task board, RAG knowledge base, research pipeline, live dashboard, multi-model code review (Gemini + Ollama).
- **NOTIFY/LISTEN** — real-time change notifications via `db_subscribe(collection)` and `db_unsubscribe(collection)` tools. Subscribers receive MCP logging notifications when records are inserted, updated, or deleted. SubscriptionManager wires Collection change events to per-session MCP servers. Subscriptions cleaned up on session disconnect.
- **Explicit vector API** — `insertVector(id, vector, metadata?)` stores pre-computed vectors without an embedding provider. `searchByVector(vector, opts?)` searches by raw vector with filter/limit support. HNSW auto-initializes from stored vectors on collection open.
- **`db_vector_upsert` tool** — store a vector with metadata via MCP.
- **`db_vector_search` tool** — search by raw vector via MCP.
- **Ollama embedding provider** — local embeddings via Ollama API (`nomic-embed-text`). No API key required.
- **Voyage AI embedding provider** — `voyage-3-lite` model. Batch API.
- **Cohere embedding provider** — `embed-english-v3.0` with `input_type` support.
- **Gemini embedding provider** — `gemini-embedding-001` with configurable output dimensionality. Free tier available.
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
- `loadArchive()` validates segment name (symmetric with `archive()`)
- `open()` merged to single-pass iteration (was two loops over store entries)
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

**Tools:**
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
- CLI: `npx @backloghq/agentdb --path ./data [--http] [--port 3000]`

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
- 15 performance benchmarks
- 94.5% line coverage
