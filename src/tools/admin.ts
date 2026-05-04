import { z } from "zod";
import type { AgentDB } from "../agentdb.js";
import { makeSafe, API_NOTE, collectionParam, WRITE_IDEMPOTENT, DESTRUCTIVE, READ } from "./shared.js";
import type { AgentTool } from "./shared.js";

export function getAdminTools(db: AgentDB): AgentTool[] {
  function safe(name: string, annotations: { readOnlyHint?: boolean; destructiveHint?: boolean }) {
    return makeSafe(db, name, annotations);
  }

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
      name: "db_stats",
      title: "Database Stats",
      description: "Get database-level statistics: total collections, total records, and estimated TextIndex memory across all collections. Lightweight — does not scan individual records." + API_NOTE,
      schema: z.object({}),
      outputSchema: z.object({ collections: z.number(), totalRecords: z.number(), textIndexBytes: z.number() }),
      annotations: READ,
      execute: safe("db_stats", READ)(async () => {
        return db.stats();
      }),
    },
  ];
}
