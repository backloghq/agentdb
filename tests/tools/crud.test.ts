import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDB } from "../../src/agentdb.js";
import { getTools } from "../../src/tools/index.js";
import type { AgentTool } from "../../src/tools/index.js";

describe("Tool Definitions — crud", () => {
  let tmpDir: string;
  let db: AgentDB;
  let tools: AgentTool[];

  function tool(name: string): AgentTool {
    const t = tools.find((t) => t.name === name);
    if (!t) throw new Error(`Tool '${name}' not found`);
    return t;
  }

  async function exec(name: string, args: Record<string, unknown> = {}) {
    const t = tool(name);
    const result = await t.execute(args);
    if (result.isError) throw new Error(result.content[0].text);
    return JSON.parse(result.content[0].text);
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agentdb-tools-"));
    db = new AgentDB(tmpDir);
    await db.init();
    tools = getTools(db);
  });

  afterEach(async () => {
    await db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("db_insert + db_find", () => {
    it("inserts and finds records", async () => {
      await exec("db_insert", {
        collection: "users",
        record: { name: "Alice", role: "admin" },
      });

      const result = await exec("db_find", { collection: "users" });
      expect(result.total).toBe(1);
      expect(result.records[0].name).toBe("Alice");
    });

    it("inserts multiple records", async () => {
      await exec("db_insert", {
        collection: "users",
        records: [{ name: "Alice" }, { name: "Bob" }],
      });

      const result = await exec("db_find", { collection: "users" });
      expect(result.total).toBe(2);
    });

    it("finds with filter", async () => {
      await exec("db_insert", { collection: "users", records: [
        { name: "Alice", role: "admin" },
        { name: "Bob", role: "user" },
      ]});

      const result = await exec("db_find", { collection: "users", filter: { role: "admin" } });
      expect(result.total).toBe(1);
      expect(result.records[0].name).toBe("Alice");
    });

    it("supports pagination", async () => {
      await exec("db_insert", { collection: "users", records: [
        { name: "A" }, { name: "B" }, { name: "C" },
      ]});

      const result = await exec("db_find", { collection: "users", limit: 2, offset: 0 });
      expect(result.records).toHaveLength(2);
      expect(result.truncated).toBe(true);
    });
  });

  describe("db_find_one", () => {
    it("finds by id", async () => {
      await exec("db_insert", { collection: "users", record: { _id: "a1", name: "Alice" } });
      const result = await exec("db_find_one", { collection: "users", id: "a1" });
      expect(result.record.name).toBe("Alice");
    });

    it("returns null for missing record", async () => {
      await exec("db_create", { collection: "users" });
      const result = await exec("db_find_one", { collection: "users", id: "missing" });
      expect(result.record).toBeNull();
    });
  });

  describe("db_update", () => {
    it("updates matching records", async () => {
      await exec("db_insert", { collection: "users", records: [
        { _id: "a", name: "Alice", role: "user" },
        { _id: "b", name: "Bob", role: "user" },
      ]});

      const result = await exec("db_update", {
        collection: "users",
        filter: { role: "user" },
        update: { $set: { role: "admin" } },
      });
      expect(result.modified).toBe(2);

      const alice = await exec("db_find_one", { collection: "users", id: "a" });
      expect(alice.record.role).toBe("admin");
    });
  });

  describe("db_upsert", () => {
    it("inserts when not exists", async () => {
      const result = await exec("db_upsert", {
        collection: "users",
        id: "new",
        record: { name: "New" },
      });
      expect(result.action).toBe("inserted");
    });

    it("updates when exists", async () => {
      await exec("db_insert", { collection: "users", record: { _id: "x", name: "Old" } });
      const result = await exec("db_upsert", {
        collection: "users",
        id: "x",
        record: { name: "Updated" },
      });
      expect(result.action).toBe("updated");
    });
  });

  describe("db_delete", () => {
    it("deletes matching records", async () => {
      await exec("db_insert", { collection: "users", records: [
        { _id: "a", role: "admin" },
        { _id: "b", role: "user" },
      ]});

      const result = await exec("db_delete", { collection: "users", filter: { role: "admin" } });
      expect(result.deleted).toBe(1);

      const count = await exec("db_count", { collection: "users" });
      expect(count.count).toBe(1);
    });
  });

  describe("db_count", () => {
    it("counts all records", async () => {
      await exec("db_insert", { collection: "users", records: [{ name: "A" }, { name: "B" }] });
      const result = await exec("db_count", { collection: "users" });
      expect(result.count).toBe(2);
    });

    it("counts with filter", async () => {
      await exec("db_insert", { collection: "users", records: [
        { role: "admin" }, { role: "user" }, { role: "admin" },
      ]});
      const result = await exec("db_count", { collection: "users", filter: { role: "admin" } });
      expect(result.count).toBe(2);
    });
  });

  describe("db_undo", () => {
    it("undoes last mutation", async () => {
      await exec("db_insert", { collection: "users", record: { _id: "a", name: "Alice" } });
      await exec("db_undo", { collection: "users" });
      const count = await exec("db_count", { collection: "users" });
      expect(count.count).toBe(0);
    });
  });

  describe("db_history", () => {
    it("returns operation history", async () => {
      await exec("db_insert", { collection: "users", record: { _id: "a", name: "V1" } });
      await exec("db_update", { collection: "users", filter: { _id: "a" }, update: { $set: { name: "V2" } } });
      const result = await exec("db_history", { collection: "users", id: "a" });
      expect(result.operations).toHaveLength(2);
    });
  });

  describe("db_distinct", () => {
    it("returns unique values", async () => {
      await exec("db_insert", { collection: "users", records: [
        { role: "admin" }, { role: "user" }, { role: "admin" },
      ]});
      const result = await exec("db_distinct", { collection: "users", field: "role" });
      expect(result.count).toBe(2);
    });
  });

  describe("db_batch", () => {
    it("executes multiple insert operations atomically", async () => {
      const result = await exec("db_batch", {
        collection: "batch-test",
        operations: [
          { op: "insert", record: { _id: "b1", name: "One" } },
          { op: "insert", record: { _id: "b2", name: "Two" } },
          { op: "insert", record: { _id: "b3", name: "Three" } },
        ],
      });
      expect(result.operations).toBeGreaterThanOrEqual(3);

      const count = await exec("db_count", { collection: "batch-test" });
      expect(count.count).toBe(3);
    });
  });
});
