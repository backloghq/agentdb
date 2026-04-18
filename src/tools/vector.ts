import { z } from "zod";
import type { AgentDB } from "../agentdb.js";
import { makeSafe, API_NOTE, collectionParam, filterParam, READ, WRITE } from "./shared.js";
import type { AgentTool } from "./shared.js";

export function getVectorTools(db: AgentDB): AgentTool[] {
  function safe(name: string, annotations: { readOnlyHint?: boolean; destructiveHint?: boolean }) {
    return makeSafe(db, name, annotations);
  }

  return [
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
  ];
}
