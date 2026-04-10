/**
 * AgentDB MCP client — wraps @modelcontextprotocol/sdk Client
 * with convenience methods for tool calls and change notifications.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

export class AgentDBClient {
  private client: Client;
  private transport: StreamableHTTPClientTransport;
  private onChangeCallback: ((data: Record<string, unknown>) => void) | null = null;

  constructor(url: string, token: string) {
    this.client = new Client(
      { name: "agentdb-agent", version: "1.0" },
      { capabilities: {} },
    );
    this.transport = new StreamableHTTPClientTransport(
      new URL(url),
      { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
    );
  }

  /** Connect to the AgentDB MCP server. */
  async connect(): Promise<void> {
    // Set up notification handler BEFORE connecting
    this.client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
      if (this.onChangeCallback && notification.params?.data) {
        const data = notification.params.data;
        const str = typeof data === "string" ? data : JSON.stringify(data);
        try {
          this.onChangeCallback(JSON.parse(str));
        } catch {
          // Not JSON, ignore
        }
      }
    });

    await this.client.connect(this.transport);
  }

  /** Subscribe to a collection and receive change notifications. */
  async subscribe(collection: string, callback: (event: Record<string, unknown>) => void): Promise<void> {
    this.onChangeCallback = callback;
    await this.callTool("db_subscribe", { collection });
  }

  /** Call an AgentDB tool and return the parsed result. */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const result = await this.client.callTool({ name, arguments: args });

    if (result.isError) {
      const msg = result.content?.map((c: { text?: string }) => c.text).join("") || "Tool error";
      throw new Error(`${name}: ${msg}`);
    }

    // Parse structured content or text
    if (result.structuredContent) return result.structuredContent;
    const text = result.content
      ?.filter((c: { type: string }) => c.type === "text")
      .map((c: { text?: string }) => c.text)
      .join("");
    if (text) {
      try { return JSON.parse(text); } catch { return text; }
    }
    return result;
  }

  /** Disconnect gracefully. */
  async disconnect(): Promise<void> {
    await this.client.close();
  }
}
