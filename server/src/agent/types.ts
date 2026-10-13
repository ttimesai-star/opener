import type { QlooEnvelope, QlooMode, QlooToolName } from "../qloo/types.ts";

/**
 * Two booking questions run on the same Qloo tools:
 * - "opener": a headliner and a city -> who should open the show.
 * - "venue":  a venue, its city and a free date -> whom the room should book.
 */
export type Scenario = "opener" | "venue";

export interface OpenerInput {
  scenario: "opener";
  headliner: string;
  city: string;
  dateFrom?: string; // YYYY-MM-DD, show window (informational)
  dateTo?: string;
  capacity?: number;
}

export interface VenueInput {
  scenario: "venue";
  venue: string;
  city: string;
  date?: string; // YYYY-MM-DD, the free date (informational: Qloo has no availability data)
  capacity?: number;
}

export type BriefInput = OpenerInput | VenueInput;

/** The entity every query in a brief is anchored on. */
export function subjectOf(input: BriefInput): { name: string; type: "artist" | "place" } {
  return input.scenario === "venue" ? { name: input.venue, type: "place" } : { name: input.headliner, type: "artist" };
}

export interface TraceStep {
  index: number;
  actor: "llm" | "planner";
  tool: QlooToolName;
  args: Record<string, unknown>;
  status: QlooEnvelope["status"];
  summary: string;
  durationMs: number;
  endpoint?: string;
  requests?: unknown[];
  purpose?: string;
}

/** One LLM round trip: choosing the next tool calls, or writing the narrative. */
export interface LlmCall {
  phase: "plan" | "narrative";
  status: "ok" | "error";
  provider?: string;
  durationMs: number;
  summary: string;
}

/**
 * Live agent events, streamed to the page over Server-Sent Events.
 * `seq` orders Qloo and LLM calls on one timeline; a "start" is always
 * followed by an "end" with the same seq.
 */
export type AgentEvent =
  | { type: "start"; seq: number; kind: "qloo"; actor: TraceStep["actor"]; tool: QlooToolName; purpose?: string; args: Record<string, unknown> }
  | { type: "end"; seq: number; kind: "qloo"; step: TraceStep }
  | { type: "start"; seq: number; kind: "llm"; phase: LlmCall["phase"] }
  | { type: "end"; seq: number; kind: "llm"; call: LlmCall };

export interface EvidenceItem {
  tool: QlooToolName;
  args: Record<string, unknown>;
  envelope: QlooEnvelope;
  purpose?: string;
}

export type Trend = "rising" | "flat" | "falling" | "unknown";

export interface Candidate {
  name: string;
  entityId?: string;
  overlapScore: number; // 0-100 min-max across the acts in one rank call (100 = strongest, 0 = weakest)
  affinity: number | null; // raw Qloo affinity from the rank call
  popularity: number | null;
  trend: Trend;
}

export interface HeatPoint {
  lat: number;
  lng: number;
  weight: number; // 0-1, relative within the query area
}

export interface Partner {
  name: string;
  kind: "place" | "brand";
  affinity: number | null;
}

export interface Demographics {
  age: Record<string, number>;
  gender: Record<string, number>;
}

export interface Brief {
  /** Permalink id, set by the server when the brief is stored. */
  id?: string;
  input: BriefInput;
  mode: QlooMode;
  agent: "llm" | "planner" | "hybrid";
  subject: { name: string; entityId?: string; type: "artist" | "place"; trend: Trend };
  candidates: Candidate[];
  /** Whose fans the map shows: the headliner (opener) or the top candidate (venue). */
  heatmapOf: string | null;
  heatmap: HeatPoint[];
  demographics: Demographics | null;
  /** Whose audience the skew describes when it is not the subject (venue with no Qloo demographics). */
  demographicsOf: string | null;
  partners: Partner[];
  /** How many acts the rank call scored (the base of overlapScore). */
  rankedCount: number;
  tasteTags: string[];
  narrative: string;
  caveats: string[];
  trace: TraceStep[];
  llmCalls: LlmCall[];
  generatedAt: string;
}
