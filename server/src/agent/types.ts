import type { QlooEnvelope, QlooMode, QlooToolName } from "../qloo/types.ts";

export interface BriefInput {
  headliner: string;
  city: string;
  dateFrom?: string; // YYYY-MM-DD, show window (informational)
  dateTo?: string;
  capacity?: number;
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

export interface EvidenceItem {
  tool: QlooToolName;
  args: Record<string, unknown>;
  envelope: QlooEnvelope;
  purpose?: string;
}

export type Trend = "rising" | "flat" | "falling" | "unknown";

export interface OpenerCandidate {
  name: string;
  entityId?: string;
  overlapScore: number; // 0-100, relative within this brief only
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
  input: BriefInput;
  mode: QlooMode;
  agent: "llm" | "planner" | "hybrid";
  headliner: { name: string; entityId?: string; trend: Trend };
  openers: OpenerCandidate[];
  heatmap: HeatPoint[];
  demographics: Demographics | null;
  partners: Partner[];
  tasteTags: string[];
  narrative: string;
  caveats: string[];
  trace: TraceStep[];
  generatedAt: string;
}
