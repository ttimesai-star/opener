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

test("planner starts with the headliner and asks for the latest ~90 days of weekly trend points", async () => {
  assert.equal(nextPlannedStep(INPUT, [], TODAY)?.tool, "qloo_describe");
  const qloo = new MockQlooClient();
  const brief = await runAgent({ input: INPUT, qloo, today: TODAY });
  const trends = qloo.calls.find((c) => c.tool === "qloo_trends");
  // 180-day query window (a 90-day one came back empty live), latest 13 weekly points.
  assert.equal(trends?.args.start_date, "2026-04-13");
  assert.equal(trends?.args.end_date, "2026-10-09");
  assert.equal(trends?.args.limit, 13);
  assert.equal((trends?.args.entities as string[])[0], brief.subject.entityId ?? INPUT.headliner);
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
  assert.equal(where?.args.entity, brief.candidates[0]?.entityId ?? brief.candidates[0]?.name);
  assert.equal(brief.heatmapOf, brief.candidates[0]?.name);
  assert.equal(brief.subject.type, "place");
  assert.equal(brief.subject.trend, "unknown");
  assert.equal(brief.candidates.length, 5);
  assert.ok(brief.caveats.some((c) => c.includes("2026-11-20")));
  assert.ok(brief.caveats.some((c) => c.includes("venue's crowd")));
  // The crowd's taste vocabulary comes from the top acts, not the venue's amenities.
  const tags = qloo.calls.find((c) => c.tool === "qloo_entity_tags");
  assert.equal(tags?.args.entity_type, "artist");
  assert.deepEqual(tags?.args.entities, brief.candidates.slice(0, 3).map((c) => c.entityId ?? c.name));
  const places = qloo.calls.find((c) => c.tool === "qloo_recommend" && c.args.target_type === "place");
  assert.ok(!(places?.args.include_tags as string[]).some((t) => t.includes("nightclub")));
});

test("venue on live-like Qloo: ambiguous name retried with city, place demographics and brand fallbacks", async () => {
  // Reproduces what live Qloo did on 2026-10-13 for Mohawk / SO36.
  class LiveLike extends MockQlooClient {
    override async call(tool: Parameters<MockQlooClient["call"]>[0], args: Record<string, unknown>) {
      if (tool === "qloo_describe" && args.entity === "Test Hall") {
        this.calls.push({ tool, args });
        return { operation: "describe", status: "needs_input" as const, results: [], summary: "Choose the intended Qloo entity." };
      }
      if (tool === "qloo_audience_demographics" && args.entity_type === "place") {
        this.calls.push({ tool, args });
        return { operation: "audience_demographics", status: "ok" as const, results: [] };
      }
      if (tool === "qloo_recommend" && args.target_type === "brand" && (args.signals as string[]).some((x) => x.includes("Test Hall"))) {
        this.calls.push({ tool, args });
        return { operation: "recommend", status: "error" as const, results: [], error: { code: "QLOO_CONTRACT", retryable: false, recovery: "" } };
      }
      return super.call(tool, args);
    }
  }
  const qloo = new LiveLike();
  const brief = await runAgent({ input: VENUE, qloo, today: TODAY });
  const describes = qloo.calls.filter((c) => c.tool === "qloo_describe").map((c) => c.args.entity);
  assert.deepEqual(describes, ["Test Hall", "Test Hall Berlin"]);
  assert.ok(!brief.caveats.some((c) => c.includes("could not pin down")), brief.caveats.join(" | "));
  assert.ok(brief.demographics, "falls back to the top act's demographics");
  assert.equal(brief.demographicsOf, brief.candidates[0]?.name);
  assert.ok(brief.caveats.some((c) => c.includes("no demographics for the venue")));
  const brands = qloo.calls.filter((c) => c.tool === "qloo_recommend" && c.args.target_type === "brand");
  assert.equal(brands.length, 1);
  assert.equal((brands[0]?.args.signals as string[]).length, 3);
  assert.ok(brief.partners.some((p) => p.kind === "brand"));
});

test("brief: partner filter applied, noise tags dropped, fit scores spread", async () => {
  const qloo = new MockQlooClient();
  const brief = await runAgent({ input: INPUT, qloo, today: TODAY });
  const places = qloo.calls.find((c) => c.tool === "qloo_recommend" && c.args.target_type === "place");
  assert.ok(Array.isArray(places?.args.include_tags));
  assert.ok(brief.tasteTags.length > 0 && !brief.tasteTags.includes("Mock Card"));
  assert.ok(brief.rankedCount >= brief.candidates.length);
  const scores = brief.candidates.map((c) => c.overlapScore);
  assert.equal(scores[0], 100);
  assert.deepEqual([...scores].sort((a, b) => b - a), scores);
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

test("venue: an empty rank never produces a trends call with no entities (Jules review)", async () => {
  const mock = new MockQlooClient();
  const calls: string[] = [];
  const emptyRank: QlooClient = {
    mode: "live",
    close: async () => {},
    call: async (tool, args) => {
      calls.push(tool);
      if (tool === "qloo_trends") assert.ok((args.entities as string[]).length > 0, "trends called with []");
      return tool === "qloo_rank" ? { operation: "rank", status: "empty", results: [] } : mock.call(tool, args);
    },
  };
  const brief = await runAgent({ input: VENUE, qloo: emptyRank, today: TODAY });
  assert.ok(!calls.includes("qloo_trends"));
  assert.ok(brief.caveats.some((c) => c.includes("qloo_rank returned no results")));
});

test("venue: top-act demographics fallback passes the act's Qloo id, brief shows its name (Jules review 2026-10-13)", async () => {
  // Harness 0.1.26 resolves a bare name by exact match; two acts with the same
  // name come back ambiguous (needs_input). A UUID goes through identifier lookup.
  class Ambiguous extends MockQlooClient {
    override async call(tool: Parameters<MockQlooClient["call"]>[0], args: Record<string, unknown>) {
      if (tool === "qloo_audience_demographics" && args.entity_type === "place") {
        this.calls.push({ tool, args });
        return { operation: "audience_demographics", status: "ok" as const, results: [] };
      }
      if (tool === "qloo_audience_demographics" && args.entity_type === "artist" && !String(args.entity).startsWith("mock-")) {
        this.calls.push({ tool, args });
        return { operation: "audience_demographics", status: "needs_input" as const, results: [], summary: "Choose the intended Qloo entity." };
      }
      return super.call(tool, args);
    }
  }
  const qloo = new Ambiguous();
  const brief = await runAgent({ input: VENUE, qloo, today: TODAY });
  const artistDemo = qloo.calls.find((c) => c.tool === "qloo_audience_demographics" && c.args.entity_type === "artist");
  assert.ok(brief.candidates[0]?.entityId, "rank returned an id");
  assert.equal(artistDemo?.args.entity, brief.candidates[0]?.entityId);
  assert.ok(brief.demographics, "fallback demographics present");
  assert.equal(brief.demographicsOf, brief.candidates[0]?.name);
  assert.ok(!brief.caveats.some((c) => c.includes("mock-")), brief.caveats.join(" | "));
});

test("planner uses entity refs for heatmap, trends, and tags, and brief maps refs to display names", async () => {
  const qloo = new MockQlooClient();
  const brief = await runAgent({ input: INPUT, qloo, today: TODAY });

  const heatmapCall = qloo.calls.find((c) => c.tool === "qloo_where_popular");
  assert.equal(heatmapCall?.args.entity, brief.subject.entityId);
  assert.equal(brief.heatmapOf, brief.subject.name);

  const trendsCall = qloo.calls.find((c) => c.tool === "qloo_trends");
  const trendEntities = trendsCall?.args.entities as string[];
  assert.equal(trendEntities[0], brief.subject.entityId);
  for (let i = 0; i < trendEntities.length - 1; i++) {
    assert.equal(trendEntities[i + 1], brief.candidates[i]?.entityId);
  }

  const tagsCall = qloo.calls.find((c) => c.tool === "qloo_entity_tags");
  assert.deepEqual(tagsCall?.args.entities, [brief.subject.entityId]);
});

test("caveats sanitize secret QLOO_API_KEY and LLM_API_KEY", async () => {
  const origQlooKey = process.env.QLOO_API_KEY;
  const origLlmKey = process.env.LLM_API_KEY;
  try {
    process.env.QLOO_API_KEY = "secret_qloo_key_123456";
    process.env.LLM_API_KEY = "secret_llm_key_123456";
    const mock = new MockQlooClient();
    const leakyClient: QlooClient = {
      mode: "live",
      close: async () => {},
      call: async (tool, args) => {
        if (tool === "qloo_where_popular") {
          return {
            operation: "where_popular",
            status: "error",
            results: [],
            error: { code: "ERROR", retryable: false, recovery: `Failed with QLOO_API_KEY secret_qloo_key_123456` },
          };
        }
        return mock.call(tool, args);
      },
    };
    const brief = await runAgent({ input: INPUT, qloo: leakyClient, today: TODAY });
    assert.ok(brief.caveats.some((c) => c.includes("[REDACTED_QLOO_API_KEY]")));
    assert.ok(!brief.caveats.some((c) => c.includes("secret_qloo_key_123456")));
  } finally {
    process.env.QLOO_API_KEY = origQlooKey;
    process.env.LLM_API_KEY = origLlmKey;
  }
});

test("secrets are masked in trace summaries, LLM call summaries and tool results sent to the LLM (incl. fallback key)", async () => {
  const keys = { QLOO_API_KEY: "qloo_secret_value_9876", LLM_API_KEY: "llm_secret_value_9876", LLM_FALLBACK_API_KEY: "fallback_secret_value_9876" };
  const saved = Object.fromEntries(Object.keys(keys).map((k) => [k, process.env[k]]));
  try {
    Object.assign(process.env, keys);
    const mock = new MockQlooClient();
    const leaky: QlooClient = {
      mode: "live",
      close: async () => {},
      call: async (tool, args) => {
        if (tool === "qloo_describe") return { ...(await mock.call(tool, args)), summary: `GET /search?key=${keys.QLOO_API_KEY}` };
        if (tool === "qloo_where_popular") throw new Error(`socket closed, header x-api-key: ${keys.QLOO_API_KEY}`);
        return mock.call(tool, args);
      },
    };
    const seen: string[] = [];
    let turn = 0;
    const llm: Llm = {
      async chat(messages: ChatMessage[], tools?: ToolSpec[]): Promise<ChatResult> {
        seen.push(JSON.stringify(messages));
        if (!tools) throw new Error(`401 invalid key ${keys.LLM_FALLBACK_API_KEY}`);
        turn++;
        if (turn === 1) {
          return { content: null, provider: "fake", toolCalls: [{ id: "1", type: "function", function: { name: "qloo_describe", arguments: JSON.stringify({ entity: INPUT.headliner, type: "artist" }) } }] };
        }
        throw new Error(`401 Unauthorized for key ${keys.LLM_API_KEY}`);
      },
    };
    const brief = await runAgent({ input: INPUT, qloo: leaky, llm, today: TODAY });
    const visible = JSON.stringify({ trace: brief.trace, llmCalls: brief.llmCalls, caveats: brief.caveats });
    for (const v of Object.values(keys)) {
      assert.ok(!visible.includes(v), `${v} leaked into the brief`);
      assert.ok(!seen.some((m) => m.includes(v)), `${v} was sent to the LLM`);
    }
    assert.ok(visible.includes("[REDACTED_QLOO_API_KEY]"));
    assert.ok(visible.includes("[REDACTED_LLM_API_KEY]"));
    assert.ok(visible.includes("[REDACTED_LLM_FALLBACK_API_KEY]"));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("trends keyed only by Qloo id still reach the subject and candidates; venue heatmap purpose names the act", async () => {
  const mock = new MockQlooClient();
  const idOnlyTrends: QlooClient = {
    mode: "live",
    close: async () => {},
    call: async (tool, args) => {
      const env = await mock.call(tool, args);
      if (tool !== "qloo_trends") return env;
      // Live entity shape (2026-10-14): { input, entityId, name, type, match }; name dropped here
      // so only the id can match.
      const ids = args.entities as string[];
      const results = (env.results as Array<{ points: unknown[] }>).map((r, i) => ({ points: r.points, entity: { input: ids[i], entityId: ids[i], type: "urn:entity:artist", match: "identifier" } }));
      return { ...env, results };
    },
  };
  const brief = await runAgent({ input: INPUT, qloo: idOnlyTrends, today: TODAY });
  assert.notEqual(brief.subject.trend, "unknown");
  assert.ok(brief.candidates.slice(0, 4).every((c) => c.trend !== "unknown"), JSON.stringify(brief.candidates.map((c) => c.trend)));

  const venueQloo = new MockQlooClient();
  const venueBrief = await runAgent({ input: VENUE, qloo: venueQloo, today: TODAY });
  const heatStep = venueBrief.trace.find((s) => s.tool === "qloo_where_popular");
  assert.ok(heatStep?.purpose?.includes(venueBrief.candidates[0]?.name ?? "?"), heatStep?.purpose);
  assert.ok(!heatStep?.purpose?.includes("mock-"), heatStep?.purpose);
});

test("LLM narrative facts carry 'not checked' instead of a bare 'unknown' trend (demo run 2026-10-14)", async () => {
  const mock = new MockQlooClient();
  const noRank: QlooClient = {
    mode: "live",
    close: async () => {},
    call: async (tool, args) => (tool === "qloo_rank" ? { operation: "rank", status: "error", results: [], error: { code: "QLOO_UPSTREAM", retryable: true, recovery: "" } } : mock.call(tool, args)),
  };
  let facts = "";
  const llm: Llm = {
    async chat(messages: ChatMessage[], tools?: ToolSpec[]): Promise<ChatResult> {
      if (tools) return { content: "DONE", toolCalls: [], provider: "fake" };
      facts = String(messages[1]?.content ?? "");
      return { content: "ok", toolCalls: [], provider: "fake" };
    },
  };
  await runAgent({ input: INPUT, qloo: noRank, llm, today: TODAY });
  const parsed = JSON.parse(facts) as { candidates: { trend: string }[]; scoreSource: string };
  assert.ok(parsed.candidates.length > 0);
  assert.ok(parsed.candidates.every((c) => c.trend === "not checked"), facts);
  assert.equal(parsed.scoreSource, "recommend");
});
