# Live Dashboard

A real-time CLI dashboard that watches AgentDB collections and re-renders on every change. Point it at any demo's data directory to see live updates as agents work.

## How It Works

The dashboard opens a read-only AgentDB instance on the same data directory as a running demo. It uses `Collection.watch()` to poll for WAL changes and re-renders the display whenever mutations are detected.

```
┌──────────────────────────────────┐
│  Live Dashboard                  │
│                                  │
│  Database: 2 collections, 12 recs│
│  ────────────────────────────    │
│                                  │
│  tasks (5 records)               │
│    pending: 0  active: 1  done: 4│
│    recent:                       │
│      Implement auth [done]       │
│      Design endpoints [active]   │
│                                  │
│  notes (4 records)               │
│    recent:                       │
│      Implemented login flow...   │
│                                  │
│  Updated: 12:45:03               │
└──────────────────────────────────┘
```

## Usage

Run alongside another demo:

```bash
# Terminal 1: Start the multi-agent demo
cd ../multi-agent && ./run.sh

# Terminal 2: Watch it live
cd ../live-dashboard
npx tsx dashboard.ts ../multi-agent/taskboard-data
```

Or with the research pipeline:

```bash
# Terminal 1: Start the pipeline
cd ../research-pipeline && ./run.sh

# Terminal 2: Watch it live  
cd ../live-dashboard
npx tsx dashboard.ts ../research-pipeline/pipeline-data
```

## Features

- Auto-discovers all collections in the data directory
- Status breakdown (pending / active / done) for collections with status fields
- Shows most recent records with title, status, and agent attribution
- Re-renders on every change via `Collection.watch()`
- Read-only — safe to run alongside a live demo

## AgentDB Features Used

- `Collection.watch(callback, intervalMs)` — WAL tailing for live updates
- `Collection.schema()` — auto-discovers field names to detect status fields
- `Collection.find({ sort: "-_version" })` — most recently modified records first
- `Collection.count(filter)` — fast status breakdowns
