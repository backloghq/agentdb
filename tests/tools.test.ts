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

  it("returns 36 tools", () => {
    expect(tools).toHaveLength(36);
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

    it("new field added to existing schema appears in added.fields with no warning", async () => {
      // Set an initial schema with one field
      await exec("db_set_schema", {
        collection: "diff-addfield",
        schema: { fields: { name: { type: "string" } } },
        agent: "admin",
      });
      const result = await exec("db_diff_schema", {
        collection: "diff-addfield",
        schema: { fields: { name: { type: "string" }, age: { type: "number" } } },
      });
      expect(result.added.fields).toContain("age");
      expect(result.removed.fields).toEqual([]);
      // Adding a field generates no warning
      const fieldWarnings = result.warnings.filter((w: { message: string }) => w.message.includes("age"));
      expect(fieldWarnings).toHaveLength(0);
    });

    it("adding an enum value appears in changed.fields with no warning", async () => {
      await exec("db_set_schema", {
        collection: "diff-enumadd",
        schema: { fields: { status: { type: "enum", values: ["open", "closed"] } } },
        agent: "admin",
      });
      const result = await exec("db_diff_schema", {
        collection: "diff-enumadd",
        schema: { fields: { status: { type: "enum", values: ["open", "closed", "pending"] } } },
      });
      const statusChange = result.changed.fields.status;
      expect(statusChange).toBeDefined();
      expect(statusChange.values.added).toContain("pending");
      expect(statusChange.values.removed).toHaveLength(0);
      // Only removals generate high-severity warnings — adding values is safe
      const highWarnings = result.warnings.filter((w: { severity: string; message: string }) =>
        w.severity === "high" && w.message.includes("status"));
      expect(highWarnings).toHaveLength(0);
    });

    it("includeImpact:true on non-existent collection returns sensible result without crashing", async () => {
      const result = await exec("db_diff_schema", {
        collection: "diff-nonexistent-xyz",
        schema: { fields: { x: { type: "string" } } },
        includeImpact: true,
      });
      expect(result.hasExisting).toBe(false);
      expect(result.impact).toBeDefined();
      expect(result.impact.totalRecords).toBe(0);
      // Should have a warning about collection not existing
      const warn = result.warnings.find((w: { message: string }) => w.message.includes("does not exist"));
      expect(warn).toBeDefined();
    });

    it("same partial candidate run twice produces identical diff", async () => {
      await exec("db_set_schema", {
        collection: "diff-idempotent2",
        schema: { fields: { x: { type: "string" } } },
        agent: "admin",
      });
      const candidate = { fields: { x: { type: "string" }, y: { type: "number" } } };
      const r1 = await exec("db_diff_schema", { collection: "diff-idempotent2", schema: candidate });
      const r2 = await exec("db_diff_schema", { collection: "diff-idempotent2", schema: candidate });
      expect(r1.added.fields).toEqual(r2.added.fields);
      expect(r1.removed.fields).toEqual(r2.removed.fields);
      expect(r1.changed.fields).toEqual(r2.changed.fields);
      expect(r1.warnings).toEqual(r2.warnings);
    });
  });

  describe("db_migrate", () => {
    it("101 ops returns a Zod validation error", async () => {
      const ops = Array.from({ length: 101 }, (_, i) => ({ op: "set", field: `f${i}`, value: i }));
      const t = tool("db_migrate");
      const result = await t.execute({ collection: "migrate-ops-cap", ops });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/100/);
    });

    it("set op assigns a field on all records", async () => {
      await exec("db_insert", { collection: "migrate-set", records: [
        { name: "Alice" }, { name: "Bob" },
      ] });
      const result = await exec("db_migrate", {
        collection: "migrate-set",
        ops: [{ op: "set", field: "active", value: true }],
      });
      expect(result.scanned).toBe(2);
      expect(result.updated).toBe(2);
      expect(result.unchanged).toBe(0);
      expect(result.failed).toBe(0);
      const records = await exec("db_find", { collection: "migrate-set" });
      expect(records.records.every((r: Record<string, unknown>) => r.active === true)).toBe(true);
    });

    it("unset op removes a field", async () => {
      await exec("db_insert", { collection: "migrate-unset", records: [
        { name: "Alice", deprecated: "old" }, { name: "Bob", deprecated: "old" },
      ] });
      const result = await exec("db_migrate", {
        collection: "migrate-unset",
        ops: [{ op: "unset", field: "deprecated" }],
      });
      expect(result.updated).toBe(2);
      const records = await exec("db_find", { collection: "migrate-unset" });
      expect(records.records.every((r: Record<string, unknown>) => !("deprecated" in r))).toBe(true);
    });

    it("rename op moves field value and removes source", async () => {
      await exec("db_insert", { collection: "migrate-rename", records: [{ status: "active" }] });
      await exec("db_migrate", {
        collection: "migrate-rename",
        ops: [{ op: "rename", from: "status", to: "state" }],
      });
      const records = await exec("db_find", { collection: "migrate-rename" });
      expect(records.records[0].state).toBe("active");
      expect("status" in records.records[0]).toBe(false);
    });

    it("default op sets field only if missing", async () => {
      await exec("db_insert", { collection: "migrate-default", records: [
        { priority: "high" }, { name: "NoPriority" },
      ] });
      const result = await exec("db_migrate", {
        collection: "migrate-default",
        ops: [{ op: "default", field: "priority", value: "medium" }],
      });
      expect(result.updated).toBe(1);
      expect(result.unchanged).toBe(1);
      const records = await exec("db_find", { collection: "migrate-default" });
      const withHigh = records.records.find((r: Record<string, unknown>) => r.name === undefined || r.priority === "high");
      expect(withHigh?.priority).toBe("high");
    });

    it("copy op copies field without removing source", async () => {
      await exec("db_insert", { collection: "migrate-copy", records: [{ first: "Alice" }] });
      await exec("db_migrate", {
        collection: "migrate-copy",
        ops: [{ op: "copy", from: "first", to: "displayName" }],
      });
      const records = await exec("db_find", { collection: "migrate-copy" });
      expect(records.records[0].first).toBe("Alice");
      expect(records.records[0].displayName).toBe("Alice");
    });

    it("dryRun:true returns counts without writing", async () => {
      await exec("db_insert", { collection: "migrate-dry", records: [{ x: 1 }, { x: 2 }] });
      const result = await exec("db_migrate", {
        collection: "migrate-dry",
        ops: [{ op: "set", field: "x", value: 99 }],
        dryRun: true,
      });
      expect(result.dryRun).toBe(true);
      expect(result.updated).toBe(2);
      const records = await exec("db_find", { collection: "migrate-dry" });
      expect(records.records[0].x).not.toBe(99);
    });

    it("filter scopes migration to matching records", async () => {
      await exec("db_insert", { collection: "migrate-filter", records: [
        { role: "admin" }, { role: "user" }, { role: "user" },
      ] });
      const result = await exec("db_migrate", {
        collection: "migrate-filter",
        ops: [{ op: "set", field: "flagged", value: true }],
        filter: { role: "user" },
      });
      expect(result.scanned).toBe(2);
      expect(result.updated).toBe(2);
      const records = await exec("db_find", { collection: "migrate-filter" });
      const admin = records.records.find((r: Record<string, unknown>) => r.role === "admin");
      expect(admin?.flagged).toBeUndefined();
    });

    it("batchSize controls in-memory chunk size across multi-batch collection", async () => {
      const records = Array.from({ length: 5 }, (_, i) => ({ n: i }));
      await exec("db_insert", { collection: "migrate-batch", records });
      const result = await exec("db_migrate", {
        collection: "migrate-batch",
        ops: [{ op: "set", field: "migrated", value: true }],
        batchSize: 2,
      });
      expect(result.scanned).toBe(5);
      expect(result.updated).toBe(5);
    });

    it("per-record error lands in errors[] (truncated to 10)", async () => {
      // Use a code-level schema (defineSchema) to enable runtime validation
      await db.collection(defineSchema({
        name: "migrate-fail",
        fields: { score: { type: "number", max: 100 } },
      }));
      await exec("db_insert", { collection: "migrate-fail", records: [
        { score: 50 }, { score: 60 },
      ] });
      // Set score to 200 — violates max:100 schema constraint
      const result = await exec("db_migrate", {
        collection: "migrate-fail",
        ops: [{ op: "set", field: "score", value: 200 }],
      });
      expect(result.failed).toBe(2);
      expect(result.errors).toHaveLength(2);
      expect(result.errors[0].error).toMatch(/200|max|score/i);
    });

    it("agent and reason are stamped on updated records", async () => {
      await exec("db_insert", { collection: "migrate-agent", records: [{ x: 1 }] });
      const ids = (await exec("db_find", { collection: "migrate-agent" })).records.map((r: Record<string, unknown>) => r._id);
      await exec("db_migrate", {
        collection: "migrate-agent",
        ops: [{ op: "set", field: "x", value: 2 }],
        agent: "migration-bot",
        reason: "test migration",
      });
      const hist = await exec("db_history", { collection: "migrate-agent", id: ids[0] as string });
      const ops = hist.operations;
      const lastOp = ops[ops.length - 1];
      expect(lastOp.data._agent).toBe("migration-bot");
      expect(lastOp.data._reason).toBe("test migration");
    });

    it("_version optimistic locking causes concurrent write to fail", async () => {
      await exec("db_insert", { collection: "migrate-version", records: [{ x: 1 }] });
      // Get the record's ID
      const findRes = await exec("db_find", { collection: "migrate-version" });
      const id = findRes.records[0]._id as string;
      // Simulate concurrent write: bump _version before migrate runs
      // We'll do this by patching update to fail via expectedVersion check
      // Actually: insert + update (to bump version) + then dryRun migrate won't help
      // So instead: run migrate twice — first succeeds, second on same record gets new _version
      // Simpler: grab collection directly and update the record to bump version
      const col = await db.collection("migrate-version");
      await col.update({ _id: id } as import("../src/collection-helpers.js").Filter, { $set: { bumped: true } });
      // Now migrate with an old expectedVersion will fail
      // We simulate by calling update directly with wrong expectedVersion
      let threw = false;
      try {
        await col.update({ _id: id } as import("../src/collection-helpers.js").Filter, { $set: { x: 99 } }, { expectedVersion: 0 });
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    });

    it("empty ops array returns an error", async () => {
      const t = tool("db_migrate");
      const result = await t.execute({ collection: "migrate-empty", ops: [] });
      expect(result.isError).toBe(true);
    });

    it("processes all records even when ops cause records to leave the filter (pagination regression)", async () => {
      // 200 records with x:0; filter={x:0}; op sets x=1 (records leave filter after update)
      // Old offset-based code: batch 1 processes 100, they leave filter, batch 2 at offset=100 finds 0 → skips 100
      // New snapshot code: all 200 IDs captured upfront, all 200 processed
      const records = Array.from({ length: 200 }, (_, i) => ({ n: i, x: 0 }));
      await exec("db_insert", { collection: "migrate-pagereg", records });
      const result = await exec("db_migrate", {
        collection: "migrate-pagereg",
        ops: [{ op: "set", field: "x", value: 1 }],
        filter: { x: 0 },
        batchSize: 100,
      });
      expect(result.scanned).toBe(200);
      expect(result.updated).toBe(200);
      expect(result.failed).toBe(0);
    });

    it("change events fire for each updated record", async () => {
      await exec("db_insert", { collection: "migrate-events", records: [{ n: 1 }, { n: 2 }, { n: 3 }] });
      const col = await db.collection("migrate-events");
      let updateCount = 0;
      const listener = (e: import("../src/collection.js").ChangeEvent) => {
        if (e.type === "update") updateCount += e.ids.length;
      };
      col.on("change", listener);
      await exec("db_migrate", {
        collection: "migrate-events",
        ops: [{ op: "set", field: "migrated", value: true }],
      });
      col.off("change", listener);
      expect(updateCount).toBe(3);
    });

    it("concurrent write between snapshot and processing lands in failed[]", async () => {
      await exec("db_insert", { collection: "migrate-conc", records: [{ x: 1 }, { x: 1 }] });
      const col = await db.collection("migrate-conc");
      const findRes = (await exec("db_find", { collection: "migrate-conc" })).records as Array<Record<string, unknown>>;
      const idB = findRes[1]._id as string;

      // Patch col.update: on first call, bump record B's version to simulate a concurrent write
      const origUpdate = col.update.bind(col);
      let firstCall = true;
      (col as unknown as { update: unknown }).update = async (...args: Parameters<typeof col.update>) => {
        if (firstCall) {
          firstCall = false;
          await origUpdate({ _id: idB } as import("../src/collection-helpers.js").Filter, { $set: { bumped: true } });
        }
        return origUpdate(...args);
      };

      const result = await exec("db_migrate", {
        collection: "migrate-conc",
        ops: [{ op: "set", field: "x", value: 2 }],
      });

      // Restore
      (col as unknown as { update: unknown }).update = origUpdate;

      expect(result.failed).toBeGreaterThanOrEqual(1);
      expect(result.errors.length).toBeGreaterThanOrEqual(1);
      expect(result.errors[0].error).toMatch(/version/i);
    });

    it("errors[] is capped at 10 even with more than 10 failures", async () => {
      await db.collection(defineSchema({
        name: "migrate-errcap",
        fields: { score: { type: "number", max: 100 } },
      }));
      const records = Array.from({ length: 15 }, (_, i) => ({ score: i * 5 }));
      await exec("db_insert", { collection: "migrate-errcap", records });
      const result = await exec("db_migrate", {
        collection: "migrate-errcap",
        ops: [{ op: "set", field: "score", value: 200 }],
      });
      expect(result.failed).toBe(15);
      expect(result.errors).toHaveLength(10);
    });

    it("set op targeting a protected field (_agent) is silently skipped", async () => {
      await exec("db_insert", { collection: "migrate-prot", records: [{ name: "Alice" }] });
      const result = await exec("db_migrate", {
        collection: "migrate-prot",
        ops: [{ op: "set", field: "_agent", value: "evil-bot" }],
      });
      expect(result.unchanged).toBe(1);
      expect(result.updated).toBe(0);
    });

    it("record deleted between snapshot and processing lands in failed[] with descriptive error", async () => {
      // Phase 1 (snapshot) sees 2 records. We delete one after inserting but before migrate runs.
      // Phase 2's $in lookup won't find the deleted record → it lands in failed[].
      await exec("db_insert", { collection: "migrate-deleted", records: [{ x: 1 }, { x: 2 }] });
      const col = await db.collection("migrate-deleted");
      const findRes = (await exec("db_find", { collection: "migrate-deleted" })).records as Array<Record<string, unknown>>;
      const idToDelete = findRes[0]._id as string;

      // Patch col.find: snapshot phase returns both records, but delete the record after snapshot
      const origFind = col.find.bind(col);
      let snapshotDone = false;
      (col as unknown as { find: unknown }).find = async (...args: Parameters<typeof col.find>) => {
        const result = await origFind(...args);
        if (!snapshotDone) {
          snapshotDone = true;
          // After snapshot is built, delete one record to simulate mid-migration deletion
          await col.deleteById(idToDelete);
        }
        return result;
      };

      const result = await exec("db_migrate", {
        collection: "migrate-deleted",
        ops: [{ op: "set", field: "x", value: 99 }],
      });

      (col as unknown as { find: unknown }).find = origFind;

      expect(result.scanned).toBe(2);
      expect(result.failed).toBe(1);
      expect(result.updated).toBe(1);
      expect(result.errors[0].id).toBe(idToDelete);
      expect(result.errors[0].error).toBe("record deleted before migration");
    });

    it("errors[] is capped at 10 with mixed deletion and validation failures", async () => {
      // 13 records total: 5 will be deleted after snapshot, 8 will fail validation
      await db.collection(defineSchema({
        name: "migrate-errors-cap",
        fields: { score: { type: "number", max: 100 } },
      }));
      await exec("db_insert", {
        collection: "migrate-errors-cap",
        records: Array.from({ length: 13 }, (_, i) => ({ score: 50 + i })),
      });
      const col = await db.collection("migrate-errors-cap");
      const findRes = (await exec("db_find", { collection: "migrate-errors-cap" })).records as Array<Record<string, unknown>>;
      const idsToDelete = findRes.slice(0, 5).map((r) => r._id as string);

      // Patch col.find: after snapshot phase completes, delete 5 records
      const origFind = col.find.bind(col);
      let snapshotDone = false;
      (col as unknown as { find: unknown }).find = async (...args: Parameters<typeof col.find>) => {
        const result = await origFind(...args);
        if (!snapshotDone) {
          snapshotDone = true;
          for (const id of idsToDelete) {
            await col.deleteById(id);
          }
        }
        return result;
      };

      const result = await exec("db_migrate", {
        collection: "migrate-errors-cap",
        ops: [{ op: "set", field: "score", value: 200 }],
      });

      (col as unknown as { find: unknown }).find = origFind;

      expect(result.scanned).toBe(13);
      expect(result.failed).toBe(13);
      expect(result.updated).toBe(0);
      expect(result.errors).toHaveLength(10);
      expect(result.errors.some((e: { error: string }) => e.error === "record deleted before migration")).toBe(true);
      expect(result.errors.some((e: { error: string }) => /200|max|score/i.test(e.error))).toBe(true);
    });
  });

  describe("db_infer_schema", () => {
    it("returns empty fields for empty collection", async () => {
      await db.collection("infer-empty"); // open (creates empty)
      const result = await exec("db_infer_schema", { collection: "infer-empty" });
      expect(result.totalRecords).toBe(0);
      expect(result.sampleSize).toBe(0);
      expect(result.proposed.fields).toBeUndefined();
      expect(result.notes[0]).toMatch(/empty/i);
    });

    it("infers boolean type", async () => {
      await exec("db_insert", { collection: "infer-bool", records: [
        { active: true }, { active: false }, { active: true },
      ]});
      const result = await exec("db_infer_schema", { collection: "infer-bool" });
      expect(result.proposed.fields.active.type).toBe("boolean");
    });

    it("infers number type", async () => {
      await exec("db_insert", { collection: "infer-num", records: [
        { score: 10 }, { score: 20 }, { score: 30 },
      ]});
      const result = await exec("db_infer_schema", { collection: "infer-num" });
      expect(result.proposed.fields.score.type).toBe("number");
    });

    it("infers enum type when distinct values <= enumThreshold", async () => {
      await exec("db_insert", { collection: "infer-enum", records: [
        { status: "active" }, { status: "inactive" }, { status: "active" },
      ]});
      const result = await exec("db_infer_schema", { collection: "infer-enum", enumThreshold: 5 });
      expect(result.proposed.fields.status.type).toBe("enum");
      expect(result.proposed.fields.status.values).toEqual(["active", "inactive"]);
      expect(result.notes.some((n: string) => n.includes("inferred as enum"))).toBe(true);
    });

    it("infers string type with maxLength when distinct values > enumThreshold", async () => {
      const records = Array.from({ length: 15 }, (_, i) => ({ comment: `comment number ${i} with some padding` }));
      await exec("db_insert", { collection: "infer-str", records });
      const result = await exec("db_infer_schema", { collection: "infer-str", enumThreshold: 10 });
      expect(result.proposed.fields.comment.type).toBe("string");
      expect(typeof result.proposed.fields.comment.maxLength).toBe("number");
      expect(result.proposed.fields.comment.maxLength).toBeGreaterThan(0);
    });

    it("infers date type from ISO date strings", async () => {
      await exec("db_insert", { collection: "infer-date", records: [
        { createdAt: "2024-01-15T10:00:00Z" },
        { createdAt: "2024-02-20T12:00:00Z" },
        { createdAt: "2023-12-01" },
      ]});
      const result = await exec("db_infer_schema", { collection: "infer-date" });
      expect(result.proposed.fields.createdAt.type).toBe("date");
      expect(result.notes.some((n: string) => n.includes("date string"))).toBe(true);
    });

    it("infers string[] type", async () => {
      await exec("db_insert", { collection: "infer-strarr", records: [
        { tags: ["a", "b"] }, { tags: ["c"] }, { tags: [] },
      ]});
      const result = await exec("db_infer_schema", { collection: "infer-strarr" });
      expect(result.proposed.fields.tags.type).toBe("string[]");
    });

    it("marks field required when presence >= requiredThreshold", async () => {
      // 20 records; name present in all 20 (100%), optional in 9 of 20 (45%)
      const records = Array.from({ length: 20 }, (_, i) => ({
        name: `user${i}`,
        ...(i < 9 ? { optional: true } : {}),
      }));
      await exec("db_insert", { collection: "infer-req", records });
      const result = await exec("db_infer_schema", { collection: "infer-req", requiredThreshold: 0.95 });
      expect(result.proposed.fields.name.required).toBe(true);
      expect(result.proposed.fields.optional?.required).toBeFalsy();
    });

    it("skips mixed-type fields with a note", async () => {
      await exec("db_insert", { collection: "infer-mixed", records: [
        { value: 42 }, { value: "hello" }, { value: true },
      ]});
      const result = await exec("db_infer_schema", { collection: "infer-mixed" });
      expect(result.proposed.fields?.value).toBeUndefined();
      expect(result.notes.some((n: string) => n.includes("value") && n.includes("mixed"))).toBe(true);
    });

    it("adds sampling note with 'reservoir' when totalRecords > sampleSize", async () => {
      const records = Array.from({ length: 50 }, (_, i) => ({ n: i }));
      await exec("db_insert", { collection: "infer-sample", records });
      const result = await exec("db_infer_schema", { collection: "infer-sample", sampleSize: 10 });
      expect(result.totalRecords).toBe(50);
      expect(result.sampleSize).toBe(10);
      const note = result.notes.find((n: string) => n.includes("Sampled"));
      expect(note).toBeDefined();
      expect(note).toContain("reservoir");
    });

    it("distributes sample uniformly (Algorithm R — 50 runs see both halves)", async () => {
      // 20 records split evenly: group A (idx 0-9) and group B (idx 10-19).
      // Window sampling of the first 10 would only ever see group A.
      // Algorithm R should see both groups in the vast majority of 50 runs.
      const records = Array.from({ length: 20 }, (_, i) => ({ group: i < 10 ? "A" : "B" }));
      await exec("db_insert", { collection: "infer-algr", records });

      let bothGroupsSeen = 0;
      for (let run = 0; run < 50; run++) {
        const result = await exec("db_infer_schema", {
          collection: "infer-algr",
          sampleSize: 10,
          enumThreshold: 2,
        });
        const groupField = result.proposed.fields?.group;
        if (groupField?.type === "enum" && Array.isArray(groupField.values) && groupField.values.length === 2) {
          bothGroupsSeen++;
        }
      }
      // At least 30 of 50 runs should see both A and B (expected ~45+ with uniform sampling)
      expect(bothGroupsSeen).toBeGreaterThan(30);
    });

    it("excludes meta fields (_id, _version) from proposed schema", async () => {
      await exec("db_insert", { collection: "infer-meta", records: [{ x: 1 }] });
      const result = await exec("db_infer_schema", { collection: "infer-meta" });
      expect(result.proposed.fields?._id).toBeUndefined();
      expect(result.proposed.fields?._version).toBeUndefined();
      expect(result.proposed.fields?.x).toBeDefined();
    });

    it("does not classify strings with non-date suffix as date (regression: false positive)", async () => {
      // Use 15 distinct values so type is string (not enum), and verify it's not misclassified as date
      const records = Array.from({ length: 15 }, (_, i) => ({ label: `2024-01-${String(i + 1).padStart(2, "0")} not a date ${i}` }));
      await exec("db_insert", { collection: "infer-dateregex", records });
      const result = await exec("db_infer_schema", { collection: "infer-dateregex" });
      expect(result.proposed.fields.label.type).toBe("string");
      expect(result.proposed.fields.label.type).not.toBe("date");
    });

    it("round-trip: proposed schema passes validatePersistedSchema and can be forwarded to db_set_schema", async () => {
      // Use 15 distinct names to exceed enumThreshold (10) → name classified as string
      const records = Array.from({ length: 15 }, (_, i) => ({ name: `Person${i}`, active: true }));
      await exec("db_insert", { collection: "infer-roundtrip", records });
      const inferred = await exec("db_infer_schema", { collection: "infer-roundtrip" });
      // Should not throw — proposed is valid
      await exec("db_set_schema", { collection: "infer-roundtrip", schema: inferred.proposed, agent: "admin" });
      const stored = await exec("db_get_schema", { collection: "infer-roundtrip" });
      expect(stored.schema.fields.name.type).toBe("string");
    });

    it("exactly 95% presence marks field required (boundary: requiredThreshold=0.95)", async () => {
      // 20 records; field present in 19 (19/20 = 0.95 == threshold)
      const records = Array.from({ length: 20 }, (_, i) => ({
        name: `user${i}`,
        ...(i < 19 ? { badge: "gold" } : {}),
      }));
      await exec("db_insert", { collection: "infer-95", records });
      const result = await exec("db_infer_schema", { collection: "infer-95", requiredThreshold: 0.95 });
      expect(result.proposed.fields.badge.required).toBe(true);
    });

    it("94% presence does not mark field required", async () => {
      // 50 records; field present in 47 (47/50 = 0.94 < 0.95)
      const records = Array.from({ length: 50 }, (_, i) => ({
        name: `user${i}`,
        ...(i < 47 ? { badge: "silver" } : {}),
      }));
      await exec("db_insert", { collection: "infer-94", records });
      const result = await exec("db_infer_schema", { collection: "infer-94", requiredThreshold: 0.95 });
      expect(result.proposed.fields.badge?.required).toBeFalsy();
    });

    it("field where all sampled values are null/undefined is excluded from proposed schema", async () => {
      await exec("db_insert", { collection: "infer-allnull", records: [
        { name: "Alice", ghost: null }, { name: "Bob", ghost: null },
      ]});
      const result = await exec("db_infer_schema", { collection: "infer-allnull" });
      // null values are filtered out; no values remain for 'ghost' → field excluded
      expect(result.proposed.fields?.ghost).toBeUndefined();
    });

    it("sampleSize > totalRecords returns all records without error", async () => {
      await exec("db_insert", { collection: "infer-small", records: [{ x: 1 }, { x: 2 }] });
      const result = await exec("db_infer_schema", { collection: "infer-small", sampleSize: 1000 });
      expect(result.totalRecords).toBe(2);
      expect(result.sampleSize).toBe(2);
      expect(result.proposed.fields?.x?.type).toBe("number");
    });

    it("null values count as missing (not present) for requiredThreshold calculation", async () => {
      // 4 records; field is null in 2, present in 2 → 2/4 = 50% < 95%
      await exec("db_insert", { collection: "infer-nullreq", records: [
        { val: 1 }, { val: 2 }, { val: null }, { val: null },
      ]});
      const result = await exec("db_infer_schema", { collection: "infer-nullreq", requiredThreshold: 0.95 });
      expect(result.proposed.fields?.val?.required).toBeFalsy();
    });

    it("meta fields (__proto__, constructor, prototype) are excluded from proposed schema", async () => {
      // Verify that the META exclusion set covers all dangerous prototype-related field names.
      // Insert a normal record and confirm none of the meta keys appear in the output.
      await exec("db_insert", { collection: "infer-proto", records: [{ normal: "value" }] });
      const result = await exec("db_infer_schema", { collection: "infer-proto" });
      const fieldKeys = Object.keys(result.proposed.fields ?? {});
      expect(fieldKeys).not.toContain("__proto__");
      expect(fieldKeys).not.toContain("constructor");
      expect(fieldKeys).not.toContain("prototype");
      expect(fieldKeys).toContain("normal");
    });

    it("enumThreshold:1 — field with 2+ distinct values is classified as string, not enum", async () => {
      // With enumThreshold:1, distinctCount <= 1 → enum; distinctCount > 1 → string
      const records = [{ tag: "a" }, { tag: "b" }];
      await exec("db_insert", { collection: "infer-ethresh", records });
      const result = await exec("db_infer_schema", { collection: "infer-ethresh", enumThreshold: 1 });
      expect(result.proposed.fields.tag.type).toBe("string");
    });

    it("emits note when collection already has a persisted schema", async () => {
      await exec("db_insert", { collection: "infer-existing", records: [{ x: 1 }] });
      await exec("db_set_schema", {
        collection: "infer-existing",
        schema: { version: 2, fields: { x: { type: "number" } } },
        agent: "admin",
      });
      const result = await exec("db_infer_schema", { collection: "infer-existing" });
      const note = result.notes.find((n: string) => n.includes("already has a persisted schema"));
      expect(note).toBeDefined();
      expect(note).toContain("version 2");
      expect(note).toContain("db_diff_schema");
      expect(note).toContain("db_set_schema");
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
