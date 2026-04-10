import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDB } from "../src/agentdb.js";
import { SubscriptionManager } from "../src/mcp/subscriptions.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

function mockMcpServer(): McpServer {
  return {
    server: {
      sendLoggingMessage: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as McpServer;
}

describe("SubscriptionManager", () => {
  let tmpDir: string;
  let db: AgentDB;
  let manager: SubscriptionManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agentdb-subs-"));
    db = new AgentDB(tmpDir);
    await db.init();
    manager = new SubscriptionManager(db);
  });

  afterEach(async () => {
    manager.destroy();
    await db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("notifies subscriber when collection changes", async () => {
    const server = mockMcpServer();
    await manager.subscribe("session-1", "tasks", server);

    const col = await db.collection("tasks");
    await col.insert({ _id: "t1", title: "Test task" });

    // Give the event a tick to propagate
    await new Promise((r) => setTimeout(r, 10));

    expect(server.server.sendLoggingMessage).toHaveBeenCalled();
    const call = (server.server.sendLoggingMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.level).toBe("info");
    const data = JSON.parse(call.data);
    expect(data.event).toBe("db_change");
    expect(data.collection).toBe("tasks");
    expect(data.type).toBe("insert");
    expect(data.ids).toContain("t1");
  });

  it("does not notify after unsubscribe", async () => {
    const server = mockMcpServer();
    await manager.subscribe("session-1", "tasks", server);
    manager.unsubscribe("session-1", "tasks");

    const col = await db.collection("tasks");
    await col.insert({ _id: "t1", title: "Test" });
    await new Promise((r) => setTimeout(r, 10));

    expect(server.server.sendLoggingMessage).not.toHaveBeenCalled();
  });

  it("notifies multiple subscribers", async () => {
    const server1 = mockMcpServer();
    const server2 = mockMcpServer();
    await manager.subscribe("session-1", "tasks", server1);
    await manager.subscribe("session-2", "tasks", server2);

    const col = await db.collection("tasks");
    await col.insert({ _id: "t1", title: "Test" });
    await new Promise((r) => setTimeout(r, 10));

    expect(server1.server.sendLoggingMessage).toHaveBeenCalled();
    expect(server2.server.sendLoggingMessage).toHaveBeenCalled();
  });

  it("removeSession cleans up all subscriptions for a session", async () => {
    const server = mockMcpServer();
    await manager.subscribe("session-1", "tasks", server);
    await manager.subscribe("session-1", "notes", server);
    manager.removeSession("session-1");

    const col = await db.collection("tasks");
    await col.insert({ _id: "t1", title: "Test" });
    await new Promise((r) => setTimeout(r, 10));

    expect(server.server.sendLoggingMessage).not.toHaveBeenCalled();
  });

  it("duplicate subscribe is idempotent", async () => {
    const server = mockMcpServer();
    await manager.subscribe("session-1", "tasks", server);
    await manager.subscribe("session-1", "tasks", server); // duplicate

    const col = await db.collection("tasks");
    await col.insert({ _id: "t1", title: "Test" });
    await new Promise((r) => setTimeout(r, 10));

    // Should only get one notification, not two
    expect(server.server.sendLoggingMessage).toHaveBeenCalledTimes(1);
  });

  it("destroy cleans up all subscriptions and listeners", async () => {
    const server = mockMcpServer();
    await manager.subscribe("session-1", "tasks", server);
    manager.destroy();

    const col = await db.collection("tasks");
    await col.insert({ _id: "t1", title: "Test" });
    await new Promise((r) => setTimeout(r, 10));

    expect(server.server.sendLoggingMessage).not.toHaveBeenCalled();
  });

  it("notification includes update type and agent", async () => {
    const server = mockMcpServer();
    await manager.subscribe("session-1", "tasks", server);

    const col = await db.collection("tasks");
    await col.insert({ _id: "t1", title: "Test" });
    await col.update({ _id: "t1" }, { $set: { title: "Updated" } }, { agent: "worker-a" });
    await new Promise((r) => setTimeout(r, 10));

    const calls = (server.server.sendLoggingMessage as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);

    const updateCall = JSON.parse(calls[calls.length - 1][0].data);
    expect(updateCall.type).toBe("update");
    expect(updateCall.agent).toBe("worker-a");
  });
});
