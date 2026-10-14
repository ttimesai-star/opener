import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenAiCompatibleLlm, toStrictMessages, type ChatMessage } from "../src/agent/llm.ts";

// A history the way a Gemini tool turn leaves it: tool_calls carry
// extra_content (thought signature) and ids Mistral does not accept.
const GEMINI_HISTORY: ChatMessage[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "{}" },
  {
    role: "assistant", content: null,
    tool_calls: [
      { id: "function-call-1", type: "function", function: { name: "qloo_describe", arguments: "{\"entity\":\"X\"}" }, extra_content: { google: { thought_signature: "sig" } } },
      { id: "function-call-2", type: "function", function: { name: "qloo_recommend", arguments: "{}" }, extra_content: { google: { thought_signature: "sig2" } } },
    ],
  },
  { role: "tool", tool_call_id: "function-call-1", content: "{\"status\":\"ok\"}" },
  { role: "tool", tool_call_id: "function-call-2", content: "{\"status\":\"ok\"}" },
];

// Mistral-like validation: unknown fields or non-9-alphanumeric ids -> 422.
function mistralLike(body: { messages: Record<string, unknown>[] }): string | null {
  const allowedMsg = new Set(["role", "content", "tool_calls", "tool_call_id"]);
  for (const m of body.messages) {
    for (const k of Object.keys(m)) if (!allowedMsg.has(k)) return `extra field ${k}`;
    for (const c of (m.tool_calls as Record<string, unknown>[] | undefined) ?? []) {
      for (const k of Object.keys(c)) if (!["id", "type", "function"].includes(k)) return `extra field tool_calls.${k}`;
      if (!/^[A-Za-z0-9]{9}$/.test(String(c.id))) return `bad id ${String(c.id)}`;
    }
    if (m.tool_call_id !== undefined && !/^[A-Za-z0-9]{9}$/.test(String(m.tool_call_id))) return `bad tool_call_id ${String(m.tool_call_id)}`;
  }
  return null;
}

test("fallback provider gets plain OpenAI messages; Gemini keeps its extra_content (demo run 2026-10-14: Mistral 422)", async () => {
  const sent: { url: string; body: { messages: Record<string, unknown>[] } }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { messages: Record<string, unknown>[] };
    sent.push({ url, body });
    if (url.includes("googleapis")) return new Response("bad", { status: 400 });
    const problem = mistralLike(body);
    if (problem) return new Response(JSON.stringify({ detail: problem }), { status: 422 });
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok", tool_calls: [] } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const llm = new OpenAiCompatibleLlm([
    { name: "primary", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: "k1", model: "g" },
    { name: "fallback", baseUrl: "https://api.mistral.ai/v1", apiKey: "k2", model: "m" },
  ], 5000, fakeFetch);
  const res = await llm.chat(GEMINI_HISTORY);
  assert.equal(res.provider, "fallback");
  const gemini = sent.find((s) => s.url.includes("googleapis"));
  assert.ok(JSON.stringify(gemini?.body).includes("thought_signature"), "Gemini must get its signature back");
  const mistral = sent.find((s) => s.url.includes("mistral"));
  assert.ok(!JSON.stringify(mistral?.body).includes("extra_content"));
});

test("strict messages map tool call ids consistently and keep valid ones", () => {
  const out = toStrictMessages([...GEMINI_HISTORY, { role: "assistant", content: "x", tool_calls: [{ id: "abcDEF123", type: "function", function: { name: "n", arguments: "{}" } }] }, { role: "tool", tool_call_id: "abcDEF123", content: "r" }]);
  const calls = (out[2]?.tool_calls as { id: string }[]).map((c) => c.id);
  assert.equal(new Set(calls).size, 2);
  assert.equal(out[3]?.tool_call_id, calls[0]);
  assert.equal(out[4]?.tool_call_id, calls[1]);
  assert.equal(out[2]?.content, "");
  assert.equal((out[5]?.tool_calls as { id: string }[])[0]?.id, "abcDEF123");
  assert.equal(out[6]?.tool_call_id, "abcDEF123");
  assert.equal(mistralLike({ messages: out }), null);
});
