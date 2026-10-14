import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgent } from "../src/agent/agent.ts";
import { quoteAround, relationToHeadliner } from "../src/agent/relations.ts";
import { MockQlooClient } from "../src/qloo/mockClient.ts";
import type { QlooClient, QlooEnvelope } from "../src/qloo/types.ts";

// Descriptions are synthetic paraphrases of the shapes seen live, not Qloo data.
const act = (name: string, description?: string) => ({ name, affinity: 0.9, popularity: 0.5, ...(description ? { description } : {}) });
const HEAD = ["radiohead", "Radiohead"];

test("relation: members, solo and side projects are part of the headliner", () => {
  const cases: [string, string][] = [
    ["Thom Yorke", "English singer and songwriter, best known as the lead vocalist of Radiohead."],
    ["Singer B", "Musician known as the vocalist and songwriter of the rock band Radiohead."],
    ["The Side", "A side project of Radiohead guitarist C."],
    ["Trio D", "Band formed by Radiohead's two members with a jazz drummer."],
    ["E Solo", "Radiohead frontman's solo work."],
  ];
  for (const [name, text] of cases) assert.equal(relationToHeadliner(act(name, text), HEAD)?.kind, "part-of", `${name}: ${text}`);
});

test("relation: comparisons and influences are only a mention; unrelated text is nothing", () => {
  assert.equal(relationToHeadliner(act("F", "Singer-songwriter whose sound is often compared to Radiohead."), HEAD)?.kind, "mentions");
  assert.equal(relationToHeadliner(act("G", "A songwriter in the vein of Radiohead."), HEAD)?.kind, "mentions");
  assert.equal(relationToHeadliner(act("H", "Toured with Radiohead in 2003."), HEAD)?.kind, "mentions");
  assert.equal(relationToHeadliner(act("I", "Dream pop band from Leeds."), HEAD), null);
  // A proper noun match only: lowercase words are not the band "Low".
  assert.equal(relationToHeadliner(act("J", "A singer known for low-key ballads."), ["Low"]), null);
  assert.equal(relationToHeadliner(act("K", "Former drummer of Low."), ["Low"])?.kind, "part-of");
});

test("relation: the headliner's own description listing the act", () => {
  const r = relationToHeadliner(act("Jamie Quill"), ["Band X"], "Band X is a rock band consisting of Jamie Quill, Ro Park and Sam Lee.");
  assert.equal(r?.kind, "part-of");
});

const INPUT = { scenario: "opener" as const, headliner: "Test Headliner", city: "Berlin" };

function withDescriptions(member: string, mentioned: string, texts: Record<string, string>): { qloo: QlooClient; calls: { tool: string; args: Record<string, unknown> }[] } {
  const mock = new MockQlooClient();
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const qloo: QlooClient = {
    mode: "live",
    close: async () => {},
    call: async (tool, args): Promise<QlooEnvelope> => {
      calls.push({ tool, args });
      const env = await mock.call(tool, args);
      if (tool !== "qloo_recommend" || args.target_type !== "artist") return env;
      const results = (env.results as Record<string, unknown>[]).map((r, i) => {
        const name = i === 0 ? member : i === 1 ? mentioned : String(r.name);
        const text = texts[name];
        return { ...r, name, ...(text ? { properties: { short_description: text } } : {}) };
      });
      return { ...env, results };
    },
  };
  return { qloo, calls };
}

test("opener: the headliner's own singer is left out, with a caveat; a mere mention is flagged (demo run 2026-10-14: Thom Yorke for Radiohead)", async () => {
  const { qloo, calls } = withDescriptions("Lead Person", "Echo Band", {
    "Lead Person": "Singer best known as the lead vocalist of Test Headliner.",
    "Echo Band": "Indie band often compared to Test Headliner.",
  });
  const brief = await runAgent({ input: INPUT, qloo, today: new Date("2026-10-10T12:00:00Z") });
  assert.ok(!brief.candidates.some((c) => c.name === "Lead Person"), brief.candidates.map((c) => c.name).join(", "));
  const rank = calls.find((c) => c.tool === "qloo_rank");
  assert.ok(!(rank?.args.options as string[]).includes("Lead Person"), "member sent to rank");
  assert.ok(brief.caveats.some((c) => c.startsWith("Left out Lead Person") && c.includes("lead vocalist of Test Headliner")), brief.caveats.join(" | "));
  if (brief.candidates.some((c) => c.name === "Echo Band")) {
    assert.ok(brief.caveats.some((c) => c.startsWith("Echo Band's Qloo description mentions Test Headliner")), brief.caveats.join(" | "));
  }
});

test("opener: rank picked a member anyway (LLM path) -> still left out of the brief", async () => {
  const { qloo } = withDescriptions("Lead Person", "Other", { "Lead Person": "Founding member of Test Headliner." });
  // A rank call that includes the member, as an LLM might send it.
  const wrapped: QlooClient = {
    ...qloo,
    call: async (tool, args) => (tool === "qloo_rank" ? qloo.call(tool, { ...args, options: ["Lead Person", ...((args.options as string[]) ?? [])] }) : qloo.call(tool, args)),
  };
  const brief = await runAgent({ input: INPUT, qloo: wrapped, today: new Date("2026-10-10T12:00:00Z") });
  assert.ok(!brief.candidates.some((c) => c.name === "Lead Person"));
});

test("opener: no descriptions at all -> a warning that members could not be screened", async () => {
  const mock = new MockQlooClient();
  const bare: QlooClient = {
    mode: "live",
    close: async () => {},
    call: async (tool, args) => {
      const env = await mock.call(tool, args);
      return { ...env, results: Array.isArray(env.results) ? (env.results as Record<string, unknown>[]).map(({ properties: _p, ...r }) => r) : env.results };
    },
  };
  const brief = await runAgent({ input: INPUT, qloo: bare, today: new Date("2026-10-10T12:00:00Z") });
  assert.ok(brief.caveats.some((c) => c.includes("could not be screened out")), brief.caveats.join(" | "));
  const demo = await runAgent({ input: INPUT, qloo: new MockQlooClient(), today: new Date("2026-10-10T12:00:00Z") });
  assert.ok(!demo.caveats.some((c) => c.includes("could not be screened out")));
});

const VENUE = { scenario: "venue" as const, venue: "Test Hall", city: "Austin" };

function withPlaces(): QlooClient {
  const mock = new MockQlooClient();
  const places = [
    { name: "Rival Nightclub", entity_id: "p1", affinity: 0.99 },
    { name: "Blue Room", entity_id: "p2", affinity: 0.98, properties: { description: "Downtown blues club and live-music venue." } },
    { name: "Bean Corner", entity_id: "p3", affinity: 0.97, properties: { description: "Coffee shop with pastries." } },
    { name: "Spin Records", entity_id: "p4", affinity: 0.96, properties: { short_description: "Independent record store." } },
    { name: "Hop Yard", entity_id: "p5", affinity: 0.95, properties: { description: "Craft brewery and taproom." } },
  ];
  return {
    mode: "live",
    close: async () => {},
    call: async (tool, args) => (tool === "qloo_recommend" && args.target_type === "place"
      ? { operation: "recommend", status: "ok", results: places }
      : mock.call(tool, args)),
  };
}

test("venue: competing music venues and nightclubs are not partner leads (demo run 2026-10-14: Antone's for Mohawk)", async () => {
  const brief = await runAgent({ input: VENUE, qloo: withPlaces(), today: new Date("2026-10-10T12:00:00Z") });
  const places = brief.partners.filter((p) => p.kind === "place").map((p) => p.name);
  assert.deepEqual(places, ["Bean Corner", "Spin Records", "Hop Yard"]);
  assert.ok(brief.caveats.some((c) => c.includes("competing rooms") && c.includes("Rival Nightclub") && c.includes("Blue Room")), brief.caveats.join(" | "));
});

test("opener: a promoter may still partner with clubs and venues", async () => {
  const brief = await runAgent({ input: INPUT, qloo: withPlaces(), today: new Date("2026-10-10T12:00:00Z") });
  assert.ok(brief.partners.some((p) => p.name === "Rival Nightclub"));
});

test("quotes in caveats start and end on word boundaries (live demo 14.10: '...wn as the principal vocalist')", () => {
  // Synthetic text shaped like the live description; shifting the start moves the 40-character cut through words.
  const full = "Born and raised in Wellingborough, Thomas Edward Yorke is an English musician, best known as the principal vocalist and songwriter of the rock band Radiohead, and a solo artist in his own right since the early years.";
  for (let shift = 0; shift < 14; shift++) {
    const text = full.slice(shift);
    const m = /principal vocalist[^,]*Radiohead/.exec(text);
    assert.ok(m);
    const q = quoteAround(text, m.index, m[0].length);
    const inner = q.replace(/^\.\.\./, "").replace(/\.\.\.$/, "");
    const at = text.indexOf(inner);
    assert.ok(at >= 0, q);
    assert.ok(at === 0 || /\s/.test(text[at - 1] ?? ""), `starts mid-word (shift ${shift}): ${q}`);
    const after = at + inner.length;
    assert.ok(after === text.length || /\s/.test(text[after] ?? ""), `ends mid-word (shift ${shift}): ${q}`);
    assert.ok(inner.includes(m[0]), "the matched phrase stays whole");
    assert.ok(q.startsWith("...") && q.endsWith("..."));
  }
  // Short text: no cut, no ellipsis.
  assert.equal(quoteAround("lead vocalist of Radiohead", 0, 26), "lead vocalist of Radiohead");
  const r = relationToHeadliner(act("Thom Yorke", full), HEAD);
  assert.equal(r?.kind, "part-of");
});

test("a cut that already falls right before a word keeps that word", () => {
  // 40 characters after the match end exactly before "tail": nothing to trim.
  const text = `vocalist of Radiohead ${"x".repeat(38)} tail words here`;
  const m = /vocalist of Radiohead/.exec(text);
  assert.ok(m);
  const q = quoteAround(text, m.index, m[0].length);
  assert.ok(q.includes("x".repeat(38)), q);
});
