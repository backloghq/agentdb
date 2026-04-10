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

## AgentDB Features Used

- `db_subscribe` + SSE notifications for pipeline triggering
- Optimistic locking (`expectedVersion`) for stage claiming
- Per-agent auth tokens (coder, reviewer, tester)
- Status tracking (`pending` → `processing` → `coded` → `reviewed` → `tested`)
