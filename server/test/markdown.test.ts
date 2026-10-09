import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgent } from "../src/agent/agent.ts";
import { briefToMarkdown, md } from "../src/agent/markdown.ts";
import { MockQlooClient } from "../src/qloo/mockClient.ts";

const TODAY = new Date("2026-10-10T12:00:00Z");

test("md() escapes links, HTML, table pipes and newlines", () => {
  assert.equal(md("[x](javascript:alert(1))"), "\\[x\\]\\(javascript:alert\\(1\\)\\)");
  assert.equal(md("<img src=x>"), "\\<img src=x\\>");
  assert.equal(md("a|b\nc"), "a\\|b c");
});

test("opener brief exports every section with a candidates table", async () => {
  const brief = await runAgent({ input: { scenario: "opener", headliner: "Band [1]", city: "Berlin", capacity: 900 }, qloo: new MockQlooClient(), today: TODAY });
  const out = briefToMarkdown(brief, "https://example.test/b/abc");
  assert.ok(out.startsWith("# Opener brief: Band \\[1\\] in Berlin"));
  for (const h of ["## Top opener candidates", "## Where the fans are", "## Audience skew", "## Local partners", "## What this does not prove", "## Agent log"]) {
    assert.ok(out.includes(h), `missing ${h}`);
  }
  assert.equal(out.split("\n").filter((l) => /^\| [1-5] \|/.test(l)).length, 5);
  assert.ok(out.includes("synthetic demo (not Qloo)"));
  assert.ok(out.includes("Permalink (expires): https://example.test/b/abc"));
});

test("venue brief uses venue wording", async () => {
  const brief = await runAgent({ input: { scenario: "venue", venue: "Hall 9", city: "Berlin", date: "2026-11-20" }, qloo: new MockQlooClient(), today: TODAY });
  const out = briefToMarkdown(brief);
  assert.ok(out.includes("## Acts to book"));
  assert.ok(out.includes("## Cross-promotion and sponsor leads"));
  assert.ok(out.includes("(venue crowd)"));
  assert.ok(!out.includes("Headliner trend"));
});
