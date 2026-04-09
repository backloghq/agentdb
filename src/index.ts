export const VERSION = "0.1.0";

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

export { TextIndex } from "./text-index.js";
export { AgentDB } from "./agentdb.js";
export type {
  AgentDBOptions,
  CollectionInfo,
} from "./agentdb.js";
