import { describe, it, expect } from "vitest";
import { BloomFilter } from "../src/bloom.js";

describe("BloomFilter", () => {
  it("reports added values as present", () => {
    const bf = new BloomFilter(100);
    bf.add("hello");
    bf.add("world");
    expect(bf.has("hello")).toBe(true);
    expect(bf.has("world")).toBe(true);
  });

  it("reports non-added values as absent (usually)", () => {
    const bf = new BloomFilter(100);
    bf.add("hello");
    // Very unlikely to be a false positive with 100 expected items and 1 added
    expect(bf.has("definitely-not-here")).toBe(false);
    expect(bf.has("also-missing")).toBe(false);
  });

  it("handles empty filter", () => {
    const bf = new BloomFilter(100);
    expect(bf.has("anything")).toBe(false);
  });

  it("handles many values with low false positive rate", () => {
    const bf = new BloomFilter(1000, 0.01);
    const added = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const val = `item-${i}`;
      bf.add(val);
      added.add(val);
    }

    // All added items should be found
    for (const val of added) {
      expect(bf.has(val)).toBe(true);
    }

    // Check false positive rate on 1000 non-added items
    let falsePositives = 0;
    for (let i = 1000; i < 2000; i++) {
      if (bf.has(`item-${i}`)) falsePositives++;
    }
    // Should be roughly ≤1% = 10, allow some margin
    expect(falsePositives).toBeLessThan(50);
  });

  it("clear resets the filter", () => {
    const bf = new BloomFilter(100);
    bf.add("hello");
    expect(bf.has("hello")).toBe(true);
    bf.clear();
    expect(bf.has("hello")).toBe(false);
  });

  it("reports bit count", () => {
    const bf = new BloomFilter(1000, 0.01);
    expect(bf.bitCount).toBeGreaterThan(0);
  });

  it("handles empty string", () => {
    const bf = new BloomFilter(100);
    bf.add("");
    expect(bf.has("")).toBe(true);
    expect(bf.has("x")).toBe(false);
  });

  it("handles unicode", () => {
    const bf = new BloomFilter(100);
    bf.add("こんにちは");
    expect(bf.has("こんにちは")).toBe(true);
    expect(bf.has("hello")).toBe(false);
  });
});
