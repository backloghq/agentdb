#!/usr/bin/env npx tsx
/**
 * Worker Agent — claims and completes tasks matching its specialty.
 * Event-driven via MCP notifications, no polling.
 *
 * Usage: npx tsx worker.ts <specialty> <token>
 */
import { AgentDBClient } from "./mcp-client.js";
import { askOllama } from "./ollama.js";

const SPECIALTY = process.argv[2] || "code";
const TOKEN = process.argv[3] || `worker-${SPECIALTY}-token`;
const NAME = `worker-${SPECIALTY}`;

const db = new AgentDBClient("http://127.0.0.1:3000/mcp", TOKEN);
await db.connect();
console.log(`[${NAME}] Connected`);

let busy = false;

async function claimAndWork(taskId: string): Promise<void> {
  if (busy) return;

  const { record: task } = await db.callTool("db_find_one", { collection: "tasks", id: taskId }) as {
    record: Record<string, unknown> | null;
  };

  if (!task || task.status !== "pending" || task.specialty !== SPECIALTY) return;

  // Claim with optimistic locking
  try {
    await db.callTool("db_update", {
      collection: "tasks",
      filter: { _id: taskId },
      update: { $set: { status: "in_progress", assignee: NAME, startedAt: new Date().toISOString() } },
      expectedVersion: task._version,
    });
  } catch {
    console.log(`[${NAME}] Could not claim "${task.title}" — already taken`);
    return;
  }

  busy = true;
  console.log(`[${NAME}] Claimed: "${task.title}"`);
  console.log(`[${NAME}] Working...`);

  const work = await askOllama(
    `You are a ${SPECIALTY} specialist. Complete the task concisely in 2-3 sentences.`,
    `Task: ${task.title}\nDescription: ${task.description}\n\nDescribe what you did.`,
  );

  await db.callTool("db_insert", {
    collection: "notes",
    record: { taskId, from: NAME, content: work, timestamp: new Date().toISOString() },
  });

  await db.callTool("db_update", {
    collection: "tasks",
    filter: { _id: taskId },
    update: { $set: { status: "completed", completedAt: new Date().toISOString() } },
  });

  console.log(`[${NAME}] Completed: "${task.title}"`);
  console.log(`[${NAME}] Result: ${work.substring(0, 120)}...\n`);
  busy = false;
}

// Check for existing pending tasks
const { records: existing } = await db.callTool("db_find", {
  collection: "tasks",
  filter: { status: "pending", specialty: SPECIALTY },
}) as { records: Array<Record<string, unknown>> };

for (const r of existing) await claimAndWork(r._id as string);

// Subscribe — react to new tasks via server push
await db.subscribe("tasks", async (event) => {
  if (event.event !== "db_change" || event.type !== "insert") return;
  for (const id of event.ids as string[]) await claimAndWork(id);
});

console.log(`[${NAME}] Listening for ${SPECIALTY} tasks...\n`);
