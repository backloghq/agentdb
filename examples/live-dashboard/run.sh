#!/bin/bash
# Live Dashboard — watch a running demo in real-time
# Usage: ./run.sh [data-directory]
#
# Examples:
#   ./run.sh ../multi-agent/taskboard-data
#   ./run.sh ../research-pipeline/pipeline-data
set -e
cd "$(dirname "$0")"

DATA="${1:-}"

if [ -z "$DATA" ]; then
  echo "Live Dashboard"
  echo "=============="
  echo ""
  echo "Usage: ./run.sh <data-directory>"
  echo ""
  echo "Point at a running demo's data directory:"
  echo "  ./run.sh ../multi-agent/taskboard-data"
  echo "  ./run.sh ../research-pipeline/pipeline-data"
  echo ""
  echo "Tip: start a demo in one terminal, run this in another."
  exit 1
fi

if [ ! -d "$DATA" ]; then
  echo "Directory not found: $DATA"
  echo "Make sure a demo is running first."
  exit 1
fi

npx tsx dashboard.ts "$DATA"
