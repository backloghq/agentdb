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
