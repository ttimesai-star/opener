# Opener brief: Radiohead in Berlin

_Generated 2026-10-15 02:03 UTC · data: Qloo Insights API · run by: LLM agent + scripted planner · capacity: 1200_

The Good, the Bad & the Queen is the strongest audience match for a Radiohead opener in Berlin, with a popularity rating in the top 0.52%.   Qloo ranked the acts, and this candidate also shows a flat trend.   If a slightly lower match is acceptable, …And You Will Know Us by the Trail of Dead follows with a popularity in the top 0.42%.   Spiritualized and Sean Lennon offer weaker matches, with popularity in the top 0.4% and top 2% respectively.

## Top opener candidates

| # | Act | Audience fit (0-100) | Qloo popularity | 90-day trend |
| - | --- | --- | --- | --- |
| 1 | The Good, the Bad & the Queen | 100 | top 0.52% | flat |
| 2 | ...And You Will Know Us by the Trail of Dead | 68 | top 0.42% | flat |
| 3 | Spiritualized | 51 | top 0.4% | flat |
| 4 | Sean Lennon | 46 | top 2% | flat |
| 5 | The Notwist | 31 | top 0.41% | n/a |

Audience fit: 100 = strongest of the 10 acts Qloo ranked, 0 = weakest; relative within this brief.

Headliner trend (90 days): flat · headliner Qloo popularity: top 0.00034%

## Where the fans are

Fans of Radiohead in Berlin: 15 areas with relative affinity (strongest = 100). Top areas:

- 52.5064, 13.3868: 100
- 52.5009, 13.4418: 100
- 52.5119, 13.3759: 100
- 52.5009, 13.3978: 99
- 52.5339, 13.3868: 99

## Audience skew

- Age: 24 and younger -0.03, 25 to 29 -0.14, 30 to 34 -0.72, 35 to 44 +0.19, 45 to 54 +0.14, 55 and older +0.04
- Gender: male +0.09, female -0.09

Positive = over-indexed, negative = under-indexed, aggregate only.

Taste tags: surrealism, Cultivated, Cerebral, rock, indie, Alternative Rock

## Local partners

- place: BarbieBar
- place: Absinthdepot Berlin
- place: Neues Ufer Café Bar
- brand: Patagonia
- brand: The North Face
- brand: Recreational Equipment Inc

## What this does not prove

- Fit scores are relative within this one Qloo rank call \(100 = strongest act ranked, 0 = weakest\). They are not ticket-sales forecasts or probabilities.
- Qloo describes aggregate taste affinities. Nothing here says anything about any individual fan.
- The brief does not check whether an act is available, affordable, touring nearby, or a good fit on stage.
- The map shows where affinity is comparatively strong inside the chosen area, not head counts of fans.
- Capacity \(1200\) is not a Qloo input; whether an act can fill it is your call.
- Candidates are limited to acts outside Qloo's top 0.34% by popularity \(Radiohead: top 0.00034%\), with Qloo's filter.popularity.max: a support act should draw a smaller crowd than the headliner, so bigger acts with a closer audience fit are left out on purpose.
- Left out as no longer active \(Qloo lists an end year\): On a Friday \(1991\).
- The scripted planner completed the evidence plan because the LLM repeated a call \(qloo\_recommend\).

## Agent log

1. `qloo_describe` (llm) - ok, 427 ms - 1 result\(s\)
2. `qloo_recommend` (llm) - ok, 1067 ms - 20 artist\(s\) with Qloo popularity at most 0.996626 \(filter.popularity.max, /v2/insights\).
3. `qloo_rank` (planner) - ok, 447 ms - Score the shortlist against one shared profile so scores are comparable
4. `qloo_trends` (planner) - ok, 3378 ms - Is the headliner and each top candidate rising over the last 90 days?
5. `qloo_where_popular` (planner) - ok, 417 ms - Where in Berlin the headliner's affinity is concentrated
6. `qloo_audience_demographics` (planner) - ok, 116 ms - Aggregate age and gender skew of the headliner's audience
7. `qloo_recommend` (planner) - ok, 401 ms - Venues, bars and shops in Berlin that the same audience likes \(partnership leads\)
8. `qloo_recommend` (planner) - ok, 228 ms - Brands with audience affinity to the headliner \(sponsor leads\)
9. `qloo_entity_tags` (planner) - ok, 398 ms - Taste concepts that characterise the audience \(for promo copy\)

LLM calls: 4 (4 ok).

---
Built with Opener on Qloo's Insights API. Aggregate taste affinities only, never individuals.
