# Multi-Model Code Review Pipeline

Three AI agents from **two different providers** collaborate on code review through AgentDB. Gemini generates code and writes tests, Ollama reviews locally. Shows AgentDB as the provider-agnostic orchestration layer.

## Architecture

```
Spec injected
     │
     ▼                    NOTIFY                NOTIFY
┌──────────────┐   ──────────────▶   ┌──────────────┐   ──────────────▶   ┌──────────────┐
│    Coder     │                     │   Reviewer   │                     │    Tester    │
│              │                     │              │                     │              │
│ Gemini 3     │                     │ Ollama       │                     │ Gemini 3     │
│ Flash        │                     │ (local)      │                     │ Flash        │
│              │                     │              │                     │              │
│ specs →      │                     │ code →       │                     │ reviews →    │
│   code       │                     │   reviews    │                     │   tests      │
└──────────────┘                     └──────────────┘                     └──────────────┘
     │                                     │                                    │
     └─────── writes to output/ ───────────┴────────────────────────────────────┘
```

## Why This Demo

1. **Multi-provider** — Gemini (Google Cloud) + Ollama (local). Not locked to one LLM.
2. **Best model for the job** — Fast cloud model for generation, local model for security review where code stays on your machine.
3. **Real file output** — Agents write actual code and test files to disk.
4. **Event-driven** — Each stage triggers the next via `db_subscribe` + SSE notifications.
5. **Structured output** — Both providers use native JSON mode (Gemini `responseMimeType`, Ollama `format: "json"`).

## Prerequisites

- `GEMINI_API_KEY` — free from https://aistudio.google.com/apikey
- [Ollama](https://ollama.com) running with `llama3.2`
- AgentDB built (`npm run build` in repo root)

## Quick Start

```bash
GEMINI_API_KEY=your-key ./run.sh
```

With a custom spec:

```bash
GEMINI_API_KEY=your-key ./run.sh "Implement a JWT authentication middleware for Express.js"
```

## What Happens

1. **Coder** (Gemini 3 Flash) receives the spec, generates production-ready code, saves to `output/`
2. **Reviewer** (Ollama, local) reviews for security vulnerabilities, bugs, and best practices
3. **Tester** (Gemini 3 Flash) reads code + review feedback, writes targeted tests, saves to `output/`

All coordination happens through AgentDB — each agent subscribes to its input collection and reacts when upstream writes.

## Files

| File | Description |
|------|-------------|
| `server.ts` | AgentDB HTTP server (port 3002) |
| `coder.ts` | Code generation agent (Gemini) |
| `reviewer.ts` | Security review agent (Ollama) |
| `tester.ts` | Test generation agent (Gemini) |
| `inject.ts` | Injects spec, waits for completion |
| `gemini.ts` | Gemini REST wrapper (fetch, no SDK) |
| `ollama.ts` | Ollama wrapper |
| `mcp-client.ts` | MCP client using @modelcontextprotocol/sdk |

## Schema Lifecycle

This example shows three v1.3 schema lifecycle steps using the `reviews` collection:

**Step 1 — Define with context**: `server.ts` defines the schema with `description`, `instructions`, and per-field `description` so agents understand the collection's purpose without reading source code:

```typescript
defineSchema({
  name: "reviews",
  version: 1,
  description: "Security and quality reviews produced by the Reviewer agent.",
  instructions: "Each record corresponds to one code_submissions record. Query by submission_id to find the review for a given submission.",
  fields: {
    submission_id: { type: "string", required: true, description: "ID of the code_submissions record being reviewed" },
    severity: { type: "enum", values: ["low","medium","high","critical"], required: true, description: "Worst-case issue severity" },
    approved: { type: "boolean", required: true, description: "True if no blocking issues found" },
  },
});
```

**Step 2 — Persistence**: On first `db.collection(reviewsSchema)`, the schema is automatically written to `review-data/meta/reviews.schema.json`. It can be committed to source control and loaded at startup — agents read it without touching the codebase.

**Step 3 — Discovery via `db_get_schema`**: Any agent can discover the collection at runtime:

```json
// Tool call: db_get_schema { "collection": "reviews" }
// Response:
{
  "schema": {
    "name": "reviews",
    "description": "Security and quality reviews produced by the Reviewer agent.",
    "instructions": "Each record corresponds to one code_submissions record...",
    "fields": {
      "submission_id": { "type": "string", "required": true, "description": "ID of the code_submissions record being reviewed" },
      "severity": { "type": "enum", "values": ["low","medium","high","critical"], "required": true },
      "approved": { "type": "boolean", "required": true }
    }
  },
  "hasCodeSchema": true
}
```

## AgentDB Features Used

- `db_subscribe` + SSE notifications for pipeline triggering
- Optimistic locking (`expectedVersion`) for stage claiming
- Per-agent auth tokens (coder, reviewer, tester)
- Status tracking (`pending` → `processing` → `coded` → `reviewed` → `tested`)
- Schema with agent context (`description`, `instructions`, per-field `description`)
