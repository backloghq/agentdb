import { describe, it, expect } from "vitest";
import { estimateBytes, MemoryMonitor } from "../src/memory.js";

describe("estimateBytes", () => {
  it("estimates null/undefined", () => {
    expect(estimateBytes(null)).toBe(8);
    expect(estimateBytes(undefined)).toBe(8);
  });

  it("estimates primitives", () => {
    expect(estimateBytes(true)).toBe(4);
    expect(estimateBytes(42)).toBe(8);
    expect(estimateBytes("hello")).toBe(50); // 2*5 + 40
  });

  it("estimates arrays", () => {
    const bytes = estimateBytes([1, 2, 3]);
    expect(bytes).toBeGreaterThan(40); // overhead + 3 numbers
  });

  it("estimates objects", () => {
    const bytes = estimateBytes({ name: "Alice", age: 30 });
    expect(bytes).toBeGreaterThan(100);
  });

  it("estimates nested structures", () => {
    const simple = estimateBytes({ x: 1 });
    const nested = estimateBytes({ x: { y: { z: 1 } } });
    expect(nested).toBeGreaterThan(simple);
  });
});

describe("MemoryMonitor", () => {
  it("tracks collection stats", () => {
    const monitor = new MemoryMonitor();
    monitor.update("users", [
      { name: "Alice", age: 30 },
      { name: "Bob", age: 25 },
    ]);

    const stats = monitor.stats();
    expect(stats.collections.users.records).toBe(2);
    expect(stats.collections.users.bytes).toBeGreaterThan(0);
    expect(stats.totalBytes).toBeGreaterThan(0);
  });

  it("tracks multiple collections", () => {
    const monitor = new MemoryMonitor();
    monitor.update("users", [{ name: "Alice" }]);
    monitor.update("tasks", [{ title: "Task 1" }, { title: "Task 2" }]);

    const stats = monitor.stats();
    expect(Object.keys(stats.collections)).toHaveLength(2);
    expect(stats.totalBytes).toBe(
      stats.collections.users.bytes + stats.collections.tasks.bytes,
    );
  });

  it("detects over budget", () => {
    const monitor = new MemoryMonitor(100); // 100 bytes budget
    monitor.update("big", [
      { data: "x".repeat(1000) }, // Way over 100 bytes
    ]);

    expect(monitor.isOverBudget()).toBe(true);
    expect(monitor.stats().overBudget).toBe(true);
  });

  it("no budget = never over", () => {
    const monitor = new MemoryMonitor(); // 0 = unlimited
    monitor.update("big", [{ data: "x".repeat(10000) }]);
    expect(monitor.isOverBudget()).toBe(false);
  });

  it("updates replace previous stats", () => {
    const monitor = new MemoryMonitor();
    monitor.update("users", [{ name: "Alice" }]);
    const before = monitor.stats().collections.users.records;
    monitor.update("users", [{ name: "Alice" }, { name: "Bob" }]);
    const after = monitor.stats().collections.users.records;
    expect(after).toBe(2);
    expect(before).toBe(1);
  });

  it("removes collection from tracking", () => {
    const monitor = new MemoryMonitor();
    monitor.update("users", [{ name: "Alice" }]);
    monitor.remove("users");
    expect(monitor.stats().collections.users).toBeUndefined();
    expect(monitor.stats().totalBytes).toBe(0);
  });
});
