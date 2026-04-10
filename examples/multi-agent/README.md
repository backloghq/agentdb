# Multi-Agent Task Board

Multiple AI agents collaborate on a shared task board through AgentDB's HTTP MCP transport. Agents use Ollama for reasoning and AgentDB for coordination — fully event-driven via server-pushed notifications.

## Architecture

```
┌────────────────┐   ┌─────────────────┐   ┌─────────────────────┐
│    Planner     │   │  Worker (code)  │   │  Worker (research)  │
│  creates tasks │   │  claims & works │   │  claims & works     │
│  monitors done │   │  on code tasks  │   │  on research tasks  │
└───────┬────────┘   └────────┬────────┘   └────────┬────────────┘
        │ planner-token       │ worker-code-token    │ worker-research-token
        └─────────┬───────────┴──────────────────────┘
                  │  MCP Streamable HTTP + SSE notifications
         ┌────────┴────────┐
         │  AgentDB Server │
         │   port 3000     │
         │  tasks / notes  │
         └─────────────────┘
                  │
              Ollama
           (llama3.2)
```

## How It Works

1. **Workers connect** and call `db_subscribe("tasks")` — opens an SSE stream for push notifications
2. **Planner connects**, asks Ollama to break down a goal into tasks, inserts them via `db_insert`
3. **Server pushes** `db_change` notifications to subscribed workers via SSE
4. **Workers receive** the notification, fetch the new task, check if it matches their specialty
5. **Workers claim** the task with `db_update` + `expectedVersion` (optimistic locking — prevents double-claiming)
6. **Workers ask Ollama** how to complete the task, record results in `notes` collection, mark task done
7. **Planner receives** completion notification, tracks progress, generates final summary when all done

Zero polling. All coordination is event-driven through AgentDB's NOTIFY/LISTEN.

## Prerequisites

- [Ollama](https://ollama.com) running locally
- `ollama pull llama3.2` (3B model, ~2GB)
- AgentDB built: `npm run build` in the repo root

## Quick Start

```bash
./run.sh
```

Or with a custom goal:

```bash
./run.sh "Build a real-time chat application with WebSocket support"
```

## Manual Start (separate terminals)

```bash
# Terminal 1: Server
npx tsx server.ts

# Terminal 2: Code worker
npx tsx worker.ts code worker-code-token

# Terminal 3: Research worker
npx tsx worker.ts research worker-research-token

# Terminal 4: Planner (starts the workflow)
npx tsx planner.ts "Build a REST API for user authentication"
```

## Files

| File | Description |
|------|-------------|
| `server.ts` | AgentDB HTTP server with per-agent auth tokens |
| `planner.ts` | Planner agent — decomposes goal, monitors completion |
| `worker.ts` | Worker agent — claims tasks by specialty, completes via Ollama |
| `mcp-client.ts` | MCP client wrapper using `@modelcontextprotocol/sdk` Client + StreamableHTTPClientTransport |
| `ollama.ts` | Ollama chat API wrapper |
| `run.sh` | Orchestrates all processes |

## Key Patterns

- **Event-driven** — `db_subscribe` + SSE notifications, not polling
- **Optimistic locking** — `expectedVersion` prevents two workers claiming the same task
- **Agent identity** — each agent authenticates with its own bearer token
- **Separation of concerns** — planner plans, workers execute, AgentDB coordinates
