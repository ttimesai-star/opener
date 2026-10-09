// Builds the brief from collected Qloo evidence. Every number in the brief
// comes from a Qloo result (or the mock); the LLM only writes the narrative.

import type { QlooMode } from "../qloo/types.ts";
import { readDemographics, readEntities, readHeatmap, readTrends, toOverlapScores } from "./normalize.ts";
import { latestOfKind } from "./planner.ts";
import type { Brief, BriefInput, EvidenceItem, OpenerCandidate, Partner, TraceStep } from "./types.ts";

export const TOP_OPENERS = 5;
export const TOP_PARTNERS = 3;

export function buildBrief(args: {
  input: BriefInput;
  mode: QlooMode;
  agent: Brief["agent"];
  evidence: EvidenceItem[];
  trace: TraceStep[];
  narrative?: string;
  now?: Date;
}): Brief {
  const { input, evidence } = args;
  const resolved = latestOfKind(evidence, "resolve");
  const head = resolved ? readEntities(resolved.envelope.results)[0] : undefined;

  const trends = (() => {
    const t = latestOfKind(evidence, "trends");
    return t ? readTrends(t.envelope.results) : new Map();
  })();

  const rank = latestOfKind(evidence, "rank");
  const fallback = latestOfKind(evidence, "candidates");
  const pool = readEntities((rank ?? fallback)?.envelope.results)
    .filter((e) => e.name.trim().toLowerCase() !== input.headliner.trim().toLowerCase())
    .sort((a, b) => (b.affinity ?? 0) - (a.affinity ?? 0))
    .slice(0, TOP_OPENERS);
  const scores = toOverlapScores(pool.map((e) => e.affinity));
  const popularity = new Map(readEntities(fallback?.envelope.results).map((e) => [e.name, e.popularity]));
  const openers: OpenerCandidate[] = pool.map((e, i) => ({
    name: e.name,
    entityId: e.entityId,
    overlapScore: scores[i] ?? 0,
    affinity: e.affinity,
    popularity: e.popularity ?? popularity.get(e.name) ?? null,
    trend: trends.get(e.name) ?? "unknown",
  }));

  const partnersOf = (kind: "places" | "brands", label: Partner["kind"]): Partner[] => {
    const item = latestOfKind(evidence, kind);
    return readEntities(item?.envelope.results).slice(0, TOP_PARTNERS).map((e) => ({ name: e.name, kind: label, affinity: e.affinity }));
  };

  const heat = latestOfKind(evidence, "heatmap");
  const demo = latestOfKind(evidence, "demographics");
  const tags = latestOfKind(evidence, "tags");

  const partial = {
    input,
    mode: args.mode,
    agent: args.agent,
    headliner: { name: head?.name ?? input.headliner, entityId: head?.entityId, trend: trends.get(head?.name ?? input.headliner) ?? "unknown" },
    openers,
    heatmap: heat ? readHeatmap(heat.envelope.results) : [],
    demographics: demo ? readDemographics(demo.envelope.results) : null,
    partners: [...partnersOf("places", "place"), ...partnersOf("brands", "brand")],
    tasteTags: readEntities(tags?.envelope.results).map((t) => t.name).slice(0, 6),
    trace: args.trace,
    generatedAt: (args.now ?? new Date()).toISOString(),
  };
  return { ...partial, narrative: args.narrative ?? templateNarrative(partial), caveats: buildCaveats(partial, evidence) };
}

type BriefCore = Omit<Brief, "narrative" | "caveats">;

export function templateNarrative(b: BriefCore): string {
  if (b.openers.length === 0) return `No opener candidates came back for ${b.headliner.name} in ${b.input.city}. See the agent log for the status of each call.`;
  const top = b.openers[0] as OpenerCandidate;
  const rising = b.openers.filter((o) => o.trend === "rising").map((o) => o.name);
  const parts = [
    `${top.name} has the strongest audience affinity with ${b.headliner.name} among the ${b.openers.length} acts scored for ${b.input.city}.`,
    rising.length > 0 ? `Rising over the last 90 days: ${rising.join(", ")}.` : "None of the shortlisted acts shows a clear 90-day rise.",
  ];
  if (b.partners.length > 0) parts.push(`Partnership leads with the same audience: ${b.partners.map((p) => p.name).join(", ")}.`);
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
  if (b.input.capacity) out.push(`Capacity (${b.input.capacity}) is not a Qloo input; whether an opener can help fill it is your call.`);
  for (const e of evidence) {
    if (e.envelope.status === "error") out.push(`${e.tool} failed (${e.envelope.error?.code ?? "UNKNOWN"}); the related section may be missing.`);
    else if (e.envelope.status === "needs_input") out.push(`${e.tool}: Qloo could not pin down "${String(e.args.entity ?? e.args.signals ?? "")}" unambiguously; check the spelling or pick the intended entity.`);
    else if (e.envelope.status === "empty") out.push(`${e.tool} returned no results; the related section is empty, not zero.`);
    else if (e.envelope.status === "partial" || e.envelope.status === "degraded") out.push(`${e.tool} came back ${e.envelope.status}: ${e.envelope.summary ?? ""}`.trim());
  }
  return [...new Set(out)];
}
