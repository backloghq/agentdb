import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager } from "../src/permissions.js";
import { AgentDB } from "../src/agentdb.js";

describe("PermissionManager", () => {
  it("no rules = unrestricted", () => {
    const pm = new PermissionManager();
    expect(pm.check("anyone", "read")).toBe(true);
    expect(pm.check("anyone", "write")).toBe(true);
    expect(pm.check("anyone", "admin")).toBe(true);
  });

  it("no agent identity = unrestricted (backward compat)", () => {
    const pm = new PermissionManager({ reader: { read: true, write: false } });
    expect(pm.check(undefined, "write")).toBe(true);
  });

  it("read-only agent", () => {
    const pm = new PermissionManager({ reader: { read: true, write: false, admin: false } });
    expect(pm.check("reader", "read")).toBe(true);
    expect(pm.check("reader", "write")).toBe(false);
    expect(pm.check("reader", "admin")).toBe(false);
  });

  it("write agent without admin", () => {
    const pm = new PermissionManager({ writer: { read: true, write: true, admin: false } });
    expect(pm.check("writer", "read")).toBe(true);
    expect(pm.check("writer", "write")).toBe(true);
    expect(pm.check("writer", "admin")).toBe(false);
  });

  it("unknown agent gets full access (default)", () => {
    const pm = new PermissionManager({ reader: { read: true, write: false } });
    expect(pm.check("unknown-agent", "write")).toBe(true);
  });

  it("require throws on denied", () => {
    const pm = new PermissionManager({ reader: { read: true, write: false } });
    expect(() => pm.require("reader", "write", "db_insert")).toThrow("Permission denied");
    expect(() => pm.require("reader", "write", "db_insert")).toThrow("reader");
  });

  it("require passes on allowed", () => {
    const pm = new PermissionManager({ writer: { read: true, write: true } });
    expect(() => pm.require("writer", "write", "db_insert")).not.toThrow();
  });

  it("defaults: write and admin default to false", () => {
    const pm = new PermissionManager({ agent: { read: true } });
    expect(pm.check("agent", "write")).toBe(false);
    expect(pm.check("agent", "admin")).toBe(false);
  });
});

describe("AgentDB with permissions", () => {
  let tmpDir: string;
  let db: AgentDB;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agentdb-perm-"));
    db = new AgentDB(tmpDir, {
      permissions: {
        reader: { read: true, write: false, admin: false },
        writer: { read: true, write: true, admin: false },
        admin: { read: true, write: true, admin: true },
      },
    });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("exposes permission manager", () => {
    const pm = db.getPermissions();
    expect(pm.hasRules).toBe(true);
    expect(pm.check("reader", "write")).toBe(false);
    expect(pm.check("writer", "write")).toBe(true);
  });

  it("collections are accessible regardless of permissions", async () => {
    // Permissions are enforced at tool level, not collection level
    const col = await db.collection("test");
    await col.insert({ name: "Alice" }, { agent: "reader" });
    // This succeeds because Collection doesn't enforce permissions
    // (enforcement happens in the tool layer)
    expect(col.count()).toBe(1);
  });
});
