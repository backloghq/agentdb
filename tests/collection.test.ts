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
      const record = await col.findOne(id);
      expect(record?._id).toBe(id);
    });

    it("uses provided _id", async () => {
      const id = await col.insert({ _id: "custom-id", name: "Alice" });
      expect(id).toBe("custom-id");
      expect((await col.findOne("custom-id"))?.name).toBe("Alice");
    });

    it("stores agent identity", async () => {
      const id = await col.insert({ name: "Alice" }, { agent: "test-agent", reason: "testing" });
      // Agent info is stripped from public API
      const record = await col.findOne(id);
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
      expect(await col.count()).toBe(3);
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
      const record = await col.findOne(id);
      expect(record?.name).toBe("Alice");
      expect(record?.role).toBe("admin");
      expect(record?._id).toBe(id);
    });

    it("returns undefined for non-existent id", async () => {
      expect(await col.findOne("nonexistent")).toBeUndefined();
    });

    it("strips internal metadata", async () => {
      const id = await col.insert({ name: "Alice" }, { agent: "bot" });
      const record = await col.findOne(id);
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

    it("returns all records with no filter", async () => {
      const result = await col.find();
      expect(result.total).toBe(5);
      expect(result.records).toHaveLength(5);
      expect(result.truncated).toBe(false);
    });

    it("filters records", async () => {
      const result = await col.find({ filter: { role: "admin" } });
      expect(result.total).toBe(2);
      expect(result.records).toHaveLength(2);
      expect(result.records.every((r) => r.role === "admin")).toBe(true);
    });

    it("supports pagination with limit", async () => {
      const result = await col.find({ limit: 2 });
      expect(result.records).toHaveLength(2);
      expect(result.total).toBe(5);
      expect(result.truncated).toBe(true);
    });

    it("supports pagination with offset", async () => {
      const result = await col.find({ limit: 2, offset: 3 });
      expect(result.records).toHaveLength(2);
      expect(result.total).toBe(5);
      expect(result.truncated).toBe(false);
    });

    it("summary mode omits long text fields", async () => {
      const result = await col.find({ summary: true });
      // Alice's bio is 300 chars — should be omitted
      const alice = result.records.find((r) => r.name === "Alice");
      expect(alice?.bio).toBeUndefined();
      // Charlie's bio is short — should be included
      const charlie = result.records.find((r) => r.name === "Charlie");
      expect(charlie?.bio).toBe("Short bio");
    });

    it("combines filter and pagination", async () => {
      const result = await col.find({ filter: { role: "user" }, limit: 1 });
      expect(result.total).toBe(2);
      expect(result.records).toHaveLength(1);
      expect(result.truncated).toBe(true);
    });

    it("returns empty result for no matches", async () => {
      const result = await col.find({ filter: { role: "superadmin" } });
      expect(result.total).toBe(0);
      expect(result.records).toHaveLength(0);
      expect(result.truncated).toBe(false);
    });

    it("strips internal metadata from results", async () => {
      const result = await col.find();
      for (const record of result.records) {
        expect(record._agent).toBeUndefined();
        expect(record._reason).toBeUndefined();
      }
    });
  });

  describe("change notifications", () => {
    it("emits on insert", async () => {
      const events: Array<{ type: string; ids: string[] }> = [];
      col.on("change", (e) => events.push({ type: e.type, ids: e.ids }));

      const id = await col.insert({ name: "Alice" });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("insert");
      expect(events[0].ids).toEqual([id]);
    });

    it("emits on update", async () => {
      await col.insert({ _id: "a", name: "Alice" });
      const events: Array<{ type: string }> = [];
      col.on("change", (e) => events.push({ type: e.type }));

      await col.update({ _id: "a" }, { $set: { name: "Updated" } });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("update");
    });

    it("emits on delete", async () => {
      await col.insert({ _id: "a", name: "Alice" });
      const events: Array<{ type: string }> = [];
      col.on("change", (e) => events.push({ type: e.type }));

      await col.remove({ _id: "a" });
      // delete emits twice: tag + delete (if agent specified) or just delete
      expect(events.some((e) => e.type === "delete")).toBe(true);
    });

    it("emits on undo", async () => {
      await col.insert({ _id: "a", name: "Alice" });
      const events: Array<{ type: string }> = [];
      col.on("change", (e) => events.push({ type: e.type }));

      await col.undo();
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("undo");
    });

    it("includes agent in event", async () => {
      const events: Array<{ agent?: string }> = [];
      col.on("change", (e) => events.push({ agent: e.agent }));

      await col.insert({ name: "Alice" }, { agent: "test-bot" });
      expect(events[0].agent).toBe("test-bot");
    });

    it("off removes listener", async () => {
      const events: Array<{ type: string }> = [];
      const listener = (e: { type: string }) => events.push({ type: e.type });
      col.on("change", listener);

      await col.insert({ name: "Alice" });
      expect(events).toHaveLength(1);

      col.off("change", listener);
      await col.insert({ name: "Bob" });
      expect(events).toHaveLength(1); // no new event
    });
  });

  describe("optimistic locking", () => {
    it("records have _version starting at 1", async () => {
      const id = await col.insert({ _id: "a", name: "Alice" });
      const record = await col.findOne(id);
      expect(record?._version).toBe(1);
    });

    it("_version increments on update", async () => {
      await col.insert({ _id: "a", name: "Alice" });
      await col.update({ _id: "a" }, { $set: { name: "Updated" } });
      expect((await col.findOne("a"))?._version).toBe(2);
    });

    it("_version increments on upsert", async () => {
      await col.insert({ _id: "a", name: "Alice" });
      await col.upsert("a", { name: "Upserted" });
      expect((await col.findOne("a"))?._version).toBe(2);
    });

    it("update with matching expectedVersion succeeds", async () => {
      await col.insert({ _id: "a", name: "Alice" });
      await col.update({ _id: "a" }, { $set: { name: "Updated" } }, { expectedVersion: 1 });
      expect((await col.findOne("a"))?._version).toBe(2);
      expect((await col.findOne("a"))?.name).toBe("Updated");
    });

    it("update with mismatched expectedVersion throws conflict", async () => {
      await col.insert({ _id: "a", name: "Alice" });
      await col.update({ _id: "a" }, { $set: { name: "V2" } }); // version now 2
      await expect(
        col.update({ _id: "a" }, { $set: { name: "V3" } }, { expectedVersion: 1 }),
      ).rejects.toThrow("Conflict");
      expect((await col.findOne("a"))?.name).toBe("V2"); // unchanged
    });

    it("upsert with mismatched expectedVersion throws conflict", async () => {
      await col.insert({ _id: "a", name: "Alice" });
      await expect(
        col.upsert("a", { name: "New" }, { expectedVersion: 99 }),
      ).rejects.toThrow("Conflict");
      expect((await col.findOne("a"))?.name).toBe("Alice");
    });

    it("no expectedVersion = no check (backward compatible)", async () => {
      await col.insert({ _id: "a", name: "Alice" });
      await col.update({ _id: "a" }, { $set: { name: "V2" } });
      await col.update({ _id: "a" }, { $set: { name: "V3" } }); // no expectedVersion
      expect((await col.findOne("a"))?.name).toBe("V3");
    });

    it("_version visible in find results", async () => {
      await col.insertMany([
        { _id: "a", name: "Alice" },
        { _id: "b", name: "Bob" },
      ]);
      const result = await col.find();
      expect(result.records.every((r) => r._version === 1)).toBe(true);
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

      expect((await col.findOne("perm"))?.name).toBe("Permanent");
      expect(await col.findOne("temp")).toBeUndefined();
    });

    it("expired records excluded from find", async () => {
      await col.insert({ _id: "a", name: "Active" });
      await insertExpired(col, "b", { name: "Expired" });

      const result = await col.find();
      expect(result.total).toBe(1);
      expect(result.records[0].name).toBe("Active");
    });

    it("expired records excluded from count", async () => {
      await col.insert({ _id: "a", name: "Active" });
      await insertExpired(col, "b", { name: "Expired" });

      expect(await col.count()).toBe(1);
    });

    it("ttl option sets _expires on insert", async () => {
      const id = await col.insert({ name: "Temp" }, { ttl: 3600 });
      expect((await col.findOne(id))?.name).toBe("Temp");
      expect((await col.findOne(id))?._expires).toBeUndefined();
      const ops = col.history(id);
      expect(ops[0].data?._expires).toBeDefined();
    });

    it("cleanup removes expired records", async () => {
      await col.insert({ _id: "a", name: "Active" });
      await insertExpired(col, "b", { name: "Expired" });
      await insertExpired(col, "c", { name: "Also expired" });

      const cleaned = await col.cleanup();
      expect(cleaned).toBe(2);
      expect(await col.count()).toBe(1);
    });

    it("non-expired records are unaffected by cleanup", async () => {
      await col.insert({ _id: "a", name: "Active" }, { ttl: 99999 });
      const cleaned = await col.cleanup();
      expect(cleaned).toBe(0);
      expect((await col.findOne("a"))?.name).toBe("Active");
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

    it("returns all records when no maxTokens", async () => {
      const result = await col.find();
      expect(result.records).toHaveLength(4);
      expect(result.estimatedTokens).toBeUndefined();
    });

    it("truncates when maxTokens exceeded", async () => {
      // Each record is ~120 tokens (400 char bio + fields). Budget for ~2 records.
      const result = await col.find({ maxTokens: 250 });
      expect(result.records.length).toBeLessThan(4);
      expect(result.truncated).toBe(true);
      expect(result.estimatedTokens).toBeDefined();
      expect(result.estimatedTokens!).toBeLessThanOrEqual(250);
    });

    it("always returns at least one record", async () => {
      const result = await col.find({ maxTokens: 1 });
      expect(result.records).toHaveLength(1);
      expect(result.truncated).toBe(true);
    });

    it("returns estimatedTokens when maxTokens set", async () => {
      const result = await col.find({ maxTokens: 10000 });
      expect(result.estimatedTokens).toBeDefined();
      expect(result.estimatedTokens!).toBeGreaterThan(0);
      expect(result.records).toHaveLength(4);
    });

    it("works with summary mode to stay under budget", async () => {
      // Summary strips the long bio field, so more records fit
      const withBio = await col.find({ maxTokens: 250 });
      const withSummary = await col.find({ maxTokens: 250, summary: true });
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

    it("find with compact string filter", async () => {
      const result = await col.find({ filter: "role:admin" });
      expect(result.total).toBe(2);
    });

    it("find with compound string filter", async () => {
      const result = await col.find({ filter: "role:admin age.gt:35" });
      expect(result.total).toBe(1);
      expect(result.records[0].name).toBe("Charlie");
    });

    it("count with string filter", async () => {
      expect(await col.count("role:admin")).toBe(2);
    });

    it("update with string filter", async () => {
      const modified = await col.update("role:admin", { $set: { verified: true } });
      expect(modified).toBe(2);
    });

    it("remove with string filter", async () => {
      const deleted = await col.remove("role:user");
      expect(deleted).toBe(1);
      expect(await col.count()).toBe(2);
    });

    it("find with or string filter", async () => {
      const result = await col.find({ filter: "(role:admin or age:25)" });
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

    it("counts all records", async () => {
      expect(await col.count()).toBe(3);
    });

    it("counts with filter", async () => {
      expect(await col.count({ role: "admin" })).toBe(2);
    });

    it("returns 0 for no matches", async () => {
      expect(await col.count({ role: "superadmin" })).toBe(0);
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
      expect((await col.findOne("1"))?.active).toBe(true);
      expect((await col.findOne("3"))?.active).toBe(true);
      expect((await col.findOne("2"))?.active).toBeUndefined();
    });

    it("removes fields with $unset", async () => {
      await col.update({ _id: "1" }, { $unset: { score: true } });
      expect((await col.findOne("1"))?.score).toBeUndefined();
    });

    it("increments with $inc", async () => {
      await col.update({ role: "admin" }, { $inc: { score: 5 } });
      expect((await col.findOne("1"))?.score).toBe(15);
      expect((await col.findOne("3"))?.score).toBe(13);
    });

    it("pushes to arrays with $push", async () => {
      await col.update({ _id: "1" }, { $set: { tags: ["admin"] } });
      await col.update({ _id: "1" }, { $push: { tags: "verified" } });
      const record = await col.findOne("1");
      expect(record?.tags).toEqual(["admin", "verified"]);
    });

    it("$push creates array if field doesn't exist", async () => {
      await col.update({ _id: "1" }, { $push: { tags: "new" } });
      expect((await col.findOne("1"))?.tags).toEqual(["new"]);
    });

    it("$inc initializes to amount if field doesn't exist", async () => {
      await col.update({ _id: "1" }, { $inc: { bonus: 3 } });
      expect((await col.findOne("1"))?.bonus).toBe(3);
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
      expect((await col.findOne("new-id"))?.name).toBe("New");
    });

    it("updates when record exists", async () => {
      await col.insert({ _id: "existing", name: "Old" });
      const result = await col.upsert("existing", { name: "Updated" });
      expect(result.action).toBe("updated");
      expect((await col.findOne("existing"))?.name).toBe("Updated");
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
      expect(await col.count()).toBe(1);
      expect((await col.findOne("2"))?.name).toBe("Bob");
    });

    it("returns 0 when no records match", async () => {
      const deleted = await col.remove({ role: "superadmin" });
      expect(deleted).toBe(0);
      expect(await col.count()).toBe(3);
    });

    it("deletes without double write", async () => {
      await col.remove({ _id: "1" }, { agent: "cleanup-bot", reason: "deactivated" });
      const ops = col.getOps();
      // Should be a single delete op, not a tag-then-delete pair
      const deleteOps = ops.filter((op) => op.op === "delete" && op.id === "1");
      expect(deleteOps).toHaveLength(1);
    });

    it("_id fast path: update by _id without full scan", async () => {
      const updated = await col.update({ _id: "1" }, { $set: { role: "superadmin" } });
      expect(updated).toBe(1);
      expect((await col.findOne("1"))?.role).toBe("superadmin");
    });

    it("_id fast path: remove by _id without full scan", async () => {
      const deleted = await col.remove({ _id: "2" });
      expect(deleted).toBe(1);
      expect(await col.findOne("2")).toBeUndefined();
      expect(await col.count()).toBe(2);
    });

    it("_id fast path: update non-existent _id returns 0", async () => {
      const updated = await col.update({ _id: "nonexistent" }, { $set: { x: 1 } });
      expect(updated).toBe(0);
    });

    it("indexed update: uses index for non-_id filter", async () => {
      col.createIndex("role");
      const updated = await col.update({ role: "admin" }, { $set: { verified: true } });
      expect(updated).toBe(2);
      expect((await col.findOne("1"))?.verified).toBe(true);
      expect((await col.findOne("3"))?.verified).toBe(true);
    });

    it("predicate cache: repeated identical filters reuse compiled predicate", async () => {
      // Run the same filter multiple times — should not error and should return consistent results
      for (let i = 0; i < 10; i++) {
        const result = await col.find({ filter: { role: "admin" } });
        expect(result.records).toHaveLength(2);
      }
    });
  });

  describe("undo", () => {
    it("undoes the last mutation", async () => {
      await col.insert({ _id: "a", name: "Alice" });
      expect(await col.count()).toBe(1);

      const undone = await col.undo();
      expect(undone).toBe(true);
      expect(await col.count()).toBe(0);
    });

    it("undoes an update", async () => {
      await col.insert({ _id: "a", name: "Original" });
      await col.update({ _id: "a" }, { $set: { name: "Updated" } });
      await col.undo();
      expect((await col.findOne("a"))?.name).toBe("Original");
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

  describe("indexes and query tracking", () => {
    beforeEach(async () => {
      await col.insertMany([
        { _id: "1", name: "Alice", role: "admin", score: 10 },
        { _id: "2", name: "Bob", role: "user", score: 20 },
        { _id: "3", name: "Charlie", role: "admin", score: 30 },
      ]);
    });

    it("creates a B-tree index and queries it", () => {
      col.createIndex("role");
      expect(col.listIndexes()).toContain("role");
    });

    it("creates a bloom filter", () => {
      col.createBloomFilter("role");
      expect(col.mightHave("role", "admin")).toBe(true);
      expect(col.mightHave("role", "nonexistent")).toBe(false);
    });

    it("mightHave returns true when no bloom filter exists", () => {
      expect(col.mightHave("role", "anything")).toBe(true);
    });

    it("tracks query frequency", async () => {
      await col.find({ filter: { role: "admin" } });
      await col.find({ filter: { role: "user" } });
      await col.find({ filter: { score: { $gt: 15 } } });
      const suggestions = col.suggestIndexes(2);
      expect(suggestions[0].field).toBe("role");
      expect(suggestions[0].count).toBe(2);
    });

    it("drops an index", () => {
      col.createIndex("role");
      expect(col.dropIndex("role")).toBe(true);
      expect(col.listIndexes()).not.toContain("role");
    });

    it("uses index for $gt/$lt range queries", async () => {
      col.createIndex("score");
      const result = await col.find({ filter: { score: { $gt: 20 } } });
      expect(result.records).toHaveLength(1);
      expect(result.records[0].name).toBe("Charlie");
    });

    it("uses index for $gte/$lte range queries", async () => {
      col.createIndex("score");
      const result = await col.find({ filter: { score: { $gte: 10, $lte: 20 } } });
      expect(result.records).toHaveLength(2);
      const names = result.records.map((r) => r.name);
      expect(names).toContain("Alice");
      expect(names).toContain("Bob");
    });

    it("uses index for compound range + equality on different fields", async () => {
      col.createIndex("score");
      // score index narrows, then role filter applied as predicate
      const result = await col.find({ filter: { score: { $gte: 10 }, role: "admin" } });
      expect(result.records).toHaveLength(2);
    });

    it("count fast path returns correct count with index and no TTL", async () => {
      col.createIndex("role");
      expect(await col.count({ role: "admin" })).toBe(2);
      expect(await col.count({ role: "user" })).toBe(1);
      expect(await col.count({ role: "nonexistent" })).toBe(0);
    });

    it("count with range operator on indexed field", async () => {
      col.createIndex("score");
      expect(await col.count({ score: { $gt: 15 } })).toBe(2);
      expect(await col.count({ score: { $lte: 10 } })).toBe(1);
    });

    // --- Composite indexes ---

    it("creates a composite index and resolves compound equality", async () => {
      col.createCompositeIndex(["role", "score"]);
      expect(col.listCompositeIndexes()).toEqual([["role", "score"]]);

      // Compound equality: role=admin AND score=10
      const result = await col.find({ filter: { role: "admin", score: 10 } });
      expect(result.records).toHaveLength(1);
      expect(result.records[0].name).toBe("Alice");
    });

    it("composite index with range on trailing field", async () => {
      col.createCompositeIndex(["role", "score"]);

      // role=admin AND score >= 20
      const result = await col.find({ filter: { role: "admin", score: { $gte: 20 } } });
      expect(result.records).toHaveLength(1);
      expect(result.records[0].name).toBe("Charlie");
    });

    it("composite index with combined range on trailing field", async () => {
      col.createCompositeIndex(["role", "score"]);

      // role=admin AND 5 <= score <= 25
      const result = await col.find({ filter: { role: "admin", score: { $gte: 5, $lte: 25 } } });
      expect(result.records).toHaveLength(1);
      expect(result.records[0].name).toBe("Alice");
    });

    it("composite index maintained through insert/update/delete", async () => {
      col.createCompositeIndex(["role", "score"]);

      await col.insert({ _id: "d", name: "Dave", role: "admin", score: 40 });
      const r1 = await col.find({ filter: { role: "admin", score: 40 } });
      expect(r1.records).toHaveLength(1);

      await col.update({ _id: "d" }, { $set: { score: 50 } });
      expect((await col.find({ filter: { role: "admin", score: 40 } })).records).toHaveLength(0);
      expect((await col.find({ filter: { role: "admin", score: 50 } })).records).toHaveLength(1);

      await col.remove({ _id: "d" });
      expect((await col.find({ filter: { role: "admin", score: 50 } })).records).toHaveLength(0);
    });

    it("composite index prefix-only falls back to single-field index", async () => {
      col.createIndex("role");
      col.createCompositeIndex(["role", "score"]);

      // Only role in filter — composite not eligible, single-field used
      const result = await col.find({ filter: { role: "admin" } });
      expect(result.records).toHaveLength(2);
    });

    it("drops a composite index", () => {
      col.createCompositeIndex(["role", "score"]);
      expect(col.dropCompositeIndex(["role", "score"])).toBe(true);
      expect(col.listCompositeIndexes()).toHaveLength(0);
    });

    it("rejects composite index with fewer than 2 fields", () => {
      expect(() => col.createCompositeIndex(["role"])).toThrow("at least 2 fields");
    });

    it("range query on indexed field with no matching records returns empty", async () => {
      col.createIndex("score");
      const result = await col.find({ filter: { score: { $gt: 100 } } });
      expect(result.records).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it("composite index with all fields matching exact equality", async () => {
      col.createCompositeIndex(["role", "score"]);
      // Both fields match exactly one record
      const result = await col.find({ filter: { role: "user", score: 20 } });
      expect(result.records).toHaveLength(1);
      expect(result.records[0].name).toBe("Bob");
    });

    it("indexedCandidates returns null when filter has no indexed fields", async () => {
      // Create an index on 'role' but filter on 'name' (not indexed)
      col.createIndex("role");
      // We query on a non-indexed field — index cannot help, falls through to full scan
      const result = await col.find({ filter: { name: "Alice" } });
      expect(result.records).toHaveLength(1);
      expect(result.records[0].name).toBe("Alice");
    });

    it("createIndex on a field that already exists is a no-op", () => {
      col.createIndex("role");
      const indexesBefore = col.listIndexes();
      // Create again — should silently no-op
      col.createIndex("role");
      const indexesAfter = col.listIndexes();
      expect(indexesAfter).toEqual(indexesBefore);
    });

    it("createCompositeIndex on fields that already exist is a no-op", () => {
      col.createCompositeIndex(["role", "score"]);
      const before = col.listCompositeIndexes();
      // Create again — should silently no-op
      col.createCompositeIndex(["role", "score"]);
      const after = col.listCompositeIndexes();
      expect(after).toEqual(before);
    });

    it("suggestIndexes returns empty when no queries tracked", () => {
      // No find() calls have been made with filters, so no query tracking
      const suggestions = col.suggestIndexes(1);
      expect(suggestions).toHaveLength(0);
    });

  });

  describe("subscription cleanup", () => {
    it("subscribe then unsubscribe prevents further notifications", async () => {
      const events: Array<{ type: string; ids: string[] }> = [];
      const listener = (e: { type: string; ids: string[] }) => {
        events.push(e);
      };

      col.on("change", listener);
      await col.insert({ _id: "x1", name: "Test" });
      expect(events.length).toBeGreaterThan(0);

      const countBefore = events.length;
      col.off("change", listener);

      await col.insert({ _id: "x2", name: "Test2" });
      // No new events after unsubscribe
      expect(events.length).toBe(countBefore);
    });
  });

  describe("TTL cleanup removes from indexes", () => {
    it("cleanup of expired records also removes them from indexes", async () => {
      await col.insert({ _id: "a", name: "Active", role: "admin" });

      // Insert a record that will expire immediately via raw store
      const rawStore = (col as unknown as { store: Store<Record<string, unknown>> }).store;
      await rawStore.set("b", {
        _id: "b",
        name: "Expired",
        role: "admin",
        _expires: "2020-01-01T00:00:00Z",
      });

      // Create index on role — expired records are excluded during index creation
      col.createIndex("role");

      // Verify: find with index only returns active record
      const beforeCleanup = await col.find({ filter: { role: "admin" } });
      expect(beforeCleanup.records).toHaveLength(1);
      expect(beforeCleanup.records[0]._id).toBe("a");

      // Run cleanup — removes expired from store + indexes
      const cleaned = await col.cleanup();
      expect(cleaned).toBe(1);

      // After cleanup, index should still work correctly
      const afterCleanup = await col.find({ filter: { role: "admin" } });
      expect(afterCleanup.records).toHaveLength(1);
      expect(afterCleanup.records[0]._id).toBe("a");

      // Total count should reflect only active records
      expect(await col.count()).toBe(1);
    });
  });

  describe("WAL tailing", () => {
    it("tail picks up new ops from another writer", async () => {
      // Writer inserts data
      await col.insert({ _id: "a", name: "Alice" });
      await col.close();

      // Open writer and reader on same directory
      const writerStore = new Store<Record<string, unknown>>();
      const writer = new Collection("test", writerStore);
      await writer.open(tmpDir, { checkpointThreshold: 1000 });

      const readerStore = new Store<Record<string, unknown>>();
      const reader = new Collection("test-reader", readerStore);
      await reader.open(tmpDir, { checkpointThreshold: 1000, readOnly: true } as Record<string, unknown>);

      // Reader sees initial data
      expect(await reader.count()).toBe(1);

      // Writer adds more
      await writer.insert({ _id: "b", name: "Bob" });

      // Reader tails to pick up
      const newOps = await reader.tail();
      expect(newOps.length).toBeGreaterThan(0);
      expect((await reader.findOne("b"))?.name).toBe("Bob");

      await reader.close();
      await writer.close();

      // Re-open original col for afterEach cleanup
      store = new Store<Record<string, unknown>>();
      col = new Collection("test", store);
      await col.open(tmpDir, { checkpointThreshold: 1000 });
    });

    it("tail returns empty when no new ops", async () => {
      await col.insert({ _id: "a", name: "Alice" });
      const ops = await col.tail();
      expect(ops).toHaveLength(0);
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

    it("defines and queries a view", async () => {
      col.defineView({ name: "admins", filter: { role: "admin" } });
      const result = await col.queryView("admins");
      expect(result.total).toBe(2);
      expect(result.records.every((r) => r.role === "admin")).toBe(true);
    });

    it("caches view results", async () => {
      col.defineView({ name: "admins", filter: { role: "admin" } });
      const r1 = await col.queryView("admins");
      const r2 = await col.queryView("admins");
      // Same object reference = cached
      expect(r1).toBe(r2);
    });

    it("invalidates cache on mutation", async () => {
      col.defineView({ name: "active", filter: { active: true } });
      const r1 = await col.queryView("active");
      expect(r1.total).toBe(3);

      await col.update({ _id: "2" }, { $set: { active: true } });
      const r2 = await col.queryView("active");
      expect(r2.total).toBe(4);
      expect(r1).not.toBe(r2); // Different object = re-queried
    });

    it("supports overrides on queryView", async () => {
      col.defineView({ name: "all", filter: {} });
      const result = await col.queryView("all", { limit: 2 });
      expect(result.records).toHaveLength(2);
      expect(result.truncated).toBe(true);
    });

    it("view with default opts", async () => {
      col.defineView({ name: "admins-summary", filter: { role: "admin" }, opts: { summary: true } });
      const result = await col.queryView("admins-summary");
      expect(result.total).toBe(2);
    });

    it("throws on unknown view", async () => {
      await expect(col.queryView("nonexistent")).rejects.toThrow("not found");
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

    it("searches by text across all string fields", async () => {
      const result = await searchCol.search("API");
      expect(result.total).toBe(2); // "Build the API" + "Write API documentation"
    });

    it("multi-term search uses AND", async () => {
      const result = await searchCol.search("API documentation");
      expect(result.total).toBe(1);
      expect(result.records[0].title).toBe("Write API documentation");
    });

    it("searches tag content", async () => {
      const result = await searchCol.search("backend");
      expect(result.total).toBe(2);
    });

    it("respects pagination", async () => {
      const result = await searchCol.search("API", { limit: 1 });
      expect(result.records).toHaveLength(1);
      expect(result.truncated).toBe(true);
    });

    it("throws when textSearch not enabled", async () => {
      await expect(col.search("test")).rejects.toThrow("not enabled");
    });

    it("index updates on insert", async () => {
      await searchCol.insert({ _id: "5", title: "New search feature" });
      const result = await searchCol.search("search feature");
      expect(result.total).toBe(1);
    });

    it("index updates on remove", async () => {
      await searchCol.remove({ _id: "1" });
      const result = await searchCol.search("API");
      expect(result.total).toBe(1); // Only "Write API documentation" remains
    });

    it("index updates on undo", async () => {
      await searchCol.insert({ _id: "5", title: "Temporary item" });
      expect((await searchCol.search("temporary")).total).toBe(1);
      await searchCol.undo();
      expect((await searchCol.search("temporary")).total).toBe(0);
    });
  });

  describe("semantic search", () => {
    let semCol: Collection;
    let mockProvider: { embed: (texts: string[]) => Promise<number[][]>; dimensions: number };

    beforeEach(async () => {
      // Mock provider: deterministic embeddings based on text content
      mockProvider = {
        dimensions: 4,
        embed: async (texts: string[]) => {
          return texts.map((text) => {
            const lower = text.toLowerCase();
            // Generate vectors that cluster by topic
            if (lower.includes("deploy") || lower.includes("production")) return [0.9, 0.1, 0.0, 0.0];
            if (lower.includes("api") || lower.includes("endpoint")) return [0.1, 0.9, 0.0, 0.0];
            if (lower.includes("css") || lower.includes("frontend")) return [0.0, 0.1, 0.9, 0.0];
            if (lower.includes("test") || lower.includes("bug")) return [0.0, 0.0, 0.1, 0.9];
            return [0.25, 0.25, 0.25, 0.25]; // generic
          });
        },
      };

      const sDir = await mkdtemp(join(tmpdir(), "agentdb-sem-"));
      const sStore = new Store<Record<string, unknown>>();
      semCol = new Collection("semantic", sStore);
      semCol.setEmbeddingProvider(mockProvider);
      await semCol.open(sDir, { checkpointThreshold: 1000 });
      (semCol as Record<string, unknown>)._testDir = sDir;

      await semCol.insertMany([
        { _id: "1", title: "Deploy to production", category: "devops" },
        { _id: "2", title: "Build API endpoint", category: "backend" },
        { _id: "3", title: "Fix CSS layout", category: "frontend" },
        { _id: "4", title: "Write unit tests", category: "testing" },
        { _id: "5", title: "Deploy staging server", category: "devops" },
      ]);
    });

    afterEach(async () => {
      const sDir = (semCol as Record<string, unknown>)._testDir as string;
      try { await semCol.close(); } catch { /* */ }
      await rm(sDir, { recursive: true, force: true });
    });

    it("finds semantically similar records", async () => {
      const result = await semCol.semanticSearch("deployment to production");
      expect(result.records.length).toBeGreaterThan(0);
      // Deploy records should rank highest
      const titles = result.records.map((r) => r.title);
      expect(titles[0]).toContain("Deploy");
    });

    it("returns scores", async () => {
      const result = await semCol.semanticSearch("deployment");
      expect(result.scores.length).toBe(result.records.length);
      // Scores should be descending
      for (let i = 1; i < result.scores.length; i++) {
        expect(result.scores[i - 1]).toBeGreaterThanOrEqual(result.scores[i]);
      }
    });

    it("respects limit", async () => {
      const result = await semCol.semanticSearch("anything", { limit: 2 });
      expect(result.records.length).toBeLessThanOrEqual(2);
    });

    it("filters with attribute filter (hybrid query)", async () => {
      const result = await semCol.semanticSearch("deploy", { filter: { category: "devops" } });
      expect(result.records.every((r) => r.category === "devops")).toBe(true);
    });

    it("throws when no embedding provider", async () => {
      // col has no provider
      await expect(col.semanticSearch("test")).rejects.toThrow("not available");
    });

    it("_embedding is stripped from output", async () => {
      const result = await semCol.semanticSearch("deploy");
      for (const record of result.records) {
        expect(record._embedding).toBeUndefined();
      }
    });

    it("embedUnembedded returns count", async () => {
      // Trigger initial embedding of all 5 records
      await semCol.semanticSearch("anything");
      // Now insert a new one
      await semCol.insert({ _id: "6", title: "New API feature" });
      const count = await semCol.embedUnembedded();
      expect(count).toBe(1); // Only the new one
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

    it("filters with virtual filter in JSON syntax", async () => {
      const result = await vfCol.find({ filter: { "+OVERDUE": true } });
      expect(result.total).toBe(1);
      expect(result.records[0].title).toBe("Past due");
    });

    it("filters with virtual filter + regular filter", async () => {
      const result = await vfCol.find({ filter: { "+HIGH": true, status: "pending" } });
      expect(result.total).toBe(3); // Past due, Blocked, Unblocked
    });

    it("virtual filter with false negates", async () => {
      const result = await vfCol.find({ filter: { "+HIGH": false } });
      expect(result.total).toBe(2); // Future (L), No due (M)
    });

    it("cross-record virtual filter works", async () => {
      // "Blocked" depends on "Future" which is pending — so it's blocked
      // "Unblocked" depends on "Past due" which is also pending — also blocked
      const result = await vfCol.find({ filter: { "+BLOCKED": true } });
      expect(result.total).toBe(2);
    });

    it("count with virtual filter", async () => {
      expect(await vfCol.count({ "+OVERDUE": true })).toBe(1);
      expect(await vfCol.count({ "+HIGH": true })).toBe(3);
    });

    it("virtual filters compose with string syntax via parseCompactFilter", async () => {
      // Compact syntax doesn't natively support +TOKEN yet,
      // but JSON filter works. String filters without + are regular fields.
      const result = await vfCol.find({ filter: { "+HIGH": true, "+OVERDUE": true } });
      expect(result.total).toBe(1);
      expect(result.records[0].title).toBe("Past due");
    });

    it("no virtual filters = backward compatible", async () => {
      const result = await col.find({ filter: { "+NONEXISTENT": true } });
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
      const record = await computed.findOne("a");
      expect(record?.fullName).toBe("Alice Smith");
      expect(record?.isHighPriority).toBe(true);
    });

    it("computed fields appear in find results", async () => {
      await computed.insert({ _id: "a", first: "Alice", last: "Smith", priority: "H" });
      await computed.insert({ _id: "b", first: "Bob", last: "Jones", priority: "L" });
      const result = await computed.find();
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
      const bob = await computed.findOne("b");
      expect(bob?.depCount).toBe(1);
    });

    it("computed fields appear in schema", async () => {
      await computed.insert({ _id: "a", first: "Alice", last: "Smith", priority: "H" });
      const s = computed.schema();
      const fullNameField = s.fields.find((f) => f.name === "fullName");
      expect(fullNameField).toBeDefined();
      expect(fullNameField?.type).toBe("string");
    });

    it("no computed = backward compatible", async () => {
      // The default col has no computed fields — find should work normally
      const result = await col.find();
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
      expect((await validated.findOne(id))?.name).toBe("Alice");
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
      expect(await validated.count()).toBe(0); // nothing persisted
    });

    it("validates update result, not operators", async () => {
      await validated.insert({ _id: "a", name: "Alice", score: 10 });
      // $unset name should fail validation (name becomes missing)
      await expect(
        validated.update({ _id: "a" }, { $unset: { name: true } }),
      ).rejects.toThrow("name is required");
      // Original record unchanged
      expect((await validated.findOne("a"))?.name).toBe("Alice");
    });

    it("allows valid update", async () => {
      await validated.insert({ _id: "a", name: "Alice" });
      await validated.update({ _id: "a" }, { $set: { name: "Bob" } });
      expect((await validated.findOne("a"))?.name).toBe("Bob");
    });

    it("rejects invalid upsert", async () => {
      await expect(validated.upsert("a", { role: "admin" })).rejects.toThrow("name is required");
      expect(await validated.findOne("a")).toBeUndefined();
    });

    it("allows valid upsert", async () => {
      await validated.upsert("a", { name: "Alice" });
      expect((await validated.findOne("a"))?.name).toBe("Alice");
    });

    it("no validate = no-op (backward compatible)", async () => {
      // The default col fixture has no validate hook
      await col.insert({ anything: "goes" });
      expect(await col.count()).toBe(1);
    });
  });

  describe("combined middleware", () => {
    it("validate + computed + virtualFilters work together", async () => {
      const cDir = await mkdtemp(join(tmpdir(), "agentdb-combo-"));
      const cStore = new Store<Record<string, unknown>>();
      const combo = new Collection("combo", cStore, {
        validate: (record) => {
          if (!record.title) throw new Error("title required");
        },
        computed: {
          titleLen: (record) => (record.title as string)?.length ?? 0,
        },
        virtualFilters: {
          "+LONG": (record) => (record.title as string)?.length > 10,
        },
      });
      await combo.open(cDir, { checkpointThreshold: 1000 });

      // Validation works
      await expect(combo.insert({})).rejects.toThrow("title required");

      // Insert valid record
      await combo.insert({ _id: "a", title: "Short" });
      await combo.insert({ _id: "b", title: "This is a long title" });

      // Computed field works
      expect((await combo.findOne("a"))?.titleLen).toBe(5);

      // Virtual filter works
      const long = await combo.find({ filter: { "+LONG": true } });
      expect(long.total).toBe(1);
      expect(long.records[0]._id).toBe("b");

      await combo.close();
      await rm(cDir, { recursive: true, force: true });
    });
  });

  describe("metadata injection prevention", () => {
    it("user-supplied _agent does not override system agent", async () => {
      const id = await col.insert(
        { _id: "inject", name: "Alice", _agent: "spoofed" },
        { agent: "real-agent" },
      );
      const ops = col.history(id);
      // System agent should be "real-agent", not "spoofed"
      expect(ops[0].data?._agent).toBe("real-agent");
    });
  });

  describe("concurrent mutations", () => {
    it("parallel inserts all succeed", async () => {
      const promises = [];
      for (let i = 0; i < 20; i++) {
        promises.push(col.insert({ name: `User ${i}` }));
      }
      await Promise.all(promises);
      expect(await col.count()).toBe(20);
    });
  });

  describe("sort", () => {
    beforeEach(async () => {
      await col.insertMany([
        { _id: "1", name: "Charlie", score: 30 },
        { _id: "2", name: "Alice", score: 10 },
        { _id: "3", name: "Bob", score: 20 },
        { _id: "4", score: 5 }, // no name — should sort to end
      ]);
    });

    it("sorts ascending by field", async () => {
      const result = await col.find({ sort: "name" });
      const names = result.records.map((r) => r.name);
      expect(names.slice(0, 3)).toEqual(["Alice", "Bob", "Charlie"]);
    });

    it("sorts descending with - prefix", async () => {
      const result = await col.find({ sort: "-score" });
      expect(result.records.map((r) => r.score)).toEqual([30, 20, 10, 5]);
    });

    it("null/undefined values sort to end", async () => {
      const result = await col.find({ sort: "name" });
      // Record with no name should be last
      expect(result.records[result.records.length - 1]._id).toBe("4");
    });
  });

  describe("error paths", () => {
    beforeEach(async () => {
      await col.insert({ _id: "e1", name: "Alice", score: 10, tags: ["a"] });
    });

    it("$inc on non-numeric field throws", async () => {
      await expect(col.update({ _id: "e1" }, { $inc: { name: 1 } })).rejects.toThrow("not a number");
    });

    it("$push on non-array field throws", async () => {
      await expect(col.update({ _id: "e1" }, { $push: { name: "x" } })).rejects.toThrow("not an array");
    });

    it("duplicate _id insert overwrites", async () => {
      await col.insert({ _id: "e1", name: "Updated" });
      expect((await col.findOne("e1"))?.name).toBe("Updated");
      expect((await col.findOne("e1"))?._version).toBe(2);
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
      expect(await col2.count()).toBe(2);
      expect((await col2.findOne("a"))?.name).toBe("Alice");
      await col2.close();
    });
  });

  describe("upsertMany", () => {
    it("inserts multiple new records atomically", async () => {
      const results = await col.upsertMany([
        { _id: "u1", name: "Alice" },
        { _id: "u2", name: "Bob" },
      ]);
      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({ id: "u1", action: "inserted" });
      expect(results[1]).toEqual({ id: "u2", action: "inserted" });
    });

    it("updates existing records", async () => {
      await col.insert({ _id: "u1", name: "Alice", v: 1 });
      const results = await col.upsertMany([
        { _id: "u1", name: "Alice Updated", v: 2 },
        { _id: "u2", name: "Bob", v: 1 },
      ]);
      expect(results[0].action).toBe("updated");
      expect(results[1].action).toBe("inserted");
      expect((await col.findOne("u1"))?.v).toBe(2);
    });

    it("requires _id on each doc", async () => {
      await expect(col.upsertMany([{ name: "no id" }])).rejects.toThrow("_id");
    });
  });

  describe("$text in find()", () => {
    it("combines text search with attribute filter", async () => {
      const textStore = new Store<Record<string, unknown>>();
      const textCol = new Collection("text-test", textStore, { textSearch: true });
      const textDir = tmpDir + "-text";
      await textCol.open(textDir, { checkpointThreshold: 1000 });

      await textCol.insert({ _id: "a", title: "Authentication system", status: "open" });
      await textCol.insert({ _id: "b", title: "Payment gateway", status: "open" });
      await textCol.insert({ _id: "c", title: "Authentication bug", status: "closed" });

      const result = await textCol.find({ filter: { $text: "authentication", status: "open" } });
      expect(result.records).toHaveLength(1);
      expect(result.records[0]._id).toBe("a");

      await textCol.close();
    });

    it("$text throws without textSearch enabled", async () => {
      await expect(col.find({ filter: { $text: "test" } })).rejects.toThrow("Text search not enabled");
    });
  });
});
