#!/bin/bash
# Research Pipeline — 3-stage AI pipeline via AgentDB
# Usage: ./run.sh ["topic to research"]
set -e
cd "$(dirname "$0")"

TOPIC="${1:-The future of embedded databases for AI agents}"

fuser -k 3001/tcp 2>/dev/null || true
rm -rf pipeline-data

echo "Starting pipeline server..."
npx tsx server.ts &
SERVER_PID=$!
sleep 2

echo "Starting pipeline stages..."

# Stage 1: Researcher — reads topics, produces sources
npx tsx stage.ts researcher researcher-token topics sources \
  "You are a researcher. Given a topic, find 3-4 key sources or references. Describe each source briefly with its main argument. Be concise." &
PID1=$!
sleep 1

# Stage 2: Analyst — reads sources, produces insights
npx tsx stage.ts analyst analyst-token sources insights \
  "You are an analyst. Given research sources, extract 3-5 key insights or patterns. Be specific and cite the sources. Be concise." &
PID2=$!
sleep 1

# Stage 3: Writer — reads insights, produces report
npx tsx stage.ts writer writer-token insights report \
  "You are a writer. Given a set of insights, write a concise summary report (2-3 paragraphs). Make it informative and well-structured." &
PID3=$!
sleep 1

echo ""
echo "Pipeline ready. Injecting topic: \"$TOPIC\""
echo ""

# Inject the topic — this triggers the cascade
npx tsx -e "
import { AgentDBClient } from './mcp-client.js';
const db = new AgentDBClient('http://127.0.0.1:3001/mcp', 'researcher-token');
await db.connect();
await db.callTool('db_insert', {
  collection: 'topics',
  record: { title: '$TOPIC', status: 'pending', createdAt: new Date().toISOString() },
});
console.log('Topic injected. Pipeline running...');

// Wait for the report to appear
let attempts = 0;
const check = setInterval(async () => {
  const result = await db.callTool('db_find', { collection: 'report' }) as { records: Array<Record<string, unknown>> };
  if (result.records.length > 0) {
    console.log('\n--- FINAL REPORT ---\n');
    console.log(result.records[0].content);
    console.log('\n--- END ---\n');
    clearInterval(check);
    await db.disconnect();
    process.exit(0);
  }
  if (++attempts > 60) {
    console.log('Timeout waiting for report.');
    clearInterval(check);
    process.exit(1);
  }
}, 2000);
"

# Cleanup
kill $PID1 $PID2 $PID3 $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null
rm -rf pipeline-data
