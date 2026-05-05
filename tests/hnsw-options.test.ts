/**
 * Tests for HNSW M/efConstruction/efSearch/maxLevel exposure via CollectionOptions and AgentDBOptions.
 * Verifies: config getters, per-collection override, db-wide default, Collection.getHnswIndex().
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDB } from "../src/agentdb.js";
import { defineSchema } from "../src/schema.js";
import type { EmbeddingProvider } from "../src/embeddings/types.js";

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agentdb-hnsw-opts-"));
}

/** Minimal deterministic embedding provider — dim 8. */
const hashProvider: EmbeddingProvider = {
  dimensions: 8,
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      let h = 5381;
      for (let i = 0; i < t.length; i++) h = (Math.imul(h, 33) ^ t.charCodeAt(i)) >>> 0;
      let s = h || 1;
      const v = Array.from({ length: 8 }, () => {
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
        return (s >>> 0) / 0x100000000 * 2 - 1;
      });
      const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
      return v.map((x) => x / norm);
    });
  },
};

describe("HNSW options exposure", () => {
  describe("HnswIndex config getters", () => {
    it("configM / configEfConstruction / configEfSearch / configMaxLevelCap reflect constructor args", async () => {
      const { HnswIndex } = await import("../src/hnsw.js");
      const idx = new HnswIndex({ dimensions: 8, M: 8, efConstruction: 150, efSearch: 40 });
      expect(idx.configM).toBe(8);
      expect(idx.configEfConstruction).toBe(150);
      expect(idx.configEfSearch).toBe(40);
      // maxLevelCap: max(16, floor(log(1e6)/log(8))) = max(16, 6) = 16
      expect(idx.configMaxLevelCap).toBe(16);
    });

    it("config getters return defaults when not specified", async () => {
      const { HnswIndex } = await import("../src/hnsw.js");
      const idx = new HnswIndex({ dimensions: 16 });
      expect(idx.configM).toBe(16);
      expect(idx.configEfConstruction).toBe(200);
      expect(idx.configEfSearch).toBe(50);
      // maxLevelCap: max(16, floor(log(1e6)/log(16))) = max(16, 4) = 16
      expect(idx.configMaxLevelCap).toBe(16);
    });

    it("explicit maxLevel is stored in configMaxLevelCap", async () => {
      const { HnswIndex } = await import("../src/hnsw.js");
      const idx = new HnswIndex({ dimensions: 8, maxLevel: 5 });
      expect(idx.configMaxLevelCap).toBe(5);
    });
  });

  describe("Collection.getHnswIndex() and per-collection hnsw option", () => {
    it("getHnswIndex returns null when no embedding provider is set", async () => {
      const dir = await makeTmpDir();
      const db = new AgentDB(dir);
      await db.init();
      const col = await db.collection(defineSchema({ name: "no-embed", fields: { v: { type: "string" } } }));
      expect(col.getHnswIndex()).toBeNull();
      await db.close();
      await rm(dir, { recursive: true, force: true });
    });

    it("getHnswIndex returns index with default config when hnsw option not set", async () => {
      const dir = await makeTmpDir();
      const db = new AgentDB(dir, { embeddings: { provider: hashProvider } });
      await db.init();
      const col = await db.collection(defineSchema({ name: "default-hnsw", fields: { v: { type: "string" } } }));
      const idx = col.getHnswIndex();
      expect(idx).not.toBeNull();
      expect(idx!.configM).toBe(16);
      expect(idx!.configEfConstruction).toBe(200);
      expect(idx!.configEfSearch).toBe(50);
      await db.close();
      await rm(dir, { recursive: true, force: true });
    });

    it("per-collection hnsw option overrides defaults (string name form)", async () => {
      const dir = await makeTmpDir();
      const db = new AgentDB(dir, { embeddings: { provider: hashProvider } });
      await db.init();
      // Use string-name form so colOpts is not discarded by the schema path
      const col = await db.collection("custom-hnsw", { hnsw: { M: 8, efConstruction: 100, efSearch: 30 } });
      const idx = col.getHnswIndex();
      expect(idx).not.toBeNull();
      expect(idx!.configM).toBe(8);
      expect(idx!.configEfConstruction).toBe(100);
      expect(idx!.configEfSearch).toBe(30);
      await db.close();
      await rm(dir, { recursive: true, force: true });
    });

    it("partial per-collection hnsw option only overrides specified fields", async () => {
      const dir = await makeTmpDir();
      const db = new AgentDB(dir, { embeddings: { provider: hashProvider } });
      await db.init();
      // Use string-name form so colOpts is not discarded by the schema path
      const col = await db.collection("partial-hnsw", { hnsw: { efSearch: 80 } });
      const idx = col.getHnswIndex();
      expect(idx).not.toBeNull();
      expect(idx!.configM).toBe(16);          // default
      expect(idx!.configEfConstruction).toBe(200); // default
      expect(idx!.configEfSearch).toBe(80);   // overridden
      await db.close();
      await rm(dir, { recursive: true, force: true });
    });
  });

  describe("AgentDB-level hnsw default", () => {
    it("db-wide hnsw option propagates to all collections", async () => {
      const dir = await makeTmpDir();
      const db = new AgentDB(dir, {
        embeddings: { provider: hashProvider },
        hnsw: { M: 8, efSearch: 100 },
      });
      await db.init();

      const colA = await db.collection(defineSchema({ name: "db-hnsw-a", fields: { v: { type: "string" } } }));
      const colB = await db.collection(defineSchema({ name: "db-hnsw-b", fields: { v: { type: "string" } } }));

      const idxA = colA.getHnswIndex();
      const idxB = colB.getHnswIndex();

      expect(idxA!.configM).toBe(8);
      expect(idxA!.configEfSearch).toBe(100);
      expect(idxB!.configM).toBe(8);
      expect(idxB!.configEfSearch).toBe(100);

      await db.close();
      await rm(dir, { recursive: true, force: true });
    });

    it("per-collection hnsw wins over db-wide default", async () => {
      const dir = await makeTmpDir();
      const db = new AgentDB(dir, {
        embeddings: { provider: hashProvider },
        hnsw: { M: 8, efSearch: 100 },
      });
      await db.init();

      // colA uses db default (schema form — hnsw not in schema so db default applies)
      const colA = await db.collection(defineSchema({ name: "db-default-a", fields: { v: { type: "string" } } }));
      // colB uses string-name form with explicit hnsw opts to override db default
      const colB = await db.collection("db-override-b", { hnsw: { M: 4, efSearch: 200 } });

      expect(colA.getHnswIndex()!.configM).toBe(8);    // db default
      expect(colA.getHnswIndex()!.configEfSearch).toBe(100); // db default
      expect(colB.getHnswIndex()!.configM).toBe(4);    // per-collection override
      expect(colB.getHnswIndex()!.configEfSearch).toBe(200); // per-collection override

      await db.close();
      await rm(dir, { recursive: true, force: true });
    });
  });

  describe("maxLevel option propagates", () => {
    it("maxLevel from CollectionOptions.hnsw is honored", async () => {
      const dir = await makeTmpDir();
      const db = new AgentDB(dir, { embeddings: { provider: hashProvider } });
      await db.init();
      // Use string-name form so colOpts is not discarded by the schema path
      const col = await db.collection("maxlevel-col", { hnsw: { maxLevel: 5 } });
      const idx = col.getHnswIndex();
      expect(idx!.configMaxLevelCap).toBe(5);
      await db.close();
      await rm(dir, { recursive: true, force: true });
    });
  });
});
