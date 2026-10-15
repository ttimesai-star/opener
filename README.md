# Opener

**Who should open for your headliner in this city, and the Qloo evidence behind every pick.**

Opener is an agent for concert promoters and venue bookers. It answers two booking questions on the same Qloo tools:

- **Find an opener**: enter a headliner and a city (optionally a date window and capacity). Who should open the show?
- **Fill a free date**: enter a venue, its city, a free date and capacity. Which acts fit the crowd that already likes this room, and which of them are rising?

The agent calls Qloo's taste tools and returns a booking brief:

- **Top 5 opener candidates**, scored by audience fit with the headliner in that city
- **Where the fans are**: a map of where the headliner's affinity is concentrated inside the city
- **Trend**: whether the headliner and each candidate rose or fell over the last 90 days
- **Audience skew**: aggregate age and gender over/under-indexing
- **Local partners**: bars, pubs, cafes, record and clothing stores and music venues in the city, plus brands, that the same audience likes (landmarks and museums are filtered out)
- **What this does not prove**: the limits of the evidence, written into every brief
- **Live agent log**: every Qloo and LLM call streams to the page as it happens (Server-Sent Events), with who made it (LLM or planner), status, duration, a one-line result and the request behind it
- **Share and export**: each brief gets a link (`/b/<id>`), a Markdown download and a print / save-as-PDF layout. Shared briefs live in server memory only and expire (24 h by default)

> Status: **prototype** for the Qloo Agentic Hackathon. It runs on live Qloo data (hackathon key; both scenarios checked end to end on 2026-10-13: Radiohead in Berlin, SO36 in Berlin, Mohawk in Austin). It has not been used by a real promoter yet. Without a key the app falls back to **synthetic mock data** (fictional names, generated numbers) and says so on screen.

## The problem

Picking a support act is usually done on gut feel, agent pitches and streaming numbers. None of those tell a promoter whether the opener's fans and the headliner's fans are the same people in *this* city, where those people are, or which local businesses they already go to. Qloo's cross-domain taste graph answers exactly those questions. Without Qloo, Opener has nothing to say: every section of the brief is a Qloo result.

## How it works

```
browser ──POST /api/brief/stream (SSE)──▶ Node server ──▶ agent loop ──▶ events: start/end per Qloo or LLM call
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

Qloo tools used (through the official harness MCP server, plus one direct Insights call the harness cannot make):

| Brief section | Tool | Why |
| --- | --- | --- |
| Resolve headliner | `qloo_describe` | Pin the entity before anything depends on it |
| Candidate pool | `GET /v2/insights` (artist, headliner id as signal, city, `filter.popularity.max`) | Smaller acts whose audiences overlap, weighted to the city. The harness's `qloo_recommend` rejects a popularity filter, so this one call goes to the Insights API directly; if it fails or returns too few acts, the ceiling is widened once, then the harness `qloo_recommend` is used as before |
| Overlap score | `qloo_rank` | One call over the whole shortlist, so scores are comparable |
| Trend | `qloo_trends` | 90-day popularity series for headliner + top candidates |
| Fan map | `qloo_where_popular` | Heatmap of affinity inside the city |
| Audience skew | `qloo_audience_demographics` | Aggregate age/gender affinity |
| Partners | `qloo_recommend` (place with `filter_location` + `include_tags` category URNs, brand) | Local businesses and sponsor leads |
| Promo vocabulary | `qloo_entity_tags` (20 tags, filtered by tag family) | Taste concepts that describe the audience |

In the venue scenario the anchor is the venue (`qloo_describe` with `type: place`): candidates and the rank are weighted to the crowd that likes the venue, trends cover the top five candidates, and the map shows where the top candidate's fans are in the city. What live Qloo forced in this scenario:

- A venue name that Qloo calls ambiguous ("Mohawk": Austin, Bend, a college, a park) is retried once as "name city".
- Qloo returns no demographics for most places (SO36: `ok`, empty). The brief then shows the skew of the top candidate's fans and says so in the card and in the caveats.
- Brand recommendations with a place as the signal fail (400 `QLOO_CONTRACT`), so sponsor leads use the top three acts as signals.
- Taste tags come from the top three acts: a venue's own tags are amenities and cuisine ("Meeting Rooms", "Fusion").
- Partner places leave out bars, live-music venues and nightclubs (competing rooms); cafes, pubs, breweries, record and clothing stores stay.

API:

| Endpoint | What it returns |
| --- | --- |
| `POST /api/brief/stream` | `text/event-stream`: `ready`, then `step` events (`start`/`end` for every Qloo and LLM call), then `brief` |
| `POST /api/brief` | The brief as JSON (same input, no stream) |
| `GET /api/briefs/<id>` / `GET /api/briefs/<id>.md` | A stored brief as JSON or Markdown; 404 once it expires |

Input: `{"scenario":"opener","headliner":"...","city":"...","dateFrom":"YYYY-MM-DD","dateTo":"...","capacity":1200}` or `{"scenario":"venue","venue":"...","city":"...","date":"YYYY-MM-DD","capacity":600}`. A missing `scenario` means `opener`.

Design rules:

- **Numbers come from Qloo, prose from the LLM.** The brief is assembled deterministically from tool results. The LLM chooses calls and writes a short narrative from the brief's own JSON; it cannot add facts.
- **The agent degrades, it does not break.** If the LLM is rate-limited or down, the scripted planner finishes the same evidence plan. Every Qloo `error`, `empty`, `partial` or `degraded` status becomes a visible caveat.
- **Audience fit (0-100)** = min-max over every act in one `qloo_rank` call: 100 = the strongest act ranked, 0 = the weakest. Live affinities for a headliner's neighbours sit within about 0.01 of each other (Radiohead in Berlin, 2026-10-13: top five 0.9655-0.9744), so a ratio to the leader showed 99-100 for everyone. The raw affinity is in the JSON and in the bar's tooltip. Scores from different briefs are not comparable, and they are not forecasts.
- **Partners are businesses.** Unfiltered place recommendations for a city were museums and memorials (Berlin: The Wall Museum, Memorial to the Murdered Jews of Europe). The place call is constrained to Qloo category tags (`urn:tag:category:place:bar`, `pub`, `brewery`, `coffee_shop`, `record_store`, `clothing_store`, `live_music_venue`, ...), whoever makes the call, LLM or planner.
- **Tags are taste, not logistics.** `qloo_entity_tags` mixes families (`credit_card`, `cost_description`, `specialty_dish`, `hotel_rating`). Opener keeps `genre:music`, `audience`, `style`, `theme` and `keyword:media` tags only.
- **Safe use.** Inputs are an artist and a city; obvious personal data is rejected. Nothing infers anything about individuals. Qloo responses and shared briefs are kept only in server memory with a TTL and never written to disk or to this repository.

## Run locally

Requires Node.js 22.19+.

```sh
npm install
npm run build          # web app -> web/dist
npm start              # http://localhost:8787 (mock data, scripted agent)
```

Dev mode with hot reload: `npm run dev:server` and `npm run dev:web` (Vite proxies `/api` to :8787).

CLI: `npm run brief -- "Headliner" "City" 1200` prints the brief JSON and the agent steps; `npm run brief -- --venue "Venue" "City" 600 2026-11-20 --md` runs the venue scenario and prints Markdown.

In demo mode the mock answers instantly; set `MOCK_LATENCY_MS=600` to see the live log fill in step by step.

### Live Qloo

```sh
npm install --global @qloo/qloo-harness@0.1.26
export QLOO_API_KEY=...        # hackathon key; works only against hackathon.api.qloo.com
npm start                      # header badge switches to "Live Qloo"
```

Opener points the harness at `https://hackathon.api.qloo.com` and marks it trusted (`QLOO_BASE_URL` / `QLOO_TRUSTED_BASE_URL`; the harness default `api.qloo.com` answers 401 to a hackathon key). Override `QLOO_BASE_URL` for another endpoint. On Windows the binary defaults to `qloo.cmd` (`QLOO_BIN` overrides it).

Live-data notes: signals carry the entity id from `qloo_describe` (a bare name like "Radiohead" is ambiguous across artist, person and album and comes back `needs_input`); `/v2/trending` returns weekly points newest first, so trends query 180 days and keep the latest 13 points (about 90 days).

### LLM agent

Any OpenAI-compatible endpoint with tool calling. Default primary is the Gemini free tier; a fallback provider (Groq, Mistral, ...) is optional. See `.env.example`. With no LLM key the scripted planner runs alone.

## Deploy

The harness MCP server is a local process, so the kit rules out browser-only and serverless hosting. Opener ships as one container (`Dockerfile`): Node server + built web app + `qloo mcp`.

- **Hugging Face Spaces** (Docker SDK, free CPU Basic: 2 vCPU, 16 GB; sleeps when idle and wakes on the next visit). Steps:
  1. Create a Space with SDK **Docker**, blank template, hardware CPU Basic (free).
  2. Push this repository to the Space (`git remote add space https://huggingface.co/spaces/<user>/opener` then `git push space main`). The Space reads its settings from YAML at the top of its `README.md`; add this header in the Space copy:
     ```yaml
     ---
     title: Opener
     sdk: docker
     app_port: 7860
     ---
     ```
  3. Settings > Variables and secrets: add secret `QLOO_API_KEY` (and optionally `LLM_API_KEY`). The key stays in the Space's secret store; the browser never sees it.
  4. Open the Space; the header badge should say "Live Qloo".
  Not deployed yet (no Hugging Face account on the project side as of 2026-10-13).
- Any other container host works the same way. Render's free tier also works but spins down after 15 minutes idle (about a minute to wake).
- Optional: host `web/` separately (e.g. Cloudflare Pages) with `VITE_API_BASE` at build time and `ALLOWED_ORIGIN` on the server.

## Tests

```sh
npm run typecheck && npm test
```

CI (GitHub Actions) runs typecheck, unit/API tests, the web build, and a Docker smoke test in mock mode. No secrets are used in CI.

## What Opener does not establish

- Overlap scores are relative within one brief, not ticket-sales predictions.
- It does not check availability, fees, routing or stage fit. A venue's free date is not a Qloo input.
- The fan map shows relative affinity inside the chosen area, not head counts.
- Demographics are aggregate affinities and say nothing about any person.

## Roadmap (before submission)

- Done 2026-10-13 on live payloads: fit scores spread across the rank call, tag-family filter, partner category filter, venue fallbacks (ambiguous name, no place demographics, brand signals).
- Open: the candidate pool can include the headliner's own members or side projects (Radiohead -> Thom Yorke). Qloo has no "member of" field in these results; a promoter has to judge.
- Done 2026-10-15: popularity is shown as "top x%" (live percentiles for a big headliner's neighbours are all above 0.998, so a 0-100 scale read 100 for everyone). Acts within 10x of the headliner's popularity are left out as co-headliners when at least five smaller acts remain.
- Done 2026-10-15 (round 3): support-sized candidates. Qloo's Insights API documents `filter.popularity.min/max` for artists (docs.qloo.com, Parameters); the harness does not pass it. The candidate pool now asks `/v2/insights` for acts whose "top %" is 1000x the headliner's (at most the top 25%), widens to 100x (at most the top 10%) when fewer than five usable acts come back, then falls back to the unfiltered harness call. Live, Radiohead in Berlin: before, Beck, The Smashing Pumpkins, Interpol, Pixies, Franz Ferdinand (all in Qloo's top 0.05%); after, The Good, the Bad & the Queen, ...And You Will Know Us by the Trail of Dead, Spiritualized, Sean Lennon, The Notwist (top 0.4% to 1.6%). Acts Qloo lists with an end year are left out (the same query offered "On a Friday", Radiohead's own name until 1991). The venue scenario has no headliner to measure against and is unchanged.
- Open: a public demo deployment (see Deploy).
- Cross-domain show ideas from the same audience: films, podcasts and brands for theme nights, merch and pre-show playlists.
- Ask the user to pick when Qloo returns `needs_input` for an ambiguous headliner, instead of only flagging it.

## Disclosure

Built with AI coding agents (Claude Code, with review by Google Jules), directed and reviewed by the author. The runtime agent uses an LLM to choose Qloo tool calls and to write the narrative paragraph.

## License

MIT, see [LICENSE](LICENSE).
