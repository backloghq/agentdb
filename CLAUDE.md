# AgentDB

AI-first embedded database for LLM agents. Library-first architecture: core library, framework-agnostic tool definitions, MCP adapter. Built on opslog (`@backloghq/opslog`) with optional S3 backend (`@backloghq/opslog-s3`).

**Status:** All phases complete. 611 tests, 28 tools (26 core + db_subscribe/db_unsubscribe on HTTP). 5 runnable demos. Auth + security hardened. Group commit ~12x faster writes. Sorted-array indexed queries with range support ($gt/$lt/$gte/$lte). Count-from-index fast path. Predicate cache. HNSW MaxHeap optimized. Incremental index rebuild on tail/watch/undo. Sort on find. MCP tools have titles, outputSchemas, structuredContent, all 4 annotation hints.

## Commands

```bash
npm run build          # tsc
npm run lint           # eslint src/ tests/
npm test               # vitest run
npm run test:coverage  # vitest coverage
```

## Coding Conventions

- Zero native dependencies — pure TypeScript/JS. Core uses opslog only; tools add zod; MCP adds express, jose, @modelcontextprotocol/sdk
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
agentdb/tools    — framework-agnostic tool definitions (getTools → 24 tools)
agentdb/mcp      — MCP server adapter (stdio + HTTP/Streamable transport)
```

## Source Layout

```
src/
  index.ts              # Core exports
  agentdb.ts            # AgentDB class: collection manager, lazy loading, LRU, memory monitor
  collection.ts         # Collection: CRUD, middleware, search, views, TTL, tailing (~1130 lines)
  collection-helpers.ts # Pure utilities: stripMeta, isExpired, applyUpdate, compositeKey, filter cache
  collection-indexes.ts # IndexManager: B-tree, composite, bloom filter indexes + query planning
  filter.ts             # JSON filter compiler (14 operators, dot-notation)
  compact-filter.ts     # Compact string parser (role:admin age.gt:18)
  hnsw.ts               # HNSW index for approximate nearest neighbor search
  btree.ts              # Sorted-array index + query frequency tracker
  bloom.ts              # Bloom filter for probabilistic existence checks
  text-index.ts         # Inverted index for full-text search
  view.ts               # Named views with cache invalidation
  permissions.ts        # Per-agent permission manager
  memory.ts             # Memory monitor with per-collection budgets
  embeddings/
    types.ts            # EmbeddingProvider interface
    openai.ts           # OpenAI embedding provider
    ollama.ts           # Ollama local embedding provider
    voyage.ts           # Voyage AI embedding provider
    cohere.ts           # Cohere embedding provider
    http.ts             # Custom HTTP embedding provider
    quantize.ts         # Int8 quantization for vector storage
    index.ts            # Provider factory
  tools/index.ts        # 26 tool definitions with zod schemas + safe() wrapper (28 total with db_subscribe/db_unsubscribe on HTTP)
  mcp/index.ts          # MCP server (stdio + HTTP/Streamable transport)
  mcp/auth.ts           # Auth middleware (bearer token, rate limiter, audit logger)
  mcp/jwt.ts            # JWT validation with jose
  mcp/subscriptions.ts  # NOTIFY/LISTEN: SubscriptionManager for real-time change notifications
  mcp/cli.ts            # CLI: npx agentdb --path ./data [--backend s3 --bucket ...]
```

## Key Design Decisions

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
