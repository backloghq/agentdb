import { randomUUID } from "node:crypto";
import { rm, mkdir, rename as fsRename, access } from "node:fs/promises";
import { join as pathJoin } from "node:path";
import { Store, FsBackend } from "@backloghq/opslog";
import type { Operation, StorageBackend } from "@backloghq/opslog";
import type { DiskStore } from "./disk-store.js";
import { getNestedValue } from "./filter.js";
// parseCompactFilter used by IndexManager (imported there directly)
import { TermLog } from "@backloghq/termlog";
import { rrf } from "./rrf.js";
import { ViewManager } from "./view.js";
import type { ViewDefinition } from "./view.js";
import { EventEmitter } from "node:events";
import { HnswIndex, type HnswOptions } from "./hnsw.js";
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
  makeFilterCache, FILTER_CACHE_MAX,
  type FilterCacheHandle,
} from "./collection-helpers.js";

// Re-export types and helpers that external consumers depend on
export type { StoredRecord, Filter, UpdateOps } from "./collection-helpers.js";
export type { ComputedFn, VirtualFilterFn, FilterCacheHandle } from "./collection-helpers.js";

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
  /** Cancellation signal. When aborted, returns a partial result with `aborted: true` and an empty or partial records array. Works in both memory and disk storage modes. */
  signal?: AbortSignal;
}

/** Result of a find query. */
export interface FindResult {
  records: Record<string, unknown>[];
  total: number;
  truncated: boolean;
  /** True when a find() was cut short by an AbortSignal rather than by a hard limit or token budget. */
  aborted?: boolean;
  /** Approximate token count of the returned records (4 chars/token heuristic). */
  estimatedTokens?: number;
}

/** Progress event emitted during long-running operations. */
export interface ProgressEvent {
  /** Records processed so far in the current phase. */
  completed: number;
  /** Total records in this phase, or `null` when total is not yet known (e.g. disk streaming). */
  total: number | null;
  /** Current operation phase. */
  phase: "wal" | "disk" | "indexing" | "importing" | "rebuilding";
}

/** Callback invoked periodically during long-running operations. */
export type ProgressCallback = (event: ProgressEvent) => void;

/** Structured result returned by {@link Collection.reembedAll}. */
export interface ReembedResult {
  /** Number of records successfully re-embedded. */
  embedded: number;
  /** Number of records whose embedding failed (provider rejected, etc.). */
  failed: number;
  /** Per-batch error details. Empty when `failed === 0`. */
  errors: Array<{ batchIndex: number; recordIds: string[]; reason: string }>;
  /** True when the operation was cancelled via AbortSignal before completing. */
  aborted?: boolean;
}

/** Live performance counters and index sizes for a collection. */
export interface CollectionMetrics {
  /** Number of compiled-filter cache misses (full compilations) since collection was opened. */
  filterCompilations: number;
  /** Number of compiled-filter cache hits since collection was opened. */
  filterCacheHits: number;
  /** Number of times a record was fetched from the disk LRU cache (hits + misses). null when not in disk mode. */
  recordCacheFetches: number | null;
  /** Number of disk LRU cache hits since collection was opened. null when not in disk mode. */
  recordCacheHits: number | null;
  /** Number of times find() returned a truncated result (maxFindLimit cap reached). */
  findTruncations: number;
  /** Number of BM25 segments in the text index. null when text search is not enabled. */
  bm25SegmentCount: number | null;
  /** Total indexed documents across all flushed BM25 segments. null when text search is not enabled. */
  bm25DocCount: number | null;
  /**
   * Whether the BM25 text index currently has more than one segment, meaning a merge pass
   * would reduce them. This reflects termlog's internal LSM compaction state — it is NOT
   * tied to `mergeParquetThreshold` or `mergeJsonlThreshold`. `true` = multiple segments
   * exist and compaction would help; `false` = fully merged (single segment); `null` = text
   * search not enabled for this collection.
   */
  bm25NeedsMerge: boolean | null;
  /** Number of nodes in the HNSW index. null when no embedding provider is configured. */
  hnswNodeCount: number | null;
  /** Number of records in the WAL (current session writes). */
  walRecordCount: number;
  /** Number of Parquet row groups from last compaction. null when not in disk mode or no compaction yet. */
  parquetRowGroups: number | null;
  /** Write mode this collection was opened with ("immediate", "group", or "async"). */
  writeMode: "immediate" | "group" | "async";
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
  /** Field names to restrict BM25/text indexing to. When empty, all string fields are indexed (fallback). */
  searchableFields?: string[];
  /** BM25 k1 saturation parameter (default: 1.2). */
  bm25K1?: number;
  /** BM25 b length normalization parameter (default: 0.75). */
  bm25B?: number;
  /** Max concurrent disk fetches in materializeCandidates for non-FS backends (default: 20). Has no effect on local FS. */
  diskConcurrency?: number;
  /** Number of records per embedding provider call in embedUnembedded (default: 256). */
  embeddingBatchSize?: number;
  /** LRU cache size for disk mode (max records, default: 1000). Overrides AgentDBOptions.cacheSize for this collection. */
  cacheSize?: number;
  /** Parquet row group size for disk mode (default: 5000). Overrides AgentDBOptions.rowGroupSize for this collection. */
  rowGroupSize?: number;
  /** Maximum records returned by find() (default: 10_000). A console.warn is emitted on truncation. Overrides AgentDBOptions.maxFindLimit for this collection. */
  maxFindLimit?: number;
  /** Max unique values a field may have before its disk B-tree index is skipped (default: 1000). A console.warn fires once per field when exceeded. Overrides AgentDBOptions.maxIndexCardinality for this collection. */
  maxIndexCardinality?: number;
  /** Per-collection compiled-filter LRU cache size (default: 64). Raise for collections with many distinct query shapes; lower for memory-constrained collections with few patterns. Overrides AgentDBOptions.filterCacheSize for this collection. */
  filterCacheSize?: number;
  /** Number of incremental Parquet files before triggering a full merge (default: 10). Overrides AgentDBOptions.mergeParquetThreshold for this collection. */
  mergeParquetThreshold?: number;
  /** Number of incremental JSONL delta files before triggering a full merge (default: 8). Overrides AgentDBOptions.mergeJsonlThreshold for this collection. */
  mergeJsonlThreshold?: number;
  /** HNSW index parameters for approximate nearest neighbor search. Overrides AgentDBOptions.hnsw for this collection. */
  hnsw?: { M?: number; efConstruction?: number; efSearch?: number; maxLevel?: number };
}

/** Change event emitted after mutations. */
export interface ChangeEvent {
  type: "insert" | "update" | "upsert" | "delete" | "undo";
  collection: string;
  ids: string[];
  agent?: string;
}

/**
 * Thrown when a v1.4 text-index.json blob is found on disk without a v2.0
 * termlog manifest. The collection cannot be opened until the index is rebuilt.
 *
 * Resolution: call `db.rebuildTextIndex(name)` then reopen, or use the
 * `db_rebuild_text_index` MCP tool.
 */
export class LegacyTextIndexError extends Error {
  readonly legacyPath: string;
  constructor(legacyPath: string) {
    super(
      `v1.4 text index detected at ${legacyPath}. v2.0 does not auto-migrate. ` +
      `To rebuild: call \`await db.rebuildTextIndex(name)\` or ` +
      `use the \`db_rebuild_text_index\` MCP tool, then reopen.`,
    );
    this.name = "LegacyTextIndexError";
    this.legacyPath = legacyPath;
  }
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
  private textIdx: TermLog | null = null;
  /** During an FS-mode rebuildTextIndex run, this is the new index being built.
   *  All live writes (insert/update/delete) shadow-write here so concurrent mutations
   *  are captured. Null when no rebuild is in progress. */
  private _rebuildingIdx: TermLog | null = null;
  /** True while any rebuildTextIndex call is in flight (guards against concurrent rebuilds). */
  private _rebuilding = false;
  /** AbortController for the in-flight FS-mode rebuild; null otherwise.
   *  close() uses this to interrupt a running rebuild before closing the store. */
  private _rebuildAbortCtrl: AbortController | null = null;
  /** Resolves when the current rebuild finishes (success or error). Used by close() to await
   *  teardown after signalling _rebuildAbortCtrl. */
  private _rebuildSettled: Promise<void> | null = null;
  private _dir = "";
  private views = new ViewManager();
  private hnswIdx: HnswIndex | null = null;
  private embeddingProvider: EmbeddingProvider | null = null;
  private backend: StorageBackend = new FsBackend();
  private blobPrefix = "";
  private emitter = new EventEmitter();
  private indexes = new IndexManager();
  private _hasTTL = false; // Tracks if any record has been inserted with TTL
  private _diskStore: DiskStore | null = null;
  // True once ensureIndexesLoaded has run and the WAL store has been replayed into textIdx.
  // Prevents ensureIndexesLoaded from overwriting current-session inserts.
  private _textIdxLoaded = false;
  // Optional termlog StorageBackend — set to S3Backend when running in S3 mode.
  private _termlogBackend: import("@backloghq/termlog").StorageBackend | undefined = undefined;
  // Per-collection compiled-filter LRU cache — initialised in constructor.
  private _filterCache!: FilterCacheHandle;
  // findTruncations counter — incremented each time find() hits the maxFindLimit cap.
  private _findTruncations = 0;
  // Write mode captured from open() options for metrics() reporting.
  private _writeMode: "immediate" | "group" | "async" = "immediate";

  /** Set disk store for disk-backed mode. Called by AgentDB during open. */
  setDiskStore(ds: DiskStore): void { this._diskStore = ds; }

  /** Set an alternative termlog StorageBackend (e.g. S3Backend from @backloghq/termlog-s3). Called by AgentDB before open() when running in S3 mode. */
  setTermlogBackend(backend: import("@backloghq/termlog").StorageBackend): void { this._termlogBackend = backend; }

  /**
   * Ensure disk indexes are loaded, then replay any current-session WAL entries into
   * the text index. This handles the case where the user inserted records before the
   * first search call triggers lazy index loading — without replay, loadFromJSON would
   * overwrite those in-memory inserts.
   */
  private async ensureDiskIndexesLoaded(): Promise<void> {
    if (!this._diskStore) return;
    if (this._textIdxLoaded) return;
    await this._diskStore.ensureIndexesLoaded();
    // Replay in-memory (WAL) entries into text index — these may predate this load call
    for (const [id, record] of this.store.entries()) {
      if (!isExpired(record)) {
        const clean = stripMeta(record);
        await this.textIndexAdd(id, extractTextFromRecord(this.textRecord(clean)));
      }
    }
    this._textIdxLoaded = true;
  }

  /** Rebuild the HNSW index from all embeddings stored in the disk store. Called by AgentDB after setDiskStore when an embedding provider is configured. */
  async rebuildHnswFromDisk(): Promise<void> {
    if (!this._diskStore || !this.hnswIdx) return;
    for await (const [id, record] of this._diskStore.entries({ skipCache: true })) {
      if (isExpired(record as StoredRecord)) continue;
      const stored = (record as StoredRecord)[META_EMBEDDING] as { data: number[]; scale: number } | undefined;
      if (!stored) continue;
      const q = deserializeQuantized(stored);
      const vec = Array.from(q.data).map((v) => v / q.scale);
      if (this.hnswIdx.dims === 0) {
        this.hnswIdx = new HnswIndex(this.hnswOpts(vec.length));
      }
      this.hnswIdx.add(id, vec);
    }
  }

  /** Get disk store (if in disk mode). */
  getDiskStore(): DiskStore | null { return this._diskStore; }

  /** Get the index manager (for persistence). */
  getIndexManager(): IndexManager { return this.indexes; }

  /** Get the text index (TermLog handle). */
  getTextIndex(): TermLog | null { return this.textIdx; }

  /** Get the HNSW index (if an embedding provider is configured). */
  getHnswIndex(): HnswIndex | null { return this.hnswIdx; }

  /** Field names restricted to BM25/text indexing. Empty means all-strings fallback. */
  searchableFields(): string[] { return this.opts.searchableFields ?? []; }

  /** Get the storage backend (for DiskStore I/O). */
  getBackend(): import("@backloghq/opslog").StorageBackend { return this.backend; }

  /** Get the opslog store (for accessing session writes in disk mode). */
  getStore(): Store<StoredRecord> { return this.store; }

  /** Configured filter cache size for this collection (default: 64). */
  get filterCacheSize(): number { return this.opts.filterCacheSize ?? FILTER_CACHE_MAX; }

  /**
   * Return live performance counters and index sizes for this collection.
   * Counters reset when the collection is closed and reopened.
   */
  metrics(): CollectionMetrics {
    const cacheStats = this._diskStore?.getCacheStats() ?? null;
    const segCount = this.textIdx?.segmentCount() ?? null;
    return {
      filterCompilations: this._filterCache.compilations(),
      filterCacheHits: this._filterCache.hits(),
      recordCacheFetches: cacheStats !== null ? cacheStats.hits + cacheStats.misses : null,
      recordCacheHits: cacheStats !== null ? cacheStats.hits : null,
      findTruncations: this._findTruncations,
      bm25SegmentCount: segCount,
      bm25DocCount: this.textIdx?.docCount() ?? null,
      bm25NeedsMerge: segCount !== null ? segCount > 1 : null,
      hnswNodeCount: this.hnswIdx?.size ?? null,
      walRecordCount: this.store.count(),
      parquetRowGroups: this._diskStore?.parquetRowGroups ?? null,
      writeMode: this._writeMode,
    };
  }

  constructor(name: string, store: Store<StoredRecord>, opts?: CollectionOptions) {
    this.name = name;
    this.store = store;
    this.opts = opts ?? {};
    this._filterCache = makeFilterCache(opts?.filterCacheSize ?? FILTER_CACHE_MAX);
    // TermLog is opened in open() once the directory is known; textIdx stays null until then.
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

  /** Project a clean record to only searchable fields, or all non-meta fields when fallback is active. */
  private textRecord(record: Record<string, unknown>): Record<string, unknown> {
    const fields = this.opts.searchableFields;
    if (!fields || fields.length === 0) {
      // Fallback: index all fields except _id and _version to avoid UUIDs and counters in BM25
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(record)) {
        if (key !== "_id" && key !== "_version") result[key] = record[key];
      }
      return result;
    }
    const projected: Record<string, unknown> = {};
    for (const f of fields) {
      if (f in record) projected[f] = record[f];
    }
    return projected;
  }

  /** Rebuild the full text index from current store contents. */
  /**
   * Rebuild the TermLog text index from scratch using current store records.
   *
   * Use this to resolve a `LegacyTextIndexError`: the collection cannot be opened
   * normally when a v1.4 text-index.json blob is present. Instantiate Collection
   * without `textSearch: true`, call `rebuildTextIndex()`, then reopen with `textSearch: true`.
   *
   * Also deletes any legacy `indexes/text-index.json` blob left over from v1.4 so
   * subsequent opens do not re-throw `LegacyTextIndexError`.
   *
   * @returns The number of documents indexed during the rebuild.
   */
  async rebuildTextIndex(opts?: { onProgress?: ProgressCallback; signal?: AbortSignal }): Promise<number> {
    if (!this._dir) return 0;
    // B: single-flight guard — concurrent callers get a clear error rather than racing into
    // the same temp directory and rename sequence.
    if (this._rebuilding) throw new Error("agentdb: rebuildTextIndex already in progress");
    this._rebuilding = true;

    const onProgress = opts?.onProgress;
    const signal = opts?.signal;
    const textDir = pathJoin(this._dir, "text");

    if (this._termlogBackend) {
      // S3 mode: no atomic rename is possible for blob stores. Use the original
      // destructive approach (wipe then rebuild). An abort here leaves textIdx=null
      // and the S3 prefix empty — the caller must retry rebuildTextIndex to restore search.
      try {
        if (this.textIdx) await this.textIdx.close();
        const blobs = await this._termlogBackend.listBlobs("").catch(() => [] as string[]);
        const CONCURRENCY = 16;
        for (let i = 0; i < blobs.length; i += CONCURRENCY) {
          const batch = blobs.slice(i, i + CONCURRENCY);
          await Promise.all(batch.map((b) => this._termlogBackend!.deleteBlob(b).catch(() => {})));
        }
        this.textIdx = await TermLog.open({
          dir: textDir,
          backend: this._termlogBackend,
          k1: this.opts.bm25K1 ?? 1.2,
          b: this.opts.bm25B ?? 0.75,
        });
        let count = 0;
        const records = this._diskStore
          ? await (async () => {
              const out: Array<[string, StoredRecord]> = [];
              for await (const [id, record] of this._diskStore!.entries()) {
                out.push([id, record as StoredRecord]);
              }
              return out;
            })()
          : Array.from(this.store.entries());
        const total = records.length;
        for (const [id, record] of records) {
          if (signal?.aborted) {
            await this.textIdx.close();
            this.textIdx = null;
            console.warn(
              `agentdb [${this.name}]: rebuildTextIndex aborted in S3 mode — ` +
              `text index wiped, indexed ${count}/${total}. Call rebuildTextIndex() again to restore search.`,
            );
            throw new DOMException("The operation was aborted.", "AbortError");
          }
          if (!isExpired(record)) {
            await this.textIdx.add(id, extractTextFromRecord(this.textRecord(stripMeta(record))));
            count++;
            try { onProgress?.({ completed: count, total, phase: "rebuilding" }); } catch (e) { console.error("agentdb: onProgress callback threw:", e); }
          }
        }
        await this.textIdx.flush();
        await this.backend.deleteBlob("indexes/text-index.json").catch(() => {});
        return count;
      } finally {
        this._rebuilding = false;
      }
    }

    // FS mode: snapshot-then-swap.
    // Build the new index into text.new/ while the existing text/ (and this.textIdx) remain
    // untouched and queryable. On abort, discard text.new/ and leave the original intact.
    // On success: rename text/→text.old/ → rename text.new/→text/ → rm text.old/ (atomic).
    const textNewDir = pathJoin(this._dir, "text.new");
    await rm(textNewDir, { recursive: true, force: true }); // clean up any previous stale temp dir
    await mkdir(textNewDir, { recursive: true });
    const newIdx = await TermLog.open({
      dir: textNewDir,
      k1: this.opts.bm25K1 ?? 1.2,
      b: this.opts.bm25B ?? 0.75,
    });

    // C: close() interlock — create an AbortController for this rebuild so close() can
    // interrupt it. Also create a promise that resolves when the rebuild finishes so
    // close() can await teardown before proceeding.
    const rebuildCtrl = new AbortController();
    this._rebuildAbortCtrl = rebuildCtrl;
    let settleRebuild!: () => void;
    this._rebuildSettled = new Promise<void>((res) => { settleRebuild = res; });

    // Shadow-write: all live writes (insert/update/delete) that arrive during the rebuild
    // window will call textIndexAdd/textIndexRemove, which forward to _rebuildingIdx as well.
    // This ensures concurrent mutations land in the new index before the swap.
    this._rebuildingIdx = newIdx;

    let count = 0;
    try {
      const records = this._diskStore
        ? await (async () => {
            const out: Array<[string, StoredRecord]> = [];
            for await (const [id, record] of this._diskStore!.entries()) {
              out.push([id, record as StoredRecord]);
            }
            return out;
          })()
        : Array.from(this.store.entries());
      const total = records.length;

      for (const [id, record] of records) {
        // Check both caller signal and the internal close() abort signal.
        if (signal?.aborted || rebuildCtrl.signal.aborted) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        if (!isExpired(record)) {
          await newIdx.add(id, extractTextFromRecord(this.textRecord(stripMeta(record))));
          count++;
          try { onProgress?.({ completed: count, total, phase: "rebuilding" }); } catch (e) { console.error("agentdb: onProgress callback threw:", e); }
        }
      }

      // Post-loop delta reconciliation (in-memory mode only):
      // opslog's _set() updates the in-memory Map synchronously inside its serialize chain,
      // before the WAL write resolves. So a concurrent insert's record IS in this.store.entries()
      // after the first yield point following the store.set() call — even if col.insert() is
      // still awaiting the WAL flush. We scan for IDs not in the original snapshot and replay
      // them into newIdx. Shadow-write (_rebuildingIdx) covers cases where textIndexAdd ran
      // during the loop; this delta scan covers the complement.
      if (!this._diskStore) {
        const snapshotIds = new Set(records.map(([id]) => id));
        for (const [id, record] of this.store.entries()) {
          if (!snapshotIds.has(id) && !isExpired(record)) {
            await newIdx.add(id, extractTextFromRecord(this.textRecord(stripMeta(record))));
            count++;
          }
        }
        for (const [id] of records) {
          if (!this.store.get(id)) {
            // Record deleted during rebuild — remove from new index
            await newIdx.remove(id);
          }
        }
      }

      // Clear shadow before flush+swap. Any writes from this point route to textIdx (old) only
      // until the swap completes — the window is negligible (close + rename + reopen).
      this._rebuildingIdx = null;
      await newIdx.flush();

      // Atomic swap: rename text/→text.old/ → rename text.new/→text/ → rm text.old/.
      // text/ is absent for at most one rename syscall (vs the previous rm-then-rename which
      // left it absent across two separate calls). On rollback, text.old/ is renamed back to
      // text/ so the collection remains queryable. Stale text.old/ from a previous crashed
      // swap is removed before step 1; open() also does crash-recovery on next startup.
      // Step 1 is skipped when text/ does not exist (first-time build or text search disabled).
      if (this.textIdx) await this.textIdx.close();
      this.textIdx = null;
      await newIdx.close();
      const textOldDir = pathJoin(this._dir, "text.old");
      const hadExistingIndex = await access(textDir).then(() => true, () => false);
      if (hadExistingIndex) {
        await rm(textOldDir, { recursive: true, force: true }); // remove any stale backup
        await fsRename(textDir, textOldDir);                    // step 1: backup old
      }
      try {
        await fsRename(textNewDir, textDir);                    // step 2: promote new
      } catch (swapErr) {
        // Rollback: restore old index on disk so the collection remains queryable.
        if (hadExistingIndex) await fsRename(textOldDir, textDir).catch(() => {});
        await rm(textNewDir, { recursive: true, force: true }).catch(() => {});
        // Re-open textIdx from the restored directory so bm25Search works again.
        // Without this, this.textIdx would remain null after the throw and every
        // subsequent bm25Search call would fail with "BM25 search not enabled".
        if (hadExistingIndex) {
          this.textIdx = await TermLog.open({
            dir: textDir,
            k1: this.opts.bm25K1 ?? 1.2,
            b: this.opts.bm25B ?? 0.75,
          }).catch((reopenErr: unknown) => {
            console.error(
              `agentdb [${this.name}]: rollback reopen failed after rebuildTextIndex swap error — ` +
              `text index unavailable until next rebuild: ${(reopenErr as Error).message}`,
            );
            return null;
          });
        }
        throw swapErr;
      }
      if (hadExistingIndex) {
        await rm(textOldDir, { recursive: true, force: true }); // step 3: drop backup
      }
      this.textIdx = await TermLog.open({
        dir: textDir,
        k1: this.opts.bm25K1 ?? 1.2,
        b: this.opts.bm25B ?? 0.75,
      });

      // Delete any legacy v1.4 blob so subsequent opens don't re-throw LegacyTextIndexError.
      await this.backend.deleteBlob("indexes/text-index.json").catch(() => {});
      return count;

    } finally {
      // A: always clear _rebuildingIdx — guards against dangling shadow-writes if newIdx.add()
      // or any later step threw an unexpected exception mid-rebuild.
      this._rebuildingIdx = null;
      this._rebuilding = false;
      this._rebuildAbortCtrl = null;
      this._rebuildSettled = null;
      settleRebuild(); // unblock any close() waiting for the rebuild to finish
      // Clean up temp state. rm is a no-op if textNewDir was already renamed (success path).
      // newIdx.close() is a no-op / suppressed if already closed in the success path.
      await newIdx.close().catch(() => {});
      await rm(textNewDir, { recursive: true, force: true }).catch(() => {});
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
  private async incrementalIndexUpdate(affectedIds: string[]): Promise<void> {
    const cleanRecords = this.indexes.incrementalUpdate(affectedIds, (id) => this.store.get(id));
    for (const [id, clean] of cleanRecords) {
      if (clean) await this.textIndexAdd(id, extractTextFromRecord(this.textRecord(clean)));
      else await this.textIndexRemove(id);
    }
  }

  /**
   * Write text for `id` to the active text index (and the rebuild shadow index when a rebuild
   * is in progress). All live-write paths must call this rather than `this.textIdx.add` directly
   * so concurrent inserts/updates are captured in the new index during a rebuildTextIndex run.
   */
  private async textIndexAdd(id: string, text: string): Promise<void> {
    if (this.textIdx) await this.textIdx.add(id, text);
    if (this._rebuildingIdx) await this._rebuildingIdx.add(id, text);
  }

  /**
   * Remove `id` from the active text index (and the rebuild shadow index when a rebuild is in
   * progress). See `textIndexAdd` for rationale.
   */
  private async textIndexRemove(id: string): Promise<void> {
    if (this.textIdx) await this.textIdx.remove(id);
    if (this._rebuildingIdx) await this._rebuildingIdx.remove(id);
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

  /** Build HnswOptions from collection-level hnsw config + the given dimensions. */
  private hnswOpts(dimensions: number): HnswOptions {
    return { dimensions, ...this.opts.hnsw };
  }

  /** Resolve a filter with virtual filter support. */
  private resolve(filter: Filter): (record: Record<string, unknown>) => boolean {
    return resolveFilter(filter, this.opts.virtualFilters, this.recordGetter(), this.opts.tagField, this._filterCache.compile);
  }

  /** Whether the underlying store is open. */
  get opened(): boolean {
    return this._opened;
  }

  /** Set the embedding provider for semantic search. Called by AgentDB. */
  setEmbeddingProvider(provider: EmbeddingProvider): void {
    this.embeddingProvider = provider;
    this.hnswIdx = new HnswIndex(this.hnswOpts(provider.dimensions));
  }

  /** Lazily initialize HNSW to the real vector size on the first embed call.
   * Needed when the provider has dimensions=0 at construction (e.g. Ollama auto-detect). */
  private ensureHnswDims(vec: number[]): void {
    if (this.hnswIdx && this.hnswIdx.dims === 0) {
      this.hnswIdx = new HnswIndex(this.hnswOpts(vec.length));
    }
  }

  /** Open the underlying opslog store at the given directory. */
  async open(dir: string, options?: { checkpointThreshold?: number; checkpointOnClose?: boolean; backend?: StorageBackend; agentId?: string; writeMode?: "immediate" | "group" | "async"; groupCommitSize?: number; groupCommitMs?: number; readOnly?: boolean; skipLoad?: boolean }): Promise<void> {
    await this.store.open(dir, options);
    this._opened = true;
    this._dir = dir;
    if (options?.writeMode) this._writeMode = options.writeMode;
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

    // Detect v1.4 legacy text-index.json blob. Only relevant for local-FS mode:
    // v1.4 never wrote text-index.json to S3 (the old TextIndex was local-FS-only).
    // In S3 mode (_termlogBackend set), skip this check entirely.
    if (this.opts.textSearch && !this._termlogBackend) {
      const legacyBlobPath = "indexes/text-index.json";
      const termlogManifestBlobPath = "text/manifest.json";

      let hasLegacyBlob = false;
      let hasTermlogManifest = false;

      try {
        const files = await this.backend.listBlobs("indexes");
        hasLegacyBlob = files.includes("text-index.json");
      } catch { /* indexes dir doesn't exist — fresh collection */ }

      try {
        await this.backend.readBlob(termlogManifestBlobPath);
        hasTermlogManifest = true;
      } catch { /* no termlog manifest yet */ }

      if (hasLegacyBlob && !hasTermlogManifest) {
        await this.store.close();
        this._opened = false;
        throw new LegacyTextIndexError(pathJoin(dir, legacyBlobPath));
      }
      if (hasLegacyBlob && hasTermlogManifest) {
        // Termlog index already built — clean up the orphaned legacy blob
        await this.backend.deleteBlob(legacyBlobPath).catch(() => {});
      }
    }

    // Open TermLog for text search (if enabled) before WAL replay so adds land in the index.
    // termlogAlreadyIndexed: true when TermLog reopened from existing segments.
    // In that case skip the WAL-replay add() loop — segments already have all data.
    // Re-adding every record doubles totalDocs/totalLen in the BM25 scoring state,
    // shifting IDF and breaking score determinism across close/reopen.
    let termlogAlreadyIndexed = false;
    if (this.opts.textSearch) {
      const textDir = pathJoin(dir, "text");
      if (!this._termlogBackend) {
        // Crash recovery for an interrupted atomic swap in rebuildTextIndex:
        //   After step 1 (rename text/→text.old/), before step 2 (rename text.new/→text/):
        //     text.old/ exists, text/ absent → restore text.old/→text/.
        //   After step 2, before step 3 (rm text.old/):
        //     text.old/ exists, text/ present → delete stale backup.
        const textOldDir = pathJoin(dir, "text.old");
        const oldExists = await access(textOldDir).then(() => true, () => false);
        if (oldExists) {
          const canonExists = await access(textDir).then(() => true, () => false);
          if (canonExists) {
            await rm(textOldDir, { recursive: true, force: true });
          } else {
            await fsRename(textOldDir, textDir);
          }
        }
        await mkdir(textDir, { recursive: true });
      }
      this.textIdx = await TermLog.open({
        dir: textDir,
        backend: this._termlogBackend,
        k1: this.opts.bm25K1 ?? 1.2,
        b: this.opts.bm25B ?? 0.75,
      });
      termlogAlreadyIndexed = this.textIdx.docCount() > 0;
    }

    // Single pass: detect TTL, build text index, load HNSW embeddings
    for (const [id, record] of this.store.entries()) {
      if (record[META_EXPIRES]) this._hasTTL = true;
      if (!termlogAlreadyIndexed && !isExpired(record)) {
        await this.textIndexAdd(id, extractTextFromRecord(this.textRecord(stripMeta(record))));
      }
      if (!isExpired(record)) {
        const stored = record[META_EMBEDDING] as { data: number[]; scale: number } | undefined;
        if (stored) {
          const q = deserializeQuantized(stored);
          const vec = Array.from(q.data).map((v) => v / q.scale);
          if (!this.hnswIdx || this.hnswIdx.dims === 0) {
            this.hnswIdx = new HnswIndex(this.hnswOpts(vec.length));
          }
          this.hnswIdx.add(id, vec);
        }
      }
    }
    if (this.textIdx) await this.textIdx.flush();
  }

  /** Close the underlying store. Idempotent — calling twice is a no-op. */
  async close(): Promise<void> {
    if (!this._opened) return;
    // C: interlock with an in-flight FS-mode rebuild. Capture the settled promise BEFORE
    // aborting (the finally block clears _rebuildSettled before resolving it, so we must
    // hold a local reference). Abort causes the rebuild loop to throw AbortError; the
    // finally block resolves settleRebuild, unblocking the await below.
    const waitForRebuild = this._rebuildSettled;
    if (this._rebuildAbortCtrl) this._rebuildAbortCtrl.abort();
    if (waitForRebuild) await waitForRebuild;

    if (this.textIdx) {
      await this.textIdx.close();
      this.textIdx = null;
    }
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
    await this.textIndexAdd(id, extractTextFromRecord(this.textRecord(stripMeta(stored))));
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
    for (const { id, stored } of prepared) {
      await this.textIndexAdd(id, extractTextFromRecord(this.textRecord(stripMeta(stored))));
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

  /** @internal Return all non-expired records preserving internal meta fields (e.g. _embedding). Intended for compaction only — do not call from user-facing code. */
  async findAllForCompaction(): Promise<[string, StoredRecord][]> {
    if (this._diskStore?.hasParquetData) {
      const seen = new Set<string>();
      const result: [string, StoredRecord][] = [];
      for (const [id, record] of this.store.entries()) {
        if (!isExpired(record)) { result.push([id, record]); seen.add(id); }
      }
      // Do NOT use skipCache:true here — LRU cache may have updated embeddings that haven't been
      // flushed to JSONL yet (written via cacheWrite in embedUnembedded for disk-origin records)
      for await (const [id, record] of this._diskStore.entries()) {
        if (!seen.has(id) && !isExpired(record as StoredRecord)) result.push([id, record as StoredRecord]);
      }
      return result;
    }
    const result: [string, StoredRecord][] = [];
    for (const [id, record] of this.store.entries()) {
      if (!isExpired(record)) result.push([id, record]);
    }
    return result;
  }

  /** Streaming record iterator — O(1) memory regardless of collection size.
   * In disk mode, yields records from Parquet one-at-a-time without accumulation.
   * In memory mode, yields from the in-memory store (already in memory).
   * Safe to use for reservoir sampling on large disk-backed collections.
   */
  async *iterate(): AsyncGenerator<Record<string, unknown>> {
    if (this._diskStore?.hasParquetData) {
      const seen = new Set<string>();
      for (const [id, record] of this.store.entries()) {
        if (!isExpired(record)) { yield stripMeta(record); seen.add(id); }
      }
      for await (const [id, record] of this._diskStore.entries()) {
        if (!seen.has(id) && !isExpired(record as StoredRecord)) yield stripMeta(record as StoredRecord);
      }
    } else {
      for (const [, record] of this.store.entries()) {
        if (!isExpired(record)) yield stripMeta(record);
      }
    }
  }

  async find(opts?: FindOpts): Promise<FindResult> {
    const MAX_LIMIT = this.opts.maxFindLimit ?? 10_000;
    const requestedLimit = opts?.limit ?? 50;
    const limit = Math.min(requestedLimit, MAX_LIMIT);
    const offset = opts?.offset ?? 0;
    const useSummary = opts?.summary ?? false;
    const maxTokens = opts?.maxTokens;
    const signal = opts?.signal;

    // Pre-abort: signal was already cancelled before find() was called — skip all work.
    if (signal?.aborted) {
      return { records: [], total: 0, truncated: false, aborted: true };
    }

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
      await this.textIdx.flush();
      const hits = await this.textIdx.search(textQuery, { mode: "and" });
      textMatchIds = new Set(hits.map((h) => h.docId));
    }

    // Lazy-load persisted indexes on first query (deferred from open for fast cold start)
    if (this._diskStore) await this._diskStore.ensureIndexesLoaded();

    const candidateIds = this.indexedCandidates(attrFilter);
    let records: StoredRecord[];
    let abortedEarly = false;

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

      // Second: records from JSONL/Parquet (not already in Map)
      // Fetch in batches to short-circuit at limit (avoid fetching 30K records when limit=10)
      const needed = offset + limit;
      const candidateSource = textMatchIds
        ? [...textMatchIds].filter((id) => !seen.has(id))
        : candidateIds
          ? [...candidateIds].filter((id) => !seen.has(id))
          : null;

      if (candidateSource) {
        const BATCH = Math.max(needed * 2, 50); // fetch 2x needed or at least 50
        for (let i = 0; i < candidateSource.length && records.length < needed; i += BATCH) {
          if (signal?.aborted) { abortedEarly = true; break; }
          const batch = candidateSource.slice(i, i + BATCH);
          const fetched = await this._diskStore.getMany(batch);
          for (const [, r] of fetched) {
            if (!isExpired(r as StoredRecord) && predicate(r as StoredRecord)) {
              records.push(r as StoredRecord);
              if (records.length >= needed) break;
            }
          }
        }
      } else {
        // Full scan from Parquet — loads all records. Consider creating an index for large collections.
        if (this._diskStore.recordCount > 10_000) {
          console.warn(`agentdb: full scan on disk-backed collection '${this.name}' (${this._diskStore.recordCount} records). Consider creating an index.`);
        }
        for await (const [id, record] of this._diskStore.entries()) {
          if (signal?.aborted) { abortedEarly = true; break; }
          if (seen.has(id)) continue;
          const r = record as StoredRecord;
          if (!isExpired(r) && predicate(r)) {
            records.push(r);
            if (records.length >= needed) break;
          }
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

    // In disk mode with short-circuit, records may be capped. Use index size as total when available.
    const total = (this._diskStore?.hasParquetData && candidateIds)
      ? candidateIds.size + this.store.count()
      : records.length;
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

    const truncated = total > offset + limit || tokenTruncated || abortedEarly;
    // Only count and warn for the maxFindLimit cap — not for token budget or abort truncations.
    const capCaused = (total > offset + limit) && requestedLimit > limit && !tokenTruncated && !abortedEarly;
    if (capCaused) {
      this._findTruncations++;
      console.warn(
        `agentdb [${this.name}]: find() truncated at maxFindLimit=${MAX_LIMIT} — set CollectionOptions.maxFindLimit to raise or lower this cap`,
      );
    }
    return {
      records: mapped,
      total,
      truncated,
      ...(abortedEarly ? { aborted: true } : {}),
      estimatedTokens: maxTokens ? tokenCount : undefined,
    };
  }

  /**
   * Count records matching a filter.
   */
  async count(filter?: Filter): Promise<number> {
    if (this._diskStore) await this._diskStore.ensureIndexesLoaded();
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
  /**
   * Hydrate a record from DiskStore into the opslog Map (for mutations in skipLoad mode).
   */
  private async hydrateFromDisk(id: string): Promise<void> {
    if (this.store.has(id) || !this._diskStore) return;
    const record = await this._diskStore.get(id);
    if (record) await this.store.set(id, record as StoredRecord);
  }

  /**
   * Batch-hydrate multiple records from DiskStore into the Map.
   * Filters to only IDs not already in Map, then does parallel JSONL reads.
   */
  private async hydrateManyFromDisk(ids: Iterable<string>): Promise<void> {
    if (!this._diskStore) return;
    const needed: string[] = [];
    for (const id of ids) {
      if (!this.store.has(id)) needed.push(id);
    }
    if (needed.length === 0) return;
    const records = await this._diskStore.getMany(needed);
    for (const [id, record] of records) {
      await this.store.set(id, record as StoredRecord);
    }
  }

  async update(filter: Filter, update: UpdateOps, opts?: MutationOpts): Promise<number> {
    // Fast path: { _id: value } → direct lookup instead of linear scan
    const directId = this.extractDirectId(filter);
    const matches: [string, StoredRecord][] = [];

    if (this._diskStore) await this._diskStore.ensureIndexesLoaded();

    if (directId) {
      // Hydrate from DiskStore if not in Map (skipLoad mode)
      await this.hydrateFromDisk(directId);
      const value = this.store.get(directId);
      if (value && !isExpired(value)) matches.push([directId, value]);
    } else {
      const candidateIds = this.indexedCandidates(filter);
      const predicate = this.resolve(filter);
      if (candidateIds) {
        await this.hydrateManyFromDisk(candidateIds);
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
    for (const { id, updated } of updates) {
      await this.textIndexAdd(id, extractTextFromRecord(this.textRecord(stripMeta(updated))));
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
    await this.textIndexRemove(id);
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
    await this.hydrateFromDisk(id);
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
    await this.textIndexAdd(id, extractTextFromRecord(this.textRecord(stripMeta(stored))));
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

    // Hydrate existing records from DiskStore for correct old/new deltas
    await this.hydrateManyFromDisk(docs.map((d) => d._id as string).filter(Boolean));

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
      await this.textIndexAdd(id, extractTextFromRecord(this.textRecord(stripMeta(stored))));
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

    if (this._diskStore) await this._diskStore.ensureIndexesLoaded();

    if (directId) {
      await this.hydrateFromDisk(directId);
      const value = this.store.get(directId);
      if (value && !isExpired(value)) toDelete.push(directId);
    } else {
      const candidateIds = this.indexedCandidates(filter);
      const predicate = this.resolve(filter);
      if (candidateIds) {
        await this.hydrateManyFromDisk(candidateIds);
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
    for (const id of toDelete) await this.textIndexRemove(id);
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
        await this.incrementalIndexUpdate([lastOp.id]);
      } else {
        await this.rebuildTextIndex();
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
    await this.rebuildTextIndex();
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
    await this.rebuildTextIndex();
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
      await this.incrementalIndexUpdate(affectedIds);
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
      await this.textIndexRemove(id);
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
    await this.ensureDiskIndexesLoaded();
    await this.textIdx.flush();
    const hits = await this.textIdx.search(query, { mode: "and" });
    const matchIds = new Set(hits.map((h) => h.docId));
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

  /**
   * Hydrate a scored candidate list into clean records.
   * Disk-mode aware: fetches from _diskStore in parallel, falls back to in-memory store.
   * Applies expiry, attribute filter, computed fields, and optional summary projection.
   */
  private async materializeCandidates(
    candidates: Array<{ id: string; score: number }>,
    opts: { limit: number; filter?: Filter; summary?: boolean },
  ): Promise<{ records: Record<string, unknown>[]; scores: number[] }> {
    const predicate = opts.filter ? this.resolve(opts.filter) : null;
    const allAccessor = this.allCleanRecords();

    let hydrated: Array<StoredRecord | undefined>;
    if (this._diskStore) {
      const ds = this._diskStore;
      // WAL fallback: records inserted in the current session live in this.store (not yet
      // compacted to disk). Disk-first preserves read-your-writes semantics for updated records.
      const walFallback = (id: string) => this.store.get(id);
      if (ds.isLocalFs()) {
        hydrated = await Promise.all(
          candidates.map(async (c) => ((await ds.get(c.id)) ?? walFallback(c.id)) as StoredRecord | undefined),
        );
      } else {
        const cap = this.opts.diskConcurrency ?? 20;
        hydrated = new Array(candidates.length);
        let next = 0;
        const workers = Array.from({ length: Math.min(cap, candidates.length) }, async () => {
          while (next < candidates.length) {
            const i = next++;
            (hydrated as Array<StoredRecord | undefined>)[i] = ((await ds.get(candidates[i].id)) ?? walFallback(candidates[i].id)) as StoredRecord | undefined;
          }
        });
        await Promise.all(workers);
      }
    } else {
      hydrated = candidates.map((c) => this.store.get(c.id));
    }

    const records: Record<string, unknown>[] = [];
    const scores: number[] = [];
    for (let i = 0; i < candidates.length; i++) {
      if (records.length >= opts.limit) break;
      const record = hydrated[i];
      if (!record || isExpired(record)) continue;
      const clean = stripMeta(record);
      if (predicate && !predicate(clean)) continue;
      const withComputed = this.applyComputed(clean, allAccessor);
      records.push(opts.summary ? summarize(withComputed) : withComputed);
      scores.push(candidates[i].score);
    }

    return { records, scores };
  }

  /**
   * BM25-ranked full-text search. Returns records sorted by BM25 score descending.
   *
   * Indexing is restricted to schema-declared `searchable` fields when the collection
   * was opened with a schema; falls back to all string fields otherwise.
   *
   * `candidateLimit` controls how many BM25 candidates are fetched before filter pruning.
   * When a `filter` is selective, the final result set may be smaller than `limit` — the
   * method does not retry beyond `candidateLimit`. Hybrid search callers should compensate.
   *
   * Requires textSearch: true in collection options.
   */
  async bm25Search(
    query: string,
    opts?: {
      limit?: number;
      filter?: Filter;
      summary?: boolean;
      candidateLimit?: number;
    },
  ): Promise<{ records: Record<string, unknown>[]; scores: number[] }> {
    if (!this.textIdx) {
      throw new Error("BM25 search not enabled. Set textSearch: true in collection options.");
    }
    await this.ensureDiskIndexesLoaded();

    if (!query || !query.trim()) return { records: [], scores: [] };

    const limit = opts?.limit ?? 10;
    const candidateLimit = opts?.candidateLimit ?? Math.max(limit * 4, 50);

    await this.textIdx.flush();
    const hits = await this.textIdx.search(query, { mode: "or", limit: candidateLimit });
    const candidates = hits.map((h) => ({ id: h.docId, score: h.score }));
    if (candidates.length === 0) return { records: [], scores: [] };

    return this.materializeCandidates(candidates, { limit, filter: opts?.filter, summary: opts?.summary });
  }

  /**
   * Hybrid search: fuses BM25 lexical and semantic vector results via RRF.
   *
   * Runs both arms in parallel and merges with Reciprocal Rank Fusion. Degrades
   * gracefully: if the embedding provider is not configured only BM25 is used;
   * if text search is not enabled only semantic is used. Throws when both are
   * unavailable.
   *
   * Returned scores are RRF scores (not raw BM25 or cosine values).
   */
  async hybridSearch(
    query: string,
    opts?: {
      limit?: number;
      filter?: Filter;
      k?: number;
      summary?: boolean;
      candidateLimit?: number;
    },
  ): Promise<{ records: Record<string, unknown>[]; scores: number[] }> {
    if (!query || !query.trim()) return { records: [], scores: [] };

    const hasBm25 = !!this.textIdx;
    const hasSemantic = !!(this.embeddingProvider && this.hnswIdx);

    if (!hasBm25 && !hasSemantic) {
      throw new Error("hybridSearch requires either an embedding provider or a text index");
    }

    const limit = opts?.limit ?? 10;
    const candidateLimit = opts?.candidateLimit ?? Math.max(limit * 4, 50);
    const k = opts?.k ?? 60;
    const armOpts = { limit: candidateLimit, candidateLimit, filter: opts?.filter, summary: opts?.summary };

    const empty = (): { records: Record<string, unknown>[]; scores: number[] } => ({ records: [], scores: [] });
    // Run available arms in parallel; catch runtime failures so one arm degrading doesn't reject the whole call
    const [bm25Result, semResult] = await Promise.all([
      hasBm25 ? this.bm25Search(query, armOpts).catch(empty) : Promise.resolve(empty()),
      hasSemantic ? this.semanticSearch(query, armOpts).catch(empty) : Promise.resolve(empty()),
    ]);

    // Build id lists preserving arm order; build record map from both arms
    const recordMap = new Map<string, Record<string, unknown>>();
    const lexList: Array<{ id: string }> = [];
    const semList: Array<{ id: string }> = [];

    for (const rec of bm25Result.records) {
      const id = rec._id as string;
      lexList.push({ id });
      recordMap.set(id, rec);
    }
    for (const rec of semResult.records) {
      const id = rec._id as string;
      semList.push({ id });
      if (!recordMap.has(id)) recordMap.set(id, rec);
    }

    // Build the lists to fuse — skip empty arms so RRF isn't padded with zero-length lists
    const listsToFuse: Array<Array<{ id: string }>> = [];
    if (lexList.length > 0) listsToFuse.push(lexList);
    if (semList.length > 0) listsToFuse.push(semList);

    if (listsToFuse.length === 0) return { records: [], scores: [] };

    const fused = rrf(listsToFuse, { k, limit });

    const records: Record<string, unknown>[] = [];
    const scores: number[] = [];
    for (const { id, score } of fused) {
      const rec = recordMap.get(id);
      if (!rec) continue;
      records.push(rec);
      scores.push(score);
    }

    return { records, scores };
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
    opts?: { filter?: Filter; limit?: number; summary?: boolean; candidateLimit?: number },
  ): Promise<{ records: Record<string, unknown>[]; scores: number[] }> {
    if (!query || !query.trim()) return { records: [], scores: [] };

    if (!this.embeddingProvider || !this.hnswIdx) {
      throw new Error("Semantic search not available. Configure an embedding provider on AgentDB.");
    }

    // Ensure all records are embedded
    await this.embedUnembedded();

    // Embed the query
    const [queryVec] = await this.embeddingProvider.embed([query]);

    // Search HNSW
    const limit = opts?.limit ?? 10;
    const candidateLimit = opts?.candidateLimit ?? Math.max(limit * 4, 50);
    const candidates = this.hnswIdx.search(queryVec, candidateLimit);

    return this.materializeCandidates(candidates, { limit, filter: opts?.filter, summary: opts?.summary });
  }

  /**
   * Embed all records that don't have embeddings yet.
   * Called lazily on first semantic search.
   * In disk mode, also iterates Parquet/JSONL records and writes embeddings back to disk.
   *
   * **Memory:** disk path buffers full record references for all unembedded records before
   * batching (~1 KB/record; expect ~1 GB at 1M unembedded). For very large lazy-embedding
   * runs, prefer {@link reembedAll} which streams and flushes mid-run with bounded memory.
   */
  async embedUnembedded(): Promise<number> {
    if (!this.embeddingProvider || !this.hnswIdx) return 0;

    const batchSize = this.opts.embeddingBatchSize ?? 256;
    let embedded = 0;

    // --- WAL (in-memory) records ---
    const walSeen = new Set<string>();
    const walToEmbed: { id: string; text: string; record: StoredRecord }[] = [];
    for (const [id, record] of this.store.entries()) {
      if (isExpired(record)) continue;
      walSeen.add(id);
      if (record[META_EMBEDDING]) continue;
      const clean = stripMeta(record);
      const text = extractTextFromRecord(clean);
      if (text) walToEmbed.push({ id, text, record });
    }

    for (let i = 0; i < walToEmbed.length; i += batchSize) {
      const batch = walToEmbed.slice(i, i + batchSize);
      let vectors: number[][];
      try {
        vectors = await this.embeddingProvider.embed(batch.map((b) => b.text));
      } catch (err) {
        console.warn(`agentdb: embedUnembedded WAL batch ${Math.floor(i / batchSize)} failed: ${err}`);
        continue;
      }
      await this.store.batch(() => {
        for (let j = 0; j < batch.length; j++) {
          const { id, record } = batch[j];
          const q = quantize(vectors[j]);
          const updated = { ...record, [META_EMBEDDING]: serializeQuantized(q) };
          this.store.set(id, updated);
        }
      });
      if (vectors.length > 0) this.ensureHnswDims(vectors[0]);
      for (let j = 0; j < batch.length; j++) {
        this.hnswIdx.add(batch[j].id, vectors[j]);
      }
      embedded += batch.length;
    }

    // --- Disk records (compacted Parquet/JSONL) ---
    if (this._diskStore?.hasParquetData) {
      // Single-pass: stream entries oldest→newest (last file wins for each id).
      // pending accumulates the final decision for each id; a later entry with _embedding
      // (written by a prior embedUnembedded) removes the id so we don't re-embed it.
      // Memory is bounded by unique-id count, not record size — each entry stores only
      // the stripped text + record needed for the embedding call.
      const pending = new Map<string, { text: string; record: StoredRecord }>();

      for await (const [id, record] of this._diskStore.entries({ skipCache: true })) {
        if (walSeen.has(id)) continue;
        if ((record as StoredRecord)[META_EMBEDDING]) {
          pending.delete(id);
        } else {
          if (isExpired(record as StoredRecord)) continue;
          const clean = stripMeta(record as StoredRecord);
          const text = extractTextFromRecord(clean);
          if (text) {
            pending.set(id, { text, record: record as StoredRecord });
          } else {
            pending.delete(id);
          }
        }
      }

      const diskBatch: { id: string; text: string; record: StoredRecord }[] = [];

      const flushDiskBatch = async (): Promise<void> => {
        if (diskBatch.length === 0) return;
        let vectors: number[][];
        try {
          vectors = await this.embeddingProvider!.embed(diskBatch.map((b) => b.text));
        } catch (err) {
          console.warn(`agentdb: embedUnembedded disk batch failed: ${err}`);
          diskBatch.length = 0;
          return;
        }
        const updates: Array<[string, Record<string, unknown>]> = diskBatch.map((b, j) => {
          const q = quantize(vectors[j]);
          return [b.id, { ...b.record, [META_EMBEDDING]: serializeQuantized(q) }];
        });
        await this._diskStore!.appendEmbeddings(updates);
        if (vectors.length > 0) this.ensureHnswDims(vectors[0]);
        for (let j = 0; j < diskBatch.length; j++) {
          this.hnswIdx!.add(diskBatch[j].id, vectors[j]);
        }
        embedded += diskBatch.length;
        diskBatch.length = 0;
      };

      for (const [id, entry] of pending) {
        diskBatch.push({ id, ...entry });
        if (diskBatch.length >= batchSize) await flushDiskBatch();
      }
      await flushDiskBatch();
    }

    return embedded;
  }

  /**
   * Force-reembed ALL records using the current embedding logic.
   * Use this to migrate embeddings from v1.3 (which incorrectly included `_id` in the text).
   * Resets the HNSW index and rewrites every record's embedding.
   * Requires an embedding provider; throws if none is configured.
   * Does NOT auto-run on open — call explicitly after upgrading from v1.3.
   * Per-batch provider failures are recorded in the returned {@link ReembedResult} rather than
   * thrown, so the caller can distinguish partial success from total failure.
   */
  async reembedAll(opts?: { onProgress?: ProgressCallback; signal?: AbortSignal }): Promise<ReembedResult> {
    if (!this.embeddingProvider || !this.hnswIdx) {
      throw new Error("reembedAll requires an embedding provider to be configured");
    }

    const batchSize = this.opts.embeddingBatchSize ?? 256;
    const onProgress = opts?.onProgress;
    const signal = opts?.signal;
    // Reset HNSW so stale vectors don't persist
    this.hnswIdx = new HnswIndex(this.hnswOpts(this.embeddingProvider.dimensions));
    let embedded = 0;
    let failed = 0;
    const errors: ReembedResult["errors"] = [];

    // --- WAL (in-memory) records ---
    const walSeen = new Set<string>();
    const walToEmbed: { id: string; text: string; record: StoredRecord }[] = [];
    for (const [id, record] of this.store.entries()) {
      if (isExpired(record)) continue;
      walSeen.add(id);
      const clean = stripMeta(record);
      const text = extractTextFromRecord(clean);
      if (text) walToEmbed.push({ id, text, record });
    }
    const walTotal = walToEmbed.length;

    for (let i = 0; i < walToEmbed.length; i += batchSize) {
      if (signal?.aborted) { console.warn(`agentdb [${this.name}]: reembedAll aborted — embedded=${embedded}, failed=${failed}`); return { embedded, failed, errors, aborted: true }; }
      const batch = walToEmbed.slice(i, i + batchSize);
      const batchIndex = Math.floor(i / batchSize);
      let vectors: number[][];
      try {
        vectors = await this.embeddingProvider.embed(batch.map((b) => b.text));
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(`agentdb: reembedAll WAL batch ${batchIndex} failed: ${reason}`);
        errors.push({ batchIndex, recordIds: batch.map((b) => b.id), reason });
        failed += batch.length;
        try { onProgress?.({ completed: embedded + failed, total: walTotal, phase: "wal" }); } catch (e) { console.error("agentdb: onProgress callback threw:", e); }
        continue;
      }
      await this.store.batch(() => {
        for (let j = 0; j < batch.length; j++) {
          const { id, record } = batch[j];
          const q = quantize(vectors[j]);
          const updated = { ...record, [META_EMBEDDING]: serializeQuantized(q) };
          this.store.set(id, updated);
        }
      });
      if (vectors.length > 0) this.ensureHnswDims(vectors[0]);
      for (let j = 0; j < batch.length; j++) {
        this.hnswIdx!.add(batch[j].id, vectors[j]);
      }
      embedded += batch.length;
      try { onProgress?.({ completed: embedded + failed, total: walTotal, phase: "wal" }); } catch (e) { console.error("agentdb: onProgress callback threw:", e); }
    }

    // --- Disk records (compacted Parquet/JSONL) ---
    if (this._diskStore?.hasParquetData) {
      let diskBatchIndex = Math.ceil(walToEmbed.length / batchSize);
      const diskBatch: { id: string; text: string; record: StoredRecord }[] = [];

      const flushDiskBatch = async (): Promise<boolean> => {
        if (diskBatch.length === 0) return false;
        if (signal?.aborted) return true; // signal abort before embedding
        let vectors: number[][];
        try {
          vectors = await this.embeddingProvider!.embed(diskBatch.map((b) => b.text));
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          console.warn(`agentdb: reembedAll disk batch ${diskBatchIndex} failed: ${reason}`);
          errors.push({ batchIndex: diskBatchIndex, recordIds: diskBatch.map((b) => b.id), reason });
          failed += diskBatch.length;
          diskBatch.length = 0;
          diskBatchIndex++;
          try { onProgress?.({ completed: embedded + failed, total: null, phase: "disk" }); } catch (e) { console.error("agentdb: onProgress callback threw:", e); }
          return false;
        }
        const updates: Array<[string, Record<string, unknown>]> = diskBatch.map((b, j) => {
          const q = quantize(vectors[j]);
          return [b.id, { ...b.record, [META_EMBEDDING]: serializeQuantized(q) }];
        });
        await this._diskStore!.appendEmbeddings(updates);
        // Mid-flight compaction: merge accumulated JSONL files when threshold hit,
        // bounding file count and index rewrite cost for large reembed runs.
        if (this._diskStore!.shouldCompact()) {
          await this._diskStore!.compactInPlace();
        }
        if (vectors.length > 0) this.ensureHnswDims(vectors[0]);
        for (let j = 0; j < diskBatch.length; j++) {
          this.hnswIdx!.add(diskBatch[j].id, vectors[j]);
        }
        embedded += diskBatch.length;
        diskBatch.length = 0;
        diskBatchIndex++;
        try { onProgress?.({ completed: embedded + failed, total: null, phase: "disk" }); } catch (e) { console.error("agentdb: onProgress callback threw:", e); }
        return false;
      };

      // Single pass: process every non-expired disk record (skip WAL-shadowed ids)
      const diskSeen = new Set<string>();
      for await (const [id, record] of this._diskStore.entries({ skipCache: true })) {
        if (signal?.aborted) break;
        if (walSeen.has(id) || diskSeen.has(id)) continue;
        diskSeen.add(id);
        if (isExpired(record as StoredRecord)) continue;
        const clean = stripMeta(record as StoredRecord);
        const text = extractTextFromRecord(clean);
        if (!text) continue;
        diskBatch.push({ id, text, record: record as StoredRecord });
        if (diskBatch.length >= batchSize) {
          const aborted = await flushDiskBatch();
          if (aborted) { console.warn(`agentdb [${this.name}]: reembedAll aborted — embedded=${embedded}, failed=${failed}`); return { embedded, failed, errors, aborted: true }; }
        }
      }
      const aborted = await flushDiskBatch();
      if (aborted || signal?.aborted) { console.warn(`agentdb [${this.name}]: reembedAll aborted — embedded=${embedded}, failed=${failed}`); return { embedded, failed, errors, aborted: true }; }
    }

    return { embedded, failed, errors };
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
      this.hnswIdx = new HnswIndex(this.hnswOpts(vector.length));
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
    await this.textIndexAdd(id, extractTextFromRecord(this.textRecord(stripMeta(stored))));
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
  async searchByVector(
    vector: number[],
    opts?: { filter?: Filter; limit?: number; summary?: boolean },
  ): Promise<{ records: Record<string, unknown>[]; scores: number[] }> {
    if (!this.hnswIdx) {
      throw new Error("Vector search not available. Call insertVector first or configure an embedding provider.");
    }
    if (vector.length !== this.hnswIdx.dims) {
      throw new Error(`Vector dimension mismatch: index has ${this.hnswIdx.dims} dimensions, query has ${vector.length}`);
    }
    const limit = opts?.limit ?? 10;
    const candidates = this.hnswIdx.search(vector, Math.max(limit * 4, 50));

    return this.materializeCandidates(candidates, { limit, filter: opts?.filter, summary: opts?.summary });
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
  stats(): { activeRecords: number; opsCount: number; textIndexBytes: number } {
    const s = this.store.stats();
    return { activeRecords: s.activeRecords, opsCount: s.opsCount, textIndexBytes: this.textIdx?.estimatedBytes() ?? 0 };
  }

  /** Flush the TermLog write buffer to disk. Used in tests to ensure segment files exist. */
  async flushTextIndex(): Promise<void> {
    if (this.textIdx) await this.textIdx.flush();
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

