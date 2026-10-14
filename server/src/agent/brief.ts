// Builds the brief from collected Qloo evidence. Every number in the brief
// comes from a Qloo result (or the mock); the LLM only writes the narrative.

import type { QlooMode } from "../qloo/types.ts";
import { readDemographics, readEntities, readHeatmap, readTags, readTrends, toOverlapScores } from "./normalize.ts";
import { isAudienceTag, kindOf, latestOfKind } from "./planner.ts";
import { sanitizeSecrets } from "./redact.ts";
import { subjectOf, type Trend, type Brief, type BriefInput, type Candidate, type EvidenceItem, type LlmCall, type Partner, type TraceStep } from "./types.ts";

export const TOP_CANDIDATES = 5;
export const TOP_PARTNERS = 3;

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

// Trend series are keyed by name and by Qloo id; the id wins because two acts can share a name.
const trendOf = (trends: Map<string, Trend>, entityId: string | undefined, ...names: string[]): Trend | undefined =>
  (entityId ? trends.get(entityId) : undefined) ?? names.map((n) => trends.get(n)).find((t) => t !== undefined);

// Harness recovery text is shown in a caveat; keep it to one short line.
const MAX_CAVEAT_DETAIL = 200;

export function buildBrief(args: {
  input: BriefInput;
  mode: QlooMode;
  agent: Brief["agent"];
  evidence: EvidenceItem[];
  trace: TraceStep[];
  llmCalls?: LlmCall[];
  narrative?: string;
  now?: Date;
}): Brief {
  const { input, evidence } = args;
  const subjectInput = subjectOf(input);
  const resolved = latestOfKind(evidence, "resolve");
  const head = resolved ? readEntities(resolved.envelope.results)[0] : undefined;
  const subjectName = head?.name ?? subjectInput.name;
  const isSubject = (name: string) => same(name, subjectInput.name) || same(name, subjectName);

  const trends = (() => {
    const t = latestOfKind(evidence, "trends");
    return t ? readTrends(t.envelope.results) : new Map();
  })();

  const rank = latestOfKind(evidence, "rank");
  const fallback = latestOfKind(evidence, "candidates");
  // Scores are spread over every act in the rank call, then the top five shown.
  // Without a rank result the recommendation's affinities are used, and the brief says so.
  const scored = rank ?? fallback;
  const ranked = readEntities(scored?.envelope.results)
    .filter((e) => !isSubject(e.name))
    .sort((a, b) => (b.affinity ?? 0) - (a.affinity ?? 0));
  const scores = toOverlapScores(ranked.map((e) => e.affinity));
  const pool = ranked.slice(0, TOP_CANDIDATES);
  const popularity = new Map(readEntities(fallback?.envelope.results).map((e) => [e.name, e.popularity]));
  const candidates: Candidate[] = pool.map((e, i) => ({
    name: e.name,
    entityId: e.entityId,
    overlapScore: scores[i] ?? 0,
    affinity: e.affinity,
    popularity: e.popularity ?? popularity.get(e.name) ?? null,
    trend: trendOf(trends, e.entityId, e.name) ?? "unknown",
  }));

  const partnersOf = (kind: "places" | "brands", label: Partner["kind"]): Partner[] => {
    const item = latestOfKind(evidence, kind);
    return readEntities(item?.envelope.results)
      .filter((e) => !isSubject(e.name)) // a venue is not its own partner
      .slice(0, TOP_PARTNERS)
      .map((e) => ({ name: e.name, kind: label, affinity: e.affinity }));
  };

  const heat = latestOfKind(evidence, "heatmap");
  const demo = latestOfKind(evidence, "demographics");
  const tags = latestOfKind(evidence, "tags");
  const heatPoints = heat ? readHeatmap(heat.envelope.results) : [];

  const displayName = (ref: string): string => {
    if (!ref) return ref;
    if (head && (head.entityId === ref || same(head.name, ref))) return head.name;
    const inRanked = ranked.find((e) => e.entityId === ref || same(e.name, ref));
    if (inRanked) return inRanked.name;
    const inFallback = readEntities(fallback?.envelope.results).find((e) => e.entityId === ref || same(e.name, ref));
    if (inFallback) return inFallback.name;
    if (same(subjectInput.name, ref)) return subjectInput.name;
    return ref;
  };

  const heatTargetRef = heat && heatPoints.length > 0 ? String(heat.args.entity ?? "") : "";

  const partial = {
    input,
    mode: args.mode,
    agent: args.agent,
    subject: {
      name: subjectName, entityId: head?.entityId, type: subjectInput.type,
      // Qloo trends are queried for artists only; a venue's trend is not measured.
      trend: subjectInput.type === "artist" ? (trendOf(trends, head?.entityId, subjectName, subjectInput.name) ?? "unknown") : "unknown",
    },
    candidates,
    heatmapOf: heatTargetRef ? displayName(heatTargetRef) || null : null,
    heatmap: heatPoints,
    demographics: demo ? readDemographics(demo.envelope.results) : null,
    // Set when the skew describes someone other than the subject (venue fallback to its top act).
    // The fallback call carries the act's Qloo id; show its name.
    demographicsOf: demo && demo.args.entity_type === "artist" && subjectInput.type === "place" ? displayName(String(demo.args.entity ?? "")) || null : null,
    partners: [...partnersOf("places", "place"), ...partnersOf("brands", "brand")],
    rankedCount: ranked.length,
    scoreSource: candidates.length === 0 ? null : scored === rank ? "rank" : "recommend",
    tasteTags: [...new Set(readTags(tags?.envelope.results).filter((t) => isAudienceTag(t.type)).map((t) => t.name))].slice(0, 6),
    trace: args.trace,
    llmCalls: args.llmCalls ?? [],
    generatedAt: (args.now ?? new Date()).toISOString(),
  } satisfies Omit<Brief, "narrative" | "caveats">;
  return { ...partial, narrative: args.narrative ?? templateNarrative(partial), caveats: buildCaveats(partial, evidence) };
}

type BriefCore = Omit<Brief, "narrative" | "caveats">;

export function templateNarrative(b: BriefCore): string {
  const venue = b.input.scenario === "venue";
  if (b.candidates.length === 0) {
    return `No candidates came back for ${b.subject.name} in ${b.input.city}. See the agent log for the status of each call.`;
  }
  const top = b.candidates[0] as Candidate;
  const rising = b.candidates.filter((o) => o.trend === "rising").map((o) => o.name);
  const base = b.scoreSource === "recommend"
    ? `among the ${b.rankedCount} acts Qloo recommended for ${b.input.city} (the rank call failed, so these are recommendation affinities)`
    : `among the ${b.rankedCount} acts Qloo ranked for ${b.input.city}`;
  const parts = [
    venue
      ? `${top.name} has the strongest affinity with the crowd that likes ${b.subject.name} ${base}.`
      : `${top.name} has the strongest audience affinity with ${b.subject.name} ${base}.`,
    rising.length > 0 ? `Rising over the last 90 days: ${rising.join(", ")}.` : "None of the shortlisted acts shows a clear 90-day rise.",
  ];
  if (b.partners.length > 0) parts.push(`${venue ? "Cross-promotion" : "Partnership"} leads with the same audience: ${b.partners.map((p) => p.name).join(", ")}.`);
  return parts.join(" ");
}

/** "What this does NOT prove" - fixed limits plus anything the evidence itself flagged. */
export function buildCaveats(b: BriefCore, evidence: EvidenceItem[]): string[] {
  const out: string[] = [];
  if (b.mode === "mock") out.push("DEMO MODE: all names and numbers are synthetic placeholders, not Qloo data.");
  out.push(
    b.scoreSource === "recommend"
      ? "qloo_rank returned no scores, so fit scores are relative within the one Qloo artist recommendation call (100 = strongest act recommended, 0 = weakest). They are not ticket-sales forecasts or probabilities."
      : "Fit scores are relative within this one Qloo rank call (100 = strongest act ranked, 0 = weakest). They are not ticket-sales forecasts or probabilities.",
    "Qloo describes aggregate taste affinities. Nothing here says anything about any individual fan.",
    "The brief does not check whether an act is available, affordable, touring nearby, or a good fit on stage.",
    "The map shows where affinity is comparatively strong inside the chosen area, not head counts of fans.",
  );
  if (b.input.scenario === "venue") {
    out.push("The venue's crowd is Qloo's aggregate audience for this place, not your ticket buyers or your mailing list.");
    if (b.demographicsOf) out.push(`Qloo returned no demographics for the venue itself; the age and gender skew shown is for fans of ${b.demographicsOf}, the act its crowd likes most.`);
    if (b.input.date) out.push(`The date (${b.input.date}) is not a Qloo input: trends cover the 90 days before today, not the night itself.`);
  }
  if (b.input.capacity) out.push(`Capacity (${b.input.capacity}) is not a Qloo input; whether an act can fill it is your call.`);
  evidence.forEach((e, i) => {
    const kind = kindOf(e.tool, e.args);
    if (e.envelope.status === "error") {
      // A later call of the same kind that came back (a retry) supersedes the failure.
      if (kind && evidence.slice(i + 1).some((later) => kindOf(later.tool, later.args) === kind && later.envelope.status !== "error")) return;
      const detail = (e.envelope.error?.recovery || e.envelope.summary || "").split("\n")[0]?.trim().slice(0, MAX_CAVEAT_DETAIL);
      out.push(`${e.tool} failed (${e.envelope.error?.code ?? "UNKNOWN"}${detail ? `: ${detail}` : ""}); the related section may be missing.`);
    }
    else if (e.envelope.status === "needs_input") {
      // A later call that resolved the same kind supersedes the ambiguity.
      if (kind && latestOfKind(evidence, kind)?.envelope.status === "ok") return;
      out.push(`${e.tool}: Qloo could not pin down "${String(e.args.entity ?? e.args.signals ?? e.args.entities ?? "")}" unambiguously; check the spelling or pick the intended entity.`);
    }
    else if (e.envelope.status === "empty") out.push(`${e.tool} returned no results; the related section is empty, not zero.`);
    else if (e.envelope.status === "partial" || e.envelope.status === "degraded") out.push(`${e.tool} came back ${e.envelope.status}: ${e.envelope.summary ?? ""}`.trim());
  });
  if (b.llmCalls.some((c) => c.status === "error")) out.push("The LLM was unavailable for part of this run; the scripted planner completed the evidence plan.");
  return [...new Set(out.map((str) => sanitizeSecrets(str)))];
}
