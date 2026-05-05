/**
 * Phase 5 smoke tests: LegacyTextIndexError detection and rebuildTextIndex fix path.
 *
 * Covers all four open() states:
 *   1. legacy-only  → LegacyTextIndexError thrown
 *   2. termlog-only → no error, search works
 *   3. both         → legacy blob deleted, no error, search works
 *   4. neither      → no error (fresh collection)
 *
 * Plus the rebuild flow and db_rebuild_text_index tool.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDB } from "../src/agentdb.js";
import { LegacyTextIndexError } from "../src/collection.js";
import { defineSchema } from "../src/schema.js";
import { getTools } from "../src/tools/index.js";

const schema = defineSchema({
  name: "docs",
  textSearch: true,
  fields: { title: { type: "string", searchable: true } },
});

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agentdb-legacy-"));
}

// Write a minimal v1.4 text-index.json blob at the expected path for a collection.
// AgentDB stores collections at <dbDir>/collections/<name>/
// The blob lives at <collectionDir>/indexes/text-index.json.
async function writeLegacyBlob(dbDir: string, collectionName: string): Promise<void> {
  const indexesDir = join(dbDir, "collections", collectionName, "indexes");
  await mkdir(indexesDir, { recursive: true });
  const legacyContent = JSON.stringify({ version: 1, docs: {}, idf: {} });
  await writeFile(join(indexesDir, "text-index.json"), legacyContent, "utf-8");
}

// Returns the collection directory path within the AgentDB directory structure.
function collectionDir(dbDir: string, collectionName: string): string {
  return join(dbDir, "collections", collectionName);
}

describe("LegacyTextIndexError — open() state detection", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await makeTmpDir();
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("state 1 (legacy-only): throws LegacyTextIndexError with correct legacyPath", async () => {
    // Create the collection without textSearch first (just to init the dir structure),
    // then write the legacy blob and reopen with textSearch: true.
    const db = new AgentDB(baseDir);
    await db.init();
    const plainSchema = defineSchema({ name: "docs", fields: { title: { type: "string" } } });
    const colNoSearch = await db.collection(plainSchema);
    await colNoSearch.insert({ _id: "x", title: "hello" });
    await db.close();

    // Write legacy blob into the collection's indexes dir
    await writeLegacyBlob(baseDir, "docs");

    // Reopen with textSearch: true — must throw LegacyTextIndexError
    const db2 = new AgentDB(baseDir);
    await db2.init();
    let thrown: unknown = null;
    try {
      await db2.collection(schema);
    } catch (e) {
      thrown = e;
    } finally {
      await db2.close().catch(() => {});
    }

    expect(thrown).toBeInstanceOf(LegacyTextIndexError);
    expect((thrown as LegacyTextIndexError).legacyPath).toContain("text-index.json");
    expect((thrown as LegacyTextIndexError).message).toContain("v1.4 text index detected");
    expect((thrown as LegacyTextIndexError).message).toContain("rebuildTextIndex");
  });

  it("state 2 (termlog-only): no error, search works", async () => {
    const db = new AgentDB(baseDir);
    await db.init();
    const col = await db.collection(schema);
    await col.insert({ _id: "a", title: "typescript guide" });
    await db.close();

    // Reopen — termlog manifest exists, no legacy blob → clean open
    const db2 = new AgentDB(baseDir);
    await db2.init();
    const col2 = await db2.collection(schema);
    const result = await col2.search("typescript");
    expect(result.total).toBeGreaterThanOrEqual(1);
    expect(result.records.some((r) => r._id === "a")).toBe(true);
    await db2.close();
  });

  it("state 3 (both legacy + termlog): deletes legacy blob, no error, search works", async () => {
    // Session 1: insert and close (creates termlog manifest)
    const db = new AgentDB(baseDir);
    await db.init();
    const col = await db.collection(schema);
    await col.insert({ _id: "b", title: "rust programming" });
    await db.close();

    // Artificially plant a legacy blob alongside the termlog manifest
    await writeLegacyBlob(baseDir, "docs");
    const colDir = collectionDir(baseDir, "docs");

    // Session 2: open — should silently delete legacy blob and proceed
    const db2 = new AgentDB(baseDir);
    await db2.init();
    const col2 = await db2.collection(schema);
    const result = await col2.search("rust");
    expect(result.total).toBeGreaterThanOrEqual(1);
    expect(result.records.some((r) => r._id === "b")).toBe(true);
    await db2.close();

    // Legacy blob must be gone
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(colDir, "indexes", "text-index.json"))).toBe(false);
  });

  it("state 4 (neither): fresh collection opens cleanly", async () => {
    const db = new AgentDB(baseDir);
    await db.init();
    const col = await db.collection(schema);
    await col.insert({ _id: "c", title: "python tutorial" });
    const result = await col.search("python");
    expect(result.total).toBeGreaterThanOrEqual(1);
    await db.close();
  });
});

describe("rebuildTextIndex — fix path for LegacyTextIndexError", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await makeTmpDir();
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("rebuild flow: legacy blob → open throws → rebuild without textSearch → reopen succeeds", async () => {
    const plainSchema = defineSchema({ name: "docs", fields: { title: { type: "string" } } });
    const colDir = collectionDir(baseDir, "docs");

    // Session 1: insert records without textSearch
    const db = new AgentDB(baseDir);
    await db.init();
    const col = await db.collection(plainSchema);
    await col.insert({ _id: "r1", title: "golang concurrency" });
    await col.insert({ _id: "r2", title: "golang channels" });
    await db.close();

    // Plant legacy blob to simulate a v1.4 collection
    await writeLegacyBlob(baseDir, "docs");

    // Session 2: open with textSearch → throws
    const db2 = new AgentDB(baseDir);
    await db2.init();
    await expect(db2.collection(schema)).rejects.toBeInstanceOf(LegacyTextIndexError);
    await db2.close().catch(() => {});

    // Session 3: open WITHOUT textSearch → succeeds; call rebuildTextIndex
    const db3 = new AgentDB(baseDir);
    await db3.init();
    const col3 = await db3.collection(plainSchema);
    const count = await col3.rebuildTextIndex();
    expect(count).toBe(2); // both records indexed
    await db3.close();

    // Session 4: reopen WITH textSearch → succeeds, legacy blob gone, search works
    const db4 = new AgentDB(baseDir);
    await db4.init();
    const col4 = await db4.collection(schema);
    const result = await col4.search("golang");
    expect(result.total).toBeGreaterThanOrEqual(1);
    expect(result.records.map((r) => r._id)).toContain("r1");

    // Legacy blob must be deleted
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(colDir, "indexes", "text-index.json"))).toBe(false);

    await db4.close();
  });
});

describe("db_rebuild_text_index tool", () => {
  let baseDir: string;
  let db: AgentDB;

  beforeEach(async () => {
    baseDir = await makeTmpDir();
    db = new AgentDB(baseDir);
    await db.init();
  });

  afterEach(async () => {
    await db.close().catch(() => {});
    await rm(baseDir, { recursive: true, force: true });
  });

  it("returns rebuiltDocCount after rebuilding the index", async () => {
    const col = await db.collection(schema);
    await col.insert({ _id: "t1", title: "java spring boot" });
    await col.insert({ _id: "t2", title: "java hibernate orm" });

    const tools = getTools(db);
    const rebuildTool = tools.find((t) => t.name === "db_rebuild_text_index")!;
    expect(rebuildTool).toBeDefined();

    const raw = await rebuildTool.execute({ collection: "docs" });
    expect(raw.isError).toBeFalsy();
    const result = JSON.parse((raw.content[0] as { text: string }).text);
    expect(result.rebuiltDocCount).toBe(2);
  });

  it("db_rebuild_text_index tool exists in the tool list", async () => {
    const tools = getTools(db);
    const names = tools.map((t) => t.name);
    expect(names).toContain("db_rebuild_text_index");
  });
});
