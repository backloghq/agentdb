/**
 * 1M record scale test — in-memory mode only.
 * One run, rough order-of-magnitude confirmation.
 */
import { describe, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDB } from "../src/agentdb.js";
import { getTools } from "../src/tools/index.js";
import type { AgentTool } from "../src/tools/index.js";

function toolExec(tools: AgentTool[], name: string) {
  const t = tools.find((t) => t.name === name)!;
  return async (args: Record<string, unknown>) => {
    const r = await t.execute(args);
    if (r.isError) throw new Error((r.content[0] as { text: string }).text);
    return JSON.parse((r.content[0] as { text: string }).text);
  };
}

const N = 1_000_000;
const CHUNK = 50_000;

describe(`1M record scale test (in-memory)`, () => {
  it("seed, cold-start, query, count, infer, migrate", { timeout: 600_000 }, async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "bench-1m-"));

    // ── Phase 1: seed 1M records (async mode for speed) ──────────────────────
    console.log(`  [1M] seeding ${N} records...`);
    const t0Seed = performance.now();
    {
      const db = new AgentDB(tmpDir, { writeMode: "async", checkpointThreshold: 100_000 });
      await db.init();
      const col = await db.collection("items");
      for (let start = 0; start < N; start += CHUNK) {
        const size = Math.min(CHUNK, N - start);
        await col.insertMany(Array.from({ length: size }, (_, i) => ({
          _id: `r-${start + i}`,
          title: `Item ${start + i}`,
          status: (start + i) % 10 === 0 ? "open" : "closed",  // 10% open
          category: ["A", "B", "C", "D"][(start + i) % 4],
          score: (start + i) % 100,
          body: "x".repeat(60),
        })));
      }
      await db.close();
    }
    const seedMs = performance.now() - t0Seed;
    console.log(`  [1M] seed done: ${(seedMs / 1000).toFixed(1)}s (${Math.round(N / (seedMs / 1000)).toLocaleString()} rec/sec)`);

    // ── Phase 2: cold start (re-open + collection load) ───────────────────────
    const t0Init = performance.now();
    const db = new AgentDB(tmpDir, { checkpointThreshold: 100_000 });
    await db.init();
    const col = await db.collection("items");  // triggers opslog replay
    const initMs = performance.now() - t0Init;
    const total = await col.count();
    console.log(`  [1M] cold start (init + collection open): ${initMs.toFixed(0)}ms [loaded ${total.toLocaleString()} records]`);
    if (initMs > 5000) console.log(`  ⚠ cold start > 5s`);

    const tools = getTools(db);
    const execCount  = toolExec(tools, "db_count");
    const execFind   = toolExec(tools, "db_find");
    const execInfer  = toolExec(tools, "db_infer_schema");
    const execMigrate = toolExec(tools, "db_migrate");

    // ── db_find first 100 records ─────────────────────────────────────────────
    const t0Find = performance.now();
    const findR = await execFind({ collection: "items", filter: {}, limit: 100 }) as { records: unknown[] };
    const findMs = performance.now() - t0Find;
    console.log(`  [1M] db_find({}, limit:100): ${findMs.toFixed(1)}ms [returned ${findR.records.length} records]`);
    if (findMs > 5000) console.log(`  ⚠ find > 5s`);

    // ── db_count({}) full scan ────────────────────────────────────────────────
    const t0CountAll = performance.now();
    const countAll = await execCount({ collection: "items", filter: {} }) as { count: number };
    const countAllMs = performance.now() - t0CountAll;
    console.log(`  [1M] db_count({}): ${countAllMs.toFixed(0)}ms [count=${countAll.count.toLocaleString()}]`);
    if (countAllMs > 5000) console.log(`  ⚠ count({}) > 5s`);

    // ── db_count({status:"open"}) without index (10% selectivity) ────────────
    const t0CountFiltered = performance.now();
    const countOpen = await execCount({ collection: "items", filter: { status: "open" } }) as { count: number };
    const countFilteredMs = performance.now() - t0CountFiltered;
    console.log(`  [1M] db_count({status:"open"}) no index: ${countFilteredMs.toFixed(0)}ms [count=${countOpen.count.toLocaleString()}]`);
    if (countFilteredMs > 5000) console.log(`  ⚠ count(filter) no-index > 5s`);

    // ── db_count({status:"open"}) WITH index ─────────────────────────────────
    col.createIndex("status");
    const t0CountIdx = performance.now();
    const countOpenIdx = await execCount({ collection: "items", filter: { status: "open" } }) as { count: number };
    const countIdxMs = performance.now() - t0CountIdx;
    console.log(`  [1M] db_count({status:"open"}) with index: ${countIdxMs.toFixed(0)}ms [count=${countOpenIdx.count.toLocaleString()}]`);
    const idxSpeedup = countFilteredMs / Math.max(countIdxMs, 0.1);
    console.log(`  [1M] index speedup: ${idxSpeedup.toFixed(0)}×`);

    // ── db_infer_schema (O(N) iterate) ────────────────────────────────────────
    const t0Infer = performance.now();
    await execInfer({ collection: "items", sampleSize: 100 });
    const inferMs = performance.now() - t0Infer;
    console.log(`  [1M] db_infer_schema(sampleSize:100): ${inferMs.toFixed(0)}ms`);
    if (inferMs > 5000) console.log(`  ⚠ infer > 5s`);

    // ── db_migrate: set op on 10K records (status:"open") ─────────────────────
    const t0Migrate = performance.now();
    const migR = await execMigrate({
      collection: "items",
      filter: { status: "open" },
      ops: [{ op: "set", field: "score", value: 99 }],
      dryRun: false,
    }) as { updated: number; scanned: number };
    const migrateMs = performance.now() - t0Migrate;
    console.log(`  [1M] db_migrate({status:"open"}, set score=99): ${migrateMs.toFixed(0)}ms [scanned=${migR.scanned.toLocaleString()} updated=${migR.updated.toLocaleString()}]`);

    // ── Summary table ─────────────────────────────────────────────────────────
    console.log(`\n  ┌─────────────────────────────────────────────────────┐`);
    console.log(`  │  Operation                          Latency          │`);
    console.log(`  ├─────────────────────────────────────────────────────┤`);
    console.log(`  │  Seed 1M records (async)            ${(seedMs/1000).toFixed(1)}s               │`);
    console.log(`  │  Cold start (init + open)           ${initMs.toFixed(0)}ms               │`);
    console.log(`  │  db_find({}, limit:100)             ${findMs.toFixed(1)}ms               │`);
    console.log(`  │  db_count({}) full scan             ${countAllMs.toFixed(0)}ms               │`);
    console.log(`  │  db_count(status:open) no index     ${countFilteredMs.toFixed(0)}ms               │`);
    console.log(`  │  db_count(status:open) with index   ${countIdxMs.toFixed(0)}ms (${idxSpeedup.toFixed(0)}× faster)  │`);
    console.log(`  │  db_infer_schema (100 samples)      ${inferMs.toFixed(0)}ms               │`);
    console.log(`  │  db_migrate 100K→set (real write)   ${migrateMs.toFixed(0)}ms               │`);
    console.log(`  └─────────────────────────────────────────────────────┘`);

    await db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });
});
