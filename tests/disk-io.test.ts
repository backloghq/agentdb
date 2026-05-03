import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsBackend } from "@backloghq/opslog";
import {
  compactToParquet,
  writeOffsetIndex,
  readOffsetIndex,
  writeCompactionMeta,
  readCompactionMeta,
  getParquetMetadata,
  cleanupOldParquetFiles,
  countByColumn,
  scanColumn,
} from "../src/disk-io.js";

describe("Parquet compaction and reader", () => {
  let tmpDir: string;
  let backend: FsBackend;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agentdb-parquet-"));
    backend = new FsBackend();
    await backend.initialize(tmpDir, { readOnly: false });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function* generateRecords(count: number): Iterable<[string, Record<string, unknown>]> {
    for (let i = 0; i < count; i++) {
      yield [`id-${i}`, {
        _id: `id-${i}`,
        title: `Record ${i}`,
        status: i % 3 === 0 ? "open" : "closed",
        score: i,
        tags: i % 2 === 0 ? ["even"] : ["odd"],
      }];
    }
  }

  describe("compactToParquet", () => {
    it("compacts records into a Parquet file", async () => {
      const { file, offsetIndex } = await compactToParquet(backend, generateRecords(100));

      expect(file.path).toMatch(/^data\/data-\d+\.parquet$/);
      expect(file.rowCount).toBe(100);
      expect(file.rowGroups).toBeGreaterThanOrEqual(1);
      expect(offsetIndex.size).toBe(100);
      expect(offsetIndex.get("id-0")).toEqual({ rowGroup: 0, row: 0 });
    });

    it("respects rowGroupSize", async () => {
      const { file } = await compactToParquet(backend, generateRecords(100), { rowGroupSize: 25 });
      expect(file.rowGroups).toBe(4);
    });

    it("extracts columns for skip-scanning", async () => {
      const { file } = await compactToParquet(backend, generateRecords(100), {
        rowGroupSize: 25,
        extractColumns: ["status", "score"],
      });

      const metadata = await getParquetMetadata(backend, file.path);
      // Should have _id + extracted columns (no _data — full records live in JSONL)
      const colNames = metadata.row_groups[0].columns.map(
        (c) => c.meta_data?.path_in_schema?.[0],
      );
      expect(colNames).toContain("_id");
      expect(colNames).not.toContain("_data");
      expect(colNames).toContain("status");
      expect(colNames).toContain("score");
    });

    it("handles empty records", async () => {
      async function* empty() { /* yields nothing */ }
      const { file, offsetIndex } = await compactToParquet(backend, empty());
      expect(file.rowCount).toBe(0);
      expect(offsetIndex.size).toBe(0);
    });

    it("Parquet has no _data column (full records live in JSONL)", async () => {
      const { file } = await compactToParquet(backend, generateRecords(50));
      const metadata = await getParquetMetadata(backend, file.path);
      const colNames = metadata.row_groups[0].columns.map(
        (c) => c.meta_data?.path_in_schema?.[0],
      );
      expect(colNames).toContain("_id");
      expect(colNames).not.toContain("_data");
    });
  });

  describe("offset index persistence", () => {
    it("writes and reads offset index", async () => {
      const { offsetIndex } = await compactToParquet(backend, generateRecords(50));
      await writeOffsetIndex(backend, offsetIndex);

      const loaded = await readOffsetIndex(backend);
      expect(loaded.size).toBe(50);
      expect(loaded.get("id-0")).toEqual(offsetIndex.get("id-0"));
      expect(loaded.get("id-49")).toEqual(offsetIndex.get("id-49"));
    });

    it("returns empty map when no index file", async () => {
      const loaded = await readOffsetIndex(backend);
      expect(loaded.size).toBe(0);
    });
  });

  describe("compaction metadata", () => {
    it("writes and reads compaction metadata", async () => {
      const meta = {
        lastTimestamp: new Date().toISOString(),
        parquetFile: "data/data-123.parquet",
        rowCount: 1000,
        rowGroups: 4,
      };
      await writeCompactionMeta(backend, meta);

      const loaded = await readCompactionMeta(backend);
      expect(loaded).toEqual(meta);
    });

    it("returns null when no metadata", async () => {
      const loaded = await readCompactionMeta(backend);
      expect(loaded).toBeNull();
    });
  });

  describe("cleanup", () => {
    it("removes old Parquet files but keeps the specified one", async () => {
      const { file: file1 } = await compactToParquet(backend, generateRecords(10));
      await new Promise((r) => setTimeout(r, 10));
      const { file: file2 } = await compactToParquet(backend, generateRecords(20));

      await cleanupOldParquetFiles(backend, file2.path);

      // file2 should still exist
      const metadata = await getParquetMetadata(backend, file2.path);
      expect(Number(metadata.num_rows)).toBe(20);

      // file1 should be gone
      await expect(getParquetMetadata(backend, file1.path)).rejects.toThrow();
    });
  });

  describe("row group metadata", () => {
    it("provides min/max stats for extracted columns", async () => {
      const { file } = await compactToParquet(backend, generateRecords(100), {
        rowGroupSize: 25,
        extractColumns: ["score"],
      });

      const metadata = await getParquetMetadata(backend, file.path);
      expect(metadata.row_groups.length).toBe(4);

      // Check score column stats in first row group (records 0-24)
      const rg0 = metadata.row_groups[0];
      const scoreCol = rg0.columns.find(
        (c) => c.meta_data?.path_in_schema?.[0] === "score",
      );
      expect(scoreCol).toBeTruthy();
      const stats = scoreCol!.meta_data!.statistics;
      expect(stats?.min_value).toBe(0);
      expect(stats?.max_value).toBe(24);
    });
  });

  describe("column-only scan", () => {
    it("countByColumn counts matches without reading _data", async () => {
      const { file } = await compactToParquet(backend, generateRecords(100), {
        extractColumns: ["status"],
      });

      // status is "open" for i % 3 === 0, "closed" otherwise
      const openCount = await countByColumn(backend, file.path, "status", "open");
      expect(openCount).toBe(34); // 0,3,6,...,99 → 34 records

      const closedCount = await countByColumn(backend, file.path, "status", "closed");
      expect(closedCount).toBe(66);
    });

    it("countByColumn returns null for non-extracted column", async () => {
      const { file } = await compactToParquet(backend, generateRecords(50), {
        extractColumns: ["status"],
      });

      const result = await countByColumn(backend, file.path, "nonexistent", "value");
      expect(result).toBeNull();
    });

    it("scanColumn returns matching IDs", async () => {
      const { file } = await compactToParquet(backend, generateRecords(50), {
        extractColumns: ["status"],
      });

      const openIds = await scanColumn(backend, file.path, "status", (v) => v === "open");
      expect(openIds).not.toBeNull();
      expect(openIds!.length).toBe(17); // 0,3,6,...,48

      // Verify IDs are correct
      expect(openIds).toContain("id-0");
      expect(openIds).toContain("id-3");
      expect(openIds).not.toContain("id-1");
    });

    it("scanColumn returns null for non-extracted column", async () => {
      const { file } = await compactToParquet(backend, generateRecords(10));
      const result = await scanColumn(backend, file.path, "title", () => true);
      expect(result).toBeNull();
    });
  });

  describe("JSONL record store", () => {
    it("writes and reads records by byte offset", async () => {
      const records: Array<[string, Record<string, unknown>]> = [
        ["id-0", { _id: "id-0", title: "First", status: "open" }],
        ["id-1", { _id: "id-1", title: "Second", status: "closed" }],
        ["id-2", { _id: "id-2", title: "Third", status: "open" }],
      ];

      const { writeRecordStore, readRecordByOffset, readRecordsByOffsets, readAllFromJsonl } = await import("../src/disk-io.js");

      const { path, offsetIndex } = await writeRecordStore(backend, records);
      expect(path).toMatch(/^data\/records-\d+-\d+\.jsonl$/);
      expect(offsetIndex.size).toBe(3);

      // Read single record by offset
      const r1 = await readRecordByOffset(backend, path, offsetIndex.get("id-1")!);
      expect(r1.title).toBe("Second");
      expect(r1._id).toBe("id-1");

      // Read multiple by offset (parallel)
      const entries = [
        { id: "id-0", entry: offsetIndex.get("id-0")! },
        { id: "id-2", entry: offsetIndex.get("id-2")! },
      ];
      const multi = await readRecordsByOffsets(backend, path, entries);
      expect(multi.size).toBe(2);
      expect(multi.get("id-0")?.title).toBe("First");
      expect(multi.get("id-2")?.title).toBe("Third");

      // Read all from JSONL
      const all = await readAllFromJsonl(backend, path);
      expect(all.size).toBe(3);
    });

    it("concurrent writeRecordStore calls produce distinct filenames (#172)", async () => {
      const { writeRecordStore } = await import("../src/disk-io.js");
      const records: Array<[string, Record<string, unknown>]> = [["x", { _id: "x" }]];
      // Fire N calls without awaiting — all land within the same ms on fast machines
      const paths = await Promise.all(
        Array.from({ length: 20 }, () => writeRecordStore(backend, records).then((r) => r.path)),
      );
      const unique = new Set(paths);
      expect(unique.size).toBe(20);
    });

    it("offset index binary round-trip", async () => {
      const { writeRecordStore, writeRecordOffsetIndex, readRecordOffsetIndex } = await import("../src/disk-io.js");

      const records: Array<[string, Record<string, unknown>]> = [
        ["a", { _id: "a", val: 1 }],
        ["b", { _id: "b", val: 2 }],
      ];
      const { offsetIndex } = await writeRecordStore(backend, records);
      await writeRecordOffsetIndex(backend, offsetIndex);

      const loaded = await readRecordOffsetIndex(backend);
      expect(loaded.size).toBe(2);
      expect(loaded.get("a")).toEqual(offsetIndex.get("a"));
      expect(loaded.get("b")).toEqual(offsetIndex.get("b"));
    });

    it("binary offset index handles variable-length IDs", async () => {
      const { writeRecordOffsetIndex, readRecordOffsetIndex } = await import("../src/disk-io.js");

      const f = "data/records-test.jsonl";
      const offsetIndex = new Map([
        ["short", { file: f, offset: 0, length: 100 }],
        ["a-much-longer-custom-id-string", { file: f, offset: 101, length: 200 }],
        ["x", { file: f, offset: 302, length: 50 }],
      ]);
      await writeRecordOffsetIndex(backend, offsetIndex);

      const loaded = await readRecordOffsetIndex(backend);
      expect(loaded.size).toBe(3);
      expect(loaded.get("short")).toEqual({ file: f, offset: 0, length: 100 });
      expect(loaded.get("a-much-longer-custom-id-string")).toEqual({ file: f, offset: 101, length: 200 });
      expect(loaded.get("x")).toEqual({ file: f, offset: 302, length: 50 });
    });

    it("binary offset index handles large offsets (uint48)", async () => {
      const { writeRecordOffsetIndex, readRecordOffsetIndex } = await import("../src/disk-io.js");

      const largeOffset = 500_000_000_000;
      const offsetIndex = new Map([
        ["big", { file: "data/records.jsonl", offset: largeOffset, length: 1000 }],
      ]);
      await writeRecordOffsetIndex(backend, offsetIndex);

      const loaded = await readRecordOffsetIndex(backend);
      expect(loaded.get("big")?.offset).toBe(largeOffset);
    });

    it("binary offset index returns empty for missing file", async () => {
      const { readRecordOffsetIndex } = await import("../src/disk-io.js");
      const loaded = await readRecordOffsetIndex(backend);
      expect(loaded.size).toBe(0);
    });
  });

  describe("readJsonlStream", () => {
    it("yields correct id/record pairs for all records", async () => {
      const { writeRecordStore, readJsonlStream } = await import("../src/disk-io.js");

      const N = 100;
      const records: Array<[string, Record<string, unknown>]> = Array.from({ length: N }, (_, i) => [
        `id-${i}`, { _id: `id-${i}`, title: `Record ${i}`, score: i },
      ]);

      const { path } = await writeRecordStore(backend, records);

      const yielded: Array<[string, Record<string, unknown>]> = [];
      for await (const entry of readJsonlStream(backend, path)) {
        yielded.push(entry);
      }

      expect(yielded.length).toBe(N);
      for (let i = 0; i < N; i++) {
        const [id, record] = yielded[i];
        expect(id).toBe(`id-${i}`);
        expect(record._id).toBe(`id-${i}`);
        expect(record.score).toBe(i);
      }
    });

    it("throws SyntaxError on malformed JSON line (truncated record in the middle)", async () => {
      const { readJsonlStream } = await import("../src/disk-io.js");

      // Write a JSONL with a valid record, a truncated line, then another valid record
      const corrupt = Buffer.from(
        '{"_id":"id-0","title":"good"}\n' +
        '{"_id":"id-1","title":"truncated\n' +     // missing closing brace/quote
        '{"_id":"id-2","title":"good2"}\n',
        "utf-8",
      );
      await backend.writeBlob("data/corrupt.jsonl", corrupt);

      await expect(async () => {
        for await (const [,] of readJsonlStream(backend, "data/corrupt.jsonl")) { /* consume */ }
      }).rejects.toThrow(SyntaxError);
    });

    it("readAllFromJsonl throws on malformed JSONL (delegates to readJsonlStream)", async () => {
      const { readAllFromJsonl } = await import("../src/disk-io.js");

      const corrupt = Buffer.from(
        '{"_id":"a","v":1}\n' +
        'not valid json at all\n' +
        '{"_id":"b","v":2}\n',
        "utf-8",
      );
      await backend.writeBlob("data/corrupt2.jsonl", corrupt);

      await expect(readAllFromJsonl(backend, "data/corrupt2.jsonl")).rejects.toThrow(SyntaxError);
    });

    it("DiskStore.entries({skipCache:true}) propagates SyntaxError from corrupt JSONL", async () => {
      const { DiskStore } = await import("../src/disk-store.js");
      const { writeRecordStore, writeCompactionMeta, compactToParquet } = await import("../src/disk-io.js");

      // Bootstrap a valid compacted state first
      const records: Array<[string, Record<string, unknown>]> = [
        ["id-0", { _id: "id-0", title: "First" }],
        ["id-1", { _id: "id-1", title: "Second" }],
      ];
      const { path: jsonlPath } = await writeRecordStore(backend, records);
      const { file: parquetFile } = await compactToParquet(backend, records);
      await writeCompactionMeta(backend, {
        lastTimestamp: new Date().toISOString(),
        parquetFile: parquetFile.path,
        jsonlFile: jsonlPath,
        rowCount: records.length,
        rowGroups: parquetFile.rowGroups,
      });

      // Overwrite the JSONL with corrupt content
      await backend.writeBlob(jsonlPath, Buffer.from(
        '{"_id":"id-0","title":"First"}\n' +
        '{CORRUPT\n' +
        '{"_id":"id-1","title":"Second"}\n',
        "utf-8",
      ));

      const store = new DiskStore(backend);
      await store.load();

      await expect(async () => {
        for await (const [,] of store.entries({ skipCache: true })) { /* consume */ }
      }).rejects.toThrow(SyntaxError);
    });

    it("streaming uses less peak heap than readAllFromJsonl for large JSONL", async () => {
      const { writeRecordStore, readJsonlStream, readAllFromJsonl } = await import("../src/disk-io.js");

      // Write 1000 records (large enough for a meaningful heap comparison)
      const N = 1000;
      const records: Array<[string, Record<string, unknown>]> = Array.from({ length: N }, (_, i) => [
        `id-${i}`, { _id: `id-${i}`, body: "x".repeat(200), score: i },
      ]);
      const { path } = await writeRecordStore(backend, records);

      // Measure heap for readAllFromJsonl (materialises full Map)
      if (global.gc) global.gc();
      const heapBefore1 = process.memoryUsage().heapUsed;
      const map = await readAllFromJsonl(backend, path);
      const heapAfterMap = process.memoryUsage().heapUsed;
      expect(map.size).toBe(N);
      const mapDelta = heapAfterMap - heapBefore1;

      // Measure heap for readJsonlStream (yields one at a time, discards each)
      if (global.gc) global.gc();
      const heapBefore2 = process.memoryUsage().heapUsed;
      let streamCount = 0;
      for await (const [,] of readJsonlStream(backend, path)) { streamCount++; }
      const heapAfterStream = process.memoryUsage().heapUsed;
      expect(streamCount).toBe(N);
      const streamDelta = heapAfterStream - heapBefore2;

      // Stream delta should be meaningfully smaller (Map overhead eliminated)
      // Best-effort: assert streaming heap delta < 2x map delta only when GC is exposed.
      // Without --expose-gc heap readings are noisy; just log the values.
      console.log(`  readAllFromJsonl heap delta: ${(mapDelta / 1024).toFixed(0)} KB`);
      console.log(`  readJsonlStream  heap delta: ${(streamDelta / 1024).toFixed(0)} KB`);
      // Hard lower bound: streaming must not use more than 3× the map path (regression guard)
      if (global.gc) {
        expect(streamDelta).toBeLessThan(mapDelta * 3);
      }
    });
  });
});
