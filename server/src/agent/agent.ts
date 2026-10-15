// The Opener agent: an LLM chooses Qloo tool calls; the scripted planner then
// fills any evidence the LLM skipped; the brief is assembled from evidence.
// Every Qloo and LLM call is reported through onEvent as it starts and ends,
// which the server streams to the page.

import { isQlooTool, type QlooClient, type QlooEnvelope, type QlooToolName } from "../qloo/types.ts";
import { buildBrief, trendNote } from "./brief.ts";
import { popularityLabel } from "./popularity.ts";
import { envMs, timeoutSignal, type ChatMessage, type ChatResult, type Llm, type ToolSpec } from "./llm.ts";
import { ceilingPurpose, isoDaysAgo, kindOf, nextCeiling, nextPlannedStep, repairLlmArgs, TREND_POINTS, TREND_QUERY_DAYS, usableSupportActs, withPartnerFilter } from "./planner.ts";
import { MIN_SUPPORT_ACTS } from "./popularity.ts";
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
  /** Wall-clock budget for the LLM's tool-choosing turns (incl. the Qloo calls it makes); the planner finishes after. */
  llmBudgetMs?: number;
  /** Time limit for the narrative call; the template narrative is used after it. */
  narrativeTimeoutMs?: number;
  /** Whole-brief target: the narrative only gets the time left until it. */
  briefTargetMs?: number;
}

/**
 * The live demo brief took 156 s: Gemini's quota ran out after two calls and a
 * free fallback model spent 8-28 s per turn. After this budget the scripted
 * planner, which needs no LLM, completes the evidence. Env: LLM_PLAN_BUDGET_MS.
 */
export const DEFAULT_LLM_BUDGET_MS = 45_000;
/** Env: LLM_NARRATIVE_TIMEOUT_MS. */
export const DEFAULT_NARRATIVE_TIMEOUT_MS = 12_000;
/**
 * Whole-brief target (env BRIEF_TARGET_MS). Live 15.10 the plan budget ran out at
 * 45 s, the planner's Qloo calls took ~12 s and the narrative timed out at 12 s:
 * 63 s. The narrative now gets what is left until this target, and is skipped
 * (template narrative) when less than MIN_NARRATIVE_MS is left.
 */
export const DEFAULT_BRIEF_TARGET_MS = 55_000;
export const MIN_NARRATIVE_MS = 3_000;

/** Waits before each retry of a rate-limited Qloo call (the harness already retried briefly). */
export const QLOO_RATE_LIMIT_BACKOFF_MS: readonly number[] = [2000, 6000];
/** The LLM may call one evidence kind at most this often per run (one retry), and once per turn. */
export const MAX_LLM_CALLS_PER_KIND = 2;
/** Statuses after which another call of the same evidence kind adds nothing (the brief reads the latest one). */
const GATHERED = new Set(["ok", "partial", "degraded"]);

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
    "2) qloo_recommend target_type=artist, signals=[headliner], signal_location=city, limit 20.",
    "3) qloo_rank the recommended artists (excluding the headliner) with option_type=artist, signals=[headliner], signal_location=city (the server picks the support-slot shortlist).",
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

/** Rejects when the signal aborts, even if the LLM client ignores it (the budget must hold for any Llm). */
export function untilAborted<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  // The abandoned call may still fail later; observe it so Node does not crash the server on an unhandled rejection (Jules review 2026-10-15).
  work.catch(() => {});
  const why = () => (signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? "time limit"));
  const stopped = () => new Error(`LLM call stopped: ${why()}`);
  if (signal.aborted) return Promise.reject(stopped());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(stopped());
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
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
  // Monotonic clock: a wall-clock jump (NTP) must not stretch or cut the brief target (Jules review 2026-10-15).
  const runStarted = performance.now();
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
  const llmKindStatus = new Map<string, QlooEnvelope["status"]>();
  // Options and env alike: positive numbers only, else the default (Jules review 2026-10-15).
  const llmBudgetMs = envMs(String(opts.llmBudgetMs ?? process.env.LLM_PLAN_BUDGET_MS ?? ""), DEFAULT_LLM_BUDGET_MS);
  const narrativeTimeoutMs = envMs(String(opts.narrativeTimeoutMs ?? process.env.LLM_NARRATIVE_TIMEOUT_MS ?? ""), DEFAULT_NARRATIVE_TIMEOUT_MS);
  /** Why the LLM stopped choosing tools before saying DONE, if it did. */
  let handover: string | undefined;

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

  /**
   * The opener candidate pool with a popularity ceiling. Too few support acts
   * under it: widen to the next ceiling, then fall back to the unfiltered harness
   * recommendation. Each step is its own call in the log. Same for LLM and planner.
   */
  const executeCandidates = async (actor: TraceStep["actor"], args: Record<string, unknown>, purpose?: string): Promise<QlooEnvelope> => {
    let envelope = await execute(actor, "qloo_recommend", args, purpose);
    let current = args;
    const { headliner, city } = input.scenario === "opener" ? input : { headliner: "", city: input.city };
    while (input.scenario === "opener" && typeof current.popularity_max === "number" && trace.length < maxToolCalls) {
      const ceiling = current.popularity_max;
      if (envelope.status !== "error" && usableSupportActs(input, evidence, envelope.results, ceiling).length >= MIN_SUPPORT_ACTS) break;
      const next = nextCeiling(input, evidence, ceiling, envelope.status);
      if (next === undefined) break;
      const { popularity_max: _dropped, ...rest } = current;
      current = next === null ? rest : { ...rest, popularity_max: next };
      envelope = await execute("planner", "qloo_recommend", current, next === null
        ? `Too few acts below the popularity ceiling; Qloo's unfiltered artist recommendation for ${headliner}, weighted to ${city}`
        : ceilingPurpose(headliner, city, next, true));
    }
    return envelope;
  };

  // One timed LLM round trip, recorded and streamed like a Qloo call.
  const askLlm = async (llm: Llm, phase: LlmCall["phase"], messages: ChatMessage[], tools?: ToolSpec[], signal?: AbortSignal): Promise<ChatResult> => {
    const id = ++seq;
    safeEmit(opts.onEvent, { type: "start", seq: id, kind: "llm", phase });
    const started = Date.now();
    try {
      const res = await untilAborted(llm.chat(messages, tools, signal ? { signal } : undefined), signal);
      // A narrative with field names or raw numbers is not shown; the live log must say so too (Jules review 2026-10-15).
      const problem = phase === "narrative" ? narrativeProblem(res.content?.trim() ?? "") : null;
      if (problem) {
        const call: LlmCall = { phase, status: "error", provider: res.provider, durationMs: Date.now() - started, summary: `wrote ${res.content?.trim().length ?? 0} characters, not used (${problem}); template shown` };
        llmCalls.push(call);
        safeEmit(opts.onEvent, { type: "end", seq: id, kind: "llm", call });
        throw new NarrativeRejected(problem);
      }
      const summary = phase === "plan"
        ? res.toolCalls.length > 0 ? `chose ${res.toolCalls.map((c) => c.function.name).join(", ")}` : "finished choosing tools"
        : `wrote ${res.content?.trim().length ?? 0} characters of narrative`;
      const call: LlmCall = { phase, status: "ok", provider: res.provider, durationMs: Date.now() - started, summary };
      llmCalls.push(call);
      safeEmit(opts.onEvent, { type: "end", seq: id, kind: "llm", call });
      return res;
    } catch (error) {
      if (error instanceof NarrativeRejected) throw error; // already recorded above
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
    const budget = new AbortController();
    const budgetNote = `the LLM time budget (${Math.round(llmBudgetMs / 1000)} s) ran out`;
    const budgetTimer = setTimeout(() => budget.abort(budgetNote), llmBudgetMs);
    try {
      for (let turn = 0; turn < (opts.maxLlmTurns ?? 10) && trace.length < maxToolCalls; turn++) {
        if (budget.signal.aborted) { handover = budgetNote; break; }
        const res = await askLlm(llm, "plan", messages, TOOL_SPECS, budget.signal);
        if (res.toolCalls.length === 0) break;
        messages.push({ role: "assistant", content: res.content, tool_calls: res.toolCalls });
        const kindsThisTurn = new Set<string>();
        for (const call of res.toolCalls) {
          if (budget.signal.aborted) { handover = budgetNote; break; }
          const name = call.function.name;
          let content: string;
          if (!isQlooTool(name) || !ALLOWED.has(name) || trace.length >= maxToolCalls) {
            content = JSON.stringify({ status: "error", summary: `Tool ${name} is not available or the call budget is spent.` });
          } else {
            let args: Record<string, unknown> = {};
            try {
              args = repairLlmArgs(input, evidence, name, JSON.parse(call.function.arguments || "{}") as Record<string, unknown>);
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
              handover ??= `the LLM repeated a call (${name})`;
            } else if (GATHERED.has(llmKindStatus.get(kind) ?? "")) {
              // The brief reads only the latest result of a kind: a second gathered call is a loop, not evidence.
              content = JSON.stringify({ status: "error", summary: `Evidence for ${name} (${kind}) is already gathered. Move on to the next step.` });
              handover ??= `the LLM repeated a call (${name})`;
            } else if (kindsThisTurn.has(kind) || (llmKindCount.get(kind) ?? 0) >= MAX_LLM_CALLS_PER_KIND) {
              content = JSON.stringify({ status: "error", summary: `Call limit for ${name} (${kind}) reached: at most one per turn and ${MAX_LLM_CALLS_PER_KIND} per run. Move on to the next step.` });
              handover ??= `the LLM repeated a call (${name})`;
            } else {
              kindsThisTurn.add(kind);
              llmKindCount.set(kind, (llmKindCount.get(kind) ?? 0) + 1);
              llmUsed = true;
              const envelope = kind === "candidates" && typeof args.popularity_max === "number"
                ? await executeCandidates("llm", args)
                : await execute("llm", name, args);
              llmResults.set(key, envelope);
              llmKindStatus.set(kind, envelope.status);
              content = compact(envelope);
            }
          }
          messages.push({ role: "tool", tool_call_id: call.id, content });
        }
        // A repeated call means the model is looping: hand over now instead of paying for more turns.
        if (handover) break;
      }
    } catch (error) {
      // LLM provider down, rate-limited, or the budget ran out mid-call: the planner below completes the brief.
      if (budget.signal.aborted) handover ??= budgetNote;
      console.warn(`LLM agent stopped, planner takes over: ${(error as Error).message}`);
    } finally {
      clearTimeout(budgetTimer);
    }
  }

  for (let step = nextPlannedStep(input, evidence, today); step && trace.length < maxToolCalls; step = nextPlannedStep(input, evidence, today)) {
    plannerUsed = true;
    if (step.kind === "candidates" && typeof step.args.popularity_max === "number") await executeCandidates("planner", step.args, step.purpose);
    else await execute("planner", step.tool, step.args, step.purpose);
  }

  const agent: Brief["agent"] = llmUsed && plannerUsed ? "hybrid" : llmUsed ? "llm" : "planner";
  const brief = buildBrief({ input, mode: qloo.mode, agent, evidence, trace, llmCalls, now: today, handover: plannerUsed ? handover : undefined });
  const briefTargetMs = envMs(String(opts.briefTargetMs ?? process.env.BRIEF_TARGET_MS ?? ""), DEFAULT_BRIEF_TARGET_MS);
  const leftMs = runStarted + briefTargetMs - performance.now();
  const narrativeMs = Math.min(narrativeTimeoutMs, leftMs);
  if (opts.llm && leftMs < MIN_NARRATIVE_MS) {
    // Shown in the agent log, not skipped silently.
    const id = ++seq;
    const call: LlmCall = { phase: "narrative", status: "error", durationMs: 0, summary: `skipped: less than ${MIN_NARRATIVE_MS / 1000} s left of the ${Math.round(briefTargetMs / 1000)} s brief time target; template shown` };
    llmCalls.push(call);
    safeEmit(opts.onEvent, { type: "start", seq: id, kind: "llm", phase: "narrative" });
    safeEmit(opts.onEvent, { type: "end", seq: id, kind: "llm", call });
  } else if (opts.llm) {
    const limit = timeoutSignal(narrativeMs, `narrative time limit of ${Math.round(narrativeMs / 1000)} s`);
    const narrative = await writeNarrative(opts.llm, brief, (m) => askLlm(opts.llm as Llm, "narrative", m, undefined, limit.signal)).catch((error: Error) => {
      console.warn(`LLM narrative failed, using template: ${error.message}`);
      return null;
    }).finally(limit.clear);
    if (narrative) brief.narrative = narrative;
  }
  return brief;
}

/** The LLM writes prose from the brief's own numbers; it adds no facts. */
export async function writeNarrative(llm: Llm, brief: Brief, chat?: (messages: ChatMessage[]) => Promise<ChatResult>): Promise<string | null> {
  const venue = brief.input.scenario === "venue";
  const facts = narrativeFacts(brief);
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `Write a 3-4 sentence booking brief for ${venue ? "a venue deciding whom to book for a free date" : "a concert promoter choosing an opener"}, in the words a booker uses. Use only the facts in the JSON. Do not invent numbers, names, dates or reasons. "fit" is 0-100 relative within this one shortlist (100 = strongest audience match, 0 = weakest), not a forecast and not a percentage; say "audience fit" if you mention it at all, and prefer words such as "the strongest audience match" over the number. "scoredBy" is "rank" (Qloo ranked the acts) or "recommend" (the rank call failed and the order comes from Qloo's recommendation; say so and never say Qloo ranked them). "popularity" is already a readable label such as "top 0.03%"; quote it as written or leave it out. Never write JSON field names (overlapScore, affinity, scoredBy, entityId) and never write raw decimals such as 0.972. A trend of "not checked" or "no trend data" is unknown: never describe such an act as not rising or flat. Qloo does not take venue capacity, ticket prices, availability or the show date into account: never mention capacity or room size, and never say or imply that the acts fit the room, the date or the budget. Plain English, no hype, no markdown.`,
    },
    { role: "user", content: JSON.stringify(facts) },
  ];
  const res = chat ? await chat(messages) : await llm.chat(messages);
  const text = res.content?.trim();
  if (!text) return null;
  // The model still echoed field names and raw numbers on the live demo (14.10:
  // "overlap score of 100 with an affinity of 0.972 and a popularity near 1.0").
  // Such text is not shown: the template narrative is used instead.
  const problem = narrativeProblem(text);
  if (problem) throw new NarrativeRejected(problem);
  return text.slice(0, 1200);
}

/** Labels the brief already shows, without raw Qloo numbers: the narrative LLM sees only these. */
export function narrativeFacts(brief: Brief): Record<string, unknown> {
  // Demographics are signed skews per band; the model gets only which bands lean over or under.
  const lean = (r: Record<string, number> | undefined) => {
    const e = Object.entries(r ?? {}).sort((a, b) => b[1] - a[1]);
    const label = (k: string) => k.replace(/_/g, " ");
    return { over: e.filter(([, v]) => v > 0).slice(0, 2).map(([k]) => label(k)), under: e.filter(([, v]) => v < 0).slice(-2).map(([k]) => label(k)) };
  };
  return {
    scenario: brief.input.scenario,
    // A missing trend is passed as "not checked" / "no trend data", never as a flat line.
    subject: {
      name: brief.subject.name, type: brief.subject.type,
      trend: brief.subject.type === "artist" ? trendNote(brief, brief.subject) : "not measured for venues",
      ...(typeof brief.subject.popularity === "number" ? { popularity: popularityLabel(brief.subject.popularity) } : {}),
    },
    // Capacity is left out on purpose: Qloo has no venue-size input, and a narrative that saw
    // it wrote "Given the venue capacity of 1200..." as if the picks accounted for it (demo 14.10).
    city: brief.input.city,
    date: brief.input.scenario === "venue" ? brief.input.date ?? null : null,
    scoredBy: brief.scoreSource,
    candidates: brief.candidates.map((c) => ({ name: c.name, fit: c.overlapScore, popularity: popularityLabel(c.popularity), trend: trendNote(brief, c) })),
    partners: brief.partners.map((p) => ({ name: p.name, kind: p.kind })),
    tasteTags: brief.tasteTags,
    audience: brief.demographics ? { age: lean(brief.demographics.age), gender: lean(brief.demographics.gender) } : null,
    mode: brief.mode,
  };
}

/** A decimal that is not a percentage: "0.972", ".972", "0.8", "1.0" (not "0.03%" or "0.03 percent"). */
const RAW_DECIMAL = String.raw`(?<![\w.])(?:[01]?\.\d+)(?![\d%]|\s*per\s?cent)`;
const NARRATIVE_PROBLEMS: [RegExp, string][] = [
  [/\boverlap[\s_-]?score/i, "field name overlapScore"],
  [/\bscore\s?source\b|\bscoredBy\b|\bentity_?id\b/i, "JSON field name"],
  // "an affinity of 0.972", not "an affinity with 2 of the acts" (Jules review 2026-10-15).
  [new RegExp(String.raw`\baffinit(?:y|ies)\b[^.]{0,20}?${RAW_DECIMAL}`, "i"), "raw affinity number"],
  [new RegExp(String.raw`\bpopularity\b[^.]{0,20}?${RAW_DECIMAL}`, "i"), "raw popularity number"],
  [new RegExp(RAW_DECIMAL), "raw decimal"],
];

class NarrativeRejected extends Error {
  constructor(problem: string) {
    super(`narrative rejected: ${problem}`);
  }
}

/** Why a narrative must not be shown (internal field names, raw Qloo numbers), or null when it reads fine. */
export function narrativeProblem(text: string): string | null {
  for (const [re, why] of NARRATIVE_PROBLEMS) if (re.test(text)) return why;
  return null;
}
