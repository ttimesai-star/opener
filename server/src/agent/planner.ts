// Scripted planner: the evidence plan Opener needs for one brief. It runs on
// its own when no LLM is configured, and fills whatever the LLM agent skipped.

import type { QlooToolName } from "../qloo/types.ts";
import { readEntities } from "./normalize.ts";
import type { BriefInput, EvidenceItem } from "./types.ts";

export type EvidenceKind =
  | "resolve" | "candidates" | "rank" | "trends" | "heatmap" | "demographics" | "places" | "brands" | "tags";

export const REQUIRED_KINDS: readonly EvidenceKind[] = [
  "resolve", "candidates", "rank", "trends", "heatmap", "demographics", "places", "brands", "tags",
];

export interface PlannedStep {
  kind: EvidenceKind;
  tool: QlooToolName;
  args: Record<string, unknown>;
  purpose: string;
}

/** Classifies a tool call so evidence from the LLM and the planner is interchangeable. */
export function kindOf(tool: QlooToolName, args: Record<string, unknown>): EvidenceKind | null {
  switch (tool) {
    case "qloo_describe": return "resolve";
    case "qloo_rank": return "rank";
    case "qloo_trends": return "trends";
    case "qloo_where_popular": return "heatmap";
    case "qloo_audience_demographics": return "demographics";
    case "qloo_entity_tags": return "tags";
    case "qloo_recommend":
      if (args.target_type === "artist") return "candidates";
      if (args.target_type === "place") return "places";
      if (args.target_type === "brand") return "brands";
      return null;
    default: return null;
  }
}

export function latestOfKind(evidence: EvidenceItem[], kind: EvidenceKind): EvidenceItem | undefined {
  for (let i = evidence.length - 1; i >= 0; i--) {
    const e = evidence[i] as EvidenceItem;
    if (kindOf(e.tool, e.args) === kind && e.envelope.status !== "error") return e;
  }
  return undefined;
}

export function isoDaysAgo(days: number, today: Date): string {
  return new Date(today.getTime() - days * 86400000).toISOString().slice(0, 10);
}

/** Candidate names from the artist recommendation, excluding the headliner. */
export function candidateNames(evidence: EvidenceItem[], headliner: string, max = 10): string[] {
  const rec = latestOfKind(evidence, "candidates");
  if (!rec) return [];
  const h = headliner.trim().toLowerCase();
  return readEntities(rec.envelope.results).map((e) => e.name).filter((n) => n.trim().toLowerCase() !== h).slice(0, max);
}

export function rankedNames(evidence: EvidenceItem[], max: number): string[] {
  const rank = latestOfKind(evidence, "rank");
  if (!rank) return [];
  return readEntities(rank.envelope.results)
    .sort((a, b) => (b.affinity ?? 0) - (a.affinity ?? 0))
    .map((e) => e.name)
    .slice(0, max);
}

export function nextPlannedStep(input: BriefInput, evidence: EvidenceItem[], today = new Date()): PlannedStep | null {
  const have = (k: EvidenceKind) => latestOfKind(evidence, k) !== undefined;
  // A kind that already failed with a non-retryable error is not retried by the planner.
  const failed = (k: EvidenceKind) =>
    evidence.some((e) => kindOf(e.tool, e.args) === k && e.envelope.status === "error") && !have(k);
  const want = (k: EvidenceKind) => !have(k) && !failed(k);
  const h = input.headliner;

  if (want("resolve")) {
    return { kind: "resolve", tool: "qloo_describe", args: { entity: h, type: "artist" }, purpose: "Resolve the headliner to a Qloo entity" };
  }
  if (want("candidates")) {
    return {
      kind: "candidates", tool: "qloo_recommend",
      args: { target_type: "artist", signals: [h], signal_location: input.city, limit: 12 },
      purpose: `Artists whose audiences overlap with ${h}'s, weighted to ${input.city}`,
    };
  }
  const candidates = candidateNames(evidence, h);
  if (want("rank") && candidates.length > 0) {
    return {
      kind: "rank", tool: "qloo_rank",
      args: { options: candidates, option_type: "artist", signals: [h], signal_location: input.city },
      purpose: "Score the shortlist against one shared profile so scores are comparable",
    };
  }
  if (want("trends") && have("rank")) {
    return {
      kind: "trends", tool: "qloo_trends",
      args: { entities: [h, ...rankedNames(evidence, 4)], entity_type: "artist", start_date: isoDaysAgo(90, today), end_date: isoDaysAgo(1, today) },
      purpose: "Is the headliner and each top candidate rising over the last 90 days?",
    };
  }
  if (want("heatmap")) {
    return {
      kind: "heatmap", tool: "qloo_where_popular",
      args: { entity: h, entity_type: "artist", within: input.city, limit: 15 },
      purpose: `Where in ${input.city} the headliner's affinity is concentrated`,
    };
  }
  if (want("demographics")) {
    return {
      kind: "demographics", tool: "qloo_audience_demographics",
      args: { entity: h, entity_type: "artist" },
      purpose: "Aggregate age and gender skew of the headliner's audience",
    };
  }
  if (want("places")) {
    return {
      kind: "places", tool: "qloo_recommend",
      args: { target_type: "place", signals: [h], filter_location: input.city, limit: 6 },
      purpose: `Venues, bars and shops in ${input.city} that the same audience likes (partnership leads)`,
    };
  }
  if (want("brands")) {
    return {
      kind: "brands", tool: "qloo_recommend",
      args: { target_type: "brand", signals: [h], limit: 6 },
      purpose: "Brands with audience affinity to the headliner (sponsor leads)",
    };
  }
  if (want("tags")) {
    return {
      kind: "tags", tool: "qloo_entity_tags",
      args: { entities: [h], entity_type: "artist", limit: 6 },
      purpose: "Taste concepts that characterise the audience (for promo copy)",
    };
  }
  return null;
}
