import { z } from "zod";
import type { AgentDB } from "../agentdb.js";
import { makeSafe, API_NOTE, READ, DESTRUCTIVE } from "./shared.js";
import type { AgentTool } from "./shared.js";

export function getBackupTools(db: AgentDB): AgentTool[] {
  function safe(name: string, annotations: { readOnlyHint?: boolean; destructiveHint?: boolean }) {
    return makeSafe(db, name, annotations);
  }

  return [
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
  ];
}
