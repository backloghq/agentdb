/**
 * Tests for Collection.metrics() — filter cache stats, findTruncations,
 * HNSW node count, BM25 segment count, WAL record count, parquet row groups.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDB } from "../src/agentdb.js";
import { defineSchema } from "../src/schema.js";
import type { EmbeddingProvider } from "../src/embeddings/types.js";

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agentdb-metrics-"));
}

/** Deterministic unit-vector embedding provider. */
const hashProvider: EmbeddingProvider = {
  dimensions: 8,
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      let h = 5381;
      for (let i = 0; i < t.length; i++) h = (Math.imul(h, 33) ^ t.charCodeAt(i)) >>> 0;
      let s = h || 1;
      const v = Array.from({ length: 8 }, () => {
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
        return (s >>> 0) / 0x100000000 * 2 - 1;
      });
      const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
      return v.map((x) => x / norm);
    });
  },
};

describe("Collection.metrics()", () => {
  describe("filterCompilations and filterCacheHits", () => {
    it("filterCacheHits >= 4 after 5 identical find() calls (only 1 compilation)", async () => {
      const dir = await makeTmpDir();
      const db = new AgentDB(dir);
      await db.init();
      const col = await db.collection(defineSchema({
        name: "metrics-filter",
        fields: { v: { type: "string" } },
      }));

      for (let i = 0; i < 5; i++) await col.insert({ v: `item ${i}` });

      // Run the same filter 5 times — 1 compilation, 4 hits
      const filter = { v: "item 0" };
      for (let i = 0; i < 5; i++) {
        await col.find({ filter });
      }

      const m = col.metrics();
      expect(m.filterCompilations).toBeGreaterThanOrEqual(1);
      expect(m.filterCacheHits).toBeGreaterThanOrEqual(4);
      // hits > compilations after repeated queries with the same filter
      expect(m.filterCacheHits).toBeGreaterThan(m.filterCompilations);

      await db.close();
      await rm(dir, { recursive: true, force: true });
    });
  });

  describe("findTruncations", () => {
    it("findTruncations equals number of truncated find() calls", async () => {
      const dir = await makeTmpDir();
      const db = new AgentDB(dir);
      await db.init();
      const col = await db.collection("metrics-trunc", { maxFindLimit: 3 });

      for (let i = 0; i < 10; i++) await col.insert({ v: `item ${i}` });

      // Each call requests 100 records but cap is 3 → truncated
      await col.find({ limit: 100 });
      await col.find({ limit: 100 });
      await col.find({ limit: 100 });

      // Non-truncated call (limit <= cap)
      await col.find({ limit: 3 });

      const m = col.metrics();
      expect(m.findTruncations).toBe(3);

      await db.close();
      await rm(dir, { recursive: true, force: true });
    });

    it("findTruncations starts at 0", async () => {
      const dir = await makeTmpDir();
      const db = new AgentDB(dir);
      await db.init();
      const col = await db.collection(defineSchema({
        name: "metrics-trunc0",
        fields: { v: { type: "string" } },
      }));

      expect(col.metrics().findTruncations).toBe(0);

      await db.close();
      await rm(dir, { recursive: true, force: true });
    });
  });

  describe("hnswNodeCount", () => {
    it("hnswNodeCount equals number of embedded records", async () => {
      const dir = await makeTmpDir();
      const N = 10;
      const db = new AgentDB(dir, { embeddings: { provider: hashProvider } });
      await db.init();
      const col = await db.collection(defineSchema({
        name: "metrics-hnsw",
        fields: { body: { type: "string" } },
      }));

      for (let i = 0; i < N; i++) await col.insert({ body: `record ${i} with content` });

      // Trigger embedding
      await col.embedUnembedded();

      const m = col.metrics();
      expect(m.hnswNodeCount).toBe(N);

      await db.close();
      await rm(dir, { recursive: true, force: true });
    });

    it("hnswNodeCount is null when no embedding provider is configured", async () => {
      const dir = await makeTmpDir();
      const db = new AgentDB(dir);
      await db.init();
      const col = await db.collection(defineSchema({
        name: "metrics-noembed",
        fields: { v: { type: "string" } },
      }));

      const m = col.metrics();
      expect(m.hnswNodeCount).toBeNull();

      await db.close();
      await rm(dir, { recursive: true, force: true });
    });
  });

  describe("bm25SegmentCount", () => {
    it("bm25SegmentCount is null when textSearch is not enabled", async () => {
      const dir = await makeTmpDir();
      const db = new AgentDB(dir);
      await db.init();
      const col = await db.collection(defineSchema({
        name: "metrics-nobm25",
        fields: { v: { type: "string" } },
      }));

      expect(col.metrics().bm25SegmentCount).toBeNull();

      await db.close();
      await rm(dir, { recursive: true, force: true });
    });

    it("bm25SegmentCount is a non-negative number when textSearch is enabled", async () => {
      const dir = await makeTmpDir();
      const db = new AgentDB(dir);
      await db.init();
      const col = await db.collection(defineSchema({
        name: "metrics-bm25",
        fields: { title: { type: "string" } },
        textSearch: true,
      }));

      for (let i = 0; i < 5; i++) await col.insert({ title: `document ${i}` });
      // Flush the text index
      await col.rebuildTextIndex();

      const m = col.metrics();
      expect(m.bm25SegmentCount).not.toBeNull();
      expect(m.bm25SegmentCount).toBeGreaterThanOrEqual(0);

      await db.close();
      await rm(dir, { recursive: true, force: true });
    });
  });

  describe("walRecordCount", () => {
    it("walRecordCount reflects current session write count", async () => {
      const dir = await makeTmpDir();
      const db = new AgentDB(dir);
      await db.init();
      const col = await db.collection(defineSchema({
        name: "metrics-wal",
        fields: { v: { type: "string" } },
      }));

      expect(col.metrics().walRecordCount).toBe(0);

      await col.insert({ v: "a" });
      await col.insert({ v: "b" });

      expect(col.metrics().walRecordCount).toBe(2);

      await db.close();
      await rm(dir, { recursive: true, force: true });
    });
  });

  describe("recordCacheFetches / recordCacheHits", () => {
    it("returns null for non-disk collections", async () => {
      const dir = await makeTmpDir();
      const db = new AgentDB(dir);
      await db.init();
      const col = await db.collection(defineSchema({
        name: "metrics-mem",
        fields: { v: { type: "string" } },
        storageMode: "memory",
      }));

      const m = col.metrics();
      expect(m.recordCacheFetches).toBeNull();
      expect(m.recordCacheHits).toBeNull();

      await db.close();
      await rm(dir, { recursive: true, force: true });
    });
  });

  describe("writeMode", () => {
    it("writeMode is 'immediate' by default", async () => {
      const dir = await makeTmpDir();
      const db = new AgentDB(dir);
      await db.init();
      const col = await db.collection(defineSchema({ name: "metrics-wm-default", fields: { v: { type: "string" } } }));
      expect(col.metrics().writeMode).toBe("immediate");
      await db.close();
      await rm(dir, { recursive: true, force: true });
    });

    it("writeMode reflects AgentDBOptions.writeMode when set to 'group'", async () => {
      const dir = await makeTmpDir();
      const db = new AgentDB(dir, { writeMode: "group" });
      await db.init();
      const col = await db.collection(defineSchema({ name: "metrics-wm-group", fields: { v: { type: "string" } } }));
      expect(col.metrics().writeMode).toBe("group");
      await db.close();
      await rm(dir, { recursive: true, force: true });
    });

    // T11: async write mode
    it("writeMode reflects AgentDBOptions.writeMode when set to 'async'", async () => {
      const dir = await makeTmpDir();
      const db = new AgentDB(dir, { writeMode: "async" });
      await db.init();
      const col = await db.collection(defineSchema({ name: "metrics-wm-async", fields: { v: { type: "string" } } }));
      expect(col.metrics().writeMode).toBe("async");
      await db.close();
      await rm(dir, { recursive: true, force: true });
    });
  });

  describe("bm25DocCount and bm25NeedsMerge", () => {
    it("bm25DocCount and bm25NeedsMerge are null when textSearch is not enabled", async () => {
      const dir = await makeTmpDir();
      const db = new AgentDB(dir);
      await db.init();
      const col = await db.collection(defineSchema({ name: "metrics-bm25null", fields: { v: { type: "string" } } }));
      expect(col.metrics().bm25DocCount).toBeNull();
      expect(col.metrics().bm25NeedsMerge).toBeNull();
      await db.close();
      await rm(dir, { recursive: true, force: true });
    });

    it("bm25DocCount is a non-negative number and bm25NeedsMerge is boolean when textSearch is enabled", async () => {
      const dir = await makeTmpDir();
      const db = new AgentDB(dir);
      await db.init();
      const col = await db.collection(defineSchema({
        name: "metrics-bm25count",
        fields: { title: { type: "string" } },
        textSearch: true,
      }));
      for (let i = 0; i < 5; i++) await col.insert({ title: `document ${i}` });
      await col.rebuildTextIndex(); // forces flush to segments

      const m = col.metrics();
      expect(m.bm25DocCount).not.toBeNull();
      expect(m.bm25DocCount).toBeGreaterThanOrEqual(0);
      expect(typeof m.bm25NeedsMerge).toBe("boolean");

      await db.close();
      await rm(dir, { recursive: true, force: true });
    });

    it("bm25NeedsMerge is false when only one segment exists", async () => {
      const dir = await makeTmpDir();
      const db = new AgentDB(dir);
      await db.init();
      const col = await db.collection(defineSchema({
        name: "metrics-bm25single",
        fields: { title: { type: "string" } },
        textSearch: true,
      }));
      for (let i = 0; i < 3; i++) await col.insert({ title: `doc ${i}` });
      await col.rebuildTextIndex(); // produces exactly 1 segment (full rebuild from scratch)

      const m = col.metrics();
      // After rebuildTextIndex: at most 1 segment → no merge pending
      expect(m.bm25SegmentCount).toBeLessThanOrEqual(1);
      expect(m.bm25NeedsMerge).toBe(false);

      await db.close();
      await rm(dir, { recursive: true, force: true });
    });

    // T12: bm25NeedsMerge: true — produce >1 segment by flushing twice without a merge/rebuild
    it("bm25NeedsMerge is true when multiple segments exist (T12)", async () => {
      const dir = await makeTmpDir();
      const db = new AgentDB(dir);
      await db.init();
      const col = await db.collection(defineSchema({
        name: "metrics-bm25multi",
        fields: { title: { type: "string" } },
        textSearch: true,
      }));

      // First batch: insert → flush → segment 1
      for (let i = 0; i < 3; i++) await col.insert({ title: `batch-one doc ${i}` });
      const textIdx = col.getTextIndex();
      if (!textIdx) throw new Error("textIdx should be non-null when textSearch is enabled");
      await textIdx.flush();

      // Second batch: insert → flush → segment 2
      for (let i = 0; i < 3; i++) await col.insert({ title: `batch-two doc ${i}` });
      await textIdx.flush();

      const m = col.metrics();
      // Two flushes without a merge → segmentCount > 1 → bm25NeedsMerge true
      expect(m.bm25SegmentCount).toBeGreaterThan(1);
      expect(m.bm25NeedsMerge).toBe(true);

      await db.close();
      await rm(dir, { recursive: true, force: true });
    });
  });

  describe("parquetRowGroups", () => {
    it("parquetRowGroups is null for memory-mode collections", async () => {
      const dir = await makeTmpDir();
      const db = new AgentDB(dir);
      await db.init();
      const col = await db.collection(defineSchema({
        name: "metrics-pq-mem",
        fields: { v: { type: "string" } },
        storageMode: "memory",
      }));

      expect(col.metrics().parquetRowGroups).toBeNull();

      await db.close();
      await rm(dir, { recursive: true, force: true });
    });

    it("parquetRowGroups is a number after disk compaction", async () => {
      const schema = defineSchema({
        name: "metrics-pq-disk",
        fields: { v: { type: "string" } },
        storageMode: "disk",
      });

      // Session 1: write and close to trigger compaction
      const dir1 = await makeTmpDir();
      let db = new AgentDB(dir1);
      await db.init();
      let col = await db.collection(schema);
      for (let i = 0; i < 5; i++) await col.insert({ v: `item ${i}` });
      await db.close();

      // Session 2: reopen — compactionMeta now populated
      db = new AgentDB(dir1);
      await db.init();
      col = await db.collection(schema);

      const m = col.metrics();
      expect(m.parquetRowGroups).not.toBeNull();
      expect(m.parquetRowGroups).toBeGreaterThanOrEqual(1);

      await db.close();
      await rm(dir1, { recursive: true, force: true });
    });
  });
});
