import { z } from "zod";
import type { AgentDB } from "../agentdb.js";

/** A framework-agnostic tool definition. */
export interface AgentTool {
  name: string;
  description: string;
  schema: z.ZodType;
  annotations: {
    readOnly?: boolean;
    destructive?: boolean;
    idempotent?: boolean;
  };
  execute: (args: unknown) => Promise<ToolResult>;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** Wrap a handler in error handling. */
function safe(fn: (args: Record<string, unknown>) => Promise<unknown>): (args: unknown) => Promise<ToolResult> {
  return async (args) => {
    try {
      const result = await fn(args as Record<string, unknown>);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text" as const, text: message }] };
    }
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
  return [
    {
      name: "db_collections",
      description: "List all collections with record counts.",
      schema: z.object({}),
      annotations: { readOnly: true },
      execute: safe(async () => {
        return { collections: await db.listCollections() };
      }),
    },

    {
      name: "db_create",
      description: "Create a collection. Idempotent — safe to call if it already exists.",
      schema: z.object({ collection: collectionParam }),
      annotations: { idempotent: true },
      execute: safe(async (args) => {
        await db.createCollection(args.collection as string);
        return { created: args.collection };
      }),
    },

    {
      name: "db_drop",
      description: "Soft-delete a collection. Can be recovered with db_purge. Use db_purge to permanently delete.",
      schema: z.object({ collection: collectionParam }),
      annotations: { destructive: true },
      execute: safe(async (args) => {
        await db.dropCollection(args.collection as string);
        return { dropped: args.collection, recoverable: true };
      }),
    },

    {
      name: "db_purge",
      description: "Permanently delete a soft-dropped collection. This cannot be undone.",
      schema: z.object({
        name: z.string().describe("Name of the dropped collection to purge"),
      }),
      annotations: { destructive: true },
      execute: safe(async (args) => {
        await db.purgeCollection(args.name as string);
        return { purged: args.name };
      }),
    },

    {
      name: "db_insert",
      description: "Insert one or more records into a collection. Auto-generates _id if not provided.",
      schema: z.object({
        collection: collectionParam,
        record: z.record(z.unknown()).optional().describe("Single record to insert"),
        records: z.array(z.record(z.unknown())).optional().describe("Multiple records to insert"),
        ...mutationOpts,
      }),
      annotations: {},
      execute: safe(async (args) => {
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
      description: "Query records with filter, pagination, and optional summary mode. Returns matching records.",
      schema: z.object({
        collection: collectionParam,
        filter: filterParam,
        limit: z.number().optional().default(50).describe("Max records to return (default 50)"),
        offset: z.number().optional().default(0).describe("Skip N records"),
        summary: z.boolean().optional().default(false).describe("Return summary fields only (omit long text)"),
        maxTokens: z.number().optional().describe("Approximate token budget — stop adding records when estimated tokens exceed this"),
      }),
      annotations: { readOnly: true },
      execute: safe(async (args) => {
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
      description: "Get a single record by its _id. Returns the full record.",
      schema: z.object({
        collection: collectionParam,
        id: z.string().describe("Record _id"),
      }),
      annotations: { readOnly: true },
      execute: safe(async (args) => {
        const col = await db.collection(args.collection as string);
        const record = col.findOne(args.id as string);
        if (!record) return { record: null, message: "Record not found" };
        return { record };
      }),
    },

    {
      name: "db_update",
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
      annotations: {},
      execute: safe(async (args) => {
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
      description: "Insert or update a record by ID. If the ID exists, updates it; otherwise inserts.",
      schema: z.object({
        collection: collectionParam,
        id: z.string().describe("Record _id"),
        record: z.record(z.unknown()).describe("Record data"),
        ...mutationOpts,
      }),
      annotations: { idempotent: true },
      execute: safe(async (args) => {
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
      description: "Delete records matching a filter. Returns the number of deleted records.",
      schema: z.object({
        collection: collectionParam,
        filter: z.record(z.unknown()).describe("Filter to match records to delete"),
        ...mutationOpts,
      }),
      annotations: { destructive: true },
      execute: safe(async (args) => {
        const col = await db.collection(args.collection as string);
        const deleted = await col.remove(
          args.filter as Record<string, unknown>,
          { agent: args.agent as string | undefined, reason: args.reason as string | undefined },
        );
        return { deleted };
      }),
    },

    {
      name: "db_count",
      description: "Count records matching a filter. Returns total count.",
      schema: z.object({
        collection: collectionParam,
        filter: filterParam,
      }),
      annotations: { readOnly: true },
      execute: safe(async (args) => {
        const col = await db.collection(args.collection as string);
        return { count: col.count(args.filter as Record<string, unknown> | undefined) };
      }),
    },

    {
      name: "db_undo",
      description: "Undo the last mutation in a collection.",
      schema: z.object({ collection: collectionParam }),
      annotations: {},
      execute: safe(async (args) => {
        const col = await db.collection(args.collection as string);
        const undone = await col.undo();
        return { undone, collection: args.collection };
      }),
    },

    {
      name: "db_history",
      description: "Get mutation history for a specific record. Shows all operations with before/after state.",
      schema: z.object({
        collection: collectionParam,
        id: z.string().describe("Record _id"),
      }),
      annotations: { readOnly: true },
      execute: safe(async (args) => {
        const col = await db.collection(args.collection as string);
        return { operations: col.history(args.id as string) };
      }),
    },

    {
      name: "db_schema",
      description: "Inspect the shape of records in a collection. Samples records and reports field names, types, and examples.",
      schema: z.object({
        collection: collectionParam,
        sampleSize: z.number().optional().default(50).describe("Number of records to sample"),
      }),
      annotations: { readOnly: true },
      execute: safe(async (args) => {
        const col = await db.collection(args.collection as string);
        return col.schema(args.sampleSize as number);
      }),
    },

    {
      name: "db_distinct",
      description: "Get unique values for a field across all records in a collection.",
      schema: z.object({
        collection: collectionParam,
        field: z.string().describe("Field name (supports dot notation for nested fields)"),
      }),
      annotations: { readOnly: true },
      execute: safe(async (args) => {
        const col = await db.collection(args.collection as string);
        return col.distinct(args.field as string);
      }),
    },

    {
      name: "db_stats",
      description: "Get database-level statistics: number of collections and total records.",
      schema: z.object({}),
      annotations: { readOnly: true },
      execute: safe(async () => {
        return db.stats();
      }),
    },
  ];
}
