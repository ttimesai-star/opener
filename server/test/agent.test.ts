import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgent } from "../src/agent/agent.ts";
import type { ChatMessage, ChatResult, Llm, ToolSpec } from "../src/agent/llm.ts";
import { REQUIRED_KINDS, kindOf, nextPlannedStep } from "../src/agent/planner.ts";
import { MockQlooClient } from "../src/qloo/mockClient.ts";
import type { QlooClient, QlooEnvelope } from "../src/qloo/types.ts";
import type { AgentEvent } from "../src/agent/types.ts";

const TODAY = new Date("2026-10-10T12:00:00Z");
const INPUT = { scenario: "opener" as const, headliner: "Test Headliner", city: "Berlin", capacity: 1200 };

test("scripted planner covers every evidence kind and builds a full brief", async () => {
  const qloo = new MockQlooClient();
  const brief = await runAgent({ input: INPUT, qloo, today: TODAY });
  const kinds = new Set(qloo.calls.map((c) => kindOf(c.tool, c.args)));
  for (const k of REQUIRED_KINDS) assert.ok(kinds.has(k), `missing ${k}`);
  assert.equal(brief.agent, "planner");
  assert.equal(brief.mode, "mock");
  assert.equal(brief.candidates.length, 5);
  assert.equal(brief.candidates[0]?.overlapScore, 100);
  assert.ok(brief.candidates.every((o) => o.name !== INPUT.headliner));
  assert.ok(brief.heatmap.length > 0);
  assert.ok(brief.demographics);
  assert.equal(brief.partners.filter((p) => p.kind === "place").length, 3);
  assert.equal(brief.partners.filter((p) => p.kind === "brand").length, 3);
  assert.ok(brief.caveats[0]?.startsWith("DEMO MODE"));
  assert.equal(brief.trace.length, REQUIRED_KINDS.length);
  assert.ok(brief.narrative.length > 0);
});

test("brief is deterministic for the same input", async () => {
  const a = await runAgent({ input: INPUT, qloo: new MockQlooClient(), today: TODAY });
  const b = await runAgent({ input: INPUT, qloo: new MockQlooClient(), today: TODAY });
  assert.deepEqual(a.candidates, b.candidates);
});

test("planner starts with the headliner and uses the 90 days before today for trends", async () => {
  assert.equal(nextPlannedStep(INPUT, [], TODAY)?.tool, "qloo_describe");
  const qloo = new MockQlooClient();
  await runAgent({ input: INPUT, qloo, today: TODAY });
  const trends = qloo.calls.find((c) => c.tool === "qloo_trends");
  assert.equal(trends?.args.start_date, "2026-07-12");
  assert.equal(trends?.args.end_date, "2026-10-09");
  assert.equal((trends?.args.entities as string[])[0], INPUT.headliner);
});

class ScriptedLlm implements Llm {
  turn = 0;
  async chat(_messages: ChatMessage[], tools?: ToolSpec[]): Promise<ChatResult> {
    if (!tools) return { content: "Narrative from the model.", toolCalls: [], provider: "fake" };
    this.turn++;
    if (this.turn === 1) {
      return {
        content: null, provider: "fake",
        toolCalls: [
          { id: "1", type: "function", function: { name: "qloo_describe", arguments: JSON.stringify({ entity: INPUT.headliner, type: "artist" }) } },
          { id: "2", type: "function", function: { name: "qloo_not_a_tool", arguments: "{}" } },
          { id: "3", type: "function", function: { name: "qloo_recommend", arguments: "{not json" } },
        ],
      };
    }
    return { content: "DONE", toolCalls: [], provider: "fake" };
  }
}

test("LLM path: unknown tools and bad JSON are rejected, planner fills gaps -> hybrid", async () => {
  const qloo = new MockQlooClient();
  const brief = await runAgent({ input: INPUT, qloo, llm: new ScriptedLlm(), today: TODAY });
  assert.equal(brief.agent, "hybrid");
  assert.equal(brief.trace[0]?.actor, "llm");
  assert.ok(brief.trace.slice(1).every((s) => s.actor === "planner"));
  assert.ok(!qloo.calls.some((c) => (c.tool as string) === "qloo_not_a_tool"));
  assert.equal(brief.narrative, "Narrative from the model.");
});

test("LLM failure falls back to the planner", async () => {
  const broken: Llm = { chat: async () => { throw new Error("429"); } };
  const brief = await runAgent({ input: INPUT, qloo: new MockQlooClient(), llm: broken, today: TODAY });
  assert.equal(brief.agent, "planner");
  assert.equal(brief.candidates.length, 5);
});

test("Qloo errors become caveats, not crashes", async () => {
  const mock = new MockQlooClient();
  const flaky: QlooClient = {
    mode: "live",
    close: async () => {},
    call: async (tool, args): Promise<QlooEnvelope> => {
      if (tool === "qloo_where_popular") throw new Error("boom");
      if (tool === "qloo_audience_demographics") return { operation: "audience_demographics", status: "empty", results: [] };
      return mock.call(tool, args);
    },
  };
  const brief = await runAgent({ input: INPUT, qloo: flaky, today: TODAY });
  assert.deepEqual(brief.heatmap, []);
  assert.equal(brief.demographics, null);
  assert.ok(brief.caveats.some((c) => c.includes("qloo_where_popular failed")));
  assert.ok(brief.caveats.some((c) => c.includes("qloo_audience_demographics returned no results")));
  assert.ok(!brief.caveats.some((c) => c.startsWith("DEMO MODE")));
});

test("an ambiguous headliner (needs_input) is surfaced as a caveat", async () => {
  const mock = new MockQlooClient();
  const ambiguous: QlooClient = {
    mode: "live",
    close: async () => {},
    call: async (tool, args) =>
      tool === "qloo_describe" ? { operation: "describe", status: "needs_input", results: [] } : mock.call(tool, args),
  };
  const brief = await runAgent({ input: INPUT, qloo: ambiguous, today: TODAY });
  assert.ok(brief.caveats.some((c) => c.includes("could not pin down")));
});

const VENUE = { scenario: "venue" as const, venue: "Test Hall", city: "Berlin", date: "2026-11-20", capacity: 600 };

test("venue scenario: same nine evidence kinds, anchored on the venue as a place", async () => {
  const qloo = new MockQlooClient();
  const brief = await runAgent({ input: VENUE, qloo, today: TODAY });
  const kinds = new Set(qloo.calls.map((c) => kindOf(c.tool, c.args)));
  for (const k of REQUIRED_KINDS) assert.ok(kinds.has(k), `missing ${k}`);
  const describe = qloo.calls.find((c) => c.tool === "qloo_describe");
  assert.deepEqual(describe?.args, { entity: "Test Hall", type: "place" });
  const demo = qloo.calls.find((c) => c.tool === "qloo_audience_demographics");
  assert.equal(demo?.args.entity_type, "place");
  // Trends are measured for candidate artists only, never for the venue.
  const trends = qloo.calls.find((c) => c.tool === "qloo_trends");
  assert.ok(!(trends?.args.entities as string[]).includes("Test Hall"));
  assert.equal((trends?.args.entities as string[]).length, 5);
  // The map shows the top candidate's fans.
  const where = qloo.calls.find((c) => c.tool === "qloo_where_popular");
  assert.equal(where?.args.entity, brief.candidates[0]?.name);
  assert.equal(brief.heatmapOf, brief.candidates[0]?.name);
  assert.equal(brief.subject.type, "place");
  assert.equal(brief.subject.trend, "unknown");
  assert.equal(brief.candidates.length, 5);
  assert.ok(brief.caveats.some((c) => c.includes("2026-11-20")));
  assert.ok(brief.caveats.some((c) => c.includes("venue's crowd")));
});

test("onEvent reports every Qloo and LLM call as start then end, in order", async () => {
  const events: AgentEvent[] = [];
  const brief = await runAgent({ input: INPUT, qloo: new MockQlooClient(), llm: new ScriptedLlm(), today: TODAY, onEvent: (e) => events.push(e) });
  const starts = events.filter((e) => e.type === "start");
  const ends = events.filter((e) => e.type === "end");
  assert.equal(starts.length, ends.length);
  assert.deepEqual(starts.map((e) => e.seq), ends.map((e) => e.seq));
  for (const s of starts) assert.ok(events.indexOf(s) < events.findIndex((e) => e.type === "end" && e.seq === s.seq));
  const qlooEnds = ends.filter((e) => e.kind === "qloo");
  assert.equal(qlooEnds.length, brief.trace.length);
  const llmEnds = ends.filter((e) => e.kind === "llm");
  assert.equal(llmEnds.length, brief.llmCalls.length);
  assert.ok(brief.llmCalls.some((c) => c.phase === "plan") && brief.llmCalls.some((c) => c.phase === "narrative"));
});

test("a throwing event listener does not break the run", async () => {
  const brief = await runAgent({ input: INPUT, qloo: new MockQlooClient(), today: TODAY, onEvent: () => { throw new Error("socket gone"); } });
  assert.equal(brief.candidates.length, 5);
});

test("LLM errors are recorded as failed calls and noted in the caveats", async () => {
  const broken: Llm = { chat: async () => { throw new Error("primary LLM HTTP 429: quota"); } };
  const brief = await runAgent({ input: INPUT, qloo: new MockQlooClient(), llm: broken, today: TODAY });
  assert.ok(brief.llmCalls.length >= 1 && brief.llmCalls.every((c) => c.status === "error"));
  assert.ok(brief.caveats.some((c) => c.includes("LLM was unavailable")));
});
