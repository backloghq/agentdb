/**
 * Declarative collection schemas — define fields, validation, computed,
 * virtual filters, hooks, and indexes in a single definition.
 */
import type { ComputedFn, VirtualFilterFn } from "./collection-helpers.js";
import type { CollectionOptions } from "./collection.js";

// --- Field types ---

export interface FieldDef {
  /** Field type. "autoIncrement" assigns sequential integer IDs (1, 2, 3...). */
  type: "string" | "number" | "boolean" | "date" | "enum" | "string[]" | "number[]" | "object" | "autoIncrement";
  /** Field is required on insert. Default: false. */
  required?: boolean;
  /** Default value — applied on insert if field is missing. */
  default?: unknown | (() => unknown);
  /** For enum type: allowed values. */
  values?: string[];
  /** Max string length. */
  maxLength?: number;
  /** Min for numbers. */
  min?: number;
  /** Max for numbers. */
  max?: number;
  /** Regex pattern for strings. */
  pattern?: RegExp;
  /** Transform value before validation (e.g. resolve "tomorrow" → ISO date string). */
  resolve?: (value: unknown) => unknown;
}

// --- Hooks ---

/** Context passed to lifecycle hooks — provides access to the collection for side effects. */
export interface HookContext {
  collection: import("./collection.js").Collection;
}

export interface SchemaHooks {
  /** Called before insert — can modify the record by returning a new one. */
  beforeInsert?: (record: Record<string, unknown>, ctx: HookContext) => void | Record<string, unknown>;
  /** Called before update. */
  beforeUpdate?: (filter: unknown, update: unknown, ctx: HookContext) => void;
  /** Called after insert with the new record's ID. */
  afterInsert?: (id: string, record: Record<string, unknown>, ctx: HookContext) => void;
  /** Called after update with affected IDs. */
  afterUpdate?: (ids: string[], ctx: HookContext) => void;
  /** Called after delete with affected IDs. */
  afterDelete?: (ids: string[], ctx: HookContext) => void;
}

// --- Schema definition ---

export interface SchemaDefinition {
  /** Collection name. */
  name: string;
  /** Field definitions. Keys are field names. */
  fields?: Record<string, FieldDef>;
  /** Fields to create B-tree indexes on (auto-created on open). */
  indexes?: string[];
  /** Composite indexes to create on open. */
  compositeIndexes?: string[][];
  /** Computed fields — calculated on read, not stored. */
  computed?: Record<string, ComputedFn>;
  /** Virtual filter predicates — domain-specific query conditions. */
  virtualFilters?: Record<string, VirtualFilterFn>;
  /** Lifecycle hooks. */
  hooks?: SchemaHooks;
  /** Enable full-text search. */
  textSearch?: boolean;
  /** Array field name for +tag/-tag compact filter syntax. Default: "tags". */
  tagField?: string;
}

// --- Compiled schema ---

export interface CollectionSchema {
  name: string;
  collectionOptions: CollectionOptions;
  indexes: string[];
  compositeIndexes: string[][];
  hooks: SchemaHooks;
  /** Apply defaults to a record (called before validation). */
  applyDefaults: (record: Record<string, unknown>) => Record<string, unknown>;
  /** Auto-increment field names (for counter initialization from existing records). */
  autoIncrementFields: string[];
  /** Shared counters for auto-increment fields. */
  counters: Map<string, number>;
  /** Array field name for +tag/-tag compact filter. Default: "tags". */
  tagField: string;
}

// --- Compile ---

/**
 * Define a typed, validated collection schema.
 * Returns a compiled schema that can be passed to `db.collection()`.
 *
 * ```typescript
 * const tasks = await db.collection(defineSchema({
 *   name: "tasks",
 *   fields: {
 *     title: { type: "string", required: true },
 *     status: { type: "enum", values: ["pending", "done"], default: "pending" },
 *   },
 *   indexes: ["status"],
 * }));
 * ```
 */
export function defineSchema(def: SchemaDefinition): CollectionSchema {
  const counters = new Map<string, number>();
  const autoIncrementFields = def.fields
    ? Object.entries(def.fields).filter(([, d]) => d.type === "autoIncrement").map(([name]) => name)
    : [];
  const fieldValidator = def.fields ? compileFieldValidation(def.fields) : undefined;
  const defaults = def.fields ? compileDefaults(def.fields, counters) : undefined;

  // Build validate function: apply defaults, then run field validation, then user beforeInsert
  const validate = (record: Record<string, unknown>): void => {
    if (fieldValidator) fieldValidator(record);
  };

  const collectionOptions: CollectionOptions = {
    validate,
    computed: def.computed,
    virtualFilters: def.virtualFilters,
    textSearch: def.textSearch,
  };

  return {
    name: def.name,
    collectionOptions,
    indexes: def.indexes ?? [],
    compositeIndexes: def.compositeIndexes ?? [],
    hooks: def.hooks ?? {},
    applyDefaults: defaults ?? ((r) => r),
    autoIncrementFields,
    counters,
    tagField: def.tagField ?? "tags",
  };
}

// --- Field validation compiler ---

function compileFieldValidation(fields: Record<string, FieldDef>): (record: Record<string, unknown>) => void {
  const entries = Object.entries(fields);

  return (record: Record<string, unknown>) => {
    for (const [name, def] of entries) {
      const val = record[name];

      // Required check
      if (def.required && (val === undefined || val === null)) {
        throw new Error(`Field '${name}' is required`);
      }
      if (val === undefined || val === null) continue;

      // Type checks
      switch (def.type) {
        case "string":
          if (typeof val !== "string") throw new Error(`Field '${name}' must be a string, got ${typeof val}`);
          if (def.maxLength !== undefined && val.length > def.maxLength) {
            throw new Error(`Field '${name}' exceeds max length ${def.maxLength}`);
          }
          if (def.pattern && !def.pattern.test(val)) {
            throw new Error(`Field '${name}' does not match required pattern`);
          }
          break;

        case "number":
          if (typeof val !== "number") throw new Error(`Field '${name}' must be a number, got ${typeof val}`);
          if (def.min !== undefined && val < def.min) throw new Error(`Field '${name}' must be >= ${def.min}`);
          if (def.max !== undefined && val > def.max) throw new Error(`Field '${name}' must be <= ${def.max}`);
          break;

        case "boolean":
          if (typeof val !== "boolean") throw new Error(`Field '${name}' must be a boolean, got ${typeof val}`);
          break;

        case "date":
          if (typeof val !== "string" && !(val instanceof Date)) {
            throw new Error(`Field '${name}' must be a date string or Date`);
          }
          break;

        case "enum":
          if (!def.values || !def.values.includes(val as string)) {
            throw new Error(`Field '${name}' must be one of: ${def.values?.join(", ")}`);
          }
          break;

        case "string[]":
          if (!Array.isArray(val) || !val.every((v) => typeof v === "string")) {
            throw new Error(`Field '${name}' must be a string array`);
          }
          break;

        case "number[]":
          if (!Array.isArray(val) || !val.every((v) => typeof v === "number")) {
            throw new Error(`Field '${name}' must be a number array`);
          }
          break;

        case "object":
          if (typeof val !== "object" || Array.isArray(val)) {
            throw new Error(`Field '${name}' must be an object`);
          }
          break;
      }
    }
  };
}

// --- Defaults compiler ---

function compileDefaults(fields: Record<string, FieldDef>, counters: Map<string, number>): (record: Record<string, unknown>) => Record<string, unknown> {
  const defaultEntries = Object.entries(fields).filter(([, def]) => def.default !== undefined);
  const autoIncrFields = Object.entries(fields).filter(([, def]) => def.type === "autoIncrement").map(([name]) => name);
  const resolveEntries = Object.entries(fields).filter(([, def]) => def.resolve !== undefined);

  if (defaultEntries.length === 0 && autoIncrFields.length === 0 && resolveEntries.length === 0) return (r) => r;

  return (record: Record<string, unknown>) => {
    const result = { ...record };
    // Apply resolve functions first (transform before defaults/validation)
    for (const [name, def] of resolveEntries) {
      if (result[name] !== undefined && result[name] !== null) {
        result[name] = def.resolve!(result[name]);
      }
    }
    for (const [name, def] of defaultEntries) {
      if (result[name] === undefined) {
        result[name] = typeof def.default === "function" ? (def.default as () => unknown)() : def.default;
      }
    }
    for (const name of autoIncrFields) {
      if (result[name] === undefined) {
        const next = (counters.get(name) ?? 0) + 1;
        counters.set(name, next);
        result[name] = next;
      }
    }
    return result;
  };
}
