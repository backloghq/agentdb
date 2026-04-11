/**
 * DiskStore — disk-backed record storage using Parquet files.
 *
 * All I/O goes through StorageBackend, so this works on both
 * filesystem (FsBackend) and S3 (S3Backend) transparently.
 */
import { RecordCache } from "./record-cache.js";
import {
  compactToParquet,
  readParquetBuffer,
  countByColumn,
  scanColumn,
  writeOffsetIndex,
  readOffsetIndex,
  writeCompactionMeta,
  readCompactionMeta,
  cleanupOldParquetFiles,
  writeRecordStore,
  readRecordByOffset,
  readRecordsByOffsets,
  readAllFromJsonl,
  writeRecordOffsetIndex,
  readRecordOffsetIndex,
  cleanupOldJsonlFiles,
  type OffsetEntry,
  type RecordOffsetEntry,
  type CompactionMeta,
  type CompactionOptions,
} from "./disk-io.js";
import type { IndexManager } from "./collection-indexes.js";
import type { TextIndex } from "./text-index.js";
import type { StorageBackend } from "@backloghq/opslog";

export interface DiskStoreOptions {
  /** Max records in LRU cache (default: 1000). */
  cacheSize?: number;
  /** Parquet row group size (default: 5000). */
  rowGroupSize?: number;
  /** Columns to extract for Parquet skip-scanning. */
  extractColumns?: string[];
}

export class DiskStore {
  private backend: StorageBackend;
  private cache: RecordCache<Record<string, unknown>>;
  private offsetIndex: Map<string, OffsetEntry> = new Map();
  private recordOffsetIndex: Map<string, RecordOffsetEntry> = new Map();
  private compactionMeta: CompactionMeta | null = null;
  private rowGroupSize: number;
  private extractColumns: string[];
  private _recordCount = 0;
  private _dirty = false;
  /** Cached Parquet file buffer — read once, reused for all queries. Cleared on compaction. */
  private _parquetBuffer: ArrayBuffer | null = null;
  /** Pending index files for lazy loading — loaded on first query. */
  private _pendingIndexFiles: Map<string, string> = new Map(); // field → filename
  private _indexManager: IndexManager | null = null;
  private _textIndex: TextIndex | null = null;

  constructor(backend: StorageBackend, options?: DiskStoreOptions) {
    this.backend = backend;
    this.cache = new RecordCache(options?.cacheSize ?? 1_000);
    this.rowGroupSize = options?.rowGroupSize ?? 5000;
    this.extractColumns = options?.extractColumns ?? [];
  }

  /** Load persisted state: offset index + compaction metadata + JSONL offsets. */
  async load(): Promise<void> {
    this.offsetIndex = await readOffsetIndex(this.backend);
    this.recordOffsetIndex = await readRecordOffsetIndex(this.backend);
    this.compactionMeta = await readCompactionMeta(this.backend);
    this._recordCount = this.recordOffsetIndex.size || this.offsetIndex.size;
  }

  /** Whether a JSONL record store exists. */
  get hasJsonlStore(): boolean {
    return this.compactionMeta?.jsonlFile !== undefined;
  }

  /** Whether a Parquet file exists from a previous compaction. */
  get hasParquetData(): boolean {
    return this.compactionMeta !== null;
  }

  /** Cardinality per extracted column from last compaction. */
  get columnCardinality(): Record<string, number> {
    return this.compactionMeta?.columnCardinality ?? {};
  }

  /** Max cardinality for in-memory index (above this, use Parquet column scan). Default: 1000. */
  static readonly MAX_INDEX_CARDINALITY = 1000;

  /** Check if a field should use in-memory index (low cardinality) or Parquet scan (high cardinality). */
  shouldUseInMemoryIndex(field: string): boolean {
    // No compaction data yet (first session) — default to in-memory
    if (!this.compactionMeta?.columnCardinality) return true;
    const cardinality = this.compactionMeta.columnCardinality[field];
    // Field not in extracted columns — default to Parquet scan (unknown = assume high)
    if (cardinality === undefined) return false;
    return cardinality <= DiskStore.MAX_INDEX_CARDINALITY;
  }

  /** Whether there are unsaved writes since last compaction. */
  get isDirty(): boolean {
    return this._dirty;
  }

  /** Number of records in the offset index. */
  get recordCount(): number {
    return this._recordCount;
  }

  /** Get the LRU cache for stats access. */
  get cacheStats() {
    return this.cache.stats();
  }

  /** Get or lazily load the cached Parquet file buffer. */
  private async getParquetBuffer(): Promise<ArrayBuffer | undefined> {
    if (!this.compactionMeta) return undefined;
    if (!this._parquetBuffer) {
      this._parquetBuffer = await readParquetBuffer(this.backend, this.compactionMeta.parquetFile);
    }
    return this._parquetBuffer;
  }

  // --- Read operations ---

  /** Get a record by ID. Checks cache → JSONL byte seek. */
  async get(id: string): Promise<Record<string, unknown> | undefined> {
    const cached = this.cache.get(id);
    if (cached !== undefined) return cached;

    if (!this.compactionMeta?.jsonlFile) return undefined;

    const jsonlEntry = this.recordOffsetIndex.get(id);
    if (!jsonlEntry) return undefined;

    const record = await readRecordByOffset(this.backend, this.compactionMeta.jsonlFile, jsonlEntry);
    this.cache.set(id, record);
    return record;
  }

  /** Check if a record exists (by offset index, no I/O). */
  has(id: string): boolean {
    return this.cache.has(id) || this.recordOffsetIndex.has(id);
  }

  /** Get multiple records by ID. Parallel JSONL byte-range reads. */
  async getMany(ids: string[]): Promise<Map<string, Record<string, unknown>>> {
    const results = new Map<string, Record<string, unknown>>();
    const uncached: string[] = [];

    for (const id of ids) {
      const cached = this.cache.get(id);
      if (cached !== undefined) {
        results.set(id, cached);
      } else if (this.recordOffsetIndex.has(id)) {
        uncached.push(id);
      }
    }

    if (uncached.length > 0 && this.compactionMeta?.jsonlFile) {
      const entries = uncached
        .map((id) => ({ id, entry: this.recordOffsetIndex.get(id)! }))
        .filter((e) => e.entry);
      if (entries.length > 0) {
        const fromJsonl = await readRecordsByOffsets(this.backend, this.compactionMeta.jsonlFile, entries);
        for (const [id, record] of fromJsonl) {
          this.cache.set(id, record);
          results.set(id, record);
        }
      }
    }

    return results;
  }

  /**
   * Count records matching a simple equality on an extracted column.
   * Reads only the target column — no _data deserialization.
   * Returns null if column not available (fall back to full scan).
   */
  private _cachedParquetFiles: string[] | null = null;
  private _cachedJsonlFiles: string[] | null = null;

  /** Get all Parquet files (base + incremental). Cached. */
  private getAllParquetFiles(): string[] {
    if (this._cachedParquetFiles) return this._cachedParquetFiles;
    if (!this.compactionMeta) return [];
    this._cachedParquetFiles = [this.compactionMeta.parquetFile, ...(this.compactionMeta.parquetFiles ?? [])];
    return this._cachedParquetFiles;
  }

  /** Get all JSONL files (base + incremental). Cached. */
  private getAllJsonlFiles(): string[] {
    if (this._cachedJsonlFiles) return this._cachedJsonlFiles;
    if (!this.compactionMeta?.jsonlFile) return [];
    this._cachedJsonlFiles = [this.compactionMeta.jsonlFile, ...(this.compactionMeta.jsonlFiles ?? [])];
    return this._cachedJsonlFiles;
  }

  async countByColumn(field: string, value: unknown): Promise<number | null> {
    if (!this.compactionMeta) return null;
    // Union count across all Parquet files
    let total = 0;
    for (const pqFile of this.getAllParquetFiles()) {
      const result = await countByColumn(this.backend, pqFile, field, value);
      if (result === null) return null; // column not available
      total += result;
    }
    return total;
  }

  async scanColumn(field: string, predicate: (value: unknown) => boolean): Promise<string[] | null> {
    if (!this.compactionMeta) return null;
    const allIds: string[] = [];
    for (const pqFile of this.getAllParquetFiles()) {
      const ids = await scanColumn(this.backend, pqFile, field, predicate);
      if (ids === null) return null;
      allIds.push(...ids);
    }
    return allIds;
  }

  /** Iterate all records from all JSONL files. */
  async *entries(): AsyncGenerator<[string, Record<string, unknown>]> {
    for (const jsonlFile of this.getAllJsonlFiles()) {
      const all = await readAllFromJsonl(this.backend, jsonlFile);
      for (const [id, record] of all) {
        this.cache.set(id, record);
        yield [id, record];
      }
    }
  }

  // --- Write-through ---

  /** Mark as dirty (mutations occurred this session). */
  markDirty(): void {
    this._dirty = true;
  }

  /** Update cache after a write (caller handles WAL persistence). */
  cacheWrite(id: string, record: Record<string, unknown>): void {
    this.cache.set(id, record);
    if (!this.offsetIndex.has(id)) this._recordCount++;
    this._dirty = true;
  }

  /** Evict from cache and offset indexes after a delete. */
  cacheDelete(id: string): void {
    this.cache.delete(id);
    this._dirty = true;
    this.recordOffsetIndex.delete(id);
    if (this.offsetIndex.has(id)) {
      this.offsetIndex.delete(id);
    }
    this._recordCount = this.recordOffsetIndex.size || this.offsetIndex.size;
  }

  /** Clear cache (e.g., after compaction when offsets change). */
  clearCache(): void {
    this.cache.clear();
  }

  /** Max incremental files before triggering a full merge. */
  private static readonly MERGE_THRESHOLD = 10;

  // --- Compaction ---

  /**
   * Compact: incremental if possible, full if first time or merge threshold reached.
   * - Incremental: writes only newRecords to new JSONL + Parquet files, appends to file list.
   * - Full: rewrites all records into single JSONL + Parquet files.
   */
  async compact(
    allRecords: AsyncIterable<[string, Record<string, unknown>]> | Iterable<[string, Record<string, unknown>]>,
    newRecords?: Array<[string, Record<string, unknown>]>,
  ): Promise<void> {
    const fileCount = (this.compactionMeta?.parquetFiles?.length ?? 0) + 1;
    const shouldMerge = !this.compactionMeta || fileCount >= DiskStore.MERGE_THRESHOLD || !newRecords;

    if (shouldMerge) {
      await this._compactFull(allRecords);
    } else {
      await this._compactIncremental(newRecords);
    }
  }

  /** Full compaction: rewrite everything into single JSONL + Parquet. */
  private async _compactFull(
    allRecords: AsyncIterable<[string, Record<string, unknown>]> | Iterable<[string, Record<string, unknown>]>,
  ): Promise<void> {
    const collected: Array<[string, Record<string, unknown>]> = [];
    for await (const entry of allRecords) collected.push(entry);

    const options: CompactionOptions = {
      rowGroupSize: this.rowGroupSize,
      extractColumns: this.extractColumns,
    };
    const { file, offsetIndex, columnCardinality } = await compactToParquet(this.backend, collected, options);
    const { path: jsonlPath, offsetIndex: recordOffsets } = await writeRecordStore(this.backend, collected);

    // Clean up ALL old files before updating meta
    if (this.compactionMeta) {
      const keepParquet = new Set([file.path]);
      const keepJsonl = new Set([jsonlPath]);
      for (const f of this.compactionMeta.parquetFiles ?? []) keepParquet.add(f);
      for (const f of this.compactionMeta.jsonlFiles ?? []) keepJsonl.add(f);
    }
    await cleanupOldParquetFiles(this.backend, file.path);
    await cleanupOldJsonlFiles(this.backend, jsonlPath);

    this.offsetIndex = offsetIndex;
    this.recordOffsetIndex = recordOffsets;
    this._recordCount = recordOffsets.size;
    this.compactionMeta = {
      lastTimestamp: new Date().toISOString(),
      parquetFile: file.path,
      parquetFiles: [],
      jsonlFile: jsonlPath,
      jsonlFiles: [],
      rowCount: file.rowCount,
      rowGroups: file.rowGroups,
      columnCardinality,
    };

    await writeOffsetIndex(this.backend, offsetIndex);
    await writeRecordOffsetIndex(this.backend, recordOffsets);
    await writeCompactionMeta(this.backend, this.compactionMeta);

    this.cache.clear();
    this._parquetBuffer = null;
    this._cachedParquetFiles = null;
    this._cachedJsonlFiles = null;
    this._dirty = false;
  }

  /** Incremental compaction: write only new records, append to file lists. */
  private async _compactIncremental(
    newRecords: Array<[string, Record<string, unknown>]>,
  ): Promise<void> {
    if (newRecords.length === 0) { this._dirty = false; return; }

    const options: CompactionOptions = {
      rowGroupSize: this.rowGroupSize,
      extractColumns: this.extractColumns,
    };
    const { file, offsetIndex: newPqOffset, columnCardinality } = await compactToParquet(this.backend, newRecords, options);
    const { path: jsonlPath, offsetIndex: newRecordOffsets } = await writeRecordStore(this.backend, newRecords);

    // Merge into existing offset indexes
    for (const [id, entry] of newPqOffset) this.offsetIndex.set(id, entry);
    for (const [id, entry] of newRecordOffsets) this.recordOffsetIndex.set(id, entry);
    this._recordCount = this.recordOffsetIndex.size;

    // Append files to lists
    const parquetFiles = [...(this.compactionMeta?.parquetFiles ?? []), file.path];
    const jsonlFiles = [...(this.compactionMeta?.jsonlFiles ?? []), jsonlPath];

    // Merge cardinality
    const mergedCardinality = { ...this.compactionMeta?.columnCardinality, ...columnCardinality };

    this.compactionMeta = {
      lastTimestamp: new Date().toISOString(),
      parquetFile: this.compactionMeta!.parquetFile, // keep original base file
      parquetFiles,
      jsonlFile: this.compactionMeta!.jsonlFile!, // keep original base file
      jsonlFiles,
      rowCount: this._recordCount,
      rowGroups: (this.compactionMeta?.rowGroups ?? 0) + file.rowGroups,
      columnCardinality: mergedCardinality,
    };

    await writeOffsetIndex(this.backend, this.offsetIndex);
    await writeRecordOffsetIndex(this.backend, this.recordOffsetIndex);
    await writeCompactionMeta(this.backend, this.compactionMeta);

    this.cache.clear();
    this._parquetBuffer = null;
    this._cachedParquetFiles = null;
    this._cachedJsonlFiles = null;
    this._dirty = false;
  }

  // --- Index persistence ---

  /** Max index file size to load (256MB). */
  private static readonly MAX_INDEX_FILE_SIZE = 256 * 1024 * 1024;

  /** Save index data to disk. Also updates cardinality for all indexed fields. */
  async saveIndexes(indexManager: IndexManager, textIndex?: TextIndex | null): Promise<void> {
    const { btree, array } = indexManager.serializeIndexes();
    // Update cardinality from all B-tree indexes
    if (this.compactionMeta) {
      const cardinality = { ...this.compactionMeta.columnCardinality };
      for (const { data } of btree) {
        cardinality[data.field] = data.entries.length;
      }
      this.compactionMeta.columnCardinality = cardinality;
      await writeCompactionMeta(this.backend, this.compactionMeta);
    }
    for (const { data } of btree) {
      await this.backend.writeBlob(`indexes/btree-${data.field}.json`, Buffer.from(JSON.stringify(data)));
    }
    for (const { data } of array) {
      await this.backend.writeBlob(`indexes/array-${data.field}.json`, Buffer.from(JSON.stringify(data)));
    }
    if (textIndex) {
      await this.backend.writeBlob("indexes/text-index.json", Buffer.from(JSON.stringify(textIndex.toJSON())));
    }
  }

  /** Discover persisted index files for lazy loading. Actual deserialization deferred to first query. */
  async loadIndexes(indexManager: IndexManager, textIndex?: TextIndex | null): Promise<boolean> {
    this._indexManager = indexManager;
    this._textIndex = textIndex ?? null;
    let found = false;

    try {
      const files = await this.backend.listBlobs("indexes");

      for (const f of files) {
        if (f.startsWith("btree-") && f.endsWith(".json")) {
          const field = f.slice(6, -5);
          if (!this.shouldUseInMemoryIndex(field)) continue;
          this._pendingIndexFiles.set(`btree:${field}`, f);
          found = true;
        }
        if (f.startsWith("array-") && f.endsWith(".json")) {
          this._pendingIndexFiles.set(`array:${f.slice(6, -5)}`, f);
          found = true;
        }
        if (f === "text-index.json") {
          this._pendingIndexFiles.set("text", f);
          found = true;
        }
      }
    } catch {
      // indexes dir doesn't exist yet
    }

    return found;
  }

  private _indexLoadPromise: Promise<void> | null = null;

  /** Ensure all pending indexes are loaded. Called lazily before first query that needs indexes. */
  async ensureIndexesLoaded(): Promise<void> {
    if (this._pendingIndexFiles.size === 0) return;
    if (!this._indexManager) return;
    // Serialize concurrent callers — only one loads, others wait
    if (this._indexLoadPromise) return this._indexLoadPromise;
    this._indexLoadPromise = this._doLoadIndexes();
    await this._indexLoadPromise;
    this._indexLoadPromise = null;
  }

  private async _doLoadIndexes(): Promise<void> {
    const im = this._indexManager!;
    for (const [key, filename] of this._pendingIndexFiles) {
      let content: Buffer;
      try {
        content = await this.backend.readBlob(`indexes/${filename}`);
      } catch {
        continue;
      }
      if (content.length > DiskStore.MAX_INDEX_FILE_SIZE) {
        console.warn(`agentdb: skipping oversized index file ${filename} (${content.length} bytes)`);
        continue;
      }
      if (key.startsWith("btree:")) {
        im.loadBTreeIndex(JSON.parse(content.toString("utf-8")));
      } else if (key.startsWith("array:")) {
        im.loadArrayIndex(JSON.parse(content.toString("utf-8")));
      } else if (key === "text" && this._textIndex) {
        this._textIndex.loadFromJSON(JSON.parse(content.toString("utf-8")));
      }
    }
    this._pendingIndexFiles.clear();
  }
}
