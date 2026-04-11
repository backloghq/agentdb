import { describe, it, expect } from "vitest";
import { ArrayIndex } from "../src/array-index.js";

describe("ArrayIndex", () => {
  it("adds and looks up elements", () => {
    const idx = new ArrayIndex("tags");
    idx.add("r1", ["bug", "urgent"]);
    idx.add("r2", ["bug", "feature"]);
    idx.add("r3", ["feature"]);

    expect(idx.lookup("bug")).toEqual(new Set(["r1", "r2"]));
    expect(idx.lookup("feature")).toEqual(new Set(["r2", "r3"]));
    expect(idx.lookup("urgent")).toEqual(new Set(["r1"]));
    expect(idx.lookup("nonexistent").size).toBe(0);
  });

  it("removes elements", () => {
    const idx = new ArrayIndex("tags");
    idx.add("r1", ["bug", "urgent"]);
    idx.add("r2", ["bug"]);

    idx.remove("r1", ["bug", "urgent"]);

    expect(idx.lookup("bug")).toEqual(new Set(["r2"]));
    expect(idx.lookup("urgent").size).toBe(0); // cleaned up empty set
  });

  it("updates elements on record change", () => {
    const idx = new ArrayIndex("tags");
    idx.add("r1", ["bug", "urgent"]);

    idx.update("r1", ["bug", "urgent"], ["bug", "fixed"]);

    expect(idx.lookup("bug")).toEqual(new Set(["r1"]));
    expect(idx.lookup("urgent").size).toBe(0);
    expect(idx.lookup("fixed")).toEqual(new Set(["r1"]));
  });

  it("ignores non-array values", () => {
    const idx = new ArrayIndex("tags");
    idx.add("r1", "not an array");
    idx.add("r2", null);
    idx.add("r3", undefined);
    idx.add("r4", 42);

    expect(idx.uniqueValues).toBe(0);
    expect(idx.totalEntries).toBe(0);
  });

  it("reports uniqueValues and totalEntries", () => {
    const idx = new ArrayIndex("tags");
    idx.add("r1", ["bug", "urgent"]);
    idx.add("r2", ["bug", "feature"]);

    expect(idx.uniqueValues).toBe(3); // bug, urgent, feature
    expect(idx.totalEntries).toBe(4); // bug:2, urgent:1, feature:1
  });

  it("clears the index", () => {
    const idx = new ArrayIndex("tags");
    idx.add("r1", ["bug"]);
    idx.add("r2", ["feature"]);
    idx.clear();

    expect(idx.uniqueValues).toBe(0);
    expect(idx.lookup("bug").size).toBe(0);
  });

  it("serializes and deserializes", () => {
    const idx = new ArrayIndex("tags");
    idx.add("r1", ["bug", "urgent"]);
    idx.add("r2", ["bug", "feature"]);

    const json = idx.toJSON();
    expect(json.version).toBe(1);
    expect(json.field).toBe("tags");
    expect(json.elements["bug"]).toEqual(["r1", "r2"]);

    const restored = ArrayIndex.fromJSON(json);
    expect(restored.field).toBe("tags");
    expect(restored.lookup("bug")).toEqual(new Set(["r1", "r2"]));
    expect(restored.lookup("urgent")).toEqual(new Set(["r1"]));
    expect(restored.lookup("feature")).toEqual(new Set(["r2"]));
  });

  it("handles empty arrays", () => {
    const idx = new ArrayIndex("tags");
    idx.add("r1", []);
    expect(idx.uniqueValues).toBe(0);
  });

  it("handles duplicate elements in array", () => {
    const idx = new ArrayIndex("tags");
    idx.add("r1", ["bug", "bug", "bug"]);
    expect(idx.lookup("bug")).toEqual(new Set(["r1"]));
    expect(idx.totalEntries).toBe(1);
  });

  it("handles numeric array elements", () => {
    const idx = new ArrayIndex("scores");
    idx.add("r1", [1, 2, 3]);
    idx.add("r2", [2, 4]);

    expect(idx.lookup("2")).toEqual(new Set(["r1", "r2"]));
    expect(idx.lookup("1")).toEqual(new Set(["r1"]));
  });
});
