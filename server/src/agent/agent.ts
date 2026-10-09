// The Opener agent: an LLM chooses Qloo tool calls; the scripted planner then
// fills any evidence the LLM skipped; the brief is assembled from evidence.

import { isQlooTool, type QlooClient, type QlooEnvelope, type QlooToolName } from "../qloo/types.ts";
import { buildBrief } from "./brief.ts";
import type { ChatMessage, Llm } from "./llm.ts";
import { isoDaysAgo, nextPlannedStep } from "./planner.ts";
import { TOOL_SPECS } from "./toolSpecs.ts";
import type { Brief, BriefInput, EvidenceItem, TraceStep } from "./types.ts";

export interface RunOptions {
  input: BriefInput;
  qloo: QlooClient;
  llm?: Llm | null;
  maxLlmTurns?: number;
  maxToolCalls?: number;
  today?: Date;
  onStep?: (step: TraceStep) => void;
}

const ALLOWED = new Set(TOOL_SPECS.map((t) => t.function.name));

export function systemPrompt(input: BriefInput, today: Date): string {
  return [
    "You are Opener, a booking research agent for concert promoters and venues.",
    "Goal: gather Qloo evidence for a brief on who should open for the headliner in the given city.",
    "Call Qloo tools; do not answer from your own knowledge. Required evidence, in this order:",
    "1) qloo_describe the headliner (type artist).",
    "2) qloo_recommend target_type=artist, signals=[headliner], signal_location=city, limit 12.",
    "3) qloo_rank the recommended artists (excluding the headliner) with option_type=artist, signals=[headliner], signal_location=city.",
    `4) qloo_trends for the headliner plus the top 4 ranked artists, entity_type=artist, start_date=${isoDaysAgo(90, today)}, end_date=${isoDaysAgo(1, today)}.`,
    "5) qloo_where_popular for the headliner within the city.",
    "6) qloo_audience_demographics for the headliner.",
    "7) qloo_recommend target_type=place with filter_location=city; 8) qloo_recommend target_type=brand; 9) qloo_entity_tags for the headliner.",
    "If a result has status needs_input, retry with a more specific name once, then move on.",
    "Never infer health, politics, finances or anything about individuals. When done, reply with the single word DONE.",
  ].join("\n");
}

function compact(envelope: QlooEnvelope, max = 1800): string {
  const slim = { status: envelope.status, summary: envelope.summary, results: envelope.results, error: envelope.error, warnings: envelope.warnings };
  const text = JSON.stringify(slim);
  return text.length > max ? `${text.slice(0, max)}...[truncated]` : text;
}

export async function runAgent(opts: RunOptions): Promise<Brief> {
  const { input, qloo } = opts;
  const today = opts.today ?? new Date();
  const maxToolCalls = opts.maxToolCalls ?? 16;
  const evidence: EvidenceItem[] = [];
  const trace: TraceStep[] = [];
  let llmUsed = false;
  let plannerUsed = false;

  const execute = async (actor: TraceStep["actor"], tool: QlooToolName, args: Record<string, unknown>, purpose?: string): Promise<QlooEnvelope> => {
    const started = Date.now();
    let envelope: QlooEnvelope;
    try {
      envelope = await qloo.call(tool, args);
    } catch (error) {
      envelope = { operation: tool, status: "error", results: [], summary: (error as Error).message, error: { code: "CLIENT", retryable: false, recovery: "See server log." } };
    }
    evidence.push({ tool, args, envelope, purpose });
    const step: TraceStep = {
      index: trace.length + 1, actor, tool, args, purpose,
      status: envelope.status,
      summary: envelope.summary ?? `${envelope.result_count ?? 0} result(s)`,
      durationMs: Date.now() - started,
      endpoint: envelope.provenance?.endpoint,
      requests: envelope.provenance?.requests,
    };
    trace.push(step);
    opts.onStep?.(step);
    return envelope;
  };

  if (opts.llm) {
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt(input, today) },
      { role: "user", content: JSON.stringify({ headliner: input.headliner, city: input.city, capacity: input.capacity ?? null, show_window: [input.dateFrom ?? null, input.dateTo ?? null] }) },
    ];
    try {
      for (let turn = 0; turn < (opts.maxLlmTurns ?? 10) && trace.length < maxToolCalls; turn++) {
        const res = await opts.llm.chat(messages, TOOL_SPECS);
        if (res.toolCalls.length === 0) break;
        messages.push({ role: "assistant", content: res.content, tool_calls: res.toolCalls });
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
            llmUsed = true;
            content = compact(await execute("llm", name, args));
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
  const brief = buildBrief({ input, mode: qloo.mode, agent, evidence, trace, now: today });
  if (opts.llm) {
    const narrative = await writeNarrative(opts.llm, brief).catch((error: Error) => {
      console.warn(`LLM narrative failed, using template: ${error.message}`);
      return null;
    });
    if (narrative) brief.narrative = narrative;
  }
  return brief;
}

/** The LLM writes prose from the brief's own numbers; it adds no facts. */
export async function writeNarrative(llm: Llm, brief: Brief): Promise<string | null> {
  const facts = {
    headliner: brief.headliner, city: brief.input.city, capacity: brief.input.capacity ?? null,
    openers: brief.openers, partners: brief.partners, tasteTags: brief.tasteTags, demographics: brief.demographics, mode: brief.mode,
  };
  const res = await llm.chat([
    { role: "system", content: "Write a 3-4 sentence booking brief for a concert promoter. Use only the facts in the JSON. Do not invent numbers, names, dates or reasons. Overlap scores are relative within this brief, not forecasts. Plain English, no hype, no markdown." },
    { role: "user", content: JSON.stringify(facts) },
  ]);
  const text = res.content?.trim();
  return text ? text.slice(0, 1200) : null;
}
