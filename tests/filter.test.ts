import { describe, it, expect } from "vitest";
import { compileFilter } from "../src/filter.js";

describe("compileFilter", () => {
  // ── Empty / undefined filter ──────────────────────────────────────

  describe("empty and undefined filters", () => {
    it("returns match-all for undefined", () => {
      const pred = compileFilter(undefined);
      expect(pred({ any: "value" })).toBe(true);
      expect(pred({})).toBe(true);
    });

    it("returns match-all for null", () => {
      const pred = compileFilter(null);
      expect(pred({ any: "value" })).toBe(true);
    });

    it("returns match-all for empty object", () => {
      const pred = compileFilter({});
      expect(pred({ role: "admin" })).toBe(true);
      expect(pred({})).toBe(true);
    });
  });

  // ── Invalid filter ────────────────────────────────────────────────

  describe("invalid filters", () => {
    it("throws for array filter", () => {
      expect(() => compileFilter([] as unknown as Record<string, unknown>)).toThrow(
        "Filter must be a plain object"
      );
    });

    it("throws for unknown top-level operator", () => {
      expect(() => compileFilter({ $unknown: true })).toThrow("Unknown top-level operator: $unknown");
    });

    it("throws for unknown field operator", () => {
      expect(() => compileFilter({ name: { $badOp: "val" } })).toThrow("Unknown filter operator: $badOp");
    });

    it("throws for $in with non-array", () => {
      expect(() => compileFilter({ role: { $in: "admin" } })).toThrow("$in requires an array");
    });

    it("throws for $nin with non-array", () => {
      expect(() => compileFilter({ role: { $nin: "admin" } })).toThrow("$nin requires an array");
    });

    it("throws for $exists with non-boolean", () => {
      expect(() => compileFilter({ role: { $exists: "yes" } })).toThrow("$exists requires a boolean");
    });

    it("throws for $startsWith with non-string", () => {
      expect(() => compileFilter({ name: { $startsWith: 123 } })).toThrow("$startsWith requires a string");
    });

    it("throws for $endsWith with non-string", () => {
      expect(() => compileFilter({ name: { $endsWith: 123 } })).toThrow("$endsWith requires a string");
    });

    it("throws for $regex with non-string non-regexp", () => {
      expect(() => compileFilter({ name: { $regex: 123 } })).toThrow("$regex requires a string or RegExp");
    });

    it("throws for $not with non-object", () => {
      expect(() => compileFilter({ name: { $not: "value" } })).toThrow("$not requires an operator object");
    });

    it("throws for $and with non-array", () => {
      expect(() => compileFilter({ $and: { role: "admin" } })).toThrow("$and requires an array");
    });

    it("throws for $or with non-array", () => {
      expect(() => compileFilter({ $or: { role: "admin" } })).toThrow("$or requires an array");
    });

    it("throws for $and with non-object elements", () => {
      expect(() => compileFilter({ $and: ["not-an-object"] })).toThrow(
        "$and array elements must be filter objects"
      );
    });

    it("throws for $or with non-object elements", () => {
      expect(() => compileFilter({ $or: [null] })).toThrow("$or array elements must be filter objects");
    });

    it("throws for top-level $not with non-object", () => {
      expect(() => compileFilter({ $not: "value" })).toThrow("$not at top level requires a filter object");
    });
  });

  // ── $eq operator ──────────────────────────────────────────────────

  describe("$eq", () => {
    it("matches implicit equality with string", () => {
      const pred = compileFilter({ role: "admin" });
      expect(pred({ role: "admin" })).toBe(true);
      expect(pred({ role: "user" })).toBe(false);
    });

    it("matches explicit $eq with string", () => {
      const pred = compileFilter({ role: { $eq: "admin" } });
      expect(pred({ role: "admin" })).toBe(true);
      expect(pred({ role: "user" })).toBe(false);
    });

    it("matches with number", () => {
      const pred = compileFilter({ age: 25 });
      expect(pred({ age: 25 })).toBe(true);
      expect(pred({ age: 26 })).toBe(false);
    });

    it("matches with boolean", () => {
      const pred = compileFilter({ active: true });
      expect(pred({ active: true })).toBe(true);
      expect(pred({ active: false })).toBe(false);
    });

    it("matches with null", () => {
      const pred = compileFilter({ deletedAt: null });
      expect(pred({ deletedAt: null })).toBe(true);
      expect(pred({ deletedAt: "2024-01-01" })).toBe(false);
    });

    it("null does not match undefined/missing field", () => {
      const pred = compileFilter({ deletedAt: null });
      expect(pred({ name: "test" })).toBe(false);
      expect(pred({})).toBe(false);
    });

    it("matches with zero", () => {
      const pred = compileFilter({ count: 0 });
      expect(pred({ count: 0 })).toBe(true);
      expect(pred({ count: 1 })).toBe(false);
      expect(pred({})).toBe(false);
    });

    it("matches with empty string", () => {
      const pred = compileFilter({ name: "" });
      expect(pred({ name: "" })).toBe(true);
      expect(pred({ name: "alice" })).toBe(false);
      expect(pred({})).toBe(false);
    });

    it("false does not match undefined", () => {
      const pred = compileFilter({ active: false });
      expect(pred({ active: false })).toBe(true);
      expect(pred({})).toBe(false);
    });
  });

  // ── $ne operator ──────────────────────────────────────────────────

  describe("$ne", () => {
    it("excludes matching value", () => {
      const pred = compileFilter({ role: { $ne: "admin" } });
      expect(pred({ role: "admin" })).toBe(false);
      expect(pred({ role: "user" })).toBe(true);
    });

    it("missing field is not equal", () => {
      const pred = compileFilter({ role: { $ne: "admin" } });
      expect(pred({})).toBe(true);
    });

    it("works with null", () => {
      const pred = compileFilter({ deletedAt: { $ne: null } });
      expect(pred({ deletedAt: null })).toBe(false);
      expect(pred({ deletedAt: "2024-01-01" })).toBe(true);
      expect(pred({})).toBe(true);
    });
  });

  // ── $gt, $gte, $lt, $lte operators ───────────────────────────────

  describe("comparison operators", () => {
    it("$gt with numbers", () => {
      const pred = compileFilter({ age: { $gt: 18 } });
      expect(pred({ age: 19 })).toBe(true);
      expect(pred({ age: 18 })).toBe(false);
      expect(pred({ age: 17 })).toBe(false);
    });

    it("$gte with numbers", () => {
      const pred = compileFilter({ age: { $gte: 18 } });
      expect(pred({ age: 19 })).toBe(true);
      expect(pred({ age: 18 })).toBe(true);
      expect(pred({ age: 17 })).toBe(false);
    });

    it("$lt with numbers", () => {
      const pred = compileFilter({ age: { $lt: 18 } });
      expect(pred({ age: 17 })).toBe(true);
      expect(pred({ age: 18 })).toBe(false);
      expect(pred({ age: 19 })).toBe(false);
    });

    it("$lte with numbers", () => {
      const pred = compileFilter({ age: { $lte: 18 } });
      expect(pred({ age: 17 })).toBe(true);
      expect(pred({ age: 18 })).toBe(true);
      expect(pred({ age: 19 })).toBe(false);
    });

    it("$gt with strings (lexicographic)", () => {
      const pred = compileFilter({ name: { $gt: "bob" } });
      expect(pred({ name: "charlie" })).toBe(true);
      expect(pred({ name: "bob" })).toBe(false);
      expect(pred({ name: "alice" })).toBe(false);
    });

    it("$gte with date strings", () => {
      const pred = compileFilter({ created: { $gte: "2026-01-01" } });
      expect(pred({ created: "2026-06-15" })).toBe(true);
      expect(pred({ created: "2026-01-01" })).toBe(true);
      expect(pred({ created: "2025-12-31" })).toBe(false);
    });

    it("$lt with date strings", () => {
      const pred = compileFilter({ created: { $lt: "2026-01-01" } });
      expect(pred({ created: "2025-12-31" })).toBe(true);
      expect(pred({ created: "2026-01-01" })).toBe(false);
    });

    it("comparison with missing field returns false", () => {
      const pred = compileFilter({ age: { $gt: 18 } });
      expect(pred({})).toBe(false);
    });

    it("comparison with incompatible types returns false", () => {
      const pred = compileFilter({ age: { $gt: 18 } });
      expect(pred({ age: "not-a-number" })).toBe(false);
      expect(pred({ age: true })).toBe(false);
      expect(pred({ age: null })).toBe(false);
    });

    it("range query with $gte and $lte combined", () => {
      const pred = compileFilter({ age: { $gte: 18, $lte: 65 } });
      expect(pred({ age: 17 })).toBe(false);
      expect(pred({ age: 18 })).toBe(true);
      expect(pred({ age: 40 })).toBe(true);
      expect(pred({ age: 65 })).toBe(true);
      expect(pred({ age: 66 })).toBe(false);
    });
  });

  // ── $in, $nin operators ───────────────────────────────────────────

  describe("$in and $nin", () => {
    it("$in matches any value in array", () => {
      const pred = compileFilter({ role: { $in: ["admin", "moderator"] } });
      expect(pred({ role: "admin" })).toBe(true);
      expect(pred({ role: "moderator" })).toBe(true);
      expect(pred({ role: "user" })).toBe(false);
    });

    it("$in with numbers", () => {
      const pred = compileFilter({ status: { $in: [0, 1, 2] } });
      expect(pred({ status: 1 })).toBe(true);
      expect(pred({ status: 3 })).toBe(false);
    });

    it("$in with missing field", () => {
      const pred = compileFilter({ role: { $in: ["admin"] } });
      expect(pred({})).toBe(false);
    });

    it("$in with null in array", () => {
      const pred = compileFilter({ role: { $in: [null, "admin"] } });
      expect(pred({ role: null })).toBe(true);
      expect(pred({ role: "admin" })).toBe(true);
      expect(pred({ role: "user" })).toBe(false);
    });

    it("$nin excludes values in array", () => {
      const pred = compileFilter({ role: { $nin: ["admin", "moderator"] } });
      expect(pred({ role: "admin" })).toBe(false);
      expect(pred({ role: "moderator" })).toBe(false);
      expect(pred({ role: "user" })).toBe(true);
    });

    it("$nin with missing field returns true", () => {
      const pred = compileFilter({ role: { $nin: ["admin"] } });
      expect(pred({})).toBe(true);
    });
  });

  // ── $contains operator ────────────────────────────────────────────

  describe("$contains", () => {
    it("matches substring in string", () => {
      const pred = compileFilter({ name: { $contains: "ali" } });
      expect(pred({ name: "alice" })).toBe(true);
      expect(pred({ name: "bob" })).toBe(false);
    });

    it("matches element in array", () => {
      const pred = compileFilter({ tags: { $contains: "urgent" } });
      expect(pred({ tags: ["urgent", "bug"] })).toBe(true);
      expect(pred({ tags: ["low", "feature"] })).toBe(false);
    });

    it("matches number element in array", () => {
      const pred = compileFilter({ scores: { $contains: 42 } });
      expect(pred({ scores: [10, 42, 99] })).toBe(true);
      expect(pred({ scores: [10, 99] })).toBe(false);
    });

    it("returns false for non-string non-array field", () => {
      const pred = compileFilter({ age: { $contains: "1" } });
      expect(pred({ age: 18 })).toBe(false);
    });

    it("returns false for missing field", () => {
      const pred = compileFilter({ tags: { $contains: "urgent" } });
      expect(pred({})).toBe(false);
    });

    it("matches empty string in any string", () => {
      const pred = compileFilter({ name: { $contains: "" } });
      expect(pred({ name: "alice" })).toBe(true);
      expect(pred({ name: "" })).toBe(true);
    });
  });

  // ── $startsWith, $endsWith ────────────────────────────────────────

  describe("$startsWith and $endsWith", () => {
    it("$startsWith matches prefix", () => {
      const pred = compileFilter({ email: { $startsWith: "admin@" } });
      expect(pred({ email: "admin@example.com" })).toBe(true);
      expect(pred({ email: "user@example.com" })).toBe(false);
    });

    it("$endsWith matches suffix", () => {
      const pred = compileFilter({ email: { $endsWith: "@example.com" } });
      expect(pred({ email: "admin@example.com" })).toBe(true);
      expect(pred({ email: "admin@other.com" })).toBe(false);
    });

    it("$startsWith returns false for non-string", () => {
      const pred = compileFilter({ age: { $startsWith: "1" } });
      expect(pred({ age: 18 })).toBe(false);
    });

    it("$endsWith returns false for missing field", () => {
      const pred = compileFilter({ email: { $endsWith: ".com" } });
      expect(pred({})).toBe(false);
    });

    it("$startsWith with empty string matches everything", () => {
      const pred = compileFilter({ name: { $startsWith: "" } });
      expect(pred({ name: "anything" })).toBe(true);
      expect(pred({ name: "" })).toBe(true);
    });
  });

  // ── $exists operator ──────────────────────────────────────────────

  describe("$exists", () => {
    it("$exists: true matches present field", () => {
      const pred = compileFilter({ email: { $exists: true } });
      expect(pred({ email: "test@test.com" })).toBe(true);
      expect(pred({ name: "alice" })).toBe(false);
    });

    it("$exists: true matches field with null value", () => {
      const pred = compileFilter({ email: { $exists: true } });
      expect(pred({ email: null })).toBe(true);
    });

    it("$exists: true matches field with undefined value", () => {
      const pred = compileFilter({ email: { $exists: true } });
      expect(pred({ email: undefined })).toBe(true);
    });

    it("$exists: false matches missing field", () => {
      const pred = compileFilter({ email: { $exists: false } });
      expect(pred({ name: "alice" })).toBe(true);
      expect(pred({ email: "test@test.com" })).toBe(false);
    });

    it("$exists with nested dot-notation path", () => {
      const pred = compileFilter({ "metadata.email": { $exists: true } });
      expect(pred({ metadata: { email: "test@test.com" } })).toBe(true);
      expect(pred({ metadata: {} })).toBe(false);
      expect(pred({})).toBe(false);
    });
  });

  // ── $regex operator ───────────────────────────────────────────────

  describe("$regex", () => {
    it("matches regex pattern as string", () => {
      const pred = compileFilter({ email: { $regex: "^admin@" } });
      expect(pred({ email: "admin@example.com" })).toBe(true);
      expect(pred({ email: "user@example.com" })).toBe(false);
    });

    it("matches regex pattern as RegExp", () => {
      const pred = compileFilter({ email: { $regex: /\.com$/i } });
      expect(pred({ email: "admin@example.COM" })).toBe(true);
      expect(pred({ email: "admin@example.org" })).toBe(false);
    });

    it("returns false for non-string field", () => {
      const pred = compileFilter({ age: { $regex: "\\d+" } });
      expect(pred({ age: 18 })).toBe(false);
    });

    it("returns false for missing field", () => {
      const pred = compileFilter({ name: { $regex: "alice" } });
      expect(pred({})).toBe(false);
    });
  });

  // ── $not operator ─────────────────────────────────────────────────

  describe("$not", () => {
    it("negates $eq", () => {
      const pred = compileFilter({ role: { $not: { $eq: "admin" } } });
      expect(pred({ role: "admin" })).toBe(false);
      expect(pred({ role: "user" })).toBe(true);
    });

    it("negates $contains", () => {
      const pred = compileFilter({ tags: { $not: { $contains: "urgent" } } });
      expect(pred({ tags: ["urgent", "bug"] })).toBe(false);
      expect(pred({ tags: ["low"] })).toBe(true);
    });

    it("negates $gt", () => {
      const pred = compileFilter({ age: { $not: { $gt: 18 } } });
      expect(pred({ age: 19 })).toBe(false);
      expect(pred({ age: 18 })).toBe(true);
      expect(pred({ age: 17 })).toBe(true);
    });

    it("top-level $not negates an entire filter", () => {
      const pred = compileFilter({ $not: { role: "admin", active: true } });
      expect(pred({ role: "admin", active: true })).toBe(false);
      expect(pred({ role: "admin", active: false })).toBe(true);
      expect(pred({ role: "user", active: true })).toBe(true);
    });
  });

  // ── $and operator ─────────────────────────────────────────────────

  describe("$and", () => {
    it("requires all conditions to match", () => {
      const pred = compileFilter({
        $and: [{ role: "admin" }, { active: true }],
      });
      expect(pred({ role: "admin", active: true })).toBe(true);
      expect(pred({ role: "admin", active: false })).toBe(false);
      expect(pred({ role: "user", active: true })).toBe(false);
    });

    it("works with operator conditions", () => {
      const pred = compileFilter({
        $and: [{ age: { $gte: 18 } }, { age: { $lte: 65 } }],
      });
      expect(pred({ age: 25 })).toBe(true);
      expect(pred({ age: 17 })).toBe(false);
      expect(pred({ age: 66 })).toBe(false);
    });

    it("empty $and matches all", () => {
      const pred = compileFilter({ $and: [] });
      expect(pred({ any: "value" })).toBe(true);
    });
  });

  // ── $or operator ──────────────────────────────────────────────────

  describe("$or", () => {
    it("requires any condition to match", () => {
      const pred = compileFilter({
        $or: [{ role: "admin" }, { role: "moderator" }],
      });
      expect(pred({ role: "admin" })).toBe(true);
      expect(pred({ role: "moderator" })).toBe(true);
      expect(pred({ role: "user" })).toBe(false);
    });

    it("works with operator conditions", () => {
      const pred = compileFilter({
        $or: [{ age: { $lt: 18 } }, { age: { $gt: 65 } }],
      });
      expect(pred({ age: 10 })).toBe(true);
      expect(pred({ age: 70 })).toBe(true);
      expect(pred({ age: 30 })).toBe(false);
    });

    it("empty $or matches none", () => {
      const pred = compileFilter({ $or: [] });
      expect(pred({ any: "value" })).toBe(false);
    });
  });

  // ── Implicit AND ──────────────────────────────────────────────────

  describe("implicit AND", () => {
    it("top-level keys are implicitly ANDed", () => {
      const pred = compileFilter({ role: "admin", active: true });
      expect(pred({ role: "admin", active: true })).toBe(true);
      expect(pred({ role: "admin", active: false })).toBe(false);
      expect(pred({ role: "user", active: true })).toBe(false);
    });

    it("works with mixed operators", () => {
      const pred = compileFilter({
        role: "admin",
        age: { $gte: 18 },
        name: { $startsWith: "A" },
      });
      expect(pred({ role: "admin", age: 25, name: "Alice" })).toBe(true);
      expect(pred({ role: "admin", age: 25, name: "Bob" })).toBe(false);
      expect(pred({ role: "admin", age: 16, name: "Alice" })).toBe(false);
      expect(pred({ role: "user", age: 25, name: "Alice" })).toBe(false);
    });
  });

  // ── Dot-notation nested access ────────────────────────────────────

  describe("dot-notation", () => {
    it("accesses nested fields", () => {
      const pred = compileFilter({ "metadata.role": "admin" });
      expect(pred({ metadata: { role: "admin" } })).toBe(true);
      expect(pred({ metadata: { role: "user" } })).toBe(false);
    });

    it("accesses deeply nested fields", () => {
      const pred = compileFilter({ "a.b.c.d": 42 });
      expect(pred({ a: { b: { c: { d: 42 } } } })).toBe(true);
      expect(pred({ a: { b: { c: { d: 43 } } } })).toBe(false);
    });

    it("returns undefined for missing intermediate paths", () => {
      const pred = compileFilter({ "metadata.role": "admin" });
      expect(pred({ metadata: {} })).toBe(false);
      expect(pred({})).toBe(false);
    });

    it("returns undefined when intermediate is null", () => {
      const pred = compileFilter({ "metadata.role": "admin" });
      expect(pred({ metadata: null })).toBe(false);
    });

    it("returns undefined when intermediate is primitive", () => {
      const pred = compileFilter({ "metadata.role": "admin" });
      expect(pred({ metadata: "string" })).toBe(false);
    });

    it("works with operators on nested fields", () => {
      const pred = compileFilter({ "metadata.tags": { $contains: "urgent" } });
      expect(pred({ metadata: { tags: ["urgent", "bug"] } })).toBe(true);
      expect(pred({ metadata: { tags: ["low"] } })).toBe(false);
    });

    it("works with $exists on nested fields", () => {
      const pred = compileFilter({ "profile.email": { $exists: true } });
      expect(pred({ profile: { email: "test@test.com" } })).toBe(true);
      expect(pred({ profile: {} })).toBe(false);
      expect(pred({})).toBe(false);
    });
  });

  // ── Combined / nested logical operators ───────────────────────────

  describe("nested logical operators", () => {
    it("$and inside $or", () => {
      const pred = compileFilter({
        $or: [
          { $and: [{ role: "admin" }, { active: true }] },
          { $and: [{ role: "moderator" }, { level: { $gte: 5 } }] },
        ],
      });
      expect(pred({ role: "admin", active: true })).toBe(true);
      expect(pred({ role: "moderator", level: 5 })).toBe(true);
      expect(pred({ role: "moderator", level: 3 })).toBe(false);
      expect(pred({ role: "user" })).toBe(false);
    });

    it("$or inside $and", () => {
      const pred = compileFilter({
        $and: [
          { $or: [{ role: "admin" }, { role: "moderator" }] },
          { active: true },
        ],
      });
      expect(pred({ role: "admin", active: true })).toBe(true);
      expect(pred({ role: "moderator", active: true })).toBe(true);
      expect(pred({ role: "admin", active: false })).toBe(false);
      expect(pred({ role: "user", active: true })).toBe(false);
    });

    it("$not with $or", () => {
      const pred = compileFilter({
        $not: { $or: [{ role: "admin" }, { role: "moderator" }] },
      });
      expect(pred({ role: "admin" })).toBe(false);
      expect(pred({ role: "moderator" })).toBe(false);
      expect(pred({ role: "user" })).toBe(true);
    });

    it("mixed top-level fields with $or", () => {
      const pred = compileFilter({
        active: true,
        $or: [{ role: "admin" }, { role: "moderator" }],
      });
      expect(pred({ active: true, role: "admin" })).toBe(true);
      expect(pred({ active: true, role: "moderator" })).toBe(true);
      expect(pred({ active: false, role: "admin" })).toBe(false);
      expect(pred({ active: true, role: "user" })).toBe(false);
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("field with empty string value", () => {
      const pred = compileFilter({ name: "" });
      expect(pred({ name: "" })).toBe(true);
      expect(pred({ name: "alice" })).toBe(false);
    });

    it("zero is not falsy in equality", () => {
      const pred = compileFilter({ count: 0 });
      expect(pred({ count: 0 })).toBe(true);
      expect(pred({ count: 1 })).toBe(false);
      expect(pred({ count: false })).toBe(false);
    });

    it("false is distinct from zero and empty string", () => {
      const pred = compileFilter({ active: false });
      expect(pred({ active: false })).toBe(true);
      expect(pred({ active: 0 })).toBe(false);
      expect(pred({ active: "" })).toBe(false);
      expect(pred({ active: null })).toBe(false);
    });

    it("undefined field value does not match null", () => {
      const pred = compileFilter({ field: null });
      expect(pred({})).toBe(false);
    });

    it("handles records with extra fields", () => {
      const pred = compileFilter({ role: "admin" });
      expect(pred({ role: "admin", name: "Alice", age: 30 })).toBe(true);
    });

    it("single field filter with single predicate (no wrapping)", () => {
      const pred = compileFilter({ role: "admin" });
      expect(pred({ role: "admin" })).toBe(true);
    });

    it("$in with empty array matches nothing", () => {
      const pred = compileFilter({ role: { $in: [] } });
      expect(pred({ role: "admin" })).toBe(false);
      expect(pred({})).toBe(false);
    });

    it("$nin with empty array matches everything", () => {
      const pred = compileFilter({ role: { $nin: [] } });
      expect(pred({ role: "admin" })).toBe(true);
      expect(pred({})).toBe(true);
    });

    it("$contains with empty array field", () => {
      const pred = compileFilter({ tags: { $contains: "urgent" } });
      expect(pred({ tags: [] })).toBe(false);
    });

    it("multiple operators on same field (implicit AND)", () => {
      const pred = compileFilter({ name: { $startsWith: "A", $endsWith: "e" } });
      expect(pred({ name: "Alice" })).toBe(true);
      expect(pred({ name: "Adam" })).toBe(false);
      expect(pred({ name: "Jane" })).toBe(false);
    });

    it("$regex with special characters in pattern", () => {
      const pred = compileFilter({ email: { $regex: "test\\.user@" } });
      expect(pred({ email: "test.user@example.com" })).toBe(true);
      expect(pred({ email: "testXuser@example.com" })).toBe(false);
    });

    it("comparison with zero", () => {
      const pred = compileFilter({ score: { $gte: 0 } });
      expect(pred({ score: 0 })).toBe(true);
      expect(pred({ score: -1 })).toBe(false);
      expect(pred({ score: 1 })).toBe(true);
    });

    it("deeply nested dot-notation with $exists false", () => {
      const pred = compileFilter({ "a.b.c": { $exists: false } });
      expect(pred({})).toBe(true);
      expect(pred({ a: {} })).toBe(true);
      expect(pred({ a: { b: {} } })).toBe(true);
      expect(pred({ a: { b: { c: "value" } } })).toBe(false);
    });
  });

  describe("$strLen", () => {
    it("exact length match with number value", () => {
      const pred = compileFilter({ name: { $strLen: 5 } });
      expect(pred({ name: "hello" })).toBe(true);
      expect(pred({ name: "hi" })).toBe(false);
      expect(pred({ name: "toolong" })).toBe(false);
    });

    it("$strLen with $gt operator", () => {
      const pred = compileFilter({ bio: { $strLen: { $gt: 10 } } });
      expect(pred({ bio: "short" })).toBe(false);
      expect(pred({ bio: "exactly ten!" })).toBe(true);
    });

    it("$strLen with $lte operator", () => {
      const pred = compileFilter({ code: { $strLen: { $lte: 3 } } });
      expect(pred({ code: "US" })).toBe(true);
      expect(pred({ code: "USA" })).toBe(true);
      expect(pred({ code: "LONG" })).toBe(false);
    });

    it("$strLen returns false for non-string values", () => {
      const pred = compileFilter({ x: { $strLen: { $gt: 0 } } });
      expect(pred({ x: 42 })).toBe(false);
      expect(pred({ x: null })).toBe(false);
      expect(pred({ x: ["a", "b"] })).toBe(false);
    });

    it("$strLen with $gte/$lte range", () => {
      const pred = compileFilter({ tag: { $strLen: { $gte: 2, $lte: 5 } } });
      expect(pred({ tag: "a" })).toBe(false);
      expect(pred({ tag: "ab" })).toBe(true);
      expect(pred({ tag: "hello" })).toBe(true);
      expect(pred({ tag: "toolong" })).toBe(false);
    });
  });
});
