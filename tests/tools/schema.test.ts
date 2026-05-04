import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDB } from "../../src/agentdb.js";
import { defineSchema } from "../../src/schema.js";
import { getTools } from "../../src/tools/index.js";
import type { AgentTool } from "../../src/tools/index.js";

describe("Tool Definitions — schema", () => {
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

    it("returns isError when searchable:true is set on a non-string field (#167)", async () => {
      const t = tool("db_set_schema");
      const result = await t.execute({
        collection: "bad-searchable",
        schema: {
          fields: { score: { type: "number", searchable: true } },
        },
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/searchable:true.*not string/i);
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

    it("completes in bounded time for 50K records (O(N) regression guard)", async () => {
      // Insert 50K records directly via collection API (bypasses tool overhead)
      const col = await db.collection("infer-50k");
      const BATCH = 1000;
      for (let b = 0; b < 50; b++) {
        const batch = Array.from({ length: BATCH }, (_, i) => ({ n: b * BATCH + i, label: `item-${b * BATCH + i}` }));
        for (const r of batch) await col.insert(r);
      }
      const start = performance.now();
      const result = await exec("db_infer_schema", { collection: "infer-50k", sampleSize: 100 });
      const elapsed = performance.now() - start;
      expect(result.totalRecords).toBe(50000);
      expect(result.sampleSize).toBe(100);
      expect(elapsed).toBeLessThan(500);
    }, 120000);

    it("disk-mode: heap delta stays under 50MB for 10K records (streaming memory guard)", async () => {
      const diskDir = await mkdtemp(join(tmpdir(), "agentdb-infer-disk-"));
      let diskDb: AgentDB | undefined;
      try {
        // Session 1: insert 10K records and close (triggers Parquet compaction)
        diskDb = new AgentDB(diskDir, { storageMode: "disk", writeMode: "async" });
        await diskDb.init();
        const col1 = await diskDb.collection("infer-disk");
        const BATCH = 500;
        for (let b = 0; b < 20; b++) {
          const batch = Array.from({ length: BATCH }, (_, i) => ({ n: b * BATCH + i, label: `item-${b * BATCH + i}`, extra: "x".repeat(100) }));
          for (const r of batch) await col1.insert(r);
        }
        await diskDb.close();
        diskDb = undefined;

        // Session 2: reopen from Parquet, measure heap growth during db_infer_schema
        diskDb = new AgentDB(diskDir, { storageMode: "disk" });
        await diskDb.init();
        const diskTools = getTools(diskDb);
        const inferTool = diskTools.find((t) => t.name === "db_infer_schema")!;

        if (global.gc) global.gc();
        const heapBefore = process.memoryUsage().heapUsed;
        const result = await inferTool.execute({ collection: "infer-disk", sampleSize: 100 });
        if (global.gc) global.gc();
        const heapAfter = process.memoryUsage().heapUsed;

        expect(result.isError).toBeFalsy();
        const delta = (heapAfter - heapBefore) / (1024 * 1024);
        expect(delta).toBeLessThan(50);
      } finally {
        await diskDb?.close();
        await rm(diskDir, { recursive: true, force: true });
      }
    }, 60000);
  });
});
