// Support-slot popularity ceiling (round 3, 15.10): live, every act the harness
// recommended for Radiohead was itself a headliner (Beck, Smashing Pumpkins,
// Interpol, top 0.05%). /v2/insights takes filter.popularity.max for artists;
// the agent asks for smaller acts and widens the ceiling when too few come back.
// Numbers are synthetic, shaped like the live ones.

import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgent } from "../src/agent/agent.ts";
import type { ChatMessage, ChatResult, Llm, ToolSpec } from "../src/agent/llm.ts";
import { repairLlmArgs } from "../src/agent/planner.ts";
import { supportCeilings } from "../src/agent/popularity.ts";
import { insightsQuery, recommendWithPopularityCeiling } from "../src/qloo/insights.ts";
import { McpQlooClient } from "../src/qloo/mcpClient.ts";
import { MockQlooClient } from "../src/qloo/mockClient.ts";
import type { QlooClient, QlooEnvelope, QlooToolName } from "../src/qloo/types.ts";

const TODAY = new Date("2026-10-10T12:00:00Z");
const INPUT = { scenario: "opener" as const, headliner: "Big Headliner", city: "Berlin" };
const HEAD_ID = "70CAE5BF-2F4C-445C-A3E5-4EDACFC3591C";
const ok = (operation: string, results: unknown[]): QlooEnvelope => ({ operation, status: "ok", results, result_count: results.length });

test("ceilings are relative to the headliner and widen step by step", () => {
  // Radiohead live 15.10: popularity 0.9999966 (top 0.00034%).
  assert.deepEqual(supportCeilings(0.9999966263060412), [0.996626, 0.999662]);
  // Mid-size headliner (top 2%): the first window is capped at the top 25%, the second at the top 10%.
  assert.deepEqual(supportCeilings(0.979467720477885), [0.75, 0.9]);
  // Small headliner: never more popular than the headliner itself.
  assert.deepEqual(supportCeilings(0.59), [0.59]);
  for (const bad of [null, undefined, Number.NaN, 0, 1, 1.2]) assert.deepEqual(supportCeilings(bad as number), []);
  const c = supportCeilings(0.9999);
  assert.ok(c.every((x, i) => i === 0 || x > (c[i - 1] as number)), "each step lets more popular acts in");
});

/** Live-shaped Qloo that honours filter.popularity.max: stars, mid-size acts and small acts. */
function shaped(opts: { small: number; mid: number; inactive?: boolean }): { qloo: QlooClient; calls: { tool: string; args: Record<string, unknown> }[] } {
  const mock = new MockQlooClient();
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const acts = [
    ...Array.from({ length: 6 }, (_, i) => ({ name: `Star ${i + 1}`, popularity: 0.9997 + i * 0.00001, affinity: 0.97 - i * 0.001 })),
    ...Array.from({ length: opts.mid }, (_, i) => ({ name: `Mid ${i + 1}`, popularity: 0.998 + i * 0.0001, affinity: 0.95 - i * 0.001 })),
    ...Array.from({ length: opts.small }, (_, i) => ({ name: `Small ${i + 1}`, popularity: 0.99 - i * 0.001, affinity: 0.93 - i * 0.001 })),
    ...(opts.inactive ? [{ name: "Old Name Band", popularity: 0.91, affinity: 0.94, end_year: 1991 }] : []),
  ];
  return {
    calls,
    qloo: {
      mode: "live",
      close: async () => {},
      call: async (tool: QlooToolName, args: Record<string, unknown>) => {
        calls.push({ tool, args });
        if (tool === "qloo_describe") return ok("describe", [{ entity_id: HEAD_ID, name: "Big Headliner", popularity: 0.9999966 }]);
        if (tool === "qloo_recommend" && args.target_type === "artist") {
          const max = args.popularity_max;
          const pool = typeof max === "number" ? acts.filter((a) => a.popularity <= max) : acts;
          return ok("recommend", pool.slice(0, Number(args.limit ?? 10)).map((a, i) => ({
            entity_id: `ID-${a.name}`, name: a.name, popularity: a.popularity, affinity: a.affinity,
            properties: { short_description: "A fictional band.", ...("end_year" in a ? { end_year: a.end_year } : {}) },
          })));
        }
        if (tool === "qloo_rank") {
          const options = (args.options as string[]) ?? [];
          return ok("rank", options.map((name, i) => ({ entity_id: `ID-${name}`, name, popularity: acts.find((a) => a.name === name)?.popularity, affinity: 0.9 - i * 0.01 })));
        }
        return mock.call(tool, args);
      },
    },
  };
}

const artistCalls = (calls: { tool: string; args: Record<string, unknown> }[]) => calls.filter((c) => c.tool === "qloo_recommend" && c.args.target_type === "artist");

test("opener: the candidate pool asks Qloo for smaller acts; no star reaches the brief", async () => {
  const { qloo, calls } = shaped({ small: 12, mid: 4 });
  const brief = await runAgent({ input: INPUT, qloo, today: TODAY });
  const rec = artistCalls(calls);
  assert.equal(rec.length, 1);
  assert.equal(rec[0]?.args.popularity_max, 0.9966);
  assert.deepEqual(rec[0]?.args.signals, [HEAD_ID]);
  assert.equal(brief.candidates.length, 5);
  assert.ok(brief.candidates.every((c) => c.name.startsWith("Small ")), brief.candidates.map((c) => c.name).join(", "));
  // Under the ceiling the shortlist follows Qloo's affinity order, not "least popular first".
  const rank = calls.find((c) => c.tool === "qloo_rank");
  assert.deepEqual(rank?.args.options, Array.from({ length: 10 }, (_, i) => `Small ${i + 1}`));
  assert.ok(brief.caveats.some((c) => c.startsWith("Candidates are limited to acts outside Qloo's top 0.34% by popularity (Big Headliner: top 0.00034%)")), brief.caveats.join(" | "));
  assert.ok(!brief.caveats.some((c) => c.includes("widened")));
  assert.ok(!brief.caveats.some((c) => c.startsWith("Every act Qloo recommended")));
});

test("opener: too few acts under the first ceiling -> widened once, and the brief says so", async () => {
  const { qloo, calls } = shaped({ small: 2, mid: 8 });
  const brief = await runAgent({ input: INPUT, qloo, today: TODAY });
  const ceilings = artistCalls(calls).map((c) => c.args.popularity_max);
  assert.deepEqual(ceilings, supportCeilings(0.9999966));
  assert.ok(brief.candidates.length === 5 && brief.candidates.every((c) => !c.name.startsWith("Star")), brief.candidates.map((c) => c.name).join(", "));
  assert.ok(brief.caveats.some((c) => c.startsWith("Candidates are limited") && c.includes("so it was widened")), brief.caveats.join(" | "));
  const widen = brief.trace.filter((s) => s.tool === "qloo_recommend" && s.args.target_type === "artist");
  assert.equal(widen.length, 2);
  assert.ok(widen[1]?.purpose?.startsWith("Too few smaller acts; widening"), widen[1]?.purpose);
});

test("opener: nothing under either ceiling -> the unfiltered harness pool, as before, with the reason", async () => {
  const { qloo, calls } = shaped({ small: 0, mid: 0 });
  const brief = await runAgent({ input: INPUT, qloo, today: TODAY });
  const rec = artistCalls(calls);
  assert.equal(rec.length, 3);
  assert.equal(rec[2]?.args.popularity_max, undefined, "last step is the plain harness call");
  assert.ok(brief.caveats.some((c) => c.startsWith("Every act Qloo recommended here is in the top 1%") && c.includes("returned fewer than 5 usable acts")), brief.caveats.join(" | "));
});

test("an act Qloo lists with an end year is not offered (live 15.10: 'On a Friday', Radiohead until 1991)", async () => {
  const { qloo, calls } = shaped({ small: 12, mid: 0, inactive: true });
  const brief = await runAgent({ input: INPUT, qloo, today: TODAY });
  const rank = calls.find((c) => c.tool === "qloo_rank");
  assert.ok(!(rank?.args.options as string[]).includes("Old Name Band"));
  assert.ok(!brief.candidates.some((c) => c.name === "Old Name Band"));
  assert.ok(brief.caveats.includes("Left out as no longer active (Qloo lists an end year): Old Name Band (1991)."), brief.caveats.join(" | "));
});

test("LLM path: the ceiling and the headliner id are added to the model's artist recommendation", async () => {
  const { qloo, calls } = shaped({ small: 12, mid: 0 });
  let turn = 0;
  const llm: Llm = {
    chat: async (_m: ChatMessage[], tools?: ToolSpec[]): Promise<ChatResult> => {
      if (!tools) return { content: "Narrative.", toolCalls: [], provider: "fake" };
      turn++;
      const call = (name: string, args: Record<string, unknown>) => ({ content: null, provider: "fake", toolCalls: [{ id: String(turn), type: "function" as const, function: { name, arguments: JSON.stringify(args) } }] });
      if (turn === 1) return call("qloo_describe", { entity: INPUT.headliner, type: "artist" });
      if (turn === 2) return call("qloo_recommend", { target_type: "artist", signals: [INPUT.headliner], signal_location: INPUT.city });
      return { content: "DONE", toolCalls: [], provider: "fake" };
    },
  };
  const brief = await runAgent({ input: INPUT, qloo, llm, today: TODAY });
  const rec = artistCalls(calls)[0];
  assert.equal(rec?.args.popularity_max, 0.9966);
  assert.deepEqual(rec?.args.signals, [HEAD_ID]);
  assert.ok(brief.candidates.every((c) => c.name.startsWith("Small ")));
  // The model cannot set the ceiling on other calls.
  const repaired = repairLlmArgs(INPUT, [], "qloo_recommend", { target_type: "brand", popularity_max: 0.1 });
  assert.equal(repaired.popularity_max, undefined);
});

test("venue scenario: no headliner, so no ceiling", async () => {
  const qloo = new MockQlooClient();
  await runAgent({ input: { scenario: "venue", venue: "Hall 9", city: "Berlin" }, qloo, today: TODAY });
  assert.ok(qloo.calls.every((c) => c.args.popularity_max === undefined));
});

test("mock opener run uses the ceiling and keeps five candidates", async () => {
  const qloo = new MockQlooClient();
  const brief = await runAgent({ input: { scenario: "opener", headliner: "Band", city: "Berlin" }, qloo, today: TODAY });
  const rec = qloo.calls.filter((c) => c.tool === "qloo_recommend" && c.args.target_type === "artist");
  assert.ok(typeof rec[0]?.args.popularity_max === "number");
  assert.equal(brief.candidates.length, 5);
  const last = rec[rec.length - 1]?.args.popularity_max;
  if (typeof last === "number") assert.ok(brief.candidates.every((c) => c.popularity === null || c.popularity <= last));
});

test("direct Insights call: documented parameters, key only in the header, errors mapped", async () => {
  const q = insightsQuery({ target_type: "artist", signals: [HEAD_ID], signal_location: "Berlin", limit: 20, popularity_max: 0.996626 });
  assert.deepEqual(q, { "filter.type": "urn:entity:artist", "signal.interests.entities": HEAD_ID, "filter.popularity.max": "0.996626", take: "20", "signal.location.query": "Berlin" });
  assert.ok("error" in insightsQuery({ target_type: "artist", signals: ["Radiohead"], popularity_max: 0.9 }), "a bare name is not sent");
  assert.ok("error" in insightsQuery({ target_type: "place", signals: [HEAD_ID], popularity_max: 0.9 }));
  assert.ok("error" in insightsQuery({ target_type: "artist", signals: [HEAD_ID], popularity_max: 1 }));

  let seen: { url: string; headers: Record<string, string> } | null = null;
  const fake = (status: number, body: unknown) => (async (url: string | URL | Request, init?: RequestInit) => {
    seen = { url: String(url), headers: init?.headers as Record<string, string> };
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  const args = { target_type: "artist", signals: [HEAD_ID], signal_location: "Berlin", limit: 20, popularity_max: 0.99 };
  const okEnv = await recommendWithPopularityCeiling(args, { baseUrl: "https://hackathon.api.qloo.com/", apiKey: "secret-key-123", fetchImpl: fake(200, { results: { entities: [{ name: "A", entity_id: "x", popularity: 0.5, query: { affinity: 0.9 } }] } }) });
  assert.equal(okEnv.status, "ok");
  assert.equal(okEnv.result_count, 1);
  const s = seen as unknown as { url: string; headers: Record<string, string> };
  assert.ok(s.url.startsWith("https://hackathon.api.qloo.com/v2/insights?"));
  assert.ok(s.url.includes("filter.popularity.max=0.99") && !s.url.includes("secret-key-123"));
  assert.equal(s.headers["X-Api-Key"], "secret-key-123");
  assert.ok(!JSON.stringify(okEnv).includes("secret-key-123"), "the key is not in the envelope or its request record");

  assert.equal((await recommendWithPopularityCeiling(args, { baseUrl: "https://h.test", apiKey: "k", fetchImpl: fake(200, { results: { entities: [] } }) })).status, "empty");
  const limited = await recommendWithPopularityCeiling(args, { baseUrl: "https://h.test", apiKey: "k", fetchImpl: fake(429, {}) });
  assert.equal(limited.error?.code, "QLOO_RATE_LIMIT");
  assert.equal((await recommendWithPopularityCeiling(args, { baseUrl: "https://h.test", apiKey: "k", fetchImpl: fake(500, {}) })).status, "error");
  seen = null;
  const plain = await recommendWithPopularityCeiling(args, { baseUrl: "http://h.test", apiKey: "k", fetchImpl: fake(200, {}) });
  assert.equal(plain.status, "error");
  assert.equal(seen, null, "no request over plain http");
  assert.equal((await recommendWithPopularityCeiling(args, { baseUrl: "https://h.test", apiKey: " ", fetchImpl: fake(200, {}) })).error?.code, "INVALID_CONFIG");
});

test("live client sends only the ceiling call to /v2/insights, without starting the harness", async () => {
  let url = "";
  const client = new McpQlooClient({
    command: "opener-no-such-binary-xyz",
    env: { QLOO_API_KEY: "k-123" },
    fetchImpl: (async (u: string | URL | Request) => { url = String(u); return new Response(JSON.stringify({ results: { entities: [] } }), { status: 200 }); }) as typeof fetch,
  });
  const env = await client.call("qloo_recommend", { target_type: "artist", signals: [HEAD_ID], popularity_max: 0.99 });
  assert.equal(env.status, "empty");
  assert.ok(url.startsWith("https://hackathon.api.qloo.com/v2/insights?"), url);
  await client.close();
});
