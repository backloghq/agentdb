import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

const CLI = join(__dirname, "..", "dist", "mcp", "cli.js");

function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn("node", [CLI, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) => resolve({ exitCode: code ?? 0, stdout, stderr }));
  });
}

describe.skipIf(!existsSync(CLI))("CLI --help", () => {
  it("exits 0", async () => {
    const { exitCode } = await runCli(["--help"]);
    expect(exitCode).toBe(0);
  }, 10000);

  it("-h is an alias for --help", async () => {
    const { exitCode } = await runCli(["-h"]);
    expect(exitCode).toBe(0);
  }, 10000);

  it("prints to stdout (not stderr)", async () => {
    const { stdout, stderr } = await runCli(["--help"]);
    expect(stdout.length).toBeGreaterThan(0);
    expect(stderr).toBe("");
  }, 10000);

  const expectedFlags = [
    "--path",
    "--http",
    "--port",
    "--host",
    "--backend",
    "--bucket",
    "--prefix",
    "--region",
    "--agent-id",
    "--auth-token",
    "--rate-limit",
    "--cors",
    "--write-mode",
    "--group-commit",
    "--embeddings",
    "--schemas",
    "--help",
  ];

  for (const flag of expectedFlags) {
    it(`documents ${flag}`, async () => {
      const { stdout } = await runCli(["--help"]);
      expect(stdout).toContain(flag);
    }, 10000);
  }
});
