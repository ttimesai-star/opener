// Shared types for the Qloo layer. The envelope mirrors the result contract of
// `qloo mcp` from @qloo/qloo-harness 0.1.26 (schema_version "1.0-preview.1").

export type QlooStatus = "ok" | "empty" | "needs_input" | "partial" | "degraded" | "error";

export type QlooToolName =
  | "qloo_describe"
  | "qloo_recommend"
  | "qloo_rank"
  | "qloo_where_popular"
  | "qloo_compare_audiences"
  | "qloo_entity_tags"
  | "qloo_audience_demographics"
  | "qloo_trends"
  | "qloo_find_tags";

export const QLOO_TOOLS: readonly QlooToolName[] = [
  "qloo_describe",
  "qloo_recommend",
  "qloo_rank",
  "qloo_where_popular",
  "qloo_compare_audiences",
  "qloo_entity_tags",
  "qloo_audience_demographics",
  "qloo_trends",
  "qloo_find_tags",
];

export interface QlooRequestRecord {
  method: "GET";
  path: string;
  query: unknown;
}

export interface QlooEnvelope {
  schema_version?: string;
  operation: string;
  status: QlooStatus;
  summary?: string;
  interpretation?: unknown;
  results: unknown;
  result_count?: number;
  warnings?: string[];
  error?: { code: string; layer?: string; retryable: boolean; recovery: string };
  execution?: { transport: string; transport_name: string; correlation_id: string; duration_ms: number };
  provenance?: { source: string; endpoint: string; documentation: string; requests?: QlooRequestRecord[] };
  [key: string]: unknown;
}

export type QlooMode = "mock" | "live";

export interface QlooClient {
  readonly mode: QlooMode;
  call(tool: QlooToolName, args: Record<string, unknown>): Promise<QlooEnvelope>;
  close(): Promise<void>;
}

export function isQlooTool(name: string): name is QlooToolName {
  return (QLOO_TOOLS as readonly string[]).includes(name);
}
