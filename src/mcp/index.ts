import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AgentDB } from "../agentdb.js";
import { getTools } from "../tools/index.js";

export { McpServer, StdioServerTransport };

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
 * Start AgentDB as an MCP server on stdio.
 * This is the main entry point for `npx agentdb --path ./data`.
 */
export async function startStdio(dataDir: string): Promise<void> {
  const db = new AgentDB(dataDir);
  await db.init();

  const server = createMcpServer(db);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Graceful shutdown
  process.on("SIGINT", async () => {
    await db.close();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await db.close();
    process.exit(0);
  });
}
