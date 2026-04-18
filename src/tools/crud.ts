import { z } from "zod";
import type { AgentDB } from "../agentdb.js";
import { makeSafe, getAgent, API_NOTE, collectionParam, filterParam, mutationOpts, READ, WRITE, WRITE_IDEMPOTENT, DESTRUCTIVE } from "./shared.js";
import type { AgentTool } from "./shared.js";

export function getCrudTools(db: AgentDB): AgentTool[] {
  function safe(name: string, annotations: { readOnlyHint?: boolean; destructiveHint?: boolean }) {
    return makeSafe(db, name, annotations);
  }

  return [
    {
      name: "db_insert",
      title: "Insert Records",
      description: "Insert one or more records into a collection. Auto-generates _id if not provided. Use 'record' for single insert, 'records' for batch insert (more efficient — single disk write). Returns the generated _id(s)." + API_NOTE,
      schema: z.object({
        collection: collectionParam,
        record: z.record(z.string(), z.unknown()).optional().meta({ description: "Single record to insert. E.g. {name: 'Alice', role: 'admin'}" }),
        records: z.array(z.record(z.string(), z.unknown())).optional().meta({ description: "Multiple records for batch insert (single disk write). E.g. [{name: 'Alice'}, {name: 'Bob'}]" }),
        ...mutationOpts,
      }),
      outputSchema: z.object({ ids: z.array(z.string()), inserted: z.number() }),
      annotations: WRITE,
      execute: safe("db_insert", WRITE)(async (args) => {
        const col = await db.collection(args.collection as string);
        const opts = { agent: getAgent(args), reason: args.reason as string | undefined };
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
        limit: z.number().optional().default(50).meta({ description: "Max records to return (default 50)" }),
        offset: z.number().optional().default(0).meta({ description: "Skip N records" }),
        summary: z.boolean().optional().default(false).meta({ description: "Return summary fields only (omit long text)" }),
        maxTokens: z.number().optional().meta({ description: "Approximate token budget — stop adding records when estimated tokens exceed this" }),
        sort: z.string().optional().meta({ description: "Sort by field. Prefix with '-' for descending. E.g. 'name' or '-score'. Supports dot notation." }),
      }),
      outputSchema: z.object({ records: z.array(z.record(z.string(), z.unknown())), total: z.number(), truncated: z.boolean(), estimatedTokens: z.number().optional() }),
      annotations: READ,
      execute: safe("db_find", READ)(async (args) => {
        const col = await db.collection(args.collection as string);
        return await col.find({
          filter: args.filter as Record<string, unknown> | undefined,
          limit: args.limit as number,
          offset: args.offset as number,
          summary: args.summary as boolean,
          maxTokens: args.maxTokens as number | undefined,
          sort: args.sort as string | undefined,
        });
      }),
    },

    {
      name: "db_find_one",
      title: "Find One Record",
      description: "Get a single record by its _id. Returns the full record with all fields. Returns null if not found. Use db_find for queries, this tool is for direct ID lookup." + API_NOTE,
      schema: z.object({
        collection: collectionParam,
        id: z.string().meta({ description: "Record _id" }),
      }),
      outputSchema: z.object({ record: z.record(z.string(), z.unknown()).nullable(), message: z.string().optional() }),
      annotations: READ,
      execute: safe("db_find_one", READ)(async (args) => {
        const col = await db.collection(args.collection as string);
        const record = await col.findOne(args.id as string);
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
        filter: z.union([z.record(z.string(), z.unknown()), z.string()]).meta({ description: "Filter: JSON object or compact string" }),
        update: z.object({
          $set: z.record(z.string(), z.unknown()).optional(),
          $unset: z.record(z.string(), z.unknown()).optional(),
          $inc: z.record(z.string(), z.number()).optional(),
          $push: z.record(z.string(), z.unknown()).optional(),
        }).meta({ description: "Update operators" }),
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
          { agent: getAgent(args), reason: args.reason as string | undefined },
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
        id: z.string().meta({ description: "Record _id" }),
        record: z.record(z.string(), z.unknown()).meta({ description: "Record data" }),
        ...mutationOpts,
      }),
      outputSchema: z.object({ id: z.string(), action: z.enum(["inserted", "updated"]) }),
      annotations: WRITE_IDEMPOTENT,
      execute: safe("db_upsert", WRITE_IDEMPOTENT)(async (args) => {
        const col = await db.collection(args.collection as string);
        return col.upsert(
          args.id as string,
          args.record as Record<string, unknown>,
          { agent: getAgent(args), reason: args.reason as string | undefined },
        );
      }),
    },

    {
      name: "db_delete",
      title: "Delete Records",
      description: "Permanently delete records matching a filter. Returns the number of deleted records. Use db_find first to preview matches. This cannot be undone except with db_undo (which only reverses the last mutation)." + API_NOTE,
      schema: z.object({
        collection: collectionParam,
        filter: z.union([z.record(z.string(), z.unknown()), z.string()]).meta({ description: "Filter to match records to delete (JSON object or compact string)" }),
        ...mutationOpts,
      }),
      outputSchema: z.object({ deleted: z.number() }),
      annotations: DESTRUCTIVE,
      execute: safe("db_delete", DESTRUCTIVE)(async (args) => {
        const col = await db.collection(args.collection as string);
        const deleted = await col.remove(
          args.filter as Record<string, unknown>,
          { agent: getAgent(args), reason: args.reason as string | undefined },
        );
        return { deleted };
      }),
    },

    {
      name: "db_batch",
      title: "Batch Operations",
      description: "Execute multiple operations within a collection. Inserts and deletes run atomically in a single batch (one disk write). Updates run sequentially after the batch (not atomic with inserts/deletes). For bulk data loading, this is much faster than individual inserts." + API_NOTE,
      schema: z.object({
        collection: collectionParam,
        operations: z.array(z.object({
          op: z.enum(["insert", "update", "delete"]).meta({ description: "Operation type" }),
          id: z.string().optional().meta({ description: "Record ID (required for update/delete)" }),
          record: z.record(z.string(), z.unknown()).optional().meta({ description: "Record data (for insert)" }),
          filter: z.union([z.record(z.string(), z.unknown()), z.string()]).optional().meta({ description: "Filter (for update/delete)" }),
          update: z.object({
            $set: z.record(z.string(), z.unknown()).optional(),
            $unset: z.record(z.string(), z.unknown()).optional(),
            $inc: z.record(z.string(), z.number()).optional(),
            $push: z.record(z.string(), z.unknown()).optional(),
          }).optional().meta({ description: "Update operators (for update)" }),
        })).meta({ description: "Array of operations to execute atomically" }),
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
              col.insert(operation.record, { agent: getAgent(args) });
              opCount++;
            } else if (operation.op === "delete" && operation.id) {
              col.deleteById(operation.id);
              opCount++;
            }
          }
        });
        // Handle updates outside batch (they're async)
        for (const operation of ops) {
          if (operation.op === "update" && operation.filter && operation.update) {
            await col.update(operation.filter, operation.update, { agent: getAgent(args) });
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
        return { count: await col.count(args.filter as Record<string, unknown> | undefined) };
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
        id: z.string().meta({ description: "Record _id" }),
      }),
      outputSchema: z.object({ operations: z.array(z.unknown()) }),
      annotations: READ,
      execute: safe("db_history", READ)(async (args) => {
        const col = await db.collection(args.collection as string);
        return { operations: col.history(args.id as string) };
      }),
    },

    {
      name: "db_distinct",
      title: "Distinct Values",
      description: "Get unique values for a specific field across all records in a collection. Supports dot notation for nested fields (e.g. 'metadata.category'). Useful for discovering what values exist before writing filters." + API_NOTE,
      schema: z.object({
        collection: collectionParam,
        field: z.string().meta({ description: "Field name (supports dot notation for nested fields)" }),
      }),
      outputSchema: z.object({ field: z.string(), values: z.array(z.unknown()), count: z.number() }),
      annotations: READ,
      execute: safe("db_distinct", READ)(async (args) => {
        const col = await db.collection(args.collection as string);
        return col.distinct(args.field as string);
      }),
    },
  ];
}
