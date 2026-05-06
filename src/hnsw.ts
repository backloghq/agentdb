/**
 * HNSW (Hierarchical Navigable Small World) index for approximate nearest neighbor search.
 * Pure TypeScript implementation.
 */

import { cosineSimilarity } from "./embeddings/quantize.js";

/** Max-heap for efficient extract-max in HNSW search queue. */
class MaxHeap {
  private heap: SearchCandidate[] = [];

  get size(): number { return this.heap.length; }

  insert(item: SearchCandidate): void {
    this.heap.push(item);
    this.bubbleUp(this.heap.length - 1);
  }

  extractMax(): SearchCandidate | null {
    if (this.heap.length === 0) return null;
    const max = this.heap[0];
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.bubbleDown(0);
    }
    return max;
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.heap[i].distance <= this.heap[parent].distance) break;
      [this.heap[i], this.heap[parent]] = [this.heap[parent], this.heap[i]];
      i = parent;
    }
  }

  private bubbleDown(i: number): void {
    const n = this.heap.length;
    while (true) {
      let largest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && this.heap[left].distance > this.heap[largest].distance) largest = left;
      if (right < n && this.heap[right].distance > this.heap[largest].distance) largest = right;
      if (largest === i) break;
      [this.heap[i], this.heap[largest]] = [this.heap[largest], this.heap[i]];
      i = largest;
    }
  }
}

export interface HnswOptions {
  /** Max connections per node per layer (default: 16). */
  M?: number;
  /** Search width during construction (default: 200). */
  efConstruction?: number;
  /** Search width during queries (default: 50). */
  efSearch?: number;
  /** Vector dimensions. */
  dimensions: number;
  /** Maximum HNSW layer a node can be assigned to (default: derived as max(16, floor(log(1e6)/log(M)))). */
  maxLevel?: number;
  /**
   * PRNG seed for deterministic layer assignment. When set, `randomLevel()` uses
   * mulberry32 instead of `Math.random`, producing the same layer assignments for
   * the same insert order across processes. Omit for the previous un-seeded behaviour.
   * Note: insert ORDER still affects graph topology — deterministic results require
   * both a fixed seed AND a deterministic insert sequence.
   */
  seed?: number;
  /**
   * Persist the full HNSW graph every N additions. When set, Collection performs an async
   * full-graph flush to `hnsw/graph.bin` after every `persistEvery` calls to `add()` from
   * user-facing embedding paths. Bounds crash exposure to at most `persistEvery` un-persisted
   * records. Default `undefined` — flush only on `close()` (v2.1.1 behavior).
   *
   * Trade-off: write amplification. Each flush rewrites the ENTIRE graph. At 1M nodes with
   * `persistEvery=1000`, a 1k-record batch causes 1k full-graph rewrites; set higher for large
   * graphs (e.g. `persistEvery: 100_000`) to amortize cost. Leave unset for batch ingest where
   * a single final `close()` is sufficient.
   */
  persistEvery?: number;
}

interface HnswNode {
  id: string;
  vector: number[];
  layer: number;
  neighbors: Map<number, string[]>; // layer → neighbor IDs
}

interface SearchCandidate {
  id: string;
  distance: number;
}

// --- Serialization helpers ---

const HNSW_MAGIC = 0x484E5347; // "HNSG"
const HNSW_FORMAT_VERSION = 1;

class BufWriter {
  private chunks: Buffer[] = [];
  private _byteLength = 0;

  writeU32(v: number): void {
    const b = Buffer.allocUnsafe(4);
    b.writeUInt32LE(v, 0);
    this.chunks.push(b);
    this._byteLength += 4;
  }

  writeBytes(data: Buffer): void {
    this.chunks.push(data);
    this._byteLength += data.length;
  }

  /** Write a length-prefixed UTF-8 string (u32 byteLen + bytes). */
  writeString(s: string): void {
    const b = Buffer.from(s, "utf8");
    this.writeU32(b.length);
    this.writeBytes(b);
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks, this._byteLength);
  }
}

class BufReader {
  private offset = 0;
  constructor(private buf: Buffer) {}

  readU32(): number {
    if (this.offset + 4 > this.buf.length) throw new Error("HNSW graph.bin truncated");
    const v = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  readBytes(len: number): Buffer {
    if (this.offset + len > this.buf.length) throw new Error("HNSW graph.bin truncated");
    const v = this.buf.subarray(this.offset, this.offset + len);
    this.offset += len;
    return v;
  }

  /** Read a length-prefixed UTF-8 string. */
  readString(): string {
    const len = this.readU32();
    return this.readBytes(len).toString("utf8");
  }
}

/**
 * HNSW index for approximate nearest neighbor search using cosine similarity.
 */
/** mulberry32 — fast, well-distributed 32-bit PRNG suitable for HNSW level generation. */
function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class HnswIndex {
  private M: number;
  private efConstruction: number;
  private efSearch: number;
  private dimensions: number;
  private nodes = new Map<string, HnswNode>();
  private entryPoint: string | null = null;
  private maxLayer = 0;
  private mL: number; // normalization factor for level generation
  private maxLevelCap: number;
  private rng: () => number;

  constructor(opts: HnswOptions) {
    this.M = opts.M ?? 16;
    this.efConstruction = opts.efConstruction ?? 200;
    this.efSearch = opts.efSearch ?? 50;
    this.dimensions = opts.dimensions;
    this.mL = 1 / Math.log(this.M);
    this.maxLevelCap = opts.maxLevel ?? Math.max(16, Math.floor(Math.log(1e6) / Math.log(this.M)));
    this.rng = opts.seed !== undefined ? mulberry32(opts.seed) : () => Math.random();
  }

  /** Number of indexed vectors. */
  get size(): number {
    return this.nodes.size;
  }

  /** Vector dimensions. */
  get dims(): number {
    return this.dimensions;
  }

  /** Highest layer currently occupied in the index (0-indexed). Reflects the max level assigned to any node. */
  get currentMaxLayer(): number {
    return this.maxLayer;
  }

  /** Max connections per node per layer as configured (default: 16). */
  get configM(): number { return this.M; }

  /** Search width used during construction as configured (default: 200). */
  get configEfConstruction(): number { return this.efConstruction; }

  /** Search width used during queries as configured (default: 50). */
  get configEfSearch(): number { return this.efSearch; }

  /** Maximum layer cap as configured (default: derived as max(16, floor(log(1e6)/log(M)))). */
  get configMaxLevel(): number { return this.maxLevelCap; }

  /** Add a vector to the index. */
  add(id: string, vector: number[]): void {
    if (vector.length !== this.dimensions) {
      throw new Error(`Vector dimension mismatch: expected ${this.dimensions}, got ${vector.length}`);
    }

    // Remove old entry if re-indexing
    if (this.nodes.has(id)) {
      this.remove(id);
    }

    const level = this.randomLevel();
    const node: HnswNode = {
      id,
      vector,
      layer: level,
      neighbors: new Map(),
    };

    // Initialize neighbor lists for all layers
    for (let l = 0; l <= level; l++) {
      node.neighbors.set(l, []);
    }

    this.nodes.set(id, node);

    if (this.entryPoint === null) {
      // First node
      this.entryPoint = id;
      this.maxLayer = level;
      return;
    }

    // Find entry point and greedily descend from top layer
    let currId = this.entryPoint;

    // Greedy search from top to level+1
    for (let l = this.maxLayer; l > level; l--) {
      currId = this.greedyClosest(vector, currId, l);
    }

    // For each layer from level down to 0, find neighbors and connect
    for (let l = Math.min(level, this.maxLayer); l >= 0; l--) {
      const candidates = this.searchLayer(vector, currId, this.efConstruction, l);
      const neighbors = this.selectNeighbors(candidates, this.M);

      node.neighbors.set(l, neighbors.map((c) => c.id));

      // Add bidirectional connections
      for (const neighbor of neighbors) {
        const neighborNode = this.nodes.get(neighbor.id);
        if (!neighborNode) continue;
        const nNeighbors = neighborNode.neighbors.get(l) ?? [];
        nNeighbors.push(id);

        // Prune if too many connections
        if (nNeighbors.length > this.M) {
          const scored = nNeighbors.map((nid) => ({
            id: nid,
            distance: this.distance(neighborNode.vector, this.nodes.get(nid)!.vector),
          }));
          scored.sort((a, b) => b.distance - a.distance); // highest similarity first
          neighborNode.neighbors.set(l, scored.slice(0, this.M).map((s) => s.id));
        } else {
          neighborNode.neighbors.set(l, nNeighbors);
        }
      }

      if (candidates.length > 0) {
        currId = candidates[0].id;
      }
    }

    // Update entry point if new node has higher layer
    if (level > this.maxLayer) {
      this.entryPoint = id;
      this.maxLayer = level;
    }
  }

  /** Remove a vector from the index. */
  remove(id: string): void {
    const node = this.nodes.get(id);
    if (!node) return;

    // Remove from all neighbors' neighbor lists
    for (const [layer, neighbors] of node.neighbors) {
      for (const neighborId of neighbors) {
        const neighborNode = this.nodes.get(neighborId);
        if (!neighborNode) continue;
        const nNeighbors = neighborNode.neighbors.get(layer);
        if (nNeighbors) {
          neighborNode.neighbors.set(layer, nNeighbors.filter((n) => n !== id));
        }
      }
    }

    this.nodes.delete(id);

    // Update entry point if we removed it
    if (this.entryPoint === id) {
      if (this.nodes.size === 0) {
        this.entryPoint = null;
        this.maxLayer = 0;
      } else {
        // Find the node with the highest layer
        let best: HnswNode | null = null;
        for (const n of this.nodes.values()) {
          if (!best || n.layer > best.layer) best = n;
        }
        this.entryPoint = best!.id;
        this.maxLayer = best!.layer;
      }
    }
  }

  /** Search for k nearest neighbors. Returns results sorted by similarity (highest first). */
  search(query: number[], k: number): Array<{ id: string; score: number }> {
    if (this.entryPoint === null || this.nodes.size === 0) return [];
    if (query.length !== this.dimensions) {
      throw new Error(`Query dimension mismatch: expected ${this.dimensions}, got ${query.length}`);
    }

    let currId = this.entryPoint;

    // Greedy descend from top layer to layer 1
    for (let l = this.maxLayer; l > 0; l--) {
      currId = this.greedyClosest(query, currId, l);
    }

    // Search at layer 0 with efSearch width
    const candidates = this.searchLayer(query, currId, Math.max(this.efSearch, k), 0);

    return candidates
      .slice(0, k)
      .map((c) => ({ id: c.id, score: c.distance }));
  }

  // --- Persistence ---

  /**
   * Serialize the graph topology to a Buffer (vectors are NOT included — they live in records).
   * Binary format: fixed header + per-node rows. See HNSW_FORMAT_VERSION for the schema.
   */
  toBuffer(): Buffer {
    const w = new BufWriter();
    w.writeU32(HNSW_MAGIC);
    w.writeU32(HNSW_FORMAT_VERSION);
    w.writeU32(this.M);
    w.writeU32(this.dimensions);
    w.writeU32(this.maxLayer);
    // Entry point: length-prefixed string (0 bytes if null)
    if (this.entryPoint) {
      w.writeString(this.entryPoint);
    } else {
      w.writeU32(0);
    }
    w.writeU32(this.nodes.size);
    for (const [id, node] of this.nodes) {
      w.writeString(id);
      w.writeU32(node.layer); // top layer for this node
      for (let l = 0; l <= node.layer; l++) {
        const nb = node.neighbors.get(l) ?? [];
        w.writeU32(nb.length);
        for (const nbId of nb) {
          w.writeString(nbId);
        }
      }
    }
    return w.toBuffer();
  }

  /**
   * Deserialize a graph from a Buffer produced by `toBuffer()`.
   * Validates magic, format-version, M, and dimensions against `opts`.
   * Throws on any mismatch or truncation.
   * Returned nodes have `vector: []` — call `hydrateVector` for each node before searching.
   */
  static fromBuffer(buf: Buffer, opts: HnswOptions): { idx: HnswIndex; nodeCount: number } {
    const r = new BufReader(buf);
    const magic = r.readU32();
    if (magic !== HNSW_MAGIC) throw new Error(`HNSW graph.bin: magic mismatch (got 0x${magic.toString(16)})`);
    const version = r.readU32();
    if (version !== HNSW_FORMAT_VERSION) throw new Error(`HNSW graph.bin: unsupported format version ${version}`);
    const storedM = r.readU32();
    const expectedM = opts.M ?? 16;
    if (storedM !== expectedM) throw new Error(`HNSW graph.bin: M mismatch (file=${storedM}, opts=${expectedM})`);
    const storedDims = r.readU32();
    if (storedDims !== opts.dimensions) throw new Error(`HNSW graph.bin: dimensions mismatch (file=${storedDims}, opts=${opts.dimensions})`);
    const maxLayer = r.readU32();
    const epLen = r.readU32();
    const entryPoint = epLen > 0 ? r.readBytes(epLen).toString("utf8") : null;
    const nodeCount = r.readU32();

    const idx = new HnswIndex(opts);
    // Set topology fields directly (static method of same class can access private members)
    idx.maxLayer = maxLayer;
    idx.entryPoint = entryPoint;

    for (let i = 0; i < nodeCount; i++) {
      const id = r.readString();
      const topLayer = r.readU32();
      const neighbors = new Map<number, string[]>();
      for (let l = 0; l <= topLayer; l++) {
        const nbCount = r.readU32();
        const nb: string[] = [];
        for (let j = 0; j < nbCount; j++) nb.push(r.readString());
        neighbors.set(l, nb);
      }
      idx.nodes.set(id, { id, vector: [], layer: topLayer, neighbors });
    }
    return { idx, nodeCount };
  }

  /**
   * Set the vector for a node that was deserialized without one.
   * Used during graph loading to hydrate topology from stored embeddings.
   * Returns false if the id is not in this index.
   */
  hydrateVector(id: string, vector: number[]): boolean {
    const node = this.nodes.get(id);
    if (!node) return false;
    node.vector = vector;
    return true;
  }

  // --- Internal ---

  private distance(a: number[], b: number[]): number {
    return cosineSimilarity(a, b);
  }

  private randomLevel(): number {
    // Standard HNSW level generation: floor(-ln(uniform) * mL)
    return Math.min(Math.floor(-Math.log(this.rng()) * this.mL), this.maxLevelCap);
  }

  /** Greedy search at a layer: find the single closest node. */
  private greedyClosest(query: number[], startId: string, layer: number): string {
    let bestId = startId;
    let bestDist = this.distance(query, this.nodes.get(startId)!.vector);

    let improved = true;
    while (improved) {
      improved = false;
      const node = this.nodes.get(bestId);
      if (!node) break;
      const neighbors = node.neighbors.get(layer) ?? [];
      for (const neighborId of neighbors) {
        const neighborNode = this.nodes.get(neighborId);
        if (!neighborNode) continue;
        const dist = this.distance(query, neighborNode.vector);
        if (dist > bestDist) {
          bestDist = dist;
          bestId = neighborId;
          improved = true;
        }
      }
    }

    return bestId;
  }

  /** Binary insert into descending-sorted candidates array. O(log n) find + O(n) splice. */
  private candidateInsert(arr: SearchCandidate[], item: SearchCandidate, maxLen: number): void {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid].distance > item.distance) lo = mid + 1;
      else hi = mid;
    }
    arr.splice(lo, 0, item);
    if (arr.length > maxLen) arr.pop();
  }

  /** Search a single layer with beam width ef. Returns candidates sorted by distance (descending = most similar first). */
  private searchLayer(query: number[], startId: string, ef: number, layer: number): SearchCandidate[] {
    const visited = new Set<string>();
    const candidates: SearchCandidate[] = [];
    const startDist = this.distance(query, this.nodes.get(startId)!.vector);

    candidates.push({ id: startId, distance: startDist });
    visited.add(startId);

    // MaxHeap for exploration queue — always explore highest-similarity node next
    const queue = new MaxHeap();
    queue.insert({ id: startId, distance: startDist });

    while (queue.size > 0) {
      const current = queue.extractMax()!;

      // If worst candidate is better than current exploration node, stop
      if (candidates.length >= ef) {
        if (current.distance < candidates[candidates.length - 1].distance) break;
      }

      const node = this.nodes.get(current.id);
      if (!node) continue;
      const neighbors = node.neighbors.get(layer) ?? [];

      for (const neighborId of neighbors) {
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);

        const neighborNode = this.nodes.get(neighborId);
        if (!neighborNode) continue;

        const dist = this.distance(query, neighborNode.vector);
        const candidate = { id: neighborId, distance: dist };

        if (candidates.length < ef || dist > candidates[candidates.length - 1].distance) {
          this.candidateInsert(candidates, candidate, ef);
          queue.insert(candidate);
        }
      }
    }

    return candidates;
  }

  /** Select the best M neighbors from candidates. */
  private selectNeighbors(candidates: SearchCandidate[], m: number): SearchCandidate[] {
    return candidates.slice(0, m);
  }
}
