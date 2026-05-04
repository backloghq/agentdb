import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDB } from "../src/agentdb.js";
import { defineSchema } from "../src/schema.js";
import { DiskStore, IndexFileTooLargeError } from "../src/disk-store.js";

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agentdb-text-persist-"));
}

// Collections live at <dir>/collections/<name> — files written for test setup must go there.
function colDir(dir: string, name: string): string {
  return join(dir, "collections", name);
}

const schema = defineSchema({
  name: "articles",
  textSearch: true,
  storageMode: "disk",
  fields: {
    title: { type: "string", searchable: true },
    body: { type: "string", searchable: true },
    category: { type: "string" },
  },
});

describe("BM25 disk persistence — v2 round-trip", () => {
  it("bm25Search scores survive close and reopen", async () => {
    const dir = await makeTmpDir();

    // --- Session 1: insert, close (triggers compaction + index save) ---
    let db = new AgentDB(dir);
    await db.init();
    let col = await db.collection(schema);

    for (let i = 0; i < 50; i++) {
      const frequent = i < 10 ? "typescript typescript typescript" : "typescript";
      await col.insert({
        title: `Article ${i}: ${frequent}`,
        body: `Body content about programming and ${frequent}`,
        category: `cat-${i % 5}`,
      });
    }

    await db.close(); // triggers compaction + saveIndexes (writes v2 text-index.json)

    // --- Session 2: reopen, capture "before" scores ---
    db = new AgentDB(dir);
    await db.init();
    col = await db.collection(schema);

    const before = await col.bm25Search("typescript programming");
    expect(before.records.length).toBeGreaterThan(0);
    expect(before.scores.length).toBe(before.records.length);

    await db.close();

    // --- Session 3: reopen again, verify scores match ---
    db = new AgentDB(dir);
    await db.init();
    col = await db.collection(schema);

    const after = await col.bm25Search("typescript programming");

    expect(after.records.length).toBe(before.records.length);
    for (let i = 0; i < before.records.length; i++) {
      expect(after.records[i]._id).toBe(before.records[i]._id);
      expect(after.scores[i]).toBeCloseTo(before.scores[i], 6);
    }

    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("higher-TF docs still score higher after reopen", async () => {
    const dir = await makeTmpDir();
    const simpleSchema = defineSchema({
      name: "docs",
      textSearch: true,
      storageMode: "disk",
      fields: { title: { type: "string", searchable: true } },
    });

    let db = new AgentDB(dir);
    await db.init();
    let col = await db.collection(simpleSchema);

    // "rich" has the query term three times; "sparse" has it once
    await col.insert({ _id: "rich", title: "rust rust rust systems programming" });
    await col.insert({ _id: "sparse", title: "rust language overview" });
    await col.insert({ _id: "other", title: "python scripting tutorial" });

    await db.close(); // saves index

    db = new AgentDB(dir);
    await db.init();
    col = await db.collection(simpleSchema);

    const results = await col.bm25Search("rust");
    const ids = results.records.map((r) => r._id);
    expect(ids).toContain("rich");
    expect(ids).toContain("sparse");
    expect(ids).not.toContain("other");
    // "rich" should rank first (higher TF)
    expect(ids[0]).toBe("rich");
    expect(results.scores[0]).toBeGreaterThan(results.scores[1]);

    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("searchable-field projection is preserved in index after reopen", async () => {
    const dir = await makeTmpDir();
    const projSchema = defineSchema({
      name: "events",
      textSearch: true,
      storageMode: "disk",
      fields: {
        title: { type: "string", searchable: true },
        secret: { type: "string" }, // not searchable
      },
    });

    let db = new AgentDB(dir);
    await db.init();
    let col = await db.collection(projSchema);

    await col.insert({ title: "hello world", secret: "classified" });

    await db.close();

    db = new AgentDB(dir);
    await db.init();
    col = await db.collection(projSchema);

    // "hello" is in searchable title — should be found
    const found = await col.bm25Search("hello");
    expect(found.records.length).toBe(1);

    // "classified" is in non-searchable secret — must NOT be found
    const notFound = await col.bm25Search("classified");
    expect(notFound.records.length).toBe(0);

    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
});

describe("BM25 disk persistence — v1 upgrade path", () => {
  it("AND search still works with a v1 text-index.json on disk", async () => {
    const dir = await makeTmpDir();

    // Manually write a v1-format text-index.json at the correct collection path
    const v1Index = {
      version: 1,
      terms: {
        hello: ["doc1", "doc2"],
        world: ["doc1"],
        there: ["doc2"],
      },
      docCount: 2,
    };
    const cDir = colDir(dir, "articles");
    await mkdir(join(cDir, "indexes"), { recursive: true });
    await writeFile(join(cDir, "indexes", "text-index.json"), JSON.stringify(v1Index));

    // Write minimal compaction meta + empty files so DiskStore.load() succeeds
    const meta = {
      lastTimestamp: new Date().toISOString(),
      parquetFile: "data.parquet",
      parquetFiles: [],
      jsonlFile: "records.jsonl",
      jsonlFiles: [],
      rowCount: 0,
      rowGroups: 0,
      columnCardinality: {},
    };
    await writeFile(join(cDir, "compaction-meta.json"), JSON.stringify(meta));
    await writeFile(join(cDir, "records.jsonl"), "");
    await writeFile(join(cDir, "record-offsets.json"), "{}");
    await writeFile(join(cDir, "offset-index.json"), "{}");

    const v1Schema = defineSchema({
      name: "articles",
      textSearch: true,
      storageMode: "disk",
      fields: { title: { type: "string", searchable: true } },
    });

    const db = new AgentDB(dir);
    await db.init();
    const col = await db.collection(v1Schema);

    // Force lazy index load via bm25Search (triggers ensureIndexesLoaded)
    await col.bm25Search("hello");

    const textIdx = col.getTextIndex()!;
    expect(textIdx).not.toBeNull();

    // AND search must still work from v1 posting lists
    const andResult = textIdx.search("hello world");
    expect(andResult.has("doc1")).toBe(true);  // doc1 is in both "hello" and "world"
    expect(andResult.has("doc2")).toBe(false); // doc2 is in "hello" but not "world"

    // BM25 skips v1 placeholder docs (empty tfMap) — returns [] for a v1-only corpus.
    // No NaN, no rank-by-id surprise.
    const bm25Result = textIdx.searchScored("hello");
    expect(bm25Result).toEqual([]);

    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("v1-only corpus: searchScored returns [] (no score=0 ghost results)", async () => {
    const { TextIndex } = await import("../src/text-index.js");
    const v1Data = {
      version: 1,
      terms: { foo: ["a", "b"], bar: ["a"] },
      docCount: 2,
    };
    const idx = TextIndex.fromJSON(v1Data);
    // AND search still works
    expect(idx.search("foo bar").has("a")).toBe(true);
    expect(idx.search("foo bar").has("b")).toBe(false);
    // BM25 returns nothing — v1 docs have no TF data
    expect(idx.searchScored("foo")).toEqual([]);
    expect(idx.searchScored("foo bar")).toEqual([]);
  });

  it("mixed corpus (v1 docs + one v2 insert): only the v2 doc scores", async () => {
    const { TextIndex } = await import("../src/text-index.js");
    const v1Data = {
      version: 1,
      terms: { hello: ["v1a", "v1b"] },
      docCount: 2,
    };
    const idx = TextIndex.fromJSON(v1Data);

    // Add one new v2 doc
    idx.add("v2doc", { text: "hello hello world" });

    const results = idx.searchScored("hello");
    const ids = results.map((r) => r.id);
    // Only v2doc should appear — v1a and v1b have no TF data
    expect(ids).toEqual(["v2doc"]);
    expect(results[0].score).toBeGreaterThan(0);
    // No NaN
    expect(Number.isNaN(results[0].score)).toBe(false);
  });
});

describe("IndexFileTooLargeError — oversized text-index throws on reopen", () => {
  const REAL_LIMIT = DiskStore.MAX_INDEX_FILE_SIZE;
  const FAKE_LIMIT = 10; // 10 bytes — any real index file exceeds this

  beforeEach(() => {
    DiskStore.MAX_INDEX_FILE_SIZE = FAKE_LIMIT;
  });

  afterEach(() => {
    DiskStore.MAX_INDEX_FILE_SIZE = REAL_LIMIT;
  });

  it("throws IndexFileTooLargeError when text-index.json exceeds the limit on reopen", async () => {
    const dir = await makeTmpDir();
    try {
      // Session 1: create a disk-mode collection with text search and insert a doc
      let db = new AgentDB(dir);
      await db.init();
      const s = defineSchema({ name: "articles", textSearch: true, storageMode: "disk",
        fields: { title: { type: "string", searchable: true } } });
      const col = await db.collection(s);
      await col.insert({ title: "hello world typescript" });
      await db.close(); // saves text-index.json

      // Session 2: reopen with the lowered cap — throw on first BM25 query (lazy load)
      db = new AgentDB(dir);
      await db.init();
      const col2 = await db.collection(s);
      await expect(col2.bm25Search("hello")).rejects.toThrow(IndexFileTooLargeError);
      await db.close().catch(() => {});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("load succeeds at exactly MAX_INDEX_FILE_SIZE (uses >, not >=)", async () => {
    // Reset to real limit so we can set a content-length-matching cap
    DiskStore.MAX_INDEX_FILE_SIZE = REAL_LIMIT;

    const dir = await makeTmpDir();
    try {
      let db = new AgentDB(dir);
      await db.init();
      const s = defineSchema({ name: "edgecase", textSearch: true, storageMode: "disk",
        fields: { title: { type: "string", searchable: true } } });
      const col = await db.collection(s);
      await col.insert({ title: "hello world" });
      await db.close(); // saves text-index.json

      // Read the actual file size and set MAX_INDEX_FILE_SIZE = exact content length
      const { readFile } = await import("node:fs/promises");
      const { join: pathJoin } = await import("node:path");
      const indexPath = pathJoin(dir, "collections", "edgecase", "indexes", "text-index.json");
      const content = await readFile(indexPath);
      DiskStore.MAX_INDEX_FILE_SIZE = content.length; // exactly equal — must NOT throw (uses >)

      db = new AgentDB(dir);
      await db.init();
      const col2 = await db.collection(s);
      // Must succeed (> not >=)
      await expect(col2.bm25Search("hello")).resolves.toBeDefined();
      await db.close().catch(() => {});
    } finally {
      DiskStore.MAX_INDEX_FILE_SIZE = REAL_LIMIT;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("IndexFileTooLargeError message includes filename, actual size, and limit", async () => {
    const dir = await makeTmpDir();
    try {
      let db = new AgentDB(dir);
      await db.init();
      const s = defineSchema({ name: "articles2", textSearch: true, storageMode: "disk",
        fields: { body: { type: "string", searchable: true } } });
      const col = await db.collection(s);
      await col.insert({ body: "some content here" });
      await db.close();

      db = new AgentDB(dir);
      await db.init();
      let thrown: Error | null = null;
      try {
        const col2 = await db.collection(s);
        await col2.bm25Search("some");
      } catch (e) {
        thrown = e as Error;
      } finally {
        await db.close().catch(() => {});
      }
      expect(thrown).toBeInstanceOf(IndexFileTooLargeError);
      expect(thrown!.message).toMatch(/text-index\.json/);
      expect(thrown!.message).toMatch(/MAX_INDEX_FILE_SIZE/);
      expect(thrown!.message).toMatch(`${FAKE_LIMIT}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
