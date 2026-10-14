import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_LLM_CALLS_PER_KIND, QLOO_RATE_LIMIT_BACKOFF_MS, runAgent } from "../src/agent/agent.ts";
import type { ChatMessage, ChatResult, Llm, ToolCall, ToolSpec } from "../src/agent/llm.ts";
import { MockQlooClient } from "../src/qloo/mockClient.ts";
import type { QlooClient, QlooEnvelope } from "../src/qloo/types.ts";

const TODAY = new Date("2026-10-10T12:00:00Z");
const INPUT = { scenario: "opener" as const, headliner: "Test Headliner", city: "Berlin" };
const noSleep = async () => {};

const recommend = (id: string, limit = 12): ToolCall => ({
  id, type: "function",
  function: { name: "qloo_recommend", arguments: JSON.stringify({ target_type: "artist", signals: [INPUT.headliner], signal_location: "Berlin", limit }) },
});

test("LLM repeating the same tool: identical calls reuse the first result, a kind is capped per turn and per run (demo run 2026-10-14: 5x recommend -> Qloo 429)", async () => {
  const qloo = new MockQlooClient();
  const replies: string[] = [];
  let turn = 0;
  const llm: Llm = {
    async chat(messages: ChatMessage[], tools?: ToolSpec[]): Promise<ChatResult> {
      if (!tools) return { content: "ok", toolCalls: [], provider: "fake" };
      replies.push(...messages.filter((m) => m.role === "tool").map((m) => String(m.content)));
      turn++;
      // Turn 1: five recommends at once (3 identical, 2 with other limits); turns 2-4: the same again.
      if (turn <= 4) return { content: null, provider: "fake", toolCalls: [recommend(`a${turn}`), recommend(`b${turn}`), recommend(`c${turn}`), recommend(`d${turn}`, 10), recommend(`e${turn}`, 8)] };
      return { content: "DONE", toolCalls: [], provider: "fake" };
    },
  };
  const brief = await runAgent({ input: INPUT, qloo, llm, today: TODAY, sleep: noSleep });
  const llmRecommends = brief.trace.filter((s) => s.actor === "llm" && s.tool === "qloo_recommend");
  assert.ok(llmRecommends.length <= MAX_LLM_CALLS_PER_KIND, `${llmRecommends.length} recommend calls reached Qloo`);
  assert.equal(qloo.calls.filter((c) => c.tool === "qloo_recommend" && c.args.target_type === "artist").length, llmRecommends.length);
  assert.ok(replies.some((r) => r.includes("\"duplicate\"")), "LLM not told about the duplicate");
  assert.ok(replies.some((r) => r.includes("Call limit")), "LLM not told about the limit");
  assert.equal(brief.candidates.length, 5);
});

test("different kinds in one turn are all allowed (artist, place and brand recommendations)", async () => {
  const qloo = new MockQlooClient();
  let turn = 0;
  const llm: Llm = {
    async chat(_m: ChatMessage[], tools?: ToolSpec[]): Promise<ChatResult> {
      if (!tools) return { content: "ok", toolCalls: [], provider: "fake" };
      if (++turn > 1) return { content: "DONE", toolCalls: [], provider: "fake" };
      const call = (id: string, args: Record<string, unknown>): ToolCall => ({ id, type: "function", function: { name: "qloo_recommend", arguments: JSON.stringify(args) } });
      return { content: null, provider: "fake", toolCalls: [call("1", { target_type: "artist", signals: ["x"] }), call("2", { target_type: "place", signals: ["x"], filter_location: "Berlin" }), call("3", { target_type: "brand", signals: ["x"] })] };
    },
  };
  const brief = await runAgent({ input: INPUT, qloo, llm, today: TODAY, sleep: noSleep });
  assert.equal(brief.trace.filter((s) => s.actor === "llm").length, 3);
});

function rateLimited(failures: number): { qloo: QlooClient; rankCalls: () => number } {
  const mock = new MockQlooClient();
  let rank = 0;
  return {
    rankCalls: () => rank,
    qloo: {
      mode: "live",
      close: async () => {},
      call: async (tool, args): Promise<QlooEnvelope> => {
        if (tool === "qloo_rank" && ++rank <= failures) {
          return { operation: "rank", status: "error", results: [], error: { code: "QLOO_RATE_LIMIT", layer: "qloo", retryable: true, recovery: "Wait for the Qloo rate-limit window, then retry the same interpreted request once." } };
        }
        return mock.call(tool, args);
      },
    },
  };
}

test("Qloo 429: the call is retried after a backoff and the brief shows rank scores", async () => {
  const waits: number[] = [];
  const { qloo, rankCalls } = rateLimited(2);
  const brief = await runAgent({ input: INPUT, qloo, today: TODAY, sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(waits, [...QLOO_RATE_LIMIT_BACKOFF_MS]);
  assert.equal(rankCalls(), 3);
  assert.equal(brief.scoreSource, "rank");
  assert.ok(!brief.caveats.some((c) => c.includes("qloo_rank failed")), brief.caveats.join(" | "));
  const step = brief.trace.find((s) => s.tool === "qloo_rank");
  assert.equal(step?.status, "ok");
  assert.ok(step?.summary.includes("after 2 rate-limit retries"), step?.summary);
});

test("Qloo 429 that does not clear: bounded retries, then the failure is a caveat", async () => {
  const waits: number[] = [];
  const { qloo, rankCalls } = rateLimited(99);
  const brief = await runAgent({ input: INPUT, qloo, today: TODAY, sleep: async (ms) => { waits.push(ms); } });
  assert.equal(rankCalls(), 1 + QLOO_RATE_LIMIT_BACKOFF_MS.length);
  assert.equal(waits.length, QLOO_RATE_LIMIT_BACKOFF_MS.length);
  assert.equal(brief.scoreSource, "recommend");
  assert.ok(brief.caveats.some((c) => c.includes("qloo_rank failed (QLOO_RATE_LIMIT")), brief.caveats.join(" | "));
});

test("non-rate-limit errors are not retried", async () => {
  const mock = new MockQlooClient();
  let n = 0;
  const qloo: QlooClient = {
    mode: "live", close: async () => {},
    call: async (tool, args) => (tool === "qloo_rank" && ++n > 0 ? { operation: "rank", status: "error", results: [], error: { code: "QLOO_CONTRACT", retryable: false, recovery: "" } } : mock.call(tool, args)),
  };
  const waits: number[] = [];
  await runAgent({ input: INPUT, qloo, today: TODAY, sleep: async (ms) => { waits.push(ms); } });
  assert.equal(n, 1);
  assert.deepEqual(waits, []);
});
