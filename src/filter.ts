/**
 * Generic JSON filter compiler.
 *
 * Compiles a MongoDB-style filter object into a predicate function that tests
 * records against the filter conditions. Supports dot-notation field access,
 * comparison operators, logical operators, and string/array operators.
 */

export type Predicate = (record: Record<string, unknown>) => boolean;

type FilterValue = unknown;

/**
 * Get a nested value from a record using dot-notation path.
 * E.g., "metadata.tags" on { metadata: { tags: ["a"] } } returns ["a"].
 */
function getNestedValue(record: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = record;
  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Check if a value has a given field (for distinguishing null from missing).
 */
function hasNestedField(record: Record<string, unknown>, path: string): boolean {
  const parts = path.split(".");
  let current: unknown = record;
  for (let i = 0; i < parts.length; i++) {
    if (current === null || current === undefined) {
      return false;
    }
    if (typeof current !== "object") {
      return false;
    }
    const obj = current as Record<string, unknown>;
    if (!(parts[i] in obj)) {
      return false;
    }
    current = obj[parts[i]];
  }
  return true;
}

/**
 * Compare two values for ordering. Works for numbers, strings, and date strings.
 * Returns negative if a < b, zero if equal, positive if a > b.
 * Returns NaN if comparison is not meaningful.
 */
function compareValues(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  if (typeof a === "string" && typeof b === "string") {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  // Allow comparing number with string-number
  if (typeof a === "number" && typeof b === "string") {
    const bNum = Number(b);
    if (!Number.isNaN(bNum)) return a - bNum;
  }
  if (typeof a === "string" && typeof b === "number") {
    const aNum = Number(a);
    if (!Number.isNaN(aNum)) return aNum - b;
  }
  return NaN;
}

/**
 * Strict equality check that handles null, undefined, and primitive types.
 */
function isEqual(a: unknown, b: unknown): boolean {
  return a === b;
}

/**
 * Check if a value is an operator object (has keys starting with $).
 */
function isOperatorObject(value: unknown): value is Record<string, unknown> {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value as Record<string, unknown>);
  return keys.length > 0 && keys.every((k) => k.startsWith("$"));
}

/**
 * Compile a single field condition (the value side of a field: condition pair).
 * If the value is a primitive, it's an implicit $eq.
 * If it's an operator object, compile each operator.
 */
function compileFieldCondition(fieldPath: string, condition: FilterValue): Predicate {
  // Primitive value -> implicit $eq
  if (condition === null || condition === undefined || typeof condition !== "object" || condition instanceof RegExp) {
    return (record) => {
      const fieldValue = getNestedValue(record, fieldPath);
      return isEqual(fieldValue, condition);
    };
  }

  // Array value -> implicit $eq (exact array match)
  if (Array.isArray(condition)) {
    return (record) => {
      const fieldValue = getNestedValue(record, fieldPath);
      if (!Array.isArray(fieldValue)) return false;
      if (fieldValue.length !== condition.length) return false;
      return fieldValue.every((v, i) => isEqual(v, condition[i]));
    };
  }

  // Operator object
  if (isOperatorObject(condition)) {
    const operators = condition as Record<string, unknown>;
    const predicates: Predicate[] = [];

    for (const [op, opValue] of Object.entries(operators)) {
      predicates.push(compileOperator(fieldPath, op, opValue));
    }

    // Multiple operators on the same field are ANDed
    if (predicates.length === 1) return predicates[0];
    return (record) => predicates.every((p) => p(record));
  }

  // Plain object value -> implicit $eq (deep equality would be complex, use reference)
  return (record) => {
    const fieldValue = getNestedValue(record, fieldPath);
    return isEqual(fieldValue, condition);
  };
}

/**
 * Compile a single operator for a field path.
 */
function compileOperator(fieldPath: string, op: string, opValue: unknown): Predicate {
  switch (op) {
    case "$eq":
      return (record) => {
        const fieldValue = getNestedValue(record, fieldPath);
        return isEqual(fieldValue, opValue);
      };

    case "$ne":
      return (record) => {
        const fieldValue = getNestedValue(record, fieldPath);
        return !isEqual(fieldValue, opValue);
      };

    case "$gt":
      return (record) => {
        const fieldValue = getNestedValue(record, fieldPath);
        const cmp = compareValues(fieldValue, opValue);
        return !Number.isNaN(cmp) && cmp > 0;
      };

    case "$gte":
      return (record) => {
        const fieldValue = getNestedValue(record, fieldPath);
        const cmp = compareValues(fieldValue, opValue);
        return !Number.isNaN(cmp) && cmp >= 0;
      };

    case "$lt":
      return (record) => {
        const fieldValue = getNestedValue(record, fieldPath);
        const cmp = compareValues(fieldValue, opValue);
        return !Number.isNaN(cmp) && cmp < 0;
      };

    case "$lte":
      return (record) => {
        const fieldValue = getNestedValue(record, fieldPath);
        const cmp = compareValues(fieldValue, opValue);
        return !Number.isNaN(cmp) && cmp <= 0;
      };

    case "$in": {
      if (!Array.isArray(opValue)) {
        throw new Error(`$in requires an array value, got ${typeof opValue}`);
      }
      const values = opValue;
      return (record) => {
        const fieldValue = getNestedValue(record, fieldPath);
        return values.some((v) => isEqual(fieldValue, v));
      };
    }

    case "$nin": {
      if (!Array.isArray(opValue)) {
        throw new Error(`$nin requires an array value, got ${typeof opValue}`);
      }
      const values = opValue;
      return (record) => {
        const fieldValue = getNestedValue(record, fieldPath);
        return !values.some((v) => isEqual(fieldValue, v));
      };
    }

    case "$contains": {
      return (record) => {
        const fieldValue = getNestedValue(record, fieldPath);
        if (typeof fieldValue === "string" && typeof opValue === "string") {
          return fieldValue.includes(opValue);
        }
        if (Array.isArray(fieldValue)) {
          return fieldValue.some((v) => isEqual(v, opValue));
        }
        return false;
      };
    }

    case "$startsWith": {
      if (typeof opValue !== "string") {
        throw new Error(`$startsWith requires a string value, got ${typeof opValue}`);
      }
      const prefix = opValue;
      return (record) => {
        const fieldValue = getNestedValue(record, fieldPath);
        return typeof fieldValue === "string" && fieldValue.startsWith(prefix);
      };
    }

    case "$endsWith": {
      if (typeof opValue !== "string") {
        throw new Error(`$endsWith requires a string value, got ${typeof opValue}`);
      }
      const suffix = opValue;
      return (record) => {
        const fieldValue = getNestedValue(record, fieldPath);
        return typeof fieldValue === "string" && fieldValue.endsWith(suffix);
      };
    }

    case "$exists": {
      if (typeof opValue !== "boolean") {
        throw new Error(`$exists requires a boolean value, got ${typeof opValue}`);
      }
      const shouldExist = opValue;
      return (record) => {
        const exists = hasNestedField(record, fieldPath);
        return shouldExist ? exists : !exists;
      };
    }

    case "$regex": {
      let regex: RegExp;
      if (opValue instanceof RegExp) {
        regex = opValue;
      } else if (typeof opValue === "string") {
        regex = new RegExp(opValue);
      } else {
        throw new Error(`$regex requires a string or RegExp value, got ${typeof opValue}`);
      }
      return (record) => {
        const fieldValue = getNestedValue(record, fieldPath);
        return typeof fieldValue === "string" && regex.test(fieldValue);
      };
    }

    case "$not": {
      if (opValue === null || opValue === undefined || typeof opValue !== "object" || Array.isArray(opValue)) {
        throw new Error(`$not requires an operator object, got ${typeof opValue}`);
      }
      const innerPredicate = compileFieldCondition(fieldPath, opValue);
      return (record) => !innerPredicate(record);
    }

    default:
      throw new Error(`Unknown filter operator: ${op}`);
  }
}

/**
 * Compile a filter object into a predicate function.
 *
 * Supports:
 * - Implicit equality: `{ role: "admin" }`
 * - Operator expressions: `{ age: { $gt: 18 } }`
 * - Dot-notation: `{ "metadata.tags": { $contains: "urgent" } }`
 * - Logical operators: `{ $and: [...] }`, `{ $or: [...] }`
 * - Negation: `{ field: { $not: { $eq: "value" } } }`
 * - Empty/undefined filter returns a match-all predicate
 *
 * Top-level keys are implicitly ANDed.
 *
 * @throws Error if the filter contains invalid operators or malformed expressions
 */
export function compileFilter(filter: Record<string, unknown> | null | undefined): Predicate {
  // Empty or undefined filter -> match all
  if (filter === null || filter === undefined) {
    return () => true;
  }

  if (typeof filter !== "object" || Array.isArray(filter)) {
    throw new Error(`Filter must be a plain object, got ${Array.isArray(filter) ? "array" : typeof filter}`);
  }

  const keys = Object.keys(filter);

  // Empty object -> match all
  if (keys.length === 0) {
    return () => true;
  }

  const predicates: Predicate[] = [];

  for (const key of keys) {
    const value = filter[key];

    if (key === "$and") {
      if (!Array.isArray(value)) {
        throw new Error("$and requires an array of filter objects");
      }
      const andPredicates = value.map((subFilter) => {
        if (subFilter === null || typeof subFilter !== "object" || Array.isArray(subFilter)) {
          throw new Error("$and array elements must be filter objects");
        }
        return compileFilter(subFilter as Record<string, unknown>);
      });
      predicates.push((record) => andPredicates.every((p) => p(record)));
      continue;
    }

    if (key === "$or") {
      if (!Array.isArray(value)) {
        throw new Error("$or requires an array of filter objects");
      }
      const orPredicates = value.map((subFilter) => {
        if (subFilter === null || typeof subFilter !== "object" || Array.isArray(subFilter)) {
          throw new Error("$or array elements must be filter objects");
        }
        return compileFilter(subFilter as Record<string, unknown>);
      });
      predicates.push((record) => orPredicates.some((p) => p(record)));
      continue;
    }

    if (key === "$not") {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("$not at top level requires a filter object");
      }
      const innerPredicate = compileFilter(value as Record<string, unknown>);
      predicates.push((record) => !innerPredicate(record));
      continue;
    }

    // Regular field condition
    if (key.startsWith("$")) {
      throw new Error(`Unknown top-level operator: ${key}`);
    }

    predicates.push(compileFieldCondition(key, value));
  }

  // Implicit AND of all top-level conditions
  if (predicates.length === 1) return predicates[0];
  return (record) => predicates.every((p) => p(record));
}
