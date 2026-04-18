import { z } from "zod";
import type { AgentDB } from "../agentdb.js";
import { makeSafe, API_NOTE, collectionParam, READ, DESTRUCTIVE } from "./shared.js";
import type { AgentTool } from "./shared.js";

export function getArchiveTools(db: AgentDB): AgentTool[] {
  function safe(name: string, annotations: { readOnlyHint?: boolean; destructiveHint?: boolean }) {
    return makeSafe(db, name, annotations);
  }

  return [
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
  ];
}
