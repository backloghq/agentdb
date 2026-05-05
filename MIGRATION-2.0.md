# Migrating to AgentDB v2.0

## What changed

v2.0 replaces the in-house `TextIndex` JSON blob (`indexes/text-index.json`) with [`@backloghq/termlog`](https://github.com/backloghq/termlog) — a segment-based LSM full-text index. The BM25 scoring algorithm, `k1`/`b` tuning, and all search APIs (`bm25Search`, `hybridSearch`, `search`, `$text` filter) are unchanged.

## Breaking changes

- `IndexFileTooLargeError` and `DiskStore.MAX_INDEX_FILE_SIZE` are removed from the package exports. Code that caught `IndexFileTooLargeError` should be updated — this error can no longer be thrown.
- `TextIndex` and `TextIndexOpts` are removed. Do not instantiate or import these directly.
- Collections with an existing v1.4 text index (`indexes/text-index.json`) require a one-time rebuild before they can be opened with `textSearch: true`.

## Detecting and rebuilding legacy indexes

When `Collection.open()` detects a v1.4 blob without a termlog manifest, it throws `LegacyTextIndexError`:

```typescript
import { AgentDB, LegacyTextIndexError, defineSchema } from "@backloghq/agentdb";

const schema = defineSchema({ name: "notes", textSearch: true, fields: { ... } });
const db = new AgentDB("./data");
await db.init();

let col;
try {
  col = await db.collection(schema);
} catch (e) {
  if (e instanceof LegacyTextIndexError) {
    // Rebuild: wipes old index, re-indexes all records, deletes legacy blob
    const count = await db.rebuildTextIndex("notes");
    console.log(`Rebuilt ${count} docs`);
    // Reopen with textSearch enabled
    col = await db.collection(schema);
  } else {
    throw e;
  }
}
```

`LegacyTextIndexError` has a `legacyPath` property pointing at the old file. If both the legacy blob and a termlog manifest exist (e.g. after a partial migration), the legacy blob is deleted silently and open proceeds normally.

## Via MCP tool (no code change required)

```json
{ "name": "db_rebuild_text_index", "arguments": { "collection": "notes" } }
```

Returns `{ rebuiltDocCount: N }`. Requires admin permission (`READ_WRITE_ADMIN` or equivalent).

## New capabilities in v2.0

### No per-collection document cap

The 256 MB safety cap (~25–30K document ceiling) is gone. termlog uses an LSM segment structure — writes append to a small active segment; background compaction merges segments. There is no in-memory blob that grows with corpus size.

### S3-backed text indexes

Install the optional peer dependency:

```bash
npm install @backloghq/termlog-s3
```

When agentdb is configured with an S3 opslog backend, text indexes are automatically stored in S3 under `<prefix>/<collection>/text/`. No additional configuration is required.

Single-writer constraint applies: only one agentdb process may write to a given `(bucket, prefix)` at a time. For multi-process deployments, use the HTTP MCP server as a single-writer proxy.

### BM25 score stability across close/reopen

v1.4 had a WAL replay bug where reopening a collection doubled `totalDocs` and `totalLen` in the termlog manifest, shifting BM25 IDF scores for boundary documents. This is fixed in v2.0: agentdb detects that the termlog already has indexed documents on open and skips the WAL replay into the text index.

## Dependency versions

```json
{
  "dependencies": {
    "@backloghq/opslog": "^0.8.1",
    "@backloghq/termlog": "^0.1.2"
  },
  "optionalDependencies": {
    "@backloghq/opslog-s3": "^0.4.1"
  },
  "peerDependencies": {
    "@backloghq/termlog-s3": "^0.1.0"
  }
}
```
