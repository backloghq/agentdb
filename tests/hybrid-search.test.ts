import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDB } from "../src/agentdb.js";
import { Collection } from "../src/collection.js";
import { DiskStore } from "../src/disk-store.js";
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

  it("semantic arm runtime failure degrades to BM25-only result", async () => {
    // Provider throws on embed — semantic arm must fail silently, BM25 results still returned
    const throwingProvider = {
      dimensions: 4,
      embed: async (): Promise<number[][]> => {
        throw new Error("provider offline");
      },
    };
    const throwDir = dir + "-throw";
    const throwDb = new AgentDB(throwDir, { embeddings: { provider: throwingProvider } });
    await throwDb.init();
    try {
      const col = await throwDb.collection(hybridSchema);
      await col.insert({ _id: "bm25-doc", title: "typescript generics advanced" });
      await col.insert({ _id: "other-doc", title: "rust systems programming" });

      const result = await col.hybridSearch("typescript generics", { limit: 5 });

      // Must not throw — semantic arm failure is swallowed
      expect(Array.isArray(result.records)).toBe(true);
      expect(Array.isArray(result.scores)).toBe(true);
      // BM25 arm still provides results
      expect(result.records.length).toBeGreaterThan(0);
      expect(result.records.map((r) => r._id)).toContain("bm25-doc");
    } finally {
      await throwDb.close();
      await rm(throwDir, { recursive: true, force: true });
    }
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

  it("db_hybrid_search candidateLimit is forwarded to the lib layer", async () => {
    const toolSchema = defineSchema({
      name: "cl_articles",
      textSearch: true,
      fields: { title: { type: "string", searchable: true }, category: { type: "string" } },
    });
    const col = await db.collection(toolSchema);
    // Insert many docs so candidateLimit=1 would cap candidates before filter pruning
    for (let i = 0; i < 10; i++) {
      await col.insert({ _id: `cl${i}`, title: "typescript language", category: i === 0 ? "keep" : "drop" });
    }
    await col.embedUnembedded();

    // candidateLimit=1 means only 1 BM25 candidate is examined — with a filter
    // that only cl0 passes, this verifies candidateLimit actually reaches bm25Search
    const limited = await exec("db_hybrid_search", {
      collection: "cl_articles",
      query: "typescript language",
      limit: 5,
      candidateLimit: 1,
      filter: { category: "keep" },
    });
    expect(Array.isArray(limited.records)).toBe(true);
    expect(limited.scores.length).toBe(limited.records.length);

    // Without candidateLimit all 10 match "typescript", filter keeps only cl0
    const unlimited = await exec("db_hybrid_search", {
      collection: "cl_articles",
      query: "typescript language",
      limit: 5,
      filter: { category: "keep" },
    });
    expect(unlimited.records.length).toBeGreaterThanOrEqual(1);
    expect(unlimited.records[0]._id).toBe("cl0");
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

  it("db_bm25_search returns records and scores in BM25 order", async () => {
    const toolSchema = defineSchema({
      name: "docs",
      textSearch: true,
      fields: { title: { type: "string", searchable: true } },
    });
    const col = await db.collection(toolSchema);
    await col.insert({ _id: "d1", title: "hello world" });
    await col.insert({ _id: "d2", title: "goodbye moon" });

    const result = await exec("db_bm25_search", {
      collection: "docs",
      query: "hello world",
      limit: 5,
    });

    expect(Array.isArray(result.records)).toBe(true);
    expect(Array.isArray(result.scores)).toBe(true);
    expect(result.records.length).toBeGreaterThan(0);
    expect(result.scores.length).toBe(result.records.length);
    expect(result.records[0]._id).toBe("d1");
  });

  it("db_bm25_search returns isError when collection has no text index", async () => {
    const noTextDir = dir + "-notext";
    const noTextDb = new AgentDB(noTextDir);
    await noTextDb.init();
    const noTextTools = getTools(noTextDb);
    try {
      const createT = noTextTools.find((t) => t.name === "db_create")!;
      await createT.execute({ collection: "plain" });
      const insertT = noTextTools.find((t) => t.name === "db_insert")!;
      await insertT.execute({ collection: "plain", record: { title: "hello" } });
      const t = noTextTools.find((t) => t.name === "db_bm25_search")!;
      const result = await t.execute({ collection: "plain", query: "hello" });
      expect(result.isError).toBe(true);
    } finally {
      await noTextDb.close();
      await rm(noTextDir, { recursive: true, force: true });
    }
  });
});

describe("hybridSearch — disk-mode correctness", () => {
  it("semantic-arm records are present after close/reopen in disk mode", async () => {
    const dir = await makeTmpDir();

    // "sem-only" has a unique semantic vector and no BM25 tokens matching the query.
    // "bm25-match" has strong BM25 overlap with the query "neural networks".
    // The query string is registered in the vectors map so the FakeEmbeddingProvider
    // returns a non-zero vector (close to sem-only's) rather than [0,0,0,0].
    const vectors = new Map<string, number[]>([
      ["neural networks query", [0, 1, 0, 0]],          // query vector — close to sem-only
      ["doc about neural networks deep learning", [1, 0, 0, 0]],
      ["semantic only document xqz", [0, 1, 0, 0]],
    ]);
    const provider = new FakeEmbeddingProvider(vectors);

    const schema = defineSchema({
      name: "articles",
      textSearch: true,
      fields: {
        title: { type: "string", searchable: true },
        body: { type: "string", searchable: true },
      },
    });

    // Phase 1: insert, embed, close.
    {
      const db = new AgentDB(dir, { embeddings: { provider } });
      await db.init();
      const col = await db.collection(schema);
      await col.insert({ _id: "bm25-match", title: "doc about neural networks deep learning" });
      await col.insert({ _id: "sem-only", title: "semantic only document xqz" });
      await col.embedUnembedded();
      await db.close();
    }

    // Phase 2: reopen, hybrid search with query whose vector points toward sem-only.
    {
      const db = new AgentDB(dir, { embeddings: { provider } });
      await db.init();
      const col = await db.collection(schema);

      // "neural networks query" → [0,1,0,0] is identical to sem-only's vector.
      // BM25 arm ranks bm25-match for "neural networks"; semantic arm ranks sem-only.
      // After RRF both must appear in the result.
      const result = await col.hybridSearch("neural networks query", { limit: 10 });

      const ids = result.records.map((r) => r._id as string);
      // Both docs must appear — the semantic arm must hydrate sem-only.
      expect(ids).toContain("bm25-match");
      expect(ids).toContain("sem-only");

      await db.close();
    }

    await rm(dir, { recursive: true, force: true });
  });
});

describe("hybridSearch — coverage gaps", () => {
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

  it("dedup: record appearing in both arms is returned once with combined RRF score", async () => {
    const schema = defineSchema({
      name: "dedup",
      textSearch: true,
      fields: { title: { type: "string", searchable: true } },
    });
    const col = await db.collection(schema);

    // "shared" appears top in both BM25 ("typescript typescript") and semantic (nearest vector)
    fakeVectors.set("typescript", [1, 0, 0, 0]);
    fakeVectors.set("typescript typescript", [1, 0, 0, 0]);
    fakeVectors.set("other content here", [0, 1, 0, 0]);

    await col.insert({ _id: "shared", title: "typescript typescript" });
    await col.insert({ _id: "other",  title: "other content here" });
    await col.embedUnembedded();

    const result = await col.hybridSearch("typescript", { limit: 10 });
    const ids = result.records.map((r) => r._id);

    // "shared" appears exactly once
    expect(ids.filter((id) => id === "shared").length).toBe(1);
    // scores and records are aligned
    expect(result.scores.length).toBe(result.records.length);
  });

  it("summary:true strips long fields from both BM25-arm-only and semantic-arm-only records", async () => {
    const schema = defineSchema({
      name: "summcol",
      textSearch: true,
      fields: {
        title: { type: "string", searchable: true },
        body: { type: "string" },
      },
    });
    const col = await db.collection(schema);
    const longBody = "x".repeat(300);

    fakeVectors.set("lexical search", [1, 0, 0, 0]);
    fakeVectors.set("lex only doc title", [0.1, 0.9, 0, 0]);
    fakeVectors.set("sem only document", [1, 0, 0, 0]);

    await col.insert({ _id: "lex", title: "lex only doc title", body: longBody });
    await col.insert({ _id: "sem", title: "sem only document",  body: longBody });
    await col.embedUnembedded();

    const result = await col.hybridSearch("lexical search", { limit: 10, summary: true });
    for (const rec of result.records) {
      // summary strips long string fields
      expect((rec.body as string | undefined) === undefined || (rec.body as string).length < 300).toBe(true);
    }
    expect(result.records.length).toBeGreaterThan(0);
  });

  it("one arm returns zero matches: semantic hits pass through when BM25 vocab misses", async () => {
    const schema = defineSchema({
      name: "onematch",
      textSearch: true,
      fields: { title: { type: "string", searchable: true } },
    });
    const col = await db.collection(schema);

    fakeVectors.set("xyzzy quux completely unknown vocab", [1, 0, 0, 0]);
    fakeVectors.set("machine learning basics", [1, 0, 0, 0]);

    await col.insert({ _id: "ml", title: "machine learning basics" });
    await col.embedUnembedded();

    // "xyzzy quux" has no BM25 match; semantic arm returns "ml" (vectors equal)
    const result = await col.hybridSearch("xyzzy quux completely unknown vocab", { limit: 5 });
    const ids = result.records.map((r) => r._id);
    expect(ids).toContain("ml");
    expect(result.scores.length).toBe(result.records.length);
    expect(result.scores.every((s) => s > 0)).toBe(true);
  });

  it("one arm returns zero matches: BM25 hits pass through when semantic vec is zero", async () => {
    const schema = defineSchema({
      name: "bm25pass",
      textSearch: true,
      fields: { title: { type: "string", searchable: true } },
    });
    const col = await db.collection(schema);

    // query vector maps to zero → semantic arm returns nothing (cosine similarity undefined/0)
    // BM25 arm matches "typescript"
    fakeVectors.set("typescript", [0, 0, 0, 0]);
    fakeVectors.set("typescript language guide", [0, 0, 0, 0]);

    await col.insert({ _id: "ts", title: "typescript language guide" });
    await col.embedUnembedded();

    const result = await col.hybridSearch("typescript", { limit: 5 });
    // BM25 arm must deliver "ts"
    expect(result.records.map((r) => r._id)).toContain("ts");
    expect(result.scores.length).toBe(result.records.length);
  });
});

describe("db_hybrid_search tool — argument forwarding", () => {
  let dir: string;
  let db: AgentDB;

  beforeEach(async () => {
    dir = await makeTmpDir();
    const fakeVectors = new Map<string, number[]>([
      ["typescript generics", [1, 0, 0, 0]],
      ["typescript language intro", [0.9, 0.1, 0, 0]],
      ["javascript guide", [0, 1, 0, 0]],
    ]);
    db = new AgentDB(dir, { embeddings: { provider: new FakeEmbeddingProvider(fakeVectors) } });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("summary, filter, k, and candidateLimit all reach hybridSearch via the tool", async () => {
    const tools = getTools(db);
    const schema = defineSchema({
      name: "argfwd",
      textSearch: true,
      fields: {
        title:    { type: "string", searchable: true },
        body:     { type: "string" },
        category: { type: "string" },
      },
    });
    const col = await db.collection(schema);
    const longBody = "z".repeat(400);
    await col.insert({ _id: "ts",  title: "typescript language intro", body: longBody, category: "keep" });
    await col.insert({ _id: "js",  title: "javascript guide",          body: longBody, category: "drop" });
    await col.embedUnembedded();

    const t = tools.find((t) => t.name === "db_hybrid_search")!;
    const raw = await t.execute({
      collection: "argfwd",
      query: "typescript generics",
      limit: 10,
      k: 30,
      candidateLimit: 100,
      summary: true,
      filter: { category: "keep" },
    });

    expect(raw.isError).toBeFalsy();
    const result = JSON.parse((raw.content[0] as { text: string }).text);

    // filter: only "keep" category passes
    expect(result.records.every((r: Record<string, unknown>) => r.category === "keep")).toBe(true);
    // summary: long body stripped
    for (const rec of result.records) {
      const body = rec.body as string | undefined;
      expect(body === undefined || body.length < 400).toBe(true);
    }
    // scores aligned
    expect(result.scores.length).toBe(result.records.length);
  });
});

describe("hybridSearch — candidateLimit no-double-amplification", () => {
  let dir: string;
  let db: AgentDB;

  beforeEach(async () => {
    dir = await makeTmpDir();
    const fakeVectors = new Map<string, number[]>();
    for (let i = 0; i < 60; i++) {
      const vec = new Array<number>(4).fill(0);
      vec[i % 4] = 1;
      fakeVectors.set(`doc${i}`, vec);
    }
    fakeVectors.set("query", [1, 0, 0, 0]);
    db = new AgentDB(dir, { embeddings: { provider: new FakeEmbeddingProvider(fakeVectors) } });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("candidateLimit is forwarded to bm25Search and semanticSearch without re-amplification", async () => {
    const schema = defineSchema({
      name: "nodoubleamp",
      textSearch: true,
      fields: { title: { type: "string", searchable: true } },
    });
    const col = await db.collection(schema);
    for (let i = 0; i < 60; i++) {
      await col.insert({ _id: `d${i}`, title: `doc${i} word` });
    }
    await col.embedUnembedded();

    const bm25Spy = vi.spyOn(Collection.prototype, "bm25Search");
    const semSpy = vi.spyOn(Collection.prototype, "semanticSearch");

    await col.hybridSearch("word", { limit: 10, candidateLimit: 50 });

    // bm25Search should receive candidateLimit=50 explicitly (not 10*4=40 nor 50*4=200)
    expect(bm25Spy).toHaveBeenCalledOnce();
    const bm25Call = bm25Spy.mock.calls[0];
    expect(bm25Call[1]).toMatchObject({ candidateLimit: 50 });

    // semanticSearch should also receive candidateLimit=50
    expect(semSpy).toHaveBeenCalledOnce();
    const semCall = semSpy.mock.calls[0];
    expect(semCall[1]).toMatchObject({ candidateLimit: 50 });

    bm25Spy.mockRestore();
    semSpy.mockRestore();
  });

  it("bm25Search receives candidateLimit=5, not 5*4=20 (no re-amplification)", async () => {
    const schema = defineSchema({
      name: "capscheck",
      textSearch: true,
      fields: { title: { type: "string", searchable: true } },
    });
    const col = await db.collection(schema);
    for (let i = 0; i < 60; i++) {
      await col.insert({ _id: `c${i}`, title: `doc${i} word` });
    }
    await col.embedUnembedded();

    const bm25Spy = vi.spyOn(Collection.prototype, "bm25Search");

    await col.hybridSearch("word", { limit: 10, candidateLimit: 5 });

    expect(bm25Spy).toHaveBeenCalledOnce();
    // candidateLimit must be passed as 5, not re-amplified to 5*4=20
    expect(bm25Spy.mock.calls[0][1]).toMatchObject({ limit: 5, candidateLimit: 5 });

    bm25Spy.mockRestore();
  });
});

describe("hybridSearch — empty-query short-circuit", () => {
  let dir: string;
  let db: AgentDB;

  beforeEach(async () => {
    dir = await makeTmpDir();
    db = new AgentDB(dir, { embeddings: { provider: new FakeEmbeddingProvider(new Map()) } });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("empty string returns [] without calling either arm", async () => {
    const schema = defineSchema({
      name: "emptyqhybrid",
      textSearch: true,
      fields: { title: { type: "string", searchable: true } },
    });
    const col = await db.collection(schema);
    await col.insert({ _id: "a", title: "typescript generics" });
    await col.embedUnembedded();

    const bm25Spy = vi.spyOn(Collection.prototype, "bm25Search");
    const semSpy = vi.spyOn(Collection.prototype, "semanticSearch");

    const result = await col.hybridSearch("");
    expect(result.records).toHaveLength(0);
    expect(result.scores).toHaveLength(0);
    expect(bm25Spy).not.toHaveBeenCalled();
    expect(semSpy).not.toHaveBeenCalled();

    bm25Spy.mockRestore();
    semSpy.mockRestore();
  });

  it("whitespace-only query returns [] without calling either arm", async () => {
    const schema = defineSchema({
      name: "emptyqhybrid2",
      textSearch: true,
      fields: { title: { type: "string", searchable: true } },
    });
    const col = await db.collection(schema);

    const bm25Spy = vi.spyOn(Collection.prototype, "bm25Search");
    const result = await col.hybridSearch("   ");
    expect(result.records).toHaveLength(0);
    expect(bm25Spy).not.toHaveBeenCalled();

    bm25Spy.mockRestore();
  });
});

describe("DiskStore.entries — skipCache flag", () => {
  it("skipCache:true does not populate the LRU cache", async () => {
    const dir = await makeTmpDir();
    const schema = defineSchema({ name: "skipcache", fields: { title: { type: "string" } } });

    // Set up disk-mode collection with records
    const db = new AgentDB(dir, { storageMode: "disk" });
    await db.init();
    const col = await db.collection(schema);
    for (let i = 0; i < 10; i++) {
      await col.insert({ _id: `d${i}`, title: `hello world ${i}` });
    }
    // Force compaction so records land in JSONL (entries() reads JSONL)
    const ds = col.getDiskStore()!;
    const allRecords = await col.findAll();
    await ds.compact(allRecords.map((r) => [r._id as string, r]));

    ds.clearCache();
    expect(ds.cacheStats.size).toBe(0);

    // entries({ skipCache: true }) — cache must stay empty
    let count = 0;
    for await (const [, ] of ds.entries({ skipCache: true })) { count++; }
    expect(count).toBeGreaterThan(0);
    expect(ds.cacheStats.size).toBe(0);

    // entries() without flag — cache must be populated
    for await (const [, ] of ds.entries()) { /* no-op */ }
    expect(ds.cacheStats.size).toBeGreaterThan(0);

    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
});

describe("materializeCandidates — concurrency cap", () => {
  it("non-FS backend: peak in-flight get() calls ≤ diskConcurrency cap", async () => {
    const dir = await makeTmpDir();
    const schema = defineSchema({
      name: "concap",
      textSearch: true,
      fields: { title: { type: "string", searchable: true } },
    });

    // Set up a disk-mode collection with enough records to fill candidateLimit
    const db = new AgentDB(dir, { storageMode: "disk" });
    await db.init();
    const col = await db.collection(schema);
    for (let i = 0; i < 60; i++) {
      await col.insert({ _id: `d${i}`, title: `word alpha beta ${i}` });
    }
    await db.close();

    // Reopen and measure peak concurrency with isLocalFs() → false (simulates S3)
    const db2 = new AgentDB(dir, { storageMode: "disk" });
    await db2.init();
    const col2 = await db2.collection(schema);

    const ds = col2.getDiskStore()!;

    // Spy: make isLocalFs() return false (simulates non-FS backend)
    const isLocalFsSpy = vi.spyOn(ds, "isLocalFs").mockReturnValue(false);

    // Spy on get() to track peak in-flight
    let inFlight = 0;
    let peakInFlight = 0;
    const originalGet = ds.get.bind(ds);
    const getSpy = vi.spyOn(ds, "get").mockImplementation(async (id: string) => {
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      const result = await originalGet(id);
      inFlight--;
      return result;
    });

    // diskConcurrency defaults to 16; corpus of 60 docs → candidateLimit = max(10*4,50) = 50
    await col2.bm25Search("word", { limit: 10 });

    expect(peakInFlight).toBeGreaterThan(0);
    expect(peakInFlight).toBeLessThanOrEqual(16);

    isLocalFsSpy.mockRestore();
    getSpy.mockRestore();
    await db2.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("local FS backend: unbounded — all candidates hydrated in parallel", async () => {
    const dir = await makeTmpDir();
    const schema = defineSchema({
      name: "fsunbounded",
      textSearch: true,
      fields: { title: { type: "string", searchable: true } },
    });

    const db = new AgentDB(dir, { storageMode: "disk" });
    await db.init();
    const col = await db.collection(schema);
    for (let i = 0; i < 20; i++) {
      await col.insert({ _id: `d${i}`, title: `word gamma ${i}` });
    }
    await db.close();

    const db2 = new AgentDB(dir, { storageMode: "disk" });
    await db2.init();
    const col2 = await db2.collection(schema);
    const ds = col2.getDiskStore()!;

    // isLocalFs() should return true for FsBackend (real FS)
    expect(ds.isLocalFs()).toBe(true);

    // Verify search still works correctly (unbounded path)
    const result = await col2.bm25Search("word", { limit: 10 });
    expect(result.records.length).toBeGreaterThan(0);

    await db2.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("diskConcurrency option overrides the default cap", async () => {
    const dir = await makeTmpDir();
    const schema = defineSchema({
      name: "customcap",
      textSearch: true,
      fields: { title: { type: "string", searchable: true } },
      diskConcurrency: 3,
    });

    const db = new AgentDB(dir, { storageMode: "disk" });
    await db.init();
    const col = await db.collection(schema);
    for (let i = 0; i < 60; i++) {
      await col.insert({ _id: `d${i}`, title: `word delta ${i}` });
    }
    await db.close();

    const db2 = new AgentDB(dir, { storageMode: "disk" });
    await db2.init();
    const col2 = await db2.collection(schema);
    const ds = col2.getDiskStore()!;

    const isLocalFsSpy = vi.spyOn(ds, "isLocalFs").mockReturnValue(false);

    let inFlight = 0;
    let peakInFlight = 0;
    const originalGet = ds.get.bind(ds);
    const getSpy = vi.spyOn(ds, "get").mockImplementation(async (id: string) => {
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      const result = await originalGet(id);
      inFlight--;
      return result;
    });

    await col2.bm25Search("word", { limit: 10 });

    expect(peakInFlight).toBeGreaterThan(0);
    expect(peakInFlight).toBeLessThanOrEqual(3);

    isLocalFsSpy.mockRestore();
    getSpy.mockRestore();
    await db2.close();
    await rm(dir, { recursive: true, force: true });
  });
});

describe("hybridSearch — arm failure modes", () => {
  it("BM25 arm throws (IndexFileTooLargeError): hybrid returns semantic results only", async () => {
    const REAL_LIMIT = DiskStore.MAX_INDEX_FILE_SIZE;
    const dir = await makeTmpDir();

    // Disk-mode schema with text search so we get a real text-index.json on disk
    const schema = defineSchema({
      name: "armthrow",
      textSearch: true,
      storageMode: "disk",
      fields: { title: { type: "string", searchable: true } },
    });

    const vectors = new Map<string, number[]>([
      ["typescript generics", [1, 0, 0, 0]],
      ["typescript guide", [0.9, 0.1, 0, 0]],
    ]);
    const provider = new FakeEmbeddingProvider(vectors);

    // Session 1: insert + embed → compacts text-index.json to disk
    {
      const db = new AgentDB(dir, { embeddings: { provider } });
      await db.init();
      const col = await db.collection(schema);
      await col.insert({ _id: "d1", title: "typescript guide" });
      await col.embedUnembedded();
      await db.close();
    }

    // Lower the size cap so the on-disk text-index.json now exceeds the limit
    DiskStore.MAX_INDEX_FILE_SIZE = 1;
    let db2: AgentDB | null = null;
    try {
      // Session 2: reopen — BM25 arm will throw IndexFileTooLargeError on ensureIndexesLoaded
      db2 = new AgentDB(dir, { embeddings: { provider } });
      await db2.init();
      const col = await db2.collection(schema);

      // hybridSearch must not reject; semantic arm degrades gracefully
      const result = await col.hybridSearch("typescript generics", { limit: 5 });
      expect(Array.isArray(result.records)).toBe(true);
      expect(Array.isArray(result.scores)).toBe(true);
      // Semantic arm provides results even though BM25 arm threw
      expect(result.records.length).toBeGreaterThan(0);
    } finally {
      // Restore limit before close so compaction can write the index cleanly
      DiskStore.MAX_INDEX_FILE_SIZE = REAL_LIMIT;
      if (db2) await db2.close().catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("both arms throw: hybrid returns {records:[], scores:[]}", async () => {
    const REAL_LIMIT = DiskStore.MAX_INDEX_FILE_SIZE;
    const dir = await makeTmpDir();

    const schema = defineSchema({
      name: "boththrow",
      textSearch: true,
      storageMode: "disk",
      fields: { title: { type: "string", searchable: true } },
    });

    const throwingProvider: EmbeddingProvider = {
      dimensions: 4,
      embed: async (): Promise<number[][]> => { throw new Error("provider offline"); },
    };

    // Session 1: insert → compacts text-index.json to disk (no embedding)
    {
      const db = new AgentDB(dir, { embeddings: { provider: throwingProvider } });
      await db.init();
      const col = await db.collection(schema);
      await col.insert({ _id: "d1", title: "typescript guide" });
      await db.close();
    }

    // Lower size cap so BM25 arm throws; provider always throws too
    DiskStore.MAX_INDEX_FILE_SIZE = 1;
    let db2: AgentDB | null = null;
    try {
      db2 = new AgentDB(dir, { embeddings: { provider: throwingProvider } });
      await db2.init();
      const col = await db2.collection(schema);

      const result = await col.hybridSearch("typescript", { limit: 5 });
      expect(result.records).toEqual([]);
      expect(result.scores).toEqual([]);
    } finally {
      // Restore limit before close so compaction can write the index cleanly
      DiskStore.MAX_INDEX_FILE_SIZE = REAL_LIMIT;
      if (db2) await db2.close().catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("TTL'd record is excluded from materializeCandidates (bm25Search and hybridSearch)", async () => {
    const dir = await makeTmpDir();
    const vectors = new Map<string, number[]>([
      ["typescript", [1, 0, 0, 0]],
      ["typescript guide permanent", [0.9, 0.1, 0, 0]],
      ["typescript expired doc", [0.8, 0.2, 0, 0]],
    ]);
    const provider = new FakeEmbeddingProvider(vectors);
    const db = new AgentDB(dir, { embeddings: { provider } });
    await db.init();

    const schema = defineSchema({
      name: "ttlcheck",
      textSearch: true,
      fields: { title: { type: "string", searchable: true } },
    });
    const col = await db.collection(schema);

    await col.insert({ _id: "permanent", title: "typescript guide permanent" });
    // TTL of 1ms — will be expired by the time we query
    await col.insert({ _id: "expired", title: "typescript expired doc" }, { ttl: 0.001 });
    await col.embedUnembedded();

    // Wait for TTL to elapse
    await new Promise((r) => setTimeout(r, 50));

    const bm25Result = await col.bm25Search("typescript", { limit: 10 });
    expect(bm25Result.records.map((r) => r._id)).not.toContain("expired");
    expect(bm25Result.records.map((r) => r._id)).toContain("permanent");

    const hybridResult = await col.hybridSearch("typescript", { limit: 10 });
    expect(hybridResult.records.map((r) => r._id)).not.toContain("expired");
    expect(hybridResult.records.map((r) => r._id)).toContain("permanent");

    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
});

// Hash-based embedding provider (deterministic, no exact-key lookup)
class HashProvider implements EmbeddingProvider {
  readonly dimensions = 4;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      let h = 0;
      for (let i = 0; i < t.length; i++) h = (Math.imul(31, h) + t.charCodeAt(i)) | 0;
      const vec = [Math.sin(h), Math.cos(h), Math.sin(h + 1), Math.cos(h + 1)];
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
      return vec.map((v) => v / norm);
    });
  }
}

describe("embedUnembedded — disk-mode lazy embedding gap", () => {
  it("embeds records compacted to Parquet before embedding provider was available", async () => {
    const dir = await makeTmpDir();
    const N = 20;
    const schema = defineSchema({ name: "lazyembed", fields: { title: { type: "string" } } });

    // Phase 1: insert without embedding provider → compacted to disk without _embedding
    {
      const db = new AgentDB(dir, { storageMode: "disk" });
      await db.init();
      const col = await db.collection(schema);
      for (let i = 0; i < N; i++) {
        await col.insert({ _id: `d${i}`, title: `topic number ${i}` });
      }
      await db.close();
    }

    // Phase 2: reopen with provider → embedUnembedded must find and embed disk records
    const provider = new HashProvider();
    {
      const db = new AgentDB(dir, { storageMode: "disk", embeddings: { provider } });
      await db.init();
      const col = await db.collection(schema);

      const count = await col.embedUnembedded();
      expect(count).toBe(N);

      await db.close();
    }

    // Phase 3: reopen again → rebuildHnswFromDisk finds all N embeddings on disk
    {
      const db = new AgentDB(dir, { storageMode: "disk", embeddings: { provider } });
      await db.init();
      const col = await db.collection(schema);

      // All N records should now be in the HNSW index → semantic search returns results
      const result = await col.semanticSearch("topic", { limit: 5 });
      expect(result.records.length).toBeGreaterThan(0);
      expect(result.records.length).toBeLessThanOrEqual(5);

      await db.close();
    }

    await rm(dir, { recursive: true, force: true });
  });

  it("embedUnembedded skips already-embedded disk records on second call", async () => {
    const dir = await makeTmpDir();
    const schema = defineSchema({ name: "noredundant", fields: { title: { type: "string" } } });

    // Phase 1: insert without provider
    {
      const db = new AgentDB(dir, { storageMode: "disk" });
      await db.init();
      const col = await db.collection(schema);
      for (let i = 0; i < 10; i++) {
        await col.insert({ _id: `d${i}`, title: `document ${i}` });
      }
      await db.close();
    }

    // Phase 2: reopen with provider, embed
    const provider = new HashProvider();
    {
      const db = new AgentDB(dir, { storageMode: "disk", embeddings: { provider } });
      await db.init();
      const col = await db.collection(schema);
      const count1 = await col.embedUnembedded();
      expect(count1).toBe(10);
      // Second call — all already embedded
      const count2 = await col.embedUnembedded();
      expect(count2).toBe(0);
      await db.close();
    }

    await rm(dir, { recursive: true, force: true });
  });

  it("db_semantic_search returns expected matches end-to-end after disk-mode reopen", async () => {
    const dir = await makeTmpDir();
    const schema = defineSchema({ name: "e2edisk", fields: { title: { type: "string" } } });

    // Insert without provider — titles designed so hash-based vectors have structure
    {
      const db = new AgentDB(dir, { storageMode: "disk" });
      await db.init();
      const col = await db.collection(schema);
      await col.insert({ _id: "match", title: "neural network deep learning" });
      await col.insert({ _id: "other", title: "cooking recipe pasta" });
      await db.close();
    }

    const provider = new HashProvider();
    {
      const db = new AgentDB(dir, { storageMode: "disk", embeddings: { provider } });
      await db.init();
      const col = await db.collection(schema);
      await col.embedUnembedded();
      await db.close();
    }

    // Reopen — semantic search should find something (HNSW rebuilt from disk embeddings)
    {
      const db = new AgentDB(dir, { storageMode: "disk", embeddings: { provider } });
      await db.init();
      const col = await db.collection(schema);
      const result = await col.semanticSearch("neural network", { limit: 2 });
      expect(result.records.length).toBeGreaterThan(0);
      const ids = result.records.map((r) => r._id as string);
      expect(ids).toContain("match");
      await db.close();
    }

    await rm(dir, { recursive: true, force: true });
  });
});
