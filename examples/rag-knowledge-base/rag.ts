#!/usr/bin/env npx tsx
/**
 * RAG Knowledge Base — ingest documents, embed with Ollama, answer questions.
 *
 * Uses hybrid search (BM25 + semantic RRF) for retrieval. Hybrid beats either
 * arm alone: BM25 catches exact-term matches (e.g. API names, error codes) that
 * semantic search misses, while the vector arm finds paraphrases and synonyms
 * that keyword search misses.
 *
 * Usage:
 *   npx tsx rag.ts ingest <file-or-directory>   Ingest text files
 *   npx tsx rag.ts ask "your question"           Ask a question
 *   npx tsx rag.ts list                          List all documents
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { AgentDB } from "../../src/agentdb.js";
import { defineSchema } from "../../src/schema.js";
import { askOllama } from "./ollama.js";

const DATA_DIR = "./rag-data";

const db = new AgentDB(DATA_DIR, {
  embeddings: { provider: "ollama" },
});
await db.init();

const docs = await db.collection(defineSchema({
  name: "documents",
  textSearch: true,
  fields: {
    source: { type: "string" },
    chunk:  { type: "number" },
    text:   { type: "string", searchable: true },  // BM25-indexed
  },
}));

const command = process.argv[2];

if (command === "ingest") {
  const target = process.argv[3];
  if (!target) { console.error("Usage: rag.ts ingest <file-or-directory>"); process.exit(1); }

  const files: string[] = [];
  const s = await stat(target);
  if (s.isDirectory()) {
    const entries = await readdir(target);
    for (const e of entries) {
      if (e.endsWith(".txt") || e.endsWith(".md")) files.push(join(target, e));
    }
  } else {
    files.push(target);
  }

  console.log(`Ingesting ${files.length} file(s)...\n`);

  for (const file of files) {
    const content = await readFile(file, "utf-8");
    const name = basename(file);

    // Split into chunks (~500 chars each with overlap)
    const chunks = chunkText(content, 500, 50);
    console.log(`  ${name}: ${chunks.length} chunks`);

    for (let i = 0; i < chunks.length; i++) {
      await docs.insert({
        _id: `${name}:${i}`,
        source: name,
        chunk: i,
        text: chunks[i],
      });
    }
  }

  // Embed all un-embedded records (Ollama nomic-embed-text)
  const embedded = await docs.embedUnembedded();
  console.log(`\nEmbedded ${embedded} chunks. ${(await db.stats()).totalRecords} total indexed.`);

} else if (command === "ask") {
  const question = process.argv.slice(3).join(" ");
  if (!question) { console.error("Usage: rag.ts ask \"your question\""); process.exit(1); }

  console.log(`Question: ${question}\n`);

  // Hybrid search: BM25 catches exact terms; vector arm catches paraphrases
  const results = await docs.hybridSearch(question, { limit: 5 });

  if (results.records.length === 0) {
    console.log("No relevant documents found. Ingest some files first.");
    process.exit(0);
  }

  console.log(`Found ${results.records.length} relevant chunks (RRF scores: ${results.scores.map((s: number) => s.toFixed(4)).join(", ")})\n`);

  // Build context from top results
  const context = results.records
    .map((r, i) => `[Source: ${r.source}, chunk ${r.chunk}, score: ${results.scores[i].toFixed(4)}]\n${r.text}`)
    .join("\n\n---\n\n");

  // Ask Ollama with context
  const answer = await askOllama(
    `You are a helpful assistant. Answer the question using ONLY the provided context. If the context doesn't contain enough information, say so. Cite the source file when possible.`,
    `Context:\n${context}\n\nQuestion: ${question}`,
  );

  console.log("Answer:", answer);

} else if (command === "list") {
  const result = await docs.find({ limit: 1000 });
  const sources = new Map<string, number>();
  for (const r of result.records) {
    const src = r.source as string;
    sources.set(src, (sources.get(src) ?? 0) + 1);
  }
  console.log(`Knowledge base: ${result.total} chunks from ${sources.size} file(s)\n`);
  for (const [src, count] of sources) {
    console.log(`  ${src}: ${count} chunks`);
  }

} else {
  console.log("RAG Knowledge Base — powered by AgentDB + Ollama\n");
  console.log("Commands:");
  console.log("  npx tsx rag.ts ingest <file-or-dir>   Ingest text/markdown files");
  console.log("  npx tsx rag.ts ask \"your question\"     Ask a question (hybrid search)");
  console.log("  npx tsx rag.ts list                    List indexed documents");
}

await db.close();

// --- Helpers ---

function chunkText(text: string, chunkSize: number, overlap: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    const chunk = text.slice(start, end).trim();
    if (chunk.length > 0) chunks.push(chunk);
    start += chunkSize - overlap;
  }
  return chunks;
}
