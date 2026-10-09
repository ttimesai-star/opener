import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { cacheKey, createApp, validateInput } from "../src/app.ts";
import { MockQlooClient } from "../src/qloo/mockClient.ts";

test("validateInput accepts a normal opener request (scenario defaults to opener)", () => {
  const r = validateInput({ headliner: " Some Band ", city: "Austin", capacity: "800", dateFrom: "2026-11-01" });
  assert.deepEqual(r, { ok: true, input: { scenario: "opener", headliner: "Some Band", city: "Austin", capacity: 800, dateFrom: "2026-11-01" } });
});

test("validateInput accepts a venue request", () => {
  const r = validateInput({ scenario: "venue", venue: "Hall 9", city: "Austin", date: "2026-11-20", capacity: 450 });
  assert.deepEqual(r, { ok: true, input: { scenario: "venue", venue: "Hall 9", city: "Austin", date: "2026-11-20", capacity: 450 } });
});

test("validateInput rejects personal data and bad fields", () => {
  assert.equal(validateInput({ headliner: "me@example.com", city: "Austin" }).ok, false);
  assert.equal(validateInput({ headliner: "Band", city: "+375 29 000 00 00" }).ok, false);
  assert.equal(validateInput({ headliner: "", city: "Austin" }).ok, false);
  assert.equal(validateInput({ headliner: "Band", city: "Austin", capacity: -5 }).ok, false);
  assert.equal(validateInput({ headliner: "Band", city: "Austin", dateTo: "next week" }).ok, false);
  assert.equal(validateInput({ scenario: "venue", headliner: "Band", city: "Austin" }).ok, false); // venue needs `venue`
  assert.equal(validateInput({ scenario: "venue", venue: "Hall", city: "Austin", date: "2026-13-45" }).ok, false);
  assert.equal(validateInput({ scenario: "festival", headliner: "Band", city: "Austin" }).ok, false);
});

test("cacheKey ignores field order and case", () => {
  assert.equal(
    cacheKey({ scenario: "opener", headliner: "Band", city: "Paris" }),
    cacheKey({ city: "paris", headliner: "BAND", scenario: "opener" } as never),
  );
  assert.notEqual(cacheKey({ scenario: "opener", headliner: "X", city: "Paris" }), cacheKey({ scenario: "venue", venue: "X", city: "Paris" }));
});

let base = "";
const server = createApp({ qloo: new MockQlooClient(), llm: null, rateLimitPerHour: 4 });
before(async () => {
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** Minimal SSE parser for tests: returns [event, data] pairs. */
async function readSse(res: Response): Promise<{ event: string; data: unknown }[]> {
  const text = await res.text();
  return text.split("\n\n").filter((b) => b.trim() && !b.startsWith(":")).map((block) => {
    const event = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
    const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? "null") as unknown;
    return { event, data };
  });
}

test("GET /api/health reports mock mode", async () => {
  const res = await fetch(`${base}/api/health`);
  assert.deepEqual(await res.json(), { ok: true, qloo: "mock", llm: false });
});

test("POST /api/brief returns a brief with a permalink id, then serves the cache", async () => {
  const first = await post("/api/brief", { headliner: "Band", city: "Paris" });
  assert.equal(first.status, 200);
  const brief = (await first.json()) as { id: string; candidates: unknown[]; cached?: boolean };
  assert.equal(brief.candidates.length, 5);
  assert.match(brief.id, /^[A-Za-z0-9_-]{12}$/);
  const second = (await (await post("/api/brief", { headliner: "band", city: "PARIS" })).json()) as { id: string; cached?: boolean };
  assert.equal(second.cached, true);
  assert.equal(second.id, brief.id);
});

test("permalink: JSON and Markdown export, unknown ids are 404", async () => {
  const { id } = (await (await post("/api/brief", { scenario: "venue", venue: "Hall 9", city: "Berlin", date: "2026-11-20" })).json()) as { id: string };
  const json = await fetch(`${base}/api/briefs/${id}`);
  assert.equal(json.status, 200);
  assert.equal(((await json.json()) as { subject: { name: string } }).subject.name, "Hall 9");
  const mdRes = await fetch(`${base}/api/briefs/${id}.md`);
  assert.equal(mdRes.status, 200);
  assert.match(mdRes.headers.get("content-type") ?? "", /text\/markdown/);
  assert.match(mdRes.headers.get("content-disposition") ?? "", /attachment; filename="opener-brief-/);
  const md = await mdRes.text();
  assert.ok(md.startsWith("# Booking brief: Hall 9, Berlin, 2026-11-20"));
  assert.ok(md.includes("## What this does not prove"));
  assert.equal((await fetch(`${base}/api/briefs/AAAAAAAAAAAA`)).status, 404);
  assert.equal((await fetch(`${base}/api/briefs/..%2F..%2Fetc`)).status, 404);
});

test("POST /api/brief/stream streams start/end events for every call, then the stored brief", async () => {
  const res = await post("/api/brief/stream", { headliner: "Stream Band", city: "Austin" });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const events = await readSse(res);
  assert.equal(events[0]?.event, "ready");
  const steps = events.filter((e) => e.event === "step").map((e) => e.data as { type: string; seq: number; kind: string });
  const starts = steps.filter((s) => s.type === "start");
  const ends = steps.filter((s) => s.type === "end");
  assert.equal(starts.length, 9);
  assert.equal(ends.length, 9);
  const last = events.at(-1);
  assert.equal(last?.event, "brief");
  const brief = last?.data as { id: string; trace: unknown[] };
  assert.equal(brief.trace.length, 9);
  assert.equal((await fetch(`${base}/api/briefs/${brief.id}`)).status, 200);

  // Cached replay: the log is replayed as finished steps, then the same brief.
  const again = await readSse(await post("/api/brief/stream", { headliner: "Stream Band", city: "Austin" }));
  assert.equal(again.filter((e) => e.event === "step").length, 9);
  const cached = again.at(-1)?.data as { id: string; cached?: boolean };
  assert.equal(cached.cached, true);
  assert.equal(cached.id, brief.id);
});

test("stream endpoint validates before opening the stream", async () => {
  const res = await post("/api/brief/stream", { headliner: "", city: "Austin" });
  assert.equal(res.status, 400);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
});

test("POST /api/brief rate-limits uncached requests and rejects bad input", async () => {
  const s = createApp({ qloo: new MockQlooClient(), llm: null, rateLimitPerHour: 1 });
  await new Promise<void>((r) => s.listen(0, r));
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  assert.equal((await fetch(`${url}/api/brief`, { method: "POST", body: "{}" })).status, 400);
  assert.equal((await fetch(`${url}/api/brief`, { method: "POST", body: JSON.stringify({ headliner: "B2", city: "Rome" }) })).status, 200);
  assert.equal((await fetch(`${url}/api/brief/stream`, { method: "POST", body: JSON.stringify({ headliner: "B3", city: "Rome" }) })).status, 429);
  s.close();
});

test("spoofed X-Forwarded-For does not reset the limit without TRUST_PROXY", async () => {
  const s = createApp({ qloo: new MockQlooClient(), llm: null, rateLimitPerHour: 1 });
  await new Promise<void>((r) => s.listen(0, r));
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/api/brief`;
  const p = (h: string, xff: string) => fetch(url, { method: "POST", headers: { "x-forwarded-for": xff }, body: JSON.stringify({ headliner: h, city: "Oslo" }) });
  assert.equal((await p("S1", "1.1.1.1")).status, 200);
  assert.equal((await p("S2", "2.2.2.2")).status, 429);
  s.close();
});

test("stored briefs expire after the TTL and the store is capped", async () => {
  const s = createApp({ qloo: new MockQlooClient(), llm: null, briefTtlMs: 50, maxStoredBriefs: 2 });
  await new Promise<void>((r) => s.listen(0, r));
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const mk = async (h: string) => ((await (await fetch(`${url}/api/brief`, { method: "POST", body: JSON.stringify({ headliner: h, city: "Oslo" }) })).json()) as { id: string }).id;
  const a = await mk("T1");
  await mk("T2");
  await mk("T3"); // evicts T1 (cap 2)
  assert.equal((await fetch(`${url}/api/briefs/${a}`)).status, 404);
  const d = await mk("T4");
  await new Promise((r) => setTimeout(r, 80));
  assert.equal((await fetch(`${url}/api/briefs/${d}`)).status, 404);
  s.close();
});
