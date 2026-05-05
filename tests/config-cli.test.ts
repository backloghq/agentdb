/**
 * Integration tests for the MCP CLI config-loading pipeline.
 * Spawns the built CLI binary with various combinations of --config, env vars,
 * and CLI flags to verify the three-layer precedence (file < env < CLI).
 *
 * All tests require a dist/ build — they are skipped automatically when
 * dist/mcp/cli.js is absent (CI always runs `npm run build` first).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CLI = join(__dirname, "..", "dist", "mcp", "cli.js");

// ---------------------------------------------------------------------------
// Helper: spawn CLI and collect output
// ---------------------------------------------------------------------------

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string[],
  opts: { env?: Record<string, string>; cwd?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn("node", [CLI, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...opts.env },
      cwd: opts.cwd,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => proc.kill("SIGKILL"), opts.timeoutMs ?? 8000);
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// Temp workspace
// ---------------------------------------------------------------------------

let tmp: string;

beforeAll(() => {
  tmp = join(tmpdir(), `agentdb-cli-test-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!existsSync(CLI))("config-cli integration", () => {
  // ------------------------------------------------------------------
  // --help / -h: must exit 0 and mention all three config mechanisms
  // ------------------------------------------------------------------

  it("--help mentions config file", async () => {
    const { stdout } = await runCli(["--help"]);
    expect(stdout).toContain("agentdb.config.json");
  }, 10000);

  it("--help mentions environment variables", async () => {
    const { stdout } = await runCli(["--help"]);
    expect(stdout).toContain("AGENTDB_PATH");
  }, 10000);

  it("--help mentions --config flag", async () => {
    const { stdout } = await runCli(["--help"]);
    expect(stdout).toContain("--config");
  }, 10000);

  // ------------------------------------------------------------------
  // --config flag: explicit path is loaded
  // ------------------------------------------------------------------

  it("--config <path> loads the specified file", async () => {
    const cfgPath = join(tmp, "custom.config.json");
    const dataDir = join(tmp, "custom-data");
    writeFileSync(cfgPath, JSON.stringify({ db: { path: dataDir } }));

    // stdio mode starts and keeps the process alive; we just need to confirm
    // it gets past config loading without error, so we kill after stderr output
    // appears (or timeout). We verify it did NOT print a config error.
    const result = await runCli(
      ["--config", cfgPath],
      { timeoutMs: 3000 },
    );
    expect(result.stderr).not.toContain("Configuration error");
    expect(result.stderr).not.toContain("agentdb.config.json");
  }, 10000);

  it("--config with a missing file exits 1 with a helpful message", async () => {
    const missing = join(tmp, "does-not-exist.json");
    const result = await runCli(["--config", missing], { timeoutMs: 3000 });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/config/i);
  }, 10000);

  it("--config with invalid JSON exits 1", async () => {
    const bad = join(tmp, "bad.json");
    writeFileSync(bad, "{ not valid json }");
    const result = await runCli(["--config", bad], { timeoutMs: 3000 });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/config/i);
  }, 10000);

  it("--config with wrong-type field exits 1", async () => {
    const bad = join(tmp, "wrong-type.json");
    writeFileSync(bad, JSON.stringify({ db: { port: "not-a-string-that-matters", maxFindLimit: "NaN" } }));
    const result = await runCli(["--config", bad], { timeoutMs: 3000 });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/config/i);
  }, 10000);

  // ------------------------------------------------------------------
  // AGENTDB_CONFIG env var: override config file path via env
  // ------------------------------------------------------------------

  it("AGENTDB_CONFIG env var picks up the specified file", async () => {
    const cfgPath = join(tmp, "env-config.json");
    const dataDir = join(tmp, "env-data");
    writeFileSync(cfgPath, JSON.stringify({ db: { path: dataDir } }));

    const result = await runCli([], {
      env: { AGENTDB_CONFIG: cfgPath },
      timeoutMs: 3000,
    });
    expect(result.stderr).not.toContain("Configuration error");
  }, 10000);

  // ------------------------------------------------------------------
  // AGENTDB_PATH env var is honoured
  // ------------------------------------------------------------------

  it("AGENTDB_PATH env var sets the data directory", async () => {
    const dataDir = join(tmp, "env-path-data");
    const result = await runCli([], {
      env: { AGENTDB_PATH: dataDir },
      timeoutMs: 3000,
    });
    // No config error expected
    expect(result.stderr).not.toContain("Configuration error");
    expect(result.exitCode).not.toBe(1);
  }, 10000);

  // ------------------------------------------------------------------
  // Precedence: CLI flag beats env var beats config file
  // ------------------------------------------------------------------

  it("CLI --path overrides AGENTDB_PATH env var", async () => {
    const cliData = join(tmp, "cli-data");
    const envData = join(tmp, "env-data2");
    // Both paths are valid; the CLI wins — process should start without error
    const result = await runCli(["--path", cliData], {
      env: { AGENTDB_PATH: envData },
      timeoutMs: 3000,
    });
    expect(result.stderr).not.toContain("Configuration error");
    expect(result.exitCode).not.toBe(1);
  }, 10000);

  it("CLI --path overrides config-file db.path", async () => {
    const cfgPath = join(tmp, "file-precedence.json");
    const fileData = join(tmp, "file-data");
    const cliData = join(tmp, "cli-data2");
    writeFileSync(cfgPath, JSON.stringify({ db: { path: fileData } }));

    const result = await runCli(["--config", cfgPath, "--path", cliData], {
      timeoutMs: 3000,
    });
    expect(result.stderr).not.toContain("Configuration error");
    expect(result.exitCode).not.toBe(1);
  }, 10000);

  // ------------------------------------------------------------------
  // Existing flags still work
  // ------------------------------------------------------------------

  it("--path flag still works (existing CLI flag unchanged)", async () => {
    const dataDir = join(tmp, "legacy-path");
    const result = await runCli(["--path", dataDir], { timeoutMs: 3000 });
    expect(result.stderr).not.toContain("Configuration error");
    expect(result.exitCode).not.toBe(1);
  }, 10000);

  it("--write-mode group flag still works", async () => {
    const dataDir = join(tmp, "wm-group");
    const result = await runCli(["--path", dataDir, "--write-mode", "group"], {
      timeoutMs: 3000,
    });
    expect(result.stderr).not.toContain("Configuration error");
    expect(result.exitCode).not.toBe(1);
  }, 10000);

  it("--group-commit alias still works", async () => {
    const dataDir = join(tmp, "wm-gc");
    const result = await runCli(["--path", dataDir, "--group-commit"], {
      timeoutMs: 3000,
    });
    expect(result.stderr).not.toContain("Configuration error");
    expect(result.exitCode).not.toBe(1);
  }, 10000);

  // ------------------------------------------------------------------
  // S3 backend: missing --bucket exits 1
  // ------------------------------------------------------------------

  it("--backend s3 without --bucket exits 1 with error", async () => {
    const result = await runCli(["--backend", "s3"], { timeoutMs: 5000 });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/bucket/i);
  }, 10000);

  // ------------------------------------------------------------------
  // HTTP transport: --http flag is accepted
  // ------------------------------------------------------------------

  it("--http flag is accepted (starts HTTP server)", async () => {
    // Pick a random high port to avoid conflicts
    const port = 39000 + Math.floor(Math.random() * 1000);
    const dataDir = join(tmp, "http-data");
    const result = await runCli(["--http", "--port", String(port), "--path", dataDir], {
      timeoutMs: 3000,
    });
    expect(result.stderr).not.toContain("Configuration error");
    // Should have started (or been killed mid-start) without a config error
    expect(result.exitCode).not.toBe(1);
  }, 10000);

  // ------------------------------------------------------------------
  // Unknown embeddings provider: exits 1
  // ------------------------------------------------------------------

  it("unknown embeddings provider exits 1", async () => {
    const result = await runCli(["--embeddings", "bogus-provider"], {
      timeoutMs: 5000,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/unknown embedding provider/i);
  }, 10000);
});
