import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDB } from "../src/agentdb.js";
import { defineSchema } from "../src/schema.js";

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

    // BM25 falls back gracefully: docs returned with score >= 0
    // v1 has tf=0 for all terms so numerator = 0, scores = 0 but docs still returned
    const bm25Result = textIdx.searchScored("hello");
    const bm25Ids = bm25Result.map((r) => r.id).sort();
    expect(bm25Ids).toEqual(["doc1", "doc2"].sort());
    for (const r of bm25Result) {
      expect(r.score).toBeGreaterThanOrEqual(0);
    }

    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
});
