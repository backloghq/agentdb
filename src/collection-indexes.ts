/**
 * IndexManager — owns B-tree, composite, and bloom filter indexes.
 * Delegated to by Collection for all index operations.
 */
import { BTreeIndex, QueryFrequencyTracker } from "./btree.js";
import { BloomFilter } from "./bloom.js";
import { ArrayIndex } from "./array-index.js";
import { getNestedValue } from "./filter.js";
import { parseCompactFilter } from "./compact-filter.js";
import {
  type StoredRecord, type Filter,
  stripMeta, isExpired, compositeKey, compositeIndexKey,
} from "./collection-helpers.js";

export class IndexManager {
  private btreeIndexes = new Map<string, BTreeIndex>();
  private compositeIndexes = new Map<string, { fields: string[]; idx: BTreeIndex }>();
  private arrayIndexes = new Map<string, ArrayIndex>();
  private bloomFilters = new Map<string, BloomFilter>();
  private queryTracker = new QueryFrequencyTracker();

  // --- Index lifecycle ---

  createIndex(field: string, entries: Iterable<[string, StoredRecord]>): void {
    if (this.btreeIndexes.has(field)) return;
    const idx = new BTreeIndex(field);
    for (const [id, record] of entries) {
      if (isExpired(record)) continue;
      const clean = stripMeta(record);
      const value = getNestedValue(clean, field);
      if (value !== undefined) idx.add(value, id);
    }
    this.btreeIndexes.set(field, idx);
  }

  dropIndex(field: string): boolean {
    return this.btreeIndexes.delete(field);
  }

  listIndexes(): string[] {
    return [...this.btreeIndexes.keys()];
  }

  // --- Array indexes ---

  createArrayIndex(field: string, entries: Iterable<[string, StoredRecord]>): void {
    if (this.arrayIndexes.has(field)) return;
    const idx = new ArrayIndex(field);
    for (const [id, record] of entries) {
      if (isExpired(record)) continue;
      const clean = stripMeta(record);
      idx.add(id, getNestedValue(clean, field));
    }
    this.arrayIndexes.set(field, idx);
  }

  dropArrayIndex(field: string): boolean {
    return this.arrayIndexes.delete(field);
  }

  listArrayIndexes(): string[] {
    return [...this.arrayIndexes.keys()];
  }

  getArrayIndex(field: string): ArrayIndex | undefined {
    return this.arrayIndexes.get(field);
  }

  createCompositeIndex(fields: string[], entries: Iterable<[string, StoredRecord]>): void {
    if (fields.length < 2) throw new Error("Composite index requires at least 2 fields");
    const key = compositeIndexKey(fields);
    if (this.compositeIndexes.has(key)) return;
    const idx = new BTreeIndex(key);
    for (const [id, record] of entries) {
      if (isExpired(record)) continue;
      const clean = stripMeta(record);
      const ck = compositeKey(fields.map((f) => getNestedValue(clean, f)));
      idx.add(ck, id);
    }
    this.compositeIndexes.set(key, { fields, idx });
  }

  dropCompositeIndex(fields: string[]): boolean {
    return this.compositeIndexes.delete(compositeIndexKey(fields));
  }

  listCompositeIndexes(): string[][] {
    return [...this.compositeIndexes.values()].map((c) => c.fields);
  }

  createBloomFilter(field: string, entries: Iterable<[string, StoredRecord]>, expectedItems = 10000): void {
    const bf = new BloomFilter(expectedItems);
    for (const [, record] of entries) {
      if (isExpired(record)) continue;
      const clean = stripMeta(record);
      const value = getNestedValue(clean, field);
      if (value !== undefined) bf.add(String(value));
    }
    this.bloomFilters.set(field, bf);
  }

  mightHave(field: string, value: string): boolean {
    const bf = this.bloomFilters.get(field);
    if (!bf) return true;
    return bf.has(value);
  }

  suggestIndexes(threshold = 100): Array<{ field: string; count: number }> {
    return this.queryTracker.suggest(threshold);
  }

  // --- Record mutation maintenance ---

  /** Update all indexes for a record change. Call after every insert/update/delete. */
  updateIndexes(id: string, oldRecord: StoredRecord | undefined, newRecord: StoredRecord | undefined): void {
    if (this.btreeIndexes.size === 0 && this.compositeIndexes.size === 0 && this.arrayIndexes.size === 0) return;
    const oldClean = oldRecord ? stripMeta(oldRecord) : undefined;
    const newClean = newRecord && !isExpired(newRecord) ? stripMeta(newRecord) : undefined;
    for (const [field, idx] of this.btreeIndexes) {
      if (oldClean) {
        const oldVal = getNestedValue(oldClean, field);
        if (oldVal !== undefined) idx.remove(oldVal, id);
      }
      if (newClean) {
        const newVal = getNestedValue(newClean, field);
        if (newVal !== undefined) idx.add(newVal, id);
      }
    }
    for (const [, { fields, idx }] of this.compositeIndexes) {
      if (oldClean) {
        idx.remove(compositeKey(fields.map((f) => getNestedValue(oldClean, f))), id);
      }
      if (newClean) {
        idx.add(compositeKey(fields.map((f) => getNestedValue(newClean, f))), id);
      }
    }
    for (const [field, idx] of this.arrayIndexes) {
      const oldVal = oldClean ? getNestedValue(oldClean, field) : undefined;
      const newVal = newClean ? getNestedValue(newClean, field) : undefined;
      idx.update(id, oldVal, newVal);
    }
  }

  /** Rebuild all indexes from scratch. Single pass over all records. */
  rebuildAll(entries: Iterable<[string, StoredRecord]>): void {
    if (this.btreeIndexes.size === 0 && this.compositeIndexes.size === 0 && this.arrayIndexes.size === 0) return;
    for (const [, idx] of this.btreeIndexes) idx.clear();
    for (const [, { idx }] of this.compositeIndexes) idx.clear();
    for (const [, idx] of this.arrayIndexes) idx.clear();
    for (const [id, record] of entries) {
      if (isExpired(record)) continue;
      const clean = stripMeta(record);
      for (const [field, idx] of this.btreeIndexes) {
        const value = getNestedValue(clean, field);
        if (value !== undefined) idx.add(value, id);
      }
      for (const [, { fields, idx }] of this.compositeIndexes) {
        idx.add(compositeKey(fields.map((f) => getNestedValue(clean, f))), id);
      }
      for (const [field, idx] of this.arrayIndexes) {
        idx.add(id, getNestedValue(clean, field));
      }
    }
  }

  /** Incremental update for known affected IDs. Returns cleaned records for text index use. */
  incrementalUpdate(affectedIds: string[], getRecord: (id: string) => StoredRecord | undefined): Map<string, Record<string, unknown> | undefined> {
    const cleanRecords = new Map<string, Record<string, unknown> | undefined>();
    for (const id of affectedIds) {
      const record = getRecord(id);
      const active = record && !isExpired(record);
      const clean = active ? stripMeta(record) : undefined;
      cleanRecords.set(id, clean);

      for (const [field, idx] of this.btreeIndexes) {
        idx.removeById(id);
        if (clean) {
          const value = getNestedValue(clean, field);
          if (value !== undefined) idx.add(value, id);
        }
      }
      for (const [, { fields, idx }] of this.compositeIndexes) {
        idx.removeById(id);
        if (clean) {
          idx.add(compositeKey(fields.map((f) => getNestedValue(clean, f))), id);
        }
      }
      for (const [field, idx] of this.arrayIndexes) {
        idx.removeById(id);
        if (clean) {
          idx.add(id, getNestedValue(clean, field));
        }
      }
    }
    return cleanRecords;
  }

  // --- Query planning ---

  trackQueryFields(filter: Filter): void {
    if (!filter) return;
    let obj: Record<string, unknown>;
    if (typeof filter === "string") {
      try { obj = parseCompactFilter(filter); } catch { return; }
    } else {
      obj = filter;
    }
    for (const key of Object.keys(obj)) {
      if (!key.startsWith("$") && !key.startsWith("+")) {
        this.queryTracker.track(key);
      }
    }
  }

  /**
   * Try to narrow candidates using indexes.
   * Returns a Set of candidate IDs or null for full scan.
   */
  indexedCandidates(filter: Filter): Set<string> | null {
    if (!filter || (this.btreeIndexes.size === 0 && this.compositeIndexes.size === 0 && this.arrayIndexes.size === 0)) return null;

    let filterObj: Record<string, unknown>;
    if (typeof filter === "string") {
      try { filterObj = parseCompactFilter(filter); } catch { return null; }
    } else {
      filterObj = filter;
    }

    // Try composite indexes first (more selective)
    const compositeResult = this.compositeIndexedCandidates(filterObj);
    if (compositeResult) return compositeResult;

    // Check array indexes for $contains
    for (const [key, value] of Object.entries(filterObj)) {
      if (key.startsWith("$") || key.startsWith("+")) continue;
      const arrIdx = this.arrayIndexes.get(key);
      if (!arrIdx) continue;
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        const ops = value as Record<string, unknown>;
        if ("$contains" in ops) {
          return new Set(arrIdx.lookup(String(ops.$contains)));
        }
      }
    }

    // Collect candidates from ALL matching single-field indexes, then intersect
    const candidateSets: Set<string>[] = [];

    for (const [key, value] of Object.entries(filterObj)) {
      if (key.startsWith("$") || key.startsWith("+")) continue;
      const idx = this.btreeIndexes.get(key);
      if (!idx) continue;

      let candidates: Set<string> | null = null;

      if (value === null || typeof value !== "object") {
        candidates = idx.eq(value);
      } else if (!Array.isArray(value)) {
        const ops = value as Record<string, unknown>;
        const opKeys = Object.keys(ops);
        if (opKeys.length === 0 || !opKeys.every((k) => k === "$gt" || k === "$gte" || k === "$lt" || k === "$lte")) continue;

        const hasGt = "$gt" in ops;
        const hasGte = "$gte" in ops;
        const hasLt = "$lt" in ops;
        const hasLte = "$lte" in ops;

        if ((hasGt || hasGte) && (hasLt || hasLte)) {
          candidates = idx.range(hasGt ? ops.$gt : ops.$gte, hasLt ? ops.$lt : ops.$lte);
          if (hasGt) { for (const id of idx.eq(ops.$gt)) candidates.delete(id); }
          if (hasLt) { for (const id of idx.eq(ops.$lt)) candidates.delete(id); }
        } else if (hasGt) candidates = idx.gt(ops.$gt);
        else if (hasGte) candidates = idx.gte(ops.$gte);
        else if (hasLt) candidates = idx.lt(ops.$lt);
        else if (hasLte) candidates = idx.lte(ops.$lte);
      }

      if (candidates) candidateSets.push(candidates);
    }

    if (candidateSets.length === 0) return null;
    if (candidateSets.length === 1) return candidateSets[0];

    // Intersect all candidate sets — start with smallest for efficiency
    candidateSets.sort((a, b) => a.size - b.size);
    const result = new Set(candidateSets[0]);
    for (let i = 1; i < candidateSets.length; i++) {
      for (const id of result) {
        if (!candidateSets[i].has(id)) result.delete(id);
      }
      if (result.size === 0) return result;
    }
    return result;
  }

  /** Check if a filter is fully covered by indexes (all fields have indexes). */
  isFullyCoveredByIndex(filter: Filter): boolean {
    if (!filter || this.btreeIndexes.size === 0) return false;

    let filterObj: Record<string, unknown>;
    if (typeof filter === "string") {
      try { filterObj = parseCompactFilter(filter); } catch { return false; }
    } else {
      filterObj = filter;
    }

    const fieldKeys = Object.keys(filterObj).filter((k) => !k.startsWith("$") && !k.startsWith("+"));
    if (fieldKeys.length === 0) return false;
    return fieldKeys.every((k) => this.btreeIndexes.has(k));
  }

  /** Get B-tree index for a field (used by distinct fast path). */
  getBTreeIndex(field: string): BTreeIndex | undefined {
    return this.btreeIndexes.get(field);
  }

  // --- Private ---

  private static isRangeOp(value: unknown): value is Record<string, unknown> {
    if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return false;
    const keys = Object.keys(value as Record<string, unknown>);
    return keys.length > 0 && keys.every((k) => k === "$gt" || k === "$gte" || k === "$lt" || k === "$lte");
  }

  private compositeIndexedCandidates(filterObj: Record<string, unknown>): Set<string> | null {
    if (this.compositeIndexes.size === 0) return null;

    for (const [, { fields, idx }] of this.compositeIndexes) {
      const values: unknown[] = [];
      let eligible = true;
      let trailingRange: Record<string, unknown> | null = null;

      for (let i = 0; i < fields.length; i++) {
        const fval = filterObj[fields[i]];
        if (fval === undefined) { eligible = false; break; }

        if (i < fields.length - 1) {
          if (fval !== null && typeof fval === "object") { eligible = false; break; }
          values.push(fval);
        } else {
          if (fval === null || typeof fval !== "object") {
            values.push(fval);
          } else if (IndexManager.isRangeOp(fval)) {
            trailingRange = fval as Record<string, unknown>;
          } else {
            eligible = false; break;
          }
        }
      }

      if (!eligible) continue;

      if (!trailingRange) {
        return idx.eq(compositeKey(values));
      }
    }

    return null;
  }

  // --- Persistence ---

  /** Serialize all indexes to JSON objects for disk persistence. */
  serializeIndexes(): {
    btree: Array<{ field: string; data: ReturnType<BTreeIndex["toJSON"]> }>;
    array: Array<{ field: string; data: ReturnType<ArrayIndex["toJSON"]> }>;
  } {
    const btree = [...this.btreeIndexes.entries()].map(([field, idx]) => ({ field, data: idx.toJSON() }));
    const array = [...this.arrayIndexes.entries()].map(([field, idx]) => ({ field, data: idx.toJSON() }));
    return { btree, array };
  }

  /** Load B-tree indexes from serialized data. */
  loadBTreeIndex(data: ReturnType<BTreeIndex["toJSON"]>): void {
    this.btreeIndexes.set(data.field, BTreeIndex.fromJSON(data));
  }

  /** Load array index from serialized data. */
  loadArrayIndex(data: ReturnType<ArrayIndex["toJSON"]>): void {
    this.arrayIndexes.set(data.field, ArrayIndex.fromJSON(data));
  }
}
