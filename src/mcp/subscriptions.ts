/**
 * Subscription manager for real-time change notifications.
 * Wires Collection change events to MCP server logging notifications.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentDB } from "../agentdb.js";
import type { ChangeEvent } from "../collection.js";

interface Subscription {
  sessionId: string;
  collection: string;
  mcpServer: McpServer;
}

export class SubscriptionManager {
  private subs = new Map<string, Subscription[]>(); // collection → subscriptions
  private listeners = new Map<string, () => void>(); // collection → change listener cleanup
  private db: AgentDB;

  constructor(db: AgentDB) {
    this.db = db;
  }

  /** Subscribe a session to changes on a collection. */
  async subscribe(sessionId: string, collection: string, mcpServer: McpServer): Promise<void> {
    const key = collection;
    let list = this.subs.get(key);
    if (!list) {
      list = [];
      this.subs.set(key, list);
    }

    // Avoid duplicate subscriptions for same session+collection
    if (list.some((s) => s.sessionId === sessionId)) return;
    list.push({ sessionId, collection, mcpServer });

    // Register collection change listener on first subscription
    if (!this.listeners.has(key)) {
      const col = await this.db.collection(collection);
      const listener = (event: ChangeEvent) => {
        this.notify(collection, event);
      };
      col.on("change", listener as (e: unknown) => void);
      this.listeners.set(key, () => col.off("change", listener as (e: unknown) => void));
    }
  }

  /** Unsubscribe a session from a collection. */
  unsubscribe(sessionId: string, collection: string): void {
    const list = this.subs.get(collection);
    if (!list) return;
    const filtered = list.filter((s) => s.sessionId !== sessionId);
    if (filtered.length === 0) {
      this.subs.delete(collection);
      // Remove change listener if no more subscribers
      const cleanup = this.listeners.get(collection);
      if (cleanup) { cleanup(); this.listeners.delete(collection); }
    } else {
      this.subs.set(collection, filtered);
    }
  }

  /** Remove all subscriptions for a session (on disconnect). */
  removeSession(sessionId: string): void {
    for (const [collection, list] of this.subs) {
      const filtered = list.filter((s) => s.sessionId !== sessionId);
      if (filtered.length === 0) {
        this.subs.delete(collection);
        const cleanup = this.listeners.get(collection);
        if (cleanup) { cleanup(); this.listeners.delete(collection); }
      } else {
        this.subs.set(collection, filtered);
      }
    }
  }

  /** Push notification to all subscribers of a collection. */
  private notify(collection: string, event: ChangeEvent): void {
    const list = this.subs.get(collection);
    if (!list || list.length === 0) return;

    const data = JSON.stringify({
      event: "db_change",
      collection,
      type: event.type,
      ids: event.ids,
      agent: event.agent,
      timestamp: new Date().toISOString(),
    });

    for (const sub of list) {
      try {
        sub.mcpServer.server.sendLoggingMessage({
          level: "info",
          data,
        }).catch(() => {}); // fire-and-forget
      } catch {
        // Session may be disconnected
      }
    }
  }

  /** Clean up all subscriptions and listeners. */
  destroy(): void {
    for (const cleanup of this.listeners.values()) {
      cleanup();
    }
    this.listeners.clear();
    this.subs.clear();
  }
}
