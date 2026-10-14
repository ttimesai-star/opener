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
