// Live demo 2026-10-14: the narrative read "highest overlap score of 100 with an
// affinity of 0.972 and a popularity near 1.0". A promoter needs words, not JSON
// fields. The LLM sees readable labels only, and text that still carries field
// names or raw numbers is replaced by the template. Fixtures are synthetic.

import assert from "node:assert/strict";
import { test } from "node:test";
import { narrativeFacts, narrativeProblem, runAgent } from "../src/agent/agent.ts";
import type { ChatMessage, ChatResult, Llm, ToolSpec } from "../src/agent/llm.ts";
import { MockQlooClient } from "../src/qloo/mockClient.ts";

const TODAY = new Date("2026-10-10T12:00:00Z");
const OPENER = { scenario: "opener" as const, headliner: "Test Headliner", city: "Berlin", capacity: 1200 };
const VENUE = { scenario: "venue" as const, venue: "Some Hall", city: "Berlin", date: "2026-11-14" };

// Shaped like the live demo narrative (names changed).
const BAD = [
  "Qloo ranked the candidate openers, giving Act One the highest overlap score of 100 with an affinity of 0.972 and a popularity near 1.0, while its trend is flat.",
  "Act One received the top overlapScore of 100.",
  "Act One shows an affinity of 0.980 and a flat trend.",
  "Act One has a popularity of 0.979.",
  "The scoreSource is rank.",
  "Act Two follows at 0.9613.",
  // Jules review 2026-10-15: no leading zero, one digit.
  "Act One has an affinity of .972.",
  "Act One scores 0.8 against the headliner.",
];
const GOOD = [
  "Act One is the strongest audience match among the 10 acts Qloo ranked for Berlin; it sits in the top 0.03% by Qloo popularity and its 90-day trend is flat.",
  "Act Two and Act Three follow with an audience fit of 64 and 63. Partnership leads with the same audience: a record store and a coffee bar.",
  // Jules review 2026-10-15: readable text that the first version rejected.
  "The crowd shares an audience affinity with 2 of the shortlisted acts.",
  "Act One sits in the top 0.03 percent by Qloo popularity.",
  "Doors at 7.30 are not a Qloo input.",
];

test("narrative check: field names and raw Qloo numbers are rejected, readable text passes", () => {
  for (const t of BAD) assert.ok(narrativeProblem(t), `not rejected: ${t}`);
  for (const t of GOOD) assert.equal(narrativeProblem(t), null, t);
});

test("narrative facts carry labels, no field names or raw decimals", async () => {
  for (const input of [OPENER, VENUE]) {
    const brief = await runAgent({ input, qloo: new MockQlooClient(), today: TODAY });
    const json = JSON.stringify(narrativeFacts(brief));
    assert.doesNotMatch(json, /overlapScore|affinity|entityId|scoreSource/, json.slice(0, 300));
    assert.doesNotMatch(json, /(?<![\d.%])0\.\d{2,}(?![\d%])/, "raw decimal in facts");
    const facts = narrativeFacts(brief) as { candidates: { popularity: string; fit: number }[] };
    assert.ok(facts.candidates.every((c) => /^top /.test(c.popularity) && Number.isInteger(c.fit)));
    // The template narrative passes the same check.
    assert.equal(narrativeProblem(brief.narrative), null, brief.narrative);
  }
});

test("an LLM narrative with field names is not shown: template instead, agent log says why", async () => {
  const llm: Llm = {
    async chat(_m: ChatMessage[], tools?: ToolSpec[]): Promise<ChatResult> {
      if (tools) return { content: "DONE", toolCalls: [], provider: "fake" };
      return { content: BAD[0] as string, toolCalls: [], provider: "fake" };
    },
  };
  const brief = await runAgent({ input: OPENER, qloo: new MockQlooClient(), llm, today: TODAY });
  assert.doesNotMatch(brief.narrative, /overlap score|0\.972|near 1\.0/);
  assert.match(brief.narrative, /strongest audience affinity/);
  const call = brief.llmCalls.at(-1);
  assert.equal(call?.phase, "narrative");
  assert.equal(call?.status, "error");
  assert.match(call?.summary ?? "", /not used \(field name overlapScore\); template shown/);
});

test("the live log's end event already says the narrative was not used (Jules review 2026-10-15)", async () => {
  const llm: Llm = {
    async chat(_m: ChatMessage[], tools?: ToolSpec[]): Promise<ChatResult> {
      if (tools) return { content: "DONE", toolCalls: [], provider: "fake" };
      return { content: BAD[0] as string, toolCalls: [], provider: "fake" };
    },
  };
  const ends: string[] = [];
  await runAgent({ input: OPENER, qloo: new MockQlooClient(), llm, today: TODAY, onEvent: (e) => { if (e.type === "end" && e.kind === "llm" && e.call.phase === "narrative") ends.push(`${e.call.status} ${e.call.summary}`); } });
  assert.equal(ends.length, 1);
  assert.match(ends[0] ?? "", /^error .*not used/);
});

test("a readable LLM narrative is shown as written", async () => {
  const llm: Llm = {
    async chat(_m: ChatMessage[], tools?: ToolSpec[]): Promise<ChatResult> {
      if (tools) return { content: "DONE", toolCalls: [], provider: "fake" };
      return { content: GOOD[0] as string, toolCalls: [], provider: "fake" };
    },
  };
  const brief = await runAgent({ input: OPENER, qloo: new MockQlooClient(), llm, today: TODAY });
  assert.equal(brief.narrative, GOOD[0]);
});
