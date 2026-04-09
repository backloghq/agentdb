import { describe, it, expect, beforeEach } from "vitest";
import { BTreeIndex, QueryFrequencyTracker } from "../src/btree.js";

describe("BTreeIndex", () => {
  let idx: BTreeIndex;

  beforeEach(() => {
    idx = new BTreeIndex("status");
  });

  it("adds and finds by equality", () => {
    idx.add("active", "a");
    idx.add("active", "b");
    idx.add("done", "c");

    expect(idx.eq("active")).toEqual(new Set(["a", "b"]));
    expect(idx.eq("done")).toEqual(new Set(["c"]));
    expect(idx.eq("missing")).toEqual(new Set());
  });

  it("removes entries", () => {
    idx.add("active", "a");
    idx.add("active", "b");
    idx.remove("active", "a");

    expect(idx.eq("active")).toEqual(new Set(["b"]));
  });

  it("handles numeric values", () => {
    const numIdx = new BTreeIndex("score");
    numIdx.add(10, "a");
    numIdx.add(20, "b");
    numIdx.add(10, "c");

    expect(numIdx.eq(10)).toEqual(new Set(["a", "c"]));
    expect(numIdx.eq(20)).toEqual(new Set(["b"]));
  });

  it("range query", () => {
    const numIdx = new BTreeIndex("score");
    for (let i = 0; i < 20; i++) {
      numIdx.add(i, `id-${i}`);
    }

    const result = numIdx.range(5, 10);
    expect(result.size).toBe(6); // 5,6,7,8,9,10
    expect(result.has("id-5")).toBe(true);
    expect(result.has("id-10")).toBe(true);
    expect(result.has("id-4")).toBe(false);
    expect(result.has("id-11")).toBe(false);
  });

  it("allValues returns indexed values", () => {
    idx.add("active", "a");
    idx.add("done", "b");
    idx.add("pending", "c");

    const values = idx.allValues();
    expect(values).toContain("active");
    expect(values).toContain("done");
    expect(values).toContain("pending");
  });

  it("tracks size", () => {
    expect(idx.size).toBe(0);
    idx.add("active", "a");
    idx.add("active", "b");
    idx.add("done", "c");
    expect(idx.size).toBe(3);
    idx.remove("active", "a");
    expect(idx.size).toBe(2);
  });

  it("clear resets the index", () => {
    idx.add("active", "a");
    idx.clear();
    expect(idx.size).toBe(0);
    expect(idx.eq("active")).toEqual(new Set());
  });

  it("handles many entries without breaking", () => {
    for (let i = 0; i < 1000; i++) {
      idx.add(`val-${i % 50}`, `id-${i}`);
    }
    expect(idx.size).toBe(1000);
    expect(idx.eq("val-0").size).toBe(20);
  });

  it("handles null values", () => {
    idx.add(null, "a");
    idx.add(null, "b");
    expect(idx.eq(null)).toEqual(new Set(["a", "b"]));
  });

  it("removeById removes entry without knowing the key", () => {
    idx.add("active", "a");
    idx.add("done", "b");
    idx.add("active", "c");
    idx.removeById("a");
    expect(idx.eq("active")).toEqual(new Set(["c"]));
    expect(idx.size).toBe(2);
  });

  it("removeById is no-op for unknown ID", () => {
    idx.add("active", "a");
    idx.removeById("nonexistent");
    expect(idx.eq("active")).toEqual(new Set(["a"]));
    expect(idx.size).toBe(1);
  });

  it("removeById works with null-keyed entries", () => {
    idx.add(null, "a");
    idx.add("active", "b");
    idx.removeById("a");
    expect(idx.eq(null)).toEqual(new Set());
    expect(idx.size).toBe(1);
  });

  describe("range comparison methods", () => {
    let numIdx: BTreeIndex;

    beforeEach(() => {
      numIdx = new BTreeIndex("score");
      for (let i = 0; i < 20; i++) {
        numIdx.add(i, `id-${i}`);
      }
    });

    it("gt returns IDs where field > value", () => {
      const result = numIdx.gt(17);
      expect(result).toEqual(new Set(["id-18", "id-19"]));
      expect(numIdx.gt(19).size).toBe(0);
      expect(numIdx.gt(-1).size).toBe(20);
    });

    it("gte returns IDs where field >= value", () => {
      const result = numIdx.gte(18);
      expect(result).toEqual(new Set(["id-18", "id-19"]));
      expect(numIdx.gte(20).size).toBe(0);
    });

    it("lt returns IDs where field < value", () => {
      const result = numIdx.lt(3);
      expect(result).toEqual(new Set(["id-0", "id-1", "id-2"]));
      expect(numIdx.lt(0).size).toBe(0);
    });

    it("lte returns IDs where field <= value", () => {
      const result = numIdx.lte(2);
      expect(result).toEqual(new Set(["id-0", "id-1", "id-2"]));
      expect(numIdx.lte(-1).size).toBe(0);
    });

    it("gt and lt with duplicate values", () => {
      const idx2 = new BTreeIndex("priority");
      idx2.add(5, "a");
      idx2.add(5, "b");
      idx2.add(10, "c");
      idx2.add(10, "d");
      idx2.add(15, "e");

      expect(idx2.gt(5)).toEqual(new Set(["c", "d", "e"]));
      expect(idx2.lt(10)).toEqual(new Set(["a", "b"]));
      expect(idx2.gte(10)).toEqual(new Set(["c", "d", "e"]));
      expect(idx2.lte(5)).toEqual(new Set(["a", "b"]));
    });
  });
});

describe("QueryFrequencyTracker", () => {
  let tracker: QueryFrequencyTracker;

  beforeEach(() => {
    tracker = new QueryFrequencyTracker();
  });

  it("tracks query counts", () => {
    tracker.track("status");
    tracker.track("status");
    tracker.track("role");
    expect(tracker.getCount("status")).toBe(2);
    expect(tracker.getCount("role")).toBe(1);
    expect(tracker.getCount("unknown")).toBe(0);
  });

  it("suggests fields above threshold", () => {
    for (let i = 0; i < 100; i++) tracker.track("status");
    for (let i = 0; i < 50; i++) tracker.track("role");
    for (let i = 0; i < 10; i++) tracker.track("name");

    const suggestions = tracker.suggest(50);
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0].field).toBe("status");
    expect(suggestions[1].field).toBe("role");
  });

  it("clear resets counts", () => {
    tracker.track("status");
    tracker.clear();
    expect(tracker.getCount("status")).toBe(0);
  });
});
