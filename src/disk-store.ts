/**
 * DiskStore — disk-backed record storage using Parquet files.
 *
 * All I/O goes through StorageBackend, so this works on both
 * filesystem (FsBackend) and S3 (S3Backend) transparently.
 */
import { RecordCache } from "./record-cache.js";
import {
  compactToParquet,
  readAllFromParquet,
  readByIds,
  readParquetBuffer,
  countByColumn,
  scanColumn,
  writeOffsetIndex,
  readOffsetIndex,
  writeCompactionMeta,
  readCompactionMeta,
  cleanupOldParquetFiles,
  type OffsetEntry,
  type CompactionMeta,
  type CompactionOptions,
} from "./parquet.js";
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
  private compactionMeta: CompactionMeta | null = null;
  private rowGroupSize: number;
  private extractColumns: string[];
  private _recordCount = 0;
  private _dirty = false;
  /** Cached Parquet file buffer — read once, reused for all queries. Cleared on compaction. */
  private _parquetBuffer: ArrayBuffer | null = null;

  constructor(backend: StorageBackend, options?: DiskStoreOptions) {
    this.backend = backend;
    this.cache = new RecordCache(options?.cacheSize ?? 1_000);
    this.rowGroupSize = options?.rowGroupSize ?? 5000;
    this.extractColumns = options?.extractColumns ?? [];
  }

  /** Load persisted state: offset index + compaction metadata. */
  async load(): Promise<void> {
    this.offsetIndex = await readOffsetIndex(this.backend);
    this.compactionMeta = await readCompactionMeta(this.backend);
    this._recordCount = this.offsetIndex.size;
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

  /** Get a record by ID. Checks cache first, then Parquet. */
  async get(id: string): Promise<Record<string, unknown> | undefined> {
    const cached = this.cache.get(id);
    if (cached !== undefined) return cached;

    if (!this.compactionMeta || !this.offsetIndex.has(id)) return undefined;

    const pqBuf = await this.getParquetBuffer();
    const results = await readByIds(
      this.backend, this.compactionMeta.parquetFile, [id], this.offsetIndex, this.rowGroupSize, pqBuf,
    );
    const record = results.get(id);
    if (record) this.cache.set(id, record);
    return record;
  }

  /** Check if a record exists (by offset index, no Parquet read). */
  has(id: string): boolean {
    return this.cache.has(id) || this.offsetIndex.has(id);
  }

  /** Get multiple records by ID. Batched Parquet reads. */
  async getMany(ids: string[]): Promise<Map<string, Record<string, unknown>>> {
    const results = new Map<string, Record<string, unknown>>();
    const uncached: string[] = [];

    for (const id of ids) {
      const cached = this.cache.get(id);
      if (cached !== undefined) {
        results.set(id, cached);
      } else if (this.offsetIndex.has(id)) {
        uncached.push(id);
      }
    }

    if (uncached.length > 0 && this.compactionMeta) {
      const pqBuf = await this.getParquetBuffer();
      const fromParquet = await readByIds(
        this.backend, this.compactionMeta.parquetFile, uncached, this.offsetIndex, this.rowGroupSize, pqBuf,
      );
      for (const [id, record] of fromParquet) {
        this.cache.set(id, record);
        results.set(id, record);
      }
    }

    return results;
  }

  /**
   * Count records matching a simple equality on an extracted column.
   * Reads only the target column — no _data deserialization.
   * Returns null if column not available (fall back to full scan).
   */
  async countByColumn(field: string, value: unknown): Promise<number | null> {
    if (!this.compactionMeta) return null;
    const pqBuf = await this.getParquetBuffer();
    return countByColumn(this.backend, this.compactionMeta.parquetFile, field, value, pqBuf);
  }

  /**
   * Scan an extracted column and return matching _ids.
   * Returns null if column not available.
   */
  async scanColumn(field: string, predicate: (value: unknown) => boolean): Promise<string[] | null> {
    if (!this.compactionMeta) return null;
    const pqBuf = await this.getParquetBuffer();
    return scanColumn(this.backend, this.compactionMeta.parquetFile, field, predicate, pqBuf);
  }

  /** Iterate all records (reads from Parquet). */
  async *entries(): AsyncGenerator<[string, Record<string, unknown>]> {
    if (!this.compactionMeta) return;
    const pqBuf = await this.getParquetBuffer();
    const all = await readAllFromParquet(this.backend, this.compactionMeta.parquetFile, pqBuf);
    for (const [id, record] of all) {
      this.cache.set(id, record);
      yield [id, record];
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

  /** Evict from cache and offset index after a delete. */
  cacheDelete(id: string): void {
    this.cache.delete(id);
    this._dirty = true;
    if (this.offsetIndex.has(id)) {
      this.offsetIndex.delete(id);
      this._recordCount--;
    }
  }

  /** Clear cache (e.g., after compaction when offsets change). */
  clearCache(): void {
    this.cache.clear();
  }

  // --- Compaction ---

  async compact(
    allRecords: AsyncIterable<[string, Record<string, unknown>]> | Iterable<[string, Record<string, unknown>]>,
  ): Promise<void> {
    const options: CompactionOptions = {
      rowGroupSize: this.rowGroupSize,
      extractColumns: this.extractColumns,
    };

    const { file, offsetIndex, columnCardinality } = await compactToParquet(this.backend, allRecords, options);

    this.offsetIndex = offsetIndex;
    this._recordCount = offsetIndex.size;
    this.compactionMeta = {
      lastTimestamp: new Date().toISOString(),
      parquetFile: file.path,
      rowCount: file.rowCount,
      rowGroups: file.rowGroups,
      columnCardinality,
    };

    await writeOffsetIndex(this.backend, offsetIndex);
    await writeCompactionMeta(this.backend, this.compactionMeta);
    await cleanupOldParquetFiles(this.backend, file.path);

    this.cache.clear();
    this._parquetBuffer = null; // invalidate cached buffer — new Parquet file
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

  /** Load persisted indexes from disk. Returns true if indexes were loaded. */
  async loadIndexes(indexManager: IndexManager, textIndex?: TextIndex | null): Promise<boolean> {
    let loaded = false;

    try {
      const files = await this.backend.listBlobs("indexes");

      for (const f of files) {
        // Size check — read blob and check length
        let content: Buffer;
        try {
          content = await this.backend.readBlob(`indexes/${f}`);
        } catch {
          continue;
        }
        if (content.length > DiskStore.MAX_INDEX_FILE_SIZE) {
          console.warn(`agentdb: skipping oversized index file ${f} (${content.length} bytes)`);
          continue;
        }
        if (f.startsWith("btree-") && f.endsWith(".json")) {
          const field = f.slice(6, -5);
          if (!this.shouldUseInMemoryIndex(field)) continue;
          const data = JSON.parse(content.toString("utf-8"));
          indexManager.loadBTreeIndex(data);
          loaded = true;
        }
        if (f.startsWith("array-") && f.endsWith(".json")) {
          const data = JSON.parse(content.toString("utf-8"));
          indexManager.loadArrayIndex(data);
          loaded = true;
        }
        if (f === "text-index.json" && textIndex) {
          const data = JSON.parse(content.toString("utf-8"));
          textIndex.loadFromJSON(data);
          loaded = true;
        }
      }
    } catch {
      // indexes dir doesn't exist yet
    }

    return loaded;
  }
}
