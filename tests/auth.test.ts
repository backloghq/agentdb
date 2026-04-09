import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHttp } from "../src/mcp/index.js";

async function mcpRequest(
  port: number,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (text.includes("data:")) {
    const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
    if (dataLine) {
      return { status: res.status, body: JSON.parse(dataLine.slice(5).trim()) };
    }
  }

  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: { raw: text } };
  }
}

const initRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } },
};

describe("Authentication", () => {
  describe("bearer token auth", () => {
    let tmpDir: string;
    let close: () => Promise<void>;
    let port: number;

    beforeAll(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "agentdb-auth-"));
      const result = await startHttp(tmpDir, {
        port: 0,
        authToken: "test-secret-token",
      });
      close = result.close;
      port = result.port;
    }, 15000);

    afterAll(async () => {
      await close();
      await rm(tmpDir, { recursive: true, force: true });
    }, 10000);

    it("rejects requests without auth header", async () => {
      const res = await mcpRequest(port, initRequest);
      expect(res.status).toBe(401);
      expect(res.body.error).toContain("Authorization");
    });

    it("rejects requests with wrong token", async () => {
      const res = await mcpRequest(port, initRequest, { Authorization: "Bearer wrong-token" });
      expect(res.status).toBe(401);
      expect(res.body.error).toContain("Invalid");
    });

    it("accepts requests with correct token", async () => {
      const res = await mcpRequest(port, initRequest, { Authorization: "Bearer test-secret-token" });
      expect(res.status).toBe(200);
      expect(res.body.result).toBeDefined();
    });

    it("health check works without auth", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("ok");
    });

    it("security headers are set", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("cache-control")).toBe("no-store");
    });
  });

  describe("no auth configured", () => {
    let close: () => Promise<void>;
    let openDir: string;
    let port: number;

    beforeAll(async () => {
      openDir = await mkdtemp(join(tmpdir(), "agentdb-noauth-"));
      const result = await startHttp(openDir, { port: 0 });
      close = result.close;
      port = result.port;
    }, 15000);

    afterAll(async () => {
      await close();
      await rm(openDir, { recursive: true, force: true });
    }, 10000);

    it("allows requests without auth when no token configured", async () => {
      const res = await mcpRequest(port, initRequest);
      expect(res.status).toBe(200);
    });
  });

  describe("multi-token auth", () => {
    let close: () => Promise<void>;
    let multiDir: string;
    let port: number;

    beforeAll(async () => {
      multiDir = await mkdtemp(join(tmpdir(), "agentdb-multi-"));
      const result = await startHttp(multiDir, {
        port: 0,
        authTokens: {
          "token-reader": { agentId: "reader", permissions: { read: true, write: false, admin: false } },
          "token-writer": { agentId: "writer", permissions: { read: true, write: true, admin: false } },
        },
      });
      close = result.close;
      port = result.port;
    }, 15000);

    afterAll(async () => {
      await close();
      await rm(multiDir, { recursive: true, force: true });
    }, 10000);

    it("accepts reader token", async () => {
      const res = await mcpRequest(port, initRequest, { Authorization: "Bearer token-reader" });
      expect(res.status).toBe(200);
    });

    it("accepts writer token", async () => {
      const res = await mcpRequest(port, initRequest, { Authorization: "Bearer token-writer" });
      expect(res.status).toBe(200);
    });

    it("rejects unknown token", async () => {
      const res = await mcpRequest(port, initRequest, { Authorization: "Bearer unknown-token" });
      expect(res.status).toBe(401);
    });
  });
});

describe("JWT Auth", () => {
  it("validates JWT with shared secret", async () => {
    const { SignJWT } = await import("jose");
    const { createJwtAuth } = await import("../src/mcp/jwt.js");

    const secret = "super-secret-key-for-testing-only";
    const authFn = createJwtAuth({ secret, audience: "agentdb", issuer: "test" });

    const jwt = await new SignJWT({ sub: "agent-1", permissions: { read: true, write: true } })
      .setProtectedHeader({ alg: "HS256" })
      .setAudience("agentdb")
      .setIssuer("test")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(secret));

    const mockReq = { headers: { authorization: `Bearer ${jwt}` } } as unknown as import("express").Request;
    const identity = await authFn(mockReq);
    expect(identity).not.toBeNull();
    expect(identity!.agentId).toBe("agent-1");
    expect(identity!.permissions?.write).toBe(true);
  });

  it("rejects expired JWT", async () => {
    const { SignJWT } = await import("jose");
    const { createJwtAuth } = await import("../src/mcp/jwt.js");

    const secret = "test-secret";
    const authFn = createJwtAuth({ secret });

    const jwt = await new SignJWT({ sub: "agent-1" })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("-1h")
      .sign(new TextEncoder().encode(secret));

    const mockReq = { headers: { authorization: `Bearer ${jwt}` } } as unknown as import("express").Request;
    expect(await authFn(mockReq)).toBeNull();
  });

  it("rejects JWT with wrong audience", async () => {
    const { SignJWT } = await import("jose");
    const { createJwtAuth } = await import("../src/mcp/jwt.js");

    const secret = "test-secret";
    const authFn = createJwtAuth({ secret, audience: "agentdb" });

    const jwt = await new SignJWT({ sub: "agent-1" })
      .setProtectedHeader({ alg: "HS256" })
      .setAudience("wrong-audience")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(secret));

    const mockReq = { headers: { authorization: `Bearer ${jwt}` } } as unknown as import("express").Request;
    expect(await authFn(mockReq)).toBeNull();
  });

  it("rejects invalid JWT", async () => {
    const { createJwtAuth } = await import("../src/mcp/jwt.js");
    const authFn = createJwtAuth({ secret: "test-secret" });
    const mockReq = { headers: { authorization: "Bearer not-a-valid-jwt" } } as unknown as import("express").Request;
    expect(await authFn(mockReq)).toBeNull();
  });

  it("returns null for missing auth header", async () => {
    const { createJwtAuth } = await import("../src/mcp/jwt.js");
    const authFn = createJwtAuth({ secret: "test-secret" });
    const mockReq = { headers: {} } as unknown as import("express").Request;
    expect(await authFn(mockReq)).toBeNull();
  });

  it("throws if no secret or jwksUrl provided", async () => {
    const { createJwtAuth } = await import("../src/mcp/jwt.js");
    expect(() => createJwtAuth({})).toThrow("requires either");
  });
});

describe("Rate Limiter", () => {
  it("allows requests under limit", async () => {
    const { RateLimiter } = await import("../src/mcp/auth.js");
    const limiter = new RateLimiter(5, 1000);
    for (let i = 0; i < 5; i++) expect(limiter.check("test")).toBe(true);
  });

  it("blocks requests over limit", async () => {
    const { RateLimiter } = await import("../src/mcp/auth.js");
    const limiter = new RateLimiter(3, 1000);
    limiter.check("test"); limiter.check("test"); limiter.check("test");
    expect(limiter.check("test")).toBe(false);
  });

  it("resets after window expires", async () => {
    const { RateLimiter } = await import("../src/mcp/auth.js");
    const limiter = new RateLimiter(2, 50);
    limiter.check("test"); limiter.check("test");
    expect(limiter.check("test")).toBe(false);
    await new Promise((r) => setTimeout(r, 100));
    expect(limiter.check("test")).toBe(true);
  });

  it("tracks different keys independently", async () => {
    const { RateLimiter } = await import("../src/mcp/auth.js");
    const limiter = new RateLimiter(2, 1000);
    limiter.check("a"); limiter.check("a");
    expect(limiter.check("a")).toBe(false);
    expect(limiter.check("b")).toBe(true);
  });
});

describe("Audit Logger", () => {
  it("logs and retrieves entries", async () => {
    const { AuditLogger } = await import("../src/mcp/auth.js");
    const logger = new AuditLogger();
    logger.log({ timestamp: "2026-01-01", agentId: "bot", method: "tools/call", tool: "db_find" });
    logger.log({ timestamp: "2026-01-02", agentId: "bot", method: "tools/call", tool: "db_insert" });
    expect(logger.recent(10)).toHaveLength(2);
  });

  it("caps entries at maxEntries", async () => {
    const { AuditLogger } = await import("../src/mcp/auth.js");
    const logger = new AuditLogger(3);
    for (let i = 0; i < 5; i++) logger.log({ timestamp: `t${i}`, agentId: "bot", method: "m" });
    expect(logger.recent(10)).toHaveLength(3);
  });
});
