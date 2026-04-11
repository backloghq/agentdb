import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDB } from "../src/agentdb.js";

describe("write modes", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agentdb-wm-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("group commit", () => {
    it("inserts are buffered and persist after close/reopen", async () => {
      const db = new AgentDB(tmpDir, { writeMode: "group" });
      await db.init();

      const col = await db.collection("items");
      await col.insert({ _id: "g1", value: "alpha" });
      await col.insert({ _id: "g2", value: "beta" });
      await col.insert({ _id: "g3", value: "gamma" });

      expect(await col.count()).toBe(3);
      expect((await col.findOne("g1"))?.value).toBe("alpha");
      await db.close();

      // Reopen with default (immediate) mode to verify persistence
      const db2 = new AgentDB(tmpDir);
      await db2.init();
      const col2 = await db2.collection("items");
      expect(await col2.count()).toBe(3);
      expect((await col2.findOne("g1"))?.value).toBe("alpha");
      expect((await col2.findOne("g2"))?.value).toBe("beta");
      expect((await col2.findOne("g3"))?.value).toBe("gamma");
      await db2.close();
    });

    it("supports updates and deletes with group commit", async () => {
      const db = new AgentDB(tmpDir, { writeMode: "group" });
      await db.init();

      const col = await db.collection("items");
      await col.insert({ _id: "u1", value: "original" });
      await col.update({ _id: "u1" }, { $set: { value: "updated" } });
      await col.insert({ _id: "u2", value: "to-delete" });
      await col.remove({ _id: "u2" });

      expect((await col.findOne("u1"))?.value).toBe("updated");
      expect(await col.findOne("u2")).toBeUndefined();
      await db.close();

      // Verify persistence
      const db2 = new AgentDB(tmpDir);
      await db2.init();
      const col2 = await db2.collection("items");
      expect((await col2.findOne("u1"))?.value).toBe("updated");
      expect(await col2.findOne("u2")).toBeUndefined();
      await db2.close();
    });

    it("respects custom groupCommitSize and groupCommitMs", async () => {
      const db = new AgentDB(tmpDir, {
        writeMode: "group",
        groupCommitSize: 2,
        groupCommitMs: 50,
      });
      await db.init();

      const col = await db.collection("items");
      for (let i = 0; i < 10; i++) {
        await col.insert({ _id: `c${i}`, idx: i });
      }

      expect(await col.count()).toBe(10);
      await db.close();

      const db2 = new AgentDB(tmpDir);
      await db2.init();
      const col2 = await db2.collection("items");
      expect(await col2.count()).toBe(10);
      for (let i = 0; i < 10; i++) {
        expect((await col2.findOne(`c${i}`))?.idx).toBe(i);
      }
      await db2.close();
    });
  });

  describe("async mode", () => {
    it("inserts return fast and persist after close/reopen", async () => {
      const db = new AgentDB(tmpDir, { writeMode: "async" });
      await db.init();

      const col = await db.collection("items");
      await col.insert({ _id: "a1", value: "one" });
      await col.insert({ _id: "a2", value: "two" });

      expect(await col.count()).toBe(2);
      expect((await col.findOne("a1"))?.value).toBe("one");
      await db.close();

      const db2 = new AgentDB(tmpDir);
      await db2.init();
      const col2 = await db2.collection("items");
      expect(await col2.count()).toBe(2);
      expect((await col2.findOne("a1"))?.value).toBe("one");
      expect((await col2.findOne("a2"))?.value).toBe("two");
      await db2.close();
    });

    it("supports batch insert in async mode", async () => {
      const db = new AgentDB(tmpDir, { writeMode: "async" });
      await db.init();

      const col = await db.collection("items");
      const docs = Array.from({ length: 20 }, (_, i) => ({
        _id: `b${i}`,
        idx: i,
      }));
      await col.insertMany(docs);

      expect(await col.count()).toBe(20);
      await db.close();

      const db2 = new AgentDB(tmpDir);
      await db2.init();
      const col2 = await db2.collection("items");
      expect(await col2.count()).toBe(20);
      expect((await col2.findOne("b0"))?.idx).toBe(0);
      expect((await col2.findOne("b19"))?.idx).toBe(19);
      await db2.close();
    });
  });

  describe("multi-writer fallback", () => {
    it("group mode with agentId still persists data", async () => {
      // When agentId is set, opslog may downgrade to immediate writes
      // but the data should still be correct
      const db = new AgentDB(tmpDir, {
        writeMode: "group",
        agentId: "agent-1",
      });
      await db.init();

      const col = await db.collection("items");
      await col.insert({ _id: "m1", value: "multi-group" });
      await col.insert({ _id: "m2", value: "multi-group-2" });

      expect(await col.count()).toBe(2);
      await db.close();

      const db2 = new AgentDB(tmpDir, { agentId: "agent-1" });
      await db2.init();
      const col2 = await db2.collection("items");
      expect(await col2.count()).toBe(2);
      expect((await col2.findOne("m1"))?.value).toBe("multi-group");
      await db2.close();
    });

    it("async mode with agentId still persists data", async () => {
      const db = new AgentDB(tmpDir, {
        writeMode: "async",
        agentId: "agent-2",
      });
      await db.init();

      const col = await db.collection("items");
      await col.insert({ _id: "ma1", value: "multi-async" });
      await col.insert({ _id: "ma2", value: "multi-async-2" });

      expect(await col.count()).toBe(2);
      await db.close();

      const db2 = new AgentDB(tmpDir, { agentId: "agent-2" });
      await db2.init();
      const col2 = await db2.collection("items");
      expect(await col2.count()).toBe(2);
      expect((await col2.findOne("ma1"))?.value).toBe("multi-async");
      await db2.close();
    });
  });

  describe("immediate mode (default)", () => {
    it("works as baseline comparison", async () => {
      const db = new AgentDB(tmpDir, { writeMode: "immediate" });
      await db.init();

      const col = await db.collection("items");
      await col.insert({ _id: "i1", value: "immediate" });
      expect(await col.count()).toBe(1);
      await db.close();

      const db2 = new AgentDB(tmpDir, { writeMode: "immediate" });
      await db2.init();
      const col2 = await db2.collection("items");
      expect(await col2.count()).toBe(1);
      expect((await col2.findOne("i1"))?.value).toBe("immediate");
      await db2.close();
    });
  });
});
