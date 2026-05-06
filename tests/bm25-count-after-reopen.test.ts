/**
 * Regression: `bm25DocCount` must not inflate when `ensureDiskIndexesLoaded`
 * fires in a same-session bm25Search after WAL-replayed records are present.
 *
 * Bug (pre-2.1.1): `Collection.open()` correctly skipped WAL-replay add when
 * termlog segments already existed on disk, but `_textIdxLoaded` was still
 * false. The first `bm25Search` (or `search`/`$text`) in the same session ran
 * `ensureDiskIndexesLoaded()` which unconditionally re-added every WAL record.
 * Each re-add tombstoned the old numId and allocated a fresh one — bloating
 * segments and roughly doubling `bm25DocCount`.
 *
 * Trigger: insert N → bm25Search → close → reopen. The inflation persists in
 * segments after close, so the post-reopen metric reads ~2N.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDB } from "../src/agentdb.js";
import { defineSchema } from "../src/schema.js";

describe("bm25DocCount stability when ensureDiskIndexesLoaded fires", () => {
  it("stays at N after insert+bm25Search+close+reopen (no 2× inflation)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bm25-count-"));
    const N = 5_000;
    const schema = defineSchema({
      description: "test",
      fields: {
        _id: { type: "string" },
        text: { type: "string", searchable: true },
      },
    });

    // Phase 1: insert N, run bm25Search in same session (this triggers
    // ensureDiskIndexesLoaded → without the fix, re-adds all WAL records),
    // then close.
    {
      const db = await AgentDB.open(dir, { storageMode: "disk" });
      const col = await db.collection("docs", { textSearch: true, schema });
      const records = Array.from({ length: N }, (_, i) => ({
        _id: `doc-${i}`,
        text: `lorem ipsum doc ${i} alpha beta`,
      }));
      await col.insertMany(records);
      const r = await col.bm25Search("alpha");
      expect(r.records.length).toBeGreaterThan(0);
      // Without the fix, ensureDiskIndexesLoaded inflated the index here.
      expect(col.metrics().bm25DocCount).toBe(N);
      await db.close();
    }

    // Phase 2: reopen — verify the persisted segment state didn't carry
    // inflated counts forward.
    {
      const db = await AgentDB.open(dir, { storageMode: "disk" });
      const col = await db.collection("docs", { textSearch: true, schema });
      expect(col.metrics().bm25DocCount).toBe(N);
      await db.close();
    }

    await rm(dir, { recursive: true, force: true });
  });

  it("search() (AND-semantics) trigger has the same fix coverage", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bm25-count-"));
    const N = 5_000;
    const schema = defineSchema({
      description: "test",
      fields: {
        _id: { type: "string" },
        text: { type: "string", searchable: true },
      },
    });

    {
      const db = await AgentDB.open(dir, { storageMode: "disk" });
      const col = await db.collection("docs", { textSearch: true, schema });
      await col.insertMany(
        Array.from({ length: N }, (_, i) => ({ _id: `d-${i}`, text: `lorem ${i} alpha` })),
      );
      // search() also calls ensureDiskIndexesLoaded — both bm25Search and
      // search must be guarded against the WAL-replay re-add. We don't assert
      // search result content here, only that calling it didn't inflate the
      // index.
      await col.search("alpha");
      expect(col.metrics().bm25DocCount).toBe(N);
      await db.close();
    }

    {
      const db = await AgentDB.open(dir, { storageMode: "disk" });
      const col = await db.collection("docs", { textSearch: true, schema });
      expect(col.metrics().bm25DocCount).toBe(N);
      await db.close();
    }

    await rm(dir, { recursive: true, force: true });
  });
});
