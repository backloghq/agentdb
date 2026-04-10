#!/usr/bin/env npx tsx
/**
 * Live Dashboard — real-time CLI view of AgentDB collections.
 * Opens in read-only mode so it can run alongside a live demo.
 *
 * Usage: npx tsx dashboard.ts [data-dir]
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Store } from "@backloghq/opslog";

const DATA_DIR = process.argv[2] || "../multi-agent/taskboard-data";
const COLLECTIONS_DIR = join(DATA_DIR, "collections");

// Discover collections from the data directory
async function discoverCollections(): Promise<string[]> {
  try {
    const metaPath = join(DATA_DIR, "meta", "manifest.json");
    const meta = JSON.parse(await readFile(metaPath, "utf-8"));
    return meta.collections ?? [];
  } catch {
    try {
      const entries = await readdir(COLLECTIONS_DIR);
      return entries.filter(e => !e.startsWith(".") && !e.startsWith("_"));
    } catch {
      return [];
    }
  }
}

// Open a collection store in read-only mode
async function openStore(name: string): Promise<Store<Record<string, unknown>>> {
  const store = new Store<Record<string, unknown>>();
  await store.open(join(COLLECTIONS_DIR, name), { readOnly: true, checkpointThreshold: 100000 });
  return store;
}

const collectionNames = await discoverCollections();
if (collectionNames.length === 0) {
  console.log("No collections found. Make sure a demo is running first.");
  process.exit(0);
}

// Open all stores read-only
const stores = new Map<string, Store<Record<string, unknown>>>();
for (const name of collectionNames) {
  try {
    stores.set(name, await openStore(name));
  } catch { /* skip locked/broken collections */ }
}

async function render(): Promise<void> {
  const lines: string[] = [];
  let totalRecords = 0;

  lines.push(`Database: ${stores.size} collections`);
  lines.push("─".repeat(60));

  for (const [name, store] of stores) {
    // Tail to pick up latest changes
    try { await store.tail(); } catch { /* ignore */ }

    const all = store.all();
    totalRecords += all.length;
    lines.push(`\n  ${name} (${all.length} records)`);

    // Status breakdown
    const statuses = new Map<string, number>();
    for (const r of all) {
      const s = (r as Record<string, unknown>).status as string | undefined;
      if (s) statuses.set(s, (statuses.get(s) ?? 0) + 1);
    }
    if (statuses.size > 0) {
      const parts = [...statuses.entries()].map(([s, n]) => `${s}: ${n}`);
      lines.push(`    ${parts.join("  ")}`);
    }

    // Recent records (last 3 by insertion order)
    const recent = all.slice(-3).reverse();
    if (recent.length > 0) {
      lines.push("    recent:");
      for (const r of recent) {
        const rec = r as Record<string, unknown>;
        const title = rec.title || rec.content?.toString().substring(0, 50) || rec._id;
        const status = rec.status ? ` [${rec.status}]` : "";
        const agent = rec.assignee || rec.processor || rec.from || rec.stage || "";
        lines.push(`      ${title}${status}${agent ? ` (${agent})` : ""}`);
      }
    }
  }

  lines.push(`\n${"─".repeat(60)}`);
  lines.push(`Total: ${totalRecords} records | Updated: ${new Date().toLocaleTimeString()}`);

  console.clear();
  console.log("Live Dashboard\n");
  console.log(lines.join("\n"));
}

// Render loop
await render();
const interval = setInterval(() => render(), 1000);

process.on("SIGINT", async () => {
  clearInterval(interval);
  for (const store of stores.values()) await store.close();
  process.exit(0);
});
