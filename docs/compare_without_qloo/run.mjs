// One LLM-only run of the question Opener answers, with no Qloo data and no tools.
// Usage: OPENROUTER_API_KEY=... node docs/compare_without_qloo/run.mjs
// Writes request.json and response.json (raw) next to this file. The key is never written.
import { writeFileSync } from "node:fs";

const model = process.env.MODEL ?? "nvidia/nemotron-3-super-120b-a12b:free";
const request = {
  model,
  temperature: 0.2,
  messages: [
    { role: "system", content: "You are a booking research assistant for concert promoters." },
    {
      role: "user",
      content: "Headliner: Radiohead. City: Berlin. Venue capacity: 1200. Who should open the show? Suggest five opening acts, ranked, with a short reason for each. Also suggest up to three places in Berlin (bars, shops, venues) and up to three brands whose audiences overlap with Radiohead's, as cross-promotion leads. Say what you based each suggestion on and how confident you are.",
    },
  ],
};
const dir = new URL(".", import.meta.url);
writeFileSync(new URL("request.json", dir), JSON.stringify({ endpoint: "https://openrouter.ai/api/v1/chat/completions", ...request }, null, 2));
const started = Date.now();
const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
  body: JSON.stringify(request),
});
const body = await res.json();
writeFileSync(new URL("response.json", dir), JSON.stringify({ http_status: res.status, duration_ms: Date.now() - started, received_at: new Date().toISOString(), body }, null, 2));
console.log(res.status, Date.now() - started, "ms");
console.log(body.choices?.[0]?.message?.content ?? JSON.stringify(body).slice(0, 500));
