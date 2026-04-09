/**
 * Memory pressure monitoring for AgentDB.
 * Tracks approximate memory usage across collections
 * and warns when thresholds are exceeded.
 */

/** Approximate memory of a JavaScript value in bytes. */
export function estimateBytes(value: unknown): number {
  if (value === null || value === undefined) return 8;
  if (typeof value === "boolean") return 4;
  if (typeof value === "number") return 8;
  if (typeof value === "string") return 2 * value.length + 40; // 2 bytes per char + overhead
  if (Array.isArray(value)) {
    let size = 40; // Array overhead
    for (const item of value) size += estimateBytes(item);
    return size;
  }
  if (typeof value === "object") {
    let size = 40; // Object overhead
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      size += 2 * key.length + 40; // Key string
      size += estimateBytes(val);
    }
    return size;
  }
  return 8;
}

export interface MemoryStats {
  /** Total estimated bytes across all tracked collections. */
  totalBytes: number;
  /** Per-collection breakdown. */
  collections: Record<string, { records: number; bytes: number }>;
  /** Whether total exceeds the budget. */
  overBudget: boolean;
  /** Configured budget in bytes (0 = unlimited). */
  budgetBytes: number;
}

/**
 * Monitors memory usage across collections.
 */
export class MemoryMonitor {
  private budgetBytes: number;
  private collectionStats = new Map<string, { records: number; bytes: number }>();

  constructor(budgetBytes = 0) {
    this.budgetBytes = budgetBytes;
  }

  /** Update stats for a collection. Call after mutations. */
  update(name: string, records: Array<Record<string, unknown>>): void {
    let bytes = 0;
    for (const record of records) {
      bytes += estimateBytes(record);
    }
    this.collectionStats.set(name, { records: records.length, bytes });
  }

  /** Remove a collection from tracking. */
  remove(name: string): void {
    this.collectionStats.delete(name);
  }

  /** Get current memory stats. */
  stats(): MemoryStats {
    let totalBytes = 0;
    const collections: Record<string, { records: number; bytes: number }> = {};
    for (const [name, stat] of this.collectionStats) {
      collections[name] = stat;
      totalBytes += stat.bytes;
    }
    return {
      totalBytes,
      collections,
      overBudget: this.budgetBytes > 0 && totalBytes > this.budgetBytes,
      budgetBytes: this.budgetBytes,
    };
  }

  /** Check if over budget. */
  isOverBudget(): boolean {
    if (this.budgetBytes <= 0) return false;
    let total = 0;
    for (const stat of this.collectionStats.values()) {
      total += stat.bytes;
      if (total > this.budgetBytes) return true;
    }
    return false;
  }
}
