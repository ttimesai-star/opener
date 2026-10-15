// Builds the brief from collected Qloo evidence. Every number in the brief
// comes from a Qloo result (or the mock); the LLM only writes the narrative.

import type { QlooMode } from "../qloo/types.ts";
import { readDemographics, readEntities, readHeatmap, readTags, readTrends, toOverlapScores } from "./normalize.ts";
import { isAudienceTag, isCompetingRoom, kindOf, latestOfKind } from "./planner.ts";
import { CO_HEADLINE_FACTOR, isCoHeadline, MIN_SUPPORT_ACTS, popularityLabel } from "./popularity.ts";
import { sanitizeSecrets } from "./redact.ts";
import { headlinerRelations, type Relation } from "./relations.ts";
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
  /** Why the LLM handed over to the planner early (time budget, repeated call), for the caveats. */
  handover?: string;
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
  // Members, solo and side projects of the headliner are not openers (opener scenario).
  const relations = input.scenario === "opener" ? headlinerRelations(evidence, [subjectInput.name, subjectName]) : null;
  const scoredActs = readEntities(scored?.envelope.results).filter((e) => !isSubject(e.name));
  const related = new Map<string, Relation>();
  // The planner already keeps members out of the rank call; check the recommendation too so the brief says why.
  const recommended = scored === fallback ? [] : readEntities(fallback?.envelope.results).filter((e) => !isSubject(e.name));
  for (const e of [...scoredActs, ...recommended]) {
    if (related.has(e.entityId ?? e.name)) continue;
    const r = relations?.of(e);
    if (r) related.set(e.entityId ?? e.name, r);
  }
  const popularity = new Map(readEntities(fallback?.envelope.results).map((e) => [e.name, e.popularity]));
  const popOf = (e: { name: string; popularity: number | null }) => e.popularity ?? popularity.get(e.name) ?? null;
  // Acts Qloo lists with an end year have stopped performing; rank results may not carry the year, the recommendation does.
  const ended = new Map(readEntities(fallback?.envelope.results).filter((e) => e.endYear !== undefined).map((e) => [e.name.toLowerCase(), e.endYear as number]));
  for (const e of scoredActs) if (e.endYear !== undefined) ended.set(e.name.toLowerCase(), e.endYear);
  const notPart = scoredActs
    .filter((e) => related.get(e.entityId ?? e.name)?.kind !== "part-of" && !ended.has(e.name.toLowerCase()))
    .sort((a, b) => (b.affinity ?? 0) - (a.affinity ?? 0));
  // Opener: an act about as popular as the headliner is a co-headliner, not a support act.
  // Left out when enough smaller acts remain; otherwise kept and flagged.
  const headPop = input.scenario === "opener" ? head?.popularity ?? null : null;
  const co = (e: { name: string; popularity: number | null }) => isCoHeadline(popOf(e), headPop);
  const dropCoHeadline = notPart.some(co) || recommended.some(co)
    ? notPart.filter((e) => !co(e)).length >= MIN_SUPPORT_ACTS
    : false;
  const ranked = dropCoHeadline ? notPart.filter((e) => !co(e)) : notPart;
  // Named in the caveats: dropped here or already kept out of the rank call by the planner; or shown and flagged.
  const coHeadline = dropCoHeadline
    ? [...new Map([...notPart, ...recommended.filter((e) => related.get(e.entityId ?? e.name)?.kind !== "part-of")].filter(co).map((e) => [e.name.toLowerCase(), e])).values()]
    : notPart.filter(co);
  const scores = toOverlapScores(ranked.map((e) => e.affinity));
  const pool = ranked.slice(0, TOP_CANDIDATES);
  const candidates: Candidate[] = pool.map((e, i) => ({
    name: e.name,
    entityId: e.entityId,
    overlapScore: scores[i] ?? 0,
    affinity: e.affinity,
    popularity: popOf(e),
    trend: trendOf(trends, e.entityId, e.name) ?? "unknown",
  }));

  // A venue does not cross-promote with rooms that compete for the same shows.
  const competing: string[] = [];
  const partnersOf = (kind: "places" | "brands", label: Partner["kind"]): Partner[] => {
    const item = latestOfKind(evidence, kind);
    return readEntities(item?.envelope.results)
      .filter((e) => !isSubject(e.name)) // a venue is not its own partner
      .filter((e) => {
        if (kind !== "places" || input.scenario !== "venue" || !isCompetingRoom(e)) return true;
        competing.push(e.name);
        return false;
      })
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
      popularity: head?.popularity ?? null,
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
  const shown = new Set(pool.map((e) => e.entityId ?? e.name));
  const relationNotes = [...related.entries()].flatMap(([key, r]) => {
    // "Qloo describes it as part of Radiohead" read wrong for a person (demo 15.10); this reads right for a person or a band.
    if (r.kind === "part-of") return [`Left out ${r.act}, a member or side project of ${subjectName} according to Qloo's description ("${r.quote}"). Members and side projects are not openers.`];
    return shown.has(key) ? [`${r.act}'s Qloo description mentions ${subjectName} ("${r.quote}"); check it is not a member or side project before booking.`] : [];
  });
  if (headPop !== null && coHeadline.length > 0) {
    const list = coHeadline.map((e) => `${e.name} (${popularityLabel(popOf(e))})`).join(", ");
    const why = `Qloo popularity within ${CO_HEADLINE_FACTOR}x of ${subjectName}'s (${popularityLabel(headPop)})`;
    relationNotes.push(dropCoHeadline
      ? `Left out as co-headline level, ${why}: ${list}. A support slot needs a smaller act.`
      : `Shown although at co-headline level, ${why}, because Qloo returned too few smaller acts: ${list}.`);
  }
  // Opener: which popularity ceiling the candidate pool came from (filter.popularity.max, /v2/insights).
  const tries = evidence.filter((e) => kindOf(e.tool, e.args) === "candidates");
  const ceilings = tries.map((e) => e.args.popularity_max).filter((c): c is number => typeof c === "number");
  const usedCeiling = fallback?.args.popularity_max;
  if (input.scenario === "opener" && typeof usedCeiling === "number") {
    const widened = ceilings.length > 1 ? ` The first limit (outside the ${popularityLabel(Math.min(...ceilings))}) left fewer than ${MIN_SUPPORT_ACTS} usable acts, so it was widened.` : "";
    relationNotes.push(`Candidates are limited to acts outside Qloo's ${popularityLabel(usedCeiling)} by popularity (${subjectName}: ${popularityLabel(headPop)}), with Qloo's filter.popularity.max: a support act should draw a smaller crowd than the headliner, so bigger acts with a closer audience fit are left out on purpose.${widened}`);
  }
  // Unfiltered pool: say so when only very popular acts came back.
  const recommendedPops = readEntities(fallback?.envelope.results).filter((e) => !isSubject(e.name)).map((e) => e.popularity).filter((p): p is number => p !== null);
  if (input.scenario === "opener" && typeof usedCeiling !== "number" && recommendedPops.length > 0 && Math.min(...recommendedPops) >= 0.99) {
    const limited = tries.filter((e) => typeof e.args.popularity_max === "number");
    const failed = limited.some((e) => e.envelope.status === "error");
    const why = ceilings.length > 0
      ? `The call for smaller acts (${ceilings.map((c) => `outside the ${popularityLabel(c)}`).join(", then ")}) ${failed ? "failed" : `returned fewer than ${MIN_SUPPORT_ACTS} usable acts`}, so this is Qloo's unfiltered recommendation`
      : `${subjectName}'s Qloo popularity was not available to set a limit`;
    relationNotes.push(`Every act Qloo recommended here is in the top 1% by Qloo popularity (the least popular is ${popularityLabel(Math.min(...recommendedPops))}). ${why}; the shortlist ranks the least popular of them.`);
  }
  if (ended.size > 0) {
    const shownEnded = [...ended.entries()].map(([k, y]) => `${[...scoredActs, ...readEntities(fallback?.envelope.results)].find((e) => e.name.toLowerCase() === k)?.name ?? k} (${y})`);
    relationNotes.push(`Left out as no longer active (Qloo lists an end year): ${[...new Set(shownEnded)].join(", ")}.`);
  }
  if (competing.length > 0) relationNotes.push(`Left out of the partner leads as competing rooms (music venues, clubs): ${competing.join(", ")}.`);
  if (args.handover) relationNotes.push(`The scripted planner completed the evidence plan because ${args.handover}.`);
  if (relations?.blind(pool)) relationNotes.push(`Qloo returned no descriptions for the shortlisted acts, so members and side projects of ${subjectName} could not be screened out; check before booking.`);
  return { ...partial, narrative: args.narrative ?? templateNarrative(partial), caveats: buildCaveats(partial, evidence, relationNotes) };
}

type BriefCore = Omit<Brief, "narrative" | "caveats">;

export type TrendNote = Exclude<Trend, "unknown"> | "not checked" | "no trend data";

/**
 * A measured trend, or why there is none: the act was not in any trends call
 * that came back ("not checked"), or it was and Qloo had no series for it.
 */
export function trendNote(b: Pick<BriefCore, "trace">, act: { name: string; entityId?: string; trend: Trend }): TrendNote {
  if (act.trend !== "unknown") return act.trend;
  const asked = new Set(b.trace
    .filter((s) => s.tool === "qloo_trends" && s.status !== "error")
    .flatMap((s) => (Array.isArray(s.args.entities) ? s.args.entities.map(String) : [])));
  return (act.entityId && asked.has(act.entityId)) || asked.has(act.name) ? "no trend data" : "not checked";
}

export function templateNarrative(b: BriefCore): string {
  const venue = b.input.scenario === "venue";
  if (b.candidates.length === 0) {
    return `No candidates came back for ${b.subject.name} in ${b.input.city}. See the agent log for the status of each call.`;
  }
  const top = b.candidates[0] as Candidate;
  const notes = b.candidates.map((o) => ({ name: o.name, note: trendNote(b, o) }));
  const rising = notes.filter((o) => o.note === "rising").map((o) => o.name);
  const measured = notes.filter((o) => o.note === "rising" || o.note === "flat" || o.note === "falling");
  const notChecked = notes.filter((o) => o.note === "not checked").map((o) => o.name);
  const noData = notes.filter((o) => o.note === "no trend data").map((o) => o.name);
  const trendParts: string[] = [];
  if (rising.length > 0) trendParts.push(`Rising over the last 90 days: ${rising.join(", ")}.`);
  else if (measured.length > 0) {
    trendParts.push(measured.length === notes.length
      ? "None of the shortlisted acts shows a clear 90-day rise."
      : `None of the ${measured.length} acts with trend data shows a clear 90-day rise.`);
  }
  // An act without a measured trend is unknown, never "not rising".
  if (notChecked.length > 0) trendParts.push(notChecked.length === notes.length ? "90-day trends were not checked for the shortlisted acts." : `90-day trend not checked for ${notChecked.join(", ")}.`);
  if (noData.length > 0) trendParts.push(`Qloo returned no 90-day trend data for ${noData.join(", ")}.`);
  const base = b.scoreSource === "recommend"
    ? `among the ${b.rankedCount} acts Qloo recommended for ${b.input.city} (the rank call failed, so these are recommendation affinities)`
    : `among the ${b.rankedCount} acts Qloo ranked for ${b.input.city}`;
  const parts = [
    venue
      ? `${top.name} has the strongest affinity with the crowd that likes ${b.subject.name} ${base}.`
      : `${top.name} has the strongest audience affinity with ${b.subject.name} ${base}.`,
    ...trendParts,
  ];
  if (b.partners.length > 0) parts.push(`${venue ? "Cross-promotion" : "Partnership"} leads with the same audience: ${b.partners.map((p) => p.name).join(", ")}.`);
  return parts.join(" ");
}

/** "What this does NOT prove" - fixed limits plus anything the evidence itself flagged. */
export function buildCaveats(b: BriefCore, evidence: EvidenceItem[], notes: string[] = []): string[] {
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
  out.push(...notes);
  return [...new Set(out.map((str) => sanitizeSecrets(str)))];
}
