// Display helpers shared by the page and the Markdown export (no Node or browser APIs).

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * "Mohawk, Austin", but "Mohawk Austin" when Qloo's own name already carries
 * the city: live, the ambiguous "Mohawk" resolved as "Mohawk Austin" and the
 * title read "Mohawk Austin, Austin" (demo 2026-10-14).
 */
export function withCity(name: string, city: string): string {
  const c = city.trim();
  if (!c) return name;
  const inName = new RegExp(`(?<![\\p{L}\\p{N}])${escape(c)}(?![\\p{L}\\p{N}])`, "iu").test(name);
  return inName ? name : `${name}, ${c}`;
}

/**
 * Who ran the Qloo calls of a brief, in words: the meta line read "agent: hybrid"
 * (demo 2026-10-15), which a promoter cannot decode.
 */
export function agentRunLabel(agent: "llm" | "planner" | "hybrid"): string {
  if (agent === "hybrid") return "LLM agent + scripted planner";
  if (agent === "llm") return "LLM agent";
  return "scripted planner";
}
