import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDB } from "../src/agentdb.js";
import { defineSchema } from "../src/schema.js";

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
