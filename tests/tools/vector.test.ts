import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDB } from "../../src/agentdb.js";
import { getTools } from "../../src/tools/index.js";
import type { AgentTool } from "../../src/tools/index.js";

describe("Tool Definitions — vector", () => {
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

  describe("db_semantic_search and db_embed", () => {
    it("db_embed returns 0 when no provider configured", async () => {
      await exec("db_create", { collection: "noembed" });
      const result = await exec("db_embed", { collection: "noembed" });
      expect(result.embedded).toBe(0);
    });

    it("db_semantic_search returns error when no provider configured", async () => {
      const t = tool("db_semantic_search");
      const result = await t.execute({ collection: "users", query: "test" });
      expect(result.isError).toBe(true);
    });
  });
});
