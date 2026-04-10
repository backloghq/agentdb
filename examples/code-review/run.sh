#!/bin/bash
# Code Review Pipeline — Gemini generates code, Ollama reviews, Gemini writes tests
# Usage: GEMINI_API_KEY=... ./run.sh ["spec description"]
set -e
cd "$(dirname "$0")"

SPEC="${1:-Implement a rate limiter middleware for Express.js that limits requests per IP with a sliding window}"

if [ -z "$GEMINI_API_KEY" ]; then
  echo "Error: Set GEMINI_API_KEY env var (https://aistudio.google.com/apikey)"
  exit 1
fi

fuser -k 3002/tcp 2>/dev/null || true
rm -rf review-data output
mkdir -p output

echo "Code Review Pipeline"
echo "===================="
echo "  Coder:    Gemini 3 Flash (cloud)"
echo "  Reviewer: Ollama llama3.2 (local)"
echo "  Tester:   Gemini 3 Flash (cloud)"
echo ""

echo "Starting server..."
npx tsx server.ts &
SERVER_PID=$!
sleep 2

echo "Starting agents..."
npx tsx coder.ts &
PID1=$!
sleep 1

npx tsx reviewer.ts &
PID2=$!
sleep 1

npx tsx tester.ts &
PID3=$!
sleep 1

echo ""
echo "Injecting spec: \"$SPEC\""
echo ""

npx tsx inject.ts "$SPEC"

# Cleanup
echo ""
echo "Shutting down..."
kill $PID1 $PID2 $PID3 $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null
rm -rf review-data
