import { fileURLToPath } from "node:url";
import { createLlm } from "./agent/llm.ts";
import { createApp } from "./app.ts";
import { createQlooClient } from "./qloo/index.ts";

const port = Number(process.env.PORT ?? 8787);
const staticDir = process.env.STATIC_DIR ?? fileURLToPath(new URL("../../web/dist", import.meta.url));

const qloo = await createQlooClient();
const llm = createLlm();
const server = createApp({ qloo, llm, staticDir, allowedOrigin: process.env.ALLOWED_ORIGIN });

server.listen(port, () => {
  console.log(`opener listening on :${port} (qloo=${qloo.mode}, llm=${llm ? "on" : "off -> scripted planner"})`);
});

const shutdown = async () => {
  server.close();
  await qloo.close().catch(() => undefined);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
