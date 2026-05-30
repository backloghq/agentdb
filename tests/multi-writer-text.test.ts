/**
 * Multi-writer text-index tests — two AgentDB instances opened against the
 * same data directory with distinct agentIds share a federated termlog view
 * without contending on its lock. Exercises Collection.refresh() picking up
 * other agents' BM25 writes, cross-agent update tombstoning, and the legacy
 * single-writer → multi-writer auto-migration triggered on open().
 *
 * Mirrors the backlog use case where the parent Claude Code process and a
 * spawned subagent both open the same task store concurrently.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDB } from "../src/agentdb.js";
import { defineSchema } from "../src/schema.js";

let dir: string;
let alice: AgentDB;
let bob: AgentDB;

const tasksSchema = defineSchema({
  name: "tasks",
  textSearch: true,
  fields: { text: { type: "string", searchable: true } },
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agentdb-mwtext-"));
});

afterEach(async () => {
  if (alice) await alice.close().catch(() => undefined);
  if (bob) await bob.close().catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

describe("multi-writer text index", () => {
  it("two AgentDB instances with distinct agentIds open the same dir without IndexLockedError", async () => {
    alice = new AgentDB(dir, { agentId: "alice" });
    bob   = new AgentDB(dir, { agentId: "bob" });
    const colA = await alice.collection(tasksSchema);
    const colB = await bob.collection(tasksSchema);
    await colA.insert({ _id: "a-1", text: "alice apple" });
    await colB.insert({ _id: "b-1", text: "bob banana" });
    // No throw is the assertion — both writers up at the same time.
    expect(colA).toBeDefined();
    expect(colB).toBeDefined();
  });

  it("Collection.refresh() picks up another agent's BM25 writes", async () => {
    alice = new AgentDB(dir, { agentId: "alice" });
    bob   = new AgentDB(dir, { agentId: "bob" });
    const colA = await alice.collection(tasksSchema);
    const colB = await bob.collection(tasksSchema);

    await colA.insert({ _id: "task-alice", text: "alice writes a task about apricots" });
    await colB.insert({ _id: "task-bob",   text: "bob writes another task about apricots" });

    // Before refresh, alice sees only her own commit.
    const before = await colA.bm25Search("apricots", { limit: 10 });
    expect(before.records.map((r) => r._id).sort()).toEqual(["task-alice"]);

    await colA.refresh();

    const after = await colA.bm25Search("apricots", { limit: 10 });
    expect(after.records.map((r) => r._id).sort()).toEqual(["task-alice", "task-bob"]);
  });

  it("cross-agent update via the same _id tombstones the other agent's content", async () => {
    alice = new AgentDB(dir, { agentId: "alice" });
    bob   = new AgentDB(dir, { agentId: "bob" });
    const colA = await alice.collection(tasksSchema);
    const colB = await bob.collection(tasksSchema);

    await colA.insert({ _id: "shared", text: "alice version with cucumber" });
    await colB.refresh();
    await colB.upsert("shared", { text: "bob version with dragonfruit" });
    await colA.refresh();

    // "cucumber" must NOT match — alice's version was tombstoned by bob's update.
    const cuke = await colA.bm25Search("cucumber");
    expect(cuke.records.map((r) => r._id)).not.toContain("shared");

    // "dragonfruit" returns the canonical version exactly once.
    const drag = await colA.bm25Search("dragonfruit");
    const hits = drag.records.filter((r) => r._id === "shared");
    expect(hits.length).toBe(1);
  });

  it("multi-writer mode uses per-agent text-index files on disk", async () => {
    alice = new AgentDB(dir, { agentId: "alice" });
    const colA = await alice.collection(tasksSchema);
    await colA.insert({ _id: "a-1", text: "alice content" });
    await alice.close();
    alice = undefined as unknown as AgentDB;

    const textDir = join(dir, "collections", "tasks", "text");
    const files = await readdir(textDir);
    expect(files).toContain("manifest-alice.json");
    expect(files.some((f) => /^seg-alice-\d{6}\.seg$/.test(f))).toBe(true);
    expect(files).toContain("docids-alice.snap");
    expect(files).toContain("slots.json");
    // Crucially: no leftover legacy manifest.json
    expect(files).not.toContain("manifest.json");
  });

  it("legacy single-writer index auto-migrates when first opened with agentId", async () => {
    // Step 1: write a legacy single-writer index by opening WITHOUT agentId.
    const legacy = new AgentDB(dir);
    const colLegacy = await legacy.collection(tasksSchema);
    await colLegacy.insert({ _id: "legacy-1", text: "ancient text about elderberry" });
    await colLegacy.insert({ _id: "legacy-2", text: "more ancient text about elderberry" });
    await legacy.close();

    const textDir = join(dir, "collections", "tasks", "text");
    let files = await readdir(textDir);
    expect(files).toContain("manifest.json");

    // Step 2: open with agentId — should auto-migrate.
    alice = new AgentDB(dir, { agentId: "alice" });
    const colA = await alice.collection(tasksSchema);

    files = await readdir(textDir);
    expect(files).toContain("manifest-alice.json");
    expect(files).not.toContain("manifest.json");

    // Step 3: original content is searchable.
    const hits = await colA.bm25Search("elderberry");
    expect(hits.records.map((r) => r._id).sort()).toEqual(["legacy-1", "legacy-2"]);
  });

  it("docCount across the federated view sums own + external agents", async () => {
    alice = new AgentDB(dir, { agentId: "alice" });
    bob   = new AgentDB(dir, { agentId: "bob" });
    const colA = await alice.collection(tasksSchema);
    const colB = await bob.collection(tasksSchema);

    for (let i = 0; i < 4; i++) await colA.insert({ _id: `a-${i}`, text: `alice doc ${i}` });
    for (let i = 0; i < 6; i++) await colB.insert({ _id: `b-${i}`, text: `bob doc ${i}` });
    await colA.refresh();

    // Federated text-index docCount via the underlying TermLog handle.
    const idx = colA.getTextIndex();
    expect(idx).not.toBeNull();
    expect(idx!.docCount()).toBe(10);
  });
});

describe("multi-writer guard: still rejects same-agent concurrent open", () => {
  it("two AgentDB instances with the SAME agentId still throw on collection open", async () => {
    alice = new AgentDB(dir, { agentId: "alice" });
    const colA = await alice.collection(tasksSchema);
    await colA.insert({ _id: "a-1", text: "first writer wins" });

    const aliceTwo = new AgentDB(dir, { agentId: "alice" });
    await expect(aliceTwo.collection(tasksSchema)).rejects.toMatchObject({ name: "IndexLockedError" });
    // Clean up the second instance so the test teardown doesn't try to close a never-opened one.
    await aliceTwo.close().catch(() => undefined);
  });
});

describe("multi-writer: mixed-state legacy handling", () => {
  it("opens cleanly when a stale legacy manifest sits alongside per-agent manifests (silently ignored)", async () => {
    // Open as multi-writer first.
    alice = new AgentDB(dir, { agentId: "alice" });
    const colA = await alice.collection(tasksSchema);
    await colA.insert({ _id: "a-1", text: "alice's first doc with kumquat" });
    await alice.close();
    alice = undefined as unknown as AgentDB;

    // Inject a stale legacy manifest.json to simulate mixed state (e.g. a
    // half-completed manual edit). agentdb's open path treats it as orphaned —
    // per-agent manifests already exist so legacy auto-migration does NOT fire.
    const textDir = join(dir, "collections", "tasks", "text");
    await mkdir(textDir, { recursive: true });
    await writeFile(
      join(textDir, "manifest.json"),
      JSON.stringify({ version: 2, generation: 0, segments: [], tokenizer: { kind: "unicode", minLen: 1 }, totalDocs: 0, totalLen: 0 }),
    );

    // Bob opening succeeds; the leftover manifest.json is ignored.
    bob = new AgentDB(dir, { agentId: "bob" });
    const colB = await bob.collection(tasksSchema);
    // Bob still sees alice's content via the federated reader view.
    const hits = await colB.bm25Search("kumquat");
    expect(hits.records.map((r) => r._id)).toContain("a-1");
  });
});
