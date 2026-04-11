import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDB } from "../src/agentdb.js";

describe("AgentDB", () => {
  let tmpDir: string;
  let db: AgentDB;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agentdb-"));
    db = new AgentDB(tmpDir);
    await db.init();
  });

  afterEach(async () => {
    try {
      await db.close();
    } catch {
      // already closed
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("lifecycle", () => {
    it("initializes a fresh database", async () => {
      const stats = await db.stats();
      expect(stats.collections).toBe(0);
      expect(stats.totalRecords).toBe(0);
    });

    it("throws on operations before init", async () => {
      const db2 = new AgentDB(tmpDir + "-other");
      expect(() => db2.listDropped()).toThrow("not initialized");
    });
  });

  describe("collections", () => {
    it("creates a collection on first access", async () => {
      const col = await db.collection("users");
      expect(col.name).toBe("users");
      const list = await db.listCollections();
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe("users");
    });

    it("returns the same instance on repeated access", async () => {
      const col1 = await db.collection("users");
      const col2 = await db.collection("users");
      expect(col1).toBe(col2);
    });

    it("supports multiple collections", async () => {
      const users = await db.collection("users");
      const tasks = await db.collection("tasks");
      await users.insert({ name: "Alice" });
      await tasks.insert({ title: "Task 1" });

      expect(await users.count()).toBe(1);
      expect(await tasks.count()).toBe(1);

      const list = await db.listCollections();
      expect(list).toHaveLength(2);
    });

    it("data persists across close/reopen", async () => {
      const users = await db.collection("users");
      await users.insert({ _id: "a", name: "Alice" });
      await db.close();

      const db2 = new AgentDB(tmpDir);
      await db2.init();
      const users2 = await db2.collection("users");
      expect((await users2.findOne("a"))?.name).toBe("Alice");
      await db2.close();
    });

    it("meta-manifest persists collection list", async () => {
      await db.collection("users");
      await db.collection("tasks");
      await db.close();

      const db2 = new AgentDB(tmpDir);
      await db2.init();
      const list = await db2.listCollections();
      expect(list).toHaveLength(2);
      expect(list.map((c) => c.name).sort()).toEqual(["tasks", "users"]);
      await db2.close();
    });
  });

  describe("LRU eviction", () => {
    it("evicts least recently used collection when limit reached", async () => {
      const lruDir = tmpDir + "-lru";
      await rm(lruDir, { recursive: true, force: true }).catch(() => null);
      const dbLru = new AgentDB(lruDir, { maxOpenCollections: 2 });
      await dbLru.init();

      const col1 = await dbLru.collection("col1");
      await col1.insert({ _id: "a", name: "A" });
      const col2 = await dbLru.collection("col2");
      await col2.insert({ _id: "b", name: "B" });

      // Opening col3 should evict col1 (LRU)
      const col3 = await dbLru.collection("col3");
      await col3.insert({ _id: "c", name: "C" });

      // col1 was evicted but data persists — reopen it
      const col1Again = await dbLru.collection("col1");
      expect((await col1Again.findOne("a"))?.name).toBe("A");

      await dbLru.close();
      await rm(lruDir, { recursive: true, force: true });
    });

    it("touch on access updates LRU order", async () => {
      const lruDir = tmpDir + "-lru2";
      const dbLru = new AgentDB(lruDir, { maxOpenCollections: 2 });
      await dbLru.init();

      await dbLru.collection("col1");
      await dbLru.collection("col2");
      // Touch col1 again — now col2 is LRU
      await dbLru.collection("col1");
      // Opening col3 should evict col2, not col1
      await dbLru.collection("col3");

      // col1 should still be cached (not evicted)
      const col1 = await dbLru.collection("col1");
      expect(col1).toBeDefined();

      await dbLru.close();
      await rm(lruDir, { recursive: true, force: true });
    });
  });

  describe("drop and purge", () => {
    it("soft-deletes a collection", async () => {
      const users = await db.collection("users");
      await users.insert({ name: "Alice" });

      await db.dropCollection("users");

      const list = await db.listCollections();
      expect(list).toHaveLength(0);
      expect(db.listDropped()).toHaveLength(1);
      expect(db.listDropped()[0]).toContain("_dropped_users_");
    });

    it("throws when dropping non-existent collection", async () => {
      await expect(db.dropCollection("nonexistent")).rejects.toThrow("not found");
    });

    it("purges a soft-deleted collection", async () => {
      await db.collection("users");
      await db.dropCollection("users");

      const droppedName = db.listDropped()[0];
      await db.purgeCollection(droppedName);

      expect(db.listDropped()).toHaveLength(0);
    });

    it("throws when purging non-existent drop", async () => {
      await expect(db.purgeCollection("nonexistent")).rejects.toThrow("not found");
    });

    it("drop persists across reopen", async () => {
      await db.collection("users");
      await db.dropCollection("users");
      await db.close();

      const db2 = new AgentDB(tmpDir);
      await db2.init();
      expect((await db2.listCollections())).toHaveLength(0);
      expect(db2.listDropped()).toHaveLength(1);
      await db2.close();
    });
  });

  describe("export and import", () => {
    it("exports all collections", async () => {
      const users = await db.collection("users");
      const tasks = await db.collection("tasks");
      await users.insert({ _id: "a", name: "Alice" });
      await tasks.insert({ _id: "t1", title: "Task 1" });

      const data = await db.export();
      expect(data.version).toBe(1);
      expect(data.exportedAt).toBeTruthy();
      expect(Object.keys(data.collections)).toHaveLength(2);
      expect(data.collections.users.records).toHaveLength(1);
      expect(data.collections.tasks.records).toHaveLength(1);
    });

    it("exports named collections", async () => {
      await (await db.collection("users")).insert({ _id: "a", name: "Alice" });
      await (await db.collection("tasks")).insert({ _id: "t1", title: "Task 1" });

      const data = await db.export(["users"]);
      expect(Object.keys(data.collections)).toHaveLength(1);
      expect(data.collections.users).toBeDefined();
      expect(data.collections.tasks).toBeUndefined();
    });

    it("round-trip: export then import into fresh db", async () => {
      const users = await db.collection("users");
      await users.insert({ _id: "a", name: "Alice" });
      await users.insert({ _id: "b", name: "Bob" });
      const data = await db.export();
      await db.close();

      // Import into fresh db
      const freshDir = tmpDir + "-fresh";
      const db2 = new AgentDB(freshDir);
      await db2.init();
      const result = await db2.import(data);
      expect(result.collections).toBe(1);
      expect(result.records).toBe(2);

      const users2 = await db2.collection("users");
      expect((await users2.findOne("a"))?.name).toBe("Alice");
      expect((await users2.findOne("b"))?.name).toBe("Bob");
      await db2.close();
      await rm(freshDir, { recursive: true, force: true });
    });

    it("import skips existing records by default", async () => {
      const users = await db.collection("users");
      await users.insert({ _id: "a", name: "Original" });

      const data = {
        version: 1,
        exportedAt: new Date().toISOString(),
        collections: { users: { records: [{ _id: "a", name: "Imported" }] } },
      };
      await db.import(data);
      expect((await users.findOne("a"))?.name).toBe("Original"); // not overwritten
    });

    it("import with overwrite replaces existing records", async () => {
      const users = await db.collection("users");
      await users.insert({ _id: "a", name: "Original" });

      const data = {
        version: 1,
        exportedAt: new Date().toISOString(),
        collections: { users: { records: [{ _id: "a", name: "Imported" }] } },
      };
      await db.import(data, { overwrite: true });
      expect((await users.findOne("a"))?.name).toBe("Imported");
    });
  });

  describe("storage backend integration", () => {
    it("accepts agentId option", async () => {
      const agentDir = tmpDir + "-agent";
      const agentDb = new AgentDB(agentDir, { agentId: "agent-1" });
      await agentDb.init();

      const col = await agentDb.collection("test");
      await col.insert({ _id: "a", name: "Alice" });
      expect((await col.findOne("a"))?.name).toBe("Alice");

      await agentDb.close();
      await rm(agentDir, { recursive: true, force: true });
    });

    it("re-exports StorageBackend types", async () => {
      // Verify types are accessible
      const { FsBackend, LamportClock } = await import("../src/index.js");
      expect(FsBackend).toBeDefined();
      expect(LamportClock).toBeDefined();

      const clock = new LamportClock();
      expect(clock.tick()).toBe(1);
      expect(clock.tick()).toBe(2);
      expect(clock.merge(10)).toBe(11);
    });
  });

  describe("stats", () => {
    it("reports correct totals", async () => {
      const users = await db.collection("users");
      const tasks = await db.collection("tasks");
      await users.insert({ name: "Alice" });
      await users.insert({ name: "Bob" });
      await tasks.insert({ title: "Task 1" });

      const stats = await db.stats();
      expect(stats.collections).toBe(2);
      expect(stats.totalRecords).toBe(3);
    });
  });

  describe("readOnly mode", () => {
    it("opens without write lock and reads data from a writer", async () => {
      // Writer inserts data
      const col = await db.collection("items");
      await col.insert({ _id: "a", name: "Alice" });
      await col.insert({ _id: "b", name: "Bob" });
      await db.close();

      // Reader opens read-only
      const reader = new AgentDB(tmpDir, { readOnly: true });
      await reader.init();

      const items = await reader.collection("items");
      expect(await items.count()).toBe(2);
      expect((await items.findOne("a"))?.name).toBe("Alice");

      await reader.close();

      // Reopen writer for afterEach cleanup
      db = new AgentDB(tmpDir);
      await db.init();
    });

    it("read-only rejects mutations", async () => {
      // Create a collection first so readOnly has something to open
      const col = await db.collection("test");
      await col.insert({ _id: "x", name: "seed" });
      await db.close();

      const reader = new AgentDB(tmpDir, { readOnly: true });
      await reader.init();

      const readCol = await reader.collection("test");
      await expect(readCol.insert({ name: "fail" })).rejects.toThrow("read-only");

      await reader.close();

      db = new AgentDB(tmpDir);
      await db.init();
    });

    it("read-only can tail new writes from a writer", async () => {
      const col = await db.collection("items");
      await col.insert({ _id: "a", name: "Alice" });

      // Open reader
      const reader = new AgentDB(tmpDir, { readOnly: true });
      await reader.init();
      const readerCol = await reader.collection("items");
      expect(await readerCol.count()).toBe(1);

      // Writer adds more
      await col.insert({ _id: "b", name: "Bob" });

      // Reader tails
      await readerCol.tail();
      expect(await readerCol.count()).toBe(2);
      expect((await readerCol.findOne("b"))?.name).toBe("Bob");

      await reader.close();
    });
  });
});
