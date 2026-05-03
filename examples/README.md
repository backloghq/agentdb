# AgentDB Examples

Runnable demos showing AgentDB in different multi-agent and AI scenarios.

## Examples

### [multi-agent/](./multi-agent/) — Agent Task Board

Multiple AI agents (Ollama) collaborate on a shared task board. Planner breaks down goals, workers claim and complete tasks by specialty. Event-driven via NOTIFY/LISTEN.

**Shows:** real-time notifications, optimistic locking, per-agent auth, MCP Streamable HTTP

```bash
cd multi-agent && ./run.sh
```

---

### [rag-knowledge-base/](./rag-knowledge-base/) — RAG Knowledge Base

Ingest documents, embed with Ollama, answer questions using **hybrid search** (BM25 + semantic RRF). CLI tool for building a local knowledge base. Updated for v1.4.

**Shows:** hybrid search (`hybridSearch`), `searchable: true` schema fields, `embedUnembedded()`, Ollama embeddings, chunking, source attribution

```bash
cd rag-knowledge-base
npx tsx rag.ts ingest ../../README.md
npx tsx rag.ts ask "What deployment patterns does AgentDB support?"
```

---

### [research-pipeline/](./research-pipeline/) — Research Pipeline

3-stage AI pipeline: Researcher → Analyst → Writer. Each stage subscribes to its input collection and triggers automatically when upstream writes.

**Shows:** pipeline pattern via NOTIFY/LISTEN, generic stage agent, status tracking, cascading triggers

```bash
cd research-pipeline && ./run.sh "The future of embedded databases"
```

---

### [live-dashboard/](./live-dashboard/) — Live Dashboard

Real-time CLI dashboard that watches AgentDB collections. Point at any demo's data directory to see live updates as agents work.

**Shows:** `Collection.watch()`, WAL tailing, schema discovery, status breakdowns

```bash
# In one terminal: run a demo
cd multi-agent && ./run.sh

# In another: watch it live
cd live-dashboard && npx tsx dashboard.ts ../multi-agent/taskboard-data
```

---

### [code-review/](./code-review/) — Multi-Model Code Review

Three agents from two providers (Gemini + Ollama) collaborate on a code review pipeline. Gemini generates code, Ollama reviews locally, Gemini writes tests. Real files output to disk.

**Shows:** multi-provider orchestration, structured JSON output, NOTIFY/LISTEN pipeline, file generation, v1.3 schema lifecycle (`defineSchema` with `description`/`instructions`/field descriptions, auto-persistence, `db_get_schema` discovery)

```bash
GEMINI_API_KEY=... cd code-review && ./run.sh "Implement JWT auth middleware"
```

---

## Prerequisites

All examples require:
- Node.js 20+
- AgentDB built (`npm run build` in the repo root)
- [Ollama](https://ollama.com) running locally

Models needed:
- `ollama pull llama3.2` — chat model (all demos)
- `ollama pull nomic-embed-text` — embedding model (RAG demo)

API keys (for code-review demo):
- `GEMINI_API_KEY` — free from https://aistudio.google.com/apikey
