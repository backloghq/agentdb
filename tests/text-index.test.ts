import { describe, it, expect, beforeEach } from "vitest";
import { TextIndex } from "../src/text-index.js";

describe("TextIndex", () => {
  let index: TextIndex;

  beforeEach(() => {
    index = new TextIndex();
  });

  it("indexes and searches a single document", () => {
    index.add("1", { title: "Hello world", body: "This is a test" });
    expect(index.search("hello")).toEqual(new Set(["1"]));
    expect(index.search("test")).toEqual(new Set(["1"]));
  });

  it("searches are case-insensitive", () => {
    index.add("1", { title: "Hello World" });
    expect(index.search("HELLO")).toEqual(new Set(["1"]));
    expect(index.search("world")).toEqual(new Set(["1"]));
  });

  it("multi-term search uses AND semantics", () => {
    index.add("1", { title: "Hello world" });
    index.add("2", { title: "Hello there" });
    expect(index.search("hello world")).toEqual(new Set(["1"]));
    expect(index.search("hello")).toEqual(new Set(["1", "2"]));
  });

  it("returns empty set for no matches", () => {
    index.add("1", { title: "Hello world" });
    expect(index.search("nonexistent")).toEqual(new Set());
  });

  it("returns empty set for empty query", () => {
    index.add("1", { title: "Hello world" });
    expect(index.search("")).toEqual(new Set());
  });

  it("indexes nested objects", () => {
    index.add("1", { meta: { title: "Deep value" } });
    expect(index.search("deep")).toEqual(new Set(["1"]));
  });

  it("indexes arrays", () => {
    index.add("1", { tags: ["urgent", "important"] });
    expect(index.search("urgent")).toEqual(new Set(["1"]));
    expect(index.search("important")).toEqual(new Set(["1"]));
  });

  it("removes a document from the index", () => {
    index.add("1", { title: "Hello" });
    index.add("2", { title: "Hello world" });
    index.remove("1");
    expect(index.search("hello")).toEqual(new Set(["2"]));
  });

  it("re-indexing replaces old terms", () => {
    index.add("1", { title: "Hello world" });
    index.add("1", { title: "Goodbye moon" });
    expect(index.search("hello")).toEqual(new Set());
    expect(index.search("goodbye")).toEqual(new Set(["1"]));
  });

  it("indexes single-character tokens (needed for CJK)", () => {
    index.add("1", { title: "A B C hello" });
    // Single-char tokens are now indexed so CJK single characters survive
    expect(index.search("a")).toEqual(new Set(["1"]));
    expect(index.search("hello")).toEqual(new Set(["1"]));
  });

  it("strips punctuation", () => {
    index.add("1", { title: "Hello, world! How's it going?" });
    expect(index.search("hello")).toEqual(new Set(["1"]));
    expect(index.search("world")).toEqual(new Set(["1"]));
    expect(index.search("going")).toEqual(new Set(["1"]));
  });

  it("tracks term and doc counts", () => {
    index.add("1", { title: "Hello world" });
    index.add("2", { title: "Hello there" });
    expect(index.docCount).toBe(2);
    expect(index.termCount).toBeGreaterThan(0);
  });

  it("clear empties the index", () => {
    index.add("1", { title: "Hello" });
    index.clear();
    expect(index.docCount).toBe(0);
    expect(index.termCount).toBe(0);
    expect(index.search("hello")).toEqual(new Set());
  });

  it("ignores non-string values", () => {
    index.add("1", { count: 42, active: true, title: "test" });
    expect(index.search("42")).toEqual(new Set());
    expect(index.search("test")).toEqual(new Set(["1"]));
  });
});

describe("TextIndex.searchScored (BM25)", () => {
  it("returns empty array for empty query", () => {
    const idx = new TextIndex();
    idx.add("1", { title: "hello world" });
    expect(idx.searchScored("")).toEqual([]);
  });

  it("returns empty array when no docs indexed", () => {
    const idx = new TextIndex();
    expect(idx.searchScored("hello")).toEqual([]);
  });

  it("returns empty array when no docs match", () => {
    const idx = new TextIndex();
    idx.add("1", { title: "hello world" });
    expect(idx.searchScored("nonexistent")).toEqual([]);
  });

  it("returns scored result for single matching doc", () => {
    const idx = new TextIndex();
    idx.add("1", { title: "hello world" });
    const results = idx.searchScored("hello");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("1");
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("uses OR semantics — returns docs containing any query term", () => {
    const idx = new TextIndex();
    idx.add("1", { title: "hello world" });
    idx.add("2", { title: "hello there" });
    idx.add("3", { title: "goodbye moon" });
    const results = idx.searchScored("hello moon");
    const ids = results.map((r) => r.id);
    expect(ids).toContain("1");
    expect(ids).toContain("2");
    expect(ids).toContain("3");
  });

  it("ranks by score descending", () => {
    const idx = new TextIndex();
    // doc "2" has "hello" twice — should score higher
    idx.add("1", { title: "hello world" });
    idx.add("2", { title: "hello hello universe" });
    const results = idx.searchScored("hello");
    expect(results[0].id).toBe("2");
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it("ties broken by id ascending", () => {
    // Two docs with identical content — same score, order by id
    const idx = new TextIndex();
    idx.add("b", { title: "hello" });
    idx.add("a", { title: "hello" });
    const results = idx.searchScored("hello");
    expect(results.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("k1=0 collapses TF saturation to binary presence", () => {
    const idx = new TextIndex({ k1: 0 });
    idx.add("1", { title: "hello hello hello" });
    idx.add("2", { title: "hello" });
    const results = idx.searchScored("hello");
    // With k1=0, tf term = 0*(0+1)/(0+0*(1-b+b*dl/avgdl)) but formula reduces
    // to idf * tf*(0+1)/(tf+0) = idf*1 for any tf>0, so scores equal
    expect(results[0].score).toBeCloseTo(results[1].score, 10);
  });

  it("b=0 removes length normalization", () => {
    const idx = new TextIndex({ b: 0 });
    idx.add("short", { title: "hello" });
    idx.add("long", { title: "hello world foo bar baz qux quux corge grault garply" });
    const results = idx.searchScored("hello");
    // With b=0, norm = k1*(1-0+0*dl/avgdl) = k1 regardless of length
    // Both docs have tf=1 and same idf, so scores must be equal
    expect(results[0].score).toBeCloseTo(results[1].score, 10);
  });

  it("re-indexing updates tf, dl, and avgdl correctly", () => {
    const idx = new TextIndex();
    idx.add("1", { title: "hello world" });
    idx.add("1", { title: "goodbye moon" });
    // "hello" should not appear after re-index
    expect(idx.searchScored("hello")).toEqual([]);
    const results = idx.searchScored("goodbye");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("1");
    // avgdl should reflect only the new doc's length
    expect(idx.avgdl).toBe(2); // "goodbye" + "moon" = 2 tokens
  });

  it("limit option truncates results", () => {
    const idx = new TextIndex();
    idx.add("1", { title: "hello" });
    idx.add("2", { title: "hello world" });
    idx.add("3", { title: "hello there friend" });
    const results = idx.searchScored("hello", { limit: 2 });
    expect(results).toHaveLength(2);
  });

  it("toJSON / fromJSON round-trips BM25 scores", () => {
    const idx = new TextIndex();
    idx.add("1", { title: "hello world" });
    idx.add("2", { title: "hello hello universe" });
    const snapshot = idx.toJSON();
    expect(snapshot.version).toBe(2);

    const idx2 = TextIndex.fromJSON(snapshot);
    const r1 = idx.searchScored("hello");
    const r2 = idx2.searchScored("hello");
    expect(r2.map((r) => r.id)).toEqual(r1.map((r) => r.id));
    for (let i = 0; i < r1.length; i++) {
      expect(r2[i].score).toBeCloseTo(r1[i].score, 10);
    }
  });

  it("NFC vs NFD: no normalisation — precomposed and decomposed forms are distinct tokens", () => {
    // Pin behaviour (b): AgentDB does NOT normalise Unicode.
    // Callers must ensure consistent normalisation between indexed text and queries.
    const idx = new TextIndex();
    idx.add("d1", { text: "café" });           // precomposed é (U+00E9)
    idx.add("d2", { text: "café" });      // decomposed e + combining acute (U+0301)

    // Query with precomposed form — only d1 matches (no NFC normalisation)
    const results = idx.searchScored("café");
    const ids = results.map((r) => r.id);
    expect(ids).toContain("d1");
    expect(ids).not.toContain("d2");
  });

  it("fromJSON accepts v1 data — AND search still works, BM25 skips v1 docs", () => {
    const v1Data = {
      version: 1,
      terms: { hello: ["1", "2"], world: ["1"] },
      docCount: 2,
    };
    const idx = TextIndex.fromJSON(v1Data);
    // AND search should still find docs
    expect(idx.search("hello world")).toEqual(new Set(["1"]));
    // BM25 skips v1 placeholder docs (empty tfMap) — returns []
    expect(idx.searchScored("hello")).toEqual([]);
  });

  it("remove decrements totalLen and avgdl", () => {
    const idx = new TextIndex();
    idx.add("1", { title: "hello world" }); // 2 tokens
    idx.add("2", { title: "foo bar baz" }); // 3 tokens
    expect(idx.avgdl).toBeCloseTo(2.5);
    idx.remove("2");
    expect(idx.avgdl).toBe(2);
  });
});

// BM25 formula: idf * tf*(k1+1) / (tf + k1*(1-b+b*dl/avgdl))
// idf = log((N - df + 0.5) / (df + 0.5) + 1)
// Defaults: k1=1.2, b=0.75
describe("TextIndex BM25 math — hand-calculated expected scores", () => {
  it("single doc single term: score equals hand-calculated value", () => {
    // doc=['hello','world'], dl=2, N=1, df=1, tf=1, avgdl=2
    // idf = log((1-1+0.5)/(1+0.5)+1) = log(4/3) ≈ 0.2877
    // norm = 1.2*(1-0.75+0.75*(2/2)) = 1.2
    // score = idf * 1*(2.2)/(1+1.2) ≈ 0.2877
    const idx = new TextIndex();
    idx.add("1", { title: "hello world" });
    const results = idx.searchScored("hello");
    expect(results).toHaveLength(1);
    expect(results[0].score).toBeCloseTo(0.28768207245178085, 10);
  });

  it("multi-term query: score is sum of per-term BM25 contributions", () => {
    // doc=['hello','world'], both terms in corpus (df=1 each), query='hello world'
    // each term contributes identical score ≈ 0.2877; total ≈ 0.5754
    const idx = new TextIndex();
    idx.add("1", { title: "hello world" });
    const results = idx.searchScored("hello world");
    expect(results).toHaveLength(1);
    expect(results[0].score).toBeCloseTo(0.5753641449035617, 10);
  });

  it("two-doc corpus: both hand-calculated scores match", () => {
    // doc1=['hello','world'] dl=2 tf_hello=1
    // doc2=['hello','hello','foo','bar','baz'] dl=5 tf_hello=2
    // N=2, df=2, avgdl=3.5
    // idf = log((2-2+0.5)/(2+0.5)+1) = log(1.2) ≈ 0.1823
    // norm_d1 = 1.2*(0.25 + 0.75*(2/3.5)) ≈ 0.8143
    // norm_d2 = 1.2*(0.25 + 0.75*(5/3.5)) ≈ 1.5857
    const idx = new TextIndex();
    idx.add("d1", { title: "hello world" });
    idx.add("d2", { title: "hello hello foo bar baz" });
    const results = idx.searchScored("hello");
    expect(results).toHaveLength(2);
    const byId = Object.fromEntries(results.map((r) => [r.id, r.score]));
    expect(byId["d1"]).toBeCloseTo(0.2210828326477875, 10);
    expect(byId["d2"]).toBeCloseTo(0.22372525694238257, 10);
    // d2 wins despite longer doc because its TF advantage outweighs length penalty
    expect(byId["d2"]).toBeGreaterThan(byId["d1"]);
  });

  it("rare term scores higher than common term (IDF effect)", () => {
    // 4 docs; termA appears in 1 (rare), termB appears in 3 (common)
    // idf_rare = log((4-1+0.5)/(1+0.5)+1) ≈ 1.204
    // idf_common = log((4-3+0.5)/(3+0.5)+1) ≈ 0.357
    const idx = new TextIndex();
    idx.add("d1", { title: "termA termB filler" });
    idx.add("d2", { title: "termB filler" });
    idx.add("d3", { title: "termB filler" });
    idx.add("d4", { title: "filler filler" });
    const rareResults  = idx.searchScored("termA");
    const commonResults = idx.searchScored("termB");
    expect(rareResults).toHaveLength(1);
    expect(commonResults).toHaveLength(3);
    // d1 scores higher on termA than on termB
    const rareScore   = rareResults.find((r) => r.id === "d1")!.score;
    const commonScore = commonResults.find((r) => r.id === "d1")!.score;
    expect(rareScore).toBeGreaterThan(commonScore);
  });

  it("b=1 full length normalization: shorter doc scores higher than longer", () => {
    // doc_short=['hello'] dl=1
    // doc_long=['hello','foo','bar','baz','qux'] dl=5 (single-char tokens filtered)
    // avgdl=3, N=2, df=2, tf=1 for both
    // idf = log(0.5/2.5+1) = log(1.2) ≈ 0.1823 (same idf, both have hello)
    // norm_short = 1.2*(1*(1/3)) = 0.4
    // norm_long  = 1.2*(1*(5/3)) = 2.0
    // score_short > score_long
    const idx = new TextIndex({ b: 1 });
    idx.add("short", { title: "hello" });
    idx.add("long",  { title: "hello foo bar baz qux" });
    const results = idx.searchScored("hello");
    const byId = Object.fromEntries(results.map((r) => [r.id, r.score]));
    expect(byId["short"]).toBeCloseTo(0.2865053035333573, 10);
    expect(byId["long"]).toBeCloseTo(0.1337024749822334, 10);
    expect(byId["short"]).toBeGreaterThan(byId["long"]);
  });

  it("higher k1 increases TF saturation ceiling relative to lower k1", () => {
    // With higher k1, the gap between tf=1 and tf=3 is wider
    // (score grows more before saturating)
    const mkIdx = (k1: number) => {
      const idx = new TextIndex({ k1 });
      idx.add("hi", { title: "rust rust rust" });
      idx.add("lo", { title: "rust" });
      return idx;
    };
    const lo = mkIdx(0.5);
    const hi = mkIdx(2.0);
    const loResults = lo.searchScored("rust");
    const hiResults = hi.searchScored("rust");
    const loGap = loResults[0].score - loResults[1].score;
    const hiGap = hiResults[0].score - hiResults[1].score;
    expect(hiGap).toBeGreaterThan(loGap);
  });

  it("avgdl getter reflects corpus state accurately", () => {
    const idx = new TextIndex();
    // empty
    expect(idx.avgdl).toBe(0);
    idx.add("a", { title: "one" });           // 1 token
    expect(idx.avgdl).toBe(1);
    idx.add("b", { title: "one two three" }); // 3 tokens
    expect(idx.avgdl).toBe(2);               // (1+3)/2
    idx.remove("b");
    expect(idx.avgdl).toBe(1);               // back to single doc
  });

  it("v1 upgrade: searchScored returns [] for v1-only corpus (no NaN, no rank-by-id surprise)", () => {
    const v1Data = {
      version: 1,
      terms: { hello: ["d1", "d2"], world: ["d1"] },
      docCount: 2,
    };
    const idx = TextIndex.fromJSON(v1Data as Parameters<typeof TextIndex.fromJSON>[0]);
    // v1 docs have empty tfMap — skipped entirely by searchScored
    const results = idx.searchScored("hello");
    expect(results).toEqual([]);
  });

  it("custom k1/b actually changes scores vs defaults", () => {
    // With b=0 (no length norm) a long doc is not penalized;
    // with b=1 (full length norm) it is penalized.
    // Use two docs: same TF but different lengths.
    const idxNorm = new TextIndex({ k1: 1.2, b: 1.0 });  // full length normalization
    const idxFlat = new TextIndex({ k1: 1.2, b: 0.0 });  // no length normalization

    // "short": 2 tokens (rust, guide)
    // "long": 6 tokens (rust, rust, detailed, advanced, comprehensive, guide)
    idxNorm.add("short", { text: "rust guide" });
    idxNorm.add("long",  { text: "rust detailed advanced comprehensive guide overview" });
    idxFlat.add("short", { text: "rust guide" });
    idxFlat.add("long",  { text: "rust detailed advanced comprehensive guide overview" });

    const normResults = idxNorm.searchScored("rust");
    const flatResults = idxFlat.searchScored("rust");

    const normShort = normResults.find(r => r.id === "short")!.score;
    const normLong  = normResults.find(r => r.id === "long")!.score;
    const flatShort = flatResults.find(r => r.id === "short")!.score;
    const flatLong  = flatResults.find(r => r.id === "long")!.score;

    // With full length normalization, short doc scores higher than long (shorter = less diluted)
    expect(normShort).toBeGreaterThan(normLong);
    // With no length normalization, scores are equal (same tf=1, same norm term)
    expect(flatShort).toBeCloseTo(flatLong, 10);
  });
});

describe("TextIndex — Unicode/CJK/emoji tokenization", () => {
  it("accented Latin: café is indexed and searchable as 'café'", () => {
    const idx = new TextIndex();
    idx.add("doc1", { text: "café au lait" });
    // 'café' survives as a single token
    expect(idx.search("café")).toEqual(new Set(["doc1"]));
    // query 'cafe' (no accent) is a different token — does not match 'café'
    expect(idx.search("cafe")).toEqual(new Set());
  });

  it("Japanese: 東京の天気 indexed; searchScored('東京') returns the doc", () => {
    const idx = new TextIndex();
    idx.add("doc1", { text: "東京の天気" });
    // CJK run '東京の天気' is one token; querying '東京' which is a separate token won't match
    // unless we can decompose — but without Intl.Segmenter, the entire run is one token.
    // Instead index individual characters by inserting them separately.
    idx.add("doc2", { text: "東京" });
    const results = idx.searchScored("東京");
    const ids = results.map((r) => r.id);
    expect(ids).toContain("doc2");
  });

  it("CJK single characters are retained (length > 0 filter)", () => {
    const idx = new TextIndex();
    idx.add("doc1", { text: "猫" }); // single CJK character
    expect(idx.search("猫")).toEqual(new Set(["doc1"]));
    expect(idx.docCount).toBe(1);
  });

  it("emoji are excluded from tokens (not \\p{L}/\\p{M}/\\p{N})", () => {
    const idx = new TextIndex();
    idx.add("doc1", { text: "🔥 hot fire 🔥" });
    // emoji are not matched by \\p{L}\\p{M}\\p{N} — only 'hot' and 'fire' are indexed
    expect(idx.search("hot")).toEqual(new Set(["doc1"]));
    // searching the emoji itself yields nothing
    expect(idx.search("🔥")).toEqual(new Set());
  });

  it("mixed-script doc (東京 fire 🔥) has both Japanese and English tokens", () => {
    const idx = new TextIndex();
    idx.add("doc1", { text: "東京 fire 🔥" });
    // '東京' is one token (single contiguous CJK run)
    expect(idx.search("東京")).toEqual(new Set(["doc1"]));
    // 'fire' is an English token
    expect(idx.search("fire")).toEqual(new Set(["doc1"]));
    // emoji not indexed
    expect(idx.search("🔥")).toEqual(new Set());
  });
});

describe("TextIndex — prototype-pollution guards in loadFromJSON", () => {
  it("ignores __proto__ / constructor / prototype keys in terms map", () => {
    const data = {
      version: 2,
      terms: {
        hello: ["doc1"],
        __proto__: ["doc1"],
        constructor: ["doc1"],
        prototype: ["doc1"],
      },
      docs: {
        doc1: { terms: { hello: 1 }, len: 1 },
      },
    };
    const idx = TextIndex.fromJSON(data as Parameters<typeof TextIndex.fromJSON>[0]);
    // Legit term works
    expect(idx.search("hello")).toEqual(new Set(["doc1"]));
    // Poison keys must not be in the index
    expect(idx.termCount).toBe(1); // only "hello"
    // No prototype pollution — a fresh plain object has no own "evil" property
    const probe: Record<string, unknown> = {};
    expect(Object.prototype.hasOwnProperty.call(probe, "evil")).toBe(false);
  });

  it("ignores __proto__ / constructor / prototype in docs map", () => {
    const data = {
      version: 2,
      terms: { hello: ["doc1"] },
      docs: {
        doc1: { terms: { hello: 1 }, len: 1 },
        __proto__: { terms: { hello: 1 }, len: 1 },
        constructor: { terms: { hello: 1 }, len: 1 },
      },
    };
    const idx = TextIndex.fromJSON(data as Parameters<typeof TextIndex.fromJSON>[0]);
    expect(idx.docCount).toBe(1); // only doc1
  });

  it("ignores __proto__ / constructor / prototype in per-doc TF map", () => {
    const data = {
      version: 2,
      terms: { hello: ["doc1"] },
      docs: {
        doc1: {
          terms: { hello: 1, __proto__: 99, constructor: 99 },
          len: 1,
        },
      },
    };
    const idx = TextIndex.fromJSON(data as Parameters<typeof TextIndex.fromJSON>[0]);
    // "hello" should be found; poison terms must not be
    const results = idx.searchScored("hello");
    expect(results.length).toBe(1);
    expect(results[0].id).toBe("doc1");
  });
});
