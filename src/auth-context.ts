/**
 * Shared auth identity context.
 * Lives in core (not mcp/) so tools can import without pulling in express.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** Authenticated agent identity. */
export interface AuthIdentity {
  agentId: string;
  permissions?: { read?: boolean; write?: boolean; admin?: boolean };
}

/** AsyncLocalStorage for propagating auth identity to tool handlers. */
export const authContext = new AsyncLocalStorage<AuthIdentity>();

/** Get the current request's authenticated identity (if any). */
export function getCurrentAuth(): AuthIdentity | undefined {
  return authContext.getStore();
}
