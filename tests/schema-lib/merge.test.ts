import { describe, it, expect } from "vitest";
import { mergeSchemas, mergePersistedSchemas } from "../../src/schema.js";

describe("mergeSchemas", () => {
  it("persisted description/instructions win over code", () => {
    const { persisted } = mergeSchemas(
      { name: "t", description: "Code desc", instructions: "Code inst" },
      { name: "t", description: "Persisted desc", instructions: "Persisted inst" },
    );
    expect(persisted.description).toBe("Persisted desc");
    expect(persisted.instructions).toBe("Persisted inst");
  });

  it("code fills in missing description/instructions", () => {
    const { persisted } = mergeSchemas(
      { name: "t", description: "Code desc", instructions: "Code inst" },
      { name: "t" },
    );
    expect(persisted.description).toBe("Code desc");
    expect(persisted.instructions).toBe("Code inst");
  });

  it("persisted version wins", () => {
    const { persisted } = mergeSchemas(
      { name: "t", version: 3 },
      { name: "t", version: 1 },
    );
    expect(persisted.version).toBe(1);
  });

  it("warns on version mismatch", () => {
    const { warnings } = mergeSchemas(
      { name: "t", version: 2 },
      { name: "t", version: 1 },
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/version mismatch.*code v2.*persisted v1/);
  });

  it("no warning when versions match", () => {
    const { warnings } = mergeSchemas(
      { name: "t", version: 1 },
      { name: "t", version: 1 },
    );
    expect(warnings).toHaveLength(0);
  });

  it("no warning when version is undefined on either side", () => {
    const { warnings: w1 } = mergeSchemas({ name: "t" }, { name: "t", version: 1 });
    const { warnings: w2 } = mergeSchemas({ name: "t", version: 1 }, { name: "t" });
    expect(w1).toHaveLength(0);
    expect(w2).toHaveLength(0);
  });

  it("warns on field type mismatch", () => {
    const { persisted, warnings } = mergeSchemas(
      { name: "t", fields: { x: { type: "string" } } },
      { name: "t", fields: { x: { type: "number" } } },
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Field 'x' type mismatch/);
    // Code type wins for validation
    expect(persisted.fields?.x.type).toBe("string");
  });

  it("unions indexes from both sides", () => {
    const { persisted } = mergeSchemas(
      { name: "t", indexes: ["status", "priority"], arrayIndexes: ["tags"] },
      { name: "t", indexes: ["status", "date"], arrayIndexes: ["labels"] },
    );
    expect(persisted.indexes).toEqual(["status", "date", "priority"]);
    expect(persisted.arrayIndexes).toEqual(["labels", "tags"]);
  });

  it("unions composite indexes", () => {
    const { persisted } = mergeSchemas(
      { name: "t", compositeIndexes: [["a", "b"], ["c", "d"]] },
      { name: "t", compositeIndexes: [["a", "b"], ["e", "f"]] },
    );
    expect(persisted.compositeIndexes).toEqual([["a", "b"], ["e", "f"], ["c", "d"]]);
  });

  it("unions fields from both sides", () => {
    const { persisted } = mergeSchemas(
      { name: "t", fields: { title: { type: "string" }, status: { type: "enum", values: ["a"] } } },
      { name: "t", fields: { title: { type: "string", description: "Persisted" }, priority: { type: "number" } } },
    );
    expect(Object.keys(persisted.fields!).sort()).toEqual(["priority", "status", "title"]);
    expect(persisted.fields?.title.description).toBe("Persisted"); // persisted desc wins
    expect(persisted.fields?.status.type).toBe("enum");
    expect(persisted.fields?.priority.type).toBe("number");
  });

  it("code tagField/storageMode wins when set", () => {
    const { persisted } = mergeSchemas(
      { name: "t", tagField: "labels", storageMode: "disk" },
      { name: "t", tagField: "tags", storageMode: "memory" },
    );
    expect(persisted.tagField).toBe("labels");
    expect(persisted.storageMode).toBe("disk");
  });

  it("persisted tagField/storageMode used when code is unset", () => {
    const { persisted } = mergeSchemas(
      { name: "t" },
      { name: "t", tagField: "tags", storageMode: "memory" },
    );
    expect(persisted.tagField).toBe("tags");
    expect(persisted.storageMode).toBe("memory");
  });

  it("strips function defaults from code fields", () => {
    const { persisted } = mergeSchemas(
      { name: "t", fields: { ts: { type: "string", default: () => "now" } } },
      { name: "t" },
    );
    expect(persisted.fields?.ts.default).toBeUndefined();
  });
});

describe("mergePersistedSchemas", () => {
  it("overlay scalar properties win over base", () => {
    const result = mergePersistedSchemas(
      { name: "t", version: 1, description: "Base", instructions: "Base inst" },
      { name: "t", version: 2, description: "Overlay", instructions: "Overlay inst" },
    );
    expect(result.version).toBe(2);
    expect(result.description).toBe("Overlay");
    expect(result.instructions).toBe("Overlay inst");
  });

  it("base scalar properties preserved when overlay omits them", () => {
    const result = mergePersistedSchemas(
      { name: "t", version: 1, description: "Base", instructions: "Base inst" },
      { name: "t" },
    );
    expect(result.version).toBe(1);
    expect(result.description).toBe("Base");
    expect(result.instructions).toBe("Base inst");
  });

  it("preserves untouched field properties when overlay updates only one property", () => {
    const result = mergePersistedSchemas(
      { name: "t", fields: { title: { type: "string", required: true, description: "The title" } } },
      { name: "t", fields: { title: { type: "string" } } },
    );
    expect(result.fields?.title.required).toBe(true);
    expect(result.fields?.title.description).toBe("The title");
  });

  it("overlay field properties win when both sides specify them", () => {
    const result = mergePersistedSchemas(
      { name: "t", fields: { status: { type: "enum", values: ["a", "b"], description: "Base desc" } } },
      { name: "t", fields: { status: { type: "enum", values: ["x", "y"], description: "New desc" } } },
    );
    expect(result.fields?.status.values).toEqual(["x", "y"]);
    expect(result.fields?.status.description).toBe("New desc");
  });

  it("base-only fields preserved in merged result", () => {
    const result = mergePersistedSchemas(
      { name: "t", fields: { existing: { type: "string", description: "Keep me" } } },
      { name: "t", fields: { newField: { type: "number" } } },
    );
    expect(result.fields?.existing).toEqual({ type: "string", description: "Keep me" });
    expect(result.fields?.newField).toEqual({ type: "number" });
  });

  it("unions indexes from both sides", () => {
    const result = mergePersistedSchemas(
      { name: "t", indexes: ["a", "b"], arrayIndexes: ["tags"] },
      { name: "t", indexes: ["b", "c"], arrayIndexes: ["labels"] },
    );
    expect(result.indexes).toEqual(["a", "b", "c"]);
    expect(result.arrayIndexes).toEqual(["tags", "labels"]);
  });

  it("unions composite indexes", () => {
    const result = mergePersistedSchemas(
      { name: "t", compositeIndexes: [["a", "b"]] },
      { name: "t", compositeIndexes: [["a", "b"], ["c", "d"]] },
    );
    expect(result.compositeIndexes).toEqual([["a", "b"], ["c", "d"]]);
  });

  it("overlay tagField and storageMode win", () => {
    const result = mergePersistedSchemas(
      { name: "t", tagField: "labels", storageMode: "memory" },
      { name: "t", tagField: "tags", storageMode: "disk" },
    );
    expect(result.tagField).toBe("tags");
    expect(result.storageMode).toBe("disk");
  });

  it("no spurious undefined keys in output", () => {
    const result = mergePersistedSchemas({ name: "t" }, { name: "t" });
    expect(Object.keys(result)).toEqual(["name"]);
  });

  it("overlay required:false explicitly clears base required:true", () => {
    const result = mergePersistedSchemas(
      { name: "t", fields: { title: { type: "string", required: true } } },
      { name: "t", fields: { title: { type: "string", required: false } } },
    );
    expect(result.fields?.title.required).toBeFalsy();
  });

  it("empty fields:{} in overlay preserves base fields (same as no fields key)", () => {
    const withEmpty = mergePersistedSchemas(
      { name: "t", fields: { title: { type: "string", description: "keep" } } },
      { name: "t", fields: {} },
    );
    const withAbsent = mergePersistedSchemas(
      { name: "t", fields: { title: { type: "string", description: "keep" } } },
      { name: "t" },
    );
    expect(withEmpty.fields?.title).toEqual({ type: "string", description: "keep" });
    expect(withAbsent.fields?.title).toEqual({ type: "string", description: "keep" });
  });

  it("overlay type wins for same field without emitting warnings (no MergeResult)", () => {
    const result = mergePersistedSchemas(
      { name: "t", fields: { count: { type: "string" } } },
      { name: "t", fields: { count: { type: "number" } } },
    );
    expect(result.fields?.count.type).toBe("number");
    // mergePersistedSchemas returns PersistedSchema, not MergeResult — no warnings property
    expect((result as Record<string, unknown>).warnings).toBeUndefined();
  });
});
