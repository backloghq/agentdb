# AgentDB

AI-first embedded database for LLM agents. Library-first architecture: core library, framework-agnostic tool definitions, MCP adapter. Built on top of opslog (`@backloghq/opslog`).

**Status:** Phase 1 complete (226 tests). Local development only — not published, no remote repo.

## Commands

```bash
npm run build          # tsc
npm run lint           # eslint src/ tests/
npm test               # vitest run
npm run test:coverage  # vitest coverage
```

## Coding Conventions

- Zero native dependencies — pure TypeScript, only Node.js built-ins + opslog
- Always look up library/framework docs via Context7 before using APIs
- Lint before committing — all code must pass eslint
- Tests for everything — aim for high coverage, run `test:coverage` to verify
- Tests use temp directories, cleaned up after each test
- Update `CHANGELOG.md` on every change ([Keep a Changelog](https://keepachangelog.com) format)
- Errors in tools return `{ isError: true, content: [...] }`, never throw across the tool boundary
- NOTES.md is gitignored — it's a private design doc, not shipped

## Package Exports

```
agentdb          — core library (AgentDB, Collection, compileFilter, parseCompactFilter)
agentdb/tools    — framework-agnostic tool definitions (getTools → { name, schema, execute }[])
agentdb/mcp      — MCP server adapter (createMcpServer, startStdio)
```

## Source Layout

```
src/
  index.ts              # Core exports
  agentdb.ts            # AgentDB class: collection manager, lazy loading, LRU, meta-manifest
  collection.ts         # Collection class: CRUD, update ops, agent identity, find, schema, distinct
  filter.ts             # JSON filter compiler (14 operators, dot-notation)
  compact-filter.ts     # Compact string parser (role:admin age.gt:18)
  tools/index.ts        # 16 tool definitions with zod schemas + safe() wrapper
  mcp/index.ts          # MCP server wrapping tool definitions
  mcp/cli.ts            # CLI entry point: npx agentdb --path ./data
```

## Key Design Decisions

- Library-first, MCP is just an adapter — see NOTES.md
- opslog Store per collection, lazy-loaded with LRU eviction
- JSON filter syntax primary, compact string syntax secondary
- Progressive disclosure on queries (summary mode, pagination)
- Agent identity + reason on every mutation (stored as _agent/_reason, stripped on read)
- Phase 2 direction: collection middleware (validate, computed fields, virtual filters) — inspired by backlog engine pattern
