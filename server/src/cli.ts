// node server/src/cli.ts "Headliner" "City" [capacity]
// Prints the brief as JSON. Uses the same env switches as the server.
import { runAgent } from "./agent/agent.ts";
import { createLlm } from "./agent/llm.ts";
import { createQlooClient } from "./qloo/index.ts";

const [headliner, city, capacity] = process.argv.slice(2);
if (!headliner || !city) {
  console.error('usage: node server/src/cli.ts "Headliner" "City" [capacity]');
  process.exit(2);
}
const qloo = await createQlooClient();
try {
  const brief = await runAgent({
    input: { headliner, city, capacity: capacity ? Number(capacity) : undefined },
    qloo,
    llm: createLlm(),
    onStep: (s) => console.error(`#${s.index} [${s.actor}] ${s.tool} -> ${s.status} (${s.durationMs} ms)`),
  });
  console.log(JSON.stringify(brief, null, 2));
} finally {
  await qloo.close();
}
