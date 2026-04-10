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

Ingest documents, embed with Ollama, answer questions using semantic search. CLI tool for building a local knowledge base.

**Shows:** vector API (`insertVector`/`searchByVector`), Ollama embeddings, chunking, source attribution

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

## Prerequisites

All examples require:
- Node.js 20+
- AgentDB built (`npm run build` in the repo root)
- [Ollama](https://ollama.com) running locally

Models needed:
- `ollama pull llama3.2` — chat model (all demos)
- `ollama pull nomic-embed-text` — embedding model (RAG demo)
