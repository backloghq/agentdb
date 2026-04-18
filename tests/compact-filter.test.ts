import { describe, it, expect } from "vitest";
import { parseCompactFilter } from "../src/compact-filter.js";
import { compileFilter } from "../src/filter.js";

describe("parseCompactFilter", () => {
  describe("basic attribute matching", () => {
    it("parses field:value", () => {
      expect(parseCompactFilter("role:admin")).toEqual({ role: "admin" });
    });

    it("coerces boolean values", () => {
      expect(parseCompactFilter("active:true")).toEqual({ active: true });
      expect(parseCompactFilter("active:false")).toEqual({ active: false });
    });

    it("coerces numeric values", () => {
      expect(parseCompactFilter("age:25")).toEqual({ age: 25 });
      expect(parseCompactFilter("score:3.14")).toEqual({ score: 3.14 });
    });

    it("coerces null", () => {
      expect(parseCompactFilter("parent:null")).toEqual({ parent: null });
    });

    it("keeps non-numeric strings as strings", () => {
      expect(parseCompactFilter("name:alice")).toEqual({ name: "alice" });
    });

    it("handles dot-notation field paths", () => {
      // If the modifier after the last dot is NOT a known modifier, treat as field path
      expect(parseCompactFilter("metadata.name:alice")).toEqual({ "metadata.name": "alice" });
    });
  });

  describe("implicit AND (adjacent terms)", () => {
    it("combines adjacent terms with $and", () => {
      expect(parseCompactFilter("role:admin active:true")).toEqual({
        $and: [{ role: "admin" }, { active: true }],
      });
    });

    it("combines three terms", () => {
      const result = parseCompactFilter("role:admin active:true score:10");
      expect(result).toEqual({
        $and: [{ role: "admin" }, { active: true }, { score: 10 }],
      });
    });
  });

  describe("explicit AND", () => {
    it("parses explicit and keyword", () => {
      expect(parseCompactFilter("role:admin and active:true")).toEqual({
        $and: [{ role: "admin" }, { active: true }],
      });
    });
  });

  describe("OR", () => {
    it("parses or keyword", () => {
      expect(parseCompactFilter("role:admin or role:moderator")).toEqual({
        $or: [{ role: "admin" }, { role: "moderator" }],
      });
    });
  });

  describe("parentheses", () => {
    it("groups with parentheses", () => {
      expect(parseCompactFilter("(role:admin or role:moderator)")).toEqual({
        $or: [{ role: "admin" }, { role: "moderator" }],
      });
    });

    it("combines parenthesized group with AND", () => {
      const result = parseCompactFilter("active:true (role:admin or role:mod)");
      expect(result).toEqual({
        $and: [
          { active: true },
          { $or: [{ role: "admin" }, { role: "mod" }] },
        ],
      });
    });

    it("throws on unmatched parenthesis", () => {
      expect(() => parseCompactFilter("(role:admin")).toThrow("Unmatched");
    });
  });

  describe("modifiers", () => {
    it("parses contains modifier", () => {
      expect(parseCompactFilter("name.contains:alice")).toEqual({
        name: { $contains: "alice" },
      });
    });

    it("parses gt modifier", () => {
      expect(parseCompactFilter("age.gt:18")).toEqual({
        age: { $gt: 18 },
      });
    });

    it("parses gte modifier", () => {
      expect(parseCompactFilter("age.gte:18")).toEqual({
        age: { $gte: 18 },
      });
    });

    it("parses lt modifier", () => {
      expect(parseCompactFilter("age.lt:65")).toEqual({
        age: { $lt: 65 },
      });
    });

    it("parses lte modifier", () => {
      expect(parseCompactFilter("age.lte:65")).toEqual({
        age: { $lte: 65 },
      });
    });

    it("parses ne modifier", () => {
      expect(parseCompactFilter("status.ne:deleted")).toEqual({
        status: { $ne: "deleted" },
      });
    });

    it("parses after/before as gt/lt", () => {
      expect(parseCompactFilter("created.after:2026-01-01")).toEqual({
        created: { $gt: "2026-01-01" },
      });
      expect(parseCompactFilter("created.before:2026-12-31")).toEqual({
        created: { $lt: "2026-12-31" },
      });
    });

    it("parses startsWith modifier", () => {
      expect(parseCompactFilter("name.startsWith:Al")).toEqual({
        name: { $startsWith: "Al" },
      });
    });

    it("parses endsWith modifier", () => {
      expect(parseCompactFilter("name.endsWith:ice")).toEqual({
        name: { $endsWith: "ice" },
      });
    });

    it("parses in modifier with comma-separated values", () => {
      expect(parseCompactFilter("role.in:admin,moderator,user")).toEqual({
        role: { $in: ["admin", "moderator", "user"] },
      });
    });

    it("coerces in values", () => {
      expect(parseCompactFilter("score.in:1,2,3")).toEqual({
        score: { $in: [1, 2, 3] },
      });
    });

    it("parses exists modifier", () => {
      expect(parseCompactFilter("email.exists:true")).toEqual({
        email: { $exists: true },
      });
      expect(parseCompactFilter("email.exists:false")).toEqual({
        email: { $exists: false },
      });
    });

    it("parses regex modifier", () => {
      expect(parseCompactFilter("name.regex:^Al")).toEqual({
        name: { $regex: "^Al" },
      });
    });

    it("parses alias modifiers (has, is, not, above, below, etc.)", () => {
      expect(parseCompactFilter("tags.has:urgent")).toEqual({ tags: { $contains: "urgent" } });
      expect(parseCompactFilter("role.is:admin")).toEqual({ role: { $eq: "admin" } });
      expect(parseCompactFilter("role.isnt:admin")).toEqual({ role: { $ne: "admin" } });
      expect(parseCompactFilter("score.above:50")).toEqual({ score: { $gt: 50 } });
      expect(parseCompactFilter("score.below:50")).toEqual({ score: { $lt: 50 } });
    });
  });

  describe("$strLen operator", () => {
    it("field.strLen:N → exact length match", () => {
      expect(parseCompactFilter("title.strLen:20")).toEqual({ title: { $strLen: 20 } });
    });

    it("field.strLen.gt:N → length comparison", () => {
      expect(parseCompactFilter("body.strLen.gt:10")).toEqual({ body: { $strLen: { $gt: 10 } } });
    });

    it("compound strLen range (implicit AND)", () => {
      expect(parseCompactFilter("title.strLen.gte:5 title.strLen.lte:20")).toEqual({
        $and: [{ title: { $strLen: { $gte: 5 } } }, { title: { $strLen: { $lte: 20 } } }],
      });
    });

    it("integration: filters records by string field length", () => {
      const records = [
        { title: "Hi" },
        { title: "Hello" },
        { title: "Hello World" },
      ];
      const filter = parseCompactFilter("title.strLen.gt:5");
      const predicate = compileFilter(filter);
      const result = records.filter(predicate);
      expect(result).toHaveLength(1);
      expect(result[0].title).toBe("Hello World");
    });

    it("strLen.eq:0 matches empty strings, rejects non-empty and non-string values", () => {
      const records = [
        { title: "" },
        { title: "x" },
        { title: null },
        { other: "no title" },
      ];
      const filter = parseCompactFilter("title.strLen.eq:0");
      const predicate = compileFilter(filter);
      const result = records.filter(predicate);
      expect(result).toHaveLength(1);
      expect(result[0].title).toBe("");
    });
  });

  describe("nested field paths with modifiers", () => {
    it("handles nested field + modifier", () => {
      expect(parseCompactFilter("metadata.score.gt:10")).toEqual({
        "metadata.score": { $gt: 10 },
      });
    });

    it("treats unknown suffix as field path, not modifier", () => {
      expect(parseCompactFilter("user.name:alice")).toEqual({
        "user.name": "alice",
      });
    });
  });

  describe("empty and edge cases", () => {
    it("returns empty object for empty string", () => {
      expect(parseCompactFilter("")).toEqual({});
    });

    it("returns empty object for whitespace", () => {
      expect(parseCompactFilter("   ")).toEqual({});
    });

    it("bare word becomes $text search", () => {
      expect(parseCompactFilter("admin")).toEqual({ $text: "admin" });
    });

    it("multiple bare words combine into $text", () => {
      expect(parseCompactFilter("auth error")).toEqual({ $text: "auth error" });
    });

    it("+tag becomes array contains", () => {
      expect(parseCompactFilter("+bug")).toEqual({ tags: { $contains: "bug" } });
    });

    it("-tag becomes array not contains", () => {
      expect(parseCompactFilter("-old")).toEqual({ tags: { $not: { $contains: "old" } } });
    });

    it("mixed: field + tag + text", () => {
      const result = parseCompactFilter("status:active +bug error");
      expect(result).toEqual({ $and: [{ status: "active" }, { tags: { $contains: "bug" } }, { $text: "error" }] });
    });
  });

  describe("integration with compileFilter", () => {
    const records = [
      { name: "Alice", role: "admin", age: 30, active: true },
      { name: "Bob", role: "user", age: 25, active: false },
      { name: "Charlie", role: "admin", age: 45, active: true },
      { name: "Diana", role: "moderator", age: 35, active: true },
    ];

    function query(compact: string): Record<string, unknown>[] {
      const filter = parseCompactFilter(compact);
      const predicate = compileFilter(filter);
      return records.filter(predicate);
    }

    it("filters by exact match", () => {
      expect(query("role:admin")).toHaveLength(2);
    });

    it("filters with comparison", () => {
      expect(query("age.gt:30")).toHaveLength(2); // Charlie(45), Diana(35)
    });

    it("filters with contains", () => {
      expect(query("name.contains:li")).toHaveLength(2); // Alice, Charlie
    });

    it("filters with OR", () => {
      expect(query("(role:admin or role:moderator)")).toHaveLength(3);
    });

    it("filters with AND", () => {
      expect(query("role:admin active:true")).toHaveLength(2);
    });

    it("complex combined filter", () => {
      expect(query("active:true (role:admin or role:moderator) age.gt:30")).toHaveLength(2); // Charlie, Diana
    });
  });
});
