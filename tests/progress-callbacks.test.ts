/**
 * Progress callback and AbortSignal tests for reembedAll, rebuildTextIndex, find, and AgentDB.import.
 * Verifies: spy called, monotonic completed, correct final value, correct phase, abort semantics.
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDB } from "../src/agentdb.js";
import { defineSchema } from "../src/schema.js";
import type { EmbeddingProvider } from "../src/embeddings/types.js";
import type { ProgressEvent } from "../src/collection.js";

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agentdb-progress-"));
}

/** Simple deterministic embedding provider — unique unit vector per text via hash. */
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

describe("Progress callbacks", () => {
  describe("reembedAll onProgress (WAL-only)", () => {
    it("fires monotonically with correct total and final completed equals record count", async () => {
      const dir = await makeTmpDir();
      const N = 30;
      const BATCH = 10; // embeddingBatchSize: 10 → 3 batches for 30 records

      const db = new AgentDB(dir, {
        embeddings: { provider: hashProvider },
        embeddingBatchSize: BATCH,
      });
      await db.init();
      const schema = defineSchema({ name: "re-progress", fields: { body: { type: "string" } } });
      const col = await db.collection(schema);

      for (let i = 0; i < N; i++) {
        await col.insert({ body: `record ${i} with some content` });
      }

      const events: ProgressEvent[] = [];
      const spy = vi.fn((e: ProgressEvent) => { events.push({ ...e }); });

      const result = await col.reembedAll({ onProgress: spy });

      expect(result.embedded).toBe(N);
      expect(spy).toHaveBeenCalled();

      // All events in WAL phase
      expect(events.every((e) => e.phase === "wal")).toBe(true);

      // completed is monotonically non-decreasing
      for (let i = 1; i < events.length; i++) {
        expect(events[i].completed).toBeGreaterThanOrEqual(events[i - 1].completed);
      }

      // total is N for all WAL events (known upfront)
      expect(events.every((e) => e.total === N)).toBe(true);

      // Final event has completed === N
      expect(events[events.length - 1].completed).toBe(N);

      await db.close();
      await rm(dir, { recursive: true, force: true });
    });

    it("fires ceil(N/batchSize) times for N WAL records", async () => {
      const dir = await makeTmpDir();
      const N = 25;
      const BATCH = 10; // ceil(25/10) = 3 batches

      const db = new AgentDB(dir, {
        embeddings: { provider: hashProvider },
        embeddingBatchSize: BATCH,
      });
      await db.init();
      const col = await db.collection(defineSchema({ name: "re-count", fields: { v: { type: "string" } } }));

      for (let i = 0; i < N; i++) await col.insert({ v: `item ${i} text` });

      const spy = vi.fn();
      await col.reembedAll({ onProgress: spy });

      expect(spy).toHaveBeenCalledTimes(Math.ceil(N / BATCH));

      await db.close();
      await rm(dir, { recursive: true, force: true });
    });
  });

  describe("rebuildTextIndex onProgress", () => {
    it("fires once per indexed record with phase=rebuilding and correct totals", async () => {
      const dir = await makeTmpDir();
      const N = 20;

      const db = new AgentDB(dir);
      await db.init();
      const col = await db.collection(defineSchema({
        name: "rebuild-progress",
        fields: { title: { type: "string" } },
        textSearch: true,
      }));

      for (let i = 0; i < N; i++) await col.insert({ title: `doc ${i} searchable` });

      const events: ProgressEvent[] = [];
      const spy = vi.fn((e: ProgressEvent) => { events.push({ ...e }); });

      const count = await col.rebuildTextIndex({ onProgress: spy });

      expect(count).toBe(N);
      expect(spy).toHaveBeenCalledTimes(N);

      // All events in rebuilding phase
      expect(events.every((e) => e.phase === "rebuilding")).toBe(true);

      // total is N for all events (records array length is known before loop)
      expect(events.every((e) => e.total === N)).toBe(true);

      // completed increments 1, 2, 3, ..., N
      for (let i = 0; i < events.length; i++) {
        expect(events[i].completed).toBe(i + 1);
      }

      await db.close();
      await rm(dir, { recursive: true, force: true });
    });
  });

  describe("AgentDB.import onProgress", () => {
    it("fires once per inserted record with phase=importing and correct totals", async () => {
      const dir = await makeTmpDir();
      const N = 15;

      const db = new AgentDB(dir);
      await db.init();

      const importData = {
        version: 1,
        exportedAt: new Date().toISOString(),
        collections: {
          items: {
            records: Array.from({ length: N }, (_, i) => ({
              _id: `item-${i}`,
              name: `Item ${i}`,
            })),
          },
        },
      };

      const events: ProgressEvent[] = [];
      const spy = vi.fn((e: ProgressEvent) => { events.push({ ...e }); });

      const result = await db.import(importData, { onProgress: spy });

      expect(result.records).toBe(N);
      expect(spy).toHaveBeenCalledTimes(N);

      // All events in importing phase
      expect(events.every((e) => e.phase === "importing")).toBe(true);

      // total is N (grandTotal known upfront from payload)
      expect(events.every((e) => e.total === N)).toBe(true);

      // completed increments 1 through N
      for (let i = 0; i < events.length; i++) {
        expect(events[i].completed).toBe(i + 1);
      }

      await db.close();
      await rm(dir, { recursive: true, force: true });
    });

    it("total spans all collections when import has multiple collections", async () => {
      const dir = await makeTmpDir();

      const db = new AgentDB(dir);
      await db.init();

      const importData = {
        version: 1,
        exportedAt: new Date().toISOString(),
        collections: {
          col_a: { records: [{ _id: "a1", v: 1 }, { _id: "a2", v: 2 }] },
          col_b: { records: [{ _id: "b1", v: 3 }] },
        },
      };

      const totals: (number | null)[] = [];
      await db.import(importData, {
        onProgress: (e) => totals.push(e.total),
      });

      // grandTotal = 2 + 1 = 3, so every event has total=3
      expect(totals).toHaveLength(3);
      expect(totals.every((t) => t === 3)).toBe(true);

      await db.close();
      await rm(dir, { recursive: true, force: true });
    });
  });

  describe("AbortSignal — reembedAll", () => {
    it("returns aborted:true with partial count when signal fires mid-run", async () => {
      const dir = await makeTmpDir();
      const N = 50;
      const BATCH = 10; // 5 batches total; abort after first

      const db = new AgentDB(dir, {
        embeddings: { provider: hashProvider },
        embeddingBatchSize: BATCH,
      });
      await db.init();
      const col = await db.collection(defineSchema({
        name: "abort-reembed",
        fields: { body: { type: "string" } },
      }));
      for (let i = 0; i < N; i++) await col.insert({ body: `record ${i} some text` });

      const controller = new AbortController();
      const result = await col.reembedAll({
        signal: controller.signal,
        onProgress: (e) => {
          // Abort after the first batch completes — next iteration check stops the loop
          if (e.completed >= BATCH) controller.abort();
        },
      });

      expect(result.aborted).toBe(true);
      expect(result.embedded).toBeGreaterThanOrEqual(BATCH);
      expect(result.embedded).toBeLessThan(N);

      await db.close();
      await rm(dir, { recursive: true, force: true });
    });

    it("returns aborted:true immediately when signal is already aborted", async () => {
      const dir = await makeTmpDir();

      const db = new AgentDB(dir, { embeddings: { provider: hashProvider } });
      await db.init();
      const col = await db.collection(defineSchema({
        name: "abort-pre",
        fields: { v: { type: "string" } },
      }));
      for (let i = 0; i < 10; i++) await col.insert({ v: `text ${i}` });

      const controller = new AbortController();
      controller.abort(); // abort before calling

      const result = await col.reembedAll({ signal: controller.signal });
      expect(result.aborted).toBe(true);
      expect(result.embedded).toBe(0);

      await db.close();
      await rm(dir, { recursive: true, force: true });
    });
  });

  describe("AbortSignal — rebuildTextIndex", () => {
    it("throws DOMException AbortError when signal is aborted during rebuild", async () => {
      const dir = await makeTmpDir();
      const N = 20;

      const db = new AgentDB(dir);
      await db.init();
      const col = await db.collection(defineSchema({
        name: "abort-rebuild",
        fields: { title: { type: "string" } },
        textSearch: true,
      }));
      for (let i = 0; i < N; i++) await col.insert({ title: `doc ${i}` });

      const controller = new AbortController();
      // Abort after 1 record indexed — signal fires inside the per-record loop
      let abortFired = false;
      const err = await col.rebuildTextIndex({
        signal: controller.signal,
        onProgress: () => {
          if (!abortFired) {
            abortFired = true;
            controller.abort();
          }
        },
      }).catch((e) => e);

      expect(err).toBeInstanceOf(DOMException);
      expect((err as DOMException).name).toBe("AbortError");

      await db.close();
      await rm(dir, { recursive: true, force: true });
    });

    it("concurrent inserts during rebuild are captured in the new index (R6/1)", async () => {
      // Shadow-write: textIndexAdd/Remove forward to _rebuildingIdx during rebuild,
      // so records inserted while the loop is running land in the new index before swap.
      const dir = await makeTmpDir();
      const N = 20; // enough records to create async yield points between each newIdx.add call

      const db = new AgentDB(dir);
      await db.init();
      const col = await db.collection(defineSchema({
        name: "concurrent-rebuild",
        fields: { title: { type: "string" } },
        textSearch: true,
      }));
      for (let i = 0; i < N; i++) await col.insert({ title: `pre-existing doc ${i}` });

      // Fire a concurrent insert from inside the onProgress callback.
      // The callback is not awaited by the rebuild loop, so the insert runs asynchronously
      // during the next yield (newIdx.add call). The shadow-write mechanism routes it to
      // both the old textIdx and the _rebuildingIdx (= newIdx) so it ends up in the new index.
      let concurrentInsertPromise: Promise<string> | null = null;
      let callbackFired = false;
      await col.rebuildTextIndex({
        onProgress: () => {
          if (!callbackFired) {
            callbackFired = true;
            concurrentInsertPromise = col.insert({ title: "concurrent-unique-beacon" });
          }
        },
      });
      // Ensure the concurrent insert has fully completed before querying.
      await concurrentInsertPromise;

      // The record must be findable in the new index after the rebuild swap.
      const results = await col.bm25Search("concurrent-unique-beacon");
      expect(results.records.length).toBeGreaterThan(0);
      expect(results.records[0].title).toBe("concurrent-unique-beacon");

      await db.close();
      await rm(dir, { recursive: true, force: true });
    });

    it("bm25Search during rebuildTextIndex does not throw (R6/3 no-throw guarantee)", async () => {
      // While a rebuildTextIndex is in flight, a concurrent bm25Search must never throw.
      // It reads from the old textIdx (still open) and may return stale results, but
      // crashing the search caller would be a contract violation.
      const dir = await makeTmpDir();
      const N = 20;

      const db = new AgentDB(dir);
      await db.init();
      const col = await db.collection(defineSchema({
        name: "concurrent-search",
        fields: { title: { type: "string" } },
        textSearch: true,
      }));
      for (let i = 0; i < N; i++) await col.insert({ title: `findme ${i}` });

      let searchResultOrError: unknown = undefined;
      let searchFired = false;
      await col.rebuildTextIndex({
        onProgress: () => {
          if (!searchFired) {
            searchFired = true;
            // Fire bm25Search concurrently — must not throw, result may be stale.
            searchResultOrError = col.bm25Search("findme").catch((e: unknown) => e);
          }
        },
      });

      // Wait for the concurrent search to settle.
      if (searchResultOrError instanceof Promise) {
        searchResultOrError = await searchResultOrError;
      }

      // The search must NOT have produced an Error/rejection.
      expect(searchResultOrError).not.toBeInstanceOf(Error);
      // And it must look like a valid search result (has a records array).
      expect(searchResultOrError).toHaveProperty("records");

      await db.close();
      await rm(dir, { recursive: true, force: true });
    });

    it("snapshot-then-swap: abort preserves the original index (not empty)", async () => {
      // Verify that aborting rebuildTextIndex mid-run does NOT destroy the existing text index.
      // The collection must still be able to bm25Search using the pre-abort index.
      const dir = await makeTmpDir();
      const N = 20;

      const db = new AgentDB(dir);
      await db.init();
      const col = await db.collection(defineSchema({
        name: "abort-preserve",
        fields: { title: { type: "string" } },
        textSearch: true,
      }));
      for (let i = 0; i < N; i++) await col.insert({ title: `doc ${i}` });

      // Initial rebuild to populate a known-good index.
      const initialCount = await col.rebuildTextIndex();
      expect(initialCount).toBe(N);

      // Sanity: search works before abort.
      const before = await col.bm25Search("doc");
      expect(before.records.length).toBeGreaterThan(0);

      // Abort the second rebuild after the first record is indexed.
      const controller = new AbortController();
      let abortFired = false;
      const err = await col.rebuildTextIndex({
        signal: controller.signal,
        onProgress: () => {
          if (!abortFired) {
            abortFired = true;
            controller.abort();
          }
        },
      }).catch((e) => e);

      expect(err).toBeInstanceOf(DOMException);
      expect((err as DOMException).name).toBe("AbortError");

      // The original index must still be intact: search returns results.
      const after = await col.bm25Search("doc");
      expect(after.records.length).toBeGreaterThan(0);

      await db.close();
      await rm(dir, { recursive: true, force: true });
    });
  });

  describe("AbortSignal — find (disk path)", () => {
    it("returns truncated:true when signal is aborted during full disk scan", async () => {
      const dir = await makeTmpDir();
      const N = 10;
      const schema = defineSchema({
        name: "abort-find",
        fields: { v: { type: "string" } },
        storageMode: "disk",
      });

      // Session 1: write records and close to trigger Parquet compaction
      let db = new AgentDB(dir);
      await db.init();
      let col = await db.collection(schema);
      for (let i = 0; i < N; i++) await col.insert({ v: `item ${i}` });
      await db.close();

      // Session 2: reopen — records are now in Parquet (hasParquetData=true)
      db = new AgentDB(dir);
      await db.init();
      col = await db.collection(schema);

      const controller = new AbortController();
      controller.abort(); // already aborted — disk scan check fires immediately

      const result = await col.find({ signal: controller.signal, limit: 100 });
      // WAL is empty (new session), disk scan was aborted → truncated=true
      expect(result.truncated).toBe(true);

      await db.close();
      await rm(dir, { recursive: true, force: true });
    });
  });

  describe("Empty-collection edge cases (T11)", () => {
    it("reembedAll on empty collection: spy not called, embedded=0, aborted=false", async () => {
      const dir = await makeTmpDir();
      const db = new AgentDB(dir, { embeddings: { provider: hashProvider } });
      await db.init();
      const col = await db.collection(defineSchema({ name: "empty-reembed", fields: { v: { type: "string" } } }));
      // No inserts — collection is empty
      const spy = vi.fn();
      const result = await col.reembedAll({ onProgress: spy });
      expect(spy).not.toHaveBeenCalled();
      expect(result.embedded).toBe(0);
      expect(result.aborted).toBeFalsy();
      await db.close();
      await rm(dir, { recursive: true, force: true });
    });

    it("db.import on empty payload: spy not called, records=0", async () => {
      const dir = await makeTmpDir();
      const db = new AgentDB(dir);
      await db.init();
      const spy = vi.fn();
      const result = await db.import(
        { version: 1, exportedAt: new Date().toISOString(), collections: { items: { records: [] } } },
        { onProgress: spy },
      );
      expect(spy).not.toHaveBeenCalled();
      expect(result.records).toBe(0);
      await db.close();
      await rm(dir, { recursive: true, force: true });
    });
  });

  describe("AbortSignal after resolve (T12)", () => {
    it("aborting the controller after reembedAll resolves does not set aborted:true", async () => {
      const dir = await makeTmpDir();
      const db = new AgentDB(dir, { embeddings: { provider: hashProvider } });
      await db.init();
      const col = await db.collection(defineSchema({ name: "abort-after", fields: { v: { type: "string" } } }));
      for (let i = 0; i < 5; i++) await col.insert({ v: `text ${i}` });

      const controller = new AbortController();
      const result = await col.reembedAll({ signal: controller.signal });
      // Abort AFTER the promise already resolved
      controller.abort();
      // Result was already determined — must not be retroactively marked aborted
      expect(result.aborted).toBeFalsy();
      expect(result.embedded).toBe(5);
      await db.close();
      await rm(dir, { recursive: true, force: true });
    });
  });
});
