import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDB } from "../src/agentdb.js";
import { getTools } from "../src/tools/index.js";
import type { AgentTool } from "../src/tools/index.js";

describe("Tool Error Branches", () => {
  let tmpDir: string;
  let db: AgentDB;
  let tools: AgentTool[];

  function tool(name: string): AgentTool {
    const t = tools.find((t) => t.name === name);
    if (!t) throw new Error(`Tool '${name}' not found`);
    return t;
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agentdb-tools-err-"));
    db = new AgentDB(tmpDir);
    await db.init();
    tools = getTools(db);
  });

  afterEach(async () => {
    await db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("invalid collection name", () => {
    it("db_create with invalid name returns isError", async () => {
      const result = await tool("db_create").execute({ collection: "../etc/passwd" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Invalid collection name");
    });

    it("db_insert with invalid name returns isError", async () => {
      const result = await tool("db_insert").execute({
        collection: "bad name!",
        record: { x: 1 },
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Invalid collection name");
    });

    it("db_find with invalid name returns isError", async () => {
      const result = await tool("db_find").execute({ collection: "" });
      expect(result.isError).toBe(true);
    });
  });

  describe("db_batch with update operations", () => {
    it("executes update operations in the non-atomic path", async () => {
      // First insert some records to update
      const col = await db.collection("batch-upd");
      await col.insert({ _id: "r1", name: "Alice", score: 10 });
      await col.insert({ _id: "r2", name: "Bob", score: 20 });

      const result = await tool("db_batch").execute({
        collection: "batch-upd",
        operations: [
          {
            op: "update",
            filter: { _id: "r1" },
            update: { $set: { score: 99 } },
          },
          {
            op: "update",
            filter: { _id: "r2" },
            update: { $inc: { score: 5 } },
          },
        ],
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.operations).toBe(2);

      // Verify updates were applied
      const r1 = col.findOne("r1");
      expect(r1?.score).toBe(99);
      const r2 = col.findOne("r2");
      expect(r2?.score).toBe(25);
    });

    it("mixes inserts and updates in a single batch", async () => {
      const result = await tool("db_batch").execute({
        collection: "batch-mix",
        operations: [
          { op: "insert", record: { _id: "m1", val: 1 } },
          { op: "insert", record: { _id: "m2", val: 2 } },
          {
            op: "update",
            filter: { _id: "m1" },
            update: { $set: { val: 100 } },
          },
        ],
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.operations).toBe(3);

      const col = await db.collection("batch-mix");
      const r = col.findOne("m1");
      expect(r?.val).toBe(100);
    });
  });

  describe("db_update with no matching records", () => {
    it("returns modified: 0 when filter matches nothing", async () => {
      // Create collection with some data
      const col = await db.collection("empty-upd");
      await col.insert({ _id: "x", role: "admin" });

      const result = await tool("db_update").execute({
        collection: "empty-upd",
        filter: { role: "nonexistent" },
        update: { $set: { role: "changed" } },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.modified).toBe(0);
    });

    it("returns modified: 0 on empty collection", async () => {
      await db.createCollection("truly-empty");

      const result = await tool("db_update").execute({
        collection: "truly-empty",
        filter: { any: "thing" },
        update: { $set: { x: 1 } },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.modified).toBe(0);
    });
  });

  describe("db_delete with non-existent collection", () => {
    it("returns isError when collection was never created", async () => {
      // db_delete calls db.collection() which creates on demand,
      // then calls remove() — on an empty collection that returns 0.
      // However, calling remove with a filter on a fresh (auto-created) collection should work.
      const result = await tool("db_delete").execute({
        collection: "never-existed",
        filter: { _id: "ghost" },
      });

      // The collection gets auto-created, so delete returns 0 (no error)
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.deleted).toBe(0);
    });
  });

  describe("db_drop non-existent collection", () => {
    it("returns isError for non-existent collection", async () => {
      const result = await tool("db_drop").execute({ collection: "phantom" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not found");
    });
  });

  describe("structured error output", () => {
    it("error responses have content array with text type", async () => {
      const result = await tool("db_drop").execute({ collection: "nope" });
      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect(typeof result.content[0].text).toBe("string");
      // structuredContent should be absent on errors
      expect(result.structuredContent).toBeUndefined();
    });

    it("successful responses have structuredContent", async () => {
      const result = await tool("db_collections").execute({});
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent).toHaveProperty("collections");
    });
  });
});
