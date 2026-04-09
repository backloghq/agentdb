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

      expect(users.count()).toBe(1);
      expect(tasks.count()).toBe(1);

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
      expect(users2.findOne("a")?.name).toBe("Alice");
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
      expect(col1Again.findOne("a")?.name).toBe("A");

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
});
