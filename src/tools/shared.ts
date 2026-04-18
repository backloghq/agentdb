import { z } from "zod";
import type { AgentDB } from "../agentdb.js";
import { getCurrentAuth } from "../auth-context.js";

/** A framework-agnostic tool definition. */
export interface AgentTool {
  name: string;
  title: string;
  description: string;
  schema: z.ZodType;
  outputSchema?: z.ZodType;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  execute: (args: unknown) => Promise<ToolResult>;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Shared note appended to descriptions. */
export const API_NOTE = " Permissions enforced based on agent identity.";

/** Standard annotation sets. */
export const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
export const WRITE_IDEMPOTENT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

/** Derive permission level from tool annotations. */
function permLevelFromAnnotations(annotations: { readOnlyHint?: boolean; destructiveHint?: boolean }): "read" | "write" | "admin" {
  if (annotations.destructiveHint) return "admin";
  if (annotations.readOnlyHint) return "read";
  return "write";
}

/** Wrap a handler in error handling, permission checking, and structured output. */
export function makeSafe(db: AgentDB, toolName: string, annotations: { readOnlyHint?: boolean; destructiveHint?: boolean }) {
  const level = permLevelFromAnnotations(annotations);
  return (fn: (args: Record<string, unknown>) => Promise<unknown>): (args: unknown) => Promise<ToolResult> => {
    return async (args) => {
      try {
        // Resolve agent identity: authenticated identity wins over self-reported args.agent.
        // Mutate args.agent so all tool handlers see the resolved identity without per-tool code.
        const authId = getCurrentAuth();
        const typedArgs = args as Record<string, unknown>;
        const agent = authId?.agentId ?? typedArgs.agent as string | undefined;
        typedArgs.agent = agent;
        db.getPermissions().require(agent, level, toolName);
        const result = await fn(typedArgs);
        const structured = result as Record<string, unknown>;
        return {
          content: [{ type: "text" as const, text: JSON.stringify(structured, null, 2) }],
          structuredContent: structured,
        };
      } catch (err) {
        let message = err instanceof Error ? err.message : String(err);
        // Sanitize filesystem paths from error messages
        message = message.replace(/\/[^\s'":]+\//g, "<path>/");
        return { isError: true, content: [{ type: "text" as const, text: message }] };
      }
    };
  };
}

// --- Shared schemas ---

export const collectionParam = z.string().meta({ description: "Collection name" });

export const filterParam = z
  .union([z.record(z.string(), z.unknown()), z.string()])
  .optional()
  .meta({ description: "Filter: JSON object ({role: 'admin'}) or compact string ('role:admin age.gt:18')" });

export const mutationOpts = {
  agent: z.string().optional().meta({ description: "Agent identity — who is making this change" }),
  reason: z.string().optional().meta({ description: "Why this change is being made" }),
};
