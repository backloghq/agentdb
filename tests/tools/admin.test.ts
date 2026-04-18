import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDB } from "../../src/agentdb.js";
import { getTools } from "../../src/tools/index.js";
import type { AgentTool } from "../../src/tools/index.js";
import { authContext } from "../../src/auth-context.js";

describe("Tool Definitions — admin", () => {
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

  it("returns 36 tools", () => {
    expect(tools).toHaveLength(36);
  });

  it("tool order is canonical (admin → crud → schema → migrate → archive → vector → blob → backup)", () => {
    expect(tools.map((t) => t.name)).toEqual([
      // admin
      "db_collections", "db_create", "db_drop", "db_purge", "db_stats",
      // crud
      "db_insert", "db_find", "db_find_one", "db_update", "db_upsert",
      "db_delete", "db_batch", "db_count", "db_undo", "db_history", "db_distinct",
      // schema
      "db_schema", "db_get_schema", "db_set_schema", "db_delete_schema", "db_diff_schema", "db_infer_schema",
      // migrate
      "db_migrate",
      // archive
      "db_archive", "db_archive_list", "db_archive_load",
      // vector
      "db_semantic_search", "db_embed", "db_vector_upsert", "db_vector_search",
      // blob
      "db_blob_write", "db_blob_read", "db_blob_list", "db_blob_delete",
      // backup
      "db_export", "db_import",
    ]);
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

    it("includes schema summary when schema exists", async () => {
      await exec("db_create", { collection: "typed" });
      await exec("db_set_schema", {
        collection: "typed",
        schema: {
          version: 1,
          description: "Typed data",
          instructions: "Handle carefully",
          fields: { x: { type: "string" }, y: { type: "number" } },
        },
      });

      const result = await exec("db_collections");
      const typed = result.collections.find((c: { name: string }) => c.name === "typed");
      expect(typed.schema).toBeDefined();
      expect(typed.schema.description).toBe("Typed data");
      expect(typed.schema.fieldCount).toBe(2);
      expect(typed.schema.hasInstructions).toBe(true);
      expect(typed.schema.version).toBe(1);
    });

    it("omits schema when none defined", async () => {
      await exec("db_create", { collection: "untyped" });
      const result = await exec("db_collections");
      const untyped = result.collections.find((c: { name: string }) => c.name === "untyped");
      expect(untyped.schema).toBeUndefined();
    });
  });

  describe("db_create", () => {
    it("creates a collection", async () => {
      const result = await exec("db_create", { collection: "tasks" });
      expect(result.created).toBe("tasks");
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
      const result = await t.execute({ collection: "nonexistent", id: "x" });
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

    it("auth identity used as _agent when no args.agent supplied", async () => {
      await authContext.run({ agentId: "auth-bot" }, async () => {
        await exec("db_insert", { collection: "auth-id-1", record: { x: 1 } });
      });
      const history = await exec("db_history", { collection: "auth-id-1", id: (await exec("db_find", { collection: "auth-id-1" })).records[0]._id as string });
      expect(history.operations[0].data._agent).toBe("auth-bot");
    });

    it("auth identity wins over args.agent when both provided", async () => {
      await authContext.run({ agentId: "auth-wins" }, async () => {
        await exec("db_insert", { collection: "auth-id-2", record: { x: 1 }, agent: "self-reported" });
      });
      const found = await exec("db_find", { collection: "auth-id-2" });
      const history = await exec("db_history", { collection: "auth-id-2", id: found.records[0]._id as string });
      expect(history.operations[0].data._agent).toBe("auth-wins");
    });

    it("args.agent used as _agent when no auth context is set", async () => {
      await exec("db_insert", { collection: "auth-id-3", record: { x: 1 }, agent: "explicit-bot" });
      const found = await exec("db_find", { collection: "auth-id-3" });
      const history = await exec("db_history", { collection: "auth-id-3", id: found.records[0]._id as string });
      expect(history.operations[0].data._agent).toBe("explicit-bot");
    });

    it("_agent is absent when neither auth context nor args.agent is set", async () => {
      await exec("db_insert", { collection: "auth-id-4", record: { x: 1 } });
      const found = await exec("db_find", { collection: "auth-id-4" });
      const history = await exec("db_history", { collection: "auth-id-4", id: found.records[0]._id as string });
      expect(history.operations[0].data._agent).toBeUndefined();
    });
  });
});
