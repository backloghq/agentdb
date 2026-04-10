# Research Pipeline

A 3-stage AI pipeline where each agent's output triggers the next — all coordinated through AgentDB's NOTIFY/LISTEN.

## Architecture

```
Topic injected
       │
       ▼
┌──────────────┐    NOTIFY     ┌──────────────┐    NOTIFY     ┌──────────────┐
│  Researcher  │ ──────────▶   │   Analyst    │ ──────────▶   │    Writer    │
│              │               │              │               │              │
│ topics →     │               │ sources →    │               │ insights →   │
│   sources    │               │   insights   │               │   report     │
└──────────────┘               └──────────────┘               └──────────────┘
       │                              │                              │
       └──────────────┬───────────────┴──────────────────────────────┘
                      │
              AgentDB Server
              (collections: topics, sources, insights, report)
```

## How It Works

1. A **topic** is inserted into the `topics` collection
2. **Researcher** is subscribed to `topics` — gets notified, researches the topic, writes findings to `sources`
3. **Analyst** is subscribed to `sources` — gets notified, extracts insights, writes to `insights`
4. **Writer** is subscribed to `insights` — gets notified, produces a final report in `report`

Each stage uses a generic `stage.ts` agent parameterized by input/output collection and Ollama system prompt. The pipeline is entirely event-driven — each stage triggers the next via AgentDB notifications.

## Prerequisites

- [Ollama](https://ollama.com) running locally
- `ollama pull llama3.2`

## Quick Start

```bash
./run.sh
```

With a custom topic:

```bash
./run.sh "How WebAssembly is changing backend development"
```

## AgentDB Features Used

- `db_subscribe` — each stage subscribes to its input collection
- SSE notifications — stages trigger automatically when upstream writes
- Optimistic locking — prevents duplicate processing
- Per-agent auth tokens — each stage has its own identity
- Status tracking — items flow through `pending` → `processing` → `done`
