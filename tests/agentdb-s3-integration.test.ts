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
import { AgentDB } from "../src/agentdb.js";
import { defineSchema } from "../src/schema.js";

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
