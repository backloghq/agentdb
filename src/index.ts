import pkg from "../package.json" with { type: "json" };
export const VERSION = pkg.version;

export { defineSchema, extractPersistedSchema, validatePersistedSchema, mergeSchemas, mergePersistedSchemas, loadSchemaFromJSON, exportSchemaToJSON } from "./schema.js";
export type { SchemaDefinition, CollectionSchema, FieldDef, FieldType, SchemaHooks, PersistedSchema, PersistedFieldDef, MergeResult } from "./schema.js";
export { compileFilter } from "./filter.js";
export type { Predicate } from "./filter.js";

export { parseCompactFilter } from "./compact-filter.js";

export { Collection } from "./collection.js";
export type {
  Filter,
  CollectionOptions,
  MutationOpts,
  FindOpts,
  FindResult,
  UpdateOps,
  FieldInfo,
} from "./collection.js";

export { RecordCache } from "./record-cache.js";
export { IndexFileTooLargeError } from "./disk-store.js";
export type { CacheStats } from "./record-cache.js";
export { ArrayIndex } from "./array-index.js";
export { TextIndex } from "./text-index.js";
export type { TextIndexOpts } from "./text-index.js";
export { rrf } from "./rrf.js";
export type { RankedItem, RRFOptions } from "./rrf.js";
export type { ViewDefinition } from "./view.js";
export { PermissionManager } from "./permissions.js";
export type { AgentPermissions } from "./permissions.js";
export { FsBackend, LamportClock } from "@backloghq/opslog";
export type { StorageBackend, LockHandle } from "@backloghq/opslog";
// S3Backend is optional — dynamically imported to avoid hard dependency on @backloghq/opslog-s3
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadS3Backend(): Promise<any> {
  return import("@backloghq/opslog-s3");
}
export { AgentDB } from "./agentdb.js";
export { resolveProvider, OpenAIEmbeddingProvider, HttpEmbeddingProvider, OllamaEmbeddingProvider, VoyageEmbeddingProvider, CohereEmbeddingProvider, GeminiEmbeddingProvider } from "./embeddings/index.js";
export type { EmbeddingProvider, EmbeddingConfig } from "./embeddings/index.js";
export type {
  AgentDBOptions,
  CollectionInfo,
  ExportData,
  SchemaLoadResult,
} from "./agentdb.js";
