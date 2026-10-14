import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgent } from "../src/agent/agent.ts";
import { relationToHeadliner } from "../src/agent/relations.ts";
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
