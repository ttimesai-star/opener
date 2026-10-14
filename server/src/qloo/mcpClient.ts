// Live client: starts `qloo mcp` (from @qloo/qloo-harness) as a child process
// and calls its tools over MCP stdio, as the hackathon kit's mcp-client starter
// does. The key reaches the harness only through QLOO_API_KEY in the server
// environment; it never goes to the browser or into logs.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { QlooClient, QlooEnvelope, QlooToolName } from "./types.ts";

const INSTALL_HINT = "Cannot start `qloo`. Install it with: npm install --global @qloo/qloo-harness@0.1.26";

// Hackathon keys work only against this host; the harness defaults to
// api.qloo.com (401 with a hackathon key) and refuses untrusted hosts.
export const QLOO_HACKATHON_BASE_URL = "https://hackathon.api.qloo.com";

/** Environment for the harness: hackathon endpoint by default, marked trusted. */
export function harnessEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") out[k] = v;
  const base = out.QLOO_BASE_URL?.trim() || QLOO_HACKATHON_BASE_URL;
  out.QLOO_BASE_URL = base;
  if (!out.QLOO_TRUSTED_BASE_URL?.trim()) out.QLOO_TRUSTED_BASE_URL = base;
  return out;
}

export interface McpClientOptions {
  command?: string; // default "qloo"; on Windows set QLOO_BIN=qloo.cmd
  args?: string[];
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv; // environment for the harness; default process.env
}

export class McpQlooClient implements QlooClient {
  readonly mode = "live" as const;
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  readonly command: string;
  private readonly args: string[];
  private readonly timeoutMs: number;
  private readonly env: NodeJS.ProcessEnv;

  constructor(opts: McpClientOptions = {}) {
    this.env = opts.env ?? process.env;
    this.command = opts.command ?? this.env.QLOO_BIN ?? (process.platform === "win32" ? "qloo.cmd" : "qloo");
    this.args = opts.args ?? ["mcp"];
    this.timeoutMs = opts.timeoutMs ?? 45_000;
  }

  /** Environment the harness child process starts with. */
  spawnEnv(): Record<string, string> {
    return harnessEnv(this.env);
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = (async () => {
        // The SDK forwards only a small default env; pass the full environment
        // so QLOO_API_KEY and QLOO_HOME reach the harness, plus the hackathon endpoint.
        const transport = new StdioClientTransport({
          command: this.command,
          args: this.args,
          env: this.spawnEnv(),
        });
        const client = new Client({ name: "opener", version: "0.1.0" });
        try {
          await client.connect(transport);
        } catch (error) {
          this.connecting = null;
          // Do not leave a half-started harness process behind (Jules review 2026-10-15).
          await transport.close().catch(() => {});
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

  /**
   * Starts `qloo mcp` and connects, without calling the Qloo API. The first
   * live brief otherwise paid for the spawn: 5-34 s locally on 2026-10-15.
   */
  async warmUp(): Promise<void> {
    await this.connect();
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
    // qloo_trends returns its payload under `series`; expose it as results.
    const results = raw.results ?? (Array.isArray(raw.series) ? raw.series : []);
    return { ...raw, results } as QlooEnvelope;
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.connecting = null;
    if (client) await client.close();
  }
}
