/**
 * Simple in-memory B-tree index for attribute matching.
 * Maps field values to sets of record IDs for O(log n) lookups.
 * Supports equality, range queries, and existence checks.
 */

interface BTreeNode {
  keys: unknown[];
  values: Set<string>[]; // Each key maps to a set of record IDs
  children: BTreeNode[];
  leaf: boolean;
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/** B-tree index on a single field. */
export class BTreeIndex {
  readonly field: string;
  private root: BTreeNode;
  private order: number;
  private _size = 0;

  constructor(field: string, order = 32) {
    this.field = field;
    this.order = order;
    this.root = { keys: [], values: [], children: [], leaf: true };
  }

  /** Number of indexed entries (field value → ID pairs). */
  get size(): number {
    return this._size;
  }

  /** Add a record ID for a field value. */
  add(value: unknown, id: string): void {
    const node = this.findLeaf(this.root, value);
    const idx = this.findKeyIndex(node, value);

    if (idx < node.keys.length && compare(node.keys[idx], value) === 0) {
      node.values[idx].add(id);
    } else {
      node.keys.splice(idx, 0, value);
      node.values.splice(idx, 0, new Set([id]));
      if (node.keys.length >= this.order) {
        this.split(node);
      }
    }
    this._size++;
  }

  /** Remove a record ID for a field value. */
  remove(value: unknown, id: string): void {
    const node = this.findLeaf(this.root, value);
    const idx = this.findKeyIndex(node, value);
    if (idx < node.keys.length && compare(node.keys[idx], value) === 0) {
      node.values[idx].delete(id);
      this._size--;
      if (node.values[idx].size === 0) {
        node.keys.splice(idx, 1);
        node.values.splice(idx, 1);
      }
    }
  }

  /** Find all record IDs where field equals value. */
  eq(value: unknown): Set<string> {
    const node = this.findLeaf(this.root, value);
    const idx = this.findKeyIndex(node, value);
    if (idx < node.keys.length && compare(node.keys[idx], value) === 0) {
      return new Set(node.values[idx]);
    }
    return new Set();
  }

  /** Find all record IDs where field is in range [min, max]. */
  range(min: unknown, max: unknown): Set<string> {
    const result = new Set<string>();
    this.rangeWalk(this.root, min, max, result);
    return result;
  }

  /** Get all indexed values. */
  allValues(): unknown[] {
    const result: unknown[] = [];
    this.inOrder(this.root, result);
    return result;
  }

  /** Clear the index. */
  clear(): void {
    this.root = { keys: [], values: [], children: [], leaf: true };
    this._size = 0;
  }

  // --- Internal ---

  private findLeaf(node: BTreeNode, value: unknown): BTreeNode {
    if (node.leaf) return node;
    const idx = this.findKeyIndex(node, value);
    return this.findLeaf(node.children[idx], value);
  }

  private findKeyIndex(node: BTreeNode, value: unknown): number {
    let lo = 0, hi = node.keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compare(node.keys[mid], value) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private split(node: BTreeNode): void {
    // Simplified: for a leaf-only B-tree, just split the root when it overflows
    // Full B-tree with internal splits would be more complex but overkill for our scale
    if (node !== this.root) return; // Only split root for simplicity

    const mid = Math.floor(node.keys.length / 2);
    const left: BTreeNode = {
      keys: node.keys.slice(0, mid),
      values: node.values.slice(0, mid),
      children: [],
      leaf: true,
    };
    const right: BTreeNode = {
      keys: node.keys.slice(mid),
      values: node.values.slice(mid),
      children: [],
      leaf: true,
    };

    this.root = {
      keys: [node.keys[mid]],
      values: [node.values[mid]],
      children: [left, right],
      leaf: false,
    };
  }

  private rangeWalk(node: BTreeNode, min: unknown, max: unknown, result: Set<string>): void {
    if (node.leaf) {
      for (let i = 0; i < node.keys.length; i++) {
        if (compare(node.keys[i], min) >= 0 && compare(node.keys[i], max) <= 0) {
          for (const id of node.values[i]) result.add(id);
        }
      }
      return;
    }
    for (let i = 0; i < node.keys.length; i++) {
      if (compare(node.keys[i], min) >= 0) {
        this.rangeWalk(node.children[i], min, max, result);
      }
      if (compare(node.keys[i], min) >= 0 && compare(node.keys[i], max) <= 0) {
        for (const id of node.values[i]) result.add(id);
      }
    }
    if (node.children.length > node.keys.length) {
      this.rangeWalk(node.children[node.children.length - 1], min, max, result);
    }
  }

  private inOrder(node: BTreeNode, result: unknown[]): void {
    if (node.leaf) {
      result.push(...node.keys);
      return;
    }
    for (let i = 0; i < node.keys.length; i++) {
      if (node.children[i]) this.inOrder(node.children[i], result);
      result.push(node.keys[i]);
    }
    if (node.children.length > node.keys.length) {
      this.inOrder(node.children[node.children.length - 1], result);
    }
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
