import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDB } from "../src/agentdb.js";
import { defineSchema, extractPersistedSchema, validatePersistedSchema, mergeSchemas, mergePersistedSchemas, loadSchemaFromJSON, exportSchemaToJSON } from "../src/schema.js";
import type { SchemaDefinition, PersistedSchema } from "../src/schema.js";

describe("defineSchema", () => {
  let tmpDir: string;
  let db: AgentDB;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agentdb-schema-"));
    db = new AgentDB(tmpDir);
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("field validation", () => {
    it("validates required fields", async () => {
      const col = await db.collection(defineSchema({
        name: "tasks",
        fields: { title: { type: "string", required: true } },
      }));

      await expect(col.insert({})).rejects.toThrow("'title' is required");
      const id = await col.insert({ title: "Hello" });
      expect(id).toBeTruthy();
    });

    it("validates string type", async () => {
      const col = await db.collection(defineSchema({
        name: "items",
        fields: { name: { type: "string" } },
      }));

      await expect(col.insert({ name: 42 })).rejects.toThrow("must be a string");
    });

    it("validates string maxLength", async () => {
      const col = await db.collection(defineSchema({
        name: "items",
        fields: { code: { type: "string", maxLength: 5 } },
      }));

      await expect(col.insert({ code: "toolong" })).rejects.toThrow("max length");
      await col.insert({ code: "ok" });
    });

    it("validates string pattern", async () => {
      const col = await db.collection(defineSchema({
        name: "items",
        fields: { slug: { type: "string", pattern: /^[a-z-]+$/ } },
      }));

      await expect(col.insert({ slug: "BAD SLUG" })).rejects.toThrow("pattern");
      await col.insert({ slug: "good-slug" });
    });

    it("validates number type and min/max", async () => {
      const col = await db.collection(defineSchema({
        name: "items",
        fields: { score: { type: "number", min: 0, max: 100 } },
      }));

      await expect(col.insert({ score: "not a number" })).rejects.toThrow("must be a number");
      await expect(col.insert({ score: -1 })).rejects.toThrow(">= 0");
      await expect(col.insert({ score: 101 })).rejects.toThrow("<= 100");
      await col.insert({ score: 50 });
    });

    it("validates boolean type", async () => {
      const col = await db.collection(defineSchema({
        name: "items",
        fields: { active: { type: "boolean" } },
      }));

      await expect(col.insert({ active: "yes" })).rejects.toThrow("must be a boolean");
      await col.insert({ active: true });
    });

    it("validates enum type", async () => {
      const col = await db.collection(defineSchema({
        name: "items",
        fields: { status: { type: "enum", values: ["open", "closed"] } },
      }));

      await expect(col.insert({ status: "invalid" })).rejects.toThrow("must be one of: open, closed");
      await col.insert({ status: "open" });
    });

    it("validates string array", async () => {
      const col = await db.collection(defineSchema({
        name: "items",
        fields: { tags: { type: "string[]" } },
      }));

      await expect(col.insert({ tags: [1, 2] })).rejects.toThrow("string array");
      await col.insert({ tags: ["a", "b"] });
    });

    it("validates date type", async () => {
      const col = await db.collection(defineSchema({
        name: "items",
        fields: { due: { type: "date" } },
      }));

      await expect(col.insert({ due: 42 })).rejects.toThrow("date");
      await col.insert({ due: "2026-04-10" });
    });

    it("skips validation for undefined optional fields", async () => {
      const col = await db.collection(defineSchema({
        name: "items",
        fields: {
          title: { type: "string", required: true },
          priority: { type: "enum", values: ["H", "M", "L"] },
        },
      }));

      const id = await col.insert({ title: "Hello" }); // priority is undefined, that's ok
      expect((await col.findOne(id))?.title).toBe("Hello");
    });
  });

  describe("defaults", () => {
    it("applies static defaults on insert", async () => {
      const col = await db.collection(defineSchema({
        name: "tasks",
        fields: {
          title: { type: "string", required: true },
          status: { type: "enum", values: ["pending", "done"], default: "pending" },
        },
      }));

      const id = await col.insert({ title: "Fix bug" });
      expect((await col.findOne(id))?.status).toBe("pending");
    });

    it("applies function defaults on insert", async () => {
      const col = await db.collection(defineSchema({
        name: "items",
        fields: {
          createdAt: { type: "string", default: () => new Date().toISOString() },
        },
      }));

      const id = await col.insert({ name: "test" });
      expect((await col.findOne(id))?.createdAt).toBeTruthy();
    });

    it("does not overwrite provided values", async () => {
      const col = await db.collection(defineSchema({
        name: "tasks",
        fields: {
          status: { type: "enum", values: ["pending", "done"], default: "pending" },
        },
      }));

      const id = await col.insert({ status: "done" });
      expect((await col.findOne(id))?.status).toBe("done");
    });
  });

  describe("auto-indexing", () => {
    it("creates indexes on collection open", async () => {
      const col = await db.collection(defineSchema({
        name: "tasks",
        fields: {
          status: { type: "string" },
          priority: { type: "string" },
        },
        indexes: ["status", "priority"],
      }));

      expect(col.listIndexes()).toContain("status");
      expect(col.listIndexes()).toContain("priority");
    });

    it("creates composite indexes on collection open", async () => {
      const col = await db.collection(defineSchema({
        name: "tasks",
        fields: {
          status: { type: "string" },
          priority: { type: "string" },
        },
        compositeIndexes: [["status", "priority"]],
      }));

      expect(col.listCompositeIndexes()).toEqual([["status", "priority"]]);
    });
  });

  describe("computed fields", () => {
    it("adds computed fields to query results", async () => {
      const col = await db.collection(defineSchema({
        name: "tasks",
        fields: { title: { type: "string", required: true } },
        computed: {
          wordCount: (r) => (r.title as string).split(" ").length,
        },
      }));

      const id = await col.insert({ title: "Fix the login bug" });
      expect((await col.findOne(id))?.wordCount).toBe(4);
    });
  });

  describe("virtual filters", () => {
    it("filters with virtual predicates", async () => {
      const col = await db.collection(defineSchema({
        name: "tasks",
        fields: {
          title: { type: "string", required: true },
          done: { type: "boolean", default: false },
        },
        virtualFilters: {
          "+PENDING": (r) => !r.done,
        },
      }));

      await col.insert({ title: "A", done: true });
      await col.insert({ title: "B", done: false });

      const pending = await col.find({ filter: { "+PENDING": true } });
      expect(pending.records).toHaveLength(1);
      expect(pending.records[0].title).toBe("B");
    });
  });

  describe("lifecycle hooks", () => {
    it("beforeInsert can modify the record", async () => {
      const col = await db.collection(defineSchema({
        name: "tasks",
        fields: { title: { type: "string" } },
        hooks: {
          beforeInsert: (record) => ({ ...record, title: (record.title as string).toUpperCase() }),
        },
      }));

      const id = await col.insert({ title: "hello" });
      expect((await col.findOne(id))?.title).toBe("HELLO");
    });

    it("afterInsert fires with id and record", async () => {
      const afterFn = vi.fn();
      const col = await db.collection(defineSchema({
        name: "tasks",
        fields: { title: { type: "string" } },
        hooks: { afterInsert: afterFn },
      }));

      await col.insert({ title: "test" });
      expect(afterFn).toHaveBeenCalledTimes(1);
      expect(afterFn.mock.calls[0][1].title).toBe("test");
    });

    it("afterUpdate fires on update", async () => {
      const afterFn = vi.fn();
      const col = await db.collection(defineSchema({
        name: "tasks",
        fields: { title: { type: "string" }, status: { type: "string" } },
        hooks: { afterUpdate: afterFn },
      }));

      const id = await col.insert({ title: "test", status: "open" });
      await col.update({ _id: id }, { $set: { status: "closed" } });
      expect(afterFn).toHaveBeenCalled();
      expect(afterFn.mock.calls[0][0]).toContain(id);
    });

    it("afterDelete fires on delete", async () => {
      const afterFn = vi.fn();
      const col = await db.collection(defineSchema({
        name: "tasks",
        fields: { title: { type: "string" } },
        hooks: { afterDelete: afterFn },
      }));

      const id = await col.insert({ title: "test" });
      await col.remove({ _id: id });
      expect(afterFn).toHaveBeenCalled();
    });
  });

  describe("full schema integration", () => {
    it("works with all features combined", async () => {
      const col = await db.collection(defineSchema({
        name: "tasks",
        fields: {
          title: { type: "string", required: true, maxLength: 200 },
          status: { type: "enum", values: ["pending", "done"], default: "pending" },
          priority: { type: "enum", values: ["H", "M", "L"], default: "M" },
          score: { type: "number", min: 0, max: 100 },
        },
        indexes: ["status"],
        computed: {
          isHighPriority: (r) => r.priority === "H",
        },
        virtualFilters: {
          "+HIGH": (r) => r.priority === "H",
        },
        textSearch: true,
      }));

      await col.insert({ title: "Fix critical bug", priority: "H", score: 90 });
      await col.insert({ title: "Update docs", score: 30 });

      // Defaults applied
      const all = await col.find();
      expect(all.records.every((r) => r.status === "pending")).toBe(true);
      expect(all.records[1].priority).toBe("M");

      // Computed
      expect(all.records[0].isHighPriority).toBe(true);
      expect(all.records[1].isHighPriority).toBe(false);

      // Virtual filter
      const high = await col.find({ filter: { "+HIGH": true } });
      expect(high.records).toHaveLength(1);

      // Index used
      expect(col.listIndexes()).toContain("status");

      // Text search
      const results = await col.search("critical");
      expect(results.records).toHaveLength(1);
    });
  });

  describe("insertMany with schema", () => {
    it("applies defaults and validation on insertMany", async () => {
      const afterFn = vi.fn();
      const col = await db.collection(defineSchema({
        name: "insertmany-schema",
        fields: {
          title: { type: "string", required: true },
          status: { type: "enum", values: ["open", "closed"], default: "open" },
          id: { type: "autoIncrement" },
        },
        hooks: { afterInsert: afterFn },
      }));

      const ids = await col.insertMany([
        { title: "First" },
        { title: "Second" },
        { title: "Third" },
      ]);

      // Defaults applied
      expect((await col.findOne(ids[0]))?.status).toBe("open");
      expect((await col.findOne(ids[1]))?.status).toBe("open");

      // Auto-increment applied
      expect((await col.findOne(ids[0]))?.id).toBe(1);
      expect((await col.findOne(ids[1]))?.id).toBe(2);
      expect((await col.findOne(ids[2]))?.id).toBe(3);

      // Hooks fired
      expect(afterFn).toHaveBeenCalledTimes(3);
    });

    it("rejects invalid records in insertMany", async () => {
      const col = await db.collection(defineSchema({
        name: "insertmany-validate",
        fields: {
          title: { type: "string", required: true },
        },
      }));

      await expect(col.insertMany([{ title: "ok" }, {}])).rejects.toThrow("'title' is required");
    });
  });

  describe("upsertMany with schema", () => {
    it("applies defaults and validation on upsertMany", async () => {
      const afterFn = vi.fn();
      const col = await db.collection(defineSchema({
        name: "upsert-schema",
        fields: {
          title: { type: "string", required: true },
          status: { type: "enum", values: ["open", "closed"], default: "open" },
        },
        hooks: { afterInsert: afterFn },
      }));

      await col.upsertMany([
        { _id: "u1", title: "First" },
        { _id: "u2", title: "Second" },
      ]);

      // Defaults applied
      expect((await col.findOne("u1"))?.status).toBe("open");
      expect((await col.findOne("u2"))?.status).toBe("open");

      // Hooks fired
      expect(afterFn).toHaveBeenCalledTimes(2);
    });

    it("rejects invalid records in upsertMany", async () => {
      const col = await db.collection(defineSchema({
        name: "upsert-validate",
        fields: {
          title: { type: "string", required: true },
        },
      }));

      // Missing required field
      await expect(col.upsertMany([{ _id: "bad" }])).rejects.toThrow("'title' is required");
    });
  });

  describe("auto-increment IDs", () => {
    it("assigns sequential IDs on insert", async () => {
      const col = await db.collection(defineSchema({
        name: "autoinc",
        fields: {
          id: { type: "autoIncrement" },
          title: { type: "string", required: true },
        },
      }));

      const id1 = await col.insert({ title: "First" });
      const id2 = await col.insert({ title: "Second" });
      const id3 = await col.insert({ title: "Third" });

      expect((await col.findOne(id1))?.id).toBe(1);
      expect((await col.findOne(id2))?.id).toBe(2);
      expect((await col.findOne(id3))?.id).toBe(3);
    });

    it("continues from max on reopen", async () => {
      const col1 = await db.collection(defineSchema({
        name: "autoinc2",
        fields: { id: { type: "autoIncrement" }, title: { type: "string" } },
      }));
      await col1.insert({ title: "First" });
      await col1.insert({ title: "Second" });
      await db.close();

      const db2 = new AgentDB(tmpDir);
      await db2.init();
      const col2 = await db2.collection(defineSchema({
        name: "autoinc2",
        fields: { id: { type: "autoIncrement" }, title: { type: "string" } },
      }));
      const id3 = await col2.insert({ title: "Third" });
      expect((await col2.findOne(id3))?.id).toBe(3);
      await db2.close();

      // Reopen for afterEach cleanup
      db = new AgentDB(tmpDir);
      await db.init();
    });
  });

  describe("hook context", () => {
    it("hooks receive collection reference in context", async () => {
      const afterFn = vi.fn();
      const col = await db.collection(defineSchema({
        name: "hookctx",
        fields: { title: { type: "string" } },
        hooks: {
          afterInsert: (_id, _record, ctx) => {
            afterFn(typeof ctx.collection.findOne);
          },
        },
      }));

      await col.insert({ title: "test" });
      expect(afterFn).toHaveBeenCalledWith("function");
    });
  });

  describe("field resolve", () => {
    it("transforms value before validation", async () => {
      const col = await db.collection(defineSchema({
        name: "resolve-test",
        fields: {
          due: {
            type: "string",
            resolve: (v) => {
              if (v === "tomorrow") return new Date(Date.now() + 86400000).toISOString().split("T")[0];
              return v;
            },
          },
        },
      }));

      const id = await col.insert({ due: "tomorrow" });
      const record = await col.findOne(id);
      // Should be an ISO date string, not "tomorrow"
      expect(record?.due).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(record?.due).not.toBe("tomorrow");
    });

    it("resolve runs before validation", async () => {
      const col = await db.collection(defineSchema({
        name: "resolve-validate",
        fields: {
          score: {
            type: "number",
            min: 0,
            max: 100,
            resolve: (v) => typeof v === "string" ? parseInt(v, 10) : v,
          },
        },
      }));

      // String "42" gets resolved to number 42 before validation
      const id = await col.insert({ score: "42" });
      expect((await col.findOne(id))?.score).toBe(42);
    });

    it("resolve does not run on undefined/null values", async () => {
      const resolveFn = vi.fn((v) => v);
      const col = await db.collection(defineSchema({
        name: "resolve-skip",
        fields: {
          optional: { type: "string", resolve: resolveFn },
        },
      }));

      await col.insert({ title: "no optional field" });
      expect(resolveFn).not.toHaveBeenCalled();
    });
  });

  describe("configurable tagField", () => {
    it("uses custom tag field name in compact filter", async () => {
      const col = await db.collection(defineSchema({
        name: "custom-tags",
        fields: {
          title: { type: "string", required: true },
          labels: { type: "string[]" },
        },
        tagField: "labels",
      }));

      await col.insert({ title: "Bug", labels: ["bug", "urgent"] });
      await col.insert({ title: "Feature", labels: ["feature"] });

      // The tagField is on the schema — verify it's set
      // (compact filter uses it when parsing +tag syntax)
      const all = await col.find({ filter: { labels: { $contains: "bug" } } });
      expect(all.records).toHaveLength(1);
      expect(all.records[0].title).toBe("Bug");
    });

    it("+tag compact filter uses custom tagField", async () => {
      const col = await db.collection(defineSchema({
        name: "custom-tags2",
        fields: {
          title: { type: "string", required: true },
          labels: { type: "string[]" },
        },
        tagField: "labels",
      }));

      await col.insert({ title: "Bug", labels: ["bug", "urgent"] });
      await col.insert({ title: "Feature", labels: ["feature"] });

      // +bug compact string filter should query "labels" field, not "tags"
      const results = await col.find({ filter: "+bug" });
      expect(results.records).toHaveLength(1);
      expect(results.records[0].title).toBe("Bug");

      // -bug should exclude
      const excluded = await col.find({ filter: "-bug" });
      expect(excluded.records).toHaveLength(1);
      expect(excluded.records[0].title).toBe("Feature");
    });
  });

  describe("description, instructions, and field descriptions", () => {
    it("accepts description and instructions on schema", async () => {
      const col = await db.collection(defineSchema({
        name: "described",
        description: "A test collection",
        instructions: "Use this for testing",
        fields: {
          title: { type: "string", required: true, description: "The item title" },
        },
      }));

      const id = await col.insert({ title: "Hello" });
      expect(id).toBeTruthy();
    });

    it("accepts version on schema", async () => {
      const col = await db.collection(defineSchema({
        name: "versioned",
        version: 2,
        fields: { title: { type: "string" } },
      }));

      const id = await col.insert({ title: "Hello" });
      expect(id).toBeTruthy();
    });
  });

  describe("array indexes", () => {
    it("$contains uses array index when available", async () => {
      const col = await db.collection(defineSchema({
        name: "array-idx-test",
        fields: {
          title: { type: "string", required: true },
          tags: { type: "string[]" },
        },
        arrayIndexes: ["tags"],
      }));

      await col.insert({ title: "Bug report", tags: ["bug", "urgent"] });
      await col.insert({ title: "Feature req", tags: ["feature"] });
      await col.insert({ title: "Bug fix", tags: ["bug", "fixed"] });

      const results = await col.find({ filter: { tags: { $contains: "bug" } } });
      expect(results.records).toHaveLength(2);
      expect(results.records.map((r) => r.title).sort()).toEqual(["Bug fix", "Bug report"]);

      // Array index should be created
      expect(col.listArrayIndexes()).toContain("tags");
    });

    it("array index updates on insert/update/delete", async () => {
      const col = await db.collection(defineSchema({
        name: "array-idx-update",
        fields: {
          title: { type: "string", required: true },
          tags: { type: "string[]" },
        },
        arrayIndexes: ["tags"],
      }));

      const id = await col.insert({ title: "Test", tags: ["alpha"] });
      expect((await col.find({ filter: { tags: { $contains: "alpha" } } })).records).toHaveLength(1);

      // Update tags
      await col.update({ _id: id }, { $set: { tags: ["beta"] } });
      expect((await col.find({ filter: { tags: { $contains: "alpha" } } })).records).toHaveLength(0);
      expect((await col.find({ filter: { tags: { $contains: "beta" } } })).records).toHaveLength(1);

      // Delete
      await col.remove({ _id: id });
      expect((await col.find({ filter: { tags: { $contains: "beta" } } })).records).toHaveLength(0);
    });
  });
});

describe("extractPersistedSchema", () => {
  it("extracts all serializable fields", () => {
    const def: SchemaDefinition = {
      name: "tickets",
      version: 3,
      description: "Support tickets",
      instructions: "Set priority based on customer tier",
      fields: {
        title: { type: "string", required: true, maxLength: 200, description: "Short summary" },
        status: { type: "enum", values: ["open", "closed"], default: "open" },
        score: { type: "number", min: 0, max: 100 },
        tags: { type: "string[]" },
      },
      indexes: ["status"],
      compositeIndexes: [["status", "score"]],
      arrayIndexes: ["tags"],
      tagField: "tags",
      storageMode: "disk",
    };

    const persisted = extractPersistedSchema(def);
    expect(persisted.name).toBe("tickets");
    expect(persisted.version).toBe(3);
    expect(persisted.description).toBe("Support tickets");
    expect(persisted.instructions).toBe("Set priority based on customer tier");
    expect(persisted.indexes).toEqual(["status"]);
    expect(persisted.compositeIndexes).toEqual([["status", "score"]]);
    expect(persisted.arrayIndexes).toEqual(["tags"]);
    expect(persisted.tagField).toBe("tags");
    expect(persisted.storageMode).toBe("disk");

    // Fields preserved
    expect(persisted.fields?.title).toEqual({ type: "string", required: true, maxLength: 200, description: "Short summary" });
    expect(persisted.fields?.status).toEqual({ type: "enum", values: ["open", "closed"], default: "open" });
    expect(persisted.fields?.score).toEqual({ type: "number", min: 0, max: 100 });
    expect(persisted.fields?.tags).toEqual({ type: "string[]" });
  });

  it("strips function defaults", () => {
    const def: SchemaDefinition = {
      name: "test",
      fields: {
        createdAt: { type: "string", default: () => new Date().toISOString() },
        status: { type: "string", default: "active" },
      },
    };

    const persisted = extractPersistedSchema(def);
    expect(persisted.fields?.createdAt.default).toBeUndefined();
    expect(persisted.fields?.status.default).toBe("active");
  });

  it("strips pattern and resolve from fields", () => {
    const def: SchemaDefinition = {
      name: "test",
      fields: {
        slug: { type: "string", pattern: /^[a-z-]+$/, description: "URL slug" },
        due: { type: "string", resolve: (v) => String(v) },
      },
    };

    const persisted = extractPersistedSchema(def);
    // pattern and resolve should not be in the output at all
    expect(persisted.fields?.slug).toEqual({ type: "string", description: "URL slug" });
    expect(persisted.fields?.due).toEqual({ type: "string" });
    expect("pattern" in (persisted.fields?.slug ?? {})).toBe(false);
    expect("resolve" in (persisted.fields?.due ?? {})).toBe(false);
  });

  it("does not include hooks, computed, or virtualFilters", () => {
    const def: SchemaDefinition = {
      name: "test",
      computed: { upper: (r) => (r.name as string).toUpperCase() },
      virtualFilters: { "+ACTIVE": (r) => !!r.active },
      hooks: { beforeInsert: () => {} },
    };

    const persisted = extractPersistedSchema(def);
    expect("computed" in persisted).toBe(false);
    expect("virtualFilters" in persisted).toBe(false);
    expect("hooks" in persisted).toBe(false);
  });

  it("omits empty optional fields", () => {
    const persisted = extractPersistedSchema({ name: "minimal" });
    expect(persisted).toEqual({ name: "minimal" });
    expect(Object.keys(persisted)).toEqual(["name"]);
  });

  it("produces JSON-serializable output", () => {
    const def: SchemaDefinition = {
      name: "json-safe",
      version: 1,
      description: "Test",
      fields: {
        title: { type: "string", required: true, pattern: /abc/, resolve: () => "x", default: () => "y" },
        count: { type: "number", min: 0 },
      },
      indexes: ["count"],
      hooks: { afterInsert: () => {} },
      computed: { x: () => 1 },
    };

    const persisted = extractPersistedSchema(def);
    const json = JSON.stringify(persisted);
    const roundTripped = JSON.parse(json);
    expect(roundTripped.name).toBe("json-safe");
    expect(roundTripped.fields.title.type).toBe("string");
    expect(roundTripped.fields.title.default).toBeUndefined();
  });

  it("deep-copies arrays so mutations don't affect original", () => {
    const indexes = ["status"];
    const def: SchemaDefinition = { name: "copy-test", indexes };

    const persisted = extractPersistedSchema(def);
    persisted.indexes!.push("extra");
    expect(indexes).toEqual(["status"]);
  });
});

describe("validatePersistedSchema", () => {
  it("accepts a valid minimal schema", () => {
    expect(() => validatePersistedSchema({ name: "test" })).not.toThrow();
  });

  it("accepts a full valid schema", () => {
    const schema: PersistedSchema = {
      name: "tickets",
      version: 1,
      description: "Support tickets",
      instructions: "Use wisely",
      fields: {
        title: { type: "string", required: true, maxLength: 200, description: "Title" },
        status: { type: "enum", values: ["open", "closed"], default: "open" },
        score: { type: "number", min: 0, max: 100 },
      },
      indexes: ["status"],
      compositeIndexes: [["status", "score"]],
      arrayIndexes: ["status"],
      tagField: "tags",
      storageMode: "disk",
    };
    expect(() => validatePersistedSchema(schema)).not.toThrow();
  });

  it("rejects non-object", () => {
    expect(() => validatePersistedSchema(null)).toThrow("non-null object");
    expect(() => validatePersistedSchema("string")).toThrow("non-null object");
    expect(() => validatePersistedSchema([])).toThrow("non-null object");
  });

  it("rejects missing or empty name", () => {
    expect(() => validatePersistedSchema({})).toThrow("'name' must be a non-empty string");
    expect(() => validatePersistedSchema({ name: "" })).toThrow("'name' must be a non-empty string");
    expect(() => validatePersistedSchema({ name: 42 })).toThrow("'name' must be a non-empty string");
  });

  it("rejects invalid version", () => {
    expect(() => validatePersistedSchema({ name: "t", version: 0 })).toThrow("positive integer");
    expect(() => validatePersistedSchema({ name: "t", version: -1 })).toThrow("positive integer");
    expect(() => validatePersistedSchema({ name: "t", version: 1.5 })).toThrow("positive integer");
    expect(() => validatePersistedSchema({ name: "t", version: "1" })).toThrow("positive integer");
  });

  it("rejects invalid field types", () => {
    expect(() => validatePersistedSchema({
      name: "t",
      fields: { x: { type: "invalid" } },
    })).toThrow("invalid type 'invalid'");
  });

  it("rejects invalid field properties", () => {
    expect(() => validatePersistedSchema({
      name: "t",
      fields: { x: { type: "string", required: "yes" } },
    })).toThrow("required");

    expect(() => validatePersistedSchema({
      name: "t",
      fields: { x: { type: "enum", values: [1, 2] } },
    })).toThrow("values");

    expect(() => validatePersistedSchema({
      name: "t",
      fields: { x: { type: "number", min: "zero" } },
    })).toThrow("min");
  });

  it("rejects invalid indexes", () => {
    expect(() => validatePersistedSchema({
      name: "t",
      indexes: "status",
    })).toThrow("array of strings");

    expect(() => validatePersistedSchema({
      name: "t",
      compositeIndexes: ["status"],
    })).toThrow("array of string arrays");
  });

  it("rejects invalid storageMode", () => {
    expect(() => validatePersistedSchema({
      name: "t",
      storageMode: "fast",
    })).toThrow("storageMode");
  });
});

describe("schema persistence", () => {
  let tmpDir: string;
  let db: AgentDB;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agentdb-persist-"));
    db = new AgentDB(tmpDir);
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("persist and load round-trip", async () => {
    const schema: PersistedSchema = {
      name: "tickets",
      version: 1,
      description: "Support tickets",
      instructions: "Set priority based on tier",
      fields: {
        title: { type: "string", required: true, description: "Short summary" },
        status: { type: "enum", values: ["open", "closed"], default: "open" },
      },
      indexes: ["status"],
    };

    await db.persistSchema("tickets", schema);
    const loaded = await db.loadPersistedSchema("tickets");
    expect(loaded).toEqual(schema);
  });

  it("loadPersistedSchema returns undefined for non-existent", async () => {
    const result = await db.loadPersistedSchema("nonexistent");
    expect(result).toBeUndefined();
  });

  it("deletePersistedSchema removes the file", async () => {
    await db.persistSchema("temp", { name: "temp", version: 1 });
    expect(await db.loadPersistedSchema("temp")).toBeDefined();

    await db.deletePersistedSchema("temp");
    expect(await db.loadPersistedSchema("temp")).toBeUndefined();
  });

  it("deletePersistedSchema is no-op for non-existent", async () => {
    await expect(db.deletePersistedSchema("ghost")).resolves.toBeUndefined();
  });

  it("persistSchema rejects invalid schema", async () => {
    await expect(db.persistSchema("bad", { name: "" } as PersistedSchema)).rejects.toThrow("non-empty string");
  });

  it("rejects invalid collection names", async () => {
    await expect(db.persistSchema("../escape", { name: "escape" })).rejects.toThrow("Invalid collection name");
    await expect(db.loadPersistedSchema("../escape")).rejects.toThrow("Invalid collection name");
  });

  it("auto-persists schema on first collection open with defineSchema", async () => {
    await db.collection(defineSchema({
      name: "auto-persist",
      version: 1,
      description: "Auto-persisted collection",
      instructions: "Handle with care",
      fields: {
        title: { type: "string", required: true, description: "The title" },
        status: { type: "enum", values: ["open", "done"], default: "open" },
      },
      indexes: ["status"],
    }));

    const loaded = await db.loadPersistedSchema("auto-persist");
    expect(loaded).toBeDefined();
    expect(loaded!.name).toBe("auto-persist");
    expect(loaded!.description).toBe("Auto-persisted collection");
    expect(loaded!.instructions).toBe("Handle with care");
    expect(loaded!.fields?.title.description).toBe("The title");
    expect(loaded!.indexes).toEqual(["status"]);
  });

  it("merges code and persisted schemas on reopen, persisted context wins", async () => {
    // Manually persist a schema with custom instructions
    await db.persistSchema("merge-test", {
      name: "merge-test",
      version: 1,
      description: "Persisted description",
      instructions: "Original instructions",
      fields: {
        title: { type: "string", description: "Persisted title desc" },
      },
    });

    // Open with different instructions in code + a new field
    await db.collection(defineSchema({
      name: "merge-test",
      version: 2,
      instructions: "New instructions",
      fields: {
        title: { type: "string", description: "Code title desc" },
        status: { type: "enum", values: ["open", "done"], default: "open" },
      },
      indexes: ["status"],
    }));

    const loaded = await db.loadPersistedSchema("merge-test");
    // Persisted context wins
    expect(loaded!.instructions).toBe("Original instructions");
    expect(loaded!.description).toBe("Persisted description");
    expect(loaded!.version).toBe(1);
    // Persisted field description wins
    expect(loaded!.fields?.title.description).toBe("Persisted title desc");
    // New field from code is added
    expect(loaded!.fields?.status).toBeDefined();
    expect(loaded!.fields?.status.type).toBe("enum");
    // Indexes merged
    expect(loaded!.indexes).toContain("status");
  });

  it("survives close and reopen", async () => {
    await db.collection(defineSchema({
      name: "survive",
      description: "Survives restart",
      fields: { x: { type: "number" } },
    }));
    await db.close();

    const db2 = new AgentDB(tmpDir);
    await db2.init();
    const loaded = await db2.loadPersistedSchema("survive");
    expect(loaded).toBeDefined();
    expect(loaded!.description).toBe("Survives restart");
    await db2.close();

    // Reopen for afterEach cleanup
    db = new AgentDB(tmpDir);
    await db.init();
  });

  it("persistSchema requires admin when agent is specified", async () => {
    await db.close();
    const dbWithPerms = new AgentDB(tmpDir, {
      permissions: {
        reader: { read: true, write: false, admin: false },
        writer: { read: true, write: true, admin: false },
        admin: { read: true, write: true, admin: true },
      },
    });
    await dbWithPerms.init();

    const schema: PersistedSchema = { name: "guarded", version: 1 };

    // Reader and writer should be denied
    await expect(dbWithPerms.persistSchema("guarded", schema, { agent: "reader" }))
      .rejects.toThrow("Permission denied");
    await expect(dbWithPerms.persistSchema("guarded", schema, { agent: "writer" }))
      .rejects.toThrow("Permission denied");

    // Admin should succeed
    await dbWithPerms.persistSchema("guarded", schema, { agent: "admin" });
    expect(await dbWithPerms.loadPersistedSchema("guarded")).toEqual(schema);

    // Delete also requires admin
    await expect(dbWithPerms.deletePersistedSchema("guarded", { agent: "writer" }))
      .rejects.toThrow("Permission denied");
    await dbWithPerms.deletePersistedSchema("guarded", { agent: "admin" });
    expect(await dbWithPerms.loadPersistedSchema("guarded")).toBeUndefined();

    await dbWithPerms.close();
    db = new AgentDB(tmpDir);
    await db.init();
  });

  it("persistSchema skips permission check when no agent specified", async () => {
    await db.close();
    const dbWithPerms = new AgentDB(tmpDir, {
      permissions: { reader: { read: true } },
    });
    await dbWithPerms.init();

    // Internal call (no agent) should succeed even with restrictive permissions
    await dbWithPerms.persistSchema("internal", { name: "internal", version: 1 });
    expect(await dbWithPerms.loadPersistedSchema("internal")).toBeDefined();

    await dbWithPerms.close();
    db = new AgentDB(tmpDir);
    await db.init();
  });

  it("getSchema returns in-memory schema", async () => {
    expect(db.getSchema("nonexistent")).toBeUndefined();

    await db.collection(defineSchema({
      name: "in-memory",
      fields: { x: { type: "string" } },
    }));
    expect(db.getSchema("in-memory")).toBeDefined();
    expect(db.getSchema("in-memory")!.name).toBe("in-memory");
  });
});

describe("mergeSchemas", () => {
  it("persisted description/instructions win over code", () => {
    const { persisted } = mergeSchemas(
      { name: "t", description: "Code desc", instructions: "Code inst" },
      { name: "t", description: "Persisted desc", instructions: "Persisted inst" },
    );
    expect(persisted.description).toBe("Persisted desc");
    expect(persisted.instructions).toBe("Persisted inst");
  });

  it("code fills in missing description/instructions", () => {
    const { persisted } = mergeSchemas(
      { name: "t", description: "Code desc", instructions: "Code inst" },
      { name: "t" },
    );
    expect(persisted.description).toBe("Code desc");
    expect(persisted.instructions).toBe("Code inst");
  });

  it("persisted version wins", () => {
    const { persisted } = mergeSchemas(
      { name: "t", version: 3 },
      { name: "t", version: 1 },
    );
    expect(persisted.version).toBe(1);
  });

  it("warns on version mismatch", () => {
    const { warnings } = mergeSchemas(
      { name: "t", version: 2 },
      { name: "t", version: 1 },
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/version mismatch.*code v2.*persisted v1/);
  });

  it("no warning when versions match", () => {
    const { warnings } = mergeSchemas(
      { name: "t", version: 1 },
      { name: "t", version: 1 },
    );
    expect(warnings).toHaveLength(0);
  });

  it("no warning when version is undefined on either side", () => {
    const { warnings: w1 } = mergeSchemas({ name: "t" }, { name: "t", version: 1 });
    const { warnings: w2 } = mergeSchemas({ name: "t", version: 1 }, { name: "t" });
    expect(w1).toHaveLength(0);
    expect(w2).toHaveLength(0);
  });

  it("warns on field type mismatch", () => {
    const { persisted, warnings } = mergeSchemas(
      { name: "t", fields: { x: { type: "string" } } },
      { name: "t", fields: { x: { type: "number" } } },
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Field 'x' type mismatch/);
    // Code type wins for validation
    expect(persisted.fields?.x.type).toBe("string");
  });

  it("unions indexes from both sides", () => {
    const { persisted } = mergeSchemas(
      { name: "t", indexes: ["status", "priority"], arrayIndexes: ["tags"] },
      { name: "t", indexes: ["status", "date"], arrayIndexes: ["labels"] },
    );
    expect(persisted.indexes).toEqual(["status", "date", "priority"]);
    expect(persisted.arrayIndexes).toEqual(["labels", "tags"]);
  });

  it("unions composite indexes", () => {
    const { persisted } = mergeSchemas(
      { name: "t", compositeIndexes: [["a", "b"], ["c", "d"]] },
      { name: "t", compositeIndexes: [["a", "b"], ["e", "f"]] },
    );
    expect(persisted.compositeIndexes).toEqual([["a", "b"], ["e", "f"], ["c", "d"]]);
  });

  it("unions fields from both sides", () => {
    const { persisted } = mergeSchemas(
      { name: "t", fields: { title: { type: "string" }, status: { type: "enum", values: ["a"] } } },
      { name: "t", fields: { title: { type: "string", description: "Persisted" }, priority: { type: "number" } } },
    );
    expect(Object.keys(persisted.fields!).sort()).toEqual(["priority", "status", "title"]);
    expect(persisted.fields?.title.description).toBe("Persisted"); // persisted desc wins
    expect(persisted.fields?.status.type).toBe("enum");
    expect(persisted.fields?.priority.type).toBe("number");
  });

  it("code tagField/storageMode wins when set", () => {
    const { persisted } = mergeSchemas(
      { name: "t", tagField: "labels", storageMode: "disk" },
      { name: "t", tagField: "tags", storageMode: "memory" },
    );
    expect(persisted.tagField).toBe("labels");
    expect(persisted.storageMode).toBe("disk");
  });

  it("persisted tagField/storageMode used when code is unset", () => {
    const { persisted } = mergeSchemas(
      { name: "t" },
      { name: "t", tagField: "tags", storageMode: "memory" },
    );
    expect(persisted.tagField).toBe("tags");
    expect(persisted.storageMode).toBe("memory");
  });

  it("strips function defaults from code fields", () => {
    const { persisted } = mergeSchemas(
      { name: "t", fields: { ts: { type: "string", default: () => "now" } } },
      { name: "t" },
    );
    expect(persisted.fields?.ts.default).toBeUndefined();
  });
});

describe("loadSchemaFromJSON / exportSchemaToJSON", () => {
  const sampleSchema: PersistedSchema = {
    name: "tickets",
    version: 1,
    description: "Customer support tickets",
    instructions: "Set priority based on customer tier",
    fields: {
      title: { type: "string", required: true, description: "Short summary" },
      status: { type: "enum", values: ["open", "in_progress", "resolved", "closed"], default: "open" },
      priority: { type: "enum", values: ["low", "medium", "high"] },
    },
    indexes: ["status", "priority"],
  };

  it("round-trip: export → import produces equivalent schema", () => {
    const json = exportSchemaToJSON(sampleSchema);
    const loaded = loadSchemaFromJSON(json);
    expect(loaded).toEqual(sampleSchema);
  });

  it("loadSchemaFromJSON accepts object input", () => {
    const loaded = loadSchemaFromJSON({ ...sampleSchema });
    expect(loaded.name).toBe("tickets");
    expect(loaded.description).toBe("Customer support tickets");
  });

  it("loadSchemaFromJSON validates and rejects invalid input", () => {
    expect(() => loadSchemaFromJSON("{}")).toThrow("non-empty string");
    expect(() => loadSchemaFromJSON('{"name":"t","version":-1}')).toThrow("positive integer");
    expect(() => loadSchemaFromJSON("not json")).toThrow();
  });

  it("exportSchemaToJSON produces pretty-printed JSON", () => {
    const json = exportSchemaToJSON({ name: "test", version: 1 });
    expect(json).toContain("\n"); // pretty-printed
    expect(JSON.parse(json)).toEqual({ name: "test", version: 1 });
  });

  it("loadSchemaFromJSON accepts minimal schema", () => {
    const loaded = loadSchemaFromJSON('{"name":"minimal"}');
    expect(loaded).toEqual({ name: "minimal" });
  });
});

describe("mergePersistedSchemas", () => {
  it("overlay scalar properties win over base", () => {
    const result = mergePersistedSchemas(
      { name: "t", version: 1, description: "Base", instructions: "Base inst" },
      { name: "t", version: 2, description: "Overlay", instructions: "Overlay inst" },
    );
    expect(result.version).toBe(2);
    expect(result.description).toBe("Overlay");
    expect(result.instructions).toBe("Overlay inst");
  });

  it("base scalar properties preserved when overlay omits them", () => {
    const result = mergePersistedSchemas(
      { name: "t", version: 1, description: "Base", instructions: "Base inst" },
      { name: "t" },
    );
    expect(result.version).toBe(1);
    expect(result.description).toBe("Base");
    expect(result.instructions).toBe("Base inst");
  });

  it("preserves untouched field properties when overlay updates only one property", () => {
    const result = mergePersistedSchemas(
      { name: "t", fields: { title: { type: "string", required: true, description: "The title" } } },
      { name: "t", fields: { title: { type: "string" } } },
    );
    expect(result.fields?.title.required).toBe(true);
    expect(result.fields?.title.description).toBe("The title");
  });

  it("overlay field properties win when both sides specify them", () => {
    const result = mergePersistedSchemas(
      { name: "t", fields: { status: { type: "enum", values: ["a", "b"], description: "Base desc" } } },
      { name: "t", fields: { status: { type: "enum", values: ["x", "y"], description: "New desc" } } },
    );
    expect(result.fields?.status.values).toEqual(["x", "y"]);
    expect(result.fields?.status.description).toBe("New desc");
  });

  it("base-only fields preserved in merged result", () => {
    const result = mergePersistedSchemas(
      { name: "t", fields: { existing: { type: "string", description: "Keep me" } } },
      { name: "t", fields: { newField: { type: "number" } } },
    );
    expect(result.fields?.existing).toEqual({ type: "string", description: "Keep me" });
    expect(result.fields?.newField).toEqual({ type: "number" });
  });

  it("unions indexes from both sides", () => {
    const result = mergePersistedSchemas(
      { name: "t", indexes: ["a", "b"], arrayIndexes: ["tags"] },
      { name: "t", indexes: ["b", "c"], arrayIndexes: ["labels"] },
    );
    expect(result.indexes).toEqual(["a", "b", "c"]);
    expect(result.arrayIndexes).toEqual(["tags", "labels"]);
  });

  it("unions composite indexes", () => {
    const result = mergePersistedSchemas(
      { name: "t", compositeIndexes: [["a", "b"]] },
      { name: "t", compositeIndexes: [["a", "b"], ["c", "d"]] },
    );
    expect(result.compositeIndexes).toEqual([["a", "b"], ["c", "d"]]);
  });

  it("overlay tagField and storageMode win", () => {
    const result = mergePersistedSchemas(
      { name: "t", tagField: "labels", storageMode: "memory" },
      { name: "t", tagField: "tags", storageMode: "disk" },
    );
    expect(result.tagField).toBe("tags");
    expect(result.storageMode).toBe("disk");
  });

  it("no spurious undefined keys in output", () => {
    const result = mergePersistedSchemas({ name: "t" }, { name: "t" });
    expect(Object.keys(result)).toEqual(["name"]);
  });

  it("overlay required:false explicitly clears base required:true", () => {
    const result = mergePersistedSchemas(
      { name: "t", fields: { title: { type: "string", required: true } } },
      { name: "t", fields: { title: { type: "string", required: false } } },
    );
    expect(result.fields?.title.required).toBeFalsy();
  });

  it("empty fields:{} in overlay preserves base fields (same as no fields key)", () => {
    const withEmpty = mergePersistedSchemas(
      { name: "t", fields: { title: { type: "string", description: "keep" } } },
      { name: "t", fields: {} },
    );
    const withAbsent = mergePersistedSchemas(
      { name: "t", fields: { title: { type: "string", description: "keep" } } },
      { name: "t" },
    );
    expect(withEmpty.fields?.title).toEqual({ type: "string", description: "keep" });
    expect(withAbsent.fields?.title).toEqual({ type: "string", description: "keep" });
  });

  it("overlay type wins for same field without emitting warnings (no MergeResult)", () => {
    const result = mergePersistedSchemas(
      { name: "t", fields: { count: { type: "string" } } },
      { name: "t", fields: { count: { type: "number" } } },
    );
    expect(result.fields?.count.type).toBe("number");
    // mergePersistedSchemas returns PersistedSchema, not MergeResult — no warnings property
    expect((result as Record<string, unknown>).warnings).toBeUndefined();
  });
});

describe("AgentDB.loadSchemasFromFiles", () => {
  let tmpDir: string;
  let db: AgentDB;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agentdb-schema-files-"));
    db = new AgentDB(tmpDir);
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("happy path: loads a valid schema file", async () => {
    const schemaPath = join(tmpDir, "users.json");
    await writeFile(schemaPath, JSON.stringify({ name: "users", description: "User accounts", fields: { name: { type: "string" } } }), "utf-8");

    const result = await db.loadSchemasFromFiles([schemaPath]);
    expect(result.loaded).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.failed).toHaveLength(0);

    const loaded = await db.loadPersistedSchema("users");
    expect(loaded).toBeDefined();
    expect(loaded!.description).toBe("User accounts");
    expect(loaded!.fields?.name.type).toBe("string");
  });

  it("uses filename as name fallback when name is absent from JSON", async () => {
    const schemaPath = join(tmpDir, "tasks.json");
    await writeFile(schemaPath, JSON.stringify({ description: "Task list", fields: { title: { type: "string" } } }), "utf-8");

    const result = await db.loadSchemasFromFiles([schemaPath]);
    expect(result.loaded).toBe(1);

    const loaded = await db.loadPersistedSchema("tasks");
    expect(loaded!.name).toBe("tasks");
    expect(loaded!.description).toBe("Task list");
  });

  it("malformed JSON: added to failed, does not abort batch", async () => {
    const goodPath = join(tmpDir, "good.json");
    const badPath = join(tmpDir, "bad.json");
    await writeFile(goodPath, JSON.stringify({ name: "good", description: "ok" }), "utf-8");
    await writeFile(badPath, "{ not valid json", "utf-8");

    const result = await db.loadSchemasFromFiles([badPath, goodPath]);
    expect(result.loaded).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].path).toBe(badPath);
    expect(result.failed[0].error).toContain("JSON parse error");
  });

  it("validation fail: invalid field type added to failed", async () => {
    const schemaPath = join(tmpDir, "invalid.json");
    await writeFile(schemaPath, JSON.stringify({ name: "invalid", fields: { x: { type: "badtype" } } }), "utf-8");

    const result = await db.loadSchemasFromFiles([schemaPath]);
    expect(result.loaded).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toContain("Validation error");
  });

  it("file-as-overlay: file props win, existing props preserved when not in file", async () => {
    await db.persistSchema("overlay-test", {
      name: "overlay-test",
      description: "Original",
      fields: { title: { type: "string", required: true, description: "Original desc" } },
    });

    const schemaPath = join(tmpDir, "overlay-test.json");
    await writeFile(schemaPath, JSON.stringify({
      name: "overlay-test",
      description: "From file",
      fields: { title: { type: "string" } },
    }), "utf-8");

    await db.loadSchemasFromFiles([schemaPath]);
    const loaded = await db.loadPersistedSchema("overlay-test");
    expect(loaded!.description).toBe("From file");
    expect(loaded!.fields?.title.required).toBe(true);
    expect(loaded!.fields?.title.description).toBe("Original desc");
  });

  it("idempotent: loading the same file twice produces same result and skips on second load", async () => {
    const schemaPath = join(tmpDir, "idempotent.json");
    await writeFile(schemaPath, JSON.stringify({ name: "idempotent", description: "Stable", version: 1 }), "utf-8");

    const r1 = await db.loadSchemasFromFiles([schemaPath]);
    expect(r1.loaded).toBe(1);
    expect(r1.skipped).toBe(0);
    const first = await db.loadPersistedSchema("idempotent");

    const r2 = await db.loadSchemasFromFiles([schemaPath]);
    expect(r2.loaded).toBe(0);
    expect(r2.skipped).toBe(1);
    const second = await db.loadPersistedSchema("idempotent");

    expect(second).toEqual(first);
  });

  it("skips file with same content but reordered JSON keys (canonicalJSON no-op detection)", async () => {
    // Load with one key order
    const schemaPath = join(tmpDir, "reorder.json");
    await writeFile(schemaPath, JSON.stringify({ name: "reorder", description: "Stable", version: 1 }), "utf-8");

    const r1 = await db.loadSchemasFromFiles([schemaPath]);
    expect(r1.loaded).toBe(1);

    // Write same logical content with different key ordering
    await writeFile(schemaPath, JSON.stringify({ version: 1, name: "reorder", description: "Stable" }), "utf-8");

    const r2 = await db.loadSchemasFromFiles([schemaPath]);
    expect(r2.loaded).toBe(0);
    expect(r2.skipped).toBe(1);
  });

  it("skips file when derived name fails collection name validation", async () => {
    const schemaPath = join(tmpDir, "_invalid.json");
    await writeFile(schemaPath, JSON.stringify({ description: "no name field" }), "utf-8");

    const result = await db.loadSchemasFromFiles([schemaPath]);
    expect(result.skipped).toBe(1);
    expect(result.loaded).toBe(0);
    expect(result.failed).toHaveLength(0);
  });

  it("warns when explicit name field disagrees with filename-derived name", async () => {
    const schemaPath = join(tmpDir, "accounts.json");
    await writeFile(schemaPath, JSON.stringify({ name: "users", description: "Disagrees" }), "utf-8");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await db.loadSchemasFromFiles([schemaPath]);
      expect(result.loaded).toBe(1);
      expect(warnSpy).toHaveBeenCalledOnce();
      const msg = warnSpy.mock.calls[0][0] as string;
      expect(msg).toContain("users");
      expect(msg).toContain("accounts");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("valid JSON but wrong content types (array, null, number) land in failed[]", async () => {
    const arrayPath = join(tmpDir, "arr.json");
    const nullPath = join(tmpDir, "nullval.json");
    const numPath = join(tmpDir, "num.json");
    await writeFile(arrayPath, JSON.stringify([{ name: "x" }]), "utf-8");
    await writeFile(nullPath, "null", "utf-8");
    await writeFile(numPath, "42", "utf-8");

    const result = await db.loadSchemasFromFiles([arrayPath, nullPath, numPath]);
    expect(result.loaded).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failed).toHaveLength(3);
    for (const f of result.failed) {
      expect(f.error).toMatch(/Validation error/i);
    }
  });

  it("file name field wins over filename-derived name, and warning fires for the mismatch", async () => {
    const schemaPath = join(tmpDir, "tickets.json");
    await writeFile(schemaPath, JSON.stringify({ name: "users", description: "Users, not tickets" }), "utf-8");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await db.loadSchemasFromFiles([schemaPath]);
      expect(result.loaded).toBe(1);
      expect(warnSpy).toHaveBeenCalledOnce();

      // Loaded under the name from the file, not from the filename
      const byName = await db.loadPersistedSchema("users");
      expect(byName).toBeDefined();
      expect(byName!.description).toBe("Users, not tickets");

      // Nothing loaded under the filename-derived name
      const byFilename = await db.loadPersistedSchema("tickets");
      expect(byFilename).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("loads under explicit name even when filename-derived name is invalid", async () => {
    // Filename "_badname.json" derives to "_badname" which fails collection name validation.
    // But explicit name field "valid-collection" is valid — file should load under explicit name
    // with a warning (name/filename mismatch), not be skipped.
    const schemaPath = join(tmpDir, "_badname.json");
    await writeFile(schemaPath, JSON.stringify({ name: "valid-collection", description: "Explicit wins" }), "utf-8");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await db.loadSchemasFromFiles([schemaPath]);
      expect(result.loaded).toBe(1);
      expect(result.failed).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledOnce();

      const schema = await db.loadPersistedSchema("valid-collection");
      expect(schema).toBeDefined();
      expect(schema!.description).toBe("Explicit wins");
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("AgentDB schemas/ auto-discover", () => {
  let tmpDir: string;
  let db: AgentDB;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agentdb-autodiscover-"));
  });

  afterEach(async () => {
    await db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("silently skips init when schemas/ directory is absent", async () => {
    db = new AgentDB(tmpDir);
    await expect(db.init()).resolves.not.toThrow();
  });

  it("loads nothing when schemas/ directory is empty", async () => {
    await mkdir(join(tmpDir, "schemas"), { recursive: true });
    db = new AgentDB(tmpDir);
    await db.init();
    // No error, and no schemas loaded
    const loaded = await db.loadPersistedSchema("anything");
    expect(loaded).toBeUndefined();
  });

  it("loads valid schema files on init", async () => {
    await mkdir(join(tmpDir, "schemas"), { recursive: true });
    await writeFile(
      join(tmpDir, "schemas", "users.json"),
      JSON.stringify({ name: "users", description: "User accounts" }),
      "utf-8",
    );
    db = new AgentDB(tmpDir);
    await db.init();

    const loaded = await db.loadPersistedSchema("users");
    expect(loaded).toBeDefined();
    expect(loaded!.description).toBe("User accounts");
  });

  it("mixed good/bad: good ones load, bad ones do not abort init", async () => {
    await mkdir(join(tmpDir, "schemas"), { recursive: true });
    await writeFile(
      join(tmpDir, "schemas", "good.json"),
      JSON.stringify({ name: "good", description: "Fine" }),
      "utf-8",
    );
    await writeFile(
      join(tmpDir, "schemas", "bad.json"),
      "not json!",
      "utf-8",
    );
    db = new AgentDB(tmpDir);
    await db.init();

    const good = await db.loadPersistedSchema("good");
    expect(good?.description).toBe("Fine");
    const bad = await db.loadPersistedSchema("bad");
    expect(bad).toBeUndefined();
  });

  it("restart-idempotent: reloading same schemas/ on second init produces same result", async () => {
    await mkdir(join(tmpDir, "schemas"), { recursive: true });
    await writeFile(
      join(tmpDir, "schemas", "tasks.json"),
      JSON.stringify({ name: "tasks", description: "Task list", version: 1 }),
      "utf-8",
    );

    db = new AgentDB(tmpDir);
    await db.init();
    const first = await db.loadPersistedSchema("tasks");
    await db.close();

    db = new AgentDB(tmpDir);
    await db.init();
    const second = await db.loadPersistedSchema("tasks");
    expect(second).toEqual(first);
  });

  it("symlinked schemas/ directory is followed and files are loaded", async () => {
    // Create schema files in a separate directory, then symlink it as <dataDir>/schemas
    const realSchemasDir = await mkdtemp(join(tmpdir(), "agentdb-real-schemas-"));
    try {
      await writeFile(
        join(realSchemasDir, "linked.json"),
        JSON.stringify({ name: "linked", description: "From symlinked dir" }),
        "utf-8",
      );
      await symlink(realSchemasDir, join(tmpDir, "schemas"));

      db = new AgentDB(tmpDir);
      await db.init();

      const loaded = await db.loadPersistedSchema("linked");
      expect(loaded).toBeDefined();
      expect(loaded!.description).toBe("From symlinked dir");
    } finally {
      await rm(realSchemasDir, { recursive: true, force: true });
    }
  });
});
