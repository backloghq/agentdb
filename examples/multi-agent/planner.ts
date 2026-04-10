#!/usr/bin/env npx tsx
/**
 * Planner Agent — breaks a goal into tasks, monitors completion via notifications.
 */
import { AgentDBClient } from "./mcp-client.js";
import { askOllama } from "./ollama.js";

const GOAL = process.argv[2] || "Build a REST API for user authentication with signup, login, and password reset";

const db = new AgentDBClient("http://127.0.0.1:3000/mcp", "planner-token");
await db.connect();
console.log("[planner] Connected");

// Ask Ollama to plan
console.log(`[planner] Goal: "${GOAL}"`);
console.log("[planner] Planning...\n");

const plan = await askOllama(
  `You are a project planner. Break goals into 4-5 tasks.
Return a JSON object with a "tasks" array. Each task has: title, description, specialty ("code" or "research"), priority ("H", "M", or "L").
Example: {"tasks":[{"title":"Research auth libs","description":"Compare JWT libraries","specialty":"research","priority":"H"}]}`,
  `Break down: "${GOAL}"`,
  { json: true },
);

let tasks: Array<{ title: string; description: string; specialty: string; priority: string }>;
try {
  const parsed = JSON.parse(plan);
  tasks = parsed.tasks ?? parsed.task ?? parsed;
  if (!Array.isArray(tasks)) throw new Error("Not an array");
} catch {
  console.error("[planner] Failed to parse plan:", plan);
  process.exit(1);
}

// Normalize specialty to lowercase
tasks = tasks.map(t => ({ ...t, specialty: t.specialty.toLowerCase(), priority: t.priority.toUpperCase() }));

// Insert tasks
for (const task of tasks) {
  const { ids } = await db.callTool("db_insert", {
    collection: "tasks",
    record: { ...task, status: "pending", assignee: null, createdAt: new Date().toISOString() },
  }) as { ids: string[] };
  console.log(`[planner] Created: "${task.title}" (${task.specialty}, ${task.priority}) → ${ids[0]}`);
}
console.log(`\n[planner] ${tasks.length} tasks created. Waiting for completion...\n`);

// Monitor via notifications
let completed = 0;
await db.subscribe("tasks", async (event) => {
  if (event.event !== "db_change" || event.collection !== "tasks") return;

  const { total } = await db.callTool("db_count", { collection: "tasks", filter: { status: "completed" } }) as { count: number; total?: number };
  const now = (total as unknown as number) ?? 0;

  // db_count returns { count: N } — handle both shapes
  const result = await db.callTool("db_count", { collection: "tasks", filter: { status: "completed" } }) as Record<string, unknown>;
  const count = (result.count ?? result.total ?? 0) as number;

  if (count > completed) {
    completed = count;
    console.log(`[planner] Progress: ${completed}/${tasks.length} completed`);

    if (completed >= tasks.length) {
      console.log("\n[planner] All done! Summary:\n");

      const { records: allTasks } = await db.callTool("db_find", { collection: "tasks" }) as { records: Array<Record<string, unknown>> };
      const { records: notes } = await db.callTool("db_find", { collection: "notes" }) as { records: Array<Record<string, unknown>> };

      const summary = await askOllama(
        "Summarize the completed project work in a short paragraph.",
        `Goal: "${GOAL}"\nTasks: ${JSON.stringify(allTasks)}\nNotes: ${JSON.stringify(notes)}`,
      );
      console.log("[planner]", summary);

      await db.disconnect();
      process.exit(0);
    }
  }
});

console.log("[planner] Subscribed to task updates...");
