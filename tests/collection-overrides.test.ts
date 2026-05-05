/**
 * Tests for AgentDBOptions.collectionOverrides — per-collection config wiring (R5/2).
 *
 * Uses `col.filterCacheSize` (synchronously observable via getter) as the primary
 * probe to verify precedence without requiring disk compaction or many records.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDB } from "../src/agentdb.js";
import { defineSchema } from "../src/schema.js";

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agentdb-col-override-"));
}

describe("AgentDBOptions.collectionOverrides", () => {
  it("override is applied at collection-open time", async () => {
    const dir = await makeTmpDir();
    try {
      const db = new AgentDB(dir, {
        collectionOverrides: { "target": { filterCacheSize: 7 } },
      });
      await db.init();

      const col = await db.collection("target");
      expect(col.filterCacheSize).toBe(7);

      await db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("override does not affect other collections", async () => {
    const dir = await makeTmpDir();
    try {
      const db = new AgentDB(dir, {
        collectionOverrides: { "only-this": { filterCacheSize: 3 } },
      });
      await db.init();

      const other = await db.collection("other-col");
      // "other-col" not in overrides → uses built-in default (64)
      expect(other.filterCacheSize).toBe(64);

      await db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("override beats db-wide AgentDBOptions default", async () => {
    const dir = await makeTmpDir();
    try {
      const db = new AgentDB(dir, {
        filterCacheSize: 50,   // db-wide default
        collectionOverrides: { "col-a": { filterCacheSize: 25 } },
      });
      await db.init();

      const colA = await db.collection("col-a");
      expect(colA.filterCacheSize).toBe(25); // override wins

      const colB = await db.collection("col-b");
      expect(colB.filterCacheSize).toBe(50); // db-wide default

      await db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("caller-passed CollectionOptions beat collectionOverrides", async () => {
    const dir = await makeTmpDir();
    try {
      const db = new AgentDB(dir, {
        collectionOverrides: { "col": { filterCacheSize: 7 } },
      });
      await db.init();

      // Caller explicitly sets filterCacheSize=99 — must win over override's 7
      const col = await db.collection("col", { filterCacheSize: 99 });
      expect(col.filterCacheSize).toBe(99);

      await db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("override maxFindLimit is enforced on find() — functional integration", async () => {
    const dir = await makeTmpDir();
    try {
      const db = new AgentDB(dir, {
        collectionOverrides: { "capped": { maxFindLimit: 3 } },
      });
      await db.init();

      const schema = defineSchema({ name: "capped", fields: { v: { type: "string" } } });
      const col = await db.collection(schema);

      for (let i = 0; i < 10; i++) await col.insert({ v: `item-${i}` });

      // Request 100 but cap is 3 → truncated
      const result = await col.find({ limit: 100 });
      expect(result.records.length).toBe(3);
      expect(result.truncated).toBe(true);
      expect(col.metrics().findTruncations).toBe(1);

      await db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("override is re-read on every open (LRU evict + reopen picks up change)", async () => {
    const dir = await makeTmpDir();
    try {
      // First instance: override = 7
      const db1 = new AgentDB(dir, {
        maxOpenCollections: 1,
        collectionOverrides: { "col": { filterCacheSize: 7 } },
      });
      await db1.init();
      const col1 = await db1.collection("col");
      expect(col1.filterCacheSize).toBe(7);
      await db1.close();

      // Second instance (simulating config change): override = 99
      const db2 = new AgentDB(dir, {
        maxOpenCollections: 1,
        collectionOverrides: { "col": { filterCacheSize: 99 } },
      });
      await db2.init();
      const col2 = await db2.collection("col");
      // New open reads updated override
      expect(col2.filterCacheSize).toBe(99);
      await db2.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
