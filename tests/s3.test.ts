/**
 * S3 backend performance benchmarks.
 *
 * Requires AWS credentials and a bucket. Configure via environment variables:
 *   AGENTDB_S3_BUCKET=my-bucket AWS_REGION=us-east-1 npm test -- tests/bench-s3.test.ts
 *
 * Skipped automatically if AGENTDB_S3_BUCKET is not set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Store } from "@backloghq/opslog";
import { Collection } from "../src/collection.js";

const BUCKET = process.env.AGENTDB_S3_BUCKET ?? "";
const REGION = process.env.AWS_REGION ?? "us-east-1";
const PREFIX = `agentdb-bench-${Date.now()}`;

// Dynamic imports — only loaded when S3 tests actually run
let S3Backend: typeof import("@backloghq/opslog-s3").S3Backend;
let S3Client: typeof import("@aws-sdk/client-s3").S3Client;
let ListObjectsV2Command: typeof import("@aws-sdk/client-s3").ListObjectsV2Command;
let DeleteObjectsCommand: typeof import("@aws-sdk/client-s3").DeleteObjectsCommand;

function randomString(len: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz ";
  return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function randomRecord(i: number): Record<string, unknown> {
  return {
    _id: `rec-${i}`,
    name: `User ${i}`,
    email: `user${i}@example.com`,
    role: ["admin", "user", "moderator"][i % 3],
    score: Math.floor(Math.random() * 100),
    active: i % 2 === 0,
    bio: randomString(200),
    tags: [`tag-${i % 10}`, `group-${i % 5}`],
  };
}

async function benchAsync(name: string, fn: () => Promise<void>, iterations = 1): Promise<{ name: string; totalMs: number; avgMs: number; opsPerSec: number }> {
  const start = performance.now();
  await fn();
  const elapsed = performance.now() - start;
  return {
    name,
    totalMs: Math.round(elapsed * 100) / 100,
    avgMs: Math.round((elapsed / iterations) * 1000) / 1000,
    opsPerSec: Math.round(iterations / (elapsed / 1000)),
  };
}

async function cleanupS3(client: S3Client): Promise<void> {
  let token: string | undefined;
  do {
    const list = await client.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: PREFIX,
      ContinuationToken: token,
    }));
    if (list.Contents && list.Contents.length > 0) {
      await client.send(new DeleteObjectsCommand({
        Bucket: BUCKET,
        Delete: { Objects: list.Contents.map((o) => ({ Key: o.Key })) },
      }));
    }
    token = list.NextContinuationToken;
  } while (token);
}

const runS3 = BUCKET.length > 0;

describe.skipIf(!runS3)("S3 backend benchmarks", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: any;

  beforeAll(async () => {
    const s3Mod = await import("@aws-sdk/client-s3");
    const opslogS3 = await import("@backloghq/opslog-s3");
    S3Backend = opslogS3.S3Backend;
    S3Client = s3Mod.S3Client;
    ListObjectsV2Command = s3Mod.ListObjectsV2Command;
    DeleteObjectsCommand = s3Mod.DeleteObjectsCommand;
    client = new S3Client({ region: REGION });
  });

  afterAll(async () => {
    if (!client) return;
    // Clean up all test data
    await cleanupS3(client);
    client.destroy();
  }, 30000);

  it("insert: 100 records individually", async () => {
    const N = 100;
    const backend = new S3Backend({ bucket: BUCKET, prefix: `${PREFIX}/insert-single`, client });
    const store = new Store<Record<string, unknown>>();
    const col = new Collection("bench", store);
    await col.open("s3", { checkpointThreshold: 5000, backend });

    const result = await benchAsync(`S3 insert ${N} records`, async () => {
      for (let i = 0; i < N; i++) {
        await col.insert(randomRecord(i));
      }
    }, N);

    console.log(`  ${result.name}: ${result.totalMs}ms (${result.opsPerSec} ops/sec, ${result.avgMs}ms/op)`);
    expect(await col.count()).toBe(N);
    await col.close();
  }, 120000);

  it("insert: 100 records via batch", async () => {
    const N = 100;
    const backend = new S3Backend({ bucket: BUCKET, prefix: `${PREFIX}/insert-batch`, client });
    const store = new Store<Record<string, unknown>>();
    const col = new Collection("bench", store);
    await col.open("s3", { checkpointThreshold: 5000, backend });

    const records = Array.from({ length: N }, (_, i) => randomRecord(i));
    const result = await benchAsync(`S3 batch insert ${N} records`, async () => {
      await col.insertMany(records);
    }, N);

    console.log(`  ${result.name}: ${result.totalMs}ms (${result.opsPerSec} ops/sec)`);
    expect(await col.count()).toBe(N);
    await col.close();
  }, 60000);

  it("find: queries on 100 records (in-memory after load)", async () => {
    const N = 100;
    const backend = new S3Backend({ bucket: BUCKET, prefix: `${PREFIX}/find`, client });
    const store = new Store<Record<string, unknown>>();
    const col = new Collection("bench", store);
    await col.open("s3", { checkpointThreshold: 5000, backend });
    await col.insertMany(Array.from({ length: N }, (_, i) => randomRecord(i)));

    const QUERIES = 100;
    const start = performance.now();
    for (let i = 0; i < QUERIES; i++) {
      await col.find({ filter: { role: "admin", active: true } });
    }
    const elapsed = performance.now() - start;

    console.log(`  S3 find (${QUERIES} queries on ${N} records, in-memory): ${(elapsed / QUERIES).toFixed(3)}ms/query`);
    expect(elapsed / QUERIES).toBeLessThan(5);
    await col.close();
  }, 60000);

  it("cold start: open store with 100 records from S3", async () => {
    // First, write data
    const backend1 = new S3Backend({ bucket: BUCKET, prefix: `${PREFIX}/cold-start`, client });
    const store1 = new Store<Record<string, unknown>>();
    const col1 = new Collection("bench", store1);
    await col1.open("s3", { checkpointThreshold: 5000, backend: backend1 });
    await col1.insertMany(Array.from({ length: 100 }, (_, i) => randomRecord(i)));
    await col1.close();

    // Now measure cold start
    const backend2 = new S3Backend({ bucket: BUCKET, prefix: `${PREFIX}/cold-start`, client });
    const result = await benchAsync("S3 cold start (100 records)", async () => {
      const store2 = new Store<Record<string, unknown>>();
      const col2 = new Collection("bench", store2);
      await col2.open("s3", { checkpointThreshold: 5000, backend: backend2 });
      expect(await col2.count()).toBe(100);
      await col2.close();
    });

    console.log(`  ${result.name}: ${result.totalMs}ms`);
  }, 60000);

  it("undo: 10 operations on S3", async () => {
    const backend = new S3Backend({ bucket: BUCKET, prefix: `${PREFIX}/undo`, client });
    const store = new Store<Record<string, unknown>>();
    const col = new Collection("bench", store);
    await col.open("s3", { checkpointThreshold: 5000, backend });

    for (let i = 0; i < 10; i++) {
      await col.insert(randomRecord(i));
    }

    const N = 10;
    const result = await benchAsync(`S3 undo ${N} operations`, async () => {
      for (let i = 0; i < N; i++) {
        await col.undo();
      }
    }, N);

    console.log(`  ${result.name}: ${result.avgMs}ms/undo (${result.opsPerSec} ops/sec)`);
    expect(await col.count()).toBe(0);
    await col.close();
  }, 60000);

  it("compact: checkpoint 100 records to S3 snapshot", async () => {
    const backend = new S3Backend({ bucket: BUCKET, prefix: `${PREFIX}/compact`, client });
    const store = new Store<Record<string, unknown>>();
    await store.open("s3", { checkpointThreshold: 5000, backend });

    for (let i = 0; i < 100; i++) {
      await store.set(`rec-${i}`, randomRecord(i));
    }

    const result = await benchAsync("S3 compact (100 records)", async () => {
      await store.compact();
    });

    console.log(`  ${result.name}: ${result.totalMs}ms`);
    await store.close();
  }, 60000);

  it("prints S3 vs filesystem comparison", () => {
    console.log("\n  === S3 vs Filesystem Comparison ===");
    console.log("  S3 latency is dominated by HTTP round-trips (~50-200ms per PutObject).");
    console.log("  Batch operations amortize this (1 PutObject per batch vs N for individual).");
    console.log("  Read queries are in-memory after initial load — same speed as filesystem.");
    console.log("  Cold start depends on snapshot + WAL size and S3 GetObject latency.\n");
    expect(true).toBe(true);
  });

  it("blob: write, read, list, delete on S3", async () => {
    const backend = new S3Backend({ bucket: BUCKET, prefix: `${PREFIX}/blobs`, client });
    const store = new Store<Record<string, unknown>>();
    const col = new Collection("bench", store);
    await col.open("s3", { checkpointThreshold: 5000, backend });

    await col.insert({ _id: "doc1", title: "Blob test" });

    // Write text blob
    await col.writeBlob("doc1", "spec.md", "# My Spec\n\nHello from S3!");
    const text = await col.readBlob("doc1", "spec.md");
    expect(text.toString("utf-8")).toBe("# My Spec\n\nHello from S3!");

    // Write binary blob
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    await col.writeBlob("doc1", "image.png", binary);
    const readBinary = await col.readBlob("doc1", "image.png");
    expect(Buffer.compare(readBinary, binary)).toBe(0);

    // List blobs
    const blobs = await col.listBlobs("doc1");
    expect(blobs).toContain("spec.md");
    expect(blobs).toContain("image.png");

    // Delete blob
    await col.deleteBlob("doc1", "spec.md");
    const afterDelete = await col.listBlobs("doc1");
    expect(afterDelete).not.toContain("spec.md");
    expect(afterDelete).toContain("image.png");

    // Delete all blobs for record
    await col.deleteBlobsForRecord("doc1");
    const afterPurge = await col.listBlobs("doc1");
    expect(afterPurge).toEqual([]);

    await col.close();
    console.log("  Blob storage on S3: write, read, list, delete — all passed");
  }, 30000);

  it("disk mode: compact to Parquet on S3, reopen and read", async () => {
    const prefix = `${PREFIX}/disk-mode`;

    // Session 1: insert records, close (triggers Parquet compaction to S3)
    const backend1 = new S3Backend({ bucket: BUCKET, prefix, client });
    const store1 = new Store<Record<string, unknown>>();
    const col1 = new Collection("disk-s3", store1);
    await col1.open("s3", { checkpointThreshold: 5000, backend: backend1, skipLoad: true });

    // Set up DiskStore
    const { DiskStore } = await import("../src/disk-store.js");
    const ds1 = new DiskStore(backend1, { rowGroupSize: 50, extractColumns: ["role"] });
    await ds1.load();
    col1.setDiskStore(ds1);

    for (let i = 0; i < 20; i++) {
      await col1.insert(randomRecord(i));
    }
    expect(await col1.count()).toBe(20);

    // Compact to Parquet on S3
    const allRecords = await col1.findAll();
    await ds1.compact(allRecords.map((r) => [r._id as string, r]));
    await ds1.saveIndexes(col1.getIndexManager(), col1.getTextIndex());
    await col1.close();
    console.log("  Session 1: 20 records compacted to Parquet on S3");

    // Session 2: reopen with skipLoad — read from S3 Parquet
    const backend2 = new S3Backend({ bucket: BUCKET, prefix, client });
    const store2 = new Store<Record<string, unknown>>();
    const col2 = new Collection("disk-s3", store2);
    await col2.open("s3", { checkpointThreshold: 5000, backend: backend2, skipLoad: true });

    const ds2 = new DiskStore(backend2, { rowGroupSize: 50, extractColumns: ["role"] });
    await ds2.load();
    col2.setDiskStore(ds2);

    expect(ds2.hasParquetData).toBe(true);
    expect(ds2.recordCount).toBe(20);

    // findOne from S3 Parquet
    const record = await col2.findOne("rec-0");
    expect(record).toBeTruthy();
    expect(record?.name).toBe("User 0");

    // find returns all records
    const all = await col2.find({ limit: 100 });
    expect(all.total).toBe(20);

    await col2.close();
    console.log("  Session 2: 20 records read from S3 Parquet — disk mode works on S3");
  }, 60000);
});
