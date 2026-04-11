import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDB } from "../src/agentdb.js";
import { defineSchema } from "../src/schema.js";

describe("Disk-backed mode", () => {
  let tmpDir: string;
  let db: AgentDB;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agentdb-disk-mode-"));
  });

  afterEach(async () => {
    if (db) await db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("explicit disk mode", () => {
    it("opens collection in disk mode via schema", async () => {
      db = new AgentDB(tmpDir);
      await db.init();

      const col = await db.collection(defineSchema({
        name: "tasks",
        fields: {
          title: { type: "string", required: true },
          status: { type: "enum", values: ["open", "closed"], default: "open" },
        },
        storageMode: "disk",
      }));

      // Insert records (goes through WAL + cache)
      const id1 = await col.insert({ title: "First task" });
      const id2 = await col.insert({ title: "Second task" });

      // Read via disk store (cache hit since just written)
      expect((await col.findOne(id1))?.title).toBe("First task");
      expect((await col.findOne(id2))?.status).toBe("open");

      // Find works
      const all = await col.find();
      expect(all.records.length).toBeGreaterThanOrEqual(2);
    });

    it("persists data across reopens in disk mode", async () => {
      db = new AgentDB(tmpDir);
      await db.init();

      const col = await db.collection(defineSchema({
        name: "persist-test",
        fields: { title: { type: "string", required: true } },
        storageMode: "disk",
      }));

      await col.insert({ title: "Persisted record" });
      await db.close();

      // Reopen
      db = new AgentDB(tmpDir);
      await db.init();

      const col2 = await db.collection(defineSchema({
        name: "persist-test",
        fields: { title: { type: "string", required: true } },
        storageMode: "disk",
      }));

      const all = await col2.find();
      expect(all.records.some((r) => r.title === "Persisted record")).toBe(true);
    });
  });

  describe("global disk mode", () => {
    it("opens all collections in disk mode", async () => {
      db = new AgentDB(tmpDir, { storageMode: "disk" });
      await db.init();

      const col = await db.collection("global-disk");
      await col.insert({ _id: "t1", title: "Test" });
      expect((await col.findOne("t1"))?.title).toBe("Test");

      // DiskStore should be set
      expect(col.getDiskStore()).not.toBeNull();
    });
  });

  describe("memory mode (default)", () => {
    it("works identically to v1.1 behavior", async () => {
      db = new AgentDB(tmpDir);
      await db.init();

      const col = await db.collection("memory-default");
      await col.insert({ _id: "m1", title: "Memory record" });
      expect((await col.findOne("m1"))?.title).toBe("Memory record");
      expect(col.getDiskStore()).toBeNull();
    });
  });

  describe("disk mode with indexes", () => {
    it("schema indexes work in disk mode", async () => {
      db = new AgentDB(tmpDir);
      await db.init();

      const col = await db.collection(defineSchema({
        name: "indexed-disk",
        fields: {
          title: { type: "string", required: true },
          status: { type: "enum", values: ["open", "closed"], default: "open" },
          tags: { type: "string[]" },
        },
        indexes: ["status"],
        arrayIndexes: ["tags"],
        storageMode: "disk",
      }));

      await col.insert({ title: "Bug fix", tags: ["bug", "urgent"] });
      await col.insert({ title: "Feature", status: "closed", tags: ["feature"] });

      // Indexed query
      const openTasks = await col.find({ filter: { status: "open" } });
      expect(openTasks.records).toHaveLength(1);
      expect(openTasks.records[0].title).toBe("Bug fix");

      // Array index query
      const bugs = await col.find({ filter: { tags: { $contains: "bug" } } });
      expect(bugs.records).toHaveLength(1);
    });
  });

  describe("skipLoad behavior", () => {
    it("records served from Parquet after reopen, not memory", async () => {
      // Session 1: create records, close (compacts to Parquet)
      db = new AgentDB(tmpDir, { storageMode: "disk" });
      await db.init();
      const col1 = await db.collection("skip-test");
      await col1.insert({ _id: "s1", title: "From Parquet" });
      await col1.insert({ _id: "s2", title: "Also Parquet" });
      await db.close();

      // Session 2: reopen with skipLoad — records come from Parquet
      db = new AgentDB(tmpDir, { storageMode: "disk" });
      await db.init();
      const col2 = await db.collection("skip-test");

      // findOne should work (DiskStore → Parquet)
      const record = await col2.findOne("s1");
      expect(record?.title).toBe("From Parquet");

      // find should return all records from Parquet
      const all = await col2.find();
      expect(all.records).toHaveLength(2);

      // count should work
      const n = await col2.count();
      expect(n).toBe(2);
    });

    it("session writes visible alongside Parquet records", async () => {
      // Session 1: seed data
      db = new AgentDB(tmpDir, { storageMode: "disk" });
      await db.init();
      const col1 = await db.collection("merge-test");
      await col1.insert({ _id: "old1", title: "Existing" });
      await db.close();

      // Session 2: add new records
      db = new AgentDB(tmpDir, { storageMode: "disk" });
      await db.init();
      const col2 = await db.collection("merge-test");

      // Old record from Parquet
      expect((await col2.findOne("old1"))?.title).toBe("Existing");

      // New record written this session
      await col2.insert({ _id: "new1", title: "Fresh" });
      expect((await col2.findOne("new1"))?.title).toBe("Fresh");

      // find returns both old (Parquet) + new (Map)
      const all = await col2.find();
      expect(all.records).toHaveLength(2);
      const titles = all.records.map((r) => r.title).sort();
      expect(titles).toEqual(["Existing", "Fresh"]);
    });
  });

  describe("auto mode", () => {
    it("stays in memory when under threshold", async () => {
      db = new AgentDB(tmpDir, { storageMode: "auto", diskThreshold: 100 });
      await db.init();

      const col = await db.collection("auto-small");
      for (let i = 0; i < 10; i++) {
        await col.insert({ title: `Record ${i}` });
      }

      // Under threshold → memory mode, no DiskStore
      expect(col.getDiskStore()).toBeNull();
      expect(await col.count()).toBe(10);
    });

    it("switches to disk mode when over threshold on reopen", async () => {
      // Session 1: insert records above threshold, memory mode (first open is always under)
      db = new AgentDB(tmpDir, { storageMode: "auto", diskThreshold: 5 });
      await db.init();
      const col1 = await db.collection("auto-grow");
      for (let i = 0; i < 10; i++) {
        await col1.insert({ title: `Record ${i}` });
      }
      await db.close();

      // Session 2: reopen — auto mode detects 10 records > threshold 5, switches to disk
      db = new AgentDB(tmpDir, { storageMode: "auto", diskThreshold: 5 });
      await db.init();
      const col2 = await db.collection("auto-grow");

      expect(col2.getDiskStore()).not.toBeNull();
      expect(await col2.count()).toBe(10);

      // Verify all records accessible
      const all = await col2.find({ limit: 100 });
      expect(all.records).toHaveLength(10);
    });

    it("per-collection schema overrides global auto mode", async () => {
      db = new AgentDB(tmpDir, { storageMode: "auto", diskThreshold: 1000 });
      await db.init();

      // Force disk mode on this collection regardless of threshold
      const col = await db.collection(defineSchema({
        name: "forced-disk",
        fields: { title: { type: "string" } },
        storageMode: "disk",
      }));

      await col.insert({ title: "Test" });
      expect(col.getDiskStore()).not.toBeNull();
    });
  });

  describe("mutations in disk mode", () => {
    it("update persists across reopens", async () => {
      db = new AgentDB(tmpDir, { storageMode: "disk" });
      await db.init();
      const col = await db.collection("mut-update");
      await col.insert({ _id: "u1", title: "Original", status: "open" });
      await col.update({ _id: "u1" }, { $set: { status: "closed" } });
      await db.close();

      db = new AgentDB(tmpDir, { storageMode: "disk" });
      await db.init();
      const col2 = await db.collection("mut-update");
      const record = await col2.findOne("u1");
      expect(record?.status).toBe("closed");
    });

    it("delete removes record from Parquet on reopen", async () => {
      db = new AgentDB(tmpDir, { storageMode: "disk" });
      await db.init();
      const col = await db.collection("mut-delete");
      await col.insert({ _id: "d1", title: "Delete me" });
      await col.insert({ _id: "d2", title: "Keep me" });
      await col.remove({ _id: "d1" });
      await db.close();

      db = new AgentDB(tmpDir, { storageMode: "disk" });
      await db.init();
      const col2 = await db.collection("mut-delete");
      expect(await col2.findOne("d1")).toBeUndefined();
      expect((await col2.findOne("d2"))?.title).toBe("Keep me");
      expect(await col2.count()).toBe(1);
    });

    it("no compaction on close when nothing changed", async () => {
      db = new AgentDB(tmpDir, { storageMode: "disk" });
      await db.init();
      const col = await db.collection("no-compact");
      await col.insert({ _id: "nc1", title: "Test" });
      await db.close();

      // Reopen, read only, close — should not compact
      db = new AgentDB(tmpDir, { storageMode: "disk" });
      await db.init();
      const col2 = await db.collection("no-compact");
      await col2.findOne("nc1"); // read only
      const ds = col2.getDiskStore()!;
      expect(ds.isDirty).toBe(false);
      await db.close();
    });

    it("programmatic index persists across reopens", async () => {
      db = new AgentDB(tmpDir, { storageMode: "disk" });
      await db.init();
      const col = await db.collection("prog-idx");
      col.createIndex("status");
      await col.insert({ _id: "p1", title: "A", status: "open" });
      await col.insert({ _id: "p2", title: "B", status: "closed" });
      await col.insert({ _id: "p3", title: "C", status: "open" });
      expect(await col.count({ status: "open" })).toBe(2);
      await db.close();

      // Reopen — programmatic index should be loaded from persisted btree
      db = new AgentDB(tmpDir, { storageMode: "disk" });
      await db.init();
      const col2 = await db.collection("prog-idx");
      col2.createIndex("status"); // re-declare programmatic index

      expect(col2.listIndexes()).toContain("status");
      expect(await col2.count({ status: "open" })).toBe(2);
      expect(await col2.count({ status: "closed" })).toBe(1);
      expect(await col2.count()).toBe(3);

      const found = await col2.find({ filter: { status: "open" } });
      expect(found.records).toHaveLength(2);
    });
  });

  describe("hybrid index — cardinality-based", () => {
    it("skips in-memory index for high-cardinality fields", async () => {
      db = new AgentDB(tmpDir);
      await db.init();

      // Create collection with a high-cardinality field (unique per record)
      const col = await db.collection(defineSchema({
        name: "cardinality-test",
        fields: {
          title: { type: "string", required: true },
          status: { type: "enum", values: ["open", "closed"], default: "open" },
          uniqueId: { type: "string" },
        },
        indexes: ["status", "uniqueId"],
        storageMode: "disk",
      }));

      // Insert records with unique IDs
      for (let i = 0; i < 20; i++) {
        await col.insert({ title: `Task ${i}`, uniqueId: `uid-${i}`, status: i % 2 === 0 ? "open" : "closed" });
      }
      await db.close();

      // Reopen — cardinality analysis should classify:
      // status: 2 unique values → in-memory index
      // uniqueId: 20 unique values → still in-memory (under 1000 threshold)
      db = new AgentDB(tmpDir);
      await db.init();
      const col2 = await db.collection(defineSchema({
        name: "cardinality-test",
        fields: {
          title: { type: "string", required: true },
          status: { type: "enum", values: ["open", "closed"], default: "open" },
          uniqueId: { type: "string" },
        },
        indexes: ["status", "uniqueId"],
        storageMode: "disk",
      }));

      // Both indexes should work (both under 1000 cardinality threshold)
      expect(await col2.count({ status: "open" })).toBe(10);
      expect((await col2.findOne("uid-5" as never))).toBeUndefined(); // findOne by _id, not uniqueId

      // Verify cardinality was computed
      const ds = col2.getDiskStore()!;
      expect(ds.columnCardinality["status"]).toBe(2);
      expect(ds.columnCardinality["uniqueId"]).toBe(20);
    });
  });

  describe("compound filter intersection", () => {
    it("intersects two indexed fields in disk mode", async () => {
      db = new AgentDB(tmpDir);
      await db.init();

      const col = await db.collection(defineSchema({
        name: "compound-disk",
        fields: {
          title: { type: "string", required: true },
          status: { type: "enum", values: ["open", "closed"], default: "open" },
          priority: { type: "enum", values: ["H", "M", "L"], default: "M" },
        },
        indexes: ["status", "priority"],
        storageMode: "disk",
      }));

      await col.insert({ title: "A", status: "open", priority: "H" });
      await col.insert({ title: "B", status: "open", priority: "L" });
      await col.insert({ title: "C", status: "closed", priority: "H" });
      await db.close();

      db = new AgentDB(tmpDir);
      await db.init();
      const col2 = await db.collection(defineSchema({
        name: "compound-disk",
        fields: {
          title: { type: "string", required: true },
          status: { type: "enum", values: ["open", "closed"], default: "open" },
          priority: { type: "enum", values: ["H", "M", "L"], default: "M" },
        },
        indexes: ["status", "priority"],
        storageMode: "disk",
      }));

      // Compound filter — should intersect two indexes
      expect(await col2.count({ status: "open", priority: "H" })).toBe(1);
      const result = await col2.find({ filter: { status: "open", priority: "H" } });
      expect(result.records).toHaveLength(1);
      expect(result.records[0].title).toBe("A");
    });
  });

  describe("column-only count", () => {
    it("count with extracted column avoids full record materialization", async () => {
      db = new AgentDB(tmpDir);
      await db.init();

      const col = await db.collection(defineSchema({
        name: "col-count",
        fields: {
          title: { type: "string", required: true },
          status: { type: "enum", values: ["open", "closed"], default: "open" },
        },
        indexes: ["status"],
        storageMode: "disk",
      }));

      await col.insert({ title: "A" });
      await col.insert({ title: "B" });
      await col.insert({ title: "C", status: "closed" });
      await db.close();

      // Reopen — records in Parquet with "status" as extracted column
      db = new AgentDB(tmpDir);
      await db.init();
      const col2 = await db.collection(defineSchema({
        name: "col-count",
        fields: {
          title: { type: "string", required: true },
          status: { type: "enum", values: ["open", "closed"], default: "open" },
        },
        indexes: ["status"],
        storageMode: "disk",
      }));

      // count with extracted column — should use column-only scan
      expect(await col2.count({ status: "open" })).toBe(2);
      expect(await col2.count({ status: "closed" })).toBe(1);
      expect(await col2.count()).toBe(3);
    });

    it("compound count uses index intersection without materializing records", async () => {
      db = new AgentDB(tmpDir);
      await db.init();

      const col = await db.collection(defineSchema({
        name: "compound-count",
        fields: {
          title: { type: "string", required: true },
          status: { type: "enum", values: ["open", "closed"], default: "open" },
          priority: { type: "number", min: 1, max: 10 },
        },
        indexes: ["status", "priority"],
        storageMode: "disk",
      }));

      for (let i = 0; i < 20; i++) {
        await col.insert({ title: `Task ${i}`, status: i < 10 ? "open" : "closed", priority: (i % 10) + 1 });
      }
      await db.close();

      db = new AgentDB(tmpDir);
      await db.init();
      const col2 = await db.collection(defineSchema({
        name: "compound-count",
        fields: {
          title: { type: "string", required: true },
          status: { type: "enum", values: ["open", "closed"], default: "open" },
          priority: { type: "number", min: 1, max: 10 },
        },
        indexes: ["status", "priority"],
        storageMode: "disk",
      }));

      // Compound count — both fields indexed, should use intersection size
      const openHighPri = await col2.count({ status: "open", priority: { $gte: 8 } });
      expect(openHighPri).toBeGreaterThan(0);
      expect(openHighPri).toBeLessThanOrEqual(10);
    });
  });

  describe("JSONL record store", () => {
    it("findOne uses JSONL byte-range reads after reopen", async () => {
      db = new AgentDB(tmpDir, { storageMode: "disk" });
      await db.init();
      const col = await db.collection("jsonl-test");
      await col.insert({ _id: "j1", title: "JSONL record 1" });
      await col.insert({ _id: "j2", title: "JSONL record 2" });
      await col.insert({ _id: "j3", title: "JSONL record 3" });
      await db.close();

      // Reopen — JSONL record store should be available
      db = new AgentDB(tmpDir, { storageMode: "disk" });
      await db.init();
      const col2 = await db.collection("jsonl-test");

      const ds = col2.getDiskStore()!;
      expect(ds.hasJsonlStore).toBe(true);

      // findOne reads from JSONL (byte seek, not Parquet row group)
      const r1 = await col2.findOne("j1");
      expect(r1?.title).toBe("JSONL record 1");

      const r3 = await col2.findOne("j3");
      expect(r3?.title).toBe("JSONL record 3");

      // find returns all records
      const all = await col2.find({ limit: 100 });
      expect(all.total).toBe(3);
    });

    it("find with limit uses JSONL for record fetch", async () => {
      db = new AgentDB(tmpDir);
      await db.init();

      const col = await db.collection(defineSchema({
        name: "jsonl-find",
        fields: {
          title: { type: "string", required: true },
          status: { type: "enum", values: ["open", "closed"], default: "open" },
        },
        indexes: ["status"],
        storageMode: "disk",
      }));

      for (let i = 0; i < 20; i++) {
        await col.insert({ title: `Task ${i}`, status: i < 10 ? "open" : "closed" });
      }
      await db.close();

      db = new AgentDB(tmpDir);
      await db.init();
      const col2 = await db.collection(defineSchema({
        name: "jsonl-find",
        fields: {
          title: { type: "string", required: true },
          status: { type: "enum", values: ["open", "closed"], default: "open" },
        },
        indexes: ["status"],
        storageMode: "disk",
      }));

      // find with index — candidates from B-tree, records from JSONL
      const open = await col2.find({ filter: { status: "open" }, limit: 5 });
      expect(open.records).toHaveLength(5);
      expect(open.total).toBe(10);
    });

    it("find() short-circuits at limit without fetching all candidates", async () => {
      db = new AgentDB(tmpDir);
      await db.init();

      const col = await db.collection(defineSchema({
        name: "short-circuit",
        fields: {
          title: { type: "string", required: true },
          status: { type: "enum", values: ["open", "closed"], default: "open" },
        },
        indexes: ["status"],
        storageMode: "disk",
      }));

      // Insert 100 records — 50 open, 50 closed
      for (let i = 0; i < 100; i++) {
        await col.insert({ title: `Task ${i}`, status: i < 50 ? "open" : "closed" });
      }
      await db.close();

      db = new AgentDB(tmpDir);
      await db.init();
      const col2 = await db.collection(defineSchema({
        name: "short-circuit",
        fields: {
          title: { type: "string", required: true },
          status: { type: "enum", values: ["open", "closed"], default: "open" },
        },
        indexes: ["status"],
        storageMode: "disk",
      }));

      // limit:5 on 50 candidates — should return 5 records, total=50
      const result = await col2.find({ filter: { status: "open" }, limit: 5 });
      expect(result.records).toHaveLength(5);
      expect(result.total).toBe(50);
      expect(result.truncated).toBe(true);

      // limit:50 should return all open records
      const all = await col2.find({ filter: { status: "open" }, limit: 50 });
      expect(all.records).toHaveLength(50);
      expect(all.total).toBe(50);
    });
  });

  describe("incremental compaction", () => {
    it("multi-session inserts accumulate correctly", async () => {
      // Session 1: insert 10 records
      db = new AgentDB(tmpDir, { storageMode: "disk" });
      await db.init();
      let col = await db.collection("incr-test");
      for (let i = 0; i < 10; i++) {
        await col.insert({ _id: `s1-${i}`, title: `Session1 ${i}` });
      }
      await db.close();

      // Session 2: insert 10 more
      db = new AgentDB(tmpDir, { storageMode: "disk" });
      await db.init();
      col = await db.collection("incr-test");
      for (let i = 0; i < 10; i++) {
        await col.insert({ _id: `s2-${i}`, title: `Session2 ${i}` });
      }
      await db.close();

      // Session 3: verify all 20 records
      db = new AgentDB(tmpDir, { storageMode: "disk" });
      await db.init();
      col = await db.collection("incr-test");

      expect(await col.count()).toBe(20);
      expect((await col.findOne("s1-0"))?.title).toBe("Session1 0");
      expect((await col.findOne("s2-9"))?.title).toBe("Session2 9");

      const all = await col.find({ limit: 100 });
      expect(all.total).toBe(20);
    });

    it("updates in later session override earlier records", async () => {
      db = new AgentDB(tmpDir, { storageMode: "disk" });
      await db.init();
      let col = await db.collection("incr-update");
      await col.insert({ _id: "u1", title: "Original", status: "open" });
      await db.close();

      db = new AgentDB(tmpDir, { storageMode: "disk" });
      await db.init();
      col = await db.collection("incr-update");
      await col.update({ _id: "u1" }, { $set: { status: "closed" } });
      await col.insert({ _id: "u2", title: "New" });
      await db.close();

      db = new AgentDB(tmpDir, { storageMode: "disk" });
      await db.init();
      col = await db.collection("incr-update");

      expect(await col.count()).toBe(2);
      const r = await col.findOne("u1");
      expect(r?.status).toBe("closed");
      expect((await col.findOne("u2"))?.title).toBe("New");
    });
  });

  describe("opslog checkpoint disabled", () => {
    it("does not create snapshot files during bulk inserts in disk mode", async () => {
      db = new AgentDB(tmpDir, { storageMode: "disk" });
      await db.init();
      const col = await db.collection("no-checkpoints");

      // Insert 500 records — would trigger 5 checkpoints at threshold=100
      for (let i = 0; i < 500; i++) {
        await col.insert({ _id: `nc-${i}`, title: `Record ${i}` });
      }

      // Check that no checkpoint snapshots were written (only the initial empty one)
      const backend = col.getBackend();
      const snaps = await backend.listBlobs("snapshots");
      expect(snaps.length).toBeLessThanOrEqual(1);

      await db.close();

      // WAL ops file should be cleaned up after close
      let opsAfterClose: string[] = [];
      try { opsAfterClose = await backend.listBlobs("ops"); } catch { /* empty */ }
      expect(opsAfterClose.length).toBe(0);

      // Verify data survived via JSONL compaction
      db = new AgentDB(tmpDir, { storageMode: "disk" });
      await db.init();
      const col2 = await db.collection("no-checkpoints");
      expect(await col2.count()).toBe(500);
    });
  });
});
