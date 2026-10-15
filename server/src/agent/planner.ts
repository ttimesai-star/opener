// Scripted planner: the evidence plan Opener needs for one brief. It runs on
// its own when no LLM is configured, and fills whatever the LLM agent skipped.
// Both scenarios use the same nine evidence kinds; only the anchor entity and
// a few arguments differ.

import type { QlooToolName } from "../qloo/types.ts";
import { readDemographics, readEntities, type EntityLike } from "./normalize.ts";
import { isCoHeadline, MIN_SUPPORT_ACTS, popularityLabel, supportCeilings } from "./popularity.ts";
import { headlinerRelations } from "./relations.ts";
import { subjectOf, type BriefInput, type EvidenceItem } from "./types.ts";

export type EvidenceKind =
  | "resolve" | "candidates" | "rank" | "trends" | "heatmap" | "demographics" | "places" | "brands" | "tags";

export const REQUIRED_KINDS: readonly EvidenceKind[] = [
  "resolve", "candidates", "rank", "trends", "heatmap", "demographics", "places", "brands", "tags",
];

// Live /v2/trending returns weekly points, newest first, capped by `limit`, and
// a 90-day window came back empty on 2026-10-13 while a 180-day one did not.
// So: query 180 days, keep the latest 13 weekly points (about 90 days).
export const TREND_QUERY_DAYS = 180;
export const TREND_POINTS = 13;

// Unfiltered place recommendations for a city come back as museums, memorials
// and landmarks (live, Berlin, 2026-10-13). Partners must be businesses a
// promoter can work with, so the place call is constrained to these Qloo
// category tags (URNs resolved through the harness on 2026-10-13; union).
export const PARTNER_PLACE_TAGS: readonly string[] = [
  "bar", "cocktail_bar", "pub", "brewery", "coffee_shop", "record_store", "clothing_store", "live_music_venue", "nightclub",
].map((t) => `urn:tag:category:place:${t}`);
// A venue does not cross-promote with competing rooms. Live, the generic "bar"
// category pulled in bar-and-concert venues (SO36 -> Badehaus, Schokoladen), so
// it is dropped too.
export const VENUE_PARTNER_PLACE_TAGS: readonly string[] = PARTNER_PLACE_TAGS.filter((t) => !/:(bar|live_music_venue|nightclub)$/.test(t));

// The tag filter is a union, so a room tagged both "pub" and "nightclub" still
// comes back: live, Antone's Nightclub was offered to Mohawk as a partner
// (2026-10-14). Harness results carry no tags, so a venue's partner leads are
// screened again by name and Qloo description.
const COMPETING_ROOM = /\b(?:night\s?clubs?|(?:live[- ])?music\s+venues?|concert\s+(?:halls?|venues?)|music\s+halls?|live[- ]music|amphitheat(?:er|re)s?|ballrooms?|opera\s+house|auditorium|arenas?|(?:blues|jazz|rock|dance|comedy|music|techno|punk|live|hip[- ]hop)\s+clubs?|disco(?:th[eè]que)?s?|(?:event|music|concert|live|performance)\s+(?:space|venue)s?|venues?)\b/i;

/** True for places that compete with a venue for the same shows (music venues, nightclubs, concert halls). */
export function isCompetingRoom(e: EntityLike): boolean {
  return COMPETING_ROOM.test(`${e.name} ${e.description ?? ""}`);
}

/** Adds the partner category filter to a place recommendation that has none (LLM or planner). */
export function withPartnerFilter(input: BriefInput, tool: QlooToolName, args: Record<string, unknown>): Record<string, unknown> {
  if (tool !== "qloo_recommend" || args.target_type !== "place") return args;
  if (Array.isArray(args.include_tags) && args.include_tags.length > 0) return args;
  const tags = input.scenario === "venue" ? VENUE_PARTNER_PLACE_TAGS : PARTNER_PLACE_TAGS;
  return { ...args, include_tags: [...tags], include_tags_operator: "union" };
}

// qloo_entity_tags mixes tag families (payment, price, dishes, amenities) with
// taste concepts. Keep only the families that describe an audience's taste.
const AUDIENCE_TAG_FAMILIES = [
  "urn:tag:genre:music", "urn:tag:audience:", "urn:tag:style:qloo", "urn:tag:theme:qloo", "urn:tag:keyword:media",
];
export function isAudienceTag(type: string | undefined): boolean {
  return typeof type === "string" && AUDIENCE_TAG_FAMILIES.some((f) => type.startsWith(f));
}
export const TAGS_QUERY_LIMIT = 20;

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

type Exclude = (e: EntityLike) => boolean;

/** Candidate names from the artist recommendation, excluding the subject (and acts that are part of it). */
export function candidateNames(evidence: EvidenceItem[], subject: string, max = 10, exclude?: Exclude): string[] {
  const rec = latestOfKind(evidence, "candidates");
  if (!rec) return [];
  return readEntities(rec.envelope.results).filter((e) => !same(e.name, subject) && !exclude?.(e)).map((e) => e.name).slice(0, max);
}

/**
 * Opener scenario: true for acts Qloo describes as part of the headliner
 * (members, solo and side projects). They are not openers. Venues: none.
 */
export function partOfHeadliner(input: BriefInput, evidence: EvidenceItem[]): Exclude | undefined {
  if (input.scenario !== "opener") return undefined;
  const resolvedName = readEntities(latestOfKind(evidence, "resolve")?.envelope.results)[0]?.name;
  const rel = headlinerRelations(evidence, [input.headliner, ...(resolvedName ? [resolvedName] : [])]);
  return (e) => rel.of(e)?.kind === "part-of";
}

/** Qloo popularity of the resolved headliner, when qloo_describe returned it. */
export function headlinerPopularity(evidence: EvidenceItem[]): number | null {
  return readEntities(latestOfKind(evidence, "resolve")?.envelope.results)[0]?.popularity ?? null;
}

/** Qloo lists an end year: the act no longer performs (live 15.10: "On a Friday", Radiohead's name until 1991). */
export const isInactive = (e: EntityLike): boolean => e.endYear !== undefined;

/**
 * Opener scenario: acts that are not a support act for this headliner. Members
 * and side projects always; acts at co-headline popularity (Beck, Arcade Fire
 * for Radiohead, demo 14.10) when Qloo recommended at least MIN_SUPPORT_ACTS
 * smaller ones. Venues: undefined (no headliner).
 */
export function notSupportAct(input: BriefInput, evidence: EvidenceItem[]): Exclude | undefined {
  const related = partOfHeadliner(input, evidence);
  // Venue: no headliner, but an act that has stopped cannot be booked either.
  if (!related) return isInactive;
  const partOf: Exclude = (e) => isInactive(e) || related(e);
  const head = headlinerPopularity(evidence);
  const recommended = readEntities(latestOfKind(evidence, "candidates")?.envelope.results).filter((e) => !same(e.name, input.scenario === "opener" ? input.headliner : "") && !partOf(e));
  const smaller = recommended.filter((e) => !isCoHeadline(e.popularity, head)).length;
  if (head === null || smaller < MIN_SUPPORT_ACTS) return partOf;
  return (e) => partOf(e) || isCoHeadline(e.popularity, head);
}

/**
 * The acts sent to qloo_rank. Opener: support acts only; from a pool under a
 * popularity ceiling in Qloo's affinity order, from the unfiltered harness pool
 * least popular first (so it leans to acts that fit under the headliner).
 * Venue: recommendation order.
 */
export function rankShortlist(input: BriefInput, evidence: EvidenceItem[], max = 10): string[] {
  const { name: s } = subjectOf(input);
  if (input.scenario !== "opener") return candidateNames(evidence, s, max, isInactive);
  const exclude = notSupportAct(input, evidence);
  const rec = latestOfKind(evidence, "candidates");
  const ceiling = typeof rec?.args.popularity_max === "number" ? rec.args.popularity_max : undefined;
  const acts = readEntities(rec?.envelope.results).filter((e) => !same(e.name, s) && !exclude?.(e)
    && (ceiling === undefined || e.popularity === null || e.popularity <= ceiling));
  // Under a popularity ceiling every act is already support-sized: keep Qloo's affinity order.
  if (ceiling !== undefined) return acts.slice(0, max).map((e) => e.name);
  const rank = (p: number | null) => (p === null ? Number.POSITIVE_INFINITY : p);
  return [...acts].sort((a, b) => rank(a.popularity) - rank(b.popularity)).slice(0, max).map((e) => e.name);
}

/** Qloo ids of the top ranked acts (names where no id came back). */
export function rankedRefs(evidence: EvidenceItem[], max: number, subject = "", exclude?: Exclude): string[] {
  const rank = latestOfKind(evidence, "rank") ?? latestOfKind(evidence, "candidates");
  if (!rank) return [];
  return readEntities(rank.envelope.results)
    .filter((e) => !same(e.name, subject) && !exclude?.(e))
    .sort((a, b) => (b.affinity ?? 0) - (a.affinity ?? 0))
    .map((e) => e.entityId ?? e.name)
    .slice(0, max);
}

/** Top names of the rank call; falls back to the recommendation order. */
export function rankedNames(evidence: EvidenceItem[], max: number, subject = "", exclude?: Exclude): string[] {
  const rank = latestOfKind(evidence, "rank");
  if (!rank) return candidateNames(evidence, subject, max, exclude);
  return readEntities(rank.envelope.results)
    .filter((e) => !same(e.name, subject) && !exclude?.(e))
    .sort((a, b) => (b.affinity ?? 0) - (a.affinity ?? 0))
    .map((e) => e.name)
    .slice(0, max);
}

/**
 * The resolved Qloo id of the subject, or its name when unresolved. Live Qloo
 * reports a bare name such as "Radiohead" as ambiguous (artist, person, album)
 * and returns needs_input, so signals carry the id from qloo_describe.
 */
export function subjectRef(evidence: EvidenceItem[], subject: string): string {
  const resolved = latestOfKind(evidence, "resolve");
  if (!resolved || resolved.envelope.status !== "ok") return subject;
  const hit = readEntities(resolved.envelope.results).find((e) => same(e.name, subject)) ?? readEntities(resolved.envelope.results)[0];
  return hit?.entityId ?? subject;
}

/**
 * Repair arguments a weaker LLM gets wrong (seen live 14.10 with Llama 3.3 70B):
 * numbers sent as strings ("limit": "12"), a rank call over 2 of the 12
 * recommended acts, place/brand recommendations with no taste signal at all.
 * The LLM still chooses which tool to call; the server makes the call well-formed.
 */
export function repairLlmArgs(input: BriefInput, evidence: EvidenceItem[], tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const a: Record<string, unknown> = { ...args };
  for (const k of ["limit", "take", "page"]) {
    const v = a[k];
    if (typeof v === "string" && /^\d+$/.test(v.trim())) a[k] = Number(v.trim());
  }
  const { name: s } = subjectOf(input);
  const ref = subjectRef(evidence, s);
  if (tool === "qloo_rank") {
    const shortlist = rankShortlist(input, evidence);
    const given = Array.isArray(a.options) ? a.options : [];
    // Opener: the support-slot shortlist is a booking rule, not a choice left to the model.
    if (shortlist.length > 0 && (input.scenario === "opener" || shortlist.length > given.length)) a.options = shortlist;
    if (!Array.isArray(a.signals) || a.signals.length === 0) a.signals = [ref];
    if (!a.signal_location) a.signal_location = input.city;
  }
  // Opener: the support-slot popularity ceiling is a booking rule too, not left to the model.
  if (tool === "qloo_recommend" && a.target_type === "artist" && input.scenario === "opener") {
    const ceiling = candidateCeilings(input, evidence)[0];
    if (ceiling !== undefined) {
      a.popularity_max = ceiling;
      if (!Array.isArray(a.signals) || a.signals.length === 0 || a.signals.every((x) => typeof x === "string" && same(x, s))) a.signals = [ref];
      if (!a.signal_location) a.signal_location = input.city;
      if (a.limit === undefined) a.limit = 20;
    } else delete a.popularity_max;
  } else delete a.popularity_max;
  if (tool === "qloo_recommend" && (a.target_type === "place" || a.target_type === "brand")) {
    if (!Array.isArray(a.signals) || a.signals.length === 0) a.signals = [ref];
  }
  return a;
}

/** Opener: the popularity ceilings for the candidate pool, from the resolved headliner (empty: unfiltered). */
export function candidateCeilings(input: BriefInput, evidence: EvidenceItem[]): number[] {
  return input.scenario === "opener" ? supportCeilings(headlinerPopularity(evidence)) : [];
}

/** Acts in a candidate result that can open: not the headliner, not part of it, still active, under the ceiling. */
export function usableSupportActs(input: BriefInput, evidence: EvidenceItem[], results: unknown, ceiling?: number): EntityLike[] {
  const { name: s } = subjectOf(input);
  const exclude = partOfHeadliner(input, evidence);
  return readEntities(results).filter((e) => !same(e.name, s) && !isInactive(e) && !exclude?.(e)
    // A client that ignored the filter must not slip stars back in.
    && (ceiling === undefined || e.popularity === null || e.popularity <= ceiling));
}

/**
 * The next candidate call after one that left too few support acts: the next
 * wider ceiling, then (null) the unfiltered harness recommendation, as before
 * the ceiling existed. undefined: nothing left to try. An error skips straight
 * to the harness: the direct call itself failed, a wider ceiling would too.
 */
export function nextCeiling(input: BriefInput, evidence: EvidenceItem[], tried: number, status: string): number | null | undefined {
  if (status === "error") return null;
  const later = candidateCeilings(input, evidence).filter((c) => c > tried);
  return later.length > 0 ? later[0] : null;
}

/** Purpose line for the agent log: what the ceiling means in "top %" terms. */
export function ceilingPurpose(headliner: string, city: string, ceiling: number, widened = false): string {
  return `${widened ? "Too few smaller acts; widening: " : "Smaller "}artists whose audiences overlap with ${headliner}'s, weighted to ${city}, outside Qloo's ${popularityLabel(ceiling)} by popularity (filter.popularity.max ${ceiling}; the harness has no such filter, so this call goes to /v2/insights)`;
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
  const ref = subjectRef(evidence, s);
  const notPart = notSupportAct(input, evidence);

  if (want("resolve")) {
    return { kind: "resolve", tool: "qloo_describe", args: { entity: s, type }, purpose: `Resolve ${venue ? "the venue" : "the headliner"} to a Qloo entity` };
  }
  // Venue names repeat across cities ("Mohawk": Austin, Bend, a college, a park).
  // When Qloo asks which one, retry once with the city in the name.
  const qualified = `${s} ${city}`;
  if (venue && latestOfKind(evidence, "resolve")?.envelope.status === "needs_input"
    && !evidence.some((e) => e.tool === "qloo_describe" && same(String(e.args.entity ?? ""), qualified))) {
    return { kind: "resolve", tool: "qloo_describe", args: { entity: qualified, type }, purpose: `"${s}" is ambiguous in Qloo; resolve it with the city` };
  }
  if (want("candidates")) {
    // Opener: support acts only, below the headliner's popularity (the agent widens the ceiling if too few come back).
    const ceiling = candidateCeilings(input, evidence)[0];
    if (ceiling !== undefined) {
      return {
        kind: "candidates", tool: "qloo_recommend",
        args: { target_type: "artist", signals: [ref], signal_location: city, limit: 20, popularity_max: ceiling },
        purpose: ceilingPurpose(s, city, ceiling),
      };
    }
    return {
      kind: "candidates", tool: "qloo_recommend",
      // Opener: 20 (the harness maximum) so the popularity spread leaves room for support acts.
      args: { target_type: "artist", signals: [ref], signal_location: city, limit: venue ? 12 : 20 },
      purpose: venue
        ? `Artists whose audiences overlap with the crowd that likes ${s}, weighted to ${city}`
        : `Artists whose audiences overlap with ${s}'s, weighted to ${city}`,
    };
  }
  const candidates = rankShortlist(input, evidence);
  if (want("rank") && candidates.length > 0) {
    return {
      kind: "rank", tool: "qloo_rank",
      args: { options: candidates, option_type: "artist", signals: [ref], signal_location: city },
      purpose: "Score the shortlist against one shared profile so scores are comparable",
    };
  }
  const trendEntities = venue ? rankedRefs(evidence, 5, s) : [ref, ...rankedRefs(evidence, 4, s, notPart)];
  if (want("trends") && have("rank") && trendEntities.length > 0) {
    const entities = trendEntities;
    return {
      kind: "trends", tool: "qloo_trends",
      args: { entities, entity_type: "artist", start_date: isoDaysAgo(TREND_QUERY_DAYS, today), end_date: isoDaysAgo(1, today), limit: TREND_POINTS },
      purpose: venue ? "Which shortlisted acts are rising over the last 90 days (momentum for the date)" : "Is the headliner and each top candidate rising over the last 90 days?",
    };
  }
  // Venue: whose fans to map is the top candidate's, so the room can see whether
  // that act's audience lives near it. Needs a candidate first.
  const mapTarget = venue ? rankedRefs(evidence, 1, s)[0] : ref;
  if (want("heatmap") && mapTarget) {
    return {
      kind: "heatmap", tool: "qloo_where_popular",
      args: { entity: mapTarget, entity_type: "artist", within: city, limit: 15 },
      // The purpose is shown in the agent log: name the act, not its Qloo id.
      purpose: venue ? `Where in ${city} the fans of the top candidate (${rankedNames(evidence, 1, s)[0] ?? mapTarget}) are concentrated` : `Where in ${city} the headliner's affinity is concentrated`,
    };
  }
  if (want("demographics")) {
    return {
      kind: "demographics", tool: "qloo_audience_demographics",
      args: { entity: venue ? ref : s, entity_type: type },
      purpose: venue ? "Aggregate age and gender skew of the venue's crowd" : "Aggregate age and gender skew of the headliner's audience",
    };
  }
  // Live Qloo returns no demographic breakdown for places (SO36, 2026-10-13:
  // status ok, empty results). Then describe the crowd through the act it
  // likes most, and the brief says so.
  const topAct = venue ? rankedNames(evidence, 1, s)[0] : undefined;
  const demo = latestOfKind(evidence, "demographics");
  if (venue && topAct && demo && readDemographics(demo.envelope.results) === null
    && !evidence.some((e) => e.tool === "qloo_audience_demographics" && e.args.entity_type === "artist")) {
    // Pass the act's Qloo id: the harness resolves a bare name by exact match,
    // and two acts with the same name come back as needs_input.
    const ranked = latestOfKind(evidence, "rank") ?? latestOfKind(evidence, "candidates");
    const topActRef = readEntities(ranked?.envelope.results).find((e) => same(e.name, topAct))?.entityId ?? topAct;
    return {
      kind: "demographics", tool: "qloo_audience_demographics",
      args: { entity: topActRef, entity_type: "artist" },
      purpose: `Qloo has no demographics for the venue itself; age and gender skew of fans of ${topAct}, the act its crowd likes most`,
    };
  }
  if (want("places")) {
    return {
      kind: "places", tool: "qloo_recommend",
      args: withPartnerFilter(input, "qloo_recommend", { target_type: "place", signals: [ref], filter_location: city, limit: 6 }),
      purpose: venue ? `Other places in ${city} the same crowd likes (cross-promotion leads)` : `Venues, bars and shops in ${city} that the same audience likes (partnership leads)`,
    };
  }
  // Brand recommendations with a place as the signal fail live (400,
  // QLOO_CONTRACT), so a venue's sponsor leads come from its top acts' audiences.
  const brandSignals = venue ? rankedRefs(evidence, 3, s) : [ref];
  const brandTried = evidence.some((e) => kindOf(e.tool, e.args) === "brands" && JSON.stringify(e.args.signals) === JSON.stringify(brandSignals));
  if (!have("brands") && !brandTried && brandSignals.length > 0) {
    return {
      kind: "brands", tool: "qloo_recommend",
      args: { target_type: "brand", signals: brandSignals, limit: 6 },
      purpose: `Brands with audience affinity to ${venue ? "the venue's crowd" : "the headliner"} (sponsor leads)`,
    };
  }
  if (want("tags")) {
    // A venue's own tags are amenities and cuisine; its crowd's taste vocabulary
    // comes from the acts that crowd likes most.
    const top = venue ? rankedRefs(evidence, 3, s) : [];
    return {
      kind: "tags", tool: "qloo_entity_tags",
      args: venue && top.length > 0
        ? { entities: top, entity_type: "artist", limit: TAGS_QUERY_LIMIT }
        : { entities: [ref], entity_type: type, limit: TAGS_QUERY_LIMIT },
      purpose: venue && top.length > 0
        ? "Taste concepts shared by the top acts the venue's crowd likes (for promo copy)"
        : "Taste concepts that characterise the audience (for promo copy)",
    };
  }
  return null;
}
