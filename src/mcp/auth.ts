/**
 * Authentication and authorization middleware for AgentDB HTTP transport.
 */
import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { authContext, TenantMismatchError } from "../auth-context.js";
import type { AuthIdentity } from "../auth-context.js";

export { authContext, getCurrentAuth, TenantMismatchError } from "../auth-context.js";
export type { AuthIdentity } from "../auth-context.js";

/** Token-to-identity mapping for multi-agent auth. */
export type TokenMap = Record<string, AuthIdentity>;

/** Pluggable auth function. Return identity or null (rejected). */
export type AuthFn = (req: Request) => AuthIdentity | null | Promise<AuthIdentity | null>;

/**
 * Create bearer token auth middleware.
 *
 * Modes:
 * - Single token: all requests must carry this token. Identity is "default".
 * - Token map: each token maps to a specific agent identity + permissions.
 * - Custom: user-provided auth function (JWT, OAuth, etc.)
 * - No auth: if nothing configured, middleware passes through.
 *
 * Tenant binding (`expectedTenantId`):
 *   When set, every successful auth must yield an identity whose `tenantId`
 *   matches. Singular `token` identities are implicitly bound to
 *   `expectedTenantId`; `tokens` map entries must declare `tenantId`
 *   explicitly (entries lacking it fail closed). The `authFn` path is
 *   responsible for its own enforcement and signals tenant-binding failures
 *   by throwing `TenantMismatchError` (so the audit logger emits a distinct
 *   `tenant_mismatch` event rather than a generic auth failure).
 */
export function createAuthMiddleware(opts: {
  token?: string;
  tokens?: TokenMap;
  authFn?: AuthFn;
  expectedTenantId?: string;
  /** Audit logger for `tenant_mismatch` security events (optional). */
  auditLog?: AuditLogger;
}): (req: Request, res: Response, next: NextFunction) => void {
  // No auth configured — pass through
  if (!opts.token && !opts.tokens && !opts.authFn) {
    return (_req, _res, next) => next();
  }

  const expectedTenantId = opts.expectedTenantId;

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      let identity: AuthIdentity | null = null;

      if (opts.authFn) {
        try {
          identity = await opts.authFn(req);
        } catch (err) {
          if (err instanceof TenantMismatchError) {
            opts.auditLog?.logTenantMismatch({
              method: typeof req.body?.method === "string" ? req.body.method : req.method,
              ip: req.ip,
            });
            // Generic 401 — never echo expected tenant ID to the caller.
            res.status(401).json({ error: "Invalid or expired authentication token" });
            return;
          }
          throw err;
        }
      } else {
        const header = req.headers.authorization;
        if (!header || !header.startsWith("Bearer ")) {
          res.status(401).json({ error: "Missing or invalid Authorization header. Expected: Bearer <token>" });
          return;
        }
        const token = header.slice(7);

        if (opts.tokens) {
          // Timing-safe: iterate all tokens with constant-time comparison
          const tokenBuf = Buffer.from(token);
          for (const [knownToken, id] of Object.entries(opts.tokens)) {
            const knownBuf = Buffer.from(knownToken);
            if (tokenBuf.length === knownBuf.length && timingSafeEqual(tokenBuf, knownBuf)) {
              identity = id;
              break;
            }
          }
        } else if (opts.token) {
          // Timing-safe comparison to prevent timing attacks
          const a = Buffer.from(token);
          const b = Buffer.from(opts.token);
          identity = a.length === b.length && timingSafeEqual(a, b)
            // Singular token is implicitly bound to expectedTenantId when set.
            ? { agentId: "default", tenantId: expectedTenantId }
            : null;
        }
      }

      if (!identity) {
        res.status(401).json({ error: "Invalid or expired authentication token" });
        return;
      }

      // Static-token tenant binding gate. Verified BEFORE permissions are ever
      // consulted by tool handlers: a wrong-tenant token cannot leak which
      // permissions it held. The authFn path enforces its own binding and has
      // already thrown TenantMismatchError above if it failed; this guards the
      // singular-token + tokens-map paths.
      if (expectedTenantId !== undefined && !opts.authFn) {
        if (identity.tenantId !== expectedTenantId) {
          opts.auditLog?.logTenantMismatch({
            agentId: identity.agentId,
            method: typeof req.body?.method === "string" ? req.body.method : req.method,
            ip: req.ip,
          });
          res.status(401).json({ error: "Invalid or expired authentication token" });
          return;
        }
      }

      // Attach identity to request + AsyncLocalStorage for tool handlers
      (req as AuthenticatedRequest).auth = identity;
      authContext.run(identity, () => next());
    } catch {
      res.status(500).json({ error: "Authentication error" });
    }
  };
}

/** Express request with attached auth identity. */
export interface AuthenticatedRequest extends Request {
  auth?: AuthIdentity;
}

/** Rate limiter — simple in-memory token bucket per key. */
export class RateLimiter {
  private counts = new Map<string, { count: number; resetAt: number }>();
  private maxRequests: number;
  private windowMs: number;

  constructor(maxRequests = 100, windowMs = 60000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  private lastCleanup = Date.now();

  /** Check if a request is allowed. Returns true if allowed, false if rate-limited. */
  check(key: string): boolean {
    const now = Date.now();

    // Periodic cleanup of expired entries (every 5 windows)
    if (now - this.lastCleanup > this.windowMs * 5) {
      for (const [k, v] of this.counts) {
        if (now > v.resetAt) this.counts.delete(k);
      }
      this.lastCleanup = now;
    }

    const entry = this.counts.get(key);

    if (!entry || now > entry.resetAt) {
      this.counts.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }

    if (entry.count >= this.maxRequests) {
      return false;
    }

    entry.count++;
    return true;
  }

  /** Create Express middleware. */
  middleware(): (req: Request, res: Response, next: NextFunction) => void {
    return (req: Request, res: Response, next: NextFunction) => {
      const key = (req as AuthenticatedRequest).auth?.agentId ?? req.ip ?? "unknown";
      if (!this.check(key)) {
        res.status(429).json({ error: "Rate limit exceeded. Try again later." });
        return;
      }
      next();
    };
  }
}

/** Audit logger — logs authenticated requests. */
export interface AuditEntry {
  /**
   * Monotonic cursor handle (zero-padded sequence). Lex-sortable so that
   * cursor pagination is a simple `entry.id > cursor` comparison.
   */
  id: string;
  timestamp: string;
  /** Authenticated agent. `undefined` for security events where no identity was admitted. */
  agentId?: string;
  method: string;
  tool?: string;
  ip?: string;
  /** Tenant the request was authenticated under (when binding is configured). */
  tenantId?: string;
  /**
   * MCP tool params for `tools/call` invocations. Opaque to the audit shipper.
   * Captured so downstream forensic queries can answer "what record was touched".
   */
  metadata?: Record<string, unknown>;
  /**
   * Distinguishes security events from ordinary request entries.
   * `tenant_mismatch` = a credential passed signature/aud/iss but carried the
   * wrong tenant binding (warrants alerting; signals routing bug, replay, or
   * cross-tenant credential leak). Absent for normal request entries.
   */
  event?: "tenant_mismatch";
}

export interface AuditQueryResult {
  entries: AuditEntry[];
  nextCursor: string | null;
}

/** Hard cap on a single `query()` page — matches the spec's documented max. */
export const AUDIT_MAX_LIMIT = 10000;
/** Default `query()` page size when caller omits `limit`. */
export const AUDIT_DEFAULT_LIMIT = 1000;

export class AuditLogger {
  private entries: AuditEntry[];
  private maxEntries: number;
  private head = 0;
  private count = 0;
  private nextSeq = 0;

  constructor(maxEntries = 10000) {
    this.maxEntries = maxEntries;
    this.entries = new Array(maxEntries);
  }

  /**
   * Log an entry. Caller supplies everything except `id`; the logger assigns
   * a monotonic, lex-sortable id. Returns the assigned id so callers (e.g.
   * test harnesses) can correlate.
   */
  log(entry: Omit<AuditEntry, "id">): AuditEntry {
    const id = String(++this.nextSeq).padStart(16, "0");
    const full: AuditEntry = { ...entry, id };
    this.entries[this.head] = full;
    this.head = (this.head + 1) % this.maxEntries;
    if (this.count < this.maxEntries) this.count++;
    return full;
  }

  /**
   * Record a tenant-binding failure as a distinct security event. Operators
   * alert on this — it is never expected in steady-state.
   */
  logTenantMismatch(opts: { agentId?: string; method?: string; ip?: string }): AuditEntry {
    return this.log({
      timestamp: new Date().toISOString(),
      agentId: opts.agentId,
      method: opts.method ?? "unknown",
      ip: opts.ip,
      event: "tenant_mismatch",
    });
  }

  /** Get recent entries. */
  recent(limit = 100): AuditEntry[] {
    const n = Math.min(limit, this.count);
    const result: AuditEntry[] = [];
    for (let i = 0; i < n; i++) {
      const idx = (this.head - n + i + this.maxEntries) % this.maxEntries;
      result.push(this.entries[idx]);
    }
    return result;
  }

  /**
   * Cursor-based pagination over the in-memory ring. Returns entries whose
   * id is strictly greater than `cursor` (or all entries when omitted), in
   * cursor-ascending order.
   *
   * - `limit` is capped at AUDIT_MAX_LIMIT and defaults to AUDIT_DEFAULT_LIMIT.
   * - `tenantFilter`, when set, drops entries whose `tenantId` is not equal —
   *   defence-in-depth for the bound-tenant case (the buffer should already
   *   be single-tenant when AGENTDB_TENANT_ID is set, but we filter anyway).
   * - `nextCursor` is the id of the last returned entry, or `null` when the
   *   caller has caught up to the buffer's tail.
   *
   * Callers that need entries older than the in-memory window will see them
   * silently dropped — retention beyond `maxEntries` is the control plane's
   * job (poll often enough; see docs/specs/upstream-agentdb-audit-streaming.md).
   */
  query(opts: { cursor?: string; limit?: number; tenantFilter?: string } = {}): AuditQueryResult {
    const requested = opts.limit ?? AUDIT_DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(AUDIT_MAX_LIMIT, requested));
    const cursor = opts.cursor;
    const tenantFilter = opts.tenantFilter;

    // Collect up to `limit + 1` matching entries; the extra one (if found) tells
    // us another page exists without requiring a second pass over the buffer.
    const collected: AuditEntry[] = [];
    for (let i = 0; i < this.count; i++) {
      const idx = (this.head - this.count + i + this.maxEntries) % this.maxEntries;
      const entry = this.entries[idx];
      if (cursor !== undefined && entry.id <= cursor) continue;
      if (tenantFilter !== undefined && entry.tenantId !== tenantFilter) continue;
      collected.push(entry);
      if (collected.length > limit) break;
    }

    const hasMore = collected.length > limit;
    const entries = hasMore ? collected.slice(0, limit) : collected;
    const nextCursor = hasMore ? entries[entries.length - 1].id : null;
    return { entries, nextCursor };
  }

  /** Create Express middleware that logs requests. */
  middleware(): (req: Request, res: Response, next: NextFunction) => void {
    return (req: Request, _res: Response, next: NextFunction) => {
      const auth = (req as AuthenticatedRequest).auth;
      if (auth) {
        // Extract tool name from MCP request body
        let tool: string | undefined;
        let metadata: Record<string, unknown> | undefined;
        if (req.body?.method === "tools/call") {
          tool = req.body?.params?.name;
          const args = req.body?.params?.arguments;
          if (args && typeof args === "object") {
            metadata = args as Record<string, unknown>;
          }
        }

        this.log({
          timestamp: new Date().toISOString(),
          agentId: auth.agentId,
          method: req.body?.method ?? req.method,
          tool,
          ip: req.ip,
          tenantId: auth.tenantId,
          metadata,
        });
      }
      next();
    };
  }
}
