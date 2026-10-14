// Qloo `popularity` is a percentile between 0 and 1. Live, every act Qloo
// recommended for Radiohead in Berlin sat between 0.9986 and 0.99999
// (2026-10-14), so "percent" rounding showed 100 for all of them. The useful
// scale near the top is the share of entities at least as popular: "top 0.14 %".
// No browser or Node dependencies: the web app imports the label too.

/** An act whose "top %" is less than this many times the headliner's is co-headline level, not a support act. */
export const CO_HEADLINE_FACTOR = 10;
/** Co-headline acts are left out only when at least this many smaller acts remain. */
export const MIN_SUPPORT_ACTS = 5;

/**
 * True when the act is about as popular as the headliner or more (within
 * CO_HEADLINE_FACTOR on the "top %" scale). The window is capped at the top
 * half: for a top-10% headliner, 10x would otherwise cover every act (Jules review 2026-10-15).
 */
export function isCoHeadline(act: number | null | undefined, headliner: number | null | undefined): boolean {
  if (typeof act !== "number" || typeof headliner !== "number" || !Number.isFinite(act) || !Number.isFinite(headliner)) return false;
  return act >= headliner || 1 - act < Math.min(0.5, CO_HEADLINE_FACTOR * (1 - headliner));
}

/** "top 0.14%": the share of Qloo entities at least as popular. */
export function popularityLabel(p: number | null | undefined): string {
  if (typeof p !== "number" || !Number.isFinite(p)) return "n/a";
  const top = Math.min(100, Math.max(0, (1 - p) * 100));
  if (top >= 1) return `top ${Math.round(top)}%`;
  if (top < 0.0001) return "top <0.0001%";
  return `top ${Number(top.toPrecision(2)).toString()}%`;
}
