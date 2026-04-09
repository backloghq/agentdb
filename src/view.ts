/**
 * Named query views with automatic cache invalidation.
 * A view is a named filter that caches its result set.
 * The cache is invalidated when the collection is mutated.
 */

import type { FindResult, FindOpts, Filter } from "./collection.js";

export interface ViewDefinition {
  name: string;
  filter: Filter;
  /** Default find options for this view. */
  opts?: Omit<FindOpts, "filter">;
}

export interface ViewCache {
  result: FindResult;
  generation: number;
}

/**
 * Manages named query views for a collection.
 * Views are invalidated on any mutation (generation bump).
 */
export class ViewManager {
  private views = new Map<string, ViewDefinition>();
  private cache = new Map<string, ViewCache>();
  private generation = 0;

  /** Register a named view. */
  define(def: ViewDefinition): void {
    this.views.set(def.name, def);
    this.cache.delete(def.name); // Invalidate cache
  }

  /** Remove a named view. */
  remove(name: string): boolean {
    this.cache.delete(name);
    return this.views.delete(name);
  }

  /** Get a view definition by name. */
  get(name: string): ViewDefinition | undefined {
    return this.views.get(name);
  }

  /** List all registered view names. */
  list(): string[] {
    return [...this.views.keys()];
  }

  /** Get cached result for a view, or undefined if stale/missing. */
  getCached(name: string): FindResult | undefined {
    const cached = this.cache.get(name);
    if (cached && cached.generation === this.generation) {
      return cached.result;
    }
    return undefined;
  }

  /** Store a result in the cache for the current generation. */
  setCache(name: string, result: FindResult): void {
    this.cache.set(name, { result, generation: this.generation });
  }

  /** Invalidate all cached views. Called after any mutation. */
  invalidate(): void {
    this.generation++;
  }

  /** Number of registered views. */
  get size(): number {
    return this.views.size;
  }
}
