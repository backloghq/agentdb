/**
 * Progress callback tests for reembedAll, rebuildTextIndex, and AgentDB.import.
 * Verifies: spy called, monotonic completed, correct final value, correct phase.
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
});
