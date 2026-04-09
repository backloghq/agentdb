import { describe, it, expect } from "vitest";
import { resolveProvider } from "../src/embeddings/index.js";
import { OpenAIEmbeddingProvider } from "../src/embeddings/openai.js";
import { HttpEmbeddingProvider } from "../src/embeddings/http.js";
import type { EmbeddingProvider } from "../src/embeddings/types.js";

/** Mock provider for testing — returns deterministic vectors. */
class MockEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 4;
  calls: string[][] = [];

  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push(texts);
    return texts.map((text) => {
      // Deterministic: hash-like vector from text length
      const seed = text.length;
      return [seed * 0.1, seed * 0.2, seed * 0.3, seed * 0.4];
    });
  }
}

describe("Embedding Providers", () => {
  describe("resolveProvider", () => {
    it("resolves a custom provider instance", () => {
      const mock = new MockEmbeddingProvider();
      const provider = resolveProvider({ provider: mock });
      expect(provider).toBe(mock);
      expect(provider.dimensions).toBe(4);
    });

    it("resolves openai provider", () => {
      const provider = resolveProvider({
        provider: "openai",
        apiKey: "test-key",
        model: "text-embedding-3-small",
        dimensions: 128,
      });
      expect(provider).toBeInstanceOf(OpenAIEmbeddingProvider);
      expect(provider.dimensions).toBe(128);
    });

    it("resolves http provider", () => {
      const provider = resolveProvider({
        provider: "http",
        url: "http://localhost:8080/embed",
        dimensions: 384,
      });
      expect(provider).toBeInstanceOf(HttpEmbeddingProvider);
      expect(provider.dimensions).toBe(384);
    });

    it("throws on unknown provider", () => {
      expect(() =>
        resolveProvider({ provider: "unknown" } as never),
      ).toThrow("Unknown embedding provider");
    });
  });

  describe("MockEmbeddingProvider", () => {
    it("generates vectors with correct dimensions", async () => {
      const mock = new MockEmbeddingProvider();
      const vectors = await mock.embed(["hello", "world"]);
      expect(vectors).toHaveLength(2);
      expect(vectors[0]).toHaveLength(4);
      expect(vectors[1]).toHaveLength(4);
    });

    it("returns empty array for empty input", async () => {
      const mock = new MockEmbeddingProvider();
      const vectors = await mock.embed([]);
      expect(vectors).toEqual([]);
    });

    it("tracks calls", async () => {
      const mock = new MockEmbeddingProvider();
      await mock.embed(["a", "b"]);
      await mock.embed(["c"]);
      expect(mock.calls).toHaveLength(2);
      expect(mock.calls[0]).toEqual(["a", "b"]);
    });

    it("generates deterministic vectors", async () => {
      const mock = new MockEmbeddingProvider();
      const v1 = await mock.embed(["hello"]);
      const v2 = await mock.embed(["hello"]);
      expect(v1[0]).toEqual(v2[0]);
    });
  });

  describe("AgentDB embedding config", () => {
    it("AgentDB accepts embedding config", async () => {
      const { AgentDB } = await import("../src/agentdb.js");
      const { mkdtemp, rm } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");

      const tmpDir = await mkdtemp(join(tmpdir(), "agentdb-embed-"));
      const mock = new MockEmbeddingProvider();
      const db = new AgentDB(tmpDir, { embeddings: { provider: mock } });
      await db.init();

      expect(db.getEmbeddingProvider()).toBe(mock);
      expect(db.getEmbeddingProvider()?.dimensions).toBe(4);

      await db.close();
      await rm(tmpDir, { recursive: true, force: true });
    });

    it("AgentDB without embeddings returns null provider", async () => {
      const { AgentDB } = await import("../src/agentdb.js");
      const { mkdtemp, rm } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");

      const tmpDir = await mkdtemp(join(tmpdir(), "agentdb-noembed-"));
      const db = new AgentDB(tmpDir);
      await db.init();

      expect(db.getEmbeddingProvider()).toBeNull();

      await db.close();
      await rm(tmpDir, { recursive: true, force: true });
    });
  });
});
