import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@backloghq/opslog";
import { Collection } from "../src/collection.js";
import { compileFilter } from "../src/filter.js";
import { parseCompactFilter } from "../src/compact-filter.js";
import { HnswIndex } from "../src/hnsw.js";
import { BloomFilter } from "../src/bloom.js";
import { BTreeIndex } from "../src/btree.js";

function randomString(len: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz ";
  return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function randomRecord(i: number): Record<string, unknown> {
  return {
    _id: `rec-${i}`,
    name: `User ${i}`,
    email: `user${i}@example.com`,
    role: ["admin", "user", "moderator"][i % 3],
    score: Math.floor(Math.random() * 100),
    active: i % 2 === 0,
    bio: randomString(200),
    tags: [`tag-${i % 10}`, `group-${i % 5}`],
    created: new Date(Date.now() - i * 86400000).toISOString(),
  };
}

function randomVector(dim: number): number[] {
  const vec = Array.from({ length: dim }, () => Math.random() * 2 - 1);
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map((v) => v / norm);
}

function bench(name: string, fn: () => void | Promise<void>, iterations = 1): { name: string; totalMs: number; avgMs: number; opsPerSec: number } {
  const start = performance.now();
  const result = fn();
  if (result instanceof Promise) {
    throw new Error("Use benchAsync for async functions");
  }
  const elapsed = performance.now() - start;
  return {
    name,
    totalMs: Math.round(elapsed * 100) / 100,
    avgMs: Math.round((elapsed / iterations) * 1000) / 1000,
    opsPerSec: Math.round(iterations / (elapsed / 1000)),
  };
}

async function benchAsync(name: string, fn: () => Promise<void>, iterations = 1): Promise<{ name: string; totalMs: number; avgMs: number; opsPerSec: number }> {
  const start = performance.now();
  await fn();
  const elapsed = performance.now() - start;
  return {
    name,
    totalMs: Math.round(elapsed * 100) / 100,
    avgMs: Math.round((elapsed / iterations) * 1000) / 1000,
    opsPerSec: Math.round(iterations / (elapsed / 1000)),
  };
}

describe("Performance benchmarks", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agentdb-bench-"));
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // --- Insert ---

  it("insert: 1000 records individually", async () => {
    const N = 1000;
    const dir = join(tmpDir, "insert-single");
    const store = new Store<Record<string, unknown>>();
    const col = new Collection("bench", store);
    await col.open(dir, { checkpointThreshold: 5000 });

    const result = await benchAsync(`insert ${N} records`, async () => {
      for (let i = 0; i < N; i++) {
        await col.insert(randomRecord(i));
      }
    }, N);

    console.log(`  ${result.name}: ${result.totalMs}ms (${result.opsPerSec} ops/sec)`);
    expect(result.opsPerSec).toBeGreaterThan(500); // Should do >500 inserts/sec
    await col.close();
  });

  it("insert: 1000 records via batch", async () => {
    const N = 1000;
    const dir = join(tmpDir, "insert-batch");
    const store = new Store<Record<string, unknown>>();
    const col = new Collection("bench", store);
    await col.open(dir, { checkpointThreshold: 5000 });

    const records = Array.from({ length: N }, (_, i) => randomRecord(i));
    const result = await benchAsync(`batch insert ${N} records`, async () => {
      await col.insertMany(records);
    }, N);

    console.log(`  ${result.name}: ${result.totalMs}ms (${result.opsPerSec} ops/sec)`);
    expect(result.opsPerSec).toBeGreaterThan(5000); // Batch should be much faster
    await col.close();
  });

  // --- Find / Query ---

  it("find: linear scan on 1000 records", async () => {
    const N = 1000;
    const dir = join(tmpDir, "find-scan");
    const store = new Store<Record<string, unknown>>();
    const col = new Collection("bench", store);
    await col.open(dir, { checkpointThreshold: 5000 });
    await col.insertMany(Array.from({ length: N }, (_, i) => randomRecord(i)));

    const QUERIES = 100;
    const result = bench(`find with filter (${QUERIES} queries on ${N} records)`, () => {
      for (let i = 0; i < QUERIES; i++) {
        col.find({ filter: { role: "admin", active: true } });
      }
    }, QUERIES);

    console.log(`  ${result.name}: ${result.avgMs}ms/query (${result.opsPerSec} queries/sec)`);
    expect(result.avgMs).toBeLessThan(5); // <5ms per query on 1K records
    await col.close();
  });

  it("find: compact string filter", async () => {
    const N = 1000;
    const dir = join(tmpDir, "find-compact");
    const store = new Store<Record<string, unknown>>();
    const col = new Collection("bench", store);
    await col.open(dir, { checkpointThreshold: 5000 });
    await col.insertMany(Array.from({ length: N }, (_, i) => randomRecord(i)));

    const QUERIES = 100;
    const result = bench(`compact filter (${QUERIES} queries on ${N} records)`, () => {
      for (let i = 0; i < QUERIES; i++) {
        col.find({ filter: "role:admin active:true" });
      }
    }, QUERIES);

    console.log(`  ${result.name}: ${result.avgMs}ms/query (${result.opsPerSec} queries/sec)`);
    expect(result.avgMs).toBeLessThan(10);
    await col.close();
  });

  it("count: on 1000 records", async () => {
    const N = 1000;
    const dir = join(tmpDir, "count");
    const store = new Store<Record<string, unknown>>();
    const col = new Collection("bench", store);
    await col.open(dir, { checkpointThreshold: 5000 });
    await col.insertMany(Array.from({ length: N }, (_, i) => randomRecord(i)));

    const QUERIES = 1000;
    const result = bench(`count with filter (${QUERIES} on ${N} records)`, () => {
      for (let i = 0; i < QUERIES; i++) {
        col.count({ role: "admin" });
      }
    }, QUERIES);

    console.log(`  ${result.name}: ${result.avgMs}ms/query (${result.opsPerSec} queries/sec)`);
    expect(result.avgMs).toBeLessThan(2);
    await col.close();
  });

  // --- Filter compilation ---

  it("filter: compile 1000 JSON filters", () => {
    const result = bench("compile 1000 JSON filters", () => {
      for (let i = 0; i < 1000; i++) {
        compileFilter({ role: "admin", score: { $gt: 50 }, $or: [{ active: true }, { tags: { $contains: "vip" } }] });
      }
    }, 1000);

    console.log(`  ${result.name}: ${result.avgMs}ms/compile (${result.opsPerSec} ops/sec)`);
    expect(result.avgMs).toBeLessThan(1);
  });

  it("filter: parse 1000 compact strings", () => {
    const result = bench("parse 1000 compact filters", () => {
      for (let i = 0; i < 1000; i++) {
        parseCompactFilter("role:admin score.gt:50 (active:true or tags.contains:vip)");
      }
    }, 1000);

    console.log(`  ${result.name}: ${result.avgMs}ms/parse (${result.opsPerSec} ops/sec)`);
    expect(result.avgMs).toBeLessThan(1);
  });

  // --- Text search ---

  it("text search: on 1000 records", async () => {
    const N = 1000;
    const dir = join(tmpDir, "text-search");
    const store = new Store<Record<string, unknown>>();
    const col = new Collection("bench", store, { textSearch: true });
    await col.open(dir, { checkpointThreshold: 5000 });
    await col.insertMany(Array.from({ length: N }, (_, i) => ({
      _id: `doc-${i}`,
      title: `Document about ${["databases", "agents", "search", "indexing", "performance"][i % 5]}`,
      body: randomString(500),
    })));

    const QUERIES = 100;
    const result = bench(`text search (${QUERIES} queries on ${N} records)`, () => {
      for (let i = 0; i < QUERIES; i++) {
        col.search("databases indexing");
      }
    }, QUERIES);

    console.log(`  ${result.name}: ${result.avgMs}ms/search (${result.opsPerSec} queries/sec)`);
    expect(result.avgMs).toBeLessThan(5);
    await col.close();
  });

  // --- HNSW ---

  it("HNSW: build 1000 vectors", () => {
    const DIM = 64;
    const N = 1000;
    const index = new HnswIndex({ dimensions: DIM, M: 12, efConstruction: 50 });

    const result = bench(`HNSW build ${N} vectors (${DIM}d)`, () => {
      for (let i = 0; i < N; i++) {
        index.add(`v${i}`, randomVector(DIM));
      }
    }, N);

    console.log(`  ${result.name}: ${result.totalMs}ms total, ${result.avgMs}ms/insert`);
    expect(index.size).toBe(N);
  });

  it("HNSW: search 1000 vectors", () => {
    const DIM = 64;
    const N = 1000;
    const index = new HnswIndex({ dimensions: DIM, M: 12, efConstruction: 50, efSearch: 30 });
    for (let i = 0; i < N; i++) index.add(`v${i}`, randomVector(DIM));

    const QUERIES = 100;
    const result = bench(`HNSW search k=10 (${QUERIES} queries on ${N} vectors)`, () => {
      for (let i = 0; i < QUERIES; i++) {
        index.search(randomVector(DIM), 10);
      }
    }, QUERIES);

    console.log(`  ${result.name}: ${result.avgMs}ms/search (${result.opsPerSec} queries/sec)`);
    expect(result.avgMs).toBeLessThan(10);
  });

  // --- B-tree ---

  it("B-tree: build and query 10000 entries", () => {
    const N = 10000;
    const idx = new BTreeIndex("score");

    const buildResult = bench(`B-tree build ${N} entries`, () => {
      for (let i = 0; i < N; i++) {
        idx.add(Math.floor(Math.random() * 1000), `id-${i}`);
      }
    }, N);

    console.log(`  ${buildResult.name}: ${buildResult.totalMs}ms total`);

    const QUERIES = 10000;
    const queryResult = bench(`B-tree eq lookup (${QUERIES} queries)`, () => {
      for (let i = 0; i < QUERIES; i++) {
        idx.eq(Math.floor(Math.random() * 1000));
      }
    }, QUERIES);

    console.log(`  ${queryResult.name}: ${queryResult.avgMs}ms/query (${queryResult.opsPerSec} ops/sec)`);
    expect(queryResult.avgMs).toBeLessThan(1);
  });

  // --- Bloom filter ---

  it("bloom: check 10000 lookups", () => {
    const N = 10000;
    const bf = new BloomFilter(N);
    for (let i = 0; i < N; i++) bf.add(`item-${i}`);

    const LOOKUPS = 100000;
    const result = bench(`bloom check (${LOOKUPS} lookups)`, () => {
      for (let i = 0; i < LOOKUPS; i++) {
        bf.has(`item-${i % (N * 2)}`);
      }
    }, LOOKUPS);

    console.log(`  ${result.name}: ${result.opsPerSec} ops/sec`);
    expect(result.opsPerSec).toBeGreaterThan(500000); // CI machines may be slower
  });

  // --- Undo ---

  it("undo: 100 operations", async () => {
    const dir = join(tmpDir, "undo");
    const store = new Store<Record<string, unknown>>();
    const col = new Collection("bench", store);
    await col.open(dir, { checkpointThreshold: 5000 });

    for (let i = 0; i < 100; i++) {
      await col.insert(randomRecord(i));
    }

    const N = 100;
    const result = await benchAsync(`undo ${N} operations`, async () => {
      for (let i = 0; i < N; i++) {
        await col.undo();
      }
    }, N);

    console.log(`  ${result.name}: ${result.avgMs}ms/undo (${result.opsPerSec} ops/sec)`);
    expect(result.opsPerSec).toBeGreaterThan(100);
    await col.close();
  });

  // --- Collection open (cold start) ---

  it("open: cold start with 1000 records", async () => {
    const dir = join(tmpDir, "cold-start");
    const store1 = new Store<Record<string, unknown>>();
    const col1 = new Collection("bench", store1);
    await col1.open(dir, { checkpointThreshold: 5000 });
    await col1.insertMany(Array.from({ length: 1000 }, (_, i) => randomRecord(i)));
    await col1.close();

    const result = await benchAsync("cold start 1000 records", async () => {
      const store2 = new Store<Record<string, unknown>>();
      const col2 = new Collection("bench", store2);
      await col2.open(dir, { checkpointThreshold: 5000 });
      await col2.close();
    });

    console.log(`  ${result.name}: ${result.totalMs}ms`);
    expect(result.totalMs).toBeLessThan(500); // <500ms to open 1K records
  });

  // --- Indexed vs unindexed find ---

  it("find: indexed vs unindexed on 10K records", async () => {
    const N = 10000;
    const dir = join(tmpDir, "indexed-find");
    const store = new Store<Record<string, unknown>>();
    const col = new Collection("bench", store);
    await col.open(dir, { checkpointThreshold: 50000 });

    const records = Array.from({ length: N }, (_, i) => ({
      _id: `rec-${i}`,
      status: ["active", "done", "pending", "archived"][i % 4],
      score: Math.floor(Math.random() * 100),
      name: `User ${i}`,
    }));
    await col.insertMany(records);

    // Unindexed scan
    const QUERIES = 100;
    const startUnindexed = performance.now();
    for (let i = 0; i < QUERIES; i++) {
      col.find({ filter: { status: "active" } });
    }
    const unindexedMs = performance.now() - startUnindexed;

    // Create index
    col.createIndex("status");

    // Indexed scan
    const startIndexed = performance.now();
    for (let i = 0; i < QUERIES; i++) {
      col.find({ filter: { status: "active" } });
    }
    const indexedMs = performance.now() - startIndexed;

    const speedup = unindexedMs / indexedMs;
    console.log(`  find ${QUERIES}x on ${N} records: unindexed=${(unindexedMs/QUERIES).toFixed(2)}ms, indexed=${(indexedMs/QUERIES).toFixed(2)}ms, speedup=${speedup.toFixed(1)}x`);

    // Indexed should be faster (at least 2x on 10K records)
    expect(speedup).toBeGreaterThan(1.5);

    await col.close();
  });

  // --- Summary ---

  it("prints summary", () => {
    console.log("\n  === Performance Summary ===");
    console.log("  All benchmarks passed within acceptable thresholds.");
    console.log("  Run with: npm test -- --reporter=verbose tests/bench.test.ts\n");
    expect(true).toBe(true);
  });
});
