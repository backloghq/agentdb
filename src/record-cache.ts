/**
 * Record-level LRU cache for disk-backed collections.
 *
 * Uses JS Map insertion order as a natural LRU — delete + re-insert
 * moves to end, evict from beginning. O(1) get/set/delete.
 */

export interface CacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  size: number;
  evictions: number;
}

export class RecordCache<T = Record<string, unknown>> {
  private map: Map<string, T> = new Map();
  private maxSize: number;
  private _hits = 0;
  private _misses = 0;
  private _evictions = 0;

  constructor(maxSize: number = 10_000) {
    this.maxSize = maxSize;
  }

  /** Get a record from cache. Returns undefined on miss. Promotes to most-recently-used on hit. */
  get(id: string): T | undefined {
    const record = this.map.get(id);
    if (record !== undefined) {
      // Move to end (most recently used)
      this.map.delete(id);
      this.map.set(id, record);
      this._hits++;
      return record;
    }
    this._misses++;
    return undefined;
  }

  /** Insert or update a record in cache. Evicts oldest if over capacity. */
  set(id: string, record: T): void {
    this.map.delete(id); // remove if exists (reinsert at end)
    this.map.set(id, record);
    // Evict oldest if over capacity
    if (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value!;
      this.map.delete(oldest);
      this._evictions++;
    }
  }

  /** Remove a record from cache. */
  delete(id: string): void {
    this.map.delete(id);
  }

  /** Check if a record is in cache (does not promote). */
  has(id: string): boolean {
    return this.map.has(id);
  }

  /** Get a record without promoting it to most-recently-used (does not update LRU order). */
  peek(id: string): T | undefined {
    return this.map.get(id);
  }

  /** Clear all entries and reset stats. */
  clear(): void {
    this.map.clear();
    this._hits = 0;
    this._misses = 0;
    this._evictions = 0;
  }

  /** Number of records in cache. */
  get size(): number {
    return this.map.size;
  }

  /** Cache performance statistics. */
  stats(): CacheStats {
    const total = this._hits + this._misses;
    return {
      hits: this._hits,
      misses: this._misses,
      hitRate: total > 0 ? this._hits / total : 0,
      size: this.map.size,
      evictions: this._evictions,
    };
  }
}
