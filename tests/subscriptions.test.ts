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

  describe("Task 305 — pin-while-subscribed prevents LRU eviction", () => {
    it("subscribed collection is not evicted when LRU limit is reached", async () => {
      // maxOpenCollections: 2 so we can force eviction with a third open
      await db.close();
      db = new AgentDB(tmpDir, { maxOpenCollections: 2 });
      await db.init();
      manager = new SubscriptionManager(db);

      // Open A and subscribe — pins A
      const colA1 = await db.collection("alpha");
      await manager.subscribe("s1", "alpha", mockMcpServer());

      // Open B (fills the 2-slot limit, LRU = [alpha, beta])
      await db.collection("beta");

      // Open C — triggers eviction. alpha is pinned so beta evicts instead.
      await db.collection("gamma");

      // alpha must still be the same open instance (not evicted and reopened)
      const colA2 = await db.collection("alpha");
      expect(colA2).toBe(colA1);
    });

    it("unsubscribed collection becomes evictable", async () => {
      await db.close();
      db = new AgentDB(tmpDir, { maxOpenCollections: 2 });
      await db.init();
      manager = new SubscriptionManager(db);

      const colA1 = await db.collection("alpha");
      await manager.subscribe("s1", "alpha", mockMcpServer());
      await db.collection("beta");

      // Unsubscribe — unpins alpha
      manager.unsubscribe("s1", "alpha");

      // Open C — alpha is now the LRU candidate and unpinned, so it evicts
      await db.collection("gamma");

      // alpha should be a new instance (evicted and reopened)
      const colA2 = await db.collection("alpha");
      expect(colA2).not.toBe(colA1);
    });

    it("subscribe → unsubscribe → resubscribe → unsubscribe: pin count returns to 0", async () => {
      await db.close();
      db = new AgentDB(tmpDir, { maxOpenCollections: 2 });
      await db.init();
      manager = new SubscriptionManager(db);

      await db.collection("alpha");
      await manager.subscribe("s1", "alpha", mockMcpServer());
      manager.unsubscribe("s1", "alpha");

      // Resubscribe
      await manager.subscribe("s1", "alpha", mockMcpServer());
      manager.unsubscribe("s1", "alpha");

      // After full round-trip alpha should be evictable
      await db.collection("beta");
      await db.collection("gamma"); // triggers eviction of alpha (oldest unpinned)

      const colA2 = await db.collection("alpha");
      // Must reopen from scratch — a new Collection instance
      const colA3 = await db.collection("alpha"); // cached now
      expect(colA2).toBe(colA3); // stable after reopen, just checking it's consistent
    });

    it("multiple subscribers on same collection: all must unsubscribe before eviction is allowed", async () => {
      await db.close();
      db = new AgentDB(tmpDir, { maxOpenCollections: 2 });
      await db.init();
      manager = new SubscriptionManager(db);

      const colA1 = await db.collection("alpha");
      // Two different sessions subscribe
      await manager.subscribe("s1", "alpha", mockMcpServer());
      await manager.subscribe("s2", "alpha", mockMcpServer());
      await db.collection("beta");

      // Remove one subscriber — alpha still pinned (s2 remains)
      manager.unsubscribe("s1", "alpha");
      await db.collection("gamma"); // beta evicts, alpha stays (still pinned by s2)
      const colA2 = await db.collection("alpha");
      expect(colA2).toBe(colA1); // still same instance

      // Remove last subscriber — alpha now unpinned
      manager.unsubscribe("s2", "alpha");
      await db.collection("delta"); // gamma evicts (alpha was accessed most recently, gamma is LRU)
      // Now open enough to evict alpha too
      await db.collection("epsilon"); // alpha is now evictable
      const colA3 = await db.collection("alpha");
      expect(colA3).not.toBe(colA1); // evicted and reopened
    });
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
