import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Store } from "@backloghq/opslog";
import type { StorageBackend } from "@backloghq/opslog";
import { Collection } from "./collection.js";
import type { CollectionOptions } from "./collection.js";
import type { EmbeddingConfig, EmbeddingProvider } from "./embeddings/index.js";
import { resolveProvider } from "./embeddings/index.js";
import { PermissionManager } from "./permissions.js";
import type { AgentPermissions } from "./permissions.js";
import type { CollectionSchema, PersistedSchema } from "./schema.js";
import { extractPersistedSchema, validatePersistedSchema, mergeSchemas, mergePersistedSchemas } from "./schema.js";
import { MemoryMonitor } from "./memory.js";
import type { MemoryStats } from "./memory.js";
import { DiskStore } from "./disk-store.js";

const META_DIR = "meta";

/** Key-sorted JSON serialization for structural equality checks independent of key order. */
function canonicalJSON(val: unknown): string {
  if (val === null || typeof val !== "object") return JSON.stringify(val);
  if (Array.isArray(val)) return "[" + (val as unknown[]).map(canonicalJSON).join(",") + "]";
  const keys = Object.keys(val as object).sort();
  return "{" + keys.map(k => `${JSON.stringify(k)}:${canonicalJSON((val as Record<string, unknown>)[k])}`).join(",") + "}";
}
const COLLECTIONS_DIR = "collections";
const DROPPED_PREFIX = "_dropped_";
const VALID_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

function validateCollectionName(name: string): void {
  if (!name || !VALID_NAME_RE.test(name)) {
    throw new Error(`Invalid collection name '${name}'. Must be alphanumeric with hyphens/underscores, no path traversal.`);
  }
}

export interface AgentDBOptions {
  /** Max number of collections open at once (default: 20). */
  maxOpenCollections?: number;
  /** Checkpoint threshold passed to opslog stores (default: 100). */
  checkpointThreshold?: number;
  /** Embedding provider configuration for semantic search. */
  embeddings?: EmbeddingConfig;
  /** Per-agent permission rules. Keys are agent IDs. */
  permissions?: Record<string, Partial<AgentPermissions>>;
  /** Custom storage backend for opslog (default: FsBackend — filesystem). */
  backend?: StorageBackend;
  /** Agent ID for multi-writer mode. Enables per-agent WAL streams. */
  agentId?: string;
  /** Memory budget in bytes. Warns when collections exceed this total. 0 = unlimited. */
  memoryBudget?: number;
  /** Write mode: "immediate" (default, safe for multi-writer), "group" (~12x faster), or "async" (~50x faster, data lost on crash). Single-writer only for group/async. */
  writeMode?: "immediate" | "group" | "async";
  /** Group commit: flush after N ops (default: 50). */
  groupCommitSize?: number;
  /** Group commit: flush after N ms (default: 100). */
  groupCommitMs?: number;
  /** Open in read-only mode. Skips write locks, rejects mutations. Safe to run alongside a writer. */
  readOnly?: boolean;
  /** Storage mode: "memory" (default, all records in RAM), "disk" (Parquet-backed with LRU cache), "auto" (switch to disk when record count exceeds diskThreshold). */
  storageMode?: "memory" | "disk" | "auto";
  /** Record count threshold for auto mode (default: 10000). */
  diskThreshold?: number;
  /** LRU cache size for disk mode (max records, default: 10000). */
  cacheSize?: number;
  /** Parquet row group size for disk mode (default: 5000). */
  rowGroupSize?: number;
}

export interface CollectionInfo {
  name: string;
  recordCount: number;
}

export interface SchemaLoadResult {
  /** Number of schema files that resulted in a persisted schema change. */
  loaded: number;
  /**
   * Number of files that were valid but produced no change — either because no
   * valid collection name could be derived, or because the merged result was
   * byte-identical to the already-persisted schema (true no-op).
   */
  skipped: number;
  /** Files that could not be loaded due to parse or validation errors. */
  failed: Array<{ path: string; error: string }>;
}

export interface ExportData {
  version: number;
  exportedAt: string;
  collections: Record<string, { records: Record<string, unknown>[] }>;
}

interface MetaManifest {
  collections: string[];
  dropped: string[];
}

/**
 * Top-level database managing multiple named collections.
 * Collections are lazy-loaded and evicted via LRU when the limit is reached.
 */
export class AgentDB {
  readonly dir: string;
  private opts: Required<Pick<AgentDBOptions, "maxOpenCollections" | "checkpointThreshold">> & Partial<AgentDBOptions>;
  private open: Map<string, Collection> = new Map();
  private opening: Map<string, Promise<Collection>> = new Map();
  private collectionOpts: Map<string, CollectionOptions> = new Map();
  private schemas: Map<string, CollectionSchema> = new Map();
  private collectionListeners: Map<string, (event: import("./collection.js").ChangeEvent) => void> = new Map();
  private embeddingProvider: EmbeddingProvider | null = null;
  private permissions: PermissionManager;
  private memoryMonitor: MemoryMonitor;
  private lru: string[] = []; // Most recently used at end
  private meta: MetaManifest = { collections: [], dropped: [] };
  private _opened = false;

  constructor(dir: string, opts?: AgentDBOptions) {
    this.dir = dir;
    this.opts = {
      maxOpenCollections: opts?.maxOpenCollections ?? 20,
      checkpointThreshold: opts?.checkpointThreshold ?? 100,
      embeddings: opts?.embeddings,
      backend: opts?.backend,
      agentId: opts?.agentId,
      writeMode: opts?.writeMode,
      groupCommitSize: opts?.groupCommitSize,
      groupCommitMs: opts?.groupCommitMs,
      readOnly: opts?.readOnly,
      storageMode: opts?.storageMode,
      diskThreshold: opts?.diskThreshold,
      cacheSize: opts?.cacheSize,
      rowGroupSize: opts?.rowGroupSize,
    };
    if (opts?.embeddings) {
      this.embeddingProvider = resolveProvider(opts.embeddings);
    }
    this.permissions = new PermissionManager(opts?.permissions);
    this.memoryMonitor = new MemoryMonitor(opts?.memoryBudget ?? 0);
  }

  /** Get the permission manager. Used by tools to enforce access control. */
  getPermissions(): PermissionManager {
    return this.permissions;
  }

  /** Get memory usage stats across all open collections. */
  memoryStats(): MemoryStats {
    return this.memoryMonitor.stats();
  }

  /** Update memory tracking for a collection (lightweight — uses record count estimate). */
  private trackMemory(name: string, col: Collection): void {
    const stats = col.stats();
    // ~500 bytes per record average avoids full scan on every mutation
    const recordBytes = stats.activeRecords * 500;
    const textIndexBytes = col.getTextIndex()?.estimatedBytes() ?? 0;
    this.memoryMonitor.updateEstimate(name, stats.activeRecords, recordBytes + textIndexBytes);
  }

  /** Get the configured embedding provider, or null if none. */
  getEmbeddingProvider(): EmbeddingProvider | null {
    return this.embeddingProvider;
  }

  /** Initialize the database directory and load metadata. */
  async init(): Promise<void> {
    await mkdir(join(this.dir, META_DIR), { recursive: true });
    await mkdir(join(this.dir, COLLECTIONS_DIR), { recursive: true });

    // Remove orphaned .tmp files left by crashed persistSchema or writeMeta calls
    const metaEntries = await readdir(join(this.dir, META_DIR));
    await Promise.all(
      metaEntries
        .filter(f => f.endsWith(".tmp"))
        .map(f => rm(join(this.dir, META_DIR, f), { force: true }))
    );

    this.meta = await this.readMeta();
    this._opened = true;

    // Auto-discover schemas from <dataDir>/schemas/*.json
    const schemasDir = join(this.dir, "schemas");
    try {
      const entries = await readdir(schemasDir);
      const jsonPaths = entries
        .filter(f => f.endsWith(".json"))
        .map(f => join(schemasDir, f));
      if (jsonPaths.length > 0) {
        const result = await this.loadSchemasFromFiles(jsonPaths);
        const parts: string[] = [`loaded ${result.loaded}`];
        if (result.skipped > 0) parts.push(`skipped ${result.skipped}`);
        if (result.failed.length > 0) {
          parts.push(`failed ${result.failed.length}`);
          for (const f of result.failed) {
            console.warn(`[agentdb] schema load failed (${f.path}): ${f.error}`);
          }
        }
        console.log(`[agentdb] schemas/*.json: ${parts.join(", ")}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  /**
   * Get or create a named collection.
   * Accepts a name + options, or a CollectionSchema from defineSchema().
   */
  async collection(nameOrSchema: string | CollectionSchema, colOpts?: CollectionOptions): Promise<Collection> {
    this.ensureOpen();

    let name: string;
    let schema: CollectionSchema | undefined;

    if (typeof nameOrSchema === "string") {
      name = nameOrSchema;
    } else {
      schema = nameOrSchema;
      name = schema.name;
      colOpts = schema.collectionOptions;
    }

    validateCollectionName(name);

    // Store collection options for future reopens (LRU eviction + reopen)
    if (colOpts) this.collectionOpts.set(name, colOpts);
    if (schema) this.schemas.set(name, schema);

    // Return cached + touch LRU
    const existing = this.open.get(name);
    if (existing) {
      this.touchLru(name);
      return existing;
    }

    // If already opening (concurrent call), wait for that promise
    const pending = this.opening.get(name);
    if (pending) return pending;

    // Open and cache the promise to prevent concurrent open races
    const promise = this._openCollection(name);
    this.opening.set(name, promise);
    try {
      return await promise;
    } finally {
      this.opening.delete(name);
    }
  }

  private async _openCollection(name: string): Promise<Collection> {
    // Evict until under limit (loop handles concurrent opens that may overshoot)
    while (this.open.size >= this.opts.maxOpenCollections && this.lru.length > 0) {
      await this.evictLru();
    }

    const colDir = join(this.dir, COLLECTIONS_DIR, name);
    await mkdir(colDir, { recursive: true });

    const store = new Store<Record<string, unknown>>();
    const col = new Collection(name, store, this.collectionOpts.get(name));
    if (this.embeddingProvider) {
      col.setEmbeddingProvider(this.embeddingProvider);
    }

    // Determine storage mode for this collection
    const schema = this.schemas.get(name);
    const mode = schema?.collectionOptions?.storageMode ?? this.opts.storageMode ?? "memory";
    const useDisk = mode === "disk" ||
      (mode === "auto" && await this.shouldUseDiskMode(colDir));

    if (useDisk) {
      // Disk mode: open with skipLoad (writes only), DiskStore handles reads.
      // Disable opslog checkpoints — persistence is via JSONL + Parquet compaction on close.
      // Without this, opslog writes quadratic snapshot files (full copy every N ops).
      await col.open(colDir, {
        checkpointThreshold: Number.MAX_SAFE_INTEGER,
        checkpointOnClose: false,
        backend: this.opts.backend,
        agentId: this.opts.agentId,
        writeMode: this.opts.writeMode,
        groupCommitSize: this.opts.groupCommitSize,
        groupCommitMs: this.opts.groupCommitMs,
        readOnly: this.opts.readOnly,
        skipLoad: true,
      });

      const diskStore = new DiskStore(col.getBackend(), {
        cacheSize: this.opts.cacheSize ?? 1_000,
        rowGroupSize: this.opts.rowGroupSize ?? 5000,
        extractColumns: schema?.indexes ?? [],
      });
      await diskStore.load();

      // If no Parquet data yet, do initial compaction from snapshot
      if (!diskStore.hasParquetData) {
        const recordMap = new Map<string, Record<string, unknown>>();
        for await (const [id, record] of store.streamSnapshot()) {
          recordMap.set(id, record);
        }
        // Apply WAL ops on top of snapshot — O(1) per op via Map
        for await (const op of store.getWalOps()) {
          if (op.op === "set" && op.data) {
            recordMap.set(op.id, op.data as Record<string, unknown>);
          } else if (op.op === "delete") {
            recordMap.delete(op.id);
          }
        }
        if (recordMap.size > 0) {
          await diskStore.compact([...recordMap.entries()]);
        }
      } else {
        // Replay WAL since last compaction into DiskStore cache (skip if Parquet is fresh)
        const { readCompactionMeta } = await import("./disk-io.js");
        const compactionMeta = await readCompactionMeta(col.getBackend());
        if (compactionMeta) {
          let walOpsReplayed = 0;
          for await (const op of store.getWalOps(compactionMeta.lastTimestamp)) {
            if (op.op === "set" && op.data) {
              diskStore.cacheWrite(op.id, op.data as Record<string, unknown>);
            } else if (op.op === "delete") {
              diskStore.cacheDelete(op.id);
            }
            walOpsReplayed++;
          }
          // If no WAL ops to replay, Parquet is fresh — reset dirty flag
          if (walOpsReplayed === 0) {
            diskStore.clearCache();
          }
        }
      }

      // Load persisted indexes
      await diskStore.loadIndexes(col.getIndexManager(), col.getTextIndex());

      col.setDiskStore(diskStore);
      // Rebuild HNSW from disk embeddings if an embedding provider is configured.
      // In disk mode, open() is called with skipLoad=true so the WAL pass never
      // runs — HNSW must be reconstructed from Parquet/JSONL entries instead.
      await col.rebuildHnswFromDisk();
    } else {
      // Memory mode: normal open (load all records into Map)
      await col.open(colDir, {
        checkpointThreshold: this.opts.checkpointThreshold,
        backend: this.opts.backend,
        agentId: this.opts.agentId,
        writeMode: this.opts.writeMode,
        groupCommitSize: this.opts.groupCommitSize,
        groupCommitMs: this.opts.groupCommitMs,
        readOnly: this.opts.readOnly,
      });
    }

    // Apply schema features: auto-create indexes, init counters, register hooks
    const ds = col.getDiskStore();
    if (schema) {
      for (const field of schema.indexes) {
        // In disk mode, skip in-memory index for high-cardinality fields (use Parquet column scan instead)
        if (ds && !ds.shouldUseInMemoryIndex(field)) continue;
        col.createIndex(field);
      }
      for (const fields of schema.compositeIndexes) col.createCompositeIndex(fields);
      for (const field of schema.arrayIndexes) col.createArrayIndex(field);
      // Initialize auto-increment counters from existing records (sorted desc, limit 1)
      if (schema.autoIncrementFields.length > 0) {
        for (const field of schema.autoIncrementFields) {
          const top = await col.find({ sort: `-${field}`, limit: 1 });
          if (top.records.length > 0) {
            const val = top.records[0][field];
            if (typeof val === "number") schema.counters.set(field, val);
          }
        }
      }
      // Wrap insert to apply defaults + beforeInsert hook
      const ctx = { collection: col };
      const originalInsert = col.insert.bind(col);
      col.insert = async (doc: Record<string, unknown>, opts?) => {
        let record = schema.applyDefaults(doc);
        if (schema.hooks.beforeInsert) {
          const modified = schema.hooks.beforeInsert(record, ctx);
          if (modified) record = modified;
        }
        const id = await originalInsert(record, opts);
        if (schema.hooks.afterInsert) schema.hooks.afterInsert(id, record, ctx);
        return id;
      };
      // Wrap insertMany to apply defaults + hooks per doc
      const originalInsertMany = col.insertMany.bind(col);
      col.insertMany = async (docs, opts?) => {
        const processed = docs.map((doc) => {
          let record = schema.applyDefaults(doc);
          if (schema.hooks.beforeInsert) {
            const modified = schema.hooks.beforeInsert(record, ctx);
            if (modified) record = modified;
          }
          return record;
        });
        const ids = await originalInsertMany(processed, opts);
        if (schema.hooks.afterInsert) {
          for (let i = 0; i < ids.length; i++) {
            const record = await col.findOne(ids[i]);
            if (record) schema.hooks.afterInsert(ids[i], record, ctx);
          }
        }
        return ids;
      };
      // Wrap upsertMany to apply defaults + hooks per doc
      const originalUpsertMany = col.upsertMany.bind(col);
      col.upsertMany = async (docs, opts?) => {
        const processed = docs.map((doc) => {
          let record = schema.applyDefaults(doc);
          if (schema.hooks.beforeInsert) {
            const modified = schema.hooks.beforeInsert(record, ctx);
            if (modified) record = modified;
          }
          return record;
        });
        const results = await originalUpsertMany(processed, opts);
        if (schema.hooks.afterInsert) {
          for (const r of results) {
            if (r.action === "inserted") {
              const record = await col.findOne(r.id);
              if (record) schema.hooks.afterInsert(r.id, record, ctx);
            }
          }
        }
        return results;
      };
    }

    this.open.set(name, col);
    this.touchLru(name);

    // Track memory usage + schema hooks via single listener (cleaned up on eviction)
    this.trackMemory(name, col);
    const schemaHooks = schema?.hooks;
    const schemaCtx = schema ? { collection: col } : undefined;
    const listener = (event: import("./collection.js").ChangeEvent) => {
      this.trackMemory(name, col);
      if (schemaHooks && schemaCtx) {
        if (event.type === "update" && schemaHooks.afterUpdate) schemaHooks.afterUpdate(event.ids, schemaCtx);
        if (event.type === "delete" && schemaHooks.afterDelete) schemaHooks.afterDelete(event.ids, schemaCtx);
      }
    };
    col.on("change", listener);
    this.collectionListeners.set(name, listener);

    // Track in meta if new
    if (!this.meta.collections.includes(name)) {
      this.meta.collections.push(name);
      await this.writeMeta();
    }

    // Auto-persist schema when collection is opened with defineSchema()
    if (schema?.definition) {
      const existing = await this.loadPersistedSchema(name);
      if (!existing) {
        // First time: extract and persist
        await this.persistSchema(name, extractPersistedSchema(schema.definition));
      } else {
        // Merge code + persisted, warn on mismatches
        const { persisted: merged, warnings } = mergeSchemas(schema.definition, existing);
        for (const w of warnings) console.warn(`[AgentDB] ${w}`);
        await this.persistSchema(name, merged);
      }
    }

    return col;
  }

  /** Create a collection explicitly (idempotent). */
  async createCollection(name: string): Promise<void> {
    this.ensureOpen();
    await this.collection(name);
  }

  /**
   * Soft-delete a collection. Renames to _dropped_<name>_<ts>.
   * The collection is closed if open.
   */
  async dropCollection(name: string): Promise<void> {
    this.ensureOpen();

    // Close if open (clean up listener + memory tracking like evictLru does)
    const existing = this.open.get(name);
    if (existing) {
      const listener = this.collectionListeners.get(name);
      if (listener) existing.off("change", listener);
      this.collectionListeners.delete(name);
      this.memoryMonitor.updateEstimate(name, 0, 0);
      await existing.close();
      this.open.delete(name);
      this.removeLru(name);
    }

    const colDir = join(this.dir, COLLECTIONS_DIR, name);
    const droppedName = `${DROPPED_PREFIX}${name}_${Date.now()}`;
    const droppedDir = join(this.dir, COLLECTIONS_DIR, droppedName);

    try {
      await rename(colDir, droppedDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Collection '${name}' not found`, { cause: err });
      }
      throw err;
    }

    this.meta.collections = this.meta.collections.filter((c) => c !== name);
    this.meta.dropped.push(droppedName);
    await this.writeMeta();
    await this.deletePersistedSchema(name);
    this.schemas.delete(name);
  }

  /** Permanently delete a soft-dropped collection. */
  async purgeCollection(droppedName: string): Promise<void> {
    this.ensureOpen();
    // Exact match on full dropped name, or match by original collection name prefix
    const match = this.meta.dropped.find((d) => d === droppedName || d.startsWith(`${DROPPED_PREFIX}${droppedName}_`));
    if (!match) {
      throw new Error(`Dropped collection '${droppedName}' not found`);
    }
    const droppedDir = join(this.dir, COLLECTIONS_DIR, match);
    await rm(droppedDir, { recursive: true, force: true });
    this.meta.dropped = this.meta.dropped.filter((d) => d !== match);
    await this.writeMeta();
    // Defensively remove the schema file using the original collection name
    const originalName = match.slice(DROPPED_PREFIX.length).replace(/_\d+$/, "");
    await this.deletePersistedSchema(originalName);
  }

  /** List all active collections with record counts. */
  async listCollections(): Promise<CollectionInfo[]> {
    this.ensureOpen();
    const infos: CollectionInfo[] = [];
    for (const name of this.meta.collections) {
      const col = await this.collection(name);
      infos.push({ name, recordCount: await col.count() });
    }
    return infos;
  }

  /** Return active collection names without opening them. */
  getCollectionNames(): string[] {
    this.ensureOpen();
    return [...this.meta.collections];
  }

  /** List soft-deleted collection names. */
  listDropped(): string[] {
    this.ensureOpen();
    return [...this.meta.dropped];
  }

  // --- Schema persistence ---

  /**
   * Persist a schema for a collection. Writes to meta/{name}.schema.json.
   * Requires admin permission when called via tools (agent parameter).
   * Internal calls (auto-persist on collection open) skip the permission check.
   */
  async persistSchema(collectionName: string, schema: PersistedSchema, opts?: { agent?: string }): Promise<void> {
    this.ensureOpen();
    if (opts?.agent) this.permissions.require(opts.agent, "admin", "persistSchema");
    validateCollectionName(collectionName);
    validatePersistedSchema(schema);
    const schemaPath = join(this.dir, META_DIR, `${collectionName}.schema.json`);
    const tmpPath = `${schemaPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmpPath, JSON.stringify(schema, null, 2), "utf-8");
    try {
      await rename(tmpPath, schemaPath);
    } catch (err) {
      await rm(tmpPath, { force: true });
      throw err;
    }
  }

  /** Load the persisted schema for a collection. Returns undefined if none stored. */
  async loadPersistedSchema(collectionName: string): Promise<PersistedSchema | undefined> {
    this.ensureOpen();
    validateCollectionName(collectionName);
    const schemaPath = join(this.dir, META_DIR, `${collectionName}.schema.json`);
    try {
      const content = await readFile(schemaPath, "utf-8");
      const parsed = JSON.parse(content);
      validatePersistedSchema(parsed);
      return parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  /** Delete the persisted schema for a collection. No-op if none exists. */
  async deletePersistedSchema(collectionName: string, opts?: { agent?: string }): Promise<void> {
    this.ensureOpen();
    if (opts?.agent) this.permissions.require(opts.agent, "admin", "deletePersistedSchema");
    validateCollectionName(collectionName);
    const schemaPath = join(this.dir, META_DIR, `${collectionName}.schema.json`);
    try {
      await rm(schemaPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  /**
   * Load schemas from a list of JSON file paths into persisted storage.
   * File content acts as an overlay: file properties win per-property via mergePersistedSchemas.
   * If a file has no `name` field, the collection name is derived from the filename (without .json).
   * Per-file isolation: one bad file never blocks the rest.
   */
  async loadSchemasFromFiles(paths: string[]): Promise<SchemaLoadResult> {
    this.ensureOpen();
    let loaded = 0;
    let skipped = 0;
    const failed: Array<{ path: string; error: string }> = [];

    for (const filePath of paths) {
      const basename = filePath.replace(/\\/g, "/").split("/").pop() ?? "";
      const derivedName = basename.endsWith(".json") ? basename.slice(0, -5) : basename;

      try {
        const fileStats = await stat(filePath);
        if (fileStats.size > 10 * 1024 * 1024) {
          console.warn(`[agentdb] schema file ${filePath}: file size exceeds 10MB limit (${fileStats.size} bytes), skipping`);
          failed.push({ path: filePath, error: "file size exceeds 10MB limit" });
          continue;
        }
        const content = await readFile(filePath, "utf-8");
        let parsed: unknown;
        try {
          parsed = JSON.parse(content);
        } catch (err) {
          failed.push({ path: filePath, error: `JSON parse error: ${err instanceof Error ? err.message : String(err)}` });
          continue;
        }

        // Inject filename-derived name if absent; warn if explicit name disagrees with derived
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          const rec = parsed as Record<string, unknown>;
          if (!("name" in rec)) {
            if (!VALID_NAME_RE.test(derivedName)) {
              skipped++;
              continue;
            }
            rec.name = derivedName;
          } else if (typeof rec.name === "string" && rec.name !== derivedName) {
            console.warn(`[agentdb] schema file ${filePath}: name field "${rec.name}" disagrees with filename-derived "${derivedName}"`);
          }
        }

        try {
          validatePersistedSchema(parsed);
        } catch (err) {
          failed.push({ path: filePath, error: `Validation error: ${err instanceof Error ? err.message : String(err)}` });
          continue;
        }

        const fileSchema = parsed as PersistedSchema;

        try {
          validateCollectionName(fileSchema.name);
        } catch (err) {
          failed.push({ path: filePath, error: err instanceof Error ? err.message : String(err) });
          continue;
        }

        const existing = await this.loadPersistedSchema(fileSchema.name);
        const merged = existing ? mergePersistedSchemas(existing, fileSchema) : fileSchema;
        // Skip write when merged result is structurally identical to existing (true no-op).
        // Uses key-sorted serialization to avoid false mismatches from key-order differences.
        if (existing && canonicalJSON(merged) === canonicalJSON(existing)) {
          skipped++;
          continue;
        }
        await this.persistSchema(fileSchema.name, merged);
        loaded++;
      } catch (err) {
        failed.push({ path: filePath, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return { loaded, skipped, failed };
  }

  /** Get the in-memory schema for a collection (from defineSchema). */
  getSchema(collectionName: string): CollectionSchema | undefined {
    return this.schemas.get(collectionName);
  }

  /** Database-level stats. */
  async stats(): Promise<{ collections: number; totalRecords: number; textIndexBytes: number }> {
    this.ensureOpen();
    let totalRecords = 0;
    let textIndexBytes = 0;
    for (const name of this.meta.collections) {
      const col = await this.collection(name);
      totalRecords += await col.count();
      textIndexBytes += col.getTextIndex()?.estimatedBytes() ?? 0;
    }
    return { collections: this.meta.collections.length, totalRecords, textIndexBytes };
  }

  // --- Export / Import ---

  /** Export all (or named) collections as a self-contained JSON object. */
  async export(collections?: string[]): Promise<ExportData> {
    this.ensureOpen();
    const names = collections ?? this.meta.collections;
    const data: ExportData = {
      version: 1,
      exportedAt: new Date().toISOString(),
      collections: {},
    };
    for (const name of names) {
      const col = await this.collection(name);
      data.collections[name] = { records: await col.findAll() };
    }
    return data;
  }

  /** Import collections from export data. Skips existing records by default. */
  async import(data: ExportData, opts?: { overwrite?: boolean }): Promise<{ collections: number; records: number }> {
    this.ensureOpen();
    let totalRecords = 0;
    const colNames = Object.keys(data.collections);
    for (const name of colNames) {
      const col = await this.collection(name);
      const records = data.collections[name].records;
      for (const record of records) {
        const id = record._id as string;
        if (!id) continue;
        if (opts?.overwrite) {
          await col.upsert(id, record);
        } else {
          if (!(await col.findOne(id))) {
            await col.insert(record);
          }
        }
        totalRecords++;
      }
    }
    return { collections: colNames.length, records: totalRecords };
  }

  /** Close all open collections and write metadata. */
  async close(): Promise<void> {
    for (const [name, col] of this.open) {
      const listener = this.collectionListeners.get(name);
      if (listener) col.off("change", listener);
      // Disk mode: compact to Parquet + save indexes before closing (only if dirty)
      const ds = col.getDiskStore();
      if (ds) {
        if (ds.isDirty) {
          // Use raw records (preserves _embedding) for compaction so embeddings survive close/reopen
          const rawRecords = await col.findAllRaw();
          const mapIds = new Set(col.getStore().entries().map(([id]) => id));
          const newRecords = rawRecords.filter(([id]) => mapIds.has(id));
          await ds.compact(
            rawRecords,
            newRecords.length > 0 ? newRecords : undefined,
          );
        }
        await ds.saveIndexes(col.getIndexManager(), col.getTextIndex());
      }
      // Clean up WAL ops after close — data is safe in JSONL + Parquet
      const diskBackend = ds ? col.getBackend() : null;
      await col.close();
      if (diskBackend) {
        try {
          const ops = await diskBackend.listBlobs("ops");
          for (const f of ops) await diskBackend.deleteBlob(`ops/${f}`);
        } catch { /* best-effort cleanup */ }
      }
    }
    this.open.clear();
    this.collectionListeners.clear();
    this.lru = [];
    this._opened = false;
  }

  // --- LRU management ---

  private touchLru(name: string): void {
    this.removeLru(name);
    this.lru.push(name);
  }

  private removeLru(name: string): void {
    const idx = this.lru.indexOf(name);
    if (idx !== -1) this.lru.splice(idx, 1);
  }

  /** Check if a collection should use disk mode based on snapshot record count. */
  private async shouldUseDiskMode(colDir: string): Promise<boolean> {
    const threshold = this.opts.diskThreshold ?? 10_000;
    try {
      // Use a temporary backend to check compaction metadata
      const { FsBackend } = await import("@backloghq/opslog");
      const tmpBackend = new FsBackend();
      await tmpBackend.initialize(colDir, { readOnly: true });
      const { readCompactionMeta } = await import("./disk-io.js");
      const meta = await readCompactionMeta(tmpBackend);
      if (meta && meta.rowCount >= threshold) return true;
      // Check manifest stats for record count
      const { readFile } = await import("node:fs/promises");
      const manifest = JSON.parse(await readFile(join(colDir, "manifest.json"), "utf-8"));
      return (manifest?.stats?.activeRecords ?? 0) >= threshold;
    } catch {
      return false;
    }
  }

  private async evictLru(): Promise<void> {
    if (this.lru.length === 0) return;
    const evict = this.lru.shift()!;
    const col = this.open.get(evict);
    if (col) {
      // Remove listener before closing to prevent leak
      const listener = this.collectionListeners.get(evict);
      if (listener) col.off("change", listener);
      this.collectionListeners.delete(evict);
      await col.close();
      this.open.delete(evict);
    }
  }

  // --- Meta-manifest ---

  private async readMeta(): Promise<MetaManifest> {
    const metaPath = join(this.dir, META_DIR, "manifest.json");
    try {
      const content = await readFile(metaPath, "utf-8");
      const parsed = JSON.parse(content);
      return {
        collections: Array.isArray(parsed.collections) ? parsed.collections : [],
        dropped: Array.isArray(parsed.dropped) ? parsed.dropped : [],
      };
    } catch {
      // No manifest yet — scan directory for existing collections
      return this.scanCollections();
    }
  }

  private async scanCollections(): Promise<MetaManifest> {
    const colDir = join(this.dir, COLLECTIONS_DIR);
    try {
      const entries = await readdir(colDir);
      const collections: string[] = [];
      const dropped: string[] = [];
      for (const entry of entries) {
        if (entry.startsWith(DROPPED_PREFIX)) {
          dropped.push(entry);
        } else if (!entry.startsWith(".")) {
          collections.push(entry);
        }
      }
      return { collections, dropped };
    } catch {
      return { collections: [], dropped: [] };
    }
  }

  private async writeMeta(): Promise<void> {
    const metaPath = join(this.dir, META_DIR, "manifest.json");
    const tmpPath = `${metaPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmpPath, JSON.stringify(this.meta, null, 2), "utf-8");
    try {
      await rename(tmpPath, metaPath);
    } catch (err) {
      await rm(tmpPath, { force: true });
      throw err;
    }
  }

  private ensureOpen(): void {
    if (!this._opened) throw new Error("AgentDB is not initialized. Call init() first.");
  }
}
