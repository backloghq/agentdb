import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDB } from "../src/agentdb.js";
import { defineSchema } from "../src/schema.js";
import type { EmbeddingProvider } from "../src/embeddings/types.js";

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agentdb-diskembed-"));
}

// Deterministic hash-based provider — 32 dimensions, xorshift PRNG per text for well-separated vectors
class HashProvider implements EmbeddingProvider {
  readonly dimensions = 32;
  readonly calls: string[][] = [];

  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push(texts);
    return texts.map((t) => {
      // djb2 hash
      let h = 5381;
      for (let i = 0; i < t.length; i++) h = (Math.imul(h, 33) ^ t.charCodeAt(i)) >>> 0;
      // Seed xorshift32 with h, generate independent dimensions
      let s = h || 1;
      const vec = Array.from({ length: this.dimensions }, () => {
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
        return (s >>> 0) / 0x100000000 * 2 - 1;
      });
      const norm = Math.sqrt(vec.reduce((a, v) => a + v * v, 0)) || 1;
      return vec.map((v) => v / norm);
    });
  }
}

describe("embedUnembedded — batching (#154)", () => {
  it("600 records with batchSize 256 triggers exactly 3 provider calls", async () => {
    const dir = await makeTmpDir();
    const provider = new HashProvider();
    const db = new AgentDB(dir, {
      embeddings: { provider },
    });
    await db.init();

    const schema = defineSchema({
      name: "batch600",
      fields: { title: { type: "string" } },
      embeddingBatchSize: 256,
    });
    const col = await db.collection(schema);

    for (let i = 0; i < 600; i++) {
      await col.insert({ _id: `d${i}`, title: `document number ${i}` });
    }

    provider.calls.length = 0;
    const count = await col.embedUnembedded();
    expect(count).toBe(600);
    // 256 + 256 + 88 = 3 batches
    expect(provider.calls.length).toBe(3);
    expect(provider.calls[0].length).toBe(256);
    expect(provider.calls[1].length).toBe(256);
    expect(provider.calls[2].length).toBe(88);

    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("second batch throws — first and third batches succeed, total embedded = 344", async () => {
    const dir = await makeTmpDir();
    let callCount = 0;
    const flakyProvider: EmbeddingProvider = {
      dimensions: 32,
      async embed(texts: string[]): Promise<number[][]> {
        callCount++;
        if (callCount === 2) throw new Error("rate limit");
        return texts.map((t) => {
          let h = 5381;
          for (let i = 0; i < t.length; i++) h = (Math.imul(h, 33) ^ t.charCodeAt(i)) >>> 0;
          let s = h || 1;
          const vec = Array.from({ length: 32 }, () => {
            s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
            return (s >>> 0) / 0x100000000 * 2 - 1;
          });
          const norm = Math.sqrt(vec.reduce((a, v) => a + v * v, 0)) || 1;
          return vec.map((v) => v / norm);
        });
      },
    };

    const db = new AgentDB(dir, { embeddings: { provider: flakyProvider } });
    await db.init();

    const schema = defineSchema({
      name: "flaky600",
      fields: { title: { type: "string" } },
      embeddingBatchSize: 256,
    });
    const col = await db.collection(schema);
    for (let i = 0; i < 600; i++) {
      await col.insert({ _id: `d${i}`, title: `document number ${i}` });
    }

    // Second batch (256..511) throws; first (0..255) and third (512..599) succeed
    const count = await col.embedUnembedded();
    expect(count).toBe(344); // 256 + 88

    // HNSW has 344 entries (first + third batches)
    const result = await col.semanticSearch("document number 0", { limit: 5 });
    expect(result.records.length).toBeGreaterThan(0);

    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("embeddingBatchSize: 100 triggers 6 provider calls for 600 records", async () => {
    const dir = await makeTmpDir();
    const provider = new HashProvider();
    const db = new AgentDB(dir, { embeddings: { provider } });
    await db.init();

    const schema = defineSchema({
      name: "batch100",
      fields: { title: { type: "string" } },
      embeddingBatchSize: 100,
    });
    const col = await db.collection(schema);
    for (let i = 0; i < 600; i++) {
      await col.insert({ _id: `d${i}`, title: `record ${i}` });
    }

    provider.calls.length = 0;
    const count = await col.embedUnembedded();
    expect(count).toBe(600);
    expect(provider.calls.length).toBe(6);
    for (const call of provider.calls) {
      expect(call.length).toBe(100);
    }

    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
});

describe("embedUnembedded — durable disk embedding (N > cacheSize) (#153 + #160)", () => {
  it("1000 disk records with cacheSize=100 — all embeddings survive close/reopen", async () => {
    const dir = await makeTmpDir();
    const N = 1000;

    const schema = defineSchema({
      name: "durable",
      fields: { title: { type: "string" } },
    });

    // Phase 1: insert without provider — compacts to disk without _embedding
    {
      const db = new AgentDB(dir, { storageMode: "disk", cacheSize: N });
      await db.init();
      const col = await db.collection(schema);
      for (let i = 0; i < N; i++) {
        await col.insert({ _id: `d${i}`, title: `topic number ${i} unique content here` });
      }
      await db.close();
    }

    // Phase 2: reopen with provider + small cache (forces eviction)
    const provider = new HashProvider();
    {
      const db = new AgentDB(dir, { storageMode: "disk", cacheSize: 100, embeddings: { provider } });
      await db.init();
      const col = await db.collection(schema);

      const count = await col.embedUnembedded();
      expect(count).toBe(N);

      // Idempotency: second call must find nothing to embed
      const count2 = await col.embedUnembedded();
      expect(count2).toBe(0);

      await db.close();
    }

    // Phase 3: reopen — HNSW rebuilt from disk embeddings; semantic search must find records
    {
      const db = new AgentDB(dir, { storageMode: "disk", cacheSize: 100, embeddings: { provider } });
      await db.init();
      const col = await db.collection(schema);

      // Run 50 distinct queries — each targets a specific record title
      let hits = 0;
      const QUERIES = 50;
      for (let i = 0; i < QUERIES; i++) {
        const targetId = `d${i * 20}`; // spread evenly across 1000
        const title = `topic number ${i * 20} unique content here`;
        const result = await col.semanticSearch(title, { limit: 5 });
        if (result.records.some((r) => r._id === targetId)) hits++;
      }

      // ≥95% of queries must return the expected record (HNSW recall)
      expect(hits).toBeGreaterThanOrEqual(Math.floor(QUERIES * 0.95));

      await db.close();
    }

    await rm(dir, { recursive: true, force: true });
  });

  it("partial embed survives mid-run (durable per batch)", async () => {
    const dir = await makeTmpDir();
    const N = 300;

    const schema = defineSchema({
      name: "partial",
      fields: { title: { type: "string" } },
    });

    // Insert without provider
    {
      const db = new AgentDB(dir, { storageMode: "disk", cacheSize: N });
      await db.init();
      const col = await db.collection(schema);
      for (let i = 0; i < N; i++) {
        await col.insert({ _id: `p${i}`, title: `doc ${i}` });
      }
      await db.close();
    }

    // Embed with a provider that throws on batches > 1 (simulates abort after first batch)
    let batchesDone = 0;
    const partialProvider: EmbeddingProvider = {
      dimensions: 32,
      async embed(texts: string[]): Promise<number[][]> {
        batchesDone++;
        if (batchesDone > 1) throw new Error("abort");
        return texts.map((t) => {
          let h = 5381;
          for (let i = 0; i < t.length; i++) h = (Math.imul(h, 33) ^ t.charCodeAt(i)) >>> 0;
          let s = h || 1;
          const vec = Array.from({ length: 32 }, () => {
            s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
            return (s >>> 0) / 0x100000000 * 2 - 1;
          });
          const norm = Math.sqrt(vec.reduce((a, v) => a + v * v, 0)) || 1;
          return vec.map((v) => v / norm);
        });
      },
    };

    {
      const db = new AgentDB(dir, { storageMode: "disk", cacheSize: 100, embeddings: { provider: partialProvider } });
      await db.init();
      const col = await db.collection(schema);
      // embeddingBatchSize defaults to 256 — with 300 records: first batch (256) succeeds, second throws
      const count = await col.embedUnembedded();
      expect(count).toBe(256); // only first batch completed
      await db.close();
    }

    // Reopen — 256 records have durable embeddings, 44 do not
    const provider2 = new HashProvider();
    {
      const db = new AgentDB(dir, { storageMode: "disk", cacheSize: 100, embeddings: { provider: provider2 } });
      await db.init();
      const col = await db.collection(defineSchema({ name: "partial", fields: { title: { type: "string" } } }));
      // Second embedUnembedded: only the remaining 44 need embedding
      const remaining = await col.embedUnembedded();
      expect(remaining).toBe(44);
      await db.close();
    }

    await rm(dir, { recursive: true, force: true });
  });
});
