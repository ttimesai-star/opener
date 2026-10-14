# Opener brief: Radiohead in Berlin

_Generated 2026-10-14 22:23 UTC · data: Qloo Insights API · agent: hybrid · capacity: 1200_

Qloo ranked the candidate openers for a Radiohead show in Berlin, giving Beck the highest overlap score of 100 with an affinity of 0.972 and a popularity near 1.0, while its trend is flat. The Smashing Pumpkins follows with an overlap score of 70 and similar affinity and popularity, also flat. Interpol, Pixies and Franz Ferdinand have lower overlap scores \(60, 45 and 37 respectively\), with Franz Ferdinand lacking trend data. Based on these scores, Beck is the strongest fit as an opener.

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
- Left out Thom Yorke: Qloo describes it as part of Radiohead \("...as the principal vocalist, principal songwriter and frontman of Radiohead. Beyond the band he has a solo career..."\). Members and side projects are not openers.
- Left out as co-headline level, Qloo popularity within 10x of Radiohead's \(top 0.00034%\): The Killers \(top 0.0023%\), Muse \(top 0.0013%\), Arctic Monkeys \(top 0.0016%\). A support slot needs a smaller act.
- Every act Qloo recommended here is in the top 1% by Qloo popularity \(the least popular is top 0.14%\). The Qloo harness has no popularity filter, so smaller local acts do not come up; the shortlist ranks the least popular of them.
- The scripted planner completed the evidence plan because the LLM repeated a call \(qloo\_recommend\).

## Agent log

1. `qloo_describe` (llm) - ok, 1313 ms - 1 result\(s\)
2. `qloo_recommend` (llm) - ok, 955 ms - 20 result\(s\)
3. `qloo_rank` (planner) - ok, 4853 ms - Score the shortlist against one shared profile so scores are comparable
4. `qloo_trends` (planner) - ok, 7860 ms - Is the headliner and each top candidate rising over the last 90 days?
5. `qloo_where_popular` (planner) - ok, 342 ms - Where in Berlin the headliner's affinity is concentrated
6. `qloo_audience_demographics` (planner) - ok, 140 ms - Aggregate age and gender skew of the headliner's audience
7. `qloo_recommend` (planner) - ok, 406 ms - Venues, bars and shops in Berlin that the same audience likes \(partnership leads\)
8. `qloo_recommend` (planner) - ok, 256 ms - Brands with audience affinity to the headliner \(sponsor leads\)
9. `qloo_entity_tags` (planner) - ok, 424 ms - Taste concepts that characterise the audience \(for promo copy\)

LLM calls: 4 (4 ok).

---
Built with Opener on Qloo's Insights API. Aggregate taste affinities only, never individuals.
