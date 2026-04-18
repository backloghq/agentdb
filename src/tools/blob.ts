import { z } from "zod";
import type { AgentDB } from "../agentdb.js";
import { makeSafe, API_NOTE, collectionParam, READ, WRITE, DESTRUCTIVE } from "./shared.js";
import type { AgentTool } from "./shared.js";

export function getBlobTools(db: AgentDB): AgentTool[] {
  function safe(name: string, annotations: { readOnlyHint?: boolean; destructiveHint?: boolean }) {
    return makeSafe(db, name, annotations);
  }

  return [
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
  ];
}
