// node server/src/cli.ts "Headliner" "City" [capacity]
// node server/src/cli.ts --venue "Venue" "City" [capacity] [YYYY-MM-DD]
// node server/src/cli.ts ... --md      prints the Markdown export instead of JSON
// Uses the same env switches as the server.
import { runAgent } from "./agent/agent.ts";
import { createLlm } from "./agent/llm.ts";
import { briefToMarkdown } from "./agent/markdown.ts";
import type { BriefInput } from "./agent/types.ts";
import { validateInput } from "./app.ts";
import { createQlooClient } from "./qloo/index.ts";

const argv = process.argv.slice(2);
const asMarkdown = argv.includes("--md");
const venue = argv.includes("--venue");
const [anchor, city, capacity, date] = argv.filter((a) => !a.startsWith("--"));
const parsed = validateInput(
  venue ? { scenario: "venue", venue: anchor, city, capacity, date } : { scenario: "opener", headliner: anchor, city, capacity },
);
if (!parsed.ok) {
  console.error(`${parsed.error}\nusage: node server/src/cli.ts [--venue] "Headliner|Venue" "City" [capacity] [date] [--md]`);
  process.exit(2);
}
const input: BriefInput = parsed.input;
const qloo = await createQlooClient();
try {
  const brief = await runAgent({
    input,
    qloo,
    llm: createLlm(),
    onEvent: (e) => {
      if (e.type !== "end") return;
      if (e.kind === "qloo") console.error(`#${e.seq} [${e.step.actor}] ${e.step.tool} -> ${e.step.status} (${e.step.durationMs} ms)`);
      else console.error(`#${e.seq} [llm ${e.call.phase}] ${e.call.status} (${e.call.durationMs} ms) ${e.call.summary}`);
    },
  });
  console.log(asMarkdown ? briefToMarkdown(brief) : JSON.stringify(brief, null, 2));
} finally {
  await qloo.close();
}
