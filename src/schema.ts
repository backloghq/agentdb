/**
 * Declarative collection schemas — define fields, validation, computed,
 * virtual filters, hooks, and indexes in a single definition.
 */
import type { ComputedFn, VirtualFilterFn } from "./collection-helpers.js";
import type { CollectionOptions } from "./collection.js";

// --- Field types ---

/** Allowed field type identifiers. */
export type FieldType = "string" | "number" | "boolean" | "date" | "enum" | "string[]" | "number[]" | "object" | "autoIncrement";

export interface FieldDef {
  /** Field type. "autoIncrement" assigns sequential integer IDs (1, 2, 3...). */
  type: FieldType;
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
  /** Human-readable description of this field — used for agent discovery. */
  description?: string;
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
  /** Schema version — for tracking changes over time. */
  version?: number;
  /** Human-readable description of this collection — used for agent discovery. */
  description?: string;
  /** Instructions for agents on how to use this collection. */
  instructions?: string;
  /** Field definitions. Keys are field names. */
  fields?: Record<string, FieldDef>;
  /** Fields to create B-tree indexes on (auto-created on open). */
  indexes?: string[];
  /** Composite indexes to create on open. */
  compositeIndexes?: string[][];
  /** Array-element indexes for $contains queries (auto-created on open). */
  arrayIndexes?: string[];
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
  /** Storage mode override: "memory", "disk", or "auto". */
  storageMode?: "memory" | "disk" | "auto";
}

// --- Compiled schema ---

export interface CollectionSchema {
  name: string;
  collectionOptions: CollectionOptions;
  indexes: string[];
  compositeIndexes: string[][];
  arrayIndexes: string[];
  hooks: SchemaHooks;
  /** Apply defaults to a record (called before validation). */
  applyDefaults: (record: Record<string, unknown>) => Record<string, unknown>;
  /** Auto-increment field names (for counter initialization from existing records). */
  autoIncrementFields: string[];
  /** Shared counters for auto-increment fields. */
  counters: Map<string, number>;
  /** Array field name for +tag/-tag compact filter. Default: "tags". */
  tagField: string;
  /** Original schema definition — retained for persistence extraction. */
  definition: SchemaDefinition;
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
    tagField: def.tagField,
    storageMode: def.storageMode,
  };

  return {
    name: def.name,
    collectionOptions,
    indexes: def.indexes ?? [],
    compositeIndexes: def.compositeIndexes ?? [],
    arrayIndexes: def.arrayIndexes ?? [],
    hooks: def.hooks ?? {},
    applyDefaults: defaults ?? ((r) => r),
    autoIncrementFields,
    counters,
    tagField: def.tagField ?? "tags",
    definition: def,
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
        try {
          result[name] = def.resolve!(result[name]);
        } catch (err) {
          throw new Error(`Field '${name}' resolve failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
        }
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

// --- Persisted schema (JSON-serializable subset) ---

/** JSON-serializable field definition — no functions or RegExp. */
export interface PersistedFieldDef {
  type: FieldType;
  required?: boolean;
  /** Static default value only (function defaults are not persisted). */
  default?: unknown;
  values?: string[];
  maxLength?: number;
  min?: number;
  max?: number;
  /** Human-readable description of this field — used for agent discovery. */
  description?: string;
}

/**
 * JSON-serializable schema stored in collection metadata.
 * Contains structural information and agent context, but no runtime
 * behaviors (hooks, computed, virtualFilters, resolve, pattern).
 */
export interface PersistedSchema {
  name: string;
  version?: number;
  /** What this collection is for. */
  description?: string;
  /** Instructions for agents on how to use this collection. */
  instructions?: string;
  fields?: Record<string, PersistedFieldDef>;
  indexes?: string[];
  compositeIndexes?: string[][];
  arrayIndexes?: string[];
  tagField?: string;
  storageMode?: "memory" | "disk" | "auto";
}

/**
 * Extract the JSON-serializable subset from a SchemaDefinition.
 * Strips functions (hooks, computed, virtualFilters, resolve, pattern)
 * and non-serializable defaults.
 */
export function extractPersistedSchema(def: SchemaDefinition): PersistedSchema {
  const persisted: PersistedSchema = { name: def.name };

  if (def.version !== undefined) persisted.version = def.version;
  if (def.description !== undefined) persisted.description = def.description;
  if (def.instructions !== undefined) persisted.instructions = def.instructions;
  if (def.indexes?.length) persisted.indexes = [...def.indexes];
  if (def.compositeIndexes?.length) persisted.compositeIndexes = def.compositeIndexes.map(ci => [...ci]);
  if (def.arrayIndexes?.length) persisted.arrayIndexes = [...def.arrayIndexes];
  if (def.tagField !== undefined) persisted.tagField = def.tagField;
  if (def.storageMode !== undefined) persisted.storageMode = def.storageMode;

  if (def.fields) {
    persisted.fields = {};
    for (const [name, field] of Object.entries(def.fields)) {
      const pf: PersistedFieldDef = { type: field.type };
      if (field.required) pf.required = true;
      // Only persist static defaults, not function defaults
      if (field.default !== undefined && typeof field.default !== "function") pf.default = field.default;
      if (field.values?.length) pf.values = [...field.values];
      if (field.maxLength !== undefined) pf.maxLength = field.maxLength;
      if (field.min !== undefined) pf.min = field.min;
      if (field.max !== undefined) pf.max = field.max;
      if (field.description !== undefined) pf.description = field.description;
      persisted.fields[name] = pf;
    }
  }

  return persisted;
}

// --- Schema merge ---

export interface MergeResult {
  /** The merged persisted schema (structural source of truth + agent context). */
  persisted: PersistedSchema;
  /** Warnings about mismatches between code and persisted schemas. */
  warnings: string[];
}

/**
 * Merge a code-level SchemaDefinition with a persisted schema.
 *
 * Precedence:
 * - description, instructions, version: persisted wins (agent context)
 * - fields structure: union of both; persisted field descriptions preserved
 * - field type conflicts: warn, code wins for validation
 * - indexes: union of both
 * - tagField, storageMode: code wins if set, else persisted
 */
export function mergeSchemas(code: SchemaDefinition, persisted: PersistedSchema): MergeResult {
  const warnings: string[] = [];

  // Version mismatch detection
  if (code.version !== undefined && persisted.version !== undefined && code.version !== persisted.version) {
    warnings.push(`Schema version mismatch for '${code.name}': code v${code.version}, persisted v${persisted.version}`);
  }

  const merged: PersistedSchema = {
    name: persisted.name,
    // Persisted wins for agent context
    version: persisted.version ?? code.version,
    description: persisted.description ?? code.description,
    instructions: persisted.instructions ?? code.instructions,
    // Code wins for runtime config if set
    tagField: code.tagField ?? persisted.tagField,
    storageMode: code.storageMode ?? persisted.storageMode,
  };

  // Merge indexes (union, deduplicated)
  const codeIndexes = code.indexes ?? [];
  const persistedIndexes = persisted.indexes ?? [];
  const mergedIndexes = [...new Set([...persistedIndexes, ...codeIndexes])];
  if (mergedIndexes.length > 0) merged.indexes = mergedIndexes;

  const codeComposite = code.compositeIndexes ?? [];
  const persistedComposite = persisted.compositeIndexes ?? [];
  const compositeKeys = new Set(persistedComposite.map(ci => ci.join(",")));
  const mergedComposite = [...persistedComposite];
  for (const ci of codeComposite) {
    if (!compositeKeys.has(ci.join(","))) mergedComposite.push(ci);
  }
  if (mergedComposite.length > 0) merged.compositeIndexes = mergedComposite;

  const codeArray = code.arrayIndexes ?? [];
  const persistedArray = persisted.arrayIndexes ?? [];
  const mergedArray = [...new Set([...persistedArray, ...codeArray])];
  if (mergedArray.length > 0) merged.arrayIndexes = mergedArray;

  // Merge fields
  const codeFields = code.fields ?? {};
  const persistedFields = persisted.fields ?? {};
  const allFieldNames = new Set([...Object.keys(persistedFields), ...Object.keys(codeFields)]);

  if (allFieldNames.size > 0) {
    merged.fields = {};
    for (const name of allFieldNames) {
      const cf = codeFields[name];
      const pf = persistedFields[name];

      if (cf && pf) {
        // Both exist — check for type conflicts
        if (cf.type !== pf.type) {
          warnings.push(`Field '${name}' type mismatch: code '${cf.type}', persisted '${pf.type}'`);
        }
        // Merge: persisted description wins, code structural props win for validation
        merged.fields[name] = {
          type: cf.type, // code wins for validation
          ...(cf.required ? { required: true } : pf.required ? { required: true } : {}),
          ...(cf.default !== undefined && typeof cf.default !== "function" ? { default: cf.default } : pf.default !== undefined ? { default: pf.default } : {}),
          ...(cf.values?.length ? { values: [...cf.values] } : pf.values?.length ? { values: [...pf.values] } : {}),
          ...(cf.maxLength !== undefined ? { maxLength: cf.maxLength } : pf.maxLength !== undefined ? { maxLength: pf.maxLength } : {}),
          ...(cf.min !== undefined ? { min: cf.min } : pf.min !== undefined ? { min: pf.min } : {}),
          ...(cf.max !== undefined ? { max: cf.max } : pf.max !== undefined ? { max: pf.max } : {}),
          // Persisted description wins (agent context)
          ...(pf.description !== undefined ? { description: pf.description } : cf.description !== undefined ? { description: cf.description } : {}),
        };
      } else if (pf) {
        // Only in persisted
        merged.fields[name] = { ...pf };
      } else if (cf) {
        // Only in code — extract serializable parts
        const pf2: PersistedFieldDef = { type: cf.type };
        if (cf.required) pf2.required = true;
        if (cf.default !== undefined && typeof cf.default !== "function") pf2.default = cf.default;
        if (cf.values?.length) pf2.values = [...cf.values];
        if (cf.maxLength !== undefined) pf2.maxLength = cf.maxLength;
        if (cf.min !== undefined) pf2.min = cf.min;
        if (cf.max !== undefined) pf2.max = cf.max;
        if (cf.description !== undefined) pf2.description = cf.description;
        merged.fields[name] = pf2;
      }
    }
  }

  // Clean up undefined optional fields
  if (merged.version === undefined) delete merged.version;
  if (merged.description === undefined) delete merged.description;
  if (merged.instructions === undefined) delete merged.instructions;
  if (merged.tagField === undefined) delete merged.tagField;
  if (merged.storageMode === undefined) delete merged.storageMode;

  return { persisted: merged, warnings };
}

/** Valid field types for schema validation. */
const VALID_FIELD_TYPES = new Set<string>([
  "string", "number", "boolean", "date", "enum",
  "string[]", "number[]", "object", "autoIncrement",
]);

/**
 * Validate a PersistedSchema structure (e.g. loaded from JSON).
 * Throws on invalid input.
 */
export function validatePersistedSchema(schema: unknown): asserts schema is PersistedSchema {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    throw new Error("Schema must be a non-null object");
  }
  const s = schema as Record<string, unknown>;

  if (typeof s.name !== "string" || !s.name.trim()) {
    throw new Error("Schema 'name' must be a non-empty string");
  }
  if (s.version !== undefined && (typeof s.version !== "number" || !Number.isInteger(s.version) || s.version < 1)) {
    throw new Error("Schema 'version' must be a positive integer");
  }
  if (s.description !== undefined && typeof s.description !== "string") {
    throw new Error("Schema 'description' must be a string");
  }
  if (s.instructions !== undefined && typeof s.instructions !== "string") {
    throw new Error("Schema 'instructions' must be a string");
  }
  if (s.tagField !== undefined && typeof s.tagField !== "string") {
    throw new Error("Schema 'tagField' must be a string");
  }
  if (s.storageMode !== undefined && !["memory", "disk", "auto"].includes(s.storageMode as string)) {
    throw new Error("Schema 'storageMode' must be 'memory', 'disk', or 'auto'");
  }

  // Validate indexes arrays
  for (const key of ["indexes", "arrayIndexes"] as const) {
    if (s[key] !== undefined) {
      if (!Array.isArray(s[key]) || !(s[key] as unknown[]).every(v => typeof v === "string")) {
        throw new Error(`Schema '${key}' must be an array of strings`);
      }
    }
  }
  if (s.compositeIndexes !== undefined) {
    if (!Array.isArray(s.compositeIndexes) ||
        !(s.compositeIndexes as unknown[]).every(ci => Array.isArray(ci) && (ci as unknown[]).every(v => typeof v === "string"))) {
      throw new Error("Schema 'compositeIndexes' must be an array of string arrays");
    }
  }

  // Validate fields
  if (s.fields !== undefined) {
    if (typeof s.fields !== "object" || s.fields === null || Array.isArray(s.fields)) {
      throw new Error("Schema 'fields' must be an object");
    }
    for (const [fieldName, fieldDef] of Object.entries(s.fields as Record<string, unknown>)) {
      if (typeof fieldDef !== "object" || fieldDef === null || Array.isArray(fieldDef)) {
        throw new Error(`Field '${fieldName}' must be an object`);
      }
      const fd = fieldDef as Record<string, unknown>;
      if (!VALID_FIELD_TYPES.has(fd.type as string)) {
        throw new Error(`Field '${fieldName}' has invalid type '${fd.type}'. Valid types: ${[...VALID_FIELD_TYPES].join(", ")}`);
      }
      if (fd.required !== undefined && typeof fd.required !== "boolean") {
        throw new Error(`Field '${fieldName}.required' must be a boolean`);
      }
      if (fd.values !== undefined) {
        if (!Array.isArray(fd.values) || !(fd.values as unknown[]).every(v => typeof v === "string")) {
          throw new Error(`Field '${fieldName}.values' must be an array of strings`);
        }
      }
      if (fd.maxLength !== undefined && typeof fd.maxLength !== "number") {
        throw new Error(`Field '${fieldName}.maxLength' must be a number`);
      }
      if (fd.min !== undefined && typeof fd.min !== "number") {
        throw new Error(`Field '${fieldName}.min' must be a number`);
      }
      if (fd.max !== undefined && typeof fd.max !== "number") {
        throw new Error(`Field '${fieldName}.max' must be a number`);
      }
      if (fd.description !== undefined && typeof fd.description !== "string") {
        throw new Error(`Field '${fieldName}.description' must be a string`);
      }
    }
  }
}
