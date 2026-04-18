import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDB } from "../src/agentdb.js";
import { defineSchema } from "../src/schema.js";
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

  it("returns 34 tools", () => {
    expect(tools).toHaveLength(34);
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

  describe("db_get_schema", () => {
    it("returns null when no schema defined", async () => {
      await exec("db_create", { collection: "empty" });
      const result = await exec("db_get_schema", { collection: "empty" });
      expect(result.schema).toBeNull();
      expect(result.hasCodeSchema).toBe(false);
    });

    it("returns persisted schema", async () => {
      // Persist a schema manually via db_set_schema
      await exec("db_set_schema", {
        collection: "typed",
        schema: {
          version: 1,
          description: "Typed collection",
          instructions: "Always set priority",
          fields: {
            title: { type: "string", required: true, description: "Short title" },
            priority: { type: "enum", values: ["H", "M", "L"], description: "Task priority" },
          },
          indexes: ["priority"],
        },
      });

      const result = await exec("db_get_schema", { collection: "typed" });
      expect(result.schema).not.toBeNull();
      expect(result.schema.description).toBe("Typed collection");
      expect(result.schema.instructions).toBe("Always set priority");
      expect(result.schema.fields.title.description).toBe("Short title");
      expect(result.schema.fields.priority.values).toEqual(["H", "M", "L"]);
      expect(result.schema.indexes).toEqual(["priority"]);
    });
  });

  describe("db_set_schema", () => {
    it("creates a new schema", async () => {
      await exec("db_set_schema", {
        collection: "new-schema",
        schema: {
          version: 1,
          description: "Test collection",
          fields: { title: { type: "string", required: true } },
        },
      });

      const result = await exec("db_get_schema", { collection: "new-schema" });
      expect(result.schema.description).toBe("Test collection");
      expect(result.schema.version).toBe(1);
    });

    it("merges with existing schema", async () => {
      // Create initial schema
      await exec("db_set_schema", {
        collection: "mergeable",
        schema: {
          version: 1,
          description: "Initial",
          fields: { title: { type: "string" } },
          indexes: ["title"],
        },
      });

      // Update with additional fields and indexes
      await exec("db_set_schema", {
        collection: "mergeable",
        schema: {
          description: "Updated",
          fields: { status: { type: "enum", values: ["open", "done"] } },
          indexes: ["status"],
        },
      });

      const result = await exec("db_get_schema", { collection: "mergeable" });
      expect(result.schema.description).toBe("Updated");
      expect(result.schema.version).toBe(1); // version preserved from original
      expect(result.schema.fields.title).toBeDefined(); // original field kept
      expect(result.schema.fields.status).toBeDefined(); // new field added
      expect(result.schema.indexes).toContain("title");
      expect(result.schema.indexes).toContain("status");
    });

    it("preserves untouched field properties when updating a single property", async () => {
      await exec("db_set_schema", {
        collection: "partial-update",
        schema: {
          fields: { title: { type: "string", required: true, description: "The title field" } },
        },
      });

      // Agent updates only the type — required and description must survive
      await exec("db_set_schema", {
        collection: "partial-update",
        schema: {
          fields: { title: { type: "string" } },
        },
      });

      const result = await exec("db_get_schema", { collection: "partial-update" });
      expect(result.schema.fields.title.required).toBe(true);
      expect(result.schema.fields.title.description).toBe("The title field");
    });
  });

  describe("db_delete_schema", () => {
    it("deletes an existing schema and returns deleted: true", async () => {
      await exec("db_set_schema", {
        collection: "to-delete",
        schema: { description: "Temporary" },
      });

      const result = await exec("db_delete_schema", { collection: "to-delete" });
      expect(result.deleted).toBe(true);

      const check = await exec("db_get_schema", { collection: "to-delete" });
      expect(check.schema).toBeNull();
    });

    it("returns deleted: false when no schema exists (idempotent)", async () => {
      const result = await exec("db_delete_schema", { collection: "never-had-schema" });
      expect(result.deleted).toBe(false);
    });

    it("is idempotent — second delete returns deleted: false", async () => {
      await exec("db_set_schema", {
        collection: "delete-twice",
        schema: { description: "Will be deleted" },
      });
      const first = await exec("db_delete_schema", { collection: "delete-twice" });
      expect(first.deleted).toBe(true);
      const second = await exec("db_delete_schema", { collection: "delete-twice" });
      expect(second.deleted).toBe(false);
    });

    it("returns isError when non-admin agent attempts delete", async () => {
      const restrictedDb = new AgentDB(tmpDir + "-restricted", {
        permissions: { reader: { read: true, write: false, admin: false } },
      });
      await restrictedDb.init();
      const restrictedTools = getTools(restrictedDb);
      const t = restrictedTools.find((t) => t.name === "db_delete_schema")!;
      const result = await t.execute({ collection: "any", agent: "reader" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Permission denied");
      await restrictedDb.close();
      await rm(tmpDir + "-restricted", { recursive: true, force: true });
    });

    it("hasCodeSchema remains true after deleting persisted schema from a defineSchema collection", async () => {
      const schema = defineSchema({
        name: "code-schema-col",
        fields: { title: { type: "string" } },
      });
      await db.collection(schema);

      // Persisted schema exists now; delete it
      const del = await exec("db_delete_schema", { collection: "code-schema-col" });
      expect(del.deleted).toBe(true);

      // In-memory code schema still active; persisted schema gone
      const check = await exec("db_get_schema", { collection: "code-schema-col" });
      expect(check.schema).toBeNull();
      expect(check.hasCodeSchema).toBe(true);
    });

    it("returns deleted:false and leaves in-memory schema intact when no persisted file exists for a defineSchema collection", async () => {
      const schema = defineSchema({
        name: "code-only-col",
        fields: { value: { type: "number" } },
      });
      await db.collection(schema);

      // Delete the persisted schema first so only in-memory remains
      await exec("db_delete_schema", { collection: "code-only-col" });

      // Second delete — no persisted file, should return false without touching in-memory schema
      const result = await exec("db_delete_schema", { collection: "code-only-col" });
      expect(result.deleted).toBe(false);

      // In-memory schema must still be registered
      expect(db.getSchema("code-only-col")).toBeDefined();
    });

    it("auto-repersists schema after delete when database is restarted and collection is re-opened", async () => {
      const schemaDef = defineSchema({
        name: "repersist-col",
        description: "Will be repersisted",
        fields: { name: { type: "string" } },
      });
      await db.collection(schemaDef);

      await exec("db_delete_schema", { collection: "repersist-col" });
      const afterDelete = await exec("db_get_schema", { collection: "repersist-col" });
      expect(afterDelete.schema).toBeNull();

      // Auto-persist runs in _openCollection (first open, not cached re-open).
      // Simulate a restart: close current db, reopen, then open the collection with defineSchema.
      await db.close();
      const db2 = new AgentDB(tmpDir);
      await db2.init();
      await db2.collection(schemaDef);
      const tools2 = getTools(db2);
      const getResult = await tools2.find((t) => t.name === "db_get_schema")!.execute({ collection: "repersist-col" });
      const afterRepersist = JSON.parse(getResult.content[0].text);
      expect(afterRepersist.schema).not.toBeNull();
      expect(afterRepersist.schema.description).toBe("Will be repersisted");
      await db2.close();
      // Re-initialize db for afterEach cleanup (db.close() would double-close otherwise)
      db = new AgentDB(tmpDir);
      await db.init();
      tools = getTools(db);
    });
  });

  describe("db_diff_schema", () => {
    it("no existing schema — everything in candidate is added", async () => {
      await exec("db_create", { collection: "diff-new" });
      const result = await exec("db_diff_schema", {
        collection: "diff-new",
        schema: {
          description: "A new collection",
          fields: { name: { type: "string" }, age: { type: "number" } },
          indexes: ["name"],
        },
      });
      expect(result.hasExisting).toBe(false);
      expect(result.added.fields).toEqual(expect.arrayContaining(["name", "age"]));
      expect(result.added.indexes).toEqual(["name"]);
      expect(result.removed.fields).toEqual([]);
      expect(result.changed.fields).toEqual({});
      expect(result.warnings).toEqual([]);
      expect(result.impact.totalRecords).toBe(0);
    });

    it("identical candidate — no changes and no warnings", async () => {
      await exec("db_create", { collection: "diff-same" });
      await exec("db_set_schema", {
        collection: "diff-same",
        schema: { description: "Stable", fields: { x: { type: "string" } } },
        agent: "admin",
      });
      const result = await exec("db_diff_schema", {
        collection: "diff-same",
        schema: { description: "Stable", fields: { x: { type: "string" } } },
      });
      expect(result.hasExisting).toBe(true);
      expect(result.added.fields).toEqual([]);
      expect(result.removed.fields).toEqual([]);
      expect(result.changed.fields).toEqual({});
      expect(result.warnings).toEqual([]);
    });

    it("type change with records — high warning with record count", async () => {
      await exec("db_create", { collection: "diff-type" });
      await exec("db_set_schema", {
        collection: "diff-type",
        schema: { fields: { score: { type: "number" } } },
        agent: "admin",
      });
      await exec("db_insert", { collection: "diff-type", records: [{ score: 10 }, { score: 20 }] });
      const result = await exec("db_diff_schema", {
        collection: "diff-type",
        schema: { fields: { score: { type: "string" } } },
      });
      expect(result.changed.fields.score.type).toEqual({ from: "number", to: "string" });
      const highWarn = result.warnings.find((w: { severity: string; message: string }) => w.severity === "high" && w.message.includes("score") && w.message.includes("type changed"));
      expect(highWarn).toBeDefined();
      expect(highWarn.message).toMatch(/2 records affected/);
      expect(result.impact.totalRecords).toBe(2);
    });

    it("required:true added with records missing field — medium warning with count", async () => {
      await exec("db_create", { collection: "diff-req" });
      await exec("db_set_schema", {
        collection: "diff-req",
        schema: { fields: { email: { type: "string" } } },
        agent: "admin",
      });
      await exec("db_insert", { collection: "diff-req", records: [
        { email: "a@b.com" },
        { name: "NoEmail" },
      ] });
      const result = await exec("db_diff_schema", {
        collection: "diff-req",
        schema: { fields: { email: { type: "string", required: true } } },
      });
      expect(result.changed.fields.email.required).toEqual({ from: false, to: true });
      const medWarn = result.warnings.find((w: { severity: string; message: string }) => w.severity === "medium" && w.message.includes("email") && w.message.includes("required"));
      expect(medWarn).toBeDefined();
      expect(medWarn.message).toMatch(/1 records missing field/);
      expect(result.impact.recordsViolatingNewConstraints).toBe(1);
    });

    it("enum value removed where records use it — high warning with count", async () => {
      await exec("db_create", { collection: "diff-enum" });
      await exec("db_set_schema", {
        collection: "diff-enum",
        schema: { fields: { status: { type: "enum", values: ["active", "inactive", "pending"] } } },
        agent: "admin",
      });
      await exec("db_insert", { collection: "diff-enum", records: [
        { status: "active" },
        { status: "pending" },
        { status: "pending" },
      ] });
      const result = await exec("db_diff_schema", {
        collection: "diff-enum",
        schema: { fields: { status: { type: "enum", values: ["active", "inactive"] } } },
      });
      expect(result.changed.fields.status.values.removed).toEqual(["pending"]);
      const highWarn = result.warnings.find((w: { severity: string; message: string }) => w.severity === "high" && w.message.includes("status") && w.message.includes("enum removed"));
      expect(highWarn).toBeDefined();
      expect(highWarn.message).toMatch(/2 records affected/);
      expect(result.impact.recordsViolatingNewConstraints).toBe(2);
    });

    it("includeImpact:false — no impact field, no record scanning", async () => {
      await exec("db_create", { collection: "diff-noimpact" });
      await exec("db_set_schema", {
        collection: "diff-noimpact",
        schema: { fields: { score: { type: "number" } } },
        agent: "admin",
      });
      await exec("db_insert", { collection: "diff-noimpact", records: [{ score: 5 }] });
      const result = await exec("db_diff_schema", {
        collection: "diff-noimpact",
        schema: { fields: { score: { type: "string" } } },
        includeImpact: false,
      });
      expect(result.impact).toBeUndefined();
      const highWarn = result.warnings.find((w: { severity: string; message: string }) => w.severity === "high" && w.message.includes("type changed"));
      expect(highWarn).toBeDefined();
      expect(highWarn.message).not.toMatch(/records affected/);
    });

    it("partial candidate (no fields key) — no field changes, proves merge semantics", async () => {
      await exec("db_create", { collection: "diff-partial" });
      await exec("db_set_schema", {
        collection: "diff-partial",
        schema: {
          description: "Old description",
          fields: { name: { type: "string" }, age: { type: "number" } },
        },
        agent: "admin",
      });
      const result = await exec("db_diff_schema", {
        collection: "diff-partial",
        schema: { description: "New description" },
      });
      // Fields should be unchanged — partial candidate preserves existing fields
      expect(result.removed.fields).toEqual([]);
      expect(result.added.fields).toEqual([]);
      expect(result.changed.fields).toEqual({});
      // Only description changed
      expect(result.changed.description).toEqual({ from: "Old description", to: "New description" });
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

  describe("db_archive tools", () => {
    it("archives and lists segments", async () => {
      await exec("db_insert", { collection: "logs", records: [
        { _id: "1", status: "done", msg: "old" },
        { _id: "2", status: "active", msg: "new" },
      ]});

      const archived = await exec("db_archive", {
        collection: "logs",
        filter: { status: "done" },
        segment: "2026-Q1",
      });
      expect(archived.archived).toBe(1);

      const segments = await exec("db_archive_list", { collection: "logs" });
      expect(segments.segments.length).toBeGreaterThan(0);

      const loaded = await exec("db_archive_load", {
        collection: "logs",
        segment: "2026-Q1",
      });
      expect(loaded.count).toBe(1);

      // Active record still there
      const count = await exec("db_count", { collection: "logs" });
      expect(count.count).toBe(1);
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

  describe("db_export / db_import", () => {
    it("round-trips data", async () => {
      await exec("db_insert", { collection: "items", records: [
        { _id: "a", name: "A" },
        { _id: "b", name: "B" },
      ]});

      const exported = await exec("db_export", { collections: ["items"] });
      expect(exported.collections.items.records).toHaveLength(2);

      // Import into a new collection (simulated by checking structure)
      const imported = await exec("db_import", {
        data: exported,
        overwrite: false,
      });
      expect(imported.records).toBe(2);
    });
  });

  describe("db_semantic_search and db_embed", () => {
    it("db_embed returns 0 when no provider configured", async () => {
      await exec("db_create", { collection: "noembed" });
      const result = await exec("db_embed", { collection: "noembed" });
      expect(result.embedded).toBe(0);
    });

    it("db_semantic_search returns error when no provider configured", async () => {
      const t = tool("db_semantic_search");
      const result = await t.execute({ collection: "users", query: "test" });
      expect(result.isError).toBe(true);
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
  });
});
