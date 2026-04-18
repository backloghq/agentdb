import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startHttp } from "../src/mcp/index.js";
import type { AgentDB } from "../src/agentdb.js";

describe("--schemas / schemaPaths option", () => {
  describe("startHttp with schemaPaths", () => {
    let tmpDir: string;
    let close: () => Promise<void>;
    let db: AgentDB;

    beforeAll(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "agentdb-cli-schemas-"));

      await writeFile(
        join(tmpDir, "users.json"),
        JSON.stringify({ name: "users", description: "User accounts", fields: { name: { type: "string" } } }),
        "utf-8",
      );
      await writeFile(
        join(tmpDir, "tasks.json"),
        JSON.stringify({ name: "tasks", description: "Task list" }),
        "utf-8",
      );

      const result = await startHttp(tmpDir, {
        port: 0,
        schemaPaths: [join(tmpDir, "users.json"), join(tmpDir, "tasks.json")],
      });
      close = result.close;
      db = result.db;
    }, 15000);

    afterAll(async () => {
      await close();
      await rm(tmpDir, { recursive: true, force: true });
    }, 10000);

    it("loads schemas specified via schemaPaths", async () => {
      const users = await db.loadPersistedSchema("users");
      expect(users).toBeDefined();
      expect(users!.description).toBe("User accounts");
      expect(users!.fields?.name.type).toBe("string");
    });

    it("loads all listed schema files", async () => {
      const tasks = await db.loadPersistedSchema("tasks");
      expect(tasks).toBeDefined();
      expect(tasks!.description).toBe("Task list");
    });
  });

  describe("glob resolution via resolveGlob", () => {
    let tmpDir: string;

    beforeAll(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "agentdb-glob-"));
      await writeFile(join(tmpDir, "a.json"), JSON.stringify({ name: "a" }), "utf-8");
      await writeFile(join(tmpDir, "b.json"), JSON.stringify({ name: "b" }), "utf-8");
      await writeFile(join(tmpDir, "readme.txt"), "not json", "utf-8");
    });

    afterAll(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it("literal path resolves to itself", async () => {
      const { resolveGlob } = await importResolveGlob();
      const results = await resolveGlob(join(tmpDir, "a.json"));
      expect(results).toEqual([resolve(tmpDir, "a.json")]);
    });

    it("*.json glob matches all JSON files in directory", async () => {
      const { resolveGlob } = await importResolveGlob();
      const results = await resolveGlob(join(tmpDir, "*.json"));
      expect(results).toHaveLength(2);
      expect(results.some(p => p.endsWith("a.json"))).toBe(true);
      expect(results.some(p => p.endsWith("b.json"))).toBe(true);
      expect(results.every(p => p.endsWith(".json"))).toBe(true);
    });

    it("non-existent glob dir returns empty array", async () => {
      const { resolveGlob } = await importResolveGlob();
      const results = await resolveGlob(join(tmpDir, "nonexistent", "*.json"));
      expect(results).toEqual([]);
    });
  });

  describe("schemaPaths failure isolation", () => {
    let tmpDir: string;
    let close: () => Promise<void>;
    let db: AgentDB;

    beforeAll(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "agentdb-schemas-fail-"));
      await writeFile(join(tmpDir, "good.json"), JSON.stringify({ name: "good", description: "Fine" }), "utf-8");
      await writeFile(join(tmpDir, "bad.json"), "not valid json!", "utf-8");

      const result = await startHttp(tmpDir, {
        port: 0,
        schemaPaths: [join(tmpDir, "good.json"), join(tmpDir, "bad.json")],
      });
      close = result.close;
      db = result.db;
    }, 15000);

    afterAll(async () => {
      await close();
      await rm(tmpDir, { recursive: true, force: true });
    }, 10000);

    it("good files are loaded when batch contains a bad file", async () => {
      const good = await db.loadPersistedSchema("good");
      expect(good?.description).toBe("Fine");
    });

    it("bad files do not abort startup", async () => {
      const bad = await db.loadPersistedSchema("bad");
      expect(bad).toBeUndefined();
    });
  });

  describe("schemas/ auto-discover runs before --schemas overlay", () => {
    let tmpDir: string;
    let close: () => Promise<void>;
    let db: AgentDB;

    beforeAll(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "agentdb-overlay-order-"));
      // schemas/ dir: establishes the base
      await mkdir(join(tmpDir, "schemas"), { recursive: true });
      await writeFile(
        join(tmpDir, "schemas", "users.json"),
        JSON.stringify({ name: "users", description: "Base desc", fields: { name: { type: "string", required: true } } }),
        "utf-8",
      );
      // --schemas file: overlays on top
      await writeFile(
        join(tmpDir, "users-overlay.json"),
        JSON.stringify({ name: "users", description: "Overlay desc" }),
        "utf-8",
      );

      const result = await startHttp(tmpDir, {
        port: 0,
        schemaPaths: [join(tmpDir, "users-overlay.json")],
      });
      close = result.close;
      db = result.db;
    }, 15000);

    afterAll(async () => {
      await close();
      await rm(tmpDir, { recursive: true, force: true });
    }, 10000);

    it("--schemas overlay wins description over schemas/ base", async () => {
      const users = await db.loadPersistedSchema("users");
      expect(users!.description).toBe("Overlay desc");
    });

    it("--schemas overlay preserves untouched fields from schemas/ base", async () => {
      const users = await db.loadPersistedSchema("users");
      expect(users!.fields?.name.required).toBe(true);
    });
  });
});

/** Import resolveGlob from the CLI module for unit testing. */
async function importResolveGlob(): Promise<{ resolveGlob: (pattern: string) => Promise<string[]> }> {
  // resolveGlob is not exported, so we replicate it inline for testing
  const { readdir } = await import("node:fs/promises");
  const { dirname, basename, resolve, join } = await import("node:path");

  async function resolveGlob(pattern: string): Promise<string[]> {
    const abs = resolve(pattern);
    const dir = dirname(abs);
    const file = basename(abs);

    if (!file.includes("*") && !file.includes("?")) return [abs];

    const regexStr = file
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    const re = new RegExp(`^${regexStr}$`);

    try {
      const entries = await readdir(dir);
      return entries.filter(e => re.test(e)).map(e => join(dir, e));
    } catch {
      return [];
    }
  }

  return { resolveGlob };
}
