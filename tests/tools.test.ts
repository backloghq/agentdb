import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDB } from "../src/agentdb.js";
import { getTools } from "../src/tools/index.js";
import type { AgentTool } from "../src/tools/index.js";

describe("Tool Definitions", () => {
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

  it("returns 23 tools", () => {
    expect(tools).toHaveLength(23);
  });

  it("every tool has required fields", () => {
    for (const t of tools) {
      expect(t.name).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(t.schema).toBeDefined();
      expect(t.annotations).toBeDefined();
      expect(typeof t.execute).toBe("function");
    }
  });

  describe("db_collections", () => {
    it("returns empty list initially", async () => {
      const result = await exec("db_collections");
      expect(result.collections).toEqual([]);
    });

    it("lists created collections", async () => {
      await exec("db_create", { collection: "users" });
      const result = await exec("db_collections");
      expect(result.collections).toHaveLength(1);
      expect(result.collections[0].name).toBe("users");
    });
  });

  describe("db_create", () => {
    it("creates a collection", async () => {
      const result = await exec("db_create", { collection: "tasks" });
      expect(result.created).toBe("tasks");
    });
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

  describe("db_schema", () => {
    it("returns field info", async () => {
      await exec("db_insert", { collection: "users", records: [
        { name: "Alice", age: 30 },
        { name: "Bob", age: 25 },
      ]});
      const result = await exec("db_schema", { collection: "users" });
      expect(result.sampleCount).toBe(2);
      const nameField = result.fields.find((f: { name: string }) => f.name === "name");
      expect(nameField?.type).toBe("string");
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

  describe("db_stats", () => {
    it("returns database stats", async () => {
      await exec("db_insert", { collection: "users", record: { name: "Alice" } });
      await exec("db_insert", { collection: "tasks", record: { title: "Task" } });
      const result = await exec("db_stats");
      expect(result.collections).toBe(2);
      expect(result.totalRecords).toBe(2);
    });
  });

  describe("error handling", () => {
    it("returns isError on failure", async () => {
      const t = tool("db_drop");
      const result = await t.execute({ collection: "nonexistent" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not found");
    });

    it("never throws", async () => {
      const t = tool("db_find_one");
      // This should not throw even with bad args
      const result = await t.execute({ collection: "nonexistent", id: "x" });
      // It either succeeds or returns isError
      expect(result.content).toBeDefined();
    });
  });

  describe("agent identity", () => {
    it("passes agent and reason to mutations", async () => {
      await exec("db_insert", {
        collection: "users",
        record: { _id: "a", name: "Alice" },
        agent: "test-bot",
        reason: "testing",
      });
      const history = await exec("db_history", { collection: "users", id: "a" });
      expect(history.operations[0].data._agent).toBe("test-bot");
      expect(history.operations[0].data._reason).toBe("testing");
    });
  });
});
