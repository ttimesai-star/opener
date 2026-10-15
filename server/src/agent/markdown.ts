// Markdown export of a brief. Names come from Qloo (or the mock), so every
// value is escaped: a name must not be able to inject links, HTML or table cells.

import { popularityLabel } from "./popularity.ts";
import { agentRunLabel, withCity } from "./titles.ts";
import type { Brief } from "./types.ts";

/** Escapes Markdown/HTML control characters and flattens whitespace. */
export function md(text: unknown): string {
  return String(text ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\\`*_{}[\]()<>#+!|~]/g, (c) => `\\${c}`)
    .trim();
}

const TREND = { rising: "rising", falling: "falling", flat: "flat", unknown: "n/a" } as const;
const pct = (v: number | null | undefined) => md(popularityLabel(v));
const signed = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2)}`;

export function titleOf(brief: Brief): string {
  return brief.input.scenario === "venue"
    ? `Booking brief: ${withCity(brief.subject.name, brief.input.city)}${brief.input.date ? `, ${brief.input.date}` : ""}`
    : `Opener brief: ${brief.subject.name} in ${brief.input.city}`;
}

export function briefToMarkdown(brief: Brief, permalink?: string): string {
  const venue = brief.input.scenario === "venue";
  const L: string[] = [];
  L.push(`# ${md(titleOf(brief))}`, "");
  const meta = [`Generated ${brief.generatedAt.slice(0, 16).replace("T", " ")} UTC`, `data: ${brief.mode === "mock" ? "synthetic demo (not Qloo)" : "Qloo Insights API"}`, `run by: ${agentRunLabel(brief.agent)}`];
  if (brief.input.capacity) meta.push(`capacity: ${brief.input.capacity}`);
  L.push(`_${meta.join(" · ")}_`, ""); // fixed text and validated numbers only
  if (permalink) L.push(`Permalink (expires): ${permalink}`, "");
  L.push(md(brief.narrative), "");

  L.push(`## ${venue ? "Acts to book" : "Top opener candidates"}`, "");
  if (brief.candidates.length === 0) L.push("No candidates returned.", "");
  else {
    L.push("| # | Act | Audience fit (0-100) | Qloo popularity | 90-day trend |", "| - | --- | --- | --- | --- |");
    brief.candidates.forEach((c, i) => L.push(`| ${i + 1} | ${md(c.name)} | ${c.overlapScore} | ${pct(c.popularity)} | ${TREND[c.trend]} |`));
    const n = brief.rankedCount ?? 0;
    const recommended = brief.scoreSource === "recommend";
    const base = n > 1 ? ` of the ${n} acts Qloo ${recommended ? "recommended" : "ranked"}` : "";
    L.push("", `Audience fit: 100 = strongest${base}, 0 = weakest; relative within this brief.${recommended ? " The rank call failed, so scores come from the artist recommendation." : ""}`, "");
  }
  if (!venue) L.push(`Headliner trend (90 days): ${TREND[brief.subject.trend]}${typeof brief.subject.popularity === "number" ? ` · headliner Qloo popularity: ${pct(brief.subject.popularity)}` : ""}`, "");

  L.push("## Where the fans are", "");
  if (brief.heatmap.length === 0) L.push("No geographic data returned.", "");
  else {
    L.push(`Fans of ${md(brief.heatmapOf ?? brief.subject.name)} in ${md(brief.input.city)}: ${brief.heatmap.length} areas with relative affinity (strongest = 100). Top areas:`, "");
    for (const p of brief.heatmap.slice(0, 5)) L.push(`- ${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}: ${Math.round(p.weight * 100)}`);
    L.push("");
  }

  L.push(`## Audience skew${venue ? " (venue crowd)" : ""}`, "");
  if (!brief.demographics) L.push("No demographic data returned.", "");
  else {
    const row = (title: string, data: Record<string, number>) => {
      const entries = Object.entries(data);
      if (entries.length) L.push(`- ${title}: ${entries.map(([k, v]) => `${md(k.replace(/_/g, " "))} ${signed(v)}`).join(", ")}`);
    };
    row("Age", brief.demographics.age);
    row("Gender", brief.demographics.gender);
    L.push("", "Positive = over-indexed, negative = under-indexed, aggregate only.", "");
    if (brief.demographicsOf) L.push(`Qloo has no demographics for the venue itself; this is the skew of fans of ${md(brief.demographicsOf)}, the act its crowd likes most.`, "");
  }
  if (brief.tasteTags.length) L.push(`Taste tags: ${brief.tasteTags.map(md).join(", ")}`, "");

  L.push(`## ${venue ? "Cross-promotion and sponsor leads" : "Local partners"}`, "");
  if (brief.partners.length === 0) L.push("No partner leads returned.", "");
  else {
    for (const p of brief.partners) L.push(`- ${p.kind}: ${md(p.name)}`);
    L.push("");
  }

  L.push("## What this does not prove", "");
  for (const c of brief.caveats) L.push(`- ${md(c)}`);
  L.push("");

  L.push("## Agent log", "");
  for (const s of brief.trace) {
    L.push(`${s.index}. \`${s.tool}\` (${s.actor}) - ${s.status}, ${s.durationMs} ms - ${md(s.purpose ?? s.summary)}`);
  }
  if (brief.llmCalls.length) {
    L.push("", `LLM calls: ${brief.llmCalls.length} (${brief.llmCalls.filter((c) => c.status === "ok").length} ok).`);
  }
  L.push("", "---", "Built with Opener on Qloo's Insights API. Aggregate taste affinities only, never individuals.", "");
  return L.join("\n");
}
