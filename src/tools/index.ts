import { z } from "zod";
import type { AgentDB } from "../agentdb.js";
import { getCurrentAuth } from "../auth-context.js";
import { mergePersistedSchemas, validatePersistedSchema } from "../schema.js";

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
        // Prefer authenticated identity from HTTP auth over self-reported args.agent
        const authId = getCurrentAuth();
        const agent = authId?.agentId ?? (args as Record<string, unknown>).agent as string | undefined;
        db.getPermissions().require(agent, level, toolName);
        const result = await fn(args as Record<string, unknown>);
        const structured = result as Record<string, unknown>;
        return {
          content: [{ type: "text" as const, text: JSON.stringify(structured, null, 2) }],
          structuredContent: structured,
        };
      } catch (err) {
        let message = err instanceof Error ? err.message : String(err);
        // Sanitize filesystem paths from error messages
        message = message.replace(/\/[^\s'":]+\//g, "<path>/");
        return { isError: true, content: [{ type: "text" as const, text: message }] };
      }
    };
  };
}

// --- Schemas ---

const collectionParam = z.string().meta({ description: "Collection name" });

const filterParam = z
  .union([z.record(z.string(), z.unknown()), z.string()])
  .optional()
  .meta({ description: "Filter: JSON object ({role: 'admin'}) or compact string ('role:admin age.gt:18')" });

const mutationOpts = {
  agent: z.string().optional().meta({ description: "Agent identity — who is making this change" }),
  reason: z.string().optional().meta({ description: "Why this change is being made" }),
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
      description: "List all collections with record counts and schema summaries. Use this first to discover what data is available and how collections are structured." + API_NOTE,
      schema: z.object({}),
      outputSchema: z.object({ collections: z.array(z.object({
        name: z.string(),
        recordCount: z.number(),
        schema: z.object({
          description: z.string().optional(),
          fieldCount: z.number(),
          hasInstructions: z.boolean(),
          version: z.number().optional(),
        }).optional(),
      })) }),
      annotations: READ,
      execute: safe("db_collections", READ)(async () => {
        const infos = await db.listCollections();
        const collections = await Promise.all(infos.map(async (info) => {
          const persisted = await db.loadPersistedSchema(info.name);
          return {
            ...info,
            ...(persisted ? {
              schema: {
                description: persisted.description,
                fieldCount: persisted.fields ? Object.keys(persisted.fields).length : 0,
                hasInstructions: !!persisted.instructions,
                version: persisted.version,
              },
            } : {}),
          };
        }));
        return { collections };
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
        name: z.string().meta({ description: "Name of the dropped collection to purge" }),
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
        record: z.record(z.string(), z.unknown()).optional().meta({ description: "Single record to insert. E.g. {name: 'Alice', role: 'admin'}" }),
        records: z.array(z.record(z.string(), z.unknown())).optional().meta({ description: "Multiple records for batch insert (single disk write). E.g. [{name: 'Alice'}, {name: 'Bob'}]" }),
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
        filter: z.union([z.record(z.string(), z.unknown()), z.string()]).meta({ description: "Filter to match records to delete (JSON object or compact string)" }),
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
              col.insert(operation.record, { agent: args.agent as string | undefined });
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
      name: "db_schema",
      title: "Inspect Schema",
      description: "Inspect the shape of records in a collection by sampling. Reports field names, types (string, number, boolean, array, object), and example values. Use this to understand the data structure before writing queries or filters." + API_NOTE,
      schema: z.object({
        collection: collectionParam,
        sampleSize: z.number().optional().default(50).meta({ description: "Number of records to sample" }),
      }),
      outputSchema: z.object({ fields: z.array(z.object({ name: z.string(), type: z.string(), example: z.unknown() })), sampleCount: z.number() }),
      annotations: READ,
      execute: safe("db_schema", READ)(async (args) => {
        const col = await db.collection(args.collection as string);
        return col.schema(args.sampleSize as number);
      }),
    },

    {
      name: "db_get_schema",
      title: "Get Collection Schema",
      description: "Get the persisted schema for a collection including field definitions, descriptions, instructions, and indexes. Use this to understand what data a collection holds, how fields should be used, and what indexes are available. Returns null if no schema has been defined." + API_NOTE,
      schema: z.object({
        collection: collectionParam,
      }),
      outputSchema: z.object({
        schema: z.unknown().meta({ description: "Persisted schema or null" }),
        hasCodeSchema: z.boolean().meta({ description: "Whether a code-level schema is also active" }),
      }),
      annotations: READ,
      execute: safe("db_get_schema", READ)(async (args) => {
        const name = args.collection as string;
        const schema = await db.loadPersistedSchema(name);
        const hasCodeSchema = db.getSchema(name) !== undefined;
        return { schema: schema ?? null, hasCodeSchema };
      }),
    },

    {
      name: "db_set_schema",
      title: "Set Collection Schema",
      description: "Create or update the persisted schema for a collection. Requires admin permission. The schema defines field types, descriptions, instructions for agents, and index configuration. Partial updates are merged with the existing schema." + API_NOTE,
      schema: z.object({
        collection: collectionParam,
        schema: z.object({
          version: z.number().optional().meta({ description: "Schema version number" }),
          description: z.string().optional().meta({ description: "What this collection is for" }),
          instructions: z.string().optional().meta({ description: "Instructions for agents on how to use this collection" }),
          fields: z.record(z.string(), z.object({
            type: z.enum(["string", "number", "boolean", "date", "enum", "string[]", "number[]", "object", "autoIncrement"]).meta({ description: "Field data type" }),
            required: z.boolean().optional().meta({ description: "Field is required on insert" }),
            default: z.unknown().optional().meta({ description: "Default value when not provided" }),
            values: z.array(z.string()).optional().meta({ description: "Allowed values for enum type" }),
            maxLength: z.number().optional().meta({ description: "Max string length" }),
            min: z.number().optional().meta({ description: "Min for numbers" }),
            max: z.number().optional().meta({ description: "Max for numbers" }),
            description: z.string().optional().meta({ description: "Human-readable field description for agent discovery" }),
          })).optional().meta({ description: "Field definitions" }),
          indexes: z.array(z.string()).optional().meta({ description: "Fields to create B-tree indexes on" }),
          compositeIndexes: z.array(z.array(z.string())).optional().meta({ description: "Composite indexes" }),
          arrayIndexes: z.array(z.string()).optional().meta({ description: "Array-element indexes for $contains queries" }),
          tagField: z.string().optional().meta({ description: "Array field for +tag/-tag compact filter syntax" }),
          storageMode: z.enum(["memory", "disk", "auto"]).optional().meta({ description: "Storage mode" }),
        }).meta({ description: "Schema definition (partial updates merged with existing)" }),
        ...mutationOpts,
      }),
      outputSchema: z.object({
        schema: z.unknown().meta({ description: "The resulting persisted schema after merge" }),
      }),
      annotations: DESTRUCTIVE,
      execute: safe("db_set_schema", DESTRUCTIVE)(async (args) => {
        const name = args.collection as string;
        const input = args.schema as Record<string, unknown>;
        const agent = args.agent as string | undefined;

        // Build the schema to persist
        const incoming = { name, ...input } as import("../schema.js").PersistedSchema;

        const existing = await db.loadPersistedSchema(name);
        const schema = existing ? mergePersistedSchemas(existing, incoming) : incoming;
        await db.persistSchema(name, schema, { agent });
        return { schema };
      }),
    },

    {
      name: "db_delete_schema",
      title: "Delete Collection Schema",
      description: "Delete the persisted schema for a collection. Requires admin permission. Idempotent — succeeds even if no schema exists. Does not affect the collection's data or in-memory code schema." + API_NOTE,
      schema: z.object({
        collection: collectionParam,
        ...mutationOpts,
      }),
      outputSchema: z.object({
        deleted: z.boolean().meta({ description: "True if a schema existed and was removed, false if there was nothing to delete" }),
      }),
      annotations: DESTRUCTIVE,
      execute: safe("db_delete_schema", DESTRUCTIVE)(async (args) => {
        const name = args.collection as string;
        const agent = args.agent as string | undefined;
        const existed = (await db.loadPersistedSchema(name)) !== undefined;
        await db.deletePersistedSchema(name, { agent });
        return { deleted: existed };
      }),
    },

    {
      name: "db_diff_schema",
      title: "Diff Schema",
      description: "Preview what db_set_schema would change before committing. Uses the same merge semantics as db_set_schema — partial candidates correctly show no-change for omitted fields. Returns structured diff (added/removed/changed fields and indexes) with warnings about data impact (type changes, required fields, enum removals, tightened constraints). includeImpact:true (default) queries the collection for affected record counts." + API_NOTE,
      schema: z.object({
        collection: collectionParam,
        schema: z.object({
          version: z.number().optional().meta({ description: "Schema version number" }),
          description: z.string().optional().meta({ description: "What this collection is for" }),
          instructions: z.string().optional().meta({ description: "Instructions for agents on how to use this collection" }),
          fields: z.record(z.string(), z.object({
            type: z.enum(["string", "number", "boolean", "date", "enum", "string[]", "number[]", "object", "autoIncrement"]).meta({ description: "Field data type" }),
            required: z.boolean().optional().meta({ description: "Field is required on insert" }),
            default: z.unknown().optional().meta({ description: "Default value when not provided" }),
            values: z.array(z.string()).optional().meta({ description: "Allowed values for enum type" }),
            maxLength: z.number().optional().meta({ description: "Max string length" }),
            min: z.number().optional().meta({ description: "Min for numbers" }),
            max: z.number().optional().meta({ description: "Max for numbers" }),
            description: z.string().optional().meta({ description: "Human-readable field description" }),
          })).optional().meta({ description: "Field definitions (partial update — omitted fields are no-change)" }),
          indexes: z.array(z.string()).optional().meta({ description: "B-tree indexes" }),
          compositeIndexes: z.array(z.array(z.string())).optional().meta({ description: "Composite indexes" }),
          arrayIndexes: z.array(z.string()).optional().meta({ description: "Array-element indexes" }),
          tagField: z.string().optional().meta({ description: "Array field for tag compact filter" }),
          storageMode: z.enum(["memory", "disk", "auto"]).optional().meta({ description: "Storage mode" }),
        }).meta({ description: "Candidate schema — same shape as db_set_schema" }),
        includeImpact: z.boolean().optional().default(true).meta({ description: "Query collection for affected record counts (default: true)" }),
      }),
      outputSchema: z.object({
        collection: z.string(),
        hasExisting: z.boolean(),
        added: z.object({
          fields: z.array(z.string()),
          indexes: z.array(z.string()),
          arrayIndexes: z.array(z.string()),
          compositeIndexes: z.array(z.array(z.string())),
        }),
        removed: z.object({
          fields: z.array(z.string()),
          indexes: z.array(z.string()),
          arrayIndexes: z.array(z.string()),
          compositeIndexes: z.array(z.array(z.string())),
        }),
        changed: z.object({
          description: z.object({ from: z.string().nullable(), to: z.string().nullable() }).optional(),
          instructions: z.object({ from: z.string().nullable(), to: z.string().nullable() }).optional(),
          version: z.object({ from: z.number().nullable(), to: z.number().nullable() }).optional(),
          fields: z.record(z.string(), z.record(z.string(), z.unknown())),
        }),
        warnings: z.array(z.object({
          severity: z.enum(["high", "medium", "low"]),
          message: z.string(),
        })),
        impact: z.object({
          totalRecords: z.number(),
          recordsWithRemovedFields: z.number(),
          recordsViolatingNewConstraints: z.number(),
        }).optional(),
      }),
      annotations: READ,
      execute: safe("db_diff_schema", READ)(async (args) => {
        const name = args.collection as string;
        const input = args.schema as Record<string, unknown>;
        const includeImpact = (args.includeImpact as boolean) !== false;

        const existing = await db.loadPersistedSchema(name);
        const hasExisting = existing !== undefined;
        const base: import("../schema.js").PersistedSchema = existing ?? { name };
        const incoming = { name, ...input } as import("../schema.js").PersistedSchema;
        const merged = hasExisting ? mergePersistedSchemas(existing!, incoming) : incoming;

        // Field diff (existing → merged)
        const baseFields = base.fields ?? {};
        const mergedFields = merged.fields ?? {};
        const existingFieldNames = Object.keys(baseFields);
        const mergedFieldNames = Object.keys(mergedFields);
        const addedFields = mergedFieldNames.filter(f => !existingFieldNames.includes(f));
        const removedFields = existingFieldNames.filter(f => !mergedFieldNames.includes(f));

        const changedFields: Record<string, Record<string, unknown>> = {};
        for (const fn of existingFieldNames.filter(f => mergedFieldNames.includes(f))) {
          const ef = baseFields[fn];
          const mf = mergedFields[fn];
          const chg: Record<string, unknown> = {};
          if (ef.type !== mf.type) chg.type = { from: ef.type, to: mf.type };
          const efReq = ef.required ?? false; const mfReq = mf.required ?? false;
          if (efReq !== mfReq) chg.required = { from: efReq, to: mfReq };
          const efDesc = ef.description ?? null; const mfDesc = mf.description ?? null;
          if (efDesc !== mfDesc) chg.description = { from: efDesc, to: mfDesc };
          const efMaxLen = ef.maxLength ?? null; const mfMaxLen = mf.maxLength ?? null;
          if (efMaxLen !== mfMaxLen) chg.maxLength = { from: efMaxLen, to: mfMaxLen };
          const efMin = ef.min ?? null; const mfMin = mf.min ?? null;
          if (efMin !== mfMin) chg.min = { from: efMin, to: mfMin };
          const efMax = ef.max ?? null; const mfMax = mf.max ?? null;
          if (efMax !== mfMax) chg.max = { from: efMax, to: mfMax };
          const efVals = ef.values ?? []; const mfVals = mf.values ?? [];
          const mfValSet = new Set(mfVals);
          const efValSet = new Set(efVals);
          const valsAdded = mfVals.filter(v => !efValSet.has(v));
          const valsRemoved = efVals.filter(v => !mfValSet.has(v));
          if (valsAdded.length > 0 || valsRemoved.length > 0) chg.values = { added: valsAdded, removed: valsRemoved };
          if (JSON.stringify(ef.default ?? null) !== JSON.stringify(mf.default ?? null)) {
            chg.default = { from: ef.default ?? null, to: mf.default ?? null };
          }
          if (Object.keys(chg).length > 0) changedFields[fn] = chg;
        }

        // Index diff
        const baseIdx = base.indexes ?? []; const mergedIdx = merged.indexes ?? [];
        const addedIndexes = mergedIdx.filter(i => !baseIdx.includes(i));
        const removedIndexes = baseIdx.filter(i => !mergedIdx.includes(i));
        const baseArrIdx = base.arrayIndexes ?? []; const mergedArrIdx = merged.arrayIndexes ?? [];
        const addedArrayIndexes = mergedArrIdx.filter(i => !baseArrIdx.includes(i));
        const removedArrayIndexes = baseArrIdx.filter(i => !mergedArrIdx.includes(i));
        const baseCmp = base.compositeIndexes ?? []; const mergedCmp = merged.compositeIndexes ?? [];
        const baseCmpKeys = new Set(baseCmp.map(ci => ci.join(",")));
        const mergedCmpKeys = new Set(mergedCmp.map(ci => ci.join(",")));
        const addedCompositeIndexes = mergedCmp.filter(ci => !baseCmpKeys.has(ci.join(",")));
        const removedCompositeIndexes = baseCmp.filter(ci => !mergedCmpKeys.has(ci.join(",")));

        // Top-level changed
        const changed: Record<string, unknown> = {};
        const bDesc = base.description ?? null; const mDesc = merged.description ?? null;
        if (bDesc !== mDesc) changed.description = { from: bDesc, to: mDesc };
        const bInstr = base.instructions ?? null; const mInstr = merged.instructions ?? null;
        if (bInstr !== mInstr) changed.instructions = { from: bInstr, to: mInstr };
        const bVer = base.version ?? null; const mVer = merged.version ?? null;
        if (bVer !== mVer) changed.version = { from: bVer, to: mVer };
        changed.fields = changedFields;

        // Structural warnings (no counts yet)
        const warnings: Array<{ severity: string; message: string }> = [];
        if (hasExisting && base.description != null && merged.description == null) {
          warnings.push({ severity: "low", message: "Collection description removed" });
        }
        if (hasExisting && base.instructions != null && merged.instructions == null) {
          warnings.push({ severity: "low", message: "Collection instructions removed" });
        }
        for (const fn of removedFields) {
          warnings.push({ severity: "medium", message: `Field '${fn}' removed from schema` });
        }
        for (const [fn, chg] of Object.entries(changedFields)) {
          if (chg.type) {
            const t = chg.type as { from: string; to: string };
            warnings.push({ severity: "high", message: `Field '${fn}' type changed from '${t.from}' to '${t.to}'` });
          }
          if (chg.required) {
            const r = chg.required as { from: boolean; to: boolean };
            if (!r.from && r.to) {
              warnings.push({ severity: "medium", message: `Field '${fn}' is now required — existing records missing this field will fail validation` });
            }
          }
          if (chg.values) {
            const v = chg.values as { added: string[]; removed: string[] };
            if (v.removed.length > 0) {
              warnings.push({ severity: "high", message: `Field '${fn}' enum removed value(s): ${v.removed.join(", ")}` });
            }
          }
          if (chg.maxLength) {
            const ml = chg.maxLength as { from: number | null; to: number | null };
            if (ml.to !== null && (ml.from === null || ml.to < ml.from)) {
              warnings.push({ severity: "medium", message: `Field '${fn}' maxLength tightened${ml.from !== null ? ` from ${ml.from}` : ""} to ${ml.to}` });
            }
          }
          if (chg.min) {
            const mn = chg.min as { from: number | null; to: number | null };
            if (mn.to !== null && (mn.from === null || mn.to > mn.from)) {
              warnings.push({ severity: "medium", message: `Field '${fn}' min tightened${mn.from !== null ? ` from ${mn.from}` : ""} to ${mn.to}` });
            }
          }
          if (chg.max) {
            const mx = chg.max as { from: number | null; to: number | null };
            if (mx.to !== null && (mx.from === null || mx.to < mx.from)) {
              warnings.push({ severity: "medium", message: `Field '${fn}' max tightened${mx.from !== null ? ` from ${mx.from}` : ""} to ${mx.to}` });
            }
          }
          if (chg.description) {
            const d = chg.description as { from: string | null; to: string | null };
            if (d.from !== null && d.to === null) {
              warnings.push({ severity: "low", message: `Field '${fn}' description removed` });
            }
          }
        }

        // Impact scan
        let impact: Record<string, number> | undefined;
        const collectionExists = db.getCollectionNames().includes(name);
        if (!collectionExists) {
          warnings.push({ severity: "medium", message: `Collection '${name}' does not exist yet` });
        }

        if (includeImpact) {
          if (collectionExists) {
            const col = await db.collection(name);
            const totalRecords = await col.count();
            let recordsWithRemovedFields = 0;
            if (removedFields.length > 0 && totalRecords > 0) {
              const orFilter = { $or: removedFields.map(f => ({ [f]: { $exists: true } })) };
              recordsWithRemovedFields = await col.count(orFilter as import("../collection-helpers.js").Filter);
              for (const fn of removedFields) {
                const cnt = await col.count({ [fn]: { $exists: true } });
                if (cnt > 0) {
                  const w = warnings.find(w => w.message === `Field '${fn}' removed from schema`);
                  if (w) w.message += ` (${cnt} records have this field)`;
                }
              }
            }
            let recordsViolatingNewConstraints = 0;
            for (const [fn, chg] of Object.entries(changedFields)) {
              if (chg.type) {
                const cnt = await col.count({ [fn]: { $exists: true } });
                if (cnt > 0) {
                  const w = warnings.find(w => w.severity === "high" && w.message.includes(`Field '${fn}' type changed`));
                  if (w) w.message += ` (${cnt} records affected)`;
                }
              }
              if (chg.required) {
                const r = chg.required as { from: boolean; to: boolean };
                if (!r.from && r.to) {
                  const cnt = await col.count({ [fn]: { $exists: false } });
                  if (cnt > 0) {
                    const w = warnings.find(w => w.severity === "medium" && w.message.includes(`Field '${fn}' is now required`));
                    if (w) w.message += ` (${cnt} records missing field)`;
                    recordsViolatingNewConstraints += cnt;
                  }
                }
              }
              if (chg.values) {
                const v = chg.values as { added: string[]; removed: string[] };
                if (v.removed.length > 0) {
                  let cnt = 0;
                  for (const val of v.removed) cnt += await col.count({ [fn]: val });
                  if (cnt > 0) {
                    const w = warnings.find(w => w.severity === "high" && w.message.includes(`Field '${fn}' enum removed`));
                    if (w) w.message += ` (${cnt} records affected)`;
                    recordsViolatingNewConstraints += cnt;
                  }
                }
              }
              if (chg.maxLength) {
                const ml = chg.maxLength as { from: number | null; to: number | null };
                if (ml.to !== null && (ml.from === null || ml.to < ml.from)) {
                  const recs = await col.find({ filter: { [fn]: { $exists: true } } });
                  let cnt = 0;
                  for (const rec of recs.records) {
                    const val = rec[fn];
                    if (typeof val === "string" && val.length > ml.to!) cnt++;
                  }
                  if (cnt > 0) {
                    const w = warnings.find(w => w.severity === "medium" && w.message.includes(`Field '${fn}' maxLength tightened`));
                    if (w) w.message += ` (${cnt} records violating)`;
                    recordsViolatingNewConstraints += cnt;
                  }
                }
              }
              if (chg.min) {
                const mn = chg.min as { from: number | null; to: number | null };
                if (mn.to !== null && (mn.from === null || mn.to > mn.from)) {
                  const recs = await col.find({ filter: { [fn]: { $exists: true } } });
                  let cnt = 0;
                  for (const rec of recs.records) {
                    const val = rec[fn];
                    if (typeof val === "number" && val < mn.to!) cnt++;
                  }
                  if (cnt > 0) {
                    const w = warnings.find(w => w.severity === "medium" && w.message.includes(`Field '${fn}' min tightened`));
                    if (w) w.message += ` (${cnt} records violating)`;
                    recordsViolatingNewConstraints += cnt;
                  }
                }
              }
              if (chg.max) {
                const mx = chg.max as { from: number | null; to: number | null };
                if (mx.to !== null && (mx.from === null || mx.to < mx.from)) {
                  const recs = await col.find({ filter: { [fn]: { $exists: true } } });
                  let cnt = 0;
                  for (const rec of recs.records) {
                    const val = rec[fn];
                    if (typeof val === "number" && val > mx.to!) cnt++;
                  }
                  if (cnt > 0) {
                    const w = warnings.find(w => w.severity === "medium" && w.message.includes(`Field '${fn}' max tightened`));
                    if (w) w.message += ` (${cnt} records violating)`;
                    recordsViolatingNewConstraints += cnt;
                  }
                }
              }
            }
            impact = { totalRecords, recordsWithRemovedFields, recordsViolatingNewConstraints };
          } else {
            impact = { totalRecords: 0, recordsWithRemovedFields: 0, recordsViolatingNewConstraints: 0 };
          }
        }

        const result: Record<string, unknown> = {
          collection: name,
          hasExisting,
          added: { fields: addedFields, indexes: addedIndexes, arrayIndexes: addedArrayIndexes, compositeIndexes: addedCompositeIndexes },
          removed: { fields: removedFields, indexes: removedIndexes, arrayIndexes: removedArrayIndexes, compositeIndexes: removedCompositeIndexes },
          changed,
          warnings,
        };
        if (impact !== undefined) result.impact = impact;
        return result;
      }),
    },

    {
      name: "db_infer_schema",
      title: "Infer Schema",
      description: "Sample existing records and propose a PersistedSchema — solves the cold-start problem. Detects field types (boolean, number, string, date, enum, string[], number[], object), marks fields required when present in ≥ requiredThreshold fraction of records, and infers enum values when distinct string count ≤ enumThreshold. Mixed-type fields are skipped with a note. Sampling is offset-randomised when totalRecords > sampleSize. The proposed schema passes validatePersistedSchema and can be forwarded directly to db_set_schema. Does not mutate any data." + API_NOTE,
      schema: z.object({
        collection: collectionParam,
        sampleSize: z.number().optional().default(100).meta({ description: "Max records to sample (default: 100, cap: 10000)" }),
        enumThreshold: z.number().optional().default(10).meta({ description: "Max distinct string values before treating as free-text instead of enum (default: 10)" }),
        requiredThreshold: z.number().optional().default(0.95).meta({ description: "Fraction of sampled records a field must appear in to be marked required (default: 0.95)" }),
      }),
      outputSchema: z.object({
        collection: z.string(),
        sampleSize: z.number(),
        totalRecords: z.number(),
        proposed: z.record(z.string(), z.unknown()),
        notes: z.array(z.string()),
      }),
      annotations: READ,
      execute: safe("db_infer_schema", READ)(async (args) => {
        const colName = args.collection as string;
        const sampleSize = Math.min(Math.max(1, (args.sampleSize as number) || 100), 10000);
        const enumThreshold = Math.max(1, (args.enumThreshold as number) || 10);
        const requiredThreshold = Math.max(0, Math.min(1, (args.requiredThreshold as number) ?? 0.95));

        const META = new Set(["_id", "_version", "_agent", "_reason", "_expires", "_embedding", "__proto__", "constructor", "prototype"]);

        const col = await db.collection(colName);
        const totalRecords = await col.count();
        const notes: string[] = [];

        // Warn when a persisted schema already exists
        const existingSchema = await db.loadPersistedSchema(colName);
        if (existingSchema !== undefined) {
          const versionPart = existingSchema.version !== undefined ? ` (version ${existingSchema.version})` : "";
          notes.push(`Collection already has a persisted schema${versionPart}. Use db_diff_schema to compare or db_set_schema to replace.`);
        }

        // Sampling: scan-all when totalRecords ≤ sampleSize, otherwise random offset
        let records: Record<string, unknown>[];
        if (totalRecords === 0) {
          records = [];
        } else if (totalRecords <= sampleSize) {
          records = (await col.find({ limit: sampleSize })).records;
        } else {
          const maxOffset = totalRecords - sampleSize;
          const startOffset = Math.floor(Math.random() * (maxOffset + 1));
          records = (await col.find({ limit: sampleSize, offset: startOffset })).records;
          notes.push(`Sampled ${records.length} of ${totalRecords} total records (random offset ${startOffset}).`);
        }

        const actualSample = records.length;

        if (actualSample === 0) {
          const proposed: import("../schema.js").PersistedSchema = { name: colName };
          validatePersistedSchema(proposed);
          return { collection: colName, sampleSize: actualSample, totalRecords, proposed, notes: ["Collection is empty; no fields could be inferred."] };
        }

        // Collect field names across all sample records (skip meta)
        const fieldNames = new Set<string>();
        for (const record of records) {
          for (const key of Object.keys(record)) {
            if (!META.has(key)) fieldNames.add(key);
          }
        }

        const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;

        const fields: Record<string, import("../schema.js").PersistedFieldDef> = {};

        for (const fieldName of fieldNames) {
          const values = records
            .map(r => r[fieldName])
            .filter(v => v !== undefined && v !== null);

          if (values.length === 0) continue;

          const presentCount = records.filter(r => r[fieldName] !== undefined && r[fieldName] !== null).length;

          // Count how many values fall into each type bucket
          let boolCount = 0, numCount = 0, strCount = 0, strArrCount = 0, numArrCount = 0, objCount = 0, otherCount = 0;
          for (const v of values) {
            if (typeof v === "boolean") boolCount++;
            else if (typeof v === "number") numCount++;
            else if (typeof v === "string") strCount++;
            else if (Array.isArray(v)) {
              if (v.length === 0 || v.every(e => typeof e === "string")) strArrCount++;
              else if (v.every(e => typeof e === "number")) numArrCount++;
              else otherCount++;
            } else if (typeof v === "object") objCount++;
            else otherCount++;
          }

          const activeBuckets = [boolCount, numCount, strCount, strArrCount, numArrCount, objCount, otherCount]
            .filter(c => c > 0).length;

          if (activeBuckets > 1) {
            const typeLabels: string[] = [];
            if (boolCount) typeLabels.push("boolean");
            if (numCount) typeLabels.push("number");
            if (strCount) typeLabels.push("string");
            if (strArrCount) typeLabels.push("string[]");
            if (numArrCount) typeLabels.push("number[]");
            if (objCount) typeLabels.push("object");
            if (otherCount) typeLabels.push("mixed/unknown");
            notes.push(`Field '${fieldName}': mixed types observed (${typeLabels.join(", ")}), skipped.`);
            continue;
          }

          const required = presentCount / actualSample >= requiredThreshold;
          let fieldDef: import("../schema.js").PersistedFieldDef;

          if (boolCount > 0) {
            fieldDef = { type: "boolean" };
          } else if (numCount > 0) {
            fieldDef = { type: "number" };
          } else if (strCount > 0) {
            const strs = values as string[];
            if (strs.every(s => ISO_DATE_RE.test(s))) {
              fieldDef = { type: "date" };
              notes.push(`Field '${fieldName}': inferred as date string.`);
            } else {
              const uniqueValues = new Set(strs);
              if (uniqueValues.size <= enumThreshold) {
                fieldDef = { type: "enum", values: [...uniqueValues].sort() };
                notes.push(`Field '${fieldName}': inferred as enum with ${uniqueValues.size} distinct value(s).`);
              } else {
                const maxLength = Math.max(...strs.map(s => s.length));
                fieldDef = { type: "string", maxLength };
              }
            }
          } else if (strArrCount > 0) {
            fieldDef = { type: "string[]" };
          } else if (numArrCount > 0) {
            fieldDef = { type: "number[]" };
          } else {
            fieldDef = { type: "object" };
          }

          if (required) fieldDef.required = true;
          fields[fieldName] = fieldDef;
        }

        const proposed: import("../schema.js").PersistedSchema = { name: colName };
        if (Object.keys(fields).length > 0) proposed.fields = fields;
        validatePersistedSchema(proposed);

        return { collection: colName, sampleSize: actualSample, totalRecords, proposed, notes };
      }),
    },

    {
      name: "db_migrate",
      title: "Migrate Records",
      description: "Declarative bulk record update via ordered ops: set (always assign), unset (remove), rename (move field, overwrite if target exists), default (assign only if missing), copy (duplicate field without removing source). Ops are applied in order per record. Idempotent ops (default, unset of absent field) make re-running safe. Per-record atomicity — no cross-record transaction. Protected meta-fields (_id, _version, _agent, _reason, _expires, _embedding) are silently skipped. Matching records are snapshotted by ID at migration start — all matches are processed even if ops cause records to leave the filter mid-run. Uses optimistic locking via snapshot versions; concurrent writes to the same record will fail and land in errors[]. Validation fires normally; a schema-violating migration causes per-record failure tracked in errors[]." + API_NOTE,
      schema: z.object({
        collection: collectionParam,
        ops: z.array(z.union([
          z.object({ op: z.literal("set"), field: z.string().meta({ description: "Field to set" }), value: z.unknown().meta({ description: "Value to assign" }) }),
          z.object({ op: z.literal("unset"), field: z.string().meta({ description: "Field to remove" }) }),
          z.object({ op: z.literal("rename"), from: z.string().meta({ description: "Source field name" }), to: z.string().meta({ description: "Target field name (overwritten if exists)" }) }),
          z.object({ op: z.literal("default"), field: z.string().meta({ description: "Field to set if missing" }), value: z.unknown().meta({ description: "Default value" }) }),
          z.object({ op: z.literal("copy"), from: z.string().meta({ description: "Source field to copy from" }), to: z.string().meta({ description: "Target field to copy into" }) }),
        ])).min(1, "ops must contain at least one operation").meta({ description: "Ordered list of operations to apply to each record" }),
        filter: filterParam,
        dryRun: z.boolean().optional().default(false).meta({ description: "Preview counts without writing (default: false)" }),
        batchSize: z.number().optional().default(100).meta({ description: "Records per batch (default: 100)" }),
        ...mutationOpts,
      }),
      outputSchema: z.object({
        collection: z.string(),
        scanned: z.number(),
        updated: z.number(),
        unchanged: z.number(),
        failed: z.number(),
        errors: z.array(z.object({ id: z.string(), error: z.string() })),
        dryRun: z.boolean(),
        ops: z.array(z.unknown()),
      }),
      annotations: DESTRUCTIVE,
      execute: safe("db_migrate", WRITE)(async (args) => {
        const colName = args.collection as string;
        const ops = args.ops as Array<Record<string, unknown>>;
        const filter = args.filter as Record<string, unknown> | string | undefined;
        const dryRun = (args.dryRun as boolean) === true;
        const batchSize = Math.max(1, (args.batchSize as number) || 100);
        const agent = args.agent as string | undefined;
        const reason = args.reason as string | undefined;

        if (!ops || ops.length === 0) throw new Error("ops must contain at least one operation");

        const PROTECTED = new Set(["_id", "_version", "_agent", "_reason", "_expires", "_embedding"]);

        function applyOps(record: Record<string, unknown>): Record<string, unknown> {
          const r = { ...record };
          for (const op of ops) {
            switch (op.op) {
              case "set":
                if (!PROTECTED.has(op.field as string)) r[op.field as string] = op.value;
                break;
              case "unset":
                if (!PROTECTED.has(op.field as string)) delete r[op.field as string];
                break;
              case "rename":
                if (!PROTECTED.has(op.from as string) && !PROTECTED.has(op.to as string) && (op.from as string) in r) {
                  r[op.to as string] = r[op.from as string];
                  delete r[op.from as string];
                }
                break;
              case "default":
                if (!PROTECTED.has(op.field as string) && r[op.field as string] === undefined) {
                  r[op.field as string] = op.value;
                }
                break;
              case "copy":
                if (!PROTECTED.has(op.from as string) && !PROTECTED.has(op.to as string) && (op.from as string) in r) {
                  r[op.to as string] = r[op.from as string];
                }
                break;
            }
          }
          return r;
        }

        const col = await db.collection(colName);
        let updated = 0;
        let unchanged = 0;
        let failed = 0;
        const errors: Array<{ id: string; error: string }> = [];

        // Phase 1: snapshot all matching IDs+versions (decouples scan from mutation so
        // records that leave the filter after being processed are still counted)
        const snapshot: Array<{ id: string; version: number | undefined }> = [];
        {
          let snapOffset = 0;
          const SNAP_CHUNK = 5000;
          while (true) {
            const snap = await col.find({ filter, limit: SNAP_CHUNK, offset: snapOffset });
            for (const r of snap.records) {
              snapshot.push({ id: r._id as string, version: r._version as number | undefined });
            }
            if (snap.records.length < SNAP_CHUNK) break;
            snapOffset += SNAP_CHUNK;
          }
        }
        const scanned = snapshot.length;

        // Phase 2: process in batches by ID; use snapshot version for optimistic locking
        for (let batchStart = 0; batchStart < snapshot.length; batchStart += batchSize) {
          const batch = snapshot.slice(batchStart, batchStart + batchSize);
          const batchIds = batch.map(s => s.id);
          const fetched = await col.find({
            filter: { _id: { $in: batchIds } } as import("../collection-helpers.js").Filter,
            limit: batchIds.length,
          });
          const recordMap = new Map(fetched.records.map(r => [r._id as string, r]));

          for (const { id, version: snapVersion } of batch) {
            const record = recordMap.get(id);
            if (!record) continue;

            // Apply ops to user fields only (exclude _id for comparison)
            const original: Record<string, unknown> = {};
            const withoutId: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(record)) {
              if (k !== "_id") { original[k] = v; withoutId[k] = v; }
            }
            const migrated = applyOps(withoutId);

            // Diff: only non-protected fields
            const $set: Record<string, unknown> = {};
            const $unset: Record<string, true> = {};
            for (const [k, v] of Object.entries(migrated)) {
              if (PROTECTED.has(k)) continue;
              if (!(k in original) || JSON.stringify(original[k]) !== JSON.stringify(v)) $set[k] = v;
            }
            for (const k of Object.keys(original)) {
              if (PROTECTED.has(k)) continue;
              if (!(k in migrated)) $unset[k] = true;
            }
            const hasChanges = Object.keys($set).length > 0 || Object.keys($unset).length > 0;

            if (!hasChanges) { unchanged++; continue; }

            if (dryRun) { updated++; continue; }

            try {
              const updateOps: Record<string, unknown> = {};
              if (Object.keys($set).length > 0) updateOps.$set = $set;
              if (Object.keys($unset).length > 0) updateOps.$unset = $unset;
              await col.update(
                { _id: id } as import("../collection-helpers.js").Filter,
                updateOps as import("../collection-helpers.js").UpdateOps,
                { agent, reason, expectedVersion: snapVersion },
              );
              updated++;
            } catch (err) {
              failed++;
              if (errors.length < 10) {
                errors.push({ id, error: err instanceof Error ? err.message : String(err) });
              }
            }
          }
        }

        return { collection: colName, scanned, updated, unchanged, failed, errors, dryRun, ops };
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

    {
      name: "db_archive",
      title: "Archive Records",
      description: "Move records matching a filter to cold storage (quarterly archive segments). Archived records are removed from the active set, keeping queries fast. Archives are append-only and read-only. Use db_archive_list to see segments and db_archive_load to view archived data." + API_NOTE,
      schema: z.object({
        collection: collectionParam,
        filter: z.union([z.record(z.string(), z.unknown()), z.string()]).meta({ description: "Filter: JSON object or compact string" }),
        segment: z.string().optional().meta({ description: "Archive segment name (defaults to current quarter, e.g. 2026-Q2)" }),
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
        segment: z.string().meta({ description: "Archive segment name" }),
      }),
      outputSchema: z.object({ records: z.array(z.record(z.string(), z.unknown())), count: z.number() }),
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
        query: z.string().meta({ description: "Natural language search query" }),
        filter: filterParam,
        limit: z.number().optional().default(10).meta({ description: "Max results (default 10)" }),
        summary: z.boolean().optional().default(false).meta({ description: "Return summary fields only" }),
      }),
      outputSchema: z.object({ records: z.array(z.record(z.string(), z.unknown())), scores: z.array(z.number()) }),
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
      name: "db_vector_upsert",
      title: "Upsert Vector",
      description: "Store a pre-computed vector for a record. No embedding provider required. Creates or replaces the record with the given vector and optional metadata fields." + API_NOTE,
      schema: z.object({
        collection: collectionParam,
        id: z.string().meta({ description: "Record ID" }),
        vector: z.array(z.number()).meta({ description: "Vector (array of numbers)" }),
        metadata: z.record(z.string(), z.unknown()).optional().meta({ description: "Optional metadata fields to store with the vector" }),
      }),
      outputSchema: z.object({ id: z.string() }),
      annotations: WRITE,
      execute: safe("db_vector_upsert", WRITE)(async (args) => {
        const col = await db.collection(args.collection as string);
        await col.insertVector(
          args.id as string,
          args.vector as number[],
          args.metadata as Record<string, unknown> | undefined,
        );
        return { id: args.id as string };
      }),
    },

    {
      name: "db_vector_search",
      title: "Vector Search",
      description: "Search by a raw vector (array of numbers). Returns the most similar records with cosine similarity scores. No embedding provider required — works with vectors stored via db_vector_upsert. Use db_semantic_search instead if you have a text query and an embedding provider configured." + API_NOTE,
      schema: z.object({
        collection: collectionParam,
        vector: z.array(z.number()).meta({ description: "Query vector" }),
        filter: z.union([z.record(z.string(), z.unknown()), z.string()]).optional().meta({ description: "Optional attribute filter" }),
        limit: z.number().optional().meta({ description: "Max results (default: 10)" }),
        summary: z.boolean().optional().meta({ description: "Return summary fields only" }),
      }),
      outputSchema: z.object({ records: z.array(z.record(z.string(), z.unknown())), scores: z.array(z.number()) }),
      annotations: READ,
      execute: safe("db_vector_search", READ)(async (args) => {
        const col = await db.collection(args.collection as string);
        return col.searchByVector(args.vector as number[], {
          filter: args.filter as Record<string, unknown> | string | undefined,
          limit: args.limit as number | undefined,
          summary: args.summary as boolean | undefined,
        });
      }),
    },

    {
      name: "db_blob_write",
      title: "Write Blob",
      description: "Attach a file (text or binary) to a record. Content is base64-encoded for transport. Stored outside the WAL via the storage backend (filesystem or S3)." + API_NOTE,
      schema: z.object({
        collection: collectionParam,
        recordId: z.string().meta({ description: "Record ID to attach the blob to" }),
        name: z.string().meta({ description: "Blob name (e.g. 'spec.md', 'screenshot.png')" }),
        content: z.string().meta({ description: "Base64-encoded content" }),
      }),
      outputSchema: z.object({ written: z.boolean() }),
      annotations: WRITE,
      execute: safe("db_blob_write", WRITE)(async (args) => {
        const col = await db.collection(args.collection as string);
        const buf = Buffer.from(args.content as string, "base64");
        await col.writeBlob(args.recordId as string, args.name as string, buf);
        return { written: true };
      }),
    },

    {
      name: "db_blob_read",
      title: "Read Blob",
      description: "Read an attached file from a record. Returns base64-encoded content." + API_NOTE,
      schema: z.object({
        collection: collectionParam,
        recordId: z.string().meta({ description: "Record ID" }),
        name: z.string().meta({ description: "Blob name" }),
      }),
      outputSchema: z.object({ content: z.string(), size: z.number() }),
      annotations: READ,
      execute: safe("db_blob_read", READ)(async (args) => {
        const col = await db.collection(args.collection as string);
        const buf = await col.readBlob(args.recordId as string, args.name as string);
        return { content: buf.toString("base64"), size: buf.length };
      }),
    },

    {
      name: "db_blob_list",
      title: "List Blobs",
      description: "List all files attached to a record." + API_NOTE,
      schema: z.object({
        collection: collectionParam,
        recordId: z.string().meta({ description: "Record ID" }),
      }),
      outputSchema: z.object({ blobs: z.array(z.string()) }),
      annotations: READ,
      execute: safe("db_blob_list", READ)(async (args) => {
        const col = await db.collection(args.collection as string);
        const blobs = await col.listBlobs(args.recordId as string);
        return { blobs };
      }),
    },

    {
      name: "db_blob_delete",
      title: "Delete Blob",
      description: "Delete an attached file from a record." + API_NOTE,
      schema: z.object({
        collection: collectionParam,
        recordId: z.string().meta({ description: "Record ID" }),
        name: z.string().meta({ description: "Blob name to delete" }),
      }),
      outputSchema: z.object({ deleted: z.boolean() }),
      annotations: DESTRUCTIVE,
      execute: safe("db_blob_delete", DESTRUCTIVE)(async (args) => {
        const col = await db.collection(args.collection as string);
        await col.deleteBlob(args.recordId as string, args.name as string);
        return { deleted: true };
      }),
    },

    {
      name: "db_export",
      title: "Export Collections",
      description: "Export all or named collections as a self-contained JSON backup. The export includes all records with their _id fields. Use db_import to restore into a fresh or existing database." + API_NOTE,
      schema: z.object({
        collections: z.array(z.string()).optional().meta({ description: "Collection names to export (default: all)" }),
      }),
      outputSchema: z.object({ version: z.number(), exportedAt: z.string(), collections: z.record(z.string(), z.unknown()) }),
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
          collections: z.record(z.string(), z.object({ records: z.array(z.record(z.string(), z.unknown())) })),
        }).meta({ description: "Export data from db_export" }),
        overwrite: z.boolean().optional().default(false).meta({ description: "Overwrite existing records (default: skip)" }),
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
