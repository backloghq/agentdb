import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@backloghq/opslog";
import { Collection } from "../src/collection.js";

describe("Collection", () => {
  let tmpDir: string;
  let store: Store<Record<string, unknown>>;
  let col: Collection;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agentdb-col-"));
    store = new Store<Record<string, unknown>>();
    col = new Collection("test", store);
    await col.open(tmpDir, { checkpointThreshold: 1000 });
  });

  afterEach(async () => {
    try {
      await col.close();
    } catch {
      // already closed
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("insert", () => {
    it("inserts a document and returns an id", async () => {
      const id = await col.insert({ name: "Alice", role: "admin" });
      expect(id).toBeTruthy();
      expect(typeof id).toBe("string");
    });

    it("auto-generates _id if not provided", async () => {
      const id = await col.insert({ name: "Alice" });
      const record = col.findOne(id);
      expect(record?._id).toBe(id);
    });

    it("uses provided _id", async () => {
      const id = await col.insert({ _id: "custom-id", name: "Alice" });
      expect(id).toBe("custom-id");
      expect(col.findOne("custom-id")?.name).toBe("Alice");
    });

    it("stores agent identity", async () => {
      const id = await col.insert({ name: "Alice" }, { agent: "test-agent", reason: "testing" });
      // Agent info is stripped from public API
      const record = col.findOne(id);
      expect(record?._agent).toBeUndefined();
      expect(record?._reason).toBeUndefined();
      // But visible in history
      const ops = col.history(id);
      expect(ops[0].data?._agent).toBe("test-agent");
      expect(ops[0].data?._reason).toBe("testing");
    });
  });

  describe("insertMany", () => {
    it("inserts multiple documents atomically", async () => {
      const ids = await col.insertMany([
        { name: "Alice" },
        { name: "Bob" },
        { name: "Charlie" },
      ]);
      expect(ids).toHaveLength(3);
      expect(col.count()).toBe(3);
    });

    it("returns correct ids", async () => {
      const ids = await col.insertMany([
        { _id: "a", name: "Alice" },
        { name: "Bob" },
      ]);
      expect(ids[0]).toBe("a");
      expect(typeof ids[1]).toBe("string");
    });
  });

  describe("findOne", () => {
    it("returns a record by id", async () => {
      const id = await col.insert({ name: "Alice", role: "admin" });
      const record = col.findOne(id);
      expect(record?.name).toBe("Alice");
      expect(record?.role).toBe("admin");
      expect(record?._id).toBe(id);
    });

    it("returns undefined for non-existent id", () => {
      expect(col.findOne("nonexistent")).toBeUndefined();
    });

    it("strips internal metadata", async () => {
      const id = await col.insert({ name: "Alice" }, { agent: "bot" });
      const record = col.findOne(id);
      expect(record?._agent).toBeUndefined();
      expect(record?._reason).toBeUndefined();
    });
  });

  describe("find", () => {
    beforeEach(async () => {
      await col.insertMany([
        { _id: "1", name: "Alice", role: "admin", bio: "A".repeat(300) },
        { _id: "2", name: "Bob", role: "user", bio: "B".repeat(300) },
        { _id: "3", name: "Charlie", role: "admin", bio: "Short bio" },
        { _id: "4", name: "Diana", role: "user", bio: "D".repeat(300) },
        { _id: "5", name: "Eve", role: "moderator", bio: "E bio" },
      ]);
    });

    it("returns all records with no filter", () => {
      const result = col.find();
      expect(result.total).toBe(5);
      expect(result.records).toHaveLength(5);
      expect(result.truncated).toBe(false);
    });

    it("filters records", () => {
      const result = col.find({ filter: { role: "admin" } });
      expect(result.total).toBe(2);
      expect(result.records).toHaveLength(2);
      expect(result.records.every((r) => r.role === "admin")).toBe(true);
    });

    it("supports pagination with limit", () => {
      const result = col.find({ limit: 2 });
      expect(result.records).toHaveLength(2);
      expect(result.total).toBe(5);
      expect(result.truncated).toBe(true);
    });

    it("supports pagination with offset", () => {
      const result = col.find({ limit: 2, offset: 3 });
      expect(result.records).toHaveLength(2);
      expect(result.total).toBe(5);
      expect(result.truncated).toBe(false);
    });

    it("summary mode omits long text fields", () => {
      const result = col.find({ summary: true });
      // Alice's bio is 300 chars — should be omitted
      const alice = result.records.find((r) => r.name === "Alice");
      expect(alice?.bio).toBeUndefined();
      // Charlie's bio is short — should be included
      const charlie = result.records.find((r) => r.name === "Charlie");
      expect(charlie?.bio).toBe("Short bio");
    });

    it("combines filter and pagination", () => {
      const result = col.find({ filter: { role: "user" }, limit: 1 });
      expect(result.total).toBe(2);
      expect(result.records).toHaveLength(1);
      expect(result.truncated).toBe(true);
    });

    it("returns empty result for no matches", () => {
      const result = col.find({ filter: { role: "superadmin" } });
      expect(result.total).toBe(0);
      expect(result.records).toHaveLength(0);
      expect(result.truncated).toBe(false);
    });

    it("strips internal metadata from results", () => {
      const result = col.find();
      for (const record of result.records) {
        expect(record._agent).toBeUndefined();
        expect(record._reason).toBeUndefined();
      }
    });
  });

  describe("string filters", () => {
    beforeEach(async () => {
      await col.insertMany([
        { _id: "1", name: "Alice", role: "admin", age: 30 },
        { _id: "2", name: "Bob", role: "user", age: 25 },
        { _id: "3", name: "Charlie", role: "admin", age: 45 },
      ]);
    });

    it("find with compact string filter", () => {
      const result = col.find({ filter: "role:admin" });
      expect(result.total).toBe(2);
    });

    it("find with compound string filter", () => {
      const result = col.find({ filter: "role:admin age.gt:35" });
      expect(result.total).toBe(1);
      expect(result.records[0].name).toBe("Charlie");
    });

    it("count with string filter", () => {
      expect(col.count("role:admin")).toBe(2);
    });

    it("update with string filter", async () => {
      const modified = await col.update("role:admin", { $set: { verified: true } });
      expect(modified).toBe(2);
    });

    it("remove with string filter", async () => {
      const deleted = await col.remove("role:user");
      expect(deleted).toBe(1);
      expect(col.count()).toBe(2);
    });

    it("find with or string filter", () => {
      const result = col.find({ filter: "(role:admin or age:25)" });
      expect(result.total).toBe(3);
    });
  });

  describe("count", () => {
    beforeEach(async () => {
      await col.insertMany([
        { _id: "1", name: "Alice", role: "admin" },
        { _id: "2", name: "Bob", role: "user" },
        { _id: "3", name: "Charlie", role: "admin" },
      ]);
    });

    it("counts all records", () => {
      expect(col.count()).toBe(3);
    });

    it("counts with filter", () => {
      expect(col.count({ role: "admin" })).toBe(2);
    });

    it("returns 0 for no matches", () => {
      expect(col.count({ role: "superadmin" })).toBe(0);
    });
  });

  describe("update", () => {
    beforeEach(async () => {
      await col.insertMany([
        { _id: "1", name: "Alice", role: "admin", score: 10 },
        { _id: "2", name: "Bob", role: "user", score: 5 },
        { _id: "3", name: "Charlie", role: "admin", score: 8 },
      ]);
    });

    it("updates matching records with $set", async () => {
      const modified = await col.update({ role: "admin" }, { $set: { active: true } });
      expect(modified).toBe(2);
      expect(col.findOne("1")?.active).toBe(true);
      expect(col.findOne("3")?.active).toBe(true);
      expect(col.findOne("2")?.active).toBeUndefined();
    });

    it("removes fields with $unset", async () => {
      await col.update({ _id: "1" }, { $unset: { score: true } });
      expect(col.findOne("1")?.score).toBeUndefined();
    });

    it("increments with $inc", async () => {
      await col.update({ role: "admin" }, { $inc: { score: 5 } });
      expect(col.findOne("1")?.score).toBe(15);
      expect(col.findOne("3")?.score).toBe(13);
    });

    it("pushes to arrays with $push", async () => {
      await col.update({ _id: "1" }, { $set: { tags: ["admin"] } });
      await col.update({ _id: "1" }, { $push: { tags: "verified" } });
      const record = col.findOne("1");
      expect(record?.tags).toEqual(["admin", "verified"]);
    });

    it("$push creates array if field doesn't exist", async () => {
      await col.update({ _id: "1" }, { $push: { tags: "new" } });
      expect(col.findOne("1")?.tags).toEqual(["new"]);
    });

    it("$inc initializes to amount if field doesn't exist", async () => {
      await col.update({ _id: "1" }, { $inc: { bonus: 3 } });
      expect(col.findOne("1")?.bonus).toBe(3);
    });

    it("returns 0 when no records match", async () => {
      const modified = await col.update({ role: "superadmin" }, { $set: { x: 1 } });
      expect(modified).toBe(0);
    });

    it("tracks agent on update", async () => {
      await col.update({ _id: "1" }, { $set: { role: "superadmin" } }, { agent: "upgrader" });
      const ops = col.history("1");
      const lastOp = ops[ops.length - 1];
      expect(lastOp.data?._agent).toBe("upgrader");
    });
  });

  describe("upsert", () => {
    it("inserts when record doesn't exist", async () => {
      const result = await col.upsert("new-id", { name: "New" });
      expect(result.action).toBe("inserted");
      expect(result.id).toBe("new-id");
      expect(col.findOne("new-id")?.name).toBe("New");
    });

    it("updates when record exists", async () => {
      await col.insert({ _id: "existing", name: "Old" });
      const result = await col.upsert("existing", { name: "Updated" });
      expect(result.action).toBe("updated");
      expect(col.findOne("existing")?.name).toBe("Updated");
    });
  });

  describe("remove", () => {
    beforeEach(async () => {
      await col.insertMany([
        { _id: "1", name: "Alice", role: "admin" },
        { _id: "2", name: "Bob", role: "user" },
        { _id: "3", name: "Charlie", role: "admin" },
      ]);
    });

    it("deletes matching records", async () => {
      const deleted = await col.remove({ role: "admin" });
      expect(deleted).toBe(2);
      expect(col.count()).toBe(1);
      expect(col.findOne("2")?.name).toBe("Bob");
    });

    it("returns 0 when no records match", async () => {
      const deleted = await col.remove({ role: "superadmin" });
      expect(deleted).toBe(0);
      expect(col.count()).toBe(3);
    });

    it("tags agent on delete", async () => {
      await col.remove({ _id: "1" }, { agent: "cleanup-bot", reason: "deactivated" });
      // The tag op is visible in ops history
      const ops = col.getOps();
      // Last op is the delete, second-to-last is the tag
      const tagOp = ops.find((op) => op.op === "set" && op.id === "1" && op.data?._agent === "cleanup-bot");
      expect(tagOp).toBeDefined();
    });
  });

  describe("undo", () => {
    it("undoes the last mutation", async () => {
      await col.insert({ _id: "a", name: "Alice" });
      expect(col.count()).toBe(1);

      const undone = await col.undo();
      expect(undone).toBe(true);
      expect(col.count()).toBe(0);
    });

    it("undoes an update", async () => {
      await col.insert({ _id: "a", name: "Original" });
      await col.update({ _id: "a" }, { $set: { name: "Updated" } });
      await col.undo();
      expect(col.findOne("a")?.name).toBe("Original");
    });

    it("returns false when nothing to undo", async () => {
      expect(await col.undo()).toBe(false);
    });
  });

  describe("history", () => {
    it("returns operation history for a record", async () => {
      await col.insert({ _id: "a", name: "V1" });
      await col.update({ _id: "a" }, { $set: { name: "V2" } });
      await col.update({ _id: "a" }, { $set: { name: "V3" } });

      const ops = col.history("a");
      expect(ops).toHaveLength(3);
      expect(ops[0].data?.name).toBe("V1");
      expect(ops[0].prev).toBeNull(); // create
      expect(ops[2].data?.name).toBe("V3");
    });

    it("returns empty array for non-existent record", () => {
      expect(col.history("nonexistent")).toHaveLength(0);
    });
  });

  describe("stats", () => {
    it("returns collection statistics", async () => {
      await col.insert({ name: "Alice" });
      await col.insert({ name: "Bob" });
      const s = col.stats();
      expect(s.activeRecords).toBe(2);
      expect(s.opsCount).toBe(2);
    });
  });

  describe("schema", () => {
    beforeEach(async () => {
      await col.insertMany([
        { _id: "1", name: "Alice", role: "admin", score: 10, tags: ["a", "b"] },
        { _id: "2", name: "Bob", role: "user", score: 5 },
        { _id: "3", name: "Charlie", role: "admin", score: 8, active: true },
      ]);
    });

    it("returns field info from sample records", () => {
      const result = col.schema();
      expect(result.sampleCount).toBe(3);
      expect(result.fields.length).toBeGreaterThan(0);

      const nameField = result.fields.find((f) => f.name === "name");
      expect(nameField?.type).toBe("string");

      const scoreField = result.fields.find((f) => f.name === "score");
      expect(scoreField?.type).toBe("number");
    });

    it("shows multiple types when field has mixed types", async () => {
      await col.insert({ _id: "4", name: 42 }); // name is number here
      const result = col.schema();
      const nameField = result.fields.find((f) => f.name === "name");
      expect(nameField?.type).toContain("string");
      expect(nameField?.type).toContain("number");
    });

    it("respects sample size", () => {
      const result = col.schema(1);
      expect(result.sampleCount).toBe(1);
    });
  });

  describe("distinct", () => {
    beforeEach(async () => {
      await col.insertMany([
        { _id: "1", name: "Alice", role: "admin" },
        { _id: "2", name: "Bob", role: "user" },
        { _id: "3", name: "Charlie", role: "admin" },
        { _id: "4", name: "Diana", role: "moderator" },
      ]);
    });

    it("returns unique values for a field", () => {
      const result = col.distinct("role");
      expect(result.field).toBe("role");
      expect(result.count).toBe(3);
      expect(result.values.sort()).toEqual(["admin", "moderator", "user"]);
    });

    it("returns empty for non-existent field", () => {
      const result = col.distinct("nonexistent");
      expect(result.count).toBe(0);
      expect(result.values).toEqual([]);
    });

    it("handles nested fields via dot notation", async () => {
      await col.insert({ _id: "5", meta: { level: "high" } });
      await col.insert({ _id: "6", meta: { level: "low" } });
      await col.insert({ _id: "7", meta: { level: "high" } });
      const result = col.distinct("meta.level");
      expect(result.count).toBe(2);
      expect(result.values.sort()).toEqual(["high", "low"]);
    });
  });

  describe("persistence", () => {
    it("data survives close and reopen", async () => {
      await col.insert({ _id: "a", name: "Alice" });
      await col.insert({ _id: "b", name: "Bob" });
      await col.close();

      const store2 = new Store<Record<string, unknown>>();
      const col2 = new Collection("test", store2);
      await col2.open(tmpDir, { checkpointThreshold: 1000 });
      expect(col2.count()).toBe(2);
      expect(col2.findOne("a")?.name).toBe("Alice");
      await col2.close();
    });
  });
});
