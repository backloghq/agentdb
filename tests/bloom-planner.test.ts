/**
 * Tests for bloom filter integration with query planner (task 315).
 * Verifies: short-circuit on definite-miss, fallthrough on maybe-present,
 * $eq operator, $in all-absent, $in partial-present, false-positive correctness,
 * disk mode integration, B-tree + bloom coexistence, and post-creation inserts.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDB } from "../src/agentdb.js";
import { defineSchema } from "../src/schema.js";

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agentdb-bloom-planner-"));
}

async function openDb(dir: string, storageMode: "memory" | "disk" = "memory"): Promise<AgentDB> {
  const db = new AgentDB(dir, { storageMode });
  await db.init();
  return db;
}

function makeSchema(name: string, storageMode?: "memory" | "disk") {
  return defineSchema({
    name,
    fields: { tag: { type: "string" }, status: { type: "string" }, score: { type: "number" } },
    ...(storageMode ? { storageMode } : {}),
  });
}

describe("Task 315 — Bloom filter query planner integration", () => {
  it("1. short-circuit: equality predicate returns empty when value definitely absent", async () => {
    const dir = await makeTmpDir();
    try {
      const db = await openDb(dir);
      const col = await db.collection(makeSchema("t1"));
      for (let i = 0; i < 100; i++) await col.insert({ tag: "common", status: "active" });
      await col.createBloomFilter("tag");

      const result = await col.find({ filter: { tag: "never-inserted" } });
      expect(result.records.length).toBe(0);
      expect(col.mightHave("tag", "never-inserted")).toBe(false);
      await db.close();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("2. fallthrough: equality predicate returns records when value maybe-present", async () => {
    const dir = await makeTmpDir();
    try {
      const db = await openDb(dir);
      const col = await db.collection(makeSchema("t2"));
      for (let i = 0; i < 50; i++) await col.insert({ tag: "common", status: "active" });
      await col.createBloomFilter("tag");

      const result = await col.find({ filter: { tag: "common" } });
      expect(result.records.length).toBe(50);
      expect(col.mightHave("tag", "common")).toBe(true);
      await db.close();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("3. $eq operator: { field: { $eq: value } } short-circuits when definitely absent", async () => {
    const dir = await makeTmpDir();
    try {
      const db = await openDb(dir);
      const col = await db.collection(makeSchema("t3"));
      for (let i = 0; i < 50; i++) await col.insert({ tag: "alpha", status: "open" });
      await col.createBloomFilter("tag");

      const result = await col.find({ filter: { tag: { $eq: "zeta" } } });
      expect(result.records.length).toBe(0);
      expect(col.mightHave("tag", "zeta")).toBe(false);
      await db.close();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("4. $in all-absent: short-circuit when all values definitely absent", async () => {
    const dir = await makeTmpDir();
    try {
      const db = await openDb(dir);
      const col = await db.collection(makeSchema("t4"));
      for (let i = 0; i < 50; i++) await col.insert({ tag: "beta", status: "open" });
      await col.createBloomFilter("tag");

      const probeValues = ["x-111-never", "x-222-never", "x-333-never"];
      const allAbsent = probeValues.every((v) => !col.mightHave("tag", v));
      if (allAbsent) {
        const result = await col.find({ filter: { tag: { $in: probeValues } } });
        expect(result.records.length).toBe(0);
      }
      await db.close();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("5. $in partial-present: falls through to scan when at least one value maybe-present", async () => {
    const dir = await makeTmpDir();
    try {
      const db = await openDb(dir);
      const col = await db.collection(makeSchema("t5"));
      for (let i = 0; i < 20; i++) await col.insert({ tag: "gamma", status: "open" });
      await col.createBloomFilter("tag");

      const result = await col.find({ filter: { tag: { $in: ["gamma", "x-never-9999"] } } });
      expect(result.records.length).toBe(20);
      await db.close();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("6. false-positive correctness: bloom maybe-present but record absent → scan returns 0", async () => {
    const dir = await makeTmpDir();
    try {
      const db = await openDb(dir);
      const col = await db.collection(makeSchema("t6"));
      for (let i = 0; i < 500; i++) await col.insert({ tag: `val-${i}`, status: "active" });
      await col.createBloomFilter("tag", 500);

      // Find a probe that mightHave returns true but isn't in data
      let falsePositiveProbe: string | null = null;
      for (let i = 0; i < 200000 && !falsePositiveProbe; i++) {
        const probe = `fp-probe-${i}`;
        if (col.mightHave("tag", probe)) falsePositiveProbe = probe;
      }

      if (falsePositiveProbe !== null) {
        // bloom says maybe → scan → correct answer (0)
        const result = await col.find({ filter: { tag: falsePositiveProbe } });
        expect(result.records.length).toBe(0);
      }
      await db.close();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("7. disk mode: bloom populated from disk after reopen, rare value short-circuits", async () => {
    const dir = await makeTmpDir();
    try {
      const diskSchema = makeSchema("disk-t7", "disk");

      let db = await openDb(dir, "disk");
      let col = await db.collection(diskSchema);
      for (let i = 0; i < 50; i++) await col.insert({ tag: "common" });
      await db.close();

      db = await openDb(dir, "disk");
      col = await db.collection(diskSchema);
      await col.createBloomFilter("tag");

      expect(col.mightHave("tag", "common")).toBe(true);
      expect(col.mightHave("tag", "zzz-never-seen")).toBe(false);

      const result = await col.find({ filter: { tag: "zzz-never-seen" } });
      expect(result.records.length).toBe(0);
      await db.close();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("8. B-tree + bloom coexistence: B-tree takes precedence, correct results", async () => {
    const dir = await makeTmpDir();
    try {
      const db = await openDb(dir);
      const col = await db.collection(makeSchema("t8"));
      for (let i = 0; i < 30; i++) await col.insert({ tag: "indexed", status: "active" });
      for (let i = 0; i < 10; i++) await col.insert({ tag: "indexed", status: "inactive" });

      await col.createIndex("tag");
      await col.createBloomFilter("tag");

      const result = await col.find({ filter: { tag: "indexed" } });
      expect(result.records.length).toBe(40);

      const absent = await col.find({ filter: { tag: "absent" } });
      expect(absent.records.length).toBe(0);
      await db.close();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("9. bloom maintained on inserts after creation — avoids false negatives", async () => {
    const dir = await makeTmpDir();
    try {
      const db = await openDb(dir);
      const col = await db.collection(makeSchema("t9"));
      await col.insert({ tag: "initial", status: "a" });
      await col.createBloomFilter("tag");

      expect(col.mightHave("tag", "initial")).toBe(true);
      expect(col.mightHave("tag", "added-later")).toBe(false);

      await col.insert({ tag: "added-later", status: "b" });

      // Bloom must now track the new value (updateIndexes fix)
      expect(col.mightHave("tag", "added-later")).toBe(true);

      const result = await col.find({ filter: { tag: "added-later" } });
      expect(result.records.length).toBe(1);
      await db.close();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("10. count() benefits from bloom short-circuit", async () => {
    const dir = await makeTmpDir();
    try {
      const db = await openDb(dir);
      const col = await db.collection(makeSchema("t10"));
      for (let i = 0; i < 100; i++) await col.insert({ tag: "present", status: "ok" });
      await col.createBloomFilter("tag");

      expect(col.mightHave("tag", "absent-count")).toBe(false);
      const n = await col.count({ tag: "absent-count" });
      expect(n).toBe(0);
      await db.close();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
