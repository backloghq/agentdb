/**
 * Tenant-binding test suite for AgentDB HTTP MCP auth.
 *
 * Covers the binding contract:
 *   - JWT path: tid claim must match expectedTenantId; missing/wrong/non-string
 *     types/case-mismatch all rejected with TenantMismatchError → distinct
 *     audit event class.
 *   - Static-token path: tokens-map entries must declare matching tenantId;
 *     entries lacking it fail closed; permissions field never inspected on
 *     wrong-tenant rejection (verified via 401 + audit-event class).
 *   - Identity propagates tenantId through to the audit log on success.
 *   - /health stays open regardless of expectedTenantId.
 *   - Startup validation rejects empty / whitespace-only / oversize tenant IDs.
 *   - Error responses MUST NOT echo the expected tenant ID.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHttp } from "../src/mcp/index.js";
import { validateTenantId } from "../src/mcp/tenant-binding.js";

const EXPECTED_TENANT = "tenant-a";
const OTHER_TENANT = "tenant-b";
const JWT_SECRET = "tenant-binding-test-secret-min-32-chars-long";

async function mcpRequest(
  port: number,
  headers?: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } },
    }),
  });
  const text = await res.text();
  if (text.includes("data:")) {
    const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
    if (dataLine) return { status: res.status, body: JSON.parse(dataLine.slice(5).trim()) };
  }
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: { raw: text } };
  }
}

async function signJwt(payload: Record<string, unknown>): Promise<string> {
  const { SignJWT } = await import("jose");
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setAudience("agentdb")
    .setIssuer("test")
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(JWT_SECRET));
}

describe("Tenant-binding — JWT path", () => {
  let tmpDir: string;
  let close: () => Promise<void>;
  let port: number;
  let auditLog: { recent: (limit?: number) => Array<Record<string, unknown>> };

  beforeAll(async () => {
    const { createJwtAuth } = await import("../src/mcp/jwt.js");
    tmpDir = await mkdtemp(join(tmpdir(), "agentdb-tenant-jwt-"));
    const authFn = createJwtAuth({
      secret: JWT_SECRET,
      audience: "agentdb",
      issuer: "test",
      expectedTenantId: EXPECTED_TENANT,
    });
    const result = await startHttp(tmpDir, { port: 0, authFn, expectedTenantId: EXPECTED_TENANT });
    close = result.close;
    port = result.port;
    auditLog = result.auditLog as unknown as typeof auditLog;
  }, 15000);

  afterAll(async () => {
    await close();
    await rm(tmpDir, { recursive: true, force: true });
  }, 10000);

  it("accepts JWT with correct tid claim", async () => {
    const jwt = await signJwt({ sub: "agent-1", tid: EXPECTED_TENANT });
    const res = await mcpRequest(port, { Authorization: `Bearer ${jwt}` });
    expect(res.status).toBe(200);
  });

  it("rejects JWT missing tid claim", async () => {
    const jwt = await signJwt({ sub: "agent-1" });
    const res = await mcpRequest(port, { Authorization: `Bearer ${jwt}` });
    expect(res.status).toBe(401);
    // Generic message — must not echo expectedTenantId.
    expect(JSON.stringify(res.body)).not.toContain(EXPECTED_TENANT);
  });

  it("rejects JWT with wrong tid", async () => {
    const jwt = await signJwt({ sub: "agent-1", tid: OTHER_TENANT });
    const res = await mcpRequest(port, { Authorization: `Bearer ${jwt}` });
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain(EXPECTED_TENANT);
  });

  it("rejects JWT with non-string tid (number, array, object)", async () => {
    for (const bad of [42, ["tenant-a"], { id: "tenant-a" }]) {
      const jwt = await signJwt({ sub: "agent-1", tid: bad });
      const res = await mcpRequest(port, { Authorization: `Bearer ${jwt}` });
      expect(res.status).toBe(401);
    }
  });

  it("rejects JWT with case-differing tid (case-exact comparison)", async () => {
    const jwt = await signJwt({ sub: "agent-1", tid: EXPECTED_TENANT.toUpperCase() });
    const res = await mcpRequest(port, { Authorization: `Bearer ${jwt}` });
    expect(res.status).toBe(401);
  });

  it("emits a distinct tenant_mismatch audit event for binding failures", async () => {
    // Make a request that will fail on tenant binding (signature OK, tid wrong).
    const jwt = await signJwt({ sub: "agent-1", tid: OTHER_TENANT });
    await mcpRequest(port, { Authorization: `Bearer ${jwt}` });

    const recent = auditLog.recent(50);
    const mismatchEvents = recent.filter((e) => e.event === "tenant_mismatch");
    expect(mismatchEvents.length).toBeGreaterThan(0);
    // tenant_mismatch entries are distinct from regular request entries
    // (which never carry an `event` field).
    expect(mismatchEvents[0].agentId).toBeUndefined();
  });

  it("identity carries tenantId on successful auth (audit log records it)", async () => {
    const jwt = await signJwt({ sub: "agent-1", tid: EXPECTED_TENANT });
    await mcpRequest(port, { Authorization: `Bearer ${jwt}` });
    const recent = auditLog.recent(50);
    const successEntry = recent.find((e) => !e.event && e.agentId === "agent-1");
    expect(successEntry).toBeDefined();
    expect(successEntry?.tenantId).toBe(EXPECTED_TENANT);
  });
});

describe("Tenant-binding — static-token path", () => {
  let tmpDir: string;
  let close: () => Promise<void>;
  let port: number;
  let auditLog: { recent: (limit?: number) => Array<Record<string, unknown>> };

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agentdb-tenant-static-"));
    const result = await startHttp(tmpDir, {
      port: 0,
      expectedTenantId: EXPECTED_TENANT,
      authTokens: {
        // Has correct tenantId — accepted.
        "token-bound": { agentId: "bound-agent", tenantId: EXPECTED_TENANT, permissions: { read: true, write: true } },
        // No tenantId — fails closed.
        "token-unbound": { agentId: "unbound-agent", permissions: { read: true, write: true, admin: true } },
        // Wrong tenantId — rejected; permissions field never inspected.
        "token-wrong-tenant": { agentId: "wrong-tenant-agent", tenantId: OTHER_TENANT, permissions: { admin: true } },
      },
    });
    close = result.close;
    port = result.port;
    auditLog = result.auditLog as unknown as typeof auditLog;
  }, 15000);

  afterAll(async () => {
    await close();
    await rm(tmpDir, { recursive: true, force: true });
  }, 10000);

  it("accepts static token bound to the correct tenant", async () => {
    const res = await mcpRequest(port, { Authorization: "Bearer token-bound" });
    expect(res.status).toBe(200);
  });

  it("rejects static token without bound tenantId (fail-closed)", async () => {
    const res = await mcpRequest(port, { Authorization: "Bearer token-unbound" });
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain(EXPECTED_TENANT);
  });

  it("rejects static token with wrong tenantId (permissions never inspected)", async () => {
    const res = await mcpRequest(port, { Authorization: "Bearer token-wrong-tenant" });
    expect(res.status).toBe(401);
    // The audit-log event records agentId but never echoes permissions.
    const recent = auditLog.recent(50);
    const mismatch = recent.find((e) => e.event === "tenant_mismatch" && e.agentId === "wrong-tenant-agent");
    expect(mismatch).toBeDefined();
    // Whole entry serialized must not include any permissions key.
    expect(JSON.stringify(mismatch)).not.toContain("permissions");
  });
});

describe("Tenant-binding — health endpoint carve-out", () => {
  let tmpDir: string;
  let close: () => Promise<void>;
  let port: number;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agentdb-tenant-health-"));
    const result = await startHttp(tmpDir, {
      port: 0,
      authToken: "any-token",
      expectedTenantId: EXPECTED_TENANT,
    });
    close = result.close;
    port = result.port;
  }, 15000);

  afterAll(async () => {
    await close();
    await rm(tmpDir, { recursive: true, force: true });
  }, 10000);

  it("/health stays 200 with no auth regardless of tenant binding", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });
});

describe("Tenant-binding — startup validation", () => {
  it("rejects empty tenant id", () => {
    expect(() => validateTenantId("")).toThrow();
  });
  it("rejects whitespace-only tenant id", () => {
    expect(() => validateTenantId("   ")).toThrow();
  });
  it("rejects tenant id with leading/trailing whitespace", () => {
    expect(() => validateTenantId(" tenant-a")).toThrow();
    expect(() => validateTenantId("tenant-a ")).toThrow();
  });
  it("rejects oversize tenant id (>256 chars)", () => {
    expect(() => validateTenantId("a".repeat(257))).toThrow();
  });
  it("accepts a normal tenant id", () => {
    expect(() => validateTenantId("tenant-a")).not.toThrow();
    expect(() => validateTenantId("550e8400-e29b-41d4-a716-446655440000")).not.toThrow();
  });
});
