// P1-4 (demo 14.10): Beck and Arcade Fire were offered as openers for Radiohead,
// and the popularity column read 100 for every act. Qloo popularity is a
// percentile; live neighbours of a big headliner all sit above 0.998. Numbers
// below are synthetic, shaped like the live ones (no Qloo data in the repo).

import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgent } from "../src/agent/agent.ts";
import type { ChatMessage, ChatResult, Llm, ToolSpec } from "../src/agent/llm.ts";
import { briefToMarkdown } from "../src/agent/markdown.ts";
import { isCoHeadline, popularityLabel } from "../src/agent/popularity.ts";
import { MockQlooClient } from "../src/qloo/mockClient.ts";
import type { QlooClient, QlooEnvelope, QlooToolName } from "../src/qloo/types.ts";

const TODAY = new Date("2026-10-10T12:00:00Z");
const INPUT = { scenario: "opener" as const, headliner: "Big Headliner", city: "Berlin" };

test("popularity label: 'top x%' keeps acts near the top apart", () => {
  assert.equal(popularityLabel(0.9986), "top 0.14%");
  assert.equal(popularityLabel(0.99967), "top 0.033%");
  assert.equal(popularityLabel(0.9999966), "top 0.00034%");
  assert.equal(popularityLabel(0.5), "top 50%");
  assert.equal(popularityLabel(1), "top <0.0001%");
  assert.equal(popularityLabel(null), "n/a");
  assert.notEqual(popularityLabel(0.9986), popularityLabel(0.9999));
});

test("co-headline: as popular as the headliner, or within 10x on the 'top %' scale", () => {
  assert.equal(isCoHeadline(0.99999, 0.99999), true);
  assert.equal(isCoHeadline(0.99995, 0.99999), true); // top 0.005% vs 0.001%
  assert.equal(isCoHeadline(0.9998, 0.99999), false); // top 0.02%: 20x smaller
  assert.equal(isCoHeadline(0.6, 0.97), false);
  assert.equal(isCoHeadline(null, 0.99), false);
  assert.equal(isCoHeadline(0.99, null), false);
});

const ok = (operation: string, results: unknown[]): QlooEnvelope => ({ operation, status: "ok", results, result_count: results.length });

/** Live-shaped Qloo: a very popular headliner, `big` co-headline acts and `small` smaller ones, all in the top 1%. */
function liveShaped(big: number, small: number): { qloo: QlooClient; rankOptions: () => string[] } {
  const mock = new MockQlooClient();
  const acts = [
    ...Array.from({ length: big }, (_, i) => ({ name: `Star ${i + 1}`, popularity: 0.99998 - i * 0.000001, affinity: 0.98 - i * 0.001 })),
    ...Array.from({ length: small }, (_, i) => ({ name: `Act ${String.fromCharCode(65 + i)}`, popularity: 0.9998 - i * 0.0001, affinity: 0.97 - i * 0.001 })),
  ];
  let options: string[] = [];
  return {
    rankOptions: () => options,
    qloo: {
      mode: "live",
      close: async () => {},
      call: async (tool: QlooToolName, args: Record<string, unknown>) => {
        if (tool === "qloo_describe") return ok("describe", [{ entity_id: "HEAD-ID", name: "Big Headliner", popularity: 0.99999 }]);
        if (tool === "qloo_recommend" && args.target_type === "artist") {
          return ok("recommend", acts.slice(0, Number(args.limit ?? 10)).map((a, i) => ({ entity_id: `ID-${i}`, name: a.name, popularity: a.popularity, affinity: a.affinity, properties: { short_description: "A fictional band." } })));
        }
        if (tool === "qloo_rank") {
          options = (args.options as string[]) ?? [];
          return ok("rank", options.map((name, i) => ({ entity_id: `R-${name}`, name, popularity: acts.find((a) => a.name === name)?.popularity, affinity: 0.9 - i * 0.01 })));
        }
        return mock.call(tool, args);
      },
    },
  };
}

test("opener: co-headline acts are left out, the 10 least popular smaller acts are ranked, the table tells them apart", async () => {
  const { qloo, rankOptions } = liveShaped(3, 17);
  const brief = await runAgent({ input: INPUT, qloo, today: TODAY });
  const options = rankOptions();
  assert.equal(options.length, 10);
  assert.ok(options.every((n) => n.startsWith("Act ")), options.join(", "));
  // Least popular first: the last of the 17 smaller acts are the ones sent.
  assert.ok(options.includes("Act Q") && !options.includes("Act A"), options.join(", "));
  assert.equal(brief.candidates.length, 5);
  assert.ok(brief.candidates.every((c) => !c.name.startsWith("Star")));
  assert.ok(brief.caveats.some((c) => c.startsWith("Left out as co-headline level") && c.includes("Star 1 (top 0.002%)")), brief.caveats.join(" | "));
  assert.ok(brief.caveats.some((c) => c.startsWith("Every act Qloo recommended here is in the top 1%")));
  assert.equal(brief.subject.popularity, 0.99999);
  const labels = new Set(brief.candidates.map((c) => popularityLabel(c.popularity)));
  assert.ok(labels.size > 1, "popularity no longer reads the same for every act");
  const md = briefToMarkdown(brief);
  assert.match(md, /\| Qloo popularity \|/);
  assert.match(md, /top 0\.0\d+%/);
  assert.match(md, /headliner Qloo popularity: top 0\.001%/);
});

test("opener: too few smaller acts -> co-headline acts stay, flagged", async () => {
  const { qloo, rankOptions } = liveShaped(8, 3);
  const brief = await runAgent({ input: INPUT, qloo, today: TODAY });
  assert.equal(rankOptions().length, 10);
  assert.equal(rankOptions()[0], "Act C", "least popular first");
  assert.ok(brief.candidates.some((c) => c.name.startsWith("Star")));
  assert.ok(brief.caveats.some((c) => c.startsWith("Shown although at co-headline level")), brief.caveats.join(" | "));
});

test("LLM path: a rank over co-headline acts is replaced by the support shortlist", async () => {
  const { qloo, rankOptions } = liveShaped(3, 17);
  let turn = 0;
  const call = (id: string, name: string, args: Record<string, unknown>) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
  const llm: Llm = {
    async chat(_m: ChatMessage[], tools?: ToolSpec[]): Promise<ChatResult> {
      if (!tools) return { content: "Narrative.", toolCalls: [], provider: "fake" };
      turn++;
      if (turn === 1) return { content: null, provider: "fake", toolCalls: [call("1", "qloo_describe", { entity: "Big Headliner", type: "artist" })] };
      if (turn === 2) return { content: null, provider: "fake", toolCalls: [call("2", "qloo_recommend", { target_type: "artist", signals: ["HEAD-ID"], signal_location: "Berlin", limit: 20 })] };
      if (turn === 3) return { content: null, provider: "fake", toolCalls: [call("3", "qloo_rank", { options: ["Star 1", "Star 2", "Star 3", "Act A"], option_type: "artist", signals: ["HEAD-ID"] })] };
      return { content: "DONE", toolCalls: [], provider: "fake" };
    },
  };
  const brief = await runAgent({ input: INPUT, qloo, llm, today: TODAY });
  assert.ok(rankOptions().every((n) => n.startsWith("Act ")), rankOptions().join(", "));
  assert.ok(brief.trace.some((s) => s.actor === "llm" && s.tool === "qloo_rank"));
});

test("venue scenario keeps the recommendation order and has no co-headline notes", async () => {
  const brief = await runAgent({ input: { scenario: "venue", venue: "Some Hall", city: "Berlin" }, qloo: new MockQlooClient(), today: TODAY });
  assert.ok(!brief.caveats.some((c) => c.includes("co-headline")));
  assert.ok(brief.candidates.length > 0);
});
