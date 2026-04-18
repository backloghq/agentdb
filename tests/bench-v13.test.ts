/**
 * v1.3 Performance Benchmark Suite
 * Covers: db_diff_schema, db_migrate, db_infer_schema, schema bootstrap,
 *         $strLen operator, persistSchema, mergeSchemas/mergePersistedSchemas
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDB } from "../src/agentdb.js";
import { getTools } from "../src/tools/index.js";
import type { AgentTool } from "../src/tools/index.js";
import {
  mergeSchemas,
  mergePersistedSchemas,
  extractPersistedSchema,
  defineSchema,
} from "../src/schema.js";
import type { PersistedSchema } from "../src/schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface BenchResult {
  name: string;
  totalMs: number;
  avgMs: number;
  opsPerSec: number;
}

async function bench(
  name: string,
  fn: () => Promise<void>,
  iterations = 1,
): Promise<BenchResult> {
  // warm-up
  await fn();
  const start = performance.now();
  for (let i = 1; i < iterations; i++) await fn();
  const elapsed = performance.now() - start;
  const count = Math.max(iterations - 1, 1);
  return {
    name,
    totalMs: Math.round((elapsed + (iterations > 1 ? 0 : 0)) * 100) / 100,
    avgMs: Math.round((elapsed / count) * 1000) / 1000,
    opsPerSec: Math.round(count / (elapsed / 1000)),
  };
}

function benchSync(name: string, fn: () => void, iterations = 1000): BenchResult {
  fn(); // warm-up
  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const elapsed = performance.now() - start;
  return {
    name,
    totalMs: Math.round(elapsed * 100) / 100,
    avgMs: Math.round((elapsed / iterations) * 1000) / 1000,
    opsPerSec: Math.round(iterations / (elapsed / 1000)),
  };
}

function log(r: BenchResult) {
  console.log(`  [bench] ${r.name}: avg=${r.avgMs}ms ops/sec=${r.opsPerSec}`);
}

function toolExec(tools: AgentTool[], name: string) {
  const t = tools.find((t) => t.name === name)!;
  return async (args: Record<string, unknown>) => {
    const result = await t.execute(args);
    if (result.isError) throw new Error((result.content[0] as { text: string }).text);
    return JSON.parse((result.content[0] as { text: string }).text);
  };
}

/** Build N records with 5 string fields and 3 enum fields */
function makeRecord(i: number, bodySize = 80): Record<string, unknown> {
  const body = "x".repeat(bodySize);
  return {
    _id: `r-${i}`,
    title: `Title ${i} ${"A".repeat(i % 80)}`,  // length varies 7–87
    slug: `slug-${i}`,
    desc: body,
    notes: `note-${i}`,
    ref: `REF${String(i).padStart(6, "0")}`,
    status: ["open", "closed", "pending"][i % 3],
    priority: ["low", "medium", "high"][i % 3],
    category: ["bug", "feature", "task"][i % 3],
  };
}

function makeSchemaWith(fields: number, nIndexes = 0): PersistedSchema {
  const fieldDefs: Record<string, { type: "string"; maxLength?: number; description?: string }> = {};
  for (let i = 0; i < fields; i++) {
    fieldDefs[`field${i}`] = {
      type: "string",
      maxLength: 200,
      description: `Field ${i} description text that is moderately long`,
    };
  }
  return {
    name: "bench",
    description: "A benchmark schema with many fields",
    fields: fieldDefs,
    indexes: Array.from({ length: nIndexes }, (_, i) => `field${i}`),
  };
}

// ---------------------------------------------------------------------------
// Global shared state — one db per test, each with a unique collection name
// ---------------------------------------------------------------------------

const results: Record<string, BenchResult | Record<string, BenchResult>> = {};

describe("v1.3 Performance Benchmarks", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agentdb-bench-v13-"));
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });

    // -----------------------------------------------------------------------
    // Print consolidated report
    // -----------------------------------------------------------------------
    console.log("\n" + "=".repeat(70));
    console.log("  v1.3 BENCHMARK RESULTS");
    console.log("=".repeat(70));
    for (const [group, val] of Object.entries(results)) {
      if ("name" in val) {
        const r = val as BenchResult;
        console.log(`  ${group}: avg=${r.avgMs}ms  ops/sec=${r.opsPerSec}`);
      } else {
        console.log(`\n  ${group}:`);
        for (const [k, r] of Object.entries(val as Record<string, BenchResult>)) {
          console.log(`    ${k}: avg=${r.avgMs}ms  ops/sec=${r.opsPerSec}`);
        }
      }
    }
    console.log("=".repeat(70) + "\n");
  });

  // =========================================================================
  // 1. db_diff_schema — impact scan
  // =========================================================================
  describe("1. db_diff_schema", () => {
    const COLL = "diff-bench";
    const N = 10_000;
    let db: AgentDB;
    let exec: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

    beforeAll(async () => {
      const dir = join(tmpDir, "diff");
      db = new AgentDB(dir, { writeMode: "async" });
      await db.init();
      const col = await db.collection(COLL);
      // Bulk insert
      await col.insertMany(Array.from({ length: N }, (_, i) => makeRecord(i)));
      // Set a baseline schema
      const tools = getTools(db);
      exec = toolExec(tools, "db_diff_schema");
      await toolExec(tools, "db_set_schema")({
        collection: COLL,
        schema: {
          fields: {
            title:    { type: "string", maxLength: 100 },
            slug:     { type: "string", maxLength: 80 },
            desc:     { type: "string", maxLength: 200 },
            notes:    { type: "string" },
            ref:      { type: "string" },
            status:   { type: "enum", values: ["open", "closed", "pending"] },
            priority: { type: "enum", values: ["low", "medium", "high"] },
            category: { type: "enum", values: ["bug", "feature", "task"] },
          },
        },
      });
    }, 60_000);

    afterAll(async () => { await db.close(); });

    it("maxLength change — includeImpact:true (forces $strLen scan)", { timeout: 60_000 }, async () => {
      const candidate = {
        fields: { title: { type: "string", maxLength: 50 } },
      };
      const r = await bench(
        "diff maxLength impact=true",
        () => exec({ collection: COLL, schema: candidate, includeImpact: true }),
        5,
      );
      log(r);
      results["diff.maxLength.impact=true"] = r;
    });

    it("maxLength change — includeImpact:false (no scan)", { timeout: 60_000 }, async () => {
      const candidate = {
        fields: { title: { type: "string", maxLength: 50 } },
      };
      const r = await bench(
        "diff maxLength impact=false",
        () => exec({ collection: COLL, schema: candidate, includeImpact: false }),
        5,
      );
      log(r);
      results["diff.maxLength.impact=false"] = r;
    });

    it("required:true change — includeImpact:true (forces $exists:false count)", { timeout: 60_000 }, async () => {
      const candidate = {
        fields: { notes: { type: "string", required: true } },
      };
      const r = await bench(
        "diff required impact=true",
        () => exec({ collection: COLL, schema: candidate, includeImpact: true }),
        5,
      );
      log(r);
      results["diff.required.impact=true"] = r;
    });

    it("field removal — includeImpact:true", { timeout: 60_000 }, async () => {
      const candidate = {
        fields: {
          title:    { type: "string", maxLength: 100 },
          slug:     { type: "string", maxLength: 80 },
          desc:     { type: "string", maxLength: 200 },
          notes:    { type: "string" },
          ref:      { type: "string" },
          status:   { type: "enum", values: ["open", "closed", "pending"] },
          priority: { type: "enum", values: ["low", "medium", "high"] },
          // category removed
        },
      };
      const r = await bench(
        "diff field-removal impact=true",
        () => exec({ collection: COLL, schema: candidate, includeImpact: true }),
        5,
      );
      log(r);
      results["diff.removal.impact=true"] = r;
    });

    it("$strLen pushdown vs manual col.find()+JS filter", { timeout: 60_000 }, async () => {
      const col = await db.collection(COLL);
      // $strLen count via compiled filter
      const strlenR = await bench(
        "$strLen count on 10K",
        () => col.count({ title: { $strLen: { $gt: 50 } } }),
        10,
      );
      log(strlenR);
      results["strLen.count.compiled"] = strlenR;

      // Manual: find all with field, then filter in JS
      const manualR = await bench(
        "manual find+JS filter on 10K",
        async () => {
          const { records } = await col.find({ filter: { title: { $exists: true } } });
          let n = 0;
          for (const r of records) {
            if (typeof r.title === "string" && r.title.length > 50) n++;
          }
          return n;
        },
        10,
      );
      log(manualR);
      results["strLen.count.manual"] = manualR;

      const speedup = manualR.avgMs / strlenR.avgMs;
      console.log(`  [bench] $strLen speedup vs manual: ${speedup.toFixed(1)}x`);
    });
  });

  // =========================================================================
  // 2. db_migrate throughput
  // =========================================================================
  describe("2. db_migrate", () => {
    afterAll(async () => { /* db closed per sub-test */ });

    it("dryRun vs real-write, 2K records", { timeout: 120_000 }, async () => {
      const N = 2_000;
      const records = Array.from({ length: N }, (_, i) => makeRecord(i));

      // --- dryRun ---
      const dirDry = join(tmpDir, "migrate-dry");
      const dbDry = new AgentDB(dirDry, { writeMode: "async" });
      await dbDry.init();
      const colDry = await dbDry.collection("tasks");
      await colDry.insertMany(records);
      const toolsDry = getTools(dbDry);
      const execDry = toolExec(toolsDry, "db_migrate");

      const t0Dry = performance.now();
      await execDry({ collection: "tasks", filter: {}, ops: [{ op: "set", field: "migrated", value: true }], dryRun: true });
      const dryMs = performance.now() - t0Dry;
      await dbDry.close();

      // --- real write ---
      const dirReal = join(tmpDir, "migrate-real");
      const dbReal = new AgentDB(dirReal, { writeMode: "async" });
      await dbReal.init();
      const colReal = await dbReal.collection("tasks");
      await colReal.insertMany(records);
      const toolsReal = getTools(dbReal);
      const execReal = toolExec(toolsReal, "db_migrate");

      const t0Real = performance.now();
      await execReal({ collection: "tasks", filter: {}, ops: [{ op: "set", field: "migrated", value: true }], dryRun: false });
      const realMs = performance.now() - t0Real;
      await dbReal.close();

      const dryR: BenchResult = { name: `migrate dryRun ${N}`, totalMs: dryMs, avgMs: dryMs, opsPerSec: Math.round(N / (dryMs / 1000)) };
      const realR: BenchResult = { name: `migrate real ${N}`, totalMs: realMs, avgMs: realMs, opsPerSec: Math.round(N / (realMs / 1000)) };
      log(dryR);
      log(realR);
      console.log(`  [bench] write overhead: ${(realMs - dryMs).toFixed(0)}ms extra for ${N} records (${((realMs / dryMs)).toFixed(1)}x)`);
      results["migrate.dryRun.2K"] = dryR;
      results["migrate.realWrite.2K"] = realR;
    });

    it("record-size stress: 100B vs 1KB vs 10KB (500 records each)", { timeout: 120_000 }, async () => {
      const N = 500;

      for (const [label, bodySize] of [["100B", 100], ["1KB", 1_000], ["10KB", 10_000]] as const) {
        const dirSize = join(tmpDir, `migrate-size-${label}`);
        const dbSize = new AgentDB(dirSize, { writeMode: "async" });
        await dbSize.init();
        const col = await dbSize.collection("items");
        await col.insertMany(Array.from({ length: N }, (_, i) => makeRecord(i, bodySize)));
        const toolsSize = getTools(dbSize);
        const execSize = toolExec(toolsSize, "db_migrate");

        const t0 = performance.now();
        await execSize({ collection: "items", filter: {}, ops: [{ op: "set", field: "tag", value: "migrated" }], dryRun: false });
        const ms = performance.now() - t0;
        await dbSize.close();

        const r: BenchResult = { name: `migrate ${N}x${label}`, totalMs: ms, avgMs: ms / N, opsPerSec: Math.round(N / (ms / 1000)) };
        log(r);
        results[`migrate.size.${label}`] = r;
      }
    });

    it("Phase 1 (snapshot) vs Phase 2 (process) cost, 2K records", { timeout: 60_000 }, async () => {
      // Phase 1 approximation: col.find() for snapshot (what the tool does internally)
      const N = 2_000;
      const dirP = join(tmpDir, "migrate-phases");
      const dbP = new AgentDB(dirP, { writeMode: "async" });
      await dbP.init();
      const col = await dbP.collection("items");
      await col.insertMany(Array.from({ length: N }, (_, i) => makeRecord(i)));

      // Phase 1 only: scan to get IDs (approximation via col.find())
      const t0 = performance.now();
      await col.find({ filter: {} });
      const phase1Ms = performance.now() - t0;

      // Full dryRun = Phase1 + Phase2 (no writes)
      const tools = getTools(dbP);
      const execP = toolExec(tools, "db_migrate");
      const t1 = performance.now();
      await execP({ collection: "items", filter: {}, ops: [{ op: "set", field: "tag", value: "v2" }], dryRun: true });
      const totalDryMs = performance.now() - t1;

      const phase2Ms = totalDryMs - phase1Ms;
      console.log(`  [bench] migrate ${N} records — Phase1≈${phase1Ms.toFixed(0)}ms Phase2≈${phase2Ms.toFixed(0)}ms total=${totalDryMs.toFixed(0)}ms`);
      results["migrate.phase1.2K"] = { name: "phase1 scan", totalMs: phase1Ms, avgMs: phase1Ms, opsPerSec: Math.round(N / (phase1Ms / 1000)) };
      results["migrate.phase2.2K"] = { name: "phase2 process", totalMs: phase2Ms, avgMs: phase2Ms, opsPerSec: Math.round(N / (Math.max(phase2Ms, 0.001) / 1000)) };
      await dbP.close();
    });
  });

  // =========================================================================
  // 3. db_infer_schema — reservoir sampling cost
  // =========================================================================
  describe("3. db_infer_schema", () => {
    it("1K / 10K / 50K records — ms per inference", { timeout: 120_000 }, async () => {
      const dirI = join(tmpDir, "infer");
      const dbI = new AgentDB(dirI, { writeMode: "async" });
      await dbI.init();
      const tools = getTools(dbI);
      const execInfer = toolExec(tools, "db_infer_schema");

      for (const N of [1_000, 10_000, 50_000]) {
        const coll = `infer-${N}`;
        const col = await dbI.collection(coll);
        await col.insertMany(Array.from({ length: N }, (_, i) => makeRecord(i)));

        const t0 = performance.now();
        await execInfer({ collection: coll, sampleSize: 100 });
        const ms = performance.now() - t0;

        const r: BenchResult = {
          name: `infer ${N} records sampleSize=100`,
          totalMs: ms,
          avgMs: ms,
          opsPerSec: Math.round(N / (ms / 1000)),
        };
        log(r);
        results[`infer.${N}`] = r;
      }

      await dbI.close();
    });
  });

  // =========================================================================
  // 4. Schema bootstrap on init
  // =========================================================================
  describe("4. schema bootstrap", () => {
    it("init cost: 1, 10, 100 schema files (+ 1 bad file)", { timeout: 60_000 }, async () => {
      for (const count of [1, 10, 100]) {
        const dir = join(tmpDir, `boot-${count}`);
        await mkdir(join(dir, "schemas"), { recursive: true });

        // Write valid schema files
        for (let i = 0; i < count; i++) {
          const schema: PersistedSchema = {
            name: `collection-${i}`,
            fields: {
              title: { type: "string", maxLength: 100 },
              status: { type: "string" },
              count: { type: "number" },
            },
          };
          await writeFile(join(dir, "schemas", `collection-${i}.json`), JSON.stringify(schema));
        }

        const t0 = performance.now();
        const db = new AgentDB(dir);
        await db.init();
        const ms = performance.now() - t0;
        await db.close();

        const r: BenchResult = { name: `init ${count} files`, totalMs: ms, avgMs: ms / count, opsPerSec: Math.round(count / (ms / 1000)) };
        log(r);
        results[`boot.${count}files`] = r;
      }
    });

    it("bad file in mix — failure isolation overhead (100 files + 1 bad)", { timeout: 30_000 }, async () => {
      const count = 100;
      const dir = join(tmpDir, "boot-bad");
      await mkdir(join(dir, "schemas"), { recursive: true });

      for (let i = 0; i < count; i++) {
        const schema: PersistedSchema = { name: `coll-${i}`, fields: { x: { type: "string" } } };
        await writeFile(join(dir, "schemas", `coll-${i}.json`), JSON.stringify(schema));
      }
      // inject bad file
      await writeFile(join(dir, "schemas", "bad-file.json"), "{ invalid json {{{{");

      const t0 = performance.now();
      const db = new AgentDB(dir);
      await db.init();
      const ms = performance.now() - t0;
      await db.close();

      // compare to clean 100 (already measured above)
      const r: BenchResult = { name: `init 100 files + 1 bad`, totalMs: ms, avgMs: ms / 101, opsPerSec: Math.round(101 / (ms / 1000)) };
      log(r);
      results["boot.100files.badFile"] = r;
    });
  });

  // =========================================================================
  // 5. $strLen operator vs alternatives — regression check
  // =========================================================================
  describe("5. $strLen operator", () => {
    let db: AgentDB;
    beforeAll(async () => {
      const dir = join(tmpDir, "strLen");
      db = new AgentDB(dir, { writeMode: "async" });
      await db.init();
      const col = await db.collection("docs");
      await col.insertMany(Array.from({ length: 10_000 }, (_, i) => ({
        _id: `d-${i}`,
        title: "A".repeat(10 + (i % 100)),  // length 10-109
        status: ["open", "closed"][i % 2],
      })));
    }, 30_000);
    afterAll(async () => { await db.close(); });

    it("col.count $strLen vs simpler filter — no regression", { timeout: 30_000 }, async () => {
      const col = await db.collection("docs");

      // Baseline: simple equality filter (should be fast, no regression)
      const baseR = await bench(
        "count status=open (simple)",
        () => col.count({ status: "open" }),
        20,
      );
      log(baseR);
      results["strLen.baseline.simpleCount"] = baseR;

      // $strLen filter
      const strlenR = await bench(
        "count title $strLen>50 on 10K",
        () => col.count({ title: { $strLen: { $gt: 50 } } }),
        20,
      );
      log(strlenR);
      results["strLen.count.10K"] = strlenR;

      // Manual: find all, JS filter
      const manualR = await bench(
        "find+JS filter title.length>50 on 10K",
        async () => {
          const { records } = await col.find({ filter: { title: { $exists: true } } });
          return records.filter((r) => typeof r.title === "string" && (r.title as string).length > 50).length;
        },
        10,
      );
      log(manualR);
      results["strLen.manual.10K"] = manualR;

      const speedup = manualR.avgMs / strlenR.avgMs;
      console.log(`  [bench] $strLen vs manual speedup: ${speedup.toFixed(1)}x`);
      console.log(`  [bench] $strLen overhead vs simple filter: ${(strlenR.avgMs / baseR.avgMs).toFixed(1)}x`);
    });
  });

  // =========================================================================
  // 6. Schema persistence write cost
  // =========================================================================
  describe("6. persistSchema write cost", () => {
    it("5-field vs 50-field schema — ms per atomic write", { timeout: 30_000 }, async () => {
      const dir = join(tmpDir, "persist");
      const db = new AgentDB(dir);
      await db.init();

      const small = makeSchemaWith(5);
      const large = makeSchemaWith(50);

      const smallR = await bench(
        "persistSchema 5-field",
        () => db.persistSchema("bench-small", { ...small, name: "bench-small" }),
        20,
      );
      log(smallR);
      results["persist.5field"] = smallR;

      const largeR = await bench(
        "persistSchema 50-field",
        () => db.persistSchema("bench-large", { ...large, name: "bench-large" }),
        20,
      );
      log(largeR);
      results["persist.50field"] = largeR;

      await db.close();
    });
  });

  // =========================================================================
  // 7. mergePersistedSchemas and mergeSchemas — pure function throughput
  // =========================================================================
  describe("7. merge functions", () => {
    it("mergePersistedSchemas: 10 vs 200 fields", () => {
      const small10 = makeSchemaWith(10);
      const overlay10 = makeSchemaWith(10);
      const large200 = makeSchemaWith(200);
      const overlay200 = makeSchemaWith(200);

      const r10 = benchSync(
        "mergePersistedSchemas 10 fields",
        () => mergePersistedSchemas(small10, overlay10),
        5_000,
      );
      log(r10);
      results["merge.persisted.10fields"] = r10;

      const r200 = benchSync(
        "mergePersistedSchemas 200 fields",
        () => mergePersistedSchemas(large200, overlay200),
        1_000,
      );
      log(r200);
      results["merge.persisted.200fields"] = r200;
    });

    it("mergeSchemas (code+persisted): 10 vs 200 fields", () => {
      const codeSchema10 = defineSchema({
        name: "bench",
        fields: Object.fromEntries(
          Array.from({ length: 10 }, (_, i) => [
            `field${i}`,
            { type: "string" as const, description: `Field ${i}` },
          ]),
        ),
      });
      const persisted10 = extractPersistedSchema(codeSchema10.definition);

      const codeSchema200 = defineSchema({
        name: "bench",
        fields: Object.fromEntries(
          Array.from({ length: 200 }, (_, i) => [
            `field${i}`,
            { type: "string" as const, description: `Field ${i}` },
          ]),
        ),
      });
      const persisted200 = extractPersistedSchema(codeSchema200.definition);

      const r10 = benchSync(
        "mergeSchemas 10 fields",
        () => mergeSchemas(codeSchema10.definition, persisted10),
        5_000,
      );
      log(r10);
      results["merge.schemas.10fields"] = r10;

      const r200 = benchSync(
        "mergeSchemas 200 fields",
        () => mergeSchemas(codeSchema200.definition, persisted200),
        1_000,
      );
      log(r200);
      results["merge.schemas.200fields"] = r200;
    });
  });
});
