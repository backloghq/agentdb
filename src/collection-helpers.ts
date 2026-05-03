/**
 * Pure utility functions, constants, and types extracted from collection.ts.
 * No dependency on Collection instance state.
 */
import { compileFilter } from "./filter.js";
import { parseCompactFilter } from "./compact-filter.js";

// Re-export getNestedValue for convenience
export { getNestedValue } from "./filter.js";

// --- Internal record type ---

export type StoredRecord = Record<string, unknown>;

// --- Metadata constants ---

export const META_AGENT = "_agent";
export const META_REASON = "_reason";
export const META_EXPIRES = "_expires";
export const META_EMBEDDING = "_embedding";
export const META_VERSION = "_version";

/** Fields that cannot be modified via $set/$unset/$inc/$push. */
export const PROTECTED_FIELDS = new Set([META_AGENT, META_REASON, META_EXPIRES, META_EMBEDDING, META_VERSION, "_id", "__proto__", "constructor", "prototype"]);

// --- Filter types ---

/** Filter can be a JSON object or a compact string. */
export type Filter = Record<string, unknown> | string | null | undefined;

/** Computed field function — receives the record and a lazy accessor for all records. */
export type ComputedFn = (record: Record<string, unknown>, allRecords: () => Record<string, unknown>[]) => unknown;

/** Virtual filter function — receives the record and a getter for looking up records by ID. */
export type VirtualFilterFn = (record: Record<string, unknown>, getter: (id: string) => Record<string, unknown> | undefined) => boolean;

// --- Predicate cache ---

const FILTER_CACHE_MAX = 64;
const filterCache = new Map<string, (record: Record<string, unknown>) => boolean>();

export function cachedCompileFilter(filterObj: Record<string, unknown>): (record: Record<string, unknown>) => boolean {
  const key = JSON.stringify(filterObj);
  const cached = filterCache.get(key);
  if (cached) {
    filterCache.delete(key);
    filterCache.set(key, cached);
    return cached;
  }
  const predicate = compileFilter(filterObj);
  if (filterCache.size >= FILTER_CACHE_MAX) {
    const oldest = filterCache.keys().next().value!;
    filterCache.delete(oldest);
  }
  filterCache.set(key, predicate);
  return predicate;
}

/** Resolve a filter (string or object) into a compiled predicate, with optional virtual filter support. */
export function resolveFilter(
  filter: Filter,
  virtualFilters?: Record<string, VirtualFilterFn>,
  getter?: (id: string) => Record<string, unknown> | undefined,
  tagField?: string,
): (record: Record<string, unknown>) => boolean {
  if (filter === null || filter === undefined) return () => true;

  let filterObj: Record<string, unknown>;
  if (typeof filter === "string") {
    if (filter.trim() === "") return () => true;
    filterObj = parseCompactFilter(filter, tagField);
  } else {
    filterObj = filter;
  }
  if (Object.keys(filterObj).length === 0) return () => true;

  if (virtualFilters) {
    const vfKeys = Object.keys(filterObj).filter((k) => k.startsWith("+") && virtualFilters[k]);
    if (vfKeys.length > 0) {
      const remaining: Record<string, unknown> = {};
      const vfPredicates: ((record: Record<string, unknown>) => boolean)[] = [];

      for (const [key, value] of Object.entries(filterObj)) {
        if (key.startsWith("+") && virtualFilters[key]) {
          const vfFn = virtualFilters[key];
          const g = getter ?? (() => undefined);
          if (value === false) {
            vfPredicates.push((record) => !vfFn(record, g));
          } else {
            vfPredicates.push((record) => vfFn(record, g));
          }
        } else {
          remaining[key] = value;
        }
      }

      const basePredicate = Object.keys(remaining).length > 0
        ? cachedCompileFilter(remaining)
        : () => true;

      return (record) =>
        basePredicate(record) && vfPredicates.every((p) => p(record));
    }
  }

  return cachedCompileFilter(filterObj);
}

// --- Record utilities ---

/** Strip internal metadata fields from a stored record for public consumption. */
export function stripMeta(record: StoredRecord): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key !== META_AGENT && key !== META_REASON && key !== META_EXPIRES && key !== META_EMBEDDING) {
      result[key] = value;
    }
  }
  return result;
}

/** Check if a record has expired. */
export function isExpired(record: StoredRecord): boolean {
  const expires = record[META_EXPIRES];
  if (!expires) return false;
  const expiresMs = typeof expires === "number" ? expires : new Date(expires as string).getTime();
  return expiresMs < Date.now();
}

/**
 * Summarize a record for progressive disclosure.
 * Keeps short-valued fields, omits long text/objects/arrays.
 */
export function summarize(record: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && value.length > 200) continue;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) continue;
    if (Array.isArray(value) && value.length > 10) continue;
    result[key] = value;
  }
  return result;
}

/** Approximate token count for a value (4 chars per token heuristic). */
export function estimateTokens(value: unknown): number {
  return Math.ceil(estimateChars(value) / 4);
}

function estimateChars(value: unknown): number {
  if (value === null || value === undefined) return 4;
  if (typeof value === "string") return value.length + 2;
  if (typeof value === "number" || typeof value === "boolean") return String(value).length;
  if (Array.isArray(value)) {
    let n = 2;
    for (const item of value) n += estimateChars(item) + 1;
    return n;
  }
  if (typeof value === "object") {
    let n = 2;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      n += k.length + 3 + estimateChars(v) + 1;
    }
    return n;
  }
  return 4;
}

/** Update operators. */
export interface UpdateOps {
  $set?: Record<string, unknown>;
  $unset?: Record<string, unknown>;
  $inc?: Record<string, number>;
  $push?: Record<string, unknown>;
}

/** Apply update operators to a record, returning a new record. */
export function applyUpdate(record: StoredRecord, update: UpdateOps): StoredRecord {
  const result = { ...record };

  if (update.$set) {
    for (const [key, value] of Object.entries(update.$set)) {
      if (!PROTECTED_FIELDS.has(key)) result[key] = value;
    }
  }

  if (update.$unset) {
    for (const key of Object.keys(update.$unset)) {
      if (!PROTECTED_FIELDS.has(key)) delete result[key];
    }
  }

  if (update.$inc) {
    for (const [key, amount] of Object.entries(update.$inc)) {
      if (PROTECTED_FIELDS.has(key)) continue;
      const current = result[key];
      if (typeof current === "number") {
        result[key] = current + amount;
      } else if (current === undefined || current === null) {
        result[key] = amount;
      } else {
        throw new Error(`$inc: field '${key}' is not a number (got ${typeof current})`);
      }
    }
  }

  if (update.$push) {
    for (const [key, value] of Object.entries(update.$push)) {
      if (PROTECTED_FIELDS.has(key)) continue;
      const current = result[key];
      if (Array.isArray(current)) {
        result[key] = [...current, value];
      } else if (current === undefined || current === null) {
        result[key] = [value];
      } else {
        throw new Error(`$push: field '${key}' is not an array (got ${typeof current})`);
      }
    }
  }

  return result;
}

// --- Composite key serialization ---

export const COMPOSITE_SEP = "\x00";

export function serializeKeyPart(v: unknown): string {
  if (v === null || v === undefined) return "\x01null";
  if (typeof v === "number") {
    const offset = v + 1e15;
    return "\x02" + offset.toFixed(10).padStart(30, "0");
  }
  if (typeof v === "boolean") return "\x03" + (v ? "1" : "0");
  return "\x04" + String(v);
}

export function compositeKey(values: unknown[]): string {
  return values.map(serializeKeyPart).join(COMPOSITE_SEP);
}

export function compositeIndexKey(fields: string[]): string {
  return fields.join(COMPOSITE_SEP);
}

/**
 * Extract all text from a record for embedding (concatenate string fields).
 * Excludes all internal metadata fields (_id, _version, _agent, _reason, _expires, _embedding).
 * @precondition Callers should pass a stripMeta-ed record; this filter is defense-in-depth.
 */
export function extractTextFromRecord(record: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (key.startsWith("_")) continue;
    if (typeof value === "string" && value.length > 0) {
      parts.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") parts.push(item);
      }
    }
  }
  return parts.join(" ");
}

/** Truncate a value for display in schema examples. */
export function summarizeValue(value: unknown): unknown {
  if (typeof value === "string" && value.length > 100) {
    return value.slice(0, 100) + "...";
  }
  if (Array.isArray(value) && value.length > 5) {
    return [...value.slice(0, 5), `... (${value.length} items)`];
  }
  return value;
}
