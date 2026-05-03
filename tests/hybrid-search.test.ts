import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDB } from "../src/agentdb.js";
import { defineSchema } from "../src/schema.js";
import { getTools } from "../src/tools/index.js";
import type { AgentTool } from "../src/tools/index.js";
import type { EmbeddingProvider } from "../src/embeddings/types.js";

// Deterministic embedding provider: vectors are one-hot by doc index
// (controlled externally via the `vectors` map).
class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 4;
  // Map from text → vector. If text not found, returns zero vector.
  private vectors: Map<string, number[]>;

  constructor(vectors: Map<string, number[]>) {
    this.vectors = vectors;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.vectors.get(t) ?? [0, 0, 0, 0]);
  }
}

const hybridSchema = defineSchema({
  name: "articles",
  textSearch: true,
  fields: {
    title: { type: "string", searchable: true },
    body: { type: "string", searchable: true },
    category: { type: "string" },
  },
});

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agentdb-hybrid-"));
}

describe("Collection.bm25Search — BM25-only scenarios", () => {
  let dir: string;
  let db: AgentDB;

  beforeEach(async () => {
    dir = await makeTmpDir();
    db = new AgentDB(dir);
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("filter prunes results: filtered-out doc absent even if BM25 top-ranked", async () => {
    const col = await db.collection(hybridSchema);
    // "alpha" has "rust" twice — top BM25, but wrong category
    await col.insert({ _id: "alpha", title: "rust rust systems", category: "systems" });
    await col.insert({ _id: "beta",  title: "rust language overview", category: "lang" });
    await col.insert({ _id: "gamma", title: "rust tools ecosystem", category: "lang" });

    const result = await col.bm25Search("rust", { filter: { category: "lang" } });
    const ids = result.records.map((r) => r._id);
    expect(ids).not.toContain("alpha");
    expect(ids).toContain("beta");
    expect(ids).toContain("gamma");
    expect(result.records.length).toBe(result.scores.length);
  });

  it("candidateLimit: overscan ensures filtered results fill limit", async () => {
    const col = await db.collection(hybridSchema);
    // Insert 10 docs; only the last 3 have category=keep
    for (let i = 0; i < 7; i++) {
      await col.insert({ _id: `skip-${i}`, title: `typescript foo bar baz ${i}`, category: "skip" });
    }
    for (let i = 0; i < 3; i++) {
      await col.insert({ _id: `keep-${i}`, title: `typescript guide ${i}`, category: "keep" });
    }

    // With default candidateLimit (max(limit*4,50)=50) all 10 candidates are considered
    const result = await col.bm25Search("typescript", {
      filter: { category: "keep" },
      limit: 3,
    });
    // All 3 "keep" docs should appear despite the 7 "skip" docs ranking first
    expect(result.records.length).toBe(3);
    expect(result.records.every((r) => r.category === "keep")).toBe(true);
  });

  it("summary projection: long string fields are stripped from bm25Search output", async () => {
    const col = await db.collection(hybridSchema);
    const longBody = "x".repeat(300);
    await col.insert({ _id: "doc1", title: "hello world", body: longBody, category: "test" });

    const withSummary = await col.bm25Search("hello", { summary: true });
    expect(withSummary.records.length).toBe(1);
    // body is >200 chars — summarize() strips it
    expect(withSummary.records[0].body).toBeUndefined();
    expect(withSummary.records[0].title).toBe("hello world");

    const withoutSummary = await col.bm25Search("hello", { summary: false });
    expect(withoutSummary.records[0].body).toBe(longBody);
  });
});

describe("Collection.hybridSearch — integration", () => {
  let dir: string;
  let db: AgentDB;
  let fakeVectors: Map<string, number[]>;

  beforeEach(async () => {
    dir = await makeTmpDir();
    fakeVectors = new Map();
    db = new AgentDB(dir, { embeddings: { provider: new FakeEmbeddingProvider(fakeVectors) } });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("combined ranking: lexical-only and semantic-only docs both appear in top results", async () => {
    const col = await db.collection(hybridSchema);

    // "lex-doc": strong BM25 signal ("python" 3x), zero semantic signal
    // "sem-doc": weak BM25 signal, strong semantic signal (vector near query)
    // "query" vector: [1,0,0,0]
    fakeVectors.set("python python python scripting tutorial", [0.01, 0.99, 0.01, 0.01]);
    fakeVectors.set("scripting automation workflow", [1, 0, 0, 0]);
    fakeVectors.set("python", [0.5, 0.5, 0, 0]);

    await col.insert({ _id: "lex-doc", title: "python python python scripting tutorial", category: "a" });
    await col.insert({ _id: "sem-doc", title: "scripting automation workflow", category: "b" });
    await col.insert({ _id: "other",   title: "unrelated content here", category: "c" });
    await col.embedUnembedded();

    const result = await col.hybridSearch("python", { limit: 5 });
    const ids = result.records.map((r) => r._id);
    expect(ids).toContain("lex-doc");
    expect(ids).toContain("sem-doc");
    expect(result.records.length).toBe(result.scores.length);
    expect(result.scores.every((s) => s > 0)).toBe(true);
  });

  it("filter respected: filter excludes top BM25 hit from hybrid output", async () => {
    const col = await db.collection(hybridSchema);

    fakeVectors.set("rust rust systems programming", [1, 0, 0, 0]);
    fakeVectors.set("rust language guide", [0.9, 0.1, 0, 0]);
    fakeVectors.set("rust", [1, 0, 0, 0]);

    await col.insert({ _id: "top-bm25", title: "rust rust systems programming", category: "systems" });
    await col.insert({ _id: "included", title: "rust language guide", category: "lang" });
    await col.embedUnembedded();

    const result = await col.hybridSearch("rust", { filter: { category: "lang" }, limit: 10 });
    const ids = result.records.map((r) => r._id);
    expect(ids).not.toContain("top-bm25");
    expect(ids).toContain("included");
  });

  it("degraded: no embedding provider — returns BM25-only ranking", async () => {
    // Use a plain db without embedding provider
    const plainDb = new AgentDB(dir + "-plain");
    await plainDb.init();
    try {
      const col = await plainDb.collection(hybridSchema);
      await col.insert({ _id: "d1", title: "typescript typescript guide", category: "a" });
      await col.insert({ _id: "d2", title: "typescript intro", category: "b" });
      await col.insert({ _id: "d3", title: "javascript tutorial", category: "c" });

      const hybridResult = await col.hybridSearch("typescript", { limit: 5 });
      const bm25Result   = await col.bm25Search("typescript", { limit: 5 });

      // Ids and order must match BM25 exactly when no semantic arm
      expect(hybridResult.records.map((r) => r._id))
        .toEqual(bm25Result.records.map((r) => r._id));
    } finally {
      await plainDb.close();
      await rm(dir + "-plain", { recursive: true, force: true });
    }
  });

  it("degraded: vector-only collection — returns vector-only ranking", async () => {
    // Collection with no text fields: hybridSearch falls back to semantic arm only
    const vecSchema = defineSchema({
      name: "vecdocs",
      fields: { label: { type: "string" } },
    });
    const col = await db.collection(vecSchema);
    // Insert vectors directly; no text indexing
    await col.insertVector("near",  [1, 0, 0, 0], { label: "near the query" });
    await col.insertVector("far",   [0, 1, 0, 0], { label: "far from query" });
    await col.insertVector("closer",[0.9, 0.1, 0, 0], { label: "closer" });

    fakeVectors.set("test query", [1, 0, 0, 0]);

    const result = await col.hybridSearch("test query", { limit: 3 });
    const ids = result.records.map((r) => r._id);
    // "near" is closest to [1,0,0,0] — must be first
    expect(ids[0]).toBe("near");
    expect(ids).toContain("closer");
    expect(ids).toContain("far");
    expect(result.records.length).toBe(result.scores.length);
  });

  it("both unavailable: throws when neither text index nor embedding provider present", async () => {
    const plainDb = new AgentDB(dir + "-plain2");
    await plainDb.init();
    try {
      const noSearchSchema = defineSchema({
        name: "plain",
        fields: { title: { type: "string" } },
      });
      const col = await plainDb.collection(noSearchSchema);
      await col.insert({ _id: "x", title: "hello" });
      await expect(col.hybridSearch("hello")).rejects.toThrow(
        "hybridSearch requires either an embedding provider or a text index",
      );
    } finally {
      await plainDb.close();
      await rm(dir + "-plain2", { recursive: true, force: true });
    }
  });

  it("disk-mode persistence: hybridSearch BM25 scores match after close/reopen", async () => {
    const diskSchema = defineSchema({
      name: "diskdocs",
      textSearch: true,
      storageMode: "disk",
      fields: { title: { type: "string", searchable: true } },
    });

    const diskDir = dir + "-disk";
    let diskDb = new AgentDB(diskDir, { embeddings: { provider: new FakeEmbeddingProvider(fakeVectors) } });
    await diskDb.init();
    let col = await diskDb.collection(diskSchema);

    fakeVectors.set("typescript guide", [1, 0, 0, 0]);
    fakeVectors.set("typescript typescript advanced", [0.9, 0.1, 0, 0]);
    fakeVectors.set("typescript", [1, 0, 0, 0]);

    await col.insert({ _id: "d1", title: "typescript guide" });
    await col.insert({ _id: "d2", title: "typescript typescript advanced" });
    await diskDb.close();

    // Reopen and run hybrid — BM25 scores must be restored from disk
    const fakeVectors2 = new Map(fakeVectors);
    diskDb = new AgentDB(diskDir, { embeddings: { provider: new FakeEmbeddingProvider(fakeVectors2) } });
    await diskDb.init();
    col = await diskDb.collection(diskSchema);
    await col.embedUnembedded();

    const before = await col.hybridSearch("typescript", { limit: 5 });
    await diskDb.close();

    const fakeVectors3 = new Map(fakeVectors);
    diskDb = new AgentDB(diskDir, { embeddings: { provider: new FakeEmbeddingProvider(fakeVectors3) } });
    await diskDb.init();
    col = await diskDb.collection(diskSchema);
    await col.embedUnembedded();

    const after = await col.hybridSearch("typescript", { limit: 5 });

    expect(after.records.map((r) => r._id)).toEqual(before.records.map((r) => r._id));
    for (let i = 0; i < before.scores.length; i++) {
      expect(after.scores[i]).toBeCloseTo(before.scores[i], 6);
    }

    await diskDb.close();
    await rm(diskDir, { recursive: true, force: true });
  });
});

describe("db_hybrid_search tool round-trip", () => {
  let dir: string;
  let db: AgentDB;
  let tools: AgentTool[];

  function tool(name: string): AgentTool {
    const t = tools.find((t) => t.name === name);
    if (!t) throw new Error(`Tool '${name}' not found`);
    return t;
  }

  async function exec(name: string, args: Record<string, unknown> = {}) {
    const t = tool(name);
    const result = await t.execute(args);
    if (result.isError) throw new Error((result.content[0] as { text: string }).text);
    return JSON.parse((result.content[0] as { text: string }).text);
  }

  beforeEach(async () => {
    dir = await makeTmpDir();
    const fakeVectors = new Map<string, number[]>([
      ["hello world search", [1, 0, 0, 0]],
      ["hello world",        [0.9, 0.1, 0, 0]],
      ["goodbye moon",       [0, 1, 0, 0]],
    ]);
    db = new AgentDB(dir, { embeddings: { provider: new FakeEmbeddingProvider(fakeVectors) } });
    await db.init();
    tools = getTools(db);
  });

  afterEach(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("db_hybrid_search returns records and scores arrays", async () => {
    // Pre-create collection with textSearch via defineSchema before using tools
    const toolSchema = defineSchema({
      name: "articles",
      textSearch: true,
      fields: { title: { type: "string", searchable: true } },
    });
    const col = await db.collection(toolSchema);
    await col.insert({ _id: "a1", title: "hello world" });
    await col.insert({ _id: "a2", title: "goodbye moon" });
    await col.embedUnembedded();

    const result = await exec("db_hybrid_search", {
      collection: "articles",
      query: "hello world search",
      limit: 5,
    });

    expect(Array.isArray(result.records)).toBe(true);
    expect(Array.isArray(result.scores)).toBe(true);
    expect(result.records.length).toBeGreaterThan(0);
    expect(result.scores.length).toBe(result.records.length);
    // "a1" has "hello world" — top BM25 match for "hello world search"
    expect(result.records[0]._id).toBe("a1");
  });

  it("db_hybrid_search returns isError when collection has no search capability", async () => {
    // Use a fresh db with no embedding provider so hybridSearch has neither arm
    const plainDir = dir + "-plain";
    const plainDb = new AgentDB(plainDir);
    await plainDb.init();
    const plainTools = getTools(plainDb);
    const plainExec = async (name: string, args: Record<string, unknown> = {}) => {
      const t = plainTools.find((t) => t.name === name)!;
      const result = await t.execute(args);
      if (result.isError) throw new Error((result.content[0] as { text: string }).text);
      return JSON.parse((result.content[0] as { text: string }).text);
    };
    try {
      await plainExec("db_create", { collection: "plain" });
      await plainExec("db_insert", { collection: "plain", record: { title: "hello" } });
      const t = plainTools.find((t) => t.name === "db_hybrid_search")!;
      const result = await t.execute({ collection: "plain", query: "test" });
      expect(result.isError).toBe(true);
    } finally {
      await plainDb.close();
      await rm(plainDir, { recursive: true, force: true });
    }
  });
});
