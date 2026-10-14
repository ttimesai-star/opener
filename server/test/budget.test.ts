// P0-2 (live demo 2026-10-14: brief took 156 s). The LLM gets a wall-clock
// budget for choosing tools; after it, or when it repeats a call, the scripted
// planner completes the evidence. The narrative call has its own time limit.

import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgent } from "../src/agent/agent.ts";
import type { ChatMessage, ChatOptions, ChatResult, Llm, ToolCall, ToolSpec } from "../src/agent/llm.ts";
import { MockQlooClient } from "../src/qloo/mockClient.ts";

const TODAY = new Date("2026-10-10T12:00:00Z");
const INPUT = { scenario: "opener" as const, headliner: "Test Headliner", city: "Berlin" };
const noSleep = async () => {};
const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// One new evidence kind per turn, each turn slow: a free model at 8-28 s per step, scaled down.
const STEPS: [string, Record<string, unknown>][] = [
  ["qloo_describe", { entity: "Test Headliner", type: "artist" }],
  ["qloo_recommend", { target_type: "artist", signals: ["Test Headliner"], signal_location: "Berlin", limit: 12 }],
  ["qloo_audience_demographics", { entity: "Test Headliner", entity_type: "artist" }],
  ["qloo_recommend", { target_type: "brand", signals: ["Test Headliner"] }],
  ["qloo_where_popular", { entity: "Test Headliner", entity_type: "artist", within: "Berlin" }],
];

test("the LLM stops choosing tools when its time budget runs out; the planner completes the brief", async () => {
  let planTurns = 0;
  const llm: Llm = {
    async chat(_m: ChatMessage[], tools?: ToolSpec[]): Promise<ChatResult> {
      if (!tools) return { content: "Narrative.", toolCalls: [], provider: "fake" };
      const step = STEPS[planTurns++];
      await wait(60);
      return step ? { content: null, provider: "fake", toolCalls: [call(`t${planTurns}`, step[0], step[1])] } : { content: "DONE", toolCalls: [], provider: "fake" };
    },
  };
  const started = Date.now();
  const brief = await runAgent({ input: INPUT, qloo: new MockQlooClient(), llm, today: TODAY, sleep: noSleep, llmBudgetMs: 150 });
  assert.ok(planTurns >= 2 && planTurns <= 4, `plan turns: ${planTurns}`);
  assert.ok(Date.now() - started < 2000);
  assert.equal(brief.agent, "hybrid");
  assert.ok(brief.trace.some((s) => s.actor === "planner" && s.tool === "qloo_rank"), "planner did not finish the plan");
  assert.equal(brief.candidates.length, 5);
  assert.ok(brief.caveats.some((c) => c.includes("LLM time budget")), brief.caveats.join(" | "));
});

test("an LLM call in flight is cut at the budget, even by a client that ignores the abort signal", async () => {
  let sawSignal = false;
  const llm: Llm = {
    chat(_m: ChatMessage[], tools?: ToolSpec[], opts?: ChatOptions): Promise<ChatResult> {
      if (!tools) return Promise.resolve({ content: "Narrative.", toolCalls: [], provider: "fake" });
      sawSignal ||= opts?.signal instanceof AbortSignal;
      return new Promise(() => {}); // never answers
    },
  };
  const started = Date.now();
  const brief = await runAgent({ input: INPUT, qloo: new MockQlooClient(), llm, today: TODAY, sleep: noSleep, llmBudgetMs: 80 });
  assert.ok(sawSignal, "the budget signal is passed to the client");
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
  assert.equal(brief.agent, "planner");
  assert.equal(brief.llmCalls[0]?.status, "error");
  assert.equal(brief.candidates.length, 5);
});

test("the same evidence kind again after it came back ok hands over to the planner at once", async () => {
  let planTurns = 0;
  const llm: Llm = {
    async chat(_m: ChatMessage[], tools?: ToolSpec[]): Promise<ChatResult> {
      if (!tools) return { content: "Narrative.", toolCalls: [], provider: "fake" };
      planTurns++;
      // Live run 14.10: the model asked for recommendations three turns in a row with slightly different arguments.
      const steps = [STEPS[0], STEPS[1], ["qloo_recommend", { target_type: "artist", signals: ["Test Headliner"], limit: 10 }], STEPS[2]] as [string, Record<string, unknown>][];
      const step = steps[planTurns - 1];
      return step ? { content: null, provider: "fake", toolCalls: [call(`t${planTurns}`, step[0], step[1])] } : { content: "DONE", toolCalls: [], provider: "fake" };
    },
  };
  const qloo = new MockQlooClient();
  const brief = await runAgent({ input: INPUT, qloo, llm, today: TODAY, sleep: noSleep });
  assert.equal(planTurns, 3, "no LLM turn after the repeat");
  assert.equal(qloo.calls.filter((c) => c.tool === "qloo_recommend" && c.args.target_type === "artist").length, 1);
  assert.ok(brief.caveats.some((c) => c.includes("the LLM repeated a call (qloo_recommend)")));
  assert.equal(brief.agent, "hybrid");
});

test("a retry after needs_input is still allowed (not a repeat)", async () => {
  class Ambiguous extends MockQlooClient {
    override async call(tool: Parameters<MockQlooClient["call"]>[0], args: Record<string, unknown>) {
      if (tool === "qloo_describe" && args.entity === "Ambig") return { operation: "describe", status: "needs_input" as const, results: [], summary: "ambiguous" };
      return super.call(tool, args);
    }
  }
  let planTurns = 0;
  const llm: Llm = {
    async chat(_m: ChatMessage[], tools?: ToolSpec[]): Promise<ChatResult> {
      if (!tools) return { content: "Narrative.", toolCalls: [], provider: "fake" };
      planTurns++;
      if (planTurns === 1) return { content: null, provider: "fake", toolCalls: [call("a", "qloo_describe", { entity: "Ambig", type: "artist" })] };
      if (planTurns === 2) return { content: null, provider: "fake", toolCalls: [call("b", "qloo_describe", { entity: "Test Headliner", type: "artist" })] };
      return { content: "DONE", toolCalls: [], provider: "fake" };
    },
  };
  const brief = await runAgent({ input: INPUT, qloo: new Ambiguous(), llm, today: TODAY, sleep: noSleep });
  assert.equal(brief.trace.filter((s) => s.actor === "llm" && s.tool === "qloo_describe").length, 2);
  assert.ok(!brief.caveats.some((c) => c.includes("repeated a call")));
});

test("a slow narrative is cut at its time limit and the template narrative is used", async () => {
  const llm: Llm = {
    chat(_m: ChatMessage[], tools?: ToolSpec[]): Promise<ChatResult> {
      if (tools) return Promise.resolve({ content: "DONE", toolCalls: [], provider: "fake" });
      return new Promise(() => {});
    },
  };
  const started = Date.now();
  const brief = await runAgent({ input: INPUT, qloo: new MockQlooClient(), llm, today: TODAY, sleep: noSleep, narrativeTimeoutMs: 60 });
  assert.ok(Date.now() - started < 2000);
  assert.match(brief.narrative, /strongest audience affinity/);
  assert.equal(brief.llmCalls.at(-1)?.phase, "narrative");
  assert.equal(brief.llmCalls.at(-1)?.status, "error");
});

test("an LLM call abandoned at the budget that fails later is not an unhandled rejection (Jules review 2026-10-15)", async () => {
  const { untilAborted } = await import("../src/agent/agent.ts");
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const ctl = new AbortController();
    ctl.abort("budget");
    let fail!: (e: Error) => void;
    const work = new Promise<never>((_, reject) => { fail = reject; });
    await assert.rejects(untilAborted(work, ctl.signal), /LLM call stopped/);
    fail(new Error("late provider error"));
    await wait(20);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("two calls of one kind in a single turn hand over to the planner (call limit counts as a repeat)", async () => {
  let planTurns = 0;
  const llm: Llm = {
    async chat(_m: ChatMessage[], tools?: ToolSpec[]): Promise<ChatResult> {
      if (!tools) return { content: "Narrative.", toolCalls: [], provider: "fake" };
      planTurns++;
      return { content: null, provider: "fake", toolCalls: [call("a", "qloo_describe", { entity: "Test Headliner", type: "artist" }), call("b", "qloo_describe", { entity: "Test Headliner Band", type: "artist" })] };
    },
  };
  const brief = await runAgent({ input: INPUT, qloo: new MockQlooClient(), llm, today: TODAY, sleep: noSleep });
  assert.equal(planTurns, 1);
  assert.ok(brief.caveats.some((c) => c.includes("repeated a call (qloo_describe)")));
});

test("the narrative gets only the time left until the brief target, and is skipped when too little is left (live 15.10: 63 s)", async () => {
  let narrativeAsked = 0;
  const slowPlan: Llm = {
    async chat(_m: ChatMessage[], tools?: ToolSpec[]): Promise<ChatResult> {
      if (!tools) { narrativeAsked++; return new Promise(() => {}); }
      await wait(120);
      return { content: "DONE", toolCalls: [], provider: "fake" };
    },
  };
  // Target already spent by the plan phase: no narrative call at all.
  const a = await runAgent({ input: INPUT, qloo: new MockQlooClient(), llm: slowPlan, today: TODAY, sleep: noSleep, briefTargetMs: 100 });
  assert.equal(narrativeAsked, 0);
  assert.match(a.llmCalls.at(-1)?.summary ?? "", /^skipped: the 0 s brief time target was reached; template shown$/);
  assert.match(a.narrative, /strongest audience affinity/);
  // Enough left: the narrative is cut at the target, not at its own 12 s limit.
  const started = Date.now();
  const b = await runAgent({ input: INPUT, qloo: new MockQlooClient(), llm: slowPlan, today: TODAY, sleep: noSleep, briefTargetMs: 3_400, narrativeTimeoutMs: 12_000 });
  const took = Date.now() - started;
  assert.equal(narrativeAsked, 1);
  assert.ok(took < 4_500, `took ${took} ms`);
  assert.equal(b.llmCalls.at(-1)?.phase, "narrative");
  assert.equal(b.llmCalls.at(-1)?.status, "error");
});
