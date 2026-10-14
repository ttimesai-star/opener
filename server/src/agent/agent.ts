// The Opener agent: an LLM chooses Qloo tool calls; the scripted planner then
// fills any evidence the LLM skipped; the brief is assembled from evidence.
// Every Qloo and LLM call is reported through onEvent as it starts and ends,
// which the server streams to the page.

import { isQlooTool, type QlooClient, type QlooEnvelope, type QlooToolName } from "../qloo/types.ts";
import { buildBrief, trendNote } from "./brief.ts";
import type { ChatMessage, ChatResult, Llm, ToolSpec } from "./llm.ts";
import { isoDaysAgo, kindOf, nextPlannedStep, TREND_POINTS, TREND_QUERY_DAYS, withPartnerFilter } from "./planner.ts";
import { sanitizeSecrets } from "./redact.ts";
import { TOOL_SPECS } from "./toolSpecs.ts";
import type { AgentEvent, Brief, BriefInput, EvidenceItem, LlmCall, TraceStep } from "./types.ts";

export interface RunOptions {
  input: BriefInput;
  qloo: QlooClient;
  llm?: Llm | null;
  maxLlmTurns?: number;
  maxToolCalls?: number;
  today?: Date;
  onStep?: (step: TraceStep) => void;
  onEvent?: (event: AgentEvent) => void;
  /** Waits between Qloo rate-limit retries; injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** Waits before each retry of a rate-limited Qloo call (the harness already retried briefly). */
export const QLOO_RATE_LIMIT_BACKOFF_MS: readonly number[] = [2000, 6000];
/** The LLM may call one evidence kind at most this often per run (one retry), and once per turn. */
export const MAX_LLM_CALLS_PER_KIND = 2;

function isRateLimited(envelope: QlooEnvelope): boolean {
  return envelope.status === "error" && (envelope.error?.code === "QLOO_RATE_LIMIT" || /\b429\b|rate[- ]limit/i.test(`${envelope.summary ?? ""} ${envelope.error?.recovery ?? ""}`));
}

/** Stable key for "the same call": tool plus arguments with sorted keys. */
function callKey(tool: string, args: Record<string, unknown>): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])])) : v;
  return `${tool}:${JSON.stringify(sort(args))}`;
}

const ALLOWED = new Set(TOOL_SPECS.map((t) => t.function.name));

export function systemPrompt(input: BriefInput, today: Date): string {
  const window = `start_date=${isoDaysAgo(TREND_QUERY_DAYS, today)}, end_date=${isoDaysAgo(1, today)}, limit=${TREND_POINTS}`;
  const common = [
    "Call Qloo tools; do not answer from your own knowledge.",
    "In signals, pass the entity_id returned by qloo_describe, not the bare name (live Qloo treats bare names as ambiguous).",
    "If a result has status needs_input, retry with a more specific name or the entity_id once, then move on.",
    "Never infer health, politics, finances or anything about individuals. When done, reply with the single word DONE.",
  ];
  if (input.scenario === "venue") {
    return [
      "You are Opener, a booking research agent for venues.",
      "Goal: gather Qloo evidence on which artists this venue should book for a free date, based on the taste of the crowd that likes the venue and on 90-day trends.",
      "Required evidence, in this order:",
      "1) qloo_describe the venue (type place).",
      "2) qloo_recommend target_type=artist, signals=[venue], signal_location=city, limit 12.",
      "3) qloo_rank the recommended artists with option_type=artist, signals=[venue], signal_location=city.",
      `4) qloo_trends for the top 5 ranked artists, entity_type=artist, ${window}.`,
      "5) qloo_where_popular for the top ranked artist within the city.",
      "6) qloo_audience_demographics for the venue (entity_type place).",
      "7) qloo_recommend target_type=place with filter_location=city; 8) qloo_recommend target_type=brand; 9) qloo_entity_tags for the top 3 ranked artists (entity_type artist), limit 20.",
      ...common,
    ].join("\n");
  }
  return [
    "You are Opener, a booking research agent for concert promoters and venues.",
    "Goal: gather Qloo evidence for a brief on who should open for the headliner in the given city.",
    "Required evidence, in this order:",
    "1) qloo_describe the headliner (type artist).",
    "2) qloo_recommend target_type=artist, signals=[headliner], signal_location=city, limit 12.",
    "3) qloo_rank the recommended artists (excluding the headliner) with option_type=artist, signals=[headliner], signal_location=city.",
    `4) qloo_trends for the headliner plus the top 4 ranked artists, entity_type=artist, ${window}.`,
    "5) qloo_where_popular for the headliner within the city.",
    "6) qloo_audience_demographics for the headliner.",
    "7) qloo_recommend target_type=place with filter_location=city; 8) qloo_recommend target_type=brand; 9) qloo_entity_tags for the headliner, limit 20.",
    ...common,
  ].join("\n");
}

function userMessage(input: BriefInput): string {
  return input.scenario === "venue"
    ? JSON.stringify({ venue: input.venue, city: input.city, free_date: input.date ?? null, capacity: input.capacity ?? null })
    : JSON.stringify({ headliner: input.headliner, city: input.city, capacity: input.capacity ?? null, show_window: [input.dateFrom ?? null, input.dateTo ?? null] });
}

function compact(envelope: QlooEnvelope, max = 1800): string {
  const slim = { status: envelope.status, summary: envelope.summary, results: envelope.results, error: envelope.error, warnings: envelope.warnings };
  // Tool results go to a third-party LLM; never send it the Qloo key.
  const text = sanitizeSecrets(JSON.stringify(slim));
  return text.length > max ? `${text.slice(0, max)}...[truncated]` : text;
}

/** Keeps listener bugs (e.g. a closed socket) from breaking the agent run. */
function safeEmit(fn: ((e: AgentEvent) => void) | undefined, event: AgentEvent): void {
  try {
    fn?.(event);
  } catch (error) {
    console.warn(`agent event listener failed: ${(error as Error).message}`);
  }
}

export async function runAgent(opts: RunOptions): Promise<Brief> {
  const { input, qloo } = opts;
  const today = opts.today ?? new Date();
  const maxToolCalls = opts.maxToolCalls ?? 16;
  const evidence: EvidenceItem[] = [];
  const trace: TraceStep[] = [];
  const llmCalls: LlmCall[] = [];
  let seq = 0;
  let llmUsed = false;
  let plannerUsed = false;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // LLM call bookkeeping: identical calls are answered from the first result;
  // a kind is capped per run and per turn (a demo run sent five recommends in a row into a Qloo 429).
  const llmResults = new Map<string, QlooEnvelope>();
  const llmKindCount = new Map<string, number>();

  const execute = async (actor: TraceStep["actor"], tool: QlooToolName, rawArgs: Record<string, unknown>, purpose?: string): Promise<QlooEnvelope> => {
    // Partner places are always restricted to bars, shops and clubs, whoever asks.
    const args = withPartnerFilter(input, tool, rawArgs);
    const id = ++seq;
    safeEmit(opts.onEvent, { type: "start", seq: id, kind: "qloo", actor, tool, purpose, args });
    const started = Date.now();
    const once = async (): Promise<QlooEnvelope> => {
      try {
        return await qloo.call(tool, args);
      } catch (error) {
        return { operation: tool, status: "error", results: [], summary: sanitizeSecrets((error as Error).message), error: { code: "CLIENT", retryable: false, recovery: "See server log." } };
      }
    };
    let envelope = await once();
    // Qloo 429: back off and retry the same call a bounded number of times.
    let retries = 0;
    for (const wait of QLOO_RATE_LIMIT_BACKOFF_MS) {
      if (!isRateLimited(envelope)) break;
      await sleep(wait);
      retries++;
      envelope = await once();
    }
    if (retries > 0) envelope = { ...envelope, summary: `${envelope.summary ?? `${envelope.result_count ?? 0} result(s)`} (after ${retries} rate-limit ${retries === 1 ? "retry" : "retries"})` };
    evidence.push({ tool, args, envelope, purpose });
    const step: TraceStep = {
      index: trace.length + 1, actor, tool, args, purpose,
      status: envelope.status,
      summary: envelope.summary !== undefined ? sanitizeSecrets(envelope.summary) : `${envelope.result_count ?? 0} result(s)`,
      durationMs: Date.now() - started,
      endpoint: envelope.provenance?.endpoint,
      requests: envelope.provenance?.requests,
    };
    trace.push(step);
    opts.onStep?.(step);
    safeEmit(opts.onEvent, { type: "end", seq: id, kind: "qloo", step });
    return envelope;
  };

  // One timed LLM round trip, recorded and streamed like a Qloo call.
  const askLlm = async (llm: Llm, phase: LlmCall["phase"], messages: ChatMessage[], tools?: ToolSpec[]): Promise<ChatResult> => {
    const id = ++seq;
    safeEmit(opts.onEvent, { type: "start", seq: id, kind: "llm", phase });
    const started = Date.now();
    try {
      const res = await llm.chat(messages, tools);
      const summary = phase === "plan"
        ? res.toolCalls.length > 0 ? `chose ${res.toolCalls.map((c) => c.function.name).join(", ")}` : "finished choosing tools"
        : `wrote ${res.content?.trim().length ?? 0} characters of narrative`;
      const call: LlmCall = { phase, status: "ok", provider: res.provider, durationMs: Date.now() - started, summary };
      llmCalls.push(call);
      safeEmit(opts.onEvent, { type: "end", seq: id, kind: "llm", call });
      return res;
    } catch (error) {
      // Error text from providers can echo request details; keep only the first line, trimmed.
      const call: LlmCall = { phase, status: "error", durationMs: Date.now() - started, summary: sanitizeSecrets((error as Error).message.split("\n")[0] ?? "").slice(0, 160) || "error" };
      llmCalls.push(call);
      safeEmit(opts.onEvent, { type: "end", seq: id, kind: "llm", call });
      throw error;
    }
  };

  if (opts.llm) {
    const llm = opts.llm;
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt(input, today) },
      { role: "user", content: userMessage(input) },
    ];
    try {
      for (let turn = 0; turn < (opts.maxLlmTurns ?? 10) && trace.length < maxToolCalls; turn++) {
        const res = await askLlm(llm, "plan", messages, TOOL_SPECS);
        if (res.toolCalls.length === 0) break;
        messages.push({ role: "assistant", content: res.content, tool_calls: res.toolCalls });
        const kindsThisTurn = new Set<string>();
        for (const call of res.toolCalls) {
          const name = call.function.name;
          let content: string;
          if (!isQlooTool(name) || !ALLOWED.has(name) || trace.length >= maxToolCalls) {
            content = JSON.stringify({ status: "error", summary: `Tool ${name} is not available or the call budget is spent.` });
          } else {
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
            } catch {
              content = JSON.stringify({ status: "error", summary: "Arguments were not valid JSON." });
              messages.push({ role: "tool", tool_call_id: call.id, content });
              continue;
            }
            const key = callKey(name, withPartnerFilter(input, name, args));
            const kind = kindOf(name, args) ?? name;
            const earlier = llmResults.get(key);
            if (earlier && earlier.status !== "error") {
              content = JSON.stringify({ status: "duplicate", summary: "This exact call was already made in this run; its result is above. Do not repeat it; move on to the next step." });
            } else if (kindsThisTurn.has(kind) || (llmKindCount.get(kind) ?? 0) >= MAX_LLM_CALLS_PER_KIND) {
              content = JSON.stringify({ status: "error", summary: `Call limit for ${name} (${kind}) reached: at most one per turn and ${MAX_LLM_CALLS_PER_KIND} per run. Move on to the next step.` });
            } else {
              kindsThisTurn.add(kind);
              llmKindCount.set(kind, (llmKindCount.get(kind) ?? 0) + 1);
              llmUsed = true;
              const envelope = await execute("llm", name, args);
              llmResults.set(key, envelope);
              content = compact(envelope);
            }
          }
          messages.push({ role: "tool", tool_call_id: call.id, content });
        }
      }
    } catch (error) {
      // LLM provider down or rate-limited: the planner below completes the brief.
      console.warn(`LLM agent stopped, planner takes over: ${(error as Error).message}`);
    }
  }

  for (let step = nextPlannedStep(input, evidence, today); step && trace.length < maxToolCalls; step = nextPlannedStep(input, evidence, today)) {
    plannerUsed = true;
    await execute("planner", step.tool, step.args, step.purpose);
  }

  const agent: Brief["agent"] = llmUsed && plannerUsed ? "hybrid" : llmUsed ? "llm" : "planner";
  const brief = buildBrief({ input, mode: qloo.mode, agent, evidence, trace, llmCalls, now: today });
  if (opts.llm) {
    const narrative = await writeNarrative(opts.llm, brief, (m) => askLlm(opts.llm as Llm, "narrative", m)).catch((error: Error) => {
      console.warn(`LLM narrative failed, using template: ${error.message}`);
      return null;
    });
    if (narrative) brief.narrative = narrative;
  }
  return brief;
}

/** The LLM writes prose from the brief's own numbers; it adds no facts. */
export async function writeNarrative(llm: Llm, brief: Brief, chat?: (messages: ChatMessage[]) => Promise<ChatResult>): Promise<string | null> {
  const venue = brief.input.scenario === "venue";
  const facts = {
    scenario: brief.input.scenario,
    // A missing trend is passed as "not checked" / "no trend data", never as a flat line.
    subject: brief.subject.type === "artist" ? { ...brief.subject, trend: trendNote(brief, brief.subject) } : { ...brief.subject, trend: "not measured for venues" },
    city: brief.input.city, capacity: brief.input.capacity ?? null,
    date: brief.input.scenario === "venue" ? brief.input.date ?? null : null,
    scoreSource: brief.scoreSource, candidates: brief.candidates.map((c) => ({ ...c, trend: trendNote(brief, c) })), partners: brief.partners, tasteTags: brief.tasteTags, demographics: brief.demographics, mode: brief.mode,
  };
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `Write a 3-4 sentence booking brief for ${venue ? "a venue deciding whom to book for a free date" : "a concert promoter choosing an opener"}. Use only the facts in the JSON. Do not invent numbers, names, dates or reasons. Fit scores are 0-100 relative within one Qloo call (100 = strongest act, 0 = weakest), not forecasts; never call them percentages. scoreSource names that call: "rank" (Qloo ranked the acts) or "recommend" (the rank call failed and the scores are recommendation affinities; say so and never say Qloo ranked them). A trend of "not checked" or "no trend data" is unknown: never describe such an act as not rising or flat. Plain English, no hype, no markdown.`,
    },
    { role: "user", content: JSON.stringify(facts) },
  ];
  const res = chat ? await chat(messages) : await llm.chat(messages);
  const text = res.content?.trim();
  return text ? text.slice(0, 1200) : null;
}
