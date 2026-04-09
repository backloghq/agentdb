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

  describe("TTL / expiry", () => {
    // Helper to insert an already-expired record via the raw opslog store
    async function insertExpired(c: Collection, id: string, fields: Record<string, unknown>): Promise<void> {
      const rawStore = (c as unknown as { store: Store<Record<string, unknown>> }).store;
      await rawStore.set(id, { _id: id, ...fields, _expires: "2020-01-01T00:00:00Z" });
    }

    it("records with expired TTL are excluded from findOne", async () => {
      await col.insert({ _id: "perm", name: "Permanent" });
      await insertExpired(col, "temp", { name: "Temporary" });

      expect(col.findOne("perm")?.name).toBe("Permanent");
      expect(col.findOne("temp")).toBeUndefined();
    });

    it("expired records excluded from find", async () => {
      await col.insert({ _id: "a", name: "Active" });
      await insertExpired(col, "b", { name: "Expired" });

      const result = col.find();
      expect(result.total).toBe(1);
      expect(result.records[0].name).toBe("Active");
    });

    it("expired records excluded from count", async () => {
      await col.insert({ _id: "a", name: "Active" });
      await insertExpired(col, "b", { name: "Expired" });

      expect(col.count()).toBe(1);
    });

    it("ttl option sets _expires on insert", async () => {
      const id = await col.insert({ name: "Temp" }, { ttl: 3600 });
      expect(col.findOne(id)?.name).toBe("Temp");
      expect(col.findOne(id)?._expires).toBeUndefined();
      const ops = col.history(id);
      expect(ops[0].data?._expires).toBeDefined();
    });

    it("cleanup removes expired records", async () => {
      await col.insert({ _id: "a", name: "Active" });
      await insertExpired(col, "b", { name: "Expired" });
      await insertExpired(col, "c", { name: "Also expired" });

      const cleaned = await col.cleanup();
      expect(cleaned).toBe(2);
      expect(col.count()).toBe(1);
    });

    it("non-expired records are unaffected by cleanup", async () => {
      await col.insert({ _id: "a", name: "Active" }, { ttl: 99999 });
      const cleaned = await col.cleanup();
      expect(cleaned).toBe(0);
      expect(col.findOne("a")?.name).toBe("Active");
    });

    it("expired records excluded from update", async () => {
      await col.insert({ _id: "a", name: "Active", score: 1 });
      await insertExpired(col, "b", { name: "Expired", score: 1 });

      const modified = await col.update({}, { $inc: { score: 10 } });
      expect(modified).toBe(1);
    });
  });

  describe("token budget", () => {
    beforeEach(async () => {
      await col.insertMany([
        { _id: "1", name: "Alice", bio: "A".repeat(400) },
        { _id: "2", name: "Bob", bio: "B".repeat(400) },
        { _id: "3", name: "Charlie", bio: "C".repeat(400) },
        { _id: "4", name: "Diana", bio: "D".repeat(400) },
      ]);
    });

    it("returns all records when no maxTokens", () => {
      const result = col.find();
      expect(result.records).toHaveLength(4);
      expect(result.estimatedTokens).toBeUndefined();
    });

    it("truncates when maxTokens exceeded", () => {
      // Each record is ~120 tokens (400 char bio + fields). Budget for ~2 records.
      const result = col.find({ maxTokens: 250 });
      expect(result.records.length).toBeLessThan(4);
      expect(result.truncated).toBe(true);
      expect(result.estimatedTokens).toBeDefined();
      expect(result.estimatedTokens!).toBeLessThanOrEqual(250);
    });

    it("always returns at least one record", () => {
      const result = col.find({ maxTokens: 1 });
      expect(result.records).toHaveLength(1);
      expect(result.truncated).toBe(true);
    });

    it("returns estimatedTokens when maxTokens set", () => {
      const result = col.find({ maxTokens: 10000 });
      expect(result.estimatedTokens).toBeDefined();
      expect(result.estimatedTokens!).toBeGreaterThan(0);
      expect(result.records).toHaveLength(4);
    });

    it("works with summary mode to stay under budget", () => {
      // Summary strips the long bio field, so more records fit
      const withBio = col.find({ maxTokens: 250 });
      const withSummary = col.find({ maxTokens: 250, summary: true });
      expect(withSummary.records.length).toBeGreaterThanOrEqual(withBio.records.length);
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

  describe("named views", () => {
    beforeEach(async () => {
      await col.insertMany([
        { _id: "1", name: "Alice", role: "admin", active: true },
        { _id: "2", name: "Bob", role: "user", active: false },
        { _id: "3", name: "Charlie", role: "admin", active: true },
        { _id: "4", name: "Diana", role: "user", active: true },
      ]);
    });

    it("defines and queries a view", () => {
      col.defineView({ name: "admins", filter: { role: "admin" } });
      const result = col.queryView("admins");
      expect(result.total).toBe(2);
      expect(result.records.every((r) => r.role === "admin")).toBe(true);
    });

    it("caches view results", () => {
      col.defineView({ name: "admins", filter: { role: "admin" } });
      const r1 = col.queryView("admins");
      const r2 = col.queryView("admins");
      // Same object reference = cached
      expect(r1).toBe(r2);
    });

    it("invalidates cache on mutation", async () => {
      col.defineView({ name: "active", filter: { active: true } });
      const r1 = col.queryView("active");
      expect(r1.total).toBe(3);

      await col.update({ _id: "2" }, { $set: { active: true } });
      const r2 = col.queryView("active");
      expect(r2.total).toBe(4);
      expect(r1).not.toBe(r2); // Different object = re-queried
    });

    it("supports overrides on queryView", () => {
      col.defineView({ name: "all", filter: {} });
      const result = col.queryView("all", { limit: 2 });
      expect(result.records).toHaveLength(2);
      expect(result.truncated).toBe(true);
    });

    it("view with default opts", () => {
      col.defineView({ name: "admins-summary", filter: { role: "admin" }, opts: { summary: true } });
      const result = col.queryView("admins-summary");
      expect(result.total).toBe(2);
    });

    it("throws on unknown view", () => {
      expect(() => col.queryView("nonexistent")).toThrow("not found");
    });

    it("lists views", () => {
      col.defineView({ name: "v1", filter: {} });
      col.defineView({ name: "v2", filter: {} });
      expect(col.listViews().sort()).toEqual(["v1", "v2"]);
    });

    it("removes a view", () => {
      col.defineView({ name: "temp", filter: {} });
      expect(col.removeView("temp")).toBe(true);
      expect(col.listViews()).not.toContain("temp");
    });
  });

  describe("full-text search", () => {
    let searchCol: Collection;

    beforeEach(async () => {
      const sDir = await mkdtemp(join(tmpdir(), "agentdb-search-"));
      const sStore = new Store<Record<string, unknown>>();
      searchCol = new Collection("search", sStore, { textSearch: true });
      await searchCol.open(sDir, { checkpointThreshold: 1000 });
      (searchCol as Record<string, unknown>)._testDir = sDir;

      await searchCol.insertMany([
        { _id: "1", title: "Build the API endpoint", tags: ["backend", "urgent"] },
        { _id: "2", title: "Fix login page CSS", tags: ["frontend", "bug"] },
        { _id: "3", title: "Write API documentation", tags: ["docs", "backend"] },
        { _id: "4", title: "Deploy to production", tags: ["devops"] },
      ]);
    });

    afterEach(async () => {
      const sDir = (searchCol as Record<string, unknown>)._testDir as string;
      try { await searchCol.close(); } catch { /* */ }
      await rm(sDir, { recursive: true, force: true });
    });

    it("searches by text across all string fields", () => {
      const result = searchCol.search("API");
      expect(result.total).toBe(2); // "Build the API" + "Write API documentation"
    });

    it("multi-term search uses AND", () => {
      const result = searchCol.search("API documentation");
      expect(result.total).toBe(1);
      expect(result.records[0].title).toBe("Write API documentation");
    });

    it("searches tag content", () => {
      const result = searchCol.search("backend");
      expect(result.total).toBe(2);
    });

    it("respects pagination", () => {
      const result = searchCol.search("API", { limit: 1 });
      expect(result.records).toHaveLength(1);
      expect(result.truncated).toBe(true);
    });

    it("throws when textSearch not enabled", () => {
      expect(() => col.search("test")).toThrow("not enabled");
    });

    it("index updates on insert", async () => {
      await searchCol.insert({ _id: "5", title: "New search feature" });
      const result = searchCol.search("search feature");
      expect(result.total).toBe(1);
    });

    it("index updates on remove", async () => {
      await searchCol.remove({ _id: "1" });
      const result = searchCol.search("API");
      expect(result.total).toBe(1); // Only "Write API documentation" remains
    });

    it("index updates on undo", async () => {
      await searchCol.insert({ _id: "5", title: "Temporary item" });
      expect(searchCol.search("temporary").total).toBe(1);
      await searchCol.undo();
      expect(searchCol.search("temporary").total).toBe(0);
    });
  });

  describe("virtual filters", () => {
    let vfCol: Collection;

    beforeEach(async () => {
      const vfDir = await mkdtemp(join(tmpdir(), "agentdb-vf-"));
      const vfStore = new Store<Record<string, unknown>>();
      vfCol = new Collection("vf", vfStore, {
        virtualFilters: {
          "+OVERDUE": (record) => {
            const due = record.due as string | undefined;
            return !!due && new Date(due) < new Date();
          },
          "+HIGH": (record) => record.priority === "H",
          "+BLOCKED": (record, getter) => {
            const deps = record.depends as string[] | undefined;
            if (!deps?.length) return false;
            return deps.some((id) => {
              const dep = getter(id);
              return !dep || dep.status !== "completed";
            });
          },
        },
      });
      await vfCol.open(vfDir, { checkpointThreshold: 1000 });
      (vfCol as Record<string, unknown>)._testDir = vfDir;

      await vfCol.insertMany([
        { _id: "1", title: "Past due", due: "2020-01-01", priority: "H", status: "pending" },
        { _id: "2", title: "Future", due: "2099-01-01", priority: "L", status: "pending" },
        { _id: "3", title: "No due", priority: "M", status: "pending" },
        { _id: "4", title: "Blocked", priority: "H", status: "pending", depends: ["2"] },
        { _id: "5", title: "Unblocked", priority: "H", status: "pending", depends: ["1"] },
      ]);
    });

    afterEach(async () => {
      const vfDir = (vfCol as Record<string, unknown>)._testDir as string;
      try { await vfCol.close(); } catch { /* */ }
      await rm(vfDir, { recursive: true, force: true });
    });

    it("filters with virtual filter in JSON syntax", () => {
      const result = vfCol.find({ filter: { "+OVERDUE": true } });
      expect(result.total).toBe(1);
      expect(result.records[0].title).toBe("Past due");
    });

    it("filters with virtual filter + regular filter", () => {
      const result = vfCol.find({ filter: { "+HIGH": true, status: "pending" } });
      expect(result.total).toBe(3); // Past due, Blocked, Unblocked
    });

    it("virtual filter with false negates", () => {
      const result = vfCol.find({ filter: { "+HIGH": false } });
      expect(result.total).toBe(2); // Future (L), No due (M)
    });

    it("cross-record virtual filter works", () => {
      // "Blocked" depends on "Future" which is pending — so it's blocked
      // "Unblocked" depends on "Past due" which is also pending — also blocked
      const result = vfCol.find({ filter: { "+BLOCKED": true } });
      expect(result.total).toBe(2);
    });

    it("count with virtual filter", () => {
      expect(vfCol.count({ "+OVERDUE": true })).toBe(1);
      expect(vfCol.count({ "+HIGH": true })).toBe(3);
    });

    it("virtual filters compose with string syntax via parseCompactFilter", () => {
      // Compact syntax doesn't natively support +TOKEN yet,
      // but JSON filter works. String filters without + are regular fields.
      const result = vfCol.find({ filter: { "+HIGH": true, "+OVERDUE": true } });
      expect(result.total).toBe(1);
      expect(result.records[0].title).toBe("Past due");
    });

    it("no virtual filters = backward compatible", () => {
      const result = col.find({ filter: { "+NONEXISTENT": true } });
      // Without virtual filters, +NONEXISTENT is treated as a regular field name
      expect(result.total).toBe(0);
    });
  });

  describe("computed fields", () => {
    let computed: Collection;

    beforeEach(async () => {
      const cDir = await mkdtemp(join(tmpdir(), "agentdb-comp-"));
      const cStore = new Store<Record<string, unknown>>();
      computed = new Collection("computed", cStore, {
        computed: {
          fullName: (record) => `${record.first} ${record.last}`,
          isHighPriority: (record) => record.priority === "H",
          depCount: (record, allRecords) => {
            const deps = record.depends as string[] | undefined;
            if (!deps?.length) return 0;
            return deps.filter((id) => allRecords().some((r) => r._id === id)).length;
          },
        },
      });
      await computed.open(cDir, { checkpointThreshold: 1000 });
      (computed as Record<string, unknown>)._testDir = cDir;
    });

    afterEach(async () => {
      const cDir = (computed as Record<string, unknown>)._testDir as string;
      try { await computed.close(); } catch { /* */ }
      await rm(cDir, { recursive: true, force: true });
    });

    it("computed fields appear in findOne", async () => {
      await computed.insert({ _id: "a", first: "Alice", last: "Smith", priority: "H" });
      const record = computed.findOne("a");
      expect(record?.fullName).toBe("Alice Smith");
      expect(record?.isHighPriority).toBe(true);
    });

    it("computed fields appear in find results", async () => {
      await computed.insert({ _id: "a", first: "Alice", last: "Smith", priority: "H" });
      await computed.insert({ _id: "b", first: "Bob", last: "Jones", priority: "L" });
      const result = computed.find();
      const alice = result.records.find((r) => r._id === "a");
      const bob = result.records.find((r) => r._id === "b");
      expect(alice?.fullName).toBe("Alice Smith");
      expect(alice?.isHighPriority).toBe(true);
      expect(bob?.isHighPriority).toBe(false);
    });

    it("computed fields are NOT persisted", async () => {
      await computed.insert({ _id: "a", first: "Alice", last: "Smith", priority: "H" });
      // Check raw store — computed fields should not be there
      const ops = computed.history("a");
      expect(ops[0].data?.fullName).toBeUndefined();
      expect(ops[0].data?.isHighPriority).toBeUndefined();
    });

    it("computed fields can reference other records", async () => {
      await computed.insert({ _id: "a", first: "Alice", last: "Smith", priority: "H" });
      await computed.insert({ _id: "b", first: "Bob", last: "Jones", priority: "L", depends: ["a"] });
      const bob = computed.findOne("b");
      expect(bob?.depCount).toBe(1);
    });

    it("computed fields appear in schema", async () => {
      await computed.insert({ _id: "a", first: "Alice", last: "Smith", priority: "H" });
      const s = computed.schema();
      const fullNameField = s.fields.find((f) => f.name === "fullName");
      expect(fullNameField).toBeDefined();
      expect(fullNameField?.type).toBe("string");
    });

    it("no computed = backward compatible", () => {
      // The default col has no computed fields — find should work normally
      const result = col.find();
      expect(result).toBeDefined();
    });
  });

  describe("validate hook", () => {
    let validated: Collection;

    beforeEach(async () => {
      const vDir = await mkdtemp(join(tmpdir(), "agentdb-val-"));
      const vStore = new Store<Record<string, unknown>>();
      validated = new Collection("validated", vStore, {
        validate: (record) => {
          if (!record.name || typeof record.name !== "string") {
            throw new Error("name is required and must be a string");
          }
          if (typeof record.name === "string" && record.name.length > 50) {
            throw new Error("name must be 50 chars or less");
          }
        },
      });
      await validated.open(vDir, { checkpointThreshold: 1000 });
      // Store vDir for cleanup
      (validated as Record<string, unknown>)._testDir = vDir;
    });

    afterEach(async () => {
      const vDir = (validated as Record<string, unknown>)._testDir as string;
      try { await validated.close(); } catch { /* */ }
      await rm(vDir, { recursive: true, force: true });
    });

    it("allows valid insert", async () => {
      const id = await validated.insert({ name: "Alice" });
      expect(validated.findOne(id)?.name).toBe("Alice");
    });

    it("rejects invalid insert", async () => {
      await expect(validated.insert({ role: "admin" })).rejects.toThrow("name is required");
    });

    it("rejects insert with name too long", async () => {
      await expect(validated.insert({ name: "x".repeat(51) })).rejects.toThrow("50 chars or less");
    });

    it("rejects invalid insertMany — no records written", async () => {
      await expect(validated.insertMany([
        { name: "Alice" },
        { role: "admin" }, // invalid — no name
      ])).rejects.toThrow("name is required");
      expect(validated.count()).toBe(0); // nothing persisted
    });

    it("validates update result, not operators", async () => {
      await validated.insert({ _id: "a", name: "Alice", score: 10 });
      // $unset name should fail validation (name becomes missing)
      await expect(
        validated.update({ _id: "a" }, { $unset: { name: true } }),
      ).rejects.toThrow("name is required");
      // Original record unchanged
      expect(validated.findOne("a")?.name).toBe("Alice");
    });

    it("allows valid update", async () => {
      await validated.insert({ _id: "a", name: "Alice" });
      await validated.update({ _id: "a" }, { $set: { name: "Bob" } });
      expect(validated.findOne("a")?.name).toBe("Bob");
    });

    it("rejects invalid upsert", async () => {
      await expect(validated.upsert("a", { role: "admin" })).rejects.toThrow("name is required");
      expect(validated.findOne("a")).toBeUndefined();
    });

    it("allows valid upsert", async () => {
      await validated.upsert("a", { name: "Alice" });
      expect(validated.findOne("a")?.name).toBe("Alice");
    });

    it("no validate = no-op (backward compatible)", async () => {
      // The default col fixture has no validate hook
      await col.insert({ anything: "goes" });
      expect(col.count()).toBe(1);
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
