import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const CLI = join(__dirname, "..", "dist", "mcp", "cli.js");

class MinimalMcpClient {
  private proc: ChildProcess;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 1;

  constructor(dataDir: string, extraArgs: string[] = []) {
    this.proc = spawn("node", [CLI, "--path", dataDir, ...extraArgs], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const rl = createInterface({ input: this.proc.stdout! });
    rl.on("line", (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve } = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          resolve(msg);
        }
      } catch { /* ignore non-JSON lines */ }
    });

    this.proc.on("error", (err) => {
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    });
  }

  private request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for ${method} (id=${id})`));
      }, 10000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v as Record<string, unknown>); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "e2e-schemas-test", version: "1.0.0" },
    });
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const response = await this.request("tools/call", { name, arguments: args });
    const result = response.result as Record<string, unknown>;
    const content = result.content as Array<{ type: string; text: string }>;
    if (result.isError) throw new Error(`Tool ${name} error: ${content[0].text}`);
    return JSON.parse(content[0].text);
  }

  async close(): Promise<void> {
    this.proc.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      this.proc.on("exit", () => resolve());
      setTimeout(() => { this.proc.kill("SIGKILL"); resolve(); }, 3000);
    });
  }
}

describe("CLI --schemas e2e", () => {
  let tmpDir: string;
  let schemaPath: string;
  let client: MinimalMcpClient;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agentdb-schemas-e2e-"));
    schemaPath = join(tmpDir, "products.json");
    await writeFile(
      schemaPath,
      JSON.stringify({
        name: "products",
        description: "Product catalog",
        fields: { sku: { type: "string", required: true }, price: { type: "number" } },
        indexes: ["sku"],
      }),
      "utf-8",
    );

    client = new MinimalMcpClient(tmpDir, ["--schemas", schemaPath]);
    await client.initialize();
  }, 15000);

  afterAll(async () => {
    await client.close();
    await rm(tmpDir, { recursive: true, force: true });
  }, 10000);

  it("schema is persisted and queryable via db_get_schema after --schemas load", async () => {
    const result = await client.callTool("db_get_schema", { collection: "products" }) as { schema: Record<string, unknown> | null };
    expect(result.schema).not.toBeNull();
    expect(result.schema!.description).toBe("Product catalog");
  });

  it("schema has correct fields after --schemas load", async () => {
    const result = await client.callTool("db_get_schema", { collection: "products" }) as { schema: Record<string, unknown> };
    const fields = result.schema.fields as Record<string, Record<string, unknown>>;
    expect(fields.sku.type).toBe("string");
    expect(fields.sku.required).toBe(true);
    expect(fields.price.type).toBe("number");
  });

  it("schema has correct indexes after --schemas load", async () => {
    const result = await client.callTool("db_get_schema", { collection: "products" }) as { schema: Record<string, unknown> };
    expect(result.schema.indexes).toContain("sku");
  });

  it("multiple --schemas flags union their results", async () => {
    const extraDir = await mkdtemp(join(tmpdir(), "agentdb-schemas-multi-"));
    try {
      const s1 = join(extraDir, "cats.json");
      const s2 = join(extraDir, "dogs.json");
      await writeFile(s1, JSON.stringify({ name: "cats", description: "Cat records" }), "utf-8");
      await writeFile(s2, JSON.stringify({ name: "dogs", description: "Dog records" }), "utf-8");

      const multiClient = new MinimalMcpClient(extraDir, ["--schemas", s1, "--schemas", s2]);
      await multiClient.initialize();
      try {
        const cats = await multiClient.callTool("db_get_schema", { collection: "cats" }) as { schema: Record<string, unknown> | null };
        const dogs = await multiClient.callTool("db_get_schema", { collection: "dogs" }) as { schema: Record<string, unknown> | null };
        expect(cats.schema?.description).toBe("Cat records");
        expect(dogs.schema?.description).toBe("Dog records");
      } finally {
        await multiClient.close();
      }
    } finally {
      await rm(extraDir, { recursive: true, force: true });
    }
  }, 15000);
});
