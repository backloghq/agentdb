import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@backloghq/opslog";
import { Collection } from "../src/collection.js";

describe("Blob storage", () => {
  let tmpDir: string;
  let store: Store<Record<string, unknown>>;
  let col: Collection;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agentdb-blob-"));
    store = new Store<Record<string, unknown>>();
    col = new Collection("test", store);
    await col.open(tmpDir, { checkpointThreshold: 1000 });
    await col.insert({ _id: "doc1", title: "Test" });
  });

  afterEach(async () => {
    await col.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("write and read a text blob", async () => {
    await col.writeBlob("doc1", "spec.md", "# My Spec\n\nDetails here.");
    const content = await col.readBlob("doc1", "spec.md");
    expect(content.toString("utf-8")).toBe("# My Spec\n\nDetails here.");
  });

  it("write and read a binary blob", async () => {
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await col.writeBlob("doc1", "image.png", binary);
    const content = await col.readBlob("doc1", "image.png");
    expect(Buffer.compare(content, binary)).toBe(0);
  });

  it("listBlobs returns blob names", async () => {
    await col.writeBlob("doc1", "spec.md", "content");
    await col.writeBlob("doc1", "notes.txt", "notes");
    const blobs = await col.listBlobs("doc1");
    expect(blobs).toContain("spec.md");
    expect(blobs).toContain("notes.txt");
  });

  it("deleteBlob removes the blob", async () => {
    await col.writeBlob("doc1", "temp.txt", "temp");
    await col.deleteBlob("doc1", "temp.txt");
    const blobs = await col.listBlobs("doc1");
    expect(blobs).not.toContain("temp.txt");
  });

  it("rejects invalid blob names", async () => {
    await expect(col.writeBlob("doc1", "../evil", "hack")).rejects.toThrow("Invalid blob name");
    await expect(col.writeBlob("doc1", "", "hack")).rejects.toThrow("Invalid blob name");
  });

  it("throws when record doesn't exist", async () => {
    await expect(col.writeBlob("nonexistent", "file.txt", "content")).rejects.toThrow("not found");
  });

  it("listBlobs returns empty for record with no blobs", async () => {
    const blobs = await col.listBlobs("doc1");
    expect(blobs).toEqual([]);
  });
});
