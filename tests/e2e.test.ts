import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

/**
 * Lightweight MCP client that talks to the AgentDB server over stdio.
 * Sends JSON-RPC requests sequentially and matches responses by id.
 */
class TestMcpClient {
  private proc: ChildProcess;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private ready = false;

  constructor(dataDir: string) {
    this.proc = spawn("node", [join(__dirname, "..", "dist", "mcp", "cli.js"), "--path", dataDir], {
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
      } catch {
        // Ignore non-JSON lines
      }
    });

    this.proc.on("error", (err) => {
      for (const { reject } of this.pending.values()) {
        reject(err);
      }
      this.pending.clear();
    });
  }

  private send(msg: Record<string, unknown>): void {
    this.proc.stdin!.write(JSON.stringify(msg) + "\n");
  }

  private request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for response to ${method} (id=${id})`));
      }, 10000);

      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as Record<string, unknown>);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });

      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "e2e-test", version: "1.0.0" },
    });
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    this.ready = true;
  }

  async call(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.ready) throw new Error("Client not initialized");
    const response = await this.request("tools/call", { name: tool, arguments: args });
    const result = response.result as Record<string, unknown>;
    const content = result.content as Array<{ type: string; text: string }>;
    if (result.isError) {
      throw new Error(`Tool ${tool} error: ${content[0].text}`);
    }
    return JSON.parse(content[0].text);
  }

  async close(): Promise<void> {
    this.proc.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      this.proc.on("exit", () => resolve());
      setTimeout(() => {
        this.proc.kill("SIGKILL");
        resolve();
      }, 3000);
    });
  }
}

describe("E2E: MCP Server", () => {
  let client: TestMcpClient;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agentdb-e2e-"));
    client = new TestMcpClient(tmpDir);
    await client.initialize();
  }, 15000);

  afterAll(async () => {
    await client.close();
    await rm(tmpDir, { recursive: true, force: true });
  }, 10000);

  // --- Collection lifecycle ---

  it("db_collections returns empty initially", async () => {
    const result = await client.call("db_collections") as { collections: unknown[] };
    expect(result.collections).toEqual([]);
  });

  it("db_create creates a collection", async () => {
    const result = await client.call("db_create", { collection: "users" }) as { created: string };
    expect(result.created).toBe("users");
  });

  // --- Insert ---

  it("db_insert inserts a single record", async () => {
    const result = await client.call("db_insert", {
      collection: "users",
      record: { _id: "alice", name: "Alice", role: "admin", age: 30 },
      agent: "e2e-test",
      reason: "seeding",
    }) as { ids: string[]; inserted: number };
    expect(result.inserted).toBe(1);
    expect(result.ids[0]).toBe("alice");
  });

  it("db_insert inserts multiple records", async () => {
    const result = await client.call("db_insert", {
      collection: "users",
      records: [
        { _id: "bob", name: "Bob", role: "user", age: 25 },
        { _id: "charlie", name: "Charlie", role: "admin", age: 45 },
        { _id: "diana", name: "Diana", role: "moderator", age: 35 },
      ],
    }) as { ids: string[]; inserted: number };
    expect(result.inserted).toBe(3);
    expect(result.ids).toEqual(["bob", "charlie", "diana"]);
  });

  // --- Query ---

  it("db_find returns all records", async () => {
    const result = await client.call("db_find", { collection: "users" }) as { records: unknown[]; total: number };
    expect(result.total).toBe(4);
    expect(result.records).toHaveLength(4);
  });

  it("db_find with JSON filter", async () => {
    const result = await client.call("db_find", {
      collection: "users",
      filter: { role: "admin" },
    }) as { records: Record<string, unknown>[]; total: number };
    expect(result.total).toBe(2);
    expect(result.records.every((r) => r.role === "admin")).toBe(true);
  });

  it("db_find with compact string filter", async () => {
    const result = await client.call("db_find", {
      collection: "users",
      filter: "age.gt:30",
    }) as { records: Record<string, unknown>[]; total: number };
    expect(result.total).toBe(2); // Charlie(45), Diana(35)
  });

  it("db_find with pagination", async () => {
    const result = await client.call("db_find", {
      collection: "users",
      limit: 2,
      offset: 0,
    }) as { records: unknown[]; total: number; truncated: boolean };
    expect(result.records).toHaveLength(2);
    expect(result.total).toBe(4);
    expect(result.truncated).toBe(true);
  });

  it("db_find_one by ID", async () => {
    const result = await client.call("db_find_one", {
      collection: "users",
      id: "alice",
    }) as { record: Record<string, unknown> };
    expect(result.record.name).toBe("Alice");
    expect(result.record._id).toBe("alice");
  });

  it("db_find_one returns null for missing", async () => {
    const result = await client.call("db_find_one", {
      collection: "users",
      id: "nonexistent",
    }) as { record: null };
    expect(result.record).toBeNull();
  });

  // --- Count ---

  it("db_count all records", async () => {
    const result = await client.call("db_count", { collection: "users" }) as { count: number };
    expect(result.count).toBe(4);
  });

  it("db_count with filter", async () => {
    const result = await client.call("db_count", {
      collection: "users",
      filter: { role: "admin" },
    }) as { count: number };
    expect(result.count).toBe(2);
  });

  // --- Update ---

  it("db_update modifies matching records", async () => {
    const result = await client.call("db_update", {
      collection: "users",
      filter: { role: "admin" },
      update: { $set: { verified: true } },
      agent: "e2e-test",
    }) as { modified: number };
    expect(result.modified).toBe(2);

    // Verify
    const alice = await client.call("db_find_one", { collection: "users", id: "alice" }) as { record: Record<string, unknown> };
    expect(alice.record.verified).toBe(true);
  });

  // --- Upsert ---

  it("db_upsert inserts new record", async () => {
    const result = await client.call("db_upsert", {
      collection: "users",
      id: "eve",
      record: { name: "Eve", role: "user", age: 28 },
    }) as { action: string };
    expect(result.action).toBe("inserted");
  });

  it("db_upsert updates existing record", async () => {
    const result = await client.call("db_upsert", {
      collection: "users",
      id: "eve",
      record: { name: "Eve Updated", role: "admin", age: 28 },
    }) as { action: string };
    expect(result.action).toBe("updated");

    const eve = await client.call("db_find_one", { collection: "users", id: "eve" }) as { record: Record<string, unknown> };
    expect(eve.record.name).toBe("Eve Updated");
  });

  // --- Delete ---

  it("db_delete removes matching records", async () => {
    const result = await client.call("db_delete", {
      collection: "users",
      filter: { _id: "eve" },
    }) as { deleted: number };
    expect(result.deleted).toBe(1);

    const count = await client.call("db_count", { collection: "users" }) as { count: number };
    expect(count.count).toBe(4); // back to 4
  });

  // --- Undo ---

  it("db_undo reverses last mutation", async () => {
    const result = await client.call("db_undo", { collection: "users" }) as { undone: boolean };
    expect(result.undone).toBe(true);

    // Eve should be back
    const count = await client.call("db_count", { collection: "users" }) as { count: number };
    expect(count.count).toBe(5);
  });

  // --- History ---

  it("db_history shows mutation trail", async () => {
    const result = await client.call("db_history", {
      collection: "users",
      id: "alice",
    }) as { operations: unknown[] };
    // alice: insert + update(verified)
    expect(result.operations.length).toBeGreaterThanOrEqual(2);
  });

  // --- Discovery ---

  it("db_schema returns field info", async () => {
    const result = await client.call("db_schema", { collection: "users" }) as { fields: Array<{ name: string; type: string }>; sampleCount: number };
    expect(result.sampleCount).toBeGreaterThan(0);
    const nameField = result.fields.find((f) => f.name === "name");
    expect(nameField).toBeDefined();
    expect(nameField!.type).toBe("string");
  });

  it("db_distinct returns unique values", async () => {
    const result = await client.call("db_distinct", {
      collection: "users",
      field: "role",
    }) as { values: unknown[]; count: number };
    expect(result.count).toBeGreaterThanOrEqual(3);
    expect(result.values).toContain("admin");
    expect(result.values).toContain("user");
  });

  it("db_stats returns database stats", async () => {
    const result = await client.call("db_stats") as { collections: number; totalRecords: number };
    expect(result.collections).toBeGreaterThanOrEqual(1);
    expect(result.totalRecords).toBeGreaterThanOrEqual(4);
  });

  it("db_collections lists the created collection", async () => {
    const result = await client.call("db_collections") as { collections: Array<{ name: string; recordCount: number }> };
    expect(result.collections.length).toBeGreaterThanOrEqual(1);
    const users = result.collections.find((c) => c.name === "users");
    expect(users).toBeDefined();
    expect(users!.recordCount).toBeGreaterThanOrEqual(4);
  });

  // --- Collection lifecycle: drop ---

  it("db_drop soft-deletes a collection", async () => {
    // Create a throwaway collection
    await client.call("db_create", { collection: "temp" });
    await client.call("db_insert", { collection: "temp", record: { x: 1 } });

    const result = await client.call("db_drop", { collection: "temp" }) as { dropped: string; recoverable: boolean };
    expect(result.dropped).toBe("temp");
    expect(result.recoverable).toBe(true);

    // Should no longer appear in collections
    const list = await client.call("db_collections") as { collections: Array<{ name: string }> };
    expect(list.collections.find((c) => c.name === "temp")).toBeUndefined();
  });

  // --- Archive flow ---

  it("db_archive moves records to cold storage", async () => {
    await client.call("db_insert", { collection: "logs", records: [
      { _id: "old", status: "done", msg: "old entry" },
      { _id: "new", status: "active", msg: "new entry" },
    ]});

    const result = await client.call("db_archive", {
      collection: "logs",
      filter: { status: "done" },
      segment: "2026-Q1",
    }) as { archived: number };
    expect(result.archived).toBe(1);

    // Active record still there
    const count = await client.call("db_count", { collection: "logs" }) as { count: number };
    expect(count.count).toBe(1);
  });

  it("db_archive_list returns segments", async () => {
    const result = await client.call("db_archive_list", { collection: "logs" }) as { segments: string[] };
    expect(result.segments.length).toBeGreaterThan(0);
  });

  it("db_archive_load reads archived records", async () => {
    const result = await client.call("db_archive_load", {
      collection: "logs",
      segment: "2026-Q1",
    }) as { records: unknown[]; count: number };
    expect(result.count).toBe(1);
  });

  // --- Purge ---

  it("db_purge permanently deletes a dropped collection", async () => {
    await client.call("db_create", { collection: "disposable" });
    await client.call("db_insert", { collection: "disposable", record: { x: 1 } });
    const dropResult = await client.call("db_drop", { collection: "disposable" }) as { dropped: string };
    expect(dropResult.dropped).toBe("disposable");

    // Find the dropped name from collections (it won't be in active list)
    // Purge using the original name as a substring match
    await client.call("db_purge", { name: "disposable" });

    // Should not appear in collections anymore
    const list = await client.call("db_collections") as { collections: Array<{ name: string }> };
    expect(list.collections.find((c) => c.name === "disposable")).toBeUndefined();
  });

  // --- Export / Import ---

  it("db_export exports collection data", async () => {
    const result = await client.call("db_export", { collections: ["users"] }) as {
      version: number;
      collections: Record<string, { records: unknown[] }>;
    };
    expect(result.version).toBe(1);
    expect(result.collections.users).toBeDefined();
    expect(result.collections.users.records.length).toBeGreaterThan(0);
  });

  it("db_import imports data into existing collections", async () => {
    const exported = await client.call("db_export", { collections: ["users"] }) as {
      version: number;
      exportedAt: string;
      collections: Record<string, { records: Record<string, unknown>[] }>;
    };

    // Import into a new collection by modifying the export
    const importData = {
      version: 1,
      exportedAt: new Date().toISOString(),
      collections: { imported: { records: exported.collections.users.records.slice(0, 2) } },
    };

    const result = await client.call("db_import", { data: importData }) as { collections: number; records: number };
    expect(result.collections).toBe(1);
    expect(result.records).toBe(2);

    const count = await client.call("db_count", { collection: "imported" }) as { count: number };
    expect(count.count).toBe(2);
  });

  // --- Error handling ---

  it("tool errors return isError without crashing server", async () => {
    // Drop a non-existent collection
    await expect(client.call("db_drop", { collection: "nonexistent" })).rejects.toThrow("not found");

    // Server should still work after error
    const count = await client.call("db_count", { collection: "users" }) as { count: number };
    expect(count.count).toBeGreaterThanOrEqual(4);
  });

  // --- Agent identity ---

  it("agent identity preserved in history", async () => {
    const result = await client.call("db_history", {
      collection: "users",
      id: "alice",
    }) as { operations: Array<{ data?: Record<string, unknown> }> };

    // First insert had agent: "e2e-test"
    const insertOp = result.operations[0];
    expect(insertOp.data?._agent).toBe("e2e-test");
    expect(insertOp.data?._reason).toBe("seeding");
  });
});
