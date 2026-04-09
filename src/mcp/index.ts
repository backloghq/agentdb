import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import express from "express";
import { AgentDB } from "../agentdb.js";
import { getTools } from "../tools/index.js";
import type { AgentDBOptions } from "../agentdb.js";

export { McpServer, StdioServerTransport, StreamableHTTPServerTransport };

/**
 * Create an MCP server that exposes all AgentDB tools.
 * Returns the server instance (not yet connected to a transport).
 */
export function createMcpServer(db: AgentDB): McpServer {
  const server = new McpServer(
    { name: "agentdb", version: "0.1.0" },
    { instructions: "AgentDB — AI-first embedded database. Use db_collections to discover data, db_find with filters to query, db_schema to inspect record shapes." },
  );

  const tools = getTools(db);

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.schema as z.ZodObject<z.ZodRawShape>,
        annotations: {
          readOnlyHint: tool.annotations.readOnly,
          destructiveHint: tool.annotations.destructive,
          idempotentHint: tool.annotations.idempotent,
        },
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
export async function startHttp(
  dataDir: string,
  opts?: { port?: number; host?: string; dbOpts?: AgentDBOptions },
): Promise<{ app: express.Express; close: () => Promise<void> }> {
  const port = opts?.port ?? 3000;
  const host = opts?.host ?? "127.0.0.1";

  const db = new AgentDB(dataDir, opts?.dbOpts);
  await db.init();

  const app = express();
  app.use(express.json());

  // Session management: one transport per client session
  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && transports.has(sessionId)) {
      // Existing session
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res, req.body);
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // New session
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, transport);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
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

  const httpServer = app.listen(port, host);

  const close = async () => {
    for (const transport of transports.values()) {
      await transport.close();
    }
    transports.clear();
    httpServer.close();
    await db.close();
  };

  process.on("SIGINT", async () => { await close(); process.exit(0); });
  process.on("SIGTERM", async () => { await close(); process.exit(0); });

  return { app, close };
}
