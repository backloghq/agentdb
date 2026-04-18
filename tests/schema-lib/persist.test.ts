import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDB } from "../../src/agentdb.js";
import { defineSchema } from "../../src/schema.js";
import type { PersistedSchema } from "../../src/schema.js";

describe("schema persistence", () => {
  let tmpDir: string;
  let db: AgentDB;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agentdb-persist-"));
    db = new AgentDB(tmpDir);
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("persist and load round-trip", async () => {
    const schema: PersistedSchema = {
      name: "tickets",
      version: 1,
      description: "Support tickets",
      instructions: "Set priority based on tier",
      fields: {
        title: { type: "string", required: true, description: "Short summary" },
        status: { type: "enum", values: ["open", "closed"], default: "open" },
      },
      indexes: ["status"],
    };

    await db.persistSchema("tickets", schema);
    const loaded = await db.loadPersistedSchema("tickets");
    expect(loaded).toEqual(schema);
  });

  it("loadPersistedSchema returns undefined for non-existent", async () => {
    const result = await db.loadPersistedSchema("nonexistent");
    expect(result).toBeUndefined();
  });

  it("deletePersistedSchema removes the file", async () => {
    await db.persistSchema("temp", { name: "temp", version: 1 });
    expect(await db.loadPersistedSchema("temp")).toBeDefined();

    await db.deletePersistedSchema("temp");
    expect(await db.loadPersistedSchema("temp")).toBeUndefined();
  });

  it("deletePersistedSchema is no-op for non-existent", async () => {
    await expect(db.deletePersistedSchema("ghost")).resolves.toBeUndefined();
  });

  it("persistSchema rejects invalid schema", async () => {
    await expect(db.persistSchema("bad", { name: "" } as PersistedSchema)).rejects.toThrow("non-empty string");
  });

  it("rejects invalid collection names", async () => {
    await expect(db.persistSchema("../escape", { name: "escape" })).rejects.toThrow("Invalid collection name");
    await expect(db.loadPersistedSchema("../escape")).rejects.toThrow("Invalid collection name");
  });

  it("auto-persists schema on first collection open with defineSchema", async () => {
    await db.collection(defineSchema({
      name: "auto-persist",
      version: 1,
      description: "Auto-persisted collection",
      instructions: "Handle with care",
      fields: {
        title: { type: "string", required: true, description: "The title" },
        status: { type: "enum", values: ["open", "done"], default: "open" },
      },
      indexes: ["status"],
    }));

    const loaded = await db.loadPersistedSchema("auto-persist");
    expect(loaded).toBeDefined();
    expect(loaded!.name).toBe("auto-persist");
    expect(loaded!.description).toBe("Auto-persisted collection");
    expect(loaded!.instructions).toBe("Handle with care");
    expect(loaded!.fields?.title.description).toBe("The title");
    expect(loaded!.indexes).toEqual(["status"]);
  });

  it("merges code and persisted schemas on reopen, persisted context wins", async () => {
    // Manually persist a schema with custom instructions
    await db.persistSchema("merge-test", {
      name: "merge-test",
      version: 1,
      description: "Persisted description",
      instructions: "Original instructions",
      fields: {
        title: { type: "string", description: "Persisted title desc" },
      },
    });

    // Open with different instructions in code + a new field
    await db.collection(defineSchema({
      name: "merge-test",
      version: 2,
      instructions: "New instructions",
      fields: {
        title: { type: "string", description: "Code title desc" },
        status: { type: "enum", values: ["open", "done"], default: "open" },
      },
      indexes: ["status"],
    }));

    const loaded = await db.loadPersistedSchema("merge-test");
    // Persisted context wins
    expect(loaded!.instructions).toBe("Original instructions");
    expect(loaded!.description).toBe("Persisted description");
    expect(loaded!.version).toBe(1);
    // Persisted field description wins
    expect(loaded!.fields?.title.description).toBe("Persisted title desc");
    // New field from code is added
    expect(loaded!.fields?.status).toBeDefined();
    expect(loaded!.fields?.status.type).toBe("enum");
    // Indexes merged
    expect(loaded!.indexes).toContain("status");
  });

  it("survives close and reopen", async () => {
    await db.collection(defineSchema({
      name: "survive",
      description: "Survives restart",
      fields: { x: { type: "number" } },
    }));
    await db.close();

    const db2 = new AgentDB(tmpDir);
    await db2.init();
    const loaded = await db2.loadPersistedSchema("survive");
    expect(loaded).toBeDefined();
    expect(loaded!.description).toBe("Survives restart");
    await db2.close();

    // Reopen for afterEach cleanup
    db = new AgentDB(tmpDir);
    await db.init();
  });

  it("persistSchema requires admin when agent is specified", async () => {
    await db.close();
    const dbWithPerms = new AgentDB(tmpDir, {
      permissions: {
        reader: { read: true, write: false, admin: false },
        writer: { read: true, write: true, admin: false },
        admin: { read: true, write: true, admin: true },
      },
    });
    await dbWithPerms.init();

    const schema: PersistedSchema = { name: "guarded", version: 1 };

    // Reader and writer should be denied
    await expect(dbWithPerms.persistSchema("guarded", schema, { agent: "reader" }))
      .rejects.toThrow("Permission denied");
    await expect(dbWithPerms.persistSchema("guarded", schema, { agent: "writer" }))
      .rejects.toThrow("Permission denied");

    // Admin should succeed
    await dbWithPerms.persistSchema("guarded", schema, { agent: "admin" });
    expect(await dbWithPerms.loadPersistedSchema("guarded")).toEqual(schema);

    // Delete also requires admin
    await expect(dbWithPerms.deletePersistedSchema("guarded", { agent: "writer" }))
      .rejects.toThrow("Permission denied");
    await dbWithPerms.deletePersistedSchema("guarded", { agent: "admin" });
    expect(await dbWithPerms.loadPersistedSchema("guarded")).toBeUndefined();

    await dbWithPerms.close();
    db = new AgentDB(tmpDir);
    await db.init();
  });

  it("persistSchema skips permission check when no agent specified", async () => {
    await db.close();
    const dbWithPerms = new AgentDB(tmpDir, {
      permissions: { reader: { read: true } },
    });
    await dbWithPerms.init();

    // Internal call (no agent) should succeed even with restrictive permissions
    await dbWithPerms.persistSchema("internal", { name: "internal", version: 1 });
    expect(await dbWithPerms.loadPersistedSchema("internal")).toBeDefined();

    await dbWithPerms.close();
    db = new AgentDB(tmpDir);
    await db.init();
  });

  it("getSchema returns in-memory schema", async () => {
    expect(db.getSchema("nonexistent")).toBeUndefined();

    await db.collection(defineSchema({
      name: "in-memory",
      fields: { x: { type: "string" } },
    }));
    expect(db.getSchema("in-memory")).toBeDefined();
    expect(db.getSchema("in-memory")!.name).toBe("in-memory");
  });

  it("forward-compat: unknown properties in JSON file round-trip through load → persist → re-read", async () => {
    // Simulate a schema file written by a newer AgentDB version with an unknown property
    const metaDir = join(tmpDir, "meta");
    const schemaFile = join(metaDir, "fwd-compat.schema.json");
    await writeFile(schemaFile, JSON.stringify({
      name: "fwd-compat",
      version: 1,
      description: "Base description",
      newFeatureProp: "future-value",
      fields: { x: { type: "string", futureConstraint: "strict" } },
    }), "utf-8");

    // Load — should succeed without error; unknown props survive as runtime values
    const loaded = await db.loadPersistedSchema("fwd-compat");
    expect(loaded).toBeDefined();
    expect(loaded!.name).toBe("fwd-compat");
    expect((loaded as Record<string, unknown>).newFeatureProp).toBe("future-value");

    // Persist back — unknown props should round-trip
    await db.persistSchema("fwd-compat", loaded!);
    const reloaded = await db.loadPersistedSchema("fwd-compat");
    expect((reloaded as Record<string, unknown>).newFeatureProp).toBe("future-value");
    expect((reloaded!.fields!.x as Record<string, unknown>).futureConstraint).toBe("strict");
  });

  it("concurrent persistSchema calls succeed without corruption (one wins, one overwrites cleanly)", async () => {
    const schemaA: PersistedSchema = { name: "concurrent", version: 1, description: "from A" };
    const schemaB: PersistedSchema = { name: "concurrent", version: 2, description: "from B" };

    // Fire both writes simultaneously — unique tmp filename prevents them clobbering each other mid-write
    await Promise.all([
      db.persistSchema("concurrent", schemaA),
      db.persistSchema("concurrent", schemaB),
    ]);

    // One must have won; the result must be a valid complete schema (not a partial/corrupted file)
    const loaded = await db.loadPersistedSchema("concurrent");
    expect(loaded).toBeDefined();
    expect(["from A", "from B"]).toContain(loaded!.description);
    expect(loaded!.name).toBe("concurrent");
  });
});
