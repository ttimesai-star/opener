// Scripted planner: the evidence plan Opener needs for one brief. It runs on
// its own when no LLM is configured, and fills whatever the LLM agent skipped.
// Both scenarios use the same nine evidence kinds; only the anchor entity and
// a few arguments differ.

import type { QlooToolName } from "../qloo/types.ts";
import { readEntities } from "./normalize.ts";
import { subjectOf, type BriefInput, type EvidenceItem } from "./types.ts";

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

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Candidate names from the artist recommendation, excluding the subject. */
export function candidateNames(evidence: EvidenceItem[], subject: string, max = 10): string[] {
  const rec = latestOfKind(evidence, "candidates");
  if (!rec) return [];
  return readEntities(rec.envelope.results).map((e) => e.name).filter((n) => !same(n, subject)).slice(0, max);
}

/** Top names of the rank call; falls back to the recommendation order. */
export function rankedNames(evidence: EvidenceItem[], max: number, subject = ""): string[] {
  const rank = latestOfKind(evidence, "rank");
  if (!rank) return candidateNames(evidence, subject, max);
  return readEntities(rank.envelope.results)
    .filter((e) => !same(e.name, subject))
    .sort((a, b) => (b.affinity ?? 0) - (a.affinity ?? 0))
    .map((e) => e.name)
    .slice(0, max);
}

export function nextPlannedStep(input: BriefInput, evidence: EvidenceItem[], today = new Date()): PlannedStep | null {
  const have = (k: EvidenceKind) => latestOfKind(evidence, k) !== undefined;
  // A kind that already failed with an error is not retried by the planner.
  const failed = (k: EvidenceKind) =>
    evidence.some((e) => kindOf(e.tool, e.args) === k && e.envelope.status === "error") && !have(k);
  const want = (k: EvidenceKind) => !have(k) && !failed(k);
  const { name: s, type } = subjectOf(input);
  const venue = input.scenario === "venue";
  const city = input.city;

  if (want("resolve")) {
    return { kind: "resolve", tool: "qloo_describe", args: { entity: s, type }, purpose: `Resolve ${venue ? "the venue" : "the headliner"} to a Qloo entity` };
  }
  if (want("candidates")) {
    return {
      kind: "candidates", tool: "qloo_recommend",
      args: { target_type: "artist", signals: [s], signal_location: city, limit: 12 },
      purpose: venue
        ? `Artists whose audiences overlap with the crowd that likes ${s}, weighted to ${city}`
        : `Artists whose audiences overlap with ${s}'s, weighted to ${city}`,
    };
  }
  const candidates = candidateNames(evidence, s);
  if (want("rank") && candidates.length > 0) {
    return {
      kind: "rank", tool: "qloo_rank",
      args: { options: candidates, option_type: "artist", signals: [s], signal_location: city },
      purpose: "Score the shortlist against one shared profile so scores are comparable",
    };
  }
  if (want("trends") && have("rank")) {
    const entities = venue ? rankedNames(evidence, 5, s) : [s, ...rankedNames(evidence, 4, s)];
    return {
      kind: "trends", tool: "qloo_trends",
      args: { entities, entity_type: "artist", start_date: isoDaysAgo(90, today), end_date: isoDaysAgo(1, today) },
      purpose: venue ? "Which shortlisted acts are rising over the last 90 days (momentum for the date)" : "Is the headliner and each top candidate rising over the last 90 days?",
    };
  }
  // Venue: whose fans to map is the top candidate's, so the room can see whether
  // that act's audience lives near it. Needs a candidate first.
  const mapTarget = venue ? rankedNames(evidence, 1, s)[0] : s;
  if (want("heatmap") && mapTarget) {
    return {
      kind: "heatmap", tool: "qloo_where_popular",
      args: { entity: mapTarget, entity_type: "artist", within: city, limit: 15 },
      purpose: venue ? `Where in ${city} the fans of the top candidate (${mapTarget}) are concentrated` : `Where in ${city} the headliner's affinity is concentrated`,
    };
  }
  if (want("demographics")) {
    return {
      kind: "demographics", tool: "qloo_audience_demographics",
      args: { entity: s, entity_type: type },
      purpose: venue ? "Aggregate age and gender skew of the venue's crowd" : "Aggregate age and gender skew of the headliner's audience",
    };
  }
  if (want("places")) {
    return {
      kind: "places", tool: "qloo_recommend",
      args: { target_type: "place", signals: [s], filter_location: city, limit: 6 },
      purpose: venue ? `Other places in ${city} the same crowd likes (cross-promotion leads)` : `Venues, bars and shops in ${city} that the same audience likes (partnership leads)`,
    };
  }
  if (want("brands")) {
    return {
      kind: "brands", tool: "qloo_recommend",
      args: { target_type: "brand", signals: [s], limit: 6 },
      purpose: `Brands with audience affinity to ${venue ? "the venue's crowd" : "the headliner"} (sponsor leads)`,
    };
  }
  if (want("tags")) {
    return {
      kind: "tags", tool: "qloo_entity_tags",
      args: { entities: [s], entity_type: type, limit: 6 },
      purpose: "Taste concepts that characterise the audience (for promo copy)",
    };
  }
  return null;
}
