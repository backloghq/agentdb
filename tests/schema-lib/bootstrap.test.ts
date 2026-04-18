import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDB } from "../../src/agentdb.js";

describe("AgentDB.loadSchemasFromFiles", () => {
  let tmpDir: string;
  let db: AgentDB;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agentdb-schema-files-"));
    db = new AgentDB(tmpDir);
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("happy path: loads a valid schema file", async () => {
    const schemaPath = join(tmpDir, "users.json");
    await writeFile(schemaPath, JSON.stringify({ name: "users", description: "User accounts", fields: { name: { type: "string" } } }), "utf-8");

    const result = await db.loadSchemasFromFiles([schemaPath]);
    expect(result.loaded).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.failed).toHaveLength(0);

    const loaded = await db.loadPersistedSchema("users");
    expect(loaded).toBeDefined();
    expect(loaded!.description).toBe("User accounts");
    expect(loaded!.fields?.name.type).toBe("string");
  });

  it("uses filename as name fallback when name is absent from JSON", async () => {
    const schemaPath = join(tmpDir, "tasks.json");
    await writeFile(schemaPath, JSON.stringify({ description: "Task list", fields: { title: { type: "string" } } }), "utf-8");

    const result = await db.loadSchemasFromFiles([schemaPath]);
    expect(result.loaded).toBe(1);

    const loaded = await db.loadPersistedSchema("tasks");
    expect(loaded!.name).toBe("tasks");
    expect(loaded!.description).toBe("Task list");
  });

  it("malformed JSON: added to failed, does not abort batch", async () => {
    const goodPath = join(tmpDir, "good.json");
    const badPath = join(tmpDir, "bad.json");
    await writeFile(goodPath, JSON.stringify({ name: "good", description: "ok" }), "utf-8");
    await writeFile(badPath, "{ not valid json", "utf-8");

    const result = await db.loadSchemasFromFiles([badPath, goodPath]);
    expect(result.loaded).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].path).toBe(badPath);
    expect(result.failed[0].error).toContain("JSON parse error");
  });

  it("validation fail: invalid field type added to failed", async () => {
    const schemaPath = join(tmpDir, "invalid.json");
    await writeFile(schemaPath, JSON.stringify({ name: "invalid", fields: { x: { type: "badtype" } } }), "utf-8");

    const result = await db.loadSchemasFromFiles([schemaPath]);
    expect(result.loaded).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toContain("Validation error");
  });

  it("file-as-overlay: file props win, existing props preserved when not in file", async () => {
    await db.persistSchema("overlay-test", {
      name: "overlay-test",
      description: "Original",
      fields: { title: { type: "string", required: true, description: "Original desc" } },
    });

    const schemaPath = join(tmpDir, "overlay-test.json");
    await writeFile(schemaPath, JSON.stringify({
      name: "overlay-test",
      description: "From file",
      fields: { title: { type: "string" } },
    }), "utf-8");

    await db.loadSchemasFromFiles([schemaPath]);
    const loaded = await db.loadPersistedSchema("overlay-test");
    expect(loaded!.description).toBe("From file");
    expect(loaded!.fields?.title.required).toBe(true);
    expect(loaded!.fields?.title.description).toBe("Original desc");
  });

  it("idempotent: loading the same file twice produces same result and skips on second load", async () => {
    const schemaPath = join(tmpDir, "idempotent.json");
    await writeFile(schemaPath, JSON.stringify({ name: "idempotent", description: "Stable", version: 1 }), "utf-8");

    const r1 = await db.loadSchemasFromFiles([schemaPath]);
    expect(r1.loaded).toBe(1);
    expect(r1.skipped).toBe(0);
    const first = await db.loadPersistedSchema("idempotent");

    const r2 = await db.loadSchemasFromFiles([schemaPath]);
    expect(r2.loaded).toBe(0);
    expect(r2.skipped).toBe(1);
    const second = await db.loadPersistedSchema("idempotent");

    expect(second).toEqual(first);
  });

  it("skips file with same content but reordered JSON keys (canonicalJSON no-op detection)", async () => {
    // Load with one key order
    const schemaPath = join(tmpDir, "reorder.json");
    await writeFile(schemaPath, JSON.stringify({ name: "reorder", description: "Stable", version: 1 }), "utf-8");

    const r1 = await db.loadSchemasFromFiles([schemaPath]);
    expect(r1.loaded).toBe(1);

    // Write same logical content with different key ordering
    await writeFile(schemaPath, JSON.stringify({ version: 1, name: "reorder", description: "Stable" }), "utf-8");

    const r2 = await db.loadSchemasFromFiles([schemaPath]);
    expect(r2.loaded).toBe(0);
    expect(r2.skipped).toBe(1);
  });

  it("skips file when derived name fails collection name validation", async () => {
    const schemaPath = join(tmpDir, "_invalid.json");
    await writeFile(schemaPath, JSON.stringify({ description: "no name field" }), "utf-8");

    const result = await db.loadSchemasFromFiles([schemaPath]);
    expect(result.skipped).toBe(1);
    expect(result.loaded).toBe(0);
    expect(result.failed).toHaveLength(0);
  });

  it("warns when explicit name field disagrees with filename-derived name", async () => {
    const schemaPath = join(tmpDir, "accounts.json");
    await writeFile(schemaPath, JSON.stringify({ name: "users", description: "Disagrees" }), "utf-8");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await db.loadSchemasFromFiles([schemaPath]);
      expect(result.loaded).toBe(1);
      expect(warnSpy).toHaveBeenCalledOnce();
      const msg = warnSpy.mock.calls[0][0] as string;
      expect(msg).toContain("users");
      expect(msg).toContain("accounts");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("valid JSON but wrong content types (array, null, number) land in failed[]", async () => {
    const arrayPath = join(tmpDir, "arr.json");
    const nullPath = join(tmpDir, "nullval.json");
    const numPath = join(tmpDir, "num.json");
    await writeFile(arrayPath, JSON.stringify([{ name: "x" }]), "utf-8");
    await writeFile(nullPath, "null", "utf-8");
    await writeFile(numPath, "42", "utf-8");

    const result = await db.loadSchemasFromFiles([arrayPath, nullPath, numPath]);
    expect(result.loaded).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failed).toHaveLength(3);
    for (const f of result.failed) {
      expect(f.error).toMatch(/Validation error/i);
    }
  });

  it("file name field wins over filename-derived name, and warning fires for the mismatch", async () => {
    const schemaPath = join(tmpDir, "tickets.json");
    await writeFile(schemaPath, JSON.stringify({ name: "users", description: "Users, not tickets" }), "utf-8");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await db.loadSchemasFromFiles([schemaPath]);
      expect(result.loaded).toBe(1);
      expect(warnSpy).toHaveBeenCalledOnce();

      // Loaded under the name from the file, not from the filename
      const byName = await db.loadPersistedSchema("users");
      expect(byName).toBeDefined();
      expect(byName!.description).toBe("Users, not tickets");

      // Nothing loaded under the filename-derived name
      const byFilename = await db.loadPersistedSchema("tickets");
      expect(byFilename).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("loads under explicit name even when filename-derived name is invalid", async () => {
    // Filename "_badname.json" derives to "_badname" which fails collection name validation.
    // But explicit name field "valid-collection" is valid — file should load under explicit name
    // with a warning (name/filename mismatch), not be skipped.
    const schemaPath = join(tmpDir, "_badname.json");
    await writeFile(schemaPath, JSON.stringify({ name: "valid-collection", description: "Explicit wins" }), "utf-8");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await db.loadSchemasFromFiles([schemaPath]);
      expect(result.loaded).toBe(1);
      expect(result.failed).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledOnce();

      const schema = await db.loadPersistedSchema("valid-collection");
      expect(schema).toBeDefined();
      expect(schema!.description).toBe("Explicit wins");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("skips files larger than 10MB and records them in failed[]", async () => {
    const bigPath = join(tmpDir, "toobig.json");
    await writeFile(bigPath, Buffer.alloc(11 * 1024 * 1024, 0x20)); // 11MB of spaces
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await db.loadSchemasFromFiles([bigPath]);
      expect(result.loaded).toBe(0);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].error).toBe("file size exceeds 10MB limit");
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("AgentDB schemas/ auto-discover", () => {
  let tmpDir: string;
  let db: AgentDB;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agentdb-autodiscover-"));
  });

  afterEach(async () => {
    await db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("silently skips init when schemas/ directory is absent", async () => {
    db = new AgentDB(tmpDir);
    await expect(db.init()).resolves.not.toThrow();
  });

  it("loads nothing when schemas/ directory is empty", async () => {
    await mkdir(join(tmpDir, "schemas"), { recursive: true });
    db = new AgentDB(tmpDir);
    await db.init();
    // No error, and no schemas loaded
    const loaded = await db.loadPersistedSchema("anything");
    expect(loaded).toBeUndefined();
  });

  it("loads valid schema files on init", async () => {
    await mkdir(join(tmpDir, "schemas"), { recursive: true });
    await writeFile(
      join(tmpDir, "schemas", "users.json"),
      JSON.stringify({ name: "users", description: "User accounts" }),
      "utf-8",
    );
    db = new AgentDB(tmpDir);
    await db.init();

    const loaded = await db.loadPersistedSchema("users");
    expect(loaded).toBeDefined();
    expect(loaded!.description).toBe("User accounts");
  });

  it("mixed good/bad: good ones load, bad ones do not abort init", async () => {
    await mkdir(join(tmpDir, "schemas"), { recursive: true });
    await writeFile(
      join(tmpDir, "schemas", "good.json"),
      JSON.stringify({ name: "good", description: "Fine" }),
      "utf-8",
    );
    await writeFile(
      join(tmpDir, "schemas", "bad.json"),
      "not json!",
      "utf-8",
    );
    db = new AgentDB(tmpDir);
    await db.init();

    const good = await db.loadPersistedSchema("good");
    expect(good?.description).toBe("Fine");
    const bad = await db.loadPersistedSchema("bad");
    expect(bad).toBeUndefined();
  });

  it("restart-idempotent: reloading same schemas/ on second init produces same result", async () => {
    await mkdir(join(tmpDir, "schemas"), { recursive: true });
    await writeFile(
      join(tmpDir, "schemas", "tasks.json"),
      JSON.stringify({ name: "tasks", description: "Task list", version: 1 }),
      "utf-8",
    );

    db = new AgentDB(tmpDir);
    await db.init();
    const first = await db.loadPersistedSchema("tasks");
    await db.close();

    db = new AgentDB(tmpDir);
    await db.init();
    const second = await db.loadPersistedSchema("tasks");
    expect(second).toEqual(first);
  });

  it("symlinked schemas/ directory is followed and files are loaded", async () => {
    // Create schema files in a separate directory, then symlink it as <dataDir>/schemas
    const realSchemasDir = await mkdtemp(join(tmpdir(), "agentdb-real-schemas-"));
    try {
      await writeFile(
        join(realSchemasDir, "linked.json"),
        JSON.stringify({ name: "linked", description: "From symlinked dir" }),
        "utf-8",
      );
      await symlink(realSchemasDir, join(tmpDir, "schemas"));

      db = new AgentDB(tmpDir);
      await db.init();

      const loaded = await db.loadPersistedSchema("linked");
      expect(loaded).toBeDefined();
      expect(loaded!.description).toBe("From symlinked dir");
    } finally {
      await rm(realSchemasDir, { recursive: true, force: true });
    }
  });
});
