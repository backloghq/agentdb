import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

// Mock node:fs/promises so rename can be made to fail for this test.
// All functions delegate to real implementations by default.
vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

import * as fsPromises from "node:fs/promises";
import { AgentDB } from "../../src/agentdb.js";

describe("persistSchema — rename failure cleanup", () => {
  let tmpDir: string;
  let db: AgentDB;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agentdb-persist-fail-"));
    db = new AgentDB(tmpDir);
    await db.init();
    vi.mocked(fsPromises.rename).mockClear();
  });

  afterEach(async () => {
    await db.close();
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
    vi.mocked(fsPromises.rename).mockClear();
  });

  it("cleans up tmp file and rethrows original error when rename fails", async () => {
    const renameError = new Error("EXDEV: cross-device link not permitted, rename");
    vi.mocked(fsPromises.rename).mockRejectedValueOnce(renameError);

    await expect(
      db.persistSchema("cleanup-test", { name: "cleanup-test", version: 1 })
    ).rejects.toThrow("EXDEV: cross-device link not permitted");

    // No .tmp files should remain — rm({force:true}) in the catch block cleaned up
    const metaDir = join(tmpDir, "meta");
    const files = await fsPromises.readdir(metaDir);
    expect(files.filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
  });
});
