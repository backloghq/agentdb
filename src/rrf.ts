export interface RankedItem {
  id: string;
  score?: number;
}

export interface RRFOptions {
  k?: number;
  limit?: number;
}

/**
 * Reciprocal Rank Fusion (Cormack et al. 2009).
 * Fuses N ranked lists into a single scored list.
 * For each id, accumulates score += 1 / (k + rank) across lists.
 * Duplicate ids within a single list: only the first (better) rank counts.
 */
export function rrf(
  lists: ReadonlyArray<ReadonlyArray<RankedItem>>,
  opts?: RRFOptions,
): Array<{ id: string; score: number }> {
  const k = opts?.k ?? 60;
  if (k <= 0) throw new RangeError(`rrf: k must be > 0, got ${k}`);

  const scores = new Map<string, number>();

  for (const list of lists) {
    const seen = new Set<string>();
    let rank = 1;
    for (const item of list) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (k + rank));
        rank++;
      }
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
