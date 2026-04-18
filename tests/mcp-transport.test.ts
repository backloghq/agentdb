import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHttp, createMcpServer } from "../src/mcp/index.js";
import { AgentDB } from "../src/agentdb.js";

let tmpDir: string;
let close: (() => Promise<void>) | undefined;
let port: number;

afterEach(async () => {
  if (close) {
    await close();
    close = undefined;
  }
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
  }
}, 10000);

async function setup(opts?: Parameters<typeof startHttp>[1]) {
  tmpDir = await mkdtemp(join(tmpdir(), "agentdb-transport-"));
  const result = await startHttp(tmpDir, { port: 0, ...opts });
  close = result.close;
  port = result.port;
  return result;
}

describe("MCP HTTP Transport", () => {
  describe("health endpoint", () => {
    it("GET /health returns { status: 'ok', version }", async () => {
      await setup();
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("ok");
      expect(typeof body.version).toBe("string");
      expect(body.version.length).toBeGreaterThan(0);
    });
  });

  describe("security headers", () => {
    it("response includes all security headers", async () => {
      await setup();
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("strict-transport-security")).toBe(
        "max-age=31536000; includeSubDomains",
      );
    });
  });

  describe("invalid request", () => {
    it("POST /mcp without session ID and non-initialize body returns 400", async () => {
      await setup();
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Invalid request");
    });
  });

  describe("CORS", () => {
    it("allowed origin gets CORS headers", async () => {
      await setup({ corsOrigins: ["https://example.com"] });
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { Origin: "https://example.com" },
      });
      expect(res.headers.get("access-control-allow-origin")).toBe(
        "https://example.com",
      );
      expect(res.headers.get("vary")).toBe("Origin");
    });

    it("disallowed origin does not get CORS headers", async () => {
      await setup({ corsOrigins: ["https://example.com"] });
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { Origin: "https://evil.com" },
      });
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("OPTIONS preflight returns 204 for allowed origin", async () => {
      await setup({ corsOrigins: ["https://example.com"] });
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://example.com",
          "Access-Control-Request-Method": "POST",
        },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-methods")).toBe(
        "GET, POST, DELETE, OPTIONS",
      );
    });
  });

  describe("POST /mcp with valid session but invalid body", () => {
    it("returns an error when body is not valid JSON-RPC", async () => {
      await setup();

      // First, establish a valid session via initialize
      const initRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test-client", version: "1.0.0" },
          },
        }),
      });
      expect(initRes.status).toBe(200);
      const sessionId = initRes.headers.get("mcp-session-id");
      expect(sessionId).toBeTruthy();

      // Now POST with the valid session ID but a completely invalid body
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Mcp-Session-Id": sessionId!,
        },
        body: JSON.stringify({ not: "a valid jsonrpc message" }),
      });
      // The transport should reject with 400 for malformed JSON-RPC
      expect(res.status).toBe(400);
    });
  });

  describe("invalid session on GET/DELETE", () => {
    it("GET /mcp with invalid session ID returns 400", async () => {
      await setup();
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "GET",
        headers: { "Mcp-Session-Id": "nonexistent-session-id" },
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Invalid session");
    });

    it("DELETE /mcp with invalid session ID returns 400", async () => {
      await setup();
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "DELETE",
        headers: { "Mcp-Session-Id": "nonexistent-session-id" },
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Invalid session");
    });

    it("GET /mcp without session ID returns 400", async () => {
      await setup();
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "GET",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Invalid session");
    });

    it("DELETE /mcp without session ID returns 400", async () => {
      await setup();
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "DELETE",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Invalid session");
    });
  });
});

describe("createMcpServer — instructions", () => {
  let db: AgentDB;
  let dbDir: string;

  beforeEach(async () => {
    dbDir = await mkdtemp(join(tmpdir(), "agentdb-mcp-instr-"));
    db = new AgentDB(dbDir);
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    await rm(dbDir, { recursive: true, force: true });
  });

  it("server instructions mention all 5 v1.3 schema lifecycle tools", () => {
    const server = createMcpServer(db);
    const instructions: string = (server.server as unknown as { _instructions: string })._instructions;

    expect(instructions).toContain("db_get_schema");
    expect(instructions).toContain("db_set_schema");
    expect(instructions).toContain("db_diff_schema");
    expect(instructions).toContain("db_infer_schema");
    expect(instructions).toContain("db_delete_schema");
  });

  it("server instructions include discovery and query guidance", () => {
    const server = createMcpServer(db);
    const instructions: string = (server.server as unknown as { _instructions: string })._instructions;

    expect(instructions).toContain("db_collections");
    expect(instructions).toContain("db_find");
    expect(instructions).toContain("db_insert");
  });
});
