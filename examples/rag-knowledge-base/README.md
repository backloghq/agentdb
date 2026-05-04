# RAG Knowledge Base

Ingest documents, embed them with Ollama, and answer questions using **hybrid search** — BM25 lexical scoring fused with vector similarity via Reciprocal Rank Fusion (RRF).

## Why hybrid beats either arm alone

| Signal | Wins for |
|--------|----------|
| BM25 (lexical) | Exact API names, error codes, version numbers, rare terms |
| Semantic (vector) | Paraphrases, synonyms, concept matches without exact wording |
| **Hybrid (RRF)** | **Both** — neither arm's top hit gets buried by the other |

## How It Works

```
Documents (txt/md)
       │
       ▼
  Chunk into ~500 char segments
       │
       ▼
  Insert into AgentDB (textSearch: true, text field searchable: true)
       │
       ▼
  embedUnembedded() → Ollama nomic-embed-text → HNSW index
       │
       ▼  On question:
  hybridSearch(question, { limit: 5 })
       │
  ─────┴──────────────────────
  │                          │
  BM25 arm                Semantic arm
  (searchScored)          (semanticSearch)
  │                          │
  └──────── RRF fusion ──────┘
               │
          Top 5 chunks → Ollama answers with context
```

## Prerequisites

- [Ollama](https://ollama.com) running locally
- `ollama pull nomic-embed-text` (embedding model)
- `ollama pull llama3.2` (chat model for answering)

## Usage

```bash
# Ingest files
npx tsx rag.ts ingest ./my-docs/
npx tsx rag.ts ingest README.md

# Ask questions (hybrid search)
npx tsx rag.ts ask "How does authentication work?"
npx tsx rag.ts ask "What are the deployment options?"

# List indexed documents
npx tsx rag.ts list
```

## Example

```bash
# Ingest AgentDB's own docs
npx tsx rag.ts ingest ../../README.md

# Ask about it
npx tsx rag.ts ask "What deployment patterns does AgentDB support?"
npx tsx rag.ts ask "How do I set up S3 backend?"
```

## AgentDB Features Used

- `defineSchema` with `textSearch: true` and `searchable: true` on the `text` field
- `embedUnembedded()` — batch-embed un-embedded records via Ollama
- `hybridSearch(query, { limit })` — BM25 + semantic RRF fusion
- Ollama embedding provider (`nomic-embed-text`)
