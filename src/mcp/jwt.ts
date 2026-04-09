/**
 * JWT authentication for AgentDB.
 * Validates JWTs as bearer tokens, extracts agent identity from claims.
 * Uses jose library (pure JS, zero native deps).
 */
import { jwtVerify, createRemoteJWKSet } from "jose";
import type { JWTPayload } from "jose";
import type { Request } from "express";
import type { AuthFn, AuthIdentity } from "./auth.js";

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

  return async (req: Request): Promise<AuthIdentity | null> => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) return null;

    const token = header.slice(7);

    try {
      const { payload } = await jwtVerify(token, keySource as Uint8Array, {
        audience: opts.audience,
        issuer: opts.issuer,
      });

      const agentId = extractClaim(payload, agentIdClaim);
      if (!agentId) return null;

      const permissions = extractPermissions(payload, permissionsClaim);

      return { agentId, permissions };
    } catch {
      return null; // Invalid token
    }
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
