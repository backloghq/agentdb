import { z } from "zod";
import type { AgentDB } from "../agentdb.js";

/** A framework-agnostic tool definition. */
export interface AgentTool {
  name: string;
  title: string;
  description: string;
  schema: z.ZodType;
  outputSchema?: z.ZodType;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  execute: (args: unknown) => Promise<ToolResult>;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Shared note appended to descriptions. */
const API_NOTE = " Permissions enforced based on agent identity.";

/** Derive permission level from tool annotations. */
function permLevelFromAnnotations(annotations: { readOnlyHint?: boolean; destructiveHint?: boolean }): "read" | "write" | "admin" {
  if (annotations.destructiveHint) return "admin";
  if (annotations.readOnlyHint) return "read";
  return "write";
}

/** Wrap a handler in error handling, permission checking, and structured output. */
function makeSafe(db: AgentDB, toolName: string, annotations: { readOnlyHint?: boolean; destructiveHint?: boolean }) {
  const level = permLevelFromAnnotations(annotations);
  return (fn: (args: Record<string, unknown>) => Promise<unknown>): (args: unknown) => Promise<ToolResult> => {
    return async (args) => {
      try {
        const agent = (args as Record<string, unknown>).agent as string | undefined;
        db.getPermissions().require(agent, level, toolName);
        const result = await fn(args as Record<string, unknown>);
        const structured = result as Record<string, unknown>;
        return {
          content: [{ type: "text" as const, text: JSON.stringify(structured, null, 2) }],
          structuredContent: structured,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text" as const, text: message }] };
      }
    };
  };
}

// --- Schemas ---

const collectionParam = z.string().describe("Collection name");

const filterParam = z
  .union([z.record(z.unknown()), z.string()])
  .optional()
  .describe("Filter: JSON object ({role: 'admin'}) or compact string ('role:admin age.gt:18')");

const mutationOpts = {
  agent: z.string().optional().describe("Agent identity — who is making this change"),
  reason: z.string().optional().describe("Why this change is being made"),
};

// --- Tool definitions ---

export function getTools(db: AgentDB): AgentTool[] {
  function safe(name: string, annotations: { readOnlyHint?: boolean; destructiveHint?: boolean }) {
    return makeSafe(db, name, annotations);
  }

  /** Standard annotation sets. */
  const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
  const WRITE_IDEMPOTENT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

  return [
    {
      name: "db_collections",
      title: "List Collections",
      description: "List all collections with record counts. Use this first to discover what data is available." + API_NOTE,
      schema: z.object({}),
      outputSchema: z.object({ collections: z.array(z.object({ name: z.string(), recordCount: z.number() })) }),
      annotations: READ,
      execute: safe("db_collections", READ)(async () => {
        return { collections: await db.listCollections() };
      }),
    },

    {
      name: "db_create",
      title: "Create Collection",
      description: "Create a named collection. Idempotent — safe to call if it already exists. Collections are created automatically on first use, but this makes intent explicit." + API_NOTE,
      schema: z.object({ collection: collectionParam }),
      outputSchema: z.object({ created: z.string() }),
      annotations: WRITE_IDEMPOTENT,
      execute: safe("db_create", WRITE_IDEMPOTENT)(async (args) => {
        await db.createCollection(args.collection as string);
        return { created: args.collection };
      }),
    },

    {
      name: "db_drop",
      title: "Drop Collection",
      description: "Soft-delete a collection by renaming it. Data is preserved and can be permanently removed with db_purge. The collection disappears from db_collections but can be recovered." + API_NOTE,
      schema: z.object({ collection: collectionParam }),
      outputSchema: z.object({ dropped: z.string(), recoverable: z.boolean() }),
      annotations: DESTRUCTIVE,
      execute: safe("db_drop", DESTRUCTIVE)(async (args) => {
        await db.dropCollection(args.collection as string);
        return { dropped: args.collection, recoverable: true };
      }),
    },

    {
      name: "db_purge",
      title: "Purge Dropped Collection",
      description: "Permanently delete a previously soft-dropped collection. This cannot be undone. Use db_drop first to soft-delete, then db_purge to permanently erase." + API_NOTE,
      schema: z.object({
        name: z.string().describe("Name of the dropped collection to purge"),
      }),
      outputSchema: z.object({ purged: z.string() }),
      annotations: DESTRUCTIVE,
      execute: safe("db_purge", DESTRUCTIVE)(async (args) => {
        await db.purgeCollection(args.name as string);
        return { purged: args.name };
      }),
    },

    {
      name: "db_insert",
      title: "Insert Records",
      description: "Insert one or more records into a collection. Auto-generates _id if not provided. Use 'record' for single insert, 'records' for batch insert (more efficient — single disk write). Returns the generated _id(s)." + API_NOTE,
      schema: z.object({
        collection: collectionParam,
        record: z.record(z.unknown()).optional().describe("Single record to insert. E.g. {name: 'Alice', role: 'admin'}"),
        records: z.array(z.record(z.unknown())).optional().describe("Multiple records for batch insert (single disk write). E.g. [{name: 'Alice'}, {name: 'Bob'}]"),
        ...mutationOpts,
      }),
      outputSchema: z.object({ ids: z.array(z.string()), inserted: z.number() }),
      annotations: WRITE,
      execute: safe("db_insert", WRITE)(async (args) => {
        const col = await db.collection(args.collection as string);
        const opts = { agent: args.agent as string | undefined, reason: args.reason as string | undefined };
        if (args.records && Array.isArray(args.records)) {
          const ids = await col.insertMany(args.records as Record<string, unknown>[], opts);
          return { ids, inserted: ids.length };
        }
        const record = (args.record ?? {}) as Record<string, unknown>;
        const id = await col.insert(record, opts);
        return { ids: [id], inserted: 1 };
      }),
    },

    {
      name: "db_find",
      title: "Find Records",
      description: "Query records with filter, pagination, and optional summary mode. Use summary:true to scan many records efficiently (omits long text). Use maxTokens to limit response size for context window management. Supports both JSON filters ({role:'admin'}) and compact string filters ('role:admin age.gt:18'). See db_schema to discover field names and types." + API_NOTE,
      schema: z.object({
        collection: collectionParam,
        filter: filterParam,
        limit: z.number().optional().default(50).describe("Max records to return (default 50)"),
        offset: z.number().optional().default(0).describe("Skip N records"),
        summary: z.boolean().optional().default(false).describe("Return summary fields only (omit long text)"),
        maxTokens: z.number().optional().describe("Approximate token budget — stop adding records when estimated tokens exceed this"),
      }),
      outputSchema: z.object({ records: z.array(z.record(z.unknown())), total: z.number(), truncated: z.boolean(), estimatedTokens: z.number().optional() }),
      annotations: READ,
      execute: safe("db_find", READ)(async (args) => {
        const col = await db.collection(args.collection as string);
        return col.find({
          filter: args.filter as Record<string, unknown> | undefined,
          limit: args.limit as number,
          offset: args.offset as number,
          summary: args.summary as boolean,
          maxTokens: args.maxTokens as number | undefined,
        });
      }),
    },

    {
      name: "db_find_one",
      title: "Find One Record",
      description: "Get a single record by its _id. Returns the full record with all fields. Returns null if not found. Use db_find for queries, this tool is for direct ID lookup." + API_NOTE,
      schema: z.object({
        collection: collectionParam,
        id: z.string().describe("Record _id"),
      }),
      outputSchema: z.object({ record: z.record(z.unknown()).nullable(), message: z.string().optional() }),
      annotations: READ,
      execute: safe("db_find_one", READ)(async (args) => {
        const col = await db.collection(args.collection as string);
        const record = col.findOne(args.id as string);
        if (!record) return { record: null, message: "Record not found" };
        return { record };
      }),
    },

    {
      name: "db_update",
      title: "Update Records",
      description: "Update records matching a filter using operators: $set (set fields), $unset (remove fields), $inc (increment numbers), $push (append to arrays). Returns the number of modified records. Use db_find first to preview which records match." + API_NOTE,
      schema: z.object({
        collection: collectionParam,
        filter: z.union([z.record(z.unknown()), z.string()]).describe("Filter: JSON object or compact string"),
        update: z.object({
          $set: z.record(z.unknown()).optional(),
          $unset: z.record(z.unknown()).optional(),
          $inc: z.record(z.number()).optional(),
          $push: z.record(z.unknown()).optional(),
        }).describe("Update operators"),
        ...mutationOpts,
      }),
      outputSchema: z.object({ modified: z.number() }),
      annotations: WRITE,
      execute: safe("db_update", WRITE)(async (args) => {
        const col = await db.collection(args.collection as string);
        const update = args.update as { $set?: Record<string, unknown>; $unset?: Record<string, unknown>; $inc?: Record<string, number>; $push?: Record<string, unknown> };
        const modified = await col.update(
          args.filter as Record<string, unknown>,
          update,
          { agent: args.agent as string | undefined, reason: args.reason as string | undefined },
        );
        return { modified };
      }),
    },

    {
      name: "db_upsert",
      title: "Upsert Record",
      description: "Insert or update a record by ID. If the ID exists, replaces the record; otherwise inserts it. Idempotent — safe to retry. Returns whether the action was 'inserted' or 'updated'." + API_NOTE,
      schema: z.object({
        collection: collectionParam,
        id: z.string().describe("Record _id"),
        record: z.record(z.unknown()).describe("Record data"),
        ...mutationOpts,
      }),
      outputSchema: z.object({ id: z.string(), action: z.enum(["inserted", "updated"]) }),
      annotations: WRITE_IDEMPOTENT,
      execute: safe("db_upsert", WRITE_IDEMPOTENT)(async (args) => {
        const col = await db.collection(args.collection as string);
        return col.upsert(
          args.id as string,
          args.record as Record<string, unknown>,
          { agent: args.agent as string | undefined, reason: args.reason as string | undefined },
        );
      }),
    },

    {
      name: "db_delete",
      title: "Delete Records",
      description: "Permanently delete records matching a filter. Returns the number of deleted records. Use db_find first to preview matches. This cannot be undone except with db_undo (which only reverses the last mutation)." + API_NOTE,
      schema: z.object({
        collection: collectionParam,
        filter: z.record(z.unknown()).describe("Filter to match records to delete"),
        ...mutationOpts,
      }),
      outputSchema: z.object({ deleted: z.number() }),
      annotations: DESTRUCTIVE,
      execute: safe("db_delete", DESTRUCTIVE)(async (args) => {
        const col = await db.collection(args.collection as string);
        const deleted = await col.remove(
          args.filter as Record<string, unknown>,
          { agent: args.agent as string | undefined, reason: args.reason as string | undefined },
        );
        return { deleted };
      }),
    },

    {
      name: "db_batch",
      title: "Batch Operations",
      description: "Execute multiple insert and delete operations atomically within a collection (single disk write). Inserts and deletes are atomic; updates run sequentially after. For bulk data loading, this is much faster than individual inserts." + API_NOTE,
      schema: z.object({
        collection: collectionParam,
        operations: z.array(z.object({
          op: z.enum(["insert", "update", "delete"]).describe("Operation type"),
          id: z.string().optional().describe("Record ID (required for update/delete)"),
          record: z.record(z.unknown()).optional().describe("Record data (for insert)"),
          filter: z.union([z.record(z.unknown()), z.string()]).optional().describe("Filter (for update/delete)"),
          update: z.object({
            $set: z.record(z.unknown()).optional(),
            $unset: z.record(z.unknown()).optional(),
            $inc: z.record(z.number()).optional(),
            $push: z.record(z.unknown()).optional(),
          }).optional().describe("Update operators (for update)"),
        })).describe("Array of operations to execute atomically"),
        ...mutationOpts,
      }),
      outputSchema: z.object({ operations: z.number() }),
      annotations: WRITE,
      execute: safe("db_batch", WRITE)(async (args) => {
        const col = await db.collection(args.collection as string);
        const ops = args.operations as Array<{
          op: string; id?: string; record?: Record<string, unknown>;
          filter?: Record<string, unknown> | string;
          update?: { $set?: Record<string, unknown>; $unset?: Record<string, unknown>; $inc?: Record<string, number>; $push?: Record<string, unknown> };
        }>;
        let opCount = 0;
        await col.batch(() => {
          for (const operation of ops) {
            if (operation.op === "insert" && operation.record) {
              col.insert(operation.record, { agent: args.agent as string | undefined });
              opCount++;
            } else if (operation.op === "delete" && operation.id) {
              col.remove({ _id: operation.id });
              opCount++;
            }
          }
        });
        // Handle updates outside batch (they're async)
        for (const operation of ops) {
          if (operation.op === "update" && operation.filter && operation.update) {
            await col.update(operation.filter, operation.update, { agent: args.agent as string | undefined });
            opCount++;
          }
        }
        return { operations: opCount };
      }),
    },

    {
      name: "db_count",
      title: "Count Records",
      description: "Count records matching an optional filter. Faster than db_find when you only need the count, not the records." + API_NOTE,
      schema: z.object({
        collection: collectionParam,
        filter: filterParam,
      }),
      outputSchema: z.object({ count: z.number() }),
      annotations: READ,
      execute: safe("db_count", READ)(async (args) => {
        const col = await db.collection(args.collection as string);
        return { count: col.count(args.filter as Record<string, unknown> | undefined) };
      }),
    },

    {
      name: "db_undo",
      title: "Undo Last Mutation",
      description: "Undo the last mutation in a collection. Reverses the most recent insert, update, upsert, or delete. Can be called multiple times to undo further back. Returns false if there is nothing to undo (e.g., after a checkpoint)." + API_NOTE,
      schema: z.object({ collection: collectionParam }),
      outputSchema: z.object({ undone: z.boolean(), collection: z.string() }),
      annotations: WRITE,
      execute: safe("db_undo", WRITE)(async (args) => {
        const col = await db.collection(args.collection as string);
        const undone = await col.undo();
        return { undone, collection: args.collection };
      }),
    },

    {
      name: "db_history",
      title: "Record History",
      description: "Get the full mutation history for a specific record by _id. Shows all operations (insert, update, delete) with timestamps, before/after state, and agent identity. Useful for audit trails and understanding how data changed." + API_NOTE,
      schema: z.object({
        collection: collectionParam,
        id: z.string().describe("Record _id"),
      }),
      outputSchema: z.object({ operations: z.array(z.unknown()) }),
      annotations: READ,
      execute: safe("db_history", READ)(async (args) => {
        const col = await db.collection(args.collection as string);
        return { operations: col.history(args.id as string) };
      }),
    },

    {
      name: "db_schema",
      title: "Inspect Schema",
      description: "Inspect the shape of records in a collection by sampling. Reports field names, types (string, number, boolean, array, object), and example values. Use this to understand the data structure before writing queries or filters." + API_NOTE,
      schema: z.object({
        collection: collectionParam,
        sampleSize: z.number().optional().default(50).describe("Number of records to sample"),
      }),
      outputSchema: z.object({ fields: z.array(z.object({ name: z.string(), type: z.string(), example: z.unknown() })), sampleCount: z.number() }),
      annotations: READ,
      execute: safe("db_schema", READ)(async (args) => {
        const col = await db.collection(args.collection as string);
        return col.schema(args.sampleSize as number);
      }),
    },

    {
      name: "db_distinct",
      title: "Distinct Values",
      description: "Get unique values for a specific field across all records in a collection. Supports dot notation for nested fields (e.g. 'metadata.category'). Useful for discovering what values exist before writing filters." + API_NOTE,
      schema: z.object({
        collection: collectionParam,
        field: z.string().describe("Field name (supports dot notation for nested fields)"),
      }),
      outputSchema: z.object({ field: z.string(), values: z.array(z.unknown()), count: z.number() }),
      annotations: READ,
      execute: safe("db_distinct", READ)(async (args) => {
        const col = await db.collection(args.collection as string);
        return col.distinct(args.field as string);
      }),
    },

    {
      name: "db_archive",
      title: "Archive Records",
      description: "Move records matching a filter to cold storage (quarterly archive segments). Archived records are removed from the active set, keeping queries fast. Archives are append-only and read-only. Use db_archive_list to see segments and db_archive_load to view archived data." + API_NOTE,
      schema: z.object({
        collection: collectionParam,
        filter: z.union([z.record(z.unknown()), z.string()]).describe("Filter: JSON object or compact string"),
        segment: z.string().optional().describe("Archive segment name (defaults to current quarter, e.g. 2026-Q2)"),
      }),
      outputSchema: z.object({ archived: z.number() }),
      annotations: DESTRUCTIVE,
      execute: safe("db_archive", DESTRUCTIVE)(async (args) => {
        const col = await db.collection(args.collection as string);
        const archived = await col.archive(
          args.filter as Record<string, unknown> | string,
          args.segment as string | undefined,
        );
        return { archived };
      }),
    },

    {
      name: "db_archive_list",
      title: "List Archive Segments",
      description: "List available archive segments for a collection. Segments are named by time period (e.g. '2026-Q1'). Use db_archive_load to view records in a segment." + API_NOTE,
      schema: z.object({ collection: collectionParam }),
      outputSchema: z.object({ segments: z.array(z.string()) }),
      annotations: READ,
      execute: safe("db_archive_list", READ)(async (args) => {
        const col = await db.collection(args.collection as string);
        return { segments: col.listArchiveSegments() };
      }),
    },

    {
      name: "db_archive_load",
      title: "Load Archived Records",
      description: "Load and view records from an archive segment. Read-only — records are not re-inserted into the active set. Use db_archive_list to discover available segments." + API_NOTE,
      schema: z.object({
        collection: collectionParam,
        segment: z.string().describe("Archive segment name"),
      }),
      outputSchema: z.object({ records: z.array(z.record(z.unknown())), count: z.number() }),
      annotations: READ,
      execute: safe("db_archive_load", READ)(async (args) => {
        const col = await db.collection(args.collection as string);
        const records = await col.loadArchive(args.segment as string);
        return { records, count: records.length };
      }),
    },

    {
      name: "db_semantic_search",
      title: "Semantic Search",
      description: "Search records by meaning using vector embeddings. Pass a natural language query and get the most similar records. Supports hybrid queries: combine semantic similarity with attribute filters. Requires an embedding provider to be configured. Records are lazily embedded on first search." + API_NOTE,
      schema: z.object({
        collection: collectionParam,
        query: z.string().describe("Natural language search query"),
        filter: filterParam,
        limit: z.number().optional().default(10).describe("Max results (default 10)"),
        summary: z.boolean().optional().default(false).describe("Return summary fields only"),
      }),
      outputSchema: z.object({ records: z.array(z.record(z.unknown())), scores: z.array(z.number()) }),
      annotations: READ,
      execute: safe("db_semantic_search", READ)(async (args) => {
        const col = await db.collection(args.collection as string);
        return col.semanticSearch(args.query as string, {
          filter: args.filter as Record<string, unknown> | string | undefined,
          limit: args.limit as number,
          summary: args.summary as boolean,
        });
      }),
    },

    {
      name: "db_embed",
      title: "Embed Records",
      description: "Manually trigger embedding for all unembedded records in a collection. Embeddings are usually generated lazily on first db_semantic_search, but this forces immediate embedding. Requires an embedding provider." + API_NOTE,
      schema: z.object({ collection: collectionParam }),
      outputSchema: z.object({ embedded: z.number() }),
      annotations: WRITE,
      execute: safe("db_embed", WRITE)(async (args) => {
        const col = await db.collection(args.collection as string);
        const count = await col.embedUnembedded();
        return { embedded: count };
      }),
    },

    {
      name: "db_export",
      title: "Export Collections",
      description: "Export all or named collections as a self-contained JSON backup. The export includes all records with their _id fields. Use db_import to restore into a fresh or existing database." + API_NOTE,
      schema: z.object({
        collections: z.array(z.string()).optional().describe("Collection names to export (default: all)"),
      }),
      outputSchema: z.object({ version: z.number(), exportedAt: z.string(), collections: z.record(z.unknown()) }),
      annotations: READ,
      execute: safe("db_export", READ)(async (args) => {
        return db.export(args.collections as string[] | undefined);
      }),
    },

    {
      name: "db_import",
      title: "Import Collections",
      description: "Import collections from a previously exported JSON backup (from db_export). Creates collections if they don't exist. By default, skips records with existing _id; set overwrite:true to replace them." + API_NOTE,
      schema: z.object({
        data: z.object({
          version: z.number(),
          exportedAt: z.string(),
          collections: z.record(z.object({ records: z.array(z.record(z.unknown())) })),
        }).describe("Export data from db_export"),
        overwrite: z.boolean().optional().default(false).describe("Overwrite existing records (default: skip)"),
      }),
      outputSchema: z.object({ collections: z.number(), records: z.number() }),
      annotations: DESTRUCTIVE,
      execute: safe("db_import", DESTRUCTIVE)(async (args) => {
        const data = args.data as { version: number; exportedAt: string; collections: Record<string, { records: Record<string, unknown>[] }> };
        return db.import(data, { overwrite: args.overwrite as boolean });
      }),
    },

    {
      name: "db_stats",
      title: "Database Stats",
      description: "Get database-level statistics: total collections and total records across all collections. Lightweight — does not scan individual records." + API_NOTE,
      schema: z.object({}),
      outputSchema: z.object({ collections: z.number(), totalRecords: z.number() }),
      annotations: READ,
      execute: safe("db_stats", READ)(async () => {
        return db.stats();
      }),
    },
  ];
}
