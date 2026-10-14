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

/** Series of { entity, points[] } -> trend label per entity name and entity_id. */
export function readTrends(results: unknown): Map<string, Trend> {
  const out = new Map<string, Trend>();
  for (const item of asArray(results)) {
    const r = asRecord(item);
    const entityRec = asRecord(r?.entity);
    const name = entityRec?.name;
    // Live /v2/trending (harness 0.1.26, checked 2026-10-14) echoes the id as
    // entityId plus the input it was asked for; entity_id is the documented API field.
    const id = [entityRec?.entity_id, entityRec?.entityId].find((v) => typeof v === "string");
    if (typeof name !== "string" && typeof id !== "string") continue;
    const points = asArray(r?.points).length > 0 ? asArray(r?.points) : asArray(r?.series ?? r?.data);
    // Live /v2/trending returns weekly points newest first; classify in date order.
    const dated = points.some((p) => typeof asRecord(p)?.date === "string")
      ? [...points].sort((a, b) => String(asRecord(a)?.date ?? "").localeCompare(String(asRecord(b)?.date ?? "")))
      : points;
    const values = dated.flatMap((p) => {
      const pr = asRecord(p);
      const v = num(pr?.population_percentile) ?? num(pr?.popularity) ?? num(pr?.value);
      return v === null ? [] : [v];
    });
    const trend = classifyTrend(values);
    if (typeof name === "string") out.set(name, trend);
    if (typeof id === "string") out.set(id, trend);
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

/**
 * Relative fit, 0-100, across ONE rank call: 100 = the strongest act Qloo
 * ranked, 0 = the weakest of the same call (min-max). Live affinities for a
 * headliner's neighbours sit within ~0.01 of each other, so a ratio to the
 * leader shows 99-100 for everyone; the spread is what tells acts apart.
 * Scores from different calls are not comparable.
 */
export function toOverlapScores(affinities: (number | null)[]): number[] {
  const valid = affinities.filter((a): a is number => a !== null && a > 0);
  if (valid.length === 0) return affinities.map(() => 0);
  const max = Math.max(...valid);
  const min = Math.min(...valid);
  return affinities.map((a) => {
    if (a === null || a <= 0) return 0;
    return max === min ? 100 : Math.round(((a - min) / (max - min)) * 100);
  });
}

export interface TagLike {
  name: string;
  type?: string;
}

/** Tags with their Qloo tag family (e.g. urn:tag:genre:music). */
export function readTags(results: unknown): TagLike[] {
  return asArray(results).flatMap((item) => {
    const r = asRecord(item);
    if (!r || typeof r.name !== "string") return [];
    return [{ name: r.name.trim(), type: typeof r.type === "string" ? r.type : undefined }];
  });
}
