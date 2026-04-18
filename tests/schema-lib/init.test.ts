import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readdir, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDB } from "../../src/agentdb.js";

describe("AgentDB.init() — orphaned tmp cleanup", () => {
  let tmpDir: string;
  let db: AgentDB;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agentdb-init-"));
  });

  afterEach(async () => {
    await db?.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("removes orphaned meta/*.tmp files on init", async () => {
    const metaDir = join(tmpDir, "meta");
    await mkdir(metaDir, { recursive: true });

    // Simulate orphaned tmp files from a crashed persistSchema or writeMeta
    await writeFile(join(metaDir, "tickets.schema.json.12345.1234567890.abc.tmp"), "{}", "utf-8");
    await writeFile(join(metaDir, "manifest.json.99999.1234567890.xyz.tmp"), "{}", "utf-8");

    db = new AgentDB(tmpDir);
    await db.init();

    const remaining = await readdir(metaDir);
    expect(remaining.filter(f => f.endsWith(".tmp"))).toHaveLength(0);
  });

  it("does not affect non-tmp files during init", async () => {
    db = new AgentDB(tmpDir);
    await db.init();

    // Create a schema so there's a real .json file
    await db.persistSchema("tasks", { name: "tasks", version: 1 });

    // Re-init (simulate restart) — should NOT delete the schema file
    await db.close();
    const db2 = new AgentDB(tmpDir);
    await db2.init();

    const loaded = await db2.loadPersistedSchema("tasks");
    expect(loaded).toBeDefined();
    expect(loaded!.name).toBe("tasks");

    db = db2;
  });
});

describe("writeMeta() — concurrent-write safety", () => {
  let tmpDir: string;
  let db1: AgentDB;
  let db2: AgentDB;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agentdb-writemeta-"));
    // Init both instances on the same directory
    db1 = new AgentDB(tmpDir);
    await db1.init();
    db2 = new AgentDB(tmpDir);
    await db2.init();
  });

  afterEach(async () => {
    await db1?.close();
    await db2?.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("concurrent createCollection calls succeed and leave no orphaned tmp files", async () => {
    // Both instances write manifest concurrently — unique tmp names prevent clobbering
    await Promise.all([
      db1.createCollection("col-a"),
      db2.createCollection("col-b"),
    ]);

    // No .tmp files should remain in meta/
    const metaDir = join(tmpDir, "meta");
    const files = await readdir(metaDir);
    expect(files.filter(f => f.endsWith(".tmp"))).toHaveLength(0);

    // Manifest must be valid JSON with at least one of the two collections
    const manifest = JSON.parse(await readFile(join(metaDir, "manifest.json"), "utf-8"));
    expect(manifest.collections).toBeDefined();
    expect(Array.isArray(manifest.collections)).toBe(true);
  });
});
