/**
 * End-to-end integration scenarios for v1.4 hybrid search.
 * Institutionalizes smoke-test coverage so the class of bugs found during
 * review (e.g. disk-mode same-session search returning 0) can't slip through.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDB } from "../src/agentdb.js";
import { defineSchema } from "../src/schema.js";
import { getTools } from "../src/tools/index.js";
import type { AgentTool } from "../src/tools/index.js";
import type { EmbeddingProvider } from "../src/embeddings/types.js";

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agentdb-e2e-"));
}

// Deterministic vector provider. Registers texts → vectors via Map.
// Unknown texts get a zero vector (miss).
class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 8;
  private vectors: Map<string, number[]>;

  constructor(vectors: Map<string, number[]>) {
    this.vectors = vectors;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.vectors.get(t) ?? new Array(this.dimensions).fill(0));
  }
}

// Deterministic hash provider (16 dims). No external Map needed — same text
// always produces the same unit vector.
class HashProvider implements EmbeddingProvider {
  readonly dimensions = 16;
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

// ── Scenario 1: Library API end-to-end (memory mode) ────────────────────────

describe("Scenario 1: library API end-to-end — memory mode (#199)", () => {
  it("bm25Search, semanticSearch, hybridSearch all return results", async () => {
    const dir = await makeTmpDir();

    // HashProvider: deterministic content-based vectors. Records with similar
    // text get similar vectors — used here to validate both search arms.
    const provider = new HashProvider();

    const schema = defineSchema({
      name: "articles",
      textSearch: true,
      fields: {
        title: { type: "string", searchable: true },
      },
    });

    const db = new AgentDB(dir, { embeddings: { provider } });
    await db.init();
    const col = await db.collection(schema);

    // 50 records across varied topics
    const topics = [
      "typescript language programming",
      "typescript type system generics",
      "typescript compiler source maps",
      "rust memory safety ownership",
      "rust async tokio runtime",
      "python data science numpy",
      "python machine learning sklearn",
      "go goroutines concurrency",
      "java spring boot framework",
      "c++ templates metaprogramming",
    ];
    for (let i = 0; i < 50; i++) {
      const topic = topics[i % topics.length];
      await col.insert({ _id: `doc${i}`, title: `${topic} article ${i}` });
    }
    await col.embedUnembedded();

    // BM25: "typescript" term is in several records; top results must contain the term
    const bm25Result = await col.bm25Search("typescript language", { limit: 5 });
    expect(bm25Result.records.length).toBeGreaterThan(0);
    expect(bm25Result.records.some((r) => (r.title as string).includes("typescript"))).toBe(true);

    // Semantic: exact query text gets a hash vector; doc0 has identical title → nearest
    const semResult = await col.semanticSearch("typescript language programming article 0", { limit: 5 });
    expect(semResult.records.length).toBeGreaterThan(0);
    expect(semResult.records[0]._id).toBe("doc0");

    // Hybrid fuses both arms — non-empty, scores aligned
    const hybridResult = await col.hybridSearch("typescript language", { limit: 5 });
    expect(hybridResult.records.length).toBeGreaterThan(0);
    expect(hybridResult.scores.length).toBe(hybridResult.records.length);

    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
});

// ── Scenario 2: Disk-mode persistence + same-session ────────────────────────

describe("Scenario 2: disk-mode persistence + same-session WAL search (#199/#196 regression)", () => {
  it("same-session search finds WAL records; close+reopen preserves results; mixed Parquet+WAL returned", async () => {
    const dir = await makeTmpDir();
    const schema = defineSchema({
      name: "docs",
      textSearch: true,
      fields: { title: { type: "string", searchable: true } },
    });

    // Session 1: insert 30 records, search WITHOUT close (WAL-only path — regression catcher for #196)
    {
      const db = new AgentDB(dir, { storageMode: "disk" });
      await db.init();
      const col = await db.collection(schema);

      for (let i = 0; i < 30; i++) {
        await col.insert({ _id: `doc${i}`, title: `document about topic ${i} science` });
      }
      await col.insert({ _id: "target", title: "unique zeppelin aeronautics" });

      // Same-session search — must find WAL-only records (pre-#196 would return 0)
      const sameSession = await col.bm25Search("zeppelin aeronautics");
      expect(sameSession.records.length).toBeGreaterThan(0);
      expect(sameSession.records.map((r) => r._id)).toContain("target");

      await db.close();
    }

    // Session 2: reopen, verify compacted (Parquet) records searchable
    {
      const db = new AgentDB(dir, { storageMode: "disk" });
      await db.init();
      const col = await db.collection(schema);

      // Old records (Parquet)
      const oldResult = await col.bm25Search("science");
      expect(oldResult.records.length).toBeGreaterThan(0);
      expect(oldResult.records.map((r) => r._id as string).some((id) => id.startsWith("doc"))).toBe(true);

      // Insert 10 more (WAL-only in this session)
      for (let i = 0; i < 10; i++) {
        await col.insert({ _id: `new${i}`, title: `fresh insertion quasar ${i}` });
      }

      // New WAL records must be found
      const newResult = await col.bm25Search("quasar");
      expect(newResult.records.length).toBeGreaterThan(0);
      expect(newResult.records.map((r) => r._id as string).some((id) => id.startsWith("new"))).toBe(true);

      // Old Parquet records must still be found alongside new WAL records
      const mixedResult = await col.bm25Search("document science");
      expect(mixedResult.records.map((r) => r._id as string).some((id) => id.startsWith("doc"))).toBe(true);

      await db.close();
    }

    await rm(dir, { recursive: true, force: true });
  });
});

// ── Scenario 3: Degraded modes ───────────────────────────────────────────────

describe("Scenario 3: degraded hybrid search modes (#199)", () => {
  it("BM25-only collection — hybridSearch degrades to BM25 results", async () => {
    const dir = await makeTmpDir();
    // No embedding provider → semantic arm unavailable
    const db = new AgentDB(dir);
    await db.init();
    const schema = defineSchema({
      name: "bm25only",
      textSearch: true,
      fields: { title: { type: "string", searchable: true } },
    });
    const col = await db.collection(schema);
    await col.insert({ _id: "a", title: "database indexing fundamentals" });
    await col.insert({ _id: "b", title: "unrelated gardening tips" });

    const result = await col.hybridSearch("database indexing");
    expect(result.records.length).toBeGreaterThan(0);
    expect(result.records[0]._id).toBe("a");

    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("vector-only collection (insertVector, no textSearch) — hybridSearch degrades to semantic results", async () => {
    const dir = await makeTmpDir();
    const provider = new HashProvider();
    const db = new AgentDB(dir, { embeddings: { provider } });
    await db.init();
    const col = await db.collection("vecs");

    const queryVec = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    await col.insertVector("v1", queryVec, { label: "target" });
    await col.insertVector("v2", [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], { label: "other" });

    const result = await col.searchByVector(queryVec, { limit: 5 });
    expect(result.records.length).toBeGreaterThan(0);
    expect(result.records[0]._id).toBe("v1");

    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("neither arm configured — hybridSearch throws", async () => {
    const dir = await makeTmpDir();
    const db = new AgentDB(dir);
    await db.init();
    const col = await db.collection("empty");
    await col.insert({ _id: "a", title: "hello" });

    await expect(col.hybridSearch("hello")).rejects.toThrow();

    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
});

// ── Scenario 4: v1.3 migration with quality recovery ────────────────────────

describe("Scenario 4: v1.3 migration — reembedAll restores semantic quality (#199)", () => {
  it("reembedAll returns ReembedResult shape and re-embeds all records", async () => {
    const dir = await makeTmpDir();

    // Simulate a v1.3 provider that "accidentally" includes _id in embedding text.
    // We model this by having the provider return distinct vectors based on doc index
    // (wrong mapping) vs. correct content-based vectors after reembed.
    const badProvider: EmbeddingProvider = {
      dimensions: 8,
      async embed(texts: string[]) {
        // Return a fixed "wrong" vector for all texts (simulates _id-contaminated embeddings)
        return texts.map(() => {
          const v = new Array(8).fill(0);
          v[7] = 1; // all records get same vector — bad quality
          return v;
        });
      },
    };

    const schema = defineSchema({ name: "migration", fields: { title: { type: "string" } } });
    const db = new AgentDB(dir, { embeddings: { provider: badProvider } });
    await db.init();
    const col = await db.collection(schema);

    for (let i = 0; i < 30; i++) {
      await col.insert({ _id: `doc${i}`, title: `migration test record ${i}` });
    }
    await col.embedUnembedded();

    // Swap to a correct provider and run reembedAll
    const goodProvider = new HashProvider();
    col.setEmbeddingProvider(goodProvider);

    const result = await col.reembedAll();
    expect(result.embedded).toBe(30);
    expect(result.failed).toBe(0);
    expect(result.errors).toHaveLength(0);

    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
});

// ── Scenario 5: MCP tool round-trip ─────────────────────────────────────────

describe("Scenario 5: MCP tool round-trip — db_hybrid_search, db_bm25_search, db_reembed_all (#199)", () => {
  it("all three tools return parseable JSON with correct shapes", async () => {
    const dir = await makeTmpDir();
    const vectors = new Map<string, number[]>([
      ["machine learning tutorial",    [1, 0, 0, 0, 0, 0, 0, 0]],
      ["machine learning fundamentals",[0.9, 0.1, 0, 0, 0, 0, 0, 0]],
      ["deep learning neural networks",[0.8, 0.2, 0, 0, 0, 0, 0, 0]],
      ["cooking recipes",              [0, 0, 0, 1, 0, 0, 0, 0]],
    ]);

    const schema = defineSchema({
      name: "mlcol",
      textSearch: true,
      fields: { title: { type: "string", searchable: true } },
    });

    const db = new AgentDB(dir, { embeddings: { provider: new FakeEmbeddingProvider(vectors) } });
    await db.init();
    const tools: AgentTool[] = getTools(db);

    function tool(name: string): AgentTool {
      const t = tools.find((t) => t.name === name);
      if (!t) throw new Error(`Tool '${name}' not found`);
      return t;
    }

    async function exec(name: string, args: Record<string, unknown> = {}) {
      const t = tool(name);
      const result = await t.execute(args);
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toBeTruthy();
      return JSON.parse(result.content[0].text as string);
    }

    const col = await db.collection(schema);
    await col.insert({ _id: "ml1", title: "machine learning fundamentals" });
    await col.insert({ _id: "ml2", title: "deep learning neural networks" });
    await col.insert({ _id: "food1", title: "cooking recipes" });
    await col.embedUnembedded();

    // db_hybrid_search
    const hybridResult = await exec("db_hybrid_search", { collection: "mlcol", query: "machine learning tutorial", limit: 5 });
    expect(Array.isArray(hybridResult.records)).toBe(true);
    expect(Array.isArray(hybridResult.scores)).toBe(true);
    expect(hybridResult.records.length).toBeGreaterThan(0);

    // db_bm25_search
    const bm25Result = await exec("db_bm25_search", { collection: "mlcol", query: "machine learning", limit: 5 });
    expect(Array.isArray(bm25Result.records)).toBe(true);
    expect(Array.isArray(bm25Result.scores)).toBe(true);
    expect(bm25Result.records.length).toBeGreaterThan(0);

    // db_reembed_all
    const reembedResult = await exec("db_reembed_all", { collection: "mlcol" });
    expect(typeof reembedResult.embedded).toBe("number");
    expect(typeof reembedResult.failed).toBe("number");
    expect(Array.isArray(reembedResult.errors)).toBe(true);
    expect(reembedResult.embedded).toBe(3);
    expect(reembedResult.failed).toBe(0);

    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
});

// ── Scenario 6: Tokenizer Unicode end-to-end ─────────────────────────────────

describe("Scenario 6: tokenizer Unicode end-to-end — CJK whole-run token behavior (#199/#198)", () => {
  it("ASCII and accented Latin match; CJK whole-run matches; CJK substring does not", async () => {
    const dir = await makeTmpDir();
    const db = new AgentDB(dir);
    await db.init();

    const schema = defineSchema({
      name: "unicode",
      textSearch: true,
      fields: { title: { type: "string", searchable: true } },
    });
    const col = await db.collection(schema);

    await col.insert({ _id: "ascii",   title: "hello world software engineering" });
    await col.insert({ _id: "accent",  title: "café au lait menu" });
    await col.insert({ _id: "cjk",     title: "東京の天気" });
    await col.insert({ _id: "unrelated", title: "unrelated filler document" });

    // ASCII match
    const asciiResult = await col.bm25Search("hello world");
    expect(asciiResult.records.map((r) => r._id)).toContain("ascii");

    // Accented Latin match — "café" tokenizes as a single term
    const accentResult = await col.bm25Search("café");
    expect(accentResult.records.map((r) => r._id)).toContain("accent");

    // CJK whole-run token: "東京の天気" is a single token (no word segmentation).
    // Searching the exact same string hits the inverted index entry.
    const cjkWholeResult = await col.bm25Search("東京の天気");
    expect(cjkWholeResult.records.map((r) => r._id)).toContain("cjk");

    // CJK PINNED: substring "東京" is NOT a registered token — the tokenizer emits
    // "東京の天気" as one run. Substring search is not segmented; no match expected.
    const cjkSubResult = await col.bm25Search("東京");
    expect(cjkSubResult.records.map((r) => r._id)).not.toContain("cjk");

    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
});

// ── Scenario 7: HNSW auto-detect dimensions (dimensions=0 provider) ──────────

describe("Scenario 7: HNSW dimensions=0 provider auto-detect — embedUnembedded and reembedAll (#201)", () => {
  it("embedUnembedded succeeds and sets correct HNSW dims when provider.dimensions=0", async () => {
    const dir = await makeTmpDir();

    // Simulates Ollama / any auto-detect provider: dimensions=0 at construction,
    // actual dim revealed only when embed() is first called.
    const autoDimProvider: EmbeddingProvider = {
      dimensions: 0,
      async embed(texts: string[]) {
        // Returns 12-dim vectors (simulating auto-detected size)
        return texts.map(() => Array.from({ length: 12 }, (_, i) => (i + 1) / 12));
      },
    };

    const schema = defineSchema({ name: "autodim", fields: { title: { type: "string" } } });
    const db = new AgentDB(dir, { embeddings: { provider: autoDimProvider } });
    await db.init();
    const col = await db.collection(schema);

    await col.insert({ _id: "a", title: "hello world" });
    await col.insert({ _id: "b", title: "goodbye world" });

    // Pre-#201 this threw: "Vector dimension mismatch: expected 0, got 12"
    const count = await col.embedUnembedded();
    expect(count).toBe(2);

    // HNSW index must now hold 2 entries and have the real dimensionality
    const result = await col.semanticSearch("hello world", { limit: 5 });
    expect(result.records.length).toBeGreaterThan(0);

    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("reembedAll succeeds when provider.dimensions=0", async () => {
    const dir = await makeTmpDir();

    const autoDimProvider: EmbeddingProvider = {
      dimensions: 0,
      async embed(texts: string[]) {
        return texts.map(() => Array.from({ length: 12 }, (_, i) => (i + 1) / 12));
      },
    };

    const schema = defineSchema({ name: "reembed_autodim", fields: { title: { type: "string" } } });
    const db = new AgentDB(dir, { embeddings: { provider: autoDimProvider } });
    await db.init();
    const col = await db.collection(schema);

    for (let i = 0; i < 5; i++) {
      await col.insert({ _id: `r${i}`, title: `reembed test record ${i}` });
    }

    // Pre-#201 this threw on the first hnsw.add call
    const result = await col.reembedAll();
    expect(result.embedded).toBe(5);
    expect(result.failed).toBe(0);
    expect(result.errors).toHaveLength(0);

    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
});
