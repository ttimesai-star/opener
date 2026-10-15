// Direct Qloo Insights call for the one parameter the harness does not expose.
// `qloo mcp` (harness 0.1.26) validates qloo_recommend with
// additionalProperties: false and has no popularity filter, while /v2/insights
// documents filter.popularity.min/max for artists (docs.qloo.com/reference/parameters,
// checked 2026-10-15; live, Radiohead/Berlin with max 0.9966 returned 20 acts,
// none in the top 0.34%). Everything else still goes through the harness.

import type { QlooEnvelope, QlooRequestRecord } from "./types.ts";

export const INSIGHTS_PATH = "/v2/insights";
export const INSIGHTS_DOCS = "https://docs.qloo.com/reference/parameters";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Query parameters for an artist recommendation with a popularity ceiling (no key: it goes in a header). */
export function insightsQuery(args: Record<string, unknown>): Record<string, string> | { error: string } {
  const max = args.popularity_max;
  if (typeof max !== "number" || !Number.isFinite(max) || max <= 0 || max >= 1) return { error: "popularity_max must be a number between 0 and 1" };
  if (args.target_type !== "artist") return { error: "the popularity ceiling is only used for artists" };
  const signals = Array.isArray(args.signals) ? args.signals.filter((s): s is string => typeof s === "string" && UUID.test(s.trim())) : [];
  if (signals.length === 0) return { error: "needs the headliner's Qloo entity id as the signal (qloo_describe did not resolve it)" };
  const limit = Math.max(1, Math.min(20, Math.trunc(Number(args.limit) || 20)));
  const q: Record<string, string> = {
    "filter.type": "urn:entity:artist",
    "signal.interests.entities": signals.map((s) => s.trim()).join(","),
    "filter.popularity.max": String(max),
    take: String(limit),
  };
  if (typeof args.signal_location === "string" && args.signal_location.trim()) q["signal.location.query"] = args.signal_location.trim();
  return q;
}

function errorEnvelope(code: string, summary: string, retryable: boolean, request?: QlooRequestRecord): QlooEnvelope {
  return {
    operation: "recommend",
    status: "error",
    results: [],
    summary,
    error: { code, layer: "insights", retryable, recovery: "The agent falls back to the next popularity ceiling or to the harness recommendation." },
    provenance: { source: "Qloo Insights API", endpoint: INSIGHTS_PATH, documentation: INSIGHTS_DOCS, ...(request ? { requests: [request] } : {}) },
  };
}

export interface InsightsOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** qloo_recommend (artist) with filter.popularity.max, as a harness-shaped envelope. */
export async function recommendWithPopularityCeiling(args: Record<string, unknown>, opts: InsightsOptions): Promise<QlooEnvelope> {
  const q = insightsQuery(args);
  if ("error" in q) return errorEnvelope("INVALID_INPUT", `Not sent: ${q.error}.`, false);
  // The key goes in a header: never to a non-HTTPS host, never with an empty key.
  if (!/^https:\/\//i.test(opts.baseUrl)) return errorEnvelope("INVALID_CONFIG", "Not sent: QLOO_BASE_URL is not an https URL.", false);
  if (!opts.apiKey.trim()) return errorEnvelope("INVALID_CONFIG", "Not sent: no Qloo API key.", false);
  const request: QlooRequestRecord = { method: "GET", path: INSIGHTS_PATH, query: q };
  const url = `${opts.baseUrl.replace(/\/+$/, "")}${INSIGHTS_PATH}?${new URLSearchParams(q).toString()}`;
  const started = Date.now();
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(url, {
      headers: { "X-Api-Key": opts.apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
  } catch (error) {
    return errorEnvelope("NETWORK", `Qloo Insights request failed: ${(error as Error).message.split("\n")[0]}`, true, request);
  }
  if (!res.ok) {
    // 429 keeps the agent's rate-limit backoff working the same as for harness calls.
    const code = res.status === 429 ? "QLOO_RATE_LIMIT" : `HTTP_${res.status}`;
    return errorEnvelope(code, `Qloo Insights answered HTTP ${res.status}.`, res.status === 429 || res.status >= 500, request);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return errorEnvelope("BAD_RESPONSE", "Qloo Insights returned a body that is not JSON.", false, request);
  }
  const results = (body as { results?: { entities?: unknown } } | null)?.results;
  const entities = Array.isArray(results?.entities) ? results.entities : [];
  return {
    operation: "recommend",
    status: entities.length > 0 ? "ok" : "empty",
    summary: `${entities.length} artist(s) with Qloo popularity at most ${q["filter.popularity.max"]} (filter.popularity.max, ${INSIGHTS_PATH}).`,
    results: { entities },
    result_count: entities.length,
    execution: { transport: "https", transport_name: "qloo-insights", correlation_id: `insights-${started}`, duration_ms: Date.now() - started },
    provenance: { source: "Qloo Insights API", endpoint: INSIGHTS_PATH, documentation: INSIGHTS_DOCS, requests: [request] },
  };
}
