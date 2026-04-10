#!/usr/bin/env npx tsx
/**
 * Live Dashboard — real-time CLI view of AgentDB collections.
 * Watches for changes and re-renders stats on every mutation.
 *
 * Usage: npx tsx dashboard.ts [data-dir]
 *
 * Works with any AgentDB data directory — point it at the multi-agent
 * or research-pipeline data to see live updates.
 */
import { AgentDB } from "../../src/agentdb.js";
import { Collection } from "../../src/collection.js";

const DATA_DIR = process.argv[2] || "../multi-agent/taskboard-data";

const db = new AgentDB(DATA_DIR);
await db.init();

const collections = await db.listCollections();
if (collections.length === 0) {
  console.log("No collections found. Run a demo first, then point this dashboard at its data directory.");
  await db.close();
  process.exit(0);
}

console.clear();
console.log("Live Dashboard — watching for changes (Ctrl+C to exit)\n");

// Track collections and set up watchers
const watchers: Collection[] = [];

async function render(): Promise<void> {
  const lines: string[] = [];
  const stats = await db.stats();
  lines.push(`Database: ${stats.collections} collections, ${stats.totalRecords} total records`);
  lines.push("─".repeat(60));

  for (const info of await db.listCollections()) {
    const col = await db.collection(info.name);
    lines.push(`\n  ${info.name} (${info.recordCount} records)`);

    // Show status breakdown if records have a status field
    const schema = col.schema(10);
    const hasStatus = schema.fields.some(f => f.name === "status");

    if (hasStatus) {
      const pending = col.count({ status: "pending" });
      const inProgress = col.count({ status: "in_progress" }) + col.count({ status: "processing" });
      const completed = col.count({ status: "completed" }) + col.count({ status: "done" });
      lines.push(`    pending: ${pending}  active: ${inProgress}  done: ${completed}`);
    }

    // Show recent records
    const recent = col.find({ limit: 3, sort: "-_version" });
    if (recent.records.length > 0) {
      lines.push("    recent:");
      for (const r of recent.records) {
        const title = r.title || r.content?.toString().substring(0, 50) || r._id;
        const status = r.status ? ` [${r.status}]` : "";
        const agent = r.assignee || r.processor || r.from || r.stage || "";
        lines.push(`      ${title}${status}${agent ? ` (${agent})` : ""}`);
      }
    }
  }

  lines.push("\n" + "─".repeat(60));
  lines.push(`Updated: ${new Date().toLocaleTimeString()}`);

  // Clear and render
  console.clear();
  console.log("Live Dashboard\n");
  console.log(lines.join("\n"));
}

// Initial render
await render();

// Watch all collections for changes
for (const info of collections) {
  const col = await db.collection(info.name);
  watchers.push(col);
  col.watch(async () => {
    await render();
  }, 500);
}

// Graceful shutdown
process.on("SIGINT", async () => {
  for (const col of watchers) col.unwatch();
  await db.close();
  process.exit(0);
});
