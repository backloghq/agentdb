import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compactToParquet,
  writeOffsetIndex,
  readOffsetIndex,
  writeCompactionMeta,
  readCompactionMeta,
  readAllFromParquet,
  readByIds,
  getParquetMetadata,
  cleanupOldParquetFiles,
} from "../src/parquet.js";

describe("Parquet compaction and reader", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agentdb-parquet-"));
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
      const { file, offsetIndex } = await compactToParquet(tmpDir, generateRecords(100));

      expect(file.path).toMatch(/^data\/data-\d+\.parquet$/);
      expect(file.rowCount).toBe(100);
      expect(file.rowGroups).toBeGreaterThanOrEqual(1);
      expect(offsetIndex.size).toBe(100);
      expect(offsetIndex.get("id-0")).toEqual({ rowGroup: 0, row: 0 });
    });

    it("respects rowGroupSize", async () => {
      const { file } = await compactToParquet(tmpDir, generateRecords(100), { rowGroupSize: 25 });
      expect(file.rowGroups).toBe(4);
    });

    it("extracts columns for skip-scanning", async () => {
      const { file } = await compactToParquet(tmpDir, generateRecords(100), {
        rowGroupSize: 25,
        extractColumns: ["status", "score"],
      });

      const metadata = await getParquetMetadata(tmpDir, file.path);
      // Should have _id, _data, status, score columns
      const colNames = metadata.row_groups[0].columns.map(
        (c) => c.meta_data?.path_in_schema?.[0],
      );
      expect(colNames).toContain("_id");
      expect(colNames).toContain("_data");
      expect(colNames).toContain("status");
      expect(colNames).toContain("score");
    });

    it("handles empty records", async () => {
      async function* empty() { /* yields nothing */ }
      const { file, offsetIndex } = await compactToParquet(tmpDir, empty());
      expect(file.rowCount).toBe(0);
      expect(offsetIndex.size).toBe(0);
    });

    it("round-trips: compact then read all", async () => {
      const { file } = await compactToParquet(tmpDir, generateRecords(50));
      const records = await readAllFromParquet(tmpDir, file.path);

      expect(records.size).toBe(50);
      expect(records.get("id-0")?.title).toBe("Record 0");
      expect(records.get("id-49")?.title).toBe("Record 49");
      expect(records.get("id-0")?.tags).toEqual(["even"]);
    });
  });

  describe("readByIds", () => {
    it("reads specific records by ID", async () => {
      const { file, offsetIndex } = await compactToParquet(
        tmpDir, generateRecords(100), { rowGroupSize: 25 },
      );

      const results = await readByIds(tmpDir, file.path, ["id-0", "id-50", "id-99"], offsetIndex, 25);
      expect(results.size).toBe(3);
      expect(results.get("id-0")?.title).toBe("Record 0");
      expect(results.get("id-50")?.score).toBe(50);
      expect(results.get("id-99")?.title).toBe("Record 99");
    });

    it("returns empty for nonexistent IDs", async () => {
      const { file, offsetIndex } = await compactToParquet(tmpDir, generateRecords(10));
      const results = await readByIds(tmpDir, file.path, ["nonexistent"], offsetIndex, 5000);
      expect(results.size).toBe(0);
    });

    it("batches reads by row group", async () => {
      // With 100 records and rowGroupSize=25, reading IDs from the same row group
      // should only read that row group
      const { file, offsetIndex } = await compactToParquet(
        tmpDir, generateRecords(100), { rowGroupSize: 25 },
      );

      // IDs 0-24 are in row group 0
      const results = await readByIds(tmpDir, file.path, ["id-0", "id-10", "id-24"], offsetIndex, 25);
      expect(results.size).toBe(3);
    });
  });

  describe("offset index persistence", () => {
    it("writes and reads offset index", async () => {
      const { offsetIndex } = await compactToParquet(tmpDir, generateRecords(50));
      await writeOffsetIndex(tmpDir, offsetIndex);

      const loaded = await readOffsetIndex(tmpDir);
      expect(loaded.size).toBe(50);
      expect(loaded.get("id-0")).toEqual(offsetIndex.get("id-0"));
      expect(loaded.get("id-49")).toEqual(offsetIndex.get("id-49"));
    });

    it("returns empty map when no index file", async () => {
      const loaded = await readOffsetIndex(tmpDir);
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
      await writeCompactionMeta(tmpDir, meta);

      const loaded = await readCompactionMeta(tmpDir);
      expect(loaded).toEqual(meta);
    });

    it("returns null when no metadata", async () => {
      const loaded = await readCompactionMeta(tmpDir);
      expect(loaded).toBeNull();
    });
  });

  describe("cleanup", () => {
    it("removes old Parquet files but keeps the specified one", async () => {
      // Create two Parquet files (delay to ensure different timestamps)
      const { file: file1 } = await compactToParquet(tmpDir, generateRecords(10));
      await new Promise((r) => setTimeout(r, 10));
      const { file: file2 } = await compactToParquet(tmpDir, generateRecords(20));

      await cleanupOldParquetFiles(tmpDir, file2.path);

      // file2 should still exist (readAll works)
      const records = await readAllFromParquet(tmpDir, file2.path);
      expect(records.size).toBe(20);

      // file1 should be gone
      await expect(readAllFromParquet(tmpDir, file1.path)).rejects.toThrow();
    });
  });

  describe("row group metadata", () => {
    it("provides min/max stats for extracted columns", async () => {
      const { file } = await compactToParquet(tmpDir, generateRecords(100), {
        rowGroupSize: 25,
        extractColumns: ["score"],
      });

      const metadata = await getParquetMetadata(tmpDir, file.path);
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
});
