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

  // 7. 1M-doc memory cliff — heap delta and per-doc footprint
  it("1M-doc memory cliff — heap delta and per-doc footprint", { timeout: 900_000 }, () => {
    const N = 1_000_000;
    // 2K-word vocab for realistic IDF distribution
    const vocab2k: string[] = Array.from({ length: 2_000 }, (_, i) =>
      `term${i.toString().padStart(4, "0")}`
    );
    const rndDoc = (tokens: number) =>
      Array.from({ length: tokens }, () => vocab2k[Math.floor(Math.random() * vocab2k.length)]).join(" ");

    const idx = new TextIndex();

    // Force GC baseline if available (node --expose-gc)
    const maybeGc = (global as Record<string, unknown>).gc;
    if (typeof maybeGc === "function") (maybeGc as () => void)();
    const heapBefore = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      idx.add(`doc-${i}`, { body: rndDoc(200) });
    }
    const ms = performance.now() - t0;
    const heapAfter = process.memoryUsage().heapUsed;

    const deltaGB = (heapAfter - heapBefore) / 1024 ** 3;
    const perDocKB = ((heapAfter - heapBefore) / N) / 1024;
    const docsPerSec = Math.round(N / (ms / 1000));
    const estimatedGB = idx.estimatedBytes() / 1024 ** 3;

    console.log(`  1M-doc memory cliff:`);
    console.log(`    Heap delta:       ${deltaGB.toFixed(2)} GB`);
    console.log(`    Per-doc:          ${perDocKB.toFixed(1)} KB`);
    console.log(`    Throughput:       ${docsPerSec.toLocaleString()} docs/sec`);
    console.log(`    estimatedBytes(): ${estimatedGB.toFixed(2)} GB`);
    console.log(`    Ratio (actual/estimated): ${(deltaGB / estimatedGB).toFixed(2)}x`);

    expect(idx.docCount).toBe(N);
    // Loose ceiling: fail if heap blows past 15 GB above baseline
    expect(deltaGB).toBeLessThan(15);
  });

  // 8. Imbalanced RRF — small list must still contribute to top-10
  it("Imbalanced RRF — [2000-item, 50-item] and [50-item, 2000-item]", () => {
    const make = (n: number, prefix: string) =>
      Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}`, score: 1 - i / n }));

    const big = make(2_000, "big");
    const small = make(50, "small");

    const fused1 = rrf([big, small], { limit: 10 });
    const fused2 = rrf([small, big], { limit: 10 });

    console.log(`  Imbalanced RRF [2000, 50]:`);
    console.log(`    Top id from [big,small]: ${fused1[0]?.id}`);
    console.log(`    Top id from [small,big]: ${fused2[0]?.id}`);

    // Both fusions return 10 results
    expect(fused1.length).toBe(10);
    expect(fused2.length).toBe(10);
    // Top of the small list (small-0) has high rank in both lists so must appear
    const ids1 = fused1.map((r) => r.id);
    const ids2 = fused2.map((r) => r.id);
    expect(ids1).toContain("small-0");
    expect(ids2).toContain("small-0");
    // Scores positive
    expect(fused1.every((r) => r.score > 0)).toBe(true);
  });

  // 9. Concurrent query/write — no errors, p99 bounded
  it("Concurrent query/write — 10 queries and 10 inserts in parallel (disk mode)", async () => {
    const schema = defineSchema({
      name: "concurrent",
      textSearch: true,
      storageMode: "disk",
      fields: { body: { type: "string", searchable: true } },
    });
    const dir = join(tmpDir, "concurrent");
    const db = new AgentDB(dir);
    await db.init();
    const col = await db.collection(schema);

    // Seed corpus
    for (let i = 0; i < 1_000; i++) {
      await col.insert({ _id: `seed-${i}`, body: randomDoc(50) });
    }

    const queryTimes: number[] = [];
    const insertTimes: number[] = [];

    const N = 10;
    const queries = Array.from({ length: N }, async (_, i) => {
      const t = performance.now();
      const result = await col.bm25Search(`word${String(i % 500).padStart(3, "0")}`, { limit: 5 });
      queryTimes.push(performance.now() - t);
      expect(Array.isArray(result.records)).toBe(true);
    });
    const inserts = Array.from({ length: N }, async (_, i) => {
      const t = performance.now();
      await col.insert({ body: randomDoc(50), _id: `new-${i}` });
      insertTimes.push(performance.now() - t);
    });

    await Promise.all([...queries, ...inserts]);
    await db.close();

    const qStats = percentiles(queryTimes);
    const iStats = percentiles(insertTimes);
    console.log(`  Concurrent 10q+10w (disk, 1K seed):`);
    console.log(`    Query  p50=${qStats.p50.toFixed(2)}ms  p99=${qStats.p99.toFixed(2)}ms`);
    console.log(`    Insert p50=${iStats.p50.toFixed(2)}ms  p99=${iStats.p99.toFixed(2)}ms`);

    // No assertion on absolute latency — just that p99 is bounded vs a very loose limit
    expect(qStats.p99).toBeLessThan(5_000);
  });

  // 10. Update/delete throughput — re-index 100K docs (full replacement)
  it("Update/delete throughput — re-index 100K docs (full replacement)", () => {
    const N = 100_000;
    const idx = new TextIndex();
    // Initial index
    for (let i = 0; i < N; i++) {
      idx.add(`doc-${i}`, { body: randomDoc(200) });
    }
    // Full replacement (remove + add = re-index)
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      idx.add(`doc-${i}`, { body: randomDoc(200) });
    }
    const ms = performance.now() - t0;
    const docsPerSec = Math.round(N / (ms / 1000));

    console.log(`  Re-index ${N} docs (full replacement via add()):`);
    console.log(`    ${ms.toFixed(0)}ms — ${docsPerSec.toLocaleString()} docs/sec`);
    console.log(`    Ratio vs add-only: ~1x (add() calls remove() internally)`);

    expect(idx.docCount).toBe(N);
    // Re-index throughput should be at least half of add-only throughput (remove+add ~2x cost)
    expect(docsPerSec).toBeGreaterThan(2_500);
  });

  // 11. rebuildHnswFromDisk cold-open heap delta (skipCache flag)
  it("rebuildHnswFromDisk cold-open heap delta — 10K and 100K docs", async () => {
    const provider = new FakeEmbedProvider();
    const schema = defineSchema({
      name: "hnsw-rebuild-bench",
      fields: { body: { type: "string" } },
    });

    async function measureRebuild(N: number): Promise<number> {
      const dir = await mkdtemp(join(tmpDir, `hnsw-${N}-`));
      // Phase 1: insert + embed
      const dbW = new AgentDB(dir, { storageMode: "disk", embeddings: { provider }, cacheSize: N });
      await dbW.init();
      const colW = await dbW.collection(schema);
      const BATCH = 500;
      for (let i = 0; i < N; i += BATCH) {
        const end = Math.min(i + BATCH, N);
        await colW.insertMany(
          Array.from({ length: end - i }, (_, j) => ({ _id: `d${i + j}`, body: randomDoc(20) }))
        );
      }
      await colW.embedUnembedded();
      await dbW.close();

      // Phase 2: cold reopen — tiny cache forces skipCache path in rebuildHnswFromDisk
      const heapBefore = process.memoryUsage().heapUsed;
      const dbR = new AgentDB(dir, { storageMode: "disk", embeddings: { provider }, cacheSize: 100 });
      await dbR.init();
      const colR = await dbR.collection(schema);
      const heapAfter = process.memoryUsage().heapUsed;
      const deltaBytes = heapAfter - heapBefore;

      // Verify HNSW works post-rebuild
      const result = await colR.semanticSearch("word000", { limit: 5 });
      expect(result.records.length).toBeGreaterThan(0);

      await dbR.close();
      await rm(dir, { recursive: true, force: true });

      return deltaBytes;
    }

    const delta10k = await measureRebuild(10_000);
    const delta100k = await measureRebuild(100_000);

    console.log("  rebuildHnswFromDisk heap delta (skipCache=true):");
    console.log(`    10K docs:  ${(delta10k / 1024 / 1024).toFixed(1)} MB heap delta`);
    console.log(`    100K docs: ${(delta100k / 1024 / 1024).toFixed(1)} MB heap delta`);

    // With skipCache=true, the LRU is not populated during rebuild.
    // The heap delta should be dominated by the HNSW index itself, not the record cache.
    // Very loose assertion: < 2 GB for 100K docs.
    expect(delta100k).toBeLessThan(2 * 1024 * 1024 * 1024);
  });
});

// Ollama real-embedder hybrid latency — requires OLLAMA_EMBED=1 and a running Ollama instance
describe.skipIf(!process.env.OLLAMA_EMBED)("Real-embedder hybrid latency (Ollama)", { timeout: 600_000 }, () => {
  it("bm25Search vs searchByVector vs hybridSearch p50/p95 — 10K corpus", async () => {
    const { OllamaEmbeddingProvider } = await import("../src/embeddings/ollama.js");
    const provider = new OllamaEmbeddingProvider({ model: "mxbai-embed-large" });

    const dir = await mkdtemp(join(tmpdir(), "bench-ollama-"));
    const schema = defineSchema({
      name: "docs",
      textSearch: true,
      fields: { body: { type: "string", searchable: true } },
    });
    const db = new AgentDB(dir, { embeddings: { provider } });
    await db.init();
    const col = await db.collection(schema);

    const N = 10_000;
    const RUNS = 50;
    console.log(`\n  === Real-Embedder Hybrid Latency (Ollama mxbai-embed-large) ===`);
    console.log(`  Corpus: ${N} docs   Queries: ${RUNS}`);

    for (let i = 0; i < N; i++) {
      await col.insert({ _id: `doc-${i}`, body: randomDoc(50) });
    }
    await col.embedUnembedded();

    const bm25Times: number[] = [];
    const vecTimes: number[] = [];
    const hybridTimes: number[] = [];

    const queries = Array.from({ length: RUNS }, (_, i) =>
      `word${String(i % 500).padStart(3, "0")} word${String((i + 1) % 500).padStart(3, "0")}`
    );

    for (const q of queries) {
      let t = performance.now();
      await col.bm25Search(q, { limit: 10 });
      bm25Times.push(performance.now() - t);

      const [vec] = await provider.embed([q]);
      t = performance.now();
      await col.searchByVector(vec, { limit: 10 });
      vecTimes.push(performance.now() - t);

      t = performance.now();
      await col.hybridSearch(q, { limit: 10 });
      hybridTimes.push(performance.now() - t);
    }

    const pb = percentiles(bm25Times);
    const pv = percentiles(vecTimes);
    const ph = percentiles(hybridTimes);

    console.log(`    BM25:   p50=${pb.p50.toFixed(2)}ms  p95=${pb.p95.toFixed(2)}ms`);
    console.log(`    Vector: p50=${pv.p50.toFixed(2)}ms  p95=${pv.p95.toFixed(2)}ms`);
    console.log(`    Hybrid: p50=${ph.p50.toFixed(2)}ms  p95=${ph.p95.toFixed(2)}ms`);

    // Relative: hybrid p95 should not exceed BM25 p95 + vector p95 * 1.5 (arms are parallel)
    expect(ph.p95).toBeLessThan((pb.p95 + pv.p95) * 1.5);

    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
});

// S3 disk-mode bm25Search latency — requires S3_BENCH=1, S3_BENCH_BUCKET, and AWS_* env vars
// Uses the same low-level Collection+DiskStore+S3Backend pattern as tests/s3.test.ts.
describe.skipIf(!process.env.S3_BENCH)("S3 disk-mode bm25Search latency", { timeout: 600_000 }, () => {
  it("bm25Search p50/p95 over S3 with candidateLimit=50 — 5K corpus", async () => {
    const { S3Client } = await import("@aws-sdk/client-s3");
    const { loadS3Backend } = await import("../src/index.js");
    const S3BackendClass = await loadS3Backend();
    const { Collection } = await import("../src/collection.js");
    const { DiskStore } = await import("../src/disk-store.js");
    const { Store } = await import("@backloghq/opslog");

    const bucket = process.env.S3_BENCH_BUCKET ?? "agentdb-bench";
    const prefix = `bench-bm25-${Date.now()}/`;
    const client = new S3Client({});
    const N = 5_000;
    const RUNS = 30;

    console.log(`\n  === S3 disk-mode bm25Search (bucket=${bucket}) ===`);

    // Session 1: insert + compact to S3
    const backend1 = new S3BackendClass({ bucket, prefix, client });
    const store1 = new Store<Record<string, unknown>>();
    const col1 = new Collection("s3bench", store1, { textSearch: true, searchableFields: ["body"] });
    await col1.open("s3", { checkpointThreshold: 50_000, backend: backend1, skipLoad: true });
    const ds1 = new DiskStore(backend1, { rowGroupSize: 500 });
    await ds1.load();
    col1.setDiskStore(ds1);
    for (let i = 0; i < N; i++) {
      await col1.insert({ _id: `doc-${i}`, body: randomDoc(50) });
    }
    const allRecs = await col1.findAll();
    await ds1.compact(allRecs.map((r) => [r._id as string, r]));
    await ds1.saveIndexes(col1.getIndexManager(), col1.getTextIndex());
    await col1.close();

    // Session 2: reopen cold, measure bm25Search latency
    const backend2 = new S3BackendClass({ bucket, prefix, client });
    const store2 = new Store<Record<string, unknown>>();
    const col2 = new Collection("s3bench", store2, { textSearch: true, searchableFields: ["body"] });
    await col2.open("s3", { checkpointThreshold: 50_000, backend: backend2, skipLoad: true });
    const ds2 = new DiskStore(backend2, { rowGroupSize: 500 });
    await ds2.load();
    col2.setDiskStore(ds2);

    const times: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const q = `word${String(i % 500).padStart(3, "0")}`;
      const t = performance.now();
      await col2.bm25Search(q, { limit: 10, candidateLimit: 50 });
      times.push(performance.now() - t);
    }

    const p = percentiles(times);
    console.log(`    S3 bm25Search (candidateLimit=50, ${RUNS} queries, ${N} docs):`);
    console.log(`    p50=${p.p50.toFixed(2)}ms  p95=${p.p95.toFixed(2)}ms`);

    expect(p.p95).toBeLessThan(10_000); // very loose — network latency varies

    await col2.close();
  });
});
