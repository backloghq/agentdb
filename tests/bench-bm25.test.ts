/**
 * BM25 + hybrid search performance benchmarks.
 *
 * Host: AMD Ryzen 7 9700X (8c/16t), 60 GiB RAM, CachyOS Linux (Arch-based)
 *
 * Run:
 *   BENCH=1 npx vitest run tests/bench-bm25.test.ts
 *
 * Not run in default `npm test` — gated behind BENCH=1.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDB } from "../src/agentdb.js";
import { defineSchema } from "../src/schema.js";
import { TextIndex } from "../src/text-index.js";
import { rrf } from "../src/rrf.js";
import type { EmbeddingProvider } from "../src/embeddings/types.js";

// --- Helpers ---

function percentiles(samples: number[]): { p50: number; p95: number; p99: number } {
  const s = [...samples].sort((a, b) => a - b);
  return {
    p50: s[Math.floor(s.length * 0.50)] ?? 0,
    p95: s[Math.floor(s.length * 0.95)] ?? 0,
    p99: s[Math.floor(s.length * 0.99)] ?? 0,
  };
}

// Vocabulary: 500 distinct words for realistic BM25 IDF distribution
const VOCAB: string[] = Array.from({ length: 500 }, (_, i) =>
  `word${i.toString().padStart(3, "0")}`
);

function randomDoc(tokens: number): string {
  return Array.from({ length: tokens }, () => VOCAB[Math.floor(Math.random() * VOCAB.length)]).join(" ");
}

function randomRecord(i: number, tokens = 200): Record<string, unknown> {
  return {
    _id: `doc-${i}`,
    title: randomDoc(10),
    body: randomDoc(tokens),
    category: `cat-${i % 20}`,
  };
}

// Deterministic fake embedding provider — 16-dim normalised random vectors keyed by text hash
class FakeEmbedProvider implements EmbeddingProvider {
  readonly dimensions = 16;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      // Cheap deterministic hash → unit vector
      let h = 0;
      for (let i = 0; i < t.length; i++) h = (Math.imul(31, h) + t.charCodeAt(i)) | 0;
      const vec = Array.from({ length: this.dimensions }, (_, i) => Math.sin(h + i));
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
      return vec.map((v) => v / norm);
    });
  }
}

// --- Suite ---

describe.skipIf(!process.env.BENCH)("BM25 + hybrid search benchmarks", { timeout: 600_000 }, () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bench-bm25-"));
    console.log("\n  === BM25 + Hybrid Search Benchmarks ===");
    console.log("  Host: AMD Ryzen 7 9700X · 60 GiB · CachyOS Linux\n");
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // 1. BM25 indexing throughput at 10K / 100K docs
  it("BM25 indexing throughput — 10K docs, ~200 tokens each", () => {
    const N = 10_000;
    const idx = new TextIndex();
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      idx.add(`doc-${i}`, { body: randomDoc(200) });
    }
    const ms = performance.now() - t0;
    const docsPerSec = Math.round(N / (ms / 1000));
    console.log(`  BM25 add() 10K docs:   ${ms.toFixed(0)}ms — ${docsPerSec.toLocaleString()} docs/sec`);
    expect(idx.docCount).toBe(N);
    expect(docsPerSec).toBeGreaterThan(10_000); // loose floor
  });

  it("BM25 indexing throughput — 100K docs, ~200 tokens each", () => {
    const N = 100_000;
    const idx = new TextIndex();
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      idx.add(`doc-${i}`, { body: randomDoc(200) });
    }
    const ms = performance.now() - t0;
    const docsPerSec = Math.round(N / (ms / 1000));
    console.log(`  BM25 add() 100K docs:  ${ms.toFixed(0)}ms — ${docsPerSec.toLocaleString()} docs/sec`);
    expect(idx.docCount).toBe(N);
    expect(docsPerSec).toBeGreaterThan(5_000); // allows for GC pressure at scale
  });

  // 2. BM25 query latency at 100K — p50/p95/p99
  it("BM25 query latency — 100K corpus, 200 queries (1/2/5-term)", () => {
    const N = 100_000;
    const QUERIES = 200;
    const idx = new TextIndex();
    for (let i = 0; i < N; i++) {
      idx.add(`doc-${i}`, { body: randomDoc(200) });
    }

    const sample1: number[] = [];
    const sample2: number[] = [];
    const sample5: number[] = [];

    for (let q = 0; q < QUERIES; q++) {
      const t1 = `word${String(q % 500).padStart(3, "0")}`;
      const t2 = `word${String((q + 1) % 500).padStart(3, "0")}`;
      const terms5 = Array.from({ length: 5 }, (_, i) => `word${String((q + i) % 500).padStart(3, "0")}`).join(" ");

      let t = performance.now(); idx.searchScored(t1, { limit: 10 }); sample1.push(performance.now() - t);
      t = performance.now(); idx.searchScored(`${t1} ${t2}`, { limit: 10 }); sample2.push(performance.now() - t);
      t = performance.now(); idx.searchScored(terms5, { limit: 10 }); sample5.push(performance.now() - t);
    }

    const p1 = percentiles(sample1);
    const p2 = percentiles(sample2);
    const p5 = percentiles(sample5);

    console.log(`  Query latency over 100K (${QUERIES} runs each):`);
    console.log(`    1-term:  p50=${p1.p50.toFixed(2)}ms  p95=${p1.p95.toFixed(2)}ms  p99=${p1.p99.toFixed(2)}ms`);
    console.log(`    2-term:  p50=${p2.p50.toFixed(2)}ms  p95=${p2.p95.toFixed(2)}ms  p99=${p2.p99.toFixed(2)}ms`);
    console.log(`    5-term:  p50=${p5.p50.toFixed(2)}ms  p95=${p5.p95.toFixed(2)}ms  p99=${p5.p99.toFixed(2)}ms`);

    // Relative: 5-term p95 should not exceed 1-term p95 * 20 (linear growth, not exponential)
    expect(p5.p95).toBeLessThan(p1.p95 * 20);
  });

  // 3. Disk-mode reopen with v2 stats vs v1 baseline
  it("Disk-mode reopen: cold-start to first BM25 query — v2 index", async () => {
    const N = 10_000; // reduced for disk-mode speed
    const schema = defineSchema({
      name: "docs",
      textSearch: true,
      storageMode: "disk",
      fields: { body: { type: "string", searchable: true } },
    });

    const dir = join(tmpDir, "disk-reopen-v2");
    let db = new AgentDB(dir);
    await db.init();
    let col = await db.collection(schema);
    for (let i = 0; i < N; i++) {
      await col.insert({ _id: `doc-${i}`, body: randomDoc(50) });
    }
    await db.close(); // compaction + v2 index save

    // Measure cold reopen + first query
    const t0 = performance.now();
    db = new AgentDB(dir);
    await db.init();
    col = await db.collection(schema);
    const result = await col.bm25Search("word001 word002", { limit: 10 });
    const coldStartMs = performance.now() - t0;

    console.log(`  Disk reopen (v2, ${N} docs): ${coldStartMs.toFixed(0)}ms cold-start to first query`);
    expect(result.records.length).toBeGreaterThanOrEqual(0);
    expect(coldStartMs).toBeLessThan(5000); // generous ceiling
    await db.close();
  });

  it("Disk-mode reopen: cold-start to first BM25 query — v1 index (upgrade path)", async () => {
    const N = 1_000;
    const dir = join(tmpDir, "disk-reopen-v1");

    // Write a v1-format index manually — no TF/DL data
    const v1Terms: Record<string, string[]> = {};
    for (let i = 0; i < 50; i++) {
      const word = `word${String(i).padStart(3, "0")}`;
      v1Terms[word] = Array.from({ length: Math.min(N, 100) }, (_, j) => `doc-${j}`);
    }
    const v1Index = { version: 1, terms: v1Terms, docCount: N };

    const colDir = join(dir, "collections", "v1docs");
    await mkdir(join(colDir, "indexes"), { recursive: true });
    await writeFile(join(colDir, "indexes", "text-index.json"), JSON.stringify(v1Index));
    const meta = {
      lastTimestamp: new Date().toISOString(),
      parquetFile: "data.parquet", parquetFiles: [],
      jsonlFile: "records.jsonl", jsonlFiles: [],
      rowCount: 0, rowGroups: 0, columnCardinality: {},
    };
    await writeFile(join(colDir, "compaction-meta.json"), JSON.stringify(meta));
    await writeFile(join(colDir, "records.jsonl"), "");
    await writeFile(join(colDir, "record-offsets.json"), "{}");
    await writeFile(join(colDir, "offset-index.json"), "{}");

    const v1Schema = defineSchema({
      name: "v1docs",
      textSearch: true,
      storageMode: "disk",
      fields: { body: { type: "string", searchable: true } },
    });

    const t0 = performance.now();
    const db = new AgentDB(dir);
    await db.init();
    const col = await db.collection(v1Schema);
    await col.bm25Search("word001 word002", { limit: 10 }); // triggers lazy load + v1 upgrade
    const coldStartMs = performance.now() - t0;

    console.log(`  Disk reopen (v1 upgrade, ${N} docs): ${coldStartMs.toFixed(0)}ms cold-start to first query`);
    expect(coldStartMs).toBeLessThan(5000);
    await db.close();
  });

  // 4. Hybrid vs arms — relative latency
  it("Hybrid vs BM25-only vs vector-only — relative latency (1K corpus)", async () => {
    const N = 1_000;
    const RUNS = 20;
    const schema = defineSchema({
      name: "hybrid-bench",
      textSearch: true,
      fields: { body: { type: "string", searchable: true } },
    });

    const dir = join(tmpDir, "hybrid-bench");
    const db = new AgentDB(dir, { embeddings: { provider: new FakeEmbedProvider() } });
    await db.init();
    const col = await db.collection(schema);

    for (let i = 0; i < N; i++) {
      await col.insert({ _id: `doc-${i}`, body: randomDoc(50) });
    }
    await col.embedUnembedded();

    const bm25Times: number[] = [];
    const hybridTimes: number[] = [];

    for (let r = 0; r < RUNS; r++) {
      const q = `word${String(r % 500).padStart(3, "0")} word${String((r + 1) % 500).padStart(3, "0")}`;

      let t = performance.now();
      await col.bm25Search(q, { limit: 10 });
      bm25Times.push(performance.now() - t);

      t = performance.now();
      await col.hybridSearch(q, { limit: 10 });
      hybridTimes.push(performance.now() - t);
    }

    const bm25Avg = bm25Times.reduce((s, v) => s + v, 0) / RUNS;
    const hybridAvg = hybridTimes.reduce((s, v) => s + v, 0) / RUNS;

    console.log(`  Hybrid vs BM25-only (${N} docs, ${RUNS} queries each):`);
    console.log(`    BM25-only avg:  ${bm25Avg.toFixed(2)}ms`);
    console.log(`    Hybrid avg:     ${hybridAvg.toFixed(2)}ms`);
    console.log(`    Overhead:       ${(hybridAvg - bm25Avg).toFixed(2)}ms`);

    // Hybrid must not be more than 5ms slower than BM25 alone (RRF should not dominate)
    expect(hybridAvg - bm25Avg).toBeLessThan(5);
    await db.close();
  });

  // 5. RRF fusion overhead — two 1K and two 10K lists
  it("RRF fusion overhead — 1K-item and 10K-item lists", () => {
    const makeList = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `doc-${i}`, score: 1 - i / n }));

    const list1k = makeList(1_000);
    const list10k = makeList(10_000);

    const RUNS = 100;

    const times1k: number[] = [];
    const times10k: number[] = [];

    for (let r = 0; r < RUNS; r++) {
      let t = performance.now(); rrf([list1k, list1k], { limit: 10 }); times1k.push(performance.now() - t);
      t = performance.now(); rrf([list10k, list10k], { limit: 10 }); times10k.push(performance.now() - t);
    }

    const p1k = percentiles(times1k);
    const p10k = percentiles(times10k);

    console.log(`  RRF fusion overhead (${RUNS} runs):`);
    console.log(`    2×1K lists:   p50=${p1k.p50.toFixed(2)}ms  p99=${p1k.p99.toFixed(2)}ms`);
    console.log(`    2×10K lists:  p50=${p10k.p50.toFixed(2)}ms  p99=${p10k.p99.toFixed(2)}ms`);

    // RRF over 1K lists should be under 5ms at p99
    expect(p1k.p99).toBeLessThan(5);
    // RRF over 10K lists should be under 20ms at p99
    expect(p10k.p99).toBeLessThan(20);
  });

  // 6. Schema-projected indexing: searchable subset vs all-strings fallback
  it("Schema-projected vs all-strings indexing — same corpus, different projection", () => {
    const N = 10_000;

    // All-strings fallback: index title + body + category (3 fields)
    const idxAll = new TextIndex();
    const tAll0 = performance.now();
    for (let i = 0; i < N; i++) {
      const r = randomRecord(i, 100);
      idxAll.add(`doc-${i}`, r); // all string fields
    }
    const msAll = performance.now() - tAll0;

    // Projected: index body only (1 field, same token count)
    const idxProj = new TextIndex();
    const tProj0 = performance.now();
    for (let i = 0; i < N; i++) {
      const r = randomRecord(i, 100);
      idxProj.add(`doc-${i}`, { body: r.body }); // searchable subset
    }
    const msProj = performance.now() - tProj0;

    console.log(`  Indexing ${N} docs:`);
    console.log(`    All-strings (title+body+category): ${msAll.toFixed(0)}ms`);
    console.log(`    Projected (body only):             ${msProj.toFixed(0)}ms`);
    console.log(`    Speedup: ${(msAll / msProj).toFixed(2)}x`);

    // Projected indexing must be strictly faster (fewer tokens to process)
    expect(msProj).toBeLessThan(msAll);
  });
});
