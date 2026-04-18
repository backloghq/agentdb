#!/usr/bin/env npx tsx
/**
 * Live Dashboard — real-time CLI view of AgentDB collections.
 * Opens in read-only mode so it can run alongside a live demo.
 *
 * Usage: npx tsx dashboard.ts [data-dir]
 */
import { AgentDB } from "../../src/agentdb.js";

const DATA_DIR = process.argv[2] || "../multi-agent/taskboard-data";

const db = new AgentDB(DATA_DIR, { readOnly: true });
await db.init();

const collectionNames = (await db.listCollections()).map(c => c.name);
if (collectionNames.length === 0) {
  console.log("No collections found. Make sure a demo is running first.");
  await db.close();
  process.exit(0);
}

async function render(): Promise<void> {
  const lines: string[] = [];
  const stats = await db.stats();

  lines.push(`Database: ${stats.collections} collections, ${stats.totalRecords} total records`);
  lines.push("─".repeat(60));

  for (const name of collectionNames) {
    const col = await db.collection(name);

    // Tail to pick up latest changes from the writer
    try { await col.tail(); } catch { /* ignore */ }

    const count = await col.count();
    lines.push(`\n  ${name} (${count} records)`);

    // Status breakdown
    const schema = col.schema(10);
    const hasStatus = schema.fields.some(f => f.name === "status");
    if (hasStatus) {
      const pending = await col.count({ status: "pending" });
      const active = (await col.count({ status: "in_progress" })) + (await col.count({ status: "processing" }));
      const done = (await col.count({ status: "completed" })) + (await col.count({ status: "done" }));
      lines.push(`    pending: ${pending}  active: ${active}  done: ${done}`);
    }

    // Recent records
    const recent = await col.find({ limit: 3, sort: "-_version" });
    if (recent.records.length > 0) {
      lines.push("    recent:");
      for (const r of recent.records) {
        const title = r.title || (r.content as string)?.substring(0, 50) || r._id;
        const status = r.status ? ` [${r.status}]` : "";
        const agent = r.assignee || r.processor || r.from || r.stage || "";
        lines.push(`      ${title}${status}${agent ? ` (${agent})` : ""}`);
      }
    }
  }

  lines.push(`\n${"─".repeat(60)}`);
  lines.push(`Updated: ${new Date().toLocaleTimeString()}`);

  console.clear();
  console.log("Live Dashboard\n");
  console.log(lines.join("\n"));
}

await render();
const interval = setInterval(() => render(), 1000);

process.on("SIGINT", async () => {
  clearInterval(interval);
  await db.close();
  process.exit(0);
});
