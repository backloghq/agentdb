/**
 * Compact string filter parser.
 *
 * Parses a compact filter syntax into a JSON filter object
 * that can be passed to compileFilter().
 *
 * Syntax:
 *   role:admin                       → { role: "admin" }
 *   role:admin active:true           → { role: "admin", active: true }
 *   name.contains:alice              → { name: { $contains: "alice" } }
 *   age.gt:18                        → { age: { $gt: 18 } }
 *   title.strLen:20                  → { title: { $strLen: 20 } }
 *   title.strLen.gt:10               → { title: { $strLen: { $gt: 10 } } }
 *   (role:admin or role:moderator)   → { $or: [{ role: "admin" }, { role: "moderator" }] }
 *   role:admin and active:true       → { $and: [{ role: "admin" }, { active: true }] }
 */

// --- Modifier to operator mapping ---

const MODIFIER_MAP: Record<string, string> = {
  is: "$eq",
  eq: "$eq",
  equals: "$eq",
  ne: "$ne",
  not: "$ne",
  isnt: "$ne",
  gt: "$gt",
  after: "$gt",
  above: "$gt",
  over: "$gt",
  gte: "$gte",
  lt: "$lt",
  before: "$lt",
  below: "$lt",
  under: "$lt",
  lte: "$lte",
  contains: "$contains",
  has: "$contains",
  startsWith: "$startsWith",
  starts: "$startsWith",
  left: "$startsWith",
  endsWith: "$endsWith",
  ends: "$endsWith",
  right: "$endsWith",
  in: "$in",
  nin: "$nin",
  exists: "$exists",
  regex: "$regex",
  match: "$regex",
  strLen: "$strLen",
};

// --- Tokenizer ---

type Token =
  | { type: "attr"; field: string; modifier: string | null; value: string }
  | { type: "tag"; include: boolean; value: string }
  | { type: "text"; value: string }
  | { type: "and" }
  | { type: "or" }
  | { type: "lparen" }
  | { type: "rparen" };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    // Skip whitespace
    if (input[i] === " " || input[i] === "\t") {
      i++;
      continue;
    }

    // Parentheses
    if (input[i] === "(") {
      tokens.push({ type: "lparen" });
      i++;
      continue;
    }
    if (input[i] === ")") {
      tokens.push({ type: "rparen" });
      i++;
      continue;
    }

    // Read a word or attribute expression
    let word = "";

    // Handle quoted values
    if (input[i] === '"' || input[i] === "'") {
      const quote = input[i];
      i++;
      while (i < input.length && input[i] !== quote) {
        if (input[i] === "\\" && i + 1 < input.length) {
          word += input[i + 1];
          i += 2;
        } else {
          word += input[i];
          i++;
        }
      }
      if (i < input.length) i++; // skip closing quote
      // Quoted strings are treated as attribute values if preceded by field:
      // But standalone quoted strings shouldn't happen in this syntax
      // For now, treat as a bare word
    } else {
      // Read until whitespace or paren
      while (i < input.length && input[i] !== " " && input[i] !== "\t" && input[i] !== "(" && input[i] !== ")") {
        word += input[i];
        i++;
      }
    }

    if (!word) continue;

    // Check for keywords
    const lower = word.toLowerCase();
    if (lower === "and") {
      tokens.push({ type: "and" });
      continue;
    }
    if (lower === "or") {
      tokens.push({ type: "or" });
      continue;
    }

    // +tag / -tag syntax
    if ((word.startsWith("+") || word.startsWith("-")) && !word.includes(":")) {
      tokens.push({ type: "tag", include: word.startsWith("+"), value: word.slice(1) });
      continue;
    }

    // Parse attribute expression: field.modifier:value or field:value
    const colonIdx = word.indexOf(":");
    if (colonIdx === -1) {
      // Bare word — collected as text search term
      tokens.push({ type: "text", value: word });
      continue;
    }

    const left = word.slice(0, colonIdx);
    const value = word.slice(colonIdx + 1);

    // Check if left contains a modifier (field.modifier)
    const dotIdx = left.lastIndexOf(".");
    let field: string;
    let modifier: string | null = null;

    if (dotIdx !== -1) {
      const possibleModifier = left.slice(dotIdx + 1);
      if (MODIFIER_MAP[possibleModifier]) {
        field = left.slice(0, dotIdx);
        modifier = possibleModifier;
      } else {
        // Dot is part of the field path (e.g., metadata.name:value)
        field = left;
      }
    } else {
      field = left;
    }

    tokens.push({ type: "attr", field, modifier, value });
  }

  return tokens;
}

// --- Coerce values ---

function coerceValue(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  const num = Number(value);
  if (value !== "" && !isNaN(num) && isFinite(num)) return num;
  return value;
}

// --- Parser (recursive descent) ---

type FilterObject = Record<string, unknown>;

function parseExpression(tokens: Token[], pos: { i: number }, tagField: string): FilterObject {
  return parseOr(tokens, pos, tagField);
}

function parseOr(tokens: Token[], pos: { i: number }, tagField: string): FilterObject {
  const left = parseAnd(tokens, pos, tagField);
  const operands = [left];

  while (pos.i < tokens.length && tokens[pos.i].type === "or") {
    pos.i++; // skip 'or'
    operands.push(parseAnd(tokens, pos, tagField));
  }

  if (operands.length === 1) return operands[0];
  return { $or: operands };
}

function parseAnd(tokens: Token[], pos: { i: number }, tagField: string): FilterObject {
  const left = parsePrimary(tokens, pos, tagField);
  const operands = [left];

  while (pos.i < tokens.length) {
    const token = tokens[pos.i];
    if (token.type === "and") {
      pos.i++; // skip explicit 'and'
      operands.push(parsePrimary(tokens, pos, tagField));
    } else if (token.type === "attr" || token.type === "lparen" || token.type === "tag" || token.type === "text") {
      // Implicit AND — adjacent terms
      operands.push(parsePrimary(tokens, pos, tagField));
    } else {
      break;
    }
  }

  if (operands.length === 1) return operands[0];
  return { $and: operands };
}

function parsePrimary(tokens: Token[], pos: { i: number }, tagField: string): FilterObject {
  if (pos.i >= tokens.length) {
    throw new Error("Unexpected end of filter expression");
  }

  const token = tokens[pos.i];

  if (token.type === "lparen") {
    pos.i++; // skip (
    const expr = parseExpression(tokens, pos, tagField);
    if (pos.i >= tokens.length || tokens[pos.i].type !== "rparen") {
      throw new Error("Unmatched opening parenthesis");
    }
    pos.i++; // skip )
    return expr;
  }

  if (token.type === "attr") {
    pos.i++;
    return attrToFilter(token.field, token.modifier, token.value);
  }

  if (token.type === "tag") {
    pos.i++;
    if (token.include) {
      return { [tagField]: { $contains: token.value } };
    } else {
      return { [tagField]: { $not: { $contains: token.value } } };
    }
  }

  if (token.type === "text") {
    // Collect consecutive text tokens
    const words: string[] = [token.value];
    pos.i++;
    while (pos.i < tokens.length && tokens[pos.i].type === "text") {
      words.push((tokens[pos.i] as { type: "text"; value: string }).value);
      pos.i++;
    }
    return { $text: words.join(" ") };
  }

  throw new Error(`Unexpected token: ${token.type}`);
}

function attrToFilter(field: string, modifier: string | null, rawValue: string): FilterObject {
  if (!modifier) {
    return { [field]: coerceValue(rawValue) };
  }

  const op = MODIFIER_MAP[modifier];
  if (!op) {
    throw new Error(`Unknown modifier: ${modifier}`);
  }

  // $strLen compound: field.strLen.modifier:value → { field: { $strLen: { [op]: value } } }
  if (field.endsWith(".strLen")) {
    const baseField = field.slice(0, -".strLen".length);
    return { [baseField]: { $strLen: { [op]: coerceValue(rawValue) } } };
  }

  // Special handling for $in/$nin — comma-separated values
  if (op === "$in" || op === "$nin") {
    const values = rawValue.split(",").map((v) => coerceValue(v.trim()));
    return { [field]: { [op]: values } };
  }

  // Special handling for $exists
  if (op === "$exists") {
    return { [field]: { [op]: rawValue !== "false" } };
  }

  return { [field]: { [op]: coerceValue(rawValue) } };
}

// --- Public API ---

/**
 * Parse a compact filter string into a JSON filter object.
 *
 * @example
 * parseCompactFilter("role:admin active:true")
 * // → { $and: [{ role: "admin" }, { active: true }] }
 *
 * parseCompactFilter("(role:admin or role:mod)")
 * // → { $or: [{ role: "admin" }, { role: "mod" }] }
 *
 * parseCompactFilter("name.contains:alice age.gt:18")
 * // → { $and: [{ name: { $contains: "alice" } }, { age: { $gt: 18 } }] }
 */
export function parseCompactFilter(input: string, tagField = "tags"): FilterObject {
  const trimmed = input.trim();
  if (!trimmed) return {};

  const tokens = tokenize(trimmed);
  if (tokens.length === 0) return {};

  const pos = { i: 0 };
  const result = parseExpression(tokens, pos, tagField);

  if (pos.i < tokens.length) {
    throw new Error(`Unexpected token at position ${pos.i}: ${tokens[pos.i].type}`);
  }

  return result;
}
