import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDB } from "../src/agentdb.js";
import { defineSchema } from "../src/schema.js";

describe("multi-collection text search isolation", () => {
  it("5 collections open simultaneously — no termlog cross-contamination", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentdb-multicol-"));
    try {
      const db = new AgentDB(dir);
      await db.init();

      // Open 5 collections, each with textSearch, each seeded with unique vocabulary
      const N = 5;
      const schemas = Array.from({ length: N }, (_, i) =>
        defineSchema({
          name: `col${i}`,
          textSearch: true,
          fields: { body: { type: "string", searchable: true } },
        })
      );

      const cols = await Promise.all(schemas.map((s) => db.collection(s)));

      // Insert collection-specific unique terms concurrently
      await Promise.all(
        cols.map((col, i) =>
          col.insertMany([
            { _id: `${i}-a`, body: `uniqueterm${i} shared common word` },
            { _id: `${i}-b`, body: `uniqueterm${i} another shared word` },
            { _id: `${i}-c`, body: `shared common word only` },
          ])
        )
      );

      // Each collection's unique term must ONLY appear in that collection
      for (let i = 0; i < N; i++) {
        const hit = await cols[i].bm25Search(`uniqueterm${i}`, { limit: 10 });
        expect(hit.records.length).toBeGreaterThan(0);
        // All returned IDs must belong to col i
        for (const rec of hit.records) {
          expect(String(rec._id)).toMatch(new RegExp(`^${i}-`));
        }

        // Other collections must NOT return results for col i's unique term
        for (let j = 0; j < N; j++) {
          if (j === i) continue;
          const miss = await cols[j].bm25Search(`uniqueterm${i}`, { limit: 10 });
          expect(miss.records.length).toBe(0);
        }
      }

      await db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("concurrent writes to 5 collections do not corrupt each other's text index", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentdb-multicol-write-"));
    try {
      const db = new AgentDB(dir);
      await db.init();

      const N = 5;
      const schemas = Array.from({ length: N }, (_, i) =>
        defineSchema({
          name: `writer${i}`,
          textSearch: true,
          fields: { body: { type: "string", searchable: true } },
        })
      );

      const cols = await Promise.all(schemas.map((s) => db.collection(s)));

      // Write 20 docs per collection concurrently
      await Promise.all(
        cols.map((col, i) =>
          Promise.all(
            Array.from({ length: 20 }, (_, j) =>
              col.insert({ _id: `w${i}-${j}`, body: `writer${i}term doc ${j}` })
            )
          )
        )
      );

      // Each collection must find its own writes
      for (let i = 0; i < N; i++) {
        const r = await cols[i].bm25Search(`writer${i}term`, { limit: 25 });
        expect(r.records.length).toBe(20);
        // No cross-contamination: no other collection's IDs
        for (const rec of r.records) {
          expect(String(rec._id)).toMatch(new RegExp(`^w${i}-`));
        }
      }

      await db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
