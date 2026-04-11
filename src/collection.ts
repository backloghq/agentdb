import { randomUUID } from "node:crypto";
import { Store, FsBackend } from "@backloghq/opslog";
import type { Operation, StorageBackend } from "@backloghq/opslog";
import type { DiskStore } from "./disk-store.js";
import { getNestedValue } from "./filter.js";
// parseCompactFilter used by IndexManager (imported there directly)
import { TextIndex } from "./text-index.js";
import { ViewManager } from "./view.js";
import type { ViewDefinition } from "./view.js";
import { EventEmitter } from "node:events";
import { HnswIndex } from "./hnsw.js";
import { IndexManager } from "./collection-indexes.js";
import type { EmbeddingProvider } from "./embeddings/types.js";
import { quantize, serializeQuantized, deserializeQuantized } from "./embeddings/quantize.js";
import {
  type StoredRecord,
  type Filter,
  type VirtualFilterFn,
  type UpdateOps,
  META_AGENT, META_REASON, META_EXPIRES, META_EMBEDDING, META_VERSION,
  resolveFilter, stripMeta, isExpired, summarize, estimateTokens,
  applyUpdate, extractTextFromRecord, summarizeValue,
} from "./collection-helpers.js";

// Re-export types and helpers that external consumers depend on
export type { StoredRecord, Filter, UpdateOps } from "./collection-helpers.js";
export type { ComputedFn, VirtualFilterFn } from "./collection-helpers.js";

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
  /** Sort by field. Prefix with "-" for descending. E.g. "name" or "-score". */
  sort?: string;
}

/** Result of a find query. */
export interface FindResult {
  records: Record<string, unknown>[];
  total: number;
  truncated: boolean;
  /** Approximate token count of the returned records (4 chars/token heuristic). */
  estimatedTokens?: number;
}

/** Options for configuring collection middleware. */
export interface CollectionOptions {
  /** Validation function — called before every insert/update/upsert. Throw to reject. */
  validate?: (record: Record<string, unknown>) => void;
  /** Computed fields — calculated on read, not stored. Keys are field names, values are compute functions. */
  computed?: Record<string, import("./collection-helpers.js").ComputedFn>;
  /** Virtual filters — domain-specific query predicates. Keys like "+OVERDUE" usable in filters. */
  virtualFilters?: Record<string, VirtualFilterFn>;
  /** Enable full-text search index. Automatically indexes all string fields. */
  textSearch?: boolean;
  /** Array field name for +tag/-tag compact filter syntax. Default: "tags". */
  tagField?: string;
  /** Storage mode override for this collection. */
  storageMode?: "memory" | "disk" | "auto";
}

/** Change event emitted after mutations. */
export interface ChangeEvent {
  type: "insert" | "update" | "upsert" | "delete" | "undo";
  collection: string;
  ids: string[];
  agent?: string;
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
  private backend: StorageBackend = new FsBackend();
  private blobPrefix = "";
  private emitter = new EventEmitter();
  private indexes = new IndexManager();
  private _hasTTL = false; // Tracks if any record has been inserted with TTL
  private _diskStore: DiskStore | null = null;

  /** Set disk store for disk-backed mode. Called by AgentDB during open. */
  setDiskStore(ds: DiskStore): void { this._diskStore = ds; }

  /** Get disk store (if in disk mode). */
  getDiskStore(): DiskStore | null { return this._diskStore; }

  /** Get the index manager (for persistence). */
  getIndexManager(): IndexManager { return this.indexes; }

  /** Get the text index (for persistence). */
  getTextIndex(): TextIndex | null { return this.textIdx; }

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
    // Mark DiskStore dirty so close() knows to compact. Don't populate cache —
    // records are in the Map during the session. Cache is for Parquet reads on reopen.
    if (this._diskStore) {
      this._diskStore.markDirty();
      if (type === "delete") {
        for (const id of ids) this._diskStore.cacheDelete(id);
      }
    }
    this.emitter.emit("change", { type, collection: this.name, ids, agent } satisfies ChangeEvent);
  }

  /** Update indexes for a record change. Delegates to IndexManager. */
  private updateBTreeIndexes(id: string, oldRecord: StoredRecord | undefined, newRecord: StoredRecord | undefined): void {
    this.indexes.updateIndexes(id, oldRecord, newRecord);
  }

  /** Rebuild the full text index from current store contents. */
  private rebuildTextIndex(): void {
    if (!this.textIdx) return;
    this.textIdx.clear();
    for (const [id, record] of this.store.entries()) {
      this.textIdx.add(id, stripMeta(record));
    }
  }

  /** Rebuild all indexes from current store contents. Delegates to IndexManager. */
  private rebuildBTreeIndexes(): void {
    this.indexes.rebuildAll(this.store.entries());
  }

  /**
   * Incremental index update for known affected IDs.
   * Re-indexes only the specified records in the text index (avoids re-tokenizing all records).
   * B-tree indexes are fully rebuilt (cheap — just field lookups, no tokenization).
   */
  private incrementalIndexUpdate(affectedIds: string[]): void {
    const cleanRecords = this.indexes.incrementalUpdate(affectedIds, (id) => this.store.get(id));
    if (this.textIdx) {
      for (const [id, clean] of cleanRecords) {
        if (clean) this.textIdx.add(id, clean);
        else this.textIdx.remove(id);
      }
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

  /** Create a lazy accessor for all active (non-expired) clean records. Single-pass. */
  private allCleanRecords(): () => Record<string, unknown>[] {
    let cached: Record<string, unknown>[] | null = null;
    return () => {
      if (!cached) {
        cached = [];
        for (const [, record] of this.store.entries()) {
          if (!isExpired(record)) cached.push(stripMeta(record));
        }
      }
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

  /** Check if text fields changed between old and new record (for embedding invalidation). */
  private hasTextChanged(oldRecord: StoredRecord, newRecord: StoredRecord): boolean {
    const oldText = extractTextFromRecord(stripMeta(oldRecord));
    const newText = extractTextFromRecord(stripMeta(newRecord));
    return oldText !== newText;
  }

  // --- Index delegation (all state in IndexManager) ---

  private indexedCandidates(filter: Filter): Set<string> | null {
    return this.indexes.indexedCandidates(filter);
  }

  private isFullyCoveredByIndex(filter: Filter): boolean {
    return this.indexes.isFullyCoveredByIndex(filter);
  }

  private trackQueryFields(filter: Filter): void {
    this.indexes.trackQueryFields(filter);
  }

  /** Resolve a filter with virtual filter support. */
  private resolve(filter: Filter): (record: Record<string, unknown>) => boolean {
    return resolveFilter(filter, this.opts.virtualFilters, this.recordGetter(), this.opts.tagField);
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
  async open(dir: string, options?: { checkpointThreshold?: number; backend?: StorageBackend; agentId?: string; writeMode?: "immediate" | "group" | "async"; groupCommitSize?: number; groupCommitMs?: number; readOnly?: boolean; skipLoad?: boolean }): Promise<void> {
    await this.store.open(dir, options);
    this._opened = true;
    if (options?.backend) {
      this.backend = options.backend;
    } else {
      // Create a per-collection FsBackend initialized with the collection dir
      // so blob paths resolve relative to the collection, not CWD
      const blobBackend = new FsBackend();
      await blobBackend.initialize(dir, { readOnly: !!options?.readOnly });
      this.backend = blobBackend;
    }
    this.blobPrefix = "blobs";
    // Single pass: detect TTL, build text index, load HNSW embeddings
    for (const [id, record] of this.store.entries()) {
      if (record[META_EXPIRES]) this._hasTTL = true;
      if (this.textIdx) this.textIdx.add(id, stripMeta(record));
      if (!isExpired(record)) {
        const stored = record[META_EMBEDDING] as { data: number[]; scale: number } | undefined;
        if (stored) {
          const q = deserializeQuantized(stored);
          const vec = Array.from(q.data).map((v) => v / q.scale);
          if (!this.hnswIdx || this.hnswIdx.dims === 0) {
            this.hnswIdx = new HnswIndex({ dimensions: vec.length });
          }
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
    if (opts?.ttl) { stored[META_EXPIRES] = Date.now() + opts.ttl * 1000; this._hasTTL = true; }
    this.validateRecord(stored);
    this.stampVersion(stored, id);
    const oldRecord = this.store.get(id);
    await this.store.set(id, stored);
    if (this.textIdx) this.textIdx.add(id, stripMeta(stored));
    this.updateBTreeIndexes(id, oldRecord, stored);
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
      if (opts?.ttl) { stored[META_EXPIRES] = Date.now() + opts.ttl * 1000; this._hasTTL = true; }
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
    for (const { id, stored } of prepared) {
      this.updateBTreeIndexes(id, undefined, stored);
    }
    this.emitChange("insert", prepared.map((p) => p.id), opts?.agent);
    return prepared.map((p) => p.id);
  }

  /**
   * Find a single record by ID.
   * Returns the record or undefined.
   */
  async findOne(id: string): Promise<Record<string, unknown> | undefined> {
    let record: StoredRecord | undefined;
    if (this._diskStore) {
      record = await this._diskStore.get(id) as StoredRecord | undefined;
    }
    // Fall back to in-memory Map (covers both memory mode and disk mode write-through)
    if (!record) {
      record = this.store.get(id);
    }
    if (!record || isExpired(record)) return undefined;
    const clean = stripMeta(record);
    return this.opts.computed ? this.applyComputed(clean, this.allCleanRecords()) : clean;
  }

  /**
   * Find records matching a filter with pagination and summary mode.
   */
  /** Return all non-expired records (no limit, no pagination). For internal use (export, etc). */
  async findAll(): Promise<Record<string, unknown>[]> {
    if (this._diskStore?.hasParquetData) {
      // Disk mode: merge Map (session writes) + Parquet
      const seen = new Set<string>();
      const result: Record<string, unknown>[] = [];
      for (const [id, record] of this.store.entries()) {
        if (!isExpired(record)) { result.push(stripMeta(record)); seen.add(id); }
      }
      for await (const [id, record] of this._diskStore.entries()) {
        if (!seen.has(id) && !isExpired(record as StoredRecord)) result.push(stripMeta(record as StoredRecord));
      }
      return result;
    }
    const result: Record<string, unknown>[] = [];
    for (const [, record] of this.store.entries()) {
      if (!isExpired(record)) result.push(stripMeta(record));
    }
    return result;
  }

  async find(opts?: FindOpts): Promise<FindResult> {
    const MAX_LIMIT = 10000;
    const limit = Math.min(opts?.limit ?? 50, MAX_LIMIT);
    const offset = opts?.offset ?? 0;
    const useSummary = opts?.summary ?? false;
    const maxTokens = opts?.maxTokens;

    // Extract $text from filter for combined text + attribute search
    let textQuery: string | undefined;
    let attrFilter = opts?.filter;
    if (attrFilter && typeof attrFilter === "object" && "$text" in attrFilter) {
      textQuery = attrFilter.$text as string;
      const { $text: _textVal, ...rest } = attrFilter;
      void _textVal;
      attrFilter = Object.keys(rest).length > 0 ? rest : undefined;
    }

    // Track queried fields for index suggestions
    this.trackQueryFields(attrFilter);

    const predicate = this.resolve(attrFilter);

    // If $text is present, intersect text search with attribute filter
    let textMatchIds: Set<string> | null = null;
    if (textQuery) {
      if (!this.textIdx) throw new Error("Text search not enabled. Set textSearch: true in collection options.");
      textMatchIds = new Set(this.textIdx.search(textQuery));
    }

    const candidateIds = this.indexedCandidates(attrFilter);
    let records: StoredRecord[];

    if (this._diskStore?.hasParquetData) {
      // Disk mode with Parquet: merge DiskStore (Parquet) + Map (session writes)
      const seen = new Set<string>();
      records = [];

      // First: records from in-memory Map (session writes, most recent)
      for (const [id, value] of this.store.entries()) {
        if (!isExpired(value) && predicate(value)) {
          if (!textMatchIds || textMatchIds.has(id)) {
            if (!candidateIds || candidateIds.has(id)) {
              records.push(value);
            }
          }
        }
        seen.add(id);
      }

      // Second: records from Parquet (not already in Map)
      if (textMatchIds) {
        const uncached = [...textMatchIds].filter((id) => !seen.has(id));
        if (uncached.length > 0) {
          const fetched = await this._diskStore.getMany(uncached);
          for (const [, r] of fetched) {
            if (!isExpired(r as StoredRecord) && predicate(r as StoredRecord)) records.push(r as StoredRecord);
          }
        }
      } else if (candidateIds) {
        const uncached = [...candidateIds].filter((id) => !seen.has(id));
        if (uncached.length > 0) {
          const fetched = await this._diskStore.getMany(uncached);
          for (const [, r] of fetched) {
            if (!isExpired(r as StoredRecord) && predicate(r as StoredRecord)) records.push(r as StoredRecord);
          }
        }
      } else {
        // Full scan from Parquet — loads all records. Consider creating an index for large collections.
        if (this._diskStore.recordCount > 10_000) {
          console.warn(`agentdb: full scan on disk-backed collection '${this.name}' (${this._diskStore.recordCount} records). Consider creating an index.`);
        }
        for await (const [id, record] of this._diskStore.entries()) {
          if (seen.has(id)) continue;
          const r = record as StoredRecord;
          if (!isExpired(r) && predicate(r)) records.push(r);
        }
      }
    } else {
      // Memory mode: read from Map
      if (textMatchIds) {
        records = [];
        for (const id of textMatchIds) {
          const value = this.store.get(id);
          if (value && !isExpired(value) && predicate(value)) records.push(value);
        }
      } else if (candidateIds) {
        records = [];
        for (const id of candidateIds) {
          const value = this.store.get(id);
          if (value && !isExpired(value) && predicate(value)) {
            records.push(value);
          }
        }
      } else {
        records = this.store.filter((value) => !isExpired(value) && predicate(value));
      }
    }

    // Sort if requested
    if (opts?.sort) {
      const desc = opts.sort.startsWith("-");
      const sortField = desc ? opts.sort.slice(1) : opts.sort;
      const cmp = (a: StoredRecord, b: StoredRecord) => {
        const va = getNestedValue(a, sortField);
        const vb = getNestedValue(b, sortField);
        if (va === vb) return 0;
        if (va === undefined || va === null) return 1;
        if (vb === undefined || vb === null) return -1;
        const c = va < vb ? -1 : va > vb ? 1 : 0;
        return desc ? -c : c;
      };
      const k = offset + limit;
      if (records.length > k * 10 && k < records.length) {
        // Partial sort: keep sorted window of size k, single-pass the rest. O(n log k).
        const top = records.slice(0, k).sort(cmp);
        for (let i = k; i < records.length; i++) {
          if (cmp(records[i], top[k - 1]) < 0) {
            let lo = 0, hi = k;
            while (lo < hi) {
              const mid = (lo + hi) >>> 1;
              if (cmp(top[mid], records[i]) <= 0) lo = mid + 1;
              else hi = mid;
            }
            top.splice(lo, 0, records[i]);
            top.pop();
          }
        }
        records = top;
      } else {
        records.sort(cmp);
      }
    }

    const total = records.length;
    const sliced = records.slice(offset, offset + limit);
    // Only materialize allCleanRecords if computed fields exist (avoids O(n) allocation)
    const allAccessor = this.opts.computed ? this.allCleanRecords() : () => [];
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
  async count(filter?: Filter): Promise<number> {
    const candidateIds = this.indexedCandidates(filter);

    // Fast path: if index covers the entire filter and no TTL records exist,
    // the index size IS the count — no record fetches needed.
    if (candidateIds && !this._hasTTL && this.isFullyCoveredByIndex(filter)) {
      return candidateIds.size;
    }

    if (this._diskStore?.hasParquetData) {
      // Disk mode fast path: no filter → offset index size + Map size (deduplicated)
      if (!filter) {
        return this._diskStore.recordCount + this.store.count();
      }
      // Column-only scan: simple equality on an extracted column
      if (filter && typeof filter === "object" && !Array.isArray(filter)) {
        const keys = Object.keys(filter).filter((k) => !k.startsWith("$") && !k.startsWith("+"));
        if (keys.length === 1) {
          const val = filter[keys[0]];
          if (val !== null && val !== undefined && typeof val !== "object") {
            const colCount = await this._diskStore.countByColumn(keys[0], val);
            if (colCount !== null) {
              // Also count matching records in Map (session writes not yet in Parquet)
              let mapCount = 0;
              for (const [, record] of this.store.entries()) {
                if ((record as Record<string, unknown>)[keys[0]] === val) mapCount++;
              }
              return colCount + mapCount;
            }
          }
        }
      }
      // Disk mode: unindexed falls through to find
      const result = await this.find({ filter, limit: 100_000 });
      return result.total;
    }

    const predicate = this.resolve(filter);
    if (candidateIds) {
      let n = 0;
      for (const id of candidateIds) {
        const value = this.store.get(id);
        if (value && !isExpired(value) && predicate(value)) n++;
      }
      return n;
    }
    return this.store.count((value) => !isExpired(value) && predicate(value));
  }

  /**
   * Extract a direct _id from a filter like { _id: "abc" } for O(1) lookup.
   * Returns the id string or null if the filter isn't a simple _id match.
   */
  private extractDirectId(filter: Filter): string | null {
    if (!filter || typeof filter === "string") return null;
    const keys = Object.keys(filter);
    if (keys.length === 1 && keys[0] === "_id") {
      const val = filter._id;
      if (typeof val === "string") return val;
    }
    return null;
  }

  /**
   * Update records matching a filter. Returns number of modified records.
   */
  async update(filter: Filter, update: UpdateOps, opts?: MutationOpts): Promise<number> {
    // Fast path: { _id: value } → direct lookup instead of linear scan
    const directId = this.extractDirectId(filter);
    const matches: [string, StoredRecord][] = [];

    if (directId) {
      const value = this.store.get(directId);
      if (value && !isExpired(value)) matches.push([directId, value]);
    } else {
      const candidateIds = this.indexedCandidates(filter);
      const predicate = this.resolve(filter);
      if (candidateIds) {
        for (const id of candidateIds) {
          const value = this.store.get(id);
          if (value && !isExpired(value) && predicate(value)) matches.push([id, value]);
        }
      } else {
        for (const [id, value] of this.store.entries()) {
          if (!isExpired(value) && predicate(value)) matches.push([id, value]);
        }
      }
    }

    if (matches.length === 0) return 0;

    // Check optimistic locks, apply updates, validate, stamp versions
    const updates: { id: string; old: StoredRecord; updated: StoredRecord }[] = [];
    for (const [id, record] of matches) {
      this.checkVersion(id, opts?.expectedVersion);
      const updated = applyUpdate(record, update);
      if (opts?.agent) updated[META_AGENT] = opts.agent;
      if (opts?.reason) updated[META_REASON] = opts.reason;
      // Invalidate embedding if text fields changed
      if (updated[META_EMBEDDING] && this.hasTextChanged(record, updated)) {
        delete updated[META_EMBEDDING];
      }
      this.validateRecord(updated);
      this.stampVersion(updated, id);
      updates.push({ id, old: record, updated });
    }

    await this.store.batch(() => {
      for (const { id, updated } of updates) {
        this.store.set(id, updated);
      }
    });
    // Incremental re-index for text and B-tree (only affected records)
    if (this.textIdx) {
      for (const { id, updated } of updates) {
        this.textIdx.add(id, stripMeta(updated));
      }
    }
    for (const { id, old, updated } of updates) {
      this.updateBTreeIndexes(id, old, updated);
    }
    this.emitChange("update", updates.map((u) => u.id), opts?.agent);

    return updates.length;
  }

  /**
   * Delete a single record by ID. Works synchronously inside batch().
   * Unlike remove() which goes through the full filter pipeline,
   * this is a direct store.delete() suitable for batch operations.
   */
  async deleteById(id: string, opts?: MutationOpts): Promise<boolean> {
    const record = this.store.get(id);
    if (!record || isExpired(record)) return false;
    this.store.delete(id);
    if (this.textIdx) this.textIdx.remove(id);
    this.updateBTreeIndexes(id, record, undefined);
    if (record._blobs) this.deleteBlobsForRecord(id).catch(() => {});
    this.emitChange("delete", [id], opts?.agent);
    return true;
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
    const oldRecord = this.store.get(id);
    const existing = oldRecord !== undefined;
    this.checkVersion(id, opts?.expectedVersion);
    const stored: StoredRecord = { ...doc, _id: id };
    if (opts?.agent) stored[META_AGENT] = opts.agent;
    if (opts?.reason) stored[META_REASON] = opts.reason;
    if (opts?.ttl) { stored[META_EXPIRES] = Date.now() + opts.ttl * 1000; this._hasTTL = true; }
    this.validateRecord(stored);
    this.stampVersion(stored, id);
    await this.store.set(id, stored);
    if (this.textIdx) this.textIdx.add(id, stripMeta(stored));
    this.updateBTreeIndexes(id, oldRecord, stored);
    this.emitChange("upsert", [id], opts?.agent);
    return { id, action: existing ? "updated" : "inserted" };
  }

  /**
   * Upsert multiple records atomically.
   * Each doc must have an _id field. Returns array of results.
   */
  async upsertMany(docs: Array<Record<string, unknown>>, opts?: MutationOpts): Promise<Array<{ id: string; action: "inserted" | "updated" }>> {
    const results: Array<{ id: string; action: "inserted" | "updated" }> = [];
    const prepared: Array<{ id: string; stored: StoredRecord; oldRecord: StoredRecord | undefined; existing: boolean }> = [];

    for (const doc of docs) {
      const id = doc._id as string;
      if (!id) throw new Error("upsertMany: each document must have an _id field");
      const oldRecord = this.store.get(id);
      const existing = oldRecord !== undefined;
      const stored: StoredRecord = { ...doc, _id: id };
      if (opts?.agent) stored[META_AGENT] = opts.agent;
      if (opts?.reason) stored[META_REASON] = opts.reason;
      if (opts?.ttl) { stored[META_EXPIRES] = Date.now() + opts.ttl * 1000; this._hasTTL = true; }
      this.validateRecord(stored);
      this.stampVersion(stored, id);
      prepared.push({ id, stored, oldRecord, existing });
    }

    await this.store.batch(() => {
      for (const { id, stored } of prepared) {
        this.store.set(id, stored);
      }
    });

    for (const { id, stored, oldRecord, existing } of prepared) {
      if (this.textIdx) this.textIdx.add(id, stripMeta(stored));
      this.updateBTreeIndexes(id, oldRecord, stored);
      results.push({ id, action: existing ? "updated" : "inserted" });
    }

    this.emitChange("upsert", prepared.map(p => p.id), opts?.agent);
    return results;
  }

  /**
   * Delete records matching a filter. Returns number of deleted records.
   */
  async remove(filter: Filter, opts?: MutationOpts): Promise<number> {
    // Fast path: { _id: value } → direct lookup
    const directId = this.extractDirectId(filter);
    const toDelete: string[] = [];

    if (directId) {
      const value = this.store.get(directId);
      if (value && !isExpired(value)) toDelete.push(directId);
    } else {
      const candidateIds = this.indexedCandidates(filter);
      const predicate = this.resolve(filter);
      if (candidateIds) {
        for (const id of candidateIds) {
          const value = this.store.get(id);
          if (value && !isExpired(value) && predicate(value)) toDelete.push(id);
        }
      } else {
        for (const [id, value] of this.store.entries()) {
          if (!isExpired(value) && predicate(value)) toDelete.push(id);
        }
      }
    }

    if (toDelete.length === 0) return 0;

    // Capture old records for B-tree cleanup
    const oldRecords = toDelete.map((id) => ({ id, record: this.store.get(id) }));

    await this.store.batch(() => {
      for (const id of toDelete) {
        this.store.delete(id);
      }
    });
    if (this.textIdx) {
      for (const id of toDelete) this.textIdx.remove(id);
    }
    for (const { id, record } of oldRecords) {
      if (record) this.updateBTreeIndexes(id, record, undefined);
      if (record?._blobs) this.deleteBlobsForRecord(id).catch(() => {});
    }
    this.emitChange("delete", toDelete, opts?.agent);

    return toDelete.length;
  }

  /**
   * Undo the last mutation in this collection.
   */
  async undo(): Promise<boolean> {
    // Capture the last op's ID before undoing so we can do incremental re-index
    const ops = this.store.getOps();
    const lastOp = ops.length > 0 ? ops[ops.length - 1] : null;
    const result = await this.store.undo();
    if (result) {
      if (lastOp) {
        this.incrementalIndexUpdate([lastOp.id]);
      } else {
        this.rebuildTextIndex();
        this.rebuildBTreeIndexes();
      }
      this.emitChange("undo", lastOp ? [lastOp.id] : []);
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

  // --- Batch ---

  /**
   * Execute multiple mutations atomically within this collection.
   * All operations succeed or all are rolled back.
   */
  async batch(fn: () => void): Promise<void> {
    await this.store.batch(fn);
    this.rebuildTextIndex();
    this.rebuildBTreeIndexes();
    this.emitChange("update", []);
  }

  // --- WAL tailing ---

  /**
   * Refresh state from the backend. Picks up writes from other agents/processes.
   * In multi-writer mode: re-reads manifest, snapshot, and all agent WAL files.
   * In single-writer/readOnly: re-reads the active ops file for new entries.
   * Call this before querying if you need to see other agents' latest writes.
   */
  async refresh(): Promise<void> {
    await this.store.refresh();
    this.rebuildTextIndex();
    this.rebuildBTreeIndexes();
    this.emitChange("update", []);
  }

  /**
   * Read new operations from the WAL since the last known position.
   * In multi-writer mode, reads ALL agent WAL files.
   * In single-writer/readOnly, reads the active ops file.
   * Returns the newly applied operations.
   */
  async tail(): Promise<Operation<StoredRecord>[]> {
    const newOps = await this.store.tail();
    if (newOps.length > 0) {
      const affectedIds = [...new Set(newOps.map((op) => op.id))];
      this.incrementalIndexUpdate(affectedIds);
      this.emitChange("update", affectedIds);
    }
    return newOps;
  }

  /**
   * Watch for new operations on an interval.
   * Calls the callback with new operations whenever they appear.
   */
  watch(callback: (ops: Operation<StoredRecord>[]) => void, intervalMs = 1000): void {
    this.store.watch((ops) => {
      if (ops.length > 0) {
        const affectedIds = [...new Set(ops.map((op) => op.id))];
        this.incrementalIndexUpdate(affectedIds);
        this.emitChange("update", affectedIds);
      }
      callback(ops as Operation<StoredRecord>[]);
    }, intervalMs);
  }

  /** Stop watching for new operations. */
  unwatch(): void {
    this.store.unwatch();
  }

  // --- TTL cleanup ---

  /**
   * Delete expired records from the store.
   * Expired records are already hidden from queries, but this frees storage.
   */
  async cleanup(): Promise<number> {
    const expired: { id: string; record: StoredRecord }[] = [];
    for (const [id, value] of this.store.entries()) {
      if (isExpired(value)) expired.push({ id, record: value });
    }
    if (expired.length === 0) return 0;

    await this.store.batch(() => {
      for (const { id } of expired) {
        this.store.delete(id);
      }
    });
    for (const { id, record } of expired) {
      if (this.textIdx) this.textIdx.remove(id);
      this.updateBTreeIndexes(id, record, undefined);
    }
    const ids = expired.map((e) => e.id);
    this.emitChange("delete", ids);
    return expired.length;
  }

  // --- Archive ---

  /**
   * Archive records matching a filter to cold storage.
   * Archived records are removed from the active set.
   */
  async archive(filter: Filter, segment?: string): Promise<number> {
    // Validate segment name to prevent path traversal
    if (segment && (!/^[a-zA-Z0-9_-]+$/.test(segment) || segment.includes(".."))) {
      throw new Error(`Invalid archive segment name '${segment}'. Must be alphanumeric with hyphens/underscores.`);
    }
    const predicate = this.resolve(filter);
    // Capture affected IDs before archiving for incremental re-index
    const affectedIds: string[] = [];
    for (const [id, value] of this.store.entries()) {
      if (predicate(value)) affectedIds.push(id);
    }
    const count = await this.store.archive(
      (value) => predicate(value),
      segment,
    );
    if (count > 0) {
      this.incrementalIndexUpdate(affectedIds);
      this.emitChange("delete", affectedIds);
    }
    return count;
  }

  /**
   * Load archived records from a segment. Returns them as an array (read-only, not re-inserted).
   */
  async loadArchive(segment: string): Promise<Record<string, unknown>[]> {
    if (!/^[a-zA-Z0-9_-]+$/.test(segment) || segment.includes("..")) {
      throw new Error(`Invalid archive segment name '${segment}'.`);
    }
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
  async search(query: string, opts?: { limit?: number; offset?: number; summary?: boolean }): Promise<FindResult> {
    if (!this.textIdx) {
      throw new Error("Full-text search not enabled. Set textSearch: true in collection options.");
    }
    const matchIds = this.textIdx.search(query);
    const allAccessor = this.allCleanRecords();
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;
    const useSummary = opts?.summary ?? false;

    const records: Record<string, unknown>[] = [];
    let skipped = 0;
    let total = 0;
    for (const id of matchIds) {
      let record: StoredRecord | undefined;
      if (this._diskStore) {
        record = await this._diskStore.get(id) as StoredRecord | undefined;
      } else {
        record = this.store.get(id);
      }
      if (record && !isExpired(record)) {
        total++;
        if (skipped < offset) { skipped++; continue; }
        if (records.length < limit) {
          let clean = stripMeta(record);
          clean = this.applyComputed(clean, allAccessor);
          records.push(useSummary ? summarize(clean) : clean);
        }
      }
    }

    return {
      records,
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
  async queryView(name: string, overrides?: Omit<FindOpts, "filter">): Promise<FindResult> {
    const def = this.views.get(name);
    if (!def) throw new Error(`View '${name}' not found`);

    // Check cache
    const cached = this.views.getCached(name);
    if (cached && !overrides) return cached;

    // Execute query
    const result = await this.find({ filter: def.filter, ...def.opts, ...overrides });
    if (!overrides) this.views.setCache(name, result);
    return result;
  }

  // --- Semantic search ---

  // --- Indexes ---

  // --- Index public API (delegates to IndexManager) ---

  createIndex(field: string): void { this.indexes.createIndex(field, this.store.entries()); }
  dropIndex(field: string): boolean { return this.indexes.dropIndex(field); }
  listIndexes(): string[] { return this.indexes.listIndexes(); }
  createCompositeIndex(fields: string[]): void { this.indexes.createCompositeIndex(fields, this.store.entries()); }
  dropCompositeIndex(fields: string[]): boolean { return this.indexes.dropCompositeIndex(fields); }
  listCompositeIndexes(): string[][] { return this.indexes.listCompositeIndexes(); }
  createArrayIndex(field: string): void { this.indexes.createArrayIndex(field, this.store.entries()); }
  dropArrayIndex(field: string): boolean { return this.indexes.dropArrayIndex(field); }
  listArrayIndexes(): string[] { return this.indexes.listArrayIndexes(); }
  createBloomFilter(field: string, expectedItems = 10000): void { this.indexes.createBloomFilter(field, this.store.entries(), expectedItems); }
  mightHave(field: string, value: string): boolean { return this.indexes.mightHave(field, value); }
  suggestIndexes(threshold = 100): Array<{ field: string; count: number }> { return this.indexes.suggestIndexes(threshold); }

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

  // --- Explicit Vector API ---

  /**
   * Store a pre-computed vector for a record. No embedding provider required.
   * Creates/updates the record and indexes the vector in HNSW.
   */
  async insertVector(id: string, vector: number[], metadata?: Record<string, unknown>): Promise<void> {
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new Error("Vector must be a non-empty number array");
    }
    // Initialize HNSW if needed, or reinitialize if dimensions were unknown (0)
    if (!this.hnswIdx || this.hnswIdx.dims === 0) {
      this.hnswIdx = new HnswIndex({ dimensions: vector.length });
    }
    // Validate dimensions
    if (vector.length !== this.hnswIdx.dims) {
      throw new Error(`Vector dimension mismatch: collection expects ${this.hnswIdx.dims}, got ${vector.length}`);
    }
    // Build stored record
    const stored: StoredRecord = { _id: id, ...metadata };
    const q = quantize(vector);
    stored[META_EMBEDDING] = serializeQuantized(q);
    this.stampVersion(stored, id);
    const oldRecord = this.store.get(id);
    await this.store.set(id, stored);
    this.updateBTreeIndexes(id, oldRecord, stored);
    if (this.textIdx) this.textIdx.add(id, stripMeta(stored));
    // Update HNSW (remove old if exists, add new)
    if (this.hnswIdx.size > 0) {
      try { this.hnswIdx.remove(id); } catch { /* not in index yet */ }
    }
    this.hnswIdx.add(id, vector);
    this.emitChange("upsert", [id]);
  }

  /**
   * Search the HNSW index by a raw vector. No embedding provider required.
   * Returns records sorted by similarity with scores.
   */
  searchByVector(
    vector: number[],
    opts?: { filter?: Filter; limit?: number; summary?: boolean },
  ): { records: Record<string, unknown>[]; scores: number[] } {
    if (!this.hnswIdx) {
      throw new Error("Vector search not available. Call insertVector first or configure an embedding provider.");
    }
    if (vector.length !== this.hnswIdx.dims) {
      throw new Error(`Vector dimension mismatch: index has ${this.hnswIdx.dims} dimensions, query has ${vector.length}`);
    }
    const limit = opts?.limit ?? 10;
    const candidates = this.hnswIdx.search(vector, limit * 3);
    const predicate = opts?.filter ? this.resolve(opts.filter) : () => true;
    const allAccessor = this.opts.computed ? this.allCleanRecords() : () => [];

    const records: Record<string, unknown>[] = [];
    const scores: number[] = [];
    for (const { id, score } of candidates) {
      if (records.length >= limit) break;
      const record = this.store.get(id);
      if (!record || isExpired(record)) continue;
      const clean = stripMeta(record);
      if (!predicate(clean)) continue;
      const withComputed = this.opts.computed ? this.applyComputed(clean, allAccessor) : clean;
      records.push(opts?.summary ? summarize(withComputed) : withComputed);
      scores.push(score);
    }

    return { records, scores };
  }

  // --- Blob storage ---

  private static readonly BLOB_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

  private blobPath(recordId: string, name?: string): string {
    if (recordId.includes("..") || recordId.includes("/") || recordId.includes("\\")) {
      throw new Error(`Invalid record ID for blob operation: '${recordId}'`);
    }
    if (name !== undefined && (!Collection.BLOB_NAME_RE.test(name) || name.includes(".."))) {
      throw new Error(`Invalid blob name '${name}'`);
    }
    return name ? `${this.blobPrefix}/${recordId}/${name}` : `${this.blobPrefix}/${recordId}`;
  }

  /** Store a blob (text or binary) associated with a record. Backed by StorageBackend. */
  async writeBlob(recordId: string, name: string, content: Buffer | string): Promise<void> {
    const path = this.blobPath(recordId, name); // validates recordId + name
    const record = this.store.get(recordId);
    if (!record) throw new Error(`Record '${recordId}' not found`);

    const buf = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
    await this.backend.writeBlob(path, buf);

    // Update _blobs metadata
    const blobs = (record._blobs as string[]) ?? [];
    if (!blobs.includes(name)) {
      await this.store.set(recordId, { ...record, _blobs: [...blobs, name] });
    }
  }

  /** Read a blob. Returns a Buffer. Backed by StorageBackend. */
  async readBlob(recordId: string, name: string): Promise<Buffer> {
    return this.backend.readBlob(this.blobPath(recordId, name));
  }

  /** List blob names for a record. Backed by StorageBackend. */
  async listBlobs(recordId: string): Promise<string[]> {
    return this.backend.listBlobs(this.blobPath(recordId));
  }

  /** Delete a blob. Backed by StorageBackend. */
  async deleteBlob(recordId: string, name: string): Promise<void> {
    await this.backend.deleteBlob(this.blobPath(recordId, name));
    const record = this.store.get(recordId);
    if (record && Array.isArray(record._blobs)) {
      const blobs = (record._blobs as string[]).filter((b) => b !== name);
      await this.store.set(recordId, { ...record, _blobs: blobs.length > 0 ? blobs : undefined });
    }
  }

  /** Delete all blobs for a record. Called on record deletion for cascade cleanup. */
  async deleteBlobsForRecord(recordId: string): Promise<void> {
    await this.backend.deleteBlobDir(this.blobPath(recordId));
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
    const all = this.store.all().filter((r) => !isExpired(r));
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
    // Fast path: use B-tree index if available (O(k) instead of O(n))
    const idx = this.indexes.getBTreeIndex(field);
    if (idx && !this._hasTTL) {
      const values = idx.allValues();
      return { field, values, count: values.length };
    }

    const seen = new Set<string>();
    const values: unknown[] = [];

    for (const [, record] of this.store.entries()) {
      if (isExpired(record)) continue;
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

