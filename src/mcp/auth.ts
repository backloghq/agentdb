/**
 * Authentication and authorization middleware for AgentDB HTTP transport.
 */
import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { authContext } from "../auth-context.js";
import type { AuthIdentity } from "../auth-context.js";

export { authContext, getCurrentAuth } from "../auth-context.js";
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
 */
export function createAuthMiddleware(opts: {
  token?: string;
  tokens?: TokenMap;
  authFn?: AuthFn;
}): (req: Request, res: Response, next: NextFunction) => void {
  // No auth configured — pass through
  if (!opts.token && !opts.tokens && !opts.authFn) {
    return (_req, _res, next) => next();
  }

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      let identity: AuthIdentity | null = null;

      if (opts.authFn) {
        identity = await opts.authFn(req);
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
            ? { agentId: "default" }
            : null;
        }
      }

      if (!identity) {
        res.status(401).json({ error: "Invalid or expired authentication token" });
        return;
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
  timestamp: string;
  agentId: string;
  method: string;
  tool?: string;
  ip?: string;
}

export class AuditLogger {
  private entries: AuditEntry[];
  private maxEntries: number;
  private head = 0;
  private count = 0;

  constructor(maxEntries = 10000) {
    this.maxEntries = maxEntries;
    this.entries = new Array(maxEntries);
  }

  log(entry: AuditEntry): void {
    this.entries[this.head] = entry;
    this.head = (this.head + 1) % this.maxEntries;
    if (this.count < this.maxEntries) this.count++;
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

  /** Create Express middleware that logs requests. */
  middleware(): (req: Request, res: Response, next: NextFunction) => void {
    return (req: Request, _res: Response, next: NextFunction) => {
      const auth = (req as AuthenticatedRequest).auth;
      if (auth) {
        // Extract tool name from MCP request body
        let tool: string | undefined;
        if (req.body?.method === "tools/call") {
          tool = req.body?.params?.name;
        }

        this.log({
          timestamp: new Date().toISOString(),
          agentId: auth.agentId,
          method: req.body?.method ?? req.method,
          tool,
          ip: req.ip,
        });
      }
      next();
    };
  }
}
