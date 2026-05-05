/**
 * R7/3a / R8/3 — Atomic rename failure modes, crash recovery, and rollback warn.
 *
 * Uses vi.mock on node:fs/promises to inject rename failures, then verifies:
 *   - Rollback path restores text/ from text.old/ and collection remains queryable.
 *   - Crash-recovery branches in open(): text.old/ present → restore or delete.
 *   - R8/3: when rollback reopen ALSO fails, console.error fires with the collection
 *     name and "text index unavailable", while the original swap error still propagates.
 */

import { vi, describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, access } from "node:fs/promises";
import { TermLog } from "@backloghq/termlog";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDB } from "../src/agentdb.js";
import { defineSchema } from "../src/schema.js";

// ---------------------------------------------------------------------------
// Selective rename mock — only active when _interceptStep2 is true
// ---------------------------------------------------------------------------
let _interceptStep2 = false;

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: vi.fn(async (oldPath: string, newPath: string) => {
      // Intercept step 2 specifically: text.new/ → text/
      // oldPath ends with "text.new", newPath ends with "text" (not "text.old")
      if (
        _interceptStep2 &&
        String(oldPath).endsWith("text.new") &&
        String(newPath).endsWith(join("", "text")) &&
        !String(newPath).endsWith("text.old")
      ) {
        _interceptStep2 = false; // one-shot
        throw Object.assign(
          new Error("ENOTEMPTY: directory not empty"),
          { code: "ENOTEMPTY" },
        );
      }
      return actual.rename(oldPath as string, newPath as string);
    }),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agentdb-atomicity-"));
}

const textSearchSchema = (name: string) =>
  defineSchema({
    name,
    fields: { title: { type: "string" } },
    textSearch: true,
  });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Atomic rename failure modes", () => {
  let dir: string;

  afterEach(async () => {
    _interceptStep2 = false;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("step-2 rename fails → rollback restores text/ from text.old/ → collection remains queryable", async () => {
    dir = await makeTmpDir();
    const N = 15;
    const db = new AgentDB(dir);
    await db.init();
    const col = await db.collection(textSearchSchema("rename-rollback"));
    for (let i = 0; i < N; i++) await col.insert({ title: `document ${i}` });

    // Initial rebuild so there is a valid index in text/
    const initCount = await col.rebuildTextIndex();
    expect(initCount).toBe(N);

    // Verify search works before the failing rebuild
    const before = await col.bm25Search("document");
    expect(before.records.length).toBeGreaterThan(0);

    // Arm the interceptor: the next step-2 rename (text.new → text) will throw
    _interceptStep2 = true;
    await expect(col.rebuildTextIndex()).rejects.toThrow("ENOTEMPTY");

    // text/ must still be accessible — rollback renamed text.old/ back
    const textDir = join(dir, "collections", "rename-rollback", "text");
    await expect(access(textDir)).resolves.toBeUndefined();

    // bm25Search must still work using the restored original index
    const after = await col.bm25Search("document");
    expect(after.records.length).toBeGreaterThan(0);

    await db.close();
  });
});

describe("Crash recovery in open()", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("A: text.old/ present, text/ absent → open() restores text/ from text.old/", async () => {
    dir = await makeTmpDir();
    const N = 12;

    // Session 1: build a collection with a populated text index
    let db = new AgentDB(dir);
    await db.init();
    const schema = textSearchSchema("crash-recovery-a");
    let col = await db.collection(schema);
    for (let i = 0; i < N; i++) await col.insert({ title: `item ${i}` });
    await col.rebuildTextIndex();

    const colDir = join(dir, "collections", "crash-recovery-a");
    const textDir = join(colDir, "text");
    const textOldDir = join(colDir, "text.old");

    // Verify index exists before we corrupt the state
    await expect(access(textDir)).resolves.toBeUndefined();

    await db.close();

    // Simulate crash state: rename text/ → text.old/ (step 1 done, step 2 never happened)
    const { rename: realRename } = await import("node:fs/promises");
    await realRename(textDir, textOldDir);

    // Verify the corrupt state
    await expect(access(textDir)).rejects.toThrow();
    await expect(access(textOldDir)).resolves.toBeUndefined();

    // Session 2: open() must detect text.old/ (no text/) and restore it
    db = new AgentDB(dir);
    await db.init();
    col = await db.collection(schema);

    // After open(), text/ should exist (restored) and text.old/ should be gone
    await expect(access(textDir)).resolves.toBeUndefined();
    await expect(access(textOldDir)).rejects.toThrow();

    // bm25Search must return results from the recovered index
    const results = await col.bm25Search("item");
    expect(results.records.length).toBeGreaterThan(0);

    await db.close();
  });

  it("B: text.old/ and text/ both present → open() removes stale text.old/", async () => {
    dir = await makeTmpDir();
    const N = 10;

    // Session 1: build collection with populated text index
    let db = new AgentDB(dir);
    await db.init();
    const schema = textSearchSchema("crash-recovery-b");
    let col = await db.collection(schema);
    for (let i = 0; i < N; i++) await col.insert({ title: `doc ${i}` });
    await col.rebuildTextIndex();

    const colDir = join(dir, "collections", "crash-recovery-b");
    const textDir = join(colDir, "text");
    const textOldDir = join(colDir, "text.old");

    await db.close();

    // Simulate crash state: step 2 succeeded (text/ has new index) but step 3 (rm text.old/)
    // never ran — create a stale text.old/ alongside the current text/
    await mkdir(textOldDir, { recursive: true });

    await expect(access(textDir)).resolves.toBeUndefined();
    await expect(access(textOldDir)).resolves.toBeUndefined();

    // Session 2: open() must detect both present and remove the stale backup
    db = new AgentDB(dir);
    await db.init();
    col = await db.collection(schema);

    // text/ must still exist; text.old/ must have been cleaned up
    await expect(access(textDir)).resolves.toBeUndefined();
    await expect(access(textOldDir)).rejects.toThrow();

    // bm25Search still works
    const results = await col.bm25Search("doc");
    expect(results.records.length).toBeGreaterThan(0);

    await db.close();
  });
});

describe("R8/3 — rollback reopen failure: console.error fires, original error propagates", () => {
  let dir: string;

  afterEach(async () => {
    _interceptStep2 = false;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("rollback reopen failure logs a named error but the swap error is still thrown", async () => {
    dir = await makeTmpDir();
    const N = 10;
    const db = new AgentDB(dir);
    await db.init();
    const col = await db.collection(textSearchSchema("rollback-reopen-fail"));
    for (let i = 0; i < N; i++) await col.insert({ title: `doc ${i}` });

    // Build an initial index so hadExistingIndex = true in the rebuild
    await col.rebuildTextIndex();

    // Spy on console.error — capture it so we can assert the message without noise
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Spy on TermLog.open: fail only when it is called for the rollback-reopen path
    // (dir ends with "/text", NOT "/text.new" or "/text.old"). The mock uses a flag so it
    // triggers exactly once, at the rollback reopen, not at the rebuild's newIdx open.
    let _failRollbackReopen = false;
    const origOpen = (TermLog as unknown as { open: (opts: Record<string, unknown>) => Promise<TermLog> }).open;
    const openSpy = vi.spyOn(TermLog as unknown as { open: (opts: Record<string, unknown>) => Promise<TermLog> }, "open")
      .mockImplementation(async (opts: Record<string, unknown>) => {
        const d = String(opts.dir ?? "");
        if (_failRollbackReopen && d.endsWith("text") && !d.endsWith("text.new") && !d.endsWith("text.old")) {
          _failRollbackReopen = false;
          throw new Error("simulated rollback-reopen ENOENT");
        }
        return origOpen.call(TermLog, opts);
      });

    try {
      // Arm both failure modes simultaneously
      _interceptStep2 = true;
      _failRollbackReopen = true;

      const swapErr = await col.rebuildTextIndex().catch((e: unknown) => e);

      // Original swap error (ENOTEMPTY from the mocked step-2 rename) must propagate
      expect(swapErr).toBeInstanceOf(Error);
      expect((swapErr as Error).message).toContain("ENOTEMPTY");

      // console.error must have been called with the rollback-reopen diagnostic
      const errCall = errorSpy.mock.calls.find(
        (args) => typeof args[0] === "string" && args[0].includes("rollback reopen failed"),
      );
      expect(errCall).toBeDefined();
      // Must name the collection so operators know which collection lost its text index
      expect(errCall![0]).toContain("rollback-reopen-fail");
      // Must advise that the index is unavailable until next rebuild
      expect(errCall![0]).toContain("text index unavailable");
    } finally {
      openSpy.mockRestore();
      errorSpy.mockRestore();
    }

    await db.close();
  });
});
