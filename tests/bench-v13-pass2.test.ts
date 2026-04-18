/**
 * v1.3 second-pass benchmarks:
 * A. Verify infer_schema O(N) fix + iterate() heap savings
 * B. New angles: migrate immediate mode, schema bootstrap 50-field, diff_schema disk, iterate throughput, tool-layer stability
 */
import { describe, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDB } from "../src/agentdb.js";
import { getTools } from "../src/tools/index.js";
import type { AgentTool } from "../src/tools/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toolExec(tools: AgentTool[], name: string) {
  const t = tools.find((t) => t.name === name)!;
  return async (args: Record<string, unknown>) => {
    const result = await t.execute(args);
    if (result.isError) throw new Error((result.content[0] as { text: string }).text);
    return JSON.parse((result.content[0] as { text: string }).text);
  };
}

function makeRecord(i: number, bodySize = 60): Record<string, unknown> {
  return {
    _id: `r-${i}`,
    title: "T".repeat(10 + (i % 60)),
    status: ["open", "closed", "pending"][i % 3],
    body: "x".repeat(bodySize),
  };
}

async function insertChunked(col: Awaited<ReturnType<AgentDB["collection"]>>, n: number, chunkSize = 5_000, bodySize = 60) {
  for (let start = 0; start < n; start += chunkSize) {
    const batch = Array.from({ length: Math.min(chunkSize, n - start) }, (_, i) => makeRecord(start + i, bodySize));
    await col.insertMany(batch);
  }
}

// ---------------------------------------------------------------------------
// A.1  db_infer_schema: verify O(N) scaling after fix
// ---------------------------------------------------------------------------
describe("A.1 db_infer_schema — O(N) scaling verification", () => {
  it("1K / 10K / 50K records — should now scale linearly", { timeout: 120_000 }, async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "bench-infer-linear-"));
    const db = new AgentDB(tmpDir, { writeMode: "async" });
    await db.init();
    const tools = getTools(db);
    const execInfer = toolExec(tools, "db_infer_schema");

    const timings: Record<string, number> = {};
    for (const N of [1_000, 10_000, 50_000]) {
      const coll = `infer-${N}`;
      const col = await db.collection(coll);
      await insertChunked(col, N);
      const t0 = performance.now();
      await execInfer({ collection: coll, sampleSize: 100 });
      timings[N] = performance.now() - t0;
      console.log(`  [A.1] infer ${N}: ${timings[N].toFixed(1)}ms`);
    }
    const scale10 = timings[10_000] / timings[1_000];
    const scale50 = timings[50_000] / timings[10_000];
    console.log(`  [A.1] 1K→10K scale factor: ${scale10.toFixed(1)}× (linear = 10×, O(N²) = 100×)`);
    console.log(`  [A.1] 10K→50K scale factor: ${scale50.toFixed(1)}× (linear = 5×, O(N²) = 25×)`);

    await db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// A.2  db_infer_schema disk-mode: heap delta should be O(sampleSize), not O(N)
// ---------------------------------------------------------------------------
describe("A.2 db_infer_schema disk-mode — heap delta with 100K records", () => {
  it("setup 100K Parquet records + measure heap during infer", { timeout: 300_000 }, async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "bench-infer-disk-"));

    // Setup: insert 100K records, close to compact to Parquet
    {
      const db = new AgentDB(tmpDir, { storageMode: "disk", writeMode: "async" });
      await db.init();
      const col = await db.collection("docs");
      await insertChunked(col, 100_000, 10_000);
      await db.close();  // triggers Parquet compaction
    }

    // Benchmark: re-open, measure heap
    const db = new AgentDB(tmpDir, { storageMode: "disk" });
    await db.init();
    const col = await db.collection("docs");
    const total = await col.count();
    console.log(`  [A.2] disk collection: ${total} records from Parquet`);

    const tools = getTools(db);
    const execInfer = toolExec(tools, "db_infer_schema");

    // warm-up
    await execInfer({ collection: "docs", sampleSize: 100 });

    const heapBefore = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    await execInfer({ collection: "docs", sampleSize: 100 });
    const ms = performance.now() - t0;
    const heapAfter = process.memoryUsage().heapUsed;
    const deltaMB = (heapAfter - heapBefore) / 1024 / 1024;

    console.log(`  [A.2] infer 100K disk: ${ms.toFixed(0)}ms, heap_delta=${deltaMB.toFixed(1)}MB`);
    if (deltaMB < 50) {
      console.log(`  [A.2] ✓ heap_delta < 50MB — iterate() streaming is working`);
    } else {
      console.log(`  [A.2] ✗ heap_delta ≥ 50MB — streaming may not be effective`);
    }

    await db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// B.3  Tool-layer stability — 500 mixed ops, track heap growth
// ---------------------------------------------------------------------------
describe("B.3 Tool-layer stability — 500 mixed ops, heap tracking", () => {
  it("500 ops: mix of find / insert / diff_schema / count — no linear growth", { timeout: 120_000 }, async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "bench-stability-"));
    const db = new AgentDB(tmpDir, { writeMode: "async" });
    await db.init();
    const tools = getTools(db);
    const execFind = toolExec(tools, "db_find");
    const execInsert = toolExec(tools, "db_insert");
    const execCount = toolExec(tools, "db_count");
    const execDiff = toolExec(tools, "db_diff_schema");

    // Seed collection
    const col = await db.collection("tasks");
    await insertChunked(col, 5_000);

    const TOTAL_OPS = 500;
    const SAMPLE_INTERVAL = 50;  // snapshot heap every 50 ops
    const heapSamples: { op: number; heapMB: number }[] = [];

    for (let i = 0; i < TOTAL_OPS; i++) {
      const op = i % 5;
      if (op === 0) await execFind({ collection: "tasks", filter: { status: "open" }, limit: 20 });
      else if (op === 1) await execInsert({ collection: "tasks", record: { title: `Task ${i}`, status: "open", body: "x".repeat(60) } });
      else if (op === 2) await execCount({ collection: "tasks", filter: { status: "closed" } });
      else if (op === 3) await execFind({ collection: "tasks", filter: {}, limit: 10 });
      else await execDiff({ collection: "tasks", schema: { fields: { title: { type: "string", maxLength: 80 } } }, includeImpact: false });

      if (i % SAMPLE_INTERVAL === 0) {
        heapSamples.push({ op: i, heapMB: process.memoryUsage().heapUsed / 1024 / 1024 });
      }
    }

    const first = heapSamples[0].heapMB;
    const last = heapSamples[heapSamples.length - 1].heapMB;
    const growth = last - first;
    console.log(`  [B.3] heap samples: ${heapSamples.map(s => `op${s.op}=${s.heapMB.toFixed(1)}MB`).join(", ")}`);
    console.log(`  [B.3] heap growth over 500 ops: ${growth >= 0 ? "+" : ""}${growth.toFixed(1)}MB`);
    if (Math.abs(growth) < 20) {
      console.log(`  [B.3] ✓ stable heap — no significant leak detected`);
    } else {
      console.log(`  [B.3] ⚠ potential heap growth — investigate`);
    }

    await db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// B.4  db_migrate: immediate mode (default) vs async — 2K and 10K records
// ---------------------------------------------------------------------------
describe("B.4 db_migrate — immediate mode vs async mode", () => {
  it("2K records: immediate vs async write throughput", { timeout: 120_000 }, async () => {
    const N = 2_000;

    for (const [label, opts] of [["immediate", {}], ["async", { writeMode: "async" as const }]] as const) {
      const tmpDir = await mkdtemp(join(tmpdir(), `bench-migrate-${label}-`));
      const db = new AgentDB(tmpDir, opts);
      await db.init();
      const col = await db.collection("tasks");
      await col.insertMany(Array.from({ length: N }, (_, i) => makeRecord(i)));
      const tools = getTools(db);
      const execMigrate = toolExec(tools, "db_migrate");

      const t0 = performance.now();
      const r = await execMigrate({ collection: "tasks", filter: {}, ops: [{ op: "set", field: "migrated", value: true }], dryRun: false });
      const ms = performance.now() - t0;
      const recsPerSec = Math.round(N / (ms / 1000));
      console.log(`  [B.4] migrate ${N} records (${label}): ${ms.toFixed(0)}ms → ${recsPerSec} rec/sec [updated=${(r as {updated:number}).updated}]`);

      await db.close();
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("10K records: immediate mode only (measures real I/O cost)", { timeout: 300_000 }, async () => {
    const N = 10_000;
    const tmpDir = await mkdtemp(join(tmpdir(), "bench-migrate-10k-imm-"));
    const db = new AgentDB(tmpDir);  // immediate (default)
    await db.init();
    const col = await db.collection("tasks");
    await insertChunked(col, N, 5_000);
    const tools = getTools(db);
    const execMigrate = toolExec(tools, "db_migrate");

    const t0 = performance.now();
    const r = await execMigrate({ collection: "tasks", filter: {}, ops: [{ op: "set", field: "migrated", value: true }], dryRun: false });
    const ms = performance.now() - t0;
    const recsPerSec = Math.round(N / (ms / 1000));
    console.log(`  [B.4] migrate ${N} records (immediate): ${ms.toFixed(0)}ms → ${recsPerSec} rec/sec [updated=${(r as {updated:number}).updated}]`);

    await db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// B.5  Schema bootstrap: 100 × 50-field schemas — init time + cost breakdown
// ---------------------------------------------------------------------------
describe("B.5 Schema bootstrap — 100 × 50-field schemas", () => {
  it("init time + per-component breakdown", { timeout: 60_000 }, async () => {
    const FILE_COUNT = 100;
    const FIELDS = 50;
    const tmpDir = await mkdtemp(join(tmpdir(), "bench-boot50-"));
    await mkdir(join(tmpDir, "schemas"), { recursive: true });

    // Generate 50-field schemas
    for (let i = 0; i < FILE_COUNT; i++) {
      const fields: Record<string, { type: string; maxLength?: number; description?: string }> = {};
      for (let f = 0; f < FIELDS; f++) {
        fields[`field_${f}`] = { type: "string", maxLength: 200, description: `Field ${f} for collection ${i}` };
      }
      const schema = { name: `collection-${i}`, description: `Collection ${i}`, fields };
      await writeFile(join(tmpDir, "schemas", `collection-${i}.json`), JSON.stringify(schema));
    }

    // Measure total init time
    const t0 = performance.now();
    const db = new AgentDB(tmpDir);
    await db.init();
    const totalMs = performance.now() - t0;
    await db.close();

    console.log(`  [B.5] init ${FILE_COUNT} × ${FIELDS}-field schemas: ${totalMs.toFixed(0)}ms total`);
    console.log(`  [B.5] per file: ${(totalMs / FILE_COUNT).toFixed(2)}ms`);

    // Isolate component costs
    const { mergePersistedSchemas: mergePersisted } = await import("../src/schema.js");
    const largeSchema = {
      name: "bench",
      fields: Object.fromEntries(Array.from({ length: FIELDS }, (_, i) => [`field_${i}`, { type: "string" as const, maxLength: 200, description: `Field ${i}` }])),
    };

    // JSON parse cost (100 files)
    const parseStart = performance.now();
    for (let i = 0; i < 1000; i++) JSON.parse(JSON.stringify(largeSchema));
    const parseMs = (performance.now() - parseStart) / 1000;

    // mergePersistedSchemas cost
    const mergeStart = performance.now();
    for (let i = 0; i < 1000; i++) mergePersisted(largeSchema, largeSchema);
    const mergeMs = (performance.now() - mergeStart) / 1000;

    console.log(`  [B.5] JSON parse (50-field): ${parseMs.toFixed(3)}ms/call`);
    console.log(`  [B.5] mergePersistedSchemas (50-field): ${mergeMs.toFixed(3)}ms/call`);
    console.log(`  [B.5] estimated write I/O: ~${(totalMs / FILE_COUNT - parseMs - mergeMs).toFixed(2)}ms/file`);

    await rm(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// B.6  db_diff_schema + $strLen on disk-mode 100K records
// ---------------------------------------------------------------------------
describe("B.6 db_diff_schema on 100K disk-mode records", () => {
  it("maxLength change: includeImpact:true vs false on Parquet-backed 100K", { timeout: 300_000 }, async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "bench-diff-disk-"));

    // Setup: 100K records in disk mode, compact to Parquet
    {
      const db = new AgentDB(tmpDir, { storageMode: "disk", writeMode: "async" });
      await db.init();
      const col = await db.collection("docs");
      await insertChunked(col, 100_000, 10_000);
      // Set baseline schema
      const tools = getTools(db);
      await toolExec(tools, "db_set_schema")({
        collection: "docs",
        schema: { fields: { title: { type: "string", maxLength: 100 }, status: { type: "string" }, body: { type: "string" } } },
      });
      await db.close();
    }

    const db = new AgentDB(tmpDir, { storageMode: "disk" });
    await db.init();
    const tools = getTools(db);
    const execDiff = toolExec(tools, "db_diff_schema");

    const candidate = { fields: { title: { type: "string", maxLength: 50 } } };

    // includeImpact: true (triggers $strLen scan over Parquet)
    const t0 = performance.now();
    await execDiff({ collection: "docs", schema: candidate, includeImpact: true });
    const withImpactMs = performance.now() - t0;

    // includeImpact: false
    const t1 = performance.now();
    await execDiff({ collection: "docs", schema: candidate, includeImpact: false });
    const noImpactMs = performance.now() - t1;

    console.log(`  [B.6] diff 100K disk, maxLength, impact=true:  ${withImpactMs.toFixed(0)}ms`);
    console.log(`  [B.6] diff 100K disk, maxLength, impact=false: ${noImpactMs.toFixed(0)}ms`);
    console.log(`  [B.6] impact scan overhead: ${(withImpactMs / noImpactMs).toFixed(1)}× on 100K Parquet records`);

    await db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// B.7  col.iterate() raw throughput — memory vs disk mode
// ---------------------------------------------------------------------------
describe("B.7 col.iterate() raw throughput — memory vs disk", () => {
  it("10K records memory mode: records/sec through iterate()", { timeout: 60_000 }, async () => {
    const N = 10_000;
    const tmpDir = await mkdtemp(join(tmpdir(), "bench-iter-mem-"));
    const db = new AgentDB(tmpDir, { writeMode: "async" });
    await db.init();
    const col = await db.collection("docs");
    await insertChunked(col, N, N);

    // warm-up
    for await (const _ of col.iterate()) { void _; }

    const t0 = performance.now();
    let count = 0;
    for await (const _ of col.iterate()) { count++; void _; }
    const ms = performance.now() - t0;
    const recsPerSec = Math.round(count / (ms / 1000));
    console.log(`  [B.7] iterate() memory ${N} records: ${ms.toFixed(1)}ms → ${recsPerSec.toLocaleString()} rec/sec`);

    await db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("100K records disk mode (Parquet): records/sec through iterate()", { timeout: 300_000 }, async () => {
    const N = 100_000;
    const tmpDir = await mkdtemp(join(tmpdir(), "bench-iter-disk-"));

    // Setup: insert + compact
    {
      const db = new AgentDB(tmpDir, { storageMode: "disk", writeMode: "async" });
      await db.init();
      const col = await db.collection("docs");
      await insertChunked(col, N, 10_000);
      await db.close();
    }

    const db = new AgentDB(tmpDir, { storageMode: "disk" });
    await db.init();
    const col = await db.collection("docs");

    // warm-up pass
    for await (const _ of col.iterate()) { void _; }

    const t0 = performance.now();
    let count = 0;
    for await (const _ of col.iterate()) { count++; void _; }
    const ms = performance.now() - t0;
    const recsPerSec = Math.round(count / (ms / 1000));
    console.log(`  [B.7] iterate() disk ${N} records: ${ms.toFixed(0)}ms → ${recsPerSec.toLocaleString()} rec/sec`);

    await db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });
});
