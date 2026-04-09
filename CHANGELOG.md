# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com),
and this project adheres to [Semantic Versioning](https://semver.org).

## [0.1.0] - Unreleased

### Added

- Project scaffold with triple entry points (`agentdb`, `agentdb/tools`, `agentdb/mcp`)
- TypeScript build configuration matching opslog conventions
- ESLint configuration with typescript-eslint
- Vitest test runner setup with coverage
- Generic JSON filter compiler (`compileFilter`) with 14 operators: `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$contains`, `$startsWith`, `$endsWith`, `$exists`, `$regex`, `$not`, `$and`, `$or`
- Dot-notation nested field access in filters
- `Collection` class wrapping opslog Store: insert, insertMany, findOne, find, count, update, upsert, remove
- Update operators: `$set`, `$unset`, `$inc`, `$push`
- Agent identity on mutations (`agent` + `reason` fields, visible in operation history)
- Progressive disclosure on `find` (summary mode omits long text fields)
- Pagination on `find` (limit/offset with truncated flag and total count)
- Per-collection undo and record history
- `schema()` — sample records and report field names, types, examples
- `distinct()` — unique values for a field with dot-notation support
- `AgentDB` class with collection manager: lazy loading, LRU eviction, configurable limits
- Collection soft-delete (`dropCollection`) and permanent purge (`purgeCollection`)
- Meta-manifest for collection registry, persisted across restarts
- 16 framework-agnostic tool definitions (`agentdb/tools`): db_collections, db_create, db_drop, db_purge, db_insert, db_find, db_find_one, db_update, db_upsert, db_delete, db_count, db_undo, db_history, db_schema, db_distinct, db_stats
- `getTools(db)` returns `{ name, description, schema, annotations, execute }` objects consumable by any agent framework
- `safe()` error wrapper — tools return `{ isError: true }` on failure, never throw
- MCP adapter (`agentdb/mcp`): `createMcpServer(db)` wraps tool definitions as MCP tools
- CLI entry point: `npx agentdb --path ./data` starts MCP server on stdio
- Compact string filter parser (`parseCompactFilter`): `role:admin`, `age.gt:18`, `(role:admin or role:mod)`, 20+ modifier aliases
