#!/bin/bash
# RAG Knowledge Base — ingest docs + ask questions
# Usage: ./run.sh [directory-to-ingest]
set -e
cd "$(dirname "$0")"

DOCS="${1:-../../}"
rm -rf rag-data

echo "RAG Knowledge Base"
echo "=================="
echo ""

# Ingest
echo "Ingesting docs from $DOCS..."
echo ""
npx tsx rag.ts ingest "$DOCS"

echo ""
echo "Ready for questions. Type your question and press Enter. Type 'exit' to quit."
echo ""
echo "Examples:"
echo "  What deployment patterns does AgentDB support?"
echo "  How do I configure S3 backend?"
echo "  How does multi-agent collaboration work?"
echo ""

# Interactive loop
while true; do
  echo -n "Ask> "
  read -r question
  if [ -z "$question" ] || [ "$question" = "quit" ] || [ "$question" = "exit" ]; then
    break
  fi
  echo ""
  npx tsx rag.ts ask "$question"
  echo ""
done

echo "Cleaning up..."
rm -rf rag-data
