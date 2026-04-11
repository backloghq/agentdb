/**
 * DiskStore — disk-backed record storage using Parquet files.
 *
 * Provides the same get/entries/find interface as opslog's in-memory Map,
 * but reads from Parquet files with an LRU cache layer.
 *
 * Architecture:
 *   get(id) → cache hit? → return : offset index → Parquet seek → cache + return
 *   find(filter) → indexed? → batch Parquet read : full Parquet scan
 */
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { RecordCache } from "./record-cache.js";
import {
  compactToParquet,
  readAllFromParquet,
  readByIds,
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

export interface DiskStoreOptions {
  /** Max records in LRU cache (default: 10000). */
  cacheSize?: number;
  /** Parquet row group size (default: 5000). */
  rowGroupSize?: number;
  /** Columns to extract for Parquet skip-scanning. */
  extractColumns?: string[];
}

export class DiskStore {
  readonly dir: string;
  private cache: RecordCache<Record<string, unknown>>;
  private offsetIndex: Map<string, OffsetEntry> = new Map();
  private compactionMeta: CompactionMeta | null = null;
  private rowGroupSize: number;
  private extractColumns: string[];
  private _recordCount = 0;
  private _dirty = false;

  constructor(dir: string, options?: DiskStoreOptions) {
    this.dir = dir;
    this.cache = new RecordCache(options?.cacheSize ?? 1_000);
    this.rowGroupSize = options?.rowGroupSize ?? 5000;
    this.extractColumns = options?.extractColumns ?? [];
  }

  /** Load persisted state: offset index + compaction metadata. */
  async load(): Promise<void> {
    this.offsetIndex = await readOffsetIndex(this.dir);
    this.compactionMeta = await readCompactionMeta(this.dir);
    this._recordCount = this.offsetIndex.size;
  }

  /** Whether a Parquet file exists from a previous compaction. */
  get hasParquetData(): boolean {
    return this.compactionMeta !== null;
  }

  /** Whether there are unsaved writes since last compaction. */
  get isDirty(): boolean {
    return this._dirty;
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

  /** Number of records in the offset index. */
  get recordCount(): number {
    return this._recordCount;
  }

  /** Get the LRU cache for stats access. */
  get cacheStats() {
    return this.cache.stats();
  }

  // --- Read operations ---

  /** Get a record by ID. Checks cache first, then Parquet. */
  async get(id: string): Promise<Record<string, unknown> | undefined> {
    // 1. Cache
    const cached = this.cache.get(id);
    if (cached !== undefined) return cached;

    // 2. Offset index → Parquet
    if (!this.compactionMeta || !this.offsetIndex.has(id)) return undefined;

    const results = await readByIds(
      this.dir, this.compactionMeta.parquetFile, [id], this.offsetIndex, this.rowGroupSize,
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
      const fromParquet = await readByIds(
        this.dir, this.compactionMeta.parquetFile, uncached, this.offsetIndex, this.rowGroupSize,
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
    return countByColumn(this.dir, this.compactionMeta.parquetFile, field, value);
  }

  /**
   * Scan an extracted column and return matching _ids.
   * Reads only _id + target column — no _data deserialization.
   * Returns null if column not available.
   */
  async scanColumn(field: string, predicate: (value: unknown) => boolean): Promise<string[] | null> {
    if (!this.compactionMeta) return null;
    return scanColumn(this.dir, this.compactionMeta.parquetFile, field, predicate);
  }

  /** Iterate all records (streams from Parquet). */
  async *entries(): AsyncGenerator<[string, Record<string, unknown>]> {
    if (!this.compactionMeta) return;
    const all = await readAllFromParquet(this.dir, this.compactionMeta.parquetFile);
    for (const [id, record] of all) {
      this.cache.set(id, record);
      yield [id, record];
    }
  }

  // --- Write-through cache ---

  /** Update cache after a write (caller handles WAL persistence). */
  cacheWrite(id: string, record: Record<string, unknown>): void {
    this.cache.set(id, record);
    if (!this.offsetIndex.has(id)) this._recordCount++;
    this._dirty = true;
  }

  /** Evict from cache and offset index after a delete (caller handles WAL persistence). */
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

  /**
   * Compact records into a new Parquet file.
   * Reads all records (from Parquet + WAL cache), writes new Parquet, updates indexes.
   */
  async compact(
    allRecords: AsyncIterable<[string, Record<string, unknown>]> | Iterable<[string, Record<string, unknown>]>,
  ): Promise<void> {
    const options: CompactionOptions = {
      rowGroupSize: this.rowGroupSize,
      extractColumns: this.extractColumns,
    };

    const { file, offsetIndex, columnCardinality } = await compactToParquet(this.dir, allRecords, options);

    // Update state
    this.offsetIndex = offsetIndex;
    this._recordCount = offsetIndex.size;
    this.compactionMeta = {
      lastTimestamp: new Date().toISOString(),
      parquetFile: file.path,
      rowCount: file.rowCount,
      rowGroups: file.rowGroups,
      columnCardinality,
    };

    // Persist
    await writeOffsetIndex(this.dir, offsetIndex);
    await writeCompactionMeta(this.dir, this.compactionMeta);

    // Clean up old Parquet files
    await cleanupOldParquetFiles(this.dir, file.path);

    // Clear cache (offsets changed) and reset dirty flag
    this.cache.clear();
    this._dirty = false;
  }

  // --- Index persistence ---

  /** Save index data to disk. Also updates cardinality for all indexed fields. */
  async saveIndexes(indexManager: IndexManager, textIndex?: TextIndex | null): Promise<void> {
    const indexDir = join(this.dir, "indexes");
    await mkdir(indexDir, { recursive: true });

    const { btree, array } = indexManager.serializeIndexes();
    // Update cardinality from all B-tree indexes (covers programmatic + schema indexes)
    if (this.compactionMeta) {
      const cardinality = { ...this.compactionMeta.columnCardinality };
      for (const { data } of btree) {
        cardinality[data.field] = data.entries.length; // number of unique values
      }
      this.compactionMeta.columnCardinality = cardinality;
      await writeCompactionMeta(this.dir, this.compactionMeta);
    }
    for (const { data } of btree) {
      await writeFile(join(indexDir, `btree-${data.field}.json`), JSON.stringify(data));
    }
    for (const { data } of array) {
      await writeFile(join(indexDir, `array-${data.field}.json`), JSON.stringify(data));
    }
    if (textIndex) {
      await writeFile(join(indexDir, "text-index.json"), JSON.stringify(textIndex.toJSON()));
    }
  }

  /** Max index file size to load (256MB). Prevents DoS via crafted index files. */
  private static readonly MAX_INDEX_FILE_SIZE = 256 * 1024 * 1024;

  /** Load persisted indexes from disk. Returns true if indexes were loaded. */
  async loadIndexes(indexManager: IndexManager, textIndex?: TextIndex | null): Promise<boolean> {
    const indexDir = join(this.dir, "indexes");
    let loaded = false;

    try {
      const { readdir } = await import("node:fs/promises");
      const files = await readdir(indexDir);

      for (const f of files) {
        const filePath = join(indexDir, f);
        const fileStat = await stat(filePath);
        if (fileStat.size > DiskStore.MAX_INDEX_FILE_SIZE) {
          console.warn(`agentdb: skipping oversized index file ${f} (${fileStat.size} bytes)`);
          continue;
        }
        if (f.startsWith("btree-") && f.endsWith(".json")) {
          const field = f.slice(6, -5); // "btree-status.json" → "status"
          if (!this.shouldUseInMemoryIndex(field)) continue; // high cardinality — skip
          const data = JSON.parse(await readFile(filePath, "utf-8"));
          indexManager.loadBTreeIndex(data);
          loaded = true;
        }
        if (f.startsWith("array-") && f.endsWith(".json")) {
          const data = JSON.parse(await readFile(filePath, "utf-8"));
          indexManager.loadArrayIndex(data);
          loaded = true;
        }
        if (f === "text-index.json" && textIndex) {
          const data = JSON.parse(await readFile(filePath, "utf-8"));
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
