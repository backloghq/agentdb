import { describe, it, expect } from "vitest";
import { rrf } from "../src/rrf.js";

describe("rrf", () => {
  it("returns [] for empty lists input", () => {
    expect(rrf([])).toEqual([]);
  });

  it("returns [] for lists containing only empty lists", () => {
    expect(rrf([[], []])).toEqual([]);
  });

  it("single list returns ids in input order with RRF scores", () => {
    const results = rrf([[{ id: "a" }, { id: "b" }, { id: "c" }]]);
    expect(results.map((r) => r.id)).toEqual(["a", "b", "c"]);
    // rank 1 scores highest
    expect(results[0].score).toBeGreaterThan(results[1].score);
    expect(results[1].score).toBeGreaterThan(results[2].score);
  });

  it("fuses two lists correctly using default k=60", () => {
    const list1 = [{ id: "a" }, { id: "b" }];
    const list2 = [{ id: "b" }, { id: "a" }];
    const results = rrf([list1, list2]);
    // "a": 1/61 + 1/62; "b": 1/62 + 1/61 — both equal
    expect(results[0].score).toBeCloseTo(results[1].score, 10);
  });

  it("id appearing in both lists scores higher than id in one list", () => {
    const list1 = [{ id: "shared" }, { id: "only1" }];
    const list2 = [{ id: "shared" }, { id: "only2" }];
    const results = rrf([list1, list2]);
    const sharedScore = results.find((r) => r.id === "shared")!.score;
    const only1Score = results.find((r) => r.id === "only1")!.score;
    const only2Score = results.find((r) => r.id === "only2")!.score;
    expect(sharedScore).toBeGreaterThan(only1Score);
    expect(sharedScore).toBeGreaterThan(only2Score);
  });

  it("score = sum of 1/(k+rank) across lists", () => {
    const k = 60;
    const results = rrf([[{ id: "x" }, { id: "y" }], [{ id: "y" }]], { k });
    const x = results.find((r) => r.id === "x")!;
    const y = results.find((r) => r.id === "y")!;
    // x: 1/(60+1) from list1 only
    expect(x.score).toBeCloseTo(1 / 61, 10);
    // y: 1/(60+2) from list1 + 1/(60+1) from list2
    expect(y.score).toBeCloseTo(1 / 62 + 1 / 61, 10);
  });

  it("sorted by score desc, ties broken by id ascending", () => {
    // All three ids at rank 1 in separate single-item lists → equal scores
    const results = rrf([[{ id: "c" }], [{ id: "a" }], [{ id: "b" }]]);
    expect(results.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(results[0].score).toBeCloseTo(results[1].score, 10);
    expect(results[1].score).toBeCloseTo(results[2].score, 10);
  });

  it("duplicate id within a single list uses only first occurrence", () => {
    const results = rrf([[{ id: "a" }, { id: "b" }, { id: "a" }]]);
    // "a" should appear only once
    const aResults = results.filter((r) => r.id === "a");
    expect(aResults).toHaveLength(1);
    // "a" at rank 1 scores higher than "b" at rank 2
    const a = results.find((r) => r.id === "a")!;
    const b = results.find((r) => r.id === "b")!;
    expect(a.score).toBeGreaterThan(b.score);
  });

  it("score field on RankedItem is ignored", () => {
    const r1 = rrf([[{ id: "a", score: 9999 }, { id: "b", score: 0.001 }]]);
    const r2 = rrf([[{ id: "a" }, { id: "b" }]]);
    expect(r1[0].id).toBe(r2[0].id);
    expect(r1[0].score).toBeCloseTo(r2[0].score, 10);
  });

  it("limit truncates output", () => {
    const results = rrf([[{ id: "a" }, { id: "b" }, { id: "c" }]], { limit: 2 });
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("a");
    expect(results[1].id).toBe("b");
  });

  it("custom k changes scores", () => {
    const k = 1;
    const results = rrf([[{ id: "a" }, { id: "b" }]], { k });
    expect(results[0].score).toBeCloseTo(1 / (k + 1), 10);
    expect(results[1].score).toBeCloseTo(1 / (k + 2), 10);
  });

  it("throws RangeError for k <= 0", () => {
    expect(() => rrf([[{ id: "a" }]], { k: 0 })).toThrow(RangeError);
    expect(() => rrf([[{ id: "a" }]], { k: -5 })).toThrow(RangeError);
  });

  it("id only in one list still included in output", () => {
    const results = rrf([[{ id: "only" }], [{ id: "other" }]]);
    expect(results.map((r) => r.id)).toContain("only");
    expect(results.map((r) => r.id)).toContain("other");
  });
});
