import assert from "node:assert/strict";
import { test } from "node:test";
import { titleOf } from "../src/agent/markdown.ts";
import { withCity } from "../src/agent/titles.ts";
import type { Brief } from "../src/agent/types.ts";

test("venue title does not repeat the city when Qloo's name carries it (demo 14.10: 'Mohawk Austin, Austin')", () => {
  assert.equal(withCity("Mohawk Austin", "Austin"), "Mohawk Austin");
  assert.equal(withCity("Mohawk", "Austin"), "Mohawk, Austin");
  assert.equal(withCity("Mohawk austin", "AUSTIN"), "Mohawk austin");
  // Only as a whole word: "Bern" is not in "Bernie's".
  assert.equal(withCity("Bernie's Bar", "Bern"), "Bernie's Bar, Bern");
  assert.equal(withCity("Café São Paulo", "São Paulo"), "Café São Paulo");
  assert.equal(withCity("Hall", ""), "Hall");
  const brief = { input: { scenario: "venue", venue: "Mohawk", city: "Austin", date: "2026-11-14" }, subject: { name: "Mohawk Austin" } } as unknown as Brief;
  assert.equal(titleOf(brief), "Booking brief: Mohawk Austin, 2026-11-14");
});
