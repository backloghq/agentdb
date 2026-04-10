#!/bin/bash
# Multi-agent demo — start server + 3 agents
# Usage: ./run.sh ["optional goal"]

set -e
cd "$(dirname "$0")"

GOAL="${1:-Build a REST API for user authentication with signup, login, and password reset}"

# Kill any existing processes on port 3000
fuser -k 3000/tcp 2>/dev/null || true
rm -rf taskboard-data

echo "Starting AgentDB server..."
npx tsx server.ts &
SERVER_PID=$!
sleep 2

echo "Starting workers..."
npx tsx worker.ts code worker-code-token &
WORKER_CODE_PID=$!
sleep 1

npx tsx worker.ts research worker-research-token &
WORKER_RESEARCH_PID=$!
sleep 1

echo "Starting planner..."
npx tsx planner.ts "$GOAL"

# Cleanup
echo "Shutting down..."
kill $WORKER_CODE_PID $WORKER_RESEARCH_PID 2>/dev/null
kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null
rm -rf taskboard-data
