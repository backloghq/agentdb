/**
 * Authentication and authorization middleware for AgentDB HTTP transport.
 */
import type { Request, Response, NextFunction } from "express";

/** Authenticated agent identity. */
export interface AuthIdentity {
  agentId: string;
  permissions?: { read?: boolean; write?: boolean; admin?: boolean };
}

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
          identity = opts.tokens[token] ?? null;
        } else if (opts.token) {
          identity = token === opts.token ? { agentId: "default" } : null;
        }
      }

      if (!identity) {
        res.status(401).json({ error: "Invalid or expired authentication token" });
        return;
      }

      // Attach identity to request for downstream use
      (req as AuthenticatedRequest).auth = identity;
      next();
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

  /** Check if a request is allowed. Returns true if allowed, false if rate-limited. */
  check(key: string): boolean {
    const now = Date.now();
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
  private entries: AuditEntry[] = [];
  private maxEntries: number;

  constructor(maxEntries = 10000) {
    this.maxEntries = maxEntries;
  }

  log(entry: AuditEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
  }

  /** Get recent entries. */
  recent(limit = 100): AuditEntry[] {
    return this.entries.slice(-limit);
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
