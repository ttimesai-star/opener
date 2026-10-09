// Builds the brief from collected Qloo evidence. Every number in the brief
// comes from a Qloo result (or the mock); the LLM only writes the narrative.

import type { QlooMode } from "../qloo/types.ts";
import { readDemographics, readEntities, readHeatmap, readTrends, toOverlapScores } from "./normalize.ts";
import { latestOfKind } from "./planner.ts";
import { subjectOf, type Brief, type BriefInput, type Candidate, type EvidenceItem, type LlmCall, type Partner, type TraceStep } from "./types.ts";

export const TOP_CANDIDATES = 5;
export const TOP_PARTNERS = 3;

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

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
  const pool = readEntities((rank ?? fallback)?.envelope.results)
    .filter((e) => !isSubject(e.name))
    .sort((a, b) => (b.affinity ?? 0) - (a.affinity ?? 0))
    .slice(0, TOP_CANDIDATES);
  const scores = toOverlapScores(pool.map((e) => e.affinity));
  const popularity = new Map(readEntities(fallback?.envelope.results).map((e) => [e.name, e.popularity]));
  const candidates: Candidate[] = pool.map((e, i) => ({
    name: e.name,
    entityId: e.entityId,
    overlapScore: scores[i] ?? 0,
    affinity: e.affinity,
    popularity: e.popularity ?? popularity.get(e.name) ?? null,
    trend: trends.get(e.name) ?? "unknown",
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

  const partial = {
    input,
    mode: args.mode,
    agent: args.agent,
    subject: {
      name: subjectName, entityId: head?.entityId, type: subjectInput.type,
      // Qloo trends are queried for artists only; a venue's trend is not measured.
      trend: subjectInput.type === "artist" ? (trends.get(subjectName) ?? trends.get(subjectInput.name) ?? "unknown") : "unknown",
    },
    candidates,
    heatmapOf: heat && heatPoints.length > 0 ? String(heat.args.entity ?? "") || null : null,
    heatmap: heatPoints,
    demographics: demo ? readDemographics(demo.envelope.results) : null,
    partners: [...partnersOf("places", "place"), ...partnersOf("brands", "brand")],
    tasteTags: readEntities(tags?.envelope.results).map((t) => t.name).slice(0, 6),
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
  const parts = [
    venue
      ? `${top.name} has the strongest affinity with the crowd that likes ${b.subject.name} among the ${b.candidates.length} acts scored for ${b.input.city}.`
      : `${top.name} has the strongest audience affinity with ${b.subject.name} among the ${b.candidates.length} acts scored for ${b.input.city}.`,
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
    "Overlap scores are relative to the strongest candidate in this one Qloo call. They are not ticket-sales forecasts or probabilities.",
    "Qloo describes aggregate taste affinities. Nothing here says anything about any individual fan.",
    "The brief does not check whether an act is available, affordable, touring nearby, or a good fit on stage.",
    "The map shows where affinity is comparatively strong inside the chosen area, not head counts of fans.",
  );
  if (b.input.scenario === "venue") {
    out.push("The venue's crowd is Qloo's aggregate audience for this place, not your ticket buyers or your mailing list.");
    if (b.input.date) out.push(`The date (${b.input.date}) is not a Qloo input: trends cover the 90 days before today, not the night itself.`);
  }
  if (b.input.capacity) out.push(`Capacity (${b.input.capacity}) is not a Qloo input; whether an act can fill it is your call.`);
  for (const e of evidence) {
    if (e.envelope.status === "error") out.push(`${e.tool} failed (${e.envelope.error?.code ?? "UNKNOWN"}); the related section may be missing.`);
    else if (e.envelope.status === "needs_input") out.push(`${e.tool}: Qloo could not pin down "${String(e.args.entity ?? e.args.signals ?? "")}" unambiguously; check the spelling or pick the intended entity.`);
    else if (e.envelope.status === "empty") out.push(`${e.tool} returned no results; the related section is empty, not zero.`);
    else if (e.envelope.status === "partial" || e.envelope.status === "degraded") out.push(`${e.tool} came back ${e.envelope.status}: ${e.envelope.summary ?? ""}`.trim());
  }
  if (b.llmCalls.some((c) => c.status === "error")) out.push("The LLM was unavailable for part of this run; the scripted planner completed the evidence plan.");
  return [...new Set(out)];
}
