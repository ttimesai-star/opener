import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createApp, validateInput } from "../src/app.ts";
import { MockQlooClient } from "../src/qloo/mockClient.ts";

test("validateInput accepts a normal request", () => {
  const r = validateInput({ headliner: " Some Band ", city: "Austin", capacity: "800", dateFrom: "2026-11-01" });
  assert.deepEqual(r, { ok: true, input: { headliner: "Some Band", city: "Austin", capacity: 800, dateFrom: "2026-11-01" } });
});

test("validateInput rejects personal data and bad fields", () => {
  assert.equal(validateInput({ headliner: "me@example.com", city: "Austin" }).ok, false);
  assert.equal(validateInput({ headliner: "Band", city: "+375 29 000 00 00" }).ok, false);
  assert.equal(validateInput({ headliner: "", city: "Austin" }).ok, false);
  assert.equal(validateInput({ headliner: "Band", city: "Austin", capacity: -5 }).ok, false);
  assert.equal(validateInput({ headliner: "Band", city: "Austin", dateTo: "next week" }).ok, false);
});

let base = "";
const server = createApp({ qloo: new MockQlooClient(), llm: null, rateLimitPerHour: 2 });
before(async () => {
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

test("GET /api/health reports mock mode", async () => {
  const res = await fetch(`${base}/api/health`);
  assert.deepEqual(await res.json(), { ok: true, qloo: "mock", llm: false });
});

test("POST /api/brief returns a brief, then serves the cache", async () => {
  const body = JSON.stringify({ headliner: "Band", city: "Paris" });
  const first = await fetch(`${base}/api/brief`, { method: "POST", body });
  assert.equal(first.status, 200);
  const brief = (await first.json()) as { openers: unknown[]; cached?: boolean };
  assert.equal(brief.openers.length, 5);
  const second = (await (await fetch(`${base}/api/brief`, { method: "POST", body })).json()) as { cached?: boolean };
  assert.equal(second.cached, true);
});

test("POST /api/brief rate-limits uncached requests and rejects bad input", async () => {
  assert.equal((await fetch(`${base}/api/brief`, { method: "POST", body: "{}" })).status, 400);
  await fetch(`${base}/api/brief`, { method: "POST", body: JSON.stringify({ headliner: "B2", city: "Rome" }) });
  const limited = await fetch(`${base}/api/brief`, { method: "POST", body: JSON.stringify({ headliner: "B3", city: "Rome" }) });
  assert.equal(limited.status, 429);
});
