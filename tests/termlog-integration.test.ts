/**
 * Phase 3 smoke test: Collection ↔ TermLog wiring.
 * Verifies that text indexing works end-to-end with termlog as the backend.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Collection } from "../src/collection.js";
import { Store } from "@backloghq/opslog";
import type { StoredRecord } from "../src/collection.js";

let dir: string;
let col: Collection;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agentdb-termlog-"));
  const store = new Store<StoredRecord>();
  col = new Collection("smoke", store, { textSearch: true });
  await col.open(dir);
});

afterEach(async () => {
  try { await col.close(); } catch { /* already closed */ }
  await rm(dir, { recursive: true, force: true });
});

describe("Collection ↔ TermLog wiring", () => {
  it("inserts 5 docs and docCount() reflects them after flush", async () => {
    for (let i = 0; i < 5; i++) {
      await col.insert({ title: `document ${i}`, body: `unique token token${i}` });
    }
    const tl = col.getTextIndex()!;
    await tl.flush();
    expect(tl.docCount()).toBe(5);
  });

  it("search() returns matching docs (AND semantics, case-insensitive)", async () => {
    await col.insert({ _id: "a", title: "quick brown fox" });
    await col.insert({ _id: "b", title: "quick lazy dog" });
    await col.insert({ _id: "c", title: "completely different" });

    const result = await col.search("quick fox");
    expect(result.total).toBe(1);
    expect(result.records[0]._id).toBe("a");
  });

  it("search() returns 0 results for a term not in any doc", async () => {
    await col.insert({ _id: "a", title: "hello world" });
    const result = await col.search("xyznotpresent");
    expect(result.total).toBe(0);
  });

  it("remove() excludes the deleted doc from search results", async () => {
    await col.insert({ _id: "a", title: "shared term" });
    await col.insert({ _id: "b", title: "shared term" });

    let result = await col.search("shared");
    expect(result.total).toBe(2);

    await col.remove({ _id: "a" });

    result = await col.search("shared");
    expect(result.total).toBe(1);
    expect(result.records[0]._id).toBe("b");
  });

  it("close + reopen preserves the text index", async () => {
    await col.insert({ _id: "persisted", title: "persist this token" });
    await col.close();

    const store2 = new Store<StoredRecord>();
    const col2 = new Collection("smoke", store2, { textSearch: true });
    await col2.open(dir);

    const result = await col2.search("persist");
    expect(result.total).toBeGreaterThanOrEqual(1);
    expect(result.records.some((r) => r._id === "persisted")).toBe(true);
    await col2.close();
  });

  it("estimatedBytes() returns a positive number after inserts", async () => {
    for (let i = 0; i < 20; i++) {
      await col.insert({ title: `document ${i}`, body: `content ${i} extra words here` });
    }
    await col.getTextIndex()!.flush();
    const bytes = col.getTextIndex()!.estimatedBytes();
    expect(bytes).toBeGreaterThan(0);
  });
});
