import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyTrend, readDemographics, readEntities, readHeatmap, readTags, readTrends, toOverlapScores } from "../src/agent/normalize.ts";
import { isAudienceTag, withPartnerFilter, PARTNER_PLACE_TAGS, VENUE_PARTNER_PLACE_TAGS } from "../src/agent/planner.ts";

test("fit scores spread min-max across one rank call", () => {
  assert.deepEqual(toOverlapScores([0.8, 0.4, null, 0.2]), [100, 33, 0, 0]);
  assert.deepEqual(toOverlapScores([null, null]), [0, 0]);
  assert.deepEqual(toOverlapScores([0.7, 0.7]), [100, 100]);
  // Live affinities bunch within ~0.01; the scale must still separate them.
  const live = [0.9744, 0.9719, 0.9717, 0.9664, 0.9655, 0.9600];
  const s = toOverlapScores(live);
  assert.equal(s[0], 100);
  assert.equal(s[5], 0);
  assert.ok(s[3]! < 50 && s[1]! > 75, `spread ${s.join(",")}`);
});

test("audience tags: taste families kept, payment/price/dish/amenity dropped (live 2026-10-13)", () => {
  const live = readTags([
    { name: "surrealism", type: "urn:tag:keyword:media" },
    { name: "VISA", type: "urn:tag:credit_card:place" },
    { name: "Bar", type: "urn:tag:genre:place" },
    { name: "Os A Moelle", type: "urn:tag:specialty_dish:place" },
    { name: "Inexpensive", type: "urn:tag:cost_description:place" },
    { name: "Two Star", type: "urn:tag:hotel_rating:place" },
    { name: "Cultivated", type: "urn:tag:audience:qloo" },
    { name: "Cerebral", type: "urn:tag:style:qloo" },
    { name: " indie rock", type: "urn:tag:genre:music" },
    { name: "Musician", type: "urn:tag:genre:person" },
    { name: "Vegan", type: "urn:tag:dietary_option:qloo" },
    { name: "no type" },
  ]);
  assert.deepEqual(live.filter((t) => isAudienceTag(t.type)).map((t) => t.name), ["surrealism", "Cultivated", "Cerebral", "indie rock"]);
});

test("partner places are restricted to category tags; venues skip competing rooms", () => {
  const opener = { scenario: "opener" as const, headliner: "X", city: "Berlin" };
  const venue = { scenario: "venue" as const, venue: "Hall", city: "Berlin" };
  const a = withPartnerFilter(opener, "qloo_recommend", { target_type: "place", filter_location: "Berlin" });
  assert.deepEqual(a.include_tags, PARTNER_PLACE_TAGS);
  assert.equal(a.include_tags_operator, "union");
  const v = withPartnerFilter(venue, "qloo_recommend", { target_type: "place" });
  assert.deepEqual(v.include_tags, VENUE_PARTNER_PLACE_TAGS);
  assert.ok(!(v.include_tags as string[]).some((t) => t.includes("live_music_venue")));
  // Explicit tags and other calls are left alone.
  assert.deepEqual(withPartnerFilter(opener, "qloo_recommend", { target_type: "place", include_tags: ["urn:tag:category:place:pub"] }).include_tags, ["urn:tag:category:place:pub"]);
  assert.equal(withPartnerFilter(opener, "qloo_recommend", { target_type: "brand" }).include_tags, undefined);
  assert.equal(withPartnerFilter(opener, "qloo_rank", { target_type: "place" }).include_tags, undefined);
});

test("trend classification", () => {
  assert.equal(classifyTrend([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]), "rising");
  assert.equal(classifyTrend([0.6, 0.5, 0.4, 0.3, 0.2, 0.1]), "falling");
  assert.equal(classifyTrend([0.5, 0.5, 0.5, 0.5]), "flat");
  assert.equal(classifyTrend([0.5]), "unknown");
});

test("entities: affinity from top level or query.affinity", () => {
  const out = readEntities([{ name: "A", entity_id: "1", affinity: 0.9 }, { name: "B", query: { affinity: 0.5 } }, { nope: 1 }]);
  assert.deepEqual(out.map((e) => [e.name, e.affinity]), [["A", 0.9], ["B", 0.5]]);
});

test("entities: results wrapped in an object", () => {
  assert.equal(readEntities({ entities: [{ name: "X" }] }).length, 1);
});

test("heatmap weights normalised to 0-1 and bad points dropped", () => {
  const pts = readHeatmap([
    { location: { latitude: 1, longitude: 2 }, query: { affinity: 0.5 } },
    { location: { latitude: 3, longitude: 4 }, query: { affinity: 0.25 } },
    { location: {}, query: { affinity: 1 } },
  ]);
  assert.deepEqual(pts, [{ lat: 1, lng: 2, weight: 1 }, { lat: 3, lng: 4, weight: 0.5 }]);
});

test("demographics read age and gender maps", () => {
  const d = readDemographics([{ query: { age: { "25_to_29": 0.2, bad: "x" }, gender: { female: 0.1 } } }]);
  assert.deepEqual(d, { age: { "25_to_29": 0.2 }, gender: { female: 0.1 } });
  assert.equal(readDemographics([]), null);
});

test("heatmap accepts lat/lon and GeoJSON coordinates", () => {
  const pts = readHeatmap([
    { location: { lat: 1, lon: 2 }, query: { affinity: 1 } },
    { location: { coordinates: [4, 3] }, query: { affinity: 0.5 } },
  ]);
  assert.deepEqual(pts, [{ lat: 1, lng: 2, weight: 1 }, { lat: 3, lng: 4, weight: 0.5 }]);
});

test("demographics wrapped in a demographics object", () => {
  assert.deepEqual(readDemographics({ demographics: { age: { "25_to_29": 0.3 }, gender: {} } }), { age: { "25_to_29": 0.3 }, gender: {} });
});

test("trends: live points arrive newest first and are classified in date order", () => {
  const points = [
    { date: "2026-10-07", population_percentile: 0.6 },
    { date: "2026-09-30", population_percentile: 0.5 },
    { date: "2026-09-23", population_percentile: 0.4 },
    { date: "2026-09-16", population_percentile: 0.3 },
  ];
  assert.equal(readTrends([{ entity: { name: "X" }, points }]).get("X"), "rising");
});

test("trends: live entity shape (entityId, input, match) is keyed by id and by name (live check 2026-10-14)", () => {
  const points = Array.from({ length: 6 }, (_, i) => ({ date: `2026-10-0${6 - i}`, population_percentile: 0.9 - i * 0.05 }));
  const id = "70CAE5BF-2F4C-445C-A3E5-4EDACFC3591C";
  const t = readTrends([{ entity: { input: id, entityId: id, name: "Radiohead", type: "urn:entity:artist", match: "identifier" }, points }]);
  assert.equal(t.get(id), "rising");
  assert.equal(t.get("Radiohead"), "rising");
});
