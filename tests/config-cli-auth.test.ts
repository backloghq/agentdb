/**
 * R5/1 integration tests — verify that JWT and multi-token auth are actually
 * enforced when wired through the CLI config pipeline.
 *
 * Spawns the built CLI binary in HTTP mode with auth configured via env vars
 * or a config file, then makes real HTTP requests to assert:
 *   - Unauthenticated requests get 401
 *   - Valid credentials get a successful response
 *
 * Requires `dist/mcp/cli.js` — skipped automatically when absent.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SignJWT } from "jose";

const CLI = join(__dirname, "..", "dist", "mcp", "cli.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmp: string;

beforeAll(() => {
  tmp = join(tmpdir(), `agentdb-auth-test-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Start the CLI in HTTP mode. Resolves once the server startup message appears in stderr. */
function startServer(
  args: string[],
  opts: { env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<{ proc: ChildProcess; port: number; kill: () => void; getStderr: () => string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [CLI, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...opts.env },
    });

    let stderr = "";
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        proc.kill("SIGKILL");
        reject(new Error(`Server did not start within ${opts.timeoutMs ?? 6000}ms. stderr: ${stderr}`));
      }
    }, opts.timeoutMs ?? 6000);

    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      // Wait for the startup "running on http://" line to know the port
      const m = stderr.match(/:(\d+)\/mcp/);
      if (m && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({
          proc,
          port: parseInt(m[1], 10),
          kill: () => proc.kill("SIGKILL"),
          getStderr: () => stderr,
        });
      }
    });

    proc.on("close", (code) => {
      if (!resolved) {
        clearTimeout(timeout);
        reject(new Error(`Server exited early with code ${code}. stderr: ${stderr}`));
      }
    });
  });
}

/** Make a minimal MCP POST to the server. Returns the HTTP status code. */
async function mcpPost(port: number, headers: Record<string, string> = {}): Promise<number> {
  const resp = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/list",
      params: {},
      id: 1,
    }),
  });
  return resp.status;
}

/** Sign a JWT with the given HMAC secret. */
async function signJwt(secret: string, claims: Record<string, unknown> = {}): Promise<string> {
  const key = new TextEncoder().encode(secret);
  return new SignJWT({ sub: "test-agent", ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!existsSync(CLI))("R5/1 auth wiring integration", () => {
  // --------------------------------------------------------------------------
  // JWT auth via AGENTDB_HTTP_JWT_SECRET
  // --------------------------------------------------------------------------

  it("JWT: unauthenticated request returns 401", async () => {
    const port = 39300 + Math.floor(Math.random() * 100);
    const dataDir = join(tmp, "jwt-data-1");
    const secret = "test-jwt-secret-r51-xxxxxxxxxxxxxxx"; // ≥32 chars

    const srv = await startServer(["--http", "--port", String(port), "--path", dataDir], {
      env: { AGENTDB_HTTP_JWT_SECRET: secret },
    });
    try {
      const status = await mcpPost(port);
      expect(status).toBe(401);
    } finally {
      srv.kill();
    }
  }, 15000);

  it("JWT: request with valid token returns 200 (not 401/403)", async () => {
    const port = 39400 + Math.floor(Math.random() * 100);
    const dataDir = join(tmp, "jwt-data-2");
    const secret = "test-jwt-secret-r51-valid-xxxxxxxxx";

    const srv = await startServer(["--http", "--port", String(port), "--path", dataDir], {
      env: { AGENTDB_HTTP_JWT_SECRET: secret },
    });
    try {
      const token = await signJwt(secret);
      const status = await mcpPost(port, { Authorization: `Bearer ${token}` });
      expect(status).not.toBe(401);
      expect(status).not.toBe(403);
    } finally {
      srv.kill();
    }
  }, 15000);

  it("JWT: startup log confirms JWT auth is active", async () => {
    const port = 39500 + Math.floor(Math.random() * 100);
    const dataDir = join(tmp, "jwt-data-3");
    const secret = "test-jwt-secret-r51-log-xxxxxxxxxx";

    const srv = await startServer(["--http", "--port", String(port), "--path", dataDir], {
      env: { AGENTDB_HTTP_JWT_SECRET: secret },
    });
    srv.kill();
    // The resolve already waited for ":port/mcp" — we also need to check stderr
    // The server logs "Authentication: JWT (HMAC secret)" after startup
    // Wait briefly for final log lines
    await new Promise((r) => setTimeout(r, 200));

    // Re-start briefly to capture stderr — already captured in startServer stderr
    // Instead, verify via a fresh spawn that the startup log appears
    const result = await new Promise<string>((res) => {
      const p = spawn("node", [CLI, "--http", "--port", String(port + 1), "--path", dataDir], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, AGENTDB_HTTP_JWT_SECRET: secret },
      });
      let out = "";
      p.stderr.on("data", (d: Buffer) => { out += d.toString(); });
      setTimeout(() => { p.kill("SIGKILL"); res(out); }, 2000);
    });
    expect(result).toContain("JWT");
  }, 15000);

  // --------------------------------------------------------------------------
  // Multi-token auth via config file http.multiToken
  // --------------------------------------------------------------------------

  it("multi-token: unauthenticated request returns 401", async () => {
    const port = 39600 + Math.floor(Math.random() * 100);
    const dataDir = join(tmp, "mt-data-1");
    const cfgPath = join(tmp, "mt-cfg-1.json");
    writeFileSync(cfgPath, JSON.stringify({
      http: { multiToken: ["secret-token-a", "secret-token-b"] },
    }));

    const srv = await startServer(["--http", "--port", String(port), "--path", dataDir, "--config", cfgPath]);
    try {
      const status = await mcpPost(port);
      expect(status).toBe(401);
    } finally {
      srv.kill();
    }
  }, 15000);

  it("multi-token: request with valid token returns 200", async () => {
    const port = 39700 + Math.floor(Math.random() * 100);
    const dataDir = join(tmp, "mt-data-2");
    const cfgPath = join(tmp, "mt-cfg-2.json");
    writeFileSync(cfgPath, JSON.stringify({
      http: { multiToken: ["secret-token-c", "secret-token-d"] },
    }));

    const srv = await startServer(["--http", "--port", String(port), "--path", dataDir, "--config", cfgPath]);
    try {
      const status = await mcpPost(port, { Authorization: "Bearer secret-token-c" });
      expect(status).not.toBe(401);
      expect(status).not.toBe(403);
    } finally {
      srv.kill();
    }
  }, 15000);

  it("multi-token: wrong token returns 401", async () => {
    const port = 39800 + Math.floor(Math.random() * 100);
    const dataDir = join(tmp, "mt-data-3");
    const cfgPath = join(tmp, "mt-cfg-3.json");
    writeFileSync(cfgPath, JSON.stringify({
      http: { multiToken: ["secret-token-e", "secret-token-f"] },
    }));

    const srv = await startServer(["--http", "--port", String(port), "--path", dataDir, "--config", cfgPath]);
    try {
      const status = await mcpPost(port, { Authorization: "Bearer wrong-token" });
      expect(status).toBe(401);
    } finally {
      srv.kill();
    }
  }, 15000);

  it("multi-token via AGENTDB_HTTP_MULTI_TOKEN env var", async () => {
    const port = 39900 + Math.floor(Math.random() * 100);
    const dataDir = join(tmp, "mt-data-env");

    const srv = await startServer(["--http", "--port", String(port), "--path", dataDir], {
      env: { AGENTDB_HTTP_MULTI_TOKEN: '["env-token-x","env-token-y"]' },
    });
    try {
      expect(await mcpPost(port)).toBe(401);
      expect(await mcpPost(port, { Authorization: "Bearer env-token-x" })).not.toBe(401);
    } finally {
      srv.kill();
    }
  }, 15000);

  // --------------------------------------------------------------------------
  // rateLimitWindow threads through
  // --------------------------------------------------------------------------

  it("rateLimitWindow from config is accepted (no startup error)", async () => {
    const port = 39110 + Math.floor(Math.random() * 100);
    const dataDir = join(tmp, "rlw-data");
    const cfgPath = join(tmp, "rlw-cfg.json");
    writeFileSync(cfgPath, JSON.stringify({
      http: { rateLimit: 60, rateLimitWindow: 30000 },
    }));

    const srv = await startServer(
      ["--http", "--port", String(port), "--path", dataDir, "--config", cfgPath],
    );
    try {
      // Just verify it started correctly — no auth error
      const status = await mcpPost(port);
      // No auth configured → pass-through (200 or protocol-specific non-401)
      expect(status).not.toBe(500);
    } finally {
      srv.kill();
    }
  }, 15000);

  // --------------------------------------------------------------------------
  // R6/3: Auth precedence — JWT wins when multiple mechanisms configured
  // --------------------------------------------------------------------------

  it("auth precedence: JWT wins over multi-token when both are configured", async () => {
    // When JWT secret + multi-token are both set, the CLI must:
    //   (a) emit the "multiple auth mechanisms" conflict warn
    //   (b) enforce JWT — so a valid JWT is accepted
    //   (c) reject a multi-token bearer (multi-token is silently dropped)
    const port = 39120 + Math.floor(Math.random() * 100);
    const dataDir = join(tmp, "precedence-data");
    const cfgPath = join(tmp, "precedence-cfg.json");
    const secret = "precedence-jwt-secret-r63-xxxxxxx";
    const multiTok = "multi-tok-should-be-ignored";

    writeFileSync(cfgPath, JSON.stringify({ http: { multiToken: [multiTok] } }));

    const srv = await startServer(
      ["--http", "--port", String(port), "--path", dataDir, "--config", cfgPath],
      { env: { AGENTDB_HTTP_JWT_SECRET: secret } },
    );
    try {
      // Give the process a moment to flush remaining stderr lines
      await new Promise((r) => setTimeout(r, 200));
      const stderr = srv.getStderr();

      // (a) conflict warn fired
      expect(stderr).toContain("multiple auth mechanisms");

      // (b) valid JWT is accepted
      const jwtToken = await signJwt(secret);
      expect(await mcpPost(port, { Authorization: `Bearer ${jwtToken}` })).not.toBe(401);

      // (c) multi-token bearer is rejected (JWT mechanism is active, not multi-token)
      expect(await mcpPost(port, { Authorization: `Bearer ${multiTok}` })).toBe(401);
    } finally {
      srv.kill();
    }
  }, 15000);

  // --------------------------------------------------------------------------
  // R6/3: Vendor key fallbacks — VOYAGE_API_KEY / COHERE_API_KEY
  // --------------------------------------------------------------------------

  it("vendor key fallback: VOYAGE_API_KEY used when AGENTDB_EMBEDDINGS_API_KEY absent", async () => {
    // The server should start and log "Embeddings: voyage" even when only VOYAGE_API_KEY
    // is set (not AGENTDB_EMBEDDINGS_API_KEY). This verifies the fallback in resolveAgentDBOpts.
    const port = 39130 + Math.floor(Math.random() * 100);
    const dataDir = join(tmp, "voyage-fallback-data");

    const srv = await startServer(
      ["--http", "--port", String(port), "--path", dataDir, "--embeddings", "voyage"],
      { env: { VOYAGE_API_KEY: "test-voyage-key-r63" } },
    );
    try {
      const stderr = srv.getStderr();
      expect(stderr).toContain("Embeddings: voyage");
      // Server is live — no startup error from missing key
      expect(await mcpPost(port)).not.toBe(500);
    } finally {
      srv.kill();
    }
  }, 15000);

  it("vendor key fallback: COHERE_API_KEY used when AGENTDB_EMBEDDINGS_API_KEY absent", async () => {
    const port = 39140 + Math.floor(Math.random() * 100);
    const dataDir = join(tmp, "cohere-fallback-data");

    const srv = await startServer(
      ["--http", "--port", String(port), "--path", dataDir, "--embeddings", "cohere"],
      { env: { COHERE_API_KEY: "test-cohere-key-r63" } },
    );
    try {
      const stderr = srv.getStderr();
      expect(stderr).toContain("Embeddings: cohere");
      expect(await mcpPost(port)).not.toBe(500);
    } finally {
      srv.kill();
    }
  }, 15000);
});
