# Same question, with and without Qloo

One real run each, 14 October 2026. Nothing here is edited; the raw files are next to this one.

| | LLM only | Opener |
| --- | --- | --- |
| Question | Radiohead headlining Berlin, capacity 1200: five openers, up to three Berlin places and three brands for cross-promotion | Same inputs, "Find an opener" |
| Model / data | `nvidia/nemotron-3-super-120b-a12b:free` via OpenRouter (the hosted demo's fallback LLM), temperature 0.2, no tools, no Qloo | Qloo Insights API through `qloo mcp`; LLM chooses calls, planner completes |
| Files | `request.json`, `response.json` (22:30 UTC, 23.7 s, script `run.mjs`) | `opener_brief.md` (22:54 UTC, Markdown export of the live brief) |

## What came back

- **Openers.** LLM only: Black Country, New Road; Yard Act; Squid; Brandt Brauer Frick; Algiers. Opener: Beck; The Smashing Pumpkins; Interpol; Pixies; Franz Ferdinand. No act appears in both lists.
- **Places.** LLM only: ://about blank, Rough Trade Berlin, Klunkerkranich. Opener (Qloo, filtered to bars, cafes and shops in Berlin): BarbieBar, Absinthdepot Berlin, Neues Ufer Café Bar.
- **Brands.** LLM only: Apple, Patagonia, Converse. Opener: Patagonia, The North Face, Recreational Equipment Inc. Patagonia is in both.

## What the LLM-only answer rests on

The model had no tools and no data beyond the prompt in this call. Its answer still says it checked tour histories on setlist.fm and Songkick, and gives figures such as ">30 % overlap with Radiohead on Spotify", "Rough Trade's Berlin branch reports >12 k monthly visitors", "22 % of Rough Trade's email list", "Statista (2023) ... 34 % of Radiohead fans", "Radiohead × Patagonia tote sold out in 2022 test runs" and "a 15 % uplift" in Berlin Converse stores. None of these lookups happened in this run, and the figures have no source we can trace. We have not checked whether any of them is true elsewhere; the point is that a promoter cannot tell from the answer.

## What Opener's brief rests on

Every number is tied to a call in the agent log: the rank weighted to Berlin (`qloo_rank`), the 90-day trend (`qloo_trends`), where in Berlin the headliner's fans concentrate (`qloo_where_popular`), the age and gender skew (`qloo_audience_demographics`), and the place and brand recommendations. The brief also says what it left out and why (Thom Yorke as a member of Radiohead; The Killers, Muse and Arctic Monkeys as co-headline level) and what it does not prove.

## Where the LLM-only answer is ahead

Its picks are smaller, current acts, closer to a realistic support slot for a 1200-capacity room. Every act Qloo recommended here is in the top 1 % by Qloo popularity (the least popular one is top 0.14 %, as the brief's caveats say), because the Qloo harness exposes no popularity filter on recommendations; the brief says so. The LLM's picks come with no audience evidence for Berlin, so neither answer is a booking decision on its own.
