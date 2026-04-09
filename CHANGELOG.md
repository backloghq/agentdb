# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com),
and this project adheres to [Semantic Versioning](https://semver.org).

## [0.1.0] - 2026-04-09

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
