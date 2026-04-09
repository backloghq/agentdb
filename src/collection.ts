import { randomUUID } from "node:crypto";
import { Store } from "@backloghq/opslog";
import type { Operation } from "@backloghq/opslog";
import { compileFilter } from "./filter.js";
import { parseCompactFilter } from "./compact-filter.js";
import { TextIndex } from "./text-index.js";
import { ViewManager } from "./view.js";
import type { ViewDefinition } from "./view.js";
import { EventEmitter } from "node:events";
import { HnswIndex } from "./hnsw.js";
import type { EmbeddingProvider } from "./embeddings/types.js";
import { quantize, serializeQuantized, deserializeQuantized } from "./embeddings/quantize.js";

// Internal record type — what's stored in opslog
type StoredRecord = Record<string, unknown>;

/** Options for mutation operations. */
export interface MutationOpts {
  /** Agent identity — who is making this change. */
  agent?: string;
  /** Reason — why this change is being made. */
  reason?: string;
  /** Time-to-live in seconds. Record expires after this duration. */
  ttl?: number;
  /** Optimistic lock — fail if record has been modified past this version. */
  expectedVersion?: number;
}

/** Filter can be a JSON object or a compact string. */
export type Filter = Record<string, unknown> | string | null | undefined;

/** Options for find queries. */
export interface FindOpts {
  /** Filter expression (JSON object or compact string like "role:admin age.gt:18"). */
  filter?: Filter;
  /** Max records to return. */
  limit?: number;
  /** Skip N records. */
  offset?: number;
  /** Return summary fields only (short-valued fields, omit long text). */
  summary?: boolean;
  /** Approximate token budget — stop adding records when estimated tokens exceed this. */
  maxTokens?: number;
}

/** Resolve a filter (string or object) into a compiled predicate, with optional virtual filter support. */
function resolveFilter(
  filter: Filter,
  virtualFilters?: Record<string, VirtualFilterFn>,
  getter?: (id: string) => Record<string, unknown> | undefined,
): (record: Record<string, unknown>) => boolean {
  if (filter === null || filter === undefined) return () => true;

  let filterObj: Record<string, unknown>;
  if (typeof filter === "string") {
    if (filter.trim() === "") return () => true;
    filterObj = parseCompactFilter(filter);
  } else {
    filterObj = filter;
  }
  if (Object.keys(filterObj).length === 0) return () => true;

  // Extract virtual filter keys and build separate predicates
  if (virtualFilters) {
    const vfKeys = Object.keys(filterObj).filter((k) => k.startsWith("+") && virtualFilters[k]);
    if (vfKeys.length > 0) {
      const remaining: Record<string, unknown> = {};
      const vfPredicates: ((record: Record<string, unknown>) => boolean)[] = [];

      for (const [key, value] of Object.entries(filterObj)) {
        if (key.startsWith("+") && virtualFilters[key]) {
          const vfFn = virtualFilters[key];
          const g = getter ?? (() => undefined);
          // value of true = include matching, false = include non-matching
          if (value === false) {
            vfPredicates.push((record) => !vfFn(record, g));
          } else {
            vfPredicates.push((record) => vfFn(record, g));
          }
        } else {
          remaining[key] = value;
        }
      }

      const basePredicate = Object.keys(remaining).length > 0
        ? compileFilter(remaining)
        : () => true;

      return (record) =>
        basePredicate(record) && vfPredicates.every((p) => p(record));
    }
  }

  return compileFilter(filterObj);
}

/** Result of a find query. */
export interface FindResult {
  records: Record<string, unknown>[];
  total: number;
  truncated: boolean;
  /** Approximate token count of the returned records (4 chars/token heuristic). */
  estimatedTokens?: number;
}

/** Approximate token count for a value (4 chars per token heuristic). */
function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
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

/** Computed field function — receives the record and a lazy accessor for all records. */
export type ComputedFn = (record: Record<string, unknown>, allRecords: () => Record<string, unknown>[]) => unknown;

/** Virtual filter function — receives the record and a getter for looking up records by ID. */
export type VirtualFilterFn = (record: Record<string, unknown>, getter: (id: string) => Record<string, unknown> | undefined) => boolean;

/** Options for configuring collection middleware. */
export interface CollectionOptions {
  /** Validation function — called before every insert/update/upsert. Throw to reject. */
  validate?: (record: Record<string, unknown>) => void;
  /** Computed fields — calculated on read, not stored. Keys are field names, values are compute functions. */
  computed?: Record<string, ComputedFn>;
  /** Virtual filters — domain-specific query predicates. Keys like "+OVERDUE" usable in filters. */
  virtualFilters?: Record<string, VirtualFilterFn>;
  /** Enable full-text search index. Automatically indexes all string fields. */
  textSearch?: boolean;
}

/** Change event emitted after mutations. */
export interface ChangeEvent {
  type: "insert" | "update" | "upsert" | "delete" | "undo";
  collection: string;
  ids: string[];
  agent?: string;
}

/** Reserved field prefix for internal metadata. */
const META_AGENT = "_agent";
const META_REASON = "_reason";
const META_EXPIRES = "_expires";
const META_EMBEDDING = "_embedding";
const META_VERSION = "_version";

/**
 * Strip internal metadata fields from a stored record for public consumption.
 */
function stripMeta(record: StoredRecord): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key !== META_AGENT && key !== META_REASON && key !== META_EXPIRES && key !== META_EMBEDDING) {
      result[key] = value;
    }
  }
  return result;
}

/** Check if a record has expired. */
function isExpired(record: StoredRecord): boolean {
  const expires = record[META_EXPIRES];
  if (!expires || typeof expires !== "string") return false;
  return new Date(expires) < new Date();
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
  private opts: CollectionOptions;
  private textIdx: TextIndex | null = null;
  private views = new ViewManager();
  private hnswIdx: HnswIndex | null = null;
  private embeddingProvider: EmbeddingProvider | null = null;
  private emitter = new EventEmitter();

  constructor(name: string, store: Store<StoredRecord>, opts?: CollectionOptions) {
    this.name = name;
    this.store = store;
    this.opts = opts ?? {};
    if (this.opts.textSearch) this.textIdx = new TextIndex();
  }

  /** Check optimistic lock and throw on version mismatch. */
  private checkVersion(id: string, expectedVersion: number | undefined): void {
    if (expectedVersion === undefined) return;
    const record = this.store.get(id);
    if (!record) return; // New record, no version to check
    const currentVersion = (record[META_VERSION] as number) ?? 0;
    if (currentVersion !== expectedVersion) {
      throw new Error(
        `Conflict: record '${id}' is at version ${currentVersion}, expected ${expectedVersion}`,
      );
    }
  }

  /** Set version on a stored record (increment existing or start at 1). */
  private stampVersion(stored: StoredRecord, id: string): void {
    const existing = this.store.get(id);
    const currentVersion = existing ? ((existing[META_VERSION] as number) ?? 0) : 0;
    stored[META_VERSION] = currentVersion + 1;
  }

  /** Subscribe to change events. */
  on(event: "change", listener: (e: ChangeEvent) => void): void {
    this.emitter.on(event, listener);
  }

  /** Unsubscribe from change events. */
  off(event: "change", listener: (e: ChangeEvent) => void): void {
    this.emitter.off(event, listener);
  }

  /** Emit a change event and invalidate caches. */
  private emitChange(type: ChangeEvent["type"], ids: string[], agent?: string): void {
    this.views.invalidate();
    this.emitter.emit("change", { type, collection: this.name, ids, agent } satisfies ChangeEvent);
  }

  /** Rebuild the full text index from current store contents. */
  private rebuildTextIndex(): void {
    if (!this.textIdx) return;
    this.textIdx.clear();
    for (const [id, record] of this.store.entries()) {
      this.textIdx.add(id, stripMeta(record));
    }
  }

  /** Run the validate hook on a clean record (meta stripped). Throws on invalid. */
  private validateRecord(record: Record<string, unknown>): void {
    if (this.opts.validate) {
      this.opts.validate(stripMeta(record));
    }
  }

  /** Apply computed fields to a clean record. Lazy-loads allRecords on first use. */
  private applyComputed(record: Record<string, unknown>, allRecordsAccessor: () => Record<string, unknown>[]): Record<string, unknown> {
    if (!this.opts.computed) return record;
    const result = { ...record };
    for (const [key, fn] of Object.entries(this.opts.computed)) {
      result[key] = fn(record, allRecordsAccessor);
    }
    return result;
  }

  /** Create a lazy accessor for all active (non-expired) clean records. */
  private allCleanRecords(): () => Record<string, unknown>[] {
    let cached: Record<string, unknown>[] | null = null;
    return () => {
      if (!cached) cached = this.store.all().filter((r) => !isExpired(r)).map(stripMeta);
      return cached;
    };
  }

  /** Create a getter for looking up clean records by ID. */
  private recordGetter(): (id: string) => Record<string, unknown> | undefined {
    return (id: string) => {
      const record = this.store.get(id);
      return record ? stripMeta(record) : undefined;
    };
  }

  /** Resolve a filter with virtual filter support. */
  private resolve(filter: Filter): (record: Record<string, unknown>) => boolean {
    return resolveFilter(filter, this.opts.virtualFilters, this.recordGetter());
  }

  /** Whether the underlying store is open. */
  get opened(): boolean {
    return this._opened;
  }

  /** Set the embedding provider for semantic search. Called by AgentDB. */
  setEmbeddingProvider(provider: EmbeddingProvider): void {
    this.embeddingProvider = provider;
    this.hnswIdx = new HnswIndex({ dimensions: provider.dimensions });
  }

  /** Open the underlying opslog store at the given directory. */
  async open(dir: string, options?: { checkpointThreshold?: number }): Promise<void> {
    await this.store.open(dir, options);
    this._opened = true;
    // Build text index from existing records
    if (this.textIdx) {
      for (const [id, record] of this.store.entries()) {
        this.textIdx.add(id, stripMeta(record));
      }
    }
    // Load existing embeddings into HNSW index
    if (this.hnswIdx) {
      for (const [id, record] of this.store.entries()) {
        if (isExpired(record)) continue;
        const stored = record[META_EMBEDDING] as { data: number[]; scale: number } | undefined;
        if (stored) {
          const q = deserializeQuantized(stored);
          const vec = Array.from(q.data).map((v) => v / q.scale); // dequantize
          this.hnswIdx.add(id, vec);
        }
      }
    }
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
    if (opts?.ttl) stored[META_EXPIRES] = new Date(Date.now() + opts.ttl * 1000).toISOString();
    this.validateRecord(stored);
    this.stampVersion(stored, id);
    await this.store.set(id, stored);
    if (this.textIdx) this.textIdx.add(id, stripMeta(stored));
    this.emitChange("insert", [id], opts?.agent);
    return id;
  }

  /**
   * Insert multiple documents atomically.
   * Returns array of _ids.
   */
  async insertMany(docs: Record<string, unknown>[], opts?: MutationOpts): Promise<string[]> {
    // Validate all records before writing any
    const prepared: { id: string; stored: StoredRecord }[] = [];
    for (const doc of docs) {
      const id = (doc._id as string) || randomUUID();
      const stored: StoredRecord = { ...doc, _id: id };
      if (opts?.agent) stored[META_AGENT] = opts.agent;
      if (opts?.reason) stored[META_REASON] = opts.reason;
      if (opts?.ttl) stored[META_EXPIRES] = new Date(Date.now() + opts.ttl * 1000).toISOString();
      this.validateRecord(stored);
      this.stampVersion(stored, id);
      prepared.push({ id, stored });
    }

    await this.store.batch(() => {
      for (const { id, stored } of prepared) {
        this.store.set(id, stored);
      }
    });
    if (this.textIdx) {
      for (const { id, stored } of prepared) {
        this.textIdx.add(id, stripMeta(stored));
      }
    }
    this.emitChange("insert", prepared.map((p) => p.id), opts?.agent);
    return prepared.map((p) => p.id);
  }

  /**
   * Find a single record by ID.
   * Returns the record or undefined.
   */
  findOne(id: string): Record<string, unknown> | undefined {
    const record = this.store.get(id);
    if (!record || isExpired(record)) return undefined;
    const clean = stripMeta(record);
    return this.applyComputed(clean, this.allCleanRecords());
  }

  /**
   * Find records matching a filter with pagination and summary mode.
   */
  find(opts?: FindOpts): FindResult {
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;
    const useSummary = opts?.summary ?? false;
    const maxTokens = opts?.maxTokens;

    const predicate = this.resolve(opts?.filter);
    const records = this.store.filter((value) => !isExpired(value) && predicate(stripMeta(value)));

    const total = records.length;
    const sliced = records.slice(offset, offset + limit);
    const allAccessor = this.allCleanRecords();
    const mapped: Record<string, unknown>[] = [];
    let tokenCount = 0;
    let tokenTruncated = false;

    for (const r of sliced) {
      let clean = stripMeta(r);
      clean = this.applyComputed(clean, allAccessor);
      const result = useSummary ? summarize(clean) : clean;

      if (maxTokens) {
        const tokens = estimateTokens(result);
        if (tokenCount + tokens > maxTokens && mapped.length > 0) {
          tokenTruncated = true;
          break;
        }
        tokenCount += tokens;
      }

      mapped.push(result);
    }

    return {
      records: mapped,
      total,
      truncated: total > offset + limit || tokenTruncated,
      estimatedTokens: maxTokens ? tokenCount : undefined,
    };
  }

  /**
   * Count records matching a filter.
   */
  count(filter?: Filter): number {
    const predicate = this.resolve(filter);
    return this.store.count((value) => !isExpired(value) && predicate(stripMeta(value)));
  }

  /**
   * Update records matching a filter. Returns number of modified records.
   */
  async update(filter: Filter, update: UpdateOps, opts?: MutationOpts): Promise<number> {
    const predicate = this.resolve(filter);
    const matches: [string, StoredRecord][] = [];
    for (const [id, value] of this.store.entries()) {
      if (!isExpired(value) && predicate(stripMeta(value))) {
        matches.push([id, value]);
      }
    }

    if (matches.length === 0) return 0;

    // Check optimistic locks, apply updates, validate, stamp versions
    const updates: { id: string; updated: StoredRecord }[] = [];
    for (const [id, record] of matches) {
      this.checkVersion(id, opts?.expectedVersion);
      const updated = applyUpdate(record, update);
      if (opts?.agent) updated[META_AGENT] = opts.agent;
      if (opts?.reason) updated[META_REASON] = opts.reason;
      this.validateRecord(updated);
      this.stampVersion(updated, id);
      updates.push({ id, updated });
    }

    await this.store.batch(() => {
      for (const { id, updated } of updates) {
        this.store.set(id, updated);
      }
    });
    this.rebuildTextIndex();
    this.emitChange("update", updates.map((u) => u.id), opts?.agent);

    return updates.length;
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
    this.checkVersion(id, opts?.expectedVersion);
    const stored: StoredRecord = { ...doc, _id: id };
    if (opts?.agent) stored[META_AGENT] = opts.agent;
    if (opts?.reason) stored[META_REASON] = opts.reason;
    if (opts?.ttl) stored[META_EXPIRES] = new Date(Date.now() + opts.ttl * 1000).toISOString();
    this.validateRecord(stored);
    this.stampVersion(stored, id);
    await this.store.set(id, stored);
    if (this.textIdx) this.textIdx.add(id, stripMeta(stored));
    this.emitChange("upsert", [id], opts?.agent);
    return { id, action: existing ? "updated" : "inserted" };
  }

  /**
   * Delete records matching a filter. Returns number of deleted records.
   */
  async remove(filter: Filter, opts?: MutationOpts): Promise<number> {
    const predicate = this.resolve(filter);
    const toDelete: string[] = [];
    for (const [id, value] of this.store.entries()) {
      if (!isExpired(value) && predicate(stripMeta(value))) {
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
    if (this.textIdx) {
      for (const id of toDelete) this.textIdx.remove(id);
    }
    this.emitChange("delete", toDelete, opts?.agent);

    return toDelete.length;
  }

  /**
   * Undo the last mutation in this collection.
   */
  async undo(): Promise<boolean> {
    const result = await this.store.undo();
    if (result) {
      this.rebuildTextIndex();
      this.emitChange("undo", []);
    }
    return result;
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

  // --- TTL cleanup ---

  /**
   * Delete expired records from the store.
   * Expired records are already hidden from queries, but this frees storage.
   */
  async cleanup(): Promise<number> {
    const expired: string[] = [];
    for (const [id, value] of this.store.entries()) {
      if (isExpired(value)) expired.push(id);
    }
    if (expired.length === 0) return 0;

    await this.store.batch(() => {
      for (const id of expired) {
        this.store.delete(id);
      }
    });
    if (this.textIdx) {
      for (const id of expired) this.textIdx.remove(id);
    }
    this.emitChange("delete", expired);
    return expired.length;
  }

  // --- Archive ---

  /**
   * Archive records matching a filter to cold storage.
   * Archived records are removed from the active set.
   */
  async archive(filter: Filter, segment?: string): Promise<number> {
    const predicate = this.resolve(filter);
    const count = await this.store.archive(
      (value) => predicate(stripMeta(value)),
      segment,
    );
    if (count > 0) {
      this.rebuildTextIndex();
      this.emitChange("delete", []);
    }
    return count;
  }

  /**
   * Load archived records from a segment. Returns them as an array (read-only, not re-inserted).
   */
  async loadArchive(segment: string): Promise<Record<string, unknown>[]> {
    const archived = await this.store.loadArchive(segment);
    return Array.from(archived.values()).map(stripMeta);
  }

  /** List available archive segments. */
  listArchiveSegments(): string[] {
    return this.store.listArchiveSegments();
  }

  /**
   * Full-text search across all string fields.
   * Requires textSearch: true in collection options.
   * Returns records matching ALL query terms (AND semantics).
   */
  search(query: string, opts?: { limit?: number; offset?: number; summary?: boolean }): FindResult {
    if (!this.textIdx) {
      throw new Error("Full-text search not enabled. Set textSearch: true in collection options.");
    }
    const matchIds = this.textIdx.search(query);
    const allAccessor = this.allCleanRecords();
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;
    const useSummary = opts?.summary ?? false;

    const records: Record<string, unknown>[] = [];
    for (const id of matchIds) {
      const record = this.store.get(id);
      if (record && !isExpired(record)) {
        let clean = stripMeta(record);
        clean = this.applyComputed(clean, allAccessor);
        records.push(useSummary ? summarize(clean) : clean);
      }
    }

    const total = records.length;
    const sliced = records.slice(offset, offset + limit);
    return {
      records: sliced,
      total,
      truncated: total > offset + limit,
    };
  }

  // --- Named views ---

  /** Define a named query view. Results are cached until the collection is mutated. */
  defineView(def: ViewDefinition): void {
    this.views.define(def);
  }

  /** Remove a named view. */
  removeView(name: string): boolean {
    return this.views.remove(name);
  }

  /** List registered view names. */
  listViews(): string[] {
    return this.views.list();
  }

  /** Execute a named view. Returns cached results if available. */
  queryView(name: string, overrides?: Omit<FindOpts, "filter">): FindResult {
    const def = this.views.get(name);
    if (!def) throw new Error(`View '${name}' not found`);

    // Check cache
    const cached = this.views.getCached(name);
    if (cached && !overrides) return cached;

    // Execute query
    const result = this.find({ filter: def.filter, ...def.opts, ...overrides });
    if (!overrides) this.views.setCache(name, result);
    return result;
  }

  // --- Semantic search ---

  /**
   * Semantic search — find records similar to the query text.
   * Requires an embedding provider to be configured.
   * Lazily embeds records that don't have embeddings yet.
   */
  async semanticSearch(
    query: string,
    opts?: { filter?: Filter; limit?: number; summary?: boolean },
  ): Promise<{ records: Record<string, unknown>[]; scores: number[] }> {
    if (!this.embeddingProvider || !this.hnswIdx) {
      throw new Error("Semantic search not available. Configure an embedding provider on AgentDB.");
    }

    // Ensure all records are embedded
    await this.embedUnembedded();

    // Embed the query
    const [queryVec] = await this.embeddingProvider.embed([query]);

    // Search HNSW
    const limit = opts?.limit ?? 10;
    const candidates = this.hnswIdx.search(queryVec, limit * 3); // over-fetch for post-filter

    // Apply attribute filter if provided
    const predicate = opts?.filter ? this.resolve(opts.filter) : () => true;
    const allAccessor = this.allCleanRecords();

    const records: Record<string, unknown>[] = [];
    const scores: number[] = [];
    for (const { id, score } of candidates) {
      if (records.length >= limit) break;
      const record = this.store.get(id);
      if (!record || isExpired(record)) continue;
      const clean = stripMeta(record);
      if (!predicate(clean)) continue;
      const withComputed = this.applyComputed(clean, allAccessor);
      records.push(opts?.summary ? summarize(withComputed) : withComputed);
      scores.push(score);
    }

    return { records, scores };
  }

  /**
   * Embed all records that don't have embeddings yet.
   * Called lazily on first semantic search.
   */
  async embedUnembedded(): Promise<number> {
    if (!this.embeddingProvider || !this.hnswIdx) return 0;

    const toEmbed: { id: string; text: string; record: StoredRecord }[] = [];
    for (const [id, record] of this.store.entries()) {
      if (isExpired(record)) continue;
      if (record[META_EMBEDDING]) continue; // already embedded
      const clean = stripMeta(record);
      const text = extractTextFromRecord(clean);
      if (text) toEmbed.push({ id, text, record });
    }

    if (toEmbed.length === 0) return 0;

    // Batch embed
    const texts = toEmbed.map((t) => t.text);
    const vectors = await this.embeddingProvider.embed(texts);

    // Store embeddings and index
    await this.store.batch(() => {
      for (let i = 0; i < toEmbed.length; i++) {
        const { id, record } = toEmbed[i];
        const q = quantize(vectors[i]);
        const updated = { ...record, [META_EMBEDDING]: serializeQuantized(q) };
        this.store.set(id, updated);
      }
    });

    // Add to HNSW index
    for (let i = 0; i < toEmbed.length; i++) {
      this.hnswIdx.add(toEmbed[i].id, vectors[i]);
    }

    return toEmbed.length;
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

    const allAccessor = this.allCleanRecords();
    for (const record of samples) {
      const clean = this.applyComputed(stripMeta(record), allAccessor);
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

/** Extract all text from a record for embedding (concatenate string fields). */
function extractTextFromRecord(record: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const value of Object.values(record)) {
    if (typeof value === "string" && value.length > 0) {
      parts.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") parts.push(item);
      }
    }
  }
  return parts.join(" ");
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
