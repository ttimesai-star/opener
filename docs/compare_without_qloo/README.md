# Same question, with and without Qloo

One real run each: LLM only on 14 October 2026; Opener re-run on 15 October 2026 after the support-slot popularity ceiling (round 3). Nothing here is edited; the raw files are next to this one.

| | LLM only | Opener |
| --- | --- | --- |
| Question | Radiohead headlining Berlin, capacity 1200: five openers, up to three Berlin places and three brands for cross-promotion | Same inputs, "Find an opener" |
| Model / data | `nvidia/nemotron-3-super-120b-a12b:free` via OpenRouter (the hosted demo's fallback LLM), temperature 0.2, no tools, no Qloo | Qloo Insights API through `qloo mcp`, candidate pool through `/v2/insights` with `filter.popularity.max`; LLM chooses calls, planner completes |
| Files | `request.json`, `response.json` (22:30 UTC, 23.7 s, script `run.mjs`) | `opener_brief.md` (15.10, 02:03 UTC, Markdown export of the live brief) |

## What came back

- **Openers.** LLM only: Black Country, New Road; Yard Act; Squid; Brandt Brauer Frick; Algiers. Opener: The Good, the Bad & the Queen; ...And You Will Know Us by the Trail of Dead; Spiritualized; Sean Lennon; The Notwist (Qloo top 0.4% to 2% by popularity). No act appears in both lists. Before the ceiling (14.10, 22:54 UTC) Opener offered Beck, The Smashing Pumpkins, Interpol, Pixies and Franz Ferdinand, all in Qloo's top 0.05%.
- **Places.** LLM only: ://about blank, Rough Trade Berlin, Klunkerkranich. Opener (Qloo, filtered to bars, cafes and shops in Berlin): BarbieBar, Absinthdepot Berlin, Neues Ufer Café Bar.
- **Brands.** LLM only: Apple, Patagonia, Converse. Opener: Patagonia, The North Face, Recreational Equipment Inc. Patagonia is in both.

## What the LLM-only answer rests on

The model had no tools and no data beyond the prompt in this call. Its answer still says it checked tour histories on setlist.fm and Songkick, and gives figures such as ">30 % overlap with Radiohead on Spotify", "Rough Trade's Berlin branch reports >12 k monthly visitors", "22 % of Rough Trade's email list", "Statista (2023) ... 34 % of Radiohead fans", "Radiohead × Patagonia tote sold out in 2022 test runs" and "a 15 % uplift" in Berlin Converse stores. None of these lookups happened in this run, and the figures have no source we can trace. We have not checked whether any of them is true elsewhere; the point is that a promoter cannot tell from the answer.

## What Opener's brief rests on

Every number is tied to a call in the agent log: the rank weighted to Berlin (`qloo_rank`), the 90-day trend (`qloo_trends`), where in Berlin the headliner's fans concentrate (`qloo_where_popular`), the age and gender skew (`qloo_audience_demographics`), and the place and brand recommendations. The brief also says what it left out and why (acts in Qloo's top 0.34% by popularity, as too big for a support slot; "On a Friday", Radiohead's own name until 1991, as no longer active) and what it does not prove. In the 14.10 run it also left out Thom Yorke as a member of Radiohead and The Killers, Muse and Arctic Monkeys as co-headline level.

## Where the LLM-only answer is ahead

Its picks are newer acts. Opener's are now support-sized relative to Radiohead (outside Qloo's top 0.34%, against Radiohead's top 0.00034%), but they are established names, and for a 1200-capacity room a promoter may want smaller ones still: the ceiling is relative to the headliner, not to the room. The LLM's picks come with no audience evidence for Berlin, so neither answer is a booking decision on its own.
