# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com),
and this project adheres to [Semantic Versioning](https://semver.org).

## [Unreleased]

### Added

- **`CollectionOptions.maxFindLimit` and `AgentDBOptions.maxFindLimit`** — configurable cap on records returned by `find()` (default: `10_000`, preserving existing behaviour). When a query hits the cap, a `console.warn` is emitted including the current limit value so operators can grep logs. `AgentDBOptions.maxFindLimit` propagates to all collections as a db-wide default; `CollectionOptions.maxFindLimit` overrides per collection.
- **`CollectionOptions.maxIndexCardinality` and `AgentDBOptions.maxIndexCardinality`** — configurable threshold for disk B-tree index use (default: `1000`, preserving existing behaviour). When a field's cardinality exceeds the threshold, the in-memory B-tree index is skipped and a `console.warn` is emitted once per field at index-load time, so operators can see which fields are falling back to full Parquet scans.
- **`HnswOptions.maxLevel`** — explicit cap on the maximum layer a node can be assigned during HNSW insertion (default: `max(16, floor(log(1e6)/log(M)))`, preserving existing behaviour for M=16). Replacing the hard-coded `16` makes the cap coherent with custom M values. `HnswIndex.currentMaxLayer` getter added for observability and white-box testing.
- **`HttpOptions.maxSessions` and `HttpOptions.sessionIdleMs`** — configurable MCP HTTP session limits (defaults: `100` sessions, `1_800_000` ms idle timeout, preserving existing behaviour). The cleanup interval now scales with `sessionIdleMs` so that short timeouts are honored promptly.
- **`HttpOptions.auditBufferSize`, `auditMaxLimit`, `auditDefaultLimit`** — configurable `AuditLogger` ring-buffer capacity and query page limits (defaults: `10_000` / `10_000` / `1_000`, preserving existing behaviour). `AuditLogger` constructor gains two additional optional parameters (`maxLimit`, `defaultLimit`); `query()` now reads instance fields instead of module constants. Exported constants `AUDIT_MAX_LIMIT` / `AUDIT_DEFAULT_LIMIT` remain for backward compatibility as documented defaults.
- **`CollectionOptions.diskConcurrency` and `AgentDBOptions.diskConcurrency`** — configurable parallel-read batch size for JSONL point-lookups (default: `20`, preserving existing behaviour). `DiskStoreOptions.diskConcurrency` wired through to `readRecordsByOffsets()`. `DiskStore.jsonlConcurrency` getter exposed for observability. Propagates via `AgentDBOptions` → `CollectionOptions` merge, same as other storage knobs.
- **`CollectionOptions.filterCacheSize` and `AgentDBOptions.filterCacheSize`** — configurable per-collection compiled-filter LRU cache size (default: `64`, preserving existing behaviour). Replaces the previous module-level singleton cache with a per-collection instance, eliminating cross-collection eviction. `makeFilterCache(maxSize, compile?)` factory exported from `collection-helpers` for unit testing. `Collection.filterCacheSize` getter added for observability.
- **Test coverage — T10/T11/T12/T13 + B2/B3/H5 carryovers** — 38 new tests: T10 data-driven loop (17 number + 10 string + 1 error = 28 tests covering all previously-untested env vars); T11 `writeMode:'async'` in metrics; T12 `bm25NeedsMerge:true` path (two flushes without rebuild produces `segmentCount > 1`); T13 three strengthened CLI precedence tests asserting actual resolved values via startup stderr logs (`Data directory:`, `http://host:port/mcp`, `N requests/minute`); B2 explicit "error does not contain raw secret" assertion; B3 wrong-shape JSON env var (number array) throws `ConfigValidationError`; H5 `--port abc` and `--rate-limit abc` exit-1 integration tests. Also adds `console.error("Data directory: ${dataDir}")` startup log (enables T13-a and aids operators). Test count: 1372 → 1410.
- **README.md § Configuration — restart-required note** — new "Restart required" subsection at the end of the Configuration section stating that configuration is read once at startup and changes require a process restart; there is no hot-reload. README env var table updated with 5 new rows from H4 (`AGENTDB_EMBEDDINGS_URL`, `AGENTDB_EMBEDDINGS_BASE_URL`, `AGENTDB_EMBEDDINGS_DIMENSIONS`, `AGENTDB_OLLAMA_URL`, `AGENTDB_DISK_THRESHOLD`).
- **README.md § Configuration** — new section (before Production Tuning) covering all three input mechanisms with concrete examples, the full `AGENTDB_*` env var reference table, `agentdb.config.json` shape with per-collection overrides example, the `requireConfigFile` distinction (explicit missing path = error; auto-discovered missing = silent empty config), and the `loadAgentDBConfig` library API. `CLAUDE.md` updated with a pointer to the new section.
- **`src/mcp/cli.ts` rewired to use config pipeline** — `--config <path>` flag added; all existing flags (`--path`, `--backend`, `--bucket`, `--port`, …) remain working and are mapped into the three-layer config (`cli: { db, http }`). When `--config` is explicitly given, a missing file is an error (exits 1); auto-discovered `./agentdb.config.json` continues to silently produce an empty config. `LoadConfigOptions.requireConfigFile` option added to `loadAgentDBConfig` to control this distinction. Help text updated to document all three input mechanisms (CLI flags, env vars, config file). 19 new tests (`tests/config-cli.test.ts`; `tests/cli-help.test.ts` extended with `--config` and `--tenant-id`).
- **`src/config.ts` — file loader + precedence merge** (`loadConfigFile`, `deepMerge`): config file auto-discovered at `./agentdb.config.json` or path from `--config`/`AGENTDB_CONFIG`; absent file → silent empty config; malformed JSON → `ConfigValidationError` with file path; invalid zod shape → error with field path; three-layer precedence merge (file < env < cli) with recursive deep-merge for nested objects (e.g. `hnsw.M` from file + `hnsw.efSearch` from env both survive). 15 new tests (file loading: valid, absent, malformed JSON, invalid shape, custom path, per-collection, `AGENTDB_CONFIG`; precedence: env over file, cli over all, partial deep merge, per-collection isolation, two-source partial, three-source cli wins).
- **`src/config.ts` — config loader skeleton** (`loadAgentDBConfig`, `ConfigValidationError`, `ConfigFileSchema`): zod-validated env var parsing for all 35+ `AGENTDB_*` vars; type coercion for number, boolean, enum, string, comma-split string[], and JSON; `ConfigValidationError` carries `.path[]`, `.source` (`"env"|"file"|"cli"`), and a human-readable message including the var name and bad value. Exported from package root (`loadAgentDBConfig`, `ConfigValidationError`, `ConfigFileSchema`, `AgentDBConfigFile`, `DbConfig`, `HttpConfig`, `CollectionConfig`, `LoadConfigOptions`). 36 new tests.
- **`CollectionMetrics.writeMode`, `bm25DocCount`, `bm25NeedsMerge`** — three new fields on the snapshot returned by `col.metrics()`. `writeMode` reflects the mode the collection was opened with (`"immediate"` / `"group"` / `"async"`; default `"immediate"`). `bm25DocCount` is the total indexed-and-flushed document count from `TermLog.docCount()` (null when text search is disabled). `bm25NeedsMerge` is `true` when there is more than one BM25 segment (i.e. a compaction pass would consolidate them), `false` when fully merged, `null` when text search is disabled.
- **`CollectionOptions.mergeParquetThreshold`, `mergeJsonlThreshold` and `AgentDBOptions.mergeParquetThreshold`, `mergeJsonlThreshold`** — configurable Parquet and JSONL compaction trigger thresholds (defaults: `10` and `8`, preserving existing behaviour). Replaces `static readonly` class constants with per-instance fields initialized from `DiskStoreOptions`. `DiskStore.mergeParquetThreshold` / `mergeJsonlThreshold` getters added for observability.
- **`ProgressEvent` / `ProgressCallback` type + progress callbacks on `reembedAll`, `rebuildTextIndex`, `AgentDB.import`** — all three long-running operations accept an optional `{ onProgress?: ProgressCallback }` argument. `ProgressEvent` carries `completed`, `total` (null during disk streaming), and `phase` (`"wal"` / `"disk"` / `"rebuilding"` / `"importing"`). `db_reembed_all` MCP tool logs progress to `console.error` so operators can track large migrations in server logs. Both types exported from the package root.
- **`AbortSignal` support on `reembedAll`, `rebuildTextIndex`, and `find`** — all three accept an optional `{ signal?: AbortSignal }` argument (additive, no breaking change). `reembedAll` checks `signal.aborted` at the top of every WAL and disk batch iteration; returns a partial `ReembedResult` with `aborted: true` immediately. `rebuildTextIndex` checks after each record; on abort closes the partial TermLog, sets `textIdx = null`, and throws `DOMException("The operation was aborted.", "AbortError")`. `find` checks `signal.aborted` at the start of each full-scan and indexed-candidate-batch iteration in the disk path; sets `truncated: true` on early exit. `ReembedResult` gains an optional `aborted?: boolean` field. `FindOpts` gains an optional `signal?: AbortSignal` field.
- **`Collection.metrics()` API** — returns a `CollectionMetrics` snapshot with: `filterCompilations` / `filterCacheHits` (lifetime filter cache misses and hits since open); `recordCacheFetches` / `recordCacheHits` (disk LRU cache activity; null in memory mode); `findTruncations` (number of `find()` calls that hit the `maxFindLimit` cap); `bm25SegmentCount` (TermLog segment count; null when text search is disabled); `hnswNodeCount` (HNSW node count; null when no embedding provider); `walRecordCount` (current-session WAL entry count); `parquetRowGroups` (Parquet row groups from last compaction; null when no compaction yet or not in disk mode). `CollectionMetrics` and `FilterCacheHandle` exported from package root. `makeFilterCache` return type changed from `CompileFn` to `FilterCacheHandle` (object with `compile`, `compilations()`, `hits()`); `DiskStore` gains `parquetRowGroups` getter and `getCacheStats()` method.
- **Production tuning + limits documentation** — `README.md` gains two new sections: "Production Tuning" (table of every configurable knob with default, location, tune-when signal, and recommended range) and "Limits and Ceilings" (table of every hard cap with default, trigger, effect, and how to raise/lower it). `MIGRATION-2.0.md` gains a "New in v2.1" section summarising all additive v2.1 changes. `CLAUDE.md` updated to reflect v2.1 status and link to the tuning guide.
- **README Production Tuning: write mode, commit, and memory budget rows** — `writeMode`, `groupCommitSize`, `groupCommitMs`, and `memoryBudget` documented in two new sub-tables ("Write mode and commit knobs", "Memory and budget knobs"). No code change.
- **`mergeThreshold` renamed to `mergeParquetThreshold`** everywhere — `CollectionOptions`, `AgentDBOptions`, `DiskStoreOptions`, and the `DiskStore.mergeParquetThreshold` getter. The old name was ambiguous (both Parquet and JSONL have thresholds); the new name is unambiguous. No behaviour change; defaults are unchanged (`10` for Parquet, `8` for JSONL).
- **`CollectionOptions.hnsw` and `AgentDBOptions.hnsw`** — expose HNSW index parameters (`M`, `efConstruction`, `efSearch`, `maxLevel`) via the standard db-wide-default / per-collection-override pattern. Defaults preserved: `M=16`, `efConstruction=200`, `efSearch=50`, `maxLevel=max(16,floor(log(1e6)/log(M)))`. Config getters added to `HnswIndex`: `configM`, `configEfConstruction`, `configEfSearch`, `configMaxLevel`. `Collection.getHnswIndex()` accessor added for test observability. `HnswIndex` and `HnswOptions` exported from package root. README Production Tuning table updated with three new rows.

### Changed

- **`Collection.close()` is now idempotent** — calling `close()` on an already-closed collection (or after `db.close()`) is now a no-op instead of throwing "Store is not open". The guard `if (!this._opened) return` is added at the top of `close()` before the rebuild-abort interlock. This is an additive behaviour change: code that previously relied on the throw to detect double-close must now check `_opened` explicitly (no known callers do this). 1 new test: two `db.close()` calls in sequence; both resolve without throwing. Test count: 1449 → 1450.

### Fixed

- **Production Tuning table: `diskConcurrency` default corrected 16 → 20** — doc drift from R5; actual default in `DiskStore` and `materializeCandidates` is 20, the table row said 16. README line ~806 and the S3 sizing guidance paragraph updated.
- **R7/3 test coverage and one source fix** — three test groups added: (a) Atomic rename failure modes: `vi.mock("node:fs/promises")` used to inject a step-2 failure (`text.new/→text/` ENOTEMPTY); assert rollback restores `text/` from `text.old/` and `bm25Search` still works. Two crash-recovery-in-open() tests: `text.old/` present without `text/` → restored; `text.old/` and `text/` both present → stale backup deleted. Source fix included: the rollback path was restoring `text.old/→text/` on disk but leaving `this.textIdx = null`, making all subsequent `bm25Search` calls throw "BM25 search not enabled". Fixed by reopening TermLog from the restored directory in the rollback catch block. (b) Broader concurrent writes during `rebuildTextIndex`: concurrent UPDATE (new text indexed in rebuilt index; store carries updated record); concurrent DELETE (record gone from store after await; `bm25Search` correctly skips missing records via `materializeCandidates`); 5-write burst (all 5 records in store; shared term findable via `bm25Search`). (c) Vendor-key forwarding via HTTP stub: local `createServer` captures the `Authorization` header; `VoyageEmbeddingProvider` and `CohereEmbeddingProvider` both send `Bearer <apiKey>`; env-fallback path tested (key sourced from `VOYAGE_API_KEY` / `COHERE_API_KEY` and forwarded identically). Test count: 1439 → 1449.
- **JWT secret minimum length enforced at config load time (R7/2)** — `HttpConfigSchema.http.jwt.secret` now carries a zod `.min(32, …)` constraint ("JWT secret must be at least 32 characters (256 bits for HS256 — use `openssl rand -hex 32`)"). Applies to both the file-load path (`loadConfigFile` → `ConfigFileSchema.safeParse`) and the env var path (post-merge `ConfigFileSchema.safeParse` in `loadAgentDBConfig`). A secret shorter than 32 bytes throws `ConfigValidationError` with `.source` set appropriately — hard error, not a warning, so the server refuses to start rather than accepting an under-length key. 3 new tests: short secret via config file → `ConfigValidationError` containing "32"; short secret via `AGENTDB_HTTP_JWT_SECRET` → `ConfigValidationError` containing "32"; exactly 32-char secret is accepted. Test count: 1436 → 1439.
- **`rebuildTextIndex` concurrency hardening (R7/1)** — three bugs fixed: (A) `_rebuildingIdx` leaked on mid-loop exception — a dangling shadow-write pointer caused live inserts to call `add()` on a zombie TermLog after an ENOSPC or OOM. Fixed: the entire FS rebuild body is wrapped in `try/finally`; the finally always clears `_rebuildingIdx`, calls `newIdx.close().catch(()=>{})`, and `rm(textNewDir, { force: true })`; all operations are idempotent so the success path (which closes/renames textNewDir) causes no double-close errors. (B) no single-flight guard — two concurrent `rebuildTextIndex` calls both wrote into `text.new/` and raced the rename dance. Fixed: `if (this._rebuilding) throw new Error("agentdb: rebuildTextIndex already in progress")` at function entry (before the S3/FS branch); `_rebuilding` is cleared in the same finally block. (C) `close()` did not interlock with an in-flight rebuild — calling `db.close()` while a rebuild was running closed `this.textIdx` (still being shadow-written by the rebuild loop), leaving state undefined. Fixed: the FS rebuild creates an `AbortController` (`_rebuildAbortCtrl`) and a settle promise (`_rebuildSettled`); `close()` calls `_rebuildAbortCtrl.abort()` and `await _rebuildSettled` before proceeding; the finally block resolves the settle promise and clears both fields. 3 new tests: A (spy TermLog.prototype.add to throw on 5th call; assert `_rebuildingIdx` null after; assert rebuild can run again), B (two concurrent calls; assert one rejects "already in progress" and the other completes), C (start rebuild; await `db.close()`; assert close completes cleanly and rebuild rejects with AbortError). Test count: 1433 → 1436.
- **README docs polish (R6/4)** — six additions: (1) "Auth priority when multiple mechanisms are configured" subsection in `## Authentication` with a priority table (`jwt > multi-token > bearer`) and a note that a startup warning fires when more than one is set; (2) JWT secret minimum length recommendation (≥32 chars / 256 bits, `openssl rand -hex 32`); (3) `rebuildTextIndex` disk-space note — FS mode holds `text/` and `text.new/` simultaneously (~2× index size in free space needed during rebuild) plus explicit write-safety note (concurrent inserts/deletes are captured; `bm25Search` reads old index until swap); (4) Docker config-file mount example (`-v ./agentdb.config.json:/etc/agentdb/config.json:ro --config /etc/agentdb/config.json`); (5) `col.metrics()` verification pointer in the Observability subsection explaining how to confirm a knob change took effect using hit-rate counters; (6) CHANGELOG: `configMaxLevelCap` corrected to `configMaxLevel` in the Added entry that introduced the getter (the name was renamed before the first release but the CHANGELOG was not updated).
- **R6/3 test coverage** — 6 new tests: (1) auth precedence: JWT wins when JWT + multi-token are both set — conflict warn fires, multi-token bearer gets 401, JWT bearer gets 200; (2) vendor key fallback: `VOYAGE_API_KEY` is used when `AGENTDB_EMBEDDINGS_API_KEY` is absent; (3) vendor key fallback: `COHERE_API_KEY` is used when `AGENTDB_EMBEDDINGS_API_KEY` is absent; (4) world-readable config file emits `console.warn` containing "world-readable" (POSIX only); (5) non-world-readable config does not emit `console.warn`; (6) `bm25Search` during an in-flight `rebuildTextIndex` does not throw — returns a valid result (may be stale, but must not error). `startServer` in `config-cli-auth.test.ts` gains a `getStderr()` accessor on its return value. Test count: 1427 → 1433.
- **`rebuildTextIndex` atomic swap now safe on crash (R6/2a)** — the previous swap sequence (`rm text/ → rename text.new/→text/`) left the collection with no `text/` directory between two separate filesystem calls. Replaced with a rename-dance: `rename text/→text.old/` → `rename text.new/→text/` → `rm text.old/`. `text/` is absent for at most one rename syscall. On rollback (step 2 fails), `text.old/` is renamed back to `text/` so the collection remains queryable. Step 1 is skipped when `text/` doesn't exist (first-time build or text search disabled). `Collection.open()` adds crash-recovery: if `text.old/` exists on startup, it either deletes it (swap completed, cleanup was interrupted) or renames it back to `text/` (swap aborted mid-flight between steps 1 and 2).
- **Auth conflict warn when multiple mechanisms configured (R6/2b)** — if more than one of JWT, multi-token, or single-bearer is set in the config, `cli.ts` now emits a `console.warn` naming the active mechanisms, the winner, and the priority order (`jwt > multi-token > bearer`). Previously the lower-priority mechanisms were silently ignored with no diagnostic.
- **`rebuildTextIndex` now captures concurrent writes (R6/1)** — records inserted or deleted while a FS-mode rebuild is in flight were previously silently dropped from the new index. Fixed with two complementary mechanisms: (1) shadow-write via `this._rebuildingIdx` routes all live `add`/`remove` calls to both the old and new index during the rebuild loop; (2) a post-loop delta scan walks `this.store.entries()` (opslog updates the in-memory Map synchronously before WAL flush) and adds any IDs not in the original snapshot to `newIdx`, then removes any snapshot IDs that were deleted. S3 mode is unaffected (no atomic rename; no delta scan). 1 new test asserts `bm25Search` finds a record inserted concurrently during a rebuild.
- **`HnswIndex.configMaxLevelCap` renamed to `configMaxLevel`** — name now matches the symmetry of the other three getters (`configM`, `configEfConstruction`, `configEfSearch`). The `Cap` suffix was misleading (it implied a runtime limit, not a config value). Test descriptions updated accordingly.
- **Voyage and Cohere vendor key env var fallbacks** — `VOYAGE_API_KEY` and `COHERE_API_KEY` are now checked as fallbacks when `AGENTDB_EMBEDDINGS_API_KEY` is not set, matching the pattern already in place for `OPENAI_API_KEY` and `GEMINI_API_KEY`. Operators using vendor-native env var names no longer need to duplicate the key under `AGENTDB_EMBEDDINGS_API_KEY`.
- **World-readable config file warning** — `loadAgentDBConfig` (and therefore the CLI) now emits a `console.warn` when the loaded config file has the world-read bit set (`mode & 0o004`), reminding operators to `chmod 600`. POSIX-only; silently skipped on Windows and if `stat` fails.
- **README env var security note** — new blockquote after the env var reference table noting that `/proc/<pid>/environ` exposes env vars on Linux and pointing at safer alternatives (secrets manager, read-protected config file, `systemd EnvironmentFile=`).
- **`rebuildTextIndex` abort no longer destroys the existing index (FS mode)** — the previous implementation wiped `text/` before starting the rebuild; an abort left the collection with `textIdx=null` and an empty text directory. Fixed with snapshot-then-swap: the new index is built into `text.new/` while the original `text/` and `this.textIdx` remain intact and queryable. On abort, `text.new/` is discarded and the original index is preserved. On success, the canonical swap closes both handles, removes `text/`, renames `text.new/→text/`, and reopens. S3 mode retains the destructive approach (no atomic blob rename) with a loud `console.warn` on abort. 1 new test (`"snapshot-then-swap: abort preserves the original index"`) asserts that `bm25Search` returns results after an aborted rebuild.
- **Per-collection config overrides now consumed** — `agentdb.config.json`'s `collections:` block was parsed and validated but dropped on the floor; the CLI never passed it to `AgentDB`. Fixed by adding `AgentDBOptions.collectionOverrides?: Record<string, CollectionOptions>` (stored by reference, read at every open) and threading `config.collections` into it from `resolveAgentDBOpts()`. Precedence at open time: programmatic `db.collection(name, opts)` (caller-passed, field must be defined) > `collectionOverrides[name]` > AgentDB-level db-wide defaults > built-in defaults. Already-open collections are unaffected; evict or close the collection for a map mutation to take effect. 6 new tests in `tests/collection-overrides.test.ts` cover: override applied, other collections unaffected, override beats db-wide default, caller opts beat override, functional `maxFindLimit` enforcement, and re-read on next open.
- **Auth wiring regression: JWT, multi-token, and `rateLimitWindow` now active** — `src/mcp/cli.ts` previously constructed `startHttp()` options without wiring `http.jwt`, `http.multiToken`, or `http.rateLimitWindow`, so operators who set `AGENTDB_HTTP_JWT_SECRET` or `http.multiToken` in their config got an unauthenticated server. Auth priority is now enforced: JWT (`http.jwt.secret`) > multi-token (`http.multiToken`) > single bearer token (`http.auth`). `rateLimitWindow` is threaded through. 8 new integration tests in `tests/config-cli-auth.test.ts` assert 401 without credentials and 200 with valid JWT / bearer token for each auth mechanism.
- **`ConfigFileSchema` removed from package root value exports** — it was leaking zod as a runtime peer-dep for library consumers. `ConfigFileSchema` remains exported from `src/config.ts` for internal use; consumers who need to validate a config shape should use `loadAgentDBConfig` instead. Type exports (`AgentDBConfigFile`, `DbConfig`, etc.) are unaffected.
- **JSON env var parse error redacted raw value** — `AGENTDB_HTTP_MULTI_TOKEN=<bad>` previously echoed the token list to stderr. Error now reads `AGENTDB_HTTP_MULTI_TOKEN=<redacted> is not valid JSON (…)`.
- **Post-merge zod validation in `loadAgentDBConfig`** — `parseEnvVars` coerced values individually but did not validate the assembled shape. `ConfigFileSchema.safeParse` is now run on the merged config before return; a wrong-shape env-supplied JSON field throws `ConfigValidationError` with source `"env"`.
- **`writeMode` propagation verified end-to-end** — `AGENTDB_WRITE_MODE=async` flows: `ENV_VAR_MAP` → `config.db.writeMode` → `resolveAgentDBOpts()` → `AgentDBOptions.writeMode` → `AgentDB._openCollection` → `Collection.open(opts)` → opslog Store `asyncMode`. New test `"writeMode propagation: metrics().writeMode is 'async' and writes are functional end-to-end"` in `write-modes.test.ts` asserts `col.metrics().writeMode === "async"`, WAL record count increments, data is immediately visible, and persists after `db.close()` + reopen.
- **`--port` and `--rate-limit` NaN guard** — `parseInt(next, 10)` returned `NaN` silently on non-numeric input. Both flags now route through `parseIntFlag()` which exits 1 with a clear error message on invalid input.
- **Five missing env vars added to `ENV_VAR_MAP`** — `AGENTDB_EMBEDDINGS_URL` (HTTP provider URL), `AGENTDB_EMBEDDINGS_BASE_URL` (Ollama base URL), `AGENTDB_EMBEDDINGS_DIMENSIONS` (HTTP provider dimensions), `AGENTDB_OLLAMA_URL` (formal alias for `AGENTDB_EMBEDDINGS_BASE_URL`; removes the ad-hoc `process.env.AGENTDB_OLLAMA_URL` fallback in `cli.ts`), and `AGENTDB_DISK_THRESHOLD` (`auto` mode switch threshold). README Configuration table updated with the new rows.
- **`writeMode: "immediate"` can now be set explicitly via CLI / config** — `resolveAgentDBOpts()` previously guarded `if (writeMode === "group" || === "async")`, blocking `immediate` from overriding a config-file `group`. Guard removed; all three values propagate.
- **CORS `"*"` wildcard now works** — passing `--cors "*"` or `AGENTDB_HTTP_CORS="*"` previously produced `["*"]` which never matched any specific origin. The CORS middleware now detects `"*"` in the allowed list and responds with `Access-Control-Allow-Origin: *` for all requests (no `Vary: Origin` header in wildcard mode).
- **`CollectionMetrics.bm25MergePending` renamed to `bm25NeedsMerge`** — the old name implied a user-configured threshold trigger; the field actually reflects termlog's internal LSM compaction state (`segmentCount() > 1`), which is unrelated to `mergeParquetThreshold`. JSDoc clarifies the semantics and the null case.
- **`AgentDBOptions.cacheSize` JSDoc** reported wrong default (`10000`); actual value enforced by `_openCollection` is `1_000`. Corrected.
- **`AgentDBOptions.diskConcurrency` JSDoc** reported wrong default (`16`); actual value enforced by `DiskStore` constructor is `20`. Corrected.
- **README `maxIndexCardinality` tune-when signal was wrong** — referenced `metrics().bm25SegmentCount` (BM25 segment count, unrelated to B-tree cardinality). Replaced with the correct signal: the `console.warn` that fires at collection open when a field exceeds the threshold.
- **Both cap/limit warnings lacked collection name** — `find()` truncation warn and DiskStore cardinality-skip warn did not include the collection name, making them useless in multi-collection deployments. Both now include `[collectionName]`. `DiskStoreOptions` gains `collectionName?: string` threaded from `agentdb.ts` at store construction time.
- **`reembedAll` abort returns were log-silent** — all three return-with-aborted paths in `reembedAll` now emit a `console.warn` with collection name, embedded count, and failed count.
- **`diskConcurrency` default split** — `collection.ts:materializeCandidates` used `?? 16`; `DiskStore` used `?? 20` for JSONL reads. Unified to `20` everywhere. `CollectionOptions.diskConcurrency` JSDoc updated from "default: 16" to "default: 20".
- **`db_reembed_all` tool silently dropped `aborted:true`** — the zod `outputSchema` did not include `aborted`, so a cancelled reembed run was indistinguishable from a completed one. Added `aborted: z.boolean().optional()` to the schema; the full `ReembedResult` is now returned as-is.
- **`onProgress` callbacks were unguarded** — if a user-supplied callback threw, the exception aborted the operation mid-flight (and in `reembedAll` left the HNSW index partially cleared). All six call sites in `collection.ts` and `agentdb.ts` are now wrapped in `try/catch`; errors are logged to `console.error` and swallowed.
- **`find()` `_findTruncations` counter and cap warning fired on abort** — `truncated` was set when aborted, and the counter/warn fired whenever `requestedLimit > limit`, including on abort. Separated: `_findTruncations` and the cap warning now only fire when the `maxFindLimit` cap was the actual cause (`total > offset + limit && requestedLimit > limit && !tokenTruncated && !abortedEarly`). `FindResult` gains an optional `aborted?: boolean` field (symmetry with `ReembedResult.aborted`) set to `true` only when an `AbortSignal` cut the scan short.
- **Missing regression tests (T8-T13)** — T8: `AgentDB`-level `maxFindLimit` propagation; T9: rewrote broken cap-boundary test to actually exercise `requestedLimit == limit` and add a `cap+1` case that must warn; T10: replaced weak HNSW M=2 derived-cap test with a deterministic `Math.random` spy forcing level=17 to prove the cap is 19 not 16; T11: empty-collection `reembedAll` and `import` edge cases; T12: post-resolve abort does not retroactively set `aborted:true`; T13: `AgentDB`-level `filterCacheSize`, `mergeParquetThreshold`, `mergeJsonlThreshold` propagation. Test count 1280 → 1287.

## [2.0.0] - 2026-05-05

### Changed (pre-release audit round 3)

- **Per-provider batch limits for all embedding providers** — all providers now chunk large `texts[]` arrays into sequential batches before hitting their respective APIs, matching the chunking pattern already in place for OpenAI. Per-provider limits: Voyage=128, Cohere=96, Gemini=100, Ollama=1 (sequential by API design, unchanged), HTTP=configurable via `batchLimit` constructor option (default 100). `HttpEmbeddingOptions` gains an optional `batchLimit?: number` field.

### Fixed (pre-release audit round 2)

- **Documented migration flow re-threw `LegacyTextIndexError` on second open** — `AgentDB.collection()` caches `colOpts` (including `textSearch: true`) before calling `_openCollection()`. When step 1 threw, the cached opts persisted; a subsequent `db.collection("name")` call used the same opts and threw again, making the documented recovery impossible. Fix: new `AgentDB.rebuildTextIndex(name)` top-level method that opens the collection internally with `textSearch: false` (temporarily overriding cached opts), calls `col.rebuildTextIndex()`, then evicts so the next open uses the caller's opts. README, MIGRATION-2.0.md, and the `LegacyTextIndexError` message all updated to the new single-call API.
- **S3 rebuild wipe had unbounded `Promise.all` fan-out** — at 10K blobs, 10K concurrent `deleteBlob` SDK calls were queued, exceeding the AWS SDK default connection pool (50) and risking timeouts or OOM. Replaced with a 16-parallel batch loop matching the `diskConcurrency` pattern used elsewhere in agentdb.

### Changed (pre-release audit round 2)

- **`AgentDB.rebuildTextIndex(name)` added** — top-level recovery method for the v1.4 → v2.0 migration path; opens collection without textSearch, rebuilds, evicts; returns indexed doc count. `LegacyTextIndexError` message updated to point at this method. README and MIGRATION-2.0.md updated accordingly.
- **CI `push` trigger drops `v1.5-termlog` branch** — working-branch trigger removed; CI now only runs on pushes to `main`.
- **README example "Updated for v1.3" corrected to "Updated for v2.0"**.

### Fixed (pre-release audit)

- **`rebuildTextIndex()` double-counted docs in S3 mode** — the local-FS branch wiped `text/` with `rm` + `mkdir` before reopening TermLog. The S3 branch skipped the wipe (no directories to delete), so `TermLog.open` reopened existing segments while the subsequent `add()` loop re-indexed every record on top — same doubling bug fixed for WAL replay at `15709e3`. Fix: in S3 mode, call `_termlogBackend.listBlobs("") `+ `deleteBlob()` for each blob before reopening TermLog. `db.import()` and repeated `db_rebuild_text_index` calls were both affected.
- **`db.import()` indexed each record twice** — `agentdb.ts` called `col.rebuildTextIndex()` after the per-record `insert/upsert` loop. Each insert already calls `tl.add()` via `incrementalIndexUpdate`, so the rebuild was redundant and, combined with the S3 double-count bug, actively poisoned BM25 scores. The `rebuildTextIndex()` call is removed; per-record inserts are sufficient.
- **Legacy v1.4 detection check skipped in S3 mode** — `Collection.open()` probed `this.backend` (opslog top-level) for `text/manifest.json`, but in S3 mode termlog writes through `_termlogBackend` at a different prefix — so the check was structurally wrong and could false-pass or crash if v1.4 S3 data ever existed. Since v1.4 never wrote `indexes/text-index.json` to S3 (old `TextIndex` was local-FS-only), the legacy check is now guarded by `!this._termlogBackend` and skipped entirely in S3 mode.
- **`Collection.flushTextIndex()` JSDoc claimed wrong callers** — the method is used by tests (to force segment files to disk before asserting on file existence); it is not called by `AgentDB.close` or WAL replay. JSDoc corrected.
- **`CHANGELOG.md` and `MIGRATION-2.0.md` excluded from npm tarball** — `package.json:files` listed only `dist/`, `README.md`, `LICENSE`. Both files added.

### Changed (pre-release audit)

- **`package.json`**: added `repository` field, `"sideEffects": false`.
- **`tsconfig.json`**: added `"sourceMap": true`, `"declarationMap": true`.

### Changed

- **`Collection` text index backend replaced with `@backloghq/termlog` (phase 3)** — `private textIdx: TextIndex | null` replaced with `TermLog | null`. TermLog is opened at `<dir>/text/` in `Collection.open()` and closed in `Collection.close()`. `rebuildTextIndex()` and `incrementalIndexUpdate()` are now async. All `textIdx.add/remove` call sites await the TermLog async API. `DiskStore.loadIndexes`/`saveIndexes` no longer receive a text-index argument — TermLog owns its own directory. `find()/$text`, `search()`, and `bm25Search()` flush the TermLog write buffer before querying so buffered writes are immediately visible without an explicit flush call. Added `Collection.flushTextIndex()` public method (used in tests to flush write buffer to segments). `Collection.getTextIndex()` return type is now `TermLog | null`.
- **`bm25Search()` uses OR semantics via TermLog (phase 4)** — BM25 ranked recall calls `tl.search(query, { mode: "or", limit: candidateLimit })`. `$text` filter and `search()` use `mode: "and"` (precision). `hybridSearch()` BM25 arm routes through `bm25Search()` with graceful arm-failure degradation unchanged. `db_bm25_search` and `db_hybrid_search` tools verified compile-clean against the new TermLog-backed paths. `searchable`-field projection (`textRecord()`) is preserved — TermLog indexes only the fields opted-in via `searchableFields`.
- **`hybrid-search.test.ts` arm-failure tests rewritten with generic error injection (phase 4)** — the two tests that previously injected `IndexFileTooLargeError` via `DiskStore.MAX_INDEX_FILE_SIZE=1` now use `vi.spyOn(Collection.prototype, "bm25Search").mockRejectedValueOnce(new Error("simulated text arm failure"))`. The intent (RRF degrades gracefully when BM25 arm fails) is preserved. `DiskStore` import removed from that test file.
- **BM25 scoring parity regression test added (phase 4)** — new file `tests/bm25-parity.test.ts` verifies that `bm25Search` scores match a hand-derived reference BM25 formula to within 1e-9. Corpus: 4 docs, query "alpha", N=4, df=3, avgdl=3.25 — doc-1 (tf=2, dl=4) ranked first, doc-3 (tf=0) absent. Tests run with default k1=1.2/b=0.75 and tuned k1=2/b=0.3 (via `defineSchema({ bm25: {...} })`).
- **`LegacyTextIndexError` detection in `Collection.open()` (phase 5)** — exported `LegacyTextIndexError` class with `legacyPath` field thrown when a v1.4 `indexes/text-index.json` blob is present without a `text/manifest.json` termlog manifest. Store lock is released before throwing. When both exist (manual plant), the legacy blob is silently deleted and open proceeds normally. The fix path: open the collection without `textSearch:true`, call `rebuildTextIndex()`, then reopen with `textSearch:true`.
- **`rebuildTextIndex()` made public, returns doc count, deletes legacy blob (phase 5)** — previously private, now `public async rebuildTextIndex(): Promise<number>`. Wipes the `text/` directory, re-opens TermLog, indexes all non-expired records (supports both in-memory opslog and disk-backed `DiskStore.entries()` paths), flushes, and deletes the `indexes/text-index.json` legacy blob. Returns the count of indexed documents.
- **`db_rebuild_text_index` MCP tool added (phase 5)** — admin tool (WRITE_IDEMPOTENT) that opens the named collection without textSearch, calls `rebuildTextIndex()`, and returns `{ rebuiltDocCount: number }`. Total tool count is now 40.
- **`tests/legacy-text-index.test.ts` — 7 tests covering all open() states and rebuild flow (phase 5)** — states: legacy-only (throws LegacyTextIndexError with correct legacyPath/message), termlog-only (no error, search works), both (legacy blob deleted, search works), neither (fresh collection). Plus: rebuild flow (open throws → rebuild without textSearch → reopen succeeds, legacy gone), `db_rebuild_text_index` tool (returns rebuiltDocCount=2), tool name in tool list.
- **Storage lifecycle integration for termlog text/ subdir (phase 6)** — `AgentDB.import()` now calls `col.rebuildTextIndex()` after inserting records into each collection with `textSearch` enabled (detected via `col.getTextIndex() !== null`), ensuring `bm25Search` works immediately after import without close/reopen. `dropCollection` and `purgeCollection` require no changes — TermLog is already closed before the dir rename, and rm-rf removes text/ with the dropped dir. `compactInPlace` requires no changes — DiskStore only touches Parquet/JSONL. New `tests/termlog-lifecycle.test.ts` with 7 tests covering all 5 lifecycle scenarios.
- **S3 mode: `@backloghq/termlog-s3` wired transparently when opslog uses S3 (phase 7)** — `AgentDB._openCollection()` detects an S3 opslog backend via `backend.constructor.name === "S3Backend"`, dynamically imports `@backloghq/termlog-s3`, and calls `col.setTermlogBackend(new S3Backend({ client, bucket, prefix: "<prefix><name>/text/" }))` before `Collection.open()`. `Collection` has a new `setTermlogBackend()` method and `_termlogBackend` field; both `open()` and `rebuildTextIndex()` pass it through to `TermLog.open({ backend })`. S3 detection uses runtime property access since opslog-s3's fields are private — the pattern is an internal monorepo concern. Fallback: if `@backloghq/termlog-s3` is not installed, text index uses local FsBackend (catch around dynamic import). Added as optional peer dependency in `package.json`; `@backloghq/termlog-s3: ^0.1.0` in `devDependencies` for test resolution. README S3 section updated with text-search-on-S3 note, single-writer constraint, and lifecycle recommendation. New `tests/agentdb-s3-integration.test.ts` (skipped without `S3_INTEGRATION=1`): insert+bm25Search, close/reopen persistence, S3 key prefix verification, and remove+reopen. CI `integration` job added (MinIO RELEASE.2025-09-07T16-13-09Z, bucket `agentdb-test`, Node 22). CI now also runs on pushes to `v1.5-termlog`.

### Added

- **`tests/stress.test.ts` — text-search stress at 100K docs (phase 9)** — gated on `STRESS=1`; without it uses a 10K subset. Inserts N docs in batches of 1K using a deterministic LCG vocabulary (1K words), measures p95 BM25 query latency (CI limit 2000ms, local 800ms), peak RSS via `process.resourceUsage().maxRSS` (limit 2 GB). Second test: close + reopen, verify top-10 results are identical. CI stress job added (runs after `test`, `STRESS=1`, Node 22).
- **`tests/multi-collection-text.test.ts` — termlog isolation across 5 concurrent collections (phase 9)** — two tests: (1) 5 collections open simultaneously each with unique vocabulary terms — verifies no cross-contamination in bm25Search results; (2) concurrent writes (20 docs per collection via `Promise.all`) — verifies each collection's unique term returns exactly 20 results with no foreign IDs.

### Fixed

- **BM25 scores change after close+reopen — WAL replay doubled `totalDocs`/`totalLen`** — `Collection.open()` replayed all WAL records into TermLog even when TermLog already had those records persisted in its on-disk segments from the previous session. Each `add()` call tombstones the old entry and inserts a new one; on flush the new segment's counts are added to the manifest totals, so a 100K-doc session would reopen with `totalDocs=200000`, doubling `avgdl` and shifting boundary BM25 scores. Fix: after `TermLog.open()`, check `termlogAlreadyIndexed = this.textIdx.docCount() > 0` and skip the WAL-replay `add()` loop when true. New records written after open continue to be indexed normally via `incrementalIndexUpdate()`.
- **`//` double-slash S3 keys when opslog prefix has a trailing slash** — `AgentDB._openCollection()` now normalizes the opslog backend prefix before constructing the termlog-s3 prefix (strips trailing slashes via `.replace(/\/+$/, "")`). This prevents keys like `"store//.lock"` or `"store//manifest.json"` that MinIO and real S3 both reject with `XMinioInvalidObjectName`. Root cause also fixed upstream in `@backloghq/opslog-s3` (SHA `6032794`) — constructor now normalizes `options.prefix` regardless of caller input. `tests/agentdb-s3-integration.test.ts` corrected: key-layout assertions updated to match actual flat S3 key structure (opslog data under the basePrefix, termlog data under `<prefix>/docs/text/`); `col.delete()` → `col.deleteById()` (correct Collection API).

### Removed

- **`src/text-index.ts` and the `TextIndex` class deleted (phase 8)** — the in-house BM25 implementation (`TextIndex`, `TextIndexOpts`) is gone. All callers have been on `@backloghq/termlog` since phase 3; the module was dead code. `IndexFileTooLargeError` and `DiskStore.MAX_INDEX_FILE_SIZE` (256 MB BM25 cap) also removed — TermLog manages its own size limits. `src/index.ts` no longer re-exports `TextIndex`, `TextIndexOpts`, or `IndexFileTooLargeError`.
- **`tests/text-index.test.ts` and `tests/text-index-persistence.test.ts` deleted (phase 8)** — 4 CI-failing tests that instantiated `TextIndex` directly; obsolete post-termlog integration. `tests/bench-bm25.test.ts` pruned: removed items 1, 2, 6, 7, 10 (direct `new TextIndex()` benchmarks) and the v1-upgrade-path bench (manually plants `indexes/text-index.json`); items 3, 4, 5, 11, 12 (AgentDB/RRF-based) retained. `tests/memory.test.ts` pruned: removed `describe("TextIndex.estimatedBytes()"...)` block (4 unit tests) and updated `describe("TextIndex memory monitor integration"...)` → `describe("TermLog memory monitor integration"...)`.

## [1.4.0] - 2026-05-04

### Changed
- **`Collection.reembedAll()` now returns `ReembedResult` instead of `number` (#182)** — structured result with `embedded` (success count), `failed` (failure count), and `errors: Array<{ batchIndex, recordIds, reason }>` (per-batch detail). Per-batch try/catch now records the batch index and failing record IDs so callers can distinguish partial success from total failure. `db_reembed_all` MCP tool returns the same shape and its description updated to mention `failed > 0` check. `ReembedResult` exported from the core package. Existing #166 tests updated to consume the new shape.
- **`extractTextFromRecord` uses explicit `META_FIELDS_FOR_EMBED` set, not `_` prefix (#183)** — reverts the `key.startsWith("_")` guard from round 4. A new `META_FIELDS_FOR_EMBED` constant (exported from `collection-helpers.ts`) enumerates exactly `_id`, `_version`, `_agent`, `_reason`, `_expires`, `_embedding`. User fields that happen to start with `_` (e.g. `_internal_note`, `_draft`, `_legacy_id`) are now included in embedding text, matching the BM25 `textRecord` path. The original round-4 bug (`_id` in embedding text) remains fixed. 3 new policy tests.

### Added
- **`AgentDB.collection` schema-vs-opts precedence documented (#202)** — JSDoc warning on `collection(nameOrSchema, colOpts?)` clarifies that when a `defineSchema()` result is passed, `schema.collectionOptions` completely replaces the `colOpts` argument (line 226 of `agentdb.ts`); any per-call overrides like `embeddingBatchSize` or `diskConcurrency` are silently discarded. Callers who need to override these knobs for a schema-defined collection must include them in the `defineSchema(...)` call or set them as db-wide defaults on `AgentDBOptions`. Two pinning tests in `tests/agentdb.test.ts` confirm: (1) schema `textSearch:true` governs even when caller passes `colOpts` without `textSearch` — `bm25Search` succeeds; (2) plain string name: `colOpts` is used as-is.
- **Mid-flight compaction during `reembedAll` (#183-compaction)** — `DiskStore.shouldCompact()` (public helper) exposes the JSONL file count threshold check; `DiskStore.compactInPlace()` streams the store's own records and triggers a full compaction without an external record list. `Collection.reembedAll()` calls `shouldCompact()` + `compactInPlace()` after each `appendEmbeddings` flush, bounding JSONL file accumulation to ≤8 files throughout a large reembed run. For 1M records at batch 256 this triggers ~488 compactions vs. zero previously; each compaction bounds index rewrite size and prevents S3 tail-latency blowup.
- **`MERGE_JSONL_THRESHOLD=8` rationale documented (#185)** — comment in `disk-store.ts` explains the choice: matches `MERGE_THRESHOLD=10` (Parquet limit) as ~10× batch size, giving smooth write amplification on S3. Also updated `disk-store.ts` description in CLAUDE.md.
- **CLAUDE.md vector.ts tool count fixed (#186)** — line was "6 tools" (missing `db_reembed_all`); corrected to 7.
- **README `searchByVector` example missing `await` fixed (#187)** — pre-existing bug in the raw-vector search code snippet; `col.searchByVector(...)` is async and must be awaited.
- **Test: `reembedAll` mid-flight failure semantics (#188)** — new test in `tests/disk-embed.test.ts`: 30 disk records, `batchSize=10`, provider throws on call 2. Asserts `ReembedResult.embedded=20`, `failed=10`, `errors[0].recordIds` has 10 entries, `errors[0].reason` contains the thrown message. Phase 3 reopen verifies `reembedAll` re-embeds all 30 with working provider.
- **Test: `db_reembed_all` tool execute path (#189)** — 2 new tests in `tests/tools/vector.test.ts`: (1) happy path inserts 2 records, calls `db_reembed_all`, asserts `{embedded:2, failed:0, errors:[]}` shape; (2) no-provider path returns `isError:true`.
- **Test: `extractTextFromRecord` user `_`-prefixed field policy (#190)** — 2 new tests in `tests/disk-embed.test.ts`: user `_custom_field` is included; only the 6 explicit `META_FIELDS_FOR_EMBED` members are excluded (not all `_`-prefixed keys). Pins the policy established in #183.
- **Test: `reembedAll` 3+ JSONL mixed states (#191)** — new test in `tests/disk-embed.test.ts`: insert 5 records (no embed) → embed all (JSONL with `_embedding`) → upsert all (WAL without `_embedding`) → `reembedAll` re-embeds all 5 WAL records. Verifies WAL path processes updated records correctly even after disk had prior embeddings.
- **`embedUnembedded` memory characteristic documented (#184 close-out)** — JSDoc on `embedUnembedded` notes the RAM profile (~1 KB/record, ~1 GB at 1M unembedded) and directs large-collection users to `reembedAll()` which streams and flushes mid-run. Same note added to README. The `pending: Map` is correct for idempotency; a streaming alternative requires reverse-iteration in `DiskStore.entries()`, deferred post-v1.4.
- **`DiskStore.compactInPlace` memory characteristic documented (#195)** — JSDoc notes the full-materialization cost (~1 KB/record; ~1 GB at 1M), amortized by the `MERGE_JSONL_THRESHOLD` call frequency. Same note in README Known limits and CHANGELOG.
- **Test: `shouldCompact` threshold boundary + `compactInPlace` reset (#193)** — 3 new unit tests in `tests/disk-store.test.ts`: (1) `shouldCompact()` false when `jsonlFiles.length < threshold - 1`; (2) false at 7 JSONL files, true at 8; (3) `compactInPlace()` resets `compactionMeta.jsonlFiles` to empty and data remains readable. Integration spy test in `tests/disk-embed.test.ts`: 80 disk records, `batchSize=10`, `reembedAll` fires `compactInPlace` at least once (verified via `vi.spyOn`).
- **Test: `reembedAll` batchIndex correctness + WAL-batch failure (#194)** — 2 new tests in `tests/disk-embed.test.ts`: (1) disk-only scenario asserts `errors[0].batchIndex === 1` for the second batch failure (first disk batch after zero WAL batches); (2) WAL-batch failure asserts `batchIndex === 0`, `recordIds` all start with "wal", and disk batches continue with correct offset.
- **Regression tests: disk-mode same-session search (#197)** — new test file `tests/disk-search-same-session.test.ts` with 5 tests: (1) `bm25Search` finds WAL-only inserts without close/reopen; (2) `semanticSearch` finds WAL-only inserts; (3) `searchByVector` finds WAL-only inserts; (4) `hybridSearch` finds WAL-only inserts; (5) mixed-session: old compacted records (Parquet) and new WAL-only inserts both found in a single search after reopen.
- **E2E integration test suite: hybrid search smoke scenarios (#199)** — new test file `tests/hybrid-search-e2e.test.ts` with 8 tests covering 6 scenarios: (1) library API end-to-end in memory mode — `bm25Search`, `semanticSearch`, `hybridSearch` all return results; (2) disk-mode persistence + same-session WAL search — same-session insert+search, post-reopen results, and mixed Parquet+WAL results; (3) degraded hybrid modes — BM25-only, vector-only, and neither-configured (throws); (4) v1.3 migration — `reembedAll` returns `{embedded, failed, errors}` shape; (5) MCP tool round-trip — `db_hybrid_search`, `db_bm25_search`, `db_reembed_all` all return parseable JSON with correct shapes; (6) tokenizer Unicode — ASCII, accented Latin (café), CJK whole-run match, and CJK substring non-match (pins the no-segmentation behavior documented in #198). Scenario 2 confirmed to fail on pre-#196 code.

### Known limits
- **`embedUnembedded` buffers unembedded records** — disk path holds full record references for all unembedded records before batching (~1 KB/record; ~1 GB at 1M unembedded). For very large lazy-embedding runs, prefer `reembedAll()` which flushes mid-run with bounded memory.
- **`compactInPlace` fully materializes the dataset** — called by `reembedAll` every `MERGE_JSONL_THRESHOLD` batches; each call loads all on-disk records into memory (~1 KB/record; ~1 GB at 1M). Cost is amortized across the run; single-call peak is bounded by dataset size.

### Fixed
- **HNSW dimensions=0 crash with auto-detect providers (#201)** — `setEmbeddingProvider` constructs `HnswIndex({ dimensions: provider.dimensions })`; when the provider is Ollama or any other that reports `dimensions=0` at construction (auto-detecting on first call), the index was built with 0 dimensions. The first `embedUnembedded` or `reembedAll` call then threw "Vector dimension mismatch: expected 0, got N". Fixed with a private `ensureHnswDims(vec)` helper — mirrors the existing `rebuildHnswFromDisk` pattern — called before the first `hnsw.add` in all four call sites: `embedUnembedded` WAL path, `embedUnembedded` disk `flushDiskBatch`, `reembedAll` WAL path, and `reembedAll` disk `flushDiskBatch`. The helper replaces the index with the correct dimensionality on the first real vector observed.
- **Disk-mode same-session search returns 0 results (#196)** — two-part bug: (1) `materializeCandidates` only called `DiskStore.get(id)`, which reads only compacted Parquet; WAL-only inserts from the current session returned `undefined` and were silently dropped. Fixed with a `walFallback` that reads from the in-memory opslog store when `DiskStore.get` misses. (2) `search()` and `bm25Search()` called `DiskStore.ensureIndexesLoaded()` directly; `ensureIndexesLoaded` calls `textIndex.loadFromJSON()` which **replaces** the in-memory text index, erasing entries for records inserted in the current session. Fixed with a new `Collection.ensureDiskIndexesLoaded()` private method that wraps `ensureIndexesLoaded` and, after loading the persisted index, replays all live (non-expired) WAL entries back into the text index. A `_textIdxLoaded` flag ensures the replay runs only once per session.
- **JSONL filename collision under concurrent appends (#172)** — `writeRecordStore` previously generated filenames as `records-${Date.now()}.jsonl`, which collides when two appends occur within the same millisecond. Replaced with `records-${Date.now()}-${++_fileSeq}.jsonl` using a module-level monotonic counter (`_fileSeq`) that guarantees uniqueness across concurrent calls. 1 updated test (regex now matches the counter suffix) and 1 new test (20 concurrent `Promise.all` calls produce 20 distinct filenames).

### Added
- **README: `_id` exclusion note (#181)** — new "What text gets embedded?" block in the Embeddings section: explains that all `_`-prefixed meta fields (`_id`, `_version`, `_agent`, `_reason`, `_expires`, `_embedding`) are excluded from the text passed to providers; includes a correct vs. wrong query-embedding example; and a v1.3→v1.4 migration callout directing users to `col.reembedAll()` / `db_reembed_all` tool.
- **README: `embeddingBatchSize` + `diskConcurrency` docs (#180)** — new `### Embedding and disk performance knobs` subsection (inserted after BM25 Limits, before Rate Limiting): documents both knobs with defaults, placement rule (AgentDBOptions db-wide / CollectionOptions per-collection), code examples, and S3 sizing guidance for `diskConcurrency` (default 16 prevents per-prefix throttling; raise to ~32 for very high QPS; lower to 8 when sharing a prefix).
- **CLAUDE.md Status paragraph restructured (#179)** — replaced the 2 KB run-on sentence with a short top-line (version, test count), bulleted capability list (search, disk mode, embeddings, config knobs, schemas, tools, write modes), and a pointer to `CHANGELOG.md` for current-cycle details. Package Exports tool count corrected from 38 to 39.
- **Disk-path mid-batch provider failure test (#178)** — new test in `tests/disk-embed.test.ts`: 30 disk records, `batchSize=10` (3 batches), provider throws on call 2. Asserts `embedUnembedded` returns 20 (batches 1 and 3 only); on reopen with a working provider, a second `embedUnembedded` returns exactly 10 (the skipped batch 2 records); third call returns 0 (idempotent). Pins the `flushDiskBatch` continue-on-error path where a failed batch is cleared and execution continues to the next batch.
- **`DiskStore.isLocalFs` direct unit tests (#177)** — 2 new tests in `tests/disk-store.test.ts`: `new DiskStore(new FsBackend()).isLocalFs()` returns `true`; `new DiskStore({} as StorageBackend).isLocalFs()` returns `false`. Pins the `instanceof FsBackend` implementation against future refactors.
- **`DiskStore.appendEmbeddings` direct unit tests (#175)** — 4 new tests in `tests/disk-store.test.ts`: (1) empty input is a no-op (`_dirty` stays false, cache unchanged); (2) single batch sets `_dirty=true`, populates LRU cache (next `get()` is a cache hit), returns embedded record; (3) `recordOffsetIndex` updated and persisted — a fresh store loaded from the same backend resolves the embedded record from JSONL offset; (4) two sequential calls grow `jsonlFiles` by two — verified via a fresh store resolving both embedded records.
- **`appendEmbeddings` precondition assert (#171)** — added JSDoc `@precondition` note and runtime `if (!this.compactionMeta)` guard at the top of `DiskStore.appendEmbeddings`: throws `"appendEmbeddings requires compactionMeta to be initialized (hasParquetData must be true)"` instead of crashing on the `compactionMeta!` spread. Also replaced the non-null assertion (`this.compactionMeta!`) and optional-chain (`this.compactionMeta?.jsonlFiles`) with plain property accesses (now safe after the guard). 2 new tests in `tests/disk-store.test.ts`: throws before first compaction, succeeds after.
- **Unified config knob placement (#170)** — `embeddingBatchSize` added to `AgentDBOptions` as a db-wide default (was only on `SchemaDefinition`/`CollectionOptions`); `cacheSize` and `rowGroupSize` added to `CollectionOptions` as per-collection overrides (was `AgentDBOptions` only). `AgentDB._openCollection` now applies all four knobs via a single merge: db-wide default fills in only when the collection didn't specify one; per-collection value always wins. `DiskStore` construction uses `mergedOpts.cacheSize`/`rowGroupSize`. 1 new test: `AgentDBOptions.embeddingBatchSize: 50` → 3 calls for 120 records; schema-level `embeddingBatchSize: 100` overrides to 2 calls.
- **Single-pass `embedUnembedded` disk scan (#168)** — replaced the two-pass `diskSeen` map (two full `DiskStore.entries()` iterations) with a single streaming pass that maintains a `pending: Map<id, {text, record}>`. Each entry either upserts into `pending` (no `_embedding`) or removes from `pending` (has `_embedding`, meaning a prior append already handled it). Halves S3/disk I/O for the common case. 1 new test: multi-JSONL last-write-wins — 100 records embedded (2 JSONL files), reopen, `embedUnembedded` counts 0 and makes 0 provider calls.
- **`Collection.reembedAll()` + `db_reembed_all` tool** — force-reembeds ALL records in a collection (including already-embedded ones), resetting the HNSW index before re-running the current embedding logic. Use to migrate from v1.3 (where `extractTextFromRecord` incorrectly included `_id` in the embedding text). Does not auto-run on open — call explicitly after upgrading. `db_reembed_all` is an admin-only (DESTRUCTIVE) MCP tool wrapping this method. 4 new tests in `tests/disk-embed.test.ts`: throws without provider, re-embeds all WAL records including already-embedded, HNSW rebuilt (semantic search works after), disk-mode Parquet records all re-embedded.
- **`appendEmbeddings` _dirty fix + JSONL threshold tests** — `appendEmbeddings` now sets `_dirty = true` (was `false`) so close() always compacts after embedding; `DiskStore.compact()` also checks `jsonlFiles.length >= MERGE_JSONL_THRESHOLD` (8) in addition to Parquet file count to trigger a full merge when JSONL files proliferate. Two new tests in `tests/disk-embed.test.ts` verify both behaviors.
- **Strengthened "BM25 arm throws" assertion** — `hybridSearch — arm failure modes` test now spies on `Collection.prototype.bm25Search` and `semanticSearch` via `mock.results[0].value` to confirm: (1) `bm25Search` promise rejected with `IndexFileTooLargeError` (not silently returned `[]`), (2) `semanticSearch` promise resolved with records, (3) final result contains `d1` from the semantic arm only.
- **TTL exclusion in disk-mode `materializeCandidates`** — new test in `tests/hybrid-search.test.ts`: a record inserted with `ttl: 1ms` compacts to disk on close; after reopening (record not in LRU cache) and sleeping past expiry, both `bm25Search` and `hybridSearch` exclude it via `isExpired()` in `materializeCandidates`. Mirrors the existing memory-mode TTL test.
- **`materializeCandidates` mid-pool failure tests** — 3 new tests in `tests/hybrid-search.test.ts`: local-FS `Promise.all` path propagates `ds.get()` rejection out of `bm25Search`; non-FS worker-pool path propagates the same rejection; `hybridSearch` per-arm `.catch(empty)` absorbs the failing arm and returns results from the surviving arm (degraded success, not rejection).
- **Malformed JSONL tests** — 3 new tests in `tests/disk-io.test.ts` pinning `readJsonlStream` throws `SyntaxError` on a truncated line mid-file; `readAllFromJsonl` propagates the same error; `DiskStore.entries({skipCache:true})` propagates `SyntaxError` from a corrupt JSONL file rather than crashing silently.
- **`embeddingBatchSize` on `SchemaDefinition` / `CollectionOptions`** — controls the number of records per embedding provider call in `embedUnembedded` (default 256); exposed via `defineSchema({ embeddingBatchSize })`.
- **`DiskStore.appendEmbeddings()`** — durably appends embedding-updated records to a new JSONL file and registers it in `compactionMeta` without a Parquet rewrite; also updates the LRU cache so subsequent `entries()` calls return the embedded version.
- **Batched `embedUnembedded` for WAL and disk paths** — `embedUnembedded` now processes records in `batchSize` chunks; continues on provider failure (logs warning, skips failed batch); disk path uses a two-pass scan to identify unembedded records and flushes each batch durably via `appendEmbeddings`.
- **`tests/disk-embed.test.ts`** — 5 new tests covering batching (3 provider calls for 600 records with `batchSize=256`, partial-batch failure, custom `batchSize=100`) and durability (1000 disk records with `cacheSize=100` embeddings survive close/reopen, partial embed survives mid-run).

### Changed
- **`embeddingBatchSize` removed from `SchemaDefinition`** — was in the wrong layer alongside `diskConcurrency` which was already moved to `AgentDBOptions` in a prior task. Set via `new AgentDB(dir, { embeddingBatchSize: N })` for a db-wide default or `db.collection("name", { embeddingBatchSize: N })` for a per-collection override. Tests updated accordingly.
- **`findAllRaw` renamed to `findAllForCompaction`** — name encodes intent (preserves meta, internal compaction only); marked `@internal` in JSDoc. Single caller in `agentdb.ts` updated.
- **`readAllFromJsonl` deduped** — now collects from `readJsonlStream` instead of duplicating the line-split parser; removes ~20 lines of identical buffer-scan logic.
- **`diskConcurrency` moved from `SchemaDefinition` to `AgentDBOptions`** — it is now a db-wide default (like `cacheSize`) rather than a per-schema option; `CollectionOptions.diskConcurrency` remains for per-collection overrides. Updated test to pass via `new AgentDB(dir, { diskConcurrency: 3 })`.
- **`defineSchema` throws on non-string `searchable:true` fields** — previously warned and silently excluded the field; now throws `Error` at schema definition time so misconfigured schemas are caught immediately. `tests/searchable-fields.test.ts` updated accordingly.

### Fixed
- **`_id` exclusion regression catcher (#174)** — new integration test in `tests/disk-embed.test.ts`: inserts a record with `agent`/`reason` opts (so `_agent`/`_reason` are stored on the raw record), captures all provider `embed()` calls, asserts the text passed during `embedUnembedded` contains no `_id`/`_agent`/`_reason` values, and asserts it equals the text the caller would use in a `semanticSearch` query. Catches future regressions where one code path leaks meta into embedding text.
- **`extractTextFromRecord` excludes all meta fields (#173)** — previously only excluded `_id`; `_version`, `_agent`, `_reason`, `_expires`, `_embedding` were passed through to the embedding text if the caller did not call `stripMeta` first. Changed the key guard from `key === "_id"` to `key.startsWith("_")`, covering all internal metadata fields as defense in depth. Updated JSDoc. 7 new unit tests in `tests/disk-embed.test.ts`.
- **`validatePersistedSchema` now rejects `searchable:true` on non-string field types (#167)** — previously only checked that `searchable` is a boolean; `{ type: "number", searchable: true }` was silently accepted and persisted via `db_set_schema`, bypassing the `defineSchema`-time check. Now throws the same error shape: `schema 'X': field 'Y' has searchable:true but type 'Z' is not string or string[]`. `db_set_schema` MCP path returns `isError: true`. 2 new tests: `validatePersistedSchema` unit tests (number/boolean throw, string/string[] pass) and `db_set_schema` tool returns isError on non-string searchable field.
- **`DiskStore.isLocalFs()` minifier-unsafe** — `constructor.name === "FsBackend"` is broken by minification; replaced with `instanceof FsBackend` (imported from `@backloghq/opslog`).
- **Embedding-loss on disk-backed collections (N > cacheSize)** — `embedUnembedded` previously wrote embeddings only to the LRU cache; with N > cacheSize, eviction silently dropped embeddings before compaction, causing HNSW rebuild failures on reopen. Fixed by writing each batch durably to disk via `DiskStore.appendEmbeddings` immediately after provider call.
- **`extractTextFromRecord` included `_id` in embedding text** — causing a mismatch between stored embeddings (computed from `"<id> <content>"`) and query embeddings (computed from content only); `_id` is now excluded from text extraction.

### Added
- **Benchmark expansion** — 7 new scenarios in `tests/bench-bm25.test.ts` (all gated behind `BENCH=1` or named env vars): 1M-doc memory cliff (heap delta, per-doc footprint, estimatedBytes ratio, ≤15 GB assertion); imbalanced RRF `[2000, 50]` and `[50, 2000]` (small list must contribute to top-10); concurrent query/write (10+10 `Promise.all` on disk-mode, p99 bounded); update/delete throughput re-index 100K docs; real-embedder hybrid latency via Ollama (gated `OLLAMA_EMBED=1`, p95 relative assertion); S3 disk-mode bm25Search p50/p95 (gated `S3_BENCH=1`, uses S3Backend+DiskStore directly, very loose 10s assertion).
- **Test coverage gaps** — 20 new tests across 3 files: prototype-pollution guards in `TextIndex.loadFromJSON` (terms/docs/per-doc TF maps); `hybridSearch` dedup (same id in both arms appears once); `summary:true` plumbing via `hybridSearch`; one-arm-zero-matches (BM25 vocab miss, inverse); `db_hybrid_search` tool argument forwarding (filter/k/candidateLimit/summary); parameterised non-string `searchable:true` types warn and are excluded (boolean/number/enum/autoIncrement/object); `string[]` accepted; `mergeSchemas` code-wins for `searchable`; `mergePersistedSchemas` overlay-wins for `searchable` (3 cases). Spec #2 (single-char query → `[]`) skipped — behavior changed by Unicode tokenizer (#142, `length > 0` now keeps single-char tokens); spec #6 (disk-mode semantic arm) and #10 (`_id`/`_version` exclusion) already covered.
- **`TextIndex.estimatedBytes()`** — heuristic resident-memory estimate (80 B/doc for TF maps + 32 B per term entry + 64 B/term in inverted index + 24 B/posting-list member); registered with `MemoryMonitor` via `AgentDB.trackMemory` so the text index footprint counts against the configured memory budget. `Collection.stats()` now returns `textIndexBytes`; `AgentDB.stats()` returns aggregate `textIndexBytes`; `db_stats` tool exposes it.
- **Unicode-aware tokenizer** — `tokenize()` in `text-index.ts` switched from ASCII `\w` regex to `[\p{L}\p{M}\p{N}]+/gu`; length filter lowered to `> 0` so single CJK characters survive. Accented Latin (café), CJK (東京), Hangul, and other non-ASCII text is now indexed and searchable. Emoji (not in `\p{L}\p{M}\p{N}`) remain excluded. Single-letter ASCII tokens (`a`, `i`) are now also indexed (minor tradeoff for CJK correctness). 5 new Unicode tests added.
- **`db_bm25_search` MCP tool** — exposes `Collection.bm25Search` via MCP; supports `filter`, `limit`, `candidateLimit`, and `summary`; no embedding provider required. 38 core tools (40 with HTTP).
- **`candidateLimit` param on `db_hybrid_search` tool** — surfaces the existing `Collection.hybridSearch` `candidateLimit` option; controls BM25/vector candidates fetched per arm before filter pruning (default `max(limit*4, 50)`).
- **`Collection.materializeCandidates()`** — private helper factoring the fetch→filter→compute→summarize loop shared by `bm25Search`, `semanticSearch`, and `searchByVector`; disk-mode aware (parallel `Promise.all` via `_diskStore`) vs in-memory path.
- **HNSW rebuild from disk on reopen** — `Collection.rebuildHnswFromDisk()` reconstructs the HNSW index from `_diskStore` entries after a disk-mode open (where `skipLoad=true` prevents the WAL-based HNSW rebuild); called by `AgentDB._openCollection` after `setDiskStore`.
- **Disk-mode hybrid search test** — `tests/hybrid-search.test.ts` extended with a close/reopen disk-mode test asserting both semantic-arm-only and BM25-arm-only docs appear in `hybridSearch` results after reopen.
- **BM25 tuning via schema** — `bm25?: { k1?: number; b?: number }` added to `SchemaDefinition`, `PersistedSchema`, and `CollectionOptions` (`bm25K1`/`bm25B`); `Collection` constructor passes these to `new TextIndex({ k1, b })`; `extractPersistedSchema`, `mergeSchemas` (code wins), `mergePersistedSchemas` (overlay wins), and `validatePersistedSchema` all handle the new field.

### Changed
- **`hybridSearch` candidate amplification fixed** — `armOpts` now passes `candidateLimit` explicitly to both `bm25Search` and `semanticSearch`; previously only `limit: candidateLimit` was passed so each arm re-applied `max(limit*4, 50)` internally, fetching 4× more candidates than the caller intended. `semanticSearch` opts extended with `candidateLimit?: number` to accept the explicit value.
- **Filter type cleanup on `db_semantic_search` / `db_vector_search`** — both tools now cast `args.filter` as `Filter` (matching `db_bm25_search` and `db_hybrid_search`); `db_vector_search` schema replaces the inline `z.union([z.record(...), z.string()])` with the shared `filterParam` import.
- **CLAUDE.md tool count drift fixed** — `Package Exports` block and `tools/` source-layout comment updated from 37 core / 39 HTTP to 38 core / 40 HTTP; test count updated to 1165.
- **Empty-query short-circuit unified** — `semanticSearch` and `hybridSearch` now return `{ records: [], scores: [] }` immediately on empty/whitespace query (before provider call or arm dispatch), matching `bm25Search` behaviour. 4 new tests verify no provider call is made.
- **`DiskStore.entries()` skipCache flag** — `entries(opts?: { skipCache?: boolean })` now accepts a flag that bypasses LRU population while iterating; `Collection.rebuildHnswFromDisk` passes `{ skipCache: true }` so HNSW cold-open rebuilds don't thrash the record cache. 1 new unit test + 1 new BENCH=1-gated heap-delta scenario.
- **`materializeCandidates` concurrency cap for non-FS backends** — `Promise.all` over candidates is now bounded to `diskConcurrency` (default 16) when the backend is not a local filesystem (`DiskStore.isLocalFs()` returns false). Local FS remains unbounded. `diskConcurrency` exposed on `CollectionOptions` and `SchemaDefinition`. 3 new tests: peak in-flight ≤ 16 for non-FS, unbounded path for FS, custom cap via `diskConcurrency: 3`.
- **`Filter` type unified across all search methods** — `bm25Search` and `hybridSearch` `filter` opts now typed as `Filter` (`Record<string, unknown> | string | null | undefined`) matching `semanticSearch` and `searchByVector`; eliminates the narrower `Record<string, unknown> | string` overload.
- **Over-fetch heuristic unified to `Math.max(limit*4, 50)`** — `semanticSearch` and `searchByVector` used `limit*3`; now matches the `bm25Search`/`materializeCandidates` heuristic.

### Added
- **`readJsonlStream` async generator** — `src/disk-io.ts` now exports `readJsonlStream(backend, path)` that yields `[id, record]` pairs one at a time instead of accumulating a full `Map`. Working set collapses from O(buffer + Map) to O(buffer), saving 200–400 MB at 100K-record JSONL files. `DiskStore.entries({ skipCache: true })` routes through `readJsonlStream`; the normal cache-warm path continues to use `readAllFromJsonl`. 2 new unit tests (correct ids at 100 records; heap comparison vs Map path) + 1 BENCH=1-gated scenario at 100K and 1M docs.
- **Round-2 test gaps covered** — 5 new tests: (1) BM25 arm throws `IndexFileTooLargeError` during `hybridSearch` — semantic arm provides results, call does not reject; (2) both arms throw runtime errors — `hybridSearch` returns `{records:[], scores:[]}` rather than rejecting; (3) TTL'd record excluded from `materializeCandidates` — absent from both `bm25Search` and `hybridSearch` after TTL elapses; (4) index load at exactly `MAX_INDEX_FILE_SIZE` succeeds (threshold uses `>`, not `>=`, off-by-one regression catcher); (5) NFC/NFD tokenizer behaviour pinned: no normalisation — precomposed and decomposed forms are distinct tokens; callers must ensure consistent Unicode normalisation.

### Fixed
- **Disk-mode lazy embedding gap** — `embedUnembedded` now also iterates `_diskStore.entries({ skipCache: true })` to find and embed records compacted to Parquet/JSONL without `_embedding`; writes the embedding back via `DiskStore.cacheWrite` (picked up by `findAllRaw` on close). `DiskStore.entries()` now prefers LRU-cached version over JSONL for records updated via `cacheWrite` (using new `RecordCache.peek()`). `findAllRaw()` added to `Collection` for compaction that preserves `_embedding`. Compaction in `agentdb.ts close()` now uses `findAllRaw()` instead of `findAll()` so embeddings survive close/reopen. 3 new end-to-end tests covering: embed disk records count matches N, idempotency, and semantic search returning expected matches after reopen.
- **`_id`/`_version` leaked into BM25 index in fallback mode** — `Collection.textRecord` fallback (no `searchableFields`) returned the full `stripMeta` record, which still contains `_id` and `_version`; now explicitly excludes those keys so UUID tokens and version numbers are never indexed.
- **Semantic search broken in disk mode** — `semanticSearch` and `searchByVector` used `this.store.get(id)` (memory-only opslog store), missing records in Parquet/JSONL; fixed via `materializeCandidates` which checks `_diskStore` first.
- **Sequential disk hydration in BM25 search** — `bm25Search` was awaiting each `_diskStore.get(id)` serially; replaced with parallel `Promise.all` via `materializeCandidates`.
- **`searchByVector` now async** — was synchronous, preventing disk hydration; return type changed to `Promise<{ records, scores }>`.
- **v1→v2 BM25 mixed-corpus ghost results** — `searchScored` was returning v1 docs with score=0, tie-broken by id (silently wrong rank order); v1 placeholder docs (empty tfMap, no TF data) are now skipped. A v1-only corpus returns `[]` from `searchScored`; mixed corpora return only v2-indexed docs. AND-search (`search()`) is unaffected. Each `add()` call upgrades that doc in place.
- **`hybridSearch` per-arm error isolation** — a runtime failure in one arm (e.g. embedding provider throws) no longer rejects the entire call; the failing arm is treated as empty and the other arm's results are returned via RRF as usual.
- **Oversized text-index now throws instead of silently degrading** — `DiskStore._doLoadIndexes` previously warned and skipped the text-index file when it exceeded `MAX_INDEX_FILE_SIZE` (256 MB, ~25–30K docs), causing `bm25Search` to silently return empty results and `hybridSearch` to silently degrade to vector-only. Now throws `IndexFileTooLargeError` (exported from core) so callers see an actionable error. B-tree/array indexes retain the warn+skip behaviour. README "Limits" subsection added under Hybrid Search.

### Added (initial v1.4 work)
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
