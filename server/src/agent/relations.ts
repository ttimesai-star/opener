// An opener has to be a different act. Live Qloo (Radiohead, 2026-10-14)
// recommended the headliner's own lead singer as an opener; harness results
// carry no member relations, only a short description per entity, so the
// relation is read from that text. A clear statement ("lead vocalist of X",
// "side project of X", "formed by X's ...") excludes the act; a bare mention
// of the headliner only raises a warning in the brief.

import type { EntityLike } from "./normalize.ts";
import type { EvidenceItem } from "./types.ts";
import { readEntities } from "./normalize.ts";

export interface Relation {
  act: string;
  /** part-of: excluded from the shortlist; mentions: kept, flagged for a human check. */
  kind: "part-of" | "mentions";
  /** The phrase of the Qloo description that triggered it (one short line). */
  quote: string;
}

const ROLES = [
  "founding member", "member", "members", "co-founder", "founder", "lead singer", "singer", "lead vocalist", "vocalist",
  "frontman", "frontwoman", "front man", "front woman", "guitarist", "bassist", "drummer", "keyboardist", "songwriter",
  "side project", "side-project", "solo project", "offshoot", "spin-off", "spinoff", "supergroup",
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** First letter either case, the rest as written: role words start sentences too. */
const anyFirst = (w: string) => `[${w[0]?.toUpperCase()}${w[0]?.toLowerCase()}]${escape(w.slice(1))}`;
const ROLE = `(?:${[...ROLES].sort((a, b) => b.length - a.length).map(anyFirst).join("|")})`;

/** A name as a proper noun: case as written, optional leading "The", not inside a longer word. */
function namePattern(name: string): string | null {
  const bare = name.trim().replace(/^the\s+/i, "");
  if (bare.length < 2) return null;
  return `(?<![\\p{L}\\p{N}])(?:[Tt]he\\s+)?${escape(bare)}(?![\\p{L}\\p{N}])`;
}

function quoteAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 40);
  return `${start > 0 ? "..." : ""}${text.slice(start, end).trim()}${end < text.length ? "..." : ""}`;
}

/**
 * How an act relates to the headliner, judged from Qloo descriptions only.
 * names: the headliner as typed and as Qloo resolved it.
 */
export function relationToHeadliner(act: EntityLike, names: string[], headlinerDescription?: string): Relation | null {
  const patterns = [...new Set(names)].map(namePattern).filter((p): p is string => p !== null);
  if (patterns.length === 0) return null;
  const head = `(?:${patterns.join("|")})`;
  const text = act.description ?? "";
  const partOf = [
    // "lead vocalist of Radiohead", "vocalist and songwriter of the rock band Radiohead", "side project of X"
    new RegExp(`\\b${ROLE}(?:,?\\s+(?:and|&)\\s+[\\p{L}-]+(?:\\s+[\\p{L}-]+)?)?\\s+(?:of|for|in|from|with)\\s+(?:(?:the|a|an)\\s+)?(?:(?:[\\p{L}-]+\\s+){0,3}?(?:band|group|duo|trio|outfit|collective)\\s+)?${head}`, "u"),
    // "Radiohead frontman", "Radiohead's lead singer"
    new RegExp(`${head}(?:['’]s)?\\s+(?:lead\\s+|founding\\s+|former\\s+)?${ROLE}\\b`, "u"),
    // "formed by Radiohead's Thom Yorke"
    new RegExp(`\\b(?:[Ff]ormed|[Ff]ounded|[Ff]ronted|[Ll]ed|[Ss]tarted)\\s+by\\s+[^.;]{0,40}?${head}`, "u"),
  ];
  for (const re of partOf) {
    const m = re.exec(text);
    if (m) return { act: act.name, kind: "part-of", quote: quoteAround(text, m.index, m[0].length) };
  }
  // The headliner's own description listing the act: "consisting of A, B and C".
  const actName = namePattern(act.name);
  if (headlinerDescription && actName && act.name.trim().length >= 5) {
    const re = new RegExp(`\\b(?:[Cc]onsist\\w*\\s+of|[Mm]embers?\\b|[Ll]ine-?up|[Ff]eaturing|[Ff]ronted\\s+by|[Ll]ed\\s+by|[Ff]ormed\\s+by|[Ff]ounded\\s+by)[^.;]{0,120}?${actName}`, "u");
    const m = re.exec(headlinerDescription);
    if (m) return { act: act.name, kind: "part-of", quote: quoteAround(headlinerDescription, m.index, m[0].length) };
  }
  const mention = new RegExp(head, "u").exec(text);
  if (mention) return { act: act.name, kind: "mentions", quote: quoteAround(text, mention.index, mention[0].length) };
  return null;
}

const lower = (s: string) => s.trim().toLowerCase();

/**
 * Relation checker for one brief (opener scenario only; a venue has no
 * members). Descriptions are gathered from every entity result in the
 * evidence, because rank results may not carry them.
 */
export function headlinerRelations(evidence: EvidenceItem[], headlinerNames: string[]): {
  of: (e: EntityLike) => Relation | null;
  /** True when no candidate act came with a description, so nothing could be screened. */
  blind: (acts: EntityLike[]) => boolean;
} {
  const byId = new Map<string, string>();
  const byName = new Map<string, string>();
  let headDescription: string | undefined;
  const heads = new Set(headlinerNames.map(lower));
  for (const item of evidence) {
    if (item.envelope.status === "error") continue;
    for (const e of readEntities(item.envelope.results)) {
      if (!e.description) continue;
      if (e.entityId && !byId.has(e.entityId)) byId.set(e.entityId, e.description);
      if (!byName.has(lower(e.name))) byName.set(lower(e.name), e.description);
      if (item.tool === "qloo_describe" && heads.has(lower(e.name))) headDescription ??= e.description;
    }
  }
  const describe = (e: EntityLike): EntityLike => ({ ...e, description: e.description ?? (e.entityId ? byId.get(e.entityId) : undefined) ?? byName.get(lower(e.name)) });
  return {
    of: (e) => relationToHeadliner(describe(e), headlinerNames, headDescription),
    blind: (acts) => acts.length > 0 && acts.every((a) => !describe(a).description),
  };
}
