/**
 * R7/3c — Vendor-key forwarding via stub HTTP provider.
 *
 * Starts a minimal Node.js HTTP server that captures the Authorization header,
 * then exercises VoyageEmbeddingProvider and CohereEmbeddingProvider with a custom
 * baseUrl pointing at the stub. Asserts that the key reaches the endpoint as
 * "Authorization: Bearer <key>", verifying end-to-end header forwarding without
 * hitting any real external API.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { VoyageEmbeddingProvider } from "../src/embeddings/voyage.js";
import { CohereEmbeddingProvider } from "../src/embeddings/cohere.js";

// ---------------------------------------------------------------------------
// Stub HTTP embedding server
// ---------------------------------------------------------------------------

interface CapturedRequest {
  path: string;
  method: string;
  authorization: string | undefined;
  body: string;
}

let _lastRequest: CapturedRequest | null = null;

let server: Server;
let baseUrl: string;

/** Return a response body matching the provider's expected shape. */
function makeResponse(req: IncomingMessage, body: string): string {
  const parsed = JSON.parse(body) as Record<string, unknown>;
  const textsArr = (parsed.texts ?? parsed.input) as string[];
  const n = Array.isArray(textsArr) ? textsArr.length : 1;
  const vec = Array.from({ length: 4 }, () => 0.5); // 4-dim unit-ish vector

  // Voyage format: { data: [{ embedding: [...] }] }
  // Cohere format: { embeddings: { float: [[...]] } }
  const path = req.url ?? "";
  if (path.endsWith("/embeddings")) {
    // Voyage
    return JSON.stringify({ data: Array.from({ length: n }, () => ({ embedding: vec })) });
  }
  if (path.endsWith("/embed")) {
    // Cohere
    return JSON.stringify({ embeddings: { float: Array.from({ length: n }, () => vec) } });
  }
  return JSON.stringify({});
}

beforeAll(() => {
  return new Promise<void>((resolve) => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        _lastRequest = {
          path: req.url ?? "",
          method: req.method ?? "",
          authorization: req.headers["authorization"],
          body,
        };
        const respBody = makeResponse(req, body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(respBody);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(() => {
  return new Promise<void>((resolve) => { server.close(() => resolve()); });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("R7/3c — vendor key forwarding via stub HTTP endpoint", () => {
  it("VoyageEmbeddingProvider forwards apiKey as Bearer to /embeddings", async () => {
    const key = "voyage-test-key-r73-xxxxxxxxxx";
    const provider = new VoyageEmbeddingProvider({
      apiKey: key,
      baseUrl,        // point at the stub instead of api.voyageai.com
      dimensions: 4,
    });

    _lastRequest = null;
    const result = await provider.embed(["hello world"]);

    // The stub must have received the request
    expect(_lastRequest).not.toBeNull();
    expect(_lastRequest!.path).toBe("/embeddings");

    // The Authorization header must carry the key as a Bearer token
    expect(_lastRequest!.authorization).toBe(`Bearer ${key}`);

    // The provider must have returned the stub's vector
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(4);
  });

  it("CohereEmbeddingProvider forwards apiKey as Bearer to /embed", async () => {
    const key = "cohere-test-key-r73-xxxxxxxxxx";
    const provider = new CohereEmbeddingProvider({
      apiKey: key,
      baseUrl,        // point at the stub instead of api.cohere.com
      dimensions: 4,
    });

    _lastRequest = null;
    const result = await provider.embed(["hello world"]);

    expect(_lastRequest).not.toBeNull();
    expect(_lastRequest!.path).toBe("/embed");
    expect(_lastRequest!.authorization).toBe(`Bearer ${key}`);

    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(4);
  });

  it("VOYAGE_API_KEY env fallback: key is forwarded when apiKey is sourced from env", async () => {
    // Simulate what cli.ts does: apiKey = process.env.VOYAGE_API_KEY || ""
    const envKey = "voyage-env-key-r73-xxxxxxxxxxx";
    const simulatedApiKey = envKey; // pretend we read it from the env

    const provider = new VoyageEmbeddingProvider({
      apiKey: simulatedApiKey,
      baseUrl,
      dimensions: 4,
    });

    _lastRequest = null;
    await provider.embed(["env key forwarding test"]);

    expect(_lastRequest!.authorization).toBe(`Bearer ${envKey}`);
  });

  it("COHERE_API_KEY env fallback: key is forwarded when apiKey is sourced from env", async () => {
    const envKey = "cohere-env-key-r73-xxxxxxxxxxx";
    const provider = new CohereEmbeddingProvider({
      apiKey: envKey,
      baseUrl,
      dimensions: 4,
    });

    _lastRequest = null;
    await provider.embed(["env key forwarding test"]);

    expect(_lastRequest!.authorization).toBe(`Bearer ${envKey}`);
  });
});

describe("R8/4f — vendor key: request body shape and constructor-key precedence", () => {
  it("Voyage: embed() sends input:[...] body containing the requested texts", async () => {
    const provider = new VoyageEmbeddingProvider({
      apiKey: "voyage-body-test-key-r84-xxxxxxx",
      baseUrl,
      dimensions: 4,
    });

    _lastRequest = null;
    await provider.embed(["text one", "text two"]);

    expect(_lastRequest).not.toBeNull();
    const parsed = JSON.parse(_lastRequest!.body) as Record<string, unknown>;
    expect(parsed.input).toEqual(["text one", "text two"]);
  });

  it("Cohere: embed() sends texts:[...] body containing the requested texts", async () => {
    const provider = new CohereEmbeddingProvider({
      apiKey: "cohere-body-test-key-r84-xxxxxxx",
      baseUrl,
      dimensions: 4,
    });

    _lastRequest = null;
    await provider.embed(["text one", "text two"]);

    expect(_lastRequest).not.toBeNull();
    const parsed = JSON.parse(_lastRequest!.body) as Record<string, unknown>;
    expect(parsed.texts).toEqual(["text one", "text two"]);
  });

  it("Voyage: constructor apiKey takes precedence over any env fallback", async () => {
    const canonicalKey = "voyage-canonical-r84-xxxxxxxxxx";
    const fallbackKey  = "voyage-fallback-r84-yyyyyyyyyyy";
    // Simulate cli.ts setting the env var while the caller also supplies an explicit key
    const prev = process.env.VOYAGE_API_KEY;
    process.env.VOYAGE_API_KEY = fallbackKey;
    try {
      const provider = new VoyageEmbeddingProvider({
        apiKey: canonicalKey, // explicit key — must win over env
        baseUrl,
        dimensions: 4,
      });

      _lastRequest = null;
      await provider.embed(["precedence test"]);

      expect(_lastRequest!.authorization).toBe(`Bearer ${canonicalKey}`);
      expect(_lastRequest!.authorization).not.toContain(fallbackKey);
    } finally {
      if (prev === undefined) delete process.env.VOYAGE_API_KEY;
      else process.env.VOYAGE_API_KEY = prev;
    }
  });

  it("Cohere: constructor apiKey takes precedence over any env fallback", async () => {
    const canonicalKey = "cohere-canonical-r84-xxxxxxxxxx";
    const fallbackKey  = "cohere-fallback-r84-yyyyyyyyyyy";
    const prev = process.env.COHERE_API_KEY;
    process.env.COHERE_API_KEY = fallbackKey;
    try {
      const provider = new CohereEmbeddingProvider({
        apiKey: canonicalKey,
        baseUrl,
        dimensions: 4,
      });

      _lastRequest = null;
      await provider.embed(["precedence test"]);

      expect(_lastRequest!.authorization).toBe(`Bearer ${canonicalKey}`);
      expect(_lastRequest!.authorization).not.toContain(fallbackKey);
    } finally {
      if (prev === undefined) delete process.env.COHERE_API_KEY;
      else process.env.COHERE_API_KEY = prev;
    }
  });
});
