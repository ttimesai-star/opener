import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyTrend, readDemographics, readEntities, readHeatmap, readTrends, toOverlapScores } from "../src/agent/normalize.ts";

test("overlap scores are relative to the leader, not stretched", () => {
  assert.deepEqual(toOverlapScores([0.8, 0.4, null, 0.2]), [100, 50, 0, 25]);
  assert.deepEqual(toOverlapScores([null, null]), [0, 0]);
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
