import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Store } from "@backloghq/opslog";
import type { StorageBackend } from "@backloghq/opslog";
import { Collection } from "./collection.js";
import type { CollectionOptions } from "./collection.js";
import type { EmbeddingConfig, EmbeddingProvider } from "./embeddings/index.js";
import { resolveProvider } from "./embeddings/index.js";
import { PermissionManager } from "./permissions.js";
import type { AgentPermissions } from "./permissions.js";
import { MemoryMonitor } from "./memory.js";
import type { MemoryStats } from "./memory.js";

const META_DIR = "meta";
const COLLECTIONS_DIR = "collections";
const DROPPED_PREFIX = "_dropped_";
const VALID_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

function validateCollectionName(name: string): void {
  if (!name || !VALID_NAME_RE.test(name) || name.includes("..")) {
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
  /** Write mode: "immediate" (default, safe for multi-writer) or "group" (~12x faster, single-writer only). */
  writeMode?: "immediate" | "group";
  /** Group commit: flush after N ops (default: 50). */
  groupCommitSize?: number;
  /** Group commit: flush after N ms (default: 100). */
  groupCommitMs?: number;
}

export interface CollectionInfo {
  name: string;
  recordCount: number;
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
  private collectionListeners: Map<string, () => void> = new Map();
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
    this.memoryMonitor.updateEstimate(name, stats.activeRecords, stats.activeRecords * 500);
  }

  /** Get the configured embedding provider, or null if none. */
  getEmbeddingProvider(): EmbeddingProvider | null {
    return this.embeddingProvider;
  }

  /** Initialize the database directory and load metadata. */
  async init(): Promise<void> {
    await mkdir(join(this.dir, META_DIR), { recursive: true });
    await mkdir(join(this.dir, COLLECTIONS_DIR), { recursive: true });
    this.meta = await this.readMeta();
    this._opened = true;
  }

  /**
   * Get or create a named collection.
   * Lazy-opens the underlying opslog store on first access.
   * Evicts least-recently-used collections when the limit is reached.
   */
  async collection(name: string, colOpts?: CollectionOptions): Promise<Collection> {
    this.ensureOpen();
    validateCollectionName(name);

    // Store collection options for future reopens (LRU eviction + reopen)
    if (colOpts) this.collectionOpts.set(name, colOpts);

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
    // Evict if at limit
    if (this.open.size >= this.opts.maxOpenCollections) {
      await this.evictLru();
    }

    const colDir = join(this.dir, COLLECTIONS_DIR, name);
    await mkdir(colDir, { recursive: true });

    const store = new Store<Record<string, unknown>>();
    const col = new Collection(name, store, this.collectionOpts.get(name));
    if (this.embeddingProvider) {
      col.setEmbeddingProvider(this.embeddingProvider);
    }
    await col.open(colDir, {
      checkpointThreshold: this.opts.checkpointThreshold,
      backend: this.opts.backend,
      agentId: this.opts.agentId,
      writeMode: this.opts.writeMode,
      groupCommitSize: this.opts.groupCommitSize,
      groupCommitMs: this.opts.groupCommitMs,
    });

    this.open.set(name, col);
    this.touchLru(name);

    // Track memory usage + store listener for cleanup on eviction
    this.trackMemory(name, col);
    const listener = () => this.trackMemory(name, col);
    col.on("change", listener);
    this.collectionListeners.set(name, listener);

    // Track in meta if new
    if (!this.meta.collections.includes(name)) {
      this.meta.collections.push(name);
      await this.writeMeta();
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

    // Close if open
    const existing = this.open.get(name);
    if (existing) {
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
  }

  /** List all active collections with record counts. */
  async listCollections(): Promise<CollectionInfo[]> {
    this.ensureOpen();
    const infos: CollectionInfo[] = [];
    for (const name of this.meta.collections) {
      const col = await this.collection(name);
      infos.push({ name, recordCount: col.count() });
    }
    return infos;
  }

  /** List soft-deleted collection names. */
  listDropped(): string[] {
    this.ensureOpen();
    return [...this.meta.dropped];
  }

  /** Database-level stats. */
  async stats(): Promise<{ collections: number; totalRecords: number }> {
    this.ensureOpen();
    let totalRecords = 0;
    for (const name of this.meta.collections) {
      const col = await this.collection(name);
      totalRecords += col.count();
    }
    return { collections: this.meta.collections.length, totalRecords };
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
      data.collections[name] = { records: col.findAll() };
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
          if (!col.findOne(id)) {
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
    for (const col of this.open.values()) {
      await col.close();
    }
    this.open.clear();
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
    const tmpPath = metaPath + ".tmp";
    await writeFile(tmpPath, JSON.stringify(this.meta, null, 2), "utf-8");
    await rename(tmpPath, metaPath);
  }

  private ensureOpen(): void {
    if (!this._opened) throw new Error("AgentDB is not initialized. Call init() first.");
  }
}
