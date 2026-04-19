/**
 * JWT authentication for AgentDB.
 * Validates JWTs as bearer tokens, extracts agent identity from claims.
 * Uses jose library (pure JS, zero native deps).
 */
import { jwtVerify, createRemoteJWKSet } from "jose";
import type { JWTPayload } from "jose";
import type { Request } from "express";
import type { AuthFn, AuthIdentity } from "./auth.js";
import { TenantMismatchError } from "../auth-context.js";

export interface JwtAuthOptions {
  /** JWKS endpoint URL for key rotation (e.g. https://auth0.com/.well-known/jwks.json). */
  jwksUrl?: string;
  /** Static secret string for HMAC verification (alternative to JWKS). */
  secret?: string;
  /** Expected audience claim. Rejects tokens not intended for this server. */
  audience?: string;
  /** Expected issuer claim. */
  issuer?: string;
  /** JWT claim to use as agent ID (default: "sub"). */
  agentIdClaim?: string;
  /** JWT claim for permissions (default: "permissions"). */
  permissionsClaim?: string;
  /**
   * Claim whose string value must equal `expectedTenantId`. Default: `"tid"`
   * (Azure AD convention; short wire format). Override for callers using
   * `tenant_id`, `org_id`, etc. Only consulted when `expectedTenantId` is set.
   */
  tenantIdClaim?: string;
  /**
   * Tenant ID this process is bound to (typically `process.env.AGENTDB_TENANT_ID`).
   * When set, JWTs without a string-typed `tenantIdClaim` matching this value
   * are rejected with `TenantMismatchError` AFTER signature/aud/iss pass —
   * letting the middleware emit a distinct `tenant_mismatch` audit event
   * separate from generic auth failures.
   */
  expectedTenantId?: string;
}

/**
 * Create a JWT-based auth function for use with createAuthMiddleware.
 *
 * Usage:
 * ```typescript
 * startHttp(dir, {
 *   authFn: createJwtAuth({
 *     jwksUrl: "https://your-auth-server/.well-known/jwks.json",
 *     audience: "agentdb",
 *     issuer: "https://your-auth-server",
 *   }),
 * });
 * ```
 */
export function createJwtAuth(opts: JwtAuthOptions): AuthFn {
  let keySource: Uint8Array | ReturnType<typeof createRemoteJWKSet>;

  if (opts.jwksUrl) {
    keySource = createRemoteJWKSet(new URL(opts.jwksUrl));
  } else if (opts.secret) {
    keySource = new TextEncoder().encode(opts.secret);
  } else {
    throw new Error("JWT auth requires either jwksUrl or secret");
  }

  const agentIdClaim = opts.agentIdClaim ?? "sub";
  const permissionsClaim = opts.permissionsClaim ?? "permissions";
  const tenantIdClaim = opts.tenantIdClaim ?? "tid";
  const expectedTenantId = opts.expectedTenantId;

  return async (req: Request): Promise<AuthIdentity | null> => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) return null;

    const token = header.slice(7);

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, keySource as Uint8Array, {
        audience: opts.audience,
        issuer: opts.issuer,
      }));
    } catch {
      return null; // Bad signature / aud / iss / expired — generic failure
    }

    const agentId = extractClaim(payload, agentIdClaim);
    if (!agentId) return null;

    // Tenant binding is verified BEFORE permissions extraction so a wrong-tenant
    // token cannot leak which permissions it held via timing or differential
    // responses. Throws (not returns null) so the middleware can distinguish
    // tenant_mismatch from generic auth failures in the audit log.
    let tenantId: string | undefined;
    if (expectedTenantId !== undefined) {
      tenantId = extractClaim(payload, tenantIdClaim);
      if (tenantId === undefined || tenantId !== expectedTenantId) {
        throw new TenantMismatchError();
      }
    }

    const permissions = extractPermissions(payload, permissionsClaim);

    return { agentId, tenantId, permissions };
  };
}

function extractClaim(payload: JWTPayload, claim: string): string | undefined {
  const value = payload[claim];
  if (typeof value === "string") return value;
  return undefined;
}

function extractPermissions(
  payload: JWTPayload,
  claim: string,
): { read?: boolean; write?: boolean; admin?: boolean } | undefined {
  const value = payload[claim];
  if (typeof value !== "object" || value === null) return undefined;
  const perms = value as Record<string, unknown>;
  return {
    read: perms.read === true ? true : undefined,
    write: perms.write === true ? true : undefined,
    admin: perms.admin === true ? true : undefined,
  };
}
