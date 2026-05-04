import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDB } from "../../src/agentdb.js";
import { defineSchema } from "../../src/schema.js";
import { getTools } from "../../src/tools/index.js";
import type { AgentTool } from "../../src/tools/index.js";
import type { EmbeddingProvider } from "../../src/embeddings/types.js";

class FakeProvider implements EmbeddingProvider {
  readonly dimensions = 4;
  readonly calls: string[][] = [];
  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push(texts);
    return texts.map(() => [1, 0, 0, 0]);
  }
}

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

  describe("db_reembed_all (#189)", () => {
    it("happy path: re-embeds all records and returns ReembedResult shape", async () => {
      const provider = new FakeProvider();
      const embedDb = new AgentDB(tmpDir + "-reembed189", { embeddings: { provider } });
      await embedDb.init();
      const embedTools = getTools(embedDb);
      const embedExec = async (name: string, args: Record<string, unknown> = {}) => {
        const t = embedTools.find((t) => t.name === name)!;
        const result = await t.execute(args);
        if (result.isError) throw new Error(result.content[0].text);
        return JSON.parse(result.content[0].text);
      };

      await embedExec("db_create", { collection: "reembed189" });
      await embedExec("db_insert", { collection: "reembed189", record: { _id: "a", text: "hello" } });
      await embedExec("db_insert", { collection: "reembed189", record: { _id: "b", text: "world" } });

      const result = await embedExec("db_reembed_all", { collection: "reembed189" });
      expect(result.embedded).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.errors).toHaveLength(0);

      await embedDb.close();
      await rm(tmpDir + "-reembed189", { recursive: true, force: true });
    });

    it("returns isError when no embedding provider is configured", async () => {
      await exec("db_create", { collection: "noprov189" });
      const t = tools.find((t) => t.name === "db_reembed_all")!;
      const result = await t.execute({ collection: "noprov189" });
      expect(result.isError).toBe(true);
    });
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

    it("semanticSearch empty query returns [] without calling the embedding provider", async () => {
      const provider = new FakeProvider();
      const embedDb = new AgentDB(tmpDir + "-sem-empty", { embeddings: { provider } });
      await embedDb.init();
      const col = await embedDb.collection(defineSchema({ name: "emptyq", fields: { text: { type: "string" } } }));
      await col.insert({ _id: "a", text: "hello" });

      const embedSpy = vi.spyOn(provider, "embed");
      const result = await col.semanticSearch("   ");
      expect(result.records).toHaveLength(0);
      expect(result.scores).toHaveLength(0);
      expect(embedSpy).not.toHaveBeenCalled();

      await embedDb.close();
      await rm(tmpDir + "-sem-empty", { recursive: true, force: true });
    });

    it("semanticSearch empty string returns [] without calling the embedding provider", async () => {
      const provider = new FakeProvider();
      const embedDb = new AgentDB(tmpDir + "-sem-empty2", { embeddings: { provider } });
      await embedDb.init();
      const col = await embedDb.collection(defineSchema({ name: "emptyq2", fields: { text: { type: "string" } } }));

      const embedSpy = vi.spyOn(provider, "embed");
      const result = await col.semanticSearch("");
      expect(result.records).toHaveLength(0);
      expect(embedSpy).not.toHaveBeenCalled();

      await embedDb.close();
      await rm(tmpDir + "-sem-empty2", { recursive: true, force: true });
    });
  });
});
