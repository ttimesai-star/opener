import assert from "node:assert/strict";
import { test } from "node:test";
import { createQlooClient } from "../src/qloo/index.ts";
import { McpQlooClient } from "../src/qloo/mcpClient.ts";

test("live client spawns the harness with the env passed to createQlooClient (Jules review 2026-10-13)", async () => {
  const env = { QLOO_API_KEY: "test-key", QLOO_BASE_URL: "https://example.invalid", QLOO_BIN: "custom-qloo" };
  const client = await createQlooClient(env);
  assert.ok(client instanceof McpQlooClient);
  const spawned = client.spawnEnv();
  assert.equal(spawned.QLOO_API_KEY, "test-key");
  assert.equal(spawned.QLOO_BASE_URL, "https://example.invalid");
  assert.equal(spawned.QLOO_TRUSTED_BASE_URL, "https://example.invalid");
  assert.equal(spawned.PATH ?? spawned.Path, undefined, "process.env does not leak in when an env is given");
  assert.equal(client.command, "custom-qloo");
});

test("warm-up of a harness that cannot start rejects (the server logs it) and the next call connects afresh", async () => {
  // The error text differs by platform (ENOENT -> install hint on Linux, "Connection closed" via a Windows shell).
  const client = new McpQlooClient({ command: "opener-no-such-binary-xyz", env: { QLOO_API_KEY: "k" } });
  await assert.rejects(client.warmUp());
  await assert.rejects(client.call("qloo_describe", { entity: "x" }));
  await client.close();
});
