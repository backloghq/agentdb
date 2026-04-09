import { randomUUID } from "node:crypto";
import { Store } from "@backloghq/opslog";
import type { Operation } from "@backloghq/opslog";
import { compileFilter } from "./filter.js";

// Internal record type — what's stored in opslog
type StoredRecord = Record<string, unknown>;

/** Options for mutation operations. */
export interface MutationOpts {
  /** Agent identity — who is making this change. */
  agent?: string;
  /** Reason — why this change is being made. */
  reason?: string;
}

/** Options for find queries. */
export interface FindOpts {
  /** Filter expression (JSON object). */
  filter?: Record<string, unknown> | null;
  /** Max records to return. */
  limit?: number;
  /** Skip N records. */
  offset?: number;
  /** Return summary fields only (short-valued fields, omit long text). */
  summary?: boolean;
}

/** Result of a find query. */
export interface FindResult {
  records: Record<string, unknown>[];
  total: number;
  truncated: boolean;
}

/** Update operators. */
export interface UpdateOps {
  /** Set fields to values. */
  $set?: Record<string, unknown>;
  /** Remove fields (value is ignored). */
  $unset?: Record<string, unknown>;
  /** Increment numeric fields. */
  $inc?: Record<string, number>;
  /** Push values to array fields. */
  $push?: Record<string, unknown>;
}

/** Reserved field prefix for internal metadata. */
const META_AGENT = "_agent";
const META_REASON = "_reason";

/**
 * Strip internal metadata fields from a stored record for public consumption.
 */
function stripMeta(record: StoredRecord): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key !== META_AGENT && key !== META_REASON) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Summarize a record for progressive disclosure.
 * Keeps short-valued fields (numbers, booleans, dates, short strings, null).
 * Omits long text fields (strings > 200 chars).
 */
function summarize(record: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && value.length > 200) {
      continue;
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      continue; // Skip nested objects in summary
    }
    if (Array.isArray(value) && value.length > 10) {
      continue; // Skip large arrays in summary
    }
    result[key] = value;
  }
  return result;
}

/**
 * Apply update operators to a record, returning a new record.
 */
function applyUpdate(record: StoredRecord, update: UpdateOps): StoredRecord {
  const result = { ...record };

  if (update.$set) {
    for (const [key, value] of Object.entries(update.$set)) {
      result[key] = value;
    }
  }

  if (update.$unset) {
    for (const key of Object.keys(update.$unset)) {
      delete result[key];
    }
  }

  if (update.$inc) {
    for (const [key, amount] of Object.entries(update.$inc)) {
      const current = result[key];
      if (typeof current === "number") {
        result[key] = current + amount;
      } else if (current === undefined || current === null) {
        result[key] = amount;
      } else {
        throw new Error(`$inc: field '${key}' is not a number (got ${typeof current})`);
      }
    }
  }

  if (update.$push) {
    for (const [key, value] of Object.entries(update.$push)) {
      const current = result[key];
      if (Array.isArray(current)) {
        result[key] = [...current, value];
      } else if (current === undefined || current === null) {
        result[key] = [value];
      } else {
        throw new Error(`$push: field '${key}' is not an array (got ${typeof current})`);
      }
    }
  }

  return result;
}

/**
 * A named collection backed by an opslog Store.
 * Provides document-store operations (insert, find, update, delete)
 * with agent identity tracking on mutations.
 */
export class Collection {
  readonly name: string;
  private store: Store<StoredRecord>;
  private _opened = false;

  constructor(name: string, store: Store<StoredRecord>) {
    this.name = name;
    this.store = store;
  }

  /** Whether the underlying store is open. */
  get opened(): boolean {
    return this._opened;
  }

  /** Open the underlying opslog store at the given directory. */
  async open(dir: string, options?: { checkpointThreshold?: number }): Promise<void> {
    await this.store.open(dir, options);
    this._opened = true;
  }

  /** Close the underlying store. */
  async close(): Promise<void> {
    await this.store.close();
    this._opened = false;
  }

  /**
   * Insert a document. Auto-generates _id if not provided.
   * Returns the _id of the inserted record.
   */
  async insert(doc: Record<string, unknown>, opts?: MutationOpts): Promise<string> {
    const id = (doc._id as string) || randomUUID();
    const stored: StoredRecord = { ...doc, _id: id };
    if (opts?.agent) stored[META_AGENT] = opts.agent;
    if (opts?.reason) stored[META_REASON] = opts.reason;
    await this.store.set(id, stored);
    return id;
  }

  /**
   * Insert multiple documents atomically.
   * Returns array of _ids.
   */
  async insertMany(docs: Record<string, unknown>[], opts?: MutationOpts): Promise<string[]> {
    const ids: string[] = [];
    await this.store.batch(() => {
      for (const doc of docs) {
        const id = (doc._id as string) || randomUUID();
        ids.push(id);
        const stored: StoredRecord = { ...doc, _id: id };
        if (opts?.agent) stored[META_AGENT] = opts.agent;
        if (opts?.reason) stored[META_REASON] = opts.reason;
        this.store.set(id, stored);
      }
    });
    return ids;
  }

  /**
   * Find a single record by ID.
   * Returns the record or undefined.
   */
  findOne(id: string): Record<string, unknown> | undefined {
    const record = this.store.get(id);
    if (!record) return undefined;
    return stripMeta(record);
  }

  /**
   * Find records matching a filter with pagination and summary mode.
   */
  find(opts?: FindOpts): FindResult {
    const filter = opts?.filter;
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;
    const useSummary = opts?.summary ?? false;

    let records: StoredRecord[];
    if (filter === null || filter === undefined || Object.keys(filter).length === 0) {
      records = this.store.all();
    } else {
      const predicate = compileFilter(filter);
      records = this.store.filter((value) => predicate(stripMeta(value)));
    }

    const total = records.length;
    const sliced = records.slice(offset, offset + limit);
    const mapped = sliced.map((r) => {
      const clean = stripMeta(r);
      return useSummary ? summarize(clean) : clean;
    });

    return {
      records: mapped,
      total,
      truncated: total > offset + limit,
    };
  }

  /**
   * Count records matching a filter.
   */
  count(filter?: Record<string, unknown> | null): number {
    if (filter === null || filter === undefined || Object.keys(filter).length === 0) {
      return this.store.count();
    }
    const predicate = compileFilter(filter);
    return this.store.count((value) => predicate(stripMeta(value)));
  }

  /**
   * Update records matching a filter. Returns number of modified records.
   */
  async update(filter: Record<string, unknown>, update: UpdateOps, opts?: MutationOpts): Promise<number> {
    const predicate = compileFilter(filter);
    const matches: [string, StoredRecord][] = [];
    for (const [id, value] of this.store.entries()) {
      if (predicate(stripMeta(value))) {
        matches.push([id, value]);
      }
    }

    if (matches.length === 0) return 0;

    await this.store.batch(() => {
      for (const [id, record] of matches) {
        const updated = applyUpdate(record, update);
        if (opts?.agent) updated[META_AGENT] = opts.agent;
        if (opts?.reason) updated[META_REASON] = opts.reason;
        this.store.set(id, updated);
      }
    });

    return matches.length;
  }

  /**
   * Insert or update a record by ID.
   * Returns whether the record was inserted or updated.
   */
  async upsert(
    id: string,
    doc: Record<string, unknown>,
    opts?: MutationOpts,
  ): Promise<{ id: string; action: "inserted" | "updated" }> {
    const existing = this.store.has(id);
    const stored: StoredRecord = { ...doc, _id: id };
    if (opts?.agent) stored[META_AGENT] = opts.agent;
    if (opts?.reason) stored[META_REASON] = opts.reason;
    await this.store.set(id, stored);
    return { id, action: existing ? "updated" : "inserted" };
  }

  /**
   * Delete records matching a filter. Returns number of deleted records.
   */
  async remove(filter: Record<string, unknown>, opts?: MutationOpts): Promise<number> {
    const predicate = compileFilter(filter);
    const toDelete: string[] = [];
    for (const [id, value] of this.store.entries()) {
      if (predicate(stripMeta(value))) {
        toDelete.push(id);
      }
    }

    if (toDelete.length === 0) return 0;

    // Set agent/reason on the last version before deleting
    if (opts?.agent || opts?.reason) {
      await this.store.batch(() => {
        for (const id of toDelete) {
          const record = this.store.get(id)!;
          const tagged = { ...record };
          if (opts?.agent) tagged[META_AGENT] = opts.agent;
          if (opts?.reason) tagged[META_REASON] = opts.reason;
          this.store.set(id, tagged);
        }
      });
    }

    await this.store.batch(() => {
      for (const id of toDelete) {
        this.store.delete(id);
      }
    });

    return toDelete.length;
  }

  /**
   * Undo the last mutation in this collection.
   */
  async undo(): Promise<boolean> {
    return this.store.undo();
  }

  /**
   * Get mutation history for a specific record.
   */
  history(id: string): Operation<StoredRecord>[] {
    return this.store.getHistory(id);
  }

  /**
   * Get operations since a timestamp.
   */
  getOps(since?: string): Operation<StoredRecord>[] {
    return this.store.getOps(since);
  }

  /** Get collection stats. */
  stats(): { activeRecords: number; opsCount: number } {
    const s = this.store.stats();
    return { activeRecords: s.activeRecords, opsCount: s.opsCount };
  }

  /**
   * Inspect the shape of records in this collection.
   * Samples up to `sampleSize` records and returns field info.
   */
  schema(sampleSize = 50): { fields: FieldInfo[]; sampleCount: number } {
    const all = this.store.all();
    const samples = all.slice(0, sampleSize);
    const fieldMap = new Map<string, { types: Set<string>; example: unknown }>();

    for (const record of samples) {
      const clean = stripMeta(record);
      for (const [key, value] of Object.entries(clean)) {
        const existing = fieldMap.get(key);
        const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
        if (existing) {
          existing.types.add(type);
        } else {
          fieldMap.set(key, { types: new Set([type]), example: value });
        }
      }
    }

    const fields: FieldInfo[] = [];
    for (const [name, info] of fieldMap) {
      fields.push({
        name,
        type: info.types.size === 1 ? [...info.types][0] : [...info.types].join(" | "),
        example: summarizeValue(info.example),
      });
    }

    return { fields, sampleCount: samples.length };
  }

  /**
   * Get unique values for a field across all records.
   */
  distinct(field: string): { field: string; values: unknown[]; count: number } {
    const seen = new Set<string>();
    const values: unknown[] = [];

    for (const record of this.store.all()) {
      const clean = stripMeta(record);
      const value = getNestedValue(clean, field);
      if (value === undefined) continue;
      const key = JSON.stringify(value);
      if (!seen.has(key)) {
        seen.add(key);
        values.push(value);
      }
    }

    return { field, values, count: values.length };
  }
}

export interface FieldInfo {
  name: string;
  type: string;
  example: unknown;
}

/**
 * Get a nested value from a record using dot-notation path.
 */
function getNestedValue(record: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = record;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Truncate a value for display in schema examples. */
function summarizeValue(value: unknown): unknown {
  if (typeof value === "string" && value.length > 100) {
    return value.slice(0, 100) + "...";
  }
  if (Array.isArray(value) && value.length > 5) {
    return [...value.slice(0, 5), `... (${value.length} items)`];
  }
  return value;
}
