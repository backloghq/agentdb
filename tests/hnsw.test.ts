import { describe, it, expect, beforeEach } from "vitest";
import { HnswIndex } from "../src/hnsw.js";

/** Simple seeded PRNG for deterministic tests. */
let seed = 42;
function seededRandom(): number {
  seed = (seed * 1664525 + 1013904223) & 0x7fffffff;
  return seed / 0x7fffffff;
}

/** Generate a random unit vector. */
function randomVector(dim: number): number[] {
  const vec = Array.from({ length: dim }, () => seededRandom() * 2 - 1);
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map((v) => v / norm);
}

/** Brute-force nearest neighbor search for ground truth. */
function bruteForceSearch(
  query: number[],
  vectors: Map<string, number[]>,
  k: number,
): Array<{ id: string; score: number }> {
  const scores: Array<{ id: string; score: number }> = [];
  for (const [id, vec] of vectors) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < query.length; i++) {
      dot += query[i] * vec[i];
      normA += query[i] * query[i];
      normB += vec[i] * vec[i];
    }
    const score = dot / (Math.sqrt(normA) * Math.sqrt(normB));
    scores.push({ id, score });
  }
  scores.sort((a, b) => b.score - a.score);
  return scores.slice(0, k);
}

describe("HnswIndex", () => {
  const DIM = 32;
  let index: HnswIndex;

  beforeEach(() => {
    seed = 42; // Reset seed for deterministic tests
    index = new HnswIndex({ dimensions: DIM, M: 8, efConstruction: 100, efSearch: 30 });
  });

  describe("basic operations", () => {
    it("starts empty", () => {
      expect(index.size).toBe(0);
      expect(index.search(randomVector(DIM), 5)).toEqual([]);
    });

    it("adds and searches a single vector", () => {
      const vec = randomVector(DIM);
      index.add("a", vec);
      expect(index.size).toBe(1);

      const results = index.search(vec, 1);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("a");
      expect(results[0].score).toBeCloseTo(1, 2); // identical vector
    });

    it("finds nearest neighbor among multiple vectors", () => {
      const target = randomVector(DIM);
      // Add 10 random vectors
      for (let i = 0; i < 10; i++) {
        index.add(`v${i}`, randomVector(DIM));
      }
      // Add a very similar vector to target
      const similar = target.map((v) => v + (seededRandom() - 0.5) * 0.01);
      const norm = Math.sqrt(similar.reduce((s, v) => s + v * v, 0));
      index.add("similar", similar.map((v) => v / norm));

      const results = index.search(target, 1);
      expect(results[0].id).toBe("similar");
    });

    it("returns k results", () => {
      for (let i = 0; i < 20; i++) {
        index.add(`v${i}`, randomVector(DIM));
      }
      const results = index.search(randomVector(DIM), 5);
      expect(results).toHaveLength(5);
    });

    it("returns fewer than k if not enough vectors", () => {
      index.add("a", randomVector(DIM));
      index.add("b", randomVector(DIM));
      const results = index.search(randomVector(DIM), 5);
      expect(results).toHaveLength(2);
    });

    it("results are sorted by score descending", () => {
      for (let i = 0; i < 20; i++) {
        index.add(`v${i}`, randomVector(DIM));
      }
      const results = index.search(randomVector(DIM), 10);
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    });
  });

  describe("remove", () => {
    it("removes a vector", () => {
      index.add("a", randomVector(DIM));
      index.add("b", randomVector(DIM));
      expect(index.size).toBe(2);

      index.remove("a");
      expect(index.size).toBe(1);

      const results = index.search(randomVector(DIM), 5);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("b");
    });

    it("handles removing the only vector", () => {
      index.add("a", randomVector(DIM));
      index.remove("a");
      expect(index.size).toBe(0);
      expect(index.search(randomVector(DIM), 5)).toEqual([]);
    });

    it("handles removing non-existent vector", () => {
      index.remove("nonexistent"); // should not throw
      expect(index.size).toBe(0);
    });

    it("re-adding after remove works", () => {
      const vec = randomVector(DIM);
      index.add("a", vec);
      index.remove("a");
      index.add("a", vec);
      expect(index.size).toBe(1);
      const results = index.search(vec, 1);
      expect(results[0].id).toBe("a");
    });
  });

  describe("re-indexing", () => {
    it("re-adding with same id replaces the vector", () => {
      const oldVec = randomVector(DIM);
      const newVec = randomVector(DIM);
      index.add("a", oldVec);
      index.add("a", newVec); // replace

      expect(index.size).toBe(1);
      const results = index.search(newVec, 1);
      expect(results[0].id).toBe("a");
      expect(results[0].score).toBeCloseTo(1, 2);
    });
  });

  describe("validation", () => {
    it("throws on wrong vector dimension", () => {
      expect(() => index.add("a", [1, 2, 3])).toThrow("dimension mismatch");
    });

    it("throws on wrong query dimension", () => {
      index.add("a", randomVector(DIM));
      expect(() => index.search([1, 2, 3], 5)).toThrow("dimension mismatch");
    });
  });

  describe("recall quality", () => {
    it("achieves >70% recall@10 on 500 vectors", () => {
      const vectors = new Map<string, number[]>();
      for (let i = 0; i < 500; i++) {
        const vec = randomVector(DIM);
        vectors.set(`v${i}`, vec);
        index.add(`v${i}`, vec);
      }

      // Test 20 queries
      let totalRecall = 0;
      const numQueries = 20;
      const k = 10;

      for (let q = 0; q < numQueries; q++) {
        const query = randomVector(DIM);
        const hnswResults = new Set(index.search(query, k).map((r) => r.id));
        const bruteResults = new Set(bruteForceSearch(query, vectors, k).map((r) => r.id));

        let hits = 0;
        for (const id of bruteResults) {
          if (hnswResults.has(id)) hits++;
        }
        totalRecall += hits / k;
      }

      const avgRecall = totalRecall / numQueries;
      expect(avgRecall).toBeGreaterThan(0.7);
    });
  });

  describe("performance", () => {
    it("searches 1K vectors in under 20ms", () => {
      const bigIndex = new HnswIndex({ dimensions: DIM, M: 12, efConstruction: 50, efSearch: 30 });
      for (let i = 0; i < 1000; i++) {
        bigIndex.add(`v${i}`, randomVector(DIM));
      }

      const query = randomVector(DIM);
      const start = performance.now();
      bigIndex.search(query, 10);
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(20);
    });
  });
});
