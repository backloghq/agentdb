/**
 * Inverted index for full-text search with BM25 scoring.
 *
 * Persistence versions:
 *   v1 — posting lists only, no TF/DL data. On load, docTerms and docLen are
 *        rebuilt as empty Maps. AND-search (search()) still works.
 *   v2 — includes per-doc TF map and docLen. Full BM25 from cold start.
 *
 * v1→v2 upgrade is lazy: docs not yet re-added via add() have empty TF Maps
 * and are skipped by searchScored() — they do not appear in BM25 results.
 * Each add() call upgrades that doc to v2 in place. To upgrade a full
 * collection at once, iterate all records and call add() on each.
 */

/** Tokenize a string into lowercase terms (with repeated occurrences).
 *  Uses Unicode property classes so CJK, diacritics, and accented text
 *  are retained. Single-character tokens are kept so CJK chars survive. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .match(/[\p{L}\p{M}\p{N}]+/gu)
    ?.filter((t) => t.length > 0) ?? [];
}

/** Extract all string values from a record (recursively). */
function extractText(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(extractText);
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap(extractText);
  }
  return [];
}

export interface TextIndexOpts {
  k1?: number;
  b?: number;
}

/**
 * In-memory inverted index with BM25 scoring.
 * `search()` retains AND semantics for $text filter compatibility.
 * `searchScored()` uses OR semantics and returns BM25-ranked results.
 */
export class TextIndex {
  private index = new Map<string, Set<string>>();
  /** term → tf per doc */
  private docTerms = new Map<string, Map<string, number>>();
  /** total token count per doc */
  private docLen = new Map<string, number>();
  /** sum of all docLen values */
  private totalLen = 0;

  private k1: number;
  private b: number;

  constructor(opts?: TextIndexOpts) {
    this.k1 = opts?.k1 ?? 1.2;
    this.b = opts?.b ?? 0.75;
  }

  /** Index a document. Extracts and tokenizes all string fields, counting TF. */
  add(id: string, record: Record<string, unknown>): void {
    this.remove(id);
    const texts = extractText(record);
    const tokens = texts.flatMap(tokenize);

    const tfMap = new Map<string, number>();
    for (const token of tokens) {
      tfMap.set(token, (tfMap.get(token) ?? 0) + 1);
    }

    const dl = tokens.length;
    this.docTerms.set(id, tfMap);
    this.docLen.set(id, dl);
    this.totalLen += dl;

    for (const term of tfMap.keys()) {
      let ids = this.index.get(term);
      if (!ids) {
        ids = new Set();
        this.index.set(term, ids);
      }
      ids.add(id);
    }
  }

  /** Remove a document from the index. */
  remove(id: string): void {
    const tfMap = this.docTerms.get(id);
    if (!tfMap) return;
    for (const term of tfMap.keys()) {
      const ids = this.index.get(term);
      if (ids) {
        ids.delete(id);
        if (ids.size === 0) this.index.delete(term);
      }
    }
    this.totalLen -= this.docLen.get(id) ?? 0;
    this.docTerms.delete(id);
    this.docLen.delete(id);
  }

  /**
   * Search for documents matching a query string.
   * Tokenizes the query and returns IDs matching ALL terms (AND).
   * Returns empty set if query is empty.
   */
  search(query: string): Set<string> {
    const terms = tokenize(query);
    if (terms.length === 0) return new Set();

    let result: Set<string> | null = null;
    for (const term of new Set(terms)) {
      const ids = this.index.get(term);
      if (!ids || ids.size === 0) return new Set();
      if (result === null) {
        result = new Set(ids);
      } else {
        for (const id of result) {
          if (!ids.has(id)) result.delete(id);
        }
      }
      if (result.size === 0) return result;
    }

    return result ?? new Set();
  }

  /**
   * BM25-scored search with OR semantics.
   * Returns docs containing any query term, sorted by score desc, ties broken
   * by id ascending. Returns [] for empty query or no matches.
   */
  searchScored(query: string, opts?: { limit?: number }): Array<{ id: string; score: number }> {
    const terms = tokenize(query);
    if (terms.length === 0) return [];

    const N = this.docTerms.size;
    if (N === 0) return [];

    const avgdl = this.totalLen > 0 ? this.totalLen / N : 1;
    const { k1, b } = this;

    const scores = new Map<string, number>();

    for (const term of new Set(terms)) {
      const ids = this.index.get(term);
      if (!ids || ids.size === 0) continue;
      const df = ids.size;
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

      for (const id of ids) {
        const tfMap = this.docTerms.get(id);
        const tf = tfMap?.get(term);
        if (!tf) continue; // skip v1 placeholders (empty tfMap) and zero-tf docs
        const dl = this.docLen.get(id) ?? 0;
        const norm = k1 * (1 - b + b * (dl / avgdl));
        const termScore = idf * (tf * (k1 + 1)) / (tf + norm);
        scores.set(id, (scores.get(id) ?? 0) + termScore);
      }
    }

    if (scores.size === 0) return [];

    let results = Array.from(scores.entries()).map(([id, score]) => ({ id, score }));
    results.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    if (opts?.limit !== undefined) {
      results = results.slice(0, opts.limit);
    }

    return results;
  }

  /** Number of indexed terms. */
  get termCount(): number {
    return this.index.size;
  }

  /** Number of indexed documents. */
  get docCount(): number {
    return this.docTerms.size;
  }

  /** Average document length (tokens). */
  get avgdl(): number {
    const n = this.docTerms.size;
    return n > 0 ? this.totalLen / n : 0;
  }

  /**
   * Estimated resident memory in bytes.
   * Heuristic (accurate within ~2x): Map/Set overhead per entry dominates.
   *   docTerms: 80 B/doc (Map entry) + 32 B per (term,tf) pair
   *   index: 64 B/term (Map entry + Set overhead) + 24 B per posting-list member
   */
  estimatedBytes(): number {
    let bytes = 128; // object overhead + scalars
    // Per-doc TF maps
    bytes += this.docTerms.size * 80;
    for (const tfMap of this.docTerms.values()) {
      bytes += tfMap.size * 32;
    }
    // Inverted index (term → id set)
    bytes += this.index.size * 64;
    let totalEdges = 0;
    for (const ids of this.index.values()) {
      totalEdges += ids.size;
    }
    bytes += totalEdges * 24;
    return bytes;
  }

  /** Clear the entire index. */
  clear(): void {
    this.index.clear();
    this.docTerms.clear();
    this.docLen.clear();
    this.totalLen = 0;
  }

  /** Serialize to JSON for persistence (v2 format). */
  toJSON(): {
    version: number;
    terms: Record<string, string[]>;
    docs: Record<string, { terms: Record<string, number>; len: number }>;
    docCount: number;
  } {
    const terms: Record<string, string[]> = {};
    for (const [term, ids] of this.index) {
      terms[term] = Array.from(ids).sort();
    }
    const docs: Record<string, { terms: Record<string, number>; len: number }> = {};
    for (const [id, tfMap] of this.docTerms) {
      const termObj: Record<string, number> = {};
      for (const [t, tf] of tfMap) {
        termObj[t] = tf;
      }
      docs[id] = { terms: termObj, len: this.docLen.get(id) ?? 0 };
    }
    return { version: 2, terms, docs, docCount: this.docTerms.size };
  }

  /** Deserialize from JSON. Accepts v1 (no scoring data) and v2. */
  static fromJSON(
    data: { version?: number; terms: Record<string, string[]>; docs?: Record<string, { terms: Record<string, number>; len: number }>; docCount?: number },
    opts?: TextIndexOpts,
  ): TextIndex {
    const idx = new TextIndex(opts);
    idx.loadFromJSON(data);
    return idx;
  }

  /** Load serialized data into this instance (replaces current state). */
  loadFromJSON(data: {
    version?: number;
    terms: Record<string, string[]>;
    docs?: Record<string, { terms: Record<string, number>; len: number }>;
    docCount?: number;
  }): void {
    this.clear();
    const version = data.version ?? 1;

    for (const [term, ids] of Object.entries(data.terms)) {
      if (term === "__proto__" || term === "constructor" || term === "prototype") continue;
      const idSet = new Set(ids);
      this.index.set(term, idSet);

      if (version < 2) {
        // v1: reconstruct docTerms with tf=0 placeholders so search() works
        for (const id of ids) {
          if (!this.docTerms.has(id)) {
            this.docTerms.set(id, new Map());
            this.docLen.set(id, 0);
          }
        }
      }
    }

    if (version >= 2 && data.docs) {
      for (const [id, docData] of Object.entries(data.docs)) {
        if (id === "__proto__" || id === "constructor" || id === "prototype") continue;
        const tfMap = new Map<string, number>();
        for (const [t, tf] of Object.entries(docData.terms)) {
          if (t === "__proto__" || t === "constructor" || t === "prototype") continue;
          tfMap.set(t, tf);
        }
        this.docTerms.set(id, tfMap);
        this.docLen.set(id, docData.len);
        this.totalLen += docData.len;
      }
    }
  }
}
