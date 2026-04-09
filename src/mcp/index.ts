import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import express from "express";
import { AgentDB } from "../agentdb.js";
import { VERSION } from "../index.js";
import { getTools } from "../tools/index.js";
import type { AgentDBOptions } from "../agentdb.js";
import { createAuthMiddleware, RateLimiter, AuditLogger } from "./auth.js";
import type { TokenMap, AuthFn } from "./auth.js";

export { createAuthMiddleware, RateLimiter, AuditLogger };
export type { TokenMap, AuthFn, AuthIdentity, AuthenticatedRequest, AuditEntry } from "./auth.js";
export { createJwtAuth } from "./jwt.js";
export type { JwtAuthOptions } from "./jwt.js";

export { McpServer, StdioServerTransport, StreamableHTTPServerTransport };

/**
 * Create an MCP server that exposes all AgentDB tools.
 * Returns the server instance (not yet connected to a transport).
 */
export function createMcpServer(db: AgentDB): McpServer {
  const server = new McpServer(
    { name: "agentdb", version: VERSION },
    { instructions: "AgentDB — AI-first embedded database. Use db_collections to discover data, db_find with filters to query, db_schema to inspect record shapes." },
  );

  const tools = getTools(db);

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.schema as z.ZodObject<z.ZodRawShape>,
        outputSchema: tool.outputSchema as z.ZodObject<z.ZodRawShape> | undefined,
        annotations: tool.annotations,
      },
      async (args) => {
        const result = await tool.execute(args);
        return { ...result };
      },
    );
  }

  return server;
}

/**
 * Start AgentDB as an MCP server on stdio (single client).
 */
export async function startStdio(dataDir: string, dbOpts?: AgentDBOptions): Promise<void> {
  const db = new AgentDB(dataDir, dbOpts);
  await db.init();

  const server = createMcpServer(db);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on("SIGINT", async () => { await db.close(); process.exit(0); });
  process.on("SIGTERM", async () => { await db.close(); process.exit(0); });
}

/**
 * Start AgentDB as an HTTP MCP server (multiple concurrent clients).
 * Uses Streamable HTTP transport with session management.
 */
export interface HttpOptions {
  port?: number;
  host?: string;
  dbOpts?: AgentDBOptions;
  /** Single bearer token for all agents. */
  authToken?: string;
  /** Multi-agent token map: token → identity + permissions. */
  authTokens?: TokenMap;
  /** Custom auth function for JWT/OAuth. */
  authFn?: AuthFn;
  /** Rate limit: max requests per window (default: 100). */
  rateLimit?: number;
  /** Rate limit window in ms (default: 60000). */
  rateLimitWindow?: number;
  /** Max request body size (default: "10mb"). */
  maxBodySize?: string;
  /** CORS allowed origins (default: none — reject cross-origin). */
  corsOrigins?: string[];
}

export async function startHttp(
  dataDir: string,
  opts?: HttpOptions,
): Promise<{ app: express.Express; close: () => Promise<void>; auditLog: AuditLogger; port: number }> {
  const port = opts?.port ?? 3000;
  const host = opts?.host ?? "127.0.0.1";

  const db = new AgentDB(dataDir, opts?.dbOpts);
  await db.init();

  const app = express();
  app.use(express.json({ limit: opts?.maxBodySize ?? "10mb" }));

  // Security headers
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Frame-Options", "DENY");
    next();
  });

  // CORS
  if (opts?.corsOrigins && opts.corsOrigins.length > 0) {
    const allowed = new Set(opts.corsOrigins);
    app.use((req, res, next) => {
      const origin = req.headers.origin;
      if (origin && allowed.has(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      }
      if (req.method === "OPTIONS") { res.status(204).end(); return; }
      next();
    });
  }

  // Auth middleware
  const authMiddleware = createAuthMiddleware({
    token: opts?.authToken,
    tokens: opts?.authTokens,
    authFn: opts?.authFn,
  });
  app.use("/mcp", authMiddleware);

  // Rate limiting
  if (opts?.rateLimit || opts?.authToken || opts?.authTokens) {
    const limiter = new RateLimiter(opts?.rateLimit ?? 100, opts?.rateLimitWindow ?? 60000);
    app.use("/mcp", limiter.middleware());
  }

  // Audit logging
  const auditLog = new AuditLogger();
  app.use("/mcp", auditLog.middleware());

  // Health check (no auth required)
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", version: VERSION });
  });


  // Session management with limits and idle timeout
  const MAX_SESSIONS = 100;
  const SESSION_IDLE_MS = 30 * 60 * 1000; // 30 minutes
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const sessionLastActive = new Map<string, number>();

  // Periodic cleanup of idle sessions
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [sid, lastActive] of sessionLastActive) {
      if (now - lastActive > SESSION_IDLE_MS) {
        const transport = transports.get(sid);
        if (transport) transport.close();
        transports.delete(sid);
        sessionLastActive.delete(sid);
      }
    }
  }, 60000); // Check every minute

  app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && transports.has(sessionId)) {
      // Existing session — touch idle timer
      sessionLastActive.set(sessionId, Date.now());
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res, req.body);
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // Check session limit
      if (transports.size >= MAX_SESSIONS) {
        res.status(503).json({ error: `Max sessions (${MAX_SESSIONS}) reached. Try again later.` });
        return;
      }
      // New session
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, transport);
          sessionLastActive.set(sid, Date.now());
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          transports.delete(transport.sessionId);
          sessionLastActive.delete(transport.sessionId);
        }
      };
      const server = createMcpServer(db);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } else {
      res.status(400).json({ error: "Invalid request: missing session ID or not an initialize request" });
    }
  });

  // GET for SSE stream (client listening for server-sent events)
  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId && transports.has(sessionId)) {
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res);
    } else {
      res.status(400).json({ error: "Invalid session" });
    }
  });

  // DELETE for session cleanup
  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId && transports.has(sessionId)) {
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res);
      transports.delete(sessionId);
    } else {
      res.status(400).json({ error: "Invalid session" });
    }
  });

  // Error handler — must be after all routes
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: "Internal server error" });
  });

  const httpServer = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const server = app.listen(port, host, () => resolve(server));
  });
  const actualPort = (httpServer.address() as { port: number })?.port ?? port;

  const close = async () => {
    clearInterval(cleanupInterval);
    for (const transport of transports.values()) {
      await transport.close();
    }
    transports.clear();
    sessionLastActive.clear();
    httpServer.close();
    await db.close();
  };

  process.on("SIGINT", async () => { await close(); process.exit(0); });
  process.on("SIGTERM", async () => { await close(); process.exit(0); });

  return { app, close, auditLog, port: actualPort };
}
