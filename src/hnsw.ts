/**
 * HNSW (Hierarchical Navigable Small World) index for approximate nearest neighbor search.
 * Pure TypeScript implementation.
 */

import { cosineSimilarity } from "./embeddings/quantize.js";

export interface HnswOptions {
  /** Max connections per node per layer (default: 16). */
  M?: number;
  /** Search width during construction (default: 200). */
  efConstruction?: number;
  /** Search width during queries (default: 50). */
  efSearch?: number;
  /** Vector dimensions. */
  dimensions: number;
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

/**
 * HNSW index for approximate nearest neighbor search using cosine similarity.
 */
export class HnswIndex {
  private M: number;
  private efConstruction: number;
  private efSearch: number;
  private dimensions: number;
  private nodes = new Map<string, HnswNode>();
  private entryPoint: string | null = null;
  private maxLayer = 0;
  private mL: number; // normalization factor for level generation

  constructor(opts: HnswOptions) {
    this.M = opts.M ?? 16;
    this.efConstruction = opts.efConstruction ?? 200;
    this.efSearch = opts.efSearch ?? 50;
    this.dimensions = opts.dimensions;
    this.mL = 1 / Math.log(this.M);
  }

  /** Number of indexed vectors. */
  get size(): number {
    return this.nodes.size;
  }

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

  // --- Internal ---

  private distance(a: number[], b: number[]): number {
    return cosineSimilarity(a, b);
  }

  private randomLevel(): number {
    // Standard HNSW level generation: floor(-ln(uniform) * mL)
    return Math.min(Math.floor(-Math.log(Math.random()) * this.mL), 16);
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

  /** Search a single layer with beam width ef. Returns candidates sorted by distance (descending = most similar first). */
  private searchLayer(query: number[], startId: string, ef: number, layer: number): SearchCandidate[] {
    const visited = new Set<string>();
    const candidates: SearchCandidate[] = [];
    const startDist = this.distance(query, this.nodes.get(startId)!.vector);

    candidates.push({ id: startId, distance: startDist });
    visited.add(startId);

    // Priority queue (sorted array — simple for small ef)
    const queue: SearchCandidate[] = [{ id: startId, distance: startDist }];

    while (queue.length > 0) {
      // Take the best unexplored candidate
      const current = queue.shift()!;

      // If worst result is better than current, stop (for efficiency)
      if (candidates.length >= ef) {
        const worstCandidate = candidates[candidates.length - 1];
        if (current.distance < worstCandidate.distance) break;
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
          candidates.push(candidate);
          candidates.sort((a, b) => b.distance - a.distance); // Best first
          if (candidates.length > ef) candidates.pop();

          // Add to exploration queue
          queue.push(candidate);
          queue.sort((a, b) => b.distance - a.distance);
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
