// Live client: starts `qloo mcp` (from @qloo/qloo-harness) as a child process
// and calls its tools over MCP stdio, as the hackathon kit's mcp-client starter
// does. The key reaches the harness only through QLOO_API_KEY in the server
// environment; it never goes to the browser or into logs.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { QlooClient, QlooEnvelope, QlooToolName } from "./types.ts";

const INSTALL_HINT = "Cannot start `qloo`. Install it with: npm install --global @qloo/qloo-harness@0.1.26";

export interface McpClientOptions {
  command?: string; // default "qloo"; on Windows set QLOO_BIN=qloo.cmd
  args?: string[];
  timeoutMs?: number;
}

export class McpQlooClient implements QlooClient {
  readonly mode = "live" as const;
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  private readonly command: string;
  private readonly args: string[];
  private readonly timeoutMs: number;

  constructor(opts: McpClientOptions = {}) {
    this.command = opts.command ?? process.env.QLOO_BIN ?? "qloo";
    this.args = opts.args ?? ["mcp"];
    this.timeoutMs = opts.timeoutMs ?? 45_000;
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = (async () => {
        // The SDK forwards only a small default env; pass the full environment
        // so QLOO_API_KEY and QLOO_HOME reach the harness.
        const transport = new StdioClientTransport({
          command: this.command,
          args: this.args,
          env: process.env as Record<string, string>,
        });
        const client = new Client({ name: "opener", version: "0.1.0" });
        try {
          await client.connect(transport);
        } catch (error) {
          this.connecting = null;
          const code = (error as { code?: string }).code;
          throw code === "ENOENT" ? new Error(INSTALL_HINT) : error;
        }
        transport.onclose = () => {
          this.client = null;
          this.connecting = null;
        };
        this.client = client;
        return client;
      })();
    }
    return this.connecting;
  }

  async call(tool: QlooToolName, args: Record<string, unknown>): Promise<QlooEnvelope> {
    const client = await this.connect();
    const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: this.timeoutMs });
    const raw = (result.structuredContent ?? {}) as Partial<QlooEnvelope>;
    if (raw.status === undefined) {
      // Same defensive normalization as the kit's backend.mjs.
      return {
        ...raw,
        operation: raw.operation ?? tool,
        status: "error",
        results: [],
        error: { code: "UNKNOWN", retryable: false, recovery: "The tool returned no structured result.", ...raw.error },
      };
    }
    return { results: [], ...raw } as QlooEnvelope;
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.connecting = null;
    if (client) await client.close();
  }
}
