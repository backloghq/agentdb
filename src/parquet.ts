/**
 * Parquet compaction and reader for disk-backed collections.
 *
 * Compaction: WAL + snapshot → Parquet file with extracted columns for skip-scanning.
 * Reader: point lookup, indexed query, row group skip-scan, full scan.
 *
 * All I/O goes through StorageBackend (writeBlob/readBlob/listBlobs/deleteBlob),
 * so this works on both filesystem and S3 transparently.
 *
 * Uses hyparquet (reader) and hyparquet-writer (writer) — both pure JS, zero native deps.
 */
import { parquetWriteBuffer } from "hyparquet-writer";
import { parquetReadObjects, parquetMetadata } from "hyparquet";
import type { FileMetaData } from "hyparquet";
import type { StorageBackend } from "@backloghq/opslog";

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
 */
export async function compactToParquet(
  backend: StorageBackend,
  records: AsyncIterable<[string, Record<string, unknown>]> | Iterable<[string, Record<string, unknown>]>,
  options?: CompactionOptions,
): Promise<{ file: ParquetFileInfo; offsetIndex: Map<string, OffsetEntry>; columnCardinality: Record<string, number> }> {
  const rowGroupSize = options?.rowGroupSize ?? 5000;
  const extractCols = options?.extractColumns ?? [];

  // Collect all records (needed for columnar layout)
  const ids: string[] = [];
  const extracted: Map<string, unknown[]> = new Map();
  for (const col of extractCols) extracted.set(col, []);

  for await (const [id, record] of records) {
    ids.push(id);
    for (const col of extractCols) {
      extracted.get(col)!.push(record[col] ?? null);
    }
  }

  if (ids.length === 0) {
    const filename = `data-${Date.now()}.parquet`;
    const relativePath = `data/${filename}`;
    const columnData = [
      { name: "_id", data: [] as string[] },
    ];
    const buffer = parquetWriteBuffer({ columnData });
    await backend.writeBlob(relativePath, Buffer.from(buffer));
    return {
      file: { path: relativePath, rowCount: 0, rowGroups: 0 },
      offsetIndex: new Map(),
      columnCardinality: {},
    };
  }

  // Build column data — _id + extracted columns only (no _data; full records live in JSONL)
  const columnData: Array<{ name: string; data: unknown[] }> = [
    { name: "_id", data: ids },
  ];
  for (const [col, values] of extracted) {
    const nonNull = values.filter((v) => v !== null && v !== undefined);
    if (nonNull.length > 0 && nonNull.every((v) => typeof v === typeof nonNull[0])) {
      columnData.push({ name: col, data: values });
    }
  }

  const buffer = parquetWriteBuffer({ columnData, rowGroupSize });

  const filename = `data-${Date.now()}.parquet`;
  const relativePath = `data/${filename}`;
  await backend.writeBlob(relativePath, Buffer.from(buffer));

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

  // Compute cardinality per extracted column
  const columnCardinality: Record<string, number> = {};
  for (const [col, values] of extracted) {
    columnCardinality[col] = new Set(values.map((v) => String(v))).size;
  }

  return {
    file: {
      path: relativePath,
      rowCount: ids.length,
      rowGroups: metadata.row_groups.length,
    },
    offsetIndex,
    columnCardinality,
  };
}

// --- Offset Index Persistence ---

export async function writeOffsetIndex(backend: StorageBackend, offsetIndex: Map<string, OffsetEntry>): Promise<void> {
  const entries: Record<string, OffsetEntry> = {};
  for (const [id, entry] of offsetIndex) entries[id] = entry;
  await backend.writeBlob("indexes/offset-index.json", Buffer.from(JSON.stringify({ version: 1, entries })));
}

export async function readOffsetIndex(backend: StorageBackend): Promise<Map<string, OffsetEntry>> {
  try {
    const buf = await backend.readBlob("indexes/offset-index.json");
    const data = JSON.parse(buf.toString("utf-8")) as { entries: Record<string, OffsetEntry> };
    return new Map(Object.entries(data.entries));
  } catch {
    return new Map();
  }
}

// --- Compaction Metadata ---

export interface CompactionMeta {
  lastTimestamp: string;
  parquetFile: string;
  /** JSONL record store for point lookups. */
  jsonlFile?: string;
  rowCount: number;
  rowGroups: number;
  /** Cardinality per extracted column. Used to decide in-memory vs Parquet-only index. */
  columnCardinality?: Record<string, number>;
}

export async function writeCompactionMeta(backend: StorageBackend, meta: CompactionMeta): Promise<void> {
  await backend.writeBlob("meta/compaction.json", Buffer.from(JSON.stringify(meta)));
}

export async function readCompactionMeta(backend: StorageBackend): Promise<CompactionMeta | null> {
  try {
    const buf = await backend.readBlob("meta/compaction.json");
    const meta = JSON.parse(buf.toString("utf-8")) as CompactionMeta;
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

/** Helper: read a Parquet file as ArrayBuffer via backend. */
export async function readParquetBuffer(backend: StorageBackend, parquetPath: string): Promise<ArrayBuffer> {
  const buf = await backend.readBlob(parquetPath);
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return ab;
}

/** Create an AsyncBuffer from an ArrayBuffer. */
function asyncBufferFrom(ab: ArrayBuffer) {
  return { byteLength: ab.byteLength, slice: (start: number, end?: number) => Promise.resolve(ab.slice(start, end)) };
}

/** Helper: get AsyncBuffer — use cached buffer if provided, otherwise read from backend. */
async function getAsyncBuffer(backend: StorageBackend, parquetPath: string, cached?: ArrayBuffer) {
  const ab = cached ?? await readParquetBuffer(backend, parquetPath);
  return asyncBufferFrom(ab);
}

/**
 * Read all records from a Parquet file.
 */
export async function readAllFromParquet(backend: StorageBackend, parquetPath: string, cached?: ArrayBuffer): Promise<Map<string, Record<string, unknown>>> {
  const file = await getAsyncBuffer(backend, parquetPath, cached);
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
  backend: StorageBackend,
  parquetPath: string,
  ids: string[],
  offsetIndex: Map<string, OffsetEntry>,
  rowGroupSize: number,
  cached?: ArrayBuffer,
): Promise<Map<string, Record<string, unknown>>> {
  if (ids.length === 0) return new Map();

  const file = await getAsyncBuffer(backend, parquetPath, cached);
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
export async function getParquetMetadata(backend: StorageBackend, parquetPath: string, cached?: ArrayBuffer): Promise<FileMetaData> {
  const ab = cached ?? await readParquetBuffer(backend, parquetPath);
  return parquetMetadata(ab);
}

/**
 * Count records matching a simple equality filter by reading only the target column.
 * Skips _data deserialization entirely.
 * Returns null if the column doesn't exist in the Parquet file.
 */
export async function countByColumn(
  backend: StorageBackend,
  parquetPath: string,
  field: string,
  value: unknown,
  cached?: ArrayBuffer,
): Promise<number | null> {
  const ab = cached ?? await readParquetBuffer(backend, parquetPath);
  const metadata = parquetMetadata(ab);
  const columns = metadata.row_groups[0]?.columns.map(
    (c) => c.meta_data?.path_in_schema?.[0],
  ) ?? [];
  if (!columns.includes(field)) return null;

  const file = { byteLength: ab.byteLength, slice: (start: number, end?: number) => Promise.resolve(ab.slice(start, end)) };
  const rows = await parquetReadObjects({ file, columns: [field] }) as Array<Record<string, unknown>>;
  let count = 0;
  for (const row of rows) {
    if (row[field] === value) count++;
  }
  return count;
}

/**
 * Read only specific columns from Parquet (no _data deserialization).
 * Returns null if the column doesn't exist.
 */
export async function scanColumn(
  backend: StorageBackend,
  parquetPath: string,
  field: string,
  predicate: (value: unknown) => boolean,
  cached?: ArrayBuffer,
): Promise<string[] | null> {
  const ab = cached ?? await readParquetBuffer(backend, parquetPath);
  const metadata = parquetMetadata(ab);
  const columns = metadata.row_groups[0]?.columns.map(
    (c) => c.meta_data?.path_in_schema?.[0],
  ) ?? [];
  if (!columns.includes(field)) return null;

  const file = { byteLength: ab.byteLength, slice: (start: number, end?: number) => Promise.resolve(ab.slice(start, end)) };
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
export async function cleanupOldParquetFiles(backend: StorageBackend, keepFile: string): Promise<void> {
  try {
    const files = await backend.listBlobs("data");
    for (const f of files) {
      if (f.endsWith(".parquet") && `data/${f}` !== keepFile) {
        await backend.deleteBlob(`data/${f}`);
      }
    }
  } catch {
    // data dir may not exist yet
  }
}

// --- JSONL Record Store ---

export interface RecordOffsetEntry {
  offset: number;
  length: number;
}

/**
 * Write a JSONL record store alongside Parquet.
 * One JSON object per line, newline-terminated. Returns byte-offset index.
 */
export async function writeRecordStore(
  backend: StorageBackend,
  records: Iterable<[string, Record<string, unknown>]> | AsyncIterable<[string, Record<string, unknown>]>,
): Promise<{ path: string; offsetIndex: Map<string, RecordOffsetEntry> }> {
  const filename = `records-${Date.now()}.jsonl`;
  const relativePath = `data/${filename}`;

  const offsetIndex = new Map<string, RecordOffsetEntry>();
  const chunks: Buffer[] = [];
  let offset = 0;

  for await (const [id, record] of records) {
    const line = JSON.stringify(record);
    const lineBytes = Buffer.byteLength(line, "utf-8");
    offsetIndex.set(id, { offset, length: lineBytes });
    chunks.push(Buffer.from(line + "\n", "utf-8"));
    offset += lineBytes + 1;
  }

  await backend.writeBlob(relativePath, Buffer.concat(chunks));
  return { path: relativePath, offsetIndex };
}

/**
 * Read a single record from JSONL by byte offset.
 */
export async function readRecordByOffset(
  backend: StorageBackend,
  jsonlPath: string,
  entry: RecordOffsetEntry,
): Promise<Record<string, unknown>> {
  const buf = await backend.readBlobRange(jsonlPath, entry.offset, entry.length);
  return JSON.parse(buf.toString("utf-8"));
}

/**
 * Read multiple records from JSONL by byte offsets. Batched.
 */
export async function readRecordsByOffsets(
  backend: StorageBackend,
  jsonlPath: string,
  entries: Array<{ id: string; entry: RecordOffsetEntry }>,
): Promise<Map<string, Record<string, unknown>>> {
  const results = new Map<string, Record<string, unknown>>();
  // Parallel reads for better S3 latency (sequential for filesystem is fine too)
  await Promise.all(entries.map(async ({ id, entry }) => {
    const record = await readRecordByOffset(backend, jsonlPath, entry);
    results.set(id, record);
  }));
  return results;
}

/**
 * Read all records from JSONL file sequentially.
 */
export async function readAllFromJsonl(
  backend: StorageBackend,
  jsonlPath: string,
): Promise<Map<string, Record<string, unknown>>> {
  const buf = await backend.readBlob(jsonlPath);
  const content = buf.toString("utf-8");
  const records = new Map<string, Record<string, unknown>>();
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as Record<string, unknown>;
    records.set(record._id as string, record);
  }
  return records;
}

/**
 * Write record offset index to storage.
 */
export async function writeRecordOffsetIndex(
  backend: StorageBackend,
  offsetIndex: Map<string, RecordOffsetEntry>,
): Promise<void> {
  const entries: Record<string, RecordOffsetEntry> = {};
  for (const [id, entry] of offsetIndex) entries[id] = entry;
  await backend.writeBlob("indexes/record-offsets.json", Buffer.from(JSON.stringify({ version: 2, entries })));
}

/**
 * Read record offset index from storage.
 */
export async function readRecordOffsetIndex(
  backend: StorageBackend,
): Promise<Map<string, RecordOffsetEntry>> {
  try {
    const buf = await backend.readBlob("indexes/record-offsets.json");
    const data = JSON.parse(buf.toString("utf-8")) as { entries: Record<string, RecordOffsetEntry> };
    return new Map(Object.entries(data.entries));
  } catch {
    return new Map();
  }
}

/**
 * Clean up old JSONL record store files (keeps only the specified file).
 */
export async function cleanupOldJsonlFiles(backend: StorageBackend, keepFile: string): Promise<void> {
  try {
    const files = await backend.listBlobs("data");
    for (const f of files) {
      if (f.endsWith(".jsonl") && `data/${f}` !== keepFile) {
        await backend.deleteBlob(`data/${f}`);
      }
    }
  } catch {
    // data dir may not exist yet
  }
}
