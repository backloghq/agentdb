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

  it("ignores single-character tokens", () => {
    index.add("1", { title: "A B C hello" });
    expect(index.search("a")).toEqual(new Set());
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

  it("fromJSON accepts v1 data — AND search still works, BM25 gives zero scores", () => {
    const v1Data = {
      version: 1,
      terms: { hello: ["1", "2"], world: ["1"] },
      docCount: 2,
    };
    const idx = TextIndex.fromJSON(v1Data);
    // AND search should still find docs
    expect(idx.search("hello world")).toEqual(new Set(["1"]));
    // BM25 falls back — tf=0, scores will be 0 but docs still returned
    const results = idx.searchScored("hello");
    expect(results.map((r) => r.id).sort()).toEqual(["1", "2"]);
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
