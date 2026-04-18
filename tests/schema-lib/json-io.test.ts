import { describe, it, expect } from "vitest";
import { loadSchemaFromJSON, exportSchemaToJSON } from "../../src/schema.js";
import type { PersistedSchema } from "../../src/schema.js";

describe("loadSchemaFromJSON / exportSchemaToJSON", () => {
  const sampleSchema: PersistedSchema = {
    name: "tickets",
    version: 1,
    description: "Customer support tickets",
    instructions: "Set priority based on customer tier",
    fields: {
      title: { type: "string", required: true, description: "Short summary" },
      status: { type: "enum", values: ["open", "in_progress", "resolved", "closed"], default: "open" },
      priority: { type: "enum", values: ["low", "medium", "high"] },
    },
    indexes: ["status", "priority"],
  };

  it("round-trip: export → import produces equivalent schema", () => {
    const json = exportSchemaToJSON(sampleSchema);
    const loaded = loadSchemaFromJSON(json);
    expect(loaded).toEqual(sampleSchema);
  });

  it("loadSchemaFromJSON accepts object input", () => {
    const loaded = loadSchemaFromJSON({ ...sampleSchema });
    expect(loaded.name).toBe("tickets");
    expect(loaded.description).toBe("Customer support tickets");
  });

  it("loadSchemaFromJSON validates and rejects invalid input", () => {
    expect(() => loadSchemaFromJSON("{}")).toThrow("non-empty string");
    expect(() => loadSchemaFromJSON('{"name":"t","version":-1}')).toThrow("positive integer");
    expect(() => loadSchemaFromJSON("not json")).toThrow();
  });

  it("exportSchemaToJSON produces pretty-printed JSON", () => {
    const json = exportSchemaToJSON({ name: "test", version: 1 });
    expect(json).toContain("\n"); // pretty-printed
    expect(JSON.parse(json)).toEqual({ name: "test", version: 1 });
  });

  it("loadSchemaFromJSON accepts minimal schema", () => {
    const loaded = loadSchemaFromJSON('{"name":"minimal"}');
    expect(loaded).toEqual({ name: "minimal" });
  });
});
