import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsBackend } from "@backloghq/opslog";
import { DiskStore } from "../src/disk-store.js";

describe("DiskStore", () => {
  let tmpDir: string;
  let backend: FsBackend;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agentdb-disk-"));
    backend = new FsBackend();
    await backend.initialize(tmpDir, { readOnly: false });
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
      const store = new DiskStore(backend, { rowGroupSize: 25 });
      await store.compact(makeRecords(100));
      await store.load();

      expect(store.recordCount).toBe(100);
      expect(store.hasParquetData).toBe(true);

      const record = await store.get("id-42");
      expect(record?.title).toBe("Record 42");
      expect(record?.score).toBe(42);
    });

    it("returns undefined for nonexistent ID", async () => {
      const store = new DiskStore(backend);
      await store.compact(makeRecords(10));
      await store.load();

      expect(await store.get("nonexistent")).toBeUndefined();
    });

    it("cache hit avoids Parquet read", async () => {
      const store = new DiskStore(backend, { cacheSize: 10 });
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
      const store = new DiskStore(backend, { rowGroupSize: 25 });
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
      const store = new DiskStore(backend);
      await store.compact(makeRecords(50));
      await store.load();

      const records: Array<[string, Record<string, unknown>]> = [];
      for await (const entry of store.entries()) {
        records.push(entry);
      }
      expect(records).toHaveLength(50);
    });

    it("yields nothing when no Parquet data", async () => {
      const store = new DiskStore(backend);
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
      const store = new DiskStore(backend);
      await store.load();

      store.cacheWrite("new-1", { _id: "new-1", title: "New" });
      const record = await store.get("new-1");
      expect(record?.title).toBe("New");
    });

    it("cacheDelete removes from cache", async () => {
      const store = new DiskStore(backend);
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
      const store = new DiskStore(backend);
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
      const store = new DiskStore(backend);
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
      const store1 = new DiskStore(backend, { rowGroupSize: 25 });
      await store1.compact(makeRecords(100));

      // New instance, same dir
      const store2 = new DiskStore(backend, { rowGroupSize: 25 });
      await store2.load();

      expect(store2.recordCount).toBe(100);
      expect(store2.hasParquetData).toBe(true);
      const record = await store2.get("id-42");
      expect(record?.title).toBe("Record 42");
    });
  });

  describe("appendEmbeddings — precondition (#171)", () => {
    it("throws when compactionMeta is null (hasParquetData is false)", async () => {
      const store = new DiskStore(backend, { rowGroupSize: 100 });
      await store.load();
      expect(store.hasParquetData).toBe(false);
      await expect(
        store.appendEmbeddings([["id-0", { _id: "id-0", _embedding: "x" }]]),
      ).rejects.toThrow("compactionMeta");
    });

    it("succeeds after compaction (hasParquetData is true)", async () => {
      const store = new DiskStore(backend, { rowGroupSize: 100 });
      await store.load();
      await store.compact(makeRecords(5), null);
      expect(store.hasParquetData).toBe(true);
      await expect(
        store.appendEmbeddings([["id-0", { _id: "id-0", _embedding: "x" }]]),
      ).resolves.toBeUndefined();
    });
  });

  describe("appendEmbeddings — direct unit (#175)", () => {
    it("empty input is a no-op: _dirty stays false, cache unchanged", async () => {
      const store = new DiskStore(backend, { rowGroupSize: 100 });
      await store.load();
      await store.compact(makeRecords(5), null);
      expect(store.isDirty).toBe(false);
      const cachesBefore = store.cacheStats.size;

      await store.appendEmbeddings([]);

      expect(store.isDirty).toBe(false);
      expect(store.cacheStats.size).toBe(cachesBefore);
    });

    it("single batch: writes JSONL, updates cache, sets _dirty=true", async () => {
      const store = new DiskStore(backend, { rowGroupSize: 100 });
      await store.load();
      await store.compact(makeRecords(5), null);
      expect(store.isDirty).toBe(false);

      const embeddedRecord = { _id: "id-2", title: "Record 2", _embedding: [0.1, 0.2, 0.3] };
      await store.appendEmbeddings([["id-2", embeddedRecord]]);

      // _dirty set so close() will compact
      expect(store.isDirty).toBe(true);
      // Cache populated: get returns the embedded record without a new disk read
      const hitsBefore = store.cacheStats.hits;
      const result = await store.get("id-2");
      expect(store.cacheStats.hits).toBe(hitsBefore + 1);
      expect(result?._embedding).toEqual([0.1, 0.2, 0.3]);
    });

    it("recordOffsetIndex updated: new JSONL entry persists across a reload", async () => {
      const store = new DiskStore(backend, { rowGroupSize: 100 });
      await store.load();
      await store.compact(makeRecords(5), null);

      const embeddedRecord = { _id: "id-3", title: "Record 3", _embedding: [0.9, 0.8] };
      await store.appendEmbeddings([["id-3", embeddedRecord]]);

      // Open a fresh store on the same backend — persisted offset index must have id-3
      const store2 = new DiskStore(backend, { rowGroupSize: 100 });
      await store2.load();
      const result = await store2.get("id-3");
      expect(result?._embedding).toEqual([0.9, 0.8]);
    });

    it("compactionMeta.jsonlFiles grows by one per call", async () => {
      const store = new DiskStore(backend, { rowGroupSize: 100 });
      await store.load();
      await store.compact(makeRecords(5), null);

      await store.appendEmbeddings([["id-0", { _id: "id-0", _embedding: [1] }]]);
      await store.appendEmbeddings([["id-1", { _id: "id-1", _embedding: [2] }]]);

      // Both writes must be reflected: a third fresh store sees both via recordOffsetIndex
      const store2 = new DiskStore(backend, { rowGroupSize: 100 });
      await store2.load();
      const r0 = await store2.get("id-0");
      const r1 = await store2.get("id-1");
      expect(r0?._embedding).toEqual([1]);
      expect(r1?._embedding).toEqual([2]);
    });
  });
});
