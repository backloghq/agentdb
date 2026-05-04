import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDB } from "../src/agentdb.js";
import { defineSchema } from "../src/schema.js";
import type { EmbeddingProvider } from "../src/embeddings/types.js";

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agentdb-same-session-"));
}

// Deterministic hash provider (32 dims) — same as disk-embed.test.ts
class HashProvider implements EmbeddingProvider {
  readonly dimensions = 32;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      let h = 5381;
      for (let i = 0; i < t.length; i++) h = (Math.imul(h, 33) ^ t.charCodeAt(i)) >>> 0;
      let s = h || 1;
      const vec = Array.from({ length: this.dimensions }, () => {
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
        return (s >>> 0) / 0x100000000 * 2 - 1;
      });
      const norm = Math.sqrt(vec.reduce((a, v) => a + v * v, 0)) || 1;
      return vec.map((v) => v / norm);
    });
  }
}

describe("disk-mode same-session search (#196 regression)", () => {
  it("bm25Search returns WAL-inserted records without close/reopen", async () => {
    const dir = await makeTmpDir();
    const schema = defineSchema({
      name: "docs",
      textSearch: true,
      fields: { title: { type: "string", searchable: true } },
    });

    const db = new AgentDB(dir, { storageMode: "disk" });
    await db.init();
    const col = await db.collection(schema);

    for (let i = 0; i < 20; i++) {
      await col.insert({ _id: `d${i}`, title: `document about topic ${i}` });
    }
    await col.insert({ _id: "target", title: "unique rust programming" });

    const result = await col.bm25Search("rust");
    expect(result.records.length).toBeGreaterThan(0);
    expect(result.records.map((r) => r._id)).toContain("target");

    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("semanticSearch returns WAL-inserted records without close/reopen", async () => {
    const dir = await makeTmpDir();
    const provider = new HashProvider();
    const schema = defineSchema({
      name: "docs",
      fields: { title: { type: "string" } },
    });

    const db = new AgentDB(dir, { storageMode: "disk", embeddings: { provider } });
    await db.init();
    const col = await db.collection(schema);

    await col.insert({ _id: "alpha", title: "apples and oranges" });
    await col.insert({ _id: "beta", title: "clouds and rain" });
    await col.embedUnembedded();

    const result = await col.semanticSearch("apples and oranges");
    expect(result.records.length).toBeGreaterThan(0);
    expect(result.records.map((r) => r._id)).toContain("alpha");

    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("searchByVector returns WAL-inserted records without close/reopen", async () => {
    const dir = await makeTmpDir();

    const db = new AgentDB(dir, { storageMode: "disk" });
    await db.init();
    const col = await db.collection("vecs");

    const vec = [1, 0, 0, 0];
    await col.insertVector("v1", vec, { label: "target" });
    await col.insertVector("v2", [0, 1, 0, 0], { label: "other" });

    const result = await col.searchByVector(vec, { limit: 5 });
    expect(result.records.length).toBeGreaterThan(0);
    expect(result.records.map((r) => r._id)).toContain("v1");

    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("hybridSearch returns WAL-inserted records without close/reopen", async () => {
    const dir = await makeTmpDir();
    const provider = new HashProvider();
    const schema = defineSchema({
      name: "docs",
      textSearch: true,
      fields: { title: { type: "string", searchable: true } },
    });

    const db = new AgentDB(dir, { storageMode: "disk", embeddings: { provider } });
    await db.init();
    const col = await db.collection(schema);

    await col.insert({ _id: "h1", title: "hybrid search test document" });
    await col.insert({ _id: "h2", title: "unrelated content here" });
    await col.embedUnembedded();

    const result = await col.hybridSearch("hybrid search");
    expect(result.records.length).toBeGreaterThan(0);
    expect(result.records.map((r) => r._id)).toContain("h1");

    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("mixed-session: old records (disk) + new records (WAL) both returned after reopen+insert+search", async () => {
    const dir = await makeTmpDir();
    const schema = defineSchema({
      name: "mixed",
      textSearch: true,
      fields: { title: { type: "string", searchable: true } },
    });

    // Session 1: insert 10 records, close → compacted to Parquet
    {
      const db = new AgentDB(dir, { storageMode: "disk" });
      await db.init();
      const col = await db.collection(schema);
      for (let i = 0; i < 10; i++) {
        await col.insert({ _id: `old${i}`, title: `old document topic ${i}` });
      }
      await db.close();
    }

    // Session 2: reopen, insert 10 more (WAL only), search → must return both
    {
      const db = new AgentDB(dir, { storageMode: "disk" });
      await db.init();
      const col = await db.collection(schema);

      for (let i = 0; i < 10; i++) {
        await col.insert({ _id: `new${i}`, title: `freshly inserted xyzzy ${i}` });
      }

      // Search for old records (Parquet)
      const oldResult = await col.bm25Search("old document topic");
      expect(oldResult.records.map((r) => r._id as string).some((id) => id.startsWith("old"))).toBe(true);

      // Search for new records (WAL) — unique term "xyzzy" only in session-2 inserts
      const newResult = await col.bm25Search("xyzzy");
      expect(newResult.records.length).toBeGreaterThan(0);
      expect(newResult.records.map((r) => r._id as string).some((id) => id.startsWith("new"))).toBe(true);

      await db.close();
    }

    await rm(dir, { recursive: true, force: true });
  });
});
