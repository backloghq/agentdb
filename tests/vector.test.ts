import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@backloghq/opslog";
import { Collection } from "../src/collection.js";

describe("Explicit Vector API", () => {
  let tmpDir: string;
  let store: Store<Record<string, unknown>>;
  let col: Collection;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agentdb-vec-"));
    store = new Store<Record<string, unknown>>();
    col = new Collection("test", store);
    await col.open(tmpDir, { checkpointThreshold: 1000 });
  });

  afterEach(async () => {
    await col.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("insertVector", () => {
    it("stores a vector and retrieves it via searchByVector", async () => {
      await col.insertVector("a", [1, 0, 0], { label: "x-axis" });
      await col.insertVector("b", [0, 1, 0], { label: "y-axis" });
      await col.insertVector("c", [0, 0, 1], { label: "z-axis" });

      const result = await col.searchByVector([1, 0, 0], { limit: 3 });
      expect(result.records.length).toBe(3);
      expect(result.records[0].label).toBe("x-axis");
      expect(result.scores[0]).toBeGreaterThan(result.scores[1]);
    });

    it("rejects dimension mismatch", async () => {
      await col.insertVector("a", [1, 0, 0]);
      await expect(col.insertVector("b", [1, 0])).rejects.toThrow("dimension mismatch");
    });

    it("rejects empty vector", async () => {
      await expect(col.insertVector("a", [])).rejects.toThrow("non-empty");
    });

    it("upserts on duplicate id", async () => {
      await col.insertVector("a", [1, 0, 0], { v: 1 });
      await col.insertVector("a", [0, 1, 0], { v: 2 });

      const record = await col.findOne("a");
      expect(record?.v).toBe(2);

      const result = await col.searchByVector([0, 1, 0], { limit: 1 });
      expect(result.records[0]._id).toBe("a");
    });

    it("persists across close/reopen", async () => {
      await col.insertVector("a", [1, 0, 0], { label: "test" });
      await col.close();

      store = new Store<Record<string, unknown>>();
      col = new Collection("test", store);
      await col.open(tmpDir, { checkpointThreshold: 1000 });

      const result = await col.searchByVector([1, 0, 0], { limit: 1 });
      expect(result.records.length).toBe(1);
      expect(result.records[0].label).toBe("test");
    });

    it("metadata fields visible on read but vector bytes hidden", async () => {
      await col.insertVector("a", [1, 0, 0], { label: "test", score: 42 });
      const record = await col.findOne("a");
      expect(record?.label).toBe("test");
      expect(record?.score).toBe(42);
      expect(record?._embedding).toBeUndefined();
    });
  });

  describe("searchByVector", () => {
    beforeEach(async () => {
      await col.insertVector("a", [1, 0, 0], { role: "admin" });
      await col.insertVector("b", [0, 1, 0], { role: "user" });
      await col.insertVector("c", [0.9, 0.1, 0], { role: "admin" });
    });

    it("throws when no vectors exist", async () => {
      const emptyStore = new Store<Record<string, unknown>>();
      const emptyCol = new Collection("empty", emptyStore);
      const emptyDir = await mkdtemp(join(tmpdir(), "agentdb-vec-empty-"));
      await emptyCol.open(emptyDir, { checkpointThreshold: 1000 });

      await expect(emptyCol.searchByVector([1, 0, 0])).rejects.toThrow("not available");

      await emptyCol.close();
      await rm(emptyDir, { recursive: true, force: true });
    });

    it("validates query dimension", async () => {
      await expect(col.searchByVector([1, 0])).rejects.toThrow("dimension mismatch");
    });

    it("respects limit", async () => {
      const result = await col.searchByVector([1, 0, 0], { limit: 2 });
      expect(result.records.length).toBe(2);
    });

    it("applies attribute filter", async () => {
      const result = await col.searchByVector([1, 0, 0], { filter: { role: "admin" }, limit: 10 });
      expect(result.records.length).toBe(2);
      expect(result.records.every((r) => r.role === "admin")).toBe(true);
    });

    it("returns scores in descending order", async () => {
      const result = await col.searchByVector([1, 0, 0], { limit: 3 });
      for (let i = 1; i < result.scores.length; i++) {
        expect(result.scores[i - 1]).toBeGreaterThanOrEqual(result.scores[i]);
      }
    });
  });
});
