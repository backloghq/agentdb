# AgentDB Examples

Runnable demos showing AgentDB in different multi-agent scenarios.

## Examples

### [multi-agent/](./multi-agent/) — Agent Task Board

Multiple AI agents (powered by Ollama) collaborate on a shared task board through AgentDB's HTTP MCP server. Demonstrates real-time notifications, optimistic locking, and agent specialization.

**Agents:**
- **Planner** — breaks a goal into tasks using AI, monitors completion
- **Code Worker** — claims and completes code tasks
- **Research Worker** — claims and completes research tasks

**Key patterns:** event-driven via `db_subscribe` (no polling), optimistic locking via `expectedVersion`, per-agent auth tokens.

```bash
cd multi-agent
./run.sh "Build a CLI tool that converts markdown to HTML"
```

**Requires:** [Ollama](https://ollama.com) running locally with `llama3.2` model.

---

## Prerequisites

All examples require:
- Node.js 20+
- AgentDB built (`npm run build` in the root)

Some examples additionally require:
- [Ollama](https://ollama.com) with a model pulled (`ollama pull llama3.2`)
