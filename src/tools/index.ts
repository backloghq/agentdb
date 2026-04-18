import type { AgentDB } from "../agentdb.js";
import type { AgentTool } from "./shared.js";
import { getAdminTools } from "./admin.js";
import { getCrudTools } from "./crud.js";
import { getSchemaTools } from "./schema.js";
import { getMigrateTools } from "./migrate.js";
import { getArchiveTools } from "./archive.js";
import { getVectorTools } from "./vector.js";
import { getBlobTools } from "./blob.js";
import { getBackupTools } from "./backup.js";

export type { AgentTool, ToolResult } from "./shared.js";

export function getTools(db: AgentDB): AgentTool[] {
  return [
    ...getAdminTools(db),
    ...getCrudTools(db),
    ...getSchemaTools(db),
    ...getMigrateTools(db),
    ...getArchiveTools(db),
    ...getVectorTools(db),
    ...getBlobTools(db),
    ...getBackupTools(db),
  ];
}
