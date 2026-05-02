/**
 * Shared auth identity context.
 * Lives in core (not mcp/) so tools can import without pulling in express.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** Authenticated agent identity. */
export interface AuthIdentity {
  agentId: string;
  /**
   * Tenant the identity is bound to. Set when the deployment supplies a
   * tenant binding (`AGENTDB_TENANT_ID` / `--tenant-id`); auth providers must
   * reject identities whose declared tenant does not match the configured one
   * before this object is constructed. `undefined` only in unbound deployments.
   */
  tenantId?: string;
  permissions?: { read?: boolean; write?: boolean; admin?: boolean };
}

/** AsyncLocalStorage for propagating auth identity to tool handlers. */
export const authContext = new AsyncLocalStorage<AuthIdentity>();

/** Get the current request's authenticated identity (if any). */
export function getCurrentAuth(): AuthIdentity | undefined {
  return authContext.getStore();
}

/**
 * Thrown by an AuthFn when a credential passed signature/aud/iss verification
 * but carries the wrong tenant binding. Distinct from a generic auth failure
 * so the audit logger can emit a `tenant_mismatch` security event the operator
 * alerts on (signals routing bug, replay, or cross-tenant credential leak).
 */
export class TenantMismatchError extends Error {
  readonly code = "tenant_mismatch" as const;
  constructor(message = "Tenant binding violation") {
    super(message);
    this.name = "TenantMismatchError";
  }
}
