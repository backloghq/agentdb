/**
 * AgentDB S3 integration test — termlog-s3 text index wiring.
 * Skipped unless S3_INTEGRATION=1 is set.
 *
 * Usage (MinIO):
 *   S3_INTEGRATION=1 \
 *   S3_TEST_BUCKET=agentdb-test \
 *   S3_TEST_ENDPOINT=http://localhost:9000 \
 *   S3_TEST_REGION=us-east-1 \
 *   AWS_ACCESS_KEY_ID=minioadmin \
 *   AWS_SECRET_ACCESS_KEY=minioadmin \
 *   npx vitest run tests/agentdb-s3-integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { AgentDB, type AgentDBOptions } from "../src/agentdb.js";
import { defineSchema } from "../src/schema.js";
import type { EmbeddingProvider } from "../src/embeddings/types.js";

const integration = process.env.S3_INTEGRATION === "1";
const bucket = process.env.S3_TEST_BUCKET ?? "agentdb-test";
const region = process.env.S3_TEST_REGION ?? "us-east-1";
const endpoint = process.env.S3_TEST_ENDPOINT;

function makeS3Client(): S3Client {
  return new S3Client({
    region,
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
  });
}

async function cleanupPrefix(client: S3Client, prefix: string): Promise<void> {
  let token: string | undefined;
  do {
    const list = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    ) as { Contents?: Array<{ Key?: string }>; IsTruncated?: boolean; NextContinuationToken?: string };
    const keys = (list.Contents ?? []).map((o) => o.Key).filter(Boolean) as string[];
    if (keys.length > 0) {
      await client.send(
        new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.map((k) => ({ Key: k })) } }),
      );
    }
    token = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (token);
}

describe.skipIf(!integration)("AgentDB S3 + termlog-s3 integration", () => {
  let client: S3Client;
  let basePrefix: string;

  const textSchema = defineSchema({
    name: "docs",
    textSearch: true,
    fields: { title: { type: "string", searchable: true } },
  });

  async function makeDb(): Promise<AgentDB> {
    const { S3Backend } = await import("@backloghq/opslog-s3");
    const backend = new S3Backend({ bucket, prefix: basePrefix, client });
    const db = new AgentDB(basePrefix, { backend });
    await db.init();
    return db;
  }

  beforeAll(() => {
    client = makeS3Client();
    basePrefix = `agentdb-s3-integration-${Date.now()}/`;
  });

  afterAll(async () => {
    if (!client) return;
    await cleanupPrefix(client, basePrefix);
    client.destroy();
  });

  it("inserts with text search → bm25Search → close → reopen → search persists", async () => {
    // Session 1: insert and search
    const db1 = await makeDb();
    const col1 = await db1.collection(textSchema);
    await col1.insert({ _id: "r1", title: "golang goroutines concurrency" });
    await col1.insert({ _id: "r2", title: "golang channels select" });
    await col1.insert({ _id: "r3", title: "python asyncio coroutines" });

    const result1 = await col1.search("golang");
    expect(result1.total).toBeGreaterThanOrEqual(2);
    expect(result1.records.some((r) => r._id === "r1")).toBe(true);
    expect(result1.records.some((r) => r._id === "r2")).toBe(true);
    expect(result1.records.some((r) => r._id === "r3")).toBe(false);

    await db1.close();

    // Session 2: reopen — verify text index was persisted in S3 and search works
    const db2 = await makeDb();
    const col2 = await db2.collection(textSchema);
    const result2 = await col2.search("golang");
    expect(result2.total).toBeGreaterThanOrEqual(2);
    expect(result2.records.some((r) => r._id === "r1")).toBe(true);
    expect(result2.records.some((r) => r._id === "r2")).toBe(true);
    expect(result2.records.some((r) => r._id === "r3")).toBe(false);

    await db2.close();
  }, 60000);

  it("opslog and termlog data live under expected S3 prefixes", async () => {
    // AgentDB passes a single S3Backend (prefix=basePrefix) to all collections.
    // Opslog stores its manifest/WAL/snapshot flat under that prefix.
    // Termlog stores its data under docs/text/ relative to that prefix
    // (built as <opslogPrefix>/<collectionName>/text/ in _openCollection).
    const allKeys: string[] = [];
    let token: string | undefined;
    do {
      const list = await client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: basePrefix, ContinuationToken: token }),
      ) as { Contents?: Array<{ Key?: string }>; IsTruncated?: boolean; NextContinuationToken?: string };
      for (const obj of list.Contents ?? []) {
        if (obj.Key) allKeys.push(obj.Key);
      }
      token = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (token);

    // Opslog data: manifest.json lives directly under the basePrefix
    const opslogKeys = allKeys.filter((k) => !k.includes("/text/"));
    expect(opslogKeys.length).toBeGreaterThan(0);

    // Termlog data: manifest or segment files under docs/text/ (relative to basePrefix)
    const termlogKeys = allKeys.filter((k) => k.includes("/docs/text/"));
    expect(termlogKeys.length).toBeGreaterThan(0);
  }, 30000);

  it("remove + reopen: removed doc absent from search results", async () => {
    const db = await makeDb();
    const col = await db.collection(textSchema);

    // r1-r3 from previous test exist; insert a new one and immediately remove it
    await col.insert({ _id: "r4", title: "rust ownership borrowing" });
    const before = await col.search("rust");
    expect(before.records.some((r) => r._id === "r4")).toBe(true);

    await col.deleteById("r4");
    await db.close();

    // Reopen — r4 must not appear
    const db2 = await makeDb();
    const col2 = await db2.collection(textSchema);
    const after = await col2.search("rust");
    expect(after.records.some((r) => r._id === "r4")).toBe(false);
    await db2.close();
  }, 60000);

  it("rebuildTextIndex in S3 mode: docCount stays at 100 (no double-count)", async () => {
    const { S3Backend: OpsS3 } = await import("@backloghq/opslog-s3");
    const rebuildPrefix = `${basePrefix}rebuild-test/`;
    const rebuildBackend = new OpsS3({ bucket, prefix: rebuildPrefix, client });
    const db = new AgentDB(rebuildPrefix, { backend: rebuildBackend });
    await db.init();

    const col = await db.collection(textSchema);
    for (let i = 0; i < 100; i++) {
      await col.insert({ _id: `rb${i}`, title: `word${i} common` });
    }
    await db.close();

    // Reopen and rebuild — must NOT double-count
    const db2 = new AgentDB(rebuildPrefix, { backend: new OpsS3({ bucket, prefix: rebuildPrefix, client }) });
    await db2.init();
    const col2 = await db2.collection(textSchema);
    const countBefore = col2.getTextIndex()?.docCount() ?? 0;
    await col2.rebuildTextIndex();
    const countAfter = col2.getTextIndex()?.docCount() ?? 0;
    expect(countBefore).toBeGreaterThan(0);
    expect(countAfter).toBe(100);
    await db2.close();

    await cleanupPrefix(client, rebuildPrefix);
  }, 90000);

  it("rebuildTextIndex bounded-concurrency wipe completes without error at 200+ blobs", async () => {
    // Insert enough docs to produce many termlog segment blobs, then rebuild.
    // Asserts no SDK timeout/error from unbounded Promise.all fan-out.
    const { S3Backend: OpsS3 } = await import("@backloghq/opslog-s3");
    const wipePrefix = `${basePrefix}wipe-concurrency/`;
    const db = new AgentDB(wipePrefix, { backend: new OpsS3({ bucket, prefix: wipePrefix, client }) });
    await db.init();

    const col = await db.collection(textSchema);
    for (let i = 0; i < 200; i++) {
      await col.insert({ _id: `w${i}`, title: `unique${i} term` });
    }
    await db.close();

    const db2 = new AgentDB(wipePrefix, { backend: new OpsS3({ bucket, prefix: wipePrefix, client }) });
    await db2.init();
    const col2 = await db2.collection(textSchema);
    // Must complete without throwing; docCount must equal N
    await expect(col2.rebuildTextIndex()).resolves.toBe(200);
    await db2.close();

    await cleanupPrefix(client, wipePrefix);
  }, 120000);

  it("S3 mode open with textSearch does not throw LegacyTextIndexError", async () => {
    // v1.4 never wrote indexes/text-index.json to S3, so the legacy check must be skipped.
    // This verifies that a fresh S3 collection opens without false-throwing.
    const { S3Backend: OpsS3 } = await import("@backloghq/opslog-s3");
    const legacyPrefix = `${basePrefix}legacy-check/`;
    const db = new AgentDB(legacyPrefix, { backend: new OpsS3({ bucket, prefix: legacyPrefix, client }) });
    await db.init();
    // Should not throw — no legacy blob exists, and S3 mode skips the check anyway.
    const col = await db.collection(textSchema);
    await col.insert({ _id: "x1", title: "test legacy check" });
    const result = await col.search("legacy");
    expect(result.records.some((r) => r._id === "x1")).toBe(true);
    await db.close();
    await cleanupPrefix(client, legacyPrefix);
  }, 60000);
});

// ---------------------------------------------------------------------------
// Task 320 — S3 + v2.1 options matrix
// Covers: mergeParquetThreshold, hnsw.maxLevel, filterCacheSize, composite
// index round-trip, and HNSW sidecar locality investigation.
// ---------------------------------------------------------------------------

describe.skipIf(!integration)("AgentDB S3 — v2.1 options matrix (task 320)", () => {
  let client: S3Client;
  let s3Prefix: string;

  /** Minimal 3-D mock provider: all texts → [0.1, 0.2, 0.3]. */
  const mockProvider: EmbeddingProvider = {
    dimensions: 3,
    embed: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
  };

  /** Open a fresh AgentDB with an S3 backend scoped to `subprefix` within `s3Prefix`. */
  async function makeS3Db(subprefix: string, extraOpts: Partial<AgentDBOptions> = {}): Promise<AgentDB> {
    const { S3Backend } = await import("@backloghq/opslog-s3");
    const prefix = `${s3Prefix}${subprefix}`;
    const backend = new S3Backend({ bucket, prefix, client });
    const db = new AgentDB(prefix, { backend, ...extraOpts });
    await db.init();
    return db;
  }

  /** List all S3 keys under a given prefix. */
  async function listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const list = await client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
      ) as { Contents?: Array<{ Key?: string }>; IsTruncated?: boolean; NextContinuationToken?: string };
      for (const obj of list.Contents ?? []) {
        if (obj.Key) keys.push(obj.Key);
      }
      token = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }

  beforeAll(() => {
    client = makeS3Client();
    s3Prefix = `agentdb-s3-opts-${Date.now()}/`;
  });

  afterAll(async () => {
    if (!client) return;
    await cleanupPrefix(client, s3Prefix);
    // AgentDB(prefix, …) creates a local directory mirroring the S3 prefix string.
    // Clean up those accidental local FS artifacts (they are empty for non-disk tests;
    // test 5 may leave hnsw/graph.bin there).
    try {
      const { rm } = await import("node:fs/promises");
      // prefix looks like "agentdb-s3-opts-1234567890/" — strip trailing slash
      const localTopDir = s3Prefix.replace(/\/$/, "").split("/")[0];
      await rm(localTopDir, { recursive: true, force: true });
    } catch { /* best-effort */ }
    client.destroy();
  });

  it("mergeParquetThreshold=2 triggers full merge on 3rd close in S3 disk mode", async () => {
    // Three close cycles:
    //   Session 1 → no compactionMeta → full compact (parquetFiles=[])
    //   Session 2 → parquetFileCount=0+1=1 < 2 → incremental (parquetFiles=[f2])
    //   Session 3 → parquetFileCount=1+1=2 >= 2 → full merge  (parquetFiles=[])
    // After session 3 all 20 records must survive the merge and the knob must be wired.
    const subprefix = "t1-merge/";
    const schema = defineSchema({ name: "items", storageMode: "disk" });

    const db1 = await makeS3Db(subprefix, { mergeParquetThreshold: 2 });
    const col1 = await db1.collection(schema);
    for (let i = 0; i < 10; i++) await col1.insert({ _id: `r${i}`, n: i });
    await db1.close();

    const db2 = await makeS3Db(subprefix, { mergeParquetThreshold: 2 });
    const col2 = await db2.collection(schema);
    for (let i = 10; i < 15; i++) await col2.insert({ _id: `r${i}`, n: i });
    await db2.close();

    const db3 = await makeS3Db(subprefix, { mergeParquetThreshold: 2 });
    const col3 = await db3.collection(schema);
    for (let i = 15; i < 20; i++) await col3.insert({ _id: `r${i}`, n: i });
    await db3.close();

    // Verify
    const db4 = await makeS3Db(subprefix, { mergeParquetThreshold: 2 });
    const col4 = await db4.collection(schema);
    expect(col4.getDiskStore()?.mergeParquetThreshold).toBe(2);
    const all = await col4.find({});
    expect(all.total).toBe(20);
    await db4.close();

    await cleanupPrefix(client, `${s3Prefix}${subprefix}`);
  }, 120000);

  it("hnsw.maxLevel honored in S3-backed collection", async () => {
    // setEmbeddingProvider is called during _openCollection when an embedding provider
    // is configured; it creates HnswIndex with opts.hnsw, so maxLevel flows through.
    const db = await makeS3Db("t2-hnsw/", {
      hnsw: { maxLevel: 4 },
      embeddings: { provider: mockProvider },
    });
    const col = await db.collection(defineSchema({ name: "items" }));

    const hnswIdx = col.getHnswIndex();
    expect(hnswIdx).not.toBeNull();
    expect(hnswIdx!.configMaxLevel).toBe(4);

    await db.close();
    await cleanupPrefix(client, `${s3Prefix}t2-hnsw/`);
  }, 30000);

  it("filterCacheSize=2 evicts at threshold in S3 collection", async () => {
    // LRU cache of size 2: after compiling 3 distinct filter shapes the first is evicted.
    // Re-querying the first shape triggers a 4th compilation (cache miss), not a hit.
    const db = await makeS3Db("t3-filter/", { filterCacheSize: 2 });
    const col = await db.collection(defineSchema({ name: "items" }));

    expect(col.filterCacheSize).toBe(2);

    // Insert two records so queries have something to scan (zero records would still
    // compile filters but let's be realistic).
    await col.insert({ _id: "a", status: "active", role: "admin", tier: "gold" });
    await col.insert({ _id: "b", status: "inactive", role: "user", tier: "silver" });

    await col.find({ filter: { status: "active" } }); // compilation 1; cache: [status]
    await col.find({ filter: { role: "admin" } });    // compilation 2; cache: [status, role] (full)
    await col.find({ filter: { tier: "gold" } });     // compilation 3; evicts status; cache: [role, tier]
    await col.find({ filter: { status: "active" } }); // compilation 4 — status was evicted, must recompile

    expect(col.metrics().filterCompilations).toBe(4);

    await db.close();
    await cleanupPrefix(client, `${s3Prefix}t3-filter/`);
  }, 30000);

  it("composite index on [category, priority] round-trips through S3 disk close/reopen", async () => {
    // Session 1: insert records + close → saveIndexes writes composite-category__priority.json to S3.
    // Session 2: reopen → tryLoadCompositeIndex reads from S3 (O(file-read) fast path).
    // Validates that task 319's tryLoadCompositeIndex works against the S3 backend.
    const subprefix = "t4-composite/";
    const schema = defineSchema({
      name: "items",
      storageMode: "disk",
      compositeIndexes: [["category", "priority"]],
    });

    const db1 = await makeS3Db(subprefix);
    const col1 = await db1.collection(schema);
    await col1.insert({ _id: "t1", category: "tech", priority: 1 });
    await col1.insert({ _id: "t2", category: "tech", priority: 2 });
    await col1.insert({ _id: "t3", category: "sci",  priority: 1 });
    await col1.insert({ _id: "t4", category: "sci",  priority: 3 });
    await db1.close();

    // Reopen: tryLoadCompositeIndex reads indexes/composite-category__priority.json from S3
    const db2 = await makeS3Db(subprefix);
    const col2 = await db2.collection(schema);

    const exact = await col2.find({ filter: { category: "tech", priority: 1 } });
    expect(exact.records.length).toBe(1);
    expect(exact.records[0]._id).toBe("t1");

    const techAll = await col2.find({ filter: { category: "tech" } });
    expect(techAll.records.length).toBe(2);

    await db2.close();
    await cleanupPrefix(client, `${s3Prefix}${subprefix}`);
  }, 90000);

  it("HNSW graph.bin sidecar is FS-only in S3 disk mode (not stored as an S3 object)", async () => {
    // Investigation result:
    //   persistHnsw() uses node:path.join(_dir, "hnsw/graph.bin") where _dir is the
    //   local-FS path passed to AgentDB (the same string used as the S3 prefix).
    //   In S3 disk mode this creates a LOCAL binary file — no S3 object is written.
    //
    // Implication: HNSW graph persistence does NOT survive container restarts in S3
    // deployments — each fresh container rebuilds the graph from the S3-stored
    // _embedding fields (rebuildHnswFromDisk). This is the intended fallback path.
    //
    // S3-native sidecar (backend.writeBlob for graph.bin) is tracked as a v2.3 task.
    const subprefix = "t5-hnsw-s3/";
    const schema = defineSchema({ name: "items", storageMode: "disk" });

    // Session 1: insert, embed, close
    const db1 = await makeS3Db(subprefix, {
      storageMode: "disk",
      embeddings: { provider: mockProvider },
    });
    const col1 = await db1.collection(schema);
    await col1.insert({ _id: "h1", title: "alpha embedding" });
    await col1.insert({ _id: "h2", title: "beta embedding" });
    await col1.insert({ _id: "h3", title: "gamma embedding" });
    await col1.embedUnembedded();
    expect(col1.getHnswIndex()?.size).toBe(3);
    await db1.close(); // triggers persistHnsw → LOCAL FS, not S3

    // Verify: S3 has no keys under any hnsw/ path for this collection
    const allKeys = await listKeys(`${s3Prefix}${subprefix}`);
    const hnswS3Keys = allKeys.filter((k) => k.includes("/hnsw/"));
    expect(hnswS3Keys).toHaveLength(0);

    // Reopen: in the same process the local sidecar IS accessible (same CWD),
    // so loadHnswFromDisk succeeds. A fresh container would fall back to
    // rebuildHnswFromDisk (reads _embedding from S3 Parquet). Either way the
    // graph is available and semantic search works.
    const db2 = await makeS3Db(subprefix, {
      storageMode: "disk",
      embeddings: { provider: mockProvider },
    });
    const col2 = await db2.collection(schema);
    expect(col2.getHnswIndex()?.size).toBe(3);

    const hits = await col2.searchByVector([0.1, 0.2, 0.3]);
    expect(hits.records.length).toBeGreaterThan(0);

    await db2.close();
    await cleanupPrefix(client, `${s3Prefix}${subprefix}`);
  }, 90000);
});
