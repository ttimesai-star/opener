# Opener

**Who should open for your headliner in this city, and the Qloo evidence behind every pick.**

Opener is an agent for concert promoters and venue bookers. You enter a headliner and a city (optionally a date window and capacity). The agent calls Qloo's taste tools and returns a booking brief:

- **Top 5 opener candidates**, scored by audience overlap with the headliner in that city
- **Where the fans are**: a map of where the headliner's affinity is concentrated inside the city
- **Trend**: whether the headliner and each candidate rose or fell over the last 90 days
- **Audience skew**: aggregate age and gender over/under-indexing
- **Local partners**: venues, bars and shops in the city plus brands that the same audience likes
- **What this does not prove**: the limits of the evidence, written into every brief
- **Agent log**: every Qloo call, who made it (LLM or planner), its status and the request behind it

> Status: scaffold. Until the hackathon API key arrives, the app runs on **synthetic mock data** (fictional names, generated numbers) and says so on screen.

## The problem

Picking a support act is usually done on gut feel, agent pitches and streaming numbers. None of those tell a promoter whether the opener's fans and the headliner's fans are the same people in *this* city, where those people are, or which local businesses they already go to. Qloo's cross-domain taste graph answers exactly those questions. Without Qloo, Opener has nothing to say: every section of the brief is a Qloo result.

## How it works

```
browser ──POST /api/brief──▶ Node server ──▶ agent loop
                                               │
                     LLM (OpenAI-compatible) ◀─┤ chooses the next Qloo tool call
                     scripted planner ◀────────┤ fills whatever the LLM skipped or if it fails
                                               │
                                               ▼
                                  QlooClient ── live: `qloo mcp` (stdio, @qloo/qloo-harness)
                                             └─ mock: deterministic synthetic fixtures
                                               │
                                               ▼
                           brief builder (numbers only from Qloo) + LLM narrative (prose only)
```

Qloo tools used (all through the official harness MCP server):

| Brief section | Tool | Why |
| --- | --- | --- |
| Resolve headliner | `qloo_describe` | Pin the entity before anything depends on it |
| Candidate pool | `qloo_recommend` (artist, `signal_location` = city) | Artists whose audiences overlap, weighted to the city |
| Overlap score | `qloo_rank` | One call over the whole shortlist, so scores are comparable |
| Trend | `qloo_trends` | 90-day popularity series for headliner + top candidates |
| Fan map | `qloo_where_popular` | Heatmap of affinity inside the city |
| Audience skew | `qloo_audience_demographics` | Aggregate age/gender affinity |
| Partners | `qloo_recommend` (place with `filter_location`, brand) | Local venues and sponsor leads |
| Promo vocabulary | `qloo_entity_tags` | Taste concepts that describe the audience |

Design rules:

- **Numbers come from Qloo, prose from the LLM.** The brief is assembled deterministically from tool results. The LLM chooses calls and writes a short narrative from the brief's own JSON; it cannot add facts.
- **The agent degrades, it does not break.** If the LLM is rate-limited or down, the scripted planner finishes the same evidence plan. Every Qloo `error`, `empty`, `partial` or `degraded` status becomes a visible caveat.
- **Overlap score** = the candidate's affinity divided by the top candidate's affinity in the same `qloo_rank` call (0-100). It is not a forecast.
- **Safe use.** Inputs are an artist and a city; obvious personal data is rejected. Nothing infers anything about individuals. Qloo responses are cached only in server memory and never written to this repository.

## Run locally

Requires Node.js 22.19+.

```sh
npm install
npm run build          # web app -> web/dist
npm start              # http://localhost:8787 (mock data, scripted agent)
```

Dev mode with hot reload: `npm run dev:server` and `npm run dev:web` (Vite proxies `/api` to :8787).

CLI: `npm run brief -- "Headliner" "City" 1200` prints the brief JSON and the agent steps.

### Live Qloo

```sh
npm install --global @qloo/qloo-harness@0.1.26
export QLOO_API_KEY=...        # hackathon key; works only against hackathon.api.qloo.com
npm start                      # header badge switches to "Live Qloo"
```

On Windows set `QLOO_BIN=qloo.cmd`.

### LLM agent

Any OpenAI-compatible endpoint with tool calling. Default primary is the Gemini free tier; a fallback provider (Groq, Mistral, ...) is optional. See `.env.example`. With no LLM key the scripted planner runs alone.

## Deploy

The harness MCP server is a local process, so the kit rules out browser-only and serverless hosting. Opener ships as one container (`Dockerfile`): Node server + built web app + `qloo mcp`.

- **Hugging Face Spaces** (Docker SDK, free CPU Basic: 2 vCPU, 16 GB; sleeps when idle and wakes on the next visit). Set `QLOO_API_KEY` and `LLM_*` as Space secrets.
- Any other container host works the same way. Render's free tier also works but spins down after 15 minutes idle (about a minute to wake).
- Optional: host `web/` separately (e.g. Cloudflare Pages) with `VITE_API_BASE` at build time and `ALLOWED_ORIGIN` on the server.

## Tests

```sh
npm run typecheck && npm test
```

CI (GitHub Actions) runs typecheck, unit/API tests, the web build, and a Docker smoke test in mock mode. No secrets are used in CI.

## What Opener does not establish

- Overlap scores are relative within one brief, not ticket-sales predictions.
- It does not check availability, fees, routing or stage fit.
- The fan map shows relative affinity inside the chosen area, not head counts.
- Demographics are aggregate affinities and say nothing about any person.

## Disclosure

Built with AI coding agents (Claude Code, with review by Google Jules), directed and reviewed by the author. The runtime agent uses an LLM to choose Qloo tool calls and to write the narrative paragraph.

## License

MIT, see [LICENSE](LICENSE).
