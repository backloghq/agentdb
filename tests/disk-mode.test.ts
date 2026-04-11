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
});
