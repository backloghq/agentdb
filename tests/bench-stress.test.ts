/**
 * Long-running agent simulation stress test.
 * Simulates realistic agent behavior: 3 collections, mixed reads/writes,
 * periodic schema ops. Tracks RSS + heap every 10s, latency p50/p99.
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
    const result = await t.execute(args);
    if (result.isError) throw new Error((result.content[0] as { text: string }).text);
    return JSON.parse((result.content[0] as { text: string }).text);
  };
}

function p50p99(latencies: number[]): { p50: number; p99: number } {
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
    p99: sorted[Math.floor(sorted.length * 0.99)] ?? 0,
  };
}

function rssMB() { return process.memoryUsage().rss / 1024 / 1024; }
function heapMB() { return process.memoryUsage().heapUsed / 1024 / 1024; }

describe("Long-running agent simulation — 3 min stress", () => {
  it("realistic agent session: inserts, queries, schema ops, migrate", { timeout: 300_000 }, async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "bench-stress-"));
    const db = new AgentDB(tmpDir, { writeMode: "async" });
    await db.init();
    const tools = getTools(db);

    const execFind   = toolExec(tools, "db_find");
    const execInsert = toolExec(tools, "db_insert");
    const execCount  = toolExec(tools, "db_count");
    const execDiff   = toolExec(tools, "db_diff_schema");
    const execGet    = toolExec(tools, "db_get_schema");
    const execMig    = toolExec(tools, "db_migrate");
    const execDistinct = toolExec(tools, "db_distinct");

    // Seed three collections
    const COLLECTIONS = ["tasks", "events", "users"] as const;
    for (const coll of COLLECTIONS) {
      const col = await db.collection(coll);
      await col.insertMany(Array.from({ length: 500 }, (_, i) => ({
        _id: `${coll}-seed-${i}`,
        title: `${coll} item ${i}`,
        status: ["open", "closed", "pending"][i % 3],
        category: ["A", "B", "C", "D"][i % 4],
        score: i % 100,
        body: "x".repeat(80),
      })));
    }

    // Set a schema on "tasks" so diff/get work meaningfully
    await toolExec(tools, "db_set_schema")({
      collection: "tasks",
      schema: {
        description: "Task tracking collection",
        fields: {
          title:    { type: "string", maxLength: 200 },
          status:   { type: "enum", values: ["open", "closed", "pending"] },
          category: { type: "string" },
          score:    { type: "number", min: 0, max: 100 },
          body:     { type: "string" },
        },
      },
    });

    // -----------------------------------------------------------------------
    // Latency trackers
    // -----------------------------------------------------------------------
    const latencies: Record<string, number[]> = {
      find: [], insert: [], count: [], diff: [], get: [], migrate: [], distinct: [],
    };

    let insertSeq = 10_000;
    const memLog: { t: number; rssMB: number; heapMB: number }[] = [];
    const DURATION_MS = 3 * 60 * 1000;  // 3 minutes
    const MEM_SAMPLE_MS = 10_000;

    const startMs = Date.now();
    memLog.push({ t: 0, rssMB: rssMB(), heapMB: heapMB() });
    let lastMemSample = startMs;
    let opCount = 0;
    let errorCount = 0;

    console.log(`  [stress] start — rss=${rssMB().toFixed(0)}MB heap=${heapMB().toFixed(0)}MB`);

    while (Date.now() - startMs < DURATION_MS) {
      const coll = COLLECTIONS[opCount % 3];
      const dice = Math.random();

      try {
        // 70% reads, 30% writes
        if (dice < 0.25) {
          // find with filter
          const t0 = performance.now();
          await execFind({ collection: coll, filter: { status: "open" }, limit: 20 });
          latencies.find.push(performance.now() - t0);
        } else if (dice < 0.45) {
          // count
          const t0 = performance.now();
          await execCount({ collection: coll, filter: { status: "closed" } });
          latencies.count.push(performance.now() - t0);
        } else if (dice < 0.55) {
          // distinct
          const t0 = performance.now();
          await execDistinct({ collection: coll, field: "category" });
          latencies.distinct.push(performance.now() - t0);
        } else if (dice < 0.65) {
          // get schema (tasks only)
          const t0 = performance.now();
          await execGet({ collection: "tasks" });
          latencies.get.push(performance.now() - t0);
        } else if (dice < 0.70) {
          // diff schema (tasks only, no impact scan)
          const t0 = performance.now();
          await execDiff({ collection: "tasks", schema: { fields: { score: { type: "number", min: 0, max: 200 } } }, includeImpact: false });
          latencies.diff.push(performance.now() - t0);
        } else if (dice < 0.85) {
          // single insert
          const t0 = performance.now();
          await execInsert({ collection: coll, record: { _id: `live-${insertSeq++}`, title: `live item`, status: "open", category: "A", score: opCount % 100, body: "x".repeat(80) } });
          latencies.insert.push(performance.now() - t0);
        } else if (dice < 0.95) {
          // bulk insert (5 records)
          const t0 = performance.now();
          for (let b = 0; b < 5; b++) {
            await execInsert({ collection: coll, record: { _id: `bulk-${insertSeq++}`, title: `bulk`, status: "pending", category: "B", score: 50, body: "y".repeat(80) } });
          }
          latencies.insert.push((performance.now() - t0) / 5);
        } else {
          // migrate small batch (tasks, filter=pending, set score=0)
          const t0 = performance.now();
          await execMig({ collection: "tasks", filter: { status: "pending" }, ops: [{ op: "set", field: "score", value: 0 }], dryRun: true });
          latencies.migrate.push(performance.now() - t0);
        }
      } catch {
        errorCount++;
      }

      opCount++;

      // Memory snapshot every 10 seconds
      const now = Date.now();
      if (now - lastMemSample >= MEM_SAMPLE_MS) {
        const t = Math.round((now - startMs) / 1000);
        const snap = { t, rssMB: rssMB(), heapMB: heapMB() };
        memLog.push(snap);
        console.log(`  [stress] t=${t}s op#${opCount} rss=${snap.rssMB.toFixed(0)}MB heap=${snap.heapMB.toFixed(0)}MB`);
        lastMemSample = now;
      }
    }

    // Final snapshot
    memLog.push({ t: Math.round((Date.now() - startMs) / 1000), rssMB: rssMB(), heapMB: heapMB() });

    // -----------------------------------------------------------------------
    // Report
    // -----------------------------------------------------------------------
    const rssStart = memLog[0].rssMB;
    const rssEnd   = memLog[memLog.length - 1].rssMB;
    const heapStart = memLog[0].heapMB;
    const heapEnd   = memLog[memLog.length - 1].heapMB;

    console.log(`\n  ── Stress test summary ──`);
    console.log(`  Duration: ${Math.round((Date.now() - startMs) / 1000)}s`);
    console.log(`  Total ops: ${opCount}, errors: ${errorCount}`);
    console.log(`  RSS: start=${rssStart.toFixed(0)}MB end=${rssEnd.toFixed(0)}MB delta=${(rssEnd - rssStart).toFixed(0)}MB`);
    console.log(`  Heap: start=${heapStart.toFixed(0)}MB end=${heapEnd.toFixed(0)}MB delta=${(heapEnd - heapStart).toFixed(0)}MB`);

    console.log(`\n  ── Latency p50/p99 per tool ──`);
    for (const [tool, lats] of Object.entries(latencies)) {
      if (lats.length === 0) continue;
      const { p50, p99 } = p50p99(lats);
      console.log(`  ${tool.padEnd(10)} n=${String(lats.length).padStart(4)}  p50=${p50.toFixed(1)}ms  p99=${p99.toFixed(1)}ms`);
    }

    // Check for latency degradation: compare first 10% vs last 10% of find latencies
    if (latencies.find.length >= 20) {
      const tenPct = Math.floor(latencies.find.length * 0.1);
      const early  = latencies.find.slice(0, tenPct);
      const late   = latencies.find.slice(-tenPct);
      const earlyP50 = p50p99(early).p50;
      const lateP50  = p50p99(late).p50;
      const drift = lateP50 / earlyP50;
      console.log(`\n  find latency drift (early vs late): ${earlyP50.toFixed(1)}ms → ${lateP50.toFixed(1)}ms (${drift.toFixed(2)}×)`);
      if (drift > 2) console.log(`  ⚠ find latency degraded >2× over session`);
      else console.log(`  ✓ find latency stable`);
    }

    const rssDelta = rssEnd - rssStart;
    if (rssDelta > 100) {
      console.log(`\n  ⚠ RSS grew ${rssDelta.toFixed(0)}MB — potential leak`);
    } else {
      console.log(`\n  ✓ RSS delta=${rssDelta.toFixed(0)}MB — stable`);
    }

    await db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });
});
