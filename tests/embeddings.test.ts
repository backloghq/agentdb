import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveProvider } from "../src/embeddings/index.js";
import { OpenAIEmbeddingProvider } from "../src/embeddings/openai.js";
import { HttpEmbeddingProvider } from "../src/embeddings/http.js";
import { OllamaEmbeddingProvider } from "../src/embeddings/ollama.js";
import { VoyageEmbeddingProvider } from "../src/embeddings/voyage.js";
import { CohereEmbeddingProvider } from "../src/embeddings/cohere.js";
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

  describe("OpenAI provider (mocked)", () => {
    it("calls the API and returns vectors", async () => {
      // Mock global fetch
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string);
        const embeddings = body.input.map((text: string, i: number) => ({
          embedding: Array.from({ length: body.dimensions }, (_, j) => (i + j) * 0.01),
          index: i,
        }));
        return new Response(JSON.stringify({ data: embeddings }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      try {
        const provider = new OpenAIEmbeddingProvider({
          apiKey: "test-key",
          dimensions: 4,
        });
        const vectors = await provider.embed(["hello", "world"]);
        expect(vectors).toHaveLength(2);
        expect(vectors[0]).toHaveLength(4);
        expect(vectors[1]).toHaveLength(4);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("throws on API error", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => new Response("Unauthorized", { status: 401 });

      try {
        const provider = new OpenAIEmbeddingProvider({ apiKey: "bad-key" });
        await expect(provider.embed(["test"])).rejects.toThrow("401");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("returns empty for empty input", async () => {
      const provider = new OpenAIEmbeddingProvider({ apiKey: "test" });
      const vectors = await provider.embed([]);
      expect(vectors).toEqual([]);
    });
  });

  describe("HTTP provider (mocked)", () => {
    it("calls the endpoint and returns vectors", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string);
        const embeddings = body.texts.map(() => [0.1, 0.2, 0.3]);
        return new Response(JSON.stringify({ embeddings }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      try {
        const provider = new HttpEmbeddingProvider({
          url: "http://localhost:9999/embed",
          dimensions: 3,
        });
        const vectors = await provider.embed(["hello"]);
        expect(vectors).toHaveLength(1);
        expect(vectors[0]).toEqual([0.1, 0.2, 0.3]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("throws on API error", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => new Response("Server Error", { status: 500 });

      try {
        const provider = new HttpEmbeddingProvider({
          url: "http://localhost:9999/embed",
          dimensions: 3,
        });
        await expect(provider.embed(["test"])).rejects.toThrow("500");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("throws on malformed response", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => new Response(JSON.stringify({ wrong: "format" }), { status: 200 });

      try {
        const provider = new HttpEmbeddingProvider({
          url: "http://localhost:9999/embed",
          dimensions: 3,
        });
        await expect(provider.embed(["test"])).rejects.toThrow("missing");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("returns empty for empty input", async () => {
      const provider = new HttpEmbeddingProvider({
        url: "http://localhost:9999/embed",
        dimensions: 3,
      });
      const vectors = await provider.embed([]);
      expect(vectors).toEqual([]);
    });
  });

  describe("resolveProvider - new providers", () => {
    it("resolves ollama provider", () => {
      const provider = resolveProvider({
        provider: "ollama",
        model: "nomic-embed-text",
        dimensions: 768,
      });
      expect(provider).toBeInstanceOf(OllamaEmbeddingProvider);
      expect(provider.dimensions).toBe(768);
    });

    it("resolves voyage provider", () => {
      const provider = resolveProvider({
        provider: "voyage",
        apiKey: "test-key",
        model: "voyage-3-lite",
        dimensions: 512,
      });
      expect(provider).toBeInstanceOf(VoyageEmbeddingProvider);
      expect(provider.dimensions).toBe(512);
    });

    it("resolves cohere provider", () => {
      const provider = resolveProvider({
        provider: "cohere",
        apiKey: "test-key",
        model: "embed-english-v3.0",
        dimensions: 1024,
      });
      expect(provider).toBeInstanceOf(CohereEmbeddingProvider);
      expect(provider.dimensions).toBe(1024);
    });
  });

  describe("Ollama provider (mocked)", () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("calls the API with correct URL and body", async () => {
      const calls: Array<{ url: string; body: unknown }> = [];
      vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string);
        calls.push({ url: url.toString(), body });
        return new Response(JSON.stringify({ embedding: [0.1, 0.2, 0.3, 0.4] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const provider = new OllamaEmbeddingProvider({ dimensions: 4 });
      const vectors = await provider.embed(["hello"]);
      expect(vectors).toHaveLength(1);
      expect(vectors[0]).toEqual([0.1, 0.2, 0.3, 0.4]);
      expect(calls[0].url).toBe("http://localhost:11434/api/embeddings");
      expect(calls[0].body).toEqual({ model: "nomic-embed-text", prompt: "hello" });
    });

    it("respects custom baseUrl and model", async () => {
      const calls: Array<{ url: string; body: unknown }> = [];
      vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string);
        calls.push({ url: url.toString(), body });
        return new Response(JSON.stringify({ embedding: [0.1, 0.2] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const provider = new OllamaEmbeddingProvider({
        model: "mxbai-embed-large",
        baseUrl: "http://myhost:5000",
        dimensions: 2,
      });
      await provider.embed(["test"]);
      expect(calls[0].url).toBe("http://myhost:5000/api/embeddings");
      expect(calls[0].body).toEqual({ model: "mxbai-embed-large", prompt: "test" });
    });

    it("auto-detects dimensions from first response", async () => {
      vi.stubGlobal("fetch", async () => {
        return new Response(JSON.stringify({ embedding: [0.1, 0.2, 0.3] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const provider = new OllamaEmbeddingProvider(); // no dimensions specified
      expect(provider.dimensions).toBe(0);
      await provider.embed(["hello"]);
      expect(provider.dimensions).toBe(3);
    });

    it("throws on non-2xx response", async () => {
      vi.stubGlobal("fetch", async () => new Response("Model not found", { status: 404 }));

      const provider = new OllamaEmbeddingProvider({ dimensions: 4 });
      await expect(provider.embed(["test"])).rejects.toThrow("404");
    });

    it("returns empty array for empty input", async () => {
      const provider = new OllamaEmbeddingProvider({ dimensions: 4 });
      const vectors = await provider.embed([]);
      expect(vectors).toEqual([]);
    });

    it("batches N texts with sequential calls", async () => {
      let callCount = 0;
      vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
        callCount++;
        const body = JSON.parse(init?.body as string);
        const len = body.prompt.length;
        return new Response(JSON.stringify({ embedding: [len * 0.1, len * 0.2, len * 0.3] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const provider = new OllamaEmbeddingProvider({ dimensions: 3 });
      const vectors = await provider.embed(["hello", "world", "foo"]);
      expect(vectors).toHaveLength(3);
      expect(callCount).toBe(3); // one fetch per text
      expect(vectors[0]).toEqual([0.5, 1.0, 1.5]); // "hello" length=5
      expect(vectors[1]).toEqual([0.5, 1.0, 1.5]); // "world" length=5
      expect(vectors[2]).toEqual([0.30000000000000004, 0.6000000000000001, 0.8999999999999999]); // "foo" length=3
    });
  });

  describe("Voyage provider (mocked)", () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("calls the API with correct URL, headers, and body", async () => {
      const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
      vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string);
        const headers = Object.fromEntries(
          Object.entries(init?.headers as Record<string, string>),
        );
        calls.push({ url: url.toString(), headers, body });
        return new Response(JSON.stringify({
          data: [{ embedding: [0.1, 0.2, 0.3] }],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const provider = new VoyageEmbeddingProvider({ apiKey: "voy-key", dimensions: 3 });
      const vectors = await provider.embed(["hello"]);
      expect(vectors).toHaveLength(1);
      expect(vectors[0]).toEqual([0.1, 0.2, 0.3]);
      expect(calls[0].url).toBe("https://api.voyageai.com/v1/embeddings");
      expect(calls[0].headers["Authorization"]).toBe("Bearer voy-key");
      expect(calls[0].body).toEqual({
        model: "voyage-3-lite",
        input: ["hello"],
        input_type: "document",
      });
    });

    it("respects custom baseUrl and model", async () => {
      const calls: Array<{ url: string; body: unknown }> = [];
      vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: url.toString(), body: JSON.parse(init?.body as string) });
        return new Response(JSON.stringify({
          data: [{ embedding: [0.5] }],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const provider = new VoyageEmbeddingProvider({
        apiKey: "key",
        model: "voyage-3",
        baseUrl: "https://custom.voyage.ai/v1",
        dimensions: 1,
      });
      await provider.embed(["test"]);
      expect(calls[0].url).toBe("https://custom.voyage.ai/v1/embeddings");
      expect(calls[0].body).toEqual({
        model: "voyage-3",
        input: ["test"],
        input_type: "document",
      });
    });

    it("auto-detects dimensions from first response", async () => {
      vi.stubGlobal("fetch", async () => {
        return new Response(JSON.stringify({
          data: [{ embedding: [0.1, 0.2, 0.3, 0.4, 0.5] }],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const provider = new VoyageEmbeddingProvider({ apiKey: "key" });
      expect(provider.dimensions).toBe(0);
      await provider.embed(["hello"]);
      expect(provider.dimensions).toBe(5);
    });

    it("throws on non-2xx response", async () => {
      vi.stubGlobal("fetch", async () => new Response("Forbidden", { status: 403 }));

      const provider = new VoyageEmbeddingProvider({ apiKey: "bad-key", dimensions: 3 });
      await expect(provider.embed(["test"])).rejects.toThrow("403");
    });

    it("returns empty array for empty input", async () => {
      const provider = new VoyageEmbeddingProvider({ apiKey: "key", dimensions: 3 });
      const vectors = await provider.embed([]);
      expect(vectors).toEqual([]);
    });

    it("batch of N texts works correctly", async () => {
      vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string);
        const embeddings = body.input.map((_text: string, i: number) => ({
          embedding: [i * 0.1, i * 0.2, i * 0.3],
        }));
        return new Response(JSON.stringify({ data: embeddings }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const provider = new VoyageEmbeddingProvider({ apiKey: "key", dimensions: 3 });
      const vectors = await provider.embed(["a", "b", "c"]);
      expect(vectors).toHaveLength(3);
      expect(vectors[0]).toEqual([0, 0, 0]);
      expect(vectors[1]).toEqual([0.1, 0.2, 0.3]);
      expect(vectors[2]).toEqual([0.2, 0.4, 0.6]);
    });
  });

  describe("Cohere provider (mocked)", () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("calls the API with correct URL, headers, and body", async () => {
      const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
      vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string);
        const headers = Object.fromEntries(
          Object.entries(init?.headers as Record<string, string>),
        );
        calls.push({ url: url.toString(), headers, body });
        return new Response(JSON.stringify({
          embeddings: { float: [[0.1, 0.2, 0.3]] },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const provider = new CohereEmbeddingProvider({ apiKey: "co-key", dimensions: 3 });
      const vectors = await provider.embed(["hello"]);
      expect(vectors).toHaveLength(1);
      expect(vectors[0]).toEqual([0.1, 0.2, 0.3]);
      expect(calls[0].url).toBe("https://api.cohere.com/v2/embed");
      expect(calls[0].headers["Authorization"]).toBe("Bearer co-key");
      expect(calls[0].body).toEqual({
        model: "embed-english-v3.0",
        texts: ["hello"],
        input_type: "search_document",
        embedding_types: ["float"],
      });
    });

    it("respects custom baseUrl, model, and inputType", async () => {
      const calls: Array<{ url: string; body: unknown }> = [];
      vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: url.toString(), body: JSON.parse(init?.body as string) });
        return new Response(JSON.stringify({
          embeddings: { float: [[0.5]] },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const provider = new CohereEmbeddingProvider({
        apiKey: "key",
        model: "embed-multilingual-v3.0",
        baseUrl: "https://custom.cohere.ai/v2",
        inputType: "search_query",
        dimensions: 1,
      });
      await provider.embed(["test"]);
      expect(calls[0].url).toBe("https://custom.cohere.ai/v2/embed");
      expect(calls[0].body).toEqual({
        model: "embed-multilingual-v3.0",
        texts: ["test"],
        input_type: "search_query",
        embedding_types: ["float"],
      });
    });

    it("auto-detects dimensions from first response", async () => {
      vi.stubGlobal("fetch", async () => {
        return new Response(JSON.stringify({
          embeddings: { float: [[0.1, 0.2, 0.3, 0.4]] },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const provider = new CohereEmbeddingProvider({ apiKey: "key" });
      expect(provider.dimensions).toBe(0);
      await provider.embed(["hello"]);
      expect(provider.dimensions).toBe(4);
    });

    it("throws on non-2xx response", async () => {
      vi.stubGlobal("fetch", async () => new Response("Unauthorized", { status: 401 }));

      const provider = new CohereEmbeddingProvider({ apiKey: "bad-key", dimensions: 3 });
      await expect(provider.embed(["test"])).rejects.toThrow("401");
    });

    it("returns empty array for empty input", async () => {
      const provider = new CohereEmbeddingProvider({ apiKey: "key", dimensions: 3 });
      const vectors = await provider.embed([]);
      expect(vectors).toEqual([]);
    });

    it("batch of N texts works correctly", async () => {
      vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string);
        const floatEmbeddings = body.texts.map((_text: string, i: number) => [i * 0.1, i * 0.2]);
        return new Response(JSON.stringify({
          embeddings: { float: floatEmbeddings },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const provider = new CohereEmbeddingProvider({ apiKey: "key", dimensions: 2 });
      const vectors = await provider.embed(["a", "b", "c", "d"]);
      expect(vectors).toHaveLength(4);
      expect(vectors[0]).toEqual([0, 0]);
      expect(vectors[1]).toEqual([0.1, 0.2]);
      expect(vectors[2]).toEqual([0.2, 0.4]);
      expect(vectors[3]).toEqual([0.30000000000000004, 0.6000000000000001]);
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
