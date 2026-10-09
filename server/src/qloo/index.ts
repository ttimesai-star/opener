import { MockQlooClient } from "./mockClient.ts";
import type { QlooClient } from "./types.ts";

export * from "./types.ts";
export { MockQlooClient } from "./mockClient.ts";

/**
 * Picks the Qloo client from the environment.
 * - QLOO_MODE=mock forces the mock (CI, offline demo).
 * - QLOO_API_KEY set -> live client over `qloo mcp`.
 * - otherwise mock.
 * The live module is imported lazily so the mock path has no MCP dependency at runtime.
 */
export async function createQlooClient(env: NodeJS.ProcessEnv = process.env): Promise<QlooClient> {
  if (env.QLOO_MODE === "mock" || !env.QLOO_API_KEY) return new MockQlooClient({ latencyMs: Number(env.MOCK_LATENCY_MS) || 0 });
  const { McpQlooClient } = await import("./mcpClient.ts");
  return new McpQlooClient();
}
