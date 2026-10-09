// Function specs the LLM sees. They are trimmed copies of the `qloo mcp` input
// schemas (harness 0.1.26) for the tools Opener uses. The harness validates
// arguments again, so a bad call comes back as an error envelope, not a crash.

import type { ToolSpec } from "./llm.ts";

const ENTITY_TYPES = ["artist", "book", "brand", "movie", "person", "place", "podcast", "tv_show", "videogame"];
const strings = (description: string, maxItems = 10) => ({ type: "array", items: { type: "string" }, minItems: 1, maxItems, description });
const limit = { type: "integer", minimum: 1, maximum: 20 };

function spec(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolSpec {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } };
}

export const TOOL_SPECS: ToolSpec[] = [
  spec("qloo_describe", "Resolve one named entity and return its Qloo metadata.", { entity: { type: "string" }, type: { type: "string", enum: ENTITY_TYPES } }, ["entity"]),
  spec("qloo_recommend", "Find Qloo entities whose audiences have affinity with the given signals. Use target_type=artist for opener candidates, place (with filter_location) for local venues/bars, brand for sponsors.", {
    target_type: { type: "string", enum: ENTITY_TYPES },
    signals: strings("Named entities, e.g. the headliner"),
    signal_location: { type: "string", description: "Weight affinity toward this location" },
    filter_location: { type: "string", description: "Only return results located here (use for places)" },
    limit,
  }, ["target_type"]),
  spec("qloo_rank", "Rank a shortlist against one shared taste profile. Scores are comparable only within one call.", {
    options: strings("Shortlisted entity names"),
    option_type: { type: "string", enum: ENTITY_TYPES },
    signals: strings("Profile signals, e.g. the headliner"),
    signal_location: { type: "string" },
  }, ["options", "option_type"]),
  spec("qloo_where_popular", "Geographic areas inside `within` where an entity has comparatively strong affinity (heatmap).", {
    entity: { type: "string" }, entity_type: { type: "string", enum: ENTITY_TYPES }, within: { type: "string" }, limit,
  }, ["entity", "within"]),
  spec("qloo_audience_demographics", "Aggregate age and gender affinity of one entity's audience.", {
    entity: { type: "string" }, entity_type: { type: "string", enum: ENTITY_TYPES },
  }, ["entity"]),
  spec("qloo_trends", "Popularity time series for one to five entities over an ISO date range.", {
    entities: strings("Entity names", 5), entity_type: { type: "string", enum: ENTITY_TYPES },
    start_date: { type: "string", description: "YYYY-MM-DD" }, end_date: { type: "string", description: "YYYY-MM-DD" },
  }, ["entities", "entity_type", "start_date", "end_date"]),
  spec("qloo_entity_tags", "Taste concepts (tags) that characterise one or more entities.", {
    entities: strings("Entity names"), entity_type: { type: "string", enum: ENTITY_TYPES }, limit,
  }, ["entities"]),
  spec("qloo_compare_audiences", "Compare the audiences of two groups of entities.", {
    group_a: strings("First group"), group_b: strings("Second group"), target_type: { type: "string", enum: ENTITY_TYPES }, limit,
  }, ["group_a", "group_b"]),
];
