/**
 * Tests for HNSW M/efConstruction/efSearch/maxLevel exposure via CollectionOptions and AgentDBOptions.
 * Verifies: config getters, per-collection override, db-wide default, Collection.getHnswIndex().
 *
 * Task 302 tests appended: HNSW remove on delete + text-change.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDB } from "../src/agentdb.js";
import { defineSchema } from "../src/schema.js";
import { HnswIndex } from "../src/hnsw.js";
import type { EmbeddingProvider } from "../src/embeddings/types.js";

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agentdb-hnsw-opts-"));
}

/** Minimal deterministic embedding provider — dim 8. */
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

describe("HNSW options exposure", () => {
  describe("HnswIndex config getters", () => {
    it("configM / configEfConstruction / configEfSearch / configMaxLevel reflect constructor args", async () => {
      const { HnswIndex } = await import("../src/hnsw.js");
      const idx = new HnswIndex({ dimensions: 8, M: 8, efConstruction: 150, efSearch: 40 });
      expect(idx.configM).toBe(8);
      expect(idx.configEfConstruction).toBe(150);
      expect(idx.configEfSearch).toBe(40);
      // maxLevelCap: max(16, floor(log(1e6)/log(8))) = max(16, 6) = 16
      expect(idx.configMaxLevel).toBe(16);
    });

    it("config getters return defaults when not specified", async () => {
      const { HnswIndex } = await import("../src/hnsw.js");
      const idx = new HnswIndex({ dimensions: 16 });
      expect(idx.configM).toBe(16);
      expect(idx.configEfConstruction).toBe(200);
      expect(idx.configEfSearch).toBe(50);
      // maxLevelCap: max(16, floor(log(1e6)/log(16))) = max(16, 4) = 16
      expect(idx.configMaxLevel).toBe(16);
    });

    it("explicit maxLevel is stored in configMaxLevel", async () => {
      const { HnswIndex } = await import("../src/hnsw.js");
      const idx = new HnswIndex({ dimensions: 8, maxLevel: 5 });
      expect(idx.configMaxLevel).toBe(5);
    });
  });

  describe("Collection.getHnswIndex() and per-collection hnsw option", () => {
    it("getHnswIndex returns null when no embedding provider is set", async () => {
      const dir = await makeTmpDir();
      const db = new AgentDB(dir);
      await db.init();
      const col = await db.collection(defineSchema({ name: "no-embed", fields: { v: { type: "string" } } }));
      expect(col.getHnswIndex()).toBeNull();
      await db.close();
      await rm(dir, { recursive: true, force: true });
    });

    it("getHnswIndex returns index with default config when hnsw option not set", async () => {
      const dir = await makeTmpDir();
      const db = new AgentDB(dir, { embeddings: { provider: hashProvider } });
      await db.init();
      const col = await db.collection(defineSchema({ name: "default-hnsw", fields: { v: { type: "string" } } }));
      const idx = col.getHnswIndex();
      expect(idx).not.toBeNull();
      expect(idx!.configM).toBe(16);
      expect(idx!.configEfConstruction).toBe(200);
      expect(idx!.configEfSearch).toBe(50);
      await db.close();
      await rm(dir, { recursive: true, force: true });
    });

    it("per-collection hnsw option overrides defaults (string name form)", async () => {
      const dir = await makeTmpDir();
      const db = new AgentDB(dir, { embeddings: { provider: hashProvider } });
      await db.init();
      // Use string-name form so colOpts is not discarded by the schema path
      const col = await db.collection("custom-hnsw", { hnsw: { M: 8, efConstruction: 100, efSearch: 30 } });
      const idx = col.getHnswIndex();
      expect(idx).not.toBeNull();
      expect(idx!.configM).toBe(8);
      expect(idx!.configEfConstruction).toBe(100);
      expect(idx!.configEfSearch).toBe(30);
      await db.close();
      await rm(dir, { recursive: true, force: true });
    });

    it("partial per-collection hnsw option only overrides specified fields", async () => {
      const dir = await makeTmpDir();
      const db = new AgentDB(dir, { embeddings: { provider: hashProvider } });
      await db.init();
      // Use string-name form so colOpts is not discarded by the schema path
      const col = await db.collection("partial-hnsw", { hnsw: { efSearch: 80 } });
      const idx = col.getHnswIndex();
      expect(idx).not.toBeNull();
      expect(idx!.configM).toBe(16);          // default
      expect(idx!.configEfConstruction).toBe(200); // default
      expect(idx!.configEfSearch).toBe(80);   // overridden
      await db.close();
      await rm(dir, { recursive: true, force: true });
    });
  });

  describe("AgentDB-level hnsw default", () => {
    it("db-wide hnsw option propagates to all collections", async () => {
      const dir = await makeTmpDir();
      const db = new AgentDB(dir, {
        embeddings: { provider: hashProvider },
        hnsw: { M: 8, efSearch: 100 },
      });
      await db.init();

      const colA = await db.collection(defineSchema({ name: "db-hnsw-a", fields: { v: { type: "string" } } }));
      const colB = await db.collection(defineSchema({ name: "db-hnsw-b", fields: { v: { type: "string" } } }));

      const idxA = colA.getHnswIndex();
      const idxB = colB.getHnswIndex();

      expect(idxA!.configM).toBe(8);
      expect(idxA!.configEfSearch).toBe(100);
      expect(idxB!.configM).toBe(8);
      expect(idxB!.configEfSearch).toBe(100);

      await db.close();
      await rm(dir, { recursive: true, force: true });
    });

    it("per-collection hnsw wins over db-wide default", async () => {
      const dir = await makeTmpDir();
      const db = new AgentDB(dir, {
        embeddings: { provider: hashProvider },
        hnsw: { M: 8, efSearch: 100 },
      });
      await db.init();

      // colA uses db default (schema form — hnsw not in schema so db default applies)
      const colA = await db.collection(defineSchema({ name: "db-default-a", fields: { v: { type: "string" } } }));
      // colB uses string-name form with explicit hnsw opts to override db default
      const colB = await db.collection("db-override-b", { hnsw: { M: 4, efSearch: 200 } });

      expect(colA.getHnswIndex()!.configM).toBe(8);    // db default
      expect(colA.getHnswIndex()!.configEfSearch).toBe(100); // db default
      expect(colB.getHnswIndex()!.configM).toBe(4);    // per-collection override
      expect(colB.getHnswIndex()!.configEfSearch).toBe(200); // per-collection override

      await db.close();
      await rm(dir, { recursive: true, force: true });
    });
  });

  describe("maxLevel option propagates", () => {
    it("maxLevel from CollectionOptions.hnsw is honored", async () => {
      const dir = await makeTmpDir();
      const db = new AgentDB(dir, { embeddings: { provider: hashProvider } });
      await db.init();
      // Use string-name form so colOpts is not discarded by the schema path
      const col = await db.collection("maxlevel-col", { hnsw: { maxLevel: 5 } });
      const idx = col.getHnswIndex();
      expect(idx!.configMaxLevel).toBe(5);
      await db.close();
      await rm(dir, { recursive: true, force: true });
    });
  });
});

// ---------------------------------------------------------------------------
// Task 302 — HNSW remove on deleteById and text-change update
// ---------------------------------------------------------------------------

describe("Task 302 — HNSW node cleanup on delete and text-change", () => {
  it("deleteById removes the corresponding HNSW node (metrics().hnswNodeCount tracks accurately)", async () => {
    const dir = await makeTmpDir();
    const db = new AgentDB(dir, { embeddings: { provider: hashProvider } });
    await db.init();
    const col = await db.collection(
      defineSchema({ name: "hnsw-del", fields: { title: { type: "string" } } }),
    );

    // Insert 10 records and embed them
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      ids.push(await col.insert({ title: `item ${i}` }));
    }
    await col.embedUnembedded();
    expect((await col.metrics()).hnswNodeCount).toBe(10);

    // Delete 5 — HNSW node count must drop to 5
    for (let i = 0; i < 5; i++) await col.deleteById(ids[i]);
    expect((await col.metrics()).hnswNodeCount).toBe(5);

    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("update text-change removes orphaned HNSW node until re-embedding runs", async () => {
    const dir = await makeTmpDir();
    const db = new AgentDB(dir, { embeddings: { provider: hashProvider } });
    await db.init();
    const col = await db.collection(
      defineSchema({ name: "hnsw-upd", fields: { title: { type: "string" } } }),
    );

    // Insert 5 records and embed them
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await col.insert({ title: `doc ${i}` }));
    }
    await col.embedUnembedded();
    expect((await col.metrics()).hnswNodeCount).toBe(5);

    // Update one record's text — embedding is invalidated, HNSW node must be removed
    await col.update({ _id: ids[0] }, { $set: { title: "completely new text" } });
    expect((await col.metrics()).hnswNodeCount).toBe(4);

    // After re-embedding, the node is re-added (count back to 5)
    await col.embedUnembedded();
    expect((await col.metrics()).hnswNodeCount).toBe(5);

    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trip: delete then re-insert with same id — semantic search returns new vector only", async () => {
    const dir = await makeTmpDir();
    const db = new AgentDB(dir, { embeddings: { provider: hashProvider } });
    await db.init();
    const col = await db.collection(
      defineSchema({ name: "hnsw-roundtrip", fields: { title: { type: "string" } } }),
    );

    const id = await col.insert({ title: "original content" });
    await col.embedUnembedded();
    expect((await col.metrics()).hnswNodeCount).toBe(1);

    // Delete removes from HNSW
    await col.deleteById(id);
    expect((await col.metrics()).hnswNodeCount).toBe(0);

    // Re-insert with same id via upsert + re-embed
    await col.upsert(id, { title: "brand new content" });
    await col.embedUnembedded();
    expect((await col.metrics()).hnswNodeCount).toBe(1);

    // Semantic search should find the new record (not return the old orphaned node)
    const results = await col.semanticSearch("brand new content", { limit: 5 });
    expect(results.records.length).toBeGreaterThan(0);
    expect(results.records[0].title).toBe("brand new content");

    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
});

describe("Task 311 — HNSW determinism via seeded PRNG", () => {
  it("same seed produces identical layer assignments (and identical search ranking) for same insert order", () => {
    // Build two independent indexes with the same seed and identical insert sequences.
    // Layer assignments are determined by randomLevel() calls during add().
    // Because mulberry32 is stateful and deterministic, both indexes must produce
    // the same graph topology and therefore identical search rankings.
    const dims = 4;
    const vectors: Array<{ id: string; vec: number[] }> = [
      { id: "a", vec: [1, 0, 0, 0] },
      { id: "b", vec: [0, 1, 0, 0] },
      { id: "c", vec: [0, 0, 1, 0] },
      { id: "d", vec: [0, 0, 0, 1] },
      { id: "e", vec: [0.7071, 0.7071, 0, 0] },
    ];
    const query = [1, 0.1, 0, 0];

    const buildAndSearch = (seed: number) => {
      const idx = new HnswIndex({ dimensions: dims, M: 4, efConstruction: 20, efSearch: 20, seed });
      for (const { id, vec } of vectors) idx.add(id, vec);
      return idx.search(query, 3).map((r) => r.id);
    };

    const run1 = buildAndSearch(42);
    const run2 = buildAndSearch(42);
    expect(run1).toEqual(run2);
  });

  it("different seeds produce different layer topologies (maxLayer diverges across a large sample)", () => {
    // Two distinct seeds produce different PRNG sequences → different layer assignments.
    // The observable proxy for layer assignment is HnswIndex.currentMaxLayer.
    // With enough inserts, the probability that two different mulberry32 sequences
    // both produce identical max-layer outcomes is negligible.
    // We sweep 10 seed pairs and assert at least one produces a different maxLayer.
    const dims = 4;
    // Deterministic vector source (no Math.random dependency in test body)
    let xs = 0xDEADBEEF;
    const nextF = () => { xs ^= xs << 13; xs ^= xs >>> 17; xs ^= xs << 5; return (xs >>> 0) / 0x100000000; };
    const vectors = Array.from({ length: 200 }, (_, i) => ({
      id: `v${i}`,
      vec: Array.from({ length: dims }, () => nextF() * 2 - 1),
    }));

    const maxLayerForSeed = (seed: number) => {
      const idx = new HnswIndex({ dimensions: dims, M: 4, efConstruction: 10, seed });
      for (const { id, vec } of vectors) idx.add(id, vec);
      return idx.currentMaxLayer;
    };

    // Check 10 seed pairs — expect at least one to diverge
    let anyDiffer = false;
    for (let base = 1; base <= 10; base++) {
      if (maxLayerForSeed(base) !== maxLayerForSeed(base + 100)) {
        anyDiffer = true;
        break;
      }
    }
    expect(anyDiffer).toBe(true);
  });

  it("unseeded index returns plausible results and does not throw", () => {
    const idx = new HnswIndex({ dimensions: 3, M: 4, efConstruction: 10, efSearch: 10 });
    idx.add("x", [1, 0, 0]);
    idx.add("y", [0, 1, 0]);
    idx.add("z", [0, 0, 1]);
    const results = idx.search([1, 0, 0], 2);
    expect(results.length).toBe(2);
    // "x" should be top-1 (closest to [1,0,0])
    expect(results[0].id).toBe("x");
  });
});

// ---------------------------------------------------------------------------
// Task 317 — efSearch recall differential
// ---------------------------------------------------------------------------

describe("Task 317 — efSearch recall differential", () => {
  it("efSearch=5 has measurably worse recall@10 than efSearch=200 on a sparse graph", () => {
    // 1000 random normalized vectors in 32D. Graph built with efConstruction=10
    // (sparse — low-quality neighbor connections). Ground truth by exact cosine search.
    // efSearch=5 → beam width max(5,10)=10; efSearch=200 → beam width 200.
    // Sparse graph means beam width matters: narrow beam misses true neighbors, wide beam finds them.
    // Recall differential must be ≥ 10pp (0.10).
    const DIMS = 32;
    const N_VECS = 1000;
    const N_QUERIES = 50;
    const K = 10;
    const SEED = 42;

    // mulberry32 PRNG — same algorithm as hnsw.ts so inserts are reproducible
    let s = SEED;
    const rng = (): number => {
      s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const normalize = (v: number[]): number[] => {
      const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
      return v.map((x) => x / n);
    };

    // 1000 random normalized vectors (dataset)
    const allVecs: Array<{ id: string; vec: number[] }> = Array.from({ length: N_VECS }, (_, i) =>
      ({ id: `v${i}`, vec: normalize(Array.from({ length: DIMS }, () => rng() * 2 - 1)) }),
    );

    // 50 query vectors (disjoint from dataset — generated after dataset)
    const queries: number[][] = Array.from({ length: N_QUERIES }, () =>
      normalize(Array.from({ length: DIMS }, () => rng() * 2 - 1)),
    );

    const cosine = (a: number[], b: number[]): number =>
      a.reduce((sum, x, i) => sum + x * b[i], 0);

    // Ground truth: exact top-K per query
    const groundTruth: Set<string>[] = queries.map((q) => {
      const scored = allVecs.map((v) => ({ id: v.id, sim: cosine(q, v.vec) }));
      scored.sort((a, b) => b.sim - a.sim);
      return new Set(scored.slice(0, K).map((x) => x.id));
    });

    // Build HNSW with efConstruction=10 (sparse graph) and seed for determinism.
    // Both indexes use the same construction parameters so topology is identical.
    const buildIdx = (efSearch: number): HnswIndex =>
      new HnswIndex({ dimensions: DIMS, M: 8, efConstruction: 10, efSearch, seed: SEED });

    const idxLow  = buildIdx(5);   // efSearch=5  → beam width max(5,10)=10
    const idxHigh = buildIdx(200); // efSearch=200 → beam width 200
    for (const { id, vec } of allVecs) {
      idxLow.add(id, vec);
      idxHigh.add(id, vec);
    }

    // Average recall@K across all queries
    let recallLow = 0;
    let recallHigh = 0;
    for (let qi = 0; qi < N_QUERIES; qi++) {
      const gt = groundTruth[qi];
      const lowHits  = idxLow.search(queries[qi], K).filter((r) => gt.has(r.id)).length;
      const highHits = idxHigh.search(queries[qi], K).filter((r) => gt.has(r.id)).length;
      recallLow  += lowHits  / K;
      recallHigh += highHits / K;
    }
    recallLow  /= N_QUERIES;
    recallHigh /= N_QUERIES;

    // High efSearch must produce meaningfully better recall (≥10pp gap, seed-deterministic)
    expect(recallHigh).toBeGreaterThan(recallLow + 0.10);
    // High efSearch should produce good absolute recall on a sparse graph (≥50%)
    expect(recallHigh).toBeGreaterThanOrEqual(0.50);
  });
});
