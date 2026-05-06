#!/usr/bin/env node
/**
 * Targeted memory-leak bench for v2.1.0 → v2.1.1 fixes.
 *
 * Run with:  node --expose-gc scripts/bench-leak.mjs
 *
 * Scenarios:
 *   A. HNSW orphans            (fix 302)
 *   B. MemoryMonitor on LRU    (fix 303)
 *   C. close() listener leak   (fix 304)
 *   D. Subscription pin map    (fix 305)
 *   E. Filter compile cache bounded at filterCacheSize
 *   F. Record cache bounded at cacheSize (disk mode)
 *   G. Audit ring buffer bounded at auditBufferSize
 *   H. MCP session cleanup evicts idle sessions
 *   I. HNSW dedup on update with same id
 *   J. opslog WAL drains in async mode
 *   K. termlog segment count drops after compaction
 *   L. RateLimiter per-IP map behaviour
 *
 * Each scenario records:
 *   - a deterministic counter (hnswNodeCount, monitor map size, listenerCount,
 *     subscriptionPins.size, etc.)
 *   - heapUsed / RSS deltas across the leaky pattern
 *
 * The script is version-agnostic where possible: it works against v2.1.0
 * (pre-fix) by reading whatever counters are present and treating missing
 * fields as N/A.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDB } from "../dist/index.js";
import { SubscriptionManager } from "../dist/mcp/subscriptions.js";
import { AuditLogger, RateLimiter } from "../dist/mcp/auth.js";
import { startHttp } from "../dist/mcp/index.js";

// ---------- helpers -------------------------------------------------------

const MB = 1024 * 1024;
function mem() {
  const m = process.memoryUsage();
  return { heapUsed: m.heapUsed, rss: m.rss };
}
function fmtMB(bytes) { return (bytes / MB).toFixed(1) + "MB"; }
function diff(after, before) {
  return { heapUsedDeltaMB: (after.heapUsed - before.heapUsed) / MB,
           rssDeltaMB: (after.rss - before.rss) / MB };
}
async function gc(rounds = 3) {
  if (typeof global.gc !== "function") return;
  for (let i = 0; i < rounds; i++) {
    global.gc();
    await new Promise((r) => setImmediate(r));
  }
}
async function tmp(label) {
  return mkdtemp(join(tmpdir(), `agentdb-leakbench-${label}-`));
}
async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

class MockEmbeddingProvider {
  constructor(dims = 64) { this.dimensions = dims; }
  async embed(texts) {
    return texts.map((t) => {
      const v = new Array(this.dimensions);
      // deterministic + non-zero so HNSW links them
      for (let i = 0; i < this.dimensions; i++) {
        v[i] = ((t.charCodeAt(i % t.length) || 1) * (i + 1)) / 1000;
      }
      return v;
    });
  }
}

const results = []; // { scenario, v210Metric, v211Metric }

// ---------- A. HNSW orphans ----------------------------------------------

async function benchHnswOrphans() {
  const N = 2000; // 2k × 2 cycles = 4k inserts; orphans would push to 4k
  const dir = await tmp("hnsw");
  const provider = new MockEmbeddingProvider(64);
  const db = new AgentDB(dir, { embeddings: { provider } });
  await db.init();
  const col = await db.collection("docs");

  const before = mem();

  // cycle 1: insert N, embed, delete N
  const ids1 = [];
  for (let i = 0; i < N; i++) {
    ids1.push(await col.insert({ text: `record-number-${i}-with-some-words` }));
  }
  await col.embedUnembedded();
  const afterEmbed1 = col.metrics().hnswNodeCount;
  for (const id of ids1) await col.deleteById(id);
  const afterDelete1 = col.metrics().hnswNodeCount;

  // cycle 2: insert N fresh, embed
  for (let i = 0; i < N; i++) {
    await col.insert({ text: `fresh-record-${i}-different-words` });
  }
  await col.embedUnembedded();
  const finalCount = col.metrics().hnswNodeCount;

  await gc();
  const after = mem();
  const d = diff(after, before);

  await db.close();
  await rm(dir, { recursive: true, force: true });

  console.log(`[A HNSW] afterEmbed1=${afterEmbed1} afterDelete1=${afterDelete1} final=${finalCount} heapDelta=${fmtMB(d.heapUsedDeltaMB * MB)} rssDelta=${fmtMB(d.rssDeltaMB * MB)}`);
  return { afterEmbed1, afterDelete1, final: finalCount, heapDeltaMB: d.heapUsedDeltaMB, rssDeltaMB: d.rssDeltaMB };
}

// ---------- B. MemoryMonitor on eviction ----------------------------------

async function benchMonitorEviction() {
  const N = 200; // open 200 collections, cache=5
  const dir = await tmp("monitor");
  const db = new AgentDB(dir, { maxOpenCollections: 5 });
  await db.init();

  for (let i = 0; i < N; i++) {
    const col = await db.collection(`coll${i}`);
    await col.insert({ k: i });
  }

  // Reflect into private MemoryMonitor's collectionStats Map
  const mm = db.memoryMonitor;
  const monitorSize = mm?.collectionStats?.size ?? null;
  const openSize = db.open?.size ?? null;

  await db.close();
  await rm(dir, { recursive: true, force: true });

  console.log(`[B Monitor] open=${openSize} monitorSize=${monitorSize}`);
  return { openSize, monitorSize };
}

// ---------- C. close() listener leak --------------------------------------

async function benchListenerLeak() {
  const CYCLES = 1000;
  const dir = await tmp("listeners");
  // cacheSize=1 so each db.collection() call evicts the previous one,
  // exercising the close() path under LRU eviction (the same path that v2.1.0
  // failed to clean listeners on).
  const db = new AgentDB(dir, { maxOpenCollections: 1 });
  await db.init();

  await gc();
  const before = mem();

  // To isolate the listener-leak effect we open + register listeners + force
  // eviction (which closes the previous collection). After v2.1.1 close() does
  // removeAllListeners + unwatch, so closures should be eligible for GC.
  let observedListenersAfterClose = -1;
  let lastEvictedRef = null;
  for (let i = 0; i < CYCLES; i++) {
    const col = await db.collection(`coll-${i}`);
    for (let k = 0; k < 5; k++) {
      const big = new Array(2048).fill(`closure-payload-${i}-${k}`);
      const h = (_e) => { void big.length; };
      col.on("change", h);
    }
    const big2 = new Array(2048).fill(`watch-${i}`);
    col.watch((_ops) => { void big2.length; }, 60_000);
    // do a tiny mutation so the emitter has had work
    await col.insert({ k: i });
    // capture listener count just before this collection is evicted on next
    // iteration's open
    if (i === CYCLES - 1) {
      // close the last one explicitly so we can read post-close listener count
      await col.close();
      observedListenersAfterClose = col.emitter?.listenerCount?.("change") ?? -1;
      lastEvictedRef = col;
    }
  }
  await gc();
  const after = mem();
  const d = diff(after, before);

  await db.close();
  await rm(dir, { recursive: true, force: true });

  console.log(`[C Listeners] cycles=${CYCLES} listenersAfterClose=${observedListenersAfterClose} heapDelta=${fmtMB(d.heapUsedDeltaMB * MB)} rssDelta=${fmtMB(d.rssDeltaMB * MB)}`);
  void lastEvictedRef;
  return { cycles: CYCLES, listenersAfterClose: observedListenersAfterClose, heapDeltaMB: d.heapUsedDeltaMB, rssDeltaMB: d.rssDeltaMB };
}

// ---------- D. Subscription pin map ---------------------------------------

async function benchSubscriptionPins() {
  const CYCLES = 1000;
  const dir = await tmp("subs");
  const db = new AgentDB(dir);
  await db.init();
  const sm = new SubscriptionManager(db);
  const fakeServer = { server: { sendLoggingMessage: async () => {} } };

  for (let i = 0; i < CYCLES; i++) {
    await sm.subscribe(`sess-${i}`, "items", fakeServer);
    sm.unsubscribe(`sess-${i}`, "items");
  }

  const pinsMap = db._subscriptionPins;
  const pinsSize = pinsMap?.size ?? null;        // null on v2.1.0 (no map)
  const subsSize = sm.subs?.size ?? null;        // both versions: should be 0
  const listenersSize = sm.listeners?.size ?? null;

  await db.close();
  await rm(dir, { recursive: true, force: true });

  console.log(`[D Pins] pinsMapSize=${pinsSize} smSubs=${subsSize} smListeners=${listenersSize}`);
  return { pinsSize, subsSize, listenersSize };
}

// ---------- E. Filter compile cache bounded -------------------------------

async function benchFilterCacheBounded() {
  const CAP = 32;
  const N_RECORDS = 100;
  const N_SHAPES = 500;
  const dir = await tmp("filter-cache");
  const db = new AgentDB(dir);
  await db.init();
  const col = await db.collection("docs", { filterCacheSize: CAP });

  for (let i = 0; i < N_RECORDS; i++) {
    await col.insert({ k: i, name: `r${i}` });
  }

  // Run N_SHAPES distinct filter shapes — every shape unique by both field
  // name and value so the JSON.stringify cache key never collides.
  for (let i = 0; i < N_SHAPES; i++) {
    await col.find({ filter: { [`field${i % 200}`]: i } });
  }

  const m = col.metrics();
  // The compiled-filter Map lives in a closure inside makeFilterCache(); it is
  // not directly reachable. We probe its post-N state by replaying the most-
  // recent CAP shapes — if cache size == CAP, all CAP probes hit. If the cache
  // grew unbounded, all CAP probes would also hit — so we additionally replay
  // a shape that should have been evicted and assert it's a miss.
  const hitsBefore = m.filterCacheHits;
  const compsBefore = m.filterCompilations;
  // Replay the most recent CAP shapes (i in [N_SHAPES - CAP, N_SHAPES))
  for (let i = N_SHAPES - CAP; i < N_SHAPES; i++) {
    await col.find({ filter: { [`field${i % 200}`]: i } });
  }
  const m2 = col.metrics();
  const hitsRecent = m2.filterCacheHits - hitsBefore;
  const compsRecent = m2.filterCompilations - compsBefore;

  // Replay an old shape that should have been evicted (cache size CAP, so the
  // shape from index 0 is long gone after 500 distinct insertions).
  await col.find({ filter: { field0: 0 } });
  const m3 = col.metrics();
  const oldShapeWasMiss = m3.filterCompilations === m2.filterCompilations + 1;

  await gc();
  await db.close();
  await rm(dir, { recursive: true, force: true });

  // Pass: all CAP recent shapes are still cached AND the old shape was evicted.
  const recentAllHit = hitsRecent === CAP && compsRecent === 0;
  const pass = recentAllHit && oldShapeWasMiss;
  console.log(`[E FilterCache] compilations=${m.filterCompilations} hits=${m.filterCacheHits} recentReplay=${hitsRecent}/${CAP} hits, ${compsRecent} comps; oldShapeMiss=${oldShapeWasMiss} pass=${pass}`);
  return { compilations: m.filterCompilations, hits: m.filterCacheHits, cap: CAP, recentReplayHits: hitsRecent, oldShapeWasMiss, pass };
}

// ---------- F. Record cache bounded (disk mode) ---------------------------

async function benchRecordCacheBounded() {
  const CAP = 50;
  const N_RECORDS = 500;
  const dir = await tmp("record-cache");

  // Phase 1: write + close to trigger Parquet compaction (records go to disk).
  {
    const dbW = new AgentDB(dir, { storageMode: "disk" });
    await dbW.init();
    const col = await dbW.collection("docs", { cacheSize: CAP });
    for (let i = 0; i < N_RECORDS; i++) {
      await col.insert({ _id: `id-${i}`, k: i });
    }
    await dbW.close(); // triggers compaction → records flushed to JSONL/Parquet
  }

  // Phase 2: reopen disk-backed, read each id; LRU should bound at CAP.
  const db = new AgentDB(dir, { storageMode: "disk" });
  await db.init();
  const col = await db.collection("docs", { cacheSize: CAP });

  for (let i = 0; i < N_RECORDS; i++) {
    await col.findOne(`id-${i}`);
  }

  const m = col.metrics();
  const ds = col._diskStore;
  const cacheSize = ds?.cache?.size ?? null;
  const cacheStats = ds?.getCacheStats?.() ?? null;

  await gc();
  await db.close();
  await rm(dir, { recursive: true, force: true });

  const pass = cacheSize !== null && cacheSize <= CAP;
  console.log(`[F RecordCache] fetches=${m.recordCacheFetches} hits=${m.recordCacheHits} cacheSize=${cacheSize} evictions=${cacheStats?.evictions ?? "?"} cap=${CAP} pass=${pass}`);
  return { fetches: m.recordCacheFetches, hits: m.recordCacheHits, cacheSize, cap: CAP, evictions: cacheStats?.evictions, pass };
}

// ---------- G. Audit ring buffer bounded ----------------------------------

async function benchAuditRingBuffer() {
  const CAP = 50;
  const PUSHED = 5000;
  const logger = new AuditLogger(CAP);

  for (let i = 0; i < PUSHED; i++) {
    logger.log({ timestamp: new Date().toISOString(), method: "tools/call", tool: `t${i}`, agentId: `a${i}` });
  }

  const internalCount = logger.count;        // private field
  const internalLen = logger.entries?.length; // pre-allocated array — equals maxEntries
  const recent = logger.recent(10000);

  const pass = internalCount === CAP && recent.length === CAP;
  console.log(`[G Audit] pushed=${PUSHED} retained(count)=${internalCount} entriesArrLen=${internalLen} recent.length=${recent.length} cap=${CAP} pass=${pass}`);
  return { pushed: PUSHED, retained: internalCount, recentLength: recent.length, entriesArrLen: internalLen, cap: CAP, pass };
}

// ---------- H. MCP session cleanup ----------------------------------------

async function benchMcpSessionCleanup() {
  const dir = await tmp("mcp");
  // pick a free port (0)
  const handle = await startHttp(dir, { port: 0, host: "127.0.0.1", maxSessions: 10, sessionIdleMs: 200 });
  const base = `http://127.0.0.1:${handle.port}`;

  const initBody = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "leakbench", version: "0" } },
  };

  // Initialize 5 sessions and remember their IDs.
  const sessionIds = [];
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ ...initBody, id: i + 1 }),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) sessionIds.push(sid);
    // drain body so socket can return to keep-alive pool
    await res.text().catch(() => "");
  }
  const sessionsAfterInit = sessionIds.length;

  // Wait > 2× idle so cleanup interval has fired (CLEANUP_INTERVAL_MS = min(60000, sessionIdleMs)).
  await sleep(450);

  // Probe each session — they should now be invalid (cleanup ran, transport gone).
  // The /mcp POST handler returns 400 when session-id is set but missing from `transports`.
  let invalid = 0;
  for (const sid of sessionIds) {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": sid },
      body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} }),
    });
    if (res.status === 400) invalid++;
    await res.text().catch(() => "");
  }

  // close() must clearInterval; if it doesn't, the process would hang on a
  // ref'd interval. We rely on Node exiting the script's main() to confirm
  // (any leaked interval would prevent process exit).
  await handle.close();
  await rm(dir, { recursive: true, force: true });

  const pass = sessionsAfterInit === 5 && invalid === 5;
  console.log(`[H MCP Sessions] sessionsAfterInit=${sessionsAfterInit} invalidatedAfter400ms=${invalid}/${sessionsAfterInit} pass=${pass}`);
  return { sessionsAfterInit, invalidatedAfterIdle: invalid, pass };
}

// ---------- I. HNSW dedup on update --------------------------------------

async function benchHnswUpdateDedup() {
  const N = 500;
  const dir = await tmp("hnsw-update");
  const provider = new MockEmbeddingProvider(64);
  const db = new AgentDB(dir, { embeddings: { provider } });
  await db.init();
  const col = await db.collection("docs");

  // Insert + embed
  const ids = [];
  for (let i = 0; i < N; i++) {
    ids.push(await col.insert({ text: `original-text-${i}-words` }));
  }
  await col.embedUnembedded();
  const afterFirstEmbed = col.metrics().hnswNodeCount;

  // Update all with new text — invalidates _embedding and removes HNSW node.
  for (const id of ids) {
    await col.update({ _id: id }, { $set: { text: `updated-text-${id}-different-words` } });
  }
  const afterUpdate = col.metrics().hnswNodeCount; // expected: 0 (all removed)

  // Re-embed
  await col.embedUnembedded();
  const afterReEmbed = col.metrics().hnswNodeCount; // expected: N (not 2N)

  await gc();
  await db.close();
  await rm(dir, { recursive: true, force: true });

  const pass = afterFirstEmbed === N && afterReEmbed === N;
  console.log(`[I HNSW update dedup] afterFirstEmbed=${afterFirstEmbed} afterUpdate=${afterUpdate} afterReEmbed=${afterReEmbed} N=${N} pass=${pass}`);
  return { N, afterFirstEmbed, afterUpdate, afterReEmbed, pass };
}

// ---------- J. opslog WAL drains in async mode ----------------------------

async function benchAsyncWalDrain() {
  const N = 5000;
  const dir = await tmp("async-wal");
  const db = new AgentDB(dir, { writeMode: "async", groupCommitMs: 50 });
  await db.init();
  const col = await db.collection("docs");

  for (let i = 0; i < N; i++) {
    await col.insert({ k: i });
  }

  // Wait > groupCommitMs * 3 for the timer-driven drain to complete.
  await sleep(150);

  // Force a flush to be deterministic (the timer might race with our read).
  const store = col.store;
  await store?.flush?.();

  const m = col.metrics();
  // Reflect on internal groupBuffer if reachable.
  const groupBuf = store?.groupBuffer;
  const groupBufSize = Array.isArray(groupBuf) ? groupBuf.length : (groupBuf?.size ?? "n/a");

  await gc();
  await db.close();
  await rm(dir, { recursive: true, force: true });

  // walRecordCount == active record count in the in-memory map. With N
  // inserts and no deletions/duplicates, it must equal N exactly. A mode bug
  // (op duplication, leaked partial state) would surface as != N.
  const pass = m.walRecordCount === N && (groupBufSize === 0 || groupBufSize === "n/a");
  console.log(`[J WAL drain] inserted=${N} walRecordCount=${m.walRecordCount} groupBuffer.length=${groupBufSize} writeMode=${m.writeMode} pass=${pass}`);
  return { inserted: N, walRecordCount: m.walRecordCount, groupBufferSize: groupBufSize, writeMode: m.writeMode, pass };
}

// ---------- K. termlog segment count drops after compaction --------------

async function benchTermlogCompaction() {
  const N = 5000;
  const dir = await tmp("termlog");
  const db = new AgentDB(dir);
  await db.init();
  const col = await db.collection("docs", { textSearch: true });

  // Force enough segments to merge: termlog's default flushThreshold = 1000.
  // 5000 inserts with explicit flushTextIndex() between batches → ≥5 segments.
  const BATCH = 500;
  for (let i = 0; i < N; i += BATCH) {
    for (let j = 0; j < BATCH; j++) {
      await col.insert({ text: `segment-doc-${i + j}-${i + j}` });
    }
    await col.flushTextIndex();
  }
  // One final flush to seal the last partial segment.
  await col.flushTextIndex();

  const before = col.metrics().bm25SegmentCount;
  const needsMergeBefore = col.metrics().bm25NeedsMerge;

  // Manual compact via internal handle.
  const tlog = col.textIdx;
  await tlog?.compact?.();

  const after = col.metrics().bm25SegmentCount;
  const needsMergeAfter = col.metrics().bm25NeedsMerge;

  await gc();
  await db.close();
  await rm(dir, { recursive: true, force: true });

  // Pass: compaction reduced segments AND ended with needsMerge=false
  const pass = before !== null && after !== null && after < before && needsMergeAfter === false;
  console.log(`[K Termlog compact] segmentsBefore=${before} (needsMerge=${needsMergeBefore}) segmentsAfter=${after} (needsMerge=${needsMergeAfter}) pass=${pass}`);
  return { segmentsBefore: before, segmentsAfter: after, needsMergeBefore, needsMergeAfter, pass };
}

// ---------- L. RateLimiter map behaviour ---------------------------------

async function benchRateLimiterMap() {
  const WIN = 100; // ms — short so we can wait for cleanup
  const rl = new RateLimiter(1000, WIN);

  // 1000 distinct IPs.
  for (let i = 0; i < 1000; i++) {
    rl.check(`ip-${i}`);
  }
  const sizeAfterFill = rl.counts?.size ?? null;

  // Wait > WIN: entries are now expired but not yet cleaned (lazy cleanup).
  await sleep(WIN + 20);
  const sizeAfterWindow = rl.counts?.size ?? null;

  // Cleanup runs only when (now - lastCleanup) > windowMs * 5. Force it.
  // Mutate lastCleanup so the next check() triggers the sweep.
  if (rl.lastCleanup !== undefined) rl.lastCleanup = 0;

  rl.check("trigger-ip");
  const sizeAfterTrigger = rl.counts?.size ?? null;

  // Pass criteria: lazy cleanup eventually runs and reaps stale entries.
  const lazyReaps = sizeAfterFill === 1000 && sizeAfterTrigger !== null && sizeAfterTrigger < 1000;
  console.log(`[L RateLimiter] sizeAfterFill=${sizeAfterFill} sizeAfterWindow(no sweep)=${sizeAfterWindow} sizeAfterTriggerSweep=${sizeAfterTrigger} lazyReaps=${lazyReaps}`);
  return { sizeAfterFill, sizeAfterWindow, sizeAfterTriggerSweep: sizeAfterTrigger, lazyReaps };
}

// ---------- main ----------------------------------------------------------

async function main() {
  if (typeof global.gc !== "function") {
    console.error("FATAL: run with --expose-gc");
    process.exit(2);
  }
  console.log("# AgentDB targeted leak bench — node " + process.version);
  console.log("# package version: ", (await import("../package.json", { with: { type: "json" } })).default.version);
  const a = await benchHnswOrphans();
  const b = await benchMonitorEviction();
  const c = await benchListenerLeak();
  const d = await benchSubscriptionPins();
  const e = await benchFilterCacheBounded();
  const f = await benchRecordCacheBounded();
  const g = await benchAuditRingBuffer();
  const h = await benchMcpSessionCleanup();
  const i = await benchHnswUpdateDedup();
  const j = await benchAsyncWalDrain();
  const k = await benchTermlogCompaction();
  const l = await benchRateLimiterMap();

  const out = { a, b, c, d, e, f, g, h, i, j, k, l };
  console.log("\n# JSON RESULT:\n" + JSON.stringify(out));
}

main().catch((e) => { console.error(e); process.exit(1); });
