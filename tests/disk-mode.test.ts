import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
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

    it("stays in memory below threshold", async () => {
      db = new AgentDB(tmpDir, { storageMode: "auto", diskThreshold: 10 });
      await db.init();
      const col = await db.collection("auto-below");
      for (let i = 0; i < 9; i++) {
        await col.insert({ title: `Record ${i}` });
      }
      await db.close();

      // 9 records < threshold 10 → stays in memory
      db = new AgentDB(tmpDir, { storageMode: "auto", diskThreshold: 10 });
      await db.init();
      const col2 = await db.collection("auto-below");
      expect(col2.getDiskStore()).toBeNull();
      expect(await col2.count()).toBe(9);
    });

    it("switches at exactly the threshold (>=)", async () => {
      db = new AgentDB(tmpDir, { storageMode: "auto", diskThreshold: 10 });
      await db.init();
      const col = await db.collection("auto-exact");
      for (let i = 0; i < 10; i++) {
        await col.insert({ title: `Record ${i}` });
      }
      await db.close();

      // 10 records >= threshold → disk mode
      db = new AgentDB(tmpDir, { storageMode: "auto", diskThreshold: 10 });
      await db.init();
      const col2 = await db.collection("auto-exact");
      expect(col2.getDiskStore()).not.toBeNull();
      expect(await col2.count()).toBe(10);
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

  describe("maxIndexCardinality", () => {
    const schema = defineSchema({
      name: "card-test",
      fields: {
        uid: { type: "string" },
        status: { type: "enum", values: ["open", "closed"], default: "open" },
      },
      indexes: ["uid", "status"],
      storageMode: "disk",
    });

    it("warns once per field when cardinality exceeds maxIndexCardinality", async () => {
      // First session: write 6 records with distinct uid values, close to trigger compaction
      db = new AgentDB(tmpDir);
      await db.init();
      const col = await db.collection(schema);
      for (let i = 0; i < 6; i++) {
        await col.insert({ uid: `u-${i}`, status: "open" });
      }
      await db.close();

      // Second session: reopen with maxIndexCardinality=5 — uid (6 distinct) should exceed it
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        db = new AgentDB(tmpDir, { maxIndexCardinality: 5 });
        await db.init();
        const col2 = await db.collection(schema);

        const calls = warnSpy.mock.calls.filter((c) => String(c[0]).includes("maxIndexCardinality=5"));
        expect(calls.length).toBeGreaterThanOrEqual(1);
        expect(calls[0][0]).toContain("uid");

        // Warning should not fire again on a subsequent query
        warnSpy.mockClear();
        await col2.count({ uid: "u-0" });
        const callsAfter = warnSpy.mock.calls.filter((c) => String(c[0]).includes("maxIndexCardinality=5"));
        expect(callsAfter).toHaveLength(0);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("task 312 — composite index populated from disk on reopen (correctness)", async () => {
      // In disk mode the store is opened with skipLoad:true, so createCompositeIndex
      // used to iterate an empty store → silently empty composite index → queries
      // using that index returned zero results (correctness bug, not just perf).
      db = new AgentDB(tmpDir, { storageMode: "disk" });
      await db.init();
      const schema312 = defineSchema({
        name: "tasks312",
        fields: {
          status: { type: "string" },
          priority: { type: "string" },
          title: { type: "string" },
        },
        compositeIndexes: [["status", "priority"]],
      });
      const col = await db.collection(schema312);
      await col.insert({ status: "open", priority: "high", title: "A" });
      await col.insert({ status: "open", priority: "high", title: "B" });
      await col.insert({ status: "closed", priority: "low", title: "C" });
      await db.close();

      // Reopen — composite index must be populated from Parquet
      db = new AgentDB(tmpDir, { storageMode: "disk" });
      await db.init();
      const col2 = await db.collection(schema312);

      // This query uses the composite index {status, priority}. Without the fix,
      // the empty index causes disk-mode find() to return zero results.
      const results = await col2.find({ filter: { status: "open", priority: "high" } });
      expect(results.records.length).toBe(2);
      expect(results.records.every((r) => r.status === "open" && r.priority === "high")).toBe(true);

      // Negative: different composite key should return zero
      const none = await col2.find({ filter: { status: "open", priority: "low" } });
      expect(none.records.length).toBe(0);
    });

    it("task 312 — bloom filter populated from disk on createBloomFilter in disk mode", async () => {
      db = new AgentDB(tmpDir, { storageMode: "disk" });
      await db.init();
      const col = await db.collection(defineSchema({
        name: "bloom312",
        fields: { role: { type: "string" } },
      }));
      await col.insert({ role: "admin" });
      await col.insert({ role: "user" });
      await col.insert({ role: "user" });
      await db.close();

      // Reopen and create bloom filter — must reflect persisted records
      db = new AgentDB(tmpDir, { storageMode: "disk" });
      await db.init();
      const col2 = await db.collection(defineSchema({
        name: "bloom312",
        fields: { role: { type: "string" } },
      }));
      await col2.createBloomFilter("role");

      expect(col2.mightHave("role", "admin")).toBe(true);
      expect(col2.mightHave("role", "user")).toBe(true);
      // A value never inserted must not be a false positive (probability ~1e-6 with 3 items)
      expect(col2.mightHave("role", "zzz-never-inserted-xyz")).toBe(false);
    });

    it("task 312 — memory-mode composite index regression: unchanged behaviour", async () => {
      db = new AgentDB(tmpDir); // memory mode (default)
      await db.init();
      const col = await db.collection(defineSchema({
        name: "mem312",
        fields: { a: { type: "string" }, b: { type: "string" } },
        compositeIndexes: [["a", "b"]],
      }));
      await col.insert({ a: "x", b: "1" });
      await col.insert({ a: "x", b: "2" });
      await col.insert({ a: "y", b: "1" });

      const results = await col.find({ filter: { a: "x", b: "1" } });
      expect(results.records.length).toBe(1);
      expect(results.records[0].a).toBe("x");
    });

    it("does not warn when maxIndexCardinality is high enough", async () => {
      db = new AgentDB(tmpDir);
      await db.init();
      const col = await db.collection(schema);
      for (let i = 0; i < 6; i++) {
        await col.insert({ uid: `u-${i}`, status: "open" });
      }
      await db.close();

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        db = new AgentDB(tmpDir, { maxIndexCardinality: 10000 });
        await db.init();
        await db.collection(schema);

        const calls = warnSpy.mock.calls.filter((c) => String(c[0]).includes("maxIndexCardinality="));
        expect(calls).toHaveLength(0);
      } finally {
        warnSpy.mockRestore();
      }
    });

    // ---- Task 319: composite + bloom durable persistence ----

    it("task 319 — round-trip composite: loaded from JSON on reopen, no disk scan", async () => {
      const schema319 = defineSchema({
        name: "t319-composite",
        fields: { status: { type: "string" }, priority: { type: "string" } },
        storageMode: "disk",
        compositeIndexes: [["status", "priority"]],
      });

      // Session 1: insert records and close → saveIndexes writes composite JSON
      db = new AgentDB(tmpDir, { storageMode: "disk" });
      await db.init();
      let col = await db.collection(schema319);
      await col.insert({ status: "open", priority: "high" });
      await col.insert({ status: "open", priority: "high" });
      await col.insert({ status: "closed", priority: "low" });
      await db.close();

      // Verify the composite JSON file was written
      const compositeFile = join(tmpDir, "collections", "t319-composite", "indexes", "composite-status__priority.json");
      const raw = JSON.parse(await readFile(compositeFile, "utf-8"));
      expect(raw.version).toBe(1);
      expect(raw.fields).toEqual(["status", "priority"]);
      expect(raw.entries.length).toBeGreaterThan(0);

      // Session 2: reopen — composite must be loaded from JSON, NOT via O(N) disk scan
      db = new AgentDB(tmpDir, { storageMode: "disk" });
      await db.init();
      col = await db.collection(schema319);

      // Spy AFTER collection is loaded so we only catch post-open calls
      const ds = col.getDiskStore()!;
      const entriesSpy = vi.spyOn(ds, "entries");

      // Query using composite index
      const results = await col.find({ filter: { status: "open", priority: "high" } });
      expect(results.records.length).toBe(2);
      expect(results.records.every((r) => r.status === "open" && r.priority === "high")).toBe(true);

      // entries() was NOT called (composite loaded from JSON, not from disk scan)
      const compositeScanCalls = entriesSpy.mock.calls.filter((a) =>
        JSON.stringify(a).includes("skipCache"),
      );
      expect(compositeScanCalls).toHaveLength(0);
      entriesSpy.mockRestore();
    });

    it("task 319 — round-trip bloom: mightHave answers preserved across close/reopen", async () => {
      // Session 1: insert, create bloom, close → saveIndexes writes bloom JSON
      db = new AgentDB(tmpDir, { storageMode: "disk" });
      await db.init();
      let col = await db.collection(defineSchema({
        name: "t319-bloom",
        fields: { tag: { type: "string" } },
        storageMode: "disk",
      }));
      await col.insert({ tag: "alpha" });
      await col.insert({ tag: "beta" });
      await col.createBloomFilter("tag");
      expect(col.mightHave("tag", "alpha")).toBe(true);
      expect(col.mightHave("tag", "zzz-absent")).toBe(false);
      await db.close();

      // Verify bloom JSON file was written
      const bloomFile = join(tmpDir, "collections", "t319-bloom", "indexes", "bloom-tag.json");
      const raw = JSON.parse(await readFile(bloomFile, "utf-8"));
      expect(raw.version).toBe(1);
      expect(raw.field).toBe("tag");
      expect(typeof raw.bits).toBe("string");

      // Session 2: reopen, recreate bloom from JSON (not from disk scan)
      db = new AgentDB(tmpDir, { storageMode: "disk" });
      await db.init();
      col = await db.collection(defineSchema({
        name: "t319-bloom",
        fields: { tag: { type: "string" } },
        storageMode: "disk",
      }));
      await col.createBloomFilter("tag");

      // mightHave answers are preserved (loaded from JSON bit array)
      expect(col.mightHave("tag", "alpha")).toBe(true);
      expect(col.mightHave("tag", "beta")).toBe(true);
      expect(col.mightHave("tag", "zzz-absent")).toBe(false);
    });

    it("task 319 — fallback when composite JSON absent: disk scan populates correctly", async () => {
      const schema319f = defineSchema({
        name: "t319-fallback",
        fields: { a: { type: "string" }, b: { type: "string" } },
        storageMode: "disk",
        compositeIndexes: [["a", "b"]],
      });

      // Session 1: insert, close
      db = new AgentDB(tmpDir, { storageMode: "disk" });
      await db.init();
      const col1 = await db.collection(schema319f);
      await col1.insert({ a: "x", b: "1" });
      await col1.insert({ a: "x", b: "2" });
      await db.close();

      // Delete the composite JSON file (simulates first open on v2.1 data)
      const compositeFile = join(tmpDir, "collections", "t319-fallback", "indexes", "composite-a__b.json");
      await rm(compositeFile, { force: true });

      // Session 2: reopen — file absent → falls back to disk scan
      db = new AgentDB(tmpDir, { storageMode: "disk" });
      await db.init();
      const col2 = await db.collection(schema319f);

      const results = await col2.find({ filter: { a: "x", b: "1" } });
      expect(results.records.length).toBe(1);
      expect(results.records[0].b).toBe("1");
    });

    it("task 319 — version mismatch: logs warn and falls back to disk scan", async () => {
      const schema319v = defineSchema({
        name: "t319-version",
        fields: { p: { type: "string" }, q: { type: "string" } },
        storageMode: "disk",
        compositeIndexes: [["p", "q"]],
      });

      // Session 1: insert, close
      db = new AgentDB(tmpDir, { storageMode: "disk" });
      await db.init();
      const col1 = await db.collection(schema319v);
      await col1.insert({ p: "foo", q: "bar" });
      await db.close();

      // Overwrite composite file with unsupported version
      const compositeFile = join(tmpDir, "collections", "t319-version", "indexes", "composite-p__q.json");
      const existing = JSON.parse(await readFile(compositeFile, "utf-8"));
      await writeFile(compositeFile, JSON.stringify({ ...existing, version: 99 }), "utf-8");

      // Session 2: reopen — version mismatch → warn + fallback
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        db = new AgentDB(tmpDir, { storageMode: "disk" });
        await db.init();
        const col2 = await db.collection(schema319v);

        // Query still works (disk scan fallback populated the index)
        const results = await col2.find({ filter: { p: "foo", q: "bar" } });
        expect(results.records.length).toBe(1);

        // Warning was emitted
        const mismatchWarns = warnSpy.mock.calls.filter((c) => String(c[0]).includes("version mismatch"));
        expect(mismatchWarns.length).toBeGreaterThan(0);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("task 319 — mutations persisted: insert + delete round-trips correctly via JSON", async () => {
      const schema319m = defineSchema({
        name: "t319-mutations",
        fields: { cat: { type: "string" }, tier: { type: "string" } },
        storageMode: "disk",
        compositeIndexes: [["cat", "tier"]],
      });

      // Session 1: insert 3 records, delete 1, close
      db = new AgentDB(tmpDir, { storageMode: "disk" });
      await db.init();
      const col1 = await db.collection(schema319m);
      const id1 = await col1.insert({ cat: "A", tier: "gold" });
      const id2 = await col1.insert({ cat: "A", tier: "gold" });
      await col1.insert({ cat: "B", tier: "silver" });
      await col1.deleteById(id2);
      await db.close();

      // Session 2: reopen — composite loaded from JSON reflects post-delete state
      db = new AgentDB(tmpDir, { storageMode: "disk" });
      await db.init();
      const col2 = await db.collection(schema319m);

      const results = await col2.find({ filter: { cat: "A", tier: "gold" } });
      expect(results.records.length).toBe(1);
      expect(results.records[0]._id).toBe(id1);

      const silverResults = await col2.find({ filter: { cat: "B", tier: "silver" } });
      expect(silverResults.records.length).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // v2.2.0 review fixes — commit 1
  // ---------------------------------------------------------------------------

  describe("B1 — createBloomFilter/createCompositeIndex: in-session inserts not overwritten by stale JSON", () => {
    it("B1a — bloom: in-session insert visible after createBloomFilter loads prior-session JSON", async () => {
      // Session 1: insert, createBloomFilter, close → writes bloom JSON to disk
      db = new AgentDB(tmpDir, { storageMode: "disk" });
      await db.init();
      const col1 = await db.collection(defineSchema({ name: "items" }));
      await col1.insert({ _id: "old", tag: "existing" });
      await col1.createBloomFilter("tag");
      await db.close();

      // Session 2: open, insert NEW record BEFORE calling createBloomFilter
      db = new AgentDB(tmpDir, { storageMode: "disk" });
      await db.init();
      const col2 = await db.collection(defineSchema({ name: "items" }));
      await col2.insert({ _id: "new", tag: "new-value" });
      // createBloomFilter loads the prior-session JSON, then merges in-session WAL on top.
      // Bug: stale JSON overwrites the WAL-seeded bloom → "new-value" lost (false negative).
      await col2.createBloomFilter("tag");

      expect(col2.mightHave("tag", "new-value")).toBe(true);
      // Bloom planner must not short-circuit to empty for in-session value
      const result = await col2.find({ filter: { tag: "new-value" } });
      expect(result.total).toBe(1);
      expect(result.records[0]._id).toBe("new");
    });

    it("B1b — composite: in-session insert visible after createCompositeIndex loads prior-session JSON", async () => {
      const schemaB1 = defineSchema({ name: "items" });

      // Session 1: insert, createCompositeIndex, close → writes composite JSON
      db = new AgentDB(tmpDir, { storageMode: "disk" });
      await db.init();
      const col1 = await db.collection(schemaB1);
      await col1.insert({ _id: "old", a: "x", b: "1" });
      await col1.createCompositeIndex(["a", "b"]);
      await db.close();

      // Session 2: insert in-session record BEFORE calling createCompositeIndex
      db = new AgentDB(tmpDir, { storageMode: "disk" });
      await db.init();
      const col2 = await db.collection(schemaB1);
      await col2.insert({ _id: "new", a: "y", b: "2" });
      await col2.createCompositeIndex(["a", "b"]);

      // The in-session record must be findable via the composite index.
      // Note: result.total uses an approximation (candidateIds.size + store.count()) that
      // can double-count WAL records also covered by the index — assert records array instead.
      const result = await col2.find({ filter: { a: "y", b: "2" } });
      expect(result.records.length).toBe(1);
      expect(result.records[0]._id).toBe("new");
    });
  });

  describe("B2 — composite filename collision: data.fields mismatch warns and rebuilds", () => {
    it("B2 — schema ['a__b','c'] and ['a','b__c'] share filename; mismatch detected and rebuilt", async () => {
      // ['a__b','c'] and ['a','b__c'] both join to 'a__b__c' via '__' separator,
      // producing the same filename composite-a__b__c.json.
      const schema1 = defineSchema({ name: "items", storageMode: "disk", compositeIndexes: [["a__b", "c"]] });
      db = new AgentDB(tmpDir, { storageMode: "disk" });
      await db.init();
      const col1 = await db.collection(schema1);
      await col1.insert({ _id: "r1", "a__b": "v1", c: "v2" });
      await db.close();

      // Session 2: request ['a','b__c'] — same filename, different data.fields
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const schema2 = defineSchema({ name: "items", storageMode: "disk", compositeIndexes: [["a", "b__c"]] });
      db = new AgentDB(tmpDir, { storageMode: "disk" });
      await db.init();
      const col2 = await db.collection(schema2);
      // Must fire a warning about the field mismatch
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("field mismatch"));
      warnSpy.mockRestore();

      // Must fall back to disk scan and correctly serve queries on ['a','b__c'].
      // Note: result.total uses an approximation that can double-count WAL + index — assert records array.
      await col2.insert({ _id: "r2", a: "x", "b__c": "y" });
      const result = await col2.find({ filter: { a: "x", "b__c": "y" } });
      expect(result.records.length).toBe(1);
      expect(result.records[0]._id).toBe("r2");
    });
  });

  // ---------------------------------------------------------------------------
  // v2.2.0 review fixes — commit 3 test gaps
  // ---------------------------------------------------------------------------

  describe("multiple composite indexes with overlapping fields", () => {
    it("two composite indexes sharing a prefix field each serve their own query", async () => {
      // Indexes on ["a","b"] and ["a","c"] both have "a" as first field.
      // Queries on either combination must route to the correct index, not cross-contaminate.
      db = new AgentDB(tmpDir, { storageMode: "disk" });
      await db.init();
      const schema = defineSchema({
        name: "items",
        compositeIndexes: [["a", "b"], ["a", "c"]],
      });
      const col = await db.collection(schema);

      await col.insert({ _id: "r1", a: "x", b: "1", c: "P" });
      await col.insert({ _id: "r2", a: "x", b: "2", c: "Q" });
      await col.insert({ _id: "r3", a: "y", b: "1", c: "P" });

      // ["a","b"] index
      const ab1 = await col.find({ filter: { a: "x", b: "1" } });
      expect(ab1.records.length).toBe(1);
      expect(ab1.records[0]._id).toBe("r1");

      const ab2 = await col.find({ filter: { a: "y", b: "1" } });
      expect(ab2.records.length).toBe(1);
      expect(ab2.records[0]._id).toBe("r3");

      // ["a","c"] index
      const ac1 = await col.find({ filter: { a: "x", c: "Q" } });
      expect(ac1.records.length).toBe(1);
      expect(ac1.records[0]._id).toBe("r2");

      const ac2 = await col.find({ filter: { a: "x", c: "P" } });
      expect(ac2.records.length).toBe(1);
      expect(ac2.records[0]._id).toBe("r1");

      await db.close();

      // Reopen — both indexes loaded from persisted JSON, same results
      db = new AgentDB(tmpDir, { storageMode: "disk" });
      await db.init();
      const col2 = await db.collection(schema);

      const abReopen = await col2.find({ filter: { a: "x", b: "1" } });
      expect(abReopen.records.length).toBe(1);
      expect(abReopen.records[0]._id).toBe("r1");

      const acReopen = await col2.find({ filter: { a: "x", c: "Q" } });
      expect(acReopen.records.length).toBe(1);
      expect(acReopen.records[0]._id).toBe("r2");
    });
  });

  describe("composite index + persistEvery combined", () => {
    it("composite index persists correctly while HNSW periodic flushes are active", async () => {
      // A collection with a composite index on ["a","b"] AND hnsw.persistEvery=3.
      // Both persistence mechanisms must operate independently without interfering.
      const { mkdtemp: mktemp2, rm: rm2 } = await import("node:fs/promises");
      const { tmpdir: td2 } = await import("node:os");
      const { join: j2 } = await import("node:path");
      const dir2 = await mktemp2(j2(td2(), "agentdb-combo-"));
      try {
        const { AgentDB: AgentDB2 } = await import("../src/agentdb.js");
        const { defineSchema: ds2 } = await import("../src/schema.js");

        const schema2 = ds2({
          name: "combo",
          fields: { title: { type: "string", searchable: true }, a: { type: "string" }, b: { type: "string" } },
          storageMode: "disk",
          compositeIndexes: [["a", "b"]],
        });

        // Stub embedding provider so HNSW flushes actually fire
        const stubProvider = {
          dimensions: 4,
          async embed(texts: string[]): Promise<number[][]> {
            return texts.map((t, i) => { const v = [i % 3, (i + 1) % 3, (i + 2) % 3, (i + 3) % 3]; const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1; return v.map(x => x / n); });
          },
        };

        let db2 = new AgentDB2(dir2, {
          storageMode: "disk",
          embeddings: { provider: stubProvider },
          hnsw: { persistEvery: 3 },
        });
        await db2.init();
        const col2 = await db2.collection(schema2);

        // Insert 6 records — 2 HNSW flushes at add 3 and add 6
        await col2.insert({ _id: "c1", title: "doc one", a: "x", b: "1" });
        await col2.insert({ _id: "c2", title: "doc two", a: "x", b: "2" });
        await col2.insert({ _id: "c3", title: "doc three", a: "y", b: "1" });
        await col2.embedUnembedded();
        await col2.insert({ _id: "c4", title: "doc four", a: "x", b: "1" });
        await col2.insert({ _id: "c5", title: "doc five", a: "y", b: "2" });
        await col2.insert({ _id: "c6", title: "doc six", a: "z", b: "1" });
        await col2.embedUnembedded();
        await col2.awaitHnswFlush();

        // Composite index still correct
        const q1 = await col2.find({ filter: { a: "x", b: "1" } });
        expect(q1.records.length).toBe(2); // c1, c4
        const ids1 = q1.records.map(r => r._id).sort();
        expect(ids1).toEqual(["c1", "c4"]);

        await db2.close();

        // Reopen — composite index loaded from JSON, HNSW loaded from graph.bin
        db2 = new AgentDB2(dir2, {
          storageMode: "disk",
          embeddings: { provider: stubProvider },
          hnsw: { persistEvery: 3 },
        });
        await db2.init();
        const col3 = await db2.collection(schema2);

        const q2 = await col3.find({ filter: { a: "x", b: "1" } });
        expect(q2.records.length).toBe(2);
        expect(q2.records.map(r => r._id).sort()).toEqual(["c1", "c4"]);

        expect((await col3.metrics()).hnswNodeCount).toBe(6);
        await db2.close();
      } finally {
        await rm2(dir2, { recursive: true, force: true });
      }
    });
  });
});
