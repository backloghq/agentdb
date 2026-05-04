import { describe, it, expect } from "vitest";
import { estimateBytes, MemoryMonitor } from "../src/memory.js";
import { TextIndex } from "../src/text-index.js";
import { AgentDB } from "../src/agentdb.js";
import { defineSchema } from "../src/schema.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("estimateBytes", () => {
  it("estimates null/undefined", () => {
    expect(estimateBytes(null)).toBe(8);
    expect(estimateBytes(undefined)).toBe(8);
  });

  it("estimates primitives", () => {
    expect(estimateBytes(true)).toBe(4);
    expect(estimateBytes(42)).toBe(8);
    expect(estimateBytes("hello")).toBe(50); // 2*5 + 40
  });

  it("estimates arrays", () => {
    const bytes = estimateBytes([1, 2, 3]);
    expect(bytes).toBeGreaterThan(40); // overhead + 3 numbers
  });

  it("estimates objects", () => {
    const bytes = estimateBytes({ name: "Alice", age: 30 });
    expect(bytes).toBeGreaterThan(100);
  });

  it("estimates nested structures", () => {
    const simple = estimateBytes({ x: 1 });
    const nested = estimateBytes({ x: { y: { z: 1 } } });
    expect(nested).toBeGreaterThan(simple);
  });
});

describe("MemoryMonitor", () => {
  it("tracks collection stats", () => {
    const monitor = new MemoryMonitor();
    monitor.update("users", [
      { name: "Alice", age: 30 },
      { name: "Bob", age: 25 },
    ]);

    const stats = monitor.stats();
    expect(stats.collections.users.records).toBe(2);
    expect(stats.collections.users.bytes).toBeGreaterThan(0);
    expect(stats.totalBytes).toBeGreaterThan(0);
  });

  it("tracks multiple collections", () => {
    const monitor = new MemoryMonitor();
    monitor.update("users", [{ name: "Alice" }]);
    monitor.update("tasks", [{ title: "Task 1" }, { title: "Task 2" }]);

    const stats = monitor.stats();
    expect(Object.keys(stats.collections)).toHaveLength(2);
    expect(stats.totalBytes).toBe(
      stats.collections.users.bytes + stats.collections.tasks.bytes,
    );
  });

  it("detects over budget", () => {
    const monitor = new MemoryMonitor(100); // 100 bytes budget
    monitor.update("big", [
      { data: "x".repeat(1000) }, // Way over 100 bytes
    ]);

    expect(monitor.isOverBudget()).toBe(true);
    expect(monitor.stats().overBudget).toBe(true);
  });

  it("no budget = never over", () => {
    const monitor = new MemoryMonitor(); // 0 = unlimited
    monitor.update("big", [{ data: "x".repeat(10000) }]);
    expect(monitor.isOverBudget()).toBe(false);
  });

  it("updates replace previous stats", () => {
    const monitor = new MemoryMonitor();
    monitor.update("users", [{ name: "Alice" }]);
    const before = monitor.stats().collections.users.records;
    monitor.update("users", [{ name: "Alice" }, { name: "Bob" }]);
    const after = monitor.stats().collections.users.records;
    expect(after).toBe(2);
    expect(before).toBe(1);
  });

  it("removes collection from tracking", () => {
    const monitor = new MemoryMonitor();
    monitor.update("users", [{ name: "Alice" }]);
    monitor.remove("users");
    expect(monitor.stats().collections.users).toBeUndefined();
    expect(monitor.stats().totalBytes).toBe(0);
  });
});

describe("TextIndex.estimatedBytes()", () => {
  it("returns 0-ish for empty index", () => {
    const idx = new TextIndex();
    expect(idx.estimatedBytes()).toBeGreaterThanOrEqual(0);
    expect(idx.estimatedBytes()).toBeLessThan(256); // just overhead
  });

  it("grows monotonically as docs are added", () => {
    const idx = new TextIndex();
    let prev = idx.estimatedBytes();
    for (let i = 0; i < 20; i++) {
      idx.add(`doc${i}`, { text: `unique term alpha${i} beta${i} gamma${i}` });
      const cur = idx.estimatedBytes();
      expect(cur).toBeGreaterThan(prev);
      prev = cur;
    }
  });

  it("decreases when docs are removed", () => {
    const idx = new TextIndex();
    for (let i = 0; i < 10; i++) {
      idx.add(`doc${i}`, { text: `word${i} common` });
    }
    const full = idx.estimatedBytes();
    for (let i = 0; i < 10; i++) idx.remove(`doc${i}`);
    const empty = idx.estimatedBytes();
    expect(empty).toBeLessThan(full);
  });

  it("returns near-zero after clear()", () => {
    const idx = new TextIndex();
    for (let i = 0; i < 50; i++) idx.add(`doc${i}`, { text: `content word${i}` });
    idx.clear();
    expect(idx.estimatedBytes()).toBeLessThan(256);
  });
});

describe("TextIndex memory monitor integration", () => {
  async function makeTmpDir() {
    return mkdtemp(join(tmpdir(), "agentdb-mem-"));
  }

  it("AgentDB memory monitor includes textIndexBytes when text search is enabled", async () => {
    const dir = await makeTmpDir();
    try {
      const db = new AgentDB(dir, { memoryBudget: 0 });
      await db.init();
      const s = defineSchema({ name: "articles", textSearch: true,
        fields: { title: { type: "string", searchable: true } } });
      const col = await db.collection(s);

      // Empty — baseline
      const before = db.memoryStats().totalBytes;

      for (let i = 0; i < 30; i++) {
        await col.insert({ title: `word${i} common prefix text` });
      }

      // After inserting, textIndexBytes should be non-zero
      const afterStats = db.memoryStats();
      expect(afterStats.totalBytes).toBeGreaterThan(before);

      // db_stats includes textIndexBytes
      const dbStats = await db.stats();
      expect(dbStats.textIndexBytes).toBeGreaterThan(0);

      await db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("memory budget is tripped when textIndex bytes exceed the limit", async () => {
    const dir = await makeTmpDir();
    try {
      // Very small budget so even a tiny textIndex trips it
      const db = new AgentDB(dir, { memoryBudget: 1 });
      await db.init();
      const s = defineSchema({ name: "docs", textSearch: true,
        fields: { body: { type: "string", searchable: true } } });
      const col = await db.collection(s);
      await col.insert({ body: "hello world typescript search" });
      // After insert, memory monitor should be over budget
      expect(db.memoryStats().overBudget).toBe(true);
      await db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
