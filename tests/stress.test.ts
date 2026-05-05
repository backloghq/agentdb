/**
 * Text-search stress test for agentdb + termlog.
 *
 * Without STRESS=1: 10K docs, quick assertions, runs in <60s.
 * With    STRESS=1: 100K docs, p95 + RSS bounds, runs in <600s.
 *
 * Run:
 *   npx vitest run tests/stress.test.ts                     # 10K smoke
 *   STRESS=1 npx vitest run tests/stress.test.ts            # 100K full
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDB } from "../src/agentdb.js";
import { defineSchema } from "../src/schema.js";

const IS_STRESS = process.env["STRESS"] === "1";
const IS_CI     = process.env["CI"] === "true";

const N              = IS_STRESS ? 100_000 : 10_000;
const P95_LIMIT_MS   = IS_STRESS ? (IS_CI ? 2000 : 800) : 100;
const MEM_LIMIT_MB   = IS_STRESS ? 2048 : 512;
const TIMEOUT_MS     = IS_STRESS ? 600_000 : 60_000;

// Vocabulary: 1000 distinct words for realistic IDF distribution
const VOCAB = Array.from({ length: 1_000 }, (_, i) => `word${String(i).padStart(4, "0")}`);

function randomDoc(seed: number, tokens = 100): string {
  // Deterministic LCG so reopened queries get the same vocabulary distribution
  let s = seed;
  return Array.from({ length: tokens }, () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return VOCAB[s % VOCAB.length];
  }).join(" ");
}

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * p)] ?? 0;
}

// Peak RSS in MB (Linux reports maxRSS in KB; macOS in bytes)
function peakRssMB(): number {
  const raw = process.resourceUsage().maxRSS;
  return process.platform === "linux" ? raw / 1024 : raw / 1024 / 1024;
}

describe(`agentdb text-search stress — ${N.toLocaleString()} docs (STRESS=${IS_STRESS ? "1" : "0"})`, { timeout: TIMEOUT_MS }, () => {
  let tmpDir: string;
  const schema = defineSchema({
    name: "corpus",
    textSearch: true,
    fields: { body: { type: "string", searchable: true } },
  });

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agentdb-stress-"));
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("indexes N docs and searches with p95 latency bound", async () => {
    const db = new AgentDB(tmpDir);
    await db.init();
    const col = await db.collection(schema);

    // Insert
    const BATCH = 1_000;
    for (let i = 0; i < N; i += BATCH) {
      const end = Math.min(i + BATCH, N);
      await col.insertMany(
        Array.from({ length: end - i }, (_, j) => ({
          _id: `doc-${i + j}`,
          body: randomDoc(i + j),
        }))
      );
    }

    const peakRss = peakRssMB();
    expect(peakRss, `Peak RSS ${peakRss.toFixed(0)} MB exceeds ${MEM_LIMIT_MB} MB`).toBeLessThan(MEM_LIMIT_MB);

    // Query latency p95 over 50 representative queries
    const QUERIES = 50;
    const latencies: number[] = [];
    for (let q = 0; q < QUERIES; q++) {
      const term1 = VOCAB[q % VOCAB.length];
      const term2 = VOCAB[(q + 17) % VOCAB.length];
      const t = performance.now();
      const r = await col.bm25Search(`${term1} ${term2}`, { limit: 10 });
      latencies.push(performance.now() - t);
      // Both terms are common in the vocab so at least some results expected
      expect(Array.isArray(r.records)).toBe(true);
    }

    const p95 = percentile(latencies, 0.95);
    console.log(`  [stress] ${N.toLocaleString()} docs | p95=${p95.toFixed(1)}ms (limit=${P95_LIMIT_MS}ms) | peakRSS=${peakRss.toFixed(0)}MB`);
    expect(p95, `BM25 p95 latency ${p95.toFixed(1)}ms exceeds ${P95_LIMIT_MS}ms`).toBeLessThan(P95_LIMIT_MS);

    await db.close();
  });

  it("close + reopen: search returns same results as pre-close", async () => {
    // Reopen the same dir written by previous test
    const db1 = new AgentDB(tmpDir);
    await db1.init();
    const col1 = await db1.collection(schema);

    const query = `${VOCAB[7]} ${VOCAB[42]} ${VOCAB[99]}`;
    const before = await col1.bm25Search(query, { limit: 10 });
    await db1.close();

    const db2 = new AgentDB(tmpDir);
    await db2.init();
    const col2 = await db2.collection(schema);
    const after = await col2.bm25Search(query, { limit: 10 });
    await db2.close();

    // Same top-10 IDs in same order
    expect(before.records.map((r) => r._id)).toEqual(after.records.map((r) => r._id));
  });
});
