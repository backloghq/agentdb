import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AgentDB } from "../src/agentdb.js";
import { defineSchema } from "../src/schema.js";
import { loadSchemaFromJSON, extractPersistedSchema, validatePersistedSchema, mergeSchemas, mergePersistedSchemas } from "../src/schema.js";
import type { PersistedSchema } from "../src/schema.js";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "agentdb-searchable-"));
}

async function textSearch(col: Awaited<ReturnType<AgentDB["collection"]>>, query: string) {
  const result = await col.find({ filter: { $text: query } });
  return result.records;
}

describe("searchable fields — schema definition", () => {
  it("searchableFields() returns [] when no schema is set", async () => {
    const dir = makeTmpDir();
    const db = new AgentDB(dir);
    await db.init();
    try {
      const col = await db.collection("things");
      expect(col.searchableFields()).toEqual([]);
    } finally {
      await db.close();
      rmSync(dir, { recursive: true });
    }
  });

  it("searchableFields() returns [] when schema has no searchable flags", async () => {
    const dir = makeTmpDir();
    const db = new AgentDB(dir);
    await db.init();
    try {
      const schema = defineSchema({
        name: "things",
        textSearch: true,
        fields: { title: { type: "string" }, body: { type: "string" } },
      });
      const col = await db.collection(schema);
      expect(col.searchableFields()).toEqual([]);
    } finally {
      await db.close();
      rmSync(dir, { recursive: true });
    }
  });

  it("searchableFields() returns only marked fields", async () => {
    const dir = makeTmpDir();
    const db = new AgentDB(dir);
    await db.init();
    try {
      const schema = defineSchema({
        name: "things",
        textSearch: true,
        fields: {
          title: { type: "string", searchable: true },
          body: { type: "string", searchable: true },
          _agent: { type: "string" },
        },
      });
      const col = await db.collection(schema);
      expect(col.searchableFields().sort()).toEqual(["body", "title"]);
    } finally {
      await db.close();
      rmSync(dir, { recursive: true });
    }
  });

  it("non-string field with searchable:true is ignored with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = makeTmpDir();
    const db = new AgentDB(dir);
    await db.init();
    try {
      const schema = defineSchema({
        name: "things",
        textSearch: true,
        fields: {
          title: { type: "string", searchable: true },
          count: { type: "number", searchable: true },
        },
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("count"));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("number"));
      const col = await db.collection(schema);
      expect(col.searchableFields()).toEqual(["title"]);
    } finally {
      await db.close();
      rmSync(dir, { recursive: true });
      warn.mockRestore();
    }
  });
});

describe("searchable fields — text index projection", () => {
  let dir: string;
  let db: AgentDB;

  beforeEach(async () => {
    dir = makeTmpDir();
    db = new AgentDB(dir);
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true });
  });

  it("unmarked field tokens are not indexed", async () => {
    const schema = defineSchema({
      name: "events",
      textSearch: true,
      fields: {
        title: { type: "string", searchable: true },
        secret: { type: "string" }, // not searchable
      },
    });
    const col = await db.collection(schema);
    await col.insert({ title: "hello world", secret: "classified" });

    expect((await textSearch(col, "hello")).length).toBe(1);
    expect((await textSearch(col, "classified")).length).toBe(0);
  });

  it("no schema → all-strings fallback (backwards compat)", async () => {
    const col = await db.collection("raw", { textSearch: true });
    await col.insert({ title: "hello", secret: "classified" });

    expect((await textSearch(col, "hello")).length).toBe(1);
    expect((await textSearch(col, "classified")).length).toBe(1);
  });

  it("schema with zero searchable flags → all-strings fallback", async () => {
    const schema = defineSchema({
      name: "things",
      textSearch: true,
      fields: { title: { type: "string" }, body: { type: "string" } },
    });
    const col = await db.collection(schema);
    await col.insert({ title: "hello", body: "world" });

    expect((await textSearch(col, "hello")).length).toBe(1);
    expect((await textSearch(col, "world")).length).toBe(1);
  });

  it("string[] field with searchable:true indexes array elements", async () => {
    const schema = defineSchema({
      name: "docs",
      textSearch: true,
      fields: {
        tags: { type: "string[]", searchable: true },
        private: { type: "string" },
      },
    });
    const col = await db.collection(schema);
    await col.insert({ tags: ["urgent", "important"], private: "hidden" });

    expect((await textSearch(col, "urgent")).length).toBe(1);
    expect((await textSearch(col, "important")).length).toBe(1);
    expect((await textSearch(col, "hidden")).length).toBe(0);
  });

  it("re-indexing (same id, update) respects field projection", async () => {
    const schema = defineSchema({
      name: "docs",
      textSearch: true,
      fields: {
        title: { type: "string", searchable: true },
        noise: { type: "string" },
      },
    });
    const col = await db.collection(schema);
    const id = await col.insert({ title: "hello", noise: "alpha" });
    await col.update({ _id: id }, { $set: { title: "goodbye", noise: "beta" } });

    expect((await textSearch(col, "hello")).length).toBe(0);
    expect((await textSearch(col, "goodbye")).length).toBe(1);
    expect((await textSearch(col, "alpha")).length).toBe(0);
    expect((await textSearch(col, "beta")).length).toBe(0);
  });
});

describe("searchable fields — PersistedSchema round-trip", () => {
  it("extractPersistedSchema preserves searchable flag", () => {
    const def = {
      name: "docs",
      fields: {
        title: { type: "string" as const, searchable: true },
        body: { type: "string" as const },
      },
    };
    const p = extractPersistedSchema(def);
    expect(p.fields?.title?.searchable).toBe(true);
    expect(p.fields?.body?.searchable).toBeUndefined();
  });

  it("loadSchemaFromJSON round-trips searchable flag", () => {
    const schema = {
      name: "docs",
      fields: {
        title: { type: "string", searchable: true },
      },
    };
    const loaded = loadSchemaFromJSON(JSON.stringify(schema));
    expect(loaded.fields?.title?.searchable).toBe(true);
  });

  it("validatePersistedSchema rejects non-boolean searchable", () => {
    const schema = {
      name: "docs",
      fields: { title: { type: "string", searchable: "yes" } },
    };
    expect(() => validatePersistedSchema(schema)).toThrow("searchable");
  });

  it("validatePersistedSchema accepts boolean searchable", () => {
    const schema = {
      name: "docs",
      fields: { title: { type: "string", searchable: true } },
    };
    expect(() => validatePersistedSchema(schema)).not.toThrow();
  });
});

describe("textRecord fallback — _id and _version excluded from BM25 index", () => {
  let dir: string;
  let db: AgentDB;

  beforeEach(async () => {
    dir = makeTmpDir();
    db = new AgentDB(dir);
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("BM25 search on _id value returns no results (UUID not indexed)", async () => {
    // No searchableFields — fallback path (all fields). _id must be excluded.
    const schema = defineSchema({ name: "noid", textSearch: true });
    const col = await db.collection(schema);

    // Use a deterministic _id with a unique token (zxqid) not in any field value
    await col.insert({ _id: "zxqid-abc123", title: "hello world" });

    // Searching for the unique _id token must return nothing
    const result = await col.bm25Search("zxqid");
    expect(result.records).toHaveLength(0);
  });

  it("field content is still BM25-searchable in fallback mode", async () => {
    const schema = defineSchema({ name: "nover", textSearch: true });
    const col = await db.collection(schema);
    // _id contains "xqtoken" which is a unique string not in title
    await col.insert({ _id: "xqtoken-doc", title: "hello world content" });

    // Field content must be found
    const found = await col.bm25Search("hello");
    expect(found.records.map(r => r._id)).toContain("xqtoken-doc");

    // _id token must NOT be found
    const notFound = await col.bm25Search("xqtoken");
    expect(notFound.records).toHaveLength(0);
  });
});

describe("bm25 schema option — Collection plumbing", () => {
  let dir: string;
  let db: AgentDB;

  beforeEach(async () => {
    dir = makeTmpDir();
    db = new AgentDB(dir);
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("k1/b from schema flow into TextIndex and change scores vs defaults", async () => {
    // b=1.0 = full length normalization — long docs are penalized
    const schema = defineSchema({
      name: "bm25tune",
      textSearch: true,
      bm25: { k1: 1.2, b: 1.0 },
      fields: { text: { type: "string", searchable: true } },
    });
    const col = await db.collection(schema);

    // short: 2 tokens; long: 6 tokens; both contain "rust" once
    await col.insert({ _id: "short", text: "rust guide" });
    await col.insert({ _id: "long",  text: "rust detailed advanced comprehensive guide overview" });

    const result = await col.bm25Search("rust");
    const ids = result.records.map(r => r._id as string);
    const scores = Object.fromEntries(ids.map((id, i) => [id, result.scores[i]]));

    // With b=1.0, shorter doc (less length dilution) must score higher
    expect(scores["short"]).toBeGreaterThan(scores["long"]);
  });
});

describe("searchable fields — non-string FieldDef types warn and are excluded", () => {
  const offendingTypes: Array<{ label: string; fieldDef: Record<string, unknown> }> = [
    { label: "boolean", fieldDef: { type: "boolean", searchable: true } },
    { label: "number",  fieldDef: { type: "number",  searchable: true } },
    { label: "enum",    fieldDef: { type: "enum", values: ["a", "b"], searchable: true } },
    { label: "autoIncrement", fieldDef: { type: "autoIncrement", searchable: true } },
    { label: "object",  fieldDef: { type: "object", searchable: true } },
  ];

  for (const { label, fieldDef } of offendingTypes) {
    it(`searchable:true on '${label}' field warns and excludes it from searchableFields()`, () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const schema = defineSchema({
          name: "things",
          textSearch: true,
          fields: {
            title: { type: "string", searchable: true },
            bad:   fieldDef as Parameters<typeof defineSchema>[0]["fields"][string],
          },
        });
        // At least one warning about the offending field
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("bad"));
        // Only string field survives
        const { collectionOptions } = schema;
        expect(collectionOptions?.searchableFields).toEqual(["title"]);
      } finally {
        warn.mockRestore();
      }
    });
  }

  it("string[] field with searchable:true is accepted without warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const schema = defineSchema({
        name: "things2",
        textSearch: true,
        fields: {
          tags: { type: "string[]", searchable: true },
        },
      });
      expect(warn).not.toHaveBeenCalled();
      expect(schema.collectionOptions?.searchableFields).toEqual(["tags"]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("searchable — mergeSchemas: code wins", () => {
  it("code searchable:false overrides persisted searchable:true", () => {
    const code = defineSchema({
      name: "col",
      fields: { body: { type: "string", searchable: false } },
    });
    const persisted: PersistedSchema = {
      name: "col",
      version: 1,
      fields: { body: { type: "string", searchable: true } },
    };
    const { persisted: merged } = mergeSchemas(code.definition!, persisted);
    expect(merged.fields?.body?.searchable).toBe(false);
  });

  it("code searchable:true overrides persisted searchable:false", () => {
    const code = defineSchema({
      name: "col",
      fields: { body: { type: "string", searchable: true } },
    });
    const persisted: PersistedSchema = {
      name: "col",
      version: 1,
      fields: { body: { type: "string", searchable: false } },
    };
    const { persisted: merged } = mergeSchemas(code.definition!, persisted);
    expect(merged.fields?.body?.searchable).toBe(true);
  });

  it("persisted searchable used as fallback when code omits it", () => {
    const code = defineSchema({
      name: "col",
      fields: { body: { type: "string" } },
    });
    const persisted: PersistedSchema = {
      name: "col",
      version: 1,
      fields: { body: { type: "string", searchable: true } },
    };
    const { persisted: merged } = mergeSchemas(code.definition!, persisted);
    expect(merged.fields?.body?.searchable).toBe(true);
  });
});

describe("searchable — mergePersistedSchemas: overlay wins", () => {
  it("base searchable:true + overlay omits → preserved", () => {
    const base: PersistedSchema = { name: "col", version: 1, fields: { body: { type: "string", searchable: true } } };
    const overlay: PersistedSchema = { name: "col", version: 1, fields: { body: { type: "string" } } };
    const merged = mergePersistedSchemas(base, overlay);
    expect(merged.fields?.body?.searchable).toBe(true);
  });

  it("base omits + overlay searchable:true → set", () => {
    const base: PersistedSchema = { name: "col", version: 1, fields: { body: { type: "string" } } };
    const overlay: PersistedSchema = { name: "col", version: 1, fields: { body: { type: "string", searchable: true } } };
    const merged = mergePersistedSchemas(base, overlay);
    expect(merged.fields?.body?.searchable).toBe(true);
  });

  it("base searchable:true + overlay searchable:false → false", () => {
    const base: PersistedSchema = { name: "col", version: 1, fields: { body: { type: "string", searchable: true } } };
    const overlay: PersistedSchema = { name: "col", version: 1, fields: { body: { type: "string", searchable: false } } };
    const merged = mergePersistedSchemas(base, overlay);
    expect(merged.fields?.body?.searchable).toBe(false);
  });
});
