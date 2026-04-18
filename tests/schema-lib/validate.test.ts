import { describe, it, expect } from "vitest";
import { extractPersistedSchema, validatePersistedSchema } from "../../src/schema.js";
import type { SchemaDefinition, PersistedSchema } from "../../src/schema.js";

describe("extractPersistedSchema", () => {
  it("extracts all serializable fields", () => {
    const def: SchemaDefinition = {
      name: "tickets",
      version: 3,
      description: "Support tickets",
      instructions: "Set priority based on customer tier",
      fields: {
        title: { type: "string", required: true, maxLength: 200, description: "Short summary" },
        status: { type: "enum", values: ["open", "closed"], default: "open" },
        score: { type: "number", min: 0, max: 100 },
        tags: { type: "string[]" },
      },
      indexes: ["status"],
      compositeIndexes: [["status", "score"]],
      arrayIndexes: ["tags"],
      tagField: "tags",
      storageMode: "disk",
    };

    const persisted = extractPersistedSchema(def);
    expect(persisted.name).toBe("tickets");
    expect(persisted.version).toBe(3);
    expect(persisted.description).toBe("Support tickets");
    expect(persisted.instructions).toBe("Set priority based on customer tier");
    expect(persisted.indexes).toEqual(["status"]);
    expect(persisted.compositeIndexes).toEqual([["status", "score"]]);
    expect(persisted.arrayIndexes).toEqual(["tags"]);
    expect(persisted.tagField).toBe("tags");
    expect(persisted.storageMode).toBe("disk");

    // Fields preserved
    expect(persisted.fields?.title).toEqual({ type: "string", required: true, maxLength: 200, description: "Short summary" });
    expect(persisted.fields?.status).toEqual({ type: "enum", values: ["open", "closed"], default: "open" });
    expect(persisted.fields?.score).toEqual({ type: "number", min: 0, max: 100 });
    expect(persisted.fields?.tags).toEqual({ type: "string[]" });
  });

  it("strips function defaults", () => {
    const def: SchemaDefinition = {
      name: "test",
      fields: {
        createdAt: { type: "string", default: () => new Date().toISOString() },
        status: { type: "string", default: "active" },
      },
    };

    const persisted = extractPersistedSchema(def);
    expect(persisted.fields?.createdAt.default).toBeUndefined();
    expect(persisted.fields?.status.default).toBe("active");
  });

  it("strips pattern and resolve from fields", () => {
    const def: SchemaDefinition = {
      name: "test",
      fields: {
        slug: { type: "string", pattern: /^[a-z-]+$/, description: "URL slug" },
        due: { type: "string", resolve: (v) => String(v) },
      },
    };

    const persisted = extractPersistedSchema(def);
    // pattern and resolve should not be in the output at all
    expect(persisted.fields?.slug).toEqual({ type: "string", description: "URL slug" });
    expect(persisted.fields?.due).toEqual({ type: "string" });
    expect("pattern" in (persisted.fields?.slug ?? {})).toBe(false);
    expect("resolve" in (persisted.fields?.due ?? {})).toBe(false);
  });

  it("does not include hooks, computed, or virtualFilters", () => {
    const def: SchemaDefinition = {
      name: "test",
      computed: { upper: (r) => (r.name as string).toUpperCase() },
      virtualFilters: { "+ACTIVE": (r) => !!r.active },
      hooks: { beforeInsert: () => {} },
    };

    const persisted = extractPersistedSchema(def);
    expect("computed" in persisted).toBe(false);
    expect("virtualFilters" in persisted).toBe(false);
    expect("hooks" in persisted).toBe(false);
  });

  it("omits empty optional fields", () => {
    const persisted = extractPersistedSchema({ name: "minimal" });
    expect(persisted).toEqual({ name: "minimal" });
    expect(Object.keys(persisted)).toEqual(["name"]);
  });

  it("produces JSON-serializable output", () => {
    const def: SchemaDefinition = {
      name: "json-safe",
      version: 1,
      description: "Test",
      fields: {
        title: { type: "string", required: true, pattern: /abc/, resolve: () => "x", default: () => "y" },
        count: { type: "number", min: 0 },
      },
      indexes: ["count"],
      hooks: { afterInsert: () => {} },
      computed: { x: () => 1 },
    };

    const persisted = extractPersistedSchema(def);
    const json = JSON.stringify(persisted);
    const roundTripped = JSON.parse(json);
    expect(roundTripped.name).toBe("json-safe");
    expect(roundTripped.fields.title.type).toBe("string");
    expect(roundTripped.fields.title.default).toBeUndefined();
  });

  it("deep-copies arrays so mutations don't affect original", () => {
    const indexes = ["status"];
    const def: SchemaDefinition = { name: "copy-test", indexes };

    const persisted = extractPersistedSchema(def);
    persisted.indexes!.push("extra");
    expect(indexes).toEqual(["status"]);
  });
});

describe("validatePersistedSchema", () => {
  it("accepts a valid minimal schema", () => {
    expect(() => validatePersistedSchema({ name: "test" })).not.toThrow();
  });

  it("accepts a full valid schema", () => {
    const schema: PersistedSchema = {
      name: "tickets",
      version: 1,
      description: "Support tickets",
      instructions: "Use wisely",
      fields: {
        title: { type: "string", required: true, maxLength: 200, description: "Title" },
        status: { type: "enum", values: ["open", "closed"], default: "open" },
        score: { type: "number", min: 0, max: 100 },
      },
      indexes: ["status"],
      compositeIndexes: [["status", "score"]],
      arrayIndexes: ["status"],
      tagField: "tags",
      storageMode: "disk",
    };
    expect(() => validatePersistedSchema(schema)).not.toThrow();
  });

  it("rejects non-object", () => {
    expect(() => validatePersistedSchema(null)).toThrow("non-null object");
    expect(() => validatePersistedSchema("string")).toThrow("non-null object");
    expect(() => validatePersistedSchema([])).toThrow("non-null object");
  });

  it("rejects missing or empty name", () => {
    expect(() => validatePersistedSchema({})).toThrow("'name' must be a non-empty string");
    expect(() => validatePersistedSchema({ name: "" })).toThrow("'name' must be a non-empty string");
    expect(() => validatePersistedSchema({ name: 42 })).toThrow("'name' must be a non-empty string");
  });

  it("rejects invalid version", () => {
    expect(() => validatePersistedSchema({ name: "t", version: 0 })).toThrow("positive integer");
    expect(() => validatePersistedSchema({ name: "t", version: -1 })).toThrow("positive integer");
    expect(() => validatePersistedSchema({ name: "t", version: 1.5 })).toThrow("positive integer");
    expect(() => validatePersistedSchema({ name: "t", version: "1" })).toThrow("positive integer");
  });

  it("rejects invalid field types", () => {
    expect(() => validatePersistedSchema({
      name: "t",
      fields: { x: { type: "invalid" } },
    })).toThrow("invalid type 'invalid'");
  });

  it("rejects invalid field properties", () => {
    expect(() => validatePersistedSchema({
      name: "t",
      fields: { x: { type: "string", required: "yes" } },
    })).toThrow("required");

    expect(() => validatePersistedSchema({
      name: "t",
      fields: { x: { type: "enum", values: [1, 2] } },
    })).toThrow("values");

    expect(() => validatePersistedSchema({
      name: "t",
      fields: { x: { type: "number", min: "zero" } },
    })).toThrow("min");
  });

  it("rejects invalid indexes", () => {
    expect(() => validatePersistedSchema({
      name: "t",
      indexes: "status",
    })).toThrow("array of strings");

    expect(() => validatePersistedSchema({
      name: "t",
      compositeIndexes: ["status"],
    })).toThrow("array of string arrays");
  });

  it("rejects invalid storageMode", () => {
    expect(() => validatePersistedSchema({
      name: "t",
      storageMode: "fast",
    })).toThrow("storageMode");
  });

  it("forward-compat: unknown top-level properties are silently ignored", () => {
    expect(() => validatePersistedSchema({
      name: "t",
      version: 1,
      unknownFutureFeature: "some-value",
      anotherNewProp: { nested: true },
    })).not.toThrow();
  });

  it("forward-compat: unknown field-level properties are silently ignored", () => {
    expect(() => validatePersistedSchema({
      name: "t",
      fields: {
        x: { type: "string", futureConstraint: "strict", anotherProp: 42 },
      },
    })).not.toThrow();
  });
});

