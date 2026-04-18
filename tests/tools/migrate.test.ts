import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDB } from "../../src/agentdb.js";
import { defineSchema } from "../../src/schema.js";
import { getTools } from "../../src/tools/index.js";
import type { AgentTool } from "../../src/tools/index.js";

describe("Tool Definitions — migrate", () => {
  let tmpDir: string;
  let db: AgentDB;
  let tools: AgentTool[];

  function tool(name: string): AgentTool {
    const t = tools.find((t) => t.name === name);
    if (!t) throw new Error(`Tool '${name}' not found`);
    return t;
  }

  async function exec(name: string, args: Record<string, unknown> = {}) {
    const t = tool(name);
    const result = await t.execute(args);
    if (result.isError) throw new Error(result.content[0].text);
    return JSON.parse(result.content[0].text);
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agentdb-tools-"));
    db = new AgentDB(tmpDir);
    await db.init();
    tools = getTools(db);
  });

  afterEach(async () => {
    await db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("db_migrate", () => {
    it("101 ops returns a Zod validation error", async () => {
      const ops = Array.from({ length: 101 }, (_, i) => ({ op: "set", field: `f${i}`, value: i }));
      const t = tool("db_migrate");
      const result = await t.execute({ collection: "migrate-ops-cap", ops });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/100/);
    });

    it("set op assigns a field on all records", async () => {
      await exec("db_insert", { collection: "migrate-set", records: [
        { name: "Alice" }, { name: "Bob" },
      ] });
      const result = await exec("db_migrate", {
        collection: "migrate-set",
        ops: [{ op: "set", field: "active", value: true }],
      });
      expect(result.scanned).toBe(2);
      expect(result.updated).toBe(2);
      expect(result.unchanged).toBe(0);
      expect(result.failed).toBe(0);
      const records = await exec("db_find", { collection: "migrate-set" });
      expect(records.records.every((r: Record<string, unknown>) => r.active === true)).toBe(true);
    });

    it("unset op removes a field", async () => {
      await exec("db_insert", { collection: "migrate-unset", records: [
        { name: "Alice", deprecated: "old" }, { name: "Bob", deprecated: "old" },
      ] });
      const result = await exec("db_migrate", {
        collection: "migrate-unset",
        ops: [{ op: "unset", field: "deprecated" }],
      });
      expect(result.updated).toBe(2);
      const records = await exec("db_find", { collection: "migrate-unset" });
      expect(records.records.every((r: Record<string, unknown>) => !("deprecated" in r))).toBe(true);
    });

    it("rename op moves field value and removes source", async () => {
      await exec("db_insert", { collection: "migrate-rename", records: [{ status: "active" }] });
      await exec("db_migrate", {
        collection: "migrate-rename",
        ops: [{ op: "rename", from: "status", to: "state" }],
      });
      const records = await exec("db_find", { collection: "migrate-rename" });
      expect(records.records[0].state).toBe("active");
      expect("status" in records.records[0]).toBe(false);
    });

    it("default op sets field only if missing", async () => {
      await exec("db_insert", { collection: "migrate-default", records: [
        { priority: "high" }, { name: "NoPriority" },
      ] });
      const result = await exec("db_migrate", {
        collection: "migrate-default",
        ops: [{ op: "default", field: "priority", value: "medium" }],
      });
      expect(result.updated).toBe(1);
      expect(result.unchanged).toBe(1);
      const records = await exec("db_find", { collection: "migrate-default" });
      const withHigh = records.records.find((r: Record<string, unknown>) => r.name === undefined || r.priority === "high");
      expect(withHigh?.priority).toBe("high");
    });

    it("copy op copies field without removing source", async () => {
      await exec("db_insert", { collection: "migrate-copy", records: [{ first: "Alice" }] });
      await exec("db_migrate", {
        collection: "migrate-copy",
        ops: [{ op: "copy", from: "first", to: "displayName" }],
      });
      const records = await exec("db_find", { collection: "migrate-copy" });
      expect(records.records[0].first).toBe("Alice");
      expect(records.records[0].displayName).toBe("Alice");
    });

    it("dryRun:true returns counts without writing", async () => {
      await exec("db_insert", { collection: "migrate-dry", records: [{ x: 1 }, { x: 2 }] });
      const result = await exec("db_migrate", {
        collection: "migrate-dry",
        ops: [{ op: "set", field: "x", value: 99 }],
        dryRun: true,
      });
      expect(result.dryRun).toBe(true);
      expect(result.updated).toBe(2);
      const records = await exec("db_find", { collection: "migrate-dry" });
      expect(records.records[0].x).not.toBe(99);
    });

    it("filter scopes migration to matching records", async () => {
      await exec("db_insert", { collection: "migrate-filter", records: [
        { role: "admin" }, { role: "user" }, { role: "user" },
      ] });
      const result = await exec("db_migrate", {
        collection: "migrate-filter",
        ops: [{ op: "set", field: "flagged", value: true }],
        filter: { role: "user" },
      });
      expect(result.scanned).toBe(2);
      expect(result.updated).toBe(2);
      const records = await exec("db_find", { collection: "migrate-filter" });
      const admin = records.records.find((r: Record<string, unknown>) => r.role === "admin");
      expect(admin?.flagged).toBeUndefined();
    });

    it("batchSize controls in-memory chunk size across multi-batch collection", async () => {
      const records = Array.from({ length: 5 }, (_, i) => ({ n: i }));
      await exec("db_insert", { collection: "migrate-batch", records });
      const result = await exec("db_migrate", {
        collection: "migrate-batch",
        ops: [{ op: "set", field: "migrated", value: true }],
        batchSize: 2,
      });
      expect(result.scanned).toBe(5);
      expect(result.updated).toBe(5);
    });

    it("per-record error lands in errors[] (truncated to 10)", async () => {
      // Use a code-level schema (defineSchema) to enable runtime validation
      await db.collection(defineSchema({
        name: "migrate-fail",
        fields: { score: { type: "number", max: 100 } },
      }));
      await exec("db_insert", { collection: "migrate-fail", records: [
        { score: 50 }, { score: 60 },
      ] });
      // Set score to 200 — violates max:100 schema constraint
      const result = await exec("db_migrate", {
        collection: "migrate-fail",
        ops: [{ op: "set", field: "score", value: 200 }],
      });
      expect(result.failed).toBe(2);
      expect(result.errors).toHaveLength(2);
      expect(result.errors[0].error).toMatch(/200|max|score/i);
    });

    it("agent and reason are stamped on updated records", async () => {
      await exec("db_insert", { collection: "migrate-agent", records: [{ x: 1 }] });
      const ids = (await exec("db_find", { collection: "migrate-agent" })).records.map((r: Record<string, unknown>) => r._id);
      await exec("db_migrate", {
        collection: "migrate-agent",
        ops: [{ op: "set", field: "x", value: 2 }],
        agent: "migration-bot",
        reason: "test migration",
      });
      const hist = await exec("db_history", { collection: "migrate-agent", id: ids[0] as string });
      const ops = hist.operations;
      const lastOp = ops[ops.length - 1];
      expect(lastOp.data._agent).toBe("migration-bot");
      expect(lastOp.data._reason).toBe("test migration");
    });

    it("_version optimistic locking causes concurrent write to fail", async () => {
      await exec("db_insert", { collection: "migrate-version", records: [{ x: 1 }] });
      // Get the record's ID
      const findRes = await exec("db_find", { collection: "migrate-version" });
      const id = findRes.records[0]._id as string;
      // Simulate concurrent write: bump _version before migrate runs
      // We'll do this by patching update to fail via expectedVersion check
      // Actually: insert + update (to bump version) + then dryRun migrate won't help
      // So instead: run migrate twice — first succeeds, second on same record gets new _version
      // Simpler: grab collection directly and update the record to bump version
      const col = await db.collection("migrate-version");
      await col.update({ _id: id } as import("../../src/collection-helpers.js").Filter, { $set: { bumped: true } });
      // Now migrate with an old expectedVersion will fail
      // We simulate by calling update directly with wrong expectedVersion
      let threw = false;
      try {
        await col.update({ _id: id } as import("../../src/collection-helpers.js").Filter, { $set: { x: 99 } }, { expectedVersion: 0 });
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    });

    it("empty ops array returns an error", async () => {
      const t = tool("db_migrate");
      const result = await t.execute({ collection: "migrate-empty", ops: [] });
      expect(result.isError).toBe(true);
    });

    it("__proto__ set op is silently skipped (prototype-pollution guard)", async () => {
      await exec("db_insert", { collection: "migrate-proto", records: [{ x: 1 }] });
      const result = await exec("db_migrate", {
        collection: "migrate-proto",
        ops: [{ op: "set", field: "__proto__", value: { polluted: true } }],
      });
      // Record is not updated (no user-visible diff) — unchanged, not failed
      expect(result.unchanged).toBe(1);
      expect(result.updated).toBe(0);
      // The prototype of the retrieved record should not be polluted
      const found = await exec("db_find", { collection: "migrate-proto" });
      const record = found.records[0];
      expect((record as Record<string, unknown>).polluted).toBeUndefined();
      expect(Object.getPrototypeOf(record)).toBe(Object.getPrototypeOf({}));
    });

    it("constructor and prototype set ops are silently skipped", async () => {
      await exec("db_insert", { collection: "migrate-proto2", records: [{ x: 1 }] });
      const result = await exec("db_migrate", {
        collection: "migrate-proto2",
        ops: [
          { op: "set", field: "constructor", value: "evil" },
          { op: "set", field: "prototype", value: { bad: true } },
        ],
      });
      expect(result.unchanged).toBe(1);
      expect(result.updated).toBe(0);
    });

    it("processes all records even when ops cause records to leave the filter (pagination regression)", async () => {
      // 200 records with x:0; filter={x:0}; op sets x=1 (records leave filter after update)
      // Old offset-based code: batch 1 processes 100, they leave filter, batch 2 at offset=100 finds 0 → skips 100
      // New snapshot code: all 200 IDs captured upfront, all 200 processed
      const records = Array.from({ length: 200 }, (_, i) => ({ n: i, x: 0 }));
      await exec("db_insert", { collection: "migrate-pagereg", records });
      const result = await exec("db_migrate", {
        collection: "migrate-pagereg",
        ops: [{ op: "set", field: "x", value: 1 }],
        filter: { x: 0 },
        batchSize: 100,
      });
      expect(result.scanned).toBe(200);
      expect(result.updated).toBe(200);
      expect(result.failed).toBe(0);
    });

    it("change events fire for each updated record", async () => {
      await exec("db_insert", { collection: "migrate-events", records: [{ n: 1 }, { n: 2 }, { n: 3 }] });
      const col = await db.collection("migrate-events");
      let updateCount = 0;
      const listener = (e: import("../../src/collection.js").ChangeEvent) => {
        if (e.type === "update") updateCount += e.ids.length;
      };
      col.on("change", listener);
      await exec("db_migrate", {
        collection: "migrate-events",
        ops: [{ op: "set", field: "migrated", value: true }],
      });
      col.off("change", listener);
      expect(updateCount).toBe(3);
    });

    it("concurrent write between snapshot and processing lands in failed[]", async () => {
      await exec("db_insert", { collection: "migrate-conc", records: [{ x: 1 }, { x: 1 }] });
      const col = await db.collection("migrate-conc");
      const findRes = (await exec("db_find", { collection: "migrate-conc" })).records as Array<Record<string, unknown>>;
      const idB = findRes[1]._id as string;

      // Patch col.update: on first call, bump record B's version to simulate a concurrent write
      const origUpdate = col.update.bind(col);
      let firstCall = true;
      (col as unknown as { update: unknown }).update = async (...args: Parameters<typeof col.update>) => {
        if (firstCall) {
          firstCall = false;
          await origUpdate({ _id: idB } as import("../../src/collection-helpers.js").Filter, { $set: { bumped: true } });
        }
        return origUpdate(...args);
      };

      const result = await exec("db_migrate", {
        collection: "migrate-conc",
        ops: [{ op: "set", field: "x", value: 2 }],
      });

      // Restore
      (col as unknown as { update: unknown }).update = origUpdate;

      expect(result.failed).toBeGreaterThanOrEqual(1);
      expect(result.errors.length).toBeGreaterThanOrEqual(1);
      expect(result.errors[0].error).toMatch(/version/i);
    });

    it("errors[] is capped at 10 even with more than 10 failures", async () => {
      await db.collection(defineSchema({
        name: "migrate-errcap",
        fields: { score: { type: "number", max: 100 } },
      }));
      const records = Array.from({ length: 15 }, (_, i) => ({ score: i * 5 }));
      await exec("db_insert", { collection: "migrate-errcap", records });
      const result = await exec("db_migrate", {
        collection: "migrate-errcap",
        ops: [{ op: "set", field: "score", value: 200 }],
      });
      expect(result.failed).toBe(15);
      expect(result.errors).toHaveLength(10);
    });

    it("set op targeting a protected field (_agent) is silently skipped", async () => {
      await exec("db_insert", { collection: "migrate-prot", records: [{ name: "Alice" }] });
      const result = await exec("db_migrate", {
        collection: "migrate-prot",
        ops: [{ op: "set", field: "_agent", value: "evil-bot" }],
      });
      expect(result.unchanged).toBe(1);
      expect(result.updated).toBe(0);
    });

    it("record deleted between snapshot and processing lands in failed[] with descriptive error", async () => {
      // Phase 1 (snapshot) sees 2 records. We delete one after inserting but before migrate runs.
      // Phase 2's $in lookup won't find the deleted record → it lands in failed[].
      await exec("db_insert", { collection: "migrate-deleted", records: [{ x: 1 }, { x: 2 }] });
      const col = await db.collection("migrate-deleted");
      const findRes = (await exec("db_find", { collection: "migrate-deleted" })).records as Array<Record<string, unknown>>;
      const idToDelete = findRes[0]._id as string;

      // Patch col.find: snapshot phase returns both records, but delete the record after snapshot
      const origFind = col.find.bind(col);
      let snapshotDone = false;
      (col as unknown as { find: unknown }).find = async (...args: Parameters<typeof col.find>) => {
        const result = await origFind(...args);
        if (!snapshotDone) {
          snapshotDone = true;
          // After snapshot is built, delete one record to simulate mid-migration deletion
          await col.deleteById(idToDelete);
        }
        return result;
      };

      const result = await exec("db_migrate", {
        collection: "migrate-deleted",
        ops: [{ op: "set", field: "x", value: 99 }],
      });

      (col as unknown as { find: unknown }).find = origFind;

      expect(result.scanned).toBe(2);
      expect(result.failed).toBe(1);
      expect(result.updated).toBe(1);
      expect(result.errors[0].id).toBe(idToDelete);
      expect(result.errors[0].error).toBe("record deleted before migration");
    });

    it("errors[] is capped at 10 with mixed deletion and validation failures", async () => {
      // 13 records total: 5 will be deleted after snapshot, 8 will fail validation
      await db.collection(defineSchema({
        name: "migrate-errors-cap",
        fields: { score: { type: "number", max: 100 } },
      }));
      await exec("db_insert", {
        collection: "migrate-errors-cap",
        records: Array.from({ length: 13 }, (_, i) => ({ score: 50 + i })),
      });
      const col = await db.collection("migrate-errors-cap");
      const findRes = (await exec("db_find", { collection: "migrate-errors-cap" })).records as Array<Record<string, unknown>>;
      const idsToDelete = findRes.slice(0, 5).map((r) => r._id as string);

      // Patch col.find: after snapshot phase completes, delete 5 records
      const origFind = col.find.bind(col);
      let snapshotDone = false;
      (col as unknown as { find: unknown }).find = async (...args: Parameters<typeof col.find>) => {
        const result = await origFind(...args);
        if (!snapshotDone) {
          snapshotDone = true;
          for (const id of idsToDelete) {
            await col.deleteById(id);
          }
        }
        return result;
      };

      const result = await exec("db_migrate", {
        collection: "migrate-errors-cap",
        ops: [{ op: "set", field: "score", value: 200 }],
      });

      (col as unknown as { find: unknown }).find = origFind;

      expect(result.scanned).toBe(13);
      expect(result.failed).toBe(13);
      expect(result.updated).toBe(0);
      expect(result.errors).toHaveLength(10);
      expect(result.errors.some((e: { error: string }) => e.error === "record deleted before migration")).toBe(true);
      expect(result.errors.some((e: { error: string }) => /200|max|score/i.test(e.error))).toBe(true);
    });
  });
});
