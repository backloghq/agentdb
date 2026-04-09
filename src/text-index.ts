/**
 * Simple inverted index for full-text search.
 * Tokenizes text fields, builds term → document ID mappings,
 * and supports multi-term queries with AND semantics.
 */

/** Tokenize a string into lowercase terms. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
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

/**
 * In-memory inverted index.
 * Maps terms to sets of document IDs.
 */
export class TextIndex {
  private index = new Map<string, Set<string>>();
  private docTerms = new Map<string, Set<string>>();

  /** Index a document. Extracts and tokenizes all string fields. */
  add(id: string, record: Record<string, unknown>): void {
    this.remove(id); // Clear old terms if re-indexing
    const texts = extractText(record);
    const terms = new Set(texts.flatMap(tokenize));
    this.docTerms.set(id, terms);
    for (const term of terms) {
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
    const terms = this.docTerms.get(id);
    if (!terms) return;
    for (const term of terms) {
      const ids = this.index.get(term);
      if (ids) {
        ids.delete(id);
        if (ids.size === 0) this.index.delete(term);
      }
    }
    this.docTerms.delete(id);
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
    for (const term of terms) {
      const ids = this.index.get(term);
      if (!ids || ids.size === 0) return new Set(); // No match for this term = no results
      if (result === null) {
        result = new Set(ids);
      } else {
        // Intersect
        for (const id of result) {
          if (!ids.has(id)) result.delete(id);
        }
      }
      if (result.size === 0) return result;
    }

    return result ?? new Set();
  }

  /** Number of indexed terms. */
  get termCount(): number {
    return this.index.size;
  }

  /** Number of indexed documents. */
  get docCount(): number {
    return this.docTerms.size;
  }

  /** Clear the entire index. */
  clear(): void {
    this.index.clear();
    this.docTerms.clear();
  }
}
