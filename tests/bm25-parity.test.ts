/**
 * BM25 parity regression — verifies that Collection.bm25Search scores match
 * a hand-derived reference implementation of the BM25 formula to within 1e-9.
 *
 * Formula (termlog/src/scoring.ts):
 *   idf   = ln(((N - df + 0.5) / (df + 0.5)) + 1)
 *   score = idf * (tf * (k1+1)) / (tf + k1 * (1 - b + b * dl / avgdl))
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDB } from "../src/index.js";
import { defineSchema } from "../src/schema.js";

function bm25Reference(args: {
  N: number; df: number; tf: number; dl: number; avgdl: number;
  k1: number; b: number;
}): number {
  const { N, df, tf, dl, avgdl, k1, b } = args;
  const idf = Math.log(((N - df + 0.5) / (df + 0.5)) + 1);
  return idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avgdl)));
}

describe("BM25 parity vs hand-derived reference", () => {
  let dir: string;
  let db: AgentDB;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bm25-parity-"));
    db = new AgentDB(dir);
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  // Tiny ASCII corpus — easy to compute reference by hand:
  //   doc-1: "alpha beta gamma alpha"  → tf(alpha)=2, dl=4
  //   doc-2: "alpha gamma delta"       → tf(alpha)=1, dl=3
  //   doc-3: "beta gamma epsilon"      → tf(alpha)=0, dl=3
  //   doc-4: "alpha epsilon zeta"      → tf(alpha)=1, dl=3
  // N=4, df(alpha)=3, avgdl=(4+3+3+3)/4=3.25
  async function runParityCase(opts: { k1: number; b: number }) {
    const schema = defineSchema({
      name: `parity-${opts.k1}-${opts.b}`.replace(/\./g, "_"),
      textSearch: true,
      bm25: { k1: opts.k1, b: opts.b },
      fields: { text: { type: "string", searchable: true } },
    });
    const col = await db.collection(schema);

    await col.insert({ _id: "doc-1", text: "alpha beta gamma alpha" });
    await col.insert({ _id: "doc-2", text: "alpha gamma delta" });
    await col.insert({ _id: "doc-3", text: "beta gamma epsilon" });
    await col.insert({ _id: "doc-4", text: "alpha epsilon zeta" });

    const results = await col.bm25Search("alpha", { limit: 10 });

    // doc-3 has tf(alpha)=0 — must be absent
    const ids = results.records.map((r) => r._id as string);
    expect(ids).toContain("doc-1");
    expect(ids).toContain("doc-2");
    expect(ids).toContain("doc-4");
    expect(ids).not.toContain("doc-3");

    // doc-1 (tf=2) must rank first
    expect(ids[0]).toBe("doc-1");

    // Verify each returned score against reference within 1e-9
    const N = 4, df = 3, avgdl = (4 + 3 + 3 + 3) / 4;
    const scoreMap = new Map(results.records.map((r, i) => [r._id as string, results.scores[i]]));

    const tfMap = new Map([["doc-1", 2], ["doc-2", 1], ["doc-4", 1]]);
    const dlMap = new Map([["doc-1", 4], ["doc-2", 3], ["doc-4", 3]]);

    for (const id of ["doc-1", "doc-2", "doc-4"]) {
      const expected = bm25Reference({
        N, df, tf: tfMap.get(id)!, dl: dlMap.get(id)!, avgdl, ...opts,
      });
      expect(Math.abs(scoreMap.get(id)! - expected)).toBeLessThan(1e-9);
    }
  }

  it("default config (k1=1.2, b=0.75)", async () => {
    await runParityCase({ k1: 1.2, b: 0.75 });
  });

  it("tuned config (k1=2, b=0.3)", async () => {
    await runParityCase({ k1: 2, b: 0.3 });
  });
});
