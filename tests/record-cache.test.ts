import { describe, it, expect } from "vitest";
import { RecordCache } from "../src/record-cache.js";

describe("RecordCache", () => {
  it("get returns undefined on miss", () => {
    const cache = new RecordCache(10);
    expect(cache.get("nonexistent")).toBeUndefined();
  });

  it("set and get round-trip", () => {
    const cache = new RecordCache(10);
    cache.set("a", { name: "Alice" });
    expect(cache.get("a")).toEqual({ name: "Alice" });
  });

  it("evicts oldest when over capacity", () => {
    const cache = new RecordCache(3);
    cache.set("a", { v: 1 });
    cache.set("b", { v: 2 });
    cache.set("c", { v: 3 });
    cache.set("d", { v: 4 }); // should evict "a"

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toEqual({ v: 2 });
    expect(cache.get("d")).toEqual({ v: 4 });
    expect(cache.size).toBe(3);
  });

  it("get promotes to most-recently-used", () => {
    const cache = new RecordCache(3);
    cache.set("a", { v: 1 });
    cache.set("b", { v: 2 });
    cache.set("c", { v: 3 });

    // Access "a" — promotes it, so "b" becomes oldest
    cache.get("a");
    cache.set("d", { v: 4 }); // should evict "b", not "a"

    expect(cache.get("a")).toEqual({ v: 1 }); // still here
    expect(cache.get("b")).toBeUndefined(); // evicted
    expect(cache.get("d")).toEqual({ v: 4 });
  });

  it("set overwrites existing value", () => {
    const cache = new RecordCache(10);
    cache.set("a", { v: 1 });
    cache.set("a", { v: 2 });
    expect(cache.get("a")).toEqual({ v: 2 });
    expect(cache.size).toBe(1);
  });

  it("delete removes from cache", () => {
    const cache = new RecordCache(10);
    cache.set("a", { v: 1 });
    cache.delete("a");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("has checks existence without promoting", () => {
    const cache = new RecordCache(3);
    cache.set("a", { v: 1 });
    cache.set("b", { v: 2 });
    cache.set("c", { v: 3 });

    expect(cache.has("a")).toBe(true);
    // "a" was NOT promoted by has(), so inserting "d" evicts "a"
    cache.set("d", { v: 4 });
    expect(cache.has("a")).toBe(false);
  });

  it("clear removes all entries", () => {
    const cache = new RecordCache(10);
    cache.set("a", { v: 1 });
    cache.set("b", { v: 2 });
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeUndefined();
  });

  it("tracks stats correctly", () => {
    const cache = new RecordCache(2);

    cache.get("miss1"); // miss
    cache.set("a", { v: 1 });
    cache.get("a"); // hit
    cache.get("a"); // hit
    cache.get("miss2"); // miss
    cache.set("b", { v: 2 });
    cache.set("c", { v: 3 }); // evicts "a"

    const stats = cache.stats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(2);
    expect(stats.hitRate).toBe(0.5);
    expect(stats.size).toBe(2);
    expect(stats.evictions).toBe(1);
  });

  it("clear resets stats", () => {
    const cache = new RecordCache(10);
    cache.set("a", { v: 1 });
    cache.get("a");
    cache.get("miss");
    cache.clear();

    const stats = cache.stats();
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
    expect(stats.evictions).toBe(0);
  });

  it("handles capacity of 1", () => {
    const cache = new RecordCache(1);
    cache.set("a", { v: 1 });
    cache.set("b", { v: 2 }); // evicts "a"
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toEqual({ v: 2 });
    expect(cache.size).toBe(1);
  });

  it("handles large number of entries", () => {
    const cache = new RecordCache(100);
    for (let i = 0; i < 200; i++) {
      cache.set(`key-${i}`, { v: i });
    }
    expect(cache.size).toBe(100);
    // First 100 should be evicted
    expect(cache.get("key-0")).toBeUndefined();
    expect(cache.get("key-99")).toBeUndefined();
    // Last 100 should be present
    expect(cache.get("key-100")).toEqual({ v: 100 });
    expect(cache.get("key-199")).toEqual({ v: 199 });
    expect(cache.stats().evictions).toBe(100);
  });

  it("handles null and undefined values", () => {
    const cache = new RecordCache(10);
    cache.set("n", { val: null });
    cache.set("u", { val: undefined });
    expect(cache.get("n")).toEqual({ val: null });
    expect(cache.get("u")).toEqual({ val: undefined });
    expect(cache.size).toBe(2);
  });

  it("handles empty object values", () => {
    const cache = new RecordCache(10);
    cache.set("empty", {});
    expect(cache.get("empty")).toEqual({});
  });

  it("delete on nonexistent key is no-op", () => {
    const cache = new RecordCache(10);
    cache.delete("nonexistent");
    expect(cache.size).toBe(0);
  });

  it("set same key multiple times doesn't grow size", () => {
    const cache = new RecordCache(10);
    cache.set("a", { v: 1 });
    cache.set("a", { v: 2 });
    cache.set("a", { v: 3 });
    expect(cache.size).toBe(1);
    expect(cache.get("a")).toEqual({ v: 3 });
    expect(cache.stats().evictions).toBe(0);
  });

  it("works correctly after clear and reuse", () => {
    const cache = new RecordCache(3);
    cache.set("a", { v: 1 });
    cache.set("b", { v: 2 });
    cache.clear();
    cache.set("c", { v: 3 });
    cache.set("d", { v: 4 });
    expect(cache.size).toBe(2);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("c")).toEqual({ v: 3 });
  });
});
