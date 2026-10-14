import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBrief } from "../src/agent/brief.ts";
import { briefToMarkdown } from "../src/agent/markdown.ts";
import type { EvidenceItem } from "../src/agent/types.ts";
import { MockQlooClient } from "../src/qloo/mockClient.ts";
import type { QlooEnvelope, QlooToolName } from "../src/qloo/types.ts";

const TODAY = new Date("2026-10-10T12:00:00Z");
const INPUT = { scenario: "opener" as const, headliner: "Test Headliner", city: "Berlin" };
const RANK_ERROR: QlooEnvelope = { operation: "rank", status: "error", results: [], error: { code: "QLOO_RATE_LIMIT", retryable: true, recovery: "Wait for the Qloo rate-limit window." } };

async function evidenceUpToRank(): Promise<{ mock: MockQlooClient; evidence: EvidenceItem[]; options: string[] }> {
  const mock = new MockQlooClient();
  const evidence: EvidenceItem[] = [];
  const add = async (tool: QlooToolName, args: Record<string, unknown>) => {
    const envelope = await mock.call(tool, args);
    evidence.push({ tool, args, envelope });
    return envelope;
  };
  await add("qloo_describe", { entity: INPUT.headliner, type: "artist" });
  const rec = await add("qloo_recommend", { target_type: "artist", signals: ["x"], signal_location: "Berlin", limit: 12 });
  const options = (rec.results as { name: string }[]).map((r) => r.name);
  return { mock, evidence, options };
}

test("rank failed: scores and every label say they come from the recommendation (demo run 2026-10-14)", async () => {
  const { evidence, options } = await evidenceUpToRank();
  evidence.push({ tool: "qloo_rank", args: { options, option_type: "artist" }, envelope: RANK_ERROR });
  const brief = buildBrief({ input: INPUT, mode: "live", agent: "planner", evidence, trace: [], now: TODAY });
  assert.equal(brief.scoreSource, "recommend");
  assert.ok(brief.candidates.length > 0);
  assert.ok(!brief.narrative.includes("Qloo ranked"), brief.narrative);
  assert.ok(brief.narrative.includes("Qloo recommended"), brief.narrative);
  assert.ok(!brief.caveats.some((c) => c.includes("within this one Qloo rank call")), brief.caveats.join(" | "));
  assert.ok(brief.caveats.some((c) => c.includes("recommendation call")));
  assert.ok(brief.caveats.some((c) => c.includes("qloo_rank failed")));
  const md = briefToMarkdown(brief);
  assert.ok(!md.includes("acts Qloo ranked"), "markdown still says ranked");
  assert.ok(md.includes("acts Qloo recommended"));
});

test("rank failed then retried successfully: rank scores, no stale 'qloo_rank failed' caveat", async () => {
  const { mock, evidence, options } = await evidenceUpToRank();
  const args = { options, option_type: "artist", signals: ["x"], signal_location: "Berlin" };
  evidence.push({ tool: "qloo_rank", args, envelope: RANK_ERROR });
  evidence.push({ tool: "qloo_rank", args, envelope: await mock.call("qloo_rank", args) });
  const brief = buildBrief({ input: INPUT, mode: "live", agent: "llm", evidence, trace: [], now: TODAY });
  assert.equal(brief.scoreSource, "rank");
  assert.ok(brief.narrative.includes("Qloo ranked"));
  assert.ok(!brief.caveats.some((c) => c.includes("qloo_rank failed")), brief.caveats.join(" | "));
});

test("a failure that was never retried stays in the caveats", async () => {
  const { evidence, options } = await evidenceUpToRank();
  evidence.push({ tool: "qloo_rank", args: { options, option_type: "artist" }, envelope: RANK_ERROR });
  evidence.push({ tool: "qloo_where_popular", args: { entity: "x", within: "Berlin" }, envelope: { operation: "where_popular", status: "error", results: [], error: { code: "QLOO_UPSTREAM", retryable: true, recovery: "" } } });
  const brief = buildBrief({ input: INPUT, mode: "live", agent: "planner", evidence, trace: [], now: TODAY });
  assert.ok(brief.caveats.some((c) => c.includes("qloo_where_popular failed")));
});

test("trends never queried: the narrative says 'not checked', not 'no clear rise' (demo run 2026-10-14)", async () => {
  const { evidence, options } = await evidenceUpToRank();
  evidence.push({ tool: "qloo_rank", args: { options, option_type: "artist" }, envelope: RANK_ERROR });
  const brief = buildBrief({ input: INPUT, mode: "live", agent: "planner", evidence, trace: [], now: TODAY });
  assert.ok(brief.candidates.every((c) => c.trend === "unknown"));
  assert.ok(!/clear 90-day rise/.test(brief.narrative), brief.narrative);
  assert.ok(brief.narrative.includes("not checked"), brief.narrative);
});

test("trend notes: acts left out of the trends call are 'not checked', acts asked about with no series 'no trend data'", async () => {
  const { mock, evidence, options } = await evidenceUpToRank();
  const rankArgs = { options, option_type: "artist", signals: ["x"], signal_location: "Berlin" };
  const rank = await mock.call("qloo_rank", rankArgs);
  evidence.push({ tool: "qloo_rank", args: rankArgs, envelope: rank });
  const top = (rank.results as { entity_id: string }[]).map((r) => r.entity_id);
  // Asked about the top two only; Qloo returned no series at all.
  const trendArgs = { entities: top.slice(0, 2), entity_type: "artist" };
  evidence.push({ tool: "qloo_trends", args: trendArgs, envelope: { operation: "trends", status: "ok", results: [] } });
  const trace = [{ index: 1, actor: "planner" as const, tool: "qloo_trends" as const, args: trendArgs, status: "ok" as const, summary: "", durationMs: 1 }];
  const brief = buildBrief({ input: INPUT, mode: "live", agent: "planner", evidence, trace, now: TODAY });
  assert.ok(!/clear 90-day rise/.test(brief.narrative), brief.narrative);
  assert.ok(brief.narrative.includes("no 90-day trend data for"), brief.narrative);
  assert.ok(brief.narrative.includes("not checked for"), brief.narrative);
});
