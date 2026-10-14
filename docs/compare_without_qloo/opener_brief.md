# Opener brief: Radiohead in Berlin

_Generated 2026-10-14 22:54 UTC · data: Qloo Insights API · agent: hybrid · capacity: 1200_

Beck has the strongest audience affinity with Radiohead among the 10 acts Qloo ranked for Berlin. None of the 4 acts with trend data shows a clear 90-day rise. 90-day trend not checked for Franz Ferdinand. Partnership leads with the same audience: BarbieBar, Absinthdepot Berlin, Neues Ufer Café Bar, Patagonia, The North Face, Recreational Equipment Inc.

## Top opener candidates

| # | Act | Audience fit (0-100) | Qloo popularity | 90-day trend |
| - | --- | --- | --- | --- |
| 1 | Beck | 100 | top 0.033% | flat |
| 2 | The Smashing Pumpkins | 70 | top 0.019% | flat |
| 3 | Interpol | 60 | top 0.045% | flat |
| 4 | Pixies | 45 | top 0.027% | flat |
| 5 | Franz Ferdinand | 37 | top 0.012% | n/a |

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
- The LLM was unavailable for part of this run; the scripted planner completed the evidence plan.
- Left out Thom Yorke: Qloo describes it as part of Radiohead \("...as the principal vocalist, principal songwriter and frontman of Radiohead. Beyond the band he has a solo career..."\). Members and side projects are not openers.
- Left out as co-headline level, Qloo popularity within 10x of Radiohead's \(top 0.00034%\): The Killers \(top 0.0023%\), Muse \(top 0.0013%\), Arctic Monkeys \(top 0.0016%\). A support slot needs a smaller act.
- Every act Qloo recommended here is in the top 1% by Qloo popularity \(the least popular is top 0.14%\). The Qloo harness has no popularity filter, so smaller local acts do not come up; the shortlist ranks the least popular of them.
- The scripted planner completed the evidence plan because the LLM time budget \(45 s\) ran out.

## Agent log

1. `qloo_describe` (llm) - ok, 1406 ms - 1 result\(s\)
2. `qloo_recommend` (llm) - ok, 1252 ms - 20 result\(s\)
3. `qloo_rank` (llm) - ok, 3845 ms - 10 result\(s\) \(after 1 rate-limit retry\)
4. `qloo_trends` (planner) - ok, 1637 ms - Is the headliner and each top candidate rising over the last 90 days?
5. `qloo_where_popular` (planner) - ok, 3090 ms - Where in Berlin the headliner's affinity is concentrated
6. `qloo_audience_demographics` (planner) - ok, 128 ms - Aggregate age and gender skew of the headliner's audience
7. `qloo_recommend` (planner) - ok, 418 ms - Venues, bars and shops in Berlin that the same audience likes \(partnership leads\)
8. `qloo_recommend` (planner) - ok, 238 ms - Brands with audience affinity to the headliner \(sponsor leads\)
9. `qloo_entity_tags` (planner) - ok, 425 ms - Taste concepts that characterise the audience \(for promo copy\)

LLM calls: 5 (3 ok).

---
Built with Opener on Qloo's Insights API. Aggregate taste affinities only, never individuals.
