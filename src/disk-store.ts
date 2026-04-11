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
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { RecordCache } from "./record-cache.js";
import {
  compactToParquet,
  readAllFromParquet,
  readByIds,
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

  constructor(dir: string, options?: DiskStoreOptions) {
    this.dir = dir;
    this.cache = new RecordCache(options?.cacheSize ?? 10_000);
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
  }

  /** Evict from cache after a delete (caller handles WAL persistence). */
  cacheDelete(id: string): void {
    this.cache.delete(id);
    // Note: offsetIndex is stale for deleted records until next compaction
    if (this.offsetIndex.has(id)) this._recordCount--;
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

    const { file, offsetIndex } = await compactToParquet(this.dir, allRecords, options);

    // Update state
    this.offsetIndex = offsetIndex;
    this._recordCount = offsetIndex.size;
    this.compactionMeta = {
      lastTimestamp: new Date().toISOString(),
      parquetFile: file.path,
      rowCount: file.rowCount,
      rowGroups: file.rowGroups,
    };

    // Persist
    await writeOffsetIndex(this.dir, offsetIndex);
    await writeCompactionMeta(this.dir, this.compactionMeta);

    // Clean up old Parquet files
    await cleanupOldParquetFiles(this.dir, file.path);

    // Clear cache (offsets changed)
    this.cache.clear();
  }

  // --- Index persistence ---

  /** Save index data to disk. */
  async saveIndexes(indexManager: IndexManager, textIndex?: TextIndex | null): Promise<void> {
    const indexDir = join(this.dir, "indexes");
    await mkdir(indexDir, { recursive: true });

    const { btree, array } = indexManager.serializeIndexes();
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

  /** Load persisted indexes from disk. Returns true if indexes were loaded. */
  async loadIndexes(indexManager: IndexManager, textIndex?: TextIndex | null): Promise<boolean> {
    const indexDir = join(this.dir, "indexes");
    let loaded = false;

    try {
      const { readdir } = await import("node:fs/promises");
      const files = await readdir(indexDir);

      for (const f of files) {
        if (f.startsWith("btree-") && f.endsWith(".json")) {
          const data = JSON.parse(await readFile(join(indexDir, f), "utf-8"));
          indexManager.loadBTreeIndex(data);
          loaded = true;
        }
        if (f.startsWith("array-") && f.endsWith(".json")) {
          const data = JSON.parse(await readFile(join(indexDir, f), "utf-8"));
          indexManager.loadArrayIndex(data);
          loaded = true;
        }
        if (f === "text-index.json" && textIndex) {
          const data = JSON.parse(await readFile(join(indexDir, f), "utf-8"));
          const restored = (await import("./text-index.js")).TextIndex.fromJSON(data);
          // Copy restored data into the existing textIndex instance
          // TextIndex doesn't have a "load" method, so we replace via clear + rebuild
          textIndex.clear();
          Object.assign(textIndex, restored);
          loaded = true;
        }
      }
    } catch {
      // indexes dir doesn't exist yet
    }

    return loaded;
  }
}
