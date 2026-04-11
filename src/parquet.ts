/**
 * Parquet compaction and reader for disk-backed collections.
 *
 * Compaction: WAL + snapshot → Parquet file with extracted columns for skip-scanning.
 * Reader: point lookup, indexed query, row group skip-scan, full scan.
 *
 * Uses hyparquet (reader) and hyparquet-writer (writer) — both pure JS, zero native deps.
 */
import { writeFile, readFile, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { parquetWriteBuffer } from "hyparquet-writer";
import { asyncBufferFromFile, parquetReadObjects, parquetMetadata } from "hyparquet";
import type { FileMetaData } from "hyparquet";

// --- Types ---

export interface CompactionOptions {
  /** Records per row group (default: 5000). */
  rowGroupSize?: number;
  /** Columns to extract for skip-scanning (in addition to _id and _data). */
  extractColumns?: string[];
}

export interface OffsetEntry {
  rowGroup: number;
  row: number;
}

export interface ParquetFileInfo {
  path: string;
  rowCount: number;
  rowGroups: number;
}

// --- Writer (Compaction) ---

/**
 * Compact records into a Parquet file.
 * Each record is stored as _id + _data (JSON) + optional extracted columns for skip-scanning.
 *
 * @returns Parquet file info and offset index mapping _id → { rowGroup, row }
 */
export async function compactToParquet(
  dir: string,
  records: AsyncIterable<[string, Record<string, unknown>]> | Iterable<[string, Record<string, unknown>]>,
  options?: CompactionOptions,
): Promise<{ file: ParquetFileInfo; offsetIndex: Map<string, OffsetEntry> }> {
  const rowGroupSize = options?.rowGroupSize ?? 5000;
  const extractCols = options?.extractColumns ?? [];

  // Collect all records (needed for columnar layout)
  const ids: string[] = [];
  const dataJsons: string[] = [];
  const extracted: Map<string, unknown[]> = new Map();
  for (const col of extractCols) extracted.set(col, []);

  for await (const [id, record] of records) {
    ids.push(id);
    dataJsons.push(JSON.stringify(record));
    for (const col of extractCols) {
      extracted.get(col)!.push(record[col] ?? null);
    }
  }

  if (ids.length === 0) {
    // Empty collection — write empty Parquet
    const filename = `data-${Date.now()}.parquet`;
    const dataDir = join(dir, "data");
    await mkdir(dataDir, { recursive: true });
    const filePath = join(dataDir, filename);
    const columnData = [
      { name: "_id", data: [] as string[] },
      { name: "_data", data: [] as string[] },
    ];
    const buffer = parquetWriteBuffer({ columnData });
    await writeFile(filePath, Buffer.from(buffer));
    return {
      file: { path: `data/${filename}`, rowCount: 0, rowGroups: 0 },
      offsetIndex: new Map(),
    };
  }

  // Build column data
  const columnData: Array<{ name: string; data: unknown[] }> = [
    { name: "_id", data: ids },
    { name: "_data", data: dataJsons },
  ];
  for (const [col, values] of extracted) {
    // Only include columns with at least one non-null value and consistent type
    const nonNull = values.filter((v) => v !== null && v !== undefined);
    if (nonNull.length > 0 && nonNull.every((v) => typeof v === typeof nonNull[0])) {
      columnData.push({ name: col, data: values });
    }
  }

  const buffer = parquetWriteBuffer({ columnData, rowGroupSize });

  const filename = `data-${Date.now()}.parquet`;
  const dataDir = join(dir, "data");
  await mkdir(dataDir, { recursive: true });
  const filePath = join(dataDir, filename);
  await writeFile(filePath, Buffer.from(buffer));

  // Build offset index
  const offsetIndex = new Map<string, OffsetEntry>();
  let rowGroup = 0;
  let rowInGroup = 0;
  for (let i = 0; i < ids.length; i++) {
    if (i > 0 && i % rowGroupSize === 0) {
      rowGroup++;
      rowInGroup = 0;
    }
    offsetIndex.set(ids[i], { rowGroup, row: rowInGroup });
    rowInGroup++;
  }

  const metadata = parquetMetadata(buffer);

  return {
    file: {
      path: `data/${filename}`,
      rowCount: ids.length,
      rowGroups: metadata.row_groups.length,
    },
    offsetIndex,
  };
}

// --- Offset Index Persistence ---

export async function writeOffsetIndex(dir: string, offsetIndex: Map<string, OffsetEntry>): Promise<void> {
  const indexDir = join(dir, "indexes");
  await mkdir(indexDir, { recursive: true });
  const entries: Record<string, OffsetEntry> = {};
  for (const [id, entry] of offsetIndex) entries[id] = entry;
  await writeFile(join(indexDir, "offset-index.json"), JSON.stringify({ version: 1, entries }));
}

export async function readOffsetIndex(dir: string): Promise<Map<string, OffsetEntry>> {
  try {
    const content = await readFile(join(dir, "indexes", "offset-index.json"), "utf-8");
    const data = JSON.parse(content) as { entries: Record<string, OffsetEntry> };
    return new Map(Object.entries(data.entries));
  } catch {
    return new Map();
  }
}

// --- Compaction Metadata ---

export interface CompactionMeta {
  lastTimestamp: string;
  parquetFile: string;
  rowCount: number;
  rowGroups: number;
}

export async function writeCompactionMeta(dir: string, meta: CompactionMeta): Promise<void> {
  const metaDir = join(dir, "meta");
  await mkdir(metaDir, { recursive: true });
  await writeFile(join(metaDir, "compaction.json"), JSON.stringify(meta));
}

export async function readCompactionMeta(dir: string): Promise<CompactionMeta | null> {
  try {
    const content = await readFile(join(dir, "meta", "compaction.json"), "utf-8");
    const meta = JSON.parse(content) as CompactionMeta;
    // Sanitize parquetFile path to prevent traversal
    if (meta.parquetFile && (meta.parquetFile.includes("..") || meta.parquetFile.startsWith("/"))) {
      throw new Error(`Invalid parquetFile path in compaction metadata: '${meta.parquetFile}'`);
    }
    return meta;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Invalid parquetFile")) throw err;
    return null;
  }
}

// --- Reader ---

/**
 * Read all records from a Parquet file.
 * Returns [id, record] pairs.
 */
export async function readAllFromParquet(dir: string, parquetPath: string): Promise<Map<string, Record<string, unknown>>> {
  const filePath = join(dir, parquetPath);
  const file = await asyncBufferFromFile(filePath);
  const rows = await parquetReadObjects({ file }) as Array<{ _id: string; _data: string }>;
  const records = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    records.set(row._id, JSON.parse(row._data));
  }
  return records;
}

/**
 * Read specific records by ID from a Parquet file using the offset index.
 * Groups reads by row group for efficiency.
 */
export async function readByIds(
  dir: string,
  parquetPath: string,
  ids: string[],
  offsetIndex: Map<string, OffsetEntry>,
  rowGroupSize: number,
): Promise<Map<string, Record<string, unknown>>> {
  if (ids.length === 0) return new Map();

  const filePath = join(dir, parquetPath);
  const file = await asyncBufferFromFile(filePath);
  const results = new Map<string, Record<string, unknown>>();

  // Group IDs by row group
  const byRowGroup = new Map<number, string[]>();
  for (const id of ids) {
    const entry = offsetIndex.get(id);
    if (!entry) continue;
    let group = byRowGroup.get(entry.rowGroup);
    if (!group) { group = []; byRowGroup.set(entry.rowGroup, group); }
    group.push(id);
  }

  // Read each row group and extract matching records
  for (const [rg, groupIds] of byRowGroup) {
    const rowStart = rg * rowGroupSize;
    const rowEnd = rowStart + rowGroupSize;
    const rows = await parquetReadObjects({
      file,
      columns: ["_id", "_data"],
      rowStart,
      rowEnd,
    }) as Array<{ _id: string; _data: string }>;

    const idSet = new Set(groupIds);
    for (const row of rows) {
      if (idSet.has(row._id)) {
        results.set(row._id, JSON.parse(row._data));
      }
    }
  }

  return results;
}

/**
 * Get Parquet file metadata (row group stats) for skip-scanning.
 */
export async function getParquetMetadata(dir: string, parquetPath: string): Promise<FileMetaData> {
  const filePath = join(dir, parquetPath);
  const buf = await readFile(filePath);
  return parquetMetadata(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

/**
 * Count records matching a simple equality filter by reading only the target column.
 * Skips _data deserialization entirely — reads ~1MB instead of ~50MB at 100K records.
 * Returns null if the column doesn't exist in the Parquet file (not an extracted column).
 */
export async function countByColumn(
  dir: string,
  parquetPath: string,
  field: string,
  value: unknown,
): Promise<number | null> {
  const filePath = join(dir, parquetPath);
  const file = await asyncBufferFromFile(filePath);

  // Check if the column exists in the Parquet schema
  const buf = await readFile(filePath);
  const metadata = parquetMetadata(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const columns = metadata.row_groups[0]?.columns.map(
    (c) => c.meta_data?.path_in_schema?.[0],
  ) ?? [];
  if (!columns.includes(field)) return null;

  // Read only the target column
  const rows = await parquetReadObjects({ file, columns: [field] }) as Array<Record<string, unknown>>;
  let count = 0;
  for (const row of rows) {
    if (row[field] === value) count++;
  }
  return count;
}

/**
 * Read only specific columns from Parquet (no _data deserialization).
 * For find() with extracted columns — scan column, collect matching _ids, then fetch full records only for matches.
 * Returns null if the column doesn't exist.
 */
export async function scanColumn(
  dir: string,
  parquetPath: string,
  field: string,
  predicate: (value: unknown) => boolean,
): Promise<string[] | null> {
  const filePath = join(dir, parquetPath);
  const file = await asyncBufferFromFile(filePath);

  const buf = await readFile(filePath);
  const metadata = parquetMetadata(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const columns = metadata.row_groups[0]?.columns.map(
    (c) => c.meta_data?.path_in_schema?.[0],
  ) ?? [];
  if (!columns.includes(field)) return null;

  const rows = await parquetReadObjects({ file, columns: ["_id", field] }) as Array<Record<string, unknown>>;
  const matchingIds: string[] = [];
  for (const row of rows) {
    if (predicate(row[field])) matchingIds.push(row._id as string);
  }
  return matchingIds;
}

/**
 * Clean up old Parquet data files (keeps only the specified file).
 */
export async function cleanupOldParquetFiles(dir: string, keepFile: string): Promise<void> {
  const dataDir = join(dir, "data");
  try {
    const files = await readdir(dataDir);
    for (const f of files) {
      if (f.endsWith(".parquet") && `data/${f}` !== keepFile) {
        await rm(join(dataDir, f), { force: true });
      }
    }
  } catch {
    // data dir may not exist yet
  }
}
