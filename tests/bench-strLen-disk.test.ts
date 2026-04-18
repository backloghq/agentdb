/**
 * $strLen disk-mode characterization — Task #97
 * Compares col.count($strLen) vs col.find($exists)+JS in disk mode.
 * Measures wall-clock time and heap delta (process.memoryUsage().heapUsed).
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDB } from "../src/agentdb.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function gc() {
  // Trigger GC if exposed (node --expose-gc), otherwise best-effort
  if (typeof global.gc === "function") global.gc();
}

interface MeasureResult {
  avgMs: number;
  heapDeltaKB: number;
  peakHeapKB: number;
}

async function measure(label: string, fn: () => Promise<unknown>, iterations = 5): Promise<MeasureResult> {
  // warm-up (exclude from measurement)
  await fn();
  gc();

  let totalMs = 0;
  let totalHeapDelta = 0;
  let peakHeap = 0;

  for (let i = 0; i < iterations; i++) {
    gc();
    const heapBefore = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    await fn();
    const elapsed = performance.now() - t0;
    const heapAfter = process.memoryUsage().heapUsed;
    const delta = heapAfter - heapBefore;

    totalMs += elapsed;
    totalHeapDelta += delta;
    peakHeap = Math.max(peakHeap, heapAfter);
    gc();
  }

  const avgMs = totalMs / iterations;
  const heapDeltaKB = Math.round(totalHeapDelta / iterations / 1024);
  const peakHeapKB = Math.round(peakHeap / 1024);

  console.log(`  [${label}] avg=${avgMs.toFixed(2)}ms heap_delta=${heapDeltaKB}KB`);
  return { avgMs, heapDeltaKB, peakHeapKB };
}

/** Build N compact records: just title (varying length) */
function makeRecord(i: number): Record<string, unknown> {
  // 50% of records have title > 50 chars (even i → long, odd i → short)
  const titleLen = i % 2 === 0 ? 60 : 30;
  return {
    _id: `r-${i}`,
    title: "T".repeat(titleLen),
  };
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe("$strLen disk-mode characterization", () => {
  let tmpDir: string;
  const N = 100_000;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agentdb-strLen-disk-"));
  }, 5_000);

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it(`setup + compact ${N} records to Parquet`, { timeout: 300_000 }, async () => {
    // Phase 1: insert with async writes for speed
    const dirSetup = join(tmpDir, "disk100k");
    const dbSetup = new AgentDB(dirSetup, { storageMode: "disk", writeMode: "async" });
    await dbSetup.init();
    const colSetup = await dbSetup.collection("docs");

    const CHUNK = 10_000;
    for (let start = 0; start < N; start += CHUNK) {
      const batch = Array.from({ length: Math.min(CHUNK, N - start) }, (_, i) => makeRecord(start + i));
      await colSetup.insertMany(batch);
    }

    // Close triggers Parquet compaction
    const t0Compact = performance.now();
    await dbSetup.close();
    const compactMs = performance.now() - t0Compact;
    console.log(`  [setup] inserted ${N} records + compacted to Parquet in ${compactMs.toFixed(0)}ms`);
  });

  it(`col.count($strLen) vs col.find($exists)+JS — ${N} records (disk mode, Parquet)`, { timeout: 300_000 }, async () => {
    const dirBench = join(tmpDir, "disk100k");
    const db = new AgentDB(dirBench, { storageMode: "disk" });
    await db.init();
    const col = await db.collection("docs");

    // Confirm record count
    const total = await col.count();
    console.log(`  [info] disk-mode collection has ${total} records (from Parquet)`);

    // --- Approach A: col.count({ title: { $strLen: { $gt: 50 } } }) ---
    const countStrLen = await measure(
      "count($strLen>50)",
      () => col.count({ title: { $strLen: { $gt: 50 } } }),
      5,
    );

    // --- Approach B: col.find({ title: { $exists: true } }) + JS.filter ---
    const findJsFilter = await measure(
      "find($exists)+JS filter",
      async () => {
        const { records } = await col.find({ filter: { title: { $exists: true } } });
        return records.filter((r) => typeof r.title === "string" && (r.title as string).length > 50).length;
      },
      5,
    );

    const timeRatio = findJsFilter.avgMs / countStrLen.avgMs;
    const memRatio = findJsFilter.heapDeltaKB / (Math.abs(countStrLen.heapDeltaKB) || 1);

    console.log(`\n  ── Disk-mode comparison (${N} records, 50% match rate) ──`);
    console.log(`  count($strLen): ${countStrLen.avgMs.toFixed(1)}ms  heap_delta=${countStrLen.heapDeltaKB}KB`);
    console.log(`  find($exists)+JS: ${findJsFilter.avgMs.toFixed(1)}ms  heap_delta=${findJsFilter.heapDeltaKB}KB`);
    console.log(`  Time ratio (find/count): ${timeRatio.toFixed(2)}×`);
    console.log(`  Memory ratio (find/count): ${memRatio.toFixed(1)}×`);
    console.log("");

    await db.close();

    // Store for final summary
    (globalThis as Record<string, unknown>).__strLen_disk_results__ = {
      n: N,
      countStrLen,
      findJsFilter,
      timeRatio,
      memRatio,
    };
  });

  it("simple equality count baseline (disk mode)", { timeout: 60_000 }, async () => {
    // Sanity check: simpler filter for comparison context
    const dirBench = join(tmpDir, "disk100k");
    const db = new AgentDB(dirBench, { storageMode: "disk" });
    await db.init();
    const col = await db.collection("docs");

    // Insert a 'status' field on a fresh simpler collection for baseline
    // Actually just count all (no filter) — disk fast path
    const countAll = await measure("count() no filter", () => col.count(), 5);
    console.log(`  [baseline] count() no filter (disk fast path): ${countAll.avgMs.toFixed(2)}ms`);

    await db.close();
  });
});
