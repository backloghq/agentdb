/**
 * Array-element index for O(1) $contains lookups.
 *
 * Maps individual array elements to the set of record IDs containing them.
 * e.g., for tags: "bug" → {"id1", "id2"}, "feature" → {"id3"}
 */

export class ArrayIndex {
  private index: Map<string, Set<string>> = new Map();
  readonly field: string;

  constructor(field: string) {
    this.field = field;
  }

  /** Add a record's array elements to the index. */
  add(recordId: string, elements: unknown): void {
    if (!Array.isArray(elements)) return;
    for (const elem of elements) {
      const key = String(elem);
      let set = this.index.get(key);
      if (!set) {
        set = new Set();
        this.index.set(key, set);
      }
      set.add(recordId);
    }
  }

  /** Remove a record's array elements from the index. */
  remove(recordId: string, elements: unknown): void {
    if (!Array.isArray(elements)) return;
    for (const elem of elements) {
      const key = String(elem);
      const set = this.index.get(key);
      if (set) {
        set.delete(recordId);
        if (set.size === 0) this.index.delete(key);
      }
    }
  }

  /** Update index when a record's array field changes. */
  update(recordId: string, oldElements: unknown, newElements: unknown): void {
    this.remove(recordId, oldElements);
    this.add(recordId, newElements);
  }

  /** Remove a record from all elements. O(uniqueValues). Used when old array value is unknown. */
  removeById(recordId: string): void {
    for (const [key, set] of this.index) {
      set.delete(recordId);
      if (set.size === 0) this.index.delete(key);
    }
  }

  /** Look up all record IDs containing a given element. O(1). */
  lookup(element: string): ReadonlySet<string> {
    return this.index.get(element) ?? new Set();
  }

  /** Number of unique element values in the index. */
  get uniqueValues(): number {
    return this.index.size;
  }

  /** Total entries (sum of all set sizes). */
  get totalEntries(): number {
    let n = 0;
    for (const set of this.index.values()) n += set.size;
    return n;
  }

  /** Clear the index. */
  clear(): void {
    this.index.clear();
  }

  /** Serialize to JSON for persistence. */
  toJSON(): { version: number; field: string; elements: Record<string, string[]> } {
    const elements: Record<string, string[]> = {};
    for (const [key, set] of this.index) {
      elements[key] = Array.from(set).sort();
    }
    return { version: 1, field: this.field, elements };
  }

  /** Deserialize from JSON. */
  static fromJSON(data: { field: string; elements: Record<string, string[]> }): ArrayIndex {
    const idx = new ArrayIndex(data.field);
    for (const [key, ids] of Object.entries(data.elements)) {
      idx.index.set(key, new Set(ids));
    }
    return idx;
  }
}
