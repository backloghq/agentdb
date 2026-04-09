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
      description: "Create a collection. Idempotent — safe to call if it already exists.",
      schema: z.object({ collection: collectionParam }),
      annotations: WRITE_IDEMPOTENT,
      execute: safe("db_create", WRITE_IDEMPOTENT)(async (args) => {
        await db.createCollection(args.collection as string);
        return { created: args.collection };
      }),
    },

    {
      name: "db_drop",
      title: "Drop Collection",
      description: "Soft-delete a collection. Can be recovered with db_purge. Use db_purge to permanently delete.",
      schema: z.object({ collection: collectionParam }),
      annotations: DESTRUCTIVE,
      execute: safe("db_drop", DESTRUCTIVE)(async (args) => {
        await db.dropCollection(args.collection as string);
        return { dropped: args.collection, recoverable: true };
      }),
    },

    {
      name: "db_purge",
      title: "Purge Dropped Collection",
      description: "Permanently delete a soft-dropped collection. This cannot be undone.",
      schema: z.object({
        name: z.string().describe("Name of the dropped collection to purge"),
      }),
      annotations: DESTRUCTIVE,
      execute: safe("db_purge", DESTRUCTIVE)(async (args) => {
        await db.purgeCollection(args.name as string);
        return { purged: args.name };
      }),
    },

    {
      name: "db_insert",
      title: "Insert Records",
      description: "Insert one or more records into a collection. Auto-generates _id if not provided.",
      schema: z.object({
        collection: collectionParam,
        record: z.record(z.unknown()).optional().describe("Single record to insert"),
        records: z.array(z.record(z.unknown())).optional().describe("Multiple records to insert"),
        ...mutationOpts,
      }),
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
      description: "Query records with filter, pagination, and optional summary mode. Returns matching records.",
      schema: z.object({
        collection: collectionParam,
        filter: filterParam,
        limit: z.number().optional().default(50).describe("Max records to return (default 50)"),
        offset: z.number().optional().default(0).describe("Skip N records"),
        summary: z.boolean().optional().default(false).describe("Return summary fields only (omit long text)"),
        maxTokens: z.number().optional().describe("Approximate token budget — stop adding records when estimated tokens exceed this"),
      }),
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
      description: "Get a single record by its _id. Returns the full record.",
      schema: z.object({
        collection: collectionParam,
        id: z.string().describe("Record _id"),
      }),
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
      description: "Update records matching a filter. Supports $set, $unset, $inc, $push operators.",
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
      description: "Insert or update a record by ID. If the ID exists, updates it; otherwise inserts.",
      schema: z.object({
        collection: collectionParam,
        id: z.string().describe("Record _id"),
        record: z.record(z.unknown()).describe("Record data"),
        ...mutationOpts,
      }),
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
      description: "Delete records matching a filter. Returns the number of deleted records.",
      schema: z.object({
        collection: collectionParam,
        filter: z.record(z.unknown()).describe("Filter to match records to delete"),
        ...mutationOpts,
      }),
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
      description: "Execute multiple insert and delete operations atomically within a collection (single disk write). Updates run sequentially after the batch.",
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
      description: "Count records matching a filter. Returns total count.",
      schema: z.object({
        collection: collectionParam,
        filter: filterParam,
      }),
      annotations: READ,
      execute: safe("db_count", READ)(async (args) => {
        const col = await db.collection(args.collection as string);
        return { count: col.count(args.filter as Record<string, unknown> | undefined) };
      }),
    },

    {
      name: "db_undo",
      title: "Undo Last Mutation",
      description: "Undo the last mutation in a collection.",
      schema: z.object({ collection: collectionParam }),
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
      description: "Get mutation history for a specific record. Shows all operations with before/after state.",
      schema: z.object({
        collection: collectionParam,
        id: z.string().describe("Record _id"),
      }),
      annotations: READ,
      execute: safe("db_history", READ)(async (args) => {
        const col = await db.collection(args.collection as string);
        return { operations: col.history(args.id as string) };
      }),
    },

    {
      name: "db_schema",
      title: "Inspect Schema",
      description: "Inspect the shape of records in a collection. Samples records and reports field names, types, and examples.",
      schema: z.object({
        collection: collectionParam,
        sampleSize: z.number().optional().default(50).describe("Number of records to sample"),
      }),
      annotations: READ,
      execute: safe("db_schema", READ)(async (args) => {
        const col = await db.collection(args.collection as string);
        return col.schema(args.sampleSize as number);
      }),
    },

    {
      name: "db_distinct",
      title: "Distinct Values",
      description: "Get unique values for a field across all records in a collection.",
      schema: z.object({
        collection: collectionParam,
        field: z.string().describe("Field name (supports dot notation for nested fields)"),
      }),
      annotations: READ,
      execute: safe("db_distinct", READ)(async (args) => {
        const col = await db.collection(args.collection as string);
        return col.distinct(args.field as string);
      }),
    },

    {
      name: "db_archive",
      title: "Archive Records",
      description: "Archive records matching a filter to cold storage. Archived records are removed from the active set.",
      schema: z.object({
        collection: collectionParam,
        filter: z.union([z.record(z.unknown()), z.string()]).describe("Filter: JSON object or compact string"),
        segment: z.string().optional().describe("Archive segment name (defaults to current quarter, e.g. 2026-Q2)"),
      }),
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
      description: "List available archive segments for a collection.",
      schema: z.object({ collection: collectionParam }),
      annotations: READ,
      execute: safe("db_archive_list", READ)(async (args) => {
        const col = await db.collection(args.collection as string);
        return { segments: col.listArchiveSegments() };
      }),
    },

    {
      name: "db_archive_load",
      title: "Load Archived Records",
      description: "Load and view records from an archive segment. Read-only — records are not re-inserted.",
      schema: z.object({
        collection: collectionParam,
        segment: z.string().describe("Archive segment name"),
      }),
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
      description: "Search records by meaning using embeddings. Requires an embedding provider. Supports hybrid queries with attribute filters.",
      schema: z.object({
        collection: collectionParam,
        query: z.string().describe("Natural language search query"),
        filter: filterParam,
        limit: z.number().optional().default(10).describe("Max results (default 10)"),
        summary: z.boolean().optional().default(false).describe("Return summary fields only"),
      }),
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
      description: "Manually trigger embedding for all unembedded records in a collection. Requires an embedding provider.",
      schema: z.object({ collection: collectionParam }),
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
      description: "Export all or named collections as a self-contained JSON backup.",
      schema: z.object({
        collections: z.array(z.string()).optional().describe("Collection names to export (default: all)"),
      }),
      annotations: READ,
      execute: safe("db_export", READ)(async (args) => {
        return db.export(args.collections as string[] | undefined);
      }),
    },

    {
      name: "db_import",
      title: "Import Collections",
      description: "Import collections from a previously exported JSON backup.",
      schema: z.object({
        data: z.object({
          version: z.number(),
          exportedAt: z.string(),
          collections: z.record(z.object({ records: z.array(z.record(z.unknown())) })),
        }).describe("Export data from db_export"),
        overwrite: z.boolean().optional().default(false).describe("Overwrite existing records (default: skip)"),
      }),
      annotations: DESTRUCTIVE,
      execute: safe("db_import", DESTRUCTIVE)(async (args) => {
        const data = args.data as { version: number; exportedAt: string; collections: Record<string, { records: Record<string, unknown>[] }> };
        return db.import(data, { overwrite: args.overwrite as boolean });
      }),
    },

    {
      name: "db_stats",
      title: "Database Stats",
      description: "Get database-level statistics: number of collections and total records.",
      schema: z.object({}),
      annotations: READ,
      execute: safe("db_stats", READ)(async () => {
        return db.stats();
      }),
    },
  ];
}
