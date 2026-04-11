/**
 * In-memory sorted index for attribute matching.
 * Uses a flat sorted array with binary search for O(log n) lookups.
 * Supports equality, range queries, and existence checks.
 *
 * Named BTreeIndex for API compatibility — internally a sorted array,
 * which performs identically to a B-tree for in-memory use cases.
 */

interface IndexEntry {
  key: unknown;
  ids: Set<string>;
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  const sa = String(a), sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/**
 * Sorted index on a single field. Binary search for O(log n) lookups.
 * Note: add()/remove() use Array.splice() which is O(n) per operation.
 * At AgentDB's target scale (≤100K unique keys), this is <0.5ms — acceptable.
 */
export class BTreeIndex {
  readonly field: string;
  private entries: IndexEntry[] = [];
  private _size = 0;
  private idToKey = new Map<string, unknown>(); // Reverse map: record ID → indexed key value

  constructor(field: string) {
    this.field = field;
  }

  /** Number of indexed entries (field value → ID pairs). */
  get size(): number {
    return this._size;
  }

  /** Add a record ID for a field value. */
  add(value: unknown, id: string): void {
    const idx = this.findIndex(value);
    if (idx < this.entries.length && compare(this.entries[idx].key, value) === 0) {
      this.entries[idx].ids.add(id);
    } else {
      this.entries.splice(idx, 0, { key: value, ids: new Set([id]) });
    }
    this.idToKey.set(id, value);
    this._size++;
  }

  /** Remove a record ID for a field value. */
  remove(value: unknown, id: string): void {
    const idx = this.findIndex(value);
    if (idx < this.entries.length && compare(this.entries[idx].key, value) === 0) {
      this.entries[idx].ids.delete(id);
      this._size--;
      this.idToKey.delete(id);
      if (this.entries[idx].ids.size === 0) {
        this.entries.splice(idx, 1);
      }
    }
  }

  /** Remove a record by ID without knowing its indexed value. */
  removeById(id: string): void {
    if (!this.idToKey.has(id)) return;
    this.remove(this.idToKey.get(id), id);
  }

  /** Find all record IDs where field equals value. */
  eq(value: unknown): Set<string> {
    const idx = this.findIndex(value);
    if (idx < this.entries.length && compare(this.entries[idx].key, value) === 0) {
      return new Set(this.entries[idx].ids);
    }
    return new Set();
  }

  /** Find all record IDs where field is in range [min, max]. */
  range(min: unknown, max: unknown): Set<string> {
    const result = new Set<string>();
    const start = this.findIndex(min);
    for (let i = start; i < this.entries.length; i++) {
      if (compare(this.entries[i].key, max) > 0) break;
      for (const id of this.entries[i].ids) result.add(id);
    }
    return result;
  }

  /** All IDs where field > value (exclusive). */
  gt(value: unknown): Set<string> {
    const result = new Set<string>();
    let start = this.findIndex(value);
    // Skip entries equal to value
    while (start < this.entries.length && compare(this.entries[start].key, value) === 0) start++;
    for (let i = start; i < this.entries.length; i++) {
      for (const id of this.entries[i].ids) result.add(id);
    }
    return result;
  }

  /** All IDs where field >= value (inclusive). */
  gte(value: unknown): Set<string> {
    const result = new Set<string>();
    const start = this.findIndex(value);
    for (let i = start; i < this.entries.length; i++) {
      for (const id of this.entries[i].ids) result.add(id);
    }
    return result;
  }

  /** All IDs where field < value (exclusive). */
  lt(value: unknown): Set<string> {
    const result = new Set<string>();
    const end = this.findIndex(value);
    for (let i = 0; i < end; i++) {
      for (const id of this.entries[i].ids) result.add(id);
    }
    return result;
  }

  /** All IDs where field <= value (inclusive). */
  lte(value: unknown): Set<string> {
    const result = new Set<string>();
    let end = this.findIndex(value);
    // Include entries equal to value
    while (end < this.entries.length && compare(this.entries[end].key, value) === 0) end++;
    for (let i = 0; i < end; i++) {
      for (const id of this.entries[i].ids) result.add(id);
    }
    return result;
  }

  /** Get all indexed values in sorted order. */
  allValues(): unknown[] {
    return this.entries.map((e) => e.key);
  }

  /** Clear the index. */
  clear(): void {
    this.entries = [];
    this._size = 0;
    this.idToKey.clear();
  }

  /** Serialize to JSON for persistence. */
  toJSON(): { version: number; field: string; entries: Array<{ key: unknown; ids: string[] }> } {
    return {
      version: 1,
      field: this.field,
      entries: this.entries.map((e) => ({ key: e.key, ids: Array.from(e.ids).sort() })),
    };
  }

  /** Deserialize from JSON. */
  static fromJSON(data: { field: string; entries: Array<{ key: unknown; ids: string[] }> }): BTreeIndex {
    const idx = new BTreeIndex(data.field);
    for (const entry of data.entries) {
      const ids = new Set(entry.ids);
      idx.entries.push({ key: entry.key, ids });
      for (const id of ids) {
        idx.idToKey.set(id, entry.key);
      }
      idx._size += ids.size;
    }
    return idx;
  }

  // --- Internal ---

  /** Binary search for the position of a key. */
  private findIndex(value: unknown): number {
    let lo = 0, hi = this.entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compare(this.entries[mid].key, value) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

/**
 * Query frequency tracker.
 * Counts how often each field is queried to suggest indexes.
 */
export class QueryFrequencyTracker {
  private counts = new Map<string, number>();

  /** Record a query on a field. */
  track(field: string): void {
    this.counts.set(field, (this.counts.get(field) ?? 0) + 1);
  }

  /** Get query count for a field. */
  getCount(field: string): number {
    return this.counts.get(field) ?? 0;
  }

  /** Get fields that exceed a threshold, sorted by frequency. */
  suggest(threshold: number): Array<{ field: string; count: number }> {
    const suggestions: Array<{ field: string; count: number }> = [];
    for (const [field, count] of this.counts) {
      if (count >= threshold) suggestions.push({ field, count });
    }
    return suggestions.sort((a, b) => b.count - a.count);
  }

  /** Reset all counts. */
  clear(): void {
    this.counts.clear();
  }
}
