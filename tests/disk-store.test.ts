import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskStore } from "../src/disk-store.js";

describe("DiskStore", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agentdb-disk-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeRecords(count: number): Array<[string, Record<string, unknown>]> {
    return Array.from({ length: count }, (_, i) => [
      `id-${i}`,
      { _id: `id-${i}`, title: `Record ${i}`, status: i % 3 === 0 ? "open" : "closed", score: i },
    ]);
  }

  describe("compact + get", () => {
    it("compacts records and reads by ID", async () => {
      const store = new DiskStore(tmpDir, { rowGroupSize: 25 });
      await store.compact(makeRecords(100));
      await store.load();

      expect(store.recordCount).toBe(100);
      expect(store.hasParquetData).toBe(true);

      const record = await store.get("id-42");
      expect(record?.title).toBe("Record 42");
      expect(record?.score).toBe(42);
    });

    it("returns undefined for nonexistent ID", async () => {
      const store = new DiskStore(tmpDir);
      await store.compact(makeRecords(10));
      await store.load();

      expect(await store.get("nonexistent")).toBeUndefined();
    });

    it("cache hit avoids Parquet read", async () => {
      const store = new DiskStore(tmpDir, { cacheSize: 10 });
      await store.compact(makeRecords(50));
      await store.load();

      // First read: cache miss
      await store.get("id-5");
      const stats1 = store.cacheStats;
      expect(stats1.misses).toBe(1);
      expect(stats1.hits).toBe(0);

      // Second read: cache hit
      await store.get("id-5");
      const stats2 = store.cacheStats;
      expect(stats2.hits).toBe(1);
    });
  });

  describe("getMany", () => {
    it("batch reads multiple IDs", async () => {
      const store = new DiskStore(tmpDir, { rowGroupSize: 25 });
      await store.compact(makeRecords(100));
      await store.load();

      const results = await store.getMany(["id-0", "id-50", "id-99", "nonexistent"]);
      expect(results.size).toBe(3);
      expect(results.get("id-0")?.title).toBe("Record 0");
      expect(results.get("id-99")?.title).toBe("Record 99");
      expect(results.has("nonexistent")).toBe(false);
    });
  });

  describe("entries", () => {
    it("iterates all records", async () => {
      const store = new DiskStore(tmpDir);
      await store.compact(makeRecords(50));
      await store.load();

      const records: Array<[string, Record<string, unknown>]> = [];
      for await (const entry of store.entries()) {
        records.push(entry);
      }
      expect(records).toHaveLength(50);
    });

    it("yields nothing when no Parquet data", async () => {
      const store = new DiskStore(tmpDir);
      await store.load();

      const records: Array<[string, Record<string, unknown>]> = [];
      for await (const entry of store.entries()) {
        records.push(entry);
      }
      expect(records).toHaveLength(0);
    });
  });

  describe("write-through cache", () => {
    it("cacheWrite makes record available via get", async () => {
      const store = new DiskStore(tmpDir);
      await store.load();

      store.cacheWrite("new-1", { _id: "new-1", title: "New" });
      const record = await store.get("new-1");
      expect(record?.title).toBe("New");
    });

    it("cacheDelete removes from cache", async () => {
      const store = new DiskStore(tmpDir);
      await store.compact(makeRecords(10));
      await store.load();

      await store.get("id-0"); // populate cache
      store.cacheDelete("id-0");
      // Record still in Parquet, but deleted from cache + offset index tracking
      expect(store.cacheStats.size).toBe(0);
    });
  });

  describe("has", () => {
    it("checks offset index without Parquet read", async () => {
      const store = new DiskStore(tmpDir);
      await store.compact(makeRecords(50));
      await store.load();

      expect(store.has("id-0")).toBe(true);
      expect(store.has("nonexistent")).toBe(false);
      // No cache misses — has() doesn't read from Parquet
      expect(store.cacheStats.misses).toBe(0);
    });
  });

  describe("re-compaction", () => {
    it("replaces old Parquet file with new one", async () => {
      const store = new DiskStore(tmpDir);
      await store.compact(makeRecords(50));
      await store.load();

      // Re-compact with different data
      const newRecords: Array<[string, Record<string, unknown>]> = [
        ["x", { _id: "x", title: "X" }],
        ["y", { _id: "y", title: "Y" }],
      ];
      await store.compact(newRecords);
      await store.load();

      expect(store.recordCount).toBe(2);
      expect(await store.get("x")).toEqual({ _id: "x", title: "X" });
      expect(await store.get("id-0")).toBeUndefined();
    });
  });

  describe("persistence across instances", () => {
    it("new DiskStore loads state from disk", async () => {
      const store1 = new DiskStore(tmpDir, { rowGroupSize: 25 });
      await store1.compact(makeRecords(100));

      // New instance, same dir
      const store2 = new DiskStore(tmpDir, { rowGroupSize: 25 });
      await store2.load();

      expect(store2.recordCount).toBe(100);
      expect(store2.hasParquetData).toBe(true);
      const record = await store2.get("id-42");
      expect(record?.title).toBe("Record 42");
    });
  });
});
