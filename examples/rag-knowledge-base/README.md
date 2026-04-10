# RAG Knowledge Base

Ingest documents, embed them with Ollama, and answer questions using semantic search — all backed by AgentDB.

## How It Works

```
Documents (txt/md)
       │
       ▼
  Chunk into ~500 char segments
       │
       ▼
  Embed each chunk via Ollama (nomic-embed-text)
       │
       ▼
  Store in AgentDB via insertVector()
       │
  ─────┴─────
  │         │
  ▼         ▼
HNSW      Record
Index     Storage
  │         │
  └────┬────┘
       │
  On question:
       │
  Embed question → searchByVector() → Top 5 chunks → Ollama answers with context
```

## Features

- **Chunking** with overlap for better retrieval across chunk boundaries
- **Semantic search** via HNSW approximate nearest neighbor
- **Source attribution** — answers cite which file the information came from
- **Full-text search** enabled alongside vector search
- **Persistent** — ingest once, query many times

## Prerequisites

- [Ollama](https://ollama.com) running locally
- `ollama pull nomic-embed-text` (embedding model)
- `ollama pull llama3.2` (chat model for answering)

## Usage

```bash
# Ingest files
npx tsx rag.ts ingest ./my-docs/
npx tsx rag.ts ingest README.md

# Ask questions
npx tsx rag.ts ask "How does authentication work?"
npx tsx rag.ts ask "What are the deployment options?"

# List indexed documents
npx tsx rag.ts list
```

## Example

```bash
# Ingest AgentDB's own docs
npx tsx rag.ts ingest ../../README.md
npx tsx rag.ts ingest ../../DEPLOYMENT.md

# Ask about it
npx tsx rag.ts ask "What deployment patterns does AgentDB support?"
npx tsx rag.ts ask "How do I set up S3 backend?"
```

## AgentDB Features Used

- `insertVector(id, vector, metadata)` — store pre-computed embeddings
- `searchByVector(vector, { limit })` — approximate nearest neighbor search
- `Collection` with `textSearch: true` — full-text search alongside vectors
- Ollama embedding provider (`nomic-embed-text`)
