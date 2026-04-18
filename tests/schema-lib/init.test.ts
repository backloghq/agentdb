import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readdir, mkdir } from "node:fs/promises";
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
