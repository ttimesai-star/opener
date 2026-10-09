// Defensive readers for harness results. The harness passes some Qloo payloads
// through as-is (heatmap points, demographics, trending), so field names can
// differ from the mock. Keep all shape knowledge here.

import type { Demographics, HeatPoint, Trend } from "./types.ts";

type Rec = Record<string, unknown>;

export function asRecord(v: unknown): Rec | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined;
}

export function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  const r = asRecord(v);
  if (!r) return [];
  for (const key of ["entities", "heatmap", "demographics", "trending", "tags", "items", "series", "data"]) {
    if (Array.isArray(r[key])) return r[key] as unknown[];
  }
  return [];
}

export function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export interface EntityLike {
  name: string;
  entityId?: string;
  affinity: number | null;
  popularity: number | null;
}

export function readEntities(results: unknown): EntityLike[] {
  return asArray(results).flatMap((item) => {
    const r = asRecord(item);
    if (!r || typeof r.name !== "string") return [];
    const query = asRecord(r.query);
    return [{
      name: r.name,
      entityId: typeof r.entity_id === "string" ? r.entity_id : undefined,
      affinity: num(r.affinity) ?? num(query?.affinity),
      popularity: num(r.popularity),
    }];
  });
}

export function readHeatmap(results: unknown): HeatPoint[] {
  const raw = asArray(results).flatMap((item) => {
    const r = asRecord(item);
    const loc = asRecord(r?.location);
    const query = asRecord(r?.query);
    // Accept latitude/longitude, lat/lng|lon, or GeoJSON-style coordinates [lng, lat].
    const coords = Array.isArray(loc?.coordinates) ? (loc?.coordinates as unknown[]) : [];
    const lat = num(loc?.latitude) ?? num(loc?.lat) ?? num(coords[1]);
    const lng = num(loc?.longitude) ?? num(loc?.lng) ?? num(loc?.lon) ?? num(coords[0]);
    const w = num(query?.affinity) ?? num(r?.affinity);
    return lat !== null && lng !== null && w !== null ? [{ lat, lng, weight: w }] : [];
  });
  const max = Math.max(0, ...raw.map((p) => p.weight));
  return max > 0 ? raw.map((p) => ({ ...p, weight: Number((p.weight / max).toFixed(3)) })) : raw;
}

export function readDemographics(results: unknown): Demographics | null {
  const first = asRecord(asArray(results)[0]) ?? asRecord(asRecord(results)?.demographics);
  const query = asRecord(first?.query) ?? asRecord(first?.demographics) ?? first;
  const age = asRecord(query?.age);
  const gender = asRecord(query?.gender);
  if (!age && !gender) return null;
  const clean = (r: Rec | undefined) =>
    Object.fromEntries(Object.entries(r ?? {}).flatMap(([k, v]) => (num(v) === null ? [] : [[k, v as number]])));
  return { age: clean(age), gender: clean(gender) };
}

/** Series of { entity, points[] } -> trend label per entity name. */
export function readTrends(results: unknown): Map<string, Trend> {
  const out = new Map<string, Trend>();
  for (const item of asArray(results)) {
    const r = asRecord(item);
    const name = asRecord(r?.entity)?.name;
    if (typeof name !== "string") continue;
    const points = asArray(r?.points).length > 0 ? asArray(r?.points) : asArray(r?.series ?? r?.data);
    const values = points.flatMap((p) => {
      const pr = asRecord(p);
      const v = num(pr?.population_percentile) ?? num(pr?.popularity) ?? num(pr?.value);
      return v === null ? [] : [v];
    });
    out.set(name, classifyTrend(values));
  }
  return out;
}

/** Compares the mean of the last third with the first third. */
export function classifyTrend(values: number[], threshold = 0.03): Trend {
  if (values.length < 3) return "unknown";
  const third = Math.max(1, Math.floor(values.length / 3));
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const delta = mean(values.slice(-third)) - mean(values.slice(0, third));
  if (delta > threshold) return "rising";
  if (delta < -threshold) return "falling";
  return "flat";
}

/** Scales affinities from ONE rank call to 0-100. Scores from different calls are not comparable. */
export function toOverlapScores(affinities: (number | null)[]): number[] {
  // Score = affinity relative to the strongest candidate in the same call.
  // No stretching: a candidate at 0.5x the leader's affinity shows 50.
  const valid = affinities.filter((a): a is number => a !== null && a > 0);
  if (valid.length === 0) return affinities.map(() => 0);
  const max = Math.max(...valid);
  return affinities.map((a) => (a === null || a <= 0 ? 0 : Math.round((a / max) * 100)));
}
