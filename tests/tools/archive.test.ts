import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDB } from "../../src/agentdb.js";
import { getTools } from "../../src/tools/index.js";
import type { AgentTool } from "../../src/tools/index.js";

describe("Tool Definitions — archive", () => {
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

  describe("db_archive tools", () => {
    it("archives and lists segments", async () => {
      await exec("db_insert", { collection: "logs", records: [
        { _id: "1", status: "done", msg: "old" },
        { _id: "2", status: "active", msg: "new" },
      ]});

      const archived = await exec("db_archive", {
        collection: "logs",
        filter: { status: "done" },
        segment: "2026-Q1",
      });
      expect(archived.archived).toBe(1);

      const segments = await exec("db_archive_list", { collection: "logs" });
      expect(segments.segments.length).toBeGreaterThan(0);

      const loaded = await exec("db_archive_load", {
        collection: "logs",
        segment: "2026-Q1",
      });
      expect(loaded.count).toBe(1);

      // Active record still there
      const count = await exec("db_count", { collection: "logs" });
      expect(count.count).toBe(1);
    });
  });
});
