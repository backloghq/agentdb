# AgentDB Deployment Patterns

## Single Agent, Local Filesystem

The simplest setup. One agent, one process, data on disk.

```bash
npx agentdb --path ./data
```

Or import directly:

```typescript
const db = new AgentDB("./data");
```

**When:** Local development, single Claude Code session, prototyping.
**Memory:** One copy of all records in memory.
**Latency:** Sub-millisecond reads and writes.

---

## Multiple Agents, Single Server (Recommended)

One AgentDB HTTP server holds the data. Multiple agents connect to it. This is the recommended pattern for most multi-agent use cases.

```
Agent 1 ──┐
Agent 2 ──┼── HTTP/MCP ──→  AgentDB Server  ──→ Filesystem or S3
Agent 3 ──┘               (one process, one
Agent N                    copy in memory)
```

### Setup

Start the server:

```bash
# Filesystem
npx agentdb --path ./data --http --port 3000

# S3
npx agentdb --backend s3 --bucket my-bucket --region us-east-1 --http --port 3000
```

Agents connect via MCP Streamable HTTP or direct HTTP calls.

### Why this is the default recommendation

- **One copy in memory.** 100K records = ~50MB on the server. Not 50MB × N agents.
- **No network overhead on queries.** Reads are in-memory on the server. Agents get results over HTTP (~1-5ms per call).
- **Writes are serialized.** The opslog async mutex handles concurrent writes from multiple agents. No conflicts, no Lamport clocks needed.
- **S3 writes are batched.** The server writes to S3 on checkpoint, not per-operation. Much cheaper.
- **Simple operations.** One process to monitor, restart, scale.

### Tradeoffs

- Single point of failure. If the server crashes, agents can't read or write until it restarts. Data is safe on disk/S3 — only availability is affected.
- All agents share one process. CPU-intensive queries (semantic search on large datasets) affect all connected agents.
- Requires network connectivity between agents and server.

---

## Multiple Agents, Multi-Writer (Decentralized)

Each agent has its own AgentDB instance and writes directly to S3. No central server. Agents see each other's writes by refreshing from S3.

```
Agent 1 ──→ S3 ←── Agent 2
              ↑
Agent 3 ──────┘
```

### Setup

Each agent:

```bash
npx agentdb --backend s3 --bucket my-bucket --agent-id agent-1
```

Or in code:

```typescript
const db = new AgentDB("mydb", {
  backend: new S3Backend({ bucket: "my-bucket", region: "us-east-1" }),
  agentId: "agent-1",
});
await db.init();

const tasks = await db.collection("tasks");

// Write (goes to agent-1's WAL on S3)
await tasks.insert({ title: "New task" });

// Read other agents' writes
await tasks.refresh();  // Re-downloads all agent WALs from S3
const result = tasks.find({ filter: { status: "active" } });
```

### How it works

- Each agent gets its own WAL file on S3 (`ops/agent-<id>-<ts>/`). No write contention.
- On `refresh()`, the agent re-reads the manifest, downloads the snapshot, and replays ALL agents' WAL files.
- Operations are merge-sorted by Lamport clock for deterministic ordering.
- Conflicts are resolved by last-write-wins (highest clock value).

### When to use this

- Agents run on different machines with no shared server.
- Offline/disconnected operation — agents write locally, sync when they reconnect.
- No single point of failure requirement.
- Dataset is small enough that every agent can hold it in memory.

### Tradeoffs

- **Full replication.** Every agent holds the entire dataset in memory. 100K records × 10 agents = 500MB total.
- **Refresh is expensive.** Every `refresh()` re-downloads snapshot + all WALs from S3. At scale, this is many S3 GetObject calls.
- **Eventual consistency.** Agents see stale data until they call `refresh()`. There's no push notification — you must poll.
- **No query delegation.** Every agent processes queries locally. Semantic search on 100K records runs on every agent, not once on a server.
- **Cost.** S3 operations are ~$0.005/1000 requests. 10 agents refreshing every 5 seconds = 120 requests/minute = ~$26/month just for polling. Writes add more.

---

## Single Agent, S3 Backend (Serverless / Lambda)

One agent per invocation, data on S3. Each invocation opens the store, does work, closes. No long-running server.

```typescript
// Lambda handler
export async function handler(event) {
  const db = new AgentDB("lambda-db", {
    backend: new S3Backend({ bucket: "my-bucket", region: "us-east-1" }),
  });
  await db.init();

  const tasks = await db.collection("tasks");
  await tasks.insert({ title: event.title, source: "lambda" });
  
  const result = tasks.find({ filter: { status: "active" } });
  await db.close();
  
  return { statusCode: 200, body: JSON.stringify(result) };
}
```

### When to use this

- Event-driven architectures (Lambda, Cloud Functions).
- Infrequent writes, short-lived processes.
- Data must persist across invocations (S3).

### Tradeoffs

- Cold start on every invocation (~200ms for 100 records, more for larger datasets).
- No in-memory caching across invocations.
- Concurrent Lambda invocations need `agentId` to avoid lock conflicts.

---

## ReadOnly Replicas

One writer process, multiple read-only processes. Readers can tail the WAL for near-real-time updates.

```
Writer ──→ Filesystem/S3
              ↑
Reader 1 ─────┤  (readOnly: true)
Reader 2 ─────┘
```

### Setup

Writer:
```typescript
const db = new AgentDB("./data");
```

Reader:
```typescript
const store = new Store();
await store.open("./data", { readOnly: true });

// Poll for updates from the writer
store.watch((newOps) => {
  console.log("New data:", newOps.length, "operations");
}, 1000);
```

### When to use this

- Dashboards, monitoring, analytics that read the same data the writer produces.
- Read scaling without HTTP overhead.
- Filesystem-based (readers on the same machine or shared volume).

---

## Decision Matrix

| Scenario | Pattern | Memory per agent | Write latency | Read consistency |
|---|---|---|---|---|
| Single dev, local | Filesystem | 1× | <1ms | Immediate |
| Multiple agents, same machine | HTTP server | 0× (server holds it) | ~2ms (HTTP) | Immediate |
| Multiple agents, different machines | HTTP server + S3 | 0× (server holds it) | ~50ms (S3 write) | Immediate |
| Agents on different machines, no server | Multi-writer S3 | 1× per agent | ~50ms (S3 write) | Eventual (refresh) |
| Serverless (Lambda) | S3 per invocation | 1× per invocation | ~50ms (S3 write) | Per-invocation |
| Read scaling | ReadOnly replicas | 1× per reader | N/A (read-only) | Near-real-time (tail) |

**Default recommendation: HTTP server.** Use multi-writer only when you truly need decentralized writes with no single server.
