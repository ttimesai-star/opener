import { fileURLToPath } from "node:url";
import { createLlm } from "./agent/llm.ts";
import { createApp } from "./app.ts";
import { createQlooClient } from "./qloo/index.ts";

const port = Number(process.env.PORT ?? 8787);
const staticDir = process.env.STATIC_DIR ?? fileURLToPath(new URL("../../web/dist", import.meta.url));

const qloo = await createQlooClient();
const llm = createLlm();
const ttlHours = Number(process.env.BRIEF_TTL_HOURS);
const server = createApp({
  qloo, llm, staticDir,
  allowedOrigin: process.env.ALLOWED_ORIGIN,
  trustProxy: process.env.TRUST_PROXY === "1",
  // Shared-brief links live in server memory only; a restart or the TTL ends them.
  briefTtlMs: ttlHours > 0 ? Math.min(ttlHours, 168) * 3600_000 : undefined,
});

server.listen(port, () => {
  console.log(`opener listening on :${port} (qloo=${qloo.mode}, llm=${llm ? "on" : "off -> scripted planner"})`);
  // Start the harness now so the first brief does not wait for it; a failure here is retried on the first call.
  const started = Date.now();
  qloo.warmUp?.().then(
    () => console.log(`qloo harness ready in ${Date.now() - started} ms`),
    (error: Error) => console.warn(`qloo harness warm-up failed (retried on first call): ${error.message}`),
  );
});

const shutdown = async () => {
  server.close();
  await qloo.close().catch(() => undefined);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
